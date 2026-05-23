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

export const JOURNAL_DB_NAME = 'easylab-journal-core'
export const JOURNAL_DB_VERSION = 3

export const JOURNAL_STORES = {
  entries: 'entries',
  attachments: 'attachments',
  fileBoxItems: 'fileBoxItems',
  transfers: 'transfers',
  tombstones: 'tombstones',
  conflicts: 'conflicts',
  syncQueue: 'syncQueue',
  devices: 'devices',
  meta: 'meta',
  blobs: 'blobs',
} as const

export type JournalStoreName = typeof JOURNAL_STORES[keyof typeof JOURNAL_STORES]

export type JournalMetaRecord = {
  id: string
  updatedAt: string
  lastSyncedAt?: string
  queueCount?: number
  value?: unknown
}

export type BlobStoreRecord = {
  id: string
  blob: Blob
  sha256: string
  size: number
  mimeType: string
  updatedAt: string
}

type StoreRecordMap = {
  [JOURNAL_STORES.entries]: SyncEntityEnvelope<Entry>
  [JOURNAL_STORES.attachments]: SyncEntityEnvelope<Attachment>
  [JOURNAL_STORES.fileBoxItems]: FileBoxItem
  [JOURNAL_STORES.transfers]: TransferRecord
  [JOURNAL_STORES.tombstones]: TombstoneRecord
  [JOURNAL_STORES.conflicts]: SyncConflict
  [JOURNAL_STORES.syncQueue]: SyncQueueItem
  [JOURNAL_STORES.devices]: DeviceProfile
  [JOURNAL_STORES.meta]: JournalMetaRecord
  [JOURNAL_STORES.blobs]: BlobStoreRecord
}

export type TypedJournalRepository<S extends JournalStoreName> = EntityRepository<StoreRecordMap[S]>
export type DailyEntryRepository = TypedJournalRepository<typeof JOURNAL_STORES.entries>
export type AttachmentRepository = TypedJournalRepository<typeof JOURNAL_STORES.attachments>
export type FileBoxRepository = TypedJournalRepository<typeof JOURNAL_STORES.fileBoxItems>
export type TransferRepository = TypedJournalRepository<typeof JOURNAL_STORES.transfers>
export type SyncQueueRepository = TypedJournalRepository<typeof JOURNAL_STORES.syncQueue>
export type DeviceRepository = TypedJournalRepository<typeof JOURNAL_STORES.devices>
export type TombstoneRepository = TypedJournalRepository<typeof JOURNAL_STORES.tombstones>
export type ConflictRepository = TypedJournalRepository<typeof JOURNAL_STORES.conflicts>
export type MetaRepository = TypedJournalRepository<typeof JOURNAL_STORES.meta>
export type BlobRecordRepository = TypedJournalRepository<typeof JOURNAL_STORES.blobs>

export function openJournalDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available.'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(JOURNAL_DB_NAME, JOURNAL_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const storeName of Object.values(JOURNAL_STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' })
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export class EntityRepository<T extends { id: string }> {
  private readonly db: IDBDatabase
  private readonly storeName: JournalStoreName

  constructor(db: IDBDatabase, storeName: JournalStoreName) {
    this.db = db
    this.storeName = storeName
  }

  all(): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly')
      const request = tx.objectStore(this.storeName).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => reject(request.error)
    })
  }

  get(id: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly')
      const request = tx.objectStore(this.storeName).get(id)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })
  }

  put(value: T): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(this.storeName).put(value)
    })
  }

  putMany(values: T[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      const store = tx.objectStore(this.storeName)
      values.forEach((value) => store.put(value))
    })
  }

  replaceAll(values: T[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      const store = tx.objectStore(this.storeName)
      store.clear()
      values.forEach((value) => store.put(value))
    })
  }

  delete(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(this.storeName).delete(id)
    })
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(this.storeName).clear()
    })
  }
}

function repository<S extends JournalStoreName>(db: IDBDatabase, storeName: S): TypedJournalRepository<S> {
  return new EntityRepository<StoreRecordMap[S]>(db, storeName)
}

export async function createJournalRepositories(db?: IDBDatabase) {
  const journalDb = db ?? (await openJournalDb())
  return {
    entries: repository(journalDb, JOURNAL_STORES.entries),
    attachments: repository(journalDb, JOURNAL_STORES.attachments),
    fileBoxItems: repository(journalDb, JOURNAL_STORES.fileBoxItems),
    transfers: repository(journalDb, JOURNAL_STORES.transfers),
    tombstones: repository(journalDb, JOURNAL_STORES.tombstones),
    conflicts: repository(journalDb, JOURNAL_STORES.conflicts),
    syncQueue: repository(journalDb, JOURNAL_STORES.syncQueue),
    devices: repository(journalDb, JOURNAL_STORES.devices),
    meta: repository(journalDb, JOURNAL_STORES.meta),
    blobs: repository(journalDb, JOURNAL_STORES.blobs),
  }
}

export type JournalRepositories = Awaited<ReturnType<typeof createJournalRepositories>>
