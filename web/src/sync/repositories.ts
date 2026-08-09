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
const JOURNAL_LOCAL_REVISION_ID = 'journal-local-revision'

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

export type JournalRepositoryOptions = {
  dbName?: string
  /**
   * Optional stable account identifier used to isolate IndexedDB data without
   * changing any object-store schema. Omitting it preserves the v1 database name.
   */
  accountScope?: string
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

export type JournalStoreReplacements = {
  [S in JournalStoreName]?: StoreRecordMap[S][]
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

export function openJournalDb(dbName = JOURNAL_DB_NAME): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available.'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, JOURNAL_DB_VERSION)
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

export function journalDbNameForScope(dbName = JOURNAL_DB_NAME, accountScope?: string) {
  if (typeof accountScope === 'undefined') return dbName
  const normalizedScope = accountScope.trim()
  if (!normalizedScope) throw new Error('Journal account scope must not be empty.')
  return `${dbName}--account-${encodeURIComponent(normalizedScope)}`
}

function isIDBDatabase(value: unknown): value is IDBDatabase {
  return typeof value === 'object' && value !== null && 'transaction' in value && 'objectStoreNames' in value
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

function journalRevision(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function readJournalRevision(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(JOURNAL_STORES.meta, 'readonly')
      .objectStore(JOURNAL_STORES.meta)
      .get(JOURNAL_LOCAL_REVISION_ID)
    request.onsuccess = () => resolve(journalRevision((request.result as JournalMetaRecord | undefined)?.value))
    request.onerror = () => reject(request.error)
  })
}

function replaceJournalStores(
  db: IDBDatabase,
  replacements: JournalStoreReplacements,
  expectedRevision?: number,
): Promise<{ applied: boolean; revision: number }> {
  const storeNames = Object.keys(replacements) as JournalStoreName[]
  if (storeNames.length === 0) {
    return readJournalRevision(db).then((revision) => ({ applied: true, revision }))
  }
  const transactionStores = [...new Set([...storeNames, JOURNAL_STORES.meta])]

  return new Promise((resolve, reject) => {
    const tx = db.transaction(transactionStores, 'readwrite')
    let applied = false
    let nextRevision = 0
    tx.oncomplete = () => resolve({ applied, revision: nextRevision })
    tx.onabort = () => reject(tx.error ?? new Error('Atomic journal store replacement was aborted.'))
    tx.onerror = () => reject(tx.error)
    const revisionRequest = tx.objectStore(JOURNAL_STORES.meta).get(JOURNAL_LOCAL_REVISION_ID)
    revisionRequest.onerror = () => reject(revisionRequest.error)
    revisionRequest.onsuccess = () => {
      try {
        const currentRevision = journalRevision((revisionRequest.result as JournalMetaRecord | undefined)?.value)
        nextRevision = currentRevision
        if (typeof expectedRevision === 'number' && currentRevision !== expectedRevision) return
        nextRevision = currentRevision + 1
        for (const storeName of storeNames) {
          const store = tx.objectStore(storeName)
          store.clear()
          const values = replacements[storeName] as Array<{ id: string }> | undefined
          values?.forEach((value) => store.put(value))
        }
        tx.objectStore(JOURNAL_STORES.meta).put({
          id: JOURNAL_LOCAL_REVISION_ID,
          updatedAt: new Date().toISOString(),
          value: nextRevision,
        } satisfies JournalMetaRecord)
        applied = true
      } catch (error) {
        tx.abort()
        reject(error)
      }
    }
  })
}

export async function createJournalRepositories(dbOrOptions?: IDBDatabase | JournalRepositoryOptions) {
  const journalDb = isIDBDatabase(dbOrOptions)
    ? dbOrOptions
    : await openJournalDb(journalDbNameForScope(dbOrOptions?.dbName, dbOrOptions?.accountScope))
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
    replaceStores: async (replacements: JournalStoreReplacements) => {
      await replaceJournalStores(journalDb, replacements)
    },
    replaceStoresIfRevision: (replacements: JournalStoreReplacements, expectedRevision: number) =>
      replaceJournalStores(journalDb, replacements, expectedRevision),
    getRevision: () => readJournalRevision(journalDb),
  }
}

export type JournalRepositories = Awaited<ReturnType<typeof createJournalRepositories>>
