import type { DeviceProfile } from '../domain/types'
import { safeDriveSegment } from './dataCore'
import {
  DRIVE_MIME_FOLDER,
  DRIVE_ROOT_FOLDER,
  GoogleDriveProvider,
  type GoogleAccountProfile,
  type DriveWritePrecondition,
  type DriveFile,
  type SyncProvider as FolderDriveClient,
} from './connectedSync'
import { isPositiveDriveVersion } from './driveResumableOperations'

export type AuthSession = {
  provider: 'mock' | 'google-drive'
  signedInAt: string
  account?: GoogleAccountProfile
}

export type WorkspaceRef = {
  id: string
  rootPath: string
}

export type RemoteFileRef = {
  id: string
  path: string
  name: string
  mimeType?: string
  size?: number
  updatedAt: string
  version: string
  appProperties?: Record<string, string>
}

export type RemoteJson<T> = RemoteFileRef & {
  value: T
}

export type RemoteJsonText = RemoteFileRef & {
  text: string
}

export type BlobMetadata = {
  mimeType?: string
  sha256?: string
  byteSize?: number
  appProperties?: Record<string, string>
}

export type PutOptions = {
  appProperties?: Record<string, string>
  precondition: WritePrecondition
  resumableOperationId?: string
}

type TestSeedOptions = {
  appProperties?: Record<string, string>
}

export type WritePrecondition = DriveWritePrecondition

export class WritePreconditionError extends Error {}

export function assertWritePrecondition(
  existing: RemoteFileRef | undefined,
  precondition: WritePrecondition,
) {
  const valid = precondition.kind === 'must-not-exist'
    ? !existing
    : Boolean(existing && existing.id === precondition.fileId && existing.version === precondition.version)
  if (!valid) {
    throw new WritePreconditionError('Remote file identity changed before the conditional write.')
  }
}

export type ListOptions = {
  prefix?: string
}

export type ChangePage = {
  changes: RemoteFileRef[]
  nextToken: string
}

export interface SyncProvider {
  readonly supportsVersionedCas?: boolean
  signIn(): Promise<AuthSession>
  signOut(): Promise<void>
  currentAccountScope?(): string | undefined
  ensureWorkspace(): Promise<WorkspaceRef>
  resolveWorkspace(): Promise<WorkspaceRef>
  acquireTransactionGuard(operationId: string): Promise<void>
  releaseTransactionGuard(operationId: string): Promise<void>

  getJson<T>(path: string): Promise<RemoteJson<T> | null>
  getJsonText?(path: string): Promise<RemoteJsonText | null>
  putJson<T>(path: string, value: T, options: PutOptions): Promise<RemoteFileRef>

  getBlob(path: string): Promise<Blob | null>
  getBlobById?(fileId: string): Promise<Blob | null>
  putBlob(path: string, blob: Blob, metadata: BlobMetadata, options: PutOptions): Promise<RemoteFileRef>

  loadManifest<T = unknown>(): Promise<T | null>
  putManifest<T>(manifest: T, options: PutOptions): Promise<RemoteFileRef>

  listManagedFiles(options?: ListOptions): Promise<RemoteFileRef[]>
  listChanges?(token: string): Promise<ChangePage>
}

type RemoteJsonRecord = {
  file: RemoteFileRef
  rawText: string
}

type RemoteBlobRecord = {
  file: RemoteFileRef
  blob: Blob
}

function nowIso() {
  return new Date().toISOString()
}

function fileNameFromPath(path: string) {
  return path.split('/').filter(Boolean).pop() || path
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T
}

const MOCK_TRANSACTION_GUARD_LEASE_MS = 24 * 60 * 60 * 1000

export class MockSyncProvider implements SyncProvider {
  readonly supportsVersionedCas = true
  private signedIn = false
  private sequence = 0
  private readonly jsonFiles = new Map<string, RemoteJsonRecord>()
  private readonly blobFiles = new Map<string, RemoteBlobRecord>()
  private readonly changes: RemoteFileRef[] = []
  private transactionGuard: { operationId: string; expiresAt: number } | undefined

  async signIn(): Promise<AuthSession> {
    this.signedIn = true
    return { provider: 'mock', signedInAt: nowIso() }
  }

  async signOut() {
    this.signedIn = false
  }

  async ensureWorkspace(): Promise<WorkspaceRef> {
    this.requireSignIn()
    return { id: 'mock-workspace', rootPath: 'Easylab Lab Notebook' }
  }

  resolveWorkspace() {
    return this.ensureWorkspace()
  }

  async acquireTransactionGuard(operationId: string) {
    this.requireSignIn()
    if (!/^[0-9a-f]{64}$/.test(operationId)) {
      throw new WritePreconditionError('Drive transaction guard identity is invalid.')
    }
    const now = Date.now()
    if (this.transactionGuard
      && this.transactionGuard.operationId !== operationId
      && this.transactionGuard.expiresAt > now) {
      throw new WritePreconditionError('Another Drive transaction holds the workspace guard.')
    }
    this.transactionGuard = { operationId, expiresAt: now + MOCK_TRANSACTION_GUARD_LEASE_MS }
  }

  async releaseTransactionGuard(operationId: string) {
    this.requireSignIn()
    if (this.transactionGuard && this.transactionGuard.operationId !== operationId) {
      throw new WritePreconditionError('Drive transaction workspace guard changed before release.')
    }
    this.transactionGuard = undefined
  }

  async ensureDeviceRecord(device: DeviceProfile) {
    await this.seedJsonForTest(`devices/${safeDriveSegment(device.id, 'device')}.json`, device)
  }

  async getJson<T>(path: string): Promise<RemoteJson<T> | null> {
    this.requireSignIn()
    const record = this.jsonFiles.get(path)
    if (!record) return null
    return { ...record.file, value: JSON.parse(record.rawText) as T }
  }

  async getJsonText(path: string): Promise<RemoteJsonText | null> {
    this.requireSignIn()
    const record = this.jsonFiles.get(path)
    return record ? { ...record.file, text: record.rawText } : null
  }

  async putJson<T>(path: string, value: T, options?: PutOptions): Promise<RemoteFileRef> {
    this.requireSignIn()
    if (!options?.precondition) throw new WritePreconditionError('Every runtime mock Drive write requires an explicit precondition.')
    const existing = this.jsonFiles.get(path)?.file
    assertWritePrecondition(existing, options.precondition)
    const file = this.makeFile(path, 'application/json', existing, options?.appProperties)
    this.jsonFiles.set(path, { file, rawText: JSON.stringify(clone(value)) })
    this.recordChange(file)
    return file
  }

  async getBlob(path: string): Promise<Blob | null> {
    this.requireSignIn()
    return this.blobFiles.get(path)?.blob ?? null
  }

  async getBlobById(fileId: string): Promise<Blob | null> {
    this.requireSignIn()
    return [...this.blobFiles.values()].find((record) => record.file.id === fileId)?.blob ?? null
  }

  async putBlob(path: string, blob: Blob, metadata: BlobMetadata, options?: PutOptions): Promise<RemoteFileRef> {
    this.requireSignIn()
    if (!options?.precondition) throw new WritePreconditionError('Every runtime mock Drive write requires an explicit precondition.')
    const existing = this.blobFiles.get(path)?.file
    assertWritePrecondition(existing, options.precondition)
    const file = this.makeFile(path, metadata.mimeType || blob.type || 'application/octet-stream', existing, metadata.appProperties)
    file.size = metadata.byteSize ?? blob.size
    this.blobFiles.set(path, { file, blob })
    this.recordChange(file)
    return file
  }

  async loadManifest<T = unknown>() {
    return (await this.getJson<T>('manifest.json'))?.value ?? null
  }

  putManifest<T>(manifest: T, options: PutOptions) {
    return this.putJson('manifest.json', manifest, {
      ...options,
      appProperties: { ...options?.appProperties, entityType: 'manifest' },
    })
  }

  async listManagedFiles(options: ListOptions = {}) {
    this.requireSignIn()
    const files = [...this.jsonFiles.values(), ...this.blobFiles.values()].map((record) => record.file)
    return files
      .filter((file) => !options.prefix || file.path.startsWith(options.prefix))
      .map((file) => ({ ...file, appProperties: file.appProperties ? { ...file.appProperties } : undefined }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  async listChanges(token: string): Promise<ChangePage> {
    this.requireSignIn()
    const start = Math.max(0, Number.parseInt(token, 10) || 0)
    return {
      changes: this.changes.slice(start).map((change) => ({ ...change })),
      nextToken: String(this.changes.length),
    }
  }

  async deletePath(path: string) {
    this.requireSignIn()
    const file = this.jsonFiles.get(path)?.file ?? this.blobFiles.get(path)?.file
    this.jsonFiles.delete(path)
    this.blobFiles.delete(path)
    if (file) this.recordChange({ ...file, updatedAt: nowIso() })
  }

  async duplicateJson<T>(sourcePath: string, duplicatePath: string, value?: T) {
    const source = this.jsonFiles.get(sourcePath)
    if (!source && typeof value === 'undefined') throw new Error(`No mock JSON exists at ${sourcePath}.`)
    return this.seedJsonForTest(
      duplicatePath,
      typeof value === 'undefined' ? JSON.parse(source!.rawText) as T : value,
    )
  }

  async putRawJsonForTest(path: string, rawText: string, options?: PutOptions): Promise<RemoteFileRef> {
    this.requireSignIn()
    const existing = this.jsonFiles.get(path)?.file
    if (options?.precondition) assertWritePrecondition(existing, options.precondition)
    const file = this.makeFile(path, 'application/json', existing, options?.appProperties)
    this.jsonFiles.set(path, { file, rawText })
    this.recordChange(file)
    return file
  }

  async seedJsonForTest<T>(path: string, value: T, options: TestSeedOptions = {}) {
    this.requireSignIn()
    const existing = this.jsonFiles.get(path)?.file
    const file = this.makeFile(path, 'application/json', existing, options.appProperties)
    this.jsonFiles.set(path, { file, rawText: JSON.stringify(clone(value)) })
    this.recordChange(file)
    return file
  }

  async seedBlobForTest(path: string, blob: Blob, metadata: BlobMetadata) {
    this.requireSignIn()
    const existing = this.blobFiles.get(path)?.file
    const file = this.makeFile(path, metadata.mimeType || blob.type || 'application/octet-stream', existing, metadata.appProperties)
    file.size = metadata.byteSize ?? blob.size
    this.blobFiles.set(path, { file, blob })
    this.recordChange(file)
    return file
  }

  private requireSignIn() {
    if (!this.signedIn) throw new Error('Mock sync provider is not signed in.')
  }

  private makeFile(
    path: string,
    mimeType: string,
    existing?: RemoteFileRef,
    appProperties?: Record<string, string>,
  ): RemoteFileRef {
    const id = existing?.id ?? `mock-file-${++this.sequence}`
    const version = String(Number.parseInt(existing?.version ?? '0', 10) + 1)
    return {
      id,
      path,
      name: fileNameFromPath(path),
      mimeType,
      updatedAt: nowIso(),
      version,
      appProperties,
    }
  }

  private recordChange(file: RemoteFileRef) {
    this.changes.push({ ...file, appProperties: file.appProperties ? { ...file.appProperties } : undefined })
  }
}

export type GoogleDriveSyncProviderOptions = {
  clientId: string
  clientSecret?: string
  folderName?: string
  folderId?: string
  authPrompt?: string
  client?: FolderDriveClient
  uploadRetryCount?: number
  retryDelayMs?: number
  /** Offline tests only. Normal application construction must leave this false. */
  testOnlyEnableVersionedCas?: boolean
  /** Explicit escape hatch for fixture seeding; never used by syncOnce. */
  testOnlyAllowUnsafeSeeding?: boolean
}

function pathSegments(path: string) {
  return path.split('/').map((segment) => segment.trim()).filter(Boolean)
}

const MANAGED_ROOT_FOLDERS = new Set([
  'devices',
  'entries',
  'attachments',
  'filebox',
  'transfers',
  'conflicts',
  'tombstones',
])

function parseDriveSize(size?: string) {
  if (!size) return undefined
  const parsed = Number.parseInt(size, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function driveFileToRemoteRef(path: string, file: DriveFile): RemoteFileRef {
  if (!isPositiveDriveVersion(file.version)) {
    throw new WritePreconditionError(`Drive managed file omitted a positive version: ${path}`)
  }
  return {
    id: file.id,
    path,
    name: file.name,
    mimeType: file.mimeType,
    size: parseDriveSize(file.size),
    updatedAt: file.modifiedTime || nowIso(),
    version: file.version,
    appProperties: file.appProperties ? { ...file.appProperties } : undefined,
  }
}

export class GoogleDriveSyncProvider implements SyncProvider {
  readonly supportsVersionedCas = false
  private readonly client: FolderDriveClient
  private readonly folderName: string
  private readonly uploadRetryCount: number
  private readonly retryDelayMs: number
  private readonly testOnlyEnableVersionedCas: boolean
  private readonly testOnlyAllowUnsafeSeeding: boolean
  private rootFolderId = ''
  private rootFolderVerified = false
  private signedInStorageScope = ''
  private readonly folderIds = new Map<string, string>()

  constructor(options: GoogleDriveSyncProviderOptions) {
    this.folderName = options.folderName || DRIVE_ROOT_FOLDER
    this.rootFolderId = options.folderId || ''
    this.uploadRetryCount = options.uploadRetryCount ?? 2
    this.retryDelayMs = options.retryDelayMs ?? 350
    this.testOnlyEnableVersionedCas = options.testOnlyEnableVersionedCas === true
    this.testOnlyAllowUnsafeSeeding = options.testOnlyAllowUnsafeSeeding === true
    this.client = options.client ?? new GoogleDriveProvider({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      folderName: this.folderName,
      authPrompt: options.authPrompt,
    })
  }

  async signIn(): Promise<AuthSession> {
    const previousScope = this.signedInStorageScope
    const account = await this.client.signIn()
    const nextScope = account?.storageScope?.trim() ?? ''
    if (previousScope && previousScope !== nextScope) this.resetRootFolder()
    this.signedInStorageScope = nextScope
    return { provider: 'google-drive', signedInAt: nowIso(), account }
  }

  async signOut() {
    this.client.logout()
    this.signedInStorageScope = ''
    this.resetRootFolder()
  }

  currentAccountScope() {
    return this.signedInStorageScope || undefined
  }

  async ensureWorkspace(): Promise<WorkspaceRef> {
    await this.ensureRoot()
    await Promise.all(['devices', 'entries', 'attachments', 'filebox', 'transfers', 'conflicts', 'tombstones'].map((folder) => this.ensureFolderPath(folder)))
    return { id: this.rootFolderId, rootPath: this.folderName }
  }

  async resolveWorkspace(): Promise<WorkspaceRef> {
    await this.resolveExistingRoot()
    for (const folder of MANAGED_ROOT_FOLDERS) {
      const matches = await this.client.listFolder(
        this.rootFolderId,
        `name = '${escapeDriveQuery(folder)}' and mimeType = '${DRIVE_MIME_FOLDER}'`,
      )
      if (matches.length !== 1) {
        throw new WritePreconditionError(`Drive managed folder must exist exactly once before sync: ${folder}`)
      }
      this.folderIds.set(folder, matches[0].id)
    }
    return { id: this.rootFolderId, rootPath: this.folderName }
  }

  async acquireTransactionGuard(operationId: string) {
    if (!this.testOnlyEnableVersionedCas) {
      throw new WritePreconditionError('Google Drive transaction guards are disabled outside offline validation.')
    }
    if (!this.rootFolderVerified || !this.rootFolderId) {
      throw new WritePreconditionError('Drive workspace must be verified before acquiring a transaction guard.')
    }
    if (!this.client.acquireWorkspaceTransactionGuard) {
      throw new WritePreconditionError('Google Drive client does not support conditional transaction guards.')
    }
    await this.client.acquireWorkspaceTransactionGuard(this.rootFolderId, operationId)
  }

  async releaseTransactionGuard(operationId: string) {
    if (!this.testOnlyEnableVersionedCas) {
      throw new WritePreconditionError('Google Drive transaction guards are disabled outside offline validation.')
    }
    if (!this.rootFolderVerified || !this.rootFolderId) {
      throw new WritePreconditionError('Drive workspace must remain verified while releasing a transaction guard.')
    }
    if (!this.client.releaseWorkspaceTransactionGuard) {
      throw new WritePreconditionError('Google Drive client does not support conditional transaction guards.')
    }
    await this.client.releaseWorkspaceTransactionGuard(this.rootFolderId, operationId)
  }

  async ensureDeviceRecord(device: DeviceProfile) {
    throw new WritePreconditionError(
      `Device ${safeDriveSegment(device.id, 'device')} must be written through a preflighted transaction.`,
    )
  }

  async getJson<T>(path: string): Promise<RemoteJson<T> | null> {
    const file = await this.findFile(path)
    if (!file) return null
    const value = await this.client.downloadJson<T>(file.id)
    return { ...driveFileToRemoteRef(path, file), value }
  }

  async getJsonText(path: string): Promise<RemoteJsonText | null> {
    const file = await this.findFile(path)
    if (!file) return null
    const text = this.client.downloadText
      ? await this.client.downloadText(file.id)
      : JSON.stringify(await this.client.downloadJson<unknown>(file.id))
    return { ...driveFileToRemoteRef(path, file), text }
  }

  async putJson<T>(path: string, value: T, options?: PutOptions): Promise<RemoteFileRef> {
    const precondition = this.requireConditionalWrite(options)
    const { folderPath, fileName } = this.splitFilePath(path)
    const parentFolderId = await this.resolveFolderPath(folderPath)
    if (!parentFolderId) throw new WritePreconditionError(`Drive managed folder is missing: ${folderPath}`)
    if (!this.client.conditionalUploadJson) throw new WritePreconditionError('Drive client has no conditional JSON capability.')
    const file = await this.client.conditionalUploadJson({
      parentFolderId,
      path,
      name: fileName,
      value,
      precondition,
      appProperties: options?.appProperties,
      resumableOperationId: options?.resumableOperationId,
    })
    return driveFileToRemoteRef(path, file)
  }

  async getBlob(path: string): Promise<Blob | null> {
    const file = await this.findFile(path)
    if (!file) return null
    return this.client.downloadBlob(file.id)
  }

  async getBlobById(fileId: string): Promise<Blob | null> {
    try {
      return await this.client.downloadBlob(fileId)
    } catch (error) {
      if (isMissingDriveFolderError(error)) return null
      throw error
    }
  }

  async putBlob(path: string, blob: Blob, metadata: BlobMetadata, options?: PutOptions): Promise<RemoteFileRef> {
    const precondition = this.requireConditionalWrite(options)
    const { folderPath, fileName } = this.splitFilePath(path)
    const parentFolderId = await this.resolveFolderPath(folderPath)
    if (!parentFolderId) throw new WritePreconditionError(`Drive managed folder is missing: ${folderPath}`)
    if (!this.client.conditionalUploadBlob) throw new WritePreconditionError('Drive client has no conditional blob capability.')
    const sha256 = metadata.sha256?.toLowerCase()
    if (!sha256) throw new WritePreconditionError('Drive conditional blob write requires a SHA-256.')
    const file = await this.client.conditionalUploadBlob({
      parentFolderId,
      path,
      name: fileName,
      blob,
      mimeType: metadata.mimeType || blob.type || 'application/octet-stream',
      sha256,
      precondition,
      appProperties: metadata.appProperties,
      resumableOperationId: options?.resumableOperationId,
    })
    return driveFileToRemoteRef(path, file)
  }

  async loadManifest<T = unknown>() {
    return (await this.getJson<T>('manifest.json'))?.value ?? null
  }

  putManifest<T>(manifest: T, options: PutOptions) {
    return this.putJson('manifest.json', manifest, {
      ...options,
      appProperties: { ...options.appProperties, entityType: 'manifest' },
    })
  }

  async seedJsonForTest<T>(path: string, value: T, appProperties?: Record<string, string>) {
    this.requireUnsafeTestSeeding()
    const { folderPath, fileName } = this.splitFilePath(path)
    const parentFolderId = await this.ensureFolderPath(folderPath)
    const fileId = await this.withUploadRetry(() => this.client.uploadJson(parentFolderId, fileName, value))
    const file = await this.findFile(path)
    if (!file || file.id !== fileId) throw new Error('Test JSON seed did not produce one exact Drive file.')
    return driveFileToRemoteRef(path, { ...file, appProperties: appProperties ?? file.appProperties })
  }

  async seedBlobForTest(path: string, blob: Blob, metadata: BlobMetadata) {
    this.requireUnsafeTestSeeding()
    const { folderPath, fileName } = this.splitFilePath(path)
    const parentFolderId = await this.ensureFolderPath(folderPath)
    const fileId = await this.withUploadRetry(() => this.client.uploadBlob(parentFolderId, fileName, blob, metadata.mimeType, {
      sha256: metadata.sha256,
      appProperties: metadata.appProperties,
    }))
    const file = await this.findFile(path)
    if (!file || file.id !== fileId) throw new Error('Test blob seed did not produce one exact Drive file.')
    return driveFileToRemoteRef(path, file)
  }

  async listManagedFiles(options: ListOptions = {}) {
    await this.resolveWorkspace()
    const allFiles = await this.listFilesRecursive('', this.rootFolderId)
    return allFiles
      .filter((file) => !options.prefix || file.path.startsWith(options.prefix))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  private splitFilePath(path: string) {
    const segments = pathSegments(path)
    const fileName = segments.pop()
    if (!fileName) throw new Error('Drive path must include a file name.')
    return { folderPath: segments.join('/'), fileName }
  }

  private requireConditionalWrite(options?: PutOptions) {
    if (!this.testOnlyEnableVersionedCas) {
      throw new WritePreconditionError('Google Drive writes are disabled outside the offline conditional-write harness.')
    }
    if (!options?.precondition) {
      throw new WritePreconditionError('Every Google Drive write requires an explicit versioned precondition.')
    }
    return options.precondition
  }

  private requireUnsafeTestSeeding() {
    if (!this.testOnlyAllowUnsafeSeeding) {
      throw new WritePreconditionError('Unsafe Drive fixture seeding is disabled.')
    }
  }

  private async ensureFolderPath(folderPath: string) {
    await this.ensureRoot()
    if (this.folderIds.has(folderPath)) return this.folderIds.get(folderPath)!
    let parentFolderId = this.rootFolderId
    const current: string[] = []
    for (const segment of pathSegments(folderPath)) {
      current.push(segment)
      const key = current.join('/')
      let folderId = this.folderIds.get(key)
      if (!folderId) {
        folderId = await this.client.ensureFolder(parentFolderId, segment)
        this.folderIds.set(key, folderId)
      }
      parentFolderId = folderId
    }
    return parentFolderId
  }

  private async resolveFolderPath(folderPath: string) {
    await this.ensureRoot()
    if (this.folderIds.has(folderPath)) return this.folderIds.get(folderPath)
    let parentFolderId = this.rootFolderId
    const current: string[] = []
    for (const segment of pathSegments(folderPath)) {
      current.push(segment)
      const key = current.join('/')
      const cached = this.folderIds.get(key)
      if (cached) {
        parentFolderId = cached
        continue
      }
      const matches = await this.client.listFolder(parentFolderId, `name = '${escapeDriveQuery(segment)}' and mimeType = '${DRIVE_MIME_FOLDER}'`)
      if (matches.length > 1) throw new Error(`Drive managed folder path is ambiguous: ${key}`)
      const folderId = matches[0]?.id
      if (!folderId) return undefined
      this.folderIds.set(key, folderId)
      parentFolderId = folderId
    }
    return parentFolderId
  }

  private async findFile(path: string) {
    const { folderPath, fileName } = this.splitFilePath(path)
    const folderId = await this.resolveFolderPath(folderPath)
    if (!folderId) return undefined
    const matches = await this.client.listFolder(folderId, `name = '${escapeDriveQuery(fileName)}' and mimeType != '${DRIVE_MIME_FOLDER}'`)
    if (matches.length > 1) throw new Error(`Drive managed file path is ambiguous: ${path}`)
    return matches[0]
  }

  private async listFilesRecursive(folderPath: string, folderId: string): Promise<RemoteFileRef[]> {
    const children = await this.client.listFolder(folderId)
    const files: RemoteFileRef[] = []
    for (const child of children) {
      const childPath = folderPath ? `${folderPath}/${child.name}` : child.name
      if (child.mimeType === DRIVE_MIME_FOLDER) {
        this.folderIds.set(childPath, child.id)
        files.push(...await this.listFilesRecursive(childPath, child.id))
      } else {
        files.push(driveFileToRemoteRef(childPath, child))
      }
    }
    return files
  }

  private async ensureRoot() {
    if (this.rootFolderId && !this.rootFolderVerified) {
      try {
        const metadata = await this.client.getFileMetadata(this.rootFolderId)
        const validFolder = metadata.id === this.rootFolderId
          && metadata.mimeType === DRIVE_MIME_FOLDER
          && metadata.trashed !== true
        const validIdentity = validFolder && (
          await this.hasValidRootManifest(this.rootFolderId)
          || (metadata.name === this.folderName && await this.isUninitializedManagedRoot(this.rootFolderId))
        )
        if (!validIdentity) this.resetRootFolder()
      } catch (error) {
        if (!isMissingDriveFolderError(error)) throw error
        this.resetRootFolder()
      }
    }
    if (!this.rootFolderId) this.rootFolderId = await this.resolveOrCreateRootFolder()
    this.rootFolderVerified = true
    this.folderIds.set('', this.rootFolderId)
  }

  private async resolveExistingRoot() {
    if (this.rootFolderId && !this.rootFolderVerified) {
      try {
        const metadata = await this.client.getFileMetadata(this.rootFolderId)
        const validFolder = metadata.id === this.rootFolderId
          && metadata.mimeType === DRIVE_MIME_FOLDER
          && metadata.trashed !== true
        const validIdentity = validFolder && (
          await this.hasValidRootManifest(this.rootFolderId)
          || (metadata.name === this.folderName && await this.isUninitializedManagedRoot(this.rootFolderId))
        )
        if (!validIdentity) this.resetRootFolder()
      } catch (error) {
        if (!isMissingDriveFolderError(error)) throw error
        this.resetRootFolder()
      }
    }
    if (!this.rootFolderId) {
      const matches = await this.client.listFolder(
        'root',
        `name = '${escapeDriveQuery(this.folderName)}' and mimeType = '${DRIVE_MIME_FOLDER}' and trashed = false`,
      )
      const manifestRoots: DriveFile[] = []
      const emptyRoots: DriveFile[] = []
      for (const candidate of matches) {
        if (await this.hasValidRootManifest(candidate.id)) manifestRoots.push(candidate)
        else if (await this.isUninitializedManagedRoot(candidate.id)) emptyRoots.push(candidate)
      }
      if (manifestRoots.length > 1 || (manifestRoots.length === 0 && emptyRoots.length > 1)) {
        throw new WritePreconditionError('Drive workspace is ambiguous and cannot be used for transactional sync.')
      }
      this.rootFolderId = manifestRoots[0]?.id ?? emptyRoots[0]?.id ?? ''
      if (!this.rootFolderId) {
        throw new WritePreconditionError('Drive workspace must already exist before transactional sync.')
      }
    }
    this.rootFolderVerified = true
    this.folderIds.set('', this.rootFolderId)
  }

  private async resolveOrCreateRootFolder() {
    const matches = await this.client.listFolder(
      'root',
      `name = '${escapeDriveQuery(this.folderName)}' and mimeType = '${DRIVE_MIME_FOLDER}' and trashed = false`,
    )
    const manifestRoots: DriveFile[] = []
    const emptyRoots: DriveFile[] = []

    for (const candidate of matches) {
      if (await this.hasValidRootManifest(candidate.id)) manifestRoots.push(candidate)
      else if (await this.isUninitializedManagedRoot(candidate.id)) emptyRoots.push(candidate)
    }

    if (manifestRoots.length > 1) {
      throw new Error('Multiple Easylab Drive workspaces were found. Choose the intended notebook before syncing.')
    }
    if (manifestRoots.length === 1) return manifestRoots[0].id
    if (emptyRoots.length > 1) {
      throw new Error('Multiple empty Easylab Drive folders were found. Remove the duplicates before syncing.')
    }
    if (emptyRoots.length === 1) return emptyRoots[0].id

    if (this.client.createRootFolder) return this.client.createRootFolder(this.folderName)
    const fallbackId = await this.client.ensureRootFolder()
    const fallbackIsSafe = await this.hasValidRootManifest(fallbackId)
      || await this.isUninitializedManagedRoot(fallbackId)
    if (!fallbackIsSafe) {
      throw new Error('The matching Drive folder is not an Easylab workspace and cannot be used safely.')
    }
    return fallbackId
  }

  private async hasValidRootManifest(folderId: string) {
    const matches = await this.client.listFolder(folderId, "name = 'manifest.json' and mimeType != 'application/vnd.google-apps.folder'")
    const manifestId = matches[0]?.id
    if (!manifestId) return false
    try {
      const manifest = await this.client.downloadJson<unknown>(manifestId)
      if (!manifest || typeof manifest !== 'object') return false
      const record = manifest as { version?: unknown; provider?: unknown; rootFolderName?: unknown }
      return record.version === 1
        && record.provider === 'google-drive'
        && typeof record.rootFolderName === 'string'
        && Boolean(record.rootFolderName.trim())
    } catch (error) {
      if (isMissingDriveFolderError(error)) return false
      throw error
    }
  }

  private async isUninitializedManagedRoot(folderId: string) {
    const children = await this.client.listFolder(folderId)
    if (children.length === 0) return true
    if (children.some((child) => child.mimeType !== DRIVE_MIME_FOLDER || !MANAGED_ROOT_FOLDERS.has(child.name))) {
      return false
    }
    for (const child of children) {
      if ((await this.client.listFolder(child.id)).length > 0) return false
    }
    return true
  }

  private resetRootFolder() {
    this.rootFolderId = ''
    this.rootFolderVerified = false
    this.folderIds.clear()
  }

  private async withUploadRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.uploadRetryCount; attempt += 1) {
      try {
        return await operation()
      } catch (err) {
        lastError = err
        if (attempt >= this.uploadRetryCount || !isRetryableUploadError(err)) break
        await new Promise((resolve) => globalThis.setTimeout(resolve, this.retryDelayMs * (attempt + 1)))
      }
    }
    throw lastError
  }
}

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function isRetryableUploadError(error: unknown) {
  if (error instanceof TypeError) return true
  if (!(error instanceof Error)) return false
  return /\b(408|429|5\d\d)\b|rate limit|network|timeout|temporar/i.test(error.message)
}

function isMissingDriveFolderError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(404|notFound)\b|file not found/i.test(message)
}
