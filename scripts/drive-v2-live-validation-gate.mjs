import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const LIVE_WRITE_ACKNOWLEDGEMENT = 'approved'
export const LIVE_EXECUTION_MODE = 'debug-test'
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const VALIDATION_CONTAINER_PREFIX = 'Easylab Lab Notebook Safety Validation '
export const WORKSPACE_ROOT_NAME = 'Easylab Lab Notebook v2'
export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
export const DRIVE_V2_PROTOCOL_MARKER = 'v2-append-only'
export const VALIDATION_APP_PROPERTY = 'easylabValidationRun'
export const MANAGED_FOLDER_ROLES = Object.freeze(['objects', 'blobs', 'commits'])
// Permanent exclusion requested by the project owner. The address itself is not
// stored in plans, journals, evidence, or logs.
export const REQUIRED_FORBIDDEN_ACCOUNT_SHA256 = 'e39ed3e99d1d992cf2d81d2c4701dc22000d713fc37b2ae1047f7ca520fecd8b'

const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const WORKSPACE_ID_PATTERN = /^ws-v2-[0-9a-f]{32}$/
const ARTIFACT_IDS = Object.freeze({
  object: /^obj-v2-[0-9a-f]{64}$/,
  blob: /^blob-v2-[0-9a-f]{64}$/,
  commit: /^commit-v2-[0-9a-f]{64}$/,
})
const PUBLIC_CHECK_KEYS = new Set([
  'cleanWorktree',
  'ignoredEvidence',
  'ignoredOAuthConfig',
  'ignoredTokenCache',
  'userConfirmationPresent',
  'driveFileOnlyConsentCompleted',
  'forbiddenAccountExcluded',
  'remoteInventorySafe',
  'appendOnlyRoundTripPassed',
  'commitLastVerified',
  'staleCreateRejected',
  'ambiguousCreateReconciled',
  'interruptedResumableRecovered',
  'crossClientReadVerified',
  'nonResurrectionVerified',
  'duplicateArtifactsAbsent',
  'physicalDeletionAvoided',
  'productionWritesRemainDisabled',
  'liveDriveMutationMade',
])
const PUBLIC_TEST_RESULT_KEYS = new Set([
  'offlineGateTestsPassed',
  'offlineContractTestsPassed',
  'oauthAuthorizationPassed',
  'liveDriveV2RoundTripPassed',
])

export class LiveValidationGateError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'LiveValidationGateError'
    this.code = code
  }
}

function fail(message, code) {
  throw new LiveValidationGateError(message, code)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizedAbsolute(value) {
  return path.resolve(String(value || ''))
}

function isInside(parent, child) {
  const relative = path.relative(normalizedAbsolute(parent), normalizedAbsolute(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function exactProperties(actual, expected, label) {
  const source = actual && typeof actual === 'object' && !Array.isArray(actual) ? actual : {}
  if (stableJson(source) !== stableJson(expected)) {
    fail(`${label} has unexpected or missing Drive app properties.`, 'invalid-drive-properties')
  }
}

export function assertSafeLocalIgnoredPath({ repoRoot, filePath, label, isTracked, isIgnored }) {
  const absoluteRoot = normalizedAbsolute(repoRoot)
  const absolute = normalizedAbsolute(filePath)
  const relative = path.relative(absoluteRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must remain inside this repository's ignored local directories.`, 'unsafe-local-path')
  }
  let cursor = absoluteRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      fail(`${label} must not pass through a symbolic link.`, 'unsafe-local-path')
    }
  }
  if (isTracked(absolute) || !isIgnored(absolute)) {
    fail(`${label} must be an ignored, untracked path inside this repository.`, 'unsafe-local-path')
  }
  return absolute
}

export function assertDriveFileOnlyScope(scope) {
  const scopes = String(scope || '').trim().split(/\s+/).filter(Boolean)
  if (scopes.length !== 1 || scopes[0] !== DRIVE_FILE_SCOPE) {
    fail('The effective Google access token must grant only the drive.file scope.', 'invalid-oauth-scope')
  }
  return DRIVE_FILE_SCOPE
}

export function normalizeForbiddenAccountHashes(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/)
  const hashes = [...new Set(entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))]
  if (hashes.length === 0) fail('Live validation requires a forbidden-account SHA-256 hash.', 'missing-forbidden-account')
  for (const hash of hashes) {
    if (!SHA256_PATTERN.test(hash)) fail('Forbidden accounts must be supplied only as SHA-256 hashes.', 'invalid-forbidden-account')
  }
  if (!hashes.includes(REQUIRED_FORBIDDEN_ACCOUNT_SHA256)) {
    fail('The required project-owner account exclusion is missing.', 'missing-required-forbidden-account')
  }
  return hashes
}

export function assertSelectedAccountAllowed(emailAddress, forbiddenAccountHashes) {
  const email = String(emailAddress || '').trim().toLowerCase()
  if (!email || !email.includes('@')) fail('Drive did not return a verifiable selected-account identity.', 'invalid-selected-account')
  const accountSha256 = sha256(email)
  if (new Set(normalizeForbiddenAccountHashes(forbiddenAccountHashes)).has(accountSha256)) {
    fail('The selected Google account is excluded from this validation run.', 'forbidden-validation-account')
  }
  return accountSha256
}

export async function assertSelectedDriveAccountAllowed(forbiddenAccountHashes, loadSelectedUser) {
  const forbidden = normalizeForbiddenAccountHashes(forbiddenAccountHashes)
  const user = await loadSelectedUser()
  if (user?.me !== true) fail('Drive did not identify the selected account as the requesting user.', 'invalid-selected-account')
  return assertSelectedAccountAllowed(user.emailAddress, forbidden)
}

export async function assertEffectiveDriveFileOnlyAccessToken(accessToken, fetchImpl = globalThis.fetch) {
  const token = String(accessToken || '').trim()
  if (!token) fail('Google returned no access token to validate.', 'invalid-access-token')
  const url = new URL('https://oauth2.googleapis.com/tokeninfo')
  url.searchParams.set('access_token', token)
  const response = await fetchImpl(url.toString(), { method: 'GET' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) fail('Google could not verify the effective access-token scope.', 'invalid-access-token')
  return assertDriveFileOnlyScope(body.scope)
}

export async function collectPaginatedDriveFiles(fetchPage) {
  const files = []
  const seen = new Set()
  let pageToken
  do {
    const page = await fetchPage(pageToken)
    if (!page || typeof page !== 'object' || !Array.isArray(page.files)) {
      fail('Drive returned an invalid inventory page.', 'invalid-drive-pagination')
    }
    files.push(...page.files)
    const next = String(page.nextPageToken || '').trim() || undefined
    if (next && seen.has(next)) fail('Drive repeated an inventory page token.', 'invalid-drive-pagination')
    if (next) seen.add(next)
    pageToken = next
  } while (pageToken)
  return files
}

export function makeValidationRunId(now = new Date(), randomHex = crypto.randomBytes(6).toString('hex')) {
  const suffix = String(randomHex).trim().toLowerCase()
  if (!/^[0-9a-f]{12}$/.test(suffix)) fail('Validation randomness must be twelve lowercase hexadecimal characters.', 'invalid-randomness')
  return `${now.toISOString().replace(/[:.]/g, '-').toLowerCase()}-${suffix}`
}

export function assertValidationRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId || ''))) fail('Live validation run id is missing or malformed.', 'invalid-run-id')
}

export function validationContainerName(runId) {
  assertValidationRunId(runId)
  return `${VALIDATION_CONTAINER_PREFIX}${runId}`
}

export function createValidationPlan({ now = new Date(), randomHex, sourceCommit }) {
  const runId = makeValidationRunId(now, randomHex)
  const commit = String(sourceCommit || '').trim()
  if (!SOURCE_COMMIT_PATTERN.test(commit)) fail('Live validation plans require the exact full source commit.', 'invalid-source-commit')
  const unsigned = {
    version: 2,
    runId,
    containerFolderName: validationContainerName(runId),
    workspaceRootName: WORKSPACE_ROOT_NAME,
    workspaceId: `ws-v2-${sha256(`easylab-drive-v2-live:${runId}:${commit}`).slice(0, 32)}`,
    createdAt: now.toISOString(),
    sourceCommit: commit,
    requiredScope: DRIVE_FILE_SCOPE,
    executionMode: LIVE_EXECUTION_MODE,
    evidenceRelativePath: `.labnote-smoke/drive-v2-append-only-validation/${runId}`,
    autoDeleteValidationContainer: false,
    productionWritesEnabled: false,
  }
  return { ...unsigned, planHash: sha256(stableJson(unsigned)) }
}

export function assertValidationPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('Live validation plan must be an object.', 'invalid-plan')
  if (plan.version !== 2) fail('Live validation plan version is unsupported.', 'invalid-plan-version')
  assertValidationRunId(plan.runId)
  const createdAt = String(plan.createdAt || '')
  if (Number.isNaN(Date.parse(createdAt)) || !plan.runId.startsWith(`${createdAt.replace(/[:.]/g, '-').toLowerCase()}-`)) {
    fail('The validation run id does not match its canonical UTC creation time.', 'invalid-created-at')
  }
  if (plan.containerFolderName !== validationContainerName(plan.runId)) fail('The validation container name is not exact.', 'invalid-container-name')
  if (plan.workspaceRootName !== WORKSPACE_ROOT_NAME) fail('The validation workspace root must retain the exact Drive v2 name.', 'invalid-workspace-name')
  if (!WORKSPACE_ID_PATTERN.test(String(plan.workspaceId || ''))) fail('The validation workspace id is malformed.', 'invalid-workspace-id')
  if (!SOURCE_COMMIT_PATTERN.test(String(plan.sourceCommit || ''))) fail('Live validation source commit is invalid.', 'invalid-source-commit')
  if (plan.requiredScope !== DRIVE_FILE_SCOPE) fail('Live validation must use only drive.file.', 'invalid-oauth-scope')
  if (plan.executionMode !== LIVE_EXECUTION_MODE) fail('Live validation is restricted to debug/test mode.', 'invalid-execution-mode')
  if (plan.autoDeleteValidationContainer !== false) fail('The harness must never automatically delete its container.', 'automatic-delete-refused')
  if (plan.productionWritesEnabled !== false) fail('A validation plan cannot enable production writes.', 'production-write-refused')
  if (plan.evidenceRelativePath !== `.labnote-smoke/drive-v2-append-only-validation/${plan.runId}`) {
    fail('Evidence must use the exact ignored v2 run path.', 'invalid-evidence-path')
  }
  const expectedWorkspaceId = `ws-v2-${sha256(`easylab-drive-v2-live:${plan.runId}:${plan.sourceCommit}`).slice(0, 32)}`
  if (plan.workspaceId !== expectedWorkspaceId) fail('The workspace id does not match this run and source.', 'invalid-workspace-id')
  const { planHash, ...unsigned } = plan
  if (!SHA256_PATTERN.test(String(planHash || '')) || planHash !== sha256(stableJson(unsigned))) {
    fail('The validation plan hash does not match its immutable fields.', 'invalid-plan-hash')
  }
  return plan
}

export function assertLocalLiveAuthorization({
  plan,
  env,
  repoRoot,
  currentHead,
  gitStatus,
  oauthConfigPath,
  tokenCachePath,
  evidenceDir,
  trackedPaths = [],
}) {
  assertValidationPlan(plan)
  if (env?.EASYLAB_DRIVE_V2_LIVE_WRITE_TEST !== LIVE_WRITE_ACKNOWLEDGEMENT) fail('Live Drive mutation acknowledgement is absent.', 'missing-live-acknowledgement')
  if (env?.EASYLAB_DRIVE_V2_LIVE_MODE !== LIVE_EXECUTION_MODE) fail('Drive v2 validation is not in debug/test mode.', 'missing-debug-test-mode')
  if (env?.EASYLAB_DRIVE_V2_USER_CONFIRMATION !== `approved:${plan.runId}`) fail('This run lacks exact one-run user confirmation.', 'missing-user-confirmation')
  normalizeForbiddenAccountHashes(env?.EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256)
  if (String(currentHead || '').trim() !== plan.sourceCommit) fail('The source commit changed after plan preparation.', 'source-commit-changed')
  if (String(gitStatus || '').trim()) fail('Live validation requires a clean Git worktree.', 'dirty-worktree')
  const absoluteRoot = normalizedAbsolute(repoRoot)
  const localRoot = path.join(absoluteRoot, '.labnote-local')
  const smokeRoot = path.join(absoluteRoot, '.labnote-smoke', 'drive-v2-append-only-validation')
  if (!isInside(localRoot, oauthConfigPath) || !isInside(localRoot, tokenCachePath)) fail('OAuth files must remain under .labnote-local.', 'unsafe-credential-path')
  if (!isInside(smokeRoot, evidenceDir) || normalizedAbsolute(evidenceDir) !== path.join(smokeRoot, plan.runId)) fail('Evidence must remain in the exact ignored run directory.', 'unsafe-evidence-path')
  const tracked = new Set(trackedPaths.map(normalizedAbsolute))
  for (const privatePath of [oauthConfigPath, tokenCachePath, evidenceDir]) {
    if (tracked.has(normalizedAbsolute(privatePath))) fail('Credentials, tokens, and evidence must never be tracked.', 'tracked-private-path')
  }
  return Object.freeze({
    runId: plan.runId,
    containerFolderName: plan.containerFolderName,
    workspaceRootName: plan.workspaceRootName,
    workspaceId: plan.workspaceId,
    scope: plan.requiredScope,
    sourceCommit: plan.sourceCommit,
    forbiddenAccountExclusionConfigured: true,
  })
}

function folderShape(file, name, label) {
  if (file?.name !== name || file?.mimeType !== DRIVE_FOLDER_MIME_TYPE || file?.trashed === true || !String(file?.id || '').trim()) {
    fail(`${label} is not the exact active Drive folder.`, 'invalid-remote-folder')
  }
}

function artifactIdentity(kind, file) {
  const id = String(file?.appProperties?.easylabCanonicalId || '')
  const digest = String(file?.appProperties?.easylabContentSha256 || '')
  if (!ARTIFACT_IDS[kind]?.test(id) || !SHA256_PATTERN.test(digest)) fail('A managed artifact has malformed canonical identity.', 'invalid-artifact-identity')
  if (id.slice(id.lastIndexOf('-') + 1) !== digest) fail('An artifact canonical id and content digest disagree.', 'invalid-artifact-identity')
  if (kind === 'object' && file.path !== `objects/${id}.json`) fail('An object path is not canonical.', 'invalid-artifact-path')
  if (kind === 'blob' && file.path !== `blobs/${id}.bin`) fail('A blob path is not canonical.', 'invalid-artifact-path')
  if (kind === 'commit' && file.path !== `commits/${id}.json`) fail('A commit path is not canonical.', 'invalid-artifact-path')
  if ((kind === 'object' || kind === 'commit') && file.mimeType !== 'application/json') fail('A JSON artifact has an invalid MIME type.', 'invalid-artifact-mime')
  if (kind === 'blob' && (!String(file.mimeType || '').trim() || file.mimeType === DRIVE_FOLDER_MIME_TYPE)) fail('A blob has an invalid MIME type.', 'invalid-artifact-mime')
  return { id, digest }
}

export function assertSafeRemoteValidationWorkspace({
  plan,
  containerMatches,
  containerChildren = [],
  workspaceChildren = [],
  managedFiles = [],
}) {
  assertValidationPlan(plan)
  if (![containerMatches, containerChildren, workspaceChildren, managedFiles].every(Array.isArray)) {
    fail('Drive validation inventories must be arrays.', 'invalid-remote-inventory')
  }
  if (!Array.isArray(containerMatches) || containerMatches.length > 1) fail('The disposable validation container is ambiguous.', 'ambiguous-validation-container')
  if (containerMatches.length === 0) {
    if (containerChildren.length || workspaceChildren.length || managedFiles.length) fail('Inventory was supplied without its validation container.', 'invalid-remote-inventory')
    return { disposition: 'create-new' }
  }
  const container = containerMatches[0]
  folderShape(container, plan.containerFolderName, 'Validation container')
  if (container.parentFolderDriveFileId !== 'root') fail('The validation container must be top-level.', 'invalid-container-parent')
  exactProperties(container.appProperties, { [VALIDATION_APP_PROPERTY]: plan.runId }, 'Validation container')
  if (containerChildren.length !== 1) fail('The container must hold exactly one Drive v2 workspace root.', 'invalid-container-inventory')
  const workspace = containerChildren[0]
  folderShape(workspace, WORKSPACE_ROOT_NAME, 'Drive v2 workspace root')
  if (workspace.parentFolderDriveFileId !== container.id) fail('The Drive v2 root is outside its validation container.', 'invalid-workspace-parent')
  exactProperties(workspace.appProperties, {
    easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER,
    easylabWorkspaceId: plan.workspaceId,
    easylabArtifactKind: 'workspace-root',
  }, 'Drive v2 workspace root')

  if (workspaceChildren.length !== MANAGED_FOLDER_ROLES.length) fail('The workspace must contain exactly its three managed folders.', 'invalid-workspace-inventory')
  const folderIds = {}
  for (const role of MANAGED_FOLDER_ROLES) {
    const matches = workspaceChildren.filter((file) => file?.name === role)
    if (matches.length !== 1) fail('A Drive v2 managed folder is missing or duplicated.', 'duplicate-managed-folder')
    const folder = matches[0]
    folderShape(folder, role, `Managed ${role} folder`)
    if (folder.parentFolderDriveFileId !== workspace.id) fail('A managed folder is outside the Drive v2 root.', 'invalid-managed-folder-parent')
    exactProperties(folder.appProperties, {
      easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER,
      easylabWorkspaceId: plan.workspaceId,
      easylabArtifactKind: 'managed-folder',
      easylabFolderRole: role,
    }, `Managed ${role} folder`)
    folderIds[role] = folder.id
  }
  if (workspaceChildren.some((file) => !MANAGED_FOLDER_ROLES.includes(file?.name))) fail('The workspace contains an unknown child.', 'foreign-drive-data')

  const seenPaths = new Set()
  for (const file of managedFiles) {
    if (!String(file?.id || '').trim() || file?.trashed === true || typeof file?.path !== 'string' || seenPaths.has(file.path)) {
      fail('The workspace contains a missing or duplicate artifact path.', 'duplicate-artifact-path')
    }
    seenPaths.add(file.path)
    const kind = String(file?.appProperties?.easylabArtifactKind || '')
    if (!MANAGED_FOLDER_ROLES.includes(`${kind}s`)) fail('The workspace contains an unknown artifact kind.', 'unknown-artifact-kind')
    const role = `${kind}s`
    if (file.parentFolderDriveFileId !== folderIds[role]) fail('An artifact is outside its exact managed folder.', 'invalid-artifact-parent')
    const { id, digest } = artifactIdentity(kind, file)
    exactProperties(file.appProperties, {
      easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER,
      easylabWorkspaceId: plan.workspaceId,
      easylabArtifactKind: kind,
      easylabCanonicalId: id,
      easylabContentSha256: digest,
    }, `Managed artifact ${file.path}`)
  }
  return { disposition: 'resume-exact', container, workspace, managedFolderIds: Object.freeze({ ...folderIds }) }
}

export function publicValidationEvidence({ plan, outcome, checks = {}, testResults = {} }) {
  assertValidationPlan(plan)
  if (!new Set(['prepared', 'blocked', 'passed', 'failed']).has(outcome)) fail('Evidence outcome is invalid.', 'invalid-evidence')
  const booleanMap = (values, label, allowed) => Object.fromEntries(Object.entries(values || {}).map(([key, value]) => {
    if (!allowed.has(key) || typeof value !== 'boolean') fail(`${label} evidence must contain approved boolean fields only.`, 'invalid-evidence')
    return [key, value]
  }))
  return {
    version: 2,
    outcome,
    checks: booleanMap(checks, 'Check', PUBLIC_CHECK_KEYS),
    testResults: booleanMap(testResults, 'Test', PUBLIC_TEST_RESULT_KEYS),
    productionWritesEnabled: false,
    validationContainerAutomaticallyDeleted: false,
  }
}
