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
import { createManifest } from './connectedSync'
import {
  applyTombstonesToSnapshot,
  buildAttachmentDrivePath,
  buildAttachmentEnvelope,
  buildEntryDriveFileName,
  buildEntryEnvelope,
  normalizeTombstonesByTarget,
  projectFileBoxPayload,
  safeDriveSegment,
  type JournalSnapshot,
} from './dataCore'
import { hashBlobSha256, hashJsonSha256, hashTextSha256, stableStringify } from './hashing'
import {
  buildInvalidRemoteJsonConflict,
  validateAttachmentEnvelope,
  validateConflict,
  validateEntryEnvelope,
  validateFileBoxEnvelope,
  validateManifest,
  validateTombstone,
  validateTransferEnvelope,
  type ValidationResult,
} from './schemas'
import type { BlobStore } from './blobStore'
import {
  createJournalRepositories,
  type JournalRepositories,
  type JournalStoreReplacements,
} from './repositories'
import {
  DriveTransactionJournal,
  IndexedDbDriveTransactionPersistence,
  MemoryDriveTransactionPersistence,
  type DriveTransactionBlobWrite,
  type DriveTransactionJsonWrite,
  type DriveTransactionPlan,
  type DriveTransactionReceipt,
  type DriveTransactionRecord,
  type DriveTransactionWrite,
} from './driveTransactionJournal'
import type { RemoteFileRef, SyncProvider, WritePrecondition } from './syncProvider'

export type SyncEngineMeta = {
  entryHashes: Record<string, string>
  attachmentHashes: Record<string, string>
  fileBoxHashes: Record<string, string>
  transferHashes: Record<string, string>
  /** Paths verified while reading Drive. Existing records must never be relocated implicitly. */
  entryPaths?: Record<string, string>
  attachmentPaths?: Record<string, string>
  attachmentBlobPaths?: Record<string, string>
  fileBoxPaths?: Record<string, string>
  transferPaths?: Record<string, string>
  conflictPaths?: Record<string, string>
  tombstonePaths?: Record<string, string>
  lastSyncedAt?: string
  driveChangesToken?: string
}

export type SyncEngineResult = {
  pulledEntries: number
  pushedEntries: number
  pulledAttachments: number
  pushedAttachments: number
  uploadedBlobs: number
  downloadedBlobs: number
  pushedTombstones: number
  conflicts: number
}

export type LocalJournalStore = {
  getSnapshot(): Promise<JournalSnapshot>
  saveSnapshot(snapshot: JournalSnapshot): Promise<void>
  getMeta(): Promise<SyncEngineMeta>
  saveMeta(meta: SyncEngineMeta): Promise<void>
  saveState?(snapshot: JournalSnapshot, meta: SyncEngineMeta): Promise<void>
  getRevision(): Promise<number>
  saveStateIfRevision(snapshot: JournalSnapshot, meta: SyncEngineMeta, expectedRevision: number): Promise<boolean>
}

const SYNC_ENGINE_META_ID = 'sync-engine'
const DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024
const DRIVE_FILE_ID_PLACEHOLDER_PREFIX = '__easylab_drive_file_id__:'
const fallbackTransactionJournal = new DriveTransactionJournal(new MemoryDriveTransactionPersistence())

function defaultTransactionJournal() {
  return typeof indexedDB === 'undefined'
    ? fallbackTransactionJournal
    : new DriveTransactionJournal(new IndexedDbDriveTransactionPersistence())
}

function nowIso() {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T
}

function defaultMeta(): SyncEngineMeta {
  return { entryHashes: {}, attachmentHashes: {}, fileBoxHashes: {}, transferHashes: {} }
}

function isSyncEngineMeta(value: unknown): value is SyncEngineMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.entryHashes === 'object' && record.entryHashes !== null && typeof record.attachmentHashes === 'object' && record.attachmentHashes !== null
}

function envelopeRecord<T>(envelopes: SyncEntityEnvelope<T>[]) {
  return Object.fromEntries(envelopes.map((envelope) => [envelope.id, envelope.payload]))
}

export class MemoryJournalStore implements LocalJournalStore {
  private snapshot: JournalSnapshot
  private meta: SyncEngineMeta
  private revision = 0

  constructor(snapshot: JournalSnapshot, meta: SyncEngineMeta = defaultMeta()) {
    this.snapshot = clone(snapshot)
    this.meta = clone(meta)
  }

  async getSnapshot() {
    return clone(this.snapshot)
  }

  async saveSnapshot(snapshot: JournalSnapshot) {
    this.revision += 1
    this.snapshot = clone(snapshot)
  }

  async getMeta() {
    return clone(this.meta)
  }

  async saveMeta(meta: SyncEngineMeta) {
    this.revision += 1
    this.meta = clone(meta)
  }

  async saveState(snapshot: JournalSnapshot, meta: SyncEngineMeta) {
    this.revision += 1
    this.snapshot = clone(snapshot)
    this.meta = clone(meta)
  }

  async getRevision() {
    return this.revision
  }

  async saveStateIfRevision(snapshot: JournalSnapshot, meta: SyncEngineMeta, expectedRevision: number) {
    if (this.revision !== expectedRevision) return false
    this.revision += 1
    this.snapshot = clone(snapshot)
    this.meta = clone(meta)
    return true
  }
}

export class IndexedDbJournalStore implements LocalJournalStore {
  private readonly repositories: JournalRepositories
  private readonly device: DeviceProfile

  constructor(repositories: JournalRepositories, device: DeviceProfile) {
    this.repositories = repositories
    this.device = device
  }

  async getSnapshot() {
    const [entryEnvelopes, attachmentEnvelopes, fileBoxItems, transfers, conflicts, tombstones, devices] = await Promise.all([
      this.repositories.entries.all(),
      this.repositories.attachments.all(),
      this.repositories.fileBoxItems.all(),
      this.repositories.transfers.all(),
      this.repositories.conflicts.all(),
      this.repositories.tombstones.all(),
      this.repositories.devices.all(),
    ])
    return applyTombstonesToSnapshot({
      entries: envelopeRecord(entryEnvelopes),
      attachments: attachmentEnvelopes.map((envelope) => envelope.payload),
      fileBoxItems,
      transfers,
      conflicts,
      tombstones,
      device: devices.find((candidate) => candidate.id === this.device.id) ?? devices[0] ?? this.device,
    }, tombstones)
  }

  async saveSnapshot(snapshot: JournalSnapshot) {
    const device = snapshot.device ?? this.device
    await this.repositories.replaceStores(snapshotReplacements(snapshot, device))
  }

  async getMeta() {
    const record = await this.repositories.meta.get(SYNC_ENGINE_META_ID)
    return isSyncEngineMeta(record?.value) ? record.value : defaultMeta()
  }

  async saveMeta(meta: SyncEngineMeta) {
    await this.repositories.replaceStores({ meta: [syncEngineMetaRecord(meta)] })
  }

  async saveState(snapshot: JournalSnapshot, meta: SyncEngineMeta) {
    const device = snapshot.device ?? this.device
    await this.repositories.replaceStores({
      ...snapshotReplacements(snapshot, device),
      meta: [syncEngineMetaRecord(meta)],
    })
  }

  getRevision() {
    return this.repositories.getRevision()
  }

  async saveStateIfRevision(snapshot: JournalSnapshot, meta: SyncEngineMeta, expectedRevision: number) {
    const device = snapshot.device ?? this.device
    const result = await this.repositories.replaceStoresIfRevision({
      ...snapshotReplacements(snapshot, device),
      meta: [syncEngineMetaRecord(meta)],
    }, expectedRevision)
    return result.applied
  }
}

function snapshotReplacements(snapshot: JournalSnapshot, device: DeviceProfile): JournalStoreReplacements {
  return {
    // IndexedDB is the local journal, so retain local-only cache/provenance fields here.
    // Drive projection remains confined to the remote writer calls below.
    entries: Object.values(snapshot.entries).map((entry) => ({
      id: entry.id,
      kind: 'entry' as const,
      version: 1 as const,
      updatedAt: entry.lastEditedDatetime,
      updatedByDeviceId: entry.updatedByDeviceId || device.id,
      payload: entry,
    })),
    attachments: snapshot.attachments.map((attachment) => ({
      id: attachment.id,
      kind: 'attachment' as const,
      version: 1 as const,
      updatedAt: attachment.updatedAt || attachment.createdAt || nowIso(),
      updatedByDeviceId: device.id,
      payload: attachment,
    })),
    fileBoxItems: snapshot.fileBoxItems,
    transfers: snapshot.transfers,
    conflicts: snapshot.conflicts,
    tombstones: snapshot.tombstones,
    devices: [device],
  }
}

function syncEngineMetaRecord(meta: SyncEngineMeta) {
  return {
    id: SYNC_ENGINE_META_ID,
    updatedAt: nowIso(),
    lastSyncedAt: meta.lastSyncedAt,
    value: meta,
  }
}

export async function createIndexedDbJournalStore(device: DeviceProfile, repositories?: JournalRepositories) {
  return new IndexedDbJournalStore(repositories ?? await createJournalRepositories(), device)
}

function canonicalOptional<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value
}

export async function entryContentHash(entry: Entry) {
  return hashJsonSha256({
    id: entry.id,
    experimentId: canonicalOptional(entry.experimentId),
    projectId: canonicalOptional(entry.projectId),
    createdDatetime: entry.createdDatetime,
    lastEditedDatetime: entry.lastEditedDatetime,
    authorId: entry.authorId,
    title: entry.title,
    dateBucket: entry.dateBucket,
    isDaily: canonicalOptional(entry.isDaily),
    content: entry.content,
    tags: entry.tags,
    projectTags: canonicalOptional(entry.projectTags),
    experimentTags: canonicalOptional(entry.experimentTags),
    searchTerms: entry.searchTerms,
    linkedFiles: entry.linkedFiles,
    pinnedRegions: entry.pinnedRegions,
    version: canonicalOptional(entry.version),
    source: canonicalOptional(entry.source),
    whatsappCaptures: canonicalOptional(entry.whatsappCaptures),
    telegramCaptures: canonicalOptional(entry.telegramCaptures),
  })
}

export async function attachmentMetadataHash(attachment: Attachment) {
  return hashJsonSha256({
    id: attachment.id,
    entryId: attachment.entryId,
    type: attachment.type,
    filename: attachment.filename,
    filesize: attachment.filesize,
    bytes: canonicalOptional(attachment.bytes),
    storagePath: attachment.storagePath,
    linkedRegionId: canonicalOptional(attachment.linkedRegionId),
    tag: canonicalOptional(attachment.tag),
    sampleId: canonicalOptional(attachment.sampleId),
    source: canonicalOptional(attachment.source),
    sourceMessageId: canonicalOptional(attachment.sourceMessageId),
    sourceMediaId: canonicalOptional(attachment.sourceMediaId),
    contentType: canonicalOptional(attachment.contentType),
    mimeType: canonicalOptional(attachment.mimeType),
    sha256: canonicalOptional(attachment.sha256),
    driveFileId: canonicalOptional(attachment.driveFileId),
    createdAt: canonicalOptional(attachment.createdAt),
    updatedAt: canonicalOptional(attachment.updatedAt),
  })
}

export async function fileBoxMetadataHash(item: FileBoxItem) {
  return hashJsonSha256({
    id: item.id,
    entryId: item.entryId,
    attachmentId: canonicalOptional(item.attachmentId),
    filename: item.filename,
    filesize: item.filesize,
    contentType: canonicalOptional(item.contentType),
    sourceDeviceId: item.sourceDeviceId,
    sourceDeviceName: item.sourceDeviceName,
    status: item.status,
    createdAt: item.createdAt,
    driveFileId: canonicalOptional(item.driveFileId),
    localObjectUrl: canonicalOptional(item.localObjectUrl),
    lastError: canonicalOptional(item.lastError),
    updatedAt: item.updatedAt,
  })
}

export async function transferMetadataHash(transfer: TransferRecord) {
  return hashJsonSha256({
    id: transfer.id,
    fileBoxItemId: canonicalOptional(transfer.fileBoxItemId),
    entryId: canonicalOptional(transfer.entryId),
    attachmentId: canonicalOptional(transfer.attachmentId),
    filename: transfer.filename,
    fromDeviceId: transfer.fromDeviceId,
    fromDeviceName: transfer.fromDeviceName,
    toDeviceId: canonicalOptional(transfer.toDeviceId),
    toDeviceName: canonicalOptional(transfer.toDeviceName),
    provider: transfer.provider,
    status: transfer.status,
    bytesTotal: canonicalOptional(transfer.bytesTotal),
    bytesTransferred: canonicalOptional(transfer.bytesTransferred),
    createdAt: transfer.createdAt,
    completedAt: canonicalOptional(transfer.completedAt),
    driveFileId: canonicalOptional(transfer.driveFileId),
    lastError: canonicalOptional(transfer.lastError),
    updatedAt: transfer.updatedAt,
  })
}

function mergeConflictId(entityKind: SyncConflict['entityKind'], entityId: string) {
  return `conf-${entityKind}-${entityId}`
}

function makeEntryConflict(params: {
  entityId: string
  local: Entry
  remote: Entry
  localHash: string
  remoteHash: string
  deviceId: string
  summary: string
}): SyncConflict {
  const now = nowIso()
  return {
    id: mergeConflictId('entry', params.entityId),
    entityKind: 'entry',
    entityId: params.entityId,
    localUpdatedAt: params.local.lastEditedDatetime || now,
    remoteUpdatedAt: params.remote.lastEditedDatetime || now,
    detectedAt: now,
    resolution: 'pending',
    summary: params.summary,
    localCopy: { hash: params.localHash, deviceId: params.deviceId, entry: params.local, value: params.local },
    remoteCopy: { hash: params.remoteHash, entry: params.remote, value: params.remote },
  }
}

function makeRemoteDeleteConflict(params: {
  entityKind: 'entry' | 'attachment' | 'fileBoxItem' | 'transfer'
  entityId: string
  localUpdatedAt: string
  localHash: string
  localCopy: unknown
  tombstone: TombstoneRecord
  deviceId: string
}): SyncConflict {
  const now = nowIso()
  return {
    id: mergeConflictId(params.entityKind, params.entityId),
    entityKind: params.entityKind,
    entityId: params.entityId,
    localUpdatedAt: params.localUpdatedAt,
    remoteUpdatedAt: params.tombstone.deletedAt,
    detectedAt: now,
    resolution: 'pending',
    summary: `Remote ${params.entityKind} delete conflicts with local changes; the local copy is kept until resolved.`,
    localCopy: { hash: params.localHash, deviceId: params.deviceId, value: params.localCopy },
    remoteCopy: { tombstone: params.tombstone },
  }
}

function makeEntityConflict(params: {
  entityKind: 'attachment' | 'fileBoxItem' | 'transfer'
  entityId: string
  localUpdatedAt: string
  remoteUpdatedAt: string
  localHash: string
  remoteHash: string
  localCopy: Attachment | FileBoxItem | TransferRecord
  remoteCopy: Attachment | FileBoxItem | TransferRecord
  deviceId: string
  summary: string
}): SyncConflict {
  const now = nowIso()
  return {
    id: mergeConflictId(params.entityKind, params.entityId),
    entityKind: params.entityKind,
    entityId: params.entityId,
    localUpdatedAt: params.localUpdatedAt || now,
    remoteUpdatedAt: params.remoteUpdatedAt || now,
    detectedAt: now,
    resolution: 'pending',
    summary: params.summary,
    localCopy: { hash: params.localHash, deviceId: params.deviceId, value: params.localCopy },
    remoteCopy: { hash: params.remoteHash, value: params.remoteCopy },
  }
}

function conflictCopyHash(copy: unknown) {
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) return undefined
  return typeof (copy as { hash?: unknown }).hash === 'string' ? (copy as { hash: string }).hash : undefined
}

function conflictCopyValue(copy: unknown, entityKind: SyncConflict['entityKind']): unknown {
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) return undefined
  const record = copy as { value?: unknown; entry?: unknown }
  if (typeof record.value !== 'undefined') return record.value
  if (entityKind === 'entry' && typeof record.entry !== 'undefined') return record.entry
  return typeof (copy as { id?: unknown }).id === 'string' ? copy : undefined
}

function conflictRemoteTombstone(conflict: SyncConflict) {
  if (typeof conflict.remoteCopy !== 'object' || conflict.remoteCopy === null || Array.isArray(conflict.remoteCopy)) return undefined
  const tombstone = (conflict.remoteCopy as { tombstone?: unknown }).tombstone
  const result = validateTombstone(tombstone)
  return result.ok ? result.value : undefined
}

function conflictLocalTombstone(conflict: SyncConflict) {
  if (typeof conflict.localCopy !== 'object' || conflict.localCopy === null || Array.isArray(conflict.localCopy)) return undefined
  const tombstone = (conflict.localCopy as { tombstone?: unknown }).tombstone
  const result = validateTombstone(tombstone)
  return result.ok ? result.value : undefined
}

function divergentTombstoneTarget(conflict: SyncConflict) {
  if (conflict.resolution !== 'pending') return undefined
  if (typeof conflict.localCopy !== 'object' || conflict.localCopy === null || Array.isArray(conflict.localCopy)) {
    return undefined
  }
  const localResult = validateTombstone((conflict.localCopy as { tombstone?: unknown }).tombstone)
  const remote = conflictRemoteTombstone(conflict)
  if (!localResult.ok || !remote) return undefined
  const local = localResult.value
  if (
    local.entityKind !== remote.entityKind
    || local.entityId !== remote.entityId
    || Date.parse(local.deletedAt) !== Date.parse(remote.deletedAt)
  ) {
    return undefined
  }
  return `${local.entityKind}\u0000${local.entityId}`
}

function matchingResolvedConflict(
  conflicts: SyncConflict[],
  entityKind: SyncConflict['entityKind'],
  entityId: string,
  localHash: string,
  remoteHash: string,
) {
  const conflict = conflicts.find((candidate) => candidate.id === mergeConflictId(entityKind, entityId) && candidate.resolution !== 'pending')
  if (!conflict) return undefined
  const expectedLocalHash = conflictCopyHash(conflict.localCopy)
  const expectedRemoteHash = conflictCopyHash(conflict.remoteCopy)
  const authoritativeHash = conflict.resolution === 'remote-won' ? expectedRemoteHash : expectedLocalHash
  const supersededHash = conflict.resolution === 'remote-won' ? expectedLocalHash : expectedRemoteHash
  if (!authoritativeHash || !supersededHash) return undefined
  if (localHash === authoritativeHash && remoteHash === supersededHash) {
    return { conflict, acceptRemote: false }
  }
  if (remoteHash === authoritativeHash && localHash === supersededHash) {
    return { conflict, acceptRemote: true }
  }
  return undefined
}

function upsertConflict(conflicts: SyncConflict[], conflict: SyncConflict) {
  const next = conflicts.filter((existing) => existing.id !== conflict.id)
  next.push(conflict)
  return next
}

function conflictTimestamp(conflict: SyncConflict) {
  return Math.max(
    Date.parse(conflict.localUpdatedAt) || 0,
    Date.parse(conflict.remoteUpdatedAt) || 0,
    Date.parse(conflict.detectedAt) || 0,
  )
}

export function selectPreferredConflict(left: SyncConflict, right: SyncConflict) {
  const leftTimestamp = conflictTimestamp(left)
  const rightTimestamp = conflictTimestamp(right)
  if (leftTimestamp !== rightTimestamp) return rightTimestamp > leftTimestamp ? right : left
  const leftResolved = left.resolution === 'pending' ? 0 : 1
  const rightResolved = right.resolution === 'pending' ? 0 : 1
  if (leftResolved !== rightResolved) return rightResolved > leftResolved ? right : left
  const leftCanonical = stableStringify(left)
  const rightCanonical = stableStringify(right)
  return rightCanonical > leftCanonical ? right : left
}

function tombstonePath(tombstone: TombstoneRecord) {
  return `tombstones/${safeDriveSegment(tombstone.entityKind, 'entity')}--${safeDriveSegment(tombstone.entityId, 'entity')}.json`
}

function entryPath(entry: Entry, entries: Record<string, Entry>) {
  return `entries/${buildEntryDriveFileName(entry, entries)}`
}

function attachmentMetadataPath(attachment: Attachment, entries: Record<string, Entry>) {
  return `${buildAttachmentDrivePath(attachment, entries[attachment.entryId])}.json`
}

function attachmentBlobPath(attachment: Attachment, entries: Record<string, Entry>) {
  return buildAttachmentDrivePath(attachment, entries[attachment.entryId])
}

function attachmentBlobKey(attachment: Attachment) {
  return attachment.cacheKey || `attachment-${attachment.id}`
}

export function buildFileBoxEnvelope(item: FileBoxItem, device: DeviceProfile): SyncEntityEnvelope<FileBoxItem> {
  return {
    id: item.id,
    kind: 'fileBoxItem',
    version: 1,
    updatedAt: item.updatedAt || nowIso(),
    updatedByDeviceId: device.id,
    payload: projectFileBoxPayload(item),
  }
}

export function buildTransferEnvelope(transfer: TransferRecord, device: DeviceProfile): SyncEntityEnvelope<TransferRecord> {
  return {
    id: transfer.id,
    kind: 'transfer',
    version: 1,
    updatedAt: transfer.updatedAt || nowIso(),
    updatedByDeviceId: device.id,
    payload: transfer,
  }
}

function fileBoxPath(item: FileBoxItem) {
  return `filebox/${safeDriveSegment(item.id, 'filebox')}.json`
}

function transferPath(transfer: TransferRecord) {
  return `transfers/${safeDriveSegment(transfer.id, 'transfer')}.json`
}

type ResolvableEntityKind = 'entry' | 'attachment' | 'fileBoxItem' | 'transfer'
type ResolvableEntity = Entry | Attachment | FileBoxItem | TransferRecord
export type ConflictResolutionChoice = Exclude<SyncConflict['resolution'], 'pending'>

function validatedConflictEntity(
  entityKind: ResolvableEntityKind,
  value: unknown,
  device: DeviceProfile,
): ResolvableEntity | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string') return undefined
  const payload = value as ResolvableEntity
  const updatedAt = entityKind === 'entry'
    ? (payload as Entry).lastEditedDatetime
    : (payload as Attachment | FileBoxItem | TransferRecord).updatedAt || nowIso()
  const envelope = {
    id: payload.id,
    kind: entityKind,
    version: 1,
    updatedAt,
    updatedByDeviceId: device.id,
    payload,
  }
  const result = entityKind === 'entry'
    ? validateEntryEnvelope(envelope)
    : entityKind === 'attachment'
      ? validateAttachmentEnvelope(envelope)
      : entityKind === 'fileBoxItem'
        ? validateFileBoxEnvelope(envelope)
        : validateTransferEnvelope(envelope)
  return result.ok ? result.value.payload : undefined
}

function snapshotEntity(snapshot: JournalSnapshot, entityKind: ResolvableEntityKind, entityId: string) {
  if (entityKind === 'entry') return snapshot.entries[entityId]
  if (entityKind === 'attachment') return snapshot.attachments.find((entity) => entity.id === entityId)
  if (entityKind === 'fileBoxItem') return snapshot.fileBoxItems.find((entity) => entity.id === entityId)
  return snapshot.transfers.find((entity) => entity.id === entityId)
}

function putSnapshotEntity(snapshot: JournalSnapshot, entityKind: ResolvableEntityKind, entity: ResolvableEntity) {
  if (entityKind === 'entry') snapshot.entries[entity.id] = entity as Entry
  else if (entityKind === 'attachment') snapshot.attachments = [...snapshot.attachments.filter((candidate) => candidate.id !== entity.id), entity as Attachment]
  else if (entityKind === 'fileBoxItem') snapshot.fileBoxItems = [...snapshot.fileBoxItems.filter((candidate) => candidate.id !== entity.id), entity as FileBoxItem]
  else snapshot.transfers = [...snapshot.transfers.filter((candidate) => candidate.id !== entity.id), entity as TransferRecord]
}

function deleteSnapshotEntity(snapshot: JournalSnapshot, entityKind: ResolvableEntityKind, entityId: string) {
  if (entityKind === 'entry') delete snapshot.entries[entityId]
  else if (entityKind === 'attachment') snapshot.attachments = snapshot.attachments.filter((candidate) => candidate.id !== entityId)
  else if (entityKind === 'fileBoxItem') snapshot.fileBoxItems = snapshot.fileBoxItems.filter((candidate) => candidate.id !== entityId)
  else snapshot.transfers = snapshot.transfers.filter((candidate) => candidate.id !== entityId)
}

function copyConflictEntity(entityKind: ResolvableEntityKind, entity: ResolvableEntity, device: DeviceProfile) {
  const suffix = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)
  const id = `${entityKind}-conflict-${suffix}`
  const timestamp = nowIso()
  if (entityKind === 'entry') {
    const entry = entity as Entry
    return {
      ...entry,
      id,
      title: `${entry.title} (conflict copy)`,
      lastEditedDatetime: timestamp,
      updatedByDeviceId: device.id,
      syncStatus: 'queued' as const,
      pinnedRegions: entry.pinnedRegions.map((region) => ({
        ...region,
        id: `${region.id}-conflict-${suffix}`,
        entryId: id,
      })),
    }
  }
  if (entityKind === 'attachment') {
    return { ...(entity as Attachment), id, driveFileId: undefined, syncStatus: 'queued' as const, updatedAt: timestamp }
  }
  if (entityKind === 'fileBoxItem') {
    return { ...(entity as FileBoxItem), id, driveFileId: undefined, status: 'queued' as const, updatedAt: timestamp }
  }
  return { ...(entity as TransferRecord), id, driveFileId: undefined, status: 'queued' as const, updatedAt: timestamp }
}

function reviveConflictEntity(entityKind: ResolvableEntityKind, entity: ResolvableEntity, device: DeviceProfile, timestamp: string) {
  if (entityKind === 'entry') {
    return { ...(entity as Entry), lastEditedDatetime: timestamp, updatedByDeviceId: device.id, syncStatus: 'queued' as const }
  }
  if (entityKind === 'attachment') {
    return { ...(entity as Attachment), updatedAt: timestamp, syncStatus: 'queued' as const }
  }
  if (entityKind === 'fileBoxItem') return { ...(entity as FileBoxItem), updatedAt: timestamp }
  return { ...(entity as TransferRecord), updatedAt: timestamp }
}

async function entityHash(entityKind: ResolvableEntityKind, entity: ResolvableEntity) {
  if (entityKind === 'entry') return entryContentHash(entity as Entry)
  if (entityKind === 'attachment') return attachmentMetadataHash(entity as Attachment)
  if (entityKind === 'fileBoxItem') return fileBoxMetadataHash(entity as FileBoxItem)
  return transferMetadataHash(entity as TransferRecord)
}

function entityHashMap(meta: SyncEngineMeta, entityKind: ResolvableEntityKind) {
  if (entityKind === 'entry') return meta.entryHashes
  if (entityKind === 'attachment') return meta.attachmentHashes
  if (entityKind === 'fileBoxItem') return meta.fileBoxHashes
  return meta.transferHashes
}

async function saveStoreState(store: LocalJournalStore, snapshot: JournalSnapshot, meta: SyncEngineMeta) {
  if (store.saveState) await store.saveState(snapshot, meta)
  else {
    await store.saveSnapshot(snapshot)
    await store.saveMeta(meta)
  }
}

async function readStableStoreState(store: LocalJournalStore) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await store.getRevision()
    const [snapshot, storedMeta] = await Promise.all([store.getSnapshot(), store.getMeta()])
    const after = await store.getRevision()
    if (before === after) {
      return { snapshot, meta: { ...defaultMeta(), ...storedMeta }, revision: after }
    }
  }
  throw new Error('Local notebook changed too many times while transactional state was being read.')
}

export async function resolveSyncConflict(params: {
  store: LocalJournalStore
  device: DeviceProfile
  conflictId: string
  resolution: ConflictResolutionChoice
}): Promise<{ snapshot: JournalSnapshot; conflict: SyncConflict; copiedEntityId?: string }> {
  const snapshot = await params.store.getSnapshot()
  const meta = { ...defaultMeta(), ...(await params.store.getMeta()) }
  meta.fileBoxHashes = meta.fileBoxHashes ?? {}
  meta.transferHashes = meta.transferHashes ?? {}
  const conflictIndex = snapshot.conflicts.findIndex((candidate) => candidate.id === params.conflictId)
  if (conflictIndex < 0) throw new Error(`Sync conflict ${params.conflictId} was not found.`)
  const conflict = snapshot.conflicts[conflictIndex]
  if (conflict.resolution !== 'pending' && conflict.resolution !== params.resolution) {
    throw new Error(`Sync conflict ${params.conflictId} is already resolved as ${conflict.resolution}.`)
  }

  let copiedEntityId: string | undefined
  let resolvedLocalCopy: unknown
  const timestamp = nowIso()
  const entityKind = conflict.entityKind === 'entry' || conflict.entityKind === 'attachment'
    || conflict.entityKind === 'fileBoxItem' || conflict.entityKind === 'transfer'
    ? conflict.entityKind
    : undefined

  if (entityKind) {
    const localEntity = snapshotEntity(snapshot, entityKind, conflict.entityId)
      ?? validatedConflictEntity(entityKind, conflictCopyValue(conflict.localCopy, entityKind), params.device)
    const remoteEntity = validatedConflictEntity(entityKind, conflictCopyValue(conflict.remoteCopy, entityKind), params.device)
    const remoteTombstone = conflictRemoteTombstone(conflict)
    const localTombstone = conflictLocalTombstone(conflict)
    const hashes = entityHashMap(meta, entityKind)

    if (params.resolution === 'local-won') {
      if (localTombstone) {
        deleteSnapshotEntity(snapshot, entityKind, conflict.entityId)
        if (!snapshot.tombstones.some((candidate) => candidate.id === localTombstone.id)) snapshot.tombstones.push(localTombstone)
        delete hashes[conflict.entityId]
      } else {
        if (!localEntity) throw new Error(`Sync conflict ${params.conflictId} has no valid local ${entityKind} copy.`)
        const revivedAt = remoteTombstone
          ? new Date(Math.max(Date.now(), Date.parse(remoteTombstone.deletedAt) + 1)).toISOString()
          : timestamp
        const authoritativeEntity = remoteTombstone
          ? reviveConflictEntity(entityKind, localEntity, params.device, revivedAt)
          : localEntity
        putSnapshotEntity(snapshot, entityKind, authoritativeEntity)
        snapshot.tombstones = snapshot.tombstones.filter((candidate) => !(candidate.entityKind === entityKind && candidate.entityId === conflict.entityId))
        hashes[conflict.entityId] = conflictCopyHash(conflict.remoteCopy) ?? remoteTombstone?.deletedAt ?? ''
        if (remoteTombstone) {
          const hash = await entityHash(entityKind, authoritativeEntity)
          resolvedLocalCopy = entityKind === 'entry'
            ? { hash, deviceId: params.device.id, entry: authoritativeEntity, value: authoritativeEntity }
            : { hash, deviceId: params.device.id, value: authoritativeEntity }
        }
      }
    } else if (params.resolution === 'remote-won') {
      if (remoteTombstone) {
        deleteSnapshotEntity(snapshot, entityKind, conflict.entityId)
        if (!snapshot.tombstones.some((candidate) => candidate.id === remoteTombstone.id)) snapshot.tombstones.push(remoteTombstone)
        delete hashes[conflict.entityId]
      } else {
        if (!remoteEntity) throw new Error(`Sync conflict ${params.conflictId} has no valid remote ${entityKind} copy.`)
        snapshot.tombstones = snapshot.tombstones.filter((candidate) => !(candidate.entityKind === entityKind && candidate.entityId === conflict.entityId))
        putSnapshotEntity(snapshot, entityKind, remoteEntity)
        hashes[conflict.entityId] = conflictCopyHash(conflict.remoteCopy) ?? await entityHash(entityKind, remoteEntity)
      }
    } else if (remoteTombstone) {
      if (!localEntity) throw new Error(`Sync conflict ${params.conflictId} has no valid local ${entityKind} copy to keep.`)
      const copy = copyConflictEntity(entityKind, localEntity, params.device)
      putSnapshotEntity(snapshot, entityKind, copy)
      copiedEntityId = copy.id
      deleteSnapshotEntity(snapshot, entityKind, conflict.entityId)
      if (!snapshot.tombstones.some((candidate) => candidate.id === remoteTombstone.id)) snapshot.tombstones.push(remoteTombstone)
      delete hashes[conflict.entityId]
      delete hashes[copy.id]
    } else {
      if (!remoteEntity) throw new Error(`Sync conflict ${params.conflictId} has no valid remote ${entityKind} copy to keep.`)
      const copy = copyConflictEntity(entityKind, remoteEntity, params.device)
      putSnapshotEntity(snapshot, entityKind, copy)
      copiedEntityId = copy.id
      if (localTombstone) delete hashes[conflict.entityId]
      else hashes[conflict.entityId] = conflictCopyHash(conflict.remoteCopy) ?? await entityHash(entityKind, remoteEntity)
      delete hashes[copy.id]
    }
  }

  const resolvedConflict: SyncConflict = {
    ...conflict,
    localCopy: resolvedLocalCopy ?? conflict.localCopy,
    resolution: params.resolution,
    summary: params.resolution === 'local-won'
      ? 'Resolved locally: the local entity is authoritative and will be pushed on the next sync.'
      : params.resolution === 'remote-won'
        ? 'Resolved from Drive: the remote entity or deletion is authoritative.'
        : `Resolved by preserving both sides${copiedEntityId ? ` as ${copiedEntityId}` : ''}.`,
    localUpdatedAt: params.resolution === 'local-won' ? timestamp : conflict.localUpdatedAt,
    remoteUpdatedAt: params.resolution === 'remote-won' ? timestamp : conflict.remoteUpdatedAt,
  }
  snapshot.conflicts[conflictIndex] = resolvedConflict
  const nextSnapshot = applyTombstonesToSnapshot(snapshot, snapshot.tombstones)
  await saveStoreState(params.store, nextSnapshot, meta)
  return { snapshot: nextSnapshot, conflict: resolvedConflict, copiedEntityId }
}

type RemotePathIndex = Map<string, RemoteFileRef[]>

function indexRemotePaths(files: RemoteFileRef[]): RemotePathIndex {
  const index = new Map<string, RemoteFileRef[]>()
  for (const file of files) index.set(file.path, [...(index.get(file.path) ?? []), file])
  for (const [path, matches] of index) {
    if (matches.length > 1) throw new Error(`Drive managed path is duplicated and cannot be written safely: ${path}`)
  }
  return index
}

function exactRemoteFile(index: RemotePathIndex, path: string) {
  return index.get(path)?.[0]
}

async function writeIdentity(seed: string, path: string, contentHash: string, precondition: WritePrecondition) {
  return hashJsonSha256({ seed, path, contentHash, precondition })
}

async function buildWritePrecondition(params: {
  seed: string
  path: string
  contentHash: string
  remoteIndex: RemotePathIndex
  appProperties: Record<string, string>
}) {
  const existing = exactRemoteFile(params.remoteIndex, params.path)
  if (existing) {
    return {
      precondition: { kind: 'must-match', fileId: existing.id, version: existing.version } as const,
      appProperties: { ...params.appProperties },
      operationId: await writeIdentity(params.seed, params.path, params.contentHash, {
        kind: 'must-match', fileId: existing.id, version: existing.version,
      }),
    }
  }
  const operationId = await writeIdentity(params.seed, params.path, params.contentHash, {
    kind: 'must-not-exist', operationId: 'pending',
  })
  return {
    precondition: { kind: 'must-not-exist', operationId } as const,
    appProperties: { ...params.appProperties, easylabOperationId: operationId },
    operationId,
  }
}

async function buildJsonTransactionWrite(params: {
  kind: DriveTransactionJsonWrite['kind']
  seed: string
  path: string
  value: unknown
  appProperties: Record<string, string>
  remoteIndex: RemotePathIndex
}): Promise<DriveTransactionJsonWrite> {
  const contentHash = await hashJsonSha256(params.value)
  const identity = await buildWritePrecondition({ ...params, contentHash })
  return {
    id: await hashTextSha256(`${params.kind}\u0000${params.path}\u0000${contentHash}`),
    kind: params.kind,
    path: params.path,
    value: clone(params.value),
    contentHash,
    appProperties: identity.appProperties,
    precondition: identity.precondition,
  }
}

async function buildBlobTransactionWrite(params: {
  seed: string
  path: string
  blobKey: string
  mimeType: string
  byteSize: number
  sha256: string
  appProperties: Record<string, string>
  remoteIndex: RemotePathIndex
}): Promise<DriveTransactionBlobWrite> {
  const identity = await buildWritePrecondition({ ...params, contentHash: params.sha256 })
  const id = await hashTextSha256(`blob\u0000${params.path}\u0000${params.sha256}`)
  return {
    id,
    kind: 'blob',
    path: params.path,
    blobKey: params.blobKey,
    mimeType: params.mimeType,
    byteSize: params.byteSize,
    sha256: params.sha256,
    contentHash: params.sha256,
    appProperties: identity.appProperties,
    precondition: identity.precondition,
    resumableOperationId: params.byteSize >= DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES ? identity.operationId : undefined,
    fileIdPlaceholder: identity.precondition.kind === 'must-not-exist'
      ? `${DRIVE_FILE_ID_PLACEHOLDER_PREFIX}${id}`
      : undefined,
  }
}

function resolveReceiptPlaceholders(value: unknown, receipts: DriveTransactionReceipt[]): unknown {
  if (typeof value === 'string' && value.startsWith(DRIVE_FILE_ID_PLACEHOLDER_PREFIX)) {
    const writeId = value.slice(DRIVE_FILE_ID_PLACEHOLDER_PREFIX.length)
    const receipt = receipts.find((candidate) => candidate.writeId === writeId)
    if (!receipt) throw new Error(`Drive transaction dependency has no verified receipt: ${writeId}`)
    return receipt.fileId
  }
  if (Array.isArray(value)) return value.map((item) => resolveReceiptPlaceholders(item, receipts))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReceiptPlaceholders(item, receipts)]))
  }
  return value
}

function appPropertiesMatch(actual: Record<string, string> | undefined, expected: Record<string, string>) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value)
}

async function verifyPlannedWrite(params: {
  provider: SyncProvider
  write: DriveTransactionWrite
  receipts: DriveTransactionReceipt[]
  expectedReceipt?: DriveTransactionReceipt
}) {
  const candidates = (await params.provider.listManagedFiles({ prefix: params.write.path }))
    .filter((file) => file.path === params.write.path)
  if (candidates.length !== 1) return undefined
  const file = candidates[0]
  if (!appPropertiesMatch(file.appProperties, params.write.appProperties)) return undefined
  if (params.expectedReceipt) {
    if (file.id !== params.expectedReceipt.fileId || file.version !== params.expectedReceipt.version) return undefined
  } else if (params.write.precondition.kind === 'must-match') {
    if (file.id !== params.write.precondition.fileId
      || BigInt(file.version) <= BigInt(params.write.precondition.version)) return undefined
  } else if (file.appProperties?.easylabOperationId !== params.write.precondition.operationId) {
    return undefined
  }

  const resolvedValue = params.write.kind === 'blob'
    ? undefined
    : resolveReceiptPlaceholders(params.write.value, params.receipts)
  const contentHash = params.write.kind === 'blob'
    ? await (async () => {
        const blob = params.provider.getBlobById
          ? await params.provider.getBlobById(file.id)
          : await params.provider.getBlob(params.write.path)
        return blob ? hashBlobSha256(blob) : undefined
      })()
    : await (async () => {
        const remote = await params.provider.getJson<unknown>(params.write.path)
        return remote ? hashJsonSha256(remote.value) : undefined
      })()
  const expectedHash = params.write.kind === 'blob'
    ? params.write.sha256
    : await hashJsonSha256(resolvedValue)
  if (await contentHash !== expectedHash) return undefined
  return {
    writeId: params.write.id,
    path: params.write.path,
    fileId: file.id,
    version: file.version,
    contentHash: expectedHash,
    verifiedAt: nowIso(),
  } satisfies DriveTransactionReceipt
}

async function revalidateGuardedRemoteIdentity(params: {
  provider: SyncProvider
  journal: DriveTransactionJournal
  storageScope: string
  record: DriveTransactionRecord
}) {
  const remoteIdentity = params.record.plan.remoteIdentity
  if (!remoteIdentity) {
    throw new Error('Drive transaction plan omitted the remote identity required for guarded recovery.')
  }
  let record = params.record
  const currentFiles = await params.provider.listManagedFiles()
  indexRemotePaths(currentFiles)
  for (const write of record.plan.writes) {
    if (record.receipts.some((receipt) => receipt.writeId === write.id)) continue
    const reconciled = await verifyPlannedWrite({
      provider: params.provider,
      write,
      receipts: record.receipts,
    })
    if (reconciled) {
      record = await params.journal.recordReceipt(
        params.storageScope,
        record.plan.operationId,
        reconciled,
      )
    }
  }
  const expected = new Map(
    remoteIdentity.map((file) => [file.path, { path: file.path, id: file.fileId, version: file.version }]),
  )
  for (const receipt of record.receipts) {
    expected.set(receipt.path, { path: receipt.path, id: receipt.fileId, version: receipt.version })
  }
  const expectedIdentity = [...expected.values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
  const currentIdentity = currentFiles
    .map(({ path, id, version }) => ({ path, id, version }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
  if (stableStringify(expectedIdentity) !== stableStringify(currentIdentity)) {
    throw new Error('Drive changed after this transaction was planned; guarded execution is blocked before mutation.')
  }
  return record
}

async function executeDriveTransaction(params: {
  provider: SyncProvider
  blobStore?: BlobStore
  journal: DriveTransactionJournal
  storageScope: string
  record: DriveTransactionRecord
}) {
  const { provider, blobStore, journal, storageScope } = params
  let record = params.record
  let guardAcquired = false
  let mutationStarted = false
  try {
    const currentAccountScope = provider.currentAccountScope?.()
    if (currentAccountScope && currentAccountScope !== storageScope) {
      throw new Error('Google account changed before the Drive transaction guard could be acquired.')
    }
    await provider.acquireTransactionGuard(record.plan.operationId)
    guardAcquired = true
    record = await revalidateGuardedRemoteIdentity({ provider, journal, storageScope, record })
    record = await journal.markRunning(storageScope, record.plan.operationId)
    for (const write of record.plan.writes) {
      const currentAccountScope = provider.currentAccountScope?.()
      if (currentAccountScope && currentAccountScope !== storageScope) {
        throw new Error('Google account changed while a Drive transaction was running; remote mutation is blocked.')
      }
      // Reacquisition is idempotent for the current operation and renews a guard
      // whose bounded lease is nearing expiry during a long blob upload.
      await provider.acquireTransactionGuard(record.plan.operationId)
      const existingReceipt = record.receipts.find((receipt) => receipt.writeId === write.id)
      if (existingReceipt) {
        const verified = await verifyPlannedWrite({ provider, write, receipts: record.receipts, expectedReceipt: existingReceipt })
        if (!verified) throw new Error(`A verified Drive transaction receipt diverged: ${write.path}`)
        continue
      }

      const reconciled = await verifyPlannedWrite({ provider, write, receipts: record.receipts })
      let receipt = reconciled
      if (!receipt) {
        mutationStarted = true
        if (write.kind === 'blob') {
          if (!blobStore) throw new Error(`Drive transaction blob store is unavailable: ${write.path}`)
          const blobRecord = await blobStore.getRecord(write.blobKey)
          if (!blobRecord || blobRecord.size !== write.byteSize || await hashBlobSha256(blobRecord.blob) !== write.sha256) {
            throw new Error(`Drive transaction blob changed after planning: ${write.path}`)
          }
          const remote = await provider.putBlob(write.path, blobRecord.blob, {
            mimeType: write.mimeType,
            sha256: write.sha256,
            byteSize: write.byteSize,
            appProperties: write.appProperties,
          }, {
            precondition: write.precondition,
            appProperties: write.appProperties,
            resumableOperationId: write.resumableOperationId,
          })
          receipt = {
            writeId: write.id,
            path: write.path,
            fileId: remote.id,
            version: remote.version,
            contentHash: write.sha256,
            verifiedAt: nowIso(),
          }
        } else {
          const value = resolveReceiptPlaceholders(write.value, record.receipts)
          const options = {
            precondition: write.precondition,
            appProperties: write.appProperties,
            resumableOperationId: write.resumableOperationId,
          }
          const remote = write.kind === 'manifest'
            ? await provider.putManifest(value, options)
            : await provider.putJson(write.path, value, options)
          receipt = {
            writeId: write.id,
            path: write.path,
            fileId: remote.id,
            version: remote.version,
            contentHash: await hashJsonSha256(value),
            verifiedAt: nowIso(),
          }
        }
      }
      record = await journal.recordReceipt(storageScope, record.plan.operationId, receipt)
      if (write.kind === 'manifest') {
        record = await journal.markManifestCommitted(storageScope, record.plan.operationId)
      }
    }
    if (record.plan.writes.at(-1)?.kind === 'manifest'
      && record.receipts.some((receipt) => receipt.writeId === record.plan.writes.at(-1)?.id)
      && record.state !== 'manifest-committed') {
      record = await journal.markManifestCommitted(storageScope, record.plan.operationId)
    }
    await provider.releaseTransactionGuard(record.plan.operationId)
    return record
  } catch (error) {
    if (guardAcquired && !mutationStarted) {
      await provider.releaseTransactionGuard(record.plan.operationId).catch(() => undefined)
    }
    await journal.markAmbiguous(storageScope, record.plan.operationId).catch(() => undefined)
    throw error
  }
}

function asJournalSnapshot(value: unknown) {
  return clone(value as JournalSnapshot)
}

function asSyncEngineMeta(value: unknown) {
  return clone(value as SyncEngineMeta)
}

function asSyncEngineResult(value: unknown) {
  return clone(value as SyncEngineResult)
}

async function resolvedTransactionState(record: DriveTransactionRecord) {
  const snapshot = asJournalSnapshot(resolveReceiptPlaceholders(record.plan.finalSnapshot, record.receipts))
  const meta = asSyncEngineMeta(resolveReceiptPlaceholders(record.plan.finalMeta, record.receipts))
  for (const attachment of snapshot.attachments) {
    if (meta.attachmentHashes[attachment.id]) meta.attachmentHashes[attachment.id] = await attachmentMetadataHash(attachment)
  }
  meta.lastSyncedAt = record.plan.createdAt
  return { snapshot, meta }
}

function sameSnapshotValue(left: unknown, right: unknown) {
  return stableStringify(left ?? null) === stableStringify(right ?? null)
}

function mergeRecordAfterTransaction<T>(
  initial: Record<string, T>,
  committed: Record<string, T>,
  current: Record<string, T>,
) {
  const merged: Record<string, T> = {}
  const ids = new Set([...Object.keys(initial), ...Object.keys(committed), ...Object.keys(current)])
  for (const id of ids) {
    const initialValue = initial[id]
    const currentValue = current[id]
    const chosen = sameSnapshotValue(currentValue, initialValue) ? committed[id] : currentValue
    if (chosen !== undefined) merged[id] = clone(chosen)
  }
  return merged
}

function mergeArrayAfterTransaction<T extends { id: string }>(
  initial: T[],
  committed: T[],
  current: T[],
) {
  const initialById = Object.fromEntries(initial.map((value) => [value.id, value]))
  const committedById = Object.fromEntries(committed.map((value) => [value.id, value]))
  const currentById = Object.fromEntries(current.map((value) => [value.id, value]))
  return Object.values(mergeRecordAfterTransaction(initialById, committedById, currentById))
}

function transactionMergeTombstone(snapshot: JournalSnapshot, entityKind: ResolvableEntityKind, entityId: string) {
  return snapshot.tombstones.find((candidate) => candidate.entityKind === entityKind && candidate.entityId === entityId)
}

function transactionMergeUpdatedAt(entityKind: ResolvableEntityKind, entity: ResolvableEntity) {
  return entityKind === 'entry'
    ? (entity as Entry).lastEditedDatetime
    : (entity as Attachment | FileBoxItem | TransferRecord).updatedAt || nowIso()
}

async function makeConcurrentTransactionConflict(params: {
  entityKind: ResolvableEntityKind
  entityId: string
  current?: ResolvableEntity
  committed?: ResolvableEntity
  currentSnapshot: JournalSnapshot
  committedSnapshot: JournalSnapshot
  deviceId: string
}) {
  if (params.current && params.committed) {
    const [localHash, remoteHash] = await Promise.all([
      entityHash(params.entityKind, params.current),
      entityHash(params.entityKind, params.committed),
    ])
    if (params.entityKind === 'entry') {
      return makeEntryConflict({
        entityId: params.entityId,
        local: params.current as Entry,
        remote: params.committed as Entry,
        localHash,
        remoteHash,
        deviceId: params.deviceId,
        summary: 'A local edit arrived while a newer Drive entry was being committed locally; both versions are preserved for review.',
      })
    }
    return makeEntityConflict({
      entityKind: params.entityKind,
      entityId: params.entityId,
      localUpdatedAt: transactionMergeUpdatedAt(params.entityKind, params.current),
      remoteUpdatedAt: transactionMergeUpdatedAt(params.entityKind, params.committed),
      localHash,
      remoteHash,
      localCopy: params.current as Attachment | FileBoxItem | TransferRecord,
      remoteCopy: params.committed as Attachment | FileBoxItem | TransferRecord,
      deviceId: params.deviceId,
      summary: `A local ${params.entityKind} edit arrived while a newer Drive version was being committed locally; both versions are preserved for review.`,
    })
  }
  if (params.current) {
    const remoteTombstone = transactionMergeTombstone(
      params.committedSnapshot,
      params.entityKind,
      params.entityId,
    )
    if (!remoteTombstone) {
      throw new Error(`Drive transaction merge found an unexplained remote deletion: ${params.entityKind}/${params.entityId}`)
    }
    return makeRemoteDeleteConflict({
      entityKind: params.entityKind,
      entityId: params.entityId,
      localUpdatedAt: transactionMergeUpdatedAt(params.entityKind, params.current),
      localHash: await entityHash(params.entityKind, params.current),
      localCopy: params.current,
      tombstone: remoteTombstone,
      deviceId: params.deviceId,
    })
  }
  if (params.committed) {
    const localTombstone = transactionMergeTombstone(
      params.currentSnapshot,
      params.entityKind,
      params.entityId,
    )
    if (!localTombstone) {
      throw new Error(`Drive transaction merge found an unexplained local deletion: ${params.entityKind}/${params.entityId}`)
    }
    const remoteHash = await entityHash(params.entityKind, params.committed)
    return {
      id: mergeConflictId(params.entityKind, params.entityId),
      entityKind: params.entityKind,
      entityId: params.entityId,
      localUpdatedAt: localTombstone.deletedAt,
      remoteUpdatedAt: transactionMergeUpdatedAt(params.entityKind, params.committed),
      detectedAt: nowIso(),
      resolution: 'pending' as const,
      summary: `A local ${params.entityKind} deletion arrived while a newer Drive version was being committed locally; deletion remains effective and both versions are preserved for review.`,
      localCopy: { tombstone: localTombstone },
      remoteCopy: params.entityKind === 'entry'
        ? { hash: remoteHash, entry: params.committed, value: params.committed }
        : { hash: remoteHash, value: params.committed },
    } satisfies SyncConflict
  }
  throw new Error(`Drive transaction merge found two unexplained deletions: ${params.entityKind}/${params.entityId}`)
}

async function mergeEntityRecordAfterTransaction(
  entityKind: ResolvableEntityKind,
  initial: Record<string, ResolvableEntity>,
  committed: Record<string, ResolvableEntity>,
  current: Record<string, ResolvableEntity>,
  committedSnapshot: JournalSnapshot,
  currentSnapshot: JournalSnapshot,
  deviceId: string,
) {
  const values: Record<string, ResolvableEntity> = {}
  const conflicts: SyncConflict[] = []
  const suppressedCommittedTombstoneTargets = new Set<string>()
  const ids = new Set([...Object.keys(initial), ...Object.keys(committed), ...Object.keys(current)])
  for (const id of ids) {
    const initialValue = initial[id]
    const committedValue = committed[id]
    const currentValue = current[id]
    const [initialHash, committedHash, currentHash] = await Promise.all([
      initialValue ? entityHash(entityKind, initialValue) : undefined,
      committedValue ? entityHash(entityKind, committedValue) : undefined,
      currentValue ? entityHash(entityKind, currentValue) : undefined,
    ])
    if (currentHash === committedHash) {
      const chosen = sameSnapshotValue(currentValue, initialValue) ? committedValue : currentValue
      if (chosen) values[id] = clone(chosen)
      continue
    }
    const localChanged = currentHash !== initialHash
    const committedChanged = committedHash !== initialHash
    if (!localChanged) {
      if (committedValue) values[id] = clone(committedValue)
      continue
    }
    if (!committedChanged) {
      if (currentValue) values[id] = clone(currentValue)
      continue
    }
    if (currentValue) values[id] = clone(currentValue)
    if (currentValue && !committedValue) {
      // The committed remote tombstone is retained inside the conflict, but must
      // not hide the newer local edit before the user resolves that conflict.
      suppressedCommittedTombstoneTargets.add(`${entityKind}\u0000${id}`)
    }
    conflicts.push(await makeConcurrentTransactionConflict({
      entityKind,
      entityId: id,
      current: currentValue,
      committed: committedValue,
      currentSnapshot,
      committedSnapshot,
      deviceId,
    }))
  }
  return { values, conflicts, suppressedCommittedTombstoneTargets }
}

async function mergeLocalChangesAfterTransaction(record: DriveTransactionRecord, committed: JournalSnapshot, current: JournalSnapshot) {
  if (!record.plan.initialSnapshot) {
    throw new Error('Drive transaction cannot preserve newer local edits because its initial snapshot is unavailable.')
  }
  const initial = asJournalSnapshot(record.plan.initialSnapshot)
  const deviceId = current.device?.id ?? committed.device?.id ?? initial.device?.id ?? 'unknown-device'
  const toRecord = <T extends ResolvableEntity>(values: T[]) => Object.fromEntries(values.map((value) => [value.id, value]))
  const [entries, attachments, fileBoxItems, transfers] = await Promise.all([
    mergeEntityRecordAfterTransaction('entry', initial.entries, committed.entries, current.entries, committed, current, deviceId),
    mergeEntityRecordAfterTransaction('attachment', toRecord(initial.attachments), toRecord(committed.attachments), toRecord(current.attachments), committed, current, deviceId),
    mergeEntityRecordAfterTransaction('fileBoxItem', toRecord(initial.fileBoxItems), toRecord(committed.fileBoxItems), toRecord(current.fileBoxItems), committed, current, deviceId),
    mergeEntityRecordAfterTransaction('transfer', toRecord(initial.transfers), toRecord(committed.transfers), toRecord(current.transfers), committed, current, deviceId),
  ])
  let conflicts = mergeArrayAfterTransaction(initial.conflicts, committed.conflicts, current.conflicts)
  for (const conflict of [...entries.conflicts, ...attachments.conflicts, ...fileBoxItems.conflicts, ...transfers.conflicts]) {
    conflicts = upsertConflict(conflicts, conflict)
  }
  const suppressedCommittedTombstoneTargets = new Set([
    ...entries.suppressedCommittedTombstoneTargets,
    ...attachments.suppressedCommittedTombstoneTargets,
    ...fileBoxItems.suppressedCommittedTombstoneTargets,
    ...transfers.suppressedCommittedTombstoneTargets,
  ])
  const normalizedTombstones = normalizeTombstonesByTarget(
    mergeArrayAfterTransaction(initial.tombstones, committed.tombstones, current.tombstones)
      .filter((tombstone) => !suppressedCommittedTombstoneTargets.has(`${tombstone.entityKind}\u0000${tombstone.entityId}`)),
  )
  for (const conflict of normalizedTombstones.conflicts) conflicts = upsertConflict(conflicts, conflict)
  return applyTombstonesToSnapshot({
    entries: entries.values as Record<string, Entry>,
    attachments: Object.values(attachments.values) as Attachment[],
    fileBoxItems: Object.values(fileBoxItems.values) as FileBoxItem[],
    transfers: Object.values(transfers.values) as TransferRecord[],
    conflicts,
    tombstones: normalizedTombstones.tombstones,
    device: sameSnapshotValue(current.device, initial.device) ? clone(committed.device) : clone(current.device),
  }, normalizedTombstones.tombstones)
}

async function finalizeDriveTransaction(params: {
  provider: SyncProvider
  store: LocalJournalStore
  journal: DriveTransactionJournal
  storageScope: string
  record: DriveTransactionRecord
}) {
  const currentAccountScope = params.provider.currentAccountScope?.()
  if (currentAccountScope && currentAccountScope !== params.storageScope) {
    throw new Error('Google account changed before Drive transaction finalization; local completion is blocked.')
  }
  const receipts = params.record.receipts
  if (receipts.length !== params.record.plan.writes.length || params.record.state !== 'manifest-committed') {
    throw new Error('Drive transaction cannot finalize before every write and manifest are verified.')
  }
  const { snapshot, meta } = await resolvedTransactionState(params.record)
  if (params.provider.listChanges) {
    meta.driveChangesToken = (await params.provider.listChanges(meta.driveChangesToken ?? '0')).nextToken
  }
  let finalized = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readStableStoreState(params.store)
    const currentInputHash = await hashJsonSha256({ snapshot: current.snapshot, meta: current.meta })
    const finalSnapshot = currentInputHash === params.record.plan.inputStateHash
      ? snapshot
      : await mergeLocalChangesAfterTransaction(params.record, snapshot, current.snapshot)
    if (await params.store.saveStateIfRevision(finalSnapshot, meta, current.revision)) {
      finalized = true
      break
    }
  }
  if (!finalized) throw new Error('Local notebook kept changing while Drive transaction completion was being merged.')
  await params.journal.markCompleted(params.storageScope, params.record.plan.operationId)
  return asSyncEngineResult(params.record.plan.result)
}

export async function syncOnce(params: {
  provider: SyncProvider
  store: LocalJournalStore
  device: DeviceProfile
  blobStore?: BlobStore
  downloadRemoteBlobs?: boolean
  transactionJournal?: DriveTransactionJournal
  accountScope?: string
}): Promise<SyncEngineResult> {
  const { provider, store, device, blobStore, downloadRemoteBlobs = true } = params
  if (provider.supportsVersionedCas !== true) {
    throw new Error('Drive v1 writes are disabled until the provider supports versioned compare-and-swap.')
  }
  const session = await provider.signIn()
  const workspace = await provider.resolveWorkspace()
  const transactionJournal = params.transactionJournal ?? defaultTransactionJournal()
  const storageScope = params.accountScope?.trim()
    || session.account?.storageScope?.trim()
    || (session.provider === 'mock' ? 'mock-account' : '')
  if (!storageScope) throw new Error('Drive transaction recovery requires an account-scoped storage identity.')

  const initialStoreState = await readStableStoreState(store)
  let snapshot = initialStoreState.snapshot
  const initialSnapshot = clone(snapshot)
  const storedMeta = initialStoreState.meta
  const inputStateHash = await hashJsonSha256({ snapshot, meta: storedMeta })
  let incomplete = await transactionJournal.latestIncomplete(storageScope)
  if (incomplete) {
    if (incomplete.plan.inputStateHash !== inputStateHash
      && !incomplete.plan.initialSnapshot) {
      throw new Error('Local notebook input changed while a legacy Drive transaction was incomplete; safe recovery is blocked.')
    }
    const manifestWrite = incomplete.plan.writes.at(-1)
    const manifestReceipt = manifestWrite?.kind === 'manifest'
      ? incomplete.receipts.find((receipt) => receipt.writeId === manifestWrite.id)
      : undefined
    if (manifestReceipt && incomplete.receipts.length === incomplete.plan.writes.length) {
      const currentAccountScope = provider.currentAccountScope?.()
      if (currentAccountScope && currentAccountScope !== storageScope) {
        throw new Error('Google account changed before manifest-committed Drive recovery; local completion is blocked.')
      }
      if (incomplete.state !== 'manifest-committed') {
        incomplete = await transactionJournal.markManifestCommitted(storageScope, incomplete.plan.operationId)
      }
      await provider.releaseTransactionGuard(incomplete.plan.operationId)
      return finalizeDriveTransaction({ provider, store, journal: transactionJournal, storageScope, record: incomplete })
    }
    const recovered = await executeDriveTransaction({
      provider,
      blobStore,
      journal: transactionJournal,
      storageScope,
      record: incomplete,
    })
    return finalizeDriveTransaction({ provider, store, journal: transactionJournal, storageScope, record: recovered })
  }

  const normalizedLocalTombstones = normalizeTombstonesByTarget(snapshot.tombstones)
  snapshot.tombstones = normalizedLocalTombstones.tombstones
  for (const conflict of normalizedLocalTombstones.conflicts) {
    snapshot.conflicts = upsertConflict(snapshot.conflicts, conflict)
  }
  const meta = storedMeta
  meta.fileBoxHashes = meta.fileBoxHashes ?? {}
  meta.transferHashes = meta.transferHashes ?? {}
  meta.entryPaths = meta.entryPaths ?? {}
  meta.attachmentPaths = meta.attachmentPaths ?? {}
  meta.attachmentBlobPaths = meta.attachmentBlobPaths ?? {}
  meta.fileBoxPaths = meta.fileBoxPaths ?? {}
  meta.transferPaths = meta.transferPaths ?? {}
  meta.conflictPaths = meta.conflictPaths ?? {}
  meta.tombstonePaths = meta.tombstonePaths ?? {}
  const remoteManifest = await provider.getJson<unknown>('manifest.json')
  const manifestResult = validateManifest(remoteManifest?.value)
  if (remoteManifest && !manifestResult.ok) {
    throw new Error(`Drive manifest is malformed and blocks transactional sync: ${manifestResult.error}`)
  }
  const previousManifest: SyncManifest | undefined = manifestResult.ok ? manifestResult.value : undefined
  const preflightFiles = await provider.listManagedFiles()
  const preflightIndex = indexRemotePaths(preflightFiles)
  const listedManifest = exactRemoteFile(preflightIndex, 'manifest.json')
  if (remoteManifest
    && (!listedManifest || remoteManifest.id !== listedManifest.id || remoteManifest.version !== listedManifest.version)) {
    throw new Error('Drive manifest identity changed before transactional preflight completed.')
  }
  if (!remoteManifest && listedManifest) {
    throw new Error('Drive manifest appeared during transactional preflight; sync must restart.')
  }

  // Validate the complete remote snapshot before making any remote mutation.  A malformed
  // tombstone cannot safely be ignored because its unknown target could otherwise resurrect.
  const [remoteConflicts, remoteTombstones, remoteEntries, remoteAttachments, remoteFileBoxItems, remoteTransfers] = await Promise.all([
    readRemoteConflicts(provider, device.id),
    readRemoteTombstones(provider, device.id),
    readRemoteEntries(provider, device.id),
    readRemoteAttachments(provider, device.id),
    readRemoteFileBoxItems(provider, device.id),
    readRemoteTransfers(provider, device.id),
  ])
  const invalidRemoteRecords = [
    ...remoteConflicts.invalid,
    ...remoteTombstones.invalid,
    ...remoteEntries.invalid,
    ...remoteAttachments.invalid,
    ...remoteFileBoxItems.invalid,
    ...remoteTransfers.invalid,
  ]
  if (invalidRemoteRecords.length > 0) {
    for (const conflict of invalidRemoteRecords) snapshot.conflicts = upsertConflict(snapshot.conflicts, conflict)
    await saveStoreState(store, snapshot, meta)
    return {
      pulledEntries: 0, pushedEntries: 0, pulledAttachments: 0, pushedAttachments: 0,
      uploadedBlobs: 0, downloadedBlobs: 0, pushedTombstones: 0, conflicts: snapshot.conflicts.length,
    }
  }
  if (previousManifest) {
    const effectiveRemoteTombstones = remoteTombstones.valid.filter((tombstone) => !remoteConflicts.valid.some((conflict) => {
      const resolvedTombstone = conflictRemoteTombstone(conflict)
      return conflict.resolution === 'local-won'
        && conflict.entityKind === tombstone.entityKind
        && conflict.entityId === tombstone.entityId
        && resolvedTombstone?.deletedAt === tombstone.deletedAt
        && resolvedTombstone.deletedByDeviceId === tombstone.deletedByDeviceId
    }))
    const projectedRemote = applyTombstonesToSnapshot({
      entries: Object.fromEntries(remoteEntries.valid.map((envelope) => [envelope.id, envelope.payload])),
      attachments: remoteAttachments.valid.map((envelope) => envelope.payload),
      fileBoxItems: remoteFileBoxItems.valid.map((envelope) => envelope.payload),
      transfers: remoteTransfers.valid.map((envelope) => envelope.payload),
      conflicts: remoteConflicts.valid,
      tombstones: effectiveRemoteTombstones,
      device,
    }, effectiveRemoteTombstones)
    const countsMatch = previousManifest.entryCount === Object.keys(projectedRemote.entries).length
      && previousManifest.attachmentCount === projectedRemote.attachments.length
      && previousManifest.fileBoxCount === projectedRemote.fileBoxItems.length
      && previousManifest.transferCount === projectedRemote.transfers.length
    if (!countsMatch) {
      throw new Error(`Drive manifest counts do not match the verified remote snapshot; transactional sync is blocked (${stableStringify({
        manifest: {
          entries: previousManifest.entryCount,
          attachments: previousManifest.attachmentCount,
          fileBox: previousManifest.fileBoxCount,
          transfers: previousManifest.transferCount,
        },
        remote: {
          entries: Object.keys(projectedRemote.entries).length,
          attachments: projectedRemote.attachments.length,
          fileBox: projectedRemote.fileBoxItems.length,
          transfers: projectedRemote.transfers.length,
        },
      })}).`)
    }
  }
  if (!previousManifest && preflightFiles.some((file) => file.path !== 'manifest.json')) {
    throw new Error('Drive workspace contains managed data without a verified manifest; transactional sync is blocked.')
  }

  let pulledEntries = 0
  let pulledAttachments = 0
  let pushedEntries = 0
  let pushedAttachments = 0
  let uploadedBlobs = 0
  let downloadedBlobs = 0
  let pushedTombstones = 0
  let conflicts = snapshot.conflicts.length

  for (const remoteConflict of remoteConflicts.valid) {
    meta.conflictPaths[remoteConflict.id] = remoteConflicts.paths[remoteConflict.id]
    const localConflict = snapshot.conflicts.find((conflict) => conflict.id === remoteConflict.id)
    const preferred = localConflict ? selectPreferredConflict(localConflict, remoteConflict) : remoteConflict
    if (!localConflict || preferred === remoteConflict) snapshot.conflicts = upsertConflict(snapshot.conflicts, remoteConflict)
  }

  const locallyWonRemoteDeletes = new Map<string, string>()
  for (const tombstone of remoteTombstones.valid) {
    meta.tombstonePaths[`${tombstone.entityKind}\u0000${tombstone.entityId}`] = remoteTombstones.paths[`${tombstone.entityKind}\u0000${tombstone.entityId}`]
    const resolvedDeleteConflict = snapshot.conflicts.find((conflict) => {
      const resolvedTombstone = conflictRemoteTombstone(conflict)
      return conflict.entityKind === tombstone.entityKind
        && conflict.entityId === tombstone.entityId
        && conflict.resolution !== 'pending'
        && resolvedTombstone?.deletedAt === tombstone.deletedAt
        && resolvedTombstone.deletedByDeviceId === tombstone.deletedByDeviceId
    })
    if (resolvedDeleteConflict?.resolution === 'local-won') {
      snapshot.tombstones = snapshot.tombstones.filter((candidate) => !(
        candidate.entityKind === tombstone.entityKind
        && candidate.entityId === tombstone.entityId
        && candidate.deletedAt === tombstone.deletedAt
      ))
      locallyWonRemoteDeletes.set(`${tombstone.entityKind}:${tombstone.entityId}`, tombstone.deletedAt)
      continue
    }

    if (tombstone.entityKind === 'entry') {
      const localEntry = snapshot.entries[tombstone.entityId]
      const baseHash = meta.entryHashes[tombstone.entityId]
      if (localEntry) {
        const localHash = await entryContentHash(localEntry)
        if (!baseHash || localHash !== baseHash) {
          snapshot.conflicts = upsertConflict(snapshot.conflicts, makeRemoteDeleteConflict({
            entityKind: 'entry',
            entityId: tombstone.entityId,
            localUpdatedAt: localEntry.lastEditedDatetime,
            localHash,
            localCopy: localEntry,
            tombstone,
            deviceId: device.id,
          }))
          continue
        }
      }
    }
    if (tombstone.entityKind === 'attachment') {
      const localAttachment = snapshot.attachments.find((attachment) => attachment.id === tombstone.entityId)
      if (localAttachment) {
        const localHash = await attachmentMetadataHash(localAttachment)
        const baseHash = meta.attachmentHashes[tombstone.entityId]
        if (!baseHash || localHash !== baseHash) {
          snapshot.conflicts = upsertConflict(snapshot.conflicts, makeRemoteDeleteConflict({
            entityKind: 'attachment',
            entityId: tombstone.entityId,
            localUpdatedAt: localAttachment.updatedAt || localAttachment.createdAt || nowIso(),
            localHash,
            localCopy: localAttachment,
            tombstone,
            deviceId: device.id,
          }))
          continue
        }
      }
    }
    if (tombstone.entityKind === 'fileBoxItem') {
      const localItem = snapshot.fileBoxItems.find((item) => item.id === tombstone.entityId)
      if (localItem) {
        const localHash = await fileBoxMetadataHash(localItem)
        const baseHash = meta.fileBoxHashes[tombstone.entityId]
        if (!baseHash || localHash !== baseHash) {
          snapshot.conflicts = upsertConflict(snapshot.conflicts, makeRemoteDeleteConflict({
            entityKind: 'fileBoxItem',
            entityId: tombstone.entityId,
            localUpdatedAt: localItem.updatedAt,
            localHash,
            localCopy: localItem,
            tombstone,
            deviceId: device.id,
          }))
          continue
        }
      }
    }
    if (tombstone.entityKind === 'transfer') {
      const localTransfer = snapshot.transfers.find((transfer) => transfer.id === tombstone.entityId)
      if (localTransfer) {
        const localHash = await transferMetadataHash(localTransfer)
        const baseHash = meta.transferHashes[tombstone.entityId]
        if (!baseHash || localHash !== baseHash) {
          snapshot.conflicts = upsertConflict(snapshot.conflicts, makeRemoteDeleteConflict({
            entityKind: 'transfer',
            entityId: tombstone.entityId,
            localUpdatedAt: localTransfer.updatedAt,
            localHash,
            localCopy: localTransfer,
            tombstone,
            deviceId: device.id,
          }))
          continue
        }
      }
    }
    const mergedTombstones = normalizeTombstonesByTarget([...snapshot.tombstones, tombstone])
    snapshot.tombstones = mergedTombstones.tombstones
    for (const conflict of mergedTombstones.conflicts) {
      snapshot.conflicts = upsertConflict(snapshot.conflicts, conflict)
    }
  }
  snapshot = applyTombstonesToSnapshot(snapshot, snapshot.tombstones)

  const tombstonedEntries = new Set(snapshot.tombstones.filter((tombstone) => tombstone.entityKind === 'entry').map((tombstone) => tombstone.entityId))
  const tombstonedAttachments = new Set(snapshot.tombstones.filter((tombstone) => tombstone.entityKind === 'attachment').map((tombstone) => tombstone.entityId))
  const tombstonedFileBoxItems = new Set(snapshot.tombstones.filter((tombstone) => tombstone.entityKind === 'fileBoxItem').map((tombstone) => tombstone.entityId))
  const tombstonedTransfers = new Set(snapshot.tombstones.filter((tombstone) => tombstone.entityKind === 'transfer').map((tombstone) => tombstone.entityId))

  for (const remoteEnvelope of remoteEntries.valid) {
    const remoteEntry = remoteEnvelope.payload
    meta.entryPaths[remoteEntry.id] = remoteEnvelope.remotePath
    const resolvedDeleteAt = locallyWonRemoteDeletes.get(`entry:${remoteEntry.id}`)
    if (tombstonedEntries.has(remoteEntry.id)
      || (resolvedDeleteAt && Date.parse(remoteEnvelope.updatedAt) <= Date.parse(resolvedDeleteAt))) continue
    const localEntry = snapshot.entries[remoteEntry.id]
    const remoteHash = await entryContentHash(remoteEntry)
    const baseHash = meta.entryHashes[remoteEntry.id]

    if (!localEntry) {
      snapshot.entries[remoteEntry.id] = remoteEntry
      meta.entryHashes[remoteEntry.id] = remoteHash
      pulledEntries += 1
      continue
    }

    const localHash = await entryContentHash(localEntry)

    if (localHash === remoteHash) {
      meta.entryHashes[remoteEntry.id] = remoteHash
      continue
    }

    const resolvedConflict = matchingResolvedConflict(snapshot.conflicts, 'entry', remoteEntry.id, localHash, remoteHash)
    if (resolvedConflict?.acceptRemote) {
      snapshot.entries[remoteEntry.id] = remoteEntry
      meta.entryHashes[remoteEntry.id] = remoteHash
      pulledEntries += 1
      continue
    }
    if (resolvedConflict) {
      meta.entryHashes[remoteEntry.id] = remoteHash
      continue
    }

    if (baseHash && localHash === baseHash) {
      snapshot.entries[remoteEntry.id] = remoteEntry
      meta.entryHashes[remoteEntry.id] = remoteHash
      pulledEntries += 1
      continue
    }

    if (baseHash && remoteHash === baseHash) {
      continue
    }

    snapshot.conflicts = upsertConflict(snapshot.conflicts, makeEntryConflict({
      entityId: remoteEntry.id,
      local: localEntry,
      remote: remoteEntry,
      localHash,
      remoteHash,
      deviceId: device.id,
      summary: 'Both devices edited this daily entry; local copy is kept visible and the Drive copy is preserved for review.',
    }))
  }

  for (const remoteEnvelope of remoteAttachments.valid) {
    const remoteAttachment = remoteEnvelope.payload
    meta.attachmentPaths[remoteAttachment.id] = remoteEnvelope.remotePath
    if (remoteEnvelope.remoteBlobPath) meta.attachmentBlobPaths[remoteAttachment.id] = remoteEnvelope.remoteBlobPath
    else delete meta.attachmentBlobPaths[remoteAttachment.id]
    const resolvedDeleteAt = locallyWonRemoteDeletes.get(`attachment:${remoteAttachment.id}`)
    if (tombstonedAttachments.has(remoteAttachment.id) || tombstonedEntries.has(remoteAttachment.entryId)
      || (resolvedDeleteAt && Date.parse(remoteEnvelope.updatedAt) <= Date.parse(resolvedDeleteAt))) {
      tombstonedAttachments.add(remoteAttachment.id)
      continue
    }
    const localIndex = snapshot.attachments.findIndex((attachment) => attachment.id === remoteAttachment.id)
    const remoteHash = await attachmentMetadataHash(remoteAttachment)
    const baseHash = meta.attachmentHashes[remoteAttachment.id]

    if (localIndex < 0) {
      const restoredAttachment = await restoreRemoteAttachmentBlob(remoteAttachment, snapshot.entries, provider, blobStore, downloadRemoteBlobs)
      if (restoredAttachment.downloaded) downloadedBlobs += 1
      snapshot.attachments.push(restoredAttachment.attachment)
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      pulledAttachments += 1
      continue
    }

    const localHash = await attachmentMetadataHash(snapshot.attachments[localIndex])
    if (localHash === remoteHash) {
      if (blobStore && downloadRemoteBlobs) {
        const restoredAttachment = await restoreRemoteAttachmentBlob(
          remoteAttachment,
          snapshot.entries,
          provider,
          blobStore,
          true,
        )
        if (restoredAttachment.downloaded) downloadedBlobs += 1
        snapshot.attachments[localIndex] = restoredAttachment.attachment
      }
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      continue
    }

    const localAttachment = snapshot.attachments[localIndex]
    const resolvedConflict = matchingResolvedConflict(snapshot.conflicts, 'attachment', remoteAttachment.id, localHash, remoteHash)
    if (resolvedConflict?.acceptRemote) {
      const restoredAttachment = await restoreRemoteAttachmentBlob(remoteAttachment, snapshot.entries, provider, blobStore, downloadRemoteBlobs)
      if (restoredAttachment.downloaded) downloadedBlobs += 1
      snapshot.attachments[localIndex] = restoredAttachment.attachment
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      pulledAttachments += 1
      continue
    }
    if (resolvedConflict) {
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      continue
    }

    if (baseHash && localHash === baseHash) {
      const restoredAttachment = await restoreRemoteAttachmentBlob(remoteAttachment, snapshot.entries, provider, blobStore, downloadRemoteBlobs)
      if (restoredAttachment.downloaded) downloadedBlobs += 1
      snapshot.attachments[localIndex] = restoredAttachment.attachment
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      pulledAttachments += 1
      continue
    }
    if (baseHash && remoteHash === baseHash) continue

    snapshot.conflicts = upsertConflict(snapshot.conflicts, makeEntityConflict({
      entityKind: 'attachment',
      entityId: remoteAttachment.id,
      localUpdatedAt: localAttachment.updatedAt || localAttachment.createdAt || nowIso(),
      remoteUpdatedAt: remoteEnvelope.updatedAt,
      localHash,
      remoteHash,
      localCopy: localAttachment,
      remoteCopy: remoteAttachment,
      deviceId: device.id,
      summary: 'Both devices changed this attachment; the local metadata is kept until resolved.',
    }))
  }

  for (const remoteEnvelope of remoteFileBoxItems.valid) {
    const remoteItem = remoteEnvelope.payload
    meta.fileBoxPaths[remoteItem.id] = remoteEnvelope.remotePath
    const resolvedDeleteAt = locallyWonRemoteDeletes.get(`fileBoxItem:${remoteItem.id}`)
    if (tombstonedFileBoxItems.has(remoteItem.id) || tombstonedEntries.has(remoteItem.entryId) || tombstonedAttachments.has(remoteItem.attachmentId || '')
      || (resolvedDeleteAt && Date.parse(remoteEnvelope.updatedAt) <= Date.parse(resolvedDeleteAt))) {
      tombstonedFileBoxItems.add(remoteItem.id)
      continue
    }
    const localIndex = snapshot.fileBoxItems.findIndex((item) => item.id === remoteItem.id)
    const remoteHash = await fileBoxMetadataHash(remoteItem)
    const baseHash = meta.fileBoxHashes[remoteItem.id]

    if (localIndex < 0) {
      snapshot.fileBoxItems.push(remoteItem)
      meta.fileBoxHashes[remoteItem.id] = remoteHash
      continue
    }

    const localHash = await fileBoxMetadataHash(snapshot.fileBoxItems[localIndex])
    if (localHash === remoteHash) {
      meta.fileBoxHashes[remoteItem.id] = remoteHash
      continue
    }

    const localItem = snapshot.fileBoxItems[localIndex]
    const resolvedConflict = matchingResolvedConflict(snapshot.conflicts, 'fileBoxItem', remoteItem.id, localHash, remoteHash)
    if (resolvedConflict?.acceptRemote) {
      snapshot.fileBoxItems[localIndex] = remoteItem
      meta.fileBoxHashes[remoteItem.id] = remoteHash
      continue
    }
    if (resolvedConflict) {
      meta.fileBoxHashes[remoteItem.id] = remoteHash
      continue
    }
    if (baseHash && localHash === baseHash) {
      snapshot.fileBoxItems[localIndex] = remoteItem
      meta.fileBoxHashes[remoteItem.id] = remoteHash
      continue
    }
    if (baseHash && remoteHash === baseHash) continue

    snapshot.conflicts = upsertConflict(snapshot.conflicts, makeEntityConflict({
      entityKind: 'fileBoxItem',
      entityId: remoteItem.id,
      localUpdatedAt: localItem.updatedAt,
      remoteUpdatedAt: remoteEnvelope.updatedAt,
      localHash,
      remoteHash,
      localCopy: localItem,
      remoteCopy: remoteItem,
      deviceId: device.id,
      summary: 'Both devices changed this File Box item; the local metadata is kept until resolved.',
    }))
  }

  for (const remoteEnvelope of remoteTransfers.valid) {
    const remoteTransfer = remoteEnvelope.payload
    meta.transferPaths[remoteTransfer.id] = remoteEnvelope.remotePath
    const resolvedDeleteAt = locallyWonRemoteDeletes.get(`transfer:${remoteTransfer.id}`)
    if (tombstonedTransfers.has(remoteTransfer.id) || tombstonedFileBoxItems.has(remoteTransfer.fileBoxItemId || '')
      || tombstonedEntries.has(remoteTransfer.entryId || '') || tombstonedAttachments.has(remoteTransfer.attachmentId || '')
      || (resolvedDeleteAt && Date.parse(remoteEnvelope.updatedAt) <= Date.parse(resolvedDeleteAt))) continue
    const localIndex = snapshot.transfers.findIndex((transfer) => transfer.id === remoteTransfer.id)
    const remoteHash = await transferMetadataHash(remoteTransfer)
    const baseHash = meta.transferHashes[remoteTransfer.id]

    if (localIndex < 0) {
      snapshot.transfers.push(remoteTransfer)
      meta.transferHashes[remoteTransfer.id] = remoteHash
      continue
    }

    const localHash = await transferMetadataHash(snapshot.transfers[localIndex])
    if (localHash === remoteHash) {
      meta.transferHashes[remoteTransfer.id] = remoteHash
      continue
    }

    const localTransfer = snapshot.transfers[localIndex]
    const resolvedConflict = matchingResolvedConflict(snapshot.conflicts, 'transfer', remoteTransfer.id, localHash, remoteHash)
    if (resolvedConflict?.acceptRemote) {
      snapshot.transfers[localIndex] = remoteTransfer
      meta.transferHashes[remoteTransfer.id] = remoteHash
      continue
    }
    if (resolvedConflict) {
      meta.transferHashes[remoteTransfer.id] = remoteHash
      continue
    }
    if (baseHash && localHash === baseHash) {
      snapshot.transfers[localIndex] = remoteTransfer
      meta.transferHashes[remoteTransfer.id] = remoteHash
      continue
    }
    if (baseHash && remoteHash === baseHash) continue

    snapshot.conflicts = upsertConflict(snapshot.conflicts, makeEntityConflict({
      entityKind: 'transfer',
      entityId: remoteTransfer.id,
      localUpdatedAt: localTransfer.updatedAt,
      remoteUpdatedAt: remoteEnvelope.updatedAt,
      localHash,
      remoteHash,
      localCopy: localTransfer,
      remoteCopy: remoteTransfer,
      deviceId: device.id,
      summary: 'Both devices changed this transfer; the local metadata is kept until resolved.',
    }))
  }

  const planningFiles = await provider.listManagedFiles()
  const preflightIdentity = preflightFiles
    .map(({ path, id, version }) => ({ path, id, version }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
  const planningIdentity = planningFiles
    .map(({ path, id, version }) => ({ path, id, version }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
  if (stableStringify(preflightIdentity) !== stableStringify(planningIdentity)) {
    throw new Error('Drive changed during transactional preflight; sync must be retried from a fresh snapshot.')
  }
  const planningIndex = indexRemotePaths(planningFiles)

  const hasTombstone = (entityKind: TombstoneRecord['entityKind'], entityId: string) => snapshot.tombstones.some(
    (tombstone) => tombstone.entityKind === entityKind && tombstone.entityId === entityId,
  )
  for (const entry of Object.values(snapshot.entries)) {
    const path = meta.entryPaths[entry.id] ?? entryPath(entry, snapshot.entries)
    if (meta.entryHashes[entry.id] && !hasTombstone('entry', entry.id) && !exactRemoteFile(planningIndex, path)) {
      throw new Error(`Drive entry with a prior baseline is missing: ${path}`)
    }
  }
  for (const attachment of snapshot.attachments) {
    const path = meta.attachmentPaths[attachment.id] ?? attachmentMetadataPath(attachment, snapshot.entries)
    if (meta.attachmentHashes[attachment.id]
      && !hasTombstone('attachment', attachment.id)
      && !hasTombstone('entry', attachment.entryId)
      && !exactRemoteFile(planningIndex, path)) {
      throw new Error(`Drive attachment with a prior baseline is missing: ${path}`)
    }
  }
  for (const item of snapshot.fileBoxItems) {
    const path = meta.fileBoxPaths[item.id] ?? fileBoxPath(item)
    if (meta.fileBoxHashes[item.id] && !hasTombstone('fileBoxItem', item.id) && !exactRemoteFile(planningIndex, path)) {
      throw new Error(`Drive File Box record with a prior baseline is missing: ${path}`)
    }
  }
  for (const transfer of snapshot.transfers) {
    const path = meta.transferPaths[transfer.id] ?? transferPath(transfer)
    if (meta.transferHashes[transfer.id] && !hasTombstone('transfer', transfer.id) && !exactRemoteFile(planningIndex, path)) {
      throw new Error(`Drive transfer with a prior baseline is missing: ${path}`)
    }
  }

  const scopeHash = await hashTextSha256(storageScope)
  const transactionSeed = await hashJsonSha256({
    scopeHash,
    inputStateHash,
    remote: planningIdentity,
    deviceId: device.id,
  })
  const tombstoneWrites: DriveTransactionJsonWrite[] = []
  const blobWrites: DriveTransactionBlobWrite[] = []
  const jsonWrites: DriveTransactionJsonWrite[] = []
  const blockedTombstoneTargets = new Set(
    snapshot.conflicts.map(divergentTombstoneTarget).filter((target): target is string => Boolean(target)),
  )
  for (const tombstone of snapshot.tombstones) {
    const target = `${tombstone.entityKind}\u0000${tombstone.entityId}`
    if (blockedTombstoneTargets.has(target)) continue
    tombstoneWrites.push(await buildJsonTransactionWrite({
      kind: 'tombstone',
      seed: transactionSeed,
      path: meta.tombstonePaths[target] ?? tombstonePath(tombstone),
      value: tombstone,
      appProperties: { entityType: 'tombstone', entityId: tombstone.entityId },
      remoteIndex: planningIndex,
    }))
    pushedTombstones += 1
  }

  const openConflictEntries = new Set(snapshot.conflicts.filter((conflict) => conflict.resolution === 'pending' && conflict.entityKind === 'entry').map((conflict) => conflict.entityId))
  const openConflictAttachments = new Set(snapshot.conflicts.filter((conflict) => conflict.resolution === 'pending' && conflict.entityKind === 'attachment').map((conflict) => conflict.entityId))
  const openConflictFileBoxItems = new Set(snapshot.conflicts.filter((conflict) => conflict.resolution === 'pending' && conflict.entityKind === 'fileBoxItem').map((conflict) => conflict.entityId))
  const openConflictTransfers = new Set(snapshot.conflicts.filter((conflict) => conflict.resolution === 'pending' && conflict.entityKind === 'transfer').map((conflict) => conflict.entityId))

  for (const attachment of snapshot.attachments) {
    if (openConflictAttachments.has(attachment.id)) continue
    const uploadedBlob = await planAttachmentBlob({
      attachment,
      entries: snapshot.entries,
      blobStore,
      verifiedBlobPath: meta.attachmentBlobPaths[attachment.id],
      seed: transactionSeed,
      remoteIndex: planningIndex,
    })
    if (uploadedBlob.write) blobWrites.push(uploadedBlob.write)
    if (uploadedBlob.uploaded) uploadedBlobs += 1
    const nextAttachment = uploadedBlob.attachment
    const attachmentIndex = snapshot.attachments.findIndex((candidate) => candidate.id === nextAttachment.id)
    if (attachmentIndex >= 0) snapshot.attachments[attachmentIndex] = nextAttachment
    if (nextAttachment.syncStatus === 'failed') continue
    const hash = await attachmentMetadataHash(nextAttachment)
    if (hash !== meta.attachmentHashes[attachment.id]) {
      jsonWrites.push(await buildJsonTransactionWrite({
        kind: 'json',
        seed: transactionSeed,
        path: meta.attachmentPaths[nextAttachment.id] ?? attachmentMetadataPath(nextAttachment, snapshot.entries),
        value: buildAttachmentEnvelope({ ...nextAttachment, syncStatus: 'synced' }, device),
        appProperties: { entityType: 'attachment', entityId: nextAttachment.id, contentHash: hash },
        remoteIndex: planningIndex,
      }))
      if (attachmentIndex >= 0) snapshot.attachments[attachmentIndex] = { ...nextAttachment, syncStatus: 'synced' }
      meta.attachmentHashes[nextAttachment.id] = hash
      pushedAttachments += 1
    }
  }

  for (const entry of Object.values(snapshot.entries)) {
    if (openConflictEntries.has(entry.id)) continue
    const hash = await entryContentHash(entry)
    if (hash !== meta.entryHashes[entry.id]) {
      const envelope = buildEntryEnvelope({ ...entry, syncStatus: 'synced', updatedByDeviceId: device.id }, device)
      jsonWrites.push(await buildJsonTransactionWrite({
        kind: 'json',
        seed: transactionSeed,
        path: meta.entryPaths[entry.id] ?? entryPath(entry, snapshot.entries),
        value: envelope,
        appProperties: { entityType: 'entry', entityId: entry.id, contentHash: hash },
        remoteIndex: planningIndex,
      }))
      meta.entryHashes[entry.id] = hash
      pushedEntries += 1
    }
  }

  for (const conflict of snapshot.conflicts) {
    jsonWrites.push(await buildJsonTransactionWrite({
      kind: 'json',
      seed: transactionSeed,
      path: meta.conflictPaths[conflict.id] ?? `conflicts/${safeDriveSegment(conflict.id, 'conflict')}.json`,
      value: conflict,
      appProperties: { entityType: 'conflict', entityId: conflict.entityId },
      remoteIndex: planningIndex,
    }))
  }

  for (const item of snapshot.fileBoxItems) {
    if (openConflictFileBoxItems.has(item.id) || tombstonedFileBoxItems.has(item.id) || tombstonedEntries.has(item.entryId) || tombstonedAttachments.has(item.attachmentId || '')) continue
    const hash = await fileBoxMetadataHash(item)
    if (hash !== meta.fileBoxHashes[item.id]) {
      jsonWrites.push(await buildJsonTransactionWrite({
        kind: 'json',
        seed: transactionSeed,
        path: meta.fileBoxPaths[item.id] ?? fileBoxPath(item),
        value: buildFileBoxEnvelope(item, device),
        appProperties: { entityType: 'fileBoxItem', entityId: item.id, contentHash: hash },
        remoteIndex: planningIndex,
      }))
      meta.fileBoxHashes[item.id] = hash
    }
  }

  for (const transfer of snapshot.transfers) {
    if (openConflictTransfers.has(transfer.id) || tombstonedTransfers.has(transfer.id)
      || tombstonedFileBoxItems.has(transfer.fileBoxItemId || '')
      || tombstonedEntries.has(transfer.entryId || '') || tombstonedAttachments.has(transfer.attachmentId || '')) continue
    const hash = await transferMetadataHash(transfer)
    if (hash !== meta.transferHashes[transfer.id]) {
      jsonWrites.push(await buildJsonTransactionWrite({
        kind: 'json',
        seed: transactionSeed,
        path: meta.transferPaths[transfer.id] ?? transferPath(transfer),
        value: buildTransferEnvelope(transfer, device),
        appProperties: { entityType: 'transfer', entityId: transfer.id, contentHash: hash },
        remoteIndex: planningIndex,
      }))
      meta.transferHashes[transfer.id] = hash
    }
  }

  jsonWrites.push(await buildJsonTransactionWrite({
    kind: 'json',
    seed: transactionSeed,
    path: `devices/${safeDriveSegment(device.id, 'device')}.json`,
    value: device,
    appProperties: { entityType: 'device', entityId: device.id },
    remoteIndex: planningIndex,
  }))

  const pendingRemoteDeletes = snapshot.conflicts
    .filter((conflict) => conflict.resolution === 'pending')
    .map(conflictRemoteTombstone)
    .filter((tombstone): tombstone is TombstoneRecord => Boolean(tombstone))
  const manifestSnapshot = applyTombstonesToSnapshot(
    snapshot,
    normalizeTombstonesByTarget([...snapshot.tombstones, ...pendingRemoteDeletes]).tombstones,
  )
  const manifest = createManifest({
    device,
    entries: manifestSnapshot.entries,
    attachments: manifestSnapshot.attachments,
    fileBoxItems: manifestSnapshot.fileBoxItems,
    transfers: manifestSnapshot.transfers,
    folderName: workspace.rootPath,
    previousManifest,
  })
  const manifestWrite = await buildJsonTransactionWrite({
    kind: 'manifest',
    seed: transactionSeed,
    path: 'manifest.json',
    value: manifest,
    appProperties: { entityType: 'manifest' },
    remoteIndex: planningIndex,
  })
  conflicts = snapshot.conflicts.length
  const result = { pulledEntries, pushedEntries, pulledAttachments, pushedAttachments, uploadedBlobs, downloadedBlobs, pushedTombstones, conflicts }
  const writes: DriveTransactionWrite[] = [...tombstoneWrites, ...blobWrites, ...jsonWrites, manifestWrite]
  const planCore = {
    inputStateHash,
    remoteIdentity: planningIdentity.map(({ path, id, version }) => ({ path, fileId: id, version })),
    writes,
    initialSnapshot,
    finalSnapshot: snapshot,
    finalMeta: meta,
    result,
  }
  const planHash = await hashJsonSha256(planCore)
  const plan: DriveTransactionPlan = {
    operationId: planHash,
    planHash,
    createdAt: nowIso(),
    ...clone(planCore),
  }
  const prepared = await transactionJournal.begin(storageScope, plan)
  const executed = await executeDriveTransaction({
    provider,
    blobStore,
    journal: transactionJournal,
    storageScope,
    record: prepared,
  })
  return finalizeDriveTransaction({ provider, store, journal: transactionJournal, storageScope, record: executed })
}

async function planAttachmentBlob(params: {
  attachment: Attachment
  entries: Record<string, Entry>
  blobStore?: BlobStore
  verifiedBlobPath?: string
  seed: string
  remoteIndex: RemotePathIndex
}): Promise<{ attachment: Attachment; uploaded: boolean; write?: DriveTransactionBlobWrite }> {
  const { attachment, entries, blobStore, verifiedBlobPath, seed, remoteIndex } = params
  if (!blobStore) return { attachment, uploaded: false }
  const key = attachmentBlobKey(attachment)
  const record = await blobStore.getRecord(key)
  if (!record) return { attachment, uploaded: false }
  if (attachment.driveFileId && attachment.syncStatus === 'synced' && attachment.sha256 === record.sha256) {
    const verified = await blobStore.verify(key, attachment.sha256)
    if (verified.ok) return { attachment: { ...attachment, cacheKey: key }, uploaded: false }
    await blobStore.delete(key)
    return {
      attachment: {
        ...attachment,
        cacheKey: undefined,
        cachedPath: undefined,
        thumbnail: undefined,
        syncStatus: 'remote-available',
      },
      uploaded: false,
    }
  }
  const expectedSha256 = attachment.sha256 || record.sha256
  const verified = await blobStore.verify(key, expectedSha256)
  if (!verified.ok || !verified.actualSha256) {
    return { attachment: { ...attachment, syncStatus: 'failed' }, uploaded: false }
  }
  const actualSha256 = verified.actualSha256
  const write = await buildBlobTransactionWrite({
    seed,
    path: verifiedBlobPath ?? attachmentBlobPath(attachment, entries),
    blobKey: key,
    mimeType: attachment.contentType || attachment.mimeType || record.mimeType,
    sha256: actualSha256,
    byteSize: record.size,
    appProperties: { entityType: 'attachmentBlob', entityId: attachment.id, sha256: actualSha256 },
    remoteIndex,
  })
  const driveFileId = write.precondition.kind === 'must-match'
    ? write.precondition.fileId
    : write.fileIdPlaceholder
  return {
    attachment: {
      ...attachment,
      cacheKey: key,
      sha256: actualSha256,
      bytes: attachment.bytes ?? record.size,
      contentType: attachment.contentType || record.mimeType,
      driveFileId,
      syncStatus: 'synced',
      updatedAt: nowIso(),
    },
    uploaded: true,
    write,
  }
}

async function restoreRemoteAttachmentBlob(
  attachment: Attachment,
  entries: Record<string, Entry>,
  provider: SyncProvider,
  blobStore?: BlobStore,
  downloadRemoteBlobs = true
): Promise<{ attachment: Attachment; downloaded: boolean }> {
  if (!blobStore || !downloadRemoteBlobs) {
    return {
      attachment: {
        ...attachment,
        cacheKey: undefined,
        cachedPath: undefined,
        thumbnail: undefined,
        syncStatus: attachment.driveFileId ? 'remote-available' : attachment.syncStatus,
      },
      downloaded: false,
    }
  }
  const key = attachmentBlobKey(attachment)
  if (await blobStore.has(key)) {
    const verification = await blobStore.verify(key, attachment.sha256)
    if (verification.ok) return { attachment: { ...attachment, cacheKey: key }, downloaded: false }
    await blobStore.delete(key)
  }
  const remoteBlobById = attachment.driveFileId && provider.getBlobById
    ? await provider.getBlobById(attachment.driveFileId)
    : null
  const remoteBlob = remoteBlobById ?? await provider.getBlob(attachmentBlobPath(attachment, entries))
  if (!remoteBlob) return { attachment, downloaded: false }
  const record = await blobStore.put(key, remoteBlob)
  if (attachment.sha256 && record.sha256 !== attachment.sha256) {
    await blobStore.delete(key)
    return { attachment: { ...attachment, syncStatus: 'failed' }, downloaded: false }
  }
  return {
    attachment: {
      ...attachment,
      cacheKey: key,
      sha256: record.sha256,
      bytes: attachment.bytes ?? record.size,
      contentType: attachment.contentType || record.mimeType,
      syncStatus: 'synced',
    },
    downloaded: true,
  }
}

export async function downloadAttachmentBlob(params: {
  attachment: Attachment
  entries: Record<string, Entry>
  provider: SyncProvider
  blobStore: BlobStore
}): Promise<{ attachment: Attachment; downloaded: boolean }> {
  return restoreRemoteAttachmentBlob(params.attachment, params.entries, params.provider, params.blobStore, true)
}

function newestEnvelopePerId<T extends SyncEntityEnvelope<unknown>>(envelopes: T[]) {
  const newest = new Map<string, T>()
  for (const envelope of envelopes) {
    const current = newest.get(envelope.id)
    if (!current || Date.parse(envelope.updatedAt) >= Date.parse(current.updatedAt)) newest.set(envelope.id, envelope)
  }
  return [...newest.values()]
}

type RemoteEnvelope<T> = SyncEntityEnvelope<T> & { remotePath: string }

function appendDuplicateEnvelopeConflicts<T>(params: {
  envelopes: RemoteEnvelope<T>[]
  invalid: SyncConflict[]
  deviceId: string
  entityKind: SyncConflict['entityKind']
}) {
  const byId = new Map<string, RemoteEnvelope<T>[]>()
  for (const envelope of params.envelopes) byId.set(envelope.id, [...(byId.get(envelope.id) ?? []), envelope])
  for (const [id, duplicates] of byId) {
    if (duplicates.length < 2) continue
    params.invalid.push(buildInvalidRemoteJsonConflict({
      entityKind: params.entityKind,
      entityId: id,
      deviceId: params.deviceId,
      error: `Multiple verified Drive records claim the same ${params.entityKind} id.`,
      remoteCopy: duplicates.map((duplicate) => ({ path: duplicate.remotePath, value: duplicate })),
      detectedAt: duplicates.map((duplicate) => duplicate.updatedAt).sort().at(-1) ?? nowIso(),
    }))
  }
}

function remoteEnvelope<T>(path: string, envelope: SyncEntityEnvelope<T>): RemoteEnvelope<T> {
  return { ...envelope, remotePath: path }
}

async function readRemoteEntries(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'entries/' })
  const valid: RemoteEnvelope<Entry>[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const result = await readValidatedRemoteJson(provider, file, deviceId, 'entry', validateEntryEnvelope)
    if (result.ok) valid.push(remoteEnvelope(file.path, result.value))
    else invalid.push(result.conflict)
  }
  appendDuplicateEnvelopeConflicts({ envelopes: valid, invalid, deviceId, entityKind: 'entry' })
  return { valid: newestEnvelopePerId(valid), invalid }
}

async function readRemoteAttachments(provider: SyncProvider, deviceId: string) {
  const allFiles = await provider.listManagedFiles({ prefix: 'attachments/' })
  const files = allFiles.filter((file) => file.path.endsWith('.json'))
  const filesById = new Map(allFiles.map((file) => [file.id, file]))
  const valid: (RemoteEnvelope<Attachment> & { remoteBlobPath?: string })[] = []
  const invalid: SyncConflict[] = []
  const results = await Promise.all(files.map(async (file) => ({
    file,
    result: await readValidatedRemoteJson(provider, file, deviceId, 'attachment', validateAttachmentEnvelope),
  })))
  const referencedBlobIds = new Set(results.flatMap(({ result }) =>
    result.ok && result.value.payload.driveFileId ? [result.value.payload.driveFileId] : [],
  ))
  for (const { file, result } of results) {
    if (!result.ok) {
      // A blob may itself be a JSON file.  Its Drive file identity, not its suffix,
      // distinguishes it from a malformed metadata sidecar.
      if (referencedBlobIds.has(file.id)) continue
      invalid.push(result.conflict)
      continue
    }
    const attachment = result.value.payload
    const blobFile = attachment.driveFileId ? filesById.get(attachment.driveFileId) : undefined
    if (attachment.driveFileId && (!blobFile || blobFile.id === file.id)) {
      invalid.push(buildInvalidRemoteJsonConflict({
        entityKind: 'attachment',
        entityId: file.path,
        deviceId,
        error: 'Attachment metadata references a blob that is not present in the verified Drive listing.',
        remoteCopy: result.value,
        detectedAt: file.updatedAt,
      }))
      continue
    }
    valid.push({ ...remoteEnvelope(file.path, result.value), remoteBlobPath: blobFile?.path })
  }
  appendDuplicateEnvelopeConflicts({ envelopes: valid, invalid, deviceId, entityKind: 'attachment' })
  return { valid: newestEnvelopePerId(valid), invalid }
}

async function readRemoteFileBoxItems(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'filebox/' })
  const valid: RemoteEnvelope<FileBoxItem>[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const result = await readValidatedRemoteJson(provider, file, deviceId, 'fileBoxItem', validateFileBoxEnvelope)
    if (result.ok) valid.push(remoteEnvelope(file.path, result.value))
    else invalid.push(result.conflict)
  }
  appendDuplicateEnvelopeConflicts({ envelopes: valid, invalid, deviceId, entityKind: 'fileBoxItem' })
  return { valid: newestEnvelopePerId(valid), invalid }
}

async function readRemoteTransfers(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'transfers/' })
  const valid: RemoteEnvelope<TransferRecord>[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const result = await readValidatedRemoteJson(provider, file, deviceId, 'transfer', validateTransferEnvelope)
    if (result.ok) valid.push(remoteEnvelope(file.path, result.value))
    else invalid.push(result.conflict)
  }
  appendDuplicateEnvelopeConflicts({ envelopes: valid, invalid, deviceId, entityKind: 'transfer' })
  return { valid: newestEnvelopePerId(valid), invalid }
}

async function readRemoteConflicts(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'conflicts/' })
  const valid: { value: SyncConflict; path: string }[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const result = await readValidatedRemoteJson(
      provider,
      file,
      deviceId,
      (value) => {
        const remoteKind = value && typeof value === 'object' && !Array.isArray(value)
          ? (value as { entityKind?: unknown }).entityKind
          : undefined
        return remoteKind === 'attachment' || remoteKind === 'fileBoxItem' || remoteKind === 'transfer'
          || remoteKind === 'device' || remoteKind === 'tombstone'
          ? remoteKind
          : 'entry'
      },
      validateConflict,
    )
    if (result.ok) valid.push({ value: result.value, path: file.path })
    else invalid.push(result.conflict)
  }
  const preferred = new Map<string, { value: SyncConflict; path: string }>()
  for (const candidate of valid) {
    const current = preferred.get(candidate.value.id)
    preferred.set(candidate.value.id, current && selectPreferredConflict(current.value, candidate.value) === current.value
      ? current
      : candidate)
  }
  const selected = [...preferred.values()]
  return {
    valid: selected.map((candidate) => candidate.value),
    paths: Object.fromEntries(selected.map((candidate) => [candidate.value.id, candidate.path])),
    invalid,
  }
}

async function readRemoteTombstones(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'tombstones/' })
  const valid: { value: TombstoneRecord; path: string }[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const result = await readValidatedRemoteJson(provider, file, deviceId, 'tombstone', validateTombstone)
    if (result.ok) valid.push({ value: result.value, path: file.path })
    else invalid.push(result.conflict)
  }
  const normalized = normalizeTombstonesByTarget(valid.map((candidate) => candidate.value))
  const paths = Object.fromEntries(normalized.tombstones.map((tombstone) => {
    const exact = valid.find((candidate) => candidate.value.id === tombstone.id)
      ?? valid.find((candidate) => candidate.value.entityKind === tombstone.entityKind && candidate.value.entityId === tombstone.entityId)
    return [`${tombstone.entityKind}\u0000${tombstone.entityId}`, exact?.path ?? tombstonePath(tombstone)]
  }))
  return { valid: normalized.tombstones, paths, invalid: [...invalid, ...normalized.conflicts] }
}

async function readValidatedRemoteJson<T>(
  provider: SyncProvider,
  file: { path: string; updatedAt: string },
  deviceId: string,
  invalidEntityKind: SyncConflict['entityKind'] | ((value: unknown) => SyncConflict['entityKind']),
  validate: (value: unknown) => ValidationResult<T>,
): Promise<{ ok: true; value: T } | { ok: false; conflict: SyncConflict }> {
  let remoteValue: unknown
  try {
    remoteValue = (await provider.getJson<unknown>(file.path))?.value
    const result = validate(remoteValue)
    if (result.ok) return result
    const entityKind = typeof invalidEntityKind === 'function'
      ? invalidEntityKind(remoteValue)
      : invalidEntityKind
    return {
      ok: false,
      conflict: buildInvalidRemoteJsonConflict({
        entityKind,
        entityId: file.path,
        deviceId,
        error: result.error,
        remoteCopy: remoteValue,
        detectedAt: file.updatedAt,
      }),
    }
  } catch (error) {
    let raw: Awaited<ReturnType<NonNullable<SyncProvider['getJsonText']>>> = null
    if (provider.getJsonText) {
      try {
        raw = await provider.getJsonText(file.path)
      } catch {
        raw = null
      }
    }
    const entityKind = typeof invalidEntityKind === 'function'
      ? invalidEntityKind(undefined)
      : invalidEntityKind
    return {
      ok: false,
      conflict: buildInvalidRemoteJsonConflict({
        entityKind,
        entityId: file.path,
        deviceId,
        error: error instanceof Error ? error.message : 'Remote JSON could not be parsed.',
        remoteCopy: {
          path: file.path,
          rawJson: raw?.text,
        },
        detectedAt: file.updatedAt,
      }),
    }
  }
}
