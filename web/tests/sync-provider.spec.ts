import { expect, test } from '@playwright/test'
import { DRIVE_MIME_FOLDER, type DriveFile, type SyncProvider as FolderDriveClient } from '../src/sync/connectedSync'
import { GoogleDriveSyncProvider } from '../src/sync/syncProvider'

type FakeDriveNode = DriveFile & {
  parentId?: string
  json?: unknown
  blob?: Blob
}

class FakeFolderDriveClient implements FolderDriveClient {
  readonly kind = 'google-drive' as const
  failNextBlobUpload = false
  blobUploadAttempts = 0
  private sequence = 0
  private readonly nodes = new Map<string, FakeDriveNode>()
  private signedIn = false

  async signIn() {
    this.signedIn = true
  }

  logout() {
    this.signedIn = false
  }

  async ensureRootFolder() {
    this.requireSignIn()
    const existing = [...this.nodes.values()].find((node) => node.name === 'Easylab Lab Notebook' && node.mimeType === DRIVE_MIME_FOLDER && !node.parentId)
    if (existing) return existing.id
    const id = this.nextId()
    this.nodes.set(id, { id, name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER, modifiedTime: nowIso() })
    return id
  }

  async ensureFolder(parentFolderId: string, name: string) {
    this.requireSignIn()
    const existing = [...this.nodes.values()].find((node) => node.parentId === parentFolderId && node.name === name && node.mimeType === DRIVE_MIME_FOLDER)
    if (existing) return existing.id
    const id = this.nextId()
    this.nodes.set(id, { id, name, parentId: parentFolderId, mimeType: DRIVE_MIME_FOLDER, modifiedTime: nowIso() })
    return id
  }

  async uploadJson<T>(parentFolderId: string, name: string, data: T) {
    const id = this.upsertFile(parentFolderId, name, 'application/json')
    this.nodes.set(id, { ...this.nodes.get(id)!, json: data, size: JSON.stringify(data).length.toString(), modifiedTime: nowIso() })
    return id
  }

  async uploadBlob(parentFolderId: string, name: string, blob: Blob, mimeType?: string) {
    this.blobUploadAttempts += 1
    if (this.failNextBlobUpload) {
      this.failNextBlobUpload = false
      throw new Error('Google Drive request failed (503): temporary upload failure')
    }
    const id = this.upsertFile(parentFolderId, name, mimeType || blob.type || 'application/octet-stream')
    this.nodes.set(id, { ...this.nodes.get(id)!, blob, size: blob.size.toString(), modifiedTime: nowIso() })
    return id
  }

  async downloadJson<T>(fileId: string) {
    return this.nodes.get(fileId)?.json as T
  }

  async downloadBlob(fileId: string) {
    const blob = this.nodes.get(fileId)?.blob
    if (!blob) throw new Error(`No blob for ${fileId}`)
    return blob
  }

  async listFolder(parentFolderId: string, query?: string) {
    this.requireSignIn()
    return [...this.nodes.values()]
      .filter((node) => node.parentId === parentFolderId)
      .filter((node) => matchesDriveQuery(node, query))
      .map((node) => ({
        id: node.id,
        name: node.name,
        mimeType: node.mimeType,
        modifiedTime: node.modifiedTime,
        size: node.size,
      }))
  }

  private upsertFile(parentFolderId: string, name: string, mimeType: string) {
    this.requireSignIn()
    const existing = [...this.nodes.values()].find((node) => node.parentId === parentFolderId && node.name === name && node.mimeType !== DRIVE_MIME_FOLDER)
    const id = existing?.id ?? this.nextId()
    this.nodes.set(id, { id, name, parentId: parentFolderId, mimeType, modifiedTime: nowIso() })
    return id
  }

  private nextId() {
    this.sequence += 1
    return `drive-${this.sequence}`
  }

  private requireSignIn() {
    if (!this.signedIn) throw new Error('Fake Drive client is not signed in.')
  }
}

function nowIso() {
  return new Date().toISOString()
}

function matchesDriveQuery(node: FakeDriveNode, query?: string) {
  if (!query) return true
  const name = query.match(/name = '([^']+)'/)?.[1]
  if (name && node.name !== name) return false
  if (query.includes(`mimeType = '${DRIVE_MIME_FOLDER}'`) && node.mimeType !== DRIVE_MIME_FOLDER) return false
  if (query.includes(`mimeType != '${DRIVE_MIME_FOLDER}'`) && node.mimeType === DRIVE_MIME_FOLDER) return false
  return true
}

test('GoogleDriveSyncProvider maps logical paths onto Drive folders and files', async () => {
  const client = new FakeFolderDriveClient()
  const provider = new GoogleDriveSyncProvider({ clientId: 'test-client-id', client })

  await provider.signIn()
  const workspace = await provider.ensureWorkspace()
  await provider.putJson('entries/2026-05-24.json', { title: 'Daily entry' })
  await provider.putBlob('attachments/2026-05-24/att-image.png', new Blob(['image bytes'], { type: 'image/png' }), {
    mimeType: 'image/png',
    byteSize: 11,
  })

  const entry = await provider.getJson<{ title: string }>('entries/2026-05-24.json')
  const blob = await provider.getBlob('attachments/2026-05-24/att-image.png')
  const files = await provider.listManagedFiles({ prefix: 'attachments/' })

  expect(workspace.rootPath).toBe('Easylab Lab Notebook')
  expect(entry?.value).toEqual({ title: 'Daily entry' })
  expect(await blob?.text()).toBe('image bytes')
  expect(files.map((file) => file.path)).toEqual(['attachments/2026-05-24/att-image.png'])
})

test('GoogleDriveSyncProvider retries transient blob upload failures', async () => {
  const client = new FakeFolderDriveClient()
  client.failNextBlobUpload = true
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client-id',
    client,
    uploadRetryCount: 2,
    retryDelayMs: 0,
  })

  await provider.signIn()
  await provider.ensureWorkspace()
  const file = await provider.putBlob('attachments/2026-05-24/retry-image.png', new Blob(['retry bytes'], { type: 'image/png' }), {
    mimeType: 'image/png',
    byteSize: 11,
  })
  const blob = await provider.getBlob('attachments/2026-05-24/retry-image.png')

  expect(client.blobUploadAttempts).toBe(2)
  expect(file.path).toBe('attachments/2026-05-24/retry-image.png')
  expect(await blob?.text()).toBe('retry bytes')
})
