import type { Attachment, Entry, Experiment, Project, Protocol } from './domain/types'
import { resolveGoogleAccountStorageScope, type GoogleAccountProfile } from './sync/connectedSync'
import type { JournalSnapshot } from './sync/dataCore'
import { JOURNAL_DB_NAME, JOURNAL_STORES, journalDbNameForScope } from './sync/repositories'
import { getCachedFileReadonly } from './idb'

export const LOCAL_WORKSPACE_SCOPE = 'local-primary-v1'

export type CachedNotebookSource = {
  id: string
  label: string
  accountScope?: string
  snapshot: JournalSnapshot
  projects: Project[]
  experiments: Experiment[]
  protocols: Protocol[]
  availableAttachmentIds: string[]
}

function parseStored<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function readRequest<T>(db: IDBDatabase, storeName: string, key?: IDBValidKey): Promise<T[]> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const request = key === undefined
      ? db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
      : db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onsuccess = () => resolve((key === undefined ? request.result : [request.result]) as T[])
    request.onerror = () => reject(request.error)
  })
}

async function readExistingJournalSnapshot(accountScope?: string): Promise<Partial<JournalSnapshot> | null> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null
  const name = journalDbNameForScope(JOURNAL_DB_NAME, accountScope)
  const databases = await indexedDB.databases()
  if (!databases.some((database) => database.name === name)) return null

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const [entries, attachments, fileBoxItems, transfers, conflicts, tombstones, devices] = await Promise.all([
      readRequest<{ id: string; payload?: Entry }>(db, JOURNAL_STORES.entries),
      readRequest<{ id: string; payload?: Attachment }>(db, JOURNAL_STORES.attachments),
      readRequest<JournalSnapshot['fileBoxItems'][number]>(db, JOURNAL_STORES.fileBoxItems),
      readRequest<JournalSnapshot['transfers'][number]>(db, JOURNAL_STORES.transfers),
      readRequest<JournalSnapshot['conflicts'][number]>(db, JOURNAL_STORES.conflicts),
      readRequest<JournalSnapshot['tombstones'][number]>(db, JOURNAL_STORES.tombstones),
      readRequest<NonNullable<JournalSnapshot['device']>>(db, JOURNAL_STORES.devices),
    ])
    return {
      entries: Object.fromEntries(entries.filter((item) => item.payload).map((item) => [item.id, item.payload as Entry])),
      attachments: attachments.flatMap((item) => item.payload ? [item.payload] : []),
      fileBoxItems,
      transfers,
      conflicts,
      tombstones,
      device: devices[0],
    }
  } finally {
    db.close()
  }
}

function mergeById<T extends { id: string }>(primary: T[], secondary: T[]) {
  const values = new Map(primary.map((value) => [value.id, value]))
  secondary.forEach((value) => values.set(value.id, value))
  return Array.from(values.values())
}

export async function readCachedNotebookSources(storage: Storage): Promise<CachedNotebookSource[]> {
  const suffix = '.labnote.entries'
  const candidates = new Map<string, { id: string; accountScope?: string; label: string; prefix: string }>()
  if (storage.getItem('labnote.entries')) {
    candidates.set('legacy', { id: 'legacy', label: 'Older local notes', prefix: '' })
  }

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith('labnote.account.') || !key.endsWith(suffix)) continue
    const accountScope = key.slice('labnote.account.'.length, -suffix.length)
    if (!accountScope || accountScope === LOCAL_WORKSPACE_SCOPE) continue
    const id = `account:${accountScope}`
    candidates.set(id, {
      id,
      accountScope,
      label: 'Saved account notes',
      prefix: `labnote.account.${accountScope}.`,
    })
  }

  const storedConnection = parseStored<{ connectedAccount?: GoogleAccountProfile } | null>(
    storage,
    'labnote.connected.googleDrive',
    null
  )
  const account = storedConnection?.connectedAccount
  const storedScope = resolveGoogleAccountStorageScope(account)
  if (storedScope) {
    const id = `account:${storedScope}`
    if (!candidates.has(id)) {
      candidates.set(id, {
        id,
        accountScope: storedScope,
        label: account?.email ? `Saved notes for ${account.email}` : 'Saved account notes',
        prefix: `labnote.account.${storedScope}.`,
      })
    } else if (account?.email) {
      const existing = candidates.get(id)
      if (existing) existing.label = `Saved notes for ${account.email}`
    }
  }

  const sources: CachedNotebookSource[] = []
  for (const candidate of candidates.values()) {
    const localEntries = parseStored<Record<string, Entry>>(storage, `${candidate.prefix}labnote.entries`, {})
    const localAttachments = parseStored<Attachment[]>(storage, `${candidate.prefix}labnote.attachments`, [])
    const oldSnapshot = await readExistingJournalSnapshot(candidate.accountScope).catch(() => null)
    const entries = { ...(oldSnapshot?.entries ?? {}), ...localEntries }
    if (!Object.keys(entries).length) continue

    const attachments = mergeById(oldSnapshot?.attachments ?? [], localAttachments)
    const snapshot: JournalSnapshot = {
      entries,
      attachments,
      fileBoxItems: oldSnapshot?.fileBoxItems ?? [],
      transfers: oldSnapshot?.transfers ?? [],
      conflicts: oldSnapshot?.conflicts ?? [],
      tombstones: oldSnapshot?.tombstones ?? [],
      device: oldSnapshot?.device,
    }
    const projects = parseStored<Project[]>(storage, `${candidate.prefix}labnote.projects`, [])
    const experiments = parseStored<Experiment[]>(storage, `${candidate.prefix}labnote.experiments`, [])
    const protocols = parseStored<Protocol[]>(storage, `${candidate.prefix}labnote.protocols`, [])
    const availableAttachmentIds: string[] = []

    for (const attachment of attachments) {
      if (await readCachedAttachmentBlob(attachment, candidate.accountScope)) {
        availableAttachmentIds.push(attachment.id)
      }
    }

    sources.push({ ...candidate, snapshot, projects, experiments, protocols, availableAttachmentIds })
  }
  return sources
}

export async function readCachedAttachmentBlob(attachment: Attachment, accountScope?: string): Promise<Blob | null> {
  if (attachment.cachedPath?.startsWith('idb://')) {
    const blob = await getCachedFileReadonly(attachment.cachedPath.replace('idb://', ''), accountScope).catch(() => undefined)
    if (blob) return blob
  }
  if (attachment.cacheKey && typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
    const name = journalDbNameForScope(JOURNAL_DB_NAME, accountScope)
    const databases = await indexedDB.databases()
    if (databases.some((database) => database.name === name)) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        if (!db.objectStoreNames.contains(JOURNAL_STORES.blobs)) return null
        const records = await readRequest<{ id: string; blob?: Blob }>(db, JOURNAL_STORES.blobs, attachment.cacheKey)
        return records[0]?.blob ?? null
      } finally {
        db.close()
      }
    }
  }
  return null
}
