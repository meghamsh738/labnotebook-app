import { expect, test } from '@playwright/test'
import {
  driveV2AppProperties,
  driveV2BlobId,
  driveV2BlobPath,
} from '../src/sync/driveV2Graph'
import { DriveV2CreateArtifact } from '../src/sync/driveV2OfflinePrimitives'
import {
  DriveV2LiveValidationClient,
  DriveV2LiveValidationError,
  type DriveV2LiveFile,
} from './support/driveV2LiveValidationClient'

type Stored = DriveV2LiveFile & { bytes: Uint8Array }

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let index = start; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer
    }
    return index
  }
  return -1
}

async function parseMultipartRelated(init: RequestInit): Promise<{ metadata: Record<string, unknown>; bytes: Uint8Array }> {
  const contentType = new Headers(init.headers).get('Content-Type') ?? ''
  const boundary = contentType.match(/^multipart\/related; boundary=(.+)$/)?.[1]
  if (!boundary) throw new Error('Expected multipart/related Drive upload.')
  const raw = new Uint8Array(await (init.body as Blob).arrayBuffer())
  const encoder = new TextEncoder()
  const headerEnd = encoder.encode('\r\n\r\n')
  const divider = encoder.encode(`\r\n--${boundary}\r\n`)
  const closing = encoder.encode(`\r\n--${boundary}--\r\n`)
  const firstBody = indexOfBytes(raw, headerEnd)
  const secondPart = indexOfBytes(raw, divider, firstBody + headerEnd.length)
  const secondBody = indexOfBytes(raw, headerEnd, secondPart + divider.length)
  const end = indexOfBytes(raw, closing, secondBody + headerEnd.length)
  if ([firstBody, secondPart, secondBody, end].some((value) => value < 0)) throw new Error('Invalid multipart/related body.')
  const metadataBytes = raw.slice(firstBody + headerEnd.length, secondPart)
  return {
    metadata: JSON.parse(new TextDecoder().decode(metadataBytes)) as Record<string, unknown>,
    bytes: raw.slice(secondBody + headerEnd.length, end),
  }
}

function fakeDrive(options: {
  listLagCallsAfterCreate?: number
  metadataNotFoundReadsAfterCreate?: number
  corruptCreatedBytes?: boolean
} = {}) {
  const files = new Map<string, Stored>()
  const sessions = new Map<string, Record<string, unknown>>()
  const listLagRemaining = new Map<string, number>()
  const metadataNotFoundRemaining = new Map<string, number>()
  const methods: string[] = []
  let nextId = 1
  const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
  const metadata = (record: Stored): DriveV2LiveFile => ({
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    trashed: record.trashed,
    version: record.version,
    parents: record.parents,
    appProperties: record.appProperties,
  })
  const store = (input: Record<string, unknown>, bytes: Uint8Array) => {
    const id = String(input.id)
    const storedBytes = Uint8Array.from(bytes)
    if (options.corruptCreatedBytes && storedBytes.length > 0) storedBytes[0] ^= 0xff
    files.set(id, {
      id,
      name: String(input.name),
      mimeType: String(input.mimeType),
      size: String(bytes.length),
      trashed: false,
      version: '1',
      parents: (input.parents as string[]) ?? [],
      appProperties: (input.appProperties as Record<string, string>) ?? {},
      bytes: storedBytes,
    })
    listLagRemaining.set(id, options.listLagCallsAfterCreate ?? 0)
    metadataNotFoundRemaining.set(id, options.metadataNotFoundReadsAfterCreate ?? 0)
  }
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = String(init.method ?? 'GET').toUpperCase()
    methods.push(method)
    if (url.pathname.endsWith('/files/generateIds')) {
      const count = Number(url.searchParams.get('count'))
      return json({ ids: Array.from({ length: count }, () => `generated-${nextId++}`) })
    }
    if (url.pathname.endsWith('/files') && method === 'GET') {
      const query = url.searchParams.get('q') ?? ''
      const parent = query.match(/^'([^']+)' in parents/)?.[1] ?? ''
      const visible = [...files.values()].filter((record) => {
        if (!record.parents?.includes(parent)) return false
        const remaining = listLagRemaining.get(record.id) ?? 0
        if (remaining > 0) {
          listLagRemaining.set(record.id, remaining - 1)
          return false
        }
        return true
      })
      return json({ files: visible.map(metadata) })
    }
    if (url.pathname.includes('/upload/drive/v3/files') && method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
      const parsed = await parseMultipartRelated(init)
      if (files.has(String(parsed.metadata.id))) return json({}, 409)
      store(parsed.metadata, parsed.bytes)
      return json(metadata(files.get(String(parsed.metadata.id))!))
    }
    if (url.pathname.endsWith('/upload/drive/v3/files') && method === 'POST' && url.searchParams.get('uploadType') === 'resumable') {
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>
      if (files.has(String(parsed.id))) return json({}, 409)
      const session = `https://upload.googleapis.com/session/${String(parsed.id)}`
      sessions.set(session, parsed)
      return new Response('', { status: 200, headers: { Location: session } })
    }
    if (url.hostname === 'upload.googleapis.com' && method === 'PUT') {
      const parsed = sessions.get(url.toString())
      if (!parsed) return json({}, 404)
      const body = init.body as Blob
      store(parsed, new Uint8Array(await body.arrayBuffer()))
      return json(metadata(files.get(String(parsed.id))!))
    }
    const fileId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
    const record = files.get(fileId)
    if (!record) return json({}, 404)
    if (url.searchParams.get('alt') === 'media') return new Response(record.bytes)
    const remainingNotFound = metadataNotFoundRemaining.get(fileId) ?? 0
    if (remainingNotFound > 0) {
      metadataNotFoundRemaining.set(fileId, remainingNotFound - 1)
      return json({}, 404)
    }
    return json(metadata(record))
  }
  return { files, methods, fetchImpl }
}

async function blobArtifact(options: {
  bytes: Uint8Array
  driveFileId: string
  folderId?: string
  operationId?: string | null
}) {
  const workspaceId = 'ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const id = await driveV2BlobId(options.bytes)
  const digest = id.slice('blob-v2-'.length)
  return DriveV2CreateArtifact.create({
    kind: 'blob',
    generatedDriveFileId: options.driveFileId,
    parentFolderDriveFileId: options.folderId ?? 'blobs-folder',
    canonicalId: id,
    path: driveV2BlobPath(id),
    mimeType: 'application/octet-stream',
    bytes: options.bytes,
    appProperties: driveV2AppProperties(workspaceId, 'blob', id, digest),
    resumableOperationId: options.operationId ?? null,
  })
}

function client(fetchImpl: typeof fetch, reconciliationDelaysMs: readonly number[] = [0]) {
  return new DriveV2LiveValidationClient({
    accessToken: 'ephemeral-test-token',
    accountScopeId: 'drive-v2-live:allowed-test-account',
    runId: '2026-08-12t12-00-00-000z-0123456789ab',
    fetchImpl,
    reconciliationDelaysMs,
  })
}

test('v2 live client uses pre-generated-id multipart creation and exact lost-response reconciliation', async () => {
  const drive = fakeDrive()
  const live = client(drive.fetchImpl)
  const ids = await live.generateFileIds(1)
  const artifact = await blobArtifact({ bytes: new Uint8Array([1, 2, 3, 4]), driveFileId: ids[0] })
  live.setFault('lose-response-after-create', artifact.path)

  const receipt = await live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)
  expect(live.faultUsed).toBe(true)
  expect(receipt.driveFileId).toBe(ids[0])
  expect(drive.files.size).toBe(1)
  expect(await live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)).toEqual(receipt)
  expect(drive.files.size).toBe(1)
  expect(drive.methods).not.toContain('PATCH')
  expect(drive.methods).not.toContain('DELETE')
})

test('v2 live client interrupts a resumable create before content and retries the same generated id', async () => {
  const drive = fakeDrive()
  const live = client(drive.fetchImpl)
  const bytes = new Uint8Array(5 * 1024 * 1024)
  bytes[0] = 42
  const artifact = await blobArtifact({
    bytes,
    driveFileId: 'generated-large-id',
    operationId: 'native-large-create-operation',
  })
  live.setFault('interrupt-before-resumable-content', artifact.path)

  await expect(live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)).rejects.toMatchObject({
    code: 'ambiguous-create',
  })
  expect(drive.files.size).toBe(0)
  live.setFault('none')
  const receipt = await live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)
  expect(receipt.driveFileId).toBe('generated-large-id')
  expect(drive.files.size).toBe(1)
  expect(drive.methods.filter((method) => method === 'POST')).toHaveLength(2)
  expect(drive.methods.filter((method) => method === 'PUT')).toHaveLength(1)
})

test('v2 lost-response reconciliation uses the generated id through list lag and transient 404 reads', async () => {
  const drive = fakeDrive({ listLagCallsAfterCreate: 3, metadataNotFoundReadsAfterCreate: 2 })
  const live = client(drive.fetchImpl, [0, 0, 0])
  const artifact = await blobArtifact({ bytes: new Uint8Array([4, 3, 2, 1]), driveFileId: 'generated-list-lag' })
  live.setFault('lose-response-after-create', artifact.path)

  const receipt = await live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)

  expect(receipt.driveFileId).toBe('generated-list-lag')
  expect(live.faultUsed).toBe(true)
  expect(await live.listChildren('blobs-folder')).toHaveLength(0)
  expect(drive.files.size).toBe(1)
})

test('v2 direct-id lost-response reconciliation preserves an exact byte mismatch', async () => {
  const drive = fakeDrive({ listLagCallsAfterCreate: 3, corruptCreatedBytes: true })
  const live = client(drive.fetchImpl)
  const artifact = await blobArtifact({ bytes: new Uint8Array([1, 3, 5, 7]), driveFileId: 'generated-corrupt' })
  live.setFault('lose-response-after-create', artifact.path)

  await expect(live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)).rejects.toMatchObject({
    code: 'create-reconciliation-mismatch',
  })
  expect(drive.files.size).toBe(1)
})

test('v2 an existing fault target is reconciled without moving the fault to the next artifact', async () => {
  const drive = fakeDrive()
  const live = client(drive.fetchImpl)
  const target = await blobArtifact({ bytes: new Uint8Array([2, 4, 6]), driveFileId: 'generated-target' })
  const later = await blobArtifact({ bytes: new Uint8Array([3, 5, 7]), driveFileId: 'generated-later' })
  await live.createOrReconcile('drive-v2-live:allowed-test-account', target)
  live.setFault('lose-response-after-create', target.path)

  await live.createOrReconcile('drive-v2-live:allowed-test-account', target)
  await live.createOrReconcile('drive-v2-live:allowed-test-account', later)

  expect(live.faultUsed).toBe(true)
  expect([...drive.files.keys()]).toEqual(['generated-target', 'generated-later'])
})

test('v2 orphan retry reuses its generated id, suppresses an early commit, and publishes one commit last', async () => {
  const drive = fakeDrive({ listLagCallsAfterCreate: 2, metadataNotFoundReadsAfterCreate: 2 })
  const first = client(drive.fetchImpl, [0])
  const orphan = await blobArtifact({ bytes: new Uint8Array([8, 6, 4, 2]), driveFileId: 'generated-orphan' })
  const commit = await blobArtifact({ bytes: new Uint8Array([9, 7, 5, 3]), driveFileId: 'generated-commit' })
  first.setFault('lose-response-after-create', orphan.path)

  await expect(first.createOrReconcile('drive-v2-live:allowed-test-account', orphan)).rejects.toMatchObject({
    code: 'ambiguous-create',
  })
  expect(drive.files.has('generated-orphan')).toBe(true)
  expect(drive.files.has('generated-commit')).toBe(false)

  const resumed = client(drive.fetchImpl, [0, 0])
  resumed.setFault('lose-response-after-create', orphan.path)
  await resumed.createOrReconcile('drive-v2-live:allowed-test-account', orphan)
  await resumed.createOrReconcile('drive-v2-live:allowed-test-account', commit)

  expect(resumed.faultUsed).toBe(true)
  expect([...drive.files.keys()]).toEqual(['generated-orphan', 'generated-commit'])
  expect([...drive.files.keys()].filter((id) => id === 'generated-commit')).toHaveLength(1)
})

test('v2 live client fails closed for duplicates, changed identity, and account switching', async () => {
  const drive = fakeDrive()
  const live = client(drive.fetchImpl)
  const artifact = await blobArtifact({ bytes: new Uint8Array([9, 8, 7]), driveFileId: 'generated-original' })
  await live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)

  const duplicate = { ...drive.files.get('generated-original')!, id: 'generated-duplicate' }
  drive.files.set(duplicate.id, duplicate)
  await expect(live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)).rejects.toBeInstanceOf(
    DriveV2LiveValidationError,
  )
  await expect(live.createOrReconcile('drive-v2-live:other-account', artifact)).rejects.toMatchObject({ code: 'account-switch' })

  drive.files.delete('generated-duplicate')
  drive.files.set('generated-original', {
    ...drive.files.get('generated-original')!,
    appProperties: { changed: 'true' },
  })
  await expect(live.createOrReconcile('drive-v2-live:allowed-test-account', artifact)).rejects.toMatchObject({
    code: 'create-reconciliation-mismatch',
  })
})
