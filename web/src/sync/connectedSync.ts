import type {
  Attachment,
  DevicePlatform,
  DeviceProfile,
  Entry,
  FileBoxItem,
  SyncConflict,
  SyncEntityEnvelope,
  SyncManifest,
  TombstoneRecord,
  TransferRecord,
  TransferStatus,
} from '../domain/types'
import {
  DriveResumableOperationIdentityError,
  DriveResumableOperationStore,
  IndexedDbDriveResumableOperationPersistence,
  isPositiveDriveVersion,
  sha256Hex,
  stableStringify,
  type DriveResumableOperationIdentity,
  type DriveResumableOperationRecord,
} from './driveResumableOperations'

export const DRIVE_SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.file'
export const DRIVE_ROOT_FOLDER = 'Easylab Lab Notebook'
export const DRIVE_MIME_FOLDER = 'application/vnd.google-apps.folder'
const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
export const DEFAULT_WEB_OAUTH_CLIENT_ID =
  env?.VITE_GOOGLE_WEB_CLIENT_ID?.trim() ||
  '252347596316-dpi31hrfh0bl3ggnut5blq02bth0diip.apps.googleusercontent.com'
export const DEFAULT_DESKTOP_OAUTH_CLIENT_ID = env?.VITE_GOOGLE_DESKTOP_CLIENT_ID?.trim() || ''
const DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024
const DRIVE_MAX_PRIVATE_APP_PROPERTIES = 30
const DRIVE_MAX_PROPERTY_BYTES = 124
const DRIVE_REQUEST_RETRY_COUNT = 2
const GOOGLE_IDENTITY_LOAD_TIMEOUT_MS = 15_000
const GOOGLE_AUTH_TIMEOUT_MS = 45_000
const DRIVE_REQUEST_TIMEOUT_MS = 30_000
const DRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,trashed,version,parents,appProperties'
const DRIVE_TRANSACTION_GUARD_PROPERTY = 'easylabTransactionGuard'
const DRIVE_TRANSACTION_GUARD_LEASE_MS = 24 * 60 * 60 * 1000
const DRIVE_TRANSACTION_GUARD_RENEWAL_WINDOW_MS = 60 * 60 * 1000

export type StorageMode = 'local-only' | 'google-drive'

export type GoogleAccountProfile = {
  provider: 'google'
  email: string
  name?: string
  picture?: string
  subject?: string
  /** Stable local cache namespace; never sent to Drive. */
  storageScope?: string
}

export const CONNECTED_STORAGE_KEYS = {
  device: 'labnote.connected.device',
  fileBox: 'labnote.connected.fileBox',
  transfers: 'labnote.connected.transfers',
  conflicts: 'labnote.connected.conflicts',
  tombstones: 'labnote.connected.tombstones',
  drive: 'labnote.connected.googleDrive',
} as const

export type DriveConnectionState = {
  provider: 'google-drive'
  storageMode: StorageMode
  /**
   * Legacy single-client field kept so existing installs do not lose their saved OAuth setting.
   * New installs should prefer desktopClientId/webClientId.
   */
  clientId: string
  desktopClientId?: string
  desktopClientSecret?: string
  webClientId?: string
  folderName: string
  folderId?: string
  connectedAccount?: GoogleAccountProfile
  connectedAt?: string
  lastSyncAt?: string
  status: 'disconnected' | 'ready' | 'needs-auth' | 'syncing' | 'error'
  lastError?: string
}

export type DriveOAuthClientKind = 'desktop' | 'web'

export type ParsedGoogleOAuthClientConfig = {
  desktopClientId?: string
  desktopClientSecret?: string
  webClientId?: string
  importedKind: DriveOAuthClientKind | 'both' | 'unknown'
}

export type SyncProvider = {
  kind: 'google-drive'
  signIn(): Promise<GoogleAccountProfile | undefined>
  ensureRootFolder(): Promise<string>
  createRootFolder?(name: string): Promise<string>
  ensureFolder(parentFolderId: string, name: string): Promise<string>
  uploadJson<T>(parentFolderId: string, name: string, data: T): Promise<string>
  uploadBlob(parentFolderId: string, name: string, blob: Blob, mimeType?: string, metadata?: DriveBlobMetadata): Promise<string>
  conditionalUploadJson?<T>(request: DriveConditionalJsonWrite<T>): Promise<DriveFile>
  conditionalUploadBlob?(request: DriveConditionalBlobWrite): Promise<DriveFile>
  acquireWorkspaceTransactionGuard?(folderId: string, operationId: string): Promise<void>
  releaseWorkspaceTransactionGuard?(folderId: string, operationId: string): Promise<void>
  downloadJson<T>(fileId: string): Promise<T>
  downloadText?(fileId: string): Promise<string>
  downloadBlob(fileId: string): Promise<Blob>
  getFileMetadata(fileId: string): Promise<DriveFile>
  listFolder(parentFolderId: string, query?: string): Promise<DriveFile[]>
  logout(): void
}

export type DriveBlobMetadata = {
  sha256?: string
  appProperties?: Record<string, unknown>
}

export type DriveWritePrecondition =
  | { kind: 'must-match'; fileId: string; version: string }
  | { kind: 'must-not-exist'; operationId: string }

type DriveConditionalWriteBase = {
  parentFolderId: string
  path: string
  name: string
  precondition: DriveWritePrecondition
  appProperties?: Record<string, string>
  resumableOperationId?: string
  signal?: AbortSignal
}

export type DriveConditionalJsonWrite<T = unknown> = DriveConditionalWriteBase & {
  value: T
}

export type DriveConditionalBlobWrite = DriveConditionalWriteBase & {
  blob: Blob
  mimeType: string
  sha256: string
}

export class DriveWritePreconditionConflictError extends Error {}

export class DriveWriteAmbiguousCommitError extends Error {}

export type DriveFile = {
  id: string
  name: string
  mimeType?: string
  modifiedTime?: string
  size?: string
  trashed?: boolean
  version?: string
  parents?: string[]
  appProperties?: Record<string, string>
}

type TokenResponse = {
  access_token?: string
  error?: string
  error_description?: string
  scope?: string
}

type TokenClient = {
  requestAccessToken(config?: { prompt?: string; scope?: string }): void
}

type GoogleIdentity = {
  accounts?: {
    oauth2?: {
      initTokenClient(config: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
        error_callback?: (error: unknown) => void
      }): TokenClient
      revoke?(token: string, callback?: () => void): void
    }
  }
}

type NativeGoogleDriveAuth = {
  requestAccessToken: (options: { clientId: string; scope: string }) => Promise<{
    accessToken?: string
    expiresIn?: number
    scope?: string
    tokenType?: string
    account?: unknown
  }>
  disconnect?: (options?: { clientId?: string }) => Promise<{ ok: boolean; message?: string }>
}

function nowIso() {
  return new Date().toISOString()
}

function getNativeGoogleDriveAuth(): NativeGoogleDriveAuth | undefined {
  if (typeof window === 'undefined') return undefined
  const plugin = window.Capacitor?.Plugins?.GoogleDriveAuth
  if (!plugin?.requestAccessToken) return undefined
  if (window.Capacitor?.isNativePlatform && !window.Capacitor.isNativePlatform()) return undefined
  return plugin
}

function googleAuthErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const record = error as { error?: unknown; error_description?: unknown; message?: unknown; type?: unknown }
    const detail = [record.error_description, record.message, record.error, record.type]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (detail) return detail
  }
  return String(error || 'Google authorization failed.')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) globalThis.clearTimeout(timer)
  })
}

async function waitForGoogleIdentity(timeoutMs = GOOGLE_IDENTITY_LOAD_TIMEOUT_MS): Promise<GoogleIdentity> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const google = (globalThis as unknown as { google?: GoogleIdentity }).google
    if (google?.accounts?.oauth2) return google
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100))
  }
  throw new Error('Google Identity Services did not finish loading.')
}

export function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveJson<T>(key: string, value: T) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

export function normalizeDriveConnection(value?: Partial<DriveConnectionState> | null): DriveConnectionState {
  const legacyClientId = value?.clientId?.trim() || ''
  const webClientId = value?.webClientId?.trim() || legacyClientId || DEFAULT_WEB_OAUTH_CLIENT_ID
  const desktopClientId = value?.desktopClientId?.trim() || legacyClientId || DEFAULT_DESKTOP_OAUTH_CLIENT_ID
  const storageMode = value?.storageMode ?? (value?.folderId || value?.connectedAt || value?.lastSyncAt ? 'google-drive' : 'local-only')
  return {
    provider: 'google-drive',
    storageMode,
    clientId: legacyClientId,
    desktopClientId,
    desktopClientSecret: value?.desktopClientSecret ?? '',
    webClientId,
    folderName: value?.folderName || DRIVE_ROOT_FOLDER,
    folderId: value?.folderId,
    connectedAccount: normalizeGoogleAccountProfile(value?.connectedAccount),
    connectedAt: value?.connectedAt,
    lastSyncAt: value?.lastSyncAt,
    status: value?.status === 'syncing' ? 'needs-auth' : value?.status ?? 'disconnected',
    lastError: value?.lastError,
  }
}

export function getPreferredDriveOAuthClientKind(): DriveOAuthClientKind {
  if (typeof window !== 'undefined' && window.electronAPI?.requestGoogleDriveAccessToken) return 'desktop'
  return 'web'
}

export function resolveDriveClientId(
  connection: Pick<DriveConnectionState, 'clientId' | 'desktopClientId' | 'webClientId'>,
  preferredKind: DriveOAuthClientKind = getPreferredDriveOAuthClientKind()
) {
  const legacyClientId = connection.clientId.trim()
  const desktopClientId = connection.desktopClientId?.trim()
  const webClientId = connection.webClientId?.trim()
  const clientId = preferredKind === 'desktop'
    ? desktopClientId || legacyClientId || DEFAULT_DESKTOP_OAUTH_CLIENT_ID
    : webClientId || legacyClientId || DEFAULT_WEB_OAUTH_CLIENT_ID
  return { clientId, preferredKind }
}

function normalizeGoogleAccountProfile(value: unknown): GoogleAccountProfile | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<GoogleAccountProfile>
  if (record.provider !== 'google' || typeof record.email !== 'string' || !record.email.trim()) return undefined
  const subject = typeof record.subject === 'string' && record.subject.trim() ? record.subject.trim() : undefined
  const legacyScopeSource = subject || record.email.trim().toLowerCase()
  const legacyStorageScope = legacyScopeSource
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return {
    provider: 'google',
    email: record.email.trim(),
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined,
    picture: typeof record.picture === 'string' && record.picture.trim() ? record.picture.trim() : undefined,
    subject,
    // Preserve the old cache key for existing installs. New connections use
    // the collision-free resolver below and then persist that chosen scope.
    storageScope: typeof record.storageScope === 'string' && record.storageScope.trim()
      ? record.storageScope.trim()
      : legacyStorageScope || undefined,
  }
}

export function resolveGoogleAccountStorageScope(account?: GoogleAccountProfile) {
  const pinned = account?.storageScope?.trim()
  if (pinned) return pinned
  const raw = account?.subject || account?.email
  return raw ? encodeURIComponent(raw.trim().toLowerCase()) : ''
}

export function parseGoogleOAuthClientConfig(raw: string): ParsedGoogleOAuthClientConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`OAuth JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OAuth JSON must be an object downloaded from Google Cloud.')
  }

  const source = parsed as Record<string, unknown>
  const installed = source.installed && typeof source.installed === 'object'
    ? source.installed as Record<string, unknown>
    : undefined
  const web = source.web && typeof source.web === 'object'
    ? source.web as Record<string, unknown>
    : undefined
  const flat = !installed && !web ? source : undefined

  const readString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const desktopClientId = readString(installed?.client_id ?? installed?.clientId)
  const desktopClientSecret = readString(installed?.client_secret ?? installed?.clientSecret)
  const webClientId = readString(web?.client_id ?? web?.clientId)
  const flatClientId = readString(flat?.client_id ?? flat?.clientId)
  const flatClientSecret = readString(flat?.client_secret ?? flat?.clientSecret)
  const flatType = readString(flat?.type)

  const result: ParsedGoogleOAuthClientConfig = {
    importedKind: 'unknown',
  }

  if (desktopClientId) {
    result.desktopClientId = desktopClientId
    result.desktopClientSecret = desktopClientSecret
  }
  if (webClientId) {
    result.webClientId = webClientId
  }
  if (flatClientId) {
    if (flatType === 'web') {
      result.webClientId = flatClientId
    } else {
      result.desktopClientId = flatClientId
      result.desktopClientSecret = flatClientSecret
    }
  }

  if (result.desktopClientId && result.webClientId) result.importedKind = 'both'
  else if (result.desktopClientId) result.importedKind = 'desktop'
  else if (result.webClientId) result.importedKind = 'web'

  if (!result.desktopClientId && !result.webClientId) {
    throw new Error('OAuth JSON did not contain a Google client_id in an installed or web section.')
  }

  return result
}

export function detectDevicePlatform(): DevicePlatform {
  if (typeof navigator === 'undefined') return 'web'
  const ua = navigator.userAgent.toLowerCase()
  if (/ipad|tablet/.test(ua)) return 'tablet'
  if (/android|iphone|mobile/.test(ua)) return 'mobile'
  if (typeof window !== 'undefined' && window.electronAPI) return 'desktop'
  return 'web'
}

export function createDeviceProfile(existing?: Partial<DeviceProfile>): DeviceProfile {
  const now = nowIso()
  const platform = existing?.platform ?? detectDevicePlatform()
  const defaultName =
    platform === 'desktop'
      ? 'Desktop Lab Notebook'
      : platform === 'mobile'
        ? 'Mobile Lab Notebook'
        : platform === 'tablet'
          ? 'Tablet Lab Notebook'
          : 'Web Lab Notebook'

  return {
    id: existing?.id || `dev-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    name: existing?.name || defaultName,
    platform,
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
    userAgent: typeof navigator === 'undefined' ? existing?.userAgent : navigator.userAgent,
    appVersion: existing?.appVersion,
  }
}

export function fileSizeLabel(bytes?: number) {
  if (!bytes || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function transferStatusLabel(status: TransferStatus) {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'uploading':
      return 'Uploading'
    case 'available':
      return 'Available'
    case 'attached':
      return 'Attached'
    case 'failed':
      return 'Failed'
    case 'conflict':
      return 'Conflict'
    case 'removed':
      return 'Removed'
    default:
      return status
  }
}

export function makeFileBoxItem(params: {
  entryId: string
  attachmentId?: string
  filename: string
  filesize: string
  contentType?: string
  device: DeviceProfile
  status?: FileBoxItem['status']
  localObjectUrl?: string
}): FileBoxItem {
  const now = nowIso()
  return {
    id: `fb-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    entryId: params.entryId,
    attachmentId: params.attachmentId,
    filename: params.filename,
    filesize: params.filesize,
    contentType: params.contentType,
    sourceDeviceId: params.device.id,
    sourceDeviceName: params.device.name,
    status: params.status ?? 'available',
    createdAt: now,
    updatedAt: now,
    localObjectUrl: params.localObjectUrl,
  }
}

export function makeTransferRecord(params: {
  fileBoxItemId?: string
  entryId?: string
  attachmentId?: string
  filename: string
  device: DeviceProfile
  status?: TransferStatus
  bytesTotal?: number
}): TransferRecord {
  const now = nowIso()
  return {
    id: `tr-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    fileBoxItemId: params.fileBoxItemId,
    entryId: params.entryId,
    attachmentId: params.attachmentId,
    filename: params.filename,
    fromDeviceId: params.device.id,
    fromDeviceName: params.device.name,
    provider: 'google-drive',
    status: params.status ?? 'available',
    bytesTotal: params.bytesTotal,
    bytesTransferred: params.status === 'attached' ? params.bytesTotal : undefined,
    createdAt: now,
    updatedAt: now,
    completedAt: params.status === 'attached' ? now : undefined,
  }
}

export function createManifest(params: {
  device: DeviceProfile
  entries: Record<string, Entry>
  attachments: Attachment[]
  fileBoxItems: FileBoxItem[]
  transfers: TransferRecord[]
  folderName?: string
  previousManifest?: SyncManifest
}): SyncManifest {
  const now = nowIso()
  const previousDevices = params.previousManifest?.devices ?? []
  const devices = [...previousDevices.filter((device) => device.id !== params.device.id), params.device]
  return {
    version: 1,
    provider: 'google-drive',
    rootFolderName: params.folderName ?? DRIVE_ROOT_FOLDER,
    createdAt: params.previousManifest?.createdAt ?? now,
    updatedAt: now,
    devices,
    entryCount: Object.keys(params.entries).length,
    attachmentCount: params.attachments.length,
    fileBoxCount: params.fileBoxItems.length,
    transferCount: params.transfers.length,
  }
}

export function envelopeEntity<T>(
  kind: SyncEntityEnvelope<T>['kind'],
  id: string,
  payload: T,
  device: DeviceProfile,
  deletedAt?: string
): SyncEntityEnvelope<T> {
  return {
    id,
    kind,
    version: 1,
    updatedAt: nowIso(),
    updatedByDeviceId: device.id,
    deletedAt,
    payload,
  }
}

export function chooseEntityWinner<T extends { lastEditedDatetime?: string; updatedAt?: string }>(
  local: SyncEntityEnvelope<T>,
  remote: SyncEntityEnvelope<T>
): { winner: SyncEntityEnvelope<T>; conflict?: SyncConflict } {
  const localTime = Date.parse(local.payload.lastEditedDatetime ?? local.payload.updatedAt ?? local.updatedAt) || 0
  const remoteTime = Date.parse(remote.payload.lastEditedDatetime ?? remote.payload.updatedAt ?? remote.updatedAt) || 0
  if (localTime === remoteTime || local.updatedByDeviceId === remote.updatedByDeviceId) {
    return { winner: localTime >= remoteTime ? local : remote }
  }

  const winner = localTime >= remoteTime ? local : remote
  return {
    winner,
    conflict: {
      id: `conf-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
      entityKind: local.kind,
      entityId: local.id,
      localUpdatedAt: new Date(localTime).toISOString(),
      remoteUpdatedAt: new Date(remoteTime).toISOString(),
      detectedAt: nowIso(),
      resolution: 'kept-copy',
      summary: 'Both devices edited this entity; latest timestamp won and the older version should be preserved as a conflict copy.',
    },
  }
}

export function makeTombstone(entityKind: TombstoneRecord['entityKind'], entityId: string, device: DeviceProfile, reason?: string): TombstoneRecord {
  return {
    id: `del-${entityKind}-${entityId}`,
    entityKind,
    entityId,
    deletedAt: nowIso(),
    deletedByDeviceId: device.id,
    reason,
  }
}

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function multipartBody(metadata: Record<string, unknown>, blob: Blob) {
  const boundary = `easylab_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  )
  return { boundary, body }
}

function driveBlobAppProperties(metadata?: DriveBlobMetadata) {
  const entries = Object.entries(metadata?.appProperties ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const)
  const appProperties = Object.fromEntries(entries)
  if (metadata?.sha256) appProperties.sha256 = String(metadata.sha256)
  validateDriveAppProperties(appProperties)
  return Object.keys(appProperties).length > 0 ? appProperties : undefined
}

function validateDriveAppProperties(appProperties: Record<string, string>) {
  const normalizedEntries = Object.entries(appProperties)
  if (normalizedEntries.length > DRIVE_MAX_PRIVATE_APP_PROPERTIES) {
    throw new Error(`Google Drive supports at most ${DRIVE_MAX_PRIVATE_APP_PROPERTIES} private app properties per file.`)
  }
  for (const [key, value] of normalizedEntries) {
    const bytes = new TextEncoder().encode(key + value).byteLength
    if (bytes > DRIVE_MAX_PROPERTY_BYTES) {
      throw new Error(`Google Drive app property "${key}" exceeds the ${DRIVE_MAX_PROPERTY_BYTES}-byte UTF-8 limit.`)
    }
  }
}

class GoogleDriveRequestError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(`Google Drive request failed (${status}): ${detail}`)
    this.status = status
  }
}

function isRetryableDriveError(error: unknown) {
  if (error instanceof TypeError) return true
  if (error instanceof GoogleDriveRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return false
}

function isDriveRequestAbort(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

function throwIfDriveRequestAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('Google Drive request was cancelled.', 'AbortError')
}

export class GoogleDriveProvider implements SyncProvider {
  readonly kind = 'google-drive' as const
  private accessToken = ''
  private accountProfile: GoogleAccountProfile | undefined
  private tokenClient: TokenClient | null = null
  private readonly options: {
    clientId: string
    clientSecret?: string
    folderName?: string
    authPrompt?: string
    resumableOperationStore?: DriveResumableOperationStore
    testOnlyStorageScope?: string
  }
  private readonly resumableOperations: DriveResumableOperationStore

  constructor(options: {
    clientId: string
    clientSecret?: string
    folderName?: string
    authPrompt?: string
    resumableOperationStore?: DriveResumableOperationStore
    testOnlyStorageScope?: string
  }) {
    this.options = options
    this.resumableOperations = options.resumableOperationStore
      ?? new DriveResumableOperationStore(new IndexedDbDriveResumableOperationPersistence())
  }

  async signIn(): Promise<GoogleAccountProfile | undefined> {
    if (this.accessToken) return this.accountProfile
    const nativeGoogleDriveAuth = getNativeGoogleDriveAuth()
    if (nativeGoogleDriveAuth) {
      const token = await withTimeout(
        nativeGoogleDriveAuth.requestAccessToken({
          clientId: this.options.clientId,
          scope: DRIVE_SCOPE,
        }),
        GOOGLE_AUTH_TIMEOUT_MS,
        'Google sign-in timed out before Android returned authorization.'
      )
      if (!token?.accessToken) throw new Error('Native Google authorization did not return an access token.')
      this.accessToken = token.accessToken
      this.accountProfile = normalizeGoogleAccountProfile(token.account) ?? await this.fetchAccountProfile()
      return this.accountProfile
    }

    if (typeof window !== 'undefined' && window.electronAPI?.requestGoogleDriveAccessToken) {
      const token = await withTimeout(
        window.electronAPI.requestGoogleDriveAccessToken({
          clientId: this.options.clientId,
          clientSecret: this.options.clientSecret,
          scope: DRIVE_SCOPE,
        }),
        GOOGLE_AUTH_TIMEOUT_MS,
        'Google sign-in timed out before the desktop authorization finished.'
      )
      if (!token?.accessToken) throw new Error('Google authorization did not return an access token.')
      this.accessToken = token.accessToken
      this.accountProfile = token.account ?? await this.fetchAccountProfile()
      return this.accountProfile
    }

    const google = await this.loadIdentity()
    await withTimeout(new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        callback()
      }
      this.tokenClient = google.accounts!.oauth2!.initTokenClient({
        client_id: this.options.clientId,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          if (response.error || !response.access_token) {
            finish(() => reject(new Error(response.error_description || response.error || 'Google authorization failed.')))
            return
          }
          this.accessToken = response.access_token
          finish(() => resolve())
        },
        error_callback: (error) => finish(() => reject(new Error(googleAuthErrorMessage(error)))),
      })
      this.tokenClient.requestAccessToken({ prompt: this.options.authPrompt ?? 'consent' })
    }), GOOGLE_AUTH_TIMEOUT_MS, 'Google sign-in timed out before the authorization finished. Please try again.')
    this.accountProfile = await this.fetchAccountProfile()
    return this.accountProfile
  }

  logout() {
    const token = this.accessToken
    this.accessToken = ''
    this.accountProfile = undefined
    const google = (globalThis as unknown as { google?: GoogleIdentity }).google
    if (token && google?.accounts?.oauth2?.revoke) google.accounts.oauth2.revoke(token)
    if (typeof window !== 'undefined' && window.electronAPI?.disconnectGoogleDrive) {
      void window.electronAPI.disconnectGoogleDrive({ clientId: this.options.clientId })
    }
    const nativeGoogleDriveAuth = getNativeGoogleDriveAuth()
    if (nativeGoogleDriveAuth?.disconnect) {
      void nativeGoogleDriveAuth.disconnect({ clientId: this.options.clientId })
    }
  }

  private async fetchAccountProfile(): Promise<GoogleAccountProfile | undefined> {
    if (!this.accessToken) return undefined
    try {
      const profile = await this.request<{
        sub?: string
        email?: string
        name?: string
        picture?: string
      }>('https://openidconnect.googleapis.com/v1/userinfo')
      if (!profile.email) return undefined
      return {
        provider: 'google',
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        subject: profile.sub,
      }
    } catch {
      return undefined
    }
  }

  async ensureRootFolder(): Promise<string> {
    const folderName = this.options.folderName ?? DRIVE_ROOT_FOLDER
    const matches = await this.listFolder('root', `name = '${escapeDriveQuery(folderName)}' and mimeType = '${DRIVE_MIME_FOLDER}' and trashed = false`)
    if (matches[0]?.id) return matches[0].id

    return this.createRootFolder(folderName)
  }

  async createRootFolder(name: string): Promise<string> {
    const created = await this.request<DriveFile>('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: DRIVE_MIME_FOLDER }),
    })
    return created.id
  }

  async ensureFolder(parentFolderId: string, name: string): Promise<string> {
    const matches = await this.listFolder(parentFolderId, `name = '${escapeDriveQuery(name)}' and mimeType = '${DRIVE_MIME_FOLDER}'`)
    if (matches[0]?.id) return matches[0].id

    const created = await this.request<DriveFile>('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentFolderId], mimeType: DRIVE_MIME_FOLDER }),
    })
    return created.id
  }

  async listFolder(parentFolderId: string, query?: string): Promise<DriveFile[]> {
    const base = `'${escapeDriveQuery(parentFolderId)}' in parents and trashed = false`
    const q = query ? `${base} and ${query}` : base
    const url = new URL('https://www.googleapis.com/drive/v3/files')
    url.searchParams.set('q', q)
    url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size,trashed,version,parents,appProperties)')
    const result = await this.request<{ files?: DriveFile[] }>(url.toString())
    return result.files ?? []
  }

  async getFileMetadata(fileId: string): Promise<DriveFile> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,trashed,version,parents,appProperties')
    return this.request<DriveFile>(url.toString())
  }

  async uploadJson<T>(parentFolderId: string, name: string, data: T): Promise<string> {
    return this.upsertFile(parentFolderId, name, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  }

  async uploadBlob(parentFolderId: string, name: string, blob: Blob, mimeType?: string, metadata?: DriveBlobMetadata): Promise<string> {
    const normalizedBlob = mimeType && blob.type !== mimeType ? blob.slice(0, blob.size, mimeType) : blob
    return this.upsertFile(parentFolderId, name, normalizedBlob, {
      resumable: normalizedBlob.size >= DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES,
      appProperties: driveBlobAppProperties(metadata),
    })
  }

  async conditionalUploadJson<T>(request: DriveConditionalJsonWrite<T>): Promise<DriveFile> {
    const content = new Blob([JSON.stringify(request.value, null, 2)], { type: 'application/json' })
    if (content.size >= DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
      throw new Error('Drive conditional JSON payload exceeds the multipart upload limit.')
    }
    return this.conditionalWrite({
      ...request,
      blob: content,
      mimeType: 'application/json',
      sha256: await sha256Hex(content),
    })
  }

  async conditionalUploadBlob(request: DriveConditionalBlobWrite): Promise<DriveFile> {
    const mimeType = request.mimeType.split(';')[0].trim().toLowerCase()
    if (!mimeType.includes('/') || mimeType.startsWith('application/vnd.google-apps.')) {
      throw new Error(`Drive blob MIME type is invalid: ${request.path}`)
    }
    const actualSha256 = await sha256Hex(request.blob)
    if (actualSha256 !== request.sha256.toLowerCase()) {
      throw new Error(`Drive blob SHA-256 does not match its bytes: ${request.path}`)
    }
    return this.conditionalWrite({ ...request, mimeType, sha256: actualSha256 })
  }

  async acquireWorkspaceTransactionGuard(folderId: string, operationId: string) {
    if (!/^[0-9a-f]{64}$/.test(operationId)) {
      throw new DriveWritePreconditionConflictError('Drive transaction guard identity is invalid.')
    }
    const snapshot = await this.getMetadataSnapshot(folderId)
    if (snapshot.file.mimeType !== DRIVE_MIME_FOLDER || snapshot.file.trashed === true || !snapshot.etag) {
      throw new DriveWritePreconditionConflictError('Drive transaction guard requires a verified active workspace folder.')
    }
    const now = Date.now()
    const existingValue = snapshot.file.appProperties?.[DRIVE_TRANSACTION_GUARD_PROPERTY]
    const existing = this.parseWorkspaceTransactionGuard(existingValue)
    if (existingValue && !existing) {
      throw new DriveWritePreconditionConflictError('Drive transaction guard metadata is malformed.')
    }
    if (existing && existing.operationId !== operationId && existing.expiresAt > now) {
      throw new DriveWritePreconditionConflictError('Another Drive transaction holds the workspace guard.')
    }
    if (existing?.operationId === operationId && existing.expiresAt > now + DRIVE_TRANSACTION_GUARD_RENEWAL_WINDOW_MS) {
      return
    }

    const leaseValue = `${operationId}:${now + DRIVE_TRANSACTION_GUARD_LEASE_MS}`
    try {
      await this.requestRawNoRetry(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'If-Match': snapshot.etag },
          body: JSON.stringify({
            appProperties: {
              ...(snapshot.file.appProperties ?? {}),
              [DRIVE_TRANSACTION_GUARD_PROPERTY]: leaseValue,
            },
          }),
        },
      )
    } catch (error) {
      const reconciled = await this.getMetadataSnapshot(folderId).catch(() => undefined)
      if (reconciled?.file.appProperties?.[DRIVE_TRANSACTION_GUARD_PROPERTY] === leaseValue) return
      if (this.isDrivePreconditionFailure(error)) {
        throw new DriveWritePreconditionConflictError('Drive transaction guard raced with another workspace update.')
      }
      throw error
    }
    const verified = await this.getMetadataSnapshot(folderId)
    if (verified.file.appProperties?.[DRIVE_TRANSACTION_GUARD_PROPERTY] !== leaseValue) {
      throw new DriveWritePreconditionConflictError('Drive transaction guard acquisition could not be verified.')
    }
  }

  async releaseWorkspaceTransactionGuard(folderId: string, operationId: string) {
    if (!/^[0-9a-f]{64}$/.test(operationId)) {
      throw new DriveWritePreconditionConflictError('Drive transaction guard identity is invalid.')
    }
    const snapshot = await this.getMetadataSnapshot(folderId)
    const existingValue = snapshot.file.appProperties?.[DRIVE_TRANSACTION_GUARD_PROPERTY]
    if (!existingValue) return
    const existing = this.parseWorkspaceTransactionGuard(existingValue)
    if (!existing || existing.operationId !== operationId || !snapshot.etag) {
      throw new DriveWritePreconditionConflictError('Drive transaction guard changed before release.')
    }
    try {
      await this.requestRawNoRetry(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'If-Match': snapshot.etag },
          body: JSON.stringify({ appProperties: { [DRIVE_TRANSACTION_GUARD_PROPERTY]: null } }),
        },
      )
    } catch (error) {
      const reconciled = await this.getMetadataSnapshot(folderId).catch(() => undefined)
      if (!reconciled?.file.appProperties?.[DRIVE_TRANSACTION_GUARD_PROPERTY]) return
      const holder = this.parseWorkspaceTransactionGuard(
        reconciled.file.appProperties[DRIVE_TRANSACTION_GUARD_PROPERTY],
      )
      if (!holder || holder.operationId !== operationId || this.isDrivePreconditionFailure(error)) {
        throw new DriveWritePreconditionConflictError('Drive transaction guard changed before release.')
      }
      throw error
    }
    const verified = await this.getMetadataSnapshot(folderId)
    if (verified.file.appProperties?.[DRIVE_TRANSACTION_GUARD_PROPERTY]) {
      throw new DriveWritePreconditionConflictError('Drive transaction guard release could not be verified.')
    }
  }

  private parseWorkspaceTransactionGuard(value?: string) {
    if (!value) return undefined
    const match = value.match(/^([0-9a-f]{64}):(\d{1,16})$/)
    if (!match) return undefined
    const expiresAt = Number.parseInt(match[2], 10)
    return Number.isSafeInteger(expiresAt) && expiresAt > 0
      ? { operationId: match[1], expiresAt }
      : undefined
  }

  private async conditionalWrite(request: DriveConditionalBlobWrite): Promise<DriveFile> {
    throwIfDriveRequestAborted(request.signal)
    if (!request.path.trim() || !request.name.trim()) throw new Error('Drive conditional path is invalid.')
    const useResumable = request.blob.size >= DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES
    const appProperties = {
      ...(request.appProperties ?? {}),
      sha256: request.sha256,
    }
    validateDriveAppProperties(appProperties)
    const storageScope = useResumable ? this.requireResumableStorageScope() : undefined
    const matches = await this.findExactPathOccupants(request.parentFolderId, request.name)
    let identity: DriveResumableOperationIdentity | undefined

    if (request.precondition.kind === 'must-match') {
      if (!isPositiveDriveVersion(request.precondition.version)) {
        throw new DriveWritePreconditionConflictError('Drive conditional update requires a positive version.')
      }
      if (matches.length !== 1 || matches[0].id !== request.precondition.fileId) {
        throw new DriveWritePreconditionConflictError('Drive path no longer has the expected unique file.')
      }
      if (useResumable) {
        const operationId = request.resumableOperationId?.trim()
        if (!operationId) throw new Error('Drive resumable update requires a stable operation id.')
        const previouslyBound = await this.resumableOperations.read(storageScope!, operationId)
        identity = {
          operationId,
          path: request.path,
          mimeType: request.mimeType,
          byteSize: request.blob.size,
          sha256: request.sha256,
          appProperties,
          target: {
            kind: 'existing',
            fileId: request.precondition.fileId,
            expectedVersion: request.precondition.version,
          },
        }
        const record = await this.resumableOperations.begin(storageScope!, identity)
        if (previouslyBound || record.state === 'completed') {
          const reconciled = await this.tryVerifyConditionalWrite({
            ...request,
            appProperties,
            fileId: request.precondition.fileId,
            minimumExclusiveVersion: request.precondition.version,
          })
          if (reconciled) {
            await this.resumableOperations.markCompleted(storageScope!, identity, reconciled.version!)
            return reconciled
          }
          if (record.state === 'completed') {
            throw new DriveWritePreconditionConflictError('Completed Drive update no longer matches its file.')
          }
        }
      } else if (request.resumableOperationId) {
        throw new Error('Drive multipart update must not include a resumable operation id.')
      }
      return this.updateConditional(
        { ...request, precondition: request.precondition },
        appProperties,
        identity,
        storageScope,
      )
    }

    if (!request.precondition.operationId.trim()) {
      throw new Error('Drive create-only write requires a stable operation id.')
    }
    if (request.resumableOperationId && request.resumableOperationId !== request.precondition.operationId) {
      throw new DriveResumableOperationIdentityError('Drive create-only resumable operation ids do not match.')
    }
    const fingerprint = await this.creationFingerprint(request, appProperties)
    const intendedAppProperties = { ...appProperties, easylabCreateFingerprint: fingerprint }
    validateDriveAppProperties(intendedAppProperties)
    const reservationKey = `elcr_${(await sha256Hex(request.path)).slice(0, 24)}`
    const reservationValue = await sha256Hex(`${request.precondition.operationId}\u0000${fingerprint}`)
    let generatedFileId: string | undefined
    let resumableRecord: DriveResumableOperationRecord | undefined
    if (useResumable) {
      const existing = await this.resumableOperations.read(storageScope!, request.precondition.operationId)
      if (existing) {
        if (existing.identity.target.kind !== 'new') {
          throw new DriveResumableOperationIdentityError('Drive operation id is bound to an existing-file update.')
        }
        generatedFileId = existing.identity.target.fileId
        identity = {
          operationId: request.precondition.operationId,
          path: request.path,
          mimeType: request.mimeType,
          byteSize: request.blob.size,
          sha256: request.sha256,
          appProperties: intendedAppProperties,
          target: { kind: 'new', fileId: generatedFileId, creationFingerprint: fingerprint },
        }
        resumableRecord = await this.resumableOperations.begin(storageScope!, identity)
      }
    }
    if (matches.length > 0) {
      if (matches.length === 1 && (!useResumable || generatedFileId)) {
        const reconciled = await this.reconcileCreatedWrite(request, intendedAppProperties, generatedFileId)
        if (reconciled) {
          if (identity) await this.resumableOperations.markCompleted(storageScope!, identity, reconciled.version!)
          await this.releaseCreateReservation(request.parentFolderId, reservationKey, reservationValue)
          return reconciled
        }
      }
      throw new DriveWritePreconditionConflictError('Drive create-only path is already occupied.')
    }

    if (useResumable) {
      if (!identity) {
        generatedFileId = await this.generateFileId()
        identity = {
          operationId: request.precondition.operationId,
          path: request.path,
          mimeType: request.mimeType,
          byteSize: request.blob.size,
          sha256: request.sha256,
          appProperties: intendedAppProperties,
          target: { kind: 'new', fileId: generatedFileId, creationFingerprint: fingerprint },
        }
        resumableRecord = await this.resumableOperations.begin(storageScope!, identity)
      }
      if (resumableRecord?.state === 'completed') {
        throw new DriveWritePreconditionConflictError('Completed Drive create operation no longer matches its file.')
      }
    } else if (request.resumableOperationId) {
      throw new Error('Drive multipart creation must not include a resumable operation id.')
    }
    throwIfDriveRequestAborted(request.signal)
    await this.acquireCreateReservation(request.parentFolderId, reservationKey, reservationValue)
    try {
      const created = await this.createConditional(
        { ...request, precondition: request.precondition },
        intendedAppProperties,
        generatedFileId,
        identity,
        storageScope,
      )
      await this.releaseCreateReservation(request.parentFolderId, reservationKey, reservationValue)
      return created
    } catch (error) {
      if (error instanceof DriveWritePreconditionConflictError) {
        await this.releaseCreateReservation(request.parentFolderId, reservationKey, reservationValue)
      }
      throw error
    }
  }

  private async updateConditional(
    request: DriveConditionalBlobWrite & { precondition: Extract<DriveWritePrecondition, { kind: 'must-match' }> },
    appProperties: Record<string, string>,
    identity?: DriveResumableOperationIdentity,
    storageScope?: string,
  ) {
    const fresh = await this.getMetadataSnapshot(request.precondition.fileId)
    if (!this.matchesExpectedTarget(fresh.file, request, request.precondition.version)) {
      throw new DriveWritePreconditionConflictError('Drive file changed before the conditional update.')
    }
    if (!fresh.etag) throw new Error('Drive metadata omitted the ETag required for a conditional update.')
    const mergedAppProperties = { ...(fresh.file.appProperties ?? {}), ...appProperties }
    const useResumable = request.blob.size >= DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES
    let mutationStarted = false
    let uploadSessionStarted = false
    try {
      throwIfDriveRequestAborted(request.signal)
      mutationStarted = true
      if (useResumable) {
        const session = await this.requestRawNoRetry(
          `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(request.precondition.fileId)}?uploadType=resumable&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'If-Match': fresh.etag,
              'X-Upload-Content-Type': request.mimeType,
              'X-Upload-Content-Length': String(request.blob.size),
            },
            body: JSON.stringify({ name: request.name, mimeType: request.mimeType, appProperties: mergedAppProperties }),
            signal: request.signal,
          },
        )
        const location = session.headers.get('Location')
        if (!location) throw new Error('Google Drive did not return a resumable upload session URL.')
        uploadSessionStarted = true
        await this.requestRawNoRetry(location, {
          method: 'PUT',
          headers: { 'Content-Type': request.mimeType },
          body: request.blob,
          signal: request.signal,
        })
      } else {
        const { body } = multipartBody({
          name: request.name,
          mimeType: request.mimeType,
          appProperties: mergedAppProperties,
        }, request.blob)
        await this.requestRawNoRetry(
          `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(request.precondition.fileId)}?uploadType=multipart&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
          { method: 'PATCH', headers: { 'If-Match': fresh.etag }, body, signal: request.signal },
        )
      }
      const verified = await this.verifyConditionalWrite({
        ...request,
        appProperties: mergedAppProperties,
        fileId: request.precondition.fileId,
        minimumExclusiveVersion: request.precondition.version,
      })
      if (identity) await this.resumableOperations.markCompleted(storageScope!, identity, verified.version!)
      return verified
    } catch (error) {
      if (this.isDrivePreconditionFailure(error) && !uploadSessionStarted) {
        throw new DriveWritePreconditionConflictError('Drive rejected a stale conditional update.')
      }
      if (mutationStarted) {
        const reconciled = await this.tryVerifyConditionalWrite({
          ...request,
          appProperties: mergedAppProperties,
          fileId: request.precondition.fileId,
          minimumExclusiveVersion: request.precondition.version,
        })
        if (reconciled) {
          if (identity) await this.resumableOperations.markCompleted(storageScope!, identity, reconciled.version!)
          return reconciled
        }
        if (identity) await this.resumableOperations.markAmbiguous(storageScope!, identity)
        if (isDriveRequestAbort(error)) throw error
        throw new DriveWriteAmbiguousCommitError(`Drive update may have committed but could not be verified: ${request.path}`)
      }
      throw error
    }
  }

  private async createConditional(
    request: DriveConditionalBlobWrite & { precondition: Extract<DriveWritePrecondition, { kind: 'must-not-exist' }> },
    appProperties: Record<string, string>,
    generatedFileId?: string,
    identity?: DriveResumableOperationIdentity,
    storageScope?: string,
  ) {
    if ((await this.findExactPathOccupants(request.parentFolderId, request.name)).length > 0) {
      throw new DriveWritePreconditionConflictError('Drive create-only path became occupied before upload.')
    }
    const useResumable = request.blob.size >= DRIVE_RESUMABLE_UPLOAD_THRESHOLD_BYTES
    let mutationStarted = false
    let uploadSessionStarted = false
    try {
      throwIfDriveRequestAborted(request.signal)
      mutationStarted = true
      if (useResumable) {
        const session = await this.requestRawNoRetry(
          `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Type': request.mimeType,
              'X-Upload-Content-Length': String(request.blob.size),
            },
            body: JSON.stringify({
              id: generatedFileId,
              name: request.name,
              mimeType: request.mimeType,
              parents: [request.parentFolderId],
              appProperties,
            }),
            signal: request.signal,
          },
        )
        const location = session.headers.get('Location')
        if (!location) throw new Error('Google Drive did not return a resumable upload session URL.')
        uploadSessionStarted = true
        await this.requestRawNoRetry(location, {
          method: 'PUT',
          headers: { 'Content-Type': request.mimeType },
          body: request.blob,
          signal: request.signal,
        })
      } else {
        const { body } = multipartBody({
          name: request.name,
          mimeType: request.mimeType,
          parents: [request.parentFolderId],
          appProperties,
        }, request.blob)
        await this.requestRawNoRetry(
          `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
          { method: 'POST', body, signal: request.signal },
        )
      }
      const matches = await this.findExactPathOccupants(request.parentFolderId, request.name)
      if (matches.length !== 1) throw new DriveWritePreconditionConflictError('Drive create did not produce one unique path occupant.')
      if (generatedFileId && matches[0].id !== generatedFileId) {
        throw new DriveWritePreconditionConflictError('Drive resumable creation used an unexpected file id.')
      }
      const verified = await this.verifyConditionalWrite({
        ...request,
        appProperties,
        fileId: matches[0].id,
        minimumExclusiveVersion: '0',
      })
      if (identity) await this.resumableOperations.markCompleted(storageScope!, identity, verified.version!)
      return verified
    } catch (error) {
      if (this.isDrivePreconditionFailure(error) && !uploadSessionStarted) {
        throw new DriveWritePreconditionConflictError('Drive rejected the create-only write.')
      }
      if (mutationStarted) {
        const reconciled = await this.reconcileCreatedWrite(request, appProperties, generatedFileId)
        if (reconciled) {
          if (identity) await this.resumableOperations.markCompleted(storageScope!, identity, reconciled.version!)
          return reconciled
        }
        if (identity) await this.resumableOperations.markAmbiguous(storageScope!, identity)
        if (isDriveRequestAbort(error)) throw error
        throw new DriveWriteAmbiguousCommitError(`Drive creation may have committed but could not be verified: ${request.path}`)
      }
      throw error
    }
  }

  async downloadJson<T>(fileId: string): Promise<T> {
    return this.request<T>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
  }

  async downloadText(fileId: string): Promise<string> {
    const response = await this.requestRaw(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    )
    return response.text()
  }

  async downloadBlob(fileId: string): Promise<Blob> {
    const response = await this.requestRaw(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
    return response.blob()
  }

  private requireResumableStorageScope() {
    const testScope = this.options.testOnlyStorageScope?.trim()
    if (testScope) return testScope
    const pinned = this.accountProfile?.storageScope?.trim()
    if (pinned) return pinned
    const subject = this.accountProfile?.subject?.trim()
    if (subject) return encodeURIComponent(subject.toLowerCase())
    throw new Error('Drive resumable writes require an account-scoped local storage identity.')
  }

  private async findExactPathOccupants(parentFolderId: string, name: string) {
    return this.listFolder(
      parentFolderId,
      `name = '${escapeDriveQuery(name)}' and mimeType != '${DRIVE_MIME_FOLDER}'`,
    )
  }

  private async getMetadataSnapshot(fileId: string): Promise<{ file: DriveFile; etag: string }> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('fields', DRIVE_FILE_FIELDS)
    const response = await this.requestRawNoRetry(url.toString(), {
      headers: { 'Cache-Control': 'no-cache' },
    })
    return {
      file: await response.json() as DriveFile,
      etag: response.headers.get('ETag')?.trim() ?? '',
    }
  }

  private async acquireCreateReservation(parentFolderId: string, key: string, value: string) {
    const snapshot = await this.getMetadataSnapshot(parentFolderId)
    if (snapshot.file.mimeType !== DRIVE_MIME_FOLDER || snapshot.file.trashed === true || !snapshot.etag) {
      throw new DriveWritePreconditionConflictError('Drive create reservation parent is not a verified active folder.')
    }
    const existing = snapshot.file.appProperties?.[key]
    if (existing) {
      if (existing === value) return
      throw new DriveWritePreconditionConflictError('Drive path has another active create reservation.')
    }
    try {
      await this.requestRawNoRetry(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parentFolderId)}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'If-Match': snapshot.etag },
          body: JSON.stringify({ appProperties: { ...(snapshot.file.appProperties ?? {}), [key]: value } }),
        },
      )
    } catch (error) {
      if (this.isDrivePreconditionFailure(error)) {
        throw new DriveWritePreconditionConflictError('Drive create reservation raced with another folder update.')
      }
      throw error
    }
    const verified = await this.getMetadataSnapshot(parentFolderId)
    if (verified.file.appProperties?.[key] !== value) {
      throw new DriveWritePreconditionConflictError('Drive create reservation could not be verified.')
    }
  }

  private async releaseCreateReservation(parentFolderId: string, key: string, value: string) {
    const snapshot = await this.getMetadataSnapshot(parentFolderId)
    const existing = snapshot.file.appProperties?.[key]
    if (!existing) return
    if (existing !== value || !snapshot.etag) {
      throw new DriveWritePreconditionConflictError('Drive create reservation changed before release.')
    }
    try {
      await this.requestRawNoRetry(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parentFolderId)}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'If-Match': snapshot.etag },
          body: JSON.stringify({ appProperties: { [key]: null } }),
        },
      )
    } catch (error) {
      if (this.isDrivePreconditionFailure(error)) {
        throw new DriveWritePreconditionConflictError('Drive create reservation changed before release.')
      }
      throw error
    }
  }

  private matchesExpectedTarget(
    file: DriveFile,
    request: DriveConditionalBlobWrite,
    expectedVersion: string,
  ) {
    return file.id === (request.precondition.kind === 'must-match' ? request.precondition.fileId : file.id)
      && file.name === request.name
      && file.mimeType === request.mimeType
      && file.trashed !== true
      && file.version === expectedVersion
      && file.parents?.length === 1
      && file.parents[0] === request.parentFolderId
  }

  private async verifyConditionalWrite(request: DriveConditionalBlobWrite & {
    appProperties: Record<string, string>
    fileId: string
    minimumExclusiveVersion: string
  }) {
    const matches = await this.findExactPathOccupants(request.parentFolderId, request.name)
    if (matches.length !== 1 || matches[0].id !== request.fileId) {
      throw new DriveWritePreconditionConflictError('Drive write verification found a missing or duplicate path.')
    }
    const first = await this.getMetadataSnapshot(request.fileId)
    if (
      first.file.id !== request.fileId
      || first.file.name !== request.name
      || first.file.mimeType !== request.mimeType
      || first.file.trashed === true
      || first.file.parents?.length !== 1
      || first.file.parents[0] !== request.parentFolderId
      || !isPositiveDriveVersion(first.file.version)
      || BigInt(first.file.version) <= BigInt(request.minimumExclusiveVersion)
    ) {
      throw new DriveWritePreconditionConflictError('Drive write metadata did not match the intended target.')
    }
    for (const [key, value] of Object.entries(request.appProperties)) {
      if (first.file.appProperties?.[key] !== value) {
        throw new DriveWritePreconditionConflictError('Drive write app properties did not verify.')
      }
    }
    const remoteBlob = await this.downloadBlob(request.fileId)
    if (remoteBlob.size !== request.blob.size || await sha256Hex(remoteBlob) !== request.sha256) {
      throw new DriveWritePreconditionConflictError('Drive write content did not verify.')
    }
    const second = await this.getMetadataSnapshot(request.fileId)
    if (
      second.file.version !== first.file.version
      || second.file.modifiedTime !== first.file.modifiedTime
      || stableStringify(second.file.appProperties ?? {}) !== stableStringify(first.file.appProperties ?? {})
      || second.file.trashed === true
    ) {
      throw new DriveWritePreconditionConflictError('Drive metadata changed during post-write verification.')
    }
    return first.file
  }

  private async tryVerifyConditionalWrite(request: DriveConditionalBlobWrite & {
    appProperties: Record<string, string>
    fileId: string
    minimumExclusiveVersion: string
  }) {
    try {
      return await this.verifyConditionalWrite(request)
    } catch {
      return undefined
    }
  }

  private async reconcileCreatedWrite(
    request: DriveConditionalBlobWrite,
    appProperties: Record<string, string>,
    generatedFileId?: string,
  ) {
    const matches = await this.findExactPathOccupants(request.parentFolderId, request.name)
    if (matches.length !== 1 || (generatedFileId && matches[0].id !== generatedFileId)) return undefined
    return this.tryVerifyConditionalWrite({
      ...request,
      appProperties,
      fileId: matches[0].id,
      minimumExclusiveVersion: '0',
    })
  }

  private creationFingerprint(
    request: DriveConditionalBlobWrite,
    appProperties: Record<string, string>,
  ) {
    return sha256Hex(stableStringify({
      path: request.path,
      mimeType: request.mimeType,
      byteSize: request.blob.size,
      sha256: request.sha256,
      appProperties,
    }))
  }

  private async generateFileId() {
    const url = new URL('https://www.googleapis.com/drive/v3/files/generateIds')
    url.searchParams.set('count', '1')
    url.searchParams.set('space', 'drive')
    url.searchParams.set('type', 'files')
    const response = await this.requestRawNoRetry(url.toString())
    const value = await response.json() as { ids?: string[] }
    const id = value.ids?.[0]?.trim()
    if (!id) throw new Error('Google Drive did not generate a file id for resumable creation.')
    return id
  }

  private isDrivePreconditionFailure(error: unknown) {
    return error instanceof GoogleDriveRequestError && [404, 409, 412].includes(error.status)
  }

  private async upsertFile(
    parentFolderId: string,
    name: string,
    blob: Blob,
    options: { resumable?: boolean; appProperties?: Record<string, string> } = {},
  ): Promise<string> {
    const existing = await this.listFolder(parentFolderId, `name = '${escapeDriveQuery(name)}'`)
    const existingId = existing[0]?.id
    if (options.resumable) {
      return this.resumableUpsertFile(parentFolderId, name, blob, existingId, options.appProperties)
    }
    const metadata = existingId
      ? { name, ...(options.appProperties ? { appProperties: options.appProperties } : {}) }
      : { name, parents: [parentFolderId], ...(options.appProperties ? { appProperties: options.appProperties } : {}) }
    const { body } = multipartBody(metadata, blob)
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id'
    const created = await this.request<DriveFile>(url, {
      method: existingId ? 'PATCH' : 'POST',
      body,
    })
    return created.id
  }

  private async resumableUpsertFile(
    parentFolderId: string,
    name: string,
    blob: Blob,
    existingId?: string,
    appProperties?: Record<string, string>,
  ): Promise<string> {
    const metadata = existingId
      ? { name, ...(appProperties ? { appProperties } : {}) }
      : { name, parents: [parentFolderId], ...(appProperties ? { appProperties } : {}) }
    const sessionUrl = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=resumable&fields=id`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id'
    const sessionResponse = await this.requestRaw(sessionUrl, {
      method: existingId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': blob.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(metadata),
    })
    const uploadUrl = sessionResponse.headers.get('Location')
    if (!uploadUrl) throw new Error('Google Drive did not return a resumable upload session URL.')
    const uploaded = await this.request<DriveFile>(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    return uploaded.id
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestRaw(url, init)
    return (await response.json()) as T
  }

  private async requestRaw(url: string, init: RequestInit = {}): Promise<Response> {
    return this.withRequestRetry(() => this.requestRawNoRetry(url, init))
  }

  private async requestRawNoRetry(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.accessToken) throw new Error('Google Drive is not authorized.')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.accessToken}`)
    const controller = new AbortController()
    const callerSignal = init.signal
    let callerAborted = callerSignal?.aborted === true
    const abortFromCaller = () => {
      callerAborted = true
      controller.abort(callerSignal?.reason)
    }
    if (callerSignal) {
      if (callerSignal.aborted) abortFromCaller()
      else callerSignal.addEventListener('abort', abortFromCaller, { once: true })
    }
    const timeout = globalThis.setTimeout(() => controller.abort(), DRIVE_REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url, { ...init, headers, signal: controller.signal })
    } catch (error) {
      if (isDriveRequestAbort(error) && callerAborted) {
        throwIfDriveRequestAborted(callerSignal)
      }
      if (isDriveRequestAbort(error)) {
        throw new Error('Google Drive request timed out. Check your connection and try again.')
      }
      throw error
    } finally {
      globalThis.clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new GoogleDriveRequestError(response.status, detail || response.statusText)
    }
    return response
  }

  private async withRequestRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= DRIVE_REQUEST_RETRY_COUNT; attempt += 1) {
      try {
        return await operation()
      } catch (err) {
        lastError = err
        if (attempt >= DRIVE_REQUEST_RETRY_COUNT || !isRetryableDriveError(err)) break
        await new Promise((resolve) => globalThis.setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
    throw lastError
  }

  private async loadIdentity(): Promise<GoogleIdentity> {
    const existing = (globalThis as unknown as { google?: GoogleIdentity }).google
    if (existing?.accounts?.oauth2) return existing

    await withTimeout(new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>('script[data-easylab-gis="1"]')
      if (existingScript) {
        if (existingScript.dataset.easylabGisLoaded === '1') {
          resolve()
          return
        }
        existingScript.addEventListener('load', () => resolve(), { once: true })
        existingScript.addEventListener('error', reject, { once: true })
        return
      }
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.dataset.easylabGis = '1'
      script.onload = () => {
        script.dataset.easylabGisLoaded = '1'
        resolve()
      }
      script.onerror = () => reject(new Error('Unable to load Google Identity Services.'))
      document.head.appendChild(script)
    }), GOOGLE_IDENTITY_LOAD_TIMEOUT_MS, 'Google Identity Services did not finish loading.')

    return waitForGoogleIdentity()
  }
}
