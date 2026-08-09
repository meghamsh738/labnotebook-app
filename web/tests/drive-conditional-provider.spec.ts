import { expect, test } from '@playwright/test'
import {
  DRIVE_MIME_FOLDER,
  DriveWriteAmbiguousCommitError,
  DriveWritePreconditionConflictError,
  GoogleDriveProvider,
  type DriveConditionalBlobWrite,
  type DriveFile,
} from '../src/sync/connectedSync'
import {
  DriveResumableOperationIdentityError,
  DriveResumableOperationStore,
  MemoryDriveResumableOperationPersistence,
  sha256Hex,
} from '../src/sync/driveResumableOperations'

type FakeNode = Required<Pick<DriveFile, 'id' | 'name' | 'mimeType' | 'version' | 'parents' | 'appProperties'>> & {
  modifiedTime: string
  trashed: boolean
  content: Blob
}

type RecordedRequest = { url: string; method: string; headers: Headers; body?: BodyInit | null }

const parentId = 'attachments-folder'
const targetPath = 'attachments/2026-05-24/att-image.txt'

class ConditionalDriveHttpFake {
  readonly requests: RecordedRequest[] = []
  readonly parent: FakeNode = node({
    id: parentId,
    name: 'attachments',
    mimeType: DRIVE_MIME_FOLDER,
    version: '1',
    parents: ['root'],
    content: new Blob(),
  })
  files: FakeNode[] = []
  generatedIdCount = 0
  mutationCount = 0
  nextMutationStatus = 0
  loseNextCompletionResponse = false
  failVerificationListAfterLostResponse = false
  interruptNextCompletionBeforeCommit = false
  expireNextSessionBeforeCommit = false
  cancelNextCompletionAfterCommit: (() => void) | undefined
  private failedListReadsRemaining = 0
  private session: { fileId?: string; metadata: Record<string, unknown> } | undefined

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    this.requests.push({ url, method, headers, body: init.body })
    if (init.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new DOMException('The operation was aborted.', 'AbortError')
    }
    const parsed = new URL(url)

    if (parsed.hostname === 'upload.example.test') return this.completeSession(init)
    if (parsed.pathname.endsWith('/files/generateIds')) {
      this.generatedIdCount += 1
      return json({ ids: [`generated-${this.generatedIdCount}`] })
    }
    if (parsed.pathname === '/drive/v3/files' && method === 'GET') return this.list(parsed)
    if (parsed.pathname.startsWith('/drive/v3/files/') && !parsed.pathname.includes('/upload/')) {
      const fileId = decodeURIComponent(parsed.pathname.split('/').pop()!)
      if (parsed.searchParams.get('alt') === 'media') return this.media(fileId)
      if (method === 'PATCH') return this.patchMetadata(fileId, init)
      return this.metadata(fileId)
    }
    if (parsed.pathname.startsWith('/upload/drive/v3/files')) {
      if (this.nextMutationStatus) {
        const status = this.nextMutationStatus
        this.nextMutationStatus = 0
        return new Response('injected precondition failure', { status })
      }
      if (parsed.searchParams.get('uploadType') === 'resumable') return this.beginSession(parsed, init)
      return this.multipart(parsed, init)
    }
    throw new Error(`Unexpected fake Drive request: ${method} ${url}`)
  }

  addTarget(content: Blob, version = '3', appProperties: Record<string, string> = { entityType: 'attachmentBlob' }) {
    const target = node({
      id: 'target-file',
      name: 'att-image.txt',
      mimeType: content.type || 'text/plain',
      version,
      parents: [parentId],
      appProperties,
      content,
    })
    this.files.push(target)
    return target
  }

  private list(url: URL) {
    if (this.failedListReadsRemaining > 0) {
      this.failedListReadsRemaining -= 1
      throw new TypeError('simulated verification read interruption')
    }
    const q = url.searchParams.get('q') ?? ''
    const requestedParent = q.match(/'([^']+)' in parents/)?.[1]
    const requestedName = q.match(/name = '([^']+)'/)?.[1]
    const files = this.files
      .filter((file) => !requestedParent || file.parents.includes(requestedParent))
      .filter((file) => !requestedName || file.name === requestedName)
      .filter((file) => !q.includes(`mimeType != '${DRIVE_MIME_FOLDER}'`) || file.mimeType !== DRIVE_MIME_FOLDER)
      .map(asDriveFile)
    return json({ files })
  }

  private metadata(fileId: string) {
    const file = fileId === parentId ? this.parent : this.files.find((candidate) => candidate.id === fileId)
    if (!file) return new Response('missing', { status: 404 })
    return json(asDriveFile(file), { ETag: etag(file) })
  }

  private media(fileId: string) {
    const file = this.files.find((candidate) => candidate.id === fileId)
    return file ? new Response(file.content) : new Response('missing', { status: 404 })
  }

  private async patchMetadata(fileId: string, init: RequestInit) {
    const file = fileId === parentId ? this.parent : this.files.find((candidate) => candidate.id === fileId)
    if (!file) return new Response('missing', { status: 404 })
    if (new Headers(init.headers).get('If-Match') !== etag(file)) return new Response('stale', { status: 412 })
    const body = JSON.parse(String(init.body)) as { appProperties?: Record<string, string | null> }
    for (const [key, value] of Object.entries(body.appProperties ?? {})) {
      if (value === null) delete file.appProperties[key]
      else file.appProperties[key] = value
    }
    advance(file)
    return json(asDriveFile(file), { ETag: etag(file) })
  }

  private beginSession(url: URL, init: RequestInit) {
    const match = url.pathname.match(/\/files\/([^/]+)$/)
    const fileId = match ? decodeURIComponent(match[1]) : undefined
    if (fileId) {
      const file = this.files.find((candidate) => candidate.id === fileId)
      if (!file) return new Response('missing', { status: 404 })
      if (new Headers(init.headers).get('If-Match') !== etag(file)) return new Response('stale', { status: 412 })
    }
    this.session = { fileId, metadata: JSON.parse(String(init.body)) as Record<string, unknown> }
    return new Response(null, { status: 200, headers: { Location: 'https://upload.example.test/session' } })
  }

  private async completeSession(init: RequestInit) {
    if (!this.session) return new Response('missing session', { status: 404 })
    if (this.expireNextSessionBeforeCommit) {
      this.expireNextSessionBeforeCommit = false
      this.session = undefined
      return new Response('expired session', { status: 404 })
    }
    if (this.interruptNextCompletionBeforeCommit) {
      this.interruptNextCompletionBeforeCommit = false
      throw new TypeError('simulated interruption before remote commit')
    }
    const content = init.body as Blob
    const metadata = this.session.metadata
    const existing = this.session.fileId
      ? this.files.find((candidate) => candidate.id === this.session!.fileId)
      : undefined
    const file = existing ?? node({
      id: String(metadata.id),
      name: String(metadata.name),
      mimeType: String(metadata.mimeType),
      version: '0',
      parents: metadata.parents as string[],
      content,
    })
    file.name = String(metadata.name)
    file.mimeType = String(metadata.mimeType)
    file.parents = (metadata.parents as string[] | undefined) ?? file.parents
    file.appProperties = { ...(metadata.appProperties as Record<string, string> | undefined) }
    file.content = content
    advance(file)
    if (!existing) this.files.push(file)
    this.mutationCount += 1
    this.session = undefined
    if (this.cancelNextCompletionAfterCommit) {
      const cancel = this.cancelNextCompletionAfterCommit
      this.cancelNextCompletionAfterCommit = undefined
      cancel()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if (this.loseNextCompletionResponse) {
      this.loseNextCompletionResponse = false
      if (this.failVerificationListAfterLostResponse) {
        this.failVerificationListAfterLostResponse = false
        this.failedListReadsRemaining = 3
      }
      throw new TypeError('simulated lost completion response')
    }
    return json(asDriveFile(file))
  }

  private async multipart(url: URL, init: RequestInit) {
    const fileId = url.pathname.match(/\/files\/([^/]+)$/)?.[1]
    const existing = fileId ? this.files.find((candidate) => candidate.id === decodeURIComponent(fileId)) : undefined
    if (existing && new Headers(init.headers).get('If-Match') !== etag(existing)) return new Response('stale', { status: 412 })
    const parsed = await parseMultipart(init.body as Blob)
    const metadata = parsed.metadata
    const file = existing ?? node({
      id: `created-${this.mutationCount + 1}`,
      name: String(metadata.name),
      mimeType: String(metadata.mimeType),
      version: '0',
      parents: metadata.parents as string[],
      content: parsed.content,
    })
    file.name = String(metadata.name)
    file.mimeType = String(metadata.mimeType)
    file.parents = (metadata.parents as string[] | undefined) ?? file.parents
    file.appProperties = { ...(metadata.appProperties as Record<string, string> | undefined) }
    file.content = parsed.content
    advance(file)
    if (!existing) this.files.push(file)
    this.mutationCount += 1
    return json(asDriveFile(file))
  }
}

function node(input: Partial<FakeNode> & Pick<FakeNode, 'id' | 'name' | 'mimeType' | 'version' | 'parents' | 'content'>): FakeNode {
  return {
    ...input,
    appProperties: input.appProperties ?? {},
    modifiedTime: input.modifiedTime ?? modifiedTime(input.version),
    trashed: input.trashed ?? false,
  }
}

function advance(file: FakeNode) {
  file.version = String(BigInt(file.version) + 1n)
  file.modifiedTime = modifiedTime(file.version)
}

function modifiedTime(version: string) {
  return `2026-05-24T10:00:${version.padStart(2, '0')}.000Z`
}

function etag(file: FakeNode) {
  return `"${file.id}-v${file.version}"`
}

function asDriveFile(file: FakeNode): DriveFile {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    size: String(file.content.size),
    trashed: file.trashed,
    version: file.version,
    parents: [...file.parents],
    appProperties: { ...file.appProperties },
  }
}

function json(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

async function parseMultipart(body: Blob) {
  const boundary = body.type.match(/boundary=(.+)$/)?.[1]
  if (!boundary) throw new Error('Fake Drive multipart body omitted its boundary.')
  const parts = (await body.text()).split(`--${boundary}`)
  const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].trim()) as Record<string, unknown>
  const contentText = parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, '')
  return { metadata, content: new Blob([contentText], { type: String(metadata.mimeType) }) }
}

function provider(fake: ConditionalDriveHttpFake, persistence = new MemoryDriveResumableOperationPersistence(), scope = 'scope-a') {
  const result = new GoogleDriveProvider({
    clientId: 'test-client',
    testOnlyStorageScope: scope,
    resumableOperationStore: new DriveResumableOperationStore(persistence),
  })
  ;(result as unknown as { accessToken: string }).accessToken = 'test-access-token'
  return result
}

async function withFakeFetch<T>(fake: ConditionalDriveHttpFake, action: () => Promise<T>) {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  try {
    return await action()
  } finally {
    globalThis.fetch = original
  }
}

test('conditional multipart update fetches a fresh ETag, sends If-Match, and verifies the result twice', async () => {
  const fake = new ConditionalDriveHttpFake()
  const content = new Blob(['updated bytes'], { type: 'text/plain' })
  const original = fake.addTarget(new Blob(['base bytes'], { type: 'text/plain' }), '3', {
    entityType: 'attachmentBlob',
    futureClientField: 'preserve-me',
  })
  const client = provider(fake)
  const contentSha256 = await sha256Hex(content)

  const updated = await withFakeFetch(fake, () => client.conditionalUploadBlob!({
    parentFolderId: parentId,
    path: targetPath,
    name: original.name,
    blob: content,
    mimeType: 'text/plain',
    sha256: contentSha256,
    appProperties: { entityType: 'attachmentBlob' },
    precondition: { kind: 'must-match', fileId: original.id, version: '3' },
  }))

  expect(updated.version).toBe('4')
  expect(updated.appProperties?.futureClientField).toBe('preserve-me')
  const mutationIndex = fake.requests.findIndex((request) => request.url.includes('uploadType=multipart'))
  expect(mutationIndex).toBeGreaterThan(0)
  expect(fake.requests[mutationIndex - 1].url).toContain(`/files/${original.id}`)
  expect(fake.requests[mutationIndex].headers.get('If-Match')).toBe('"target-file-v3"')
  expect(fake.requests.filter((request) => request.url.includes(`/files/${original.id}`) && request.method === 'GET')).toHaveLength(4)
})

test('conditional updates fail closed for stale versions, duplicate paths, and Drive 412 responses', async () => {
  const content = new Blob(['updated'], { type: 'text/plain' })
  const request = async (fake: ConditionalDriveHttpFake, version = '3') => provider(fake).conditionalUploadBlob!({
    parentFolderId: parentId,
    path: targetPath,
    name: 'att-image.txt',
    blob: content,
    mimeType: 'text/plain',
    sha256: await sha256Hex(content),
    precondition: { kind: 'must-match', fileId: 'target-file', version },
  })

  const stale = new ConditionalDriveHttpFake()
  stale.addTarget(new Blob(['base'], { type: 'text/plain' }))
  await withFakeFetch(stale, async () => {
    await expect(request(stale, '2')).rejects.toBeInstanceOf(DriveWritePreconditionConflictError)
  })
  expect(stale.mutationCount).toBe(0)

  const duplicate = new ConditionalDriveHttpFake()
  duplicate.addTarget(new Blob(['base'], { type: 'text/plain' }))
  duplicate.files.push(node({
    id: 'duplicate-file', name: 'att-image.txt', mimeType: 'text/plain', version: '1', parents: [parentId], content: new Blob(['other']),
  }))
  await withFakeFetch(duplicate, async () => {
    await expect(request(duplicate)).rejects.toBeInstanceOf(DriveWritePreconditionConflictError)
  })
  expect(duplicate.mutationCount).toBe(0)

  for (const status of [404, 409, 412]) {
    const rejected = new ConditionalDriveHttpFake()
    rejected.addTarget(new Blob(['base'], { type: 'text/plain' }))
    rejected.nextMutationStatus = status
    await withFakeFetch(rejected, async () => {
      await expect(request(rejected)).rejects.toBeInstanceOf(DriveWritePreconditionConflictError)
    })
    expect(rejected.mutationCount).toBe(0)
  }
})

test('small create-only retry reconciles the exact file and never creates a duplicate', async () => {
  const fake = new ConditionalDriveHttpFake()
  const content = new Blob(['new bytes'], { type: 'text/plain' })
  const client = provider(fake)
  const request: DriveConditionalBlobWrite = {
    parentFolderId: parentId,
    path: targetPath,
    name: 'att-image.txt',
    blob: content,
    mimeType: 'text/plain',
    sha256: await sha256Hex(content),
    precondition: { kind: 'must-not-exist', operationId: 'small-create-1' },
  }

  await withFakeFetch(fake, async () => {
    const first = await client.conditionalUploadBlob!(request)
    const retry = await client.conditionalUploadBlob!(request)
    expect(retry.id).toBe(first.id)
  })

  expect(fake.mutationCount).toBe(1)
  expect(fake.files).toHaveLength(1)
  const changed = { ...request, blob: new Blob(['different'], { type: 'text/plain' }) }
  changed.sha256 = await sha256Hex(changed.blob)
  await withFakeFetch(fake, async () => {
    await expect(client.conditionalUploadBlob!(changed)).rejects.toBeInstanceOf(DriveWritePreconditionConflictError)
  })
  expect(fake.mutationCount).toBe(1)
})

test('large resumable create survives a lost response with one generated id and immutable account-scoped identity', async () => {
  const persistence = new MemoryDriveResumableOperationPersistence()
  const fake = new ConditionalDriveHttpFake()
  fake.loseNextCompletionResponse = true
  const content = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' })
  const sha256 = await sha256Hex(content)
  const client = provider(fake, persistence, 'scope-a')
  const request: DriveConditionalBlobWrite = {
    parentFolderId: parentId,
    path: 'attachments/2026-05-24/large.bin',
    name: 'large.bin',
    blob: content,
    mimeType: 'application/octet-stream',
    sha256,
    precondition: { kind: 'must-not-exist', operationId: 'large-create-1' },
    resumableOperationId: 'large-create-1',
  }

  await withFakeFetch(fake, async () => {
    const created = await client.conditionalUploadBlob!(request)
    expect(created.id).toBe('generated-1')
    expect((await client.conditionalUploadBlob!(request)).id).toBe(created.id)
  })

  expect(fake.generatedIdCount).toBe(1)
  expect(fake.mutationCount).toBe(1)
  const record = await persistence.read('scope-a', 'large-create-1')
  expect(record?.state).toBe('completed')
  expect(JSON.stringify(record)).not.toMatch(/access.?token|session|email/i)

  const otherScopeStore = new DriveResumableOperationStore(persistence)
  await expect(otherScopeStore.begin('scope-b', record!.identity)).resolves.toMatchObject({ state: 'prepared' })
  await expect(otherScopeStore.begin('scope-a', {
    ...record!.identity,
    path: 'attachments/2026-05-24/changed.bin',
  })).rejects.toBeInstanceOf(DriveResumableOperationIdentityError)
})

test('interrupted resumable update is ambiguous without remote proof and keeps its retry identity', async () => {
  const persistence = new MemoryDriveResumableOperationPersistence()
  const fake = new ConditionalDriveHttpFake()
  fake.interruptNextCompletionBeforeCommit = true
  const original = fake.addTarget(new Blob(['base'], { type: 'application/octet-stream' }))
  const content = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'application/octet-stream' })
  const request: DriveConditionalBlobWrite = {
    parentFolderId: parentId,
    path: 'attachments/2026-05-24/att-image.txt',
    name: original.name,
    blob: content,
    mimeType: 'application/octet-stream',
    sha256: await sha256Hex(content),
    precondition: { kind: 'must-match', fileId: original.id, version: original.version },
    resumableOperationId: 'large-update-1',
  }

  await withFakeFetch(fake, async () => {
    await expect(provider(fake, persistence).conditionalUploadBlob!(request)).rejects.toBeInstanceOf(DriveWriteAmbiguousCommitError)
    const retried = await provider(fake, persistence).conditionalUploadBlob!(request)
    expect(retried.version).toBe('4')
  })
  expect((await persistence.read('scope-a', 'large-update-1'))?.state).toBe('completed')
  expect(fake.mutationCount).toBe(1)
})

test('a committed resumable update with a temporarily lost verification read reconciles on restart', async () => {
  const persistence = new MemoryDriveResumableOperationPersistence()
  const fake = new ConditionalDriveHttpFake()
  fake.loseNextCompletionResponse = true
  fake.failVerificationListAfterLostResponse = true
  const original = fake.addTarget(new Blob(['base'], { type: 'application/octet-stream' }))
  const content = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' })
  const request: DriveConditionalBlobWrite = {
    parentFolderId: parentId,
    path: targetPath,
    name: original.name,
    blob: content,
    mimeType: 'application/octet-stream',
    sha256: await sha256Hex(content),
    precondition: { kind: 'must-match', fileId: original.id, version: original.version },
    resumableOperationId: 'large-update-lost-verification',
  }

  await withFakeFetch(fake, async () => {
    let firstError: unknown
    try {
      await provider(fake, persistence).conditionalUploadBlob!(request)
    } catch (error) {
      firstError = error
    }
    expect(firstError).toBeInstanceOf(DriveWriteAmbiguousCommitError)
    expect((await persistence.read('scope-a', request.resumableOperationId!))?.state).toBe('ambiguous')
    const reconciled = await provider(fake, persistence).conditionalUploadBlob!(request)
    expect(reconciled.version).toBe('4')
  })

  expect(fake.mutationCount).toBe(1)
  expect((await persistence.read('scope-a', request.resumableOperationId!))?.state).toBe('completed')
})

test('large create retry rejects an exact-content occupant with the wrong persisted generated id', async () => {
  const persistence = new MemoryDriveResumableOperationPersistence()
  const fake = new ConditionalDriveHttpFake()
  fake.interruptNextCompletionBeforeCommit = true
  const content = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' })
  const request: DriveConditionalBlobWrite = {
    parentFolderId: parentId,
    path: 'attachments/2026-05-24/large-collision.bin',
    name: 'large-collision.bin',
    blob: content,
    mimeType: 'application/octet-stream',
    sha256: await sha256Hex(content),
    precondition: { kind: 'must-not-exist', operationId: 'large-create-collision' },
    resumableOperationId: 'large-create-collision',
  }

  await withFakeFetch(fake, async () => {
    await expect(provider(fake, persistence).conditionalUploadBlob!(request)).rejects.toBeInstanceOf(DriveWriteAmbiguousCommitError)
    const record = await persistence.read('scope-a', request.resumableOperationId!)
    expect(record?.identity.target).toMatchObject({ kind: 'new', fileId: 'generated-1' })
    fake.files.push(node({
      id: 'foreign-file',
      name: request.name,
      mimeType: request.mimeType,
      version: '1',
      parents: [parentId],
      appProperties: { ...record!.identity.appProperties },
      content,
    }))
    await expect(provider(fake, persistence).conditionalUploadBlob!(request)).rejects.toBeInstanceOf(DriveWritePreconditionConflictError)
  })

  expect(fake.generatedIdCount).toBe(1)
  expect(fake.mutationCount).toBe(0)
})

test('conditional JSON at the 5 MiB boundary is rejected instead of becoming resumable', async () => {
  const fake = new ConditionalDriveHttpFake()
  const threshold = 5 * 1024 * 1024
  const value = 'x'.repeat(threshold - 2)
  expect(new Blob([JSON.stringify(value, null, 2)]).size).toBe(threshold)

  await expect(provider(fake).conditionalUploadJson!({
    parentFolderId: parentId,
    path: 'entries/2026/05/24/oversized.json',
    name: 'oversized.json',
    value,
    precondition: { kind: 'must-not-exist', operationId: 'oversized-json' },
  })).rejects.toThrow(/multipart upload limit/i)

  expect(fake.requests).toHaveLength(0)
})

test('resumable cancellation before commit aborts cleanly and cancellation after commit reconciles success', async () => {
  const beforePersistence = new MemoryDriveResumableOperationPersistence()
  const beforeFake = new ConditionalDriveHttpFake()
  const beforeOriginal = beforeFake.addTarget(new Blob(['base'], { type: 'application/octet-stream' }))
  const content = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' })
  const beforeController = new AbortController()
  beforeController.abort(new DOMException('cancelled before upload', 'AbortError'))
  const beforeRequest: DriveConditionalBlobWrite = {
    parentFolderId: parentId,
    path: targetPath,
    name: beforeOriginal.name,
    blob: content,
    mimeType: 'application/octet-stream',
    sha256: await sha256Hex(content),
    precondition: { kind: 'must-match', fileId: beforeOriginal.id, version: beforeOriginal.version },
    resumableOperationId: 'cancel-before',
    signal: beforeController.signal,
  }

  await withFakeFetch(beforeFake, async () => {
    await expect(provider(beforeFake, beforePersistence).conditionalUploadBlob!(beforeRequest)).rejects.toMatchObject({ name: 'AbortError' })
  })
  expect(beforeFake.mutationCount).toBe(0)
  expect(await beforePersistence.read('scope-a', beforeRequest.resumableOperationId!)).toBeUndefined()

  const afterPersistence = new MemoryDriveResumableOperationPersistence()
  const afterFake = new ConditionalDriveHttpFake()
  const afterOriginal = afterFake.addTarget(new Blob(['base'], { type: 'application/octet-stream' }))
  const afterController = new AbortController()
  afterFake.cancelNextCompletionAfterCommit = () => afterController.abort(new DOMException('cancelled after commit', 'AbortError'))
  const afterRequest: DriveConditionalBlobWrite = {
    ...beforeRequest,
    precondition: { kind: 'must-match', fileId: afterOriginal.id, version: afterOriginal.version },
    resumableOperationId: 'cancel-after',
    signal: afterController.signal,
  }

  await withFakeFetch(afterFake, async () => {
    const reconciled = await provider(afterFake, afterPersistence).conditionalUploadBlob!(afterRequest)
    expect(reconciled.version).toBe('4')
  })
  expect(afterFake.mutationCount).toBe(1)
  expect((await afterPersistence.read('scope-a', afterRequest.resumableOperationId!))?.state).toBe('completed')
})

test('an expired resumable session becomes ambiguous and retries with the same immutable identity', async () => {
  const persistence = new MemoryDriveResumableOperationPersistence()
  const fake = new ConditionalDriveHttpFake()
  fake.expireNextSessionBeforeCommit = true
  const original = fake.addTarget(new Blob(['base'], { type: 'application/octet-stream' }))
  const content = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' })
  const request: DriveConditionalBlobWrite = {
    parentFolderId: parentId,
    path: targetPath,
    name: original.name,
    blob: content,
    mimeType: 'application/octet-stream',
    sha256: await sha256Hex(content),
    precondition: { kind: 'must-match', fileId: original.id, version: original.version },
    resumableOperationId: 'expired-session-update',
  }

  await withFakeFetch(fake, async () => {
    await expect(provider(fake, persistence).conditionalUploadBlob!(request)).rejects.toBeInstanceOf(DriveWriteAmbiguousCommitError)
    expect((await persistence.read('scope-a', request.resumableOperationId!))?.state).toBe('ambiguous')
    const retried = await provider(fake, persistence).conditionalUploadBlob!(request)
    expect(retried.version).toBe('4')
  })
  expect(fake.mutationCount).toBe(1)
  expect((await persistence.read('scope-a', request.resumableOperationId!))?.state).toBe('completed')
})
