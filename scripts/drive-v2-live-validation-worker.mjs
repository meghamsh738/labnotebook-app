import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  DRIVE_FILE_SCOPE,
  DRIVE_FOLDER_MIME_TYPE,
  DRIVE_V2_PROTOCOL_MARKER,
  MANAGED_FOLDER_ROLES,
  VALIDATION_APP_PROPERTY,
  WORKSPACE_ROOT_NAME,
  assertDriveFileOnlyScope,
  assertEffectiveDriveFileOnlyAccessToken,
  assertLocalLiveAuthorization,
  assertSafeLocalIgnoredPath,
  assertSafeRemoteValidationWorkspace,
  assertSelectedDriveAccountAllowed,
  assertValidationPlan,
  collectPaginatedDriveFiles,
  normalizeForbiddenAccountHashes,
  publicValidationEvidence,
} from './drive-v2-live-validation-gate.mjs'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const FILE_FIELDS = 'id,name,mimeType,trashed,version,parents,appProperties'
const NATIVE_TEST_CLASS = 'com.easylab.labnotebook.sync.DriveV2LiveValidationHarnessTest'
const BROWSER_TEST = 'web/tests/drive-v2-live-validation-round-trip.spec.ts'

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error(`${label} is unavailable or invalid.`)
  }
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function isTracked(repoRoot, filePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path.relative(repoRoot, filePath)], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch { return false }
}

function isIgnored(repoRoot, filePath) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', filePath], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch { return false }
}

export function assertWorkerAuthorization({ plan, planFile, evidenceDir, repoRoot, oauthConfigPath, tokenCachePath, env = process.env }) {
  if (path.resolve(env.EASYLAB_DRIVE_V2_LIVE_PLAN_FILE || '') !== path.resolve(planFile)) throw new Error('The worker lacks the exact gated plan.')
  if (path.resolve(planFile) !== path.resolve(evidenceDir, 'plan.json')) throw new Error('The worker plan is outside its exact evidence directory.')
  const persisted = assertValidationPlan(readJson(planFile, 'Drive v2 validation plan'))
  const supplied = assertValidationPlan(plan)
  if (persisted.planHash !== supplied.planHash) throw new Error('The worker plan differs from its immutable plan file.')
  const ignored = (filePath, label) => assertSafeLocalIgnoredPath({
    repoRoot, filePath, label,
    isTracked: (value) => isTracked(repoRoot, value),
    isIgnored: (value) => isIgnored(repoRoot, value),
  })
  ignored(planFile, 'Live validation plan')
  ignored(evidenceDir, 'Live evidence directory')
  ignored(oauthConfigPath, 'OAuth configuration')
  ignored(tokenCachePath, 'OAuth token cache')
  normalizeForbiddenAccountHashes(env.EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256)
  return assertLocalLiveAuthorization({
    plan: supplied, env, repoRoot,
    currentHead: git(repoRoot, ['rev-parse', 'HEAD']),
    gitStatus: git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    oauthConfigPath, tokenCachePath, evidenceDir,
    trackedPaths: [planFile, evidenceDir, oauthConfigPath, tokenCachePath].filter((value) => isTracked(repoRoot, value)),
  })
}

function readOAuthConfig(configPath) {
  if (!fs.existsSync(configPath)) throw new Error('The ignored Desktop OAuth configuration is missing.')
  const parsed = readJson(configPath, 'Desktop OAuth configuration')
  const section = parsed.installed || parsed
  const clientId = String(section.client_id || section.clientId || '').trim()
  const clientSecret = String(section.client_secret || section.clientSecret || '').trim()
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('OAuth configuration is not a Google Desktop client.')
  return { clientId, clientSecret }
}

function readRefreshToken(tokenCachePath, clientId) {
  if (!fs.existsSync(tokenCachePath)) throw new Error('Manual OAuth authorization is required before execution.')
  const parsed = readJson(tokenCachePath, 'Drive v2 validation token cache')
  if (String(parsed.client_id || '').trim() !== clientId || !String(parsed.refresh_token || '').trim()) throw new Error('The isolated token cache does not match this OAuth client.')
  assertDriveFileOnlyScope(parsed.scope)
  const accountSha256 = String(parsed.account_sha256 || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(accountSha256)) throw new Error('The isolated token cache is not bound to a selected account.')
  return Object.freeze({ refreshToken: String(parsed.refresh_token), accountSha256 })
}

async function tokenRequest(body) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.access_token) throw new Error(`OAuth token request failed with status ${response.status}.`)
  await assertEffectiveDriveFileOnlyAccessToken(String(payload.access_token))
  return payload
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken })
  if (clientSecret) body.set('client_secret', clientSecret)
  return String((await tokenRequest(body)).access_token)
}

function base64Url(value) { return Buffer.from(value).toString('base64url') }

export function makePkce(randomBytes = crypto.randomBytes(32)) {
  const verifier = base64Url(randomBytes)
  return { verifier, challenge: base64Url(crypto.createHash('sha256').update(verifier).digest()) }
}

function createOAuthListener(timeoutMs = 10 * 60 * 1000) {
  let timer
  let resolveCode
  let rejectCode
  const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth2callback') { response.writeHead(404); response.end('Not found'); return }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      response.writeHead(error || !code ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(error || !code ? 'Easylab Drive v2 authorization failed.' : 'Authorization complete. You may close this tab.')
      clearTimeout(timer); server.close()
      if (error || !code) rejectCode(new Error('Google authorization did not return an authorization code.'))
      else resolveCode(code)
    } catch { clearTimeout(timer); server.close(); rejectCode(new Error('Google authorization callback was invalid.')) }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      timer = setTimeout(() => { server.close(); rejectCode(new Error('Timed out waiting for manual OAuth consent.')) }, timeoutMs)
      resolve({ redirectUri: `http://127.0.0.1:${server.address().port}/oauth2callback`, codePromise })
    })
  })
}

async function exchangeCode({ clientId, clientSecret, code, verifier, redirectUri }) {
  const body = new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri })
  if (clientSecret) body.set('client_secret', clientSecret)
  const payload = await tokenRequest(body)
  if (!payload.refresh_token) throw new Error('Google returned no refresh token for isolated validation.')
  assertDriveFileOnlyScope(payload.scope)
  return payload
}

async function driveRequest(accessToken, url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase()
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new Error(`Drive v2 validation forbids HTTP ${method}.`)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(url, { ...init, method, headers, redirect: 'error' })
  if (!response.ok) throw new Error(`Drive v2 validation request failed with status ${response.status}.`)
  return response
}

async function verifySelectedAccount(accessToken) {
  const forbidden = normalizeForbiddenAccountHashes(process.env.EASYLAB_DRIVE_V2_FORBIDDEN_ACCOUNT_SHA256)
  return assertSelectedDriveAccountAllowed(forbidden, async () => {
    const response = await driveRequest(accessToken, `${DRIVE_API}/about?fields=user(emailAddress,me)`)
    return (await response.json())?.user
  })
}

export async function authorizeLiveDriveV2Validation(context) {
  assertWorkerAuthorization(context)
  const { plan, evidenceDir, oauthConfigPath, tokenCachePath } = context
  const { clientId, clientSecret } = readOAuthConfig(oauthConfigPath)
  if (fs.existsSync(tokenCachePath)) {
    const cached = readRefreshToken(tokenCachePath, clientId)
    const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken: cached.refreshToken })
    const selectedAccountSha256 = await verifySelectedAccount(accessToken)
    if (selectedAccountSha256 !== cached.accountSha256) throw new Error('The selected Google account changed from the isolated token-cache binding.')
    console.log(JSON.stringify({ authorized: true, reusedIgnoredTokenCache: true, forbiddenAccountExcluded: true, liveDriveMutationMade: false }, null, 2))
    return
  }
  const authDirectory = path.join(path.dirname(tokenCachePath), 'drive-v2-live-auth', plan.runId)
  const authUrlFile = path.join(authDirectory, 'oauth-url.txt')
  const { verifier, challenge } = makePkce()
  const listener = await createOAuthListener()
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  for (const [key, value] of Object.entries({
    client_id: clientId, redirect_uri: listener.redirectUri, response_type: 'code', scope: DRIVE_FILE_SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
    include_granted_scopes: 'false',
  })) authUrl.searchParams.set(key, value)
  fs.mkdirSync(authDirectory, { recursive: true })
  fs.writeFileSync(authUrlFile, `${authUrl}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ waitingForManualOAuthConsent: true, oauthUrlFile: authUrlFile, requestedScope: DRIVE_FILE_SCOPE, liveDriveMutationMade: false }, null, 2))
  const payload = await exchangeCode({ clientId, clientSecret, code: await listener.codePromise, verifier, redirectUri: listener.redirectUri })
  // Account exclusion deliberately precedes the first token-cache write.
  const selectedAccountSha256 = await verifySelectedAccount(String(payload.access_token))
  writePrivateJson(tokenCachePath, {
    client_id: clientId,
    refresh_token: payload.refresh_token,
    scope: DRIVE_FILE_SCOPE,
    token_type: payload.token_type || 'Bearer',
    account_sha256: selectedAccountSha256,
  })
  fs.rmSync(authUrlFile, { force: true })
  writePrivateJson(path.join(evidenceDir, 'authorization.json'), publicValidationEvidence({
    plan, outcome: 'prepared',
    checks: { driveFileOnlyConsentCompleted: true, forbiddenAccountExcluded: true, liveDriveMutationMade: false, productionWritesRemainDisabled: true },
    testResults: { oauthAuthorizationPassed: true },
  }))
  console.log(JSON.stringify({ authorized: true, tokenCacheStoredInIgnoredLocalPath: true, liveDriveMutationMade: false }, null, 2))
}

function escapeDriveQuery(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") }

async function listChildren(accessToken, parentId) {
  return collectPaginatedDriveFiles(async (pageToken) => {
    const url = new URL(`${DRIVE_API}/files`)
    url.searchParams.set('q', `'${escapeDriveQuery(parentId)}' in parents and trashed = false`)
    url.searchParams.set('spaces', 'drive'); url.searchParams.set('pageSize', '1000')
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const payload = await (await driveRequest(accessToken, url.toString())).json()
    return { files: payload.files || [], nextPageToken: payload.nextPageToken }
  })
}

async function listNamedTopLevel(accessToken, name) {
  return (await listChildren(accessToken, 'root')).filter((file) => file.name === name)
}

async function generateIds(accessToken, count) {
  const url = new URL(`${DRIVE_API}/files/generateIds`)
  url.searchParams.set('count', String(count)); url.searchParams.set('space', 'drive'); url.searchParams.set('fields', 'ids')
  const ids = (await (await driveRequest(accessToken, url.toString())).json()).ids
  if (!Array.isArray(ids) || ids.length !== count || ids.some((id) => !String(id).trim()) || new Set(ids).size !== ids.length) throw new Error('Drive did not return exact unique pre-generated folder ids.')
  return ids.map(String)
}

async function createFolder(accessToken, descriptor) {
  const response = await driveRequest(accessToken, `${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ id: descriptor.id, name: descriptor.name, mimeType: DRIVE_FOLDER_MIME_TYPE, ...(descriptor.parentId === 'root' ? {} : { parents: [descriptor.parentId] }), appProperties: descriptor.appProperties }),
  })
  return response.json()
}

function withParent(file) { return { ...file, parentFolderDriveFileId: file?.parents?.[0] || 'root' } }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function requireAccountSha256(value) {
  const accountSha256 = String(value || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(accountSha256)) throw new Error('Private Drive v2 state is not bound to a selected account.')
  return accountSha256
}

export function folderJournal(plan, ids, selectedAccountSha256) {
  const accountSha256 = requireAccountSha256(selectedAccountSha256)
  return {
    version: 2, runId: plan.runId, workspaceId: plan.workspaceId, accountSha256,
    container: { id: ids[0], name: plan.containerFolderName, parentId: 'root', appProperties: { [VALIDATION_APP_PROPERTY]: plan.runId } },
    workspace: { id: ids[1], name: WORKSPACE_ROOT_NAME, parentId: ids[0], appProperties: { easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER, easylabWorkspaceId: plan.workspaceId, easylabArtifactKind: 'workspace-root' } },
    folders: Object.fromEntries(MANAGED_FOLDER_ROLES.map((role, index) => [role, { id: ids[index + 2], name: role, parentId: ids[1], appProperties: { easylabDriveProtocol: DRIVE_V2_PROTOCOL_MARKER, easylabWorkspaceId: plan.workspaceId, easylabArtifactKind: 'managed-folder', easylabFolderRole: role } }])),
  }
}

export function assertProvisioningJournal(plan, journal, selectedAccountSha256) {
  const accountSha256 = requireAccountSha256(selectedAccountSha256)
  if (journal?.version !== 2 || journal.runId !== plan.runId || journal.workspaceId !== plan.workspaceId || journal.accountSha256 !== accountSha256) throw new Error('The private provisioning journal does not match this account and validation plan.')
  const values = [journal.container, journal.workspace, ...MANAGED_FOLDER_ROLES.map((role) => journal.folders?.[role])]
  if (values.some((value) => !value?.id || !value?.name || !value?.parentId || !value?.appProperties) || new Set(values.map((value) => value.id)).size !== values.length) throw new Error('The private provisioning journal is incomplete or ambiguous.')
  const expected = folderJournal(plan, values.map((value) => value.id), accountSha256)
  if (stableJson(journal) !== stableJson(expected)) throw new Error('The private provisioning journal contains a descriptor outside the exact signed validation plan.')
  return journal
}

function exactStringMap(left, right) {
  return JSON.stringify(Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b)))
}

async function reconcileOrCreateFolder(accessToken, descriptor, currentChildren) {
  const matches = currentChildren.filter((file) => file.name === descriptor.name)
  if (matches.length > 1) throw new Error('A validation folder name is duplicated.')
  if (matches.length === 1) {
    const exact = descriptor.parentId === 'root'
      ? { ...withParent(matches[0]), parentFolderDriveFileId: 'root' }
      : withParent(matches[0])
    if (exact.id !== descriptor.id || exact.mimeType !== DRIVE_FOLDER_MIME_TYPE || exact.trashed === true || exact.parentFolderDriveFileId !== descriptor.parentId || !exactStringMap(exact.appProperties, descriptor.appProperties)) throw new Error('A validation folder occupant differs from its persisted identity.')
    return exact
  }
  const created = withParent(await createFolder(accessToken, descriptor))
  return descriptor.parentId === 'root' ? { ...created, parentFolderDriveFileId: 'root' } : created
}

async function collectInventory(accessToken, journal) {
  const containerMatches = await listNamedTopLevel(accessToken, journal.container.name)
  if (containerMatches.length === 0) return { containerMatches: [], containerChildren: [], workspaceChildren: [], managedFiles: [] }
  const containerChildren = await listChildren(accessToken, journal.container.id)
  const workspaceChildren = await listChildren(accessToken, journal.workspace.id)
  const managedFiles = []
  for (const role of MANAGED_FOLDER_ROLES) {
    for (const file of await listChildren(accessToken, journal.folders[role].id)) {
      managedFiles.push({ ...withParent(file), path: `${role}/${file.name}` })
    }
  }
  return {
    containerMatches: containerMatches.map((file) => ({ ...withParent(file), parentFolderDriveFileId: 'root' })),
    containerChildren: containerChildren.map(withParent),
    workspaceChildren: workspaceChildren.map(withParent),
    managedFiles,
  }
}

function assertNativeGenesisIdsPresent(inventory, nativeIds) {
  const remoteIds = inventory.managedFiles.map((file) => file.id)
  if (remoteIds.length !== new Set(remoteIds).size || Object.values(nativeIds).some((id) => !remoteIds.includes(id))) {
    throw new Error('The verified native genesis artifacts are missing or duplicated after the native phase.')
  }
}

async function provisionOrResume({ accessToken, plan, evidenceDir, selectedAccountSha256 }) {
  const journalFile = path.join(evidenceDir, 'provisioning.json')
  let journal
  if (fs.existsSync(journalFile)) journal = assertProvisioningJournal(
    plan,
    readJson(journalFile, 'Private provisioning journal'),
    selectedAccountSha256,
  )
  else {
    const existing = await listNamedTopLevel(accessToken, plan.containerFolderName)
    if (existing.length) throw new Error('A validation container exists without its private pre-generated-id journal.')
    journal = folderJournal(plan, await generateIds(accessToken, 5), selectedAccountSha256)
    writePrivateJson(journalFile, journal)
  }
  await reconcileOrCreateFolder(accessToken, journal.container, await listChildren(accessToken, 'root'))
  await reconcileOrCreateFolder(accessToken, journal.workspace, await listChildren(accessToken, journal.container.id))
  for (const role of MANAGED_FOLDER_ROLES) await reconcileOrCreateFolder(accessToken, journal.folders[role], await listChildren(accessToken, journal.workspace.id))
  const inventory = await collectInventory(accessToken, journal)
  const verified = assertSafeRemoteValidationWorkspace({ plan, ...inventory })
  if (verified.container.id !== journal.container.id || verified.workspace.id !== journal.workspace.id || MANAGED_FOLDER_ROLES.some((role) => verified.managedFolderIds[role] !== journal.folders[role].id)) throw new Error('Verified remote folders differ from the private journal.')
  return { journal, inventory }
}

function assertPrivateIdJournal(persisted, plan, selectedAccountSha256, roles, label) {
  const accountSha256 = requireAccountSha256(selectedAccountSha256)
  const ids = persisted?.ids
  if (persisted?.version !== 2 || persisted.runId !== plan.runId || persisted.workspaceId !== plan.workspaceId ||
    persisted.accountSha256 !== accountSha256 || !ids ||
    !roles.every((role) => typeof ids[role] === 'string' && ids[role].trim()) ||
    Object.keys(ids).sort().join(',') !== [...roles].sort().join(',') ||
    new Set(roles.map((role) => ids[role])).size !== roles.length) {
    throw new Error(`${label} does not match this account and validation plan.`)
  }
  return Object.freeze({ ...ids })
}

async function nativeGenesisIds(accessToken, plan, evidenceDir, selectedAccountSha256) {
  const filePath = path.join(evidenceDir, 'native-genesis-ids.json')
  if (fs.existsSync(filePath)) {
    const persisted = readJson(filePath, 'Private native genesis id journal')
    return assertPrivateIdJournal(
      persisted,
      plan,
      selectedAccountSha256,
      ['blob', 'entry', 'attachment', 'commit'],
      'The private native genesis id journal',
    )
  }
  const generated = await generateIds(accessToken, 4)
  const ids = Object.freeze({ blob: generated[0], entry: generated[1], attachment: generated[2], commit: generated[3] })
  writePrivateJson(filePath, {
    version: 2,
    runId: plan.runId,
    workspaceId: plan.workspaceId,
    accountSha256: requireAccountSha256(selectedAccountSha256),
    ids,
  })
  return ids
}

const BROWSER_ID_ROLES = Object.freeze([
  'webEntry', 'webCommit', 'webLargeBlob', 'webAttachment', 'webBlobCommit',
  'electronEntryTombstone', 'electronAttachmentTombstone', 'electronCommit',
])

async function browserArtifactIds(accessToken, plan, evidenceDir, selectedAccountSha256) {
  const filePath = path.join(evidenceDir, 'browser-artifact-ids.json')
  if (fs.existsSync(filePath)) {
    const persisted = readJson(filePath, 'Private browser artifact id journal')
    return assertPrivateIdJournal(
      persisted,
      plan,
      selectedAccountSha256,
      BROWSER_ID_ROLES,
      'The private browser artifact id journal',
    )
  }
  const generated = await generateIds(accessToken, BROWSER_ID_ROLES.length)
  const ids = Object.freeze(Object.fromEntries(BROWSER_ID_ROLES.map((role, index) => [role, generated[index]])))
  writePrivateJson(filePath, {
    version: 2,
    runId: plan.runId,
    workspaceId: plan.workspaceId,
    accountSha256: requireAccountSha256(selectedAccountSha256),
    ids,
  })
  return ids
}

function phaseEnvironment(context, accessToken, selectedAccountSha256, journal, nativeIds, browserIds, phase) {
  return {
    ...process.env, FORCE_COLOR: '0',
    EASYLAB_DRIVE_V2_NATIVE_PHASE: phase,
    EASYLAB_DRIVE_V2_RUN_ID: context.plan.runId,
    EASYLAB_DRIVE_V2_REPO_ROOT: context.repoRoot,
    EASYLAB_DRIVE_V2_PLAN_FILE: context.planFile,
    EASYLAB_DRIVE_V2_PLAN_HASH: context.plan.planHash,
    EASYLAB_DRIVE_V2_SOURCE_COMMIT: context.plan.sourceCommit,
    EASYLAB_DRIVE_V2_CONTAINER_FOLDER_ID: journal.container.id,
    EASYLAB_DRIVE_V2_WORKSPACE_ROOT_ID: journal.workspace.id,
    EASYLAB_DRIVE_V2_WORKSPACE_ID: context.plan.workspaceId,
    EASYLAB_DRIVE_V2_ACCOUNT_SHA256: requireAccountSha256(selectedAccountSha256),
    EASYLAB_DRIVE_V2_OBJECTS_FOLDER_ID: journal.folders.objects.id,
    EASYLAB_DRIVE_V2_BLOBS_FOLDER_ID: journal.folders.blobs.id,
    EASYLAB_DRIVE_V2_COMMITS_FOLDER_ID: journal.folders.commits.id,
    EASYLAB_DRIVE_V2_NATIVE_BLOB_FILE_ID: nativeIds.blob,
    EASYLAB_DRIVE_V2_NATIVE_ENTRY_FILE_ID: nativeIds.entry,
    EASYLAB_DRIVE_V2_NATIVE_ATTACHMENT_FILE_ID: nativeIds.attachment,
    EASYLAB_DRIVE_V2_NATIVE_COMMIT_FILE_ID: nativeIds.commit,
    EASYLAB_DRIVE_V2_WEB_ENTRY_FILE_ID: browserIds.webEntry,
    EASYLAB_DRIVE_V2_WEB_COMMIT_FILE_ID: browserIds.webCommit,
    EASYLAB_DRIVE_V2_WEB_LARGE_BLOB_FILE_ID: browserIds.webLargeBlob,
    EASYLAB_DRIVE_V2_WEB_ATTACHMENT_FILE_ID: browserIds.webAttachment,
    EASYLAB_DRIVE_V2_WEB_BLOB_COMMIT_FILE_ID: browserIds.webBlobCommit,
    EASYLAB_DRIVE_V2_ELECTRON_ENTRY_TOMBSTONE_FILE_ID: browserIds.electronEntryTombstone,
    EASYLAB_DRIVE_V2_ELECTRON_ATTACHMENT_TOMBSTONE_FILE_ID: browserIds.electronAttachmentTombstone,
    EASYLAB_DRIVE_V2_ELECTRON_COMMIT_FILE_ID: browserIds.electronCommit,
    EASYLAB_DRIVE_V2_ACCESS_TOKEN: accessToken,
    EASYLAB_DRIVE_V2_TIMESTAMP: context.plan.createdAt,
  }
}

function runNativePhase(context, accessToken, selectedAccountSha256, journal, nativeIds, browserIds, method, phase) {
  execFileSync(process.execPath, ['scripts/android-gradle.mjs', '--no-daemon', ':app:testDebugUnitTest', '--tests', `${NATIVE_TEST_CLASS}.${method}`], {
    cwd: context.repoRoot,
    env: phaseEnvironment(context, accessToken, selectedAccountSha256, journal, nativeIds, browserIds, phase),
    stdio: 'inherit',
  })
}

function runBrowserPhase(context, accessToken, selectedAccountSha256, journal, nativeIds, browserIds) {
  const testFile = path.join(context.repoRoot, BROWSER_TEST)
  if (!fs.existsSync(testFile)) throw new Error('The dedicated Drive v2 Playwright validation phase is missing.')
  execFileSync('npm', ['--prefix', 'web', 'run', 'test:e2e', '--', 'tests/drive-v2-live-validation-round-trip.spec.ts'], {
    cwd: context.repoRoot,
    env: {
      ...phaseEnvironment(
        context,
        accessToken,
        selectedAccountSha256,
        journal,
        nativeIds,
        browserIds,
        'browser-append-electron-tombstone',
      ),
      EASYLAB_DRIVE_V2_BROWSER_PHASE: 'web-append-electron-tombstone',
      PLAYWRIGHT_LIST_PRINT_STEPS: '1',
    },
    stdio: 'inherit',
  })
}

export async function runLiveDriveV2Validation(context) {
  assertWorkerAuthorization(context)
  const { plan, evidenceDir, oauthConfigPath, tokenCachePath } = context
  const resultFile = path.join(evidenceDir, 'result.json')
  try {
    const { clientId, clientSecret } = readOAuthConfig(oauthConfigPath)
    const cached = readRefreshToken(tokenCachePath, clientId)
    const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken: cached.refreshToken })
    const selectedAccountSha256 = await verifySelectedAccount(accessToken)
    if (selectedAccountSha256 !== cached.accountSha256) throw new Error('The selected Google account changed from the isolated token-cache binding.')
    const provisioned = await provisionOrResume({ accessToken, plan, evidenceDir, selectedAccountSha256 })
    const nativeIds = await nativeGenesisIds(accessToken, plan, evidenceDir, selectedAccountSha256)
    const browserIds = await browserArtifactIds(accessToken, plan, evidenceDir, selectedAccountSha256)
    runNativePhase(context, accessToken, selectedAccountSha256, provisioned.journal, nativeIds, browserIds, 'nativeCreatesGenesisWithLargeBlobAndCommitLast', 'native-create')
    const nativeInventory = await collectInventory(accessToken, provisioned.journal)
    assertSafeRemoteValidationWorkspace({ plan, ...nativeInventory })
    assertNativeGenesisIdsPresent(nativeInventory, nativeIds)
    runBrowserPhase(context, accessToken, selectedAccountSha256, provisioned.journal, nativeIds, browserIds)
    runNativePhase(context, accessToken, selectedAccountSha256, provisioned.journal, nativeIds, browserIds, 'nativeReadsFinalGraphAndProvesNonResurrection', 'native-read-final')
    const finalInventory = await collectInventory(accessToken, provisioned.journal)
    assertSafeRemoteValidationWorkspace({ plan, ...finalInventory })
    writePrivateJson(resultFile, publicValidationEvidence({
      plan, outcome: 'passed',
      checks: {
        forbiddenAccountExcluded: true, remoteInventorySafe: true, appendOnlyRoundTripPassed: true,
        commitLastVerified: true, staleCreateRejected: true, ambiguousCreateReconciled: true,
        interruptedResumableRecovered: true, crossClientReadVerified: true, nonResurrectionVerified: true,
        duplicateArtifactsAbsent: true, physicalDeletionAvoided: true,
        productionWritesRemainDisabled: true, liveDriveMutationMade: true,
      },
      testResults: { liveDriveV2RoundTripPassed: true },
    }))
    console.log(JSON.stringify({ passed: true, evidenceFile: resultFile, validationContainerAutomaticallyDeleted: false, productionWritesEnabled: false }, null, 2))
  } catch (error) {
    writePrivateJson(resultFile, publicValidationEvidence({
      plan, outcome: 'failed', checks: { productionWritesRemainDisabled: true },
      testResults: { liveDriveV2RoundTripPassed: false },
    }))
    throw new Error('Drive v2 validation stopped safely; ignored boolean-only evidence was preserved and production writes remain disabled.', { cause: error })
  }
}
