import type { DeviceProfile } from '../domain/types'
import { safeDriveSegment } from './dataCore'
import {
  DRIVE_MIME_FOLDER,
  DRIVE_ROOT_FOLDER,
  GoogleDriveProvider,
  type GoogleAccountProfile,
  type DriveFile,
  type SyncProvider as FolderDriveClient,
} from './connectedSync'

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
  appProperties?: Record<string, string>
}

export type RemoteJson<T> = RemoteFileRef & {
  value: T
}

export type BlobMetadata = {
  mimeType?: string
  sha256?: string
  byteSize?: number
  appProperties?: Record<string, string>
}

export type PutOptions = {
  appProperties?: Record<string, string>
}

export type ListOptions = {
  prefix?: string
}

export type ChangePage = {
  changes: RemoteFileRef[]
  nextToken: string
}

export interface SyncProvider {
  signIn(): Promise<AuthSession>
  signOut(): Promise<void>
  ensureWorkspace(): Promise<WorkspaceRef>
  ensureDeviceRecord(device: DeviceProfile): Promise<void>

  getJson<T>(path: string): Promise<RemoteJson<T> | null>
  putJson<T>(path: string, value: T, options?: PutOptions): Promise<RemoteFileRef>

  getBlob(path: string): Promise<Blob | null>
  getBlobById?(fileId: string): Promise<Blob | null>
  putBlob(path: string, blob: Blob, metadata: BlobMetadata): Promise<RemoteFileRef>

  loadManifest<T = unknown>(): Promise<T | null>
  putManifest<T>(manifest: T): Promise<RemoteFileRef>

  listManagedFiles(options?: ListOptions): Promise<RemoteFileRef[]>
  listChanges?(token: string): Promise<ChangePage>
}

type RemoteJsonRecord = {
  file: RemoteFileRef
  value: unknown
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

export class MockSyncProvider implements SyncProvider {
  private signedIn = false
  private sequence = 0
  private readonly jsonFiles = new Map<string, RemoteJsonRecord>()
  private readonly blobFiles = new Map<string, RemoteBlobRecord>()
  private readonly changes: RemoteFileRef[] = []

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

  async ensureDeviceRecord(device: DeviceProfile) {
    await this.putJson(`devices/${safeDriveSegment(device.id, 'device')}.json`, device)
  }

  async getJson<T>(path: string): Promise<RemoteJson<T> | null> {
    this.requireSignIn()
    const record = this.jsonFiles.get(path)
    if (!record) return null
    return { ...record.file, value: clone(record.value) as T }
  }

  async putJson<T>(path: string, value: T, options?: PutOptions): Promise<RemoteFileRef> {
    this.requireSignIn()
    const existing = this.jsonFiles.get(path)?.file
    const file = this.makeFile(path, 'application/json', existing?.id, options?.appProperties)
    this.jsonFiles.set(path, { file, value: clone(value) })
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

  async putBlob(path: string, blob: Blob, metadata: BlobMetadata): Promise<RemoteFileRef> {
    this.requireSignIn()
    const existing = this.blobFiles.get(path)?.file
    const file = this.makeFile(path, metadata.mimeType || blob.type || 'application/octet-stream', existing?.id, metadata.appProperties)
    file.size = metadata.byteSize ?? blob.size
    this.blobFiles.set(path, { file, blob })
    this.recordChange(file)
    return file
  }

  async loadManifest<T = unknown>() {
    return (await this.getJson<T>('manifest.json'))?.value ?? null
  }

  putManifest<T>(manifest: T) {
    return this.putJson('manifest.json', manifest, {
      appProperties: { entityType: 'manifest' },
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
    return this.putJson(duplicatePath, typeof value === 'undefined' ? source!.value as T : value)
  }

  private requireSignIn() {
    if (!this.signedIn) throw new Error('Mock sync provider is not signed in.')
  }

  private makeFile(path: string, mimeType: string, existingId?: string, appProperties?: Record<string, string>): RemoteFileRef {
    return {
      id: existingId ?? `mock-file-${++this.sequence}`,
      path,
      name: fileNameFromPath(path),
      mimeType,
      updatedAt: nowIso(),
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
  return {
    id: file.id,
    path,
    name: file.name,
    mimeType: file.mimeType,
    size: parseDriveSize(file.size),
    updatedAt: file.modifiedTime || nowIso(),
  }
}

export class GoogleDriveSyncProvider implements SyncProvider {
  private readonly client: FolderDriveClient
  private readonly folderName: string
  private readonly uploadRetryCount: number
  private readonly retryDelayMs: number
  private rootFolderId = ''
  private rootFolderVerified = false
  private readonly folderIds = new Map<string, string>()

  constructor(options: GoogleDriveSyncProviderOptions) {
    this.folderName = options.folderName || DRIVE_ROOT_FOLDER
    this.rootFolderId = options.folderId || ''
    this.uploadRetryCount = options.uploadRetryCount ?? 2
    this.retryDelayMs = options.retryDelayMs ?? 350
    this.client = options.client ?? new GoogleDriveProvider({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      folderName: this.folderName,
      authPrompt: options.authPrompt,
    })
  }

  async signIn(): Promise<AuthSession> {
    const account = await this.client.signIn()
    return { provider: 'google-drive', signedInAt: nowIso(), account }
  }

  async signOut() {
    this.client.logout()
  }

  async ensureWorkspace(): Promise<WorkspaceRef> {
    await this.ensureRoot()
    await Promise.all(['devices', 'entries', 'attachments', 'filebox', 'transfers', 'conflicts', 'tombstones'].map((folder) => this.ensureFolderPath(folder)))
    return { id: this.rootFolderId, rootPath: this.folderName }
  }

  async ensureDeviceRecord(device: DeviceProfile) {
    await this.putJson(`devices/${safeDriveSegment(device.id, 'device')}.json`, device)
  }

  async getJson<T>(path: string): Promise<RemoteJson<T> | null> {
    const file = await this.findFile(path)
    if (!file) return null
    const value = await this.client.downloadJson<T>(file.id)
    return { ...driveFileToRemoteRef(path, file), value }
  }

  async putJson<T>(path: string, value: T): Promise<RemoteFileRef> {
    const { folderPath, fileName } = this.splitFilePath(path)
    const parentFolderId = await this.ensureFolderPath(folderPath)
    const fileId = await this.withUploadRetry(() => this.client.uploadJson(parentFolderId, fileName, value))
    const file = await this.findFile(path)
    return file ? driveFileToRemoteRef(path, file) : {
      id: fileId,
      path,
      name: fileName,
      mimeType: 'application/json',
      updatedAt: nowIso(),
    }
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

  async putBlob(path: string, blob: Blob, metadata: BlobMetadata): Promise<RemoteFileRef> {
    const { folderPath, fileName } = this.splitFilePath(path)
    const parentFolderId = await this.ensureFolderPath(folderPath)
    const fileId = await this.withUploadRetry(() => this.client.uploadBlob(parentFolderId, fileName, blob, metadata.mimeType, {
      sha256: metadata.sha256,
      appProperties: metadata.appProperties,
    }))
    const file = await this.findFile(path)
    return file ? driveFileToRemoteRef(path, file) : {
      id: fileId,
      path,
      name: fileName,
      mimeType: metadata.mimeType || blob.type || 'application/octet-stream',
      size: metadata.byteSize ?? blob.size,
      updatedAt: nowIso(),
    }
  }

  async loadManifest<T = unknown>() {
    return (await this.getJson<T>('manifest.json'))?.value ?? null
  }

  putManifest<T>(manifest: T) {
    return this.putJson('manifest.json', manifest)
  }

  async listManagedFiles(options: ListOptions = {}) {
    await this.ensureWorkspace()
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
