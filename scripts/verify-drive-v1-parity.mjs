import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repositoryRoot, 'contracts', 'drive-v1-parity')
const expectedJsonFiles = [
  'canonicalization.json',
  'delete-edit-race.json',
  'equal-targets.json',
  'malformed-json.json',
  'missing-record.json',
  'non-resurrection.json',
  'policy.json',
]

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8'))
}

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function canonicalTombstone(value) {
  return {
    ...value,
    id: `del-${value.entityKind}-${value.entityId}`,
  }
}

function effectiveDeletedTargets(graph, tombstones) {
  const deletedEntries = new Set(
    tombstones.filter((item) => item.entityKind === 'entry').map((item) => item.entityId),
  )
  const deletedAttachments = new Set(
    tombstones.filter((item) => item.entityKind === 'attachment').map((item) => item.entityId),
  )
  const deletedFileBoxItems = new Set(
    tombstones.filter((item) => item.entityKind === 'fileBoxItem').map((item) => item.entityId),
  )
  const deletedTransfers = new Set(
    tombstones.filter((item) => item.entityKind === 'transfer').map((item) => item.entityId),
  )
  for (const attachment of graph.attachments) {
    if (deletedEntries.has(attachment.entryId)) deletedAttachments.add(attachment.id)
  }
  for (const item of graph.fileBoxItems) {
    if (deletedEntries.has(item.entryId) || deletedAttachments.has(item.attachmentId)) {
      deletedFileBoxItems.add(item.id)
    }
  }
  for (const transfer of graph.transfers) {
    if (
      deletedEntries.has(transfer.entryId)
      || deletedAttachments.has(transfer.attachmentId)
      || deletedFileBoxItems.has(transfer.fileBoxItemId)
    ) {
      deletedTransfers.add(transfer.id)
    }
  }
  return [
    ...[...deletedAttachments].map((id) => `attachment:${id}`),
    ...[...deletedEntries].map((id) => `entry:${id}`),
    ...[...deletedFileBoxItems].map((id) => `fileBoxItem:${id}`),
    ...[...deletedTransfers].map((id) => `transfer:${id}`),
  ].sort()
}

const actualJsonFiles = (await readdir(fixtureRoot))
  .filter((name) => name.endsWith('.json'))
  .sort()
assert.deepEqual(actualJsonFiles, expectedJsonFiles)

const policy = await fixture('policy.json')
const blockers = new Set(policy.runtimeParity.blockingIssueIds)
assert.equal(policy.gateVersion, 1)
assert.equal(policy.driveContractVersion, 1)
assert.equal(policy.writeGate, 'disabled-until-runtime-parity')
assert.equal(policy.runtimeParity.status, 'blocked')
assert.equal(policy.runtimeParity.nativeDriveWritesAllowed, false)
assert.deepEqual([...blockers].sort(), [
  'android-data-thumbnail',
  'android-unique-entry-path',
  'malformed-json-quarantine',
  'tombstone-target-normalization',
  'web-filebox-transfer-cascade',
  'web-payload-projection',
  'web-versioned-cas',
])
assert.deepEqual(policy.remoteVersion.existingRequires, ['fileId', 'version'])
assert.equal(policy.remoteVersion.minimumVersion, 1)
assert.equal(policy.remoteVersion.freshEtagBeforeMutation, true)
assert.equal(policy.deletions.cascade, 'parent-transitively-suppresses-descendants')
assert.equal(policy.deletions.explicitChildTombstones, 'accepted-not-required')
assert.equal(policy.deletions.physicalDriveDeletion, false)
assert.equal(policy.deletions.nonResurrection, true)

const malformed = await fixture('malformed-json.json')
assert.throws(() => JSON.parse(malformed.remoteDocumentText), SyntaxError)
assert.equal(
  malformed.expected.conflictId,
  `conf-invalid-${malformed.entityKind}-${malformed.remotePath}`,
)
assert.equal(malformed.expected.decision, 'quarantine-conflict')
assert.equal(malformed.expected.remoteWriteAllowed, false)
assert.equal(malformed.expected.runtimeParity, 'blocked')
assert.ok(blockers.has(malformed.expected.blockingIssueId))

const missing = await fixture('missing-record.json')
assert.ok(missing.baseline.fileId)
assert.ok(Number.isInteger(missing.baseline.version) && missing.baseline.version >= 1)
assert.deepEqual(missing.expected.precondition, {
  kind: 'must-match',
  fileId: missing.baseline.fileId,
  version: missing.baseline.version,
})
assert.equal(missing.expected.decision, 'blocked')
assert.equal(missing.expected.remoteWriteAllowed, false)

const deleteEdit = await fixture('delete-edit-race.json')
assert.match(deleteEdit.baseHash, /^[0-9a-f]{64}$/)
assert.match(deleteEdit.localHash, /^[0-9a-f]{64}$/)
assert.notEqual(deleteEdit.baseHash, deleteEdit.localHash)
assert.equal(deleteEdit.expectedConflict.localCopy.hash, deleteEdit.localHash)
assert.equal(deleteEdit.remoteTombstone.entityKind, deleteEdit.entityKind)
assert.equal(deleteEdit.remoteTombstone.entityId, deleteEdit.entityId)
assert.equal(deleteEdit.expectedConflict.id, `conf-${deleteEdit.entityKind}-${deleteEdit.entityId}`)
assert.equal(deleteEdit.expectedConflict.resolution, 'pending')
assert.deepEqual(deleteEdit.expectedConflict.localCopy.value, deleteEdit.localValue)
assert.deepEqual(deleteEdit.expectedConflict.remoteCopy.tombstone, deleteEdit.remoteTombstone)
assert.equal(deleteEdit.expected.remoteWriteAllowed, false)

const equalTargets = await fixture('equal-targets.json')
const newest = equalTargets.candidates
  .toSorted((left, right) => Date.parse(left.deletedAt) - Date.parse(right.deletedAt))
  .at(-1)
assert.deepEqual(stable(canonicalTombstone(newest)), stable(equalTargets.expected.canonical))
assert.equal(
  equalTargets.expected.drivePath,
  `tombstones/${equalTargets.entityKind}--${equalTargets.entityId}.json`,
)
const [equalLeft, equalRight] = equalTargets.equalInstantDivergence
assert.equal(equalLeft.deletedAt, equalRight.deletedAt)
assert.notEqual(equalLeft.deletedByDeviceId, equalRight.deletedByDeviceId)
assert.equal(equalTargets.expected.equalInstantDecision, 'blocked')
assert.equal(equalTargets.expected.runtimeParity, 'blocked')
assert.ok(blockers.has(equalTargets.expected.blockingIssueId))
assert.notEqual(equalTargets.expected.observedNativeCreatedId, equalTargets.expected.canonical.id)

const nonResurrection = await fixture('non-resurrection.json')
assert.deepEqual(
  effectiveDeletedTargets(nonResurrection.liveGraph, nonResurrection.tombstones),
  nonResurrection.expected.effectiveDeletedTargets,
)
assert.deepEqual(nonResurrection.expected.remainingLiveTargets, [])
assert.equal(nonResurrection.expected.explicitChildTombstonesRequired, false)
assert.equal(nonResurrection.expected.legacyChildTombstonesAccepted, true)
assert.equal(nonResurrection.expected.staleRemoteRecordsIgnored, true)
assert.equal(nonResurrection.expected.runtimeParity, 'blocked')
assert.ok(blockers.has(nonResurrection.expected.blockingIssueId))
assert.ok(nonResurrection.tombstones.some((item) => item.id.startsWith('delete-')))

const canonicalization = await fixture('canonicalization.json')
assert.equal(
  canonicalization.uniqueEntry.expectedPath,
  `entries/${canonicalization.uniqueEntry.dateBucket}.json`,
)
assert.equal(canonicalization.uniqueEntry.runtimeParity, 'blocked')
assert.ok(blockers.has(canonicalization.uniqueEntry.blockingIssueId))
assert.notEqual(
  canonicalization.uniqueEntry.expectedPath,
  canonicalization.uniqueEntry.observedAndroidPath,
)
assert.equal(
  canonicalization.sameDayCollision.expectedPath,
  `entries/${canonicalization.sameDayCollision.dateBucket}-${canonicalization.sameDayCollision.entityId}.json`,
)
assert.equal(
  canonicalization.existingAttachmentRename.expectedPath,
  canonicalization.existingAttachmentRename.verifiedPath,
)
assert.equal(canonicalization.existingAttachmentRename.runtimeWriteAllowedUntilPathParity, false)
for (const [fixtureKey, policyKind] of [
  ['entryPayload', 'entry'],
  ['attachmentPayload', 'attachment'],
  ['fileBoxPayload', 'fileBoxItem'],
]) {
  const fixtureCase = canonicalization[fixtureKey]
  const canonicalPayload = structuredClone(fixtureCase.input)
  for (const key of policy.canonicalPayloads.stripLocalOnly[policyKind]) delete canonicalPayload[key]
  assert.deepEqual(canonicalPayload, fixtureCase.expected)
}
assert.equal(canonicalization.attachmentPayload.expected.futureRemoteField.preserve, true)
assert.equal(canonicalization.attachmentPayload.runtimeParity, 'blocked')
assert.ok(blockers.has(canonicalization.attachmentPayload.blockingIssueId))
assert.equal(canonicalization.fileBoxPayload.webRuntimeParity, 'blocked')
assert.ok(blockers.has(canonicalization.fileBoxPayload.blockingIssueId))

// These source-anchored checks ensure the assessment cannot silently claim parity
// while the known client implementations still have the recorded blockers.
const androidSerializer = await source(
  'android/app/src/main/java/com/easylab/labnotebook/sync/DriveV1LocalSerializer.kt',
)
const androidDao = await source(
  'android/app/src/main/java/com/easylab/labnotebook/data/local/LabNotebookDao.kt',
)
const webSyncEngine = await source('web/src/sync/syncEngine.ts')
const webDataCore = await source('web/src/sync/dataCore.ts')
const webProvider = await source('web/src/sync/syncProvider.ts')

assert.match(androidSerializer, /A new entry must use its collision-safe ID-derived Drive path/)
assert.match(androidSerializer, /thumbnail = thumbnail\?\.takeUnless\(::isLocalCacheHint\)/)
assert.doesNotMatch(androidSerializer, /startsWith\("data:"\)/)
assert.match(androidDao, /val baseRecordId = "delete-\$entityKind-\$entityId"/)
assert.match(webSyncEngine, /existing\.id === tombstone\.id/)
const readRemoteEntries = webSyncEngine.slice(
  webSyncEngine.indexOf('async function readRemoteEntries'),
  webSyncEngine.indexOf('async function readRemoteAttachments'),
)
assert.match(readRemoteEntries, /await provider\.getJson<unknown>\(file\.path\)/)
assert.doesNotMatch(readRemoteEntries, /try\s*\{|catch\s*\(/)
const readRemoteTombstones = webSyncEngine.slice(
  webSyncEngine.indexOf('async function readRemoteTombstones'),
)
assert.match(readRemoteTombstones, /if \(result\.ok\) valid\.push\(result\.value\)/)
const applyTombstones = webDataCore.slice(
  webDataCore.indexOf('export function applyTombstonesToSnapshot'),
  webDataCore.indexOf('export function buildPendingSyncQueue'),
)
assert.doesNotMatch(applyTombstones, /fileBoxItemId/)
const providerContract = webProvider.slice(
  webProvider.indexOf('export interface SyncProvider'),
  webProvider.indexOf('export class'),
)
assert.doesNotMatch(providerContract, /ifMatch|etag|precondition/i)
assert.match(webDataCore, /buildEntryEnvelope[\s\S]*payload: entry/)
assert.match(webDataCore, /buildAttachmentEnvelope[\s\S]*payload: attachment/)
assert.match(webSyncEngine, /buildFileBoxEnvelope[\s\S]*payload: item/)

console.log(
  `Drive v1 parity assessment passed: ${actualJsonFiles.length} shared JSON fixtures; `
    + `${blockers.size} runtime blockers keep native writes disabled.`,
)
