import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const LIVE_WRITE_ACKNOWLEDGEMENT = 'approved'
export const LIVE_EXECUTION_MODE = 'debug-test'
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const VALIDATION_FOLDER_PREFIX = 'Easylab Lab Notebook Safety Validation '
export const NORMAL_WORKSPACE_NAME = 'Easylab Lab Notebook'
export const VALIDATION_APP_PROPERTY = 'easylabValidationRun'
export const MANAGED_ROOT_FOLDERS = Object.freeze([
  'devices',
  'entries',
  'attachments',
  'filebox',
  'transfers',
  'conflicts',
  'tombstones',
])

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{15,95}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const PUBLIC_CHECK_KEYS = new Set([
  'cleanWorktree',
  'ignoredEvidence',
  'ignoredOAuthConfig',
  'ignoredTokenCache',
  'userConfirmationPresent',
  'driveFileOnlyConsentCompleted',
  'forbiddenAccountExcluded',
  'tokenCacheIgnored',
  'liveDriveMutationMade',
  'isolatedWorkspaceVerified',
  'nativeManifestLastTransactionPassed',
  'nativePayloadRead',
  'nativeBlobHashVerified',
  'webLostResponseReconciled',
  'staleVersionRejected',
  'resumableInterruptionRecovered',
  'unknownFieldsPreserved',
  'electronTombstonePublished',
  'physicalDeletionAvoided',
  'nativeReadOnlyNonResurrectionPassed',
  'manifestCountsMatched',
  'duplicatePathsAbsent',
  'productionWritesRemainDisabled',
])
const PUBLIC_TEST_RESULT_KEYS = new Set([
  'offlineGateTestsPassed',
  'oauthAuthorizationPassed',
  'liveDriveV1RoundTripPassed',
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
  const hashes = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,]+/)
  const normalized = [...new Set(hashes.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))]
  if (normalized.length === 0) {
    fail('Live validation requires at least one forbidden-account SHA-256 hash.', 'missing-forbidden-account')
  }
  return normalized.map((hash) => {
    if (!SHA256_PATTERN.test(hash)) {
      fail('Forbidden validation accounts must be supplied as SHA-256 hashes.', 'invalid-forbidden-account')
    }
    return hash
  })
}

export async function assertSelectedDriveAccountAllowed(forbiddenAccountHashes, loadSelectedUser) {
  const forbidden = normalizeForbiddenAccountHashes(forbiddenAccountHashes)
  const user = await loadSelectedUser()
  if (user?.me !== true) {
    fail('Drive did not identify the selected validation account as the requesting user.', 'invalid-selected-account')
  }
  return assertSelectedAccountAllowed(user.emailAddress, forbidden)
}

export function assertSelectedAccountAllowed(emailAddress, forbiddenAccountHashes) {
  const email = String(emailAddress || '').trim().toLowerCase()
  if (!email || !email.includes('@')) {
    fail('Drive did not return a verifiable selected-account identity.', 'invalid-selected-account')
  }
  const forbidden = new Set(normalizeForbiddenAccountHashes(forbiddenAccountHashes))
  if (forbidden.has(sha256(email))) {
    fail('The selected Google account is excluded from this validation run.', 'forbidden-validation-account')
  }
  return true
}

export async function assertEffectiveDriveFileOnlyAccessToken(accessToken, fetchImpl = globalThis.fetch) {
  const token = String(accessToken || '').trim()
  if (!token) fail('Google returned no access token to validate.', 'invalid-access-token')
  const tokenInfoUrl = new URL('https://oauth2.googleapis.com/tokeninfo')
  tokenInfoUrl.searchParams.set('access_token', token)
  const response = await fetchImpl(tokenInfoUrl.toString(), { method: 'GET' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) fail('Google could not verify the effective access-token scope.', 'invalid-access-token')
  return assertDriveFileOnlyScope(payload.scope)
}

export async function collectPaginatedDriveFiles(fetchPage) {
  const files = []
  const seenTokens = new Set()
  let pageToken
  do {
    const page = await fetchPage(pageToken)
    if (!page || typeof page !== 'object' || !Array.isArray(page.files)) {
      fail('Drive returned an invalid validation inventory page.', 'invalid-drive-pagination')
    }
    files.push(...page.files)
    const nextPageToken = String(page.nextPageToken || '').trim() || undefined
    if (nextPageToken && seenTokens.has(nextPageToken)) {
      fail('Drive repeated an inventory page token.', 'invalid-drive-pagination')
    }
    if (nextPageToken) seenTokens.add(nextPageToken)
    pageToken = nextPageToken
  } while (pageToken)
  return files
}

export function makeValidationRunId(now = new Date(), randomHex = crypto.randomBytes(6).toString('hex')) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').toLowerCase()
  const suffix = String(randomHex).trim().toLowerCase()
  if (!/^[0-9a-f]{12}$/.test(suffix)) fail('Validation randomness must be twelve lowercase hexadecimal characters.', 'invalid-randomness')
  return `${timestamp}-${suffix}`
}

export function validationFolderName(runId) {
  assertValidationRunId(runId)
  return `${VALIDATION_FOLDER_PREFIX}${runId}`
}

export function assertValidationRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId || ''))) {
    fail('Live validation run id is missing or malformed.', 'invalid-run-id')
  }
}

export function assertValidationFolderName(folderName, runId) {
  assertValidationRunId(runId)
  if (folderName === NORMAL_WORKSPACE_NAME) {
    fail('The normal Easylab notebook folder can never be used for live safety validation.', 'normal-workspace-refused')
  }
  if (folderName !== validationFolderName(runId)) {
    fail('Live validation must use the exact generated disposable folder name.', 'invalid-folder-name')
  }
}

export function createValidationPlan({ now = new Date(), randomHex, sourceCommit }) {
  const runId = makeValidationRunId(now, randomHex)
  const plan = {
    version: 1,
    runId,
    rootFolderName: validationFolderName(runId),
    createdAt: now.toISOString(),
    sourceCommit: String(sourceCommit || '').trim(),
    requiredScope: DRIVE_FILE_SCOPE,
    executionMode: LIVE_EXECUTION_MODE,
    evidenceRelativePath: `.labnote-smoke/drive-v1-conditional-validation/${runId}`,
    autoDeleteValidationFolder: false,
    normalApplicationWritesEnabled: false,
  }
  if (!SOURCE_COMMIT_PATTERN.test(plan.sourceCommit)) {
    fail('Live validation plans require the exact full source commit.', 'invalid-source-commit')
  }
  return { ...plan, planHash: sha256(stableJson(plan)) }
}

export function assertValidationPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('Live validation plan must be an object.', 'invalid-plan')
  if (plan.version !== 1) fail('Live validation plan version is unsupported.', 'invalid-plan-version')
  assertValidationFolderName(plan.rootFolderName, plan.runId)
  if (!SOURCE_COMMIT_PATTERN.test(String(plan.sourceCommit || ''))) fail('Live validation source commit is invalid.', 'invalid-source-commit')
  if (plan.requiredScope !== DRIVE_FILE_SCOPE) fail('Live validation must use only the drive.file scope.', 'invalid-oauth-scope')
  if (plan.executionMode !== LIVE_EXECUTION_MODE) fail('Live validation is restricted to the debug/test execution mode.', 'invalid-execution-mode')
  if (plan.autoDeleteValidationFolder !== false) fail('The harness must never automatically delete its validation folder.', 'automatic-delete-refused')
  if (plan.normalApplicationWritesEnabled !== false) fail('A live plan cannot enable normal application writes.', 'production-write-refused')
  if (plan.evidenceRelativePath !== `.labnote-smoke/drive-v1-conditional-validation/${plan.runId}`) {
    fail('Live validation evidence path is not the generated ignored run path.', 'invalid-evidence-path')
  }
  const { planHash, ...unsigned } = plan
  if (!SHA256_PATTERN.test(String(planHash || '')) || planHash !== sha256(stableJson(unsigned))) {
    fail('Live validation plan hash does not match its immutable fields.', 'invalid-plan-hash')
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
  if (env?.EASYLAB_DRIVE_V1_LIVE_WRITE_TEST !== LIVE_WRITE_ACKNOWLEDGEMENT) {
    fail('Live Drive mutation acknowledgement is absent.', 'missing-live-acknowledgement')
  }
  if (env?.EASYLAB_DRIVE_V1_LIVE_MODE !== LIVE_EXECUTION_MODE) {
    fail('Live Drive validation is not in the debug/test execution mode.', 'missing-debug-test-mode')
  }
  const expectedConfirmation = `approved:${plan.runId}`
  if (env?.EASYLAB_DRIVE_V1_USER_CONFIRMATION !== expectedConfirmation) {
    fail('This validation run has not received its one-run user confirmation.', 'missing-user-confirmation')
  }
  if (String(currentHead || '').trim() !== plan.sourceCommit) {
    fail('The repository commit changed after the live validation plan was prepared.', 'source-commit-changed')
  }
  if (String(gitStatus || '').trim()) {
    fail('Live validation requires a clean Git worktree.', 'dirty-worktree')
  }

  const localRoot = path.join(normalizedAbsolute(repoRoot), '.labnote-local')
  const smokeRoot = path.join(normalizedAbsolute(repoRoot), '.labnote-smoke', 'drive-v1-conditional-validation')
  if (!isInside(localRoot, oauthConfigPath) || !isInside(localRoot, tokenCachePath)) {
    fail('OAuth configuration and token cache must stay under ignored .labnote-local storage.', 'unsafe-credential-path')
  }
  if (!isInside(smokeRoot, evidenceDir) || normalizedAbsolute(evidenceDir) !== path.join(smokeRoot, plan.runId)) {
    fail('Live validation evidence must stay in the exact ignored run directory.', 'unsafe-evidence-path')
  }
  const tracked = new Set(trackedPaths.map(normalizedAbsolute))
  for (const localPath of [oauthConfigPath, tokenCachePath, evidenceDir]) {
    if (tracked.has(normalizedAbsolute(localPath))) {
      fail('Credentials, tokens, and live evidence must never be tracked by Git.', 'tracked-private-path')
    }
  }
  return Object.freeze({
    runId: plan.runId,
    rootFolderName: plan.rootFolderName,
    scope: plan.requiredScope,
    sourceCommit: plan.sourceCommit,
  })
}

function requireValidationMarker(file, runId, label) {
  if (file?.appProperties?.[VALIDATION_APP_PROPERTY] !== runId) {
    fail(`${label} is not owned by this validation run.`, 'foreign-drive-data')
  }
}

export function assertSafeRemoteValidationWorkspace({
  plan,
  rootMatches,
  rootChildren = [],
  managedFolders = [],
  managedFiles = [],
  expectedUnmarkedFiles = {},
  allowedManagedPaths = [],
  allowedManagedFolderPaths = [],
}) {
  assertValidationPlan(plan)
  if (!Array.isArray(rootMatches) || rootMatches.length > 1) {
    fail('The generated validation folder name is ambiguous in Drive.', 'ambiguous-validation-root')
  }
  if (rootMatches.length === 0) {
    if (rootChildren.length || managedFolders.length || managedFiles.length) fail('Remote inventory was supplied without a validation root.', 'invalid-remote-inventory')
    return { disposition: 'create-new' }
  }

  const root = rootMatches[0]
  if (root.name !== plan.rootFolderName || root.mimeType !== 'application/vnd.google-apps.folder' || root.trashed === true) {
    fail('The saved validation root is not the exact active generated folder.', 'invalid-validation-root')
  }
  requireValidationMarker(root, plan.runId, 'Validation root')

  const seenChildren = new Set()
  for (const child of rootChildren) {
    if (seenChildren.has(child.name)) fail('The validation root contains duplicate child paths.', 'duplicate-validation-path')
    seenChildren.add(child.name)
    requireValidationMarker(child, plan.runId, `Validation child ${child.name}`)
    const allowedFolder = child.mimeType === 'application/vnd.google-apps.folder' && MANAGED_ROOT_FOLDERS.includes(child.name)
    const allowedManifest = child.mimeType !== 'application/vnd.google-apps.folder' && child.name === 'manifest.json'
    if (!allowedFolder && !allowedManifest) {
      fail('The validation root contains non-test or unknown data.', 'foreign-drive-data')
    }
  }

  const seenPaths = new Set()
  const allowedPaths = new Set(allowedManagedPaths)
  const allowedFolderPaths = new Set(allowedManagedFolderPaths)
  for (const folder of managedFolders) {
    const managedPath = String(folder.path || '')
    if (!managedPath || seenPaths.has(managedPath)) fail('The validation workspace contains a missing or duplicate managed folder path.', 'duplicate-validation-path')
    if (allowedFolderPaths.size > 0 && !allowedFolderPaths.has(managedPath)) {
      fail('The validation workspace contains an unplanned managed folder.', 'foreign-drive-data')
    }
    seenPaths.add(managedPath)
    requireValidationMarker(folder, plan.runId, `Validation folder ${managedPath}`)
    const topLevel = managedPath.split('/')[0]
    if (!MANAGED_ROOT_FOLDERS.includes(topLevel)) {
      fail('The validation workspace contains a folder outside the Drive v1 layout.', 'foreign-drive-data')
    }
  }
  for (const file of managedFiles) {
    const managedPath = String(file.path || '')
    if (!managedPath || seenPaths.has(managedPath)) fail('The validation workspace contains a missing or duplicate managed path.', 'duplicate-validation-path')
    if (allowedPaths.size > 0 && !allowedPaths.has(managedPath)) {
      fail('The validation workspace contains an unplanned managed path.', 'foreign-drive-data')
    }
    seenPaths.add(managedPath)
    if (file?.appProperties?.[VALIDATION_APP_PROPERTY] !== plan.runId) {
      const expectedProperties = expectedUnmarkedFiles[managedPath]
      const exactNativeIdentity = expectedProperties && Object.entries(expectedProperties)
        .every(([key, value]) => file?.appProperties?.[key] === value)
      if (!exactNativeIdentity) {
        fail(`Validation file ${managedPath} is not owned by this validation run.`, 'foreign-drive-data')
      }
    }
    const topLevel = managedPath.split('/')[0]
    if (managedPath !== 'manifest.json' && !MANAGED_ROOT_FOLDERS.includes(topLevel)) {
      fail('The validation workspace contains a path outside the Drive v1 layout.', 'foreign-drive-data')
    }
  }
  return { disposition: 'resume-exact', root }
}

export function publicValidationEvidence({
  plan,
  outcome,
  checks = {},
  testResults = {},
}) {
  assertValidationPlan(plan)
  const allowedOutcomes = new Set(['prepared', 'blocked', 'passed', 'failed'])
  if (!allowedOutcomes.has(outcome)) fail('Live validation evidence outcome is invalid.', 'invalid-evidence')
  const booleanMap = (value, label, allowedKeys) => Object.fromEntries(Object.entries(value || {}).map(([key, entry]) => {
    if (!allowedKeys.has(key)) fail(`${label} evidence key is not public.`, 'invalid-evidence')
    if (typeof entry !== 'boolean') fail(`${label} evidence values must be boolean.`, 'invalid-evidence')
    return [key, entry]
  }))
  return {
    version: 1,
    runId: plan.runId,
    rootFolderName: plan.rootFolderName,
    sourceCommit: plan.sourceCommit,
    scope: plan.requiredScope,
    outcome,
    checks: booleanMap(checks, 'Check', PUBLIC_CHECK_KEYS),
    testResults: booleanMap(testResults, 'Test', PUBLIC_TEST_RESULT_KEYS),
    normalApplicationWritesEnabled: false,
    validationFolderAutomaticallyDeleted: false,
  }
}
