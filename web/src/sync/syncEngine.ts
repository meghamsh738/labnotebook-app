import type {
  Attachment,
  DeviceProfile,
  Entry,
  SyncConflict,
  SyncEntityEnvelope,
  TombstoneRecord,
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
  validateTombstone,
} from './schemas'
import type { SyncProvider } from './syncProvider'

export type SyncEngineMeta = {
  entryHashes: Record<string, string>
  attachmentHashes: Record<string, string>
  lastSyncedAt?: string
  driveChangesToken?: string
}

export type SyncEngineResult = {
  pulledEntries: number
  pushedEntries: number
  pushedAttachments: number
  pushedTombstones: number
  conflicts: number
}

export type LocalJournalStore = {
  getSnapshot(): Promise<JournalSnapshot>
  saveSnapshot(snapshot: JournalSnapshot): Promise<void>
  getMeta(): Promise<SyncEngineMeta>
  saveMeta(meta: SyncEngineMeta): Promise<void>
}

function nowIso() {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T
}

function defaultMeta(): SyncEngineMeta {
  return { entryHashes: {}, attachmentHashes: {} }
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

export async function syncOnce(params: {
  provider: SyncProvider
  store: LocalJournalStore
  device: DeviceProfile
}): Promise<SyncEngineResult> {
  const { provider, store, device } = params
  await provider.signIn()
  await provider.ensureWorkspace()
  await provider.ensureDeviceRecord(device)

  let snapshot = await store.getSnapshot()
  const meta = { ...defaultMeta(), ...(await store.getMeta()) }
  let pulledEntries = 0
  let pushedEntries = 0
  let pushedAttachments = 0
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
      snapshot.attachments.push(remoteAttachment)
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      continue
    }

    if (localHash === remoteHash) {
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
      continue
    }

    if (localHash === baseHash || !baseHash) {
      snapshot.attachments[localIndex] = remoteAttachment
      meta.attachmentHashes[remoteAttachment.id] = remoteHash
    }
  }

  for (const tombstone of snapshot.tombstones) {
    await provider.putJson(tombstonePath(tombstone), tombstone, {
      appProperties: { entityType: 'tombstone', entityId: tombstone.entityId },
    })
    pushedTombstones += 1
  }

  for (const attachment of snapshot.attachments) {
    const hash = await attachmentMetadataHash(attachment)
    if (hash !== meta.attachmentHashes[attachment.id]) {
      await provider.putJson(attachmentMetadataPath(attachment, snapshot.entries), buildAttachmentEnvelope({
        ...attachment,
        syncStatus: 'synced',
      }, device), {
        appProperties: { entityType: 'attachment', entityId: attachment.id, contentHash: hash },
      })
      meta.attachmentHashes[attachment.id] = hash
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

  return { pulledEntries, pushedEntries, pushedAttachments, pushedTombstones, conflicts }
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
