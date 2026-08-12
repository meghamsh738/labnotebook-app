import {
  DriveV2ContractError,
  driveV2CanonicalJson,
  driveV2DecodeCanonicalObject,
  driveV2Sha256,
} from './driveV2CanonicalJson'
import {
  DRIVE_V2_FOLDER_MIME_TYPE,
  DRIVE_V2_JSON_MIME_TYPE,
  DRIVE_V2_MANAGED_FOLDER_ROLES,
  DRIVE_V2_RESUMABLE_THRESHOLD_BYTES,
  DRIVE_V2_WORKSPACE_ROOT_NAME,
  driveV2AppProperties,
  driveV2BlobId,
  driveV2BlobPath,
  driveV2CommitPath,
  driveV2ObjectPath,
  projectDriveV2Workspace,
  validateDriveV2Commit,
  validateDriveV2Object,
  validateDriveV2Workspace,
  type DriveV2BlobRecord,
  type DriveV2CommitRecord,
  type DriveV2ObjectRecord,
  type DriveV2Projection,
  type DriveV2WorkspaceState,
} from './driveV2Graph'

export type DriveV2WorkspaceItem = {
  readonly driveFileId: string
  readonly name: string
  readonly parentIds: readonly string[]
  readonly mimeType: string
  readonly trashed: boolean
  readonly appProperties: Readonly<Record<string, string>>
}

export type DriveV2ArtifactDescriptor = {
  readonly kind: 'blob' | 'commit' | 'object'
  readonly canonicalId: string
  readonly generatedDriveFileId: string
  readonly parentFolderDriveFileId: string
  readonly path: string
  readonly mimeType: string
  readonly byteCount: number
  readonly contentSha256: string
  readonly resumableOperationId: string | null
}

export type DriveV2OperationJournalInput = {
  readonly accountScopeId: string
  readonly savedRootDriveFileId: string
  readonly workspaceId: string
  readonly operationId: string
  readonly managedFolderIds: Readonly<Record<string, string>>
  readonly artifactDescriptors: readonly DriveV2ArtifactDescriptor[]
  readonly rootParentDriveFileId?: string
}

const validatedOperationJournals = new WeakSet<DriveV2OperationJournal>()

function cloneFreeze<T>(value: T): Readonly<T> {
  const copy = structuredClone(value)
  const freeze = (candidate: unknown): unknown => {
    if (candidate && typeof candidate === 'object' && !Object.isFrozen(candidate)) {
      Object.values(candidate).forEach(freeze)
      Object.freeze(candidate)
    }
    return candidate
  }
  return freeze(copy) as Readonly<T>
}

function fail(code: string): never {
  throw new DriveV2ContractError(code)
}

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) fail(code)
}

function exact(left: unknown, right: unknown): boolean {
  return driveV2CanonicalJson(left) === driveV2CanonicalJson(right)
}

function workspaceIdValid(value: string): boolean {
  return /^ws-v2-[0-9a-f]{32}$/.test(value)
}

export class DriveV2OperationJournal {
  readonly accountScopeId: string
  readonly savedRootDriveFileId: string
  readonly workspaceId: string
  readonly operationId: string
  readonly managedFolderIds: Readonly<Record<string, string>>
  readonly artifactDescriptors: readonly DriveV2ArtifactDescriptor[]
  readonly rootParentDriveFileId: string

  constructor(input: DriveV2OperationJournalInput) {
    requireCondition(Boolean(
      input.accountScopeId.trim()
        && input.savedRootDriveFileId.trim()
        && input.operationId.trim()
        && workspaceIdValid(input.workspaceId),
    ), 'invalid-operation-identity')
    this.accountScopeId = input.accountScopeId
    this.savedRootDriveFileId = input.savedRootDriveFileId
    this.workspaceId = input.workspaceId
    this.operationId = input.operationId
    this.rootParentDriveFileId = input.rootParentDriveFileId ?? 'root'
    requireCondition(Boolean(this.rootParentDriveFileId.trim()), 'invalid-operation-identity')
    this.managedFolderIds = cloneFreeze(input.managedFolderIds)
    this.artifactDescriptors = cloneFreeze(input.artifactDescriptors)
    validatedOperationJournals.add(this)
    Object.freeze(this)
  }
}

export type DriveV2RemoteArtifactInput = {
  readonly kind: 'blob' | 'commit' | 'object'
  readonly driveFileId: string
  readonly parentFolderDriveFileId: string
  readonly path: string
  readonly mimeType: string
  readonly byteCount: number
  readonly expectedId: string
  readonly expectedContentSha256: string
  readonly appProperties: Readonly<Record<string, string>>
  readonly bytes: Uint8Array
}

export class DriveV2RemoteArtifact {
  readonly kind: 'blob' | 'commit' | 'object'
  readonly driveFileId: string
  readonly parentFolderDriveFileId: string
  readonly path: string
  readonly mimeType: string
  readonly byteCount: number
  readonly expectedId: string
  readonly expectedContentSha256: string
  readonly appProperties: Readonly<Record<string, string>>
  readonly #bytes: Uint8Array

  constructor(input: DriveV2RemoteArtifactInput) {
    requireCondition(['blob', 'commit', 'object'].includes(input.kind), 'unknown-artifact-kind')
    this.kind = input.kind
    this.driveFileId = input.driveFileId
    this.parentFolderDriveFileId = input.parentFolderDriveFileId
    this.path = input.path
    this.mimeType = input.mimeType
    this.byteCount = input.byteCount
    this.expectedId = input.expectedId
    this.expectedContentSha256 = input.expectedContentSha256
    this.appProperties = cloneFreeze(input.appProperties)
    this.#bytes = Uint8Array.from(input.bytes)
    Object.freeze(this)
  }

  get bytes(): Uint8Array {
    return Uint8Array.from(this.#bytes)
  }

  descriptor(resumableOperationId: string | null = null): DriveV2ArtifactDescriptor {
    return cloneFreeze({
      kind: this.kind,
      canonicalId: this.expectedId,
      generatedDriveFileId: this.driveFileId,
      parentFolderDriveFileId: this.parentFolderDriveFileId,
      path: this.path,
      mimeType: this.mimeType,
      byteCount: this.byteCount,
      contentSha256: this.expectedContentSha256,
      resumableOperationId,
    })
  }

  remoteIdentityEquals(other: DriveV2RemoteArtifact): boolean {
    const leftBytes = this.#bytes
    const rightBytes = other.#bytes
    return this.kind === other.kind
      && this.parentFolderDriveFileId === other.parentFolderDriveFileId
      && this.path === other.path
      && this.mimeType === other.mimeType
      && this.byteCount === other.byteCount
      && this.expectedId === other.expectedId
      && this.expectedContentSha256 === other.expectedContentSha256
      && exact(this.appProperties, other.appProperties)
      && leftBytes.length === rightBytes.length
      && leftBytes.every((byte, index) => byte === rightBytes[index])
  }
}

export type DriveV2PreflightSnapshot = {
  readonly currentAccountScopeId: string
  readonly currentSavedRootDriveFileId: string
  readonly currentWorkspaceId: string
  readonly currentOperationId: string
  readonly currentManagedFolderIds: Readonly<Record<string, string>>
  readonly currentArtifactDescriptors: readonly DriveV2ArtifactDescriptor[]
  readonly journal: DriveV2OperationJournal
  readonly roots: readonly DriveV2WorkspaceItem[]
  readonly folders: readonly DriveV2WorkspaceItem[]
  readonly artifacts: readonly DriveV2RemoteArtifact[]
}

const validatedReadiness = new WeakSet<DriveV2PlanReadiness>()

export class DriveV2PlanReadiness {
  readonly state: DriveV2WorkspaceState
  readonly projection: DriveV2Projection
  readonly accountScopeId: string
  readonly savedRootDriveFileId: string
  readonly workspaceId: string
  readonly operationId: string
  readonly managedFolderIds: Readonly<Record<string, string>>
  readonly artifactDescriptors: readonly DriveV2ArtifactDescriptor[]
  readonly rootParentDriveFileId: string
  readonly remoteArtifacts: readonly DriveV2RemoteArtifact[]

  constructor(
    inventory: DriveV2ValidatedInventory,
    projection: DriveV2Projection,
    journal: DriveV2OperationJournal,
    validationSeal: symbol,
  ) {
    requireCondition(validationSeal === readinessSeal, 'unvalidated-readiness')
    this.state = inventory.state
    this.projection = projection
    this.accountScopeId = journal.accountScopeId
    this.savedRootDriveFileId = journal.savedRootDriveFileId
    this.workspaceId = journal.workspaceId
    this.operationId = journal.operationId
    this.managedFolderIds = cloneFreeze(journal.managedFolderIds)
    this.artifactDescriptors = cloneFreeze(journal.artifactDescriptors)
    this.rootParentDriveFileId = journal.rootParentDriveFileId
    this.remoteArtifacts = Object.freeze([...inventory.artifacts])
    validatedReadiness.add(this)
    Object.freeze(this)
  }
}

const readinessSeal = Symbol('DriveV2ValidatedReadiness')

type DriveV2ValidatedInventory = {
  readonly state: DriveV2WorkspaceState
  readonly artifacts: readonly DriveV2RemoteArtifact[]
}

function validateJournalAndFolders(snapshot: DriveV2PreflightSnapshot) {
  const journal = snapshot.journal
  requireCondition(snapshot.currentAccountScopeId === journal.accountScopeId, 'account-switch')
  requireCondition(snapshot.currentSavedRootDriveFileId === journal.savedRootDriveFileId, 'saved-root-switch')
  requireCondition(snapshot.currentWorkspaceId === journal.workspaceId, 'workspace-marker-switch')
  requireCondition(snapshot.currentOperationId === journal.operationId, 'stale-operation-id')
  requireCondition(exact(snapshot.currentManagedFolderIds, journal.managedFolderIds), 'managed-folder-switch')
  requireCondition(exact(snapshot.currentArtifactDescriptors, journal.artifactDescriptors), 'changed-artifact-descriptor')
  requireCondition(workspaceIdValid(journal.workspaceId), 'workspace-marker-switch')

  const matchingRoots = snapshot.roots.filter((root) => root.driveFileId === journal.savedRootDriveFileId)
  requireCondition(matchingRoots.length === 1, 'saved-root-switch')
  const root = matchingRoots[0]
  const expectedRootProperties = {
    easylabDriveProtocol: 'v2-append-only',
    easylabWorkspaceId: journal.workspaceId,
    easylabArtifactKind: 'workspace-root',
  }
  requireCondition(
    root.name === DRIVE_V2_WORKSPACE_ROOT_NAME
      && exact(root.parentIds, [journal.rootParentDriveFileId])
      && root.mimeType === DRIVE_V2_FOLDER_MIME_TYPE
      && !root.trashed
      && exact(root.appProperties, expectedRootProperties),
    'workspace-marker-switch',
  )
  const markedRoots = snapshot.roots.filter((candidate) =>
    !candidate.trashed
      && candidate.appProperties.easylabDriveProtocol === 'v2-append-only'
      && candidate.appProperties.easylabArtifactKind === 'workspace-root')
  requireCondition(markedRoots.length === 1, 'duplicate-marked-root')

  requireCondition(exact(Object.keys(journal.managedFolderIds).sort(), DRIVE_V2_MANAGED_FOLDER_ROLES), 'managed-folder-switch')
  for (const role of DRIVE_V2_MANAGED_FOLDER_ROLES) {
    const folderId = journal.managedFolderIds[role]
    const matchingFolders = snapshot.folders.filter((folder) => folder.driveFileId === folderId)
    requireCondition(matchingFolders.length === 1, 'managed-folder-switch')
    const folder = matchingFolders[0]
    const expectedProperties = {
      easylabDriveProtocol: 'v2-append-only',
      easylabWorkspaceId: journal.workspaceId,
      easylabArtifactKind: 'managed-folder',
      easylabFolderRole: role,
    }
    requireCondition(
      folder.name === role
        && exact(folder.parentIds, [root.driveFileId])
        && folder.mimeType === DRIVE_V2_FOLDER_MIME_TYPE
        && !folder.trashed
        && exact(folder.appProperties, expectedProperties),
      'managed-folder-switch',
    )
  }
  requireCondition(snapshot.folders.length === DRIVE_V2_MANAGED_FOLDER_ROLES.length, 'managed-folder-switch')
}

async function validateArtifacts(snapshot: DriveV2PreflightSnapshot): Promise<DriveV2ValidatedInventory> {
  const byPath = new Map<string, DriveV2RemoteArtifact[]>()
  for (const artifact of snapshot.artifacts) {
    const copies = byPath.get(artifact.path) ?? []
    copies.push(artifact)
    byPath.set(artifact.path, copies)
  }
  const representatives = [...byPath.values()].map((copies) => {
    requireCondition(copies.slice(1).every((copy) => copies[0].remoteIdentityEquals(copy)), 'divergent-duplicate')
    return copies[0]
  })
  const objects: DriveV2ObjectRecord[] = []
  const commits: DriveV2CommitRecord[] = []
  const blobs: DriveV2BlobRecord[] = []
  for (const artifact of representatives) {
    requireCondition(Boolean(artifact.driveFileId.trim()), 'artifact-schema-mismatch')
    const bytes = artifact.bytes
    requireCondition(Number.isSafeInteger(artifact.byteCount) && artifact.byteCount === bytes.length, 'content-length-mismatch')
    const digest = await driveV2Sha256(bytes)
    requireCondition(digest === artifact.expectedContentSha256, 'content-hash-mismatch')
    const role = artifact.kind === 'object' ? 'objects' : artifact.kind === 'blob' ? 'blobs' : 'commits'
    requireCondition(artifact.parentFolderDriveFileId === snapshot.journal.managedFolderIds[role], 'artifact-parent-mismatch')
    const expectedPath = artifact.kind === 'object'
      ? driveV2ObjectPath(artifact.expectedId)
      : artifact.kind === 'blob'
        ? driveV2BlobPath(artifact.expectedId)
        : driveV2CommitPath(artifact.expectedId)
    requireCondition(artifact.path === expectedPath, 'artifact-path-mismatch')
    requireCondition(Boolean(artifact.mimeType.trim()), 'artifact-mime-mismatch')
    if (artifact.kind !== 'blob') requireCondition(artifact.mimeType === DRIVE_V2_JSON_MIME_TYPE, 'artifact-mime-mismatch')
    requireCondition(
      exact(artifact.appProperties, driveV2AppProperties(snapshot.journal.workspaceId, artifact.kind, artifact.expectedId, digest)),
      'artifact-properties-mismatch',
    )
    if (artifact.kind === 'blob') {
      requireCondition(artifact.expectedId === await driveV2BlobId(bytes), 'canonical-id-mismatch')
      blobs.push({ expectedId: artifact.expectedId, bytes, mimeType: artifact.mimeType })
    } else {
      const body = driveV2DecodeCanonicalObject(bytes)
      if (artifact.kind === 'object') {
        const record = { expectedId: artifact.expectedId, body }
        await validateDriveV2Object(record, snapshot.journal.workspaceId)
        objects.push(record)
      } else {
        const record = { expectedId: artifact.expectedId, body }
        await validateDriveV2Commit(record, snapshot.journal.workspaceId)
        commits.push(record)
      }
    }
  }
  return Object.freeze({
    state: await validateDriveV2Workspace(snapshot.journal.workspaceId, objects, blobs, commits),
    artifacts: Object.freeze(representatives),
  })
}

export async function validateDriveV2BeforePlan(snapshot: DriveV2PreflightSnapshot): Promise<DriveV2PlanReadiness> {
  requireCondition(validatedOperationJournals.has(snapshot.journal), 'unvalidated-operation-journal')
  const journal = new DriveV2OperationJournal({
    accountScopeId: snapshot.journal.accountScopeId,
    savedRootDriveFileId: snapshot.journal.savedRootDriveFileId,
    workspaceId: snapshot.journal.workspaceId,
    operationId: snapshot.journal.operationId,
    managedFolderIds: snapshot.journal.managedFolderIds,
    artifactDescriptors: snapshot.journal.artifactDescriptors,
    rootParentDriveFileId: snapshot.journal.rootParentDriveFileId,
  })
  const frozenSnapshot: DriveV2PreflightSnapshot = {
    currentAccountScopeId: snapshot.currentAccountScopeId,
    currentSavedRootDriveFileId: snapshot.currentSavedRootDriveFileId,
    currentWorkspaceId: snapshot.currentWorkspaceId,
    currentOperationId: snapshot.currentOperationId,
    currentManagedFolderIds: cloneFreeze(snapshot.currentManagedFolderIds),
    currentArtifactDescriptors: cloneFreeze(snapshot.currentArtifactDescriptors),
    journal,
    roots: cloneFreeze(snapshot.roots),
    folders: cloneFreeze(snapshot.folders),
    artifacts: snapshot.artifacts.map((artifact) => new DriveV2RemoteArtifact({
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
    })),
  }
  validateJournalAndFolders(frozenSnapshot)
  const inventory = await validateArtifacts(frozenSnapshot)
  return new DriveV2PlanReadiness(
    inventory,
    await projectDriveV2Workspace(inventory.state),
    frozenSnapshot.journal,
    readinessSeal,
  )
}

export type DriveV2CreateArtifactInput = {
  readonly kind: 'blob' | 'commit' | 'object'
  readonly generatedDriveFileId: string
  readonly parentFolderDriveFileId: string
  readonly canonicalId: string
  readonly path: string
  readonly mimeType: string
  readonly bytes: Uint8Array
  readonly appProperties: Readonly<Record<string, string>>
  readonly resumableOperationId?: string | null
}

const validatedCreateArtifacts = new WeakSet<DriveV2CreateArtifact>()
const createArtifactSeal = Symbol('DriveV2CreateArtifact')

export class DriveV2CreateArtifact {
  readonly kind: 'blob' | 'commit' | 'object'
  readonly generatedDriveFileId: string
  readonly parentFolderDriveFileId: string
  readonly canonicalId: string
  readonly path: string
  readonly mimeType: string
  readonly byteCount: number
  readonly contentSha256: string
  readonly appProperties: Readonly<Record<string, string>>
  readonly resumableOperationId: string | null
  readonly #bytes: Uint8Array

  private constructor(input: DriveV2CreateArtifactInput, contentSha256: string, validationSeal: symbol) {
    requireCondition(validationSeal === createArtifactSeal, 'unvalidated-create-artifact')
    this.kind = input.kind
    this.generatedDriveFileId = input.generatedDriveFileId
    this.parentFolderDriveFileId = input.parentFolderDriveFileId
    this.canonicalId = input.canonicalId
    this.path = input.path
    this.mimeType = input.mimeType
    this.#bytes = Uint8Array.from(input.bytes)
    this.byteCount = this.#bytes.length
    this.contentSha256 = contentSha256
    this.appProperties = cloneFreeze(input.appProperties)
    this.resumableOperationId = input.resumableOperationId ?? null
    validatedCreateArtifacts.add(this)
    Object.freeze(this)
  }

  static async create(input: DriveV2CreateArtifactInput): Promise<DriveV2CreateArtifact> {
    requireCondition(['blob', 'commit', 'object'].includes(input.kind), 'unknown-artifact-kind')
    requireCondition(Boolean(input.generatedDriveFileId.trim() && input.parentFolderDriveFileId.trim()), 'artifact-schema-mismatch')
    const bytes = Uint8Array.from(input.bytes)
    const digest = await driveV2Sha256(bytes)
    const workspaceId = input.appProperties.easylabWorkspaceId
    requireCondition(typeof workspaceId === 'string' && workspaceIdValid(workspaceId), 'workspace-marker-switch')
    requireCondition(exact(input.appProperties, driveV2AppProperties(workspaceId, input.kind, input.canonicalId, digest)), 'artifact-properties-mismatch')
    const expectedPath = input.kind === 'blob'
      ? driveV2BlobPath(input.canonicalId)
      : input.kind === 'object'
        ? driveV2ObjectPath(input.canonicalId)
        : driveV2CommitPath(input.canonicalId)
    requireCondition(input.path === expectedPath && Boolean(input.mimeType.trim()), 'artifact-path-mismatch')
    const resumableOperationId = input.resumableOperationId ?? null
    if (input.kind === 'blob' && bytes.length >= DRIVE_V2_RESUMABLE_THRESHOLD_BYTES) {
      requireCondition(Boolean(resumableOperationId?.trim()), 'missing-resumable-operation-id')
    } else {
      requireCondition(resumableOperationId === null, 'unexpected-resumable-operation-id')
    }
    if (input.kind === 'blob') {
      requireCondition(input.canonicalId === await driveV2BlobId(bytes), 'canonical-id-mismatch')
    } else {
      requireCondition(input.mimeType === DRIVE_V2_JSON_MIME_TYPE && bytes.length < DRIVE_V2_RESUMABLE_THRESHOLD_BYTES, 'artifact-mime-mismatch')
      const body = driveV2DecodeCanonicalObject(bytes)
      if (input.kind === 'object') await validateDriveV2Object({ expectedId: input.canonicalId, body }, workspaceId)
      else await validateDriveV2Commit({ expectedId: input.canonicalId, body }, workspaceId)
    }
    return new DriveV2CreateArtifact({ ...input, bytes, resumableOperationId }, digest, createArtifactSeal)
  }

  get bytes(): Uint8Array {
    return Uint8Array.from(this.#bytes)
  }

  descriptor(): DriveV2ArtifactDescriptor {
    return cloneFreeze({
      kind: this.kind,
      canonicalId: this.canonicalId,
      generatedDriveFileId: this.generatedDriveFileId,
      parentFolderDriveFileId: this.parentFolderDriveFileId,
      path: this.path,
      mimeType: this.mimeType,
      byteCount: this.byteCount,
      contentSha256: this.contentSha256,
      resumableOperationId: this.resumableOperationId,
    })
  }
}

export class DriveV2CreateTransaction {
  readonly readiness: DriveV2PlanReadiness
  readonly accountScopeId: string
  readonly operationId: string
  readonly blobs: readonly DriveV2CreateArtifact[]
  readonly objects: readonly DriveV2CreateArtifact[]
  readonly commit: DriveV2CreateArtifact

  private constructor(
    readiness: DriveV2PlanReadiness,
    blobs: readonly DriveV2CreateArtifact[],
    objects: readonly DriveV2CreateArtifact[],
    commit: DriveV2CreateArtifact,
    validationSeal: symbol,
  ) {
    requireCondition(validationSeal === createTransactionSeal, 'unvalidated-create-transaction')
    this.readiness = readiness
    this.accountScopeId = readiness.accountScopeId
    this.operationId = readiness.operationId
    this.blobs = Object.freeze([...blobs])
    this.objects = Object.freeze([...objects])
    this.commit = commit
    validatedCreateTransactions.add(this)
    Object.freeze(this)
  }

  static async create(
    readiness: DriveV2PlanReadiness,
    blobs: readonly DriveV2CreateArtifact[],
    objects: readonly DriveV2CreateArtifact[],
    commit: DriveV2CreateArtifact,
  ): Promise<DriveV2CreateTransaction> {
    requireCondition(validatedReadiness.has(readiness), 'unvalidated-readiness')
    requireCondition([...blobs, ...objects, commit].every((artifact) => validatedCreateArtifacts.has(artifact)), 'unvalidated-create-artifact')
    requireCondition(Boolean(readiness.operationId.trim() && readiness.savedRootDriveFileId.trim()), 'stale-operation-id')
    requireCondition(blobs.every((artifact) => artifact.kind === 'blob'), 'artifact-schema-mismatch')
    requireCondition(objects.every((artifact) => artifact.kind === 'object') && commit.kind === 'commit', 'artifact-schema-mismatch')
    const writes = [...blobs, ...objects, commit]
    requireCondition(new Set(writes.map((artifact) => artifact.path)).size === writes.length, 'divergent-duplicate')
    requireCondition(new Set(writes.map((artifact) => artifact.generatedDriveFileId)).size === writes.length, 'changed-artifact-descriptor')
    for (const artifact of writes) {
      const role = artifact.kind === 'blob' ? 'blobs' : artifact.kind === 'object' ? 'objects' : 'commits'
      requireCondition(artifact.parentFolderDriveFileId === readiness.managedFolderIds[role], 'managed-folder-switch')
      requireCondition(artifact.appProperties.easylabWorkspaceId === readiness.workspaceId, 'workspace-marker-switch')
    }
    const descriptors = writes.map((artifact) => artifact.descriptor()).sort((left, right) => left.canonicalId.localeCompare(right.canonicalId))
    const expectedDescriptors = [...readiness.artifactDescriptors].sort((left, right) => left.canonicalId.localeCompare(right.canonicalId))
    requireCondition(exact(descriptors, expectedDescriptors), 'changed-artifact-descriptor')
    const resumableIds = blobs.map((artifact) => artifact.resumableOperationId).filter((id): id is string => id !== null)
    requireCondition(new Set(resumableIds).size === resumableIds.length, 'duplicate-resumable-operation-id')
    const commitBody = driveV2DecodeCanonicalObject(commit.bytes)
    requireCondition(commitBody.operationId === readiness.operationId, 'stale-operation-id')
    requireCondition(exact(commitBody.objectIds, objects.map((artifact) => artifact.canonicalId).sort()), 'missing-object-reference')
    requireCondition(exact(commitBody.blobIds, blobs.map((artifact) => artifact.canonicalId).sort()), 'missing-blob-reference')
    const existingObjects: DriveV2ObjectRecord[] = []
    const existingBlobs: DriveV2BlobRecord[] = []
    const existingCommits: DriveV2CommitRecord[] = []
    for (const artifact of readiness.remoteArtifacts) {
      if (artifact.kind === 'object') {
        existingObjects.push({ expectedId: artifact.expectedId, body: driveV2DecodeCanonicalObject(artifact.bytes) })
      } else if (artifact.kind === 'blob') {
        existingBlobs.push({ expectedId: artifact.expectedId, bytes: artifact.bytes, mimeType: artifact.mimeType })
      } else {
        existingCommits.push({ expectedId: artifact.expectedId, body: driveV2DecodeCanonicalObject(artifact.bytes) })
      }
    }
    const plannedObjects = objects.map((artifact) => ({
      expectedId: artifact.canonicalId,
      body: driveV2DecodeCanonicalObject(artifact.bytes),
    }))
    const plannedBlobs = blobs.map((artifact) => ({
      expectedId: artifact.canonicalId,
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
    }))
    const plannedCommit = { expectedId: commit.canonicalId, body: commitBody }
    const commitAlreadyVisible = existingCommits.some((record) => record.expectedId === plannedCommit.expectedId)
    if (!commitAlreadyVisible) requireCondition(exact(commitBody.parentCommitIds, readiness.state.tips), 'incomplete-parent-frontier')
    const mergeExact = <T>(
      existing: readonly T[],
      planned: readonly T[],
      id: (value: T) => string,
      same: (left: T, right: T) => boolean,
    ): T[] => {
      const merged = new Map<string, T>()
      for (const value of [...existing, ...planned]) {
        const key = id(value)
        const previous = merged.get(key)
        requireCondition(previous === undefined || same(previous, value), 'divergent-duplicate')
        if (previous === undefined) merged.set(key, value)
      }
      return [...merged.values()]
    }
    const sameBlob = (left: DriveV2BlobRecord, right: DriveV2BlobRecord) =>
      left.mimeType === right.mimeType
        && left.bytes.length === right.bytes.length
        && left.bytes.every((byte, index) => byte === right.bytes[index])
    await validateDriveV2Workspace(
      readiness.workspaceId,
      mergeExact(existingObjects, plannedObjects, (record) => record.expectedId, (left, right) => exact(left.body, right.body)),
      mergeExact(existingBlobs, plannedBlobs, (record) => record.expectedId, sameBlob),
      mergeExact(existingCommits, [plannedCommit], (record) => record.expectedId, (left, right) => exact(left.body, right.body)),
    )
    return new DriveV2CreateTransaction(readiness, blobs, objects, commit, createTransactionSeal)
  }
}

const validatedCreateTransactions = new WeakSet<DriveV2CreateTransaction>()
const createTransactionSeal = Symbol('DriveV2CreateTransaction')

export type DriveV2CreateReceipt = {
  readonly driveFileId: string
  readonly parentFolderDriveFileId: string
  readonly path: string
  readonly canonicalId: string
  readonly contentSha256: string
  readonly mimeType: string
  readonly appProperties: Readonly<Record<string, string>>
  readonly byteCount: number
  readonly trashed: boolean
  readonly stableSecondRead: boolean
}

export interface DriveV2CreateOnlyClient {
  createOrReconcile(
    accountScopeId: string,
    artifact: DriveV2CreateArtifact,
    signal?: AbortSignal,
  ): Promise<DriveV2CreateReceipt>
}

export type DriveV2CreateTransactionResult = {
  readonly prerequisiteReceipts: readonly DriveV2CreateReceipt[]
  readonly commitReceipt: DriveV2CreateReceipt
}

export class DriveV2CreateTransactionError extends Error {
  readonly failedPath: string
  readonly completedReceipts: readonly DriveV2CreateReceipt[]

  constructor(failedPath: string, completedReceipts: readonly DriveV2CreateReceipt[], cause: unknown) {
    super(`Drive v2 create-only transaction failed at ${failedPath}.`, { cause })
    this.name = 'DriveV2CreateTransactionError'
    this.failedPath = failedPath
    this.completedReceipts = cloneFreeze(completedReceipts)
  }
}

function cancellationError(error: unknown, signal?: AbortSignal): unknown | undefined {
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') return error
  if (!signal?.aborted) return undefined
  const reason = signal.reason
  if (typeof reason === 'object' && reason !== null && 'name' in reason && reason.name === 'AbortError') return reason
  const message = reason instanceof Error
    ? reason.message
    : error instanceof Error
      ? error.message
      : 'Drive v2 transaction was cancelled.'
  const normalized = new Error(message, { cause: reason ?? error })
  normalized.name = 'AbortError'
  return normalized
}

/** Offline-only executor. Normal web and Electron construction never imports or creates this type. */
export class DriveV2CreateTransactionExecutor {
  readonly #client: DriveV2CreateOnlyClient

  constructor(client: DriveV2CreateOnlyClient) {
    this.#client = client
  }

  async execute(transaction: DriveV2CreateTransaction, signal?: AbortSignal): Promise<DriveV2CreateTransactionResult> {
    requireCondition(validatedCreateTransactions.has(transaction), 'unvalidated-create-transaction')
    requireCondition(validatedReadiness.has(transaction.readiness), 'unvalidated-readiness')
    const completed: DriveV2CreateReceipt[] = []
    for (const artifact of [...transaction.blobs, ...transaction.objects, transaction.commit]) {
      if (signal?.aborted) throw new DOMException('Drive v2 transaction was cancelled.', 'AbortError')
      let receipt: DriveV2CreateReceipt
      try {
        receipt = await this.#client.createOrReconcile(transaction.accountScopeId, artifact, signal)
      } catch (error) {
        const cancellation = cancellationError(error, signal)
        if (cancellation) throw cancellation
        throw new DriveV2CreateTransactionError(artifact.path, completed, error)
      }
      const matches = receipt.driveFileId === artifact.generatedDriveFileId
        && receipt.parentFolderDriveFileId === artifact.parentFolderDriveFileId
        && receipt.path === artifact.path
        && receipt.canonicalId === artifact.canonicalId
        && receipt.contentSha256 === artifact.contentSha256
        && receipt.mimeType === artifact.mimeType
        && exact(receipt.appProperties, artifact.appProperties)
        && receipt.byteCount === artifact.byteCount
        && !receipt.trashed
        && receipt.stableSecondRead
      if (!matches) {
        throw new DriveV2CreateTransactionError(
          artifact.path,
          completed,
          new DriveV2ContractError('create-reconciliation-mismatch'),
        )
      }
      completed.push(cloneFreeze(receipt))
    }
    return Object.freeze({
      prerequisiteReceipts: Object.freeze(completed.slice(0, -1)),
      commitReceipt: completed.at(-1)!,
    })
  }
}
