import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  DRIVE_FILE_SCOPE,
  MANAGED_ROOT_FOLDERS,
  VALIDATION_APP_PROPERTY,
  assertDriveFileOnlyScope,
  assertEffectiveDriveFileOnlyAccessToken,
  assertLocalLiveAuthorization,
  assertSafeLocalIgnoredPath,
  assertSafeRemoteValidationWorkspace,
  assertValidationPlan,
  collectPaginatedDriveFiles,
  publicValidationEvidence,
} from './drive-v1-live-validation-gate.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('../web/node_modules/playwright')
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'
const ENTRY_ID = 'entry-live-validation'

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function isTracked(repoRoot, filePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path.relative(repoRoot, filePath)], {
      cwd: repoRoot,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function isIgnored(repoRoot, filePath) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', filePath], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function assertWorkerAuthorization({ plan, planFile, evidenceDir, repoRoot, oauthConfigPath, tokenCachePath }) {
  if (path.resolve(process.env.EASYLAB_DRIVE_V1_LIVE_PLAN_FILE || '') !== path.resolve(planFile)) {
    throw new Error('The worker was not given the exact gated live validation plan.')
  }
  const expectedPlanFile = path.resolve(evidenceDir, 'plan.json')
  if (path.resolve(planFile) !== expectedPlanFile) {
    throw new Error('The worker plan is not in the exact gated evidence directory.')
  }
  const persistedPlan = assertValidationPlan(readJson(planFile, 'Live validation plan'))
  const suppliedPlan = assertValidationPlan(plan)
  if (persistedPlan.planHash !== suppliedPlan.planHash) {
    throw new Error('The worker plan does not match the immutable plan file.')
  }
  const ignoredPathInput = (filePath, label) => assertSafeLocalIgnoredPath({
    repoRoot,
    filePath,
    label,
    isTracked: (value) => isTracked(repoRoot, value),
    isIgnored: (value) => isIgnored(repoRoot, value),
  })
  ignoredPathInput(planFile, 'Live validation plan')
  ignoredPathInput(evidenceDir, 'Live evidence directory')
  ignoredPathInput(oauthConfigPath, 'OAuth configuration')
  ignoredPathInput(tokenCachePath, 'OAuth token cache')
  assertLocalLiveAuthorization({
    plan: suppliedPlan,
    env: process.env,
    repoRoot,
    currentHead: git(repoRoot, ['rev-parse', 'HEAD']),
    gitStatus: git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    oauthConfigPath,
    tokenCachePath,
    evidenceDir,
    trackedPaths: [planFile, evidenceDir, oauthConfigPath, tokenCachePath].filter((value) => isTracked(repoRoot, value)),
  })
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid.`)
  }
}

function readOAuthConfig(configPath) {
  if (!fs.existsSync(configPath)) throw new Error('The ignored Desktop OAuth configuration is missing.')
  const parsed = readJson(configPath, 'Desktop OAuth configuration')
  const section = parsed.installed || parsed
  const clientId = String(section.client_id || section.clientId || '').trim()
  const clientSecret = String(section.client_secret || section.clientSecret || '').trim()
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('The ignored OAuth configuration is not a Google Desktop client.')
  }
  return { clientId, clientSecret }
}

function readRefreshToken(tokenCachePath, clientId) {
  if (!fs.existsSync(tokenCachePath)) {
    throw new Error('The isolated live-validation token cache is missing; manual OAuth consent is required before execution.')
  }
  const parsed = readJson(tokenCachePath, 'Live-validation token cache')
  const cachedClientId = String(parsed.client_id || parsed.clientId || '').trim()
  const refreshToken = String(parsed.refresh_token || parsed.refreshToken || '').trim()
  if (cachedClientId !== clientId || !refreshToken) throw new Error('The isolated token cache does not match this OAuth client.')
  assertDriveFileOnlyScope(parsed.scope)
  return refreshToken
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  if (clientSecret) body.set('client_secret', clientSecret)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.access_token) throw new Error(`OAuth token refresh failed with status ${response.status}.`)
  const accessToken = String(payload.access_token)
  await assertEffectiveDriveFileOnlyAccessToken(accessToken)
  return accessToken
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function makePkce() {
  const verifier = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function createOAuthListener(timeoutMs = 10 * 60 * 1000) {
  let timeout
  let resolveCode
  let rejectCode
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
      if (requestUrl.pathname !== '/oauth2callback') {
        response.writeHead(404)
        response.end('Not found')
        return
      }
      const error = requestUrl.searchParams.get('error')
      const code = requestUrl.searchParams.get('code')
      response.writeHead(error ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(error ? 'Easylab Drive validation authorization failed.' : 'Easylab Drive validation authorization is complete. You may close this tab.')
      clearTimeout(timeout)
      server.close()
      if (error) rejectCode(new Error('Google authorization was declined.'))
      else if (!code) rejectCode(new Error('Google authorization returned no code.'))
      else resolveCode(code)
    } catch {
      clearTimeout(timeout)
      server.close()
      rejectCode(new Error('Google authorization callback was invalid.'))
    }
  })
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      timeout = setTimeout(() => {
        server.close()
        rejectCode(new Error('Timed out waiting for manual OAuth consent.'))
      }, timeoutMs)
      resolve({
        redirectUri: `http://127.0.0.1:${server.address().port}/oauth2callback`,
        codePromise,
      })
    })
  })
  return ready
}

async function exchangeAuthorizationCode({ clientId, clientSecret, code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })
  if (clientSecret) body.set('client_secret', clientSecret)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(`OAuth authorization exchange failed with status ${response.status}.`)
  }
  assertDriveFileOnlyScope(payload.scope)
  await assertEffectiveDriveFileOnlyAccessToken(String(payload.access_token))
  return payload
}

export async function authorizeLiveDriveV1Validation({
  plan,
  planFile,
  evidenceDir,
  repoRoot,
  oauthConfigPath,
  tokenCachePath,
}) {
  assertWorkerAuthorization({ plan, planFile, evidenceDir, repoRoot, oauthConfigPath, tokenCachePath })
  const { clientId, clientSecret } = readOAuthConfig(oauthConfigPath)
  if (fs.existsSync(tokenCachePath)) {
    readRefreshToken(tokenCachePath, clientId)
    console.log(JSON.stringify({
      authorized: true,
      reusedIgnoredTokenCache: true,
      liveDriveMutationMade: false,
      rootFolderName: plan.rootFolderName,
    }, null, 2))
    return
  }
  const authDirectory = path.join(path.dirname(tokenCachePath), 'drive-v1-live-auth', plan.runId)
  const authUrlFile = path.join(authDirectory, 'oauth-url.txt')
  const { verifier, challenge } = makePkce()
  const listener = await createOAuthListener()
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', listener.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', DRIVE_FILE_SCOPE)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('include_granted_scopes', 'false')
  fs.mkdirSync(authDirectory, { recursive: true })
  fs.writeFileSync(authUrlFile, `${authUrl.toString()}\n`, { mode: 0o600 })
  console.log(JSON.stringify({
    waitingForManualOAuthConsent: true,
    oauthUrlFile: authUrlFile,
    requestedScope: DRIVE_FILE_SCOPE,
    liveDriveMutationMade: false,
  }, null, 2))
  const code = await listener.codePromise
  const tokenPayload = await exchangeAuthorizationCode({
    clientId,
    clientSecret,
    code,
    verifier,
    redirectUri: listener.redirectUri,
  })
  writePrivateJson(tokenCachePath, {
    client_id: clientId,
    refresh_token: tokenPayload.refresh_token,
    scope: DRIVE_FILE_SCOPE,
    token_type: tokenPayload.token_type || 'Bearer',
    updated_at: new Date().toISOString(),
  })
  fs.rmSync(authUrlFile, { force: true })
  writePrivateJson(path.join(evidenceDir, 'authorization.json'), publicValidationEvidence({
    plan,
    outcome: 'prepared',
    checks: {
      driveFileOnlyConsentCompleted: true,
      tokenCacheIgnored: true,
      liveDriveMutationMade: false,
    },
    testResults: { oauthAuthorizationPassed: true },
  }))
  console.log(JSON.stringify({
    authorized: true,
    tokenCacheStoredInIgnoredLocalPath: true,
    liveDriveMutationMade: false,
    rootFolderName: plan.rootFolderName,
  }, null, 2))
}

async function driveRequest(accessToken, url, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) throw new Error(`Drive validation request failed with status ${response.status}.`)
  return response
}

function escapeDriveQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function listChildren(accessToken, parentId, extraQuery = '') {
  return collectPaginatedDriveFiles(async (pageToken) => {
    const url = new URL(`${DRIVE_API}/files`)
    const parentQuery = `'${escapeDriveQuery(parentId)}' in parents and trashed = false`
    url.searchParams.set('q', extraQuery ? `${parentQuery} and ${extraQuery}` : parentQuery)
    url.searchParams.set('spaces', 'drive')
    url.searchParams.set('pageSize', '1000')
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,trashed,version,parents,appProperties)')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const response = await driveRequest(accessToken, url.toString())
    const payload = await response.json()
    return { files: payload.files || [], nextPageToken: payload.nextPageToken }
  })
}

async function listValidationRoots(accessToken, folderName) {
  return listChildren(
    accessToken,
    'root',
    `name = '${escapeDriveQuery(folderName)}' and mimeType = '${DRIVE_FOLDER_MIME}'`,
  )
}

async function createFolder(accessToken, name, parentId, runId) {
  const response = await driveRequest(accessToken, `${DRIVE_API}/files?fields=id,name,mimeType,trashed,version,parents,appProperties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      name,
      mimeType: DRIVE_FOLDER_MIME,
      ...(parentId === 'root' ? {} : { parents: [parentId] }),
      appProperties: { [VALIDATION_APP_PROPERTY]: runId },
    }),
  })
  return response.json()
}

async function listManagedInventory(accessToken, rootId) {
  const rootChildren = await listChildren(accessToken, rootId)
  const managedFolders = []
  const managedFiles = []
  async function visit(folderId, prefix) {
    const children = await listChildren(accessToken, folderId)
    for (const child of children) {
      const childPath = prefix ? `${prefix}/${child.name}` : child.name
      if (child.mimeType === DRIVE_FOLDER_MIME) {
        managedFolders.push({ ...child, path: childPath })
        await visit(child.id, childPath)
      } else managedFiles.push({ ...child, path: childPath })
    }
  }
  for (const child of rootChildren) {
    if (child.mimeType === DRIVE_FOLDER_MIME && MANAGED_ROOT_FOLDERS.includes(child.name)) {
      await visit(child.id, child.name)
    } else if (child.mimeType !== DRIVE_FOLDER_MIME) {
      managedFiles.push({ ...child, path: child.name })
    }
  }
  return { rootChildren, managedFolders, managedFiles }
}

async function provisionOrResumeWorkspace({ accessToken, plan, dateBucket, expectedPaths, expectedUnmarkedFiles }) {
  let roots = await listValidationRoots(accessToken, plan.rootFolderName)
  if (roots.length === 0) {
    const root = await createFolder(accessToken, plan.rootFolderName, 'root', plan.runId)
    roots = [root]
  }
  let inventory = await listManagedInventory(accessToken, roots[0].id)
  assertSafeRemoteValidationWorkspace({
    plan,
    rootMatches: roots,
    ...inventory,
    expectedUnmarkedFiles,
    allowedManagedPaths: expectedPaths,
    allowedManagedFolderPaths: [`attachments/${dateBucket}`],
  })

  const childrenByName = new Map(inventory.rootChildren.map((child) => [child.name, child]))
  for (const folder of MANAGED_ROOT_FOLDERS) {
    if (!childrenByName.has(folder)) await createFolder(accessToken, folder, roots[0].id, plan.runId)
  }
  inventory = await listManagedInventory(accessToken, roots[0].id)
  assertSafeRemoteValidationWorkspace({
    plan,
    rootMatches: roots,
    ...inventory,
    expectedUnmarkedFiles,
    allowedManagedPaths: expectedPaths,
    allowedManagedFolderPaths: [`attachments/${dateBucket}`],
  })
  const attachmentRoot = inventory.rootChildren.find(
    (child) => child.name === 'attachments' && child.mimeType === DRIVE_FOLDER_MIME,
  )
  if (!attachmentRoot) throw new Error('Validation provisioning did not produce the attachments folder.')
  if (!inventory.managedFolders.some((folder) => folder.path === `attachments/${dateBucket}`)) {
    await createFolder(accessToken, dateBucket, attachmentRoot.id, plan.runId)
    inventory = await listManagedInventory(accessToken, roots[0].id)
    assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: roots,
      ...inventory,
      expectedUnmarkedFiles,
      allowedManagedPaths: expectedPaths,
      allowedManagedFolderPaths: [`attachments/${dateBucket}`],
    })
  }
  return { root: roots[0], inventory }
}

function nativeEnvironment({ context, accessToken, rootFolderId, phase }) {
  return {
    ...process.env,
    FORCE_COLOR: '0',
    EASYLAB_DRIVE_V1_NATIVE_PHASE: phase,
    EASYLAB_DRIVE_V1_RUN_ID: context.plan.runId,
    EASYLAB_DRIVE_V1_ROOT_FOLDER_NAME: context.plan.rootFolderName,
    EASYLAB_DRIVE_V1_ROOT_FOLDER_ID: rootFolderId,
    EASYLAB_DRIVE_V1_ACCESS_TOKEN: accessToken,
    EASYLAB_DRIVE_V1_DATE_BUCKET: context.dateBucket,
    EASYLAB_DRIVE_V1_TIMESTAMP: context.plan.createdAt,
    EASYLAB_DRIVE_V1_REPO_ROOT: context.repoRoot,
    EASYLAB_DRIVE_V1_PLAN_FILE: context.planFile,
    EASYLAB_DRIVE_V1_PLAN_HASH: context.plan.planHash,
    EASYLAB_DRIVE_V1_SOURCE_COMMIT: context.plan.sourceCommit,
  }
}

function runNativePhase(context, accessToken, rootFolderId, method, phase) {
  execFileSync(
    process.execPath,
    [
      'scripts/android-gradle.mjs',
      '--no-daemon',
      ':app:testDebugUnitTest',
      '--tests',
      `com.easylab.labnotebook.sync.DriveV1LiveValidationHarnessTest.${method}`,
    ],
    {
      cwd: context.repoRoot,
      env: nativeEnvironment({ context, accessToken, rootFolderId, phase }),
      stdio: 'inherit',
    },
  )
}

function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume()
        resolve()
      })
      request.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('Timed out waiting for the validation-only web server.'))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

async function startVite(repoRoot) {
  const port = Number(process.env.EASYLAB_DRIVE_V1_LIVE_PORT || 4197)
  const url = `http://127.0.0.1:${port}`
  const child = spawn('npm', ['--prefix', 'web', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  try {
    await waitForUrl(url)
    return { child, url }
  } catch (error) {
    child.kill('SIGTERM')
    throw new Error(output ? 'The validation-only web server failed to start.' : error.message)
  }
}

async function runBrowserAndElectronPhases({ context, accessToken, rootFolderId, clientId, expectedBlobSha256 }) {
  const vite = await startVite(context.repoRoot)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(vite.url)
    await page.waitForLoadState('domcontentloaded')
    return await page.evaluate(async ({
      accessToken,
      rootFolderId,
      clientId,
      runId,
      folderName,
      dateBucket,
      createdAt,
      expectedBlobSha256,
      validationAppProperty,
      entryId,
    }) => {
      const {
        DriveWriteAmbiguousCommitError,
        DriveWritePreconditionConflictError,
        GoogleDriveProvider,
      } = await import('/src/sync/connectedSync.ts')
      const {
        DriveResumableOperationStore,
        MemoryDriveResumableOperationPersistence,
      } = await import('/src/sync/driveResumableOperations.ts')
      const { GoogleDriveSyncProvider, WritePreconditionError } = await import('/src/sync/syncProvider.ts')
      const { canonicalTombstoneId, safeDriveSegment } = await import('/src/sync/dataCore.ts')

      const electronApi = {
        requestGoogleDriveAccessToken: async () => ({
          accessToken,
          account: {
            provider: 'google',
            email: 'redacted',
            storageScope: `drive-v1-live:${runId}`,
          },
        }),
        disconnectGoogleDrive: async () => undefined,
      }
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronApi })

      const client = new GoogleDriveProvider({
        clientId,
        folderName,
        resumableOperationStore: new DriveResumableOperationStore(
          new MemoryDriveResumableOperationPersistence(),
        ),
        testOnlyStorageScope: `drive-v1-live:${runId}`,
      })
      const provider = new GoogleDriveSyncProvider({
        clientId,
        folderName,
        folderId: rootFolderId,
        client,
        testOnlyEnableVersionedCas: true,
      })
      await provider.signIn()
      await provider.resolveWorkspace()

      const entryPath = `entries/${dateBucket}.json`
      const blobPath = `attachments/${dateBucket}/att-live-validation-native-large.bin`
      const attachmentPath = `${blobPath}.json`
      const entryBefore = await provider.getJson(entryPath)
      const attachmentBefore = await provider.getJson(attachmentPath)
      const manifestBefore = await provider.getJson('manifest.json')
      const originalBlob = await provider.getBlob(blobPath)
      if (!entryBefore || !attachmentBefore || !manifestBefore || !originalBlob) {
        throw new Error('Native validation transaction was not completely readable by the web provider.')
      }
      const sha256Hex = async (blob) => {
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
        return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
      }
      if (await sha256Hex(originalBlob) !== expectedBlobSha256) {
        throw new Error('Web validation read found a native attachment hash mismatch.')
      }
      if (entryBefore.value.futureValidationField !== 'preserve-across-clients') {
        throw new Error('Web validation did not receive the native unknown field.')
      }

      const webTimestamp = new Date(Date.parse(createdAt) + 60_000).toISOString()
      const webEditedEntry = {
        ...entryBefore.value,
        updatedAt: webTimestamp,
        updatedByDeviceId: 'dev-web-live-validation',
        payload: {
          ...entryBefore.value.payload,
          title: 'Web conditional Drive v1 safety edit',
          lastEditedDatetime: webTimestamp,
          updatedByDeviceId: 'dev-web-live-validation',
        },
      }
      const originalFetch = globalThis.fetch.bind(globalThis)
      let lostResponseInjected = false
      globalThis.fetch = async (input, init = {}) => {
        const response = await originalFetch(input, init)
        const url = String(input instanceof Request ? input.url : input)
        if (!lostResponseInjected && String(init.method || 'GET').toUpperCase() === 'PATCH' && url.includes('/upload/drive/v3/files/')) {
          lostResponseInjected = true
          throw new TypeError('validation-only simulated lost response')
        }
        return response
      }
      let editedRef
      try {
        editedRef = await provider.putJson(entryPath, webEditedEntry, {
          precondition: { kind: 'must-match', fileId: entryBefore.id, version: entryBefore.version },
          appProperties: {
            [validationAppProperty]: runId,
            entityType: 'entry',
            entityId: 'entry-live-validation',
          },
        })
      } finally {
        globalThis.fetch = originalFetch
      }
      if (!lostResponseInjected || !editedRef) throw new Error('Lost-response reconciliation was not exercised.')

      const manifestAfterEntry = await provider.getJson('manifest.json')
      if (!manifestAfterEntry) throw new Error('Manifest disappeared before web publication.')
      await provider.putManifest({ ...manifestAfterEntry.value, updatedAt: webTimestamp }, {
        precondition: { kind: 'must-match', fileId: manifestAfterEntry.id, version: manifestAfterEntry.version },
        appProperties: { [validationAppProperty]: runId },
      })

      let staleWriteRejected = false
      try {
        await provider.putJson(entryPath, { ...webEditedEntry, payload: { ...webEditedEntry.payload, title: 'stale overwrite' } }, {
          precondition: { kind: 'must-match', fileId: entryBefore.id, version: entryBefore.version },
          appProperties: { [validationAppProperty]: runId, entityType: 'entry', entityId: 'entry-live-validation' },
        })
      } catch (error) {
        if (error instanceof DriveWritePreconditionConflictError || error instanceof WritePreconditionError) {
          staleWriteRejected = true
        } else {
          throw error
        }
      }
      if (!staleWriteRejected) throw new Error('Drive accepted a stale conditional web update.')

      const listedBeforeBlobUpdate = await provider.listManagedFiles()
      const blobRef = listedBeforeBlobUpdate.find((file) => file.path === blobPath)
      if (!blobRef) throw new Error('Large native attachment identity is missing.')
      const updatedBytes = new Uint8Array(5 * 1024 * 1024 + 257)
      for (let index = 0; index < updatedBytes.length; index += 1) updatedBytes[index] = (index + 7) % 251
      const updatedBlob = new Blob([updatedBytes], { type: 'application/octet-stream' })
      const updatedSha256 = await sha256Hex(updatedBlob)
      const operationId = `web-update-${runId}`
      let interruptionInjected = false
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input instanceof Request ? input.url : input)
        if (!interruptionInjected && String(init.method || 'GET').toUpperCase() === 'PUT' && url.includes('googleapis.com/upload/')) {
          interruptionInjected = true
          throw new TypeError('validation-only simulated interrupted upload')
        }
        return originalFetch(input, init)
      }
      let ambiguousInterruptionObserved = false
      try {
        await provider.putBlob(blobPath, updatedBlob, {
          mimeType: updatedBlob.type,
          sha256: updatedSha256,
          byteSize: updatedBlob.size,
          appProperties: { [validationAppProperty]: runId, entityType: 'attachmentBlob' },
        }, {
          precondition: { kind: 'must-match', fileId: blobRef.id, version: blobRef.version },
          resumableOperationId: operationId,
        })
      } catch (error) {
        if (error instanceof DriveWriteAmbiguousCommitError) {
          ambiguousInterruptionObserved = true
        } else {
          throw error
        }
      } finally {
        globalThis.fetch = originalFetch
      }
      if (!interruptionInjected || !ambiguousInterruptionObserved) {
        throw new Error('Interrupted resumable upload did not fail closed as ambiguous.')
      }
      await provider.putBlob(blobPath, updatedBlob, {
        mimeType: updatedBlob.type,
        sha256: updatedSha256,
        byteSize: updatedBlob.size,
        appProperties: { [validationAppProperty]: runId, entityType: 'attachmentBlob' },
      }, {
        precondition: { kind: 'must-match', fileId: blobRef.id, version: blobRef.version },
        resumableOperationId: operationId,
      })

      const attachmentLatest = await provider.getJson(attachmentPath)
      if (!attachmentLatest) throw new Error('Attachment metadata disappeared during resumable recovery.')
      const attachmentEdited = {
        ...attachmentLatest.value,
        updatedAt: new Date(Date.parse(createdAt) + 120_000).toISOString(),
        updatedByDeviceId: 'dev-web-live-validation',
        payload: {
          ...attachmentLatest.value.payload,
          sha256: updatedSha256,
          bytes: updatedBlob.size,
          filesize: `${updatedBlob.size} bytes`,
          updatedAt: new Date(Date.parse(createdAt) + 120_000).toISOString(),
        },
      }
      await provider.putJson(attachmentPath, attachmentEdited, {
        precondition: { kind: 'must-match', fileId: attachmentLatest.id, version: attachmentLatest.version },
        appProperties: { [validationAppProperty]: runId, entityType: 'attachment', entityId: 'att-live-validation' },
      })
      const manifestAfterBlob = await provider.getJson('manifest.json')
      if (!manifestAfterBlob) throw new Error('Manifest disappeared before resumable publication.')
      await provider.putManifest({
        ...manifestAfterBlob.value,
        updatedAt: new Date(Date.parse(createdAt) + 120_000).toISOString(),
      }, {
        precondition: { kind: 'must-match', fileId: manifestAfterBlob.id, version: manifestAfterBlob.version },
        appProperties: { [validationAppProperty]: runId },
      })

      const downloadedUpdatedBlob = await provider.getBlob(blobPath)
      if (!downloadedUpdatedBlob || await sha256Hex(downloadedUpdatedBlob) !== updatedSha256) {
        throw new Error('Recovered resumable attachment did not verify.')
      }
      const editedEntryRead = await provider.getJson(entryPath)
      if (!editedEntryRead || editedEntryRead.value.futureValidationField !== 'preserve-across-clients') {
        throw new Error('Unknown native fields were not preserved through the web write.')
      }

      const tombstone = {
        id: canonicalTombstoneId('entry', entryId),
        entityKind: 'entry',
        entityId: entryId,
        deletedAt: new Date(Date.parse(createdAt) + 180_000).toISOString(),
        deletedByDeviceId: 'dev-electron-live-validation',
        reason: 'isolated Drive v1 validation',
      }
      const tombstonePath = `tombstones/${safeDriveSegment(tombstone.entityKind, 'entity')}--${safeDriveSegment(tombstone.entityId, 'entity')}.json`
      await provider.putJson(tombstonePath, tombstone, {
        precondition: { kind: 'must-not-exist', operationId: `electron-tombstone-${runId}` },
        appProperties: { [validationAppProperty]: runId, entityType: 'tombstone', entityId: tombstone.entityId },
      })
      const manifestBeforeDelete = await provider.getJson('manifest.json')
      if (!manifestBeforeDelete) throw new Error('Manifest disappeared before Electron tombstone publication.')
      await provider.putManifest({
        ...manifestBeforeDelete.value,
        updatedAt: tombstone.deletedAt,
        entryCount: 0,
        attachmentCount: 0,
        fileBoxCount: 0,
        transferCount: 0,
      }, {
        precondition: { kind: 'must-match', fileId: manifestBeforeDelete.id, version: manifestBeforeDelete.version },
        appProperties: { [validationAppProperty]: runId },
      })
      const finalFiles = await provider.listManagedFiles()
      if (!finalFiles.some((file) => file.path === entryPath) || !finalFiles.some((file) => file.path === blobPath)) {
        throw new Error('Live validation unexpectedly physically deleted stale entity data.')
      }
      return {
        nativePayloadRead: true,
        nativeBlobHashVerified: true,
        webLostResponseReconciled: lostResponseInjected,
        staleVersionRejected: staleWriteRejected,
        resumableInterruptionRecovered: interruptionInjected && ambiguousInterruptionObserved,
        unknownFieldsPreserved: true,
        electronTombstonePublished: true,
        physicalDeletionAvoided: true,
      }
    }, {
      accessToken,
      rootFolderId,
      clientId,
      runId: context.plan.runId,
      folderName: context.plan.rootFolderName,
      dateBucket: context.dateBucket,
      createdAt: context.plan.createdAt,
      expectedBlobSha256,
      validationAppProperty: VALIDATION_APP_PROPERTY,
      entryId: ENTRY_ID,
    })
  } finally {
    await browser.close().catch(() => {})
    vite.child.kill('SIGTERM')
  }
}

export async function runLiveDriveV1Validation({
  plan,
  planFile,
  evidenceDir,
  repoRoot,
  oauthConfigPath,
  tokenCachePath,
}) {
  assertWorkerAuthorization({ plan, planFile, evidenceDir, repoRoot, oauthConfigPath, tokenCachePath })
  const resultFile = path.join(evidenceDir, 'result.json')
  const diagnosticFile = path.join(evidenceDir, 'diagnostic.json')
  const dateBucket = plan.createdAt.slice(0, 10)
  const blobPath = `attachments/${dateBucket}/att-live-validation-native-large.bin`
  const expectedPaths = [
    `entries/${dateBucket}.json`,
    blobPath,
    `${blobPath}.json`,
    'manifest.json',
    'tombstones/entry--entry-live-validation.json',
  ]
  const nativeBytes = Buffer.alloc(5 * 1024 * 1024 + 257)
  for (let index = 0; index < nativeBytes.length; index += 1) nativeBytes[index] = index % 251
  const expectedBlobSha256 = crypto.createHash('sha256').update(nativeBytes).digest('hex')
  const expectedUnmarkedFiles = {
    [`entries/${dateBucket}.json`]: { entityType: 'entry', entityId: ENTRY_ID },
    [blobPath]: { entityType: 'attachmentBlob', sha256: expectedBlobSha256 },
    [`${blobPath}.json`]: { entityType: 'attachment', entityId: 'att-live-validation' },
    'manifest.json': { entityType: 'manifest' },
  }
  const context = {
    plan,
    evidenceDir,
    repoRoot,
    planFile,
    dateBucket,
  }
  try {
    const { clientId, clientSecret } = readOAuthConfig(oauthConfigPath)
    const refreshToken = readRefreshToken(tokenCachePath, clientId)
    const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken })
    const workspace = await provisionOrResumeWorkspace({
      accessToken,
      plan,
      dateBucket,
      expectedPaths,
      expectedUnmarkedFiles,
    })

    if (!workspace.inventory.managedFiles.some((file) => file.path === 'manifest.json')) {
      runNativePhase(
        context,
        accessToken,
        workspace.root.id,
        'nativeWriterPublishesLargeBlobAndManifestLast',
        'native-create',
      )
    }
    const browserChecks = await runBrowserAndElectronPhases({
      context,
      accessToken,
      rootFolderId: workspace.root.id,
      clientId,
      expectedBlobSha256,
    })
    runNativePhase(
      context,
      accessToken,
      workspace.root.id,
      'nativeReadOnlyProjectionVerifiesFinalTombstoneState',
      'native-read-final',
    )

    const finalRoots = await listValidationRoots(accessToken, plan.rootFolderName)
    const finalInventory = await listManagedInventory(accessToken, workspace.root.id)
    assertSafeRemoteValidationWorkspace({
      plan,
      rootMatches: finalRoots,
      ...finalInventory,
      expectedUnmarkedFiles,
      allowedManagedPaths: expectedPaths,
      allowedManagedFolderPaths: [`attachments/${dateBucket}`],
    })
    const actualPaths = finalInventory.managedFiles.map((file) => file.path)
    if (
      actualPaths.length !== expectedPaths.length ||
      actualPaths.length !== new Set(actualPaths).size ||
      expectedPaths.some((expected) => !actualPaths.includes(expected))
    ) {
      throw new Error('Final validation workspace inventory is missing or duplicated.')
    }

    writePrivateJson(resultFile, publicValidationEvidence({
      plan,
      outcome: 'passed',
      checks: {
        isolatedWorkspaceVerified: true,
        nativeManifestLastTransactionPassed: true,
        ...browserChecks,
        nativeReadOnlyNonResurrectionPassed: true,
        manifestCountsMatched: true,
        duplicatePathsAbsent: true,
        productionWritesRemainDisabled: true,
      },
      testResults: { liveDriveV1RoundTripPassed: true },
    }))
    fs.rmSync(diagnosticFile, { force: true })
    console.log(JSON.stringify({
      passed: true,
      rootFolderName: plan.rootFolderName,
      evidenceFile: resultFile,
      validationFolderAutomaticallyDeleted: false,
      productionWritesEnabled: false,
    }, null, 2))
  } catch (error) {
    writePrivateJson(diagnosticFile, {
      version: 1,
      runId: plan.runId,
      failed: true,
      category: error instanceof Error ? error.name : 'Error',
      productionWritesEnabled: false,
      validationFolderAutomaticallyDeleted: false,
    })
    writePrivateJson(resultFile, publicValidationEvidence({
      plan,
      outcome: 'failed',
      checks: { productionWritesRemainDisabled: true },
      testResults: { liveDriveV1RoundTripPassed: false },
    }))
    throw new Error('Live Drive validation stopped safely; inspect the ignored diagnostic category and keep production writes disabled.')
  }
}
