import type {
  Attachment,
  Entry,
  SyncConflict,
  SyncEntityEnvelope,
  SyncManifest,
  TombstoneRecord,
} from '../domain/types'

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function hasString(record: Record<string, unknown>, key: string) {
  return isString(record[key]) && record[key].length > 0
}

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error }
}

export function validateEntryEnvelope(value: unknown): ValidationResult<SyncEntityEnvelope<Entry>> {
  if (!isRecord(value)) return fail('Entry envelope must be an object.')
  if (value.kind !== 'entry') return fail('Entry envelope kind must be entry.')
  if (!hasString(value, 'id')) return fail('Entry envelope id is required.')
  if (!hasString(value, 'updatedAt')) return fail('Entry envelope updatedAt is required.')
  if (!hasString(value, 'updatedByDeviceId')) return fail('Entry envelope updatedByDeviceId is required.')
  const payload = value.payload
  if (!isRecord(payload)) return fail('Entry envelope payload must be an object.')
  if (!hasString(payload, 'id')) return fail('Entry payload id is required.')
  if (!hasString(payload, 'dateBucket')) return fail('Entry payload dateBucket is required.')
  if (!Array.isArray(payload.content)) return fail('Entry payload content must be an array.')
  return { ok: true, value: value as unknown as SyncEntityEnvelope<Entry> }
}

export function validateAttachmentEnvelope(value: unknown): ValidationResult<SyncEntityEnvelope<Attachment>> {
  if (!isRecord(value)) return fail('Attachment envelope must be an object.')
  if (value.kind !== 'attachment') return fail('Attachment envelope kind must be attachment.')
  if (!hasString(value, 'id')) return fail('Attachment envelope id is required.')
  if (!hasString(value, 'updatedAt')) return fail('Attachment envelope updatedAt is required.')
  if (!hasString(value, 'updatedByDeviceId')) return fail('Attachment envelope updatedByDeviceId is required.')
  const payload = value.payload
  if (!isRecord(payload)) return fail('Attachment envelope payload must be an object.')
  if (!hasString(payload, 'id')) return fail('Attachment payload id is required.')
  if (!hasString(payload, 'entryId')) return fail('Attachment payload entryId is required.')
  if (!hasString(payload, 'filename')) return fail('Attachment payload filename is required.')
  return { ok: true, value: value as unknown as SyncEntityEnvelope<Attachment> }
}

export function validateTombstone(value: unknown): ValidationResult<TombstoneRecord> {
  if (!isRecord(value)) return fail('Tombstone must be an object.')
  if (!hasString(value, 'id')) return fail('Tombstone id is required.')
  if (!hasString(value, 'entityKind')) return fail('Tombstone entityKind is required.')
  if (!hasString(value, 'entityId')) return fail('Tombstone entityId is required.')
  if (!hasString(value, 'deletedAt')) return fail('Tombstone deletedAt is required.')
  if (!hasString(value, 'deletedByDeviceId')) return fail('Tombstone deletedByDeviceId is required.')
  return { ok: true, value: value as unknown as TombstoneRecord }
}

export function validateConflict(value: unknown): ValidationResult<SyncConflict> {
  if (!isRecord(value)) return fail('Conflict must be an object.')
  if (!hasString(value, 'id')) return fail('Conflict id is required.')
  if (!hasString(value, 'entityKind')) return fail('Conflict entityKind is required.')
  if (!hasString(value, 'entityId')) return fail('Conflict entityId is required.')
  if (!hasString(value, 'detectedAt')) return fail('Conflict detectedAt is required.')
  if (!hasString(value, 'summary')) return fail('Conflict summary is required.')
  return { ok: true, value: value as unknown as SyncConflict }
}

export function validateManifest(value: unknown): ValidationResult<SyncManifest> {
  if (!isRecord(value)) return fail('Manifest must be an object.')
  if (value.version !== 1) return fail('Manifest version must be 1.')
  if (value.provider !== 'google-drive') return fail('Manifest provider must be google-drive.')
  if (!hasString(value, 'rootFolderName')) return fail('Manifest rootFolderName is required.')
  if (!Array.isArray(value.devices)) return fail('Manifest devices must be an array.')
  return { ok: true, value: value as unknown as SyncManifest }
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
