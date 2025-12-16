// Best-effort filesystem cache using File System Access API (Chrome/Edge desktop). Falls back to undefined if not available or user cancels.
let cacheHandle: FileSystemDirectoryHandle | null = null

const DB_NAME = 'labnote-cache'
const HANDLE_STORE = 'handles'

type FsPermissionMode = 'read' | 'readwrite'
type DirectoryPickerOptions = { mode: FsPermissionMode; id?: string }
type DirectoryPicker = (options: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>
type DirectoryPickerWindow = Window & { showDirectoryPicker?: DirectoryPicker }
type FsDirectoryWithPerm = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: FsPermissionMode }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: FsPermissionMode }) => Promise<PermissionState>
}

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveHandle(handle: FileSystemDirectoryHandle) {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(HANDLE_STORE).put(handle, 'dir')
    })
  } catch (err) {
    console.warn('Unable to persist cache handle', err)
  }
}

export async function clearCacheHandle(): Promise<void> {
  cacheHandle = null
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(HANDLE_STORE).delete('dir')
    })
  } catch (err) {
    console.warn('Unable to clear cache handle', err)
  }
}

export async function restoreCacheHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly')
      const req = tx.objectStore(HANDLE_STORE).get('dir')
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    console.warn('Unable to load cache handle', err)
    return null
  }
}

export async function pickCacheDir(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker
  if (typeof picker !== 'function') return null
  try {
    cacheHandle = await picker({ mode: 'readwrite', id: 'labnote-cache' })
    if (cacheHandle) await saveHandle(cacheHandle)
    return cacheHandle
  } catch {
    return null
  }
}

export async function ensureCacheDir(): Promise<FileSystemDirectoryHandle | null> {
  if (cacheHandle) return cacheHandle
  cacheHandle = await restoreCacheHandle()
  if (cacheHandle) {
    // queryPermission/requestPermission not always typed; use optional chaining
    const handleWithPerm = cacheHandle as FsDirectoryWithPerm
    const permFn = handleWithPerm.queryPermission
    const reqFn = handleWithPerm.requestPermission
    if (permFn) {
      const perm = await permFn({ mode: 'readwrite' })
      if (perm === 'granted') return cacheHandle
    }
    if (reqFn) {
      const req = await reqFn({ mode: 'readwrite' })
      if (req === 'granted') return cacheHandle
    }
  }
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker
  if (typeof picker !== 'function') return null
  try {
    cacheHandle = await picker({ mode: 'readwrite', id: 'labnote-cache' })
    if (cacheHandle) await saveHandle(cacheHandle)
    return cacheHandle
  } catch {
    return null
  }
}

export async function writeFileToCache(file: File): Promise<string | null> {
  const dir = await ensureCacheDir()
  if (!dir) return null
  const name = `${Date.now()}-${file.name}`
  try {
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(file)
    await writable.close()
    return `fs://${name}`
  } catch (err) {
    console.warn('Filesystem cache failed', err)
    return null
  }
}
