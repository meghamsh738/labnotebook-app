import type { DeviceProfile } from '../domain/types'
import type { BlobStore } from './blobStore'
import type { JournalSnapshot } from './dataCore'
import type { LocalJournalStore } from './syncEngine'

export type JournalBackupBlob = {
  id: string
  sha256: string
  size: number
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
}): Promise<JournalBackupRestoreResult> {
  const snapshot = cloneJson(params.backup.snapshot)
  if (params.device) {
    snapshot.device = {
      ...params.device,
      lastSeenAt: new Date().toISOString(),
    }
  }

  if (params.blobStore) {
    for (const record of params.backup.blobs) {
      await params.blobStore.put(record.id, blobFromBase64(record.dataBase64, record.mimeType))
    }
  }

  await params.store.saveSnapshot(snapshot)

  return {
    entries: Object.keys(snapshot.entries || {}).length,
    attachments: snapshot.attachments?.length ?? 0,
    blobs: params.backup.blobs.length,
    conflicts: snapshot.conflicts?.length ?? 0,
    tombstones: snapshot.tombstones?.length ?? 0,
  }
}
