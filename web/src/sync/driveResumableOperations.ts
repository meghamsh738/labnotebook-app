export const DRIVE_RESUMABLE_OPERATION_DB_NAME = 'easylab-drive-resumable-operations'

export type DriveResumableTarget =
  | { kind: 'existing'; fileId: string; expectedVersion: string }
  | { kind: 'new'; fileId: string; creationFingerprint: string }

export type DriveResumableOperationIdentity = {
  operationId: string
  path: string
  mimeType: string
  byteSize: number
  sha256: string
  appProperties: Record<string, string>
  target: DriveResumableTarget
}

export type DriveResumableOperationRecord = {
  identity: DriveResumableOperationIdentity
  state: 'prepared' | 'ambiguous' | 'completed'
  completedVersion?: string
}

export interface DriveResumableOperationPersistence {
  read(storageScope: string, operationId: string): Promise<DriveResumableOperationRecord | undefined>
  bindIfAbsent(
    storageScope: string,
    record: DriveResumableOperationRecord,
  ): Promise<DriveResumableOperationRecord>
  replace(
    storageScope: string,
    expected: DriveResumableOperationRecord,
    replacement: DriveResumableOperationRecord,
  ): Promise<boolean>
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T
}

function normalizedScope(storageScope: string) {
  const normalized = storageScope.trim()
  if (!normalized) throw new Error('Drive resumable storage scope must not be empty.')
  return normalized
}

function validateIdentity(identity: DriveResumableOperationIdentity) {
  const hasControlCharacter = [...identity.operationId].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
  if (!identity.operationId.trim() || identity.operationId.length > 256 || hasControlCharacter) {
    throw new Error('Drive resumable operation id is invalid.')
  }
  if (!identity.path.trim() || !identity.mimeType.trim()) throw new Error('Drive resumable operation identity is incomplete.')
  if (!Number.isSafeInteger(identity.byteSize) || identity.byteSize < 0) throw new Error('Drive resumable byte count is invalid.')
  if (!/^[0-9a-f]{64}$/.test(identity.sha256)) throw new Error('Drive resumable SHA-256 is invalid.')
  if (!identity.target.fileId.trim()) throw new Error('Drive resumable target file id is invalid.')
  if (identity.target.kind === 'existing') {
    if (!isPositiveDriveVersion(identity.target.expectedVersion)) throw new Error('Drive resumable target version is invalid.')
  } else if (!/^[0-9a-f]{64}$/.test(identity.target.creationFingerprint)) {
    throw new Error('Drive resumable creation fingerprint is invalid.')
  }
}

export function isPositiveDriveVersion(version: string | undefined): version is string {
  return typeof version === 'string' && /^[1-9]\d*$/.test(version)
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export async function sha256Hex(value: Blob | Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Blob
      ? new Uint8Array(await value.arrayBuffer())
      : value
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function resumableIdentityEquals(
  left: DriveResumableOperationIdentity,
  right: DriveResumableOperationIdentity,
) {
  return stableStringify(left) === stableStringify(right)
}

export class DriveResumableOperationIdentityError extends Error {}

export class DriveResumableOperationStore {
  private readonly persistence: DriveResumableOperationPersistence

  constructor(persistence: DriveResumableOperationPersistence) {
    this.persistence = persistence
  }

  read(storageScope: string, operationId: string) {
    return this.persistence.read(normalizedScope(storageScope), operationId)
  }

  async begin(storageScope: string, identity: DriveResumableOperationIdentity) {
    validateIdentity(identity)
    const prepared: DriveResumableOperationRecord = { identity: clone(identity), state: 'prepared' }
    const bound = await this.persistence.bindIfAbsent(normalizedScope(storageScope), prepared)
    if (!resumableIdentityEquals(bound.identity, identity)) {
      throw new DriveResumableOperationIdentityError(
        'Drive resumable operation id is already bound to different immutable content.',
      )
    }
    return clone(bound)
  }

  markAmbiguous(storageScope: string, identity: DriveResumableOperationIdentity) {
    return this.update(storageScope, identity, (record) => record.state === 'completed'
      ? record
      : { identity: record.identity, state: 'ambiguous' })
  }

  markCompleted(storageScope: string, identity: DriveResumableOperationIdentity, completedVersion: string) {
    if (!isPositiveDriveVersion(completedVersion)) throw new Error('Drive resumable completion version is invalid.')
    const minimum = identity.target.kind === 'existing' ? BigInt(identity.target.expectedVersion) : 0n
    if (BigInt(completedVersion) <= minimum) throw new Error('Drive resumable completion did not advance its target version.')
    return this.update(storageScope, identity, (record) => ({
      identity: record.identity,
      state: 'completed',
      completedVersion: record.completedVersion && BigInt(record.completedVersion) > BigInt(completedVersion)
        ? record.completedVersion
        : completedVersion,
    }))
  }

  private async update(
    storageScope: string,
    identity: DriveResumableOperationIdentity,
    transform: (record: DriveResumableOperationRecord) => DriveResumableOperationRecord,
  ) {
    const scope = normalizedScope(storageScope)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.persistence.read(scope, identity.operationId)
      if (!current) throw new Error('Drive resumable operation identity was not prepared.')
      if (!resumableIdentityEquals(current.identity, identity)) {
        throw new DriveResumableOperationIdentityError('Drive resumable operation identity changed before its outcome was persisted.')
      }
      const replacement = transform(current)
      if (await this.persistence.replace(scope, current, replacement)) return clone(replacement)
    }
    throw new Error('Drive resumable operation outcome changed too many times concurrently.')
  }
}

export class MemoryDriveResumableOperationPersistence implements DriveResumableOperationPersistence {
  private readonly records = new Map<string, DriveResumableOperationRecord>()

  async read(storageScope: string, operationId: string) {
    const record = this.records.get(this.key(storageScope, operationId))
    return record ? clone(record) : undefined
  }

  async bindIfAbsent(storageScope: string, record: DriveResumableOperationRecord) {
    const key = this.key(storageScope, record.identity.operationId)
    const existing = this.records.get(key)
    if (existing) return clone(existing)
    this.records.set(key, clone(record))
    return clone(record)
  }

  async replace(
    storageScope: string,
    expected: DriveResumableOperationRecord,
    replacement: DriveResumableOperationRecord,
  ) {
    const key = this.key(storageScope, expected.identity.operationId)
    const current = this.records.get(key)
    if (!current || stableStringify(current) !== stableStringify(expected)) return false
    this.records.set(key, clone(replacement))
    return true
  }

  private key(storageScope: string, operationId: string) {
    return `${normalizedScope(storageScope)}\u0000${operationId}`
  }
}

export class IndexedDbDriveResumableOperationPersistence implements DriveResumableOperationPersistence {
  async read(storageScope: string, operationId: string) {
    const db = await this.open(storageScope)
    return new Promise<DriveResumableOperationRecord | undefined>((resolve, reject) => {
      const request = db.transaction('operations', 'readonly').objectStore('operations').get(operationId)
      request.onsuccess = () => resolve(request.result ? clone(request.result as DriveResumableOperationRecord) : undefined)
      request.onerror = () => reject(request.error)
    }).finally(() => db.close())
  }

  async bindIfAbsent(storageScope: string, record: DriveResumableOperationRecord) {
    const db = await this.open(storageScope)
    return new Promise<DriveResumableOperationRecord>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite')
      const store = tx.objectStore('operations')
      let result: DriveResumableOperationRecord = clone(record)
      const get = store.get(record.identity.operationId)
      get.onerror = () => reject(get.error)
      get.onsuccess = () => {
        if (get.result) result = clone(get.result as DriveResumableOperationRecord)
        else store.add(clone(record), record.identity.operationId)
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('Drive resumable identity bind was aborted.'))
      tx.onerror = () => reject(tx.error)
    }).finally(() => db.close())
  }

  async replace(
    storageScope: string,
    expected: DriveResumableOperationRecord,
    replacement: DriveResumableOperationRecord,
  ) {
    const db = await this.open(storageScope)
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite')
      const store = tx.objectStore('operations')
      let replaced = false
      const get = store.get(expected.identity.operationId)
      get.onerror = () => reject(get.error)
      get.onsuccess = () => {
        if (get.result && stableStringify(get.result) === stableStringify(expected)) {
          store.put(clone(replacement), expected.identity.operationId)
          replaced = true
        }
      }
      tx.oncomplete = () => resolve(replaced)
      tx.onabort = () => reject(tx.error ?? new Error('Drive resumable outcome update was aborted.'))
      tx.onerror = () => reject(tx.error)
    }).finally(() => db.close())
  }

  private open(storageScope: string): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available.'))
    const dbName = `${DRIVE_RESUMABLE_OPERATION_DB_NAME}--account-${encodeURIComponent(normalizedScope(storageScope))}`
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('operations')) request.result.createObjectStore('operations')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
}
