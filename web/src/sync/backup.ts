import type { DeviceProfile } from '../domain/types'
import type { BlobStore } from './blobStore'
import type { JournalSnapshot } from './dataCore'
import type { LocalJournalStore } from './syncEngine'
import { hashBlobSha256 } from './hashing'

export type JournalBackupBlob = {
  id: string
  sha256: string
  size?: number
  mimeType: string
  updatedAt: string
  dataBase64: string
}

export type JournalBackupDocument = {
  version: 1
  app: 'easylab-lab-notebook'
  exportedAt: string
  snapshot: JournalSnapshot
  blobs: JournalBackupBlob[]
}

export type JournalBackupRestoreResult = {
  entries: number
  attachments: number
  blobs: number
  conflicts: number
  tombstones: number
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function blobToBase64(blob: Blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

function blobFromBase64(base64: string, mimeType: string) {
  return new Blob([base64ToBytes(base64)], { type: mimeType || 'application/octet-stream' })
}

function randomRestoreId() {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `restored-${uuid}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSnapshot(value: unknown): JournalSnapshot {
  if (!isRecord(value)) throw new Error('Backup file is missing snapshot data.')
  if (!isRecord(value.entries)) throw new Error('Backup file contains malformed note data.')
  const readArray = <T>(key: string): T[] => {
    const field = value[key]
    if (typeof field === 'undefined') return []
    if (!Array.isArray(field)) throw new Error(`Backup file contains malformed ${key} data.`)
    return field as T[]
  }
  return {
    entries: value.entries as JournalSnapshot['entries'],
    attachments: readArray<JournalSnapshot['attachments'][number]>('attachments'),
    fileBoxItems: readArray<JournalSnapshot['fileBoxItems'][number]>('fileBoxItems'),
    transfers: readArray<JournalSnapshot['transfers'][number]>('transfers'),
    conflicts: readArray<JournalSnapshot['conflicts'][number]>('conflicts'),
    tombstones: readArray<JournalSnapshot['tombstones'][number]>('tombstones'),
    ...(isRecord(value.device) ? { device: value.device as unknown as JournalSnapshot['device'] } : {}),
  }
}

async function decodeAndValidateBlobs(blobs: JournalBackupBlob[]) {
  const decoded = new Map<string, Blob>()
  for (const record of blobs) {
    if (decoded.has(record.id)) throw new Error(`Backup file contains duplicate blob ID “${record.id}”.`)
    if (typeof record.size !== 'undefined' && (!Number.isSafeInteger(record.size) || record.size < 0)) {
      throw new Error(`Backup file contains an invalid size for “${record.id}”.`)
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.dataBase64)) {
      throw new Error(`Backup file contains invalid encoded data for “${record.id}”.`)
    }
    let blob: Blob
    try {
      blob = blobFromBase64(record.dataBase64, record.mimeType)
    } catch {
      throw new Error(`Backup file contains invalid encoded data for “${record.id}”.`)
    }
    if (typeof record.size === 'number' && blob.size !== record.size) {
      throw new Error(`Backup file size check failed for “${record.id}”.`)
    }
    if (record.sha256) {
      const actualSha256 = await hashBlobSha256(blob)
      if (actualSha256.toLowerCase() !== record.sha256.toLowerCase()) {
        throw new Error(`Backup file checksum check failed for “${record.id}”.`)
      }
    }
    decoded.set(record.id, blob)
  }
  return decoded
}

function attachmentBlobReference(attachment: JournalSnapshot['attachments'][number]) {
  if (attachment.cacheKey) return attachment.cacheKey
  if (attachment.cachedPath?.startsWith('idb://')) return attachment.cachedPath.slice('idb://'.length)
  return undefined
}

function localAttachmentPath(filename: string) {
  return `local://${encodeURIComponent(filename || 'attachment')}`
}

export async function createJournalBackup(snapshot: JournalSnapshot, blobStore?: BlobStore): Promise<JournalBackupDocument> {
  const blobs: JournalBackupBlob[] = []
  if (blobStore) {
    for (const record of await blobStore.list()) {
      blobs.push({
        id: record.id,
        sha256: record.sha256,
        size: record.size,
        mimeType: record.mimeType,
        updatedAt: record.updatedAt,
        dataBase64: await blobToBase64(record.blob),
      })
    }
  }

  return {
    version: 1,
    app: 'easylab-lab-notebook',
    exportedAt: new Date().toISOString(),
    snapshot: cloneJson(snapshot),
    blobs,
  }
}

export function parseJournalBackup(value: unknown): JournalBackupDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Backup file is not a JSON object.')
  }
  const record = value as Partial<JournalBackupDocument>
  if (record.version !== 1 || record.app !== 'easylab-lab-notebook') {
    throw new Error('Backup file is not an Easylab Lab Notebook backup.')
  }
  if (typeof record.exportedAt !== 'string') throw new Error('Backup file is missing exportedAt.')
  if (typeof record.snapshot !== 'object' || record.snapshot === null) throw new Error('Backup file is missing snapshot data.')
  if (!Array.isArray(record.blobs)) throw new Error('Backup file is missing blob data.')
  for (const blob of record.blobs) {
    if (
      typeof blob !== 'object' ||
      blob === null ||
      typeof blob.id !== 'string' ||
      typeof blob.sha256 !== 'string' ||
      (typeof blob.size !== 'undefined' && typeof blob.size !== 'number') ||
      typeof blob.mimeType !== 'string' ||
      typeof blob.dataBase64 !== 'string'
    ) {
      throw new Error('Backup file contains malformed blob data.')
    }
  }
  return record as JournalBackupDocument
}

export async function restoreJournalBackup(params: {
  backup: JournalBackupDocument
  store: LocalJournalStore
  blobStore?: BlobStore
  device?: DeviceProfile
  localWorkspace?: boolean
}): Promise<JournalBackupRestoreResult> {
  // Decode and verify the entire portable file before touching either the
  // local blob cache or the current journal. Older v1 backups may omit newer
  // optional snapshot arrays, so normalize those to empty arrays here.
  const decodedBlobs = await decodeAndValidateBlobs(params.backup.blobs)
  const snapshot = normalizeSnapshot(cloneJson(params.backup.snapshot))
  if (params.device) {
    snapshot.device = {
      ...params.device,
      lastSeenAt: new Date().toISOString(),
    }
  }

  const stagedBlobIds: string[] = []
  let restoreBlobIds = new Map(params.backup.blobs.map((record) => [record.id, record.id]))
  if (params.localWorkspace) {
    if (decodedBlobs.size > 0 && !params.blobStore) {
      throw new Error('A local attachment cache is required to restore the files in this backup.')
    }

    const occupiedIds = new Set<string>()
    if (params.blobStore) {
      for (const record of await params.blobStore.list()) occupiedIds.add(record.id)
    }
    restoreBlobIds = new Map()
    for (const record of params.backup.blobs) {
      let id = randomRestoreId()
      while (occupiedIds.has(id)) id = randomRestoreId()
      occupiedIds.add(id)
      restoreBlobIds.set(record.id, id)
    }

    snapshot.attachments = snapshot.attachments.map((attachment) => {
      const sourceId = attachmentBlobReference(attachment)
      const restoredId = sourceId ? restoreBlobIds.get(sourceId) : undefined
      return {
        ...attachment,
        cacheKey: restoredId,
        cachedPath: undefined,
        thumbnail: undefined,
        driveFileId: undefined,
        storagePath: localAttachmentPath(attachment.filename),
        offlineUnavailable: !restoredId,
        pinnedOffline: true,
        syncStatus: 'local',
      }
    })
  }

  if (params.blobStore) {
    try {
      for (const [sourceId, blob] of decodedBlobs) {
        const targetId = restoreBlobIds.get(sourceId) ?? sourceId
        if (params.localWorkspace) stagedBlobIds.push(targetId)
        await params.blobStore.put(targetId, blob)
      }
      await params.store.saveSnapshot(snapshot)
    } catch (error) {
      if (params.localWorkspace) {
        await Promise.all(stagedBlobIds.map((id) => params.blobStore?.delete(id).catch(() => undefined)))
      }
      throw error
    }
  } else {
    await params.store.saveSnapshot(snapshot)
  }

  return {
    entries: Object.keys(snapshot.entries).length,
    attachments: snapshot.attachments.length,
    blobs: decodedBlobs.size,
    conflicts: snapshot.conflicts.length,
    tombstones: snapshot.tombstones.length,
  }
}
