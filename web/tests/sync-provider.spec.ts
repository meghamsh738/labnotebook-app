import { expect, test } from '@playwright/test'
import type { DeviceProfile, Entry } from '../src/domain/types'
import {
  DRIVE_MIME_FOLDER,
  GoogleDriveProvider,
  type DriveBlobMetadata,
  type DriveFile,
  type SyncProvider as FolderDriveClient,
} from '../src/sync/connectedSync'
import type { JournalSnapshot } from '../src/sync/dataCore'
import { MemoryJournalStore, syncOnce } from '../src/sync/syncEngine'
import {
  GoogleDriveSyncProvider,
  MockSyncProvider,
  WritePreconditionError,
} from '../src/sync/syncProvider'

type FakeDriveNode = DriveFile & {
  parentId?: string
  json?: unknown
  blob?: Blob
}

test('Mock provider enforces exact file and version preconditions', async () => {
  const provider = new MockSyncProvider()
  await provider.signIn()
  const created = await provider.seedJsonForTest('entries/2026-05-24.json', { title: 'base' })
  expect(provider.supportsVersionedCas).toBe(true)
  const precondition = {
    kind: 'must-match' as const,
    fileId: created.id,
    version: created.version!,
  }

  const updated = await provider.putJson(
    created.path,
    { title: 'updated' },
    { precondition },
  )
  expect(updated.version).not.toBe(created.version)
  await expect(provider.putJson(
    created.path,
    { title: 'stale' },
    { precondition },
  )).rejects.toBeInstanceOf(WritePreconditionError)
  await expect(provider.putJson(
    'entries/missing.json',
    { title: 'missing' },
    { precondition },
  )).rejects.toBeInstanceOf(WritePreconditionError)
})

class FakeFolderDriveClient implements FolderDriveClient {
  readonly kind = 'google-drive' as const
  failNextBlobUpload = false
  failNextJsonUploadName = ''
  blobUploadAttempts = 0
  lastBlobMetadata: DriveBlobMetadata | undefined
  rootListCalls = 0
  private sequence = 0
  private readonly nodes = new Map<string, FakeDriveNode>()
  private signedIn = false

  async signIn() {
    this.signedIn = true
    return undefined
  }

  logout() {
    this.signedIn = false
  }

  async ensureRootFolder() {
    this.requireSignIn()
    const existing = [...this.nodes.values()].find((node) => node.name === 'Easylab Lab Notebook'
      && node.mimeType === DRIVE_MIME_FOLDER
      && node.trashed !== true
      && !node.parentId)
    if (existing) return existing.id
    const id = this.nextId()
    this.nodes.set(id, { id, name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER, modifiedTime: nowIso() })
    return id
  }

  async createRootFolder(name: string) {
    this.requireSignIn()
    const id = this.nextId()
    this.nodes.set(id, { id, name, mimeType: DRIVE_MIME_FOLDER, modifiedTime: nowIso() })
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
    if (this.failNextJsonUploadName === name) {
      this.failNextJsonUploadName = ''
      throw new Error(`Injected JSON upload failure for ${name}`)
    }
    const id = this.upsertFile(parentFolderId, name, 'application/json')
    this.nodes.set(id, { ...this.nodes.get(id)!, json: data, size: JSON.stringify(data).length.toString(), modifiedTime: nowIso() })
    return id
  }

  async uploadBlob(parentFolderId: string, name: string, blob: Blob, mimeType?: string, metadata?: DriveBlobMetadata) {
    this.blobUploadAttempts += 1
    this.lastBlobMetadata = metadata
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

  async getFileMetadata(fileId: string) {
    this.requireSignIn()
    const node = this.nodes.get(fileId)
    if (!node) throw new Error(`Google Drive request failed (404): File not found: ${fileId}.`)
    return toDriveFile(node)
  }

  async listFolder(parentFolderId: string, query?: string) {
    this.requireSignIn()
    if (parentFolderId === 'root') this.rootListCalls += 1
    return [...this.nodes.values()]
      .filter((node) => (node.parentId ?? 'root') === parentFolderId)
      .filter((node) => matchesDriveQuery(node, query))
      .map(toDriveFile)
  }

  async acquireWorkspaceTransactionGuard(folderId: string, operationId: string) {
    this.requireSignIn()
    const node = this.nodes.get(folderId)
    if (!node || node.mimeType !== DRIVE_MIME_FOLDER) throw new Error('Workspace folder is missing.')
    const existing = node.appProperties?.easylabTransactionGuard
    if (existing && existing !== operationId) throw new Error('Another workspace transaction guard is active.')
    this.nodes.set(folderId, {
      ...node,
      version: String(Number.parseInt(node.version ?? '0', 10) + 1),
      appProperties: { ...(node.appProperties ?? {}), easylabTransactionGuard: operationId },
    })
  }

  async releaseWorkspaceTransactionGuard(folderId: string, operationId: string) {
    this.requireSignIn()
    const node = this.nodes.get(folderId)
    if (!node) throw new Error('Workspace folder is missing.')
    const existing = node.appProperties?.easylabTransactionGuard
    if (existing && existing !== operationId) throw new Error('Workspace transaction guard changed.')
    const appProperties = { ...(node.appProperties ?? {}) }
    delete appProperties.easylabTransactionGuard
    this.nodes.set(folderId, {
      ...node,
      version: String(Number.parseInt(node.version ?? '0', 10) + 1),
      appProperties,
    })
  }

  addNode(node: FakeDriveNode) {
    this.nodes.set(node.id, node)
  }

  rootFolders(name: string) {
    return [...this.nodes.values()].filter((node) => !node.parentId && node.name === name && node.mimeType === DRIVE_MIME_FOLDER)
  }

  private upsertFile(parentFolderId: string, name: string, mimeType: string) {
    this.requireSignIn()
    const existing = [...this.nodes.values()].find((node) => node.parentId === parentFolderId && node.name === name && node.mimeType !== DRIVE_MIME_FOLDER)
    const id = existing?.id ?? this.nextId()
    const version = String(Number.parseInt(existing?.version ?? '0', 10) + 1)
    this.nodes.set(id, { id, name, parentId: parentFolderId, mimeType, modifiedTime: nowIso(), version })
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

function toDriveFile(node: FakeDriveNode): DriveFile {
  return {
    id: node.id,
    name: node.name,
    mimeType: node.mimeType,
    modifiedTime: node.modifiedTime,
    size: node.size,
    trashed: node.trashed,
    version: node.version ?? '1',
    parents: node.parentId ? [node.parentId] : [],
    appProperties: node.appProperties,
  }
}

function nowIso() {
  return new Date().toISOString()
}

function device(id = 'dev-test'): DeviceProfile {
  return {
    id,
    name: 'Test device',
    platform: 'desktop',
    createdAt: '2026-05-23T08:00:00.000Z',
    lastSeenAt: '2026-05-23T08:00:00.000Z',
  }
}

function entry(deviceId: string): Entry {
  return {
    id: 'entry-test',
    authorId: 'researcher',
    title: 'Recovery test',
    dateBucket: '2026-05-23',
    createdDatetime: '2026-05-23T08:00:00.000Z',
    lastEditedDatetime: '2026-05-23T09:00:00.000Z',
    content: [{ id: 'block-test', type: 'paragraph', text: 'Preserve this entry.' }],
    tags: [],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [],
    updatedByDeviceId: deviceId,
  }
}

function journalSnapshot(deviceProfile: DeviceProfile): JournalSnapshot {
  const dailyEntry = entry(deviceProfile.id)
  return {
    entries: { [dailyEntry.id]: dailyEntry },
    attachments: [],
    fileBoxItems: [],
    transfers: [],
    conflicts: [],
    tombstones: [],
    device: deviceProfile,
  }
}

function matchesDriveQuery(node: FakeDriveNode, query?: string) {
  if (!query) return true
  if (query.includes('trashed = false') && node.trashed === true) return false
  const name = query.match(/name = '([^']+)'/)?.[1]
  if (name && node.name !== name) return false
  if (query.includes(`mimeType = '${DRIVE_MIME_FOLDER}'`) && node.mimeType !== DRIVE_MIME_FOLDER) return false
  if (query.includes(`mimeType != '${DRIVE_MIME_FOLDER}'`) && node.mimeType === DRIVE_MIME_FOLDER) return false
  return true
}

test('GoogleDriveSyncProvider maps logical paths onto Drive folders and files', async () => {
  const client = new FakeFolderDriveClient()
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client-id',
    client,
    testOnlyAllowUnsafeSeeding: true,
  })

  await provider.signIn()
  const workspace = await provider.ensureWorkspace()
  await provider.seedJsonForTest('entries/2026-05-24.json', { title: 'Daily entry' })
  await provider.seedBlobForTest('attachments/2026-05-24/att-image.png', new Blob(['image bytes'], { type: 'image/png' }), {
    mimeType: 'image/png',
    sha256: 'actual-image-sha256',
    byteSize: 11,
    appProperties: {
      entityType: 'attachmentBlob',
      entityId: 'att-image',
      hash: 'existing-hash',
    },
  })

  const entry = await provider.getJson<{ title: string }>('entries/2026-05-24.json')
  const blob = await provider.getBlob('attachments/2026-05-24/att-image.png')
  const files = await provider.listManagedFiles({ prefix: 'attachments/' })

  expect(workspace.rootPath).toBe('Easylab Lab Notebook')
  expect(entry?.value).toEqual({ title: 'Daily entry' })
  expect(await blob?.text()).toBe('image bytes')
  expect(files.map((file) => file.path)).toEqual(['attachments/2026-05-24/att-image.png'])
  expect(client.lastBlobMetadata).toEqual({
    sha256: 'actual-image-sha256',
    appProperties: {
      entityType: 'attachmentBlob',
      entityId: 'att-image',
      hash: 'existing-hash',
    },
  })
})

for (const existingId of [undefined, 'existing-drive-file']) {
  test(`GoogleDriveProvider includes string appProperties in multipart ${existingId ? 'updates' : 'uploads'}`, async () => {
    const provider = new GoogleDriveProvider({ clientId: 'test-client-id' })
    ;(provider as unknown as { accessToken: string }).accessToken = 'test-access-token'
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/drive/v3/files?') && !url.includes('/upload/')) {
        return new Response(JSON.stringify({
          files: existingId ? [{ id: existingId, name: 'att-image.png' }] : [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ id: existingId ?? 'created-drive-file' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    try {
      await provider.uploadBlob('attachments-folder', 'att-image.png', new Blob(['image'], { type: 'image/png' }), 'image/png', {
        sha256: 'a'.repeat(64),
        appProperties: {
          entityType: 'attachmentBlob',
          entityId: 'att-image',
          hash: 'existing-hash',
          numericValue: 42,
          sha256: 'stale-sha256',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    const upload = requests.find((request) => request.url.includes('uploadType=multipart'))
    expect(upload?.init?.method).toBe(existingId ? 'PATCH' : 'POST')
    const multipartText = await (upload?.init?.body as Blob).text()
    expect(multipartText).toContain(JSON.stringify({
      name: 'att-image.png',
      ...(existingId ? {} : { parents: ['attachments-folder'] }),
      appProperties: {
        entityType: 'attachmentBlob',
        entityId: 'att-image',
        hash: 'existing-hash',
        numericValue: '42',
        sha256: 'a'.repeat(64),
      },
    }))
  })
}

for (const existingId of [undefined, 'existing-drive-file']) {
  test(`GoogleDriveProvider includes verified appProperties in resumable ${existingId ? 'updates' : 'uploads'}`, async () => {
    const provider = new GoogleDriveProvider({ clientId: 'test-client-id' })
    ;(provider as unknown as { accessToken: string }).accessToken = 'test-access-token'
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/drive/v3/files?') && !url.includes('/upload/')) {
        return new Response(JSON.stringify({
          files: existingId ? [{ id: existingId, name: 'large-image.tif' }] : [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('uploadType=resumable')) {
        return new Response(null, { status: 200, headers: { Location: 'https://upload.example.test/session' } })
      }
      return new Response(JSON.stringify({ id: existingId ?? 'created-drive-file' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    try {
      await provider.uploadBlob(
        'attachments-folder',
        'large-image.tif',
        new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'image/tiff' }),
        'image/tiff',
        {
          sha256: 'b'.repeat(64),
          appProperties: {
            entityType: 'attachmentBlob',
            entityId: 'large-image',
            sha256: 'stale-sha256',
          },
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const session = requests.find((request) => request.url.includes('uploadType=resumable'))
    expect(session?.init?.method).toBe(existingId ? 'PATCH' : 'POST')
    expect(JSON.parse(String(session?.init?.body))).toEqual({
      name: 'large-image.tif',
      ...(existingId ? {} : { parents: ['attachments-folder'] }),
      appProperties: {
        entityType: 'attachmentBlob',
        entityId: 'large-image',
        sha256: 'b'.repeat(64),
      },
    })
    expect(requests.some((request) => request.url === 'https://upload.example.test/session' && request.init?.method === 'PUT')).toBe(true)
  })
}

test('GoogleDriveProvider rejects appProperties that exceed Drive limits before upload', async () => {
  const provider = new GoogleDriveProvider({ clientId: 'test-client-id' })
  ;(provider as unknown as { accessToken: string }).accessToken = 'test-access-token'
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = async () => {
    requestCount += 1
    return new Response(JSON.stringify({ files: [] }), { status: 200 })
  }

  try {
    await expect(provider.uploadBlob('folder', 'too-many.bin', new Blob(['x']), undefined, {
      appProperties: Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`key${index}`, 'value'])),
    })).rejects.toThrow('at most 30 private app properties')
    await expect(provider.uploadBlob('folder', 'too-long.bin', new Blob(['x']), undefined, {
      appProperties: { label: 'é'.repeat(60) },
    })).rejects.toThrow('124-byte UTF-8 limit')
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(requestCount).toBe(0)
})

test('GoogleDriveSyncProvider recreates the workspace when a saved Drive folder id is missing', async () => {
  const client = new FakeFolderDriveClient()
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client-id',
    client,
    folderId: 'missing-root-folder',
    testOnlyAllowUnsafeSeeding: true,
  })

  await provider.signIn()
  expect(await client.listFolder('missing-root-folder')).toEqual([])
  const workspace = await provider.ensureWorkspace()
  const file = await provider.seedJsonForTest('entries/recovered.json', { recovered: true })

  expect(workspace.id).not.toBe('missing-root-folder')
  expect(workspace.rootPath).toBe('Easylab Lab Notebook')
  expect(file.path).toBe('entries/recovered.json')
})

test('transactional workspace resolution refuses missing folders without provisioning them', async () => {
  const client = new FakeFolderDriveClient()
  client.addNode({
    id: 'managed-root',
    name: 'Easylab Lab Notebook',
    mimeType: DRIVE_MIME_FOLDER,
    modifiedTime: nowIso(),
  })
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client',
    client,
    folderId: 'managed-root',
  })

  await provider.signIn()
  await expect(provider.resolveWorkspace()).rejects.toThrow(/must exist exactly once/i)
  expect(await client.listFolder('managed-root')).toEqual([])
})

test('transactional workspace resolution rejects duplicate managed folders', async () => {
  const client = new FakeFolderDriveClient()
  client.addNode({
    id: 'managed-root',
    name: 'Easylab Lab Notebook',
    mimeType: DRIVE_MIME_FOLDER,
    modifiedTime: nowIso(),
  })
  for (const folder of ['devices', 'entries', 'attachments', 'filebox', 'transfers', 'conflicts', 'tombstones']) {
    client.addNode({
      id: `managed-${folder}`,
      name: folder,
      parentId: 'managed-root',
      mimeType: DRIVE_MIME_FOLDER,
      modifiedTime: nowIso(),
    })
  }
  client.addNode({
    id: 'managed-entries-duplicate',
    name: 'entries',
    parentId: 'managed-root',
    mimeType: DRIVE_MIME_FOLDER,
    modifiedTime: nowIso(),
  })
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client',
    client,
    folderId: 'managed-root',
  })

  await provider.signIn()
  await expect(provider.resolveWorkspace()).rejects.toThrow(/must exist exactly once.*entries/i)
  expect((await client.listFolder('managed-root')).filter((folder) => folder.name === 'entries')).toHaveLength(2)
})

test('sign-out clears cached workspace identity before another account can resolve it', async () => {
  const client = new FakeFolderDriveClient()
  client.addNode({ id: 'account-root', name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER })
  for (const folder of ['devices', 'entries', 'attachments', 'filebox', 'transfers', 'conflicts', 'tombstones']) {
    client.addNode({ id: `account-${folder}`, name: folder, parentId: 'account-root', mimeType: DRIVE_MIME_FOLDER })
  }
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client', client, folderId: 'account-root', testOnlyEnableVersionedCas: true,
  })

  await provider.signIn()
  await provider.resolveWorkspace()
  expect(client.rootListCalls).toBe(0)
  await provider.signOut()
  await provider.signIn()
  await provider.resolveWorkspace()
  expect(client.rootListCalls).toBeGreaterThan(0)
})

test('workspace transaction guard is exclusive, resumable by identity, and explicitly released', async () => {
  const client = new FakeFolderDriveClient()
  client.addNode({ id: 'guard-root', name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER })
  for (const folder of ['devices', 'entries', 'attachments', 'filebox', 'transfers', 'conflicts', 'tombstones']) {
    client.addNode({ id: `guard-${folder}`, name: folder, parentId: 'guard-root', mimeType: DRIVE_MIME_FOLDER })
  }
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client', client, folderId: 'guard-root', testOnlyEnableVersionedCas: true,
  })
  const first = 'a'.repeat(64)
  const second = 'b'.repeat(64)

  await provider.signIn()
  await provider.resolveWorkspace()
  await provider.acquireTransactionGuard(first)
  await provider.acquireTransactionGuard(first)
  await expect(provider.acquireTransactionGuard(second)).rejects.toThrow(/another.*guard/i)
  await provider.releaseTransactionGuard(first)
  await provider.acquireTransactionGuard(second)
  await provider.releaseTransactionGuard(second)
})

test('GoogleDriveSyncProvider rejects saved ids with invalid root metadata', async () => {
  const invalidRoots: FakeDriveNode[] = [
    { id: 'wrong-root-folder', name: 'Shared project', mimeType: DRIVE_MIME_FOLDER },
    { id: 'trashed-root-folder', name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER, trashed: true },
    { id: 'root-file', name: 'Easylab Lab Notebook', mimeType: 'application/json' },
  ]

  for (const invalidRoot of invalidRoots) {
    const client = new FakeFolderDriveClient()
    client.addNode(invalidRoot)
    client.addNode({ id: 'expected-root-folder', name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER })
    const provider = new GoogleDriveSyncProvider({
      clientId: 'test-client-id',
      client,
      folderId: invalidRoot.id,
    })

    await provider.signIn()
    const workspace = await provider.ensureWorkspace()

    expect(workspace.id).toBe('expected-root-folder')
    expect(workspace.rootPath).toBe('Easylab Lab Notebook')
  }
})

test('GoogleDriveSyncProvider accepts a renamed saved folder with a valid Drive v1 manifest identity', async () => {
  const client = new FakeFolderDriveClient()
  client.addNode({ id: 'renamed-root-folder', name: 'Renamed notebook', mimeType: DRIVE_MIME_FOLDER })
  client.addNode({
    id: 'manifest-file',
    name: 'manifest.json',
    parentId: 'renamed-root-folder',
    mimeType: 'application/json',
    json: { version: 1, provider: 'google-drive', rootFolderName: 'Easylab Lab Notebook' },
  })
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client-id',
    client,
    folderId: 'renamed-root-folder',
  })

  await provider.signIn()
  const workspace = await provider.ensureWorkspace()

  expect(workspace.id).toBe('renamed-root-folder')
})

test('GoogleDriveSyncProvider blocks sync before sign-in or workspace mutation without CAS', async () => {
  const client = new FakeFolderDriveClient()
  const provider = new GoogleDriveSyncProvider({ clientId: 'test-client-id', client, folderName: 'Original notebook' })
  const testDevice = device()
  const store = new MemoryJournalStore(journalSnapshot(testDevice))

  await expect(syncOnce({ provider, store, device: testDevice })).rejects.toThrow(/writes are disabled.*compare-and-swap/i)
  expect(client.rootFolders('Original notebook')).toHaveLength(0)
})

test('GoogleDriveSyncProvider rejects direct writes without the offline CAS capability and explicit precondition', async () => {
  const client = new FakeFolderDriveClient()
  const disabled = new GoogleDriveSyncProvider({ clientId: 'test-client-id', client })

  await expect(disabled.putJson('entries/blocked.json', { blocked: true })).rejects.toThrow(/writes are disabled/i)
  expect(client.rootFolders('Easylab Lab Notebook')).toHaveLength(0)

  const testOnlyConditional = new GoogleDriveSyncProvider({
    clientId: 'test-client-id',
    client,
    testOnlyEnableVersionedCas: true,
  })
  expect(testOnlyConditional.supportsVersionedCas).toBe(false)
  await expect(testOnlyConditional.putJson('entries/blocked.json', { blocked: true })).rejects.toThrow(/explicit versioned precondition/i)
  expect(client.rootFolders('Easylab Lab Notebook')).toHaveLength(0)
})

test('GoogleDriveSyncProvider remains disabled for custom workspace names', async () => {
  const client = new FakeFolderDriveClient()
  const testDevice = device()
  const store = new MemoryJournalStore(journalSnapshot(testDevice))

  await expect(syncOnce({
    provider: new GoogleDriveSyncProvider({ clientId: 'test-client-id', client, folderName: 'Custom study' }), store, device: testDevice,
  })).rejects.toThrow(/writes are disabled.*compare-and-swap/i)

  expect(client.rootFolders('Custom study')).toHaveLength(0)
})

for (const interruptedUpload of ['dev-test.json', '2026-05-23.json']) {
  test(`disabled Google sync does not reach the ${interruptedUpload} upload path`, async () => {
    const client = new FakeFolderDriveClient()
    const testDevice = device()
    const store = new MemoryJournalStore(journalSnapshot(testDevice))
    const firstProvider = new GoogleDriveSyncProvider({ clientId: 'test-client-id', client })
    client.failNextJsonUploadName = interruptedUpload

    await expect(syncOnce({ provider: firstProvider, store, device: testDevice })).rejects.toThrow(/writes are disabled.*compare-and-swap/i)
    expect(client.rootFolders('Easylab Lab Notebook')).toHaveLength(0)
  })
}

test('GoogleDriveSyncProvider ignores unrelated same-name folders that contain unmanaged data', async () => {
  const client = new FakeFolderDriveClient()
  client.addNode({ id: 'unrelated-root', name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER })
  client.addNode({
    id: 'unrelated-file',
    name: 'personal.json',
    parentId: 'unrelated-root',
    mimeType: 'application/json',
    json: { personal: true },
  })
  const provider = new GoogleDriveSyncProvider({ clientId: 'test-client-id', client })

  await provider.signIn()
  const workspace = await provider.ensureWorkspace()

  expect(workspace.id).not.toBe('unrelated-root')
  expect((await client.listFolder('unrelated-root')).map((file) => file.name)).toEqual(['personal.json'])
})

test('GoogleDriveSyncProvider chooses the single manifest-backed folder among same-name candidates', async () => {
  const client = new FakeFolderDriveClient()
  client.addNode({ id: 'unrelated-root', name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER })
  client.addNode({ id: 'unrelated-file', name: 'notes.txt', parentId: 'unrelated-root', mimeType: 'text/plain' })
  client.addNode({ id: 'managed-root', name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER })
  client.addNode({
    id: 'managed-manifest',
    name: 'manifest.json',
    parentId: 'managed-root',
    mimeType: 'application/json',
    json: { version: 1, provider: 'google-drive', rootFolderName: 'Easylab Lab Notebook' },
  })
  const provider = new GoogleDriveSyncProvider({ clientId: 'test-client-id', client })

  await provider.signIn()
  await expect(provider.ensureWorkspace()).resolves.toMatchObject({ id: 'managed-root' })
})

test('GoogleDriveSyncProvider refuses ambiguous manifest-backed folders', async () => {
  const client = new FakeFolderDriveClient()
  for (const suffix of ['a', 'b']) {
    client.addNode({ id: `managed-root-${suffix}`, name: 'Easylab Lab Notebook', mimeType: DRIVE_MIME_FOLDER })
    client.addNode({
      id: `manifest-${suffix}`,
      name: 'manifest.json',
      parentId: `managed-root-${suffix}`,
      mimeType: 'application/json',
      json: { version: 1, provider: 'google-drive', rootFolderName: 'Easylab Lab Notebook' },
    })
  }
  const provider = new GoogleDriveSyncProvider({ clientId: 'test-client-id', client })

  await provider.signIn()
  await expect(provider.ensureWorkspace()).rejects.toThrow(/multiple easylab drive workspaces/i)
})

test('GoogleDriveSyncProvider retries transient blob upload failures', async () => {
  const client = new FakeFolderDriveClient()
  client.failNextBlobUpload = true
  const provider = new GoogleDriveSyncProvider({
    clientId: 'test-client-id',
    client,
    uploadRetryCount: 2,
    retryDelayMs: 0,
    testOnlyAllowUnsafeSeeding: true,
  })

  await provider.signIn()
  await provider.ensureWorkspace()
  const file = await provider.seedBlobForTest('attachments/2026-05-24/retry-image.png', new Blob(['retry bytes'], { type: 'image/png' }), {
    mimeType: 'image/png',
    byteSize: 11,
  })
  const blob = await provider.getBlob('attachments/2026-05-24/retry-image.png')

  expect(client.blobUploadAttempts).toBe(2)
  expect(file.path).toBe('attachments/2026-05-24/retry-image.png')
  expect(await blob?.text()).toBe('retry bytes')
})
