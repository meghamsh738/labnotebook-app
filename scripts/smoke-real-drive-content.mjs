import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(process.env.LABNOTE_REAL_DRIVE_OUTPUT_DIR || path.join(root, '.labnote-smoke', 'real-drive-content'))
const authUrlFile = path.join(outputDir, 'oauth-url.txt')
const resultFile = path.join(outputDir, 'result.json')
const configPath = path.resolve(process.env.LABNOTE_OAUTH_CONFIG_FILE || path.join(root, '.labnote-local', 'oauth.desktop.json'))
const tokenCachePath = path.resolve(process.env.LABNOTE_REAL_DRIVE_TOKEN_FILE || path.join(root, '.labnote-local', 'real-drive-token.json'))
const scope = 'https://www.googleapis.com/auth/drive.file'
const folderName = process.env.LABNOTE_REAL_DRIVE_FOLDER_NAME?.trim() || `Easylab Lab Notebook Real Drive Smoke ${new Date().toISOString().replace(/[:.]/g, '-')}`
const timeoutMs = Number(process.env.LABNOTE_REAL_DRIVE_TIMEOUT_MS || 300000)

function writeResult(payload) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify({ ...payload, writtenAt: new Date().toISOString() }, null, 2))
}

function fail(message, extra = {}) {
  writeResult({ ok: false, message, ...extra })
  console.error(message)
  process.exit(1)
}

function readOAuthConfig() {
  const envClientId = process.env.LABNOTE_DESKTOP_CLIENT_ID?.trim() || ''
  const envClientSecret = process.env.LABNOTE_DESKTOP_CLIENT_SECRET?.trim() || ''
  if (envClientId) return { clientId: envClientId, clientSecret: envClientSecret, source: 'environment' }
  if (!fs.existsSync(configPath)) {
    fail('Desktop OAuth config is missing. Run npm run preflight:drive-oauth first, then keep OAuth JSON under .labnote-local/.', { configPath })
  }
  const tracked = isTracked(configPath)
  if (tracked) fail('OAuth config is tracked by Git. Move it to ignored .labnote-local/ before running real Drive smoke.', { configPath })
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`Could not parse OAuth config: ${error instanceof Error ? error.message : String(error)}`, { configPath })
  }
  const section = parsed.installed || parsed
  return {
    clientId: String(section.client_id || section.clientId || '').trim(),
    clientSecret: String(section.client_secret || section.clientSecret || '').trim(),
    source: 'local-config',
  }
}

function readTokenCache() {
  if (!fs.existsSync(tokenCachePath)) return null
  if (isTracked(tokenCachePath)) fail('Real Drive token cache is tracked by Git. Move it to ignored .labnote-local/ before running real Drive smoke.', { tokenCachePath })
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8').replace(/^\uFEFF/, ''))
    const refreshToken = String(parsed.refresh_token || parsed.refreshToken || '').trim()
    const cachedClientId = String(parsed.client_id || parsed.clientId || '').trim()
    if (!refreshToken) return null
    return {
      refreshToken,
      clientId: cachedClientId,
      scope: String(parsed.scope || '').trim(),
    }
  } catch (error) {
    fail(`Could not parse real Drive token cache: ${error instanceof Error ? error.message : String(error)}`, { tokenCachePath })
  }
}

function writeTokenCache({ clientId, tokenPayload }) {
  const refreshToken = String(tokenPayload.refresh_token || '').trim()
  if (!refreshToken) return false
  fs.mkdirSync(path.dirname(tokenCachePath), { recursive: true })
  fs.writeFileSync(tokenCachePath, JSON.stringify({
    client_id: clientId,
    refresh_token: refreshToken,
    scope: tokenPayload.scope || scope,
    token_type: tokenPayload.token_type || 'Bearer',
    updated_at: new Date().toISOString(),
  }, null, 2))
  return true
}

function isTracked(filePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path.relative(root, filePath)], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makePkce() {
  const verifier = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function createOAuthListener() {
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
      response.writeHead(error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(error ? 'Google authorization failed. You can close this tab.' : 'Google authorization complete. You can close this tab.')
      clearTimeout(timeout)
      server.close()
      if (error) rejectCode(new Error(error))
      else if (!code) rejectCode(new Error('Google callback did not include an authorization code.'))
      else resolveCode({ code })
    } catch (error) {
      clearTimeout(timeout)
      server.close()
      rejectCode(error)
    }
  })

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      timeout = setTimeout(() => {
        server.close()
        rejectCode(new Error(`Timed out waiting for OAuth consent after ${timeoutMs} ms.`))
      }, timeoutMs)
      const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`
      resolve({ server, redirectUri, codePromise })
    })
  })

  return ready
}

async function exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
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
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Token exchange failed with ${response.status}`)
  }
  return payload
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
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Token refresh failed with ${response.status}`)
  }
  return payload
}

async function driveRequest(accessToken, url, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Drive request failed (${response.status}): ${detail || response.statusText}`)
  }
  return response
}

function escapeDriveQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function listFolder(accessToken, parentId, query = '') {
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  const base = `'${escapeDriveQuery(parentId)}' in parents and trashed = false`
  url.searchParams.set('q', query ? `${base} and ${query}` : base)
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size)')
  const response = await driveRequest(accessToken, url.toString())
  return (await response.json()).files || []
}

async function ensureFolder(accessToken, parentId, name) {
  const matches = await listFolder(accessToken, parentId, `name = '${escapeDriveQuery(name)}' and mimeType = 'application/vnd.google-apps.folder'`)
  if (matches[0]?.id) return matches[0].id
  const response = await driveRequest(accessToken, 'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: parentId === 'root' ? undefined : [parentId], mimeType: 'application/vnd.google-apps.folder' }),
  })
  return (await response.json()).id
}

function multipartBody(metadata, body, mimeType) {
  const boundary = `easylab_${crypto.randomUUID()}`
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      Buffer.from(body),
      Buffer.from(`\r\n--${boundary}--`),
    ]),
  }
}

async function uploadFile(accessToken, parentId, name, body, mimeType) {
  const { contentType, body: multipart } = multipartBody({ name, parents: [parentId] }, body, mimeType)
  const response = await driveRequest(accessToken, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: multipart,
  })
  return response.json()
}

async function downloadText(accessToken, fileId) {
  const response = await driveRequest(accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
  return response.text()
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  for (const child of ['oauth-url.txt', 'result.json']) fs.rmSync(path.join(outputDir, child), { force: true })

  const { clientId, clientSecret, source } = readOAuthConfig()
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) fail('Desktop OAuth client ID is invalid.', { source })
  if (!clientSecret) fail('Desktop OAuth client secret is required for this real Drive smoke.', { source })

  let accessToken = ''
  let authMode = ''
  let tokenCacheReused = false
  const cached = readTokenCache()
  if (cached?.refreshToken && (!cached.clientId || cached.clientId === clientId)) {
    try {
      const refreshed = await refreshAccessToken({ clientId, clientSecret, refreshToken: cached.refreshToken })
      accessToken = String(refreshed.access_token)
      authMode = 'cached-refresh-token'
      tokenCacheReused = true
      writeResult({ ok: null, stage: 'using-cached-refresh-token', folderName, tokenCachePath })
    } catch (error) {
      writeResult({
        ok: null,
        stage: 'cached-refresh-token-failed',
        folderName,
        tokenCachePath,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (!accessToken) {
    const { verifier, challenge } = makePkce()
    const listener = await createOAuthListener()
    const redirectUri = listener.redirectUri
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', scope)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    fs.writeFileSync(authUrlFile, authUrl.toString())
    writeResult({ ok: null, stage: 'waiting-for-consent', authUrlFile, folderName, tokenCachePath })

    const codeResult = await listener.codePromise
    const tokenPayload = await exchangeCode({ clientId, clientSecret, code: codeResult.code, codeVerifier: verifier, redirectUri })
    accessToken = String(tokenPayload.access_token)
    authMode = 'interactive-consent'
    writeTokenCache({ clientId, tokenPayload })
  }

  const rootFolderId = await ensureFolder(accessToken, 'root', folderName)
  const devicesFolderId = await ensureFolder(accessToken, rootFolderId, 'devices')
  const entriesFolderId = await ensureFolder(accessToken, rootFolderId, 'entries')
  const attachmentsFolderId = await ensureFolder(accessToken, rootFolderId, 'attachments')
  const dateFolderId = await ensureFolder(accessToken, attachmentsFolderId, '2026-05-24')
  const fileBoxFolderId = await ensureFolder(accessToken, rootFolderId, 'filebox')
  const transfersFolderId = await ensureFolder(accessToken, rootFolderId, 'transfers')
  await ensureFolder(accessToken, rootFolderId, 'tombstones')

  const device = {
    id: 'dev-real-drive-desktop',
    name: 'Real Drive Smoke Desktop',
    platform: 'desktop',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }
  const entry = {
    id: 'entry-2026-05-24',
    dateBucket: '2026-05-24',
    title: 'Real Drive smoke entry',
    content: [{ id: 'block-1', type: 'paragraph', text: 'Real Drive smoke note created by packaged OAuth validation.' }],
    tags: ['smoke', 'drive'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedByDeviceId: device.id,
    version: 1,
  }
  const attachmentBody = Buffer.from('pixel camera smoke bytes')
  const attachment = {
    id: 'att-real-drive-camera',
    entryId: entry.id,
    filename: 'pixel-camera-smoke.jpg',
    type: 'image',
    mimeType: 'image/jpeg',
    size: attachmentBody.length,
    sha256: crypto.createHash('sha256').update(attachmentBody).digest('hex'),
    storagePath: 'attachments/2026-05-24/att-real-drive-camera-pixel-camera-smoke.jpg',
    syncStatus: 'remote',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const fileBox = {
    id: 'fb-real-drive-camera',
    entryId: entry.id,
    attachmentId: attachment.id,
    filename: attachment.filename,
    filesize: `${attachment.size} B`,
    contentType: attachment.mimeType,
    sourceDeviceId: 'pixel-7a-smoke',
    sourceDeviceName: 'Pixel 7a',
    status: 'available',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const transfer = {
    id: 'tr-real-drive-camera',
    fileBoxItemId: fileBox.id,
    entryId: entry.id,
    attachmentId: attachment.id,
    filename: attachment.filename,
    fromDeviceId: 'pixel-7a-smoke',
    fromDeviceName: 'Pixel 7a',
    provider: 'google-drive',
    status: 'available',
    bytesTotal: attachment.size,
    bytesTransferred: attachment.size,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  }
  const manifest = {
    version: 1,
    provider: 'google-drive',
    rootFolderName: folderName,
    updatedAt: new Date().toISOString(),
    devices: [device],
    entryCount: 1,
    attachmentCount: 1,
    fileBoxCount: 1,
    transferCount: 1,
  }

  const uploaded = {
    manifest: await uploadFile(accessToken, rootFolderId, 'manifest.json', JSON.stringify(manifest, null, 2), 'application/json'),
    device: await uploadFile(accessToken, devicesFolderId, `${device.id}.json`, JSON.stringify(device, null, 2), 'application/json'),
    entry: await uploadFile(accessToken, entriesFolderId, '2026-05-24.json', JSON.stringify(entry, null, 2), 'application/json'),
    attachmentMetadata: await uploadFile(accessToken, dateFolderId, 'att-real-drive-camera-pixel-camera-smoke.jpg.json', JSON.stringify(attachment, null, 2), 'application/json'),
    attachmentBlob: await uploadFile(accessToken, dateFolderId, 'att-real-drive-camera-pixel-camera-smoke.jpg', attachmentBody, attachment.mimeType),
    fileBox: await uploadFile(accessToken, fileBoxFolderId, `${fileBox.id}.json`, JSON.stringify(fileBox, null, 2), 'application/json'),
    transfer: await uploadFile(accessToken, transfersFolderId, `${transfer.id}.json`, JSON.stringify(transfer, null, 2), 'application/json'),
  }

  const metadataBeforeBlobDownload = await listFolder(accessToken, dateFolderId)
  const downloadedAttachmentMetadata = JSON.parse(await downloadText(accessToken, uploaded.attachmentMetadata.id))
  const downloadedBlob = await downloadText(accessToken, uploaded.attachmentBlob.id)
  const remotePaths = [
    'manifest.json',
    `devices/${device.id}.json`,
    'entries/2026-05-24.json',
    'attachments/2026-05-24/att-real-drive-camera-pixel-camera-smoke.jpg.json',
    'attachments/2026-05-24/att-real-drive-camera-pixel-camera-smoke.jpg',
    `filebox/${fileBox.id}.json`,
    `transfers/${transfer.id}.json`,
  ]

  if (downloadedAttachmentMetadata.entryId !== entry.id) throw new Error('Downloaded attachment metadata does not point to the daily entry.')
  if (downloadedBlob !== attachmentBody.toString('utf8')) throw new Error('Downloaded attachment blob did not match uploaded content.')

  writeResult({
    ok: true,
    stage: 'passed',
    message: 'Real Google Drive content smoke passed with daily entry, metadata-first attachment listing, and explicit on-demand blob download.',
    folderName,
    folderId: rootFolderId,
    remotePaths,
    metadataListedBeforeBlobDownload: metadataBeforeBlobDownload.some((file) => file.name.endsWith('.json')),
    blobDownloadedOnDemand: true,
    authMode,
    tokenCacheReused,
  })
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
