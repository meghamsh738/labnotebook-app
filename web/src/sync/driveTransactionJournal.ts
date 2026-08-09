import type { WritePrecondition } from './syncProvider'
import { stableStringify } from './hashing'

export const DRIVE_TRANSACTION_DB_NAME = 'easylab-drive-transactions'

export type DriveTransactionJsonWrite = {
  id: string
  kind: 'tombstone' | 'json' | 'manifest'
  path: string
  value: unknown
  contentHash: string
  appProperties: Record<string, string>
  precondition: WritePrecondition
  resumableOperationId?: string
}

export type DriveTransactionBlobWrite = {
  id: string
  kind: 'blob'
  path: string
  blobKey: string
  mimeType: string
  byteSize: number
  sha256: string
  contentHash: string
  appProperties: Record<string, string>
  precondition: WritePrecondition
  resumableOperationId?: string
  fileIdPlaceholder?: string
}

export type DriveTransactionWrite = DriveTransactionJsonWrite | DriveTransactionBlobWrite

export type DriveTransactionPlan = {
  operationId: string
  planHash: string
  inputStateHash: string
  createdAt: string
  remoteIdentity?: Array<{ path: string; fileId: string; version: string }>
  writes: DriveTransactionWrite[]
  initialSnapshot?: unknown
  finalSnapshot: unknown
  finalMeta: unknown
  result: unknown
}

export type DriveTransactionReceipt = {
  writeId: string
  path: string
  fileId: string
  version: string
  contentHash: string
  verifiedAt: string
}

export type DriveTransactionState = 'prepared' | 'running' | 'ambiguous' | 'manifest-committed' | 'completed'

export type DriveTransactionRecord = {
  plan: DriveTransactionPlan
  state: DriveTransactionState
  receipts: DriveTransactionReceipt[]
  updatedAt: string
}

export interface DriveTransactionPersistence {
  read(storageScope: string, operationId: string): Promise<DriveTransactionRecord | undefined>
  list(storageScope: string): Promise<DriveTransactionRecord[]>
  bindIfAbsent(storageScope: string, record: DriveTransactionRecord): Promise<DriveTransactionRecord>
  replace(
    storageScope: string,
    expected: DriveTransactionRecord,
    replacement: DriveTransactionRecord,
  ): Promise<boolean>
  pruneCompleted(storageScope: string, retain: number): Promise<void>
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T
}

function normalizedScope(storageScope: string) {
  const normalized = storageScope.trim()
  if (!normalized) throw new Error('Drive transaction storage scope must not be empty.')
  return normalized
}

function validatePlan(plan: DriveTransactionPlan) {
  if (!plan.operationId.trim() || !/^[0-9a-f]{64}$/.test(plan.planHash) || !/^[0-9a-f]{64}$/.test(plan.inputStateHash)) {
    throw new Error('Drive transaction plan identity is invalid.')
  }
  if (!plan.writes.length || plan.writes.at(-1)?.kind !== 'manifest') {
    throw new Error('Drive transaction plan must end with one manifest write.')
  }
  const ids = new Set<string>()
  for (const write of plan.writes) {
    if (!write.id.trim() || ids.has(write.id) || !write.path.trim() || !/^[0-9a-f]{64}$/.test(write.contentHash)) {
      throw new Error('Drive transaction write identity is invalid.')
    }
    ids.add(write.id)
  }
}

function samePlan(left: DriveTransactionPlan, right: DriveTransactionPlan) {
  return left.operationId === right.operationId
    && left.planHash === right.planHash
    && left.inputStateHash === right.inputStateHash
    && stableStringify(left) === stableStringify(right)
}

export class DriveTransactionPlanIdentityError extends Error {}

export class DriveTransactionJournal {
  private readonly persistence: DriveTransactionPersistence

  constructor(persistence: DriveTransactionPersistence) {
    this.persistence = persistence
  }

  read(storageScope: string, operationId: string) {
    return this.persistence.read(normalizedScope(storageScope), operationId)
  }

  async latestIncomplete(storageScope: string) {
    const records = await this.persistence.list(normalizedScope(storageScope))
    return records
      .filter((record) => record.state !== 'completed')
      .sort((left, right) => right.plan.createdAt.localeCompare(left.plan.createdAt))[0]
  }

  async begin(storageScope: string, plan: DriveTransactionPlan) {
    validatePlan(plan)
    const prepared: DriveTransactionRecord = {
      plan: clone(plan),
      state: 'prepared',
      receipts: [],
      updatedAt: plan.createdAt,
    }
    const bound = await this.persistence.bindIfAbsent(normalizedScope(storageScope), prepared)
    if (!samePlan(bound.plan, plan)) {
      throw new DriveTransactionPlanIdentityError(
        'Drive transaction operation id is already bound to a different immutable plan.',
      )
    }
    return clone(bound)
  }

  markRunning(storageScope: string, operationId: string) {
    return this.update(storageScope, operationId, (record) => record.state === 'completed'
      ? record
      : { ...record, state: 'running', updatedAt: new Date().toISOString() })
  }

  markAmbiguous(storageScope: string, operationId: string) {
    return this.update(storageScope, operationId, (record) => record.state === 'completed' || record.state === 'manifest-committed'
      ? record
      : { ...record, state: 'ambiguous', updatedAt: new Date().toISOString() })
  }

  markManifestCommitted(storageScope: string, operationId: string) {
    return this.update(storageScope, operationId, (record) => record.state === 'completed'
      ? record
      : { ...record, state: 'manifest-committed', updatedAt: new Date().toISOString() })
  }

  async markCompleted(storageScope: string, operationId: string) {
    const scope = normalizedScope(storageScope)
    const completed = await this.update(scope, operationId, (record) => ({
      ...record,
      state: 'completed',
      updatedAt: new Date().toISOString(),
    }))
    await this.persistence.pruneCompleted(scope, 1)
    return completed
  }

  recordReceipt(storageScope: string, operationId: string, receipt: DriveTransactionReceipt) {
    return this.update(storageScope, operationId, (record) => {
      const existing = record.receipts.find((candidate) => candidate.writeId === receipt.writeId)
      if (existing && stableStringify(existing) !== stableStringify(receipt)) {
        throw new DriveTransactionPlanIdentityError('Drive transaction receipt changed for an immutable write.')
      }
      if (existing) return record
      return {
        ...record,
        receipts: [...record.receipts, clone(receipt)],
        updatedAt: new Date().toISOString(),
      }
    })
  }

  private async update(
    storageScope: string,
    operationId: string,
    transform: (record: DriveTransactionRecord) => DriveTransactionRecord,
  ) {
    const scope = normalizedScope(storageScope)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.persistence.read(scope, operationId)
      if (!current) throw new Error('Drive transaction plan was not prepared.')
      const replacement = transform(current)
      if (stableStringify(replacement) === stableStringify(current)) return clone(current)
      if (await this.persistence.replace(scope, current, replacement)) return clone(replacement)
    }
    throw new Error('Drive transaction journal changed too many times concurrently.')
  }
}

export class MemoryDriveTransactionPersistence implements DriveTransactionPersistence {
  private readonly records = new Map<string, DriveTransactionRecord>()

  async read(storageScope: string, operationId: string) {
    const record = this.records.get(this.key(storageScope, operationId))
    return record ? clone(record) : undefined
  }

  async list(storageScope: string) {
    const prefix = `${normalizedScope(storageScope)}\u0000`
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => clone(record))
  }

  async bindIfAbsent(storageScope: string, record: DriveTransactionRecord) {
    const key = this.key(storageScope, record.plan.operationId)
    const existing = this.records.get(key)
    if (existing) return clone(existing)
    const prefix = `${normalizedScope(storageScope)}\u0000`
    const active = [...this.records.entries()].find(([candidateKey, candidate]) =>
      candidateKey.startsWith(prefix) && candidate.state !== 'completed')?.[1]
    if (active) return clone(active)
    this.records.set(key, clone(record))
    return clone(record)
  }

  async replace(storageScope: string, expected: DriveTransactionRecord, replacement: DriveTransactionRecord) {
    const key = this.key(storageScope, expected.plan.operationId)
    const current = this.records.get(key)
    if (!current || stableStringify(current) !== stableStringify(expected)) return false
    this.records.set(key, clone(replacement))
    return true
  }

  async pruneCompleted(storageScope: string, retain: number) {
    const prefix = `${normalizedScope(storageScope)}\u0000`
    const completed = [...this.records.entries()]
      .filter(([key, record]) => key.startsWith(prefix) && record.state === 'completed')
      .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
    for (const [key] of completed.slice(Math.max(0, retain))) this.records.delete(key)
  }

  private key(storageScope: string, operationId: string) {
    return `${normalizedScope(storageScope)}\u0000${operationId}`
  }
}

export class IndexedDbDriveTransactionPersistence implements DriveTransactionPersistence {
  async read(storageScope: string, operationId: string) {
    const db = await this.open(storageScope)
    return new Promise<DriveTransactionRecord | undefined>((resolve, reject) => {
      const request = db.transaction('operations', 'readonly').objectStore('operations').get(operationId)
      request.onsuccess = () => resolve(request.result ? clone(request.result as DriveTransactionRecord) : undefined)
      request.onerror = () => reject(request.error)
    }).finally(() => db.close())
  }

  async list(storageScope: string) {
    const db = await this.open(storageScope)
    return new Promise<DriveTransactionRecord[]>((resolve, reject) => {
      const request = db.transaction('operations', 'readonly').objectStore('operations').getAll()
      request.onsuccess = () => resolve((request.result as DriveTransactionRecord[]).map(clone))
      request.onerror = () => reject(request.error)
    }).finally(() => db.close())
  }

  async bindIfAbsent(storageScope: string, record: DriveTransactionRecord) {
    const db = await this.open(storageScope)
    return new Promise<DriveTransactionRecord>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite')
      const store = tx.objectStore('operations')
      let result = clone(record)
      const getAll = store.getAll()
      getAll.onerror = () => reject(getAll.error)
      getAll.onsuccess = () => {
        const records = getAll.result as DriveTransactionRecord[]
        const exact = records.find((candidate) => candidate.plan.operationId === record.plan.operationId)
        const active = records.find((candidate) => candidate.state !== 'completed')
        if (exact) result = clone(exact)
        else if (active) result = clone(active)
        else store.add(clone(record), record.plan.operationId)
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('Drive transaction bind was aborted.'))
      tx.onerror = () => reject(tx.error)
    }).finally(() => db.close())
  }

  async replace(storageScope: string, expected: DriveTransactionRecord, replacement: DriveTransactionRecord) {
    const db = await this.open(storageScope)
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite')
      const store = tx.objectStore('operations')
      let replaced = false
      const get = store.get(expected.plan.operationId)
      get.onerror = () => reject(get.error)
      get.onsuccess = () => {
        if (get.result && stableStringify(get.result) === stableStringify(expected)) {
          store.put(clone(replacement), expected.plan.operationId)
          replaced = true
        }
      }
      tx.oncomplete = () => resolve(replaced)
      tx.onabort = () => reject(tx.error ?? new Error('Drive transaction update was aborted.'))
      tx.onerror = () => reject(tx.error)
    }).finally(() => db.close())
  }

  async pruneCompleted(storageScope: string, retain: number) {
    const db = await this.open(storageScope)
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite')
      const store = tx.objectStore('operations')
      const getAll = store.getAll()
      getAll.onerror = () => reject(getAll.error)
      getAll.onsuccess = () => {
        const completed = (getAll.result as DriveTransactionRecord[])
          .filter((record) => record.state === 'completed')
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        for (const record of completed.slice(Math.max(0, retain))) store.delete(record.plan.operationId)
      }
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Drive transaction journal pruning was aborted.'))
      tx.onerror = () => reject(tx.error)
    }).finally(() => db.close())
  }

  private open(storageScope: string): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available.'))
    const dbName = `${DRIVE_TRANSACTION_DB_NAME}--account-${encodeURIComponent(normalizedScope(storageScope))}`
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
