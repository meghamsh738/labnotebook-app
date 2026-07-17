const DB_NAME = 'labnote-cache'
const STORE = 'files'
const LEGACY_CACHE_OWNER_KEY = 'labnote.legacyBlobCacheOwner'

type IDBDB = IDBDatabase

function scopedDbName(accountScope?: string) {
  if (!accountScope?.trim()) return DB_NAME
  const normalized = accountScope.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  if (!normalized) throw new Error('Attachment cache account scope must not be empty.')
  return `${DB_NAME}--${normalized}`
}

function canUseLegacyCache(accountScope?: string) {
  if (!accountScope?.trim() || typeof window === 'undefined') return !accountScope
  const normalized = accountScope.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  if (!normalized) return false
  const owner = window.localStorage.getItem(LEGACY_CACHE_OWNER_KEY)
  if (owner) return owner === normalized
  window.localStorage.setItem(LEGACY_CACHE_OWNER_KEY, normalized)
  return true
}

function ensureFilesStore(db: IDBDatabase, dbName: string): Promise<IDBDatabase> {
  if (db.objectStoreNames.contains(STORE)) return Promise.resolve(db)
  const nextVersion = db.version + 1
  db.close()
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, nextVersion)
    req.onupgradeneeded = () => {
      const upgraded = req.result
      if (!upgraded.objectStoreNames.contains(STORE)) {
        upgraded.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openDB(accountScope?: string): Promise<IDBDB> {
  const dbName = scopedDbName(accountScope)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => {
      ensureFilesStore(req.result, dbName).then(resolve, reject)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function cacheFile(file: File, accountScope?: string): Promise<string> {
  const db = await openDB(accountScope)
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).put(file, id)
    })
  } finally {
    db.close()
  }
  return id
}

async function readCachedFile(id: string, accountScope?: string): Promise<Blob | undefined> {
  const db = await openDB(accountScope)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(id)
      req.onsuccess = () => resolve(req.result as Blob | undefined)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function getCachedFile(id: string, accountScope?: string): Promise<Blob | undefined> {
  const scoped = await readCachedFile(id, accountScope)
  if (scoped || !accountScope) return scoped
  if (!canUseLegacyCache(accountScope)) return undefined

  // One-time compatibility read for pre-account caches. The calling account's
  // scoped attachment metadata must already know this unguessable cache key,
  // and only the first account that claims the legacy cache may migrate it.
  const legacy = await readCachedFile(id)
  if (legacy) {
    const db = await openDB(accountScope)
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.objectStore(STORE).put(legacy, id)
      })
    } finally {
      db.close()
    }
  }
  return legacy
}

async function removeCachedFile(id: string, accountScope?: string): Promise<void> {
  const db = await openDB(accountScope)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).delete(id)
    })
  } finally {
    db.close()
  }
}

export async function deleteCachedFile(id: string, accountScope?: string): Promise<void> {
  await removeCachedFile(id, accountScope)
  if (accountScope && canUseLegacyCache(accountScope)) await removeCachedFile(id)
}
