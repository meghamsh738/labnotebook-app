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

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DRIVE_ROOT_FOLDER = 'Easylab Lab Notebook'
export const DRIVE_MIME_FOLDER = 'application/vnd.google-apps.folder'

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
  clientId: string
  folderName: string
  folderId?: string
  connectedAt?: string
  lastSyncAt?: string
  status: 'disconnected' | 'ready' | 'needs-auth' | 'syncing' | 'error'
  lastError?: string
}

export type SyncProvider = {
  kind: 'google-drive'
  signIn(): Promise<void>
  ensureRootFolder(): Promise<string>
  ensureFolder(parentFolderId: string, name: string): Promise<string>
  uploadJson<T>(parentFolderId: string, name: string, data: T): Promise<string>
  uploadBlob(parentFolderId: string, name: string, blob: Blob, mimeType?: string): Promise<string>
  downloadJson<T>(fileId: string): Promise<T>
  downloadBlob(fileId: string): Promise<Blob>
  listFolder(parentFolderId: string, query?: string): Promise<DriveFile[]>
  logout(): void
}

export type DriveFile = {
  id: string
  name: string
  mimeType?: string
  modifiedTime?: string
  size?: string
}

type TokenResponse = {
  access_token?: string
  error?: string
  error_description?: string
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

function nowIso() {
  return new Date().toISOString()
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
}): SyncManifest {
  const now = nowIso()
  return {
    version: 1,
    provider: 'google-drive',
    rootFolderName: params.folderName ?? DRIVE_ROOT_FOLDER,
    createdAt: now,
    updatedAt: now,
    devices: [params.device],
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

export class GoogleDriveProvider implements SyncProvider {
  readonly kind = 'google-drive' as const
  private accessToken = ''
  private tokenClient: TokenClient | null = null
  private readonly options: { clientId: string; folderName?: string }

  constructor(options: { clientId: string; folderName?: string }) {
    this.options = options
  }

  async signIn(): Promise<void> {
    if (typeof window !== 'undefined' && window.electronAPI?.requestGoogleDriveAccessToken) {
      const token = await window.electronAPI.requestGoogleDriveAccessToken({
        clientId: this.options.clientId,
        scope: DRIVE_SCOPE,
      })
      if (!token?.accessToken) throw new Error('Google authorization did not return an access token.')
      this.accessToken = token.accessToken
      return
    }

    const google = await this.loadIdentity()
    await new Promise<void>((resolve, reject) => {
      this.tokenClient = google.accounts!.oauth2!.initTokenClient({
        client_id: this.options.clientId,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          if (response.error || !response.access_token) {
            reject(new Error(response.error_description || response.error || 'Google authorization failed.'))
            return
          }
          this.accessToken = response.access_token
          resolve()
        },
        error_callback: reject,
      })
      this.tokenClient.requestAccessToken({ prompt: 'consent' })
    })
  }

  logout() {
    const token = this.accessToken
    this.accessToken = ''
    const google = (globalThis as unknown as { google?: GoogleIdentity }).google
    if (token && google?.accounts?.oauth2?.revoke) google.accounts.oauth2.revoke(token)
  }

  async ensureRootFolder(): Promise<string> {
    const folderName = this.options.folderName ?? DRIVE_ROOT_FOLDER
    const matches = await this.listFolder('root', `name = '${escapeDriveQuery(folderName)}' and mimeType = '${DRIVE_MIME_FOLDER}' and trashed = false`)
    if (matches[0]?.id) return matches[0].id

    const created = await this.request<DriveFile>('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: DRIVE_MIME_FOLDER }),
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
    url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size)')
    const result = await this.request<{ files?: DriveFile[] }>(url.toString())
    return result.files ?? []
  }

  async uploadJson<T>(parentFolderId: string, name: string, data: T): Promise<string> {
    return this.upsertFile(parentFolderId, name, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  }

  async uploadBlob(parentFolderId: string, name: string, blob: Blob, mimeType?: string): Promise<string> {
    return this.upsertFile(parentFolderId, name, mimeType && blob.type !== mimeType ? blob.slice(0, blob.size, mimeType) : blob)
  }

  async downloadJson<T>(fileId: string): Promise<T> {
    return this.request<T>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
  }

  async downloadBlob(fileId: string): Promise<Blob> {
    if (!this.accessToken) throw new Error('Google Drive is not authorized.')
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Google Drive blob download failed (${response.status}): ${detail || response.statusText}`)
    }
    return response.blob()
  }

  private async upsertFile(parentFolderId: string, name: string, blob: Blob): Promise<string> {
    const existing = await this.listFolder(parentFolderId, `name = '${escapeDriveQuery(name)}'`)
    const metadata = { name, parents: [parentFolderId] }
    const { body } = multipartBody(metadata, blob)
    const existingId = existing[0]?.id
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id'
    const created = await this.request<DriveFile>(url, {
      method: existingId ? 'PATCH' : 'POST',
      body,
    })
    return created.id
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (!this.accessToken) throw new Error('Google Drive is not authorized.')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.accessToken}`)
    const response = await fetch(url, { ...init, headers })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Google Drive request failed (${response.status}): ${detail || response.statusText}`)
    }
    return (await response.json()) as T
  }

  private async loadIdentity(): Promise<GoogleIdentity> {
    const existing = (globalThis as unknown as { google?: GoogleIdentity }).google
    if (existing?.accounts?.oauth2) return existing

    await new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>('script[data-easylab-gis="1"]')
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(), { once: true })
        existingScript.addEventListener('error', reject, { once: true })
        return
      }
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.dataset.easylabGis = '1'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Unable to load Google Identity Services.'))
      document.head.appendChild(script)
    })

    const google = (globalThis as unknown as { google?: GoogleIdentity }).google
    if (!google?.accounts?.oauth2) throw new Error('Google Identity Services did not initialize.')
    return google
  }
}
