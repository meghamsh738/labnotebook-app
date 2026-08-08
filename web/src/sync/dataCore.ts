import type {
  Attachment,
  DeviceProfile,
  Entry,
  FileBoxItem,
  SyncConflict,
  SyncEntityEnvelope,
  SyncQueueItem,
  TombstoneRecord,
  TransferRecord,
} from '../domain/types'
import { hashBlobSha256 } from './hashing'
import {
  createJournalRepositories,
  JOURNAL_DB_NAME,
  JOURNAL_DB_VERSION,
  JOURNAL_STORES,
} from './repositories'

export { hashBlobSha256, JOURNAL_DB_NAME, JOURNAL_DB_VERSION, JOURNAL_STORES }

export type JournalSnapshot = {
  entries: Record<string, Entry>
  attachments: Attachment[]
  fileBoxItems: FileBoxItem[]
  transfers: TransferRecord[]
  conflicts: SyncConflict[]
  tombstones: TombstoneRecord[]
  device?: DeviceProfile
}

export type JournalHydrationResult = {
  snapshot: JournalSnapshot
  source: 'indexeddb' | 'migrated' | 'local-fallback'
  queueCount: number
}

export type JournalPersistResult = {
  queueCount: number
}

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

function nowIso() {
  return new Date().toISOString()
}

export function safeDriveSegment(value: string, fallback = 'untitled') {
  const input = value.length === 0 ? fallback : value
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = input.charCodeAt(index + 1)
      if (index + 1 >= input.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new Error('Drive path segments must contain valid Unicode.')
      }
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error('Drive path segments must contain valid Unicode.')
    }
  }
  const bytes = new TextEncoder().encode(input)
  let encoded = ''
  for (const byte of bytes) {
    const isSafeAscii =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x2d
    encoded += isSafeAscii ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded
}

export function buildEntryDriveFileName(entry: Entry, allEntries?: Record<string, Entry>) {
  const date = safeDriveSegment(entry.dateBucket || entry.createdDatetime.slice(0, 10) || 'undated')
  if (!allEntries) return `${date}.json`
  const sameDay = Object.values(allEntries).filter((candidate) => candidate.dateBucket === entry.dateBucket)
  return sameDay.length > 1 ? `${date}-${safeDriveSegment(entry.id)}.json` : `${date}.json`
}

export function buildAttachmentDriveFolder(entry?: Entry) {
  return safeDriveSegment(entry?.dateBucket || entry?.createdDatetime.slice(0, 10) || 'undated')
}

export function buildAttachmentDriveFileName(attachment: Attachment) {
  return `${safeDriveSegment(attachment.id, 'attachment')}-${safeDriveSegment(attachment.filename, 'file')}`
}

export function buildAttachmentDrivePath(attachment: Attachment, entry?: Entry) {
  return `attachments/${buildAttachmentDriveFolder(entry)}/${buildAttachmentDriveFileName(attachment)}`
}

export function buildEntryEnvelope(entry: Entry, device: DeviceProfile): SyncEntityEnvelope<Entry> {
  return {
    id: entry.id,
    kind: 'entry',
    version: 1,
    updatedAt: entry.lastEditedDatetime || nowIso(),
    updatedByDeviceId: entry.updatedByDeviceId || device.id,
    payload: projectEntryPayload(entry),
  }
}

export function buildAttachmentEnvelope(attachment: Attachment, device: DeviceProfile): SyncEntityEnvelope<Attachment> {
  return {
    id: attachment.id,
    kind: 'attachment',
    version: 1,
    updatedAt: attachment.updatedAt || attachment.createdAt || nowIso(),
    updatedByDeviceId: device.id,
    payload: projectAttachmentPayload(attachment),
  }
}

function isLocalCacheHint(value: string) {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('blob:')
    || normalized.startsWith('file:')
    || normalized.startsWith('content:')
    || normalized.startsWith('data:')
    || normalized.startsWith('/')
    || normalized.startsWith('~/')
    || /^[a-z]:[\\/]/.test(normalized)
}

export function projectEntryPayload(entry: Entry): Entry {
  const payload = { ...entry }
  if (payload.syncPath && isLocalCacheHint(payload.syncPath)) delete payload.syncPath
  return payload
}

export function projectAttachmentPayload(attachment: Attachment): Attachment {
  const payload = { ...attachment }
  delete payload.cachedPath
  delete payload.cacheKey
  if (payload.thumbnail && isLocalCacheHint(payload.thumbnail)) delete payload.thumbnail
  return payload
}

export function projectFileBoxPayload(item: FileBoxItem): FileBoxItem {
  const payload = { ...item }
  delete payload.localObjectUrl
  return payload
}

export function canonicalTombstoneId(entityKind: TombstoneRecord['entityKind'], entityId: string) {
  return `del-${entityKind}-${entityId}`
}

export function normalizeTombstone(tombstone: TombstoneRecord): TombstoneRecord {
  return {
    ...tombstone,
    id: canonicalTombstoneId(tombstone.entityKind, tombstone.entityId),
  }
}

function sameTombstoneSemantics(left: TombstoneRecord, right: TombstoneRecord) {
  return left.entityKind === right.entityKind
    && left.entityId === right.entityId
    && left.deletedAt === right.deletedAt
    && left.deletedByDeviceId === right.deletedByDeviceId
    && left.reason === right.reason
}

export function normalizeTombstonesByTarget(
  tombstones: TombstoneRecord[],
  detectedAt = new Date().toISOString(),
): { tombstones: TombstoneRecord[]; conflicts: SyncConflict[] } {
  const preferred = new Map<string, TombstoneRecord>()
  const conflicts = new Map<string, SyncConflict>()
  for (const candidateValue of tombstones) {
    const candidate = normalizeTombstone(candidateValue)
    const target = `${candidate.entityKind}\u0000${candidate.entityId}`
    const current = preferred.get(target)
    if (!current) {
      preferred.set(target, candidate)
      continue
    }
    const candidateTime = Date.parse(candidate.deletedAt)
    const currentTime = Date.parse(current.deletedAt)
    if (candidateTime > currentTime) {
      preferred.set(target, candidate)
      continue
    }
    if (candidateTime < currentTime || sameTombstoneSemantics(candidate, current)) continue

    const ordered: TombstoneRecord[] = [current, candidate]
    ordered.sort((left, right) => {
      const leftKey = `${left.deletedByDeviceId}\u0000${left.reason ?? ''}`
      const rightKey = `${right.deletedByDeviceId}\u0000${right.reason ?? ''}`
      return leftKey.localeCompare(rightKey)
    })
    preferred.set(target, ordered[0])
    const conflictId = `conf-${candidate.entityKind}-${candidate.entityId}`
    conflicts.set(conflictId, {
      id: conflictId,
      entityKind: candidate.entityKind,
      entityId: candidate.entityId,
      localUpdatedAt: candidate.deletedAt,
      remoteUpdatedAt: candidate.deletedAt,
      detectedAt,
      resolution: 'pending',
      summary: 'Equal-time tombstones disagree; deletion remains effective but publication is blocked.',
      localCopy: { tombstone: ordered[0] },
      remoteCopy: { tombstone: ordered[1] },
    })
  }
  return {
    tombstones: [...preferred.values()].sort((left, right) =>
      `${left.entityKind}\u0000${left.entityId}`.localeCompare(`${right.entityKind}\u0000${right.entityId}`)),
    conflicts: [...conflicts.values()],
  }
}

export function effectiveDeletedTargetSets(snapshot: JournalSnapshot, tombstones: TombstoneRecord[]) {
  const deletedEntries = new Set(tombstones.filter((t) => t.entityKind === 'entry').map((t) => t.entityId))
  const deletedAttachments = new Set(tombstones.filter((t) => t.entityKind === 'attachment').map((t) => t.entityId))
  const deletedFileBoxItems = new Set(tombstones.filter((t) => t.entityKind === 'fileBoxItem').map((t) => t.entityId))
  const deletedTransfers = new Set(tombstones.filter((t) => t.entityKind === 'transfer').map((t) => t.entityId))
  for (const attachment of snapshot.attachments) {
    if (deletedEntries.has(attachment.entryId)) deletedAttachments.add(attachment.id)
  }
  for (const item of snapshot.fileBoxItems) {
    if (deletedEntries.has(item.entryId) || deletedAttachments.has(item.attachmentId || '')) {
      deletedFileBoxItems.add(item.id)
    }
  }
  for (const transfer of snapshot.transfers) {
    if (
      deletedEntries.has(transfer.entryId || '')
      || deletedAttachments.has(transfer.attachmentId || '')
      || deletedFileBoxItems.has(transfer.fileBoxItemId || '')
    ) {
      deletedTransfers.add(transfer.id)
    }
  }
  return { deletedEntries, deletedAttachments, deletedFileBoxItems, deletedTransfers }
}

export function mergeEntryEnvelopes(
  local: SyncEntityEnvelope<Entry>,
  remote: SyncEntityEnvelope<Entry>
): { entry: Entry; conflict?: SyncConflict } {
  const localTime = Date.parse(local.payload.lastEditedDatetime || local.updatedAt) || 0
  const remoteTime = Date.parse(remote.payload.lastEditedDatetime || remote.updatedAt) || 0
  if (local.updatedByDeviceId === remote.updatedByDeviceId || localTime === remoteTime) {
    return { entry: localTime >= remoteTime ? local.payload : remote.payload }
  }

  const localWins = localTime >= remoteTime
  return {
    entry: localWins ? local.payload : remote.payload,
    conflict: {
      id: randomId('conf'),
      entityKind: 'entry',
      entityId: local.id,
      localUpdatedAt: new Date(localTime).toISOString(),
      remoteUpdatedAt: new Date(remoteTime).toISOString(),
      detectedAt: nowIso(),
      resolution: 'kept-copy',
      summary: 'Both devices edited this daily entry; the newest version is visible and the older copy is preserved.',
      localCopy: local.payload,
      remoteCopy: remote.payload,
    },
  }
}

export function applyTombstonesToSnapshot(snapshot: JournalSnapshot, tombstones: TombstoneRecord[]): JournalSnapshot {
  // Device identity is owned by the active local profile, and deleting a tombstone
  // has no safe v1 resurrection semantics. Those tombstone kinds remain recorded
  // but intentionally do not erase local snapshot state.
  const normalized = normalizeTombstonesByTarget(tombstones)
  const { deletedEntries, deletedAttachments, deletedFileBoxItems, deletedTransfers } =
    effectiveDeletedTargetSets(snapshot, normalized.tombstones)
  const entries = Object.fromEntries(Object.entries(snapshot.entries)
    .filter(([id]) => !deletedEntries.has(id))
    .map(([id, entry]) => [id, {
      ...entry,
      linkedFiles: entry.linkedFiles.filter((attachmentId) => !deletedAttachments.has(attachmentId)),
      pinnedRegions: entry.pinnedRegions.map((region) => ({
        ...region,
        linkedAttachments: region.linkedAttachments.filter((attachmentId) => !deletedAttachments.has(attachmentId)),
      })),
    }]))
  return {
    ...snapshot,
    entries,
    attachments: snapshot.attachments.filter((attachment) => !deletedAttachments.has(attachment.id) && !deletedEntries.has(attachment.entryId)),
    fileBoxItems: snapshot.fileBoxItems.filter((item) => !deletedFileBoxItems.has(item.id) && !deletedAttachments.has(item.attachmentId || '') && !deletedEntries.has(item.entryId)),
    transfers: snapshot.transfers.filter((transfer) =>
      !deletedTransfers.has(transfer.id)
      && !deletedFileBoxItems.has(transfer.fileBoxItemId || '')
      && !deletedAttachments.has(transfer.attachmentId || '')
      && !deletedEntries.has(transfer.entryId || '')),
    conflicts: [...new Map(
      [...snapshot.conflicts, ...normalized.conflicts].map((conflict) => [conflict.id, conflict]),
    ).values()],
    tombstones: normalized.tombstones,
  }
}

export function buildPendingSyncQueue(
  snapshot: JournalSnapshot,
  device: DeviceProfile,
  lastSyncedAt?: string
): SyncQueueItem[] {
  const threshold = lastSyncedAt ? Date.parse(lastSyncedAt) || 0 : 0
  const queuedAt = nowIso()
  const queue: SyncQueueItem[] = []

  for (const entry of Object.values(snapshot.entries)) {
    const updatedAt = entry.lastEditedDatetime || entry.createdDatetime || queuedAt
    if (!threshold || (Date.parse(updatedAt) || 0) > threshold) {
      queue.push({
        id: `entry-${entry.id}`,
        entityKind: 'entry',
        entityId: entry.id,
        operation: 'upsert',
        status: 'queued',
        queuedAt,
        updatedAt,
        updatedByDeviceId: entry.updatedByDeviceId || device.id,
        baseVersion: entry.version,
      })
    }
  }

  for (const attachment of snapshot.attachments) {
    const updatedAt = attachment.updatedAt || attachment.createdAt || queuedAt
    const remoteMetadataSynced =
      (attachment.syncStatus === 'synced' || attachment.syncStatus === 'remote-available') && Boolean(attachment.driveFileId)
    if (!remoteMetadataSynced || !threshold || (Date.parse(updatedAt) || 0) > threshold) {
      queue.push({
        id: `attachment-${attachment.id}`,
        entityKind: 'attachment',
        entityId: attachment.id,
        operation: 'upsert',
        status: attachment.syncStatus === 'failed' ? 'failed' : 'queued',
        queuedAt,
        updatedAt,
        updatedByDeviceId: device.id,
      })
    }
  }

  for (const tombstone of snapshot.tombstones) {
    queue.push({
      id: `delete-${tombstone.entityKind}-${tombstone.entityId}`,
      entityKind: tombstone.entityKind,
      entityId: tombstone.entityId,
      operation: 'delete',
      status: 'queued',
      queuedAt,
      updatedAt: tombstone.deletedAt,
      updatedByDeviceId: tombstone.deletedByDeviceId || device.id,
    })
  }

  return queue
}

function fromEnvelopeRecord<T>(envelopes: SyncEntityEnvelope<T>[]) {
  return Object.fromEntries(envelopes.map((envelope) => [envelope.id, envelope.payload]))
}

function normalizeLocalSnapshot(snapshot: JournalSnapshot): JournalSnapshot {
  return {
    entries: snapshot.entries || {},
    attachments: snapshot.attachments || [],
    fileBoxItems: snapshot.fileBoxItems || [],
    transfers: snapshot.transfers || [],
    conflicts: snapshot.conflicts || [],
    tombstones: snapshot.tombstones || [],
    device: snapshot.device,
  }
}

export async function hydrateOrMigrateJournalSnapshot(
  localSnapshot: JournalSnapshot,
  options: { device: DeviceProfile; lastSyncedAt?: string; accountScope?: string }
): Promise<JournalHydrationResult> {
  try {
    const repositories = await createJournalRepositories(
      options.accountScope ? { accountScope: options.accountScope } : undefined
    )
    const [entryEnvelopes, attachmentEnvelopes, fileBoxItems, transfers, conflicts, tombstones, devices, metadata] = await Promise.all([
      repositories.entries.all(),
      repositories.attachments.all(),
      repositories.fileBoxItems.all(),
      repositories.transfers.all(),
      repositories.conflicts.all(),
      repositories.tombstones.all(),
      repositories.devices.all(),
      repositories.meta.all(),
    ])

    const hasIndexedData = entryEnvelopes.length > 0
      || attachmentEnvelopes.length > 0
      || fileBoxItems.length > 0
      || transfers.length > 0
      || conflicts.length > 0
      || tombstones.length > 0
      || devices.length > 0
      || metadata.length > 0
    if (hasIndexedData) {
      const snapshot = applyTombstonesToSnapshot(
        {
          entries: fromEnvelopeRecord(entryEnvelopes),
          attachments: attachmentEnvelopes.map((envelope) => envelope.payload),
          fileBoxItems,
          transfers,
          conflicts,
          tombstones,
          device: devices[0] ?? options.device,
        },
        tombstones
      )
      const queue = buildPendingSyncQueue(snapshot, options.device, options.lastSyncedAt)
      return { snapshot, source: 'indexeddb', queueCount: queue.length }
    }

    const migrated = normalizeLocalSnapshot(localSnapshot)
    const persisted = await persistJournalSnapshot(migrated, options)
    return { snapshot: migrated, source: 'migrated', queueCount: persisted.queueCount }
  } catch (error) {
    console.warn('Journal data core unavailable; using localStorage fallback', error)
    return { snapshot: normalizeLocalSnapshot(localSnapshot), source: 'local-fallback', queueCount: 0 }
  }
}

export async function persistJournalSnapshot(
  snapshot: JournalSnapshot,
  options: { device: DeviceProfile; lastSyncedAt?: string; accountScope?: string }
): Promise<JournalPersistResult> {
  const repositories = await createJournalRepositories(
    options.accountScope ? { accountScope: options.accountScope } : undefined
  )
  const normalized = normalizeLocalSnapshot(snapshot)
  const queue = buildPendingSyncQueue(normalized, options.device, options.lastSyncedAt)
  await repositories.replaceStores({
    entries: Object.values(normalized.entries).map((entry) => buildEntryEnvelope(entry, options.device)),
    attachments: normalized.attachments.map((attachment) => buildAttachmentEnvelope(attachment, options.device)),
    fileBoxItems: normalized.fileBoxItems,
    transfers: normalized.transfers,
    conflicts: normalized.conflicts,
    tombstones: normalized.tombstones,
    syncQueue: queue,
    devices: [options.device],
  })
  // The sync engine stores remote content hashes and its Drive change token in
  // this same object store. Snapshot persistence must update its own record
  // without clearing those sync checkpoints.
  await repositories.meta.put({
    id: 'snapshot',
    updatedAt: nowIso(),
    lastSyncedAt: options.lastSyncedAt,
    queueCount: queue.length,
  })
  return { queueCount: queue.length }
}
