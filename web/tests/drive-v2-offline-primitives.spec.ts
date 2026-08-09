import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DriveV2ContractError,
  driveV2CanonicalBytes,
  driveV2CanonicalJson,
  driveV2CanonicalSha256,
  driveV2DecodeCanonicalObject,
  driveV2Sha256,
  type DriveV2JsonObject,
} from '../src/sync/driveV2CanonicalJson'
import {
  DRIVE_V2_JSON_MIME_TYPE,
  DRIVE_V2_RESUMABLE_THRESHOLD_BYTES,
  classifyDriveV2Frontier,
  driveV2AppProperties,
  driveV2BlobId,
  driveV2BlobPath,
  driveV2CommitId,
  driveV2CommitPath,
  driveV2ObjectId,
  driveV2ObjectPath,
  projectDriveV2Workspace,
  validateDriveV2Commit,
  validateDriveV2Object,
  validateDriveV2Workspace,
} from '../src/sync/driveV2Graph'
import {
  DriveV2CreateArtifact,
  DriveV2CreateTransaction,
  DriveV2CreateTransactionError,
  DriveV2CreateTransactionExecutor,
  DriveV2OperationJournal,
  DriveV2PlanReadiness,
  DriveV2RemoteArtifact,
  validateDriveV2BeforePlan,
  type DriveV2ArtifactDescriptor,
  type DriveV2CreateOnlyClient,
  type DriveV2CreateReceipt,
  type DriveV2PreflightSnapshot,
  type DriveV2RemoteArtifactInput,
  type DriveV2WorkspaceItem,
} from '../src/sync/driveV2OfflinePrimitives'

const fixtureRoot = fileURLToPath(new URL('../../contracts/drive-v2-append-only/', import.meta.url))

type GraphFixture = {
  workspaceId: string
  objects: Array<{ expectedId: string; body: DriveV2JsonObject }>
  commits: Array<{ expectedId: string; body: DriveV2JsonObject }>
  expected?: Record<string, unknown>
}

type RemoteArtifactFixture = {
  kind?: 'blob' | 'commit' | 'object'
  driveFileId: string
  parentFolderDriveFileId: string
  path: string
  mimeType: string
  byteCount: number
  expectedId: string
  expectedContentSha256: string
  appProperties: Record<string, string>
  bytesBase64?: string
  downloadedBytesBase64?: string
}

type InterruptedFixture = GraphFixture & {
  blobs: RemoteArtifactFixture[]
  objects: Array<RemoteArtifactFixture & { body: DriveV2JsonObject }>
  commits: Array<RemoteArtifactFixture & { body: DriveV2JsonObject }>
}

type PreflightFixture = {
  accountScopeId: string
  operationId: string
  workspaceId: string
  savedRootDriveFileId: string
  root: DriveV2WorkspaceItem
  managedFolders: DriveV2WorkspaceItem[]
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')) as T
}

async function expectCode(action: () => unknown | Promise<unknown>, code: string) {
  try {
    await action()
    throw new Error(`Expected Drive v2 error ${code}.`)
  } catch (error) {
    expect(error).toBeInstanceOf(DriveV2ContractError)
    expect((error as DriveV2ContractError).code).toBe(code)
  }
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function remoteArtifact(fixtureValue: RemoteArtifactFixture, kind: 'blob' | 'commit' | 'object') {
  const base64 = kind === 'blob' ? fixtureValue.bytesBase64 : fixtureValue.downloadedBytesBase64
  if (!base64) throw new Error(`Fixture ${fixtureValue.path} is missing downloaded bytes.`)
  return new DriveV2RemoteArtifact({
    kind,
    driveFileId: fixtureValue.driveFileId,
    parentFolderDriveFileId: fixtureValue.parentFolderDriveFileId,
    path: fixtureValue.path,
    mimeType: fixtureValue.mimeType,
    byteCount: fixtureValue.byteCount,
    expectedId: fixtureValue.expectedId,
    expectedContentSha256: fixtureValue.expectedContentSha256,
    appProperties: fixtureValue.appProperties,
    bytes: base64Bytes(base64),
  })
}

function cloneRemote(artifact: DriveV2RemoteArtifact, overrides: Partial<DriveV2RemoteArtifactInput> = {}) {
  return new DriveV2RemoteArtifact({
    kind: artifact.kind,
    driveFileId: artifact.driveFileId,
    parentFolderDriveFileId: artifact.parentFolderDriveFileId,
    path: artifact.path,
    mimeType: artifact.mimeType,
    byteCount: artifact.byteCount,
    expectedId: artifact.expectedId,
    expectedContentSha256: artifact.expectedContentSha256,
    appProperties: artifact.appProperties,
    bytes: artifact.bytes,
    ...overrides,
  })
}

async function buildPreflight(options: {
  descriptors?: readonly DriveV2ArtifactDescriptor[]
  operationId?: string
} = {}): Promise<DriveV2PreflightSnapshot> {
  const preflight = await fixture<PreflightFixture>('preflight.json')
  const interrupted = await fixture<InterruptedFixture>('interrupted-transaction.json')
  const artifacts = [
    ...interrupted.blobs.map((record) => remoteArtifact(record, 'blob')),
    ...interrupted.objects.map((record) => remoteArtifact(record, 'object')),
    ...interrupted.commits.map((record) => remoteArtifact(record, 'commit')),
  ]
  const managedFolderIds = Object.fromEntries(preflight.managedFolders.map((folder) => [folder.name, folder.driveFileId]))
  const descriptors = [...(options.descriptors ?? artifacts.map((artifact) => artifact.descriptor()))]
    .sort((left, right) => left.canonicalId.localeCompare(right.canonicalId))
  const operationId = options.operationId ?? preflight.operationId
  const journal = new DriveV2OperationJournal({
    accountScopeId: preflight.accountScopeId,
    savedRootDriveFileId: preflight.savedRootDriveFileId,
    workspaceId: preflight.workspaceId,
    operationId,
    managedFolderIds,
    artifactDescriptors: descriptors,
  })
  return {
    currentAccountScopeId: preflight.accountScopeId,
    currentSavedRootDriveFileId: preflight.savedRootDriveFileId,
    currentWorkspaceId: preflight.workspaceId,
    currentOperationId: operationId,
    currentManagedFolderIds: managedFolderIds,
    currentArtifactDescriptors: descriptors,
    journal,
    roots: [preflight.root],
    folders: preflight.managedFolders,
    artifacts,
  }
}

async function createArtifact(remote: DriveV2RemoteArtifact, resumableOperationId: string | null = null) {
  return DriveV2CreateArtifact.create({
    kind: remote.kind,
    generatedDriveFileId: remote.driveFileId,
    parentFolderDriveFileId: remote.parentFolderDriveFileId,
    canonicalId: remote.expectedId,
    path: remote.path,
    mimeType: remote.mimeType,
    bytes: remote.bytes,
    appProperties: remote.appProperties,
    resumableOperationId,
  })
}

async function createTransaction() {
  const interrupted = await fixture<InterruptedFixture>('interrupted-transaction.json')
  const remotes = [
    ...interrupted.blobs.map((record) => remoteArtifact(record, 'blob')),
    ...interrupted.objects.map((record) => remoteArtifact(record, 'object')),
    remoteArtifact(interrupted.commits[0], 'commit'),
  ]
  const artifacts = await Promise.all(remotes.map((remote) => createArtifact(remote)))
  const blobs = artifacts.filter((artifact) => artifact.kind === 'blob')
  const objects = artifacts.filter((artifact) => artifact.kind === 'object')
    .sort((left, right) => left.path.localeCompare(right.path))
  const commit = artifacts.find((artifact) => artifact.kind === 'commit')!
  const operationId = String(driveV2DecodeCanonicalObject(commit.bytes).operationId)
  const readiness = await validateDriveV2BeforePlan(await buildPreflight({
    descriptors: artifacts.map((artifact) => artifact.descriptor()),
    operationId,
  }))
  return DriveV2CreateTransaction.create(readiness, blobs, objects, commit)
}

function receipt(artifact: DriveV2CreateArtifact): DriveV2CreateReceipt {
  return {
    driveFileId: artifact.generatedDriveFileId,
    parentFolderDriveFileId: artifact.parentFolderDriveFileId,
    path: artifact.path,
    canonicalId: artifact.canonicalId,
    contentSha256: artifact.contentSha256,
    mimeType: artifact.mimeType,
    appProperties: artifact.appProperties,
    byteCount: artifact.byteCount,
    trashed: false,
    stableSecondRead: true,
  }
}

test('web canonical JSON matches the shared RFC vector and rejects malformed raw bytes', async () => {
  const shared = await fixture<{
    input: DriveV2JsonObject
    expectedCanonicalJson: string
    expectedSha256: string
  }>('canonicalization.json')
  expect(driveV2CanonicalJson(shared.input)).toBe(shared.expectedCanonicalJson)
  expect(await driveV2CanonicalSha256(shared.input)).toBe(shared.expectedSha256)
  expect(driveV2DecodeCanonicalObject(driveV2CanonicalBytes(shared.input))).toEqual(shared.input)

  await expectCode(() => driveV2DecodeCanonicalObject(Buffer.from(` ${shared.expectedCanonicalJson}`)), 'noncanonical-json-bytes')
  await expectCode(() => driveV2DecodeCanonicalObject(Uint8Array.from([0xef, 0xbb, 0xbf, ...driveV2CanonicalBytes(shared.input)])), 'noncanonical-json-bytes')
  await expectCode(() => driveV2DecodeCanonicalObject(Uint8Array.from([0xc3, 0x28])), 'invalid-utf8')
  await expectCode(() => driveV2CanonicalJson({ value: '\ud800' }), 'invalid-unicode-scalar')
})

test('web independently derives shared conflicts, delete-edit hiding, and descendant suppression', async () => {
  const concurrent = await fixture<GraphFixture>('concurrent-edits.json')
  const concurrentState = await validateDriveV2Workspace(concurrent.workspaceId, concurrent.objects, [], concurrent.commits)
  const expected = concurrent.expected as {
    tips: string[]
    maximalObjectIds: string[]
    decision: string
    conflictId: string
  }
  const firstBody = concurrent.objects[0].body
  const key = `${String(firstBody.entityKind)}:${String(firstBody.entityId)}`
  expect(concurrentState.tips).toEqual(expected.tips)
  expect(concurrentState.frontiers[key]).toEqual(expected.maximalObjectIds)
  const decision = await classifyDriveV2Frontier(concurrentState.frontiers[key], concurrentState.objectMap)
  expect(decision.decision).toBe(expected.decision)
  expect(decision.conflictId).toBe(expected.conflictId)
  expect(decision.visible).toBe(false)
  const originalProjection = await projectDriveV2Workspace(concurrentState)
  expect(() => {
    const body = concurrentState.objectMap.get(expected.maximalObjectIds[0])!.body as Record<string, unknown>
    body.operation = 'upsert'
  }).toThrow()
  expect(() => (concurrentState.frontiers[key] as string[]).push('obj-v2-forged')).toThrow()
  expect((concurrentState.objectMap as unknown as { set?: unknown }).set).toBeUndefined()
  expect(await projectDriveV2Workspace(concurrentState)).toEqual(originalProjection)

  const race = await fixture<GraphFixture & {
    raceSnapshot: { commitIds: string[]; expected: { visibleTargets: string[]; suppressedTargets: string[] } }
    resolvedSnapshot: { commitIds: string[]; expected: { visibleTargets: string[]; suppressedTargets: string[] } }
  }>('delete-edit-race.json')
  for (const snapshot of [race.raceSnapshot, race.resolvedSnapshot]) {
    const state = await validateDriveV2Workspace(
      race.workspaceId,
      race.objects,
      [],
      race.commits.filter((record) => snapshot.commitIds.includes(record.expectedId)),
    )
    const projection = await projectDriveV2Workspace(state)
    expect(projection.visibleTargets).toEqual(snapshot.expected.visibleTargets)
    expect(projection.suppressedTargets).toEqual(snapshot.expected.suppressedTargets)
  }
})

test('web independently reproduces the staged Android, web, Electron, and Android return fixture', async () => {
  type CrossClientRecord = {
    origin: string
    body: DriveV2JsonObject
    expectedId: string
    expectedContentSha256: string
    expectedPath: string
  }
  type CrossClientFixture = {
    workspaceId: string
    liveDriveUsed: boolean
    productionWritesEnabled: boolean
    blobs: Array<{
      bytesBase64: string
      mimeType: string
      byteCount: number
      expectedId: string
      expectedContentSha256: string
      path: string
    }>
    objects: CrossClientRecord[]
    commits: CrossClientRecord[]
    stages: Array<{
      name: string
      client: string
      commitIds: string[]
      expected: {
        tips: string[]
        frontiers: Record<string, string[]>
        visibleTargets: string[]
        suppressedTargets: string[]
      }
    }>
    transactions: Array<{
      client: string
      operationId: string
      writeOrder: string[]
      commitLast: boolean
    }>
    recovery: {
      uncommittedObjectId: string
      orphanVisible: boolean
      resurrectionAllowed: boolean
      physicalDeletionCount: number
      unknownRemoteField: string
      unknownRemoteFieldPreserved: boolean
      localOnlyFieldsAbsent: string[]
    }
  }

  const shared = await fixture<CrossClientFixture>('cross-client-round-trip.json')
  expect(shared.liveDriveUsed).toBe(false)
  expect(shared.productionWritesEnabled).toBe(false)

  const sharedBlob = shared.blobs[0]
  const blobBytes = base64Bytes(sharedBlob.bytesBase64)
  expect(blobBytes.byteLength).toBe(sharedBlob.byteCount)
  expect(await driveV2Sha256(blobBytes)).toBe(sharedBlob.expectedContentSha256)
  expect(await driveV2BlobId(blobBytes)).toBe(sharedBlob.expectedId)
  expect(driveV2BlobPath(sharedBlob.expectedId)).toBe(sharedBlob.path)

  for (const record of shared.objects) {
    expect(await driveV2ObjectId(record.body)).toBe(record.expectedId)
    expect(await driveV2CanonicalSha256(record.body)).toBe(record.expectedContentSha256)
    expect(driveV2ObjectPath(record.expectedId)).toBe(record.expectedPath)
  }
  for (const record of shared.commits) {
    expect(await driveV2CommitId(record.body)).toBe(record.expectedId)
    expect(await driveV2CanonicalSha256(record.body)).toBe(record.expectedContentSha256)
    expect(driveV2CommitPath(record.expectedId)).toBe(record.expectedPath)
  }

  const blobRecords = shared.blobs.map((record) => ({
    expectedId: record.expectedId,
    bytes: base64Bytes(record.bytesBase64),
    mimeType: record.mimeType,
  }))
  for (const stage of shared.stages) {
    const state = await validateDriveV2Workspace(
      shared.workspaceId,
      shared.objects,
      blobRecords,
      shared.commits.filter((record) => stage.commitIds.includes(record.expectedId)),
    )
    const projection = await projectDriveV2Workspace(state)
    expect(state.tips).toEqual(stage.expected.tips)
    expect(state.frontiers).toEqual(stage.expected.frontiers)
    expect(projection.visibleTargets).toEqual(stage.expected.visibleTargets)
    expect(projection.suppressedTargets).toEqual(stage.expected.suppressedTargets)
  }

  const objectsById = new Map(shared.objects.map((record) => [record.expectedId, record]))
  for (const transaction of shared.transactions) {
    const commit = shared.commits.find((record) => record.body.operationId === transaction.operationId)!
    const expectedOrder = [
      ...(commit.body.blobIds as string[]).map(driveV2BlobPath),
      ...(commit.body.objectIds as string[]).map((id) => objectsById.get(id)!.expectedPath),
      commit.expectedPath,
    ]
    expect(commit.origin).toBe(transaction.client)
    expect(transaction.writeOrder).toEqual(expectedOrder)
    expect(transaction.commitLast).toBe(true)
    expect(transaction.writeOrder.at(-1)).toBe(commit.expectedPath)
  }

  const finalStage = shared.stages.find((stage) => stage.name === 'android-return')!
  const finalState = await validateDriveV2Workspace(
    shared.workspaceId,
    shared.objects,
    blobRecords,
    shared.commits.filter((record) => finalStage.commitIds.includes(record.expectedId)),
  )
  expect(finalState.visibleObjectIds.includes(shared.recovery.uncommittedObjectId))
    .toBe(shared.recovery.orphanVisible)
  expect(shared.recovery.resurrectionAllowed).toBe(false)
  expect(shared.recovery.physicalDeletionCount).toBe(0)
  const entryPayloads = shared.objects
    .filter((record) => record.body.entityKind === 'entry' && record.body.payload !== null)
    .map((record) => record.body.payload as DriveV2JsonObject)
  expect(entryPayloads.every((payload) => shared.recovery.unknownRemoteField in payload)).toBe(true)
  expect(shared.recovery.unknownRemoteFieldPreserved).toBe(true)
  for (const localOnlyField of shared.recovery.localOnlyFieldsAbsent) {
    expect(entryPayloads.every((payload) => !(localOnlyField in payload))).toBe(true)
  }
})

test('web artifact validators fail closed on malformed types, floating payloads, and invalid timestamps', async () => {
  const workspaceId = 'ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const body: DriveV2JsonObject = {
    protocol: 'easylab-drive-v2-append-only',
    schemaVersion: 2,
    workspaceId,
    entityKind: 'entry',
    entityId: 'entry-web',
    operation: 'upsert',
    baseObjectIds: [],
    blobIds: [],
    payload: { id: 'entry-web' },
    tombstone: null,
    resolutionOf: [],
  }
  const id = `obj-v2-${await driveV2CanonicalSha256(body)}`
  await validateDriveV2Object({ expectedId: id, body }, workspaceId)
  await expectCode(() => validateDriveV2Object({ expectedId: id, body: { ...body, schemaVersion: '2' } }, workspaceId), 'artifact-schema-mismatch')
  await expectCode(async () => {
    const floating = { ...body, payload: { id: 'entry-web', measurement: 0.5 } }
    await validateDriveV2Object({ expectedId: await driveV2CommitId(floating), body: floating }, workspaceId)
  }, 'unsupported-artifact-number')

  for (const createdAt of ['0000-01-01T00:00:00.000Z', '1582-10-10T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
    const commitBody: DriveV2JsonObject = {
      protocol: 'easylab-drive-v2-append-only', schemaVersion: 2, workspaceId,
      operationId: `op-${createdAt}`, createdAt, parentCommitIds: [], objectIds: [], blobIds: [],
    }
    await validateDriveV2Commit({ expectedId: await driveV2CommitId(commitBody), body: commitBody }, workspaceId)
  }
  const invalidBody: DriveV2JsonObject = {
    protocol: 'easylab-drive-v2-append-only', schemaVersion: 2, workspaceId,
    operationId: 'op-invalid-date', createdAt: '1900-02-29T00:00:00.000Z',
    parentCommitIds: [], objectIds: [], blobIds: [],
  }
  await expectCode(
    () => validateDriveV2Commit({ expectedId: 'commit-v2-invalid', body: invalidBody }, workspaceId),
    'noncanonical-utc',
  )
})

test('web preflight snapshots account, root, folders, descriptors, bytes, and duplicate identity', async () => {
  const valid = await buildPreflight()
  const readiness = await validateDriveV2BeforePlan(valid)
  expect(readiness.projection.visibleTargets).toContain('entry:entry-interrupted')
  await expectCode(
    () => new DriveV2PlanReadiness(readiness.state, readiness.projection, valid.journal, Symbol('forged')),
    'unvalidated-readiness',
  )
  const forgedJournal = {
    accountScopeId: valid.journal.accountScopeId,
    savedRootDriveFileId: valid.journal.savedRootDriveFileId,
    workspaceId: valid.journal.workspaceId,
    operationId: valid.journal.operationId,
    managedFolderIds: structuredClone(valid.journal.managedFolderIds),
    artifactDescriptors: structuredClone(valid.journal.artifactDescriptors),
  } as unknown as DriveV2OperationJournal
  const forgedPreflight = validateDriveV2BeforePlan({ ...valid, journal: forgedJournal })
  ;(forgedJournal as unknown as { accountScopeId: string }).accountScopeId = 'switched-during-hash'
  await expectCode(() => forgedPreflight, 'unvalidated-operation-journal')

  await expectCode(() => validateDriveV2BeforePlan({ ...valid, currentAccountScopeId: 'other-account' }), 'account-switch')
  const duplicateRoot = { ...valid.roots[0], driveFileId: 'duplicate-marked-root' }
  await expectCode(() => validateDriveV2BeforePlan({ ...valid, roots: [...valid.roots, duplicateRoot] }), 'duplicate-marked-root')
  await expectCode(() => validateDriveV2BeforePlan({
    ...valid,
    currentArtifactDescriptors: valid.currentArtifactDescriptors.map((descriptor, index) =>
      index === 0 ? { ...descriptor, contentSha256: 'f'.repeat(64) } : descriptor),
  }), 'changed-artifact-descriptor')

  const firstObject = valid.artifacts.find((artifact) => artifact.kind === 'object')!
  const exactDuplicate = cloneRemote(firstObject, { driveFileId: 'exact-duplicate-drive-id' })
  await validateDriveV2BeforePlan({ ...valid, artifacts: [...valid.artifacts, exactDuplicate] })
  const divergent = cloneRemote(firstObject, { driveFileId: 'divergent-drive-id', bytes: Uint8Array.from([...firstObject.bytes, 0x20]) })
  await expectCode(() => validateDriveV2BeforePlan({ ...valid, artifacts: [...valid.artifacts, divergent] }), 'divergent-duplicate')

  const callerBytes = firstObject.bytes
  const pending = validateDriveV2BeforePlan(valid)
  callerBytes.fill(0)
  await pending
})

test('web create-only executor is commit-last, verifies receipts, suppresses commit on failure, and propagates cancellation', async () => {
  const transaction = await createTransaction()
  const calls: string[] = []
  const client: DriveV2CreateOnlyClient = {
    async createOrReconcile(accountScopeId, artifact) {
      expect(accountScopeId).toBe(transaction.accountScopeId)
      calls.push(artifact.path)
      return receipt(artifact)
    },
  }
  const result = await new DriveV2CreateTransactionExecutor(client).execute(transaction)
  expect(calls.at(-1)).toBe(transaction.commit.path)
  expect(calls.slice(0, -1)).toEqual([...transaction.blobs, ...transaction.objects].map((artifact) => artifact.path))
  expect(result.prerequisiteReceipts).toHaveLength(transaction.blobs.length + transaction.objects.length)
  expect(result.commitReceipt.path).toBe(transaction.commit.path)

  const failedCalls: string[] = []
  const failure = new DriveV2CreateTransactionExecutor({
    async createOrReconcile(_accountScopeId, artifact) {
      failedCalls.push(artifact.path)
      if (artifact.kind === 'object') throw new Error('injected prerequisite failure')
      return receipt(artifact)
    },
  }).execute(transaction)
  await expect(failure).rejects.toBeInstanceOf(DriveV2CreateTransactionError)
  expect(failedCalls).not.toContain(transaction.commit.path)

  const mismatched = new DriveV2CreateTransactionExecutor({
    async createOrReconcile(_accountScopeId, artifact) {
      return { ...receipt(artifact), mimeType: 'application/mismatched' }
    },
  }).execute(transaction)
  await expect(mismatched).rejects.toMatchObject({
    cause: expect.objectContaining({ code: 'create-reconciliation-mismatch' }),
  })

  const cancelled = new DOMException('cancelled', 'AbortError')
  const cancellation = new DriveV2CreateTransactionExecutor({
    async createOrReconcile() { throw cancelled },
  }).execute(transaction)
  await expect(cancellation).rejects.toBe(cancelled)

  const nodeAbort = new Error('node-style cancellation')
  nodeAbort.name = 'AbortError'
  const nodeCancellation = new DriveV2CreateTransactionExecutor({
    async createOrReconcile() { throw nodeAbort },
  }).execute(transaction)
  await expect(nodeCancellation).rejects.toBe(nodeAbort)

  const controller = new AbortController()
  const abortedCalls: string[] = []
  const abortAfterPrerequisite = new DriveV2CreateTransactionExecutor({
    async createOrReconcile(_accountScopeId, artifact) {
      abortedCalls.push(artifact.path)
      controller.abort()
      return receipt(artifact)
    },
  }).execute(transaction, controller.signal)
  await expect(abortAfterPrerequisite).rejects.toMatchObject({ name: 'AbortError' })
  expect(abortedCalls).toHaveLength(1)
  expect(abortedCalls).not.toContain(transaction.commit.path)

  const genericAbortController = new AbortController()
  const genericAbortCalls: string[] = []
  const genericAbort = new DriveV2CreateTransactionExecutor({
    async createOrReconcile(_accountScopeId, artifact) {
      genericAbortCalls.push(artifact.path)
      genericAbortController.abort()
      throw new TypeError('runtime reported a generic fetch failure after abort')
    },
  }).execute(transaction, genericAbortController.signal)
  await expect(genericAbort).rejects.toMatchObject({ name: 'AbortError' })
  expect(genericAbortCalls).toHaveLength(1)
  expect(genericAbortCalls).not.toContain(transaction.commit.path)
})

test('web create artifacts enforce the exact 5 MiB boundary and immutable resumable identity', async () => {
  const workspaceId = 'ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const makeBlob = async (
    size: number,
    operationId: string | null,
    parentFolderDriveFileId = 'blobs-folder',
    artifactWorkspaceId = workspaceId,
  ) => {
    const bytes = new Uint8Array(size)
    bytes[0] = size % 251
    const id = await driveV2BlobId(bytes)
    const digest = await driveV2Sha256(bytes)
    return DriveV2CreateArtifact.create({
      kind: 'blob',
      generatedDriveFileId: `generated-${size}`,
      parentFolderDriveFileId,
      canonicalId: id,
      path: driveV2BlobPath(id),
      mimeType: 'application/octet-stream',
      bytes,
      appProperties: driveV2AppProperties(artifactWorkspaceId, 'blob', id, digest),
      resumableOperationId: operationId,
    })
  }

  const below = await makeBlob(DRIVE_V2_RESUMABLE_THRESHOLD_BYTES - 1, null)
  expect(below.resumableOperationId).toBeNull()
  await expectCode(
    () => makeBlob(DRIVE_V2_RESUMABLE_THRESHOLD_BYTES, null),
    'missing-resumable-operation-id',
  )
  const exactBoundary = await makeBlob(DRIVE_V2_RESUMABLE_THRESHOLD_BYTES, 'resume-exact-boundary')
  const above = await makeBlob(DRIVE_V2_RESUMABLE_THRESHOLD_BYTES + 1, 'resume-above-boundary')
  expect(exactBoundary.resumableOperationId).toBe('resume-exact-boundary')
  expect(above.resumableOperationId).toBe('resume-above-boundary')

  const base = await buildPreflight()
  const duplicateA = await makeBlob(
    DRIVE_V2_RESUMABLE_THRESHOLD_BYTES,
    'duplicated-resumable-operation',
    base.currentManagedFolderIds.blobs,
    base.currentWorkspaceId,
  )
  const duplicateB = await makeBlob(
    DRIVE_V2_RESUMABLE_THRESHOLD_BYTES + 1,
    'duplicated-resumable-operation',
    base.currentManagedFolderIds.blobs,
    base.currentWorkspaceId,
  )
  const operationId = 'op-web-v2-duplicate-resumable'
  const commitBody: DriveV2JsonObject = {
    protocol: 'easylab-drive-v2-append-only',
    schemaVersion: 2,
    workspaceId: base.currentWorkspaceId,
    operationId,
    createdAt: '2026-08-09T13:00:00.000Z',
    parentCommitIds: [],
    objectIds: [],
    blobIds: [duplicateA.canonicalId, duplicateB.canonicalId].sort(),
  }
  const commitId = await driveV2CommitId(commitBody)
  const commitBytes = driveV2CanonicalBytes(commitBody)
  const commit = await DriveV2CreateArtifact.create({
    kind: 'commit',
    generatedDriveFileId: 'generated-duplicate-resumable-commit',
    parentFolderDriveFileId: base.currentManagedFolderIds.commits,
    canonicalId: commitId,
    path: driveV2CommitPath(commitId),
    mimeType: DRIVE_V2_JSON_MIME_TYPE,
    bytes: commitBytes,
    appProperties: driveV2AppProperties(
      base.currentWorkspaceId,
      'commit',
      commitId,
      await driveV2Sha256(commitBytes),
    ),
  })
  const readiness = await validateDriveV2BeforePlan(await buildPreflight({
    descriptors: [duplicateA, duplicateB, commit].map((artifact) => artifact.descriptor()),
    operationId,
  }))
  await expectCode(
    () => DriveV2CreateTransaction.create(readiness, [duplicateA, duplicateB], [], commit),
    'duplicate-resumable-operation-id',
  )
})

test('normal provider and Electron renderer remain on the existing disabled web path', async () => {
  const provider = await readFile(fileURLToPath(new URL('../src/sync/syncProvider.ts', import.meta.url)), 'utf8')
  const app = await readFile(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')
  const electron = await readFile(fileURLToPath(new URL('../../desktop/main.cjs', import.meta.url)), 'utf8')
  expect(provider).toMatch(/class GoogleDriveSyncProvider[\s\S]*supportsVersionedCas = false/)
  expect(app).not.toContain('DriveV2CreateTransactionExecutor')
  expect(provider).not.toContain('DriveV2CreateTransactionExecutor')
  expect(electron).toContain("path.join(process.resourcesPath, 'web'")
})
