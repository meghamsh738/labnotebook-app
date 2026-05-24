import type {
  Attachment,
  DeviceProfile,
  Entry,
  FileBoxItem,
  SyncConflict,
  SyncEntityEnvelope,
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
  type JournalSnapshot,
} from './dataCore'
import { hashJsonSha256 } from './hashing'
import {
  buildInvalidRemoteJsonConflict,
  validateAttachmentEnvelope,
  validateEntryEnvelope,
  validateFileBoxEnvelope,
  validateTombstone,
  validateTransferEnvelope,
} from './schemas'
import type { BlobStore } from './blobStore'
import { createJournalRepositories, type JournalRepositories } from './repositories'
import type { SyncProvider } from './syncProvider'

export type SyncEngineMeta = {
  entryHashes: Record<string, string>
  attachmentHashes: Record<string, string>
  fileBoxHashes: Record<string, string>
  transferHashes: Record<string, string>
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
}

const SYNC_ENGINE_META_ID = 'sync-engine'

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

  constructor(snapshot: JournalSnapshot, meta: SyncEngineMeta = defaultMeta()) {
    this.snapshot = clone(snapshot)
    this.meta = clone(meta)
  }

  async getSnapshot() {
    return clone(this.snapshot)
  }

  async saveSnapshot(snapshot: JournalSnapshot) {
    this.snapshot = clone(snapshot)
  }

  async getMeta() {
    return clone(this.meta)
  }

  async saveMeta(meta: SyncEngineMeta) {
    this.meta = clone(meta)
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
    await Promise.all([
      this.repositories.entries.replaceAll(Object.values(snapshot.entries).map((entry) => buildEntryEnvelope(entry, device))),
      this.repositories.attachments.replaceAll(snapshot.attachments.map((attachment) => buildAttachmentEnvelope(attachment, device))),
      this.repositories.fileBoxItems.replaceAll(snapshot.fileBoxItems),
      this.repositories.transfers.replaceAll(snapshot.transfers),
      this.repositories.conflicts.replaceAll(snapshot.conflicts),
      this.repositories.tombstones.replaceAll(snapshot.tombstones),
      this.repositories.devices.replaceAll([device]),
    ])
  }

  async getMeta() {
    const record = await this.repositories.meta.get(SYNC_ENGINE_META_ID)
    return isSyncEngineMeta(record?.value) ? record.value : defaultMeta()
  }

  async saveMeta(meta: SyncEngineMeta) {
    await this.repositories.meta.put({
      id: SYNC_ENGINE_META_ID,
      updatedAt: nowIso(),
      lastSyncedAt: meta.lastSyncedAt,
      value: meta,
    })
  }
}

export async function createIndexedDbJournalStore(device: DeviceProfile, repositories?: JournalRepositories) {
  return new IndexedDbJournalStore(repositories ?? await createJournalRepositories(), device)
}

export async function entryContentHash(entry: Entry) {
  return hashJsonSha256({
    id: entry.id,
    title: entry.title,
    dateBucket: entry.dateBucket,
    content: entry.content,
    tags: entry.tags,
    projectTags: entry.projectTags,
    experimentTags: entry.experimentTags,
    linkedFiles: entry.linkedFiles,
    pinnedRegions: entry.pinnedRegions,
  })
}

export async function attachmentMetadataHash(attachment: Attachment) {
  return hashJsonSha256({
    id: attachment.id,
    entryId: attachment.entryId,
    filename: attachment.filename,
    bytes: attachment.bytes,
    contentType: attachment.contentType || attachment.mimeType,
    sha256: attachment.sha256,
    driveFileId: attachment.driveFileId,
  })
}

async function fileBoxMetadataHash(item: FileBoxItem) {
  return hashJsonSha256({
    id: item.id,
    entryId: item.entryId,
    attachmentId: item.attachmentId,
    filename: item.filename,
    filesize: item.filesize,
    contentType: item.contentType,
    sourceDeviceId: item.sourceDeviceId,
    sourceDeviceName: item.sourceDeviceName,
    status: item.status,
    driveFileId: item.driveFileId,
    lastError: item.lastError,
    updatedAt: item.updatedAt,
  })
}

async function transferMetadataHash(transfer: TransferRecord) {
  return hashJsonSha256({
    id: transfer.id,
    fileBoxItemId: transfer.fileBoxItemId,
    entryId: transfer.entryId,
    attachmentId: transfer.attachmentId,
    filename: transfer.filename,
    fromDeviceId: transfer.fromDeviceId,
    fromDeviceName: transfer.fromDeviceName,
    toDeviceId: transfer.toDeviceId,
    toDeviceName: transfer.toDeviceName,
    provider: transfer.provider,
    status: transfer.status,
    bytesTotal: transfer.bytesTotal,
    bytesTransferred: transfer.bytesTransferred,
    completedAt: transfer.completedAt,
    driveFileId: transfer.driveFileId,
    lastError: transfer.lastError,
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
    localCopy: { hash: params.localHash, deviceId: params.deviceId, entry: params.local },
    remoteCopy: { hash: params.remoteHash, entry: params.remote },
  }
}

function upsertConflict(conflicts: SyncConflict[], conflict: SyncConflict) {
  const next = conflicts.filter((existing) => existing.id !== conflict.id)
  next.push(conflict)
  return next
}

function tombstonePath(tombstone: TombstoneRecord) {
  return `tombstones/${tombstone.entityKind}--${tombstone.entityId}.json`
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

function buildFileBoxEnvelope(item: FileBoxItem, device: DeviceProfile): SyncEntityEnvelope<FileBoxItem> {
  return {
    id: item.id,
    kind: 'fileBoxItem',
    version: 1,
    updatedAt: item.updatedAt || nowIso(),
    updatedByDeviceId: device.id,
    payload: item,
  }
}

function buildTransferEnvelope(transfer: TransferRecord, device: DeviceProfile): SyncEntityEnvelope<TransferRecord> {
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
  return `filebox/${item.id}.json`
}

function transferPath(transfer: TransferRecord) {
  return `transfers/${transfer.id}.json`
}

export async function syncOnce(params: {
  provider: SyncProvider
  store: LocalJournalStore
  device: DeviceProfile
  blobStore?: BlobStore
  downloadRemoteBlobs?: boolean
}): Promise<SyncEngineResult> {
  const { provider, store, device, blobStore, downloadRemoteBlobs = true } = params
  await provider.signIn()
  await provider.ensureWorkspace()
  await provider.ensureDeviceRecord(device)

  let snapshot = await store.getSnapshot()
  const meta = { ...defaultMeta(), ...(await store.getMeta()) }
  meta.fileBoxHashes = meta.fileBoxHashes ?? {}
  meta.transferHashes = meta.transferHashes ?? {}
  let pulledEntries = 0
  let pulledAttachments = 0
  let pushedEntries = 0
  let pushedAttachments = 0
  let uploadedBlobs = 0
  let downloadedBlobs = 0
  let pushedTombstones = 0
  let conflicts = snapshot.conflicts.length

  const remoteTombstones = await readRemoteTombstones(provider, device.id)
  for (const tombstone of remoteTombstones.valid) {
    if (tombstone.entityKind === 'entry') {
      const localEntry = snapshot.entries[tombstone.entityId]
      const baseHash = meta.entryHashes[tombstone.entityId]
      if (localEntry) {
        const localHash = await entryContentHash(localEntry)
        if (!baseHash || localHash !== baseHash) {
          snapshot.conflicts = upsertConflict(snapshot.conflicts, makeEntryConflict({
            entityId: tombstone.entityId,
            local: localEntry,
            remote: { ...localEntry, title: `[Deleted remotely] ${localEntry.title}` },
            localHash,
            remoteHash: tombstone.deletedAt,
            deviceId: device.id,
            summary: 'Remote delete conflicts with local edits; local entry is kept visible until resolved.',
          }))
          continue
        }
      }
    }
    if (!snapshot.tombstones.some((existing) => existing.id === tombstone.id)) {
      snapshot.tombstones.push(tombstone)
    }
  }
  snapshot.conflicts = [...snapshot.conflicts, ...remoteTombstones.invalid]
  snapshot = applyTombstonesToSnapshot(snapshot, snapshot.tombstones)

  const tombstonedEntries = new Set(snapshot.tombstones.filter((tombstone) => tombstone.entityKind === 'entry').map((tombstone) => tombstone.entityId))
  const tombstonedAttachments = new Set(snapshot.tombstones.filter((tombstone) => tombstone.entityKind === 'attachment').map((tombstone) => tombstone.entityId))

  const remoteEntries = await readRemoteEntries(provider, device.id)
  snapshot.conflicts = [...snapshot.conflicts, ...remoteEntries.invalid]
  for (const remoteEnvelope of remoteEntries.valid) {
    const remoteEntry = remoteEnvelope.payload
    if (tombstonedEntries.has(remoteEntry.id)) continue
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

    if (localHash === baseHash || !baseHash) {
      snapshot.entries[remoteEntry.id] = remoteEntry
      meta.entryHashes[remoteEntry.id] = remoteHash
      pulledEntries += 1
      continue
    }

    if (remoteHash === baseHash) {
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

  const remoteAttachments = await readRemoteAttachments(provider, device.id)
  snapshot.conflicts = [...snapshot.conflicts, ...remoteAttachments.invalid]
  for (const remoteEnvelope of remoteAttachments.valid) {
    const remoteAttachment = remoteEnvelope.payload
    if (tombstonedAttachments.has(remoteAttachment.id) || tombstonedEntries.has(remoteAttachment.entryId)) continue
    const localIndex = snapshot.attachments.findIndex((attachment) => attachment.id === remoteAttachment.id)
    const remoteHash = await attachmentMetadataHash(remoteAttachment)
    const baseHash = meta.attachmentHashes[remoteAttachment.id]
    const localHash = localIndex >= 0 ? await attachmentMetadataHash(snapshot.attachments[localIndex]) : undefined

    if (localIndex < 0) {
      const restoredAttachment = await restoreRemoteAttachmentBlob(remoteAttachment, snapshot.entries, provider, blobStore, downloadRemoteBlobs)
      if (restoredAttachment.downloaded) downloadedBlobs += 1
      snapshot.attachments.push(restoredAttachment.attachment)
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      pulledAttachments += 1
      continue
    }

    if (localHash === remoteHash) {
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      continue
    }

    if (localHash === baseHash || !baseHash) {
      const restoredAttachment = await restoreRemoteAttachmentBlob(remoteAttachment, snapshot.entries, provider, blobStore, downloadRemoteBlobs)
      if (restoredAttachment.downloaded) downloadedBlobs += 1
      snapshot.attachments[localIndex] = restoredAttachment.attachment
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      pulledAttachments += 1
    }
  }

  const remoteFileBoxItems = await readRemoteFileBoxItems(provider, device.id)
  snapshot.conflicts = [...snapshot.conflicts, ...remoteFileBoxItems.invalid]
  for (const remoteEnvelope of remoteFileBoxItems.valid) {
    const remoteItem = remoteEnvelope.payload
    if (tombstonedEntries.has(remoteItem.entryId) || tombstonedAttachments.has(remoteItem.attachmentId || '')) continue
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

    const localTime = Date.parse(snapshot.fileBoxItems[localIndex].updatedAt) || 0
    const remoteTime = Date.parse(remoteItem.updatedAt) || 0
    if (localHash === baseHash || remoteTime >= localTime) {
      snapshot.fileBoxItems[localIndex] = remoteItem
      meta.fileBoxHashes[remoteItem.id] = remoteHash
    }
  }

  const remoteTransfers = await readRemoteTransfers(provider, device.id)
  snapshot.conflicts = [...snapshot.conflicts, ...remoteTransfers.invalid]
  for (const remoteEnvelope of remoteTransfers.valid) {
    const remoteTransfer = remoteEnvelope.payload
    if (tombstonedEntries.has(remoteTransfer.entryId || '') || tombstonedAttachments.has(remoteTransfer.attachmentId || '')) continue
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

    const localTime = Date.parse(snapshot.transfers[localIndex].updatedAt) || 0
    const remoteTime = Date.parse(remoteTransfer.updatedAt) || 0
    if (localHash === baseHash || remoteTime >= localTime) {
      snapshot.transfers[localIndex] = remoteTransfer
      meta.transferHashes[remoteTransfer.id] = remoteHash
    }
  }

  for (const tombstone of snapshot.tombstones) {
    await provider.putJson(tombstonePath(tombstone), tombstone, {
      appProperties: { entityType: 'tombstone', entityId: tombstone.entityId },
    })
    pushedTombstones += 1
  }

  for (const attachment of snapshot.attachments) {
    const uploadedBlob = await uploadAttachmentBlob(attachment, snapshot.entries, provider, blobStore)
    if (uploadedBlob.uploaded) uploadedBlobs += 1
    const nextAttachment = uploadedBlob.attachment
    const hash = await attachmentMetadataHash(nextAttachment)
    if (hash !== meta.attachmentHashes[attachment.id]) {
      await provider.putJson(attachmentMetadataPath(nextAttachment, snapshot.entries), buildAttachmentEnvelope({
        ...nextAttachment,
        syncStatus: 'synced',
      }, device), {
        appProperties: { entityType: 'attachment', entityId: nextAttachment.id, contentHash: hash },
      })
      const attachmentIndex = snapshot.attachments.findIndex((candidate) => candidate.id === nextAttachment.id)
      if (attachmentIndex >= 0) snapshot.attachments[attachmentIndex] = { ...nextAttachment, syncStatus: 'synced' }
      meta.attachmentHashes[nextAttachment.id] = hash
      pushedAttachments += 1
    }
  }

  const openConflictEntries = new Set(snapshot.conflicts.filter((conflict) => conflict.resolution === 'pending' && conflict.entityKind === 'entry').map((conflict) => conflict.entityId))
  for (const entry of Object.values(snapshot.entries)) {
    if (openConflictEntries.has(entry.id)) continue
    const hash = await entryContentHash(entry)
    if (hash !== meta.entryHashes[entry.id]) {
      const envelope = buildEntryEnvelope({ ...entry, syncStatus: 'synced', updatedByDeviceId: device.id }, device)
      await provider.putJson(entryPath(entry, snapshot.entries), envelope, {
        appProperties: { entityType: 'entry', entityId: entry.id, contentHash: hash },
      })
      meta.entryHashes[entry.id] = hash
      pushedEntries += 1
    }
  }

  for (const conflict of snapshot.conflicts) {
    await provider.putJson(`conflicts/${conflict.id}.json`, conflict, {
      appProperties: { entityType: 'conflict', entityId: conflict.entityId },
    })
  }

  for (const item of snapshot.fileBoxItems) {
    if (tombstonedEntries.has(item.entryId) || tombstonedAttachments.has(item.attachmentId || '')) continue
    const hash = await fileBoxMetadataHash(item)
    if (hash !== meta.fileBoxHashes[item.id]) {
      await provider.putJson(fileBoxPath(item), buildFileBoxEnvelope(item, device), {
        appProperties: { entityType: 'fileBoxItem', entityId: item.id, contentHash: hash },
      })
      meta.fileBoxHashes[item.id] = hash
    }
  }

  for (const transfer of snapshot.transfers) {
    if (tombstonedEntries.has(transfer.entryId || '') || tombstonedAttachments.has(transfer.attachmentId || '')) continue
    const hash = await transferMetadataHash(transfer)
    if (hash !== meta.transferHashes[transfer.id]) {
      await provider.putJson(transferPath(transfer), buildTransferEnvelope(transfer, device), {
        appProperties: { entityType: 'transfer', entityId: transfer.id, contentHash: hash },
      })
      meta.transferHashes[transfer.id] = hash
    }
  }

  await provider.putManifest(createManifest({
    device,
    entries: snapshot.entries,
    attachments: snapshot.attachments,
    fileBoxItems: snapshot.fileBoxItems,
    transfers: snapshot.transfers,
  }))

  meta.lastSyncedAt = nowIso()
  if (provider.listChanges) {
    meta.driveChangesToken = (await provider.listChanges(meta.driveChangesToken ?? '0')).nextToken
  }
  conflicts = snapshot.conflicts.length
  await store.saveSnapshot(snapshot)
  await store.saveMeta(meta)

  return { pulledEntries, pushedEntries, pulledAttachments, pushedAttachments, uploadedBlobs, downloadedBlobs, pushedTombstones, conflicts }
}

async function uploadAttachmentBlob(
  attachment: Attachment,
  entries: Record<string, Entry>,
  provider: SyncProvider,
  blobStore?: BlobStore
): Promise<{ attachment: Attachment; uploaded: boolean }> {
  if (!blobStore) return { attachment, uploaded: false }
  const key = attachmentBlobKey(attachment)
  const record = await blobStore.getRecord(key)
  if (!record) return { attachment, uploaded: false }
  if (attachment.driveFileId && attachment.syncStatus === 'synced' && attachment.sha256 === record.sha256) {
    return { attachment: { ...attachment, cacheKey: key }, uploaded: false }
  }
  const expectedSha256 = attachment.sha256 || record.sha256
  const verified = await blobStore.verify(key, expectedSha256)
  if (!verified.ok) return { attachment: { ...attachment, syncStatus: 'failed' }, uploaded: false }
  const remote = await provider.putBlob(attachmentBlobPath(attachment, entries), record.blob, {
    mimeType: attachment.contentType || attachment.mimeType || record.mimeType,
    sha256: record.sha256,
    byteSize: record.size,
    appProperties: { entityType: 'attachmentBlob', entityId: attachment.id, sha256: record.sha256 },
  })
  return {
    attachment: {
      ...attachment,
      cacheKey: key,
      sha256: record.sha256,
      bytes: attachment.bytes ?? record.size,
      contentType: attachment.contentType || record.mimeType,
      driveFileId: remote.id,
      syncStatus: 'synced',
      updatedAt: nowIso(),
    },
    uploaded: true,
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
  if (await blobStore.has(key)) return { attachment: { ...attachment, cacheKey: key }, downloaded: false }
  const remoteBlob = await provider.getBlob(attachmentBlobPath(attachment, entries))
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

async function readRemoteEntries(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'entries/' })
  const valid: SyncEntityEnvelope<Entry>[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const remote = await provider.getJson<unknown>(file.path)
    const result = validateEntryEnvelope(remote?.value)
    if (result.ok) valid.push(result.value)
    else invalid.push(buildInvalidRemoteJsonConflict({
      entityKind: 'entry',
      entityId: file.path,
      deviceId,
      error: result.error,
      remoteCopy: remote?.value,
    }))
  }
  return { valid, invalid }
}

async function readRemoteAttachments(provider: SyncProvider, deviceId: string) {
  const files = (await provider.listManagedFiles({ prefix: 'attachments/' })).filter((file) => file.path.endsWith('.json'))
  const valid: SyncEntityEnvelope<Attachment>[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const remote = await provider.getJson<unknown>(file.path)
    const result = validateAttachmentEnvelope(remote?.value)
    if (result.ok) valid.push(result.value)
    else invalid.push(buildInvalidRemoteJsonConflict({
      entityKind: 'attachment',
      entityId: file.path,
      deviceId,
      error: result.error,
      remoteCopy: remote?.value,
    }))
  }
  return { valid, invalid }
}

async function readRemoteFileBoxItems(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'filebox/' })
  const valid: SyncEntityEnvelope<FileBoxItem>[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const remote = await provider.getJson<unknown>(file.path)
    const result = validateFileBoxEnvelope(remote?.value)
    if (result.ok) valid.push(result.value)
    else invalid.push(buildInvalidRemoteJsonConflict({
      entityKind: 'fileBoxItem',
      entityId: file.path,
      deviceId,
      error: result.error,
      remoteCopy: remote?.value,
    }))
  }
  return { valid, invalid }
}

async function readRemoteTransfers(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'transfers/' })
  const valid: SyncEntityEnvelope<TransferRecord>[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const remote = await provider.getJson<unknown>(file.path)
    const result = validateTransferEnvelope(remote?.value)
    if (result.ok) valid.push(result.value)
    else invalid.push(buildInvalidRemoteJsonConflict({
      entityKind: 'transfer',
      entityId: file.path,
      deviceId,
      error: result.error,
      remoteCopy: remote?.value,
    }))
  }
  return { valid, invalid }
}

async function readRemoteTombstones(provider: SyncProvider, deviceId: string) {
  const files = await provider.listManagedFiles({ prefix: 'tombstones/' })
  const valid: TombstoneRecord[] = []
  const invalid: SyncConflict[] = []
  for (const file of files) {
    const remote = await provider.getJson<unknown>(file.path)
    const result = validateTombstone(remote?.value)
    if (result.ok) valid.push(result.value)
    else invalid.push(buildInvalidRemoteJsonConflict({
      entityKind: 'tombstone',
      entityId: file.path,
      deviceId,
      error: result.error,
      remoteCopy: remote?.value,
    }))
  }
  return { valid, invalid }
}
