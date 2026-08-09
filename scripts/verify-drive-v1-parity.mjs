import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repositoryRoot, 'contracts', 'drive-v1-parity')
const expectedJsonFiles = [
  'canonicalization.json',
  'conditional-create.json',
  'delete-edit-race.json',
  'equal-targets.json',
  'malformed-json.json',
  'missing-record.json',
  'non-resurrection.json',
  'offline-round-trip.json',
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
const resolved = new Set(policy.runtimeParity.resolvedIssueIds)
assert.equal(policy.gateVersion, 1)
assert.equal(policy.driveContractVersion, 1)
assert.equal(policy.writeGate, 'disabled-until-runtime-parity')
assert.equal(policy.runtimeParity.status, 'blocked')
assert.equal(policy.runtimeParity.nativeDriveWritesAllowed, false)
assert.deepEqual([...blockers], ['live-versioned-cas-validation'])
assert.deepEqual([...resolved].sort(), [
  'android-data-thumbnail',
  'android-unique-entry-path',
  'malformed-json-quarantine',
  'native-idempotent-create-only',
  'tombstone-target-normalization',
  'web-filebox-transfer-cascade',
  'web-payload-projection',
  'web-versioned-cas',
])
assert.deepEqual(policy.remoteVersion.existingRequires, ['fileId', 'version'])
assert.equal(policy.remoteVersion.minimumVersion, 1)
assert.equal(policy.remoteVersion.freshEtagBeforeMutation, true)
assert.equal(policy.remoteVersion.webVersionedCas, 'implemented-offline-unwired')
assert.equal(policy.remoteVersion.liveVersionedCasValidationPerformed, false)
assert.equal(policy.remoteVersion.conditionalCreate, 'idempotent-create-only-offline')
assert.equal(policy.deletions.cascade, 'parent-transitively-suppresses-descendants')
assert.equal(policy.deletions.explicitChildTombstones, 'accepted-not-required')
assert.equal(policy.deletions.physicalDriveDeletion, false)
assert.equal(policy.deletions.nonResurrection, true)

const conditionalCreate = await fixture('conditional-create.json')
assert.equal(conditionalCreate.precondition, 'must-not-exist')
assert.equal(conditionalCreate.scope, 'offline-cross-client-transaction-only')
assert.equal(conditionalCreate.identity.property, 'easylabCreateFingerprint')
assert.equal(conditionalCreate.identity.deterministic, true)
assert.equal(conditionalCreate.missingPath.overwriteAllowed, false)
assert.equal(conditionalCreate.uploadModes.boundedMultipart.maximumExclusiveBytes, 5 * 1024 * 1024)
assert.equal(conditionalCreate.uploadModes.boundedMultipart.method, 'multipart-post')
assert.equal(conditionalCreate.uploadModes.boundedMultipart.generatedFileIdRequired, false)
assert.equal(conditionalCreate.uploadModes.resumable.minimumInclusiveBytes, 5 * 1024 * 1024)
assert.equal(conditionalCreate.uploadModes.resumable.method, 'resumable-post')
assert.equal(conditionalCreate.uploadModes.resumable.generatedFileIdRequired, true)
assert.equal(conditionalCreate.uploadModes.resumable.persistBeforeContentTransfer, true)
assert.equal(conditionalCreate.uploadModes.resumable.pathReservation, 'parent-folder-etag-cas')
assert.equal(conditionalCreate.uploadModes.resumable.reservationScope, 'canonical-path-hash')
assert.equal(
  conditionalCreate.uploadModes.resumable.independentRecovery,
  'adopt-exact-generated-id-and-fingerprint',
)
assert.equal(conditionalCreate.existingPath.exactIdentityAndContent, 'reconcile-as-success')
assert.equal(conditionalCreate.existingPath.mismatch, 'precondition-conflict')
assert.equal(conditionalCreate.existingPath.duplicates, 'precondition-conflict')
assert.equal(conditionalCreate.ambiguousOutcome.otherwise, 'ambiguous-commit')
assert.equal(conditionalCreate.runtime.productionWired, false)
assert.equal(conditionalCreate.runtime.webProductionWired, false)
assert.equal(conditionalCreate.runtime.nativeDriveWritesAllowed, false)
assert.equal(conditionalCreate.runtime.liveDriveValidationPerformed, false)

const malformed = await fixture('malformed-json.json')
assert.throws(() => JSON.parse(malformed.remoteDocumentText), SyntaxError)
assert.equal(
  malformed.expected.conflictId,
  `conf-invalid-${malformed.entityKind}-${malformed.remotePath}`,
)
assert.equal(malformed.expected.decision, 'quarantine-conflict')
assert.equal(malformed.expected.remoteWriteAllowed, false)
assert.equal(malformed.expected.runtimeParity, 'resolved')
assert.ok(resolved.has(malformed.expected.resolvedIssueId))

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
assert.equal(equalTargets.expected.runtimeParity, 'resolved')
assert.ok(resolved.has(equalTargets.expected.resolvedIssueId))
assert.equal(equalTargets.expected.observedNativeCreatedId, equalTargets.expected.canonical.id)

const nonResurrection = await fixture('non-resurrection.json')
assert.deepEqual(
  effectiveDeletedTargets(nonResurrection.liveGraph, nonResurrection.tombstones),
  nonResurrection.expected.effectiveDeletedTargets,
)
assert.deepEqual(nonResurrection.expected.remainingLiveTargets, [])
assert.equal(nonResurrection.expected.explicitChildTombstonesRequired, false)
assert.equal(nonResurrection.expected.legacyChildTombstonesAccepted, true)
assert.equal(nonResurrection.expected.staleRemoteRecordsIgnored, true)
assert.equal(nonResurrection.expected.runtimeParity, 'resolved')
assert.ok(resolved.has(nonResurrection.expected.resolvedIssueId))
assert.ok(nonResurrection.tombstones.some((item) => item.id.startsWith('delete-')))

const canonicalization = await fixture('canonicalization.json')
assert.equal(
  canonicalization.uniqueEntry.expectedPath,
  `entries/${canonicalization.uniqueEntry.dateBucket}.json`,
)
assert.equal(canonicalization.uniqueEntry.runtimeParity, 'resolved')
assert.ok(resolved.has(canonicalization.uniqueEntry.resolvedIssueId))
assert.equal(
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
assert.equal(canonicalization.attachmentPayload.runtimeParity, 'resolved')
assert.ok(resolved.has(canonicalization.attachmentPayload.resolvedIssueId))
assert.equal(canonicalization.fileBoxPayload.webRuntimeParity, 'resolved')
assert.ok(resolved.has(canonicalization.fileBoxPayload.resolvedIssueId))

const offlineRoundTrip = await fixture('offline-round-trip.json')
assert.equal(offlineRoundTrip.contractVersion, 1)
assert.equal(offlineRoundTrip.liveDriveUsed, false)
assert.equal(offlineRoundTrip.productionWritesEnabled, false)
assert.equal(offlineRoundTrip.androidOrigin.entryPath, 'entries/2026-05-23.json')
assert.equal(
  offlineRoundTrip.androidOrigin.attachmentMetadataPath,
  `${offlineRoundTrip.androidOrigin.attachmentBlobPath}.json`,
)
assert.match(offlineRoundTrip.androidOrigin.entryContentHash, /^[0-9a-f]{64}$/)
assert.match(offlineRoundTrip.androidOrigin.attachmentMetadataHash, /^[0-9a-f]{64}$/)
assert.match(offlineRoundTrip.webEdit.entryContentHash, /^[0-9a-f]{64}$/)
assert.deepEqual(offlineRoundTrip.webEdit.precondition, {
  kind: 'must-match',
  fileId: offlineRoundTrip.webEdit.fileId,
  version: offlineRoundTrip.webEdit.version,
})
assert.equal(offlineRoundTrip.webEdit.path, offlineRoundTrip.androidOrigin.entryPath)
assert.equal(offlineRoundTrip.webEdit.verifiedExistingPathPreserved, true)
assert.equal(
  offlineRoundTrip.electronDelete.id,
  `del-${offlineRoundTrip.electronDelete.entityKind}-${offlineRoundTrip.electronDelete.entityId}`,
)
assert.equal(
  offlineRoundTrip.electronDelete.path,
  `tombstones/${offlineRoundTrip.electronDelete.entityKind}--${offlineRoundTrip.electronDelete.entityId}.json`,
)
assert.equal(offlineRoundTrip.electronDelete.physicalDriveDeletion, false)
assert.equal(
  offlineRoundTrip.canonicalConflict.path,
  `conflicts/${offlineRoundTrip.canonicalConflict.id}.json`,
)
assert.deepEqual(offlineRoundTrip.androidReturn.finalManifestCounts, {
  entryCount: 0,
  attachmentCount: 0,
  fileBoxCount: 0,
  transferCount: 0,
})
assert.equal(offlineRoundTrip.androidReturn.staleLiveRecordsResurrect, false)
assert.equal(offlineRoundTrip.payloadProjection.unknownField.preserved, true)
assert.equal(offlineRoundTrip.payloadProjection.localOnlyFieldsPublished, false)
assert.equal(
  offlineRoundTrip.transactionScenarios.smallCreateOnlyRetry.expected,
  'exact-reconciliation-no-duplicate',
)
assert.equal(
  offlineRoundTrip.transactionScenarios.largeResumableCreate.expected,
  'same-operation-id-no-duplicate',
)
assert.equal(
  offlineRoundTrip.transactionScenarios.largeResumableUpdate.expected,
  'same-operation-id-conditional-update',
)
assert.equal(
  offlineRoundTrip.transactionScenarios.partialPrerequisitesWithOldManifest.expected,
  'repair-only-known-plan-paths-manifest-last',
)
assert.equal(
  offlineRoundTrip.transactionScenarios.accountIsolation.expected,
  'operation-and-cache-inaccessible-cross-account',
)

// These source-anchored checks ensure the assessment cannot silently claim parity
// while the known client implementations still have the recorded blockers.
const androidSerializer = await source(
  'android/app/src/main/java/com/easylab/labnotebook/sync/DriveV1LocalSerializer.kt',
)
const androidDao = await source(
  'android/app/src/main/java/com/easylab/labnotebook/data/local/LabNotebookDao.kt',
)
const androidReader = await source(
  'android/app/src/main/java/com/easylab/labnotebook/sync/DriveReadOnlyMetadataSync.kt',
)
const androidWriter = await source(
  'android/app/src/main/java/com/easylab/labnotebook/sync/GoogleDriveWriteRepository.kt',
)
const webSyncEngine = await source('web/src/sync/syncEngine.ts')
const webDataCore = await source('web/src/sync/dataCore.ts')
const webProvider = await source('web/src/sync/syncProvider.ts')
const androidParityTest = await source(
  'android/app/src/test/java/com/easylab/labnotebook/sync/DriveV1CrossClientParityGateTest.kt',
)
const webParityTest = await source('web/tests/drive-v1-contract.spec.ts')
const androidWriteTransactionTest = await source(
  'android/app/src/test/java/com/easylab/labnotebook/sync/DriveV1WriteTransactionTest.kt',
)
const androidWriteRepositoryTest = await source(
  'android/app/src/test/java/com/easylab/labnotebook/sync/GoogleDriveWriteRepositoryTest.kt',
)
const androidDurableRecoveryTest = await source(
  'android/app/src/test/java/com/easylab/labnotebook/sync/DriveV1DurableTransactionRecoveryTest.kt',
)
const androidRepairTest = await source(
  'android/app/src/test/java/com/easylab/labnotebook/sync/DriveV1PlanRecoveryVerifierTest.kt',
)
const webConditionalTest = await source('web/tests/drive-conditional-provider.spec.ts')
const webTransactionTest = await source('web/tests/sync-transaction.spec.ts')
const webEngineTest = await source('web/tests/sync-engine.spec.ts')
const webProviderTest = await source('web/tests/sync-provider.spec.ts')

assert.match(androidSerializer, /requires a path selected from a complete same-day inventory/)
assert.match(androidSerializer, /thumbnail = thumbnail\?\.takeUnless\(::isLocalCacheHint\)/)
assert.match(androidSerializer, /startsWith\("data:"\)/)
assert.match(androidDao, /val baseRecordId = "del-\$entityKind-\$entityId"/)
assert.match(androidReader, /conf-invalid-\$entityKind-\$\{ref\.path\}/)
assert.match(androidReader, /cacheAsBaseline = false/)
assert.match(androidWriter, /CREATE_FINGERPRINT_PROPERTY = "easylabCreateFingerprint"/)
assert.match(androidWriter, /private suspend fun conditionalCreateMedia/)
assert.match(androidWriter, /private suspend fun reconcileCreatedWrite/)
assert.match(webSyncEngine, /normalizeTombstonesByTarget\(\[\.\.\.snapshot\.tombstones, tombstone\]\)/)
const readRemoteEntries = webSyncEngine.slice(
  webSyncEngine.indexOf('async function readRemoteEntries'),
  webSyncEngine.indexOf('async function readRemoteAttachments'),
)
assert.match(readRemoteEntries, /readValidatedRemoteJson/)
const readRemoteTombstones = webSyncEngine.slice(
  webSyncEngine.indexOf('async function readRemoteTombstones'),
)
assert.match(
  readRemoteTombstones,
  /if \(result\.ok\) valid\.push\(\{ value: result\.value, path: file\.path \}\)/,
)
assert.match(readRemoteTombstones, /exact\?\.path \?\? tombstonePath\(tombstone\)/)
const applyTombstones = webDataCore.slice(
  webDataCore.indexOf('export function applyTombstonesToSnapshot'),
  webDataCore.indexOf('export function buildPendingSyncQueue'),
)
assert.match(applyTombstones, /fileBoxItemId/)
const providerContract = webProvider.slice(
  webProvider.indexOf('export interface SyncProvider'),
  webProvider.indexOf('type RemoteJsonRecord'),
)
assert.match(providerContract, /supportsVersionedCas/)
assert.match(webProvider, /export type PutOptions = \{[\s\S]*precondition: WritePrecondition/)
assert.match(providerContract, /putJson<T>\(path: string, value: T, options: PutOptions\)/)
assert.match(providerContract, /putBlob\(path: string, blob: Blob, metadata: BlobMetadata, options: PutOptions\)/)
assert.match(providerContract, /putManifest<T>\(manifest: T, options: PutOptions\)/)
assert.match(webProvider, /class MockSyncProvider[\s\S]*supportsVersionedCas = true/)
assert.match(webProvider, /class GoogleDriveSyncProvider[\s\S]*supportsVersionedCas = false/)
assert.match(webDataCore, /buildEntryEnvelope[\s\S]*payload: projectEntryPayload\(entry\)/)
assert.match(webDataCore, /buildAttachmentEnvelope[\s\S]*payload: projectAttachmentPayload\(attachment\)/)
assert.match(webSyncEngine, /buildFileBoxEnvelope[\s\S]*payload: projectFileBoxPayload\(item\)/)
assert.match(webSyncEngine, /rawJson: raw\?\.text/)
assert.match(androidParityTest, /fixture\("offline-round-trip\.json"\)/)
assert.match(webParityTest, /offline-round-trip\.json/)
assert.match(webSyncEngine, /revalidateGuardedRemoteIdentity/)
assert.match(webSyncEngine, /record\.plan\.writes\.at\(-1\)\?\.kind === 'manifest'/)
assert.match(webProvider, /acquireTransactionGuard\(operationId: string\)/)
assert.match(webProvider, /readonly supportsVersionedCas = false/)
assert.match(androidWriteTransactionTest, /writesTombstonesThenBlobsBeforeEntityJsonAndPublishesManifestLast/)
assert.match(androidWriteTransactionTest, /dispatchesLargeCreateOnlyBlobToGeneratedIdProtocol/)
assert.match(androidWriteRepositoryTest, /lostCreateResponseReconcilesAndRetryDoesNotCreateADuplicate/)
assert.match(androidWriteRepositoryTest, /resumableBlobInterruptionRetryAndStaleIdentityAreSafe/)
assert.match(androidDurableRecoveryTest, /partialOlderTransactionIsRepairedBeforeNewerMutationIsPlanned/)
assert.match(androidDurableRecoveryTest, /malformedMissingDuplicateAndDeleteEditPlansFailBeforeAnyWrite/)
assert.match(androidRepairTest, /repairScopeRejectsDuplicatesMissingFilesAndUnplannedVersionChanges/)
assert.match(webConditionalTest, /large resumable create survives a lost response/)
assert.match(webConditionalTest, /interrupted resumable update is ambiguous without remote proof/)
assert.match(webTransactionTest, /transaction plan gives every write a precondition and publishes manifest last/)
assert.match(webTransactionTest, /lost manifest response reconciles before the local checkpoint is finalized/)
assert.match(webTransactionTest, /missing baselines, count mismatches, duplicate paths, and stale update races/)
assert.match(webEngineTest, /malformed remote JSON is quarantined without overwriting the source path/)
assert.match(webEngineTest, /entry tombstones prevent stale Drive JSON from resurrecting deleted days/)
assert.match(webProviderTest, /transactional workspace resolution rejects duplicate managed folders/)

console.log(
  `Drive v1 parity assessment passed: ${actualJsonFiles.length} shared JSON fixtures; `
    + `${blockers.size} runtime blocker${blockers.size === 1 ? '' : 's'} keep native writes disabled.`,
)
