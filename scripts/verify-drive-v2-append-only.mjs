import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repositoryRoot, 'contracts', 'drive-v2-append-only')
const protocol = 'easylab-drive-v2-append-only'
const expectedJsonFiles = [
  'canonicalization.json',
  'concurrent-edits.json',
  'cross-client-round-trip.json',
  'delete-edit-race.json',
  'duplicate-artifacts.json',
  'frontier-preservation.json',
  'interrupted-transaction.json',
  'invalid-artifacts.json',
  'isolation.json',
  'live-validation-result.json',
  'policy.json',
  'preflight.json',
  'tombstone-convergence.json',
  'v1-import.json',
]
const objectFields = [
  'baseObjectIds',
  'blobIds',
  'entityId',
  'entityKind',
  'operation',
  'payload',
  'protocol',
  'resolutionOf',
  'schemaVersion',
  'tombstone',
  'workspaceId',
]
const commitFields = [
  'blobIds',
  'createdAt',
  'objectIds',
  'operationId',
  'parentCommitIds',
  'protocol',
  'schemaVersion',
  'workspaceId',
]
const appPropertyFields = [
  'easylabArtifactKind',
  'easylabCanonicalId',
  'easylabContentSha256',
  'easylabDriveProtocol',
  'easylabWorkspaceId',
]
const requiredParentLinks = {
  entry: [],
  attachment: ['entryId'],
  fileBoxItem: ['entryId', 'attachmentId'],
  transfer: ['entryId', 'attachmentId', 'fileBoxItemId'],
}

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8'))
}

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

function requireUnicodeScalars(value) {
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index)
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) contractError('invalid-unicode-scalar')
        index += 1
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        contractError('invalid-unicode-scalar')
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach(requireUnicodeScalars)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      requireUnicodeScalars(key)
      requireUnicodeScalars(nested)
    }
  }
}

function canonicalJsonUnchecked(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonUnchecked).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonUnchecked(value[key])}`).join(',')}}`
}

function canonicalJson(value) {
  requireUnicodeScalars(value)
  return canonicalJsonUnchecked(value)
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'))
}

function objectId(body) {
  return `obj-v2-${sha256Canonical(body)}`
}

function commitId(body) {
  return `commit-v2-${sha256Canonical(body)}`
}

function blobId(bytes) {
  return `blob-v2-${sha256Bytes(bytes)}`
}

function targetKey(value) {
  return `${value.entityKind}:${value.entityId}`
}

function contractError(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function assertContractError(action, expectedCode) {
  assert.throws(action, (error) => error?.code === expectedCode)
}

function isSortedUnique(values) {
  return Array.isArray(values)
    && values.every((value) => typeof value === 'string' && value.length > 0)
    && values.every((value, index) => index === 0 || values[index - 1] < value)
}

function requireSortedUnique(values) {
  if (!isSortedUnique(values)) contractError('set-field-not-sorted-unique')
}

function isCanonicalUtc(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value
}

function assertExactFields(value, fields) {
  assert.deepEqual(Object.keys(value).sort(), fields)
}

function requireExactArtifactFields(value, fields) {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(fields)) {
    contractError('artifact-schema-mismatch')
  }
}

function expectedAppProperties(workspaceId, kind, canonicalId, contentSha256) {
  return {
    easylabDriveProtocol: 'v2-append-only',
    easylabWorkspaceId: workspaceId,
    easylabArtifactKind: kind,
    easylabCanonicalId: canonicalId,
    easylabContentSha256: contentSha256,
  }
}

function validateAppProperties(actual, workspaceId, kind, canonicalId, contentSha256) {
  assertExactFields(actual, appPropertyFields)
  assert.deepEqual(actual, expectedAppProperties(workspaceId, kind, canonicalId, contentSha256))
}

function validateObjectRecord(record, workspaceId = record.body.workspaceId) {
  const { body } = record
  requireExactArtifactFields(body, objectFields)
  validateArtifactNumberDomain(body)
  assert.equal(body.protocol, protocol)
  assert.equal(body.schemaVersion, 2)
  assert.equal(body.workspaceId, workspaceId)
  assert.match(body.workspaceId, /^ws-v2-[0-9a-f]{32}$/)
  assert.ok(typeof body.entityKind === 'string' && body.entityKind.length > 0)
  assert.ok(typeof body.entityId === 'string' && body.entityId.length > 0)
  assert.ok(['upsert', 'tombstone', 'resolve-upsert', 'resolve-tombstone'].includes(body.operation))
  requireSortedUniqueOrEmpty(body.baseObjectIds)
  requireSortedUniqueOrEmpty(body.blobIds)
  requireSortedUniqueOrEmpty(body.resolutionOf)

  const isUpsert = body.operation === 'upsert' || body.operation === 'resolve-upsert'
  if (isUpsert) {
    assert.ok(body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload))
    assert.equal(body.tombstone, null)
    for (const field of requiredParentLinks[body.entityKind] ?? []) {
      if (typeof body.payload[field] !== 'string' || body.payload[field].length === 0) {
        contractError('missing-parent-linkage')
      }
    }
  } else {
    assert.equal(body.payload, null)
    assert.ok(body.tombstone && typeof body.tombstone === 'object' && !Array.isArray(body.tombstone))
    assert.deepEqual(Object.keys(body.tombstone).sort(), ['deletedAt', 'deletedByDeviceId'])
    assert.ok(isCanonicalUtc(body.tombstone.deletedAt))
    assert.ok(typeof body.tombstone.deletedByDeviceId === 'string' && body.tombstone.deletedByDeviceId.length > 0)
  }

  const isResolution = body.operation.startsWith('resolve-')
  if (isResolution) {
    assert.ok(body.resolutionOf.length > 0)
    assert.deepEqual(body.resolutionOf, body.baseObjectIds)
  } else {
    assert.deepEqual(body.resolutionOf, [])
  }

  const digest = sha256Canonical(body)
  if (record.expectedId !== `obj-v2-${digest}`) contractError('canonical-id-mismatch')
  return record.expectedId
}

function validateCommitRecord(record, workspaceId = record.body.workspaceId) {
  const { body } = record
  requireExactArtifactFields(body, commitFields)
  validateArtifactNumberDomain(body)
  assert.equal(body.protocol, protocol)
  assert.equal(body.schemaVersion, 2)
  assert.equal(body.workspaceId, workspaceId)
  assert.match(body.workspaceId, /^ws-v2-[0-9a-f]{32}$/)
  assert.ok(typeof body.operationId === 'string' && body.operationId.length > 0)
  assert.ok(isCanonicalUtc(body.createdAt))
  requireSortedUniqueOrEmpty(body.parentCommitIds)
  requireSortedUniqueOrEmpty(body.objectIds)
  requireSortedUniqueOrEmpty(body.blobIds)
  const digest = sha256Canonical(body)
  if (record.expectedId !== `commit-v2-${digest}`) contractError('canonical-id-mismatch')
  return record.expectedId
}

function validateRemoteJsonRecord(record, workspaceId, kind, expectedParentFolderDriveFileId) {
  if (typeof record.downloadedBytesBase64 !== 'string') contractError('missing-downloaded-json-bytes')
  const downloadedBytes = Buffer.from(record.downloadedBytesBase64, 'base64')
  if (downloadedBytes.toString('base64') !== record.downloadedBytesBase64) {
    contractError('invalid-downloaded-byte-encoding')
  }
  let downloadedText
  try {
    downloadedText = new TextDecoder('utf-8', { fatal: true }).decode(downloadedBytes)
  } catch {
    contractError('invalid-utf8')
  }
  if (!Buffer.from(downloadedText, 'utf8').equals(downloadedBytes)) {
    contractError('noncanonical-json-bytes')
  }
  if (typeof record.downloadedText !== 'string') contractError('missing-downloaded-json-bytes')
  if (record.downloadedText !== downloadedText) contractError('downloaded-text-mismatch')
  let downloadedBody
  try {
    downloadedBody = JSON.parse(downloadedText)
  } catch {
    contractError('malformed-json')
  }
  const canonicalDownloadedText = canonicalJson(downloadedBody)
  if (downloadedText !== canonicalDownloadedText) contractError('noncanonical-json-bytes')
  if (canonicalJson(record.body) !== downloadedText) contractError('downloaded-body-mismatch')
  const downloadedRecord = { ...record, body: downloadedBody }
  const id = kind === 'object'
    ? validateObjectRecord(downloadedRecord, workspaceId)
    : validateCommitRecord(downloadedRecord, workspaceId)
  const digest = sha256Bytes(downloadedBytes)
  assert.ok(typeof record.driveFileId === 'string' && record.driveFileId.length > 0)
  assert.equal(record.parentFolderDriveFileId, expectedParentFolderDriveFileId)
  assert.equal(record.path, `${kind === 'object' ? 'objects' : 'commits'}/${id}.json`)
  assert.equal(record.mimeType, 'application/json')
  assert.equal(record.byteCount, downloadedBytes.length)
  assert.equal(record.expectedContentSha256, digest)
  validateAppProperties(record.appProperties, workspaceId, kind, id, digest)
  return id
}

function validateBlobRecord(record, workspaceId, expectedParentFolderDriveFileId = record.parentFolderDriveFileId) {
  const bytes = Buffer.from(record.bytesBase64, 'base64')
  assert.equal(bytes.toString('base64'), record.bytesBase64)
  const digest = sha256Bytes(bytes)
  assert.equal(record.expectedId, `blob-v2-${digest}`)
  assert.equal(record.expectedContentSha256, digest)
  assert.ok(typeof record.driveFileId === 'string' && record.driveFileId.length > 0)
  assert.equal(record.parentFolderDriveFileId, expectedParentFolderDriveFileId)
  assert.equal(record.path, `blobs/${record.expectedId}.bin`)
  assert.ok(typeof record.mimeType === 'string' && record.mimeType.length > 0)
  assert.equal(record.byteCount, bytes.length)
  validateAppProperties(record.appProperties, workspaceId, 'blob', record.expectedId, digest)
  return record.expectedId
}

function requireSortedUniqueOrEmpty(values) {
  if (!Array.isArray(values)) contractError('set-field-not-sorted-unique')
  if (values.length > 0) requireSortedUnique(values)
}

function validateArtifactNumberDomain(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) contractError('unsupported-artifact-number')
    return
  }
  if (Array.isArray(value)) {
    value.forEach(validateArtifactNumberDomain)
    return
  }
  if (value && typeof value === 'object') Object.values(value).forEach(validateArtifactNumberDomain)
}

function rawGraphTips(graph) {
  const byId = new Map(graph.map((commit) => [commit.id, commit]))
  if (byId.size !== graph.length) contractError('duplicate-commit-id')
  const referenced = new Set()
  for (const commit of graph) {
    for (const parent of commit.parents) {
      if (!byId.has(parent)) contractError('missing-commit-parent')
      referenced.add(parent)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visited.has(id)) return
    if (visiting.has(id)) contractError('commit-cycle')
    visiting.add(id)
    for (const parent of byId.get(id).parents) visit(parent)
    visiting.delete(id)
    visited.add(id)
  }
  for (const commit of graph) visit(commit.id)
  return graph.map((commit) => commit.id).filter((id) => !referenced.has(id)).sort()
}

function frontierForObjectIds(objectIds, objectMap) {
  const included = new Set(objectIds)
  const referencedBases = new Set()
  for (const id of included) {
    const record = objectMap.get(id)
    if (!record) contractError('missing-object-reference')
    for (const baseId of record.body.baseObjectIds) {
      if (!included.has(baseId)) contractError('missing-object-base')
      const base = objectMap.get(baseId)
      if (!base) contractError('missing-object-base')
      if (targetKey(base.body) !== targetKey(record.body)) contractError('cross-target-object-base')
      referencedBases.add(baseId)
    }
  }
  const output = {}
  for (const id of [...included].sort()) {
    if (referencedBases.has(id)) continue
    const key = targetKey(objectMap.get(id).body)
    ;(output[key] ??= []).push(id)
  }
  return output
}

function reachableObjectIdsForCommit(commitIdValue, commitMap, memo = new Map()) {
  if (memo.has(commitIdValue)) return memo.get(commitIdValue)
  const commit = commitMap.get(commitIdValue)
  const ids = new Set(commit.body.objectIds)
  for (const parentId of commit.body.parentCommitIds) {
    for (const objectIdValue of reachableObjectIdsForCommit(parentId, commitMap, memo)) ids.add(objectIdValue)
  }
  memo.set(commitIdValue, ids)
  return ids
}

function validateTransition(parentFrontier, candidate) {
  const expectedBases = parentFrontier.map((item) => item.id).sort()
  const actualBases = [...candidate.baseObjectIds]
  if (canonicalJson(actualBases) !== canonicalJson(expectedBases)) {
    contractError(candidate.operation.startsWith('resolve-') ? 'incomplete-resolution-frontier' : 'incomplete-parent-frontier')
  }
  if (parentFrontier.length > 1 && !candidate.operation.startsWith('resolve-')) {
    contractError('explicit-resolution-required')
  }
  if (candidate.operation.startsWith('resolve-')) {
    if (canonicalJson(candidate.resolutionOf) !== canonicalJson(expectedBases)) {
      contractError('incomplete-resolution-frontier')
    }
  }
  if (
    candidate.operation === 'upsert'
    && parentFrontier.some((item) => item.operation === 'tombstone' || item.operation === 'resolve-tombstone')
  ) {
    contractError('explicit-restore-required')
  }
}

function validateReachableRelationships(objectIds, objectMap) {
  const recordsByTarget = new Map()
  for (const id of objectIds) {
    const record = objectMap.get(id)
    const key = targetKey(record.body)
    const records = recordsByTarget.get(key) ?? []
    records.push(record)
    recordsByTarget.set(key, records)
  }

  const requireTarget = (kind, id) => {
    const records = recordsByTarget.get(`${kind}:${id}`)
    if (!records || records.length === 0) contractError('missing-parent-target')
    return records.filter((record) =>
      record.body.operation === 'upsert' || record.body.operation === 'resolve-upsert')
  }
  const requireConsistentLink = (records, field, expected) => {
    if (records.some((record) => record.body.payload[field] !== expected)) {
      contractError('inconsistent-parent-linkage')
    }
  }

  for (const id of objectIds) {
    const body = objectMap.get(id).body
    if (body.operation !== 'upsert' && body.operation !== 'resolve-upsert') continue
    const payload = body.payload
    switch (body.entityKind) {
      case 'attachment':
        requireTarget('entry', payload.entryId)
        break
      case 'fileBoxItem': {
        requireTarget('entry', payload.entryId)
        const attachments = requireTarget('attachment', payload.attachmentId)
        requireConsistentLink(attachments, 'entryId', payload.entryId)
        break
      }
      case 'transfer': {
        requireTarget('entry', payload.entryId)
        const attachments = requireTarget('attachment', payload.attachmentId)
        const fileBoxItems = requireTarget('fileBoxItem', payload.fileBoxItemId)
        requireConsistentLink(attachments, 'entryId', payload.entryId)
        requireConsistentLink(fileBoxItems, 'entryId', payload.entryId)
        requireConsistentLink(fileBoxItems, 'attachmentId', payload.attachmentId)
        break
      }
      default:
        break
    }
  }
}

function validateWorkspaceSnapshot(fixtureValue, selectedCommitIds = fixtureValue.commits.map((record) => record.expectedId)) {
  const workspaceId = fixtureValue.workspaceId
  const blobRecords = fixtureValue.blobs ?? []
  const objectRecords = fixtureValue.objects ?? []
  const commitRecords = fixtureValue.commits.filter((record) => selectedCommitIds.includes(record.expectedId))
  blobRecords.forEach((record) => validateBlobRecord(record, workspaceId))
  objectRecords.forEach((record) => validateObjectRecord(record, workspaceId))
  commitRecords.forEach((record) => validateCommitRecord(record, workspaceId))
  const objectMap = new Map(objectRecords.map((record) => [record.expectedId, record]))
  const blobMap = new Map(blobRecords.map((record) => [record.expectedId, record]))
  const commitMap = new Map(commitRecords.map((record) => [record.expectedId, record]))
  assert.equal(commitMap.size, commitRecords.length)

  if (commitRecords.length === 0) {
    return {
      tips: [],
      frontiers: {},
      objectMap,
      visibleCommitIds: [],
      visibleObjectIds: [],
    }
  }

  const tips = rawGraphTips(commitRecords.map((record) => ({
    id: record.expectedId,
    parents: record.body.parentCommitIds,
  })))
  if (commitRecords.filter((record) => record.body.parentCommitIds.length === 0).length !== 1) {
    contractError('multiple-genesis-commits')
  }

  const memo = new Map()
  for (const record of commitRecords) {
    for (const objectIdValue of record.body.objectIds) {
      if (!objectMap.has(objectIdValue)) contractError('missing-object-reference')
    }
    for (const blobIdValue of record.body.blobIds) {
      if (!blobMap.has(blobIdValue)) contractError('missing-blob-reference')
    }
    const introducedRecords = record.body.objectIds.map((id) => objectMap.get(id))
    const targets = introducedRecords.map((introduced) => targetKey(introduced.body))
    if (new Set(targets).size !== targets.length) contractError('duplicate-target-in-commit')
    const requiredBlobs = [...new Set(introducedRecords.flatMap((introduced) => introduced.body.blobIds))].sort()
    if (canonicalJson(requiredBlobs) !== canonicalJson(record.body.blobIds)) {
      contractError('commit-blob-reference-mismatch')
    }

    const parentHistory = new Set()
    for (const parentId of record.body.parentCommitIds) {
      for (const id of reachableObjectIdsForCommit(parentId, commitMap, memo)) parentHistory.add(id)
    }
    const parentFrontiers = parentHistory.size === 0 ? {} : frontierForObjectIds(parentHistory, objectMap)
    for (const introduced of introducedRecords) {
      const frontier = (parentFrontiers[targetKey(introduced.body)] ?? []).map((id) => ({
        id,
        operation: objectMap.get(id).body.operation,
      }))
      validateTransition(frontier, introduced.body)
    }
    reachableObjectIdsForCommit(record.expectedId, commitMap, memo)
  }

  const allReachableObjectIds = new Set()
  for (const tip of tips) {
    for (const id of reachableObjectIdsForCommit(tip, commitMap, memo)) allReachableObjectIds.add(id)
  }
  validateReachableRelationships(allReachableObjectIds, objectMap)
  return {
    tips,
    frontiers: frontierForObjectIds(allReachableObjectIds, objectMap),
    objectMap,
    visibleCommitIds: [...commitMap.keys()].sort(),
    visibleObjectIds: [...allReachableObjectIds].sort(),
  }
}

function deterministicConflictId(target, maximalObjectIds) {
  return `conf-v2-${sha256Canonical({
    entityId: target.entityId,
    entityKind: target.entityKind,
    maximalObjectIds: [...new Set(maximalObjectIds)].sort(),
  })}`
}

function classifyFrontier(frontierIds, objectMap) {
  const uniqueIds = [...new Set(frontierIds)].sort()
  assert.ok(uniqueIds.length > 0)
  if (uniqueIds.length > 1) {
    const target = objectMap.get(uniqueIds[0]).body
    return {
      decision: 'deterministic-pending-conflict',
      visible: false,
      conflictId: deterministicConflictId(target, uniqueIds),
    }
  }
  const body = objectMap.get(uniqueIds[0]).body
  const deleted = body.operation === 'tombstone' || body.operation === 'resolve-tombstone'
  return {
    decision: deleted ? 'deleted' : 'live',
    visible: !deleted,
    conflictId: null,
  }
}

function projectFrontiers(frontiers, objectMap) {
  const classifications = {}
  const visible = new Set()
  const suppressed = new Set()
  for (const [target, ids] of Object.entries(frontiers)) {
    const classification = classifyFrontier(ids, objectMap)
    classifications[target] = classification
    if (classification.visible) visible.add(target)
    else suppressed.add(target)
  }

  const requiresVisibleParent = (kind, id) =>
    typeof id === 'string' && id.length > 0 && visible.has(`${kind}:${id}`)
  let changed
  do {
    changed = false
    for (const target of [...visible]) {
      const ids = frontiers[target]
      if (ids.length !== 1) continue
      const body = objectMap.get(ids[0]).body
      const payload = body.payload ?? {}
      const parentsVisible = (() => {
        switch (body.entityKind) {
          case 'attachment':
            return requiresVisibleParent('entry', payload.entryId)
          case 'fileBoxItem':
            return requiresVisibleParent('entry', payload.entryId)
              && requiresVisibleParent('attachment', payload.attachmentId)
          case 'transfer':
            return requiresVisibleParent('entry', payload.entryId)
              && requiresVisibleParent('attachment', payload.attachmentId)
              && requiresVisibleParent('fileBoxItem', payload.fileBoxItemId)
          default:
            return true
        }
      })()
      if (!parentsVisible) {
        visible.delete(target)
        suppressed.add(target)
        changed = true
      }
    }
  } while (changed)

  return {
    classifications,
    visibleTargets: [...visible].sort(),
    suppressedTargets: [...suppressed].sort(),
  }
}

function stripLocalDuplicateIdentity(value) {
  const { driveFileId: _driveFileId, ...remoteIdentity } = value
  return remoteIdentity
}

function operationDescriptor(record) {
  return {
    kind: record.kind,
    canonicalId: record.expectedId,
    generatedDriveFileId: record.driveFileId,
    parentFolderDriveFileId: record.parentFolderDriveFileId,
    path: record.path,
    mimeType: record.mimeType,
    byteCount: record.byteCount,
    contentSha256: record.expectedContentSha256,
  }
}

function setDownloadedJsonText(record, downloadedText) {
  record.downloadedText = downloadedText
  record.downloadedBytesBase64 = Buffer.from(downloadedText, 'utf8').toString('base64')
}

function makeRemoteCommitRecord(body, driveFileId, parentFolderDriveFileId) {
  const digest = sha256Canonical(body)
  const id = `commit-v2-${digest}`
  const record = {
    kind: 'commit',
    driveFileId,
    parentFolderDriveFileId,
    path: `commits/${id}.json`,
    mimeType: 'application/json',
    byteCount: Buffer.byteLength(canonicalJson(body), 'utf8'),
    body,
    expectedId: id,
    expectedContentSha256: digest,
    appProperties: expectedAppProperties(body.workspaceId, 'commit', id, digest),
  }
  setDownloadedJsonText(record, canonicalJson(body))
  return record
}

function rebindRemoteJsonRecord(record) {
  const kind = record.kind ?? (Object.hasOwn(record.body, 'entityKind') ? 'object' : 'commit')
  const downloadedText = canonicalJson(record.body)
  const digest = sha256Bytes(Buffer.from(downloadedText, 'utf8'))
  const id = `${kind === 'object' ? 'obj' : 'commit'}-v2-${digest}`
  setDownloadedJsonText(record, downloadedText)
  record.expectedId = id
  record.expectedContentSha256 = digest
  record.path = `${kind === 'object' ? 'objects' : 'commits'}/${id}.json`
  record.mimeType = 'application/json'
  record.byteCount = Buffer.byteLength(downloadedText, 'utf8')
  record.appProperties = expectedAppProperties(record.body.workspaceId, kind, id, digest)
  return id
}

function makeRemoteObjectRecord(body, driveFileId, parentFolderDriveFileId) {
  const record = {
    kind: 'object',
    driveFileId,
    parentFolderDriveFileId,
    body,
  }
  rebindRemoteJsonRecord(record)
  return record
}

function addObjectsToGenesis(snapshot, objects) {
  snapshot.artifacts.push(...objects)
  const genesis = snapshot.artifacts.find((artifact) =>
    artifact.kind === 'commit' && artifact.body.parentCommitIds.length === 0)
  const previousGenesisId = genesis.expectedId
  genesis.body.objectIds = [...genesis.body.objectIds, ...objects.map((record) => record.expectedId)].sort()
  const reboundGenesisId = rebindRemoteJsonRecord(genesis)
  const child = snapshot.artifacts.find((artifact) =>
    artifact.kind === 'commit' && artifact.body.parentCommitIds.includes(previousGenesisId))
  child.body.parentCommitIds = child.body.parentCommitIds
    .map((id) => id === previousGenesisId ? reboundGenesisId : id)
    .sort()
  rebindRemoteJsonRecord(child)
}

function makeUpsertObjectBody(workspaceId, entityKind, entityId, payload) {
  return {
    protocol,
    schemaVersion: 2,
    workspaceId,
    entityKind,
    entityId,
    operation: 'upsert',
    baseObjectIds: [],
    blobIds: [],
    payload,
    tombstone: null,
    resolutionOf: [],
  }
}

function buildPreflightSnapshot(preflightFixture, artifactFixture) {
  const foldersByRole = Object.fromEntries(
    preflightFixture.managedFolders.map((folder) => [folder.name, folder.driveFileId]),
  )
  const artifacts = [
    ...artifactFixture.blobs.map((record) => ({ ...structuredClone(record), kind: 'blob' })),
    ...artifactFixture.objects.map((record) => ({ ...structuredClone(record), kind: 'object' })),
    ...artifactFixture.commits.map((record) => ({ ...structuredClone(record), kind: 'commit' })),
  ]
  const plannedDescriptors = artifacts.map(operationDescriptor)
    .toSorted((left, right) => left.canonicalId.localeCompare(right.canonicalId))
  return {
    currentAccountScopeId: preflightFixture.accountScopeId,
    currentSavedRootDriveFileId: preflightFixture.savedRootDriveFileId,
    currentWorkspaceId: preflightFixture.workspaceId,
    currentOperationId: preflightFixture.operationId,
    currentManagedFolderIds: structuredClone(foldersByRole),
    currentArtifactDescriptors: structuredClone(plannedDescriptors),
    journal: {
      accountScopeId: preflightFixture.accountScopeId,
      savedRootDriveFileId: preflightFixture.savedRootDriveFileId,
      workspaceId: preflightFixture.workspaceId,
      operationId: preflightFixture.operationId,
      managedFolderIds: structuredClone(foldersByRole),
      artifactDescriptors: structuredClone(plannedDescriptors),
    },
    roots: [structuredClone(preflightFixture.root)],
    folders: structuredClone(preflightFixture.managedFolders),
    artifacts,
  }
}

function applyPreflightMutation(snapshot, mutation) {
  switch (mutation) {
    case 'none':
      return
    case 'add-exact-object-duplicate': {
      const duplicate = structuredClone(snapshot.artifacts.find((artifact) => artifact.kind === 'object'))
      duplicate.driveFileId = 'fixture-exact-duplicate-drive-id'
      snapshot.artifacts.push(duplicate)
      return
    }
    case 'switch-account':
      snapshot.currentAccountScopeId = 'local-account-other'
      return
    case 'switch-saved-root':
      snapshot.currentSavedRootDriveFileId = 'fixture-other-root-drive-id'
      return
    case 'switch-workspace-marker':
      snapshot.roots[0].appProperties.easylabWorkspaceId = 'ws-v2-99999999999999999999999999999999'
      return
    case 'switch-managed-folder-id':
      snapshot.currentManagedFolderIds.objects = 'fixture-other-objects-folder-id'
      return
    case 'add-duplicate-marked-root': {
      const duplicate = structuredClone(snapshot.roots[0])
      duplicate.driveFileId = 'fixture-duplicate-root-drive-id'
      snapshot.roots.push(duplicate)
      return
    }
    case 'add-different-workspace-marked-root': {
      const duplicate = structuredClone(snapshot.roots[0])
      duplicate.driveFileId = 'fixture-different-workspace-root-drive-id'
      duplicate.appProperties.easylabWorkspaceId = 'ws-v2-88888888888888888888888888888888'
      snapshot.roots.push(duplicate)
      return
    }
    case 'add-renamed-marked-root': {
      const duplicate = structuredClone(snapshot.roots[0])
      duplicate.driveFileId = 'fixture-renamed-root-drive-id'
      duplicate.name = 'Renamed Easylab v2 workspace'
      snapshot.roots.push(duplicate)
      return
    }
    case 'add-non-folder-marked-root': {
      const duplicate = structuredClone(snapshot.roots[0])
      duplicate.driveFileId = 'fixture-non-folder-root-drive-id'
      duplicate.mimeType = 'application/json'
      snapshot.roots.push(duplicate)
      return
    }
    case 'switch-operation-id':
      snapshot.currentOperationId = 'op-v2-preflight-stale'
      return
    case 'change-journal-descriptor':
      snapshot.currentArtifactDescriptors[0].contentSha256 = 'f'.repeat(64)
      return
    case 'malform-object-json': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      setDownloadedJsonText(object, '{"protocol":')
      return
    }
    case 'make-object-json-invalid-utf8': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      object.downloadedBytesBase64 = Buffer.from([0xc3, 0x28]).toString('base64')
      return
    }
    case 'make-object-json-utf8-bom': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      const canonicalBytes = Buffer.from(object.downloadedBytesBase64, 'base64')
      object.downloadedBytesBase64 = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        canonicalBytes,
      ]).toString('base64')
      return
    }
    case 'make-object-json-lone-surrogate': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      setDownloadedJsonText(
        object,
        object.downloadedText.replace('Interrupted transaction', '\\ud800'),
      )
      return
    }
    case 'make-object-json-noncanonical': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      setDownloadedJsonText(object, JSON.stringify(object.body))
      return
    }
    case 'remove-commit-field': {
      const commit = snapshot.artifacts.find((artifact) => artifact.kind === 'commit')
      delete commit.body.createdAt
      setDownloadedJsonText(commit, canonicalJson(commit.body))
      return
    }
    case 'add-floating-payload-number': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      object.body.payload.measurement = 0.5
      setDownloadedJsonText(object, canonicalJson(object.body))
      return
    }
    case 'remove-attachment-entry-link': {
      const attachment = snapshot.artifacts.find((artifact) =>
        artifact.kind === 'object' && artifact.body.entityKind === 'attachment')
      delete attachment.body.payload.entryId
      setDownloadedJsonText(attachment, canonicalJson(attachment.body))
      return
    }
    case 'make-malformed-filebox-linkage': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      object.body.entityKind = 'fileBoxItem'
      object.body.entityId = 'file-box-malformed'
      object.body.payload = { id: 'file-box-malformed', entryId: 'entry-interrupted' }
      setDownloadedJsonText(object, canonicalJson(object.body))
      return
    }
    case 'make-malformed-transfer-linkage': {
      const object = snapshot.artifacts.find((artifact) => artifact.kind === 'object')
      object.body.entityKind = 'transfer'
      object.body.entityId = 'transfer-malformed'
      object.body.payload = {
        id: 'transfer-malformed',
        entryId: 'entry-interrupted',
        attachmentId: 'attachment-interrupted',
      }
      setDownloadedJsonText(object, canonicalJson(object.body))
      return
    }
    case 'point-attachment-to-missing-entry': {
      const attachment = snapshot.artifacts.find((artifact) =>
        artifact.kind === 'object' && artifact.body.entityKind === 'attachment')
      const previousAttachmentId = attachment.expectedId
      attachment.body.payload.entryId = 'entry-does-not-exist'
      const reboundAttachmentId = rebindRemoteJsonRecord(attachment)

      const genesis = snapshot.artifacts.find((artifact) =>
        artifact.kind === 'commit' && artifact.body.parentCommitIds.length === 0)
      const previousGenesisId = genesis.expectedId
      genesis.body.objectIds = genesis.body.objectIds
        .map((id) => id === previousAttachmentId ? reboundAttachmentId : id)
        .sort()
      const reboundGenesisId = rebindRemoteJsonRecord(genesis)

      const child = snapshot.artifacts.find((artifact) =>
        artifact.kind === 'commit' && artifact.body.parentCommitIds.includes(previousGenesisId))
      child.body.parentCommitIds = child.body.parentCommitIds
        .map((id) => id === previousGenesisId ? reboundGenesisId : id)
        .sort()
      rebindRemoteJsonRecord(child)
      return
    }
    case 'add-inconsistent-filebox-parent-chain': {
      const otherEntry = makeRemoteObjectRecord(
        makeUpsertObjectBody(snapshot.currentWorkspaceId, 'entry', 'entry-other', {
          id: 'entry-other',
          title: 'Other entry',
        }),
        'fixture-other-entry-object-drive-id',
        snapshot.currentManagedFolderIds.objects,
      )
      const fileBoxItem = makeRemoteObjectRecord(
        makeUpsertObjectBody(snapshot.currentWorkspaceId, 'fileBoxItem', 'file-box-inconsistent', {
          id: 'file-box-inconsistent',
          entryId: 'entry-other',
          attachmentId: 'attachment-interrupted',
        }),
        'fixture-inconsistent-file-box-object-drive-id',
        snapshot.currentManagedFolderIds.objects,
      )
      addObjectsToGenesis(snapshot, [otherEntry, fileBoxItem])
      return
    }
    case 'add-inconsistent-transfer-parent-chain': {
      const otherEntry = makeRemoteObjectRecord(
        makeUpsertObjectBody(snapshot.currentWorkspaceId, 'entry', 'entry-other', {
          id: 'entry-other',
          title: 'Other entry',
        }),
        'fixture-other-entry-object-drive-id',
        snapshot.currentManagedFolderIds.objects,
      )
      const otherAttachment = makeRemoteObjectRecord(
        makeUpsertObjectBody(snapshot.currentWorkspaceId, 'attachment', 'attachment-other', {
          id: 'attachment-other',
          entryId: 'entry-other',
          filename: 'other.txt',
        }),
        'fixture-other-attachment-object-drive-id',
        snapshot.currentManagedFolderIds.objects,
      )
      const otherFileBoxItem = makeRemoteObjectRecord(
        makeUpsertObjectBody(snapshot.currentWorkspaceId, 'fileBoxItem', 'file-box-other', {
          id: 'file-box-other',
          entryId: 'entry-other',
          attachmentId: 'attachment-other',
        }),
        'fixture-other-file-box-object-drive-id',
        snapshot.currentManagedFolderIds.objects,
      )
      const transfer = makeRemoteObjectRecord(
        makeUpsertObjectBody(snapshot.currentWorkspaceId, 'transfer', 'transfer-inconsistent', {
          id: 'transfer-inconsistent',
          entryId: 'entry-interrupted',
          attachmentId: 'attachment-interrupted',
          fileBoxItemId: 'file-box-other',
        }),
        'fixture-inconsistent-transfer-object-drive-id',
        snapshot.currentManagedFolderIds.objects,
      )
      addObjectsToGenesis(snapshot, [otherEntry, otherAttachment, otherFileBoxItem, transfer])
      return
    }
    case 'add-unknown-artifact':
      snapshot.artifacts.push({
        kind: 'future-index',
        driveFileId: 'fixture-unknown-drive-id',
        parentFolderDriveFileId: snapshot.currentManagedFolderIds.objects,
        path: 'objects/future-index.json',
      })
      return
    case 'add-divergent-object-duplicate': {
      const duplicate = structuredClone(snapshot.artifacts.find((artifact) => artifact.kind === 'object'))
      duplicate.driveFileId = 'fixture-divergent-duplicate-drive-id'
      duplicate.body.payload.title = 'Divergent bytes under the same content path'
      setDownloadedJsonText(duplicate, canonicalJson(duplicate.body))
      snapshot.artifacts.push(duplicate)
      return
    }
    case 'remove-referenced-object': {
      const id = snapshot.artifacts.find((artifact) => artifact.kind === 'object').expectedId
      snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.expectedId !== id)
      return
    }
    case 'remove-referenced-blob':
      snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.kind !== 'blob')
      return
    case 'remove-parent-commit': {
      const parentId = snapshot.artifacts
        .filter((artifact) => artifact.kind === 'commit')
        .find((artifact) => artifact.body.parentCommitIds.length === 0).expectedId
      snapshot.artifacts = snapshot.artifacts.filter((artifact) => artifact.expectedId !== parentId)
      return
    }
    case 'make-commit-cycle': {
      const child = snapshot.artifacts
        .filter((artifact) => artifact.kind === 'commit')
        .find((artifact) => artifact.body.parentCommitIds.length > 0)
      child.body.parentCommitIds = [child.expectedId]
      setDownloadedJsonText(child, canonicalJson(child.body))
      return
    }
    case 'add-valid-second-genesis': {
      const body = {
        protocol,
        schemaVersion: 2,
        workspaceId: snapshot.currentWorkspaceId,
        operationId: 'op-v2-second-genesis',
        createdAt: '2026-08-09T10:02:00.000Z',
        parentCommitIds: [],
        objectIds: [],
        blobIds: [],
      }
      snapshot.artifacts.push(makeRemoteCommitRecord(
        body,
        'fixture-second-genesis-drive-id',
        snapshot.currentManagedFolderIds.commits,
      ))
      return
    }
    default:
      assert.fail(`Unhandled preflight mutation: ${mutation}`)
  }
}

function validateRootAndFolders(snapshot) {
  if (snapshot.currentAccountScopeId !== snapshot.journal.accountScopeId) contractError('account-switch')
  if (snapshot.currentSavedRootDriveFileId !== snapshot.journal.savedRootDriveFileId) {
    contractError('saved-root-switch')
  }
  if (snapshot.currentWorkspaceId !== snapshot.journal.workspaceId) contractError('workspace-marker-switch')
  if (snapshot.currentOperationId !== snapshot.journal.operationId) contractError('stale-operation-id')
  if (canonicalJson(snapshot.currentManagedFolderIds) !== canonicalJson(snapshot.journal.managedFolderIds)) {
    contractError('managed-folder-switch')
  }
  if (canonicalJson(snapshot.currentArtifactDescriptors) !== canonicalJson(snapshot.journal.artifactDescriptors)) {
    contractError('changed-artifact-descriptor')
  }

  const root = snapshot.roots.find((candidate) => candidate.driveFileId === snapshot.journal.savedRootDriveFileId)
  if (!root) contractError('saved-root-switch')
  if (root.appProperties.easylabWorkspaceId !== snapshot.journal.workspaceId) {
    contractError('workspace-marker-switch')
  }
  const expectedRootProperties = {
    easylabDriveProtocol: 'v2-append-only',
    easylabWorkspaceId: snapshot.journal.workspaceId,
    easylabArtifactKind: 'workspace-root',
  }
  if (
    root.name !== 'Easylab Lab Notebook v2'
    || canonicalJson(root.parentIds) !== canonicalJson(['root'])
    || root.mimeType !== 'application/vnd.google-apps.folder'
    || root.trashed !== false
    || canonicalJson(root.appProperties) !== canonicalJson(expectedRootProperties)
  ) contractError('workspace-marker-switch')
  const markedRoots = snapshot.roots.filter((candidate) =>
    candidate.trashed === false
    && candidate.appProperties?.easylabDriveProtocol === 'v2-append-only'
    && candidate.appProperties?.easylabArtifactKind === 'workspace-root')
  if (markedRoots.length !== 1) contractError('duplicate-marked-root')

  for (const role of ['blobs', 'commits', 'objects']) {
    const folder = snapshot.folders.find((candidate) => candidate.driveFileId === snapshot.journal.managedFolderIds[role])
    const expectedProperties = {
      easylabDriveProtocol: 'v2-append-only',
      easylabWorkspaceId: snapshot.journal.workspaceId,
      easylabArtifactKind: 'managed-folder',
      easylabFolderRole: role,
    }
    if (
      !folder
      || folder.name !== role
      || canonicalJson(folder.parentIds) !== canonicalJson([root.driveFileId])
      || folder.mimeType !== 'application/vnd.google-apps.folder'
      || folder.trashed !== false
      || canonicalJson(folder.appProperties) !== canonicalJson(expectedProperties)
    ) contractError('managed-folder-switch')
  }
  if (snapshot.folders.length !== 3) contractError('managed-folder-switch')
}

function validateRemoteArtifacts(snapshot) {
  const normalizedArtifacts = snapshot.artifacts.map((artifact) => {
    if (!['blob', 'object', 'commit'].includes(artifact.kind)) contractError('unknown-artifact-kind')
    return structuredClone(artifact)
  })
  const byPath = new Map()
  for (const artifact of normalizedArtifacts) {
    const copies = byPath.get(artifact.path) ?? []
    copies.push(artifact)
    byPath.set(artifact.path, copies)
  }
  const representatives = []
  for (const copies of byPath.values()) {
    const remoteIdentities = copies.map(stripLocalDuplicateIdentity)
    if (remoteIdentities.some((identity) => canonicalJson(identity) !== canonicalJson(remoteIdentities[0]))) {
      contractError('divergent-duplicate')
    }
    representatives.push(copies[0])
  }
  const objects = representatives.filter((artifact) => artifact.kind === 'object')
  const commits = representatives.filter((artifact) => artifact.kind === 'commit')
  const blobs = representatives.filter((artifact) => artifact.kind === 'blob')
  objects.forEach((record) => validateRemoteJsonRecord(
    record,
    snapshot.journal.workspaceId,
    'object',
    snapshot.journal.managedFolderIds.objects,
  ))
  commits.forEach((record) => validateRemoteJsonRecord(
    record,
    snapshot.journal.workspaceId,
    'commit',
    snapshot.journal.managedFolderIds.commits,
  ))
  blobs.forEach((record) => validateBlobRecord(
    record,
    snapshot.journal.workspaceId,
    snapshot.journal.managedFolderIds.blobs,
  ))
  return validateWorkspaceSnapshot({
    workspaceId: snapshot.journal.workspaceId,
    objects,
    commits,
    blobs,
  })
}

function validateBeforePlan(snapshot, writerSpy) {
  assert.equal(writerSpy.calls, 0)
  validateRootAndFolders(snapshot)
  const state = validateRemoteArtifacts(snapshot)
  assert.equal(writerSpy.calls, 0)
  return { kind: 'plan', state }
}

const actualJsonFiles = (await readdir(fixtureRoot))
  .filter((name) => name.endsWith('.json'))
  .sort()
assert.deepEqual(actualJsonFiles, expectedJsonFiles)

const policy = await fixture('policy.json')
assert.equal(policy.gateVersion, 1)
assert.equal(policy.driveContractVersion, 2)
assert.equal(policy.protocol, protocol)
assert.equal(policy.writeGate, 'disabled-pending-explicit-production-rollout-approval')
assert.equal(policy.workspace.rootFolderName, 'Easylab Lab Notebook v2')
assert.deepEqual(policy.workspace.managedFolders, ['objects', 'blobs', 'commits'])
assert.equal(policy.workspace.provisioning, 'explicit-single-client-only')
assert.equal(
  policy.workspace.isolatedValidationContainer,
  'allowed-only-when-its-drive-id-is-bound-in-the-local-operation-journal',
)
assert.equal(policy.workspace.duplicateMarkedRoots, 'block')
assert.equal(policy.workspace.v1Boundary, 'read-only-import-source')
assert.equal(policy.remoteMutation.mode, 'create-only')
assert.equal(policy.remoteMutation.preGeneratedDriveFileIdRequired, true)
assert.equal(policy.remoteMutation.filesUpdateAllowed, false)
assert.equal(policy.remoteMutation.multipartPatchAllowed, false)
assert.equal(policy.remoteMutation.resumablePatchAllowed, false)
assert.equal(policy.remoteMutation.physicalDeletionAllowed, false)
assert.equal(policy.remoteMutation.retryUsesSameDriveFileId, true)
assert.equal(policy.remoteMutation.ambiguousCreateRequiresExactReconciliation, true)
assert.equal(policy.canonicalIdentity.jsonCanonicalization, 'RFC-8785')
assert.equal(policy.canonicalIdentity.digest, 'SHA-256')
assert.ok(policy.canonicalIdentity.forbiddenInputs.includes('driveFileId'))
assert.ok(policy.canonicalIdentity.forbiddenInputs.includes('etag'))
assert.ok(policy.canonicalIdentity.forbiddenInputs.includes('oauthToken'))
assert.ok(policy.canonicalIdentity.forbiddenInputs.includes('accountEmail'))
assert.deepEqual(policy.remoteSchemas.objectEnvelopeBody.exactFields.toSorted(), objectFields)
assert.deepEqual(policy.remoteSchemas.entityRelationships, {
  entry: [],
  attachment: ['entryId'],
  fileBoxItem: ['entryId', 'attachmentId'],
  transfer: ['entryId', 'attachmentId', 'fileBoxItemId'],
  requiredIds: 'nonblank-and-reference-existing-reachable-targets-of-the-declared-kind',
  parentConsistency: 'all-referenced-parent-links-must-agree',
})
assert.deepEqual(policy.remoteSchemas.numberDomain, {
  artifactNumbers: 'signed-safe-integers-only',
  minimum: -9_007_199_254_740_991,
  maximum: 9_007_199_254_740_991,
  decimalMeasurements: 'canonical-decimal-strings',
  unsupportedNumbers: 'block-before-remote-mutation',
})
assert.deepEqual(policy.remoteSchemas.commitBody.exactFields.toSorted(), commitFields)
assert.deepEqual(policy.remoteSchemas.artifactAppProperties.required.toSorted(), appPropertyFields)
assert.equal(policy.paths.object, 'objects/{objectId}.json')
assert.equal(policy.paths.blob, 'blobs/{blobId}.bin')
assert.equal(policy.paths.commit, 'commits/{commitId}.json')
assert.deepEqual(policy.transaction.order, ['blobs', 'objects', 'commit'])
assert.equal(policy.transaction.commitLast, true)
assert.equal(policy.transaction.genesis, 'exactly-one-parentless-commit')
assert.equal(policy.transaction.commitParents, 'all-observed-valid-tips')
assert.equal(policy.transaction.unreferencedPrerequisites, 'inert-orphans')
assert.equal(policy.transaction.emptyWorkspaceBeforeGenesis, 'valid-zero-visible-state')
assert.equal(policy.transaction.plannedCommitValidation, 'full-resulting-graph-before-first-remote-request')
assert.equal(policy.transaction.partialTransactionVisible, false)
assert.equal(policy.transaction.checkpointBeforeVerifiedCommit, false)
assert.equal(policy.frontier.scope, 'per-entity-across-all-valid-reachable-commits')
assert.equal(policy.frontier.unrelatedDescendantCommitPreservesState, true)
assert.equal(policy.frontier.mergeOnlyCommitPreservesEveryEntityFrontier, true)
assert.equal(policy.merge.wallClockTieBreakAllowed, false)
assert.equal(policy.merge.concurrentDivergentEdit, 'deterministic-pending-conflict')
assert.equal(policy.merge.concurrentDivergentEditProjection, 'hidden-until-explicit-resolution')
assert.equal(policy.merge.concurrentDivergentTombstones, 'deterministic-pending-conflict-and-hide-live-target')
assert.equal(policy.merge.regularUpsertAfterTombstone, 'invalid-restore-must-be-explicit')
assert.equal(policy.deletions.physicalDriveDeletion, false)
assert.equal(policy.deletions.nonResurrection, true)
assert.equal(policy.deletions.cascade, 'parent-transitively-suppresses-descendants')
assert.equal(policy.verification.missingReferencedArtifact, 'block')
assert.equal(policy.verification.malformedArtifact, 'block-with-zero-remote-mutation')
assert.equal(policy.verification.graphCycle, 'block-with-zero-remote-mutation')
assert.deepEqual(
  policy.localOperationIdentity.tuple,
  ['accountScopeId', 'savedRootDriveFileId', 'workspaceId', 'operationId'],
)
assert.equal(policy.localOperationIdentity.crossAccountJournalReadAllowed, false)
assert.equal(policy.localOperationIdentity.rootParentSwitch, 'block-with-zero-remote-mutation')
assert.equal(policy.upload.multipartMaximumExclusiveBytes, 5 * 1024 * 1024)
assert.equal(policy.upload.resumableMinimumInclusiveBytes, 5 * 1024 * 1024)
assert.equal(policy.upload.allModesCreateOnly, true)
assert.equal(policy.upload.operationIdentityAccountScoped, true)
assert.equal(policy.upload.sessionUrlPersisted, false)
assert.equal(policy.runtime.contractOnly, true)
assert.equal(policy.runtime.oauthScope, 'https://www.googleapis.com/auth/drive.file')
assert.equal(policy.runtime.androidProductionWired, false)
assert.equal(policy.runtime.webProductionWired, false)
assert.equal(policy.runtime.electronProductionWired, false)
assert.equal(policy.runtime.nativeDriveWritesAllowed, false)
assert.equal(policy.runtime.liveDriveValidationPerformed, true)
assert.equal(policy.runtime.liveDriveValidationPassed, true)
assert.equal(policy.runtime.liveValidationScope, 'isolated-test-only')

const liveValidation = await fixture('live-validation-result.json')
assert.deepEqual(Object.keys(liveValidation).sort(), [
  'checks',
  'production',
  'protocol',
  'validatedSourceCommit',
  'validationMode',
  'version',
].sort())
assert.equal(liveValidation.version, 1)
assert.equal(liveValidation.protocol, protocol)
assert.equal(liveValidation.validationMode, 'isolated-test-only')
assert.equal(liveValidation.validatedSourceCommit, '1d0a3d1450390ed64252589fcbcda233cc7d9a0f')
assert.deepEqual(Object.keys(liveValidation.checks).sort(), [
  'accountExclusionPassed',
  'ambiguousCreateReconciled',
  'appendOnlyRoundTripPassed',
  'commitLastPassed',
  'crossClientReadPassed',
  'driveFileOnlyScopePassed',
  'duplicateArtifactsAbsent',
  'interruptedResumableRecovered',
  'nonResurrectionPassed',
  'physicalDeletionAvoided',
  'productionDriveV2WritesRemainDisabled',
  'stalePlanRejected',
].sort())
assert.equal(liveValidation.checks.accountExclusionPassed, true)
assert.equal(liveValidation.checks.driveFileOnlyScopePassed, true)
assert.equal(liveValidation.checks.appendOnlyRoundTripPassed, true)
assert.equal(liveValidation.checks.commitLastPassed, true)
assert.equal(liveValidation.checks.stalePlanRejected, true)
assert.equal(liveValidation.checks.ambiguousCreateReconciled, true)
assert.equal(liveValidation.checks.interruptedResumableRecovered, true)
assert.equal(liveValidation.checks.crossClientReadPassed, true)
assert.equal(liveValidation.checks.nonResurrectionPassed, true)
assert.equal(liveValidation.checks.duplicateArtifactsAbsent, true)
assert.equal(liveValidation.checks.physicalDeletionAvoided, true)
assert.equal(liveValidation.checks.productionDriveV2WritesRemainDisabled, true)
assert.deepEqual(Object.keys(liveValidation.production).sort(), [
  'androidDriveV2ArtifactWritesEnabled',
  'electronDriveV2ArtifactWritesEnabled',
  'webDriveV2ArtifactWritesEnabled',
].sort())
assert.deepEqual(liveValidation.production, {
  androidDriveV2ArtifactWritesEnabled: false,
  webDriveV2ArtifactWritesEnabled: false,
  electronDriveV2ArtifactWritesEnabled: false,
})

const canonicalization = await fixture('canonicalization.json')
assert.equal(canonicalJson(canonicalization.input), canonicalization.expectedCanonicalJson)
assert.equal(sha256Canonical(canonicalization.input), canonicalization.expectedSha256)

const concurrent = await fixture('concurrent-edits.json')
const concurrentState = validateWorkspaceSnapshot(concurrent)
assert.deepEqual(concurrentState.tips, concurrent.expected.tips)
const concurrentKey = targetKey(concurrent.objects[0].body)
assert.deepEqual(concurrentState.frontiers[concurrentKey], concurrent.expected.maximalObjectIds)
assert.equal(
  deterministicConflictId(concurrent.objects[0].body, concurrentState.frontiers[concurrentKey]),
  concurrent.expected.conflictId,
)
assert.equal(
  classifyFrontier(concurrentState.frontiers[concurrentKey], concurrentState.objectMap).decision,
  concurrent.expected.decision,
)
assert.equal(concurrent.expected.winner, null)
assert.equal(concurrent.expected.remoteOverwriteAllowed, false)

const crossClient = await fixture('cross-client-round-trip.json')
assert.equal(crossClient.liveDriveUsed, false)
assert.equal(crossClient.productionWritesEnabled, false)
assert.equal(crossClient.blobs.length, 1)
const crossClientBlob = crossClient.blobs[0]
const crossClientBlobBytes = Buffer.from(crossClientBlob.bytesBase64, 'base64')
assert.equal(crossClientBlobBytes.toString('base64'), crossClientBlob.bytesBase64)
assert.equal(crossClientBlob.byteCount, crossClientBlobBytes.length)
assert.equal(crossClientBlob.expectedContentSha256, sha256Bytes(crossClientBlobBytes))
assert.equal(crossClientBlob.expectedId, blobId(crossClientBlobBytes))
assert.equal(crossClientBlob.path, `blobs/${crossClientBlob.expectedId}.bin`)
validateBlobRecord(crossClientBlob, crossClient.workspaceId)
for (const record of crossClient.objects) {
  validateObjectRecord(record, crossClient.workspaceId)
  assert.equal(record.expectedContentSha256, sha256Canonical(record.body))
  assert.equal(record.expectedPath, `objects/${record.expectedId}.json`)
}
for (const record of crossClient.commits) {
  validateCommitRecord(record, crossClient.workspaceId)
  assert.equal(record.expectedContentSha256, sha256Canonical(record.body))
  assert.equal(record.expectedPath, `commits/${record.expectedId}.json`)
}
const crossClientObjects = new Map(crossClient.objects.map((record) => [record.expectedId, record]))
const crossClientCommits = new Map(crossClient.commits.map((record) => [record.expectedId, record]))
for (const stage of crossClient.stages) {
  assert.ok(['android', 'web', 'electron'].includes(stage.client))
  const state = validateWorkspaceSnapshot(crossClient, stage.commitIds)
  const projection = projectFrontiers(state.frontiers, state.objectMap)
  assert.deepEqual(state.tips, stage.expected.tips)
  assert.deepEqual(state.frontiers, stage.expected.frontiers)
  assert.deepEqual(projection.visibleTargets, stage.expected.visibleTargets)
  assert.deepEqual(projection.suppressedTargets, stage.expected.suppressedTargets)
}
for (const transaction of crossClient.transactions) {
  const commit = [...crossClientCommits.values()].find(
    (record) => record.body.operationId === transaction.operationId,
  )
  assert.ok(commit)
  assert.equal(commit.origin, transaction.client)
  const expectedOrder = [
    ...commit.body.blobIds.map((id) => `blobs/${id}.bin`),
    ...commit.body.objectIds.map((id) => crossClientObjects.get(id).expectedPath),
    commit.expectedPath,
  ]
  assert.deepEqual(transaction.writeOrder, expectedOrder)
  assert.equal(transaction.commitLast, true)
  assert.equal(transaction.writeOrder.at(-1), commit.expectedPath)
}
const finalCrossClientStage = crossClient.stages.find((stage) => stage.name === 'android-return')
assert.ok(finalCrossClientStage)
const finalCrossClientState = validateWorkspaceSnapshot(crossClient, finalCrossClientStage.commitIds)
assert.equal(
  finalCrossClientState.visibleObjectIds.includes(crossClient.recovery.uncommittedObjectId),
  crossClient.recovery.orphanVisible,
)
assert.equal(crossClient.recovery.resurrectionAllowed, false)
assert.equal(crossClient.recovery.physicalDeletionCount, 0)
const preservedPayloads = crossClient.objects
  .filter((record) => record.body.payload !== null && record.body.entityKind === 'entry')
  .map((record) => record.body.payload)
assert.ok(preservedPayloads.every((payload) => Object.hasOwn(payload, crossClient.recovery.unknownRemoteField)))
assert.equal(crossClient.recovery.unknownRemoteFieldPreserved, true)
for (const localOnlyField of crossClient.recovery.localOnlyFieldsAbsent) {
  assert.ok(preservedPayloads.every((payload) => !Object.hasOwn(payload, localOnlyField)))
}

const frontierFixture = await fixture('frontier-preservation.json')
const frontierState = validateWorkspaceSnapshot(frontierFixture)
assert.deepEqual(frontierState.tips, frontierFixture.expected.tips)
assert.deepEqual(frontierState.frontiers, frontierFixture.expected.frontiers)
assert.equal(frontierFixture.expected.entryAConflictRemains, true)
assert.equal(frontierFixture.expected.mergeOnlyPreservesState, true)

const deleteEdit = await fixture('delete-edit-race.json')
const raceState = validateWorkspaceSnapshot(deleteEdit, deleteEdit.raceSnapshot.commitIds)
const deleteEditKey = `${deleteEdit.target.entityKind}:${deleteEdit.target.entityId}`
assert.deepEqual(raceState.frontiers[deleteEditKey], deleteEdit.raceSnapshot.expected.frontier)
assert.equal(
  deterministicConflictId(deleteEdit.target, raceState.frontiers[deleteEditKey]),
  deleteEdit.raceSnapshot.expected.conflictId,
)
const raceProjection = projectFrontiers(raceState.frontiers, raceState.objectMap)
assert.equal(raceProjection.classifications[deleteEditKey].decision, deleteEdit.raceSnapshot.expected.decision)
assert.deepEqual(raceProjection.visibleTargets, deleteEdit.raceSnapshot.expected.visibleTargets)
assert.deepEqual(raceProjection.suppressedTargets, deleteEdit.raceSnapshot.expected.suppressedTargets)
assert.equal(
  raceProjection.visibleTargets.includes(deleteEditKey),
  deleteEdit.raceSnapshot.expected.resurrectionAllowed,
)
assert.deepEqual(
  deleteEdit.raceSnapshot.expected.resolutionMustReference,
  raceState.frontiers[deleteEditKey],
)
const resolvedState = validateWorkspaceSnapshot(deleteEdit, deleteEdit.resolvedSnapshot.commitIds)
assert.deepEqual(resolvedState.frontiers[deleteEditKey], deleteEdit.resolvedSnapshot.expected.frontier)
const resolvedProjection = projectFrontiers(resolvedState.frontiers, resolvedState.objectMap)
assert.deepEqual(resolvedProjection.visibleTargets, deleteEdit.resolvedSnapshot.expected.visibleTargets)
assert.deepEqual(resolvedProjection.suppressedTargets, deleteEdit.resolvedSnapshot.expected.suppressedTargets)
assert.equal(deleteEdit.resolvedSnapshot.expected.explicitResolution, true)

const tombstones = await fixture('tombstone-convergence.json')
const tombstoneMap = new Map(tombstones.objects.map((record) => {
  validateObjectRecord(record, tombstones.workspaceId)
  return [record.expectedId, record]
}))
const identical = tombstones.scenarios.identicalConcurrentCopies
assert.deepEqual([...new Set(identical.frontier)].sort(), identical.expectedUniqueFrontier)
assert.equal(identical.decision, 'converge')
for (const scenario of [
  tombstones.scenarios.unequalInstantConcurrent,
  tombstones.scenarios.equalInstantDivergent,
]) {
  const selected = new Set([
    tombstones.objects[0].expectedId,
    ...scenario.frontier,
  ])
  const derived = frontierForObjectIds(selected, tombstoneMap)[targetKey(tombstones.target)]
  assert.deepEqual(derived, scenario.frontier)
  const classification = classifyFrontier(derived, tombstoneMap)
  assert.equal(classification.conflictId, scenario.expectedConflictId)
  assert.equal(classification.decision, scenario.decision)
  assert.equal(classification.visible, scenario.liveTargetVisible)
}
const causalScenario = tombstones.scenarios.causalTombstone
const causalSelected = new Set([
  tombstones.objects[0].expectedId,
  ...causalScenario.superseded,
  ...causalScenario.frontier,
])
assert.deepEqual(
  frontierForObjectIds(causalSelected, tombstoneMap)[targetKey(tombstones.target)],
  causalScenario.frontier,
)
assert.equal(classifyFrontier(causalScenario.frontier, tombstoneMap).decision, causalScenario.decision)
assert.equal(tombstones.wallClockTieBreakAllowed, false)

const interrupted = await fixture('interrupted-transaction.json')
interrupted.blobs.forEach((record) => validateBlobRecord(record, interrupted.workspaceId))
interrupted.objects.forEach((record) => validateRemoteJsonRecord(
  record,
  interrupted.workspaceId,
  'object',
  'fixture-v2-objects-folder-id',
))
interrupted.commits.forEach((record) => validateRemoteJsonRecord(
  record,
  interrupted.workspaceId,
  'commit',
  'fixture-v2-commits-folder-id',
))
const allArtifactIds = new Set([
  ...interrupted.blobs.map((record) => record.expectedId),
  ...interrupted.objects.map((record) => record.expectedId),
  ...interrupted.commits.map((record) => record.expectedId),
])
for (const phase of interrupted.phases) {
  assert.ok(phase.presentArtifactIds.every((id) => allArtifactIds.has(id)))
  const presentCommitIds = interrupted.commits
    .map((record) => record.expectedId)
    .filter((id) => phase.presentArtifactIds.includes(id))
  if (presentCommitIds.length === 0) {
    assert.equal(phase.expected, 'no-visible-commit')
    const state = validateWorkspaceSnapshot(interrupted, [])
    assert.deepEqual(state.tips, [])
    assert.deepEqual(state.frontiers, {})
    assert.deepEqual(state.visibleObjectIds, [])
    continue
  }
  const required = interrupted.commits
    .filter((record) => presentCommitIds.includes(record.expectedId))
    .flatMap((record) => [...record.body.objectIds, ...record.body.blobIds])
  assert.ok(required.every((id) => phase.presentArtifactIds.includes(id)))
  const state = validateWorkspaceSnapshot(interrupted, presentCommitIds)
  assert.equal(phase.expected, 'verified-visible-commit')
  assert.deepEqual(state.visibleCommitIds, interrupted.expected.visibleCommitIds)
  assert.deepEqual(state.visibleObjectIds, interrupted.expected.visibleObjectIds)
}
assert.equal(interrupted.expected.commitPublishedLast, true)
assert.equal(interrupted.expected.orphanPrerequisitesVisible, false)
assert.equal(interrupted.expected.retryUsesPersistedDriveFileIds, true)
assert.equal(interrupted.expected.manifestSingletonRequired, false)

const duplicates = await fixture('duplicate-artifacts.json')
const exactRemoteIdentities = duplicates.exactCopies.map(stripLocalDuplicateIdentity)
assert.equal(new Set(duplicates.exactCopies.map((copy) => copy.driveFileId)).size, 2)
assert.deepEqual(exactRemoteIdentities[0], exactRemoteIdentities[1])
assert.notDeepEqual(exactRemoteIdentities[0], stripLocalDuplicateIdentity(duplicates.divergentCopy))
for (const copy of [...duplicates.exactCopies, duplicates.divergentCopy]) {
  const canonicalId = copy.appProperties.easylabCanonicalId
  assert.equal(copy.path, `objects/${canonicalId}.json`)
  assert.equal(copy.appProperties.easylabContentSha256, copy.contentSha256)
  assert.equal(copy.mimeType, 'application/json')
  assert.equal(copy.parentFolderDriveFileId, 'fixture-v2-objects-folder-id')
}
const exactDecision = exactRemoteIdentities.every(
  (identity) => canonicalJson(identity) === canonicalJson(exactRemoteIdentities[0]),
) ? 'equivalent' : 'block'
const divergentDecision = [...duplicates.exactCopies, duplicates.divergentCopy]
  .map(stripLocalDuplicateIdentity)
  .every((identity) => canonicalJson(identity) === canonicalJson(exactRemoteIdentities[0]))
  ? 'equivalent'
  : 'block'
assert.equal(exactDecision, duplicates.expected.exactCopiesDecision)
assert.equal(divergentDecision, duplicates.expected.divergentCopiesDecision)
assert.equal(duplicates.expected.driveFileIdAffectsCanonicalIdentity, false)
assert.equal(duplicates.expected.remoteMutationAllowedAfterDivergence, false)

const invalid = await fixture('invalid-artifacts.json')
for (const invalidCase of invalid.cases) {
  switch (invalidCase.name) {
    case 'malformed-json':
      assert.throws(() => JSON.parse(invalidCase.artifactText), SyntaxError)
      assert.equal(invalidCase.expectedError, 'malformed-json')
      break
    case 'unknown-artifact-kind':
      assertContractError(() => {
        if (!['blob', 'object', 'commit'].includes(invalidCase.artifact.kind)) contractError('unknown-artifact-kind')
      }, invalidCase.expectedError)
      break
    case 'artifact-schema-mismatch':
      assertContractError(() => {
        if (canonicalJson(invalidCase.actualFields.toSorted()) !== canonicalJson(invalidCase.allowedFields.toSorted())) {
          contractError('artifact-schema-mismatch')
        }
      }, invalidCase.expectedError)
      break
    case 'canonical-id-mismatch':
      assertContractError(() => {
        if (invalidCase.claimedId !== invalidCase.derivedId) contractError('canonical-id-mismatch')
      }, invalidCase.expectedError)
      break
    case 'missing-commit-parent':
    case 'commit-cycle':
      assertContractError(() => rawGraphTips(invalidCase.graph), invalidCase.expectedError)
      break
    case 'multiple-genesis-commits':
      assertContractError(() => {
        rawGraphTips(invalidCase.graph)
        if (invalidCase.graph.filter((commit) => commit.parents.length === 0).length !== 1) {
          contractError('multiple-genesis-commits')
        }
      }, invalidCase.expectedError)
      break
    case 'missing-object-reference':
      assertContractError(() => {
        for (const id of invalidCase.commitReferences.objectIds) {
          if (!invalidCase.availableObjectIds.includes(id)) contractError('missing-object-reference')
        }
      }, invalidCase.expectedError)
      break
    case 'missing-blob-reference':
      assertContractError(() => {
        for (const id of invalidCase.commitReferences.blobIds) {
          if (!invalidCase.availableBlobIds.includes(id)) contractError('missing-blob-reference')
        }
      }, invalidCase.expectedError)
      break
    case 'divergent-duplicate':
    case 'divergent-commit-duplicate':
      assertContractError(() => {
        if (new Set(invalidCase.copies.map((copy) => copy.contentSha256)).size !== 1) {
          contractError('divergent-duplicate')
        }
      }, invalidCase.expectedError)
      break
    case 'missing-object-base':
      assertContractError(() => {
        for (const id of invalidCase.object.baseObjectIds) {
          if (!invalidCase.availableObjects.some((object) => object.id === id)) contractError('missing-object-base')
        }
      }, invalidCase.expectedError)
      break
    case 'cross-target-object-base':
      assertContractError(() => {
        const base = invalidCase.availableObjects.find((object) => object.id === invalidCase.object.baseObjectIds[0])
        if (targetKey(base) !== targetKey(invalidCase.object)) contractError('cross-target-object-base')
      }, invalidCase.expectedError)
      break
    case 'regular-upsert-after-tombstone':
    case 'incomplete-resolution':
      assertContractError(
        () => validateTransition(invalidCase.parentFrontier, invalidCase.candidate),
        invalidCase.expectedError,
      )
      break
    case 'unsorted-set-field':
    case 'duplicate-set-field':
      assertContractError(() => requireSortedUnique(invalidCase.values), invalidCase.expectedError)
      break
    default:
      assert.fail(`Unhandled invalid fixture case: ${invalidCase.name}`)
  }
}
assert.equal(invalid.expected.everyCaseBlocksRemoteMutation, true)
assert.equal(invalid.expected.malformedArtifactCanResurrect, false)
assert.equal(invalid.expected.unknownArtifactCanBecomeParent, false)

const isolation = await fixture('isolation.json')
for (const resumeCase of isolation.resumeCases) {
  const exactTuple = ['accountScopeId', 'savedRootDriveFileId', 'workspaceId', 'operationId']
    .every((key) => resumeCase.current[key] === isolation.storedIdentity[key])
  const folderMatches = resumeCase.current.managedFolderSetId === resumeCase.storedManagedFolderSetId
  const oneRoot = resumeCase.current.matchingMarkedRootCount === 1
  assert.equal(exactTuple && folderMatches && oneRoot ? 'resume' : 'block-zero-mutation', resumeCase.expected)
}
for (const descriptorCase of isolation.descriptorCases) {
  assert.equal(
    canonicalJson(descriptorCase.current) === canonicalJson(isolation.immutableArtifactDescriptors)
      ? 'resume'
      : 'block-zero-mutation',
    descriptorCase.expected,
  )
}
assert.equal(isolation.sameOperationIdOtherAccount.operationId, isolation.storedIdentity.operationId)
assert.notEqual(isolation.sameOperationIdOtherAccount.accountScopeId, isolation.storedIdentity.accountScopeId)
assert.equal(isolation.sameOperationIdOtherAccount.canReadStoredAccountAJournal, false)
const remoteBodies = [
  ...concurrent.objects.map((record) => record.body),
  ...concurrent.commits.map((record) => record.body),
  ...interrupted.objects.map((record) => record.body),
  ...interrupted.commits.map((record) => record.body),
]
const remoteBodyText = canonicalJson(remoteBodies)
for (const key of isolation.remoteCanonicalBodiesContain) assert.match(remoteBodyText, new RegExp(`"${key}"`))
for (const key of isolation.remoteCanonicalBodiesExclude) assert.doesNotMatch(remoteBodyText, new RegExp(`"${key}"`))

const preflightFixture = await fixture('preflight.json')
assert.equal(preflightFixture.artifactFixture, 'interrupted-transaction.json')
for (const preflightCase of preflightFixture.cases) {
  const snapshot = buildPreflightSnapshot(preflightFixture, interrupted)
  const writerSpy = { calls: 0 }
  applyPreflightMutation(snapshot, preflightCase.mutation)
  if (preflightCase.expected === 'plan') {
    assert.equal(validateBeforePlan(snapshot, writerSpy).kind, 'plan')
  } else {
    assertContractError(() => validateBeforePlan(snapshot, writerSpy), preflightCase.expected)
  }
  assert.equal(writerSpy.calls, preflightCase.writerCalls)
}

const migration = await fixture('v1-import.json')
assert.equal(migration.source.protocol, 'drive-v1')
assert.equal(migration.source.mode, 'read-only')
assert.equal(migration.source.manifestVerified, true)
assert.equal(migration.source.completeInventoryVerified, true)
assert.equal(migration.source.duplicates, false)
assert.equal(migration.source.malformedRecords, false)
assert.equal(migration.destination.protocol, policy.protocol)
assert.equal(migration.destination.commitKind, 'genesis-import')
assert.deepEqual(migration.destination.parentCommitIds, [])
validateObjectRecord(migration.destination.object)
validateCommitRecord(migration.destination.commit)
assert.equal(objectId(migration.repeatImport.objectBody), migration.repeatImport.expectedObjectId)
assert.equal(commitId(migration.repeatImport.commitBody), migration.repeatImport.expectedCommitId)
assert.equal(migration.repeatImport.expectedObjectId, migration.destination.object.expectedId)
assert.equal(migration.repeatImport.expectedCommitId, migration.destination.commit.expectedId)
assert.equal(migration.expected.v1MutationCount, 0)
assert.equal(migration.expected.v1PhysicalDeletionCount, 0)
assert.equal(migration.expected.v2CommitPublishedLast, true)
assert.equal(migration.expected.repeatImportWithSameSnapshot, 'same-canonical-commit-id')
assert.equal(migration.expected.missingOrMalformedV1Input, 'block')

const v1Policy = JSON.parse(await source('contracts/drive-v1-parity/policy.json'))
assert.equal(v1Policy.runtimeParity.nativeDriveWritesAllowed, false)
assert.equal(v1Policy.remoteVersion.liveVersionedCasValidationPerformed, false)
const syncWorker = await source('android/app/src/main/java/com/easylab/labnotebook/sync/SyncWorker.kt')
assert.match(syncWorker, /NativeDriveReadOnlyFactory\.create/)
assert.doesNotMatch(syncWorker, /GoogleDriveWriteRepository\s*\(/)
const webProvider = await source('web/src/sync/syncProvider.ts')
assert.match(webProvider, /class GoogleDriveSyncProvider[\s\S]*?supportsVersionedCas = false/)

console.log(`Drive v2 append-only contract verified: ${actualJsonFiles.length} fixtures; all production Drive writes disabled.`)
