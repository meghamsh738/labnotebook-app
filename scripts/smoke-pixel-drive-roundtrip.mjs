import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(process.env.LABNOTE_PIXEL_DRIVE_OUTPUT_DIR || path.join(root, '.labnote-smoke', 'pixel-drive-roundtrip'))
const resultFile = path.join(outputDir, 'result.json')
const captureResultPath = path.resolve(
  process.env.LABNOTE_PIXEL_CAPTURE_RESULT ||
    path.join(root, '.labnote-device-smoke', 'pixel-capture', 'result.json')
)
const configPath = path.resolve(process.env.LABNOTE_OAUTH_CONFIG_FILE || path.join(root, '.labnote-local', 'oauth.desktop.json'))
const tokenCachePath = path.resolve(process.env.LABNOTE_REAL_DRIVE_TOKEN_FILE || path.join(root, '.labnote-local', 'real-drive-token.json'))
const folderName =
  process.env.LABNOTE_PIXEL_DRIVE_FOLDER_NAME?.trim() ||
  `Easylab Lab Notebook Pixel Drive Roundtrip ${new Date().toISOString().replace(/[:.]/g, '-')}`

function writeResult(payload) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify({ ...payload, writtenAt: new Date().toISOString() }, null, 2))
}

function fail(message, extra = {}) {
  writeResult({ ok: false, message, ...extra })
  console.error(message)
  process.exit(1)
}

function isTracked(filePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path.relative(root, filePath)], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`, { filePath })
  }
}

function readOAuthConfig() {
  const envClientId = process.env.LABNOTE_DESKTOP_CLIENT_ID?.trim() || ''
  const envClientSecret = process.env.LABNOTE_DESKTOP_CLIENT_SECRET?.trim() || ''
  if (envClientId) return { clientId: envClientId, clientSecret: envClientSecret, source: 'environment' }
  if (!fs.existsSync(configPath)) fail('Desktop OAuth config is missing.', { configPath })
  if (isTracked(configPath)) fail('OAuth config is tracked by Git. Move it to ignored .labnote-local/.', { configPath })
  const parsed = readJsonFile(configPath, 'OAuth config')
  const section = parsed.installed || parsed.web || parsed
  return {
    clientId: String(section.client_id || section.clientId || '').trim(),
    clientSecret: String(section.client_secret || section.clientSecret || '').trim(),
    source: 'local-config',
  }
}

function readTokenCache(clientId) {
  if (!fs.existsSync(tokenCachePath)) {
    fail('Real Drive token cache is missing. Run npm run smoke:real-drive-content once and complete Google consent.', { tokenCachePath })
  }
  if (isTracked(tokenCachePath)) fail('Real Drive token cache is tracked by Git. Move it to ignored .labnote-local/.', { tokenCachePath })
  const parsed = readJsonFile(tokenCachePath, 'real Drive token cache')
  const cachedClientId = String(parsed.client_id || parsed.clientId || '').trim()
  const refreshToken = String(parsed.refresh_token || parsed.refreshToken || '').trim()
  if (cachedClientId && cachedClientId !== clientId) fail('Real Drive token cache belongs to a different OAuth client.', { tokenCachePath })
  if (!refreshToken) fail('Real Drive token cache does not contain a refresh token.', { tokenCachePath })
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
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Token refresh failed with ${response.status}`)
  }
  return String(payload.access_token)
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
  const matches = await listFolder(
    accessToken,
    parentId,
    `name = '${escapeDriveQuery(name)}' and mimeType = 'application/vnd.google-apps.folder'`
  )
  if (matches[0]?.id) return matches[0].id
  const response = await driveRequest(accessToken, 'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      parents: parentId === 'root' ? undefined : [parentId],
      mimeType: 'application/vnd.google-apps.folder',
    }),
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

async function downloadBytes(accessToken, fileId) {
  const response = await driveRequest(accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.rmSync(resultFile, { force: true })

  if (!fs.existsSync(captureResultPath)) fail('Pixel capture smoke result is missing. Run npm run smoke:pixel-capture first.', { captureResultPath })
  const capture = readJsonFile(captureResultPath, 'Pixel capture smoke result')
  if (capture.ok !== true) fail('Pixel capture smoke result was not successful.', { captureResultPath, captureOk: capture.ok })

  const uploadPath = path.resolve(capture.uploadFile || '')
  if (!uploadPath || !fs.existsSync(uploadPath)) fail('Pixel capture upload file is missing.', { uploadPath })

  const captureState = capture.captureState || {}
  const attachment = captureState.attachment
  const entry = captureState.entry
  const fileBoxItem = captureState.fileBoxItem
  const transfer = captureState.transfer
  if (!attachment?.id || !attachment?.entryId || !attachment?.filename) fail('Pixel capture attachment metadata is incomplete.', { captureState })
  if (!entry?.id || !entry?.dateBucket || entry.isDaily !== true) fail('Pixel capture did not resolve to a daily entry.', { entry })
  if (!fileBoxItem?.id || !transfer?.id) fail('Pixel capture File Box or transfer metadata is incomplete.', { fileBoxItem, transfer })

  const blob = fs.readFileSync(uploadPath)
  const actualSha256 = crypto.createHash('sha256').update(blob).digest('hex')
  if (attachment.sha256 && actualSha256 !== attachment.sha256) {
    fail('Pixel capture blob hash does not match captured attachment metadata.', { expected: attachment.sha256, actual: actualSha256 })
  }

  const { clientId, clientSecret } = readOAuthConfig()
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) fail('Desktop OAuth client ID is invalid.')
  const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken: readTokenCache(clientId) })
  const authMode = 'cached-refresh-token'

  const rootFolderId = await ensureFolder(accessToken, 'root', folderName)
  const devicesFolderId = await ensureFolder(accessToken, rootFolderId, 'devices')
  const entriesFolderId = await ensureFolder(accessToken, rootFolderId, 'entries')
  const attachmentsFolderId = await ensureFolder(accessToken, rootFolderId, 'attachments')
  const dateFolderId = await ensureFolder(accessToken, attachmentsFolderId, entry.dateBucket)
  const fileBoxFolderId = await ensureFolder(accessToken, rootFolderId, 'filebox')
  const transfersFolderId = await ensureFolder(accessToken, rootFolderId, 'transfers')
  await ensureFolder(accessToken, rootFolderId, 'tombstones')

  const device = {
    id: 'pixel-7a-pwa-smoke',
    name: fileBoxItem.sourceDeviceName || 'Pixel 7a PWA',
    platform: 'mobile',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }
  const entryEnvelope = {
    ...entry,
    source: 'pixel-pwa-capture-smoke',
    updatedByDeviceId: device.id,
    updatedAt: new Date().toISOString(),
  }
  const attachmentMetadata = {
    ...attachment,
    source: 'pixel-pwa-capture-smoke',
    bytes: blob.length,
    mimeType: 'image/png',
    contentType: 'image/png',
    sha256: actualSha256,
    drivePath: `attachments/${entry.dateBucket}/${attachment.id}-${attachment.filename}`,
    syncStatus: 'remote-available',
    updatedAt: new Date().toISOString(),
  }
  const fileBoxEnvelope = {
    ...fileBoxItem,
    sourceDeviceId: device.id,
    sourceDeviceName: device.name,
    status: 'available',
    updatedAt: new Date().toISOString(),
  }
  const transferEnvelope = {
    ...transfer,
    fromDeviceId: device.id,
    fromDeviceName: device.name,
    status: 'available',
    bytesTotal: blob.length,
    bytesTransferred: blob.length,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const manifest = {
    version: 1,
    provider: 'google-drive',
    rootFolderName: folderName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    devices: [device],
    entryCount: 1,
    attachmentCount: 1,
    fileBoxCount: 1,
    transferCount: 1,
    source: 'pixel-pwa-capture-smoke',
  }

  const attachmentBaseName = `${attachment.id}-${attachment.filename}`
  const uploaded = {
    manifest: await uploadFile(accessToken, rootFolderId, 'manifest.json', JSON.stringify(manifest, null, 2), 'application/json'),
    device: await uploadFile(accessToken, devicesFolderId, `${device.id}.json`, JSON.stringify(device, null, 2), 'application/json'),
    entry: await uploadFile(accessToken, entriesFolderId, `${entry.dateBucket}.json`, JSON.stringify(entryEnvelope, null, 2), 'application/json'),
    attachmentMetadata: await uploadFile(accessToken, dateFolderId, `${attachmentBaseName}.json`, JSON.stringify(attachmentMetadata, null, 2), 'application/json'),
    attachmentBlob: await uploadFile(accessToken, dateFolderId, attachmentBaseName, blob, attachmentMetadata.mimeType),
    fileBox: await uploadFile(accessToken, fileBoxFolderId, `${fileBoxItem.id}.json`, JSON.stringify(fileBoxEnvelope, null, 2), 'application/json'),
    transfer: await uploadFile(accessToken, transfersFolderId, `${transfer.id}.json`, JSON.stringify(transferEnvelope, null, 2), 'application/json'),
  }

  const remoteAttachmentFiles = await listFolder(accessToken, dateFolderId)
  const metadataListedBeforeBlobDownload = remoteAttachmentFiles.some((file) => file.name === `${attachmentBaseName}.json`)
  const blobListedBeforeDownload = remoteAttachmentFiles.some((file) => file.name === attachmentBaseName)
  const downloadedMetadata = JSON.parse((await downloadBytes(accessToken, uploaded.attachmentMetadata.id)).toString('utf8'))
  const downloadedBlob = await downloadBytes(accessToken, uploaded.attachmentBlob.id)
  const downloadedSha256 = crypto.createHash('sha256').update(downloadedBlob).digest('hex')

  if (downloadedMetadata.entryId !== attachment.entryId) fail('Downloaded Drive metadata does not point to the Pixel daily entry.', { downloadedMetadata })
  if (downloadedSha256 !== actualSha256) fail('Downloaded Drive blob hash does not match Pixel capture blob.', { actualSha256, downloadedSha256 })

  const remotePaths = [
    'manifest.json',
    `devices/${device.id}.json`,
    `entries/${entry.dateBucket}.json`,
    `attachments/${entry.dateBucket}/${attachmentBaseName}.json`,
    `attachments/${entry.dateBucket}/${attachmentBaseName}`,
    `filebox/${fileBoxItem.id}.json`,
    `transfers/${transfer.id}.json`,
  ]

  writeResult({
    ok: true,
    stage: 'passed',
    message: 'Pixel PWA capture to real Google Drive roundtrip passed with metadata-first listing and on-demand blob download.',
    folderName,
    folderId: rootFolderId,
    pixelCaptureResult: captureResultPath,
    pixelUploadFile: uploadPath,
    entry: entryEnvelope,
    attachment: {
      id: attachment.id,
      entryId: attachment.entryId,
      filename: attachment.filename,
      sha256: actualSha256,
      bytes: blob.length,
    },
    remotePaths,
    metadataListedBeforeBlobDownload,
    blobListedBeforeDownload,
    blobDownloadedOnDemand: true,
    authMode,
    tokenCacheReused: true,
  })
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
