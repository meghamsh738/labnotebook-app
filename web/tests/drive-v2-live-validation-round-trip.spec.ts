import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  driveV2CanonicalBytes,
  driveV2Sha256,
  type DriveV2JsonObject,
} from '../src/sync/driveV2CanonicalJson'
import {
  DRIVE_V2_FOLDER_MIME_TYPE,
  DRIVE_V2_JSON_MIME_TYPE,
  driveV2AppProperties,
  driveV2BlobId,
  driveV2BlobPath,
  driveV2CommitId,
  driveV2CommitPath,
  driveV2ObjectId,
  driveV2ObjectPath,
  projectDriveV2Workspace,
} from '../src/sync/driveV2Graph'
import {
  DriveV2CreateArtifact,
  DriveV2CreateTransaction,
  DriveV2CreateTransactionError,
  DriveV2CreateTransactionExecutor,
  DriveV2OperationJournal,
  DriveV2RemoteArtifact,
  validateDriveV2BeforePlan,
  type DriveV2ArtifactDescriptor,
  type DriveV2PreflightSnapshot,
  type DriveV2WorkspaceItem,
} from '../src/sync/driveV2OfflinePrimitives'
import { DriveV2LiveValidationClient } from './support/driveV2LiveValidationClient'

const enabled = process.env.EASYLAB_DRIVE_V2_BROWSER_PHASE === 'web-append-electron-tombstone'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requiredForbiddenAccountSha256 = 'e39ed3e99d1d992cf2d81d2c4701dc22000d713fc37b2ae1047f7ca520fecd8b'
const required = (name: string): string => {
  const value = String(process.env[name] ?? '').trim()
  if (!value) throw new Error(`Drive v2 live validation requires ${name}.`)
  return value
}

type GatePlan = {
  runId: string
  planHash: string
  sourceCommit: string
  createdAt: string
  workspaceId: string
  evidenceRelativePath: string
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function exactEnvironmentGate(): GatePlan {
  const planFile = path.resolve(required('EASYLAB_DRIVE_V2_PLAN_FILE'))
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as GatePlan
  expect(required('EASYLAB_DRIVE_V2_RUN_ID')).toBe(plan.runId)
  expect(required('EASYLAB_DRIVE_V2_PLAN_HASH')).toBe(plan.planHash)
  expect(required('EASYLAB_DRIVE_V2_SOURCE_COMMIT')).toBe(plan.sourceCommit)
  expect(required('EASYLAB_DRIVE_V2_WORKSPACE_ID')).toBe(plan.workspaceId)
  expect(process.env.EASYLAB_DRIVE_V2_LIVE_WRITE_TEST).toBe('approved')
  expect(process.env.EASYLAB_DRIVE_V2_LIVE_MODE).toBe('debug-test')
  expect(process.env.EASYLAB_DRIVE_V2_USER_CONFIRMATION).toBe(`approved:${plan.runId}`)
  const forbidden = required('EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256')
    .split(/[\s,]+/)
    .filter(Boolean)
  expect(forbidden).toContain(requiredForbiddenAccountSha256)
  forbidden.forEach((value) => expect(value).toMatch(/^[0-9a-f]{64}$/))
  expect(required('EASYLAB_DRIVE_V2_ACCOUNT_SHA256')).toMatch(/^[0-9a-f]{64}$/)
  expect(git(['rev-parse', 'HEAD'])).toBe(plan.sourceCommit)
  expect(git(['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  expect(path.dirname(planFile)).toBe(path.resolve(repoRoot, plan.evidenceRelativePath))
  expect(git(['check-ignore', planFile])).not.toBe('')
  expect(fs.lstatSync(planFile).isSymbolicLink()).toBe(false)
  return plan
}

type Runtime = {
  plan: GatePlan
  client: DriveV2LiveValidationClient
  methods: string[]
  accountScopeId: string
  containerId: string
  rootId: string
  folderIds: Record<'objects' | 'blobs' | 'commits', string>
}

function runtime(): Runtime {
  const plan = exactEnvironmentGate()
  const methods: string[] = []
  const trackedFetch: typeof fetch = async (input, init = {}) => {
    methods.push(String(init.method ?? 'GET').toUpperCase())
    return fetch(input, init)
  }
  const accountScopeId = `drive-v2-live:${required('EASYLAB_DRIVE_V2_ACCOUNT_SHA256')}:${plan.runId}`
  const runId = plan.runId
  return {
    plan,
    methods,
    accountScopeId,
    containerId: required('EASYLAB_DRIVE_V2_CONTAINER_FOLDER_ID'),
    rootId: required('EASYLAB_DRIVE_V2_WORKSPACE_ROOT_ID'),
    folderIds: {
      objects: required('EASYLAB_DRIVE_V2_OBJECTS_FOLDER_ID'),
      blobs: required('EASYLAB_DRIVE_V2_BLOBS_FOLDER_ID'),
      commits: required('EASYLAB_DRIVE_V2_COMMITS_FOLDER_ID'),
    },
    client: new DriveV2LiveValidationClient({
      accessToken: required('EASYLAB_DRIVE_V2_ACCESS_TOKEN'),
      accountScopeId,
      runId,
      fetchImpl: trackedFetch,
    }),
  }
}

async function workspaceItem(client: DriveV2LiveValidationClient, id: string): Promise<DriveV2WorkspaceItem> {
  const file = await client.metadata(id)
  return {
    driveFileId: file.id,
    name: file.name,
    parentIds: [...(file.parents ?? [])],
    mimeType: file.mimeType ?? '',
    trashed: file.trashed === true,
    appProperties: file.appProperties ?? {},
  }
}

async function loadRemote(rt: Runtime) {
  const artifacts: DriveV2RemoteArtifact[] = []
  for (const role of ['objects', 'blobs', 'commits'] as const) {
    for (const file of await rt.client.listChildren(rt.folderIds[role])) {
      const kind = role === 'objects' ? 'object' : role === 'blobs' ? 'blob' : 'commit'
      const expectedId = String(file.appProperties?.easylabCanonicalId ?? '')
      const expectedDigest = String(file.appProperties?.easylabContentSha256 ?? '')
      expect(file.trashed).not.toBe(true)
      expect(file.name).toBe(`${expectedId}.${kind === 'blob' ? 'bin' : 'json'}`)
      expect(file.parents).toEqual([rt.folderIds[role]])
      expect(file.appProperties).toEqual(driveV2AppProperties(rt.plan.workspaceId, kind, expectedId, expectedDigest))
      if (kind === 'blob') {
        expect(file.mimeType?.trim()).not.toBe('')
        expect(file.mimeType).not.toBe(DRIVE_V2_FOLDER_MIME_TYPE)
      } else {
        expect(file.mimeType).toBe(DRIVE_V2_JSON_MIME_TYPE)
      }
      expect(file.version).toMatch(/^[1-9]\d*$/)
      const bytes = await rt.client.downloadBytes(file.id)
      expect(file.size).toBe(String(bytes.byteLength))
      expect(await driveV2Sha256(bytes)).toBe(expectedDigest)
      const stable = await rt.client.metadata(file.id)
      expect(stable).toEqual(file)
      artifacts.push(new DriveV2RemoteArtifact({
        kind,
        driveFileId: file.id,
        parentFolderDriveFileId: rt.folderIds[role],
        path: `${role}/${file.name}`,
        mimeType: file.mimeType ?? '',
        byteCount: bytes.byteLength,
        expectedId,
        expectedContentSha256: expectedDigest,
        appProperties: file.appProperties ?? {},
        bytes,
      }))
    }
  }
  const roots = [await workspaceItem(rt.client, rt.rootId)]
  const folders = await Promise.all(Object.values(rt.folderIds).map((id) => workspaceItem(rt.client, id)))
  return { artifacts, roots, folders }
}

async function readiness(rt: Runtime, operationId: string, descriptors: readonly DriveV2ArtifactDescriptor[]) {
  const remote = await loadRemote(rt)
  const journal = new DriveV2OperationJournal({
    accountScopeId: rt.accountScopeId,
    savedRootDriveFileId: rt.rootId,
    workspaceId: rt.plan.workspaceId,
    operationId,
    managedFolderIds: rt.folderIds,
    artifactDescriptors: descriptors,
    rootParentDriveFileId: rt.containerId,
  })
  const snapshot: DriveV2PreflightSnapshot = {
    currentAccountScopeId: rt.accountScopeId,
    currentSavedRootDriveFileId: rt.rootId,
    currentWorkspaceId: rt.plan.workspaceId,
    currentOperationId: operationId,
    currentManagedFolderIds: rt.folderIds,
    currentArtifactDescriptors: descriptors,
    journal,
    roots: remote.roots,
    folders: remote.folders,
    artifacts: remote.artifacts,
  }
  return validateDriveV2BeforePlan(snapshot)
}

async function jsonArtifact(rt: Runtime, kind: 'object' | 'commit', body: DriveV2JsonObject, driveFileId: string) {
  const bytes = driveV2CanonicalBytes(body)
  const canonicalId = kind === 'object' ? await driveV2ObjectId(body) : await driveV2CommitId(body)
  const digest = await driveV2Sha256(bytes)
  return DriveV2CreateArtifact.create({
    kind,
    generatedDriveFileId: driveFileId,
    parentFolderDriveFileId: rt.folderIds[kind === 'object' ? 'objects' : 'commits'],
    canonicalId,
    path: kind === 'object' ? driveV2ObjectPath(canonicalId) : driveV2CommitPath(canonicalId),
    mimeType: DRIVE_V2_JSON_MIME_TYPE,
    bytes,
    appProperties: driveV2AppProperties(rt.plan.workspaceId, kind, canonicalId, digest),
  })
}

async function blobArtifact(rt: Runtime, bytes: Uint8Array, driveFileId: string, operationId: string) {
  const canonicalId = await driveV2BlobId(bytes)
  const digest = await driveV2Sha256(bytes)
  return DriveV2CreateArtifact.create({
    kind: 'blob',
    generatedDriveFileId: driveFileId,
    parentFolderDriveFileId: rt.folderIds.blobs,
    canonicalId,
    path: driveV2BlobPath(canonicalId),
    mimeType: 'application/octet-stream',
    bytes,
    appProperties: driveV2AppProperties(rt.plan.workspaceId, 'blob', canonicalId, digest),
    resumableOperationId: operationId,
  })
}

function utc(plan: GatePlan, offsetMs: number): string {
  return new Date(Date.parse(plan.createdAt) + offsetMs).toISOString()
}

function objectBody(plan: GatePlan, options: {
  entityKind: string
  entityId: string
  operation: 'upsert' | 'tombstone'
  bases: string[]
  blobIds?: string[]
  payload?: DriveV2JsonObject
  deletedAt?: string
}): DriveV2JsonObject {
  return {
    protocol: 'easylab-drive-v2-append-only', schemaVersion: 2, workspaceId: plan.workspaceId,
    entityKind: options.entityKind, entityId: options.entityId, operation: options.operation,
    baseObjectIds: [...options.bases].sort(), blobIds: [...(options.blobIds ?? [])].sort(),
    payload: options.operation === 'upsert' ? options.payload! : null,
    tombstone: options.operation === 'tombstone'
      ? { deletedAt: options.deletedAt!, deletedByDeviceId: 'device-electron-live-v2' }
      : null,
    resolutionOf: [],
  }
}

function commitBody(plan: GatePlan, operationId: string, createdAt: string, parents: readonly string[], objects: readonly string[], blobs: readonly string[]): DriveV2JsonObject {
  return {
    protocol: 'easylab-drive-v2-append-only', schemaVersion: 2, workspaceId: plan.workspaceId,
    operationId, createdAt, parentCommitIds: [...parents].sort(), objectIds: [...objects].sort(), blobIds: [...blobs].sort(),
  }
}

async function transaction(rt: Runtime, operationId: string, blobs: DriveV2CreateArtifact[], objects: DriveV2CreateArtifact[], commit: DriveV2CreateArtifact) {
  const descriptors = [...blobs, ...objects, commit].map((artifact) => artifact.descriptor())
  return DriveV2CreateTransaction.create(await readiness(rt, operationId, descriptors), blobs, objects, commit)
}

test.describe('gated Drive v2 live append-only round trip', () => {
  test.skip(!enabled, 'Default-off: requires the separately gated Drive v2 live worker.')

  test('web append, retry, Electron tombstones, and final non-resurrection', async () => {
    const rt = runtime()
    const initial = await readiness(rt, 'inspect-native-genesis', [])
    expect(initial.state.tips).toHaveLength(1)
    const nativeTip = initial.state.tips[0]
    const entryKey = Object.keys(initial.state.frontiers).find((key) => key.startsWith('entry:'))
    const attachmentKey = Object.keys(initial.state.frontiers).find((key) => key.startsWith('attachment:'))
    expect(entryKey).toBeTruthy(); expect(attachmentKey).toBeTruthy()
    const nativeEntryId = initial.state.frontiers[entryKey!][0]
    const nativeAttachmentId = initial.state.frontiers[attachmentKey!][0]
    const nativeEntry = initial.state.objectMap.get(nativeEntryId)!.body
    const nativeAttachment = initial.state.objectMap.get(nativeAttachmentId)!.body
    const nativePayload = nativeEntry.payload as DriveV2JsonObject
    expect(nativePayload.futureRemote).toBeDefined()
    const originalDriveIds = (await loadRemote(rt)).artifacts.map((artifact) => artifact.driveFileId)

    const webOperation = `op-v2-web-live-${rt.plan.runId}`
    const webBody = objectBody(rt.plan, {
      entityKind: 'entry', entityId: String(nativeEntry.entityId), operation: 'upsert', bases: [nativeEntryId],
      payload: { ...nativePayload, title: 'Web append-only validation edit', updatedAt: utc(rt.plan, 60_000), updatedByDeviceId: 'device-web-live-v2' },
    })
    expect((webBody.payload as DriveV2JsonObject).futureRemote).toEqual(nativePayload.futureRemote)
    const webObject = await jsonArtifact(rt, 'object', webBody, required('EASYLAB_DRIVE_V2_WEB_ENTRY_FILE_ID'))
    const webCommit = await jsonArtifact(rt, 'commit', commitBody(rt.plan, webOperation, utc(rt.plan, 61_000), [nativeTip], [webObject.canonicalId], []), required('EASYLAB_DRIVE_V2_WEB_COMMIT_FILE_ID'))
    const webTx = await transaction(rt, webOperation, [], [webObject], webCommit)
    rt.client.setFault('lose-response-after-create')
    await new DriveV2CreateTransactionExecutor(rt.client).execute(webTx)
    expect(rt.client.faultUsed).toBe(true)

    const afterWeb = await readiness(rt, 'inspect-web-append', [])
    expect(afterWeb.state.tips).toEqual([webCommit.canonicalId])
    const webRecord = afterWeb.state.objectMap.get(webObject.canonicalId)!.body
    expect((webRecord.payload as DriveV2JsonObject).futureRemote).toEqual(nativePayload.futureRemote)

    const staleBody = objectBody(rt.plan, {
      entityKind: 'entry', entityId: String(nativeEntry.entityId), operation: 'upsert', bases: [webObject.canonicalId],
      payload: { ...(webRecord.payload as DriveV2JsonObject), title: 'must never publish' },
    })
    const staleObject = await jsonArtifact(rt, 'object', staleBody, 'never-used-stale-object-id')
    const staleOperation = `op-v2-stale-${rt.plan.runId}`
    const staleCommit = await jsonArtifact(rt, 'commit', commitBody(rt.plan, staleOperation, utc(rt.plan, 62_000), [nativeTip], [staleObject.canonicalId], []), 'never-used-stale-commit-id')
    const staleWriterCalls = rt.methods.filter((method) => method !== 'GET').length
    await expect(transaction(rt, staleOperation, [], [staleObject], staleCommit)).rejects.toMatchObject({ code: 'incomplete-parent-frontier' })
    expect(rt.methods.filter((method) => method !== 'GET')).toHaveLength(staleWriterCalls)

    const largeBytes = new Uint8Array(5 * 1024 * 1024 + 257)
    for (let index = 0; index < largeBytes.length; index += 1) largeBytes[index] = (index + 17) % 251
    const blobOperation = `op-v2-web-large-${rt.plan.runId}`
    const blob = await blobArtifact(rt, largeBytes, required('EASYLAB_DRIVE_V2_WEB_LARGE_BLOB_FILE_ID'), `upload-${blobOperation}`)
    const attachmentPayload = nativeAttachment.payload as DriveV2JsonObject
    const attachmentBody = objectBody(rt.plan, {
      entityKind: 'attachment', entityId: String(nativeAttachment.entityId), operation: 'upsert', bases: [nativeAttachmentId],
      blobIds: [blob.canonicalId],
      payload: { ...attachmentPayload, blobId: blob.canonicalId, sha256: blob.contentSha256, bytes: blob.byteCount, updatedAt: utc(rt.plan, 120_000) },
    })
    const attachment = await jsonArtifact(rt, 'object', attachmentBody, required('EASYLAB_DRIVE_V2_WEB_ATTACHMENT_FILE_ID'))
    const blobCommit = await jsonArtifact(rt, 'commit', commitBody(rt.plan, blobOperation, utc(rt.plan, 121_000), [webCommit.canonicalId], [attachment.canonicalId], [blob.canonicalId]), required('EASYLAB_DRIVE_V2_WEB_BLOB_COMMIT_FILE_ID'))
    const blobTx = await transaction(rt, blobOperation, [blob], [attachment], blobCommit)
    const orderedCalls: string[] = []
    const recordingClient = {
      createOrReconcile: async (account: string, artifact: DriveV2CreateArtifact, signal?: AbortSignal) => {
        orderedCalls.push(artifact.path)
        return rt.client.createOrReconcile(account, artifact, signal)
      },
    }
    rt.client.setFault('interrupt-before-resumable-content')
    await expect(new DriveV2CreateTransactionExecutor(recordingClient).execute(blobTx)).rejects.toBeInstanceOf(DriveV2CreateTransactionError)
    expect(orderedCalls).toEqual([blob.path])
    const beforeRetry = await rt.client.listChildren(rt.folderIds.objects)
    expect(beforeRetry.some((file) => file.id === attachment.generatedDriveFileId)).toBe(false)
    expect((await rt.client.listChildren(rt.folderIds.commits)).some((file) => file.id === blobCommit.generatedDriveFileId)).toBe(false)
    rt.client.setFault('none'); orderedCalls.length = 0
    await new DriveV2CreateTransactionExecutor(recordingClient).execute(blobTx)
    expect(orderedCalls).toEqual([blob.path, attachment.path, blobCommit.path])

    const afterBlob = await readiness(rt, 'inspect-large-append', [])
    expect(afterBlob.state.tips).toEqual([blobCommit.canonicalId])
    const entryFrontier = afterBlob.state.frontiers[entryKey!]
    const attachmentFrontier = afterBlob.state.frontiers[attachmentKey!]
    const deletedAt = utc(rt.plan, 180_000)
    const entryTombstoneBody = objectBody(rt.plan, { entityKind: 'entry', entityId: String(nativeEntry.entityId), operation: 'tombstone', bases: [...entryFrontier], deletedAt })
    const attachmentTombstoneBody = objectBody(rt.plan, { entityKind: 'attachment', entityId: String(nativeAttachment.entityId), operation: 'tombstone', bases: [...attachmentFrontier], deletedAt })
    const entryTombstone = await jsonArtifact(rt, 'object', entryTombstoneBody, required('EASYLAB_DRIVE_V2_ELECTRON_ENTRY_TOMBSTONE_FILE_ID'))
    const attachmentTombstone = await jsonArtifact(rt, 'object', attachmentTombstoneBody, required('EASYLAB_DRIVE_V2_ELECTRON_ATTACHMENT_TOMBSTONE_FILE_ID'))
    const electronOperation = `op-v2-electron-delete-${rt.plan.runId}`
    const electronCommit = await jsonArtifact(rt, 'commit', commitBody(rt.plan, electronOperation, utc(rt.plan, 181_000), [blobCommit.canonicalId], [entryTombstone.canonicalId, attachmentTombstone.canonicalId], []), required('EASYLAB_DRIVE_V2_ELECTRON_COMMIT_FILE_ID'))
    const electronTx = await transaction(rt, electronOperation, [], [entryTombstone, attachmentTombstone], electronCommit)
    await new DriveV2CreateTransactionExecutor(rt.client).execute(electronTx)

    const final = await readiness(rt, 'inspect-final-electron-projection', [])
    const projection = await projectDriveV2Workspace(final.state)
    expect(projection.visibleTargets).not.toContain(entryKey)
    expect(projection.visibleTargets).not.toContain(attachmentKey)
    expect(projection.suppressedTargets).toContain(entryKey)
    expect(projection.suppressedTargets).toContain(attachmentKey)
    const all = (await loadRemote(rt)).artifacts
    const paths = all.map((artifact) => artifact.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(originalDriveIds.every((id) => all.some((artifact) => artifact.driveFileId === id))).toBe(true)
    expect(rt.methods).not.toContain('PATCH')
    expect(rt.methods).not.toContain('DELETE')
  })
})
