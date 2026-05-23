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
  const cleaned = value
    .normalize('NFKD')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || fallback).slice(0, 120)
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
    payload: entry,
  }
}

export function buildAttachmentEnvelope(attachment: Attachment, device: DeviceProfile): SyncEntityEnvelope<Attachment> {
  return {
    id: attachment.id,
    kind: 'attachment',
    version: 1,
    updatedAt: attachment.updatedAt || attachment.createdAt || nowIso(),
    updatedByDeviceId: device.id,
    payload: attachment,
  }
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
  const deletedEntries = new Set(tombstones.filter((t) => t.entityKind === 'entry').map((t) => t.entityId))
  const deletedAttachments = new Set(tombstones.filter((t) => t.entityKind === 'attachment').map((t) => t.entityId))
  return {
    ...snapshot,
    entries: Object.fromEntries(Object.entries(snapshot.entries).filter(([id]) => !deletedEntries.has(id))),
    attachments: snapshot.attachments.filter((attachment) => !deletedAttachments.has(attachment.id) && !deletedEntries.has(attachment.entryId)),
    fileBoxItems: snapshot.fileBoxItems.filter((item) => !deletedAttachments.has(item.attachmentId || '') && !deletedEntries.has(item.entryId)),
    transfers: snapshot.transfers.filter((transfer) => !deletedAttachments.has(transfer.attachmentId || '') && !deletedEntries.has(transfer.entryId || '')),
    tombstones,
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
    if (attachment.syncStatus !== 'synced' || !attachment.driveFileId || !threshold || (Date.parse(updatedAt) || 0) > threshold) {
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
  options: { device: DeviceProfile; lastSyncedAt?: string }
): Promise<JournalHydrationResult> {
  try {
    const repositories = await createJournalRepositories()
    const [entryEnvelopes, attachmentEnvelopes, fileBoxItems, transfers, conflicts, tombstones, devices] = await Promise.all([
      repositories.entries.all(),
      repositories.attachments.all(),
      repositories.fileBoxItems.all(),
      repositories.transfers.all(),
      repositories.conflicts.all(),
      repositories.tombstones.all(),
      repositories.devices.all(),
    ])

    const hasIndexedData = entryEnvelopes.length > 0 || attachmentEnvelopes.length > 0 || fileBoxItems.length > 0 || transfers.length > 0
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
  options: { device: DeviceProfile; lastSyncedAt?: string }
): Promise<JournalPersistResult> {
  const repositories = await createJournalRepositories()
  const normalized = normalizeLocalSnapshot(snapshot)
  const queue = buildPendingSyncQueue(normalized, options.device, options.lastSyncedAt)
  await Promise.all([
    repositories.entries.replaceAll(Object.values(normalized.entries).map((entry) => buildEntryEnvelope(entry, options.device))),
    repositories.attachments.replaceAll(normalized.attachments.map((attachment) => buildAttachmentEnvelope(attachment, options.device))),
    repositories.fileBoxItems.replaceAll(normalized.fileBoxItems),
    repositories.transfers.replaceAll(normalized.transfers),
    repositories.conflicts.replaceAll(normalized.conflicts),
    repositories.tombstones.replaceAll(normalized.tombstones),
    repositories.syncQueue.replaceAll(queue),
    repositories.devices.replaceAll([options.device]),
    repositories.meta.replaceAll([
      {
        id: 'snapshot',
        updatedAt: nowIso(),
        lastSyncedAt: options.lastSyncedAt,
        queueCount: queue.length,
      },
    ]),
  ])
  return { queueCount: queue.length }
}
