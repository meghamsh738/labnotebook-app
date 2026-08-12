import {
  DriveV2ContractError,
  driveV2CanonicalJson,
  driveV2CanonicalSha256,
  driveV2Sha256,
  type DriveV2JsonObject,
  type DriveV2JsonValue,
} from './driveV2CanonicalJson'

export const DRIVE_V2_PROTOCOL = 'easylab-drive-v2-append-only'
export const DRIVE_V2_WORKSPACE_ROOT_NAME = 'Easylab Lab Notebook v2'
export const DRIVE_V2_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
export const DRIVE_V2_JSON_MIME_TYPE = 'application/json'
export const DRIVE_V2_MANAGED_FOLDER_ROLES = ['blobs', 'commits', 'objects'] as const
export const DRIVE_V2_RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024

const workspaceIdPattern = /^ws-v2-[0-9a-f]{32}$/
const safeIntegerMaximum = 9_007_199_254_740_991
const objectFields = [
  'baseObjectIds', 'blobIds', 'entityId', 'entityKind', 'operation', 'payload',
  'protocol', 'resolutionOf', 'schemaVersion', 'tombstone', 'workspaceId',
].sort()
const commitFields = [
  'blobIds', 'createdAt', 'objectIds', 'operationId', 'parentCommitIds',
  'protocol', 'schemaVersion', 'workspaceId',
].sort()
const operations = new Set(['upsert', 'tombstone', 'resolve-upsert', 'resolve-tombstone'])
const requiredParentLinks: Record<string, readonly string[]> = {
  entry: [],
  attachment: ['entryId'],
  fileBoxItem: ['entryId', 'attachmentId'],
  transfer: ['entryId', 'attachmentId', 'fileBoxItemId'],
}

export type DriveV2ObjectRecord = { readonly expectedId: string; readonly body: DriveV2JsonObject }
export type DriveV2CommitRecord = { readonly expectedId: string; readonly body: DriveV2JsonObject }
export type DriveV2BlobRecord = { readonly expectedId: string; readonly bytes: Uint8Array; readonly mimeType: string }
export type DriveV2FrontierDecision = {
  readonly decision: 'deterministic-pending-conflict' | 'deleted' | 'live'
  readonly visible: boolean
  readonly conflictId: string | null
}
export type DriveV2WorkspaceState = {
  readonly tips: readonly string[]
  readonly frontiers: Readonly<Record<string, readonly string[]>>
  readonly objectMap: ReadonlyMap<string, DriveV2ObjectRecord>
  readonly visibleCommitIds: readonly string[]
  readonly visibleObjectIds: readonly string[]
}
export type DriveV2Projection = {
  readonly classifications: Readonly<Record<string, DriveV2FrontierDecision>>
  readonly visibleTargets: readonly string[]
  readonly suppressedTargets: readonly string[]
}

function fail(code: string): never {
  throw new DriveV2ContractError(code)
}

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) fail(code)
}

function recordValue(value: unknown, code = 'artifact-schema-mismatch'): DriveV2JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') fail(code)
  return value as DriveV2JsonObject
}

function text(value: DriveV2JsonObject, name: string, code = 'artifact-schema-mismatch'): string {
  const candidate = value[name]
  if (typeof candidate !== 'string') fail(code)
  return candidate
}

function nonblankText(value: DriveV2JsonObject, name: string, code = 'artifact-schema-mismatch'): string {
  const candidate = text(value, name, code)
  if (!candidate.trim()) fail(code)
  return candidate
}

function stringList(value: DriveV2JsonObject, name: string): string[] {
  const candidate = value[name]
  if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== 'string')) {
    fail('artifact-schema-mismatch')
  }
  return candidate as string[]
}

function requireSortedUnique(values: readonly string[]) {
  requireCondition(
    values.every((value) => value.length > 0)
      && values.every((value, index) => index === 0 || values[index - 1] < value),
    'set-field-not-sorted-unique',
  )
}

function requireExactFields(value: DriveV2JsonObject, expected: readonly string[]) {
  requireCondition(driveV2CanonicalJson(Object.keys(value).sort()) === driveV2CanonicalJson(expected), 'artifact-schema-mismatch')
}

function requireArtifactNumberDomain(value: DriveV2JsonValue) {
  if (typeof value === 'number') {
    requireCondition(Number.isSafeInteger(value) && Math.abs(value) <= safeIntegerMaximum, 'unsupported-artifact-number')
  } else if (Array.isArray(value)) {
    value.forEach(requireArtifactNumberDomain)
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(requireArtifactNumberDomain)
  }
}

function requireWorkspace(actual: string, expected: string) {
  requireCondition(workspaceIdPattern.test(actual) && actual === expected, 'workspace-marker-switch')
}

function requireCanonicalUtc(value: string) {
  requireCondition(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), 'noncanonical-utc')
  try {
    requireCondition(new Date(value).toISOString() === value, 'noncanonical-utc')
  } catch {
    fail('noncanonical-utc')
  }
}

function cloneObject(value: DriveV2JsonObject): DriveV2JsonObject {
  const freeze = (candidate: DriveV2JsonValue): DriveV2JsonValue => {
    if (Array.isArray(candidate)) {
      candidate.forEach(freeze)
      Object.freeze(candidate)
      return candidate
    }
    if (candidate !== null && typeof candidate === 'object') {
      Object.values(candidate).forEach(freeze)
      Object.freeze(candidate)
      return candidate
    }
    return candidate
  }
  return freeze(structuredClone(value)) as DriveV2JsonObject
}

class DriveV2ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>

  constructor(values: Iterable<readonly [K, V]>) {
    this.#values = new Map(values)
    Object.freeze(this)
  }

  get size() { return this.#values.size }
  get [Symbol.toStringTag]() { return 'DriveV2ImmutableMap' }
  entries() { return this.#values.entries() }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
    this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this))
  }
  get(key: K) { return this.#values.get(key) }
  has(key: K) { return this.#values.has(key) }
  keys() { return this.#values.keys() }
  values() { return this.#values.values() }
  [Symbol.iterator]() { return this.#values[Symbol.iterator]() }
}

function immutableFrontiers(value: Record<string, string[]>): Readonly<Record<string, readonly string[]>> {
  const entries = Object.entries(value).map(([key, ids]) => [key, Object.freeze([...ids])] as const)
  return Object.freeze(Object.fromEntries(entries))
}

export async function driveV2ObjectId(body: DriveV2JsonObject): Promise<string> {
  return `obj-v2-${await driveV2CanonicalSha256(body)}`
}

export async function driveV2CommitId(body: DriveV2JsonObject): Promise<string> {
  return `commit-v2-${await driveV2CanonicalSha256(body)}`
}

export async function driveV2BlobId(bytes: Uint8Array): Promise<string> {
  return `blob-v2-${await driveV2Sha256(bytes)}`
}

export function driveV2ObjectPath(id: string): string {
  return `objects/${id}.json`
}

export function driveV2CommitPath(id: string): string {
  return `commits/${id}.json`
}

export function driveV2BlobPath(id: string): string {
  return `blobs/${id}.bin`
}

export function driveV2AppProperties(
  workspaceId: string,
  kind: string,
  canonicalId: string,
  contentSha256: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    easylabArtifactKind: kind,
    easylabCanonicalId: canonicalId,
    easylabContentSha256: contentSha256,
    easylabDriveProtocol: 'v2-append-only',
    easylabWorkspaceId: workspaceId,
  })
}

export async function validateDriveV2Object(
  record: DriveV2ObjectRecord,
  workspaceId = text(record.body, 'workspaceId'),
): Promise<string> {
  const expectedId = record.expectedId
  const body = cloneObject(record.body)
  requireExactFields(body, objectFields)
  requireArtifactNumberDomain(body)
  requireCondition(text(body, 'protocol') === DRIVE_V2_PROTOCOL, 'artifact-schema-mismatch')
  requireCondition(body.schemaVersion === 2, 'artifact-schema-mismatch')
  requireWorkspace(text(body, 'workspaceId'), workspaceId)
  const entityKind = nonblankText(body, 'entityKind')
  nonblankText(body, 'entityId')
  const operation = text(body, 'operation')
  requireCondition(operations.has(operation), 'artifact-schema-mismatch')
  const bases = stringList(body, 'baseObjectIds')
  const blobIds = stringList(body, 'blobIds')
  const resolution = stringList(body, 'resolutionOf')
  requireSortedUnique(bases)
  requireSortedUnique(blobIds)
  requireSortedUnique(resolution)

  const isUpsert = operation === 'upsert' || operation === 'resolve-upsert'
  if (isUpsert) {
    const payload = recordValue(body.payload)
    requireCondition(body.tombstone === null, 'artifact-schema-mismatch')
    for (const field of requiredParentLinks[entityKind] ?? []) nonblankText(payload, field, 'missing-parent-linkage')
  } else {
    requireCondition(body.payload === null, 'artifact-schema-mismatch')
    const tombstone = recordValue(body.tombstone)
    requireExactFields(tombstone, ['deletedAt', 'deletedByDeviceId'])
    requireCanonicalUtc(text(tombstone, 'deletedAt'))
    nonblankText(tombstone, 'deletedByDeviceId')
  }

  if (operation.startsWith('resolve-')) {
    requireCondition(resolution.length > 0 && driveV2CanonicalJson(resolution) === driveV2CanonicalJson(bases), 'incomplete-resolution-frontier')
  } else {
    requireCondition(resolution.length === 0, 'artifact-schema-mismatch')
  }
  requireCondition(expectedId === await driveV2ObjectId(body), 'canonical-id-mismatch')
  return expectedId
}

export async function validateDriveV2Commit(
  record: DriveV2CommitRecord,
  workspaceId = text(record.body, 'workspaceId'),
): Promise<string> {
  const expectedId = record.expectedId
  const body = cloneObject(record.body)
  requireExactFields(body, commitFields)
  requireArtifactNumberDomain(body)
  requireCondition(text(body, 'protocol') === DRIVE_V2_PROTOCOL, 'artifact-schema-mismatch')
  requireCondition(body.schemaVersion === 2, 'artifact-schema-mismatch')
  requireWorkspace(text(body, 'workspaceId'), workspaceId)
  nonblankText(body, 'operationId')
  requireCanonicalUtc(text(body, 'createdAt'))
  requireSortedUnique(stringList(body, 'parentCommitIds'))
  requireSortedUnique(stringList(body, 'objectIds'))
  requireSortedUnique(stringList(body, 'blobIds'))
  requireCondition(expectedId === await driveV2CommitId(body), 'canonical-id-mismatch')
  return expectedId
}

function targetKey(body: DriveV2JsonObject): string {
  return `${text(body, 'entityKind')}:${text(body, 'entityId')}`
}

function graphTips(commits: ReadonlyMap<string, DriveV2CommitRecord>): string[] {
  const referenced = new Set<string>()
  for (const commit of commits.values()) {
    for (const parent of stringList(commit.body, 'parentCommitIds')) {
      requireCondition(commits.has(parent), 'missing-commit-parent')
      referenced.add(parent)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) fail('commit-cycle')
    visiting.add(id)
    for (const parent of stringList(commits.get(id)!.body, 'parentCommitIds')) visit(parent)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of commits.keys()) visit(id)
  return [...commits.keys()].filter((id) => !referenced.has(id)).sort()
}

function reachableObjectIds(
  commitId: string,
  commits: ReadonlyMap<string, DriveV2CommitRecord>,
  memo: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = memo.get(commitId)
  if (cached) return cached
  const commit = commits.get(commitId) ?? fail('missing-commit-parent')
  const ids = new Set(stringList(commit.body, 'objectIds'))
  for (const parent of stringList(commit.body, 'parentCommitIds')) {
    for (const id of reachableObjectIds(parent, commits, memo)) ids.add(id)
  }
  memo.set(commitId, ids)
  return ids
}

function frontier(
  objectIds: Iterable<string>,
  objects: ReadonlyMap<string, DriveV2ObjectRecord>,
): Record<string, string[]> {
  const included = new Set(objectIds)
  const referencedBases = new Set<string>()
  for (const id of included) {
    const record = objects.get(id) ?? fail('missing-object-reference')
    for (const baseId of stringList(record.body, 'baseObjectIds')) {
      requireCondition(included.has(baseId), 'missing-object-base')
      const base = objects.get(baseId) ?? fail('missing-object-base')
      requireCondition(targetKey(base.body) === targetKey(record.body), 'cross-target-object-base')
      referencedBases.add(baseId)
    }
  }
  const result: Record<string, string[]> = {}
  for (const id of [...included].sort()) {
    if (referencedBases.has(id)) continue
    const key = targetKey(objects.get(id)!.body)
    ;(result[key] ??= []).push(id)
  }
  return result
}

function validateTransition(parentFrontier: readonly DriveV2ObjectRecord[], candidate: DriveV2ObjectRecord) {
  const expected = parentFrontier.map((record) => record.expectedId).sort()
  const actual = stringList(candidate.body, 'baseObjectIds')
  const operation = text(candidate.body, 'operation')
  if (driveV2CanonicalJson(actual) !== driveV2CanonicalJson(expected)) {
    fail(operation.startsWith('resolve-') ? 'incomplete-resolution-frontier' : 'incomplete-parent-frontier')
  }
  if (parentFrontier.length > 1 && !operation.startsWith('resolve-')) fail('explicit-resolution-required')
  if (operation.startsWith('resolve-')) {
    requireCondition(
      driveV2CanonicalJson(stringList(candidate.body, 'resolutionOf')) === driveV2CanonicalJson(expected),
      'incomplete-resolution-frontier',
    )
  }
  if (operation === 'upsert' && parentFrontier.some((record) => {
    const parentOperation = text(record.body, 'operation')
    return parentOperation === 'tombstone' || parentOperation === 'resolve-tombstone'
  })) fail('explicit-restore-required')
}

function validateRelationships(objectIds: Iterable<string>, objects: ReadonlyMap<string, DriveV2ObjectRecord>) {
  const byTarget = new Map<string, DriveV2ObjectRecord[]>()
  for (const id of objectIds) {
    const record = objects.get(id) ?? fail('missing-object-reference')
    const records = byTarget.get(targetKey(record.body)) ?? []
    records.push(record)
    byTarget.set(targetKey(record.body), records)
  }
  const requireTarget = (kind: string, id: string) => {
    const records = byTarget.get(`${kind}:${id}`)
    if (!records?.length) fail('missing-parent-target')
    return records.filter((record) => ['upsert', 'resolve-upsert'].includes(text(record.body, 'operation')))
  }
  const requireLink = (records: readonly DriveV2ObjectRecord[], field: string, expected: string) => {
    requireCondition(records.every((record) => text(recordValue(record.body.payload), field) === expected), 'inconsistent-parent-linkage')
  }
  for (const id of objectIds) {
    const body = objects.get(id)!.body
    if (!['upsert', 'resolve-upsert'].includes(text(body, 'operation'))) continue
    const payload = recordValue(body.payload)
    switch (text(body, 'entityKind')) {
      case 'attachment':
        requireTarget('entry', text(payload, 'entryId'))
        break
      case 'fileBoxItem': {
        requireTarget('entry', text(payload, 'entryId'))
        requireLink(requireTarget('attachment', text(payload, 'attachmentId')), 'entryId', text(payload, 'entryId'))
        break
      }
      case 'transfer': {
        requireTarget('entry', text(payload, 'entryId'))
        const attachments = requireTarget('attachment', text(payload, 'attachmentId'))
        const fileBoxes = requireTarget('fileBoxItem', text(payload, 'fileBoxItemId'))
        requireLink(attachments, 'entryId', text(payload, 'entryId'))
        requireLink(fileBoxes, 'entryId', text(payload, 'entryId'))
        requireLink(fileBoxes, 'attachmentId', text(payload, 'attachmentId'))
        break
      }
    }
  }
}

export async function validateDriveV2Workspace(
  workspaceId: string,
  objectsInput: readonly DriveV2ObjectRecord[],
  blobsInput: readonly DriveV2BlobRecord[],
  commitsInput: readonly DriveV2CommitRecord[],
): Promise<DriveV2WorkspaceState> {
  requireWorkspace(workspaceId, workspaceId)
  const objects = objectsInput.map((record) => Object.freeze({ expectedId: record.expectedId, body: cloneObject(record.body) }))
  const commits = commitsInput.map((record) => Object.freeze({ expectedId: record.expectedId, body: cloneObject(record.body) }))
  const blobs = blobsInput.map((record) => ({ expectedId: record.expectedId, bytes: Uint8Array.from(record.bytes), mimeType: record.mimeType }))
  await Promise.all(objects.map((record) => validateDriveV2Object(record, workspaceId)))
  await Promise.all(commits.map((record) => validateDriveV2Commit(record, workspaceId)))
  await Promise.all(blobs.map(async (blob) => {
    requireCondition(blob.expectedId === await driveV2BlobId(blob.bytes), 'canonical-id-mismatch')
    requireCondition(Boolean(blob.mimeType.trim()), 'artifact-schema-mismatch')
  }))
  const unique = <T>(values: readonly T[], id: (value: T) => string) => {
    const result = new Map<string, T>()
    for (const value of values) {
      const key = id(value)
      requireCondition(!result.has(key), 'divergent-duplicate')
      result.set(key, value)
    }
    return result
  }
  const objectMap = unique(objects, (record) => record.expectedId)
  const blobMap = unique(blobs, (record) => record.expectedId)
  const commitMap = unique(commits, (record) => record.expectedId)
  if (commitMap.size === 0) {
    return Object.freeze({
      tips: Object.freeze([]),
      frontiers: Object.freeze({}),
      objectMap: new DriveV2ImmutableMap(objectMap),
      visibleCommitIds: Object.freeze([]),
      visibleObjectIds: Object.freeze([]),
    })
  }
  const tips = graphTips(commitMap)
  requireCondition(commits.filter((record) => stringList(record.body, 'parentCommitIds').length === 0).length === 1, 'multiple-genesis-commits')

  const memo = new Map<string, ReadonlySet<string>>()
  for (const commit of commits) {
    const objectIds = stringList(commit.body, 'objectIds')
    const blobIds = stringList(commit.body, 'blobIds')
    objectIds.forEach((id) => requireCondition(objectMap.has(id), 'missing-object-reference'))
    blobIds.forEach((id) => requireCondition(blobMap.has(id), 'missing-blob-reference'))
    const introduced = objectIds.map((id) => objectMap.get(id)!)
    requireCondition(new Set(introduced.map((record) => targetKey(record.body))).size === introduced.length, 'duplicate-target-in-commit')
    const requiredBlobs = [...new Set(introduced.flatMap((record) => stringList(record.body, 'blobIds')))].sort()
    requireCondition(driveV2CanonicalJson(requiredBlobs) === driveV2CanonicalJson(blobIds), 'commit-blob-reference-mismatch')
    const parentHistory = new Set<string>()
    for (const parent of stringList(commit.body, 'parentCommitIds')) {
      for (const id of reachableObjectIds(parent, commitMap, memo)) parentHistory.add(id)
    }
    const parentFrontiers = parentHistory.size === 0 ? {} : frontier(parentHistory, objectMap)
    for (const candidate of introduced) {
      validateTransition((parentFrontiers[targetKey(candidate.body)] ?? []).map((id) => objectMap.get(id)!), candidate)
    }
    reachableObjectIds(commit.expectedId, commitMap, memo)
  }

  const reachable = new Set<string>()
  for (const tip of tips) for (const id of reachableObjectIds(tip, commitMap, memo)) reachable.add(id)
  validateRelationships(reachable, objectMap)
  return Object.freeze({
    tips: Object.freeze(tips),
    frontiers: immutableFrontiers(frontier(reachable, objectMap)),
    objectMap: new DriveV2ImmutableMap(objectMap),
    visibleCommitIds: Object.freeze([...commitMap.keys()].sort()),
    visibleObjectIds: Object.freeze([...reachable].sort()),
  })
}

export async function driveV2ConflictId(
  target: DriveV2JsonObject,
  maximalObjectIds: readonly string[],
): Promise<string> {
  const body = {
    entityId: text(target, 'entityId'),
    entityKind: text(target, 'entityKind'),
    maximalObjectIds: [...new Set(maximalObjectIds)].sort(),
  }
  return `conf-v2-${await driveV2CanonicalSha256(body)}`
}

export async function classifyDriveV2Frontier(
  frontierIds: readonly string[],
  objectMap: ReadonlyMap<string, DriveV2ObjectRecord>,
): Promise<DriveV2FrontierDecision> {
  const ids = [...new Set(frontierIds)].sort()
  requireCondition(ids.length > 0, 'missing-object-reference')
  const record = objectMap.get(ids[0]) ?? fail('missing-object-reference')
  if (ids.length > 1) {
    return { decision: 'deterministic-pending-conflict', visible: false, conflictId: await driveV2ConflictId(record.body, ids) }
  }
  const operation = text(record.body, 'operation')
  const deleted = operation === 'tombstone' || operation === 'resolve-tombstone'
  return { decision: deleted ? 'deleted' : 'live', visible: !deleted, conflictId: null }
}

export async function projectDriveV2Workspace(state: DriveV2WorkspaceState): Promise<DriveV2Projection> {
  const classifications: Record<string, DriveV2FrontierDecision> = {}
  const visible = new Set<string>()
  const suppressed = new Set<string>()
  for (const [target, ids] of Object.entries(state.frontiers)) {
    const classification = await classifyDriveV2Frontier(ids, state.objectMap)
    classifications[target] = Object.freeze(classification)
    ;(classification.visible ? visible : suppressed).add(target)
  }
  const parentVisible = (kind: string, id: DriveV2JsonValue | undefined) =>
    typeof id === 'string' && visible.has(`${kind}:${id}`)
  let changed: boolean
  do {
    changed = false
    for (const target of [...visible]) {
      const ids = state.frontiers[target]
      if (ids.length !== 1) continue
      const body = state.objectMap.get(ids[0])!.body
      const payload = body.payload === null ? {} : recordValue(body.payload)
      const parentsVisible = (() => {
        switch (text(body, 'entityKind')) {
          case 'attachment': return parentVisible('entry', payload.entryId)
          case 'fileBoxItem': return parentVisible('entry', payload.entryId) && parentVisible('attachment', payload.attachmentId)
          case 'transfer': return parentVisible('entry', payload.entryId)
            && parentVisible('attachment', payload.attachmentId)
            && parentVisible('fileBoxItem', payload.fileBoxItemId)
          default: return true
        }
      })()
      if (!parentsVisible) {
        visible.delete(target)
        suppressed.add(target)
        changed = true
      }
    }
  } while (changed)
  return Object.freeze({
    classifications: Object.freeze(Object.fromEntries(Object.entries(classifications).sort(([left], [right]) => left.localeCompare(right)))),
    visibleTargets: Object.freeze([...visible].sort()),
    suppressedTargets: Object.freeze([...suppressed].sort()),
  })
}
