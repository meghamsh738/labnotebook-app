const DB_NAME = 'labnote-cache'
const STORE = 'files'

type IDBDB = IDBDatabase

function ensureFilesStore(db: IDBDatabase): Promise<IDBDatabase> {
  if (db.objectStoreNames.contains(STORE)) return Promise.resolve(db)
  const nextVersion = db.version + 1
  db.close()
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, nextVersion)
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

function openDB(): Promise<IDBDB> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => {
      ensureFilesStore(req.result).then(resolve, reject)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function cacheFile(file: File): Promise<string> {
  const db = await openDB()
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

export async function getCachedFile(id: string): Promise<Blob | undefined> {
  const db = await openDB()
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

export async function deleteCachedFile(id: string): Promise<void> {
  const db = await openDB()
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
