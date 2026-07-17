import type {
  Attachment,
  DeviceProfile,
  Entry,
  FileBoxItem,
  SyncConflict,
  SyncEntityEnvelope,
  SyncManifest,
  TombstoneRecord,
  TransferRecord,
} from '../domain/types'

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

const ENTITY_KINDS = ['entry', 'attachment', 'fileBoxItem', 'transfer', 'device', 'tombstone'] as const
const BLOCK_KINDS = ['heading', 'paragraph', 'table', 'workbook', 'image', 'file', 'checklist', 'list', 'quote', 'divider'] as const
const SYNC_STATUSES = ['local', 'queued', 'syncing', 'synced', 'remote-available', 'failed', 'conflict'] as const
const FILE_BOX_STATUSES = ['queued', 'uploading', 'available', 'attached', 'rejected', 'failed', 'removed'] as const
const TRANSFER_STATUSES = ['queued', 'uploading', 'available', 'attached', 'failed', 'conflict', 'removed'] as const
const CONFLICT_RESOLUTIONS = ['pending', 'local-won', 'remote-won', 'kept-copy'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isEnumValue<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function isDateBucket(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error }
}

function optionalString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === 'undefined' || typeof record[key] === 'string'
}

function optionalTimestamp(record: Record<string, unknown>, key: string) {
  return typeof record[key] === 'undefined' || isIsoTimestamp(record[key])
}

function validateStringMatrix(value: unknown) {
  return Array.isArray(value) && value.every((row) => isStringArray(row))
}

function validateTextRuns(value: unknown) {
  if (typeof value === 'undefined') return true
  return Array.isArray(value) && value.every((run) => isRecord(run) && typeof run.text === 'string')
}

function validateTextItems(value: unknown, checklist = false) {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  return value.every((item) => {
    if (!isRecord(item) || !isNonEmptyString(item.id) || typeof item.text !== 'string') return false
    if (ids.has(item.id)) return false
    ids.add(item.id)
    if (checklist && typeof item.done !== 'boolean') return false
    return validateTextRuns(item.runs)
  })
}

function validateBlock(value: unknown, index: number): string | undefined {
  if (!isRecord(value)) return `Entry payload content[${index}] must be an object.`
  if (!isNonEmptyString(value.id)) return `Entry payload content[${index}].id is required.`
  if (!isEnumValue(value.type, BLOCK_KINDS)) return `Entry payload content[${index}].type is not supported by Drive v1.`
  if (!validateTextRuns(value.runs)) return `Entry payload content[${index}].runs must contain text runs.`

  switch (value.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return typeof value.text === 'string' ? undefined : `Entry payload content[${index}].text must be a string.`
    case 'table':
    case 'workbook':
      return validateStringMatrix(value.data) ? undefined : `Entry payload content[${index}].data must be a string matrix.`
    case 'image':
    case 'file':
      return isNonEmptyString(value.attachmentId) ? undefined : `Entry payload content[${index}].attachmentId is required.`
    case 'checklist':
      return validateTextItems(value.items, true) ? undefined : `Entry payload content[${index}].items must be valid checklist items.`
    case 'list':
      return validateTextItems(value.items) ? undefined : `Entry payload content[${index}].items must be valid list items.`
    case 'divider':
      return undefined
  }
}

function validatePinnedRegions(value: unknown, entryId: string) {
  return Array.isArray(value) && value.every((region) => isRecord(region)
    && isNonEmptyString(region.id)
    && region.entryId === entryId
    && isNonEmptyString(region.label)
    && isStringArray(region.blockIds)
    && isStringArray(region.linkedAttachments))
}

function validateCaptureArray(value: unknown) {
  if (typeof value === 'undefined') return true
  return Array.isArray(value) && value.every((capture) => isRecord(capture)
    && isNonEmptyString(capture.messageId)
    && isIsoTimestamp(capture.sentAt)
    && isIsoTimestamp(capture.receivedAt)
    && isStringArray(capture.blockIds)
    && isStringArray(capture.attachmentIds))
}

function validateDeviceRecord(value: unknown, label: string): string | undefined {
  if (!isRecord(value)) return `${label} must be an object.`
  if (!isNonEmptyString(value.id)) return `${label}.id is required.`
  if (!isNonEmptyString(value.name)) return `${label}.name is required.`
  if (!isEnumValue(value.platform, ['desktop', 'mobile', 'tablet', 'web'] as const)) return `${label}.platform is invalid.`
  if (!isIsoTimestamp(value.createdAt)) return `${label}.createdAt must be an ISO timestamp.`
  if (!isIsoTimestamp(value.lastSeenAt)) return `${label}.lastSeenAt must be an ISO timestamp.`
  if (!optionalString(value, 'userAgent') || !optionalString(value, 'appVersion')) return `${label} optional metadata must be strings.`
  return undefined
}

function validateEnvelopeBase(value: unknown, kind: SyncEntityEnvelope<unknown>['kind']): ValidationResult<{
  envelope: Record<string, unknown>
  payload: Record<string, unknown>
}> {
  if (!isRecord(value)) return fail(`${kind} envelope must be an object.`)
  if (value.kind !== kind) return fail(`${kind} envelope kind must be ${kind}.`)
  if (value.version !== 1) return fail(`${kind} envelope version must be 1.`)
  if (!isNonEmptyString(value.id)) return fail(`${kind} envelope id is required.`)
  if (!isIsoTimestamp(value.updatedAt)) return fail(`${kind} envelope updatedAt must be an ISO timestamp.`)
  if (!isNonEmptyString(value.updatedByDeviceId)) return fail(`${kind} envelope updatedByDeviceId is required.`)
  if (!optionalTimestamp(value, 'deletedAt')) return fail(`${kind} envelope deletedAt must be an ISO timestamp.`)
  if (typeof value.deletedAt !== 'undefined') {
    return fail(`${kind} envelope deletedAt must be represented by a Drive v1 tombstone.`)
  }
  if (!isRecord(value.payload)) return fail(`${kind} envelope payload must be an object.`)
  if (!isNonEmptyString(value.payload.id)) return fail(`${kind} payload id is required.`)
  if (value.id !== value.payload.id) return fail(`${kind} envelope id must match payload id.`)
  return { ok: true, value: { envelope: value, payload: value.payload } }
}

export function validateEntryEnvelope(value: unknown): ValidationResult<SyncEntityEnvelope<Entry>> {
  const base = validateEnvelopeBase(value, 'entry')
  if (!base.ok) return fail(base.error)
  const payload = base.value.payload
  if (!isNonEmptyString(payload.authorId)) return fail('Entry payload authorId is required.')
  if (typeof payload.title !== 'string') return fail('Entry payload title must be a string.')
  if (!isDateBucket(payload.dateBucket)) return fail('Entry payload dateBucket must be a valid YYYY-MM-DD date.')
  if (!isIsoTimestamp(payload.createdDatetime)) return fail('Entry payload createdDatetime must be an ISO timestamp.')
  if (!isIsoTimestamp(payload.lastEditedDatetime)) return fail('Entry payload lastEditedDatetime must be an ISO timestamp.')
  if (!Array.isArray(payload.content)) return fail('Entry payload content must be an array.')
  const blockIds = new Set<string>()
  for (let index = 0; index < payload.content.length; index += 1) {
    const error = validateBlock(payload.content[index], index)
    if (error) return fail(error)
    const blockId = (payload.content[index] as Record<string, unknown>).id as string
    if (blockIds.has(blockId)) return fail('Entry payload content block ids must be unique.')
    blockIds.add(blockId)
  }
  for (const key of ['tags', 'searchTerms', 'linkedFiles'] as const) {
    if (!isStringArray(payload[key])) return fail(`Entry payload ${key} must be a string array.`)
  }
  for (const key of ['projectTags', 'experimentTags'] as const) {
    if (typeof payload[key] !== 'undefined' && !isStringArray(payload[key])) return fail(`Entry payload ${key} must be a string array.`)
  }
  if (!validatePinnedRegions(payload.pinnedRegions, payload.id as string)) return fail('Entry payload pinnedRegions must contain valid regions for this entry.')
  if (!validateCaptureArray(payload.whatsappCaptures) || !validateCaptureArray(payload.telegramCaptures)) {
    return fail('Entry payload captures must contain valid nested capture records.')
  }
  if (typeof payload.version !== 'undefined' && !isNonNegativeInteger(payload.version)) return fail('Entry payload version must be a non-negative integer.')
  if (typeof payload.syncStatus !== 'undefined' && !isEnumValue(payload.syncStatus, SYNC_STATUSES)) return fail('Entry payload syncStatus is invalid.')
  return { ok: true, value: value as SyncEntityEnvelope<Entry> }
}

export function validateAttachmentEnvelope(value: unknown): ValidationResult<SyncEntityEnvelope<Attachment>> {
  const base = validateEnvelopeBase(value, 'attachment')
  if (!base.ok) return fail(base.error)
  const payload = base.value.payload
  if (!isNonEmptyString(payload.entryId)) return fail('Attachment payload entryId is required.')
  if (!isEnumValue(payload.type, ['image', 'pdf', 'file', 'raw'] as const)) return fail('Attachment payload type is invalid.')
  if (!isNonEmptyString(payload.filename)) return fail('Attachment payload filename is required.')
  if (!isNonEmptyString(payload.filesize)) return fail('Attachment payload filesize is required.')
  if (!isNonEmptyString(payload.storagePath)) return fail('Attachment payload storagePath is required.')
  if (typeof payload.bytes !== 'undefined' && !isNonNegativeInteger(payload.bytes)) return fail('Attachment payload bytes must be a non-negative integer.')
  if (!optionalTimestamp(payload, 'createdAt') || !optionalTimestamp(payload, 'updatedAt')) return fail('Attachment payload timestamps must be ISO timestamps.')
  if (typeof payload.syncStatus !== 'undefined' && !isEnumValue(payload.syncStatus, SYNC_STATUSES)) return fail('Attachment payload syncStatus is invalid.')
  return { ok: true, value: value as SyncEntityEnvelope<Attachment> }
}

export function validateFileBoxEnvelope(value: unknown): ValidationResult<SyncEntityEnvelope<FileBoxItem>> {
  const base = validateEnvelopeBase(value, 'fileBoxItem')
  if (!base.ok) return fail(base.error)
  const payload = base.value.payload
  if (!isNonEmptyString(payload.entryId)) return fail('File Box payload entryId is required.')
  if (!isNonEmptyString(payload.filename)) return fail('File Box payload filename is required.')
  if (!isNonEmptyString(payload.filesize)) return fail('File Box payload filesize is required.')
  if (!isNonEmptyString(payload.sourceDeviceId) || !isNonEmptyString(payload.sourceDeviceName)) return fail('File Box payload source device is required.')
  if (!isEnumValue(payload.status, FILE_BOX_STATUSES)) return fail('File Box payload status is invalid.')
  if (!isIsoTimestamp(payload.createdAt) || !isIsoTimestamp(payload.updatedAt)) return fail('File Box payload timestamps must be ISO timestamps.')
  return { ok: true, value: value as SyncEntityEnvelope<FileBoxItem> }
}

export function validateTransferEnvelope(value: unknown): ValidationResult<SyncEntityEnvelope<TransferRecord>> {
  const base = validateEnvelopeBase(value, 'transfer')
  if (!base.ok) return fail(base.error)
  const payload = base.value.payload
  if (!isNonEmptyString(payload.filename)) return fail('Transfer payload filename is required.')
  if (!isNonEmptyString(payload.fromDeviceId) || !isNonEmptyString(payload.fromDeviceName)) return fail('Transfer payload source device is required.')
  if (payload.provider !== 'google-drive') return fail('Transfer payload provider must be google-drive.')
  if (!isEnumValue(payload.status, TRANSFER_STATUSES)) return fail('Transfer payload status is invalid.')
  if (!isIsoTimestamp(payload.createdAt) || !isIsoTimestamp(payload.updatedAt)) return fail('Transfer payload timestamps must be ISO timestamps.')
  if (!optionalTimestamp(payload, 'completedAt')) return fail('Transfer payload completedAt must be an ISO timestamp.')
  if (typeof payload.bytesTotal !== 'undefined' && !isNonNegativeNumber(payload.bytesTotal)) return fail('Transfer payload bytesTotal must be non-negative.')
  if (typeof payload.bytesTransferred !== 'undefined' && !isNonNegativeNumber(payload.bytesTransferred)) return fail('Transfer payload bytesTransferred must be non-negative.')
  return { ok: true, value: value as SyncEntityEnvelope<TransferRecord> }
}

export function validateTombstone(value: unknown): ValidationResult<TombstoneRecord> {
  if (!isRecord(value)) return fail('Tombstone must be an object.')
  if (!isNonEmptyString(value.id)) return fail('Tombstone id is required.')
  if (!isEnumValue(value.entityKind, ENTITY_KINDS)) return fail('Tombstone entityKind is not supported by Drive v1.')
  if (!isNonEmptyString(value.entityId)) return fail('Tombstone entityId is required.')
  if (!isIsoTimestamp(value.deletedAt)) return fail('Tombstone deletedAt must be an ISO timestamp.')
  if (!isNonEmptyString(value.deletedByDeviceId)) return fail('Tombstone deletedByDeviceId is required.')
  if (!optionalString(value, 'reason')) return fail('Tombstone reason must be a string.')
  return { ok: true, value: value as unknown as TombstoneRecord }
}

export function validateConflict(value: unknown): ValidationResult<SyncConflict> {
  if (!isRecord(value)) return fail('Conflict must be an object.')
  if (!isNonEmptyString(value.id)) return fail('Conflict id is required.')
  if (!isEnumValue(value.entityKind, ENTITY_KINDS)) return fail('Conflict entityKind is not supported by Drive v1.')
  if (!isNonEmptyString(value.entityId)) return fail('Conflict entityId is required.')
  if (!isIsoTimestamp(value.localUpdatedAt)) return fail('Conflict localUpdatedAt must be an ISO timestamp.')
  if (!isIsoTimestamp(value.remoteUpdatedAt)) return fail('Conflict remoteUpdatedAt must be an ISO timestamp.')
  if (!isIsoTimestamp(value.detectedAt)) return fail('Conflict detectedAt must be an ISO timestamp.')
  if (!isEnumValue(value.resolution, CONFLICT_RESOLUTIONS)) return fail('Conflict resolution is invalid.')
  if (!isNonEmptyString(value.summary)) return fail('Conflict summary is required.')
  return { ok: true, value: value as unknown as SyncConflict }
}

export function validateManifest(value: unknown): ValidationResult<SyncManifest> {
  if (!isRecord(value)) return fail('Manifest must be an object.')
  if (value.version !== 1) return fail('Manifest version must be 1.')
  if (value.provider !== 'google-drive') return fail('Manifest provider must be google-drive.')
  if (!isNonEmptyString(value.rootFolderName)) return fail('Manifest rootFolderName is required.')
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return fail('Manifest timestamps must be ISO timestamps.')
  if (!Array.isArray(value.devices)) return fail('Manifest devices must be an array.')
  const deviceIds = new Set<string>()
  for (let index = 0; index < value.devices.length; index += 1) {
    const error = validateDeviceRecord(value.devices[index], `Manifest devices[${index}]`)
    if (error) return fail(error)
    const deviceId = (value.devices[index] as Record<string, unknown>).id as string
    if (deviceIds.has(deviceId)) return fail('Manifest device ids must be unique.')
    deviceIds.add(deviceId)
  }
  for (const key of ['entryCount', 'attachmentCount', 'fileBoxCount', 'transferCount'] as const) {
    if (!isNonNegativeInteger(value[key])) return fail(`Manifest ${key} must be a non-negative integer.`)
  }
  return { ok: true, value: value as unknown as SyncManifest }
}

export function validateDevice(value: unknown): ValidationResult<DeviceProfile> {
  const error = validateDeviceRecord(value, 'Device')
  return error ? fail(error) : { ok: true, value: value as DeviceProfile }
}

export function buildInvalidRemoteJsonConflict(params: {
  entityKind: SyncConflict['entityKind']
  entityId: string
  deviceId: string
  error: string
  remoteCopy: unknown
}): SyncConflict {
  const now = new Date().toISOString()
  return {
    id: `conf-invalid-${params.entityKind}-${params.entityId}`,
    entityKind: params.entityKind,
    entityId: params.entityId,
    localUpdatedAt: now,
    remoteUpdatedAt: now,
    detectedAt: now,
    resolution: 'pending',
    summary: `Remote JSON was not applied: ${params.error}`,
    localCopy: { detectedByDeviceId: params.deviceId },
    remoteCopy: params.remoteCopy,
  }
}
