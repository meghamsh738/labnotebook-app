import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('../web/node_modules/playwright')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(process.env.LABNOTE_REAL_DRIVE_SYNC_OUTPUT_DIR || path.join(root, '.labnote-smoke', 'real-drive-sync-loop'))
const resultFile = path.join(outputDir, 'result.json')
const configPath = path.resolve(process.env.LABNOTE_OAUTH_CONFIG_FILE || path.join(root, '.labnote-local', 'oauth.desktop.json'))
const tokenCachePath = path.resolve(process.env.LABNOTE_REAL_DRIVE_TOKEN_FILE || path.join(root, '.labnote-local', 'real-drive-token.json'))
const folderName = process.env.LABNOTE_REAL_DRIVE_SYNC_FOLDER_NAME?.trim() || `Easylab Lab Notebook Real Sync Loop ${new Date().toISOString().replace(/[:.]/g, '-')}`
const port = Number(process.env.LABNOTE_REAL_DRIVE_SYNC_PORT || 4181)
const baseUrl = `http://127.0.0.1:${port}`
const scope = 'https://www.googleapis.com/auth/drive.file'

function writeResult(payload) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify({ ...payload, writtenAt: new Date().toISOString() }, null, 2))
}

function fail(message, extra = {}) {
  writeResult({ ok: false, message, ...extra })
  console.error(message)
  process.exit(1)
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`, { filePath })
  }
}

function readOAuthConfig() {
  if (!fs.existsSync(configPath)) fail('Desktop OAuth config is missing.', { configPath })
  const parsed = readJson(configPath, 'OAuth config')
  const section = parsed.installed || parsed
  return {
    clientId: String(section.client_id || section.clientId || '').trim(),
    clientSecret: String(section.client_secret || section.clientSecret || '').trim(),
  }
}

function readRefreshToken(clientId) {
  if (!fs.existsSync(tokenCachePath)) fail('Real Drive token cache is missing.', { tokenCachePath })
  const parsed = readJson(tokenCachePath, 'real Drive token cache')
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

function waitForUrl(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume()
        resolve()
      })
      request.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`))
        else setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

async function startVite() {
  const child = spawn('npm', ['--prefix', 'web', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  try {
    await waitForUrl(baseUrl)
    return { child, output: () => output }
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.rmSync(resultFile, { force: true })
  const { clientId, clientSecret } = readOAuthConfig()
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) fail('Desktop OAuth client ID is invalid.')
  const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken: readRefreshToken(clientId) })
  writeResult({ ok: null, stage: 'access-token-refreshed', folderName })

  const vite = await startVite()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    const result = await page.evaluate(async ({ accessToken, folderName }) => {
      const { DRIVE_MIME_FOLDER } = await import('/src/sync/connectedSync.ts')
      const { GoogleDriveSyncProvider } = await import('/src/sync/syncProvider.ts')
      const { createJournalRepositories } = await import('/src/sync/repositories.ts')
      const { IndexedDbBlobStore } = await import('/src/sync/blobStore.ts')
      const { createIndexedDbJournalStore, syncOnce, downloadAttachmentBlob } = await import('/src/sync/syncEngine.ts')

      const nowIso = () => new Date().toISOString()
      const escapeDriveQuery = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const pathSegments = (value) => value.split('/').map((segment) => segment.trim()).filter(Boolean)

      class TokenFolderDriveClient {
        kind = 'google-drive'
        signedIn = false
        constructor(token, rootFolderName) {
          this.token = token
          this.rootFolderName = rootFolderName
        }
        async signIn() {
          this.signedIn = true
        }
        logout() {
          this.signedIn = false
        }
        async ensureRootFolder() {
          this.requireSignIn()
          const existing = await this.listFolder('root', `name = '${escapeDriveQuery(this.rootFolderName)}' and mimeType = '${DRIVE_MIME_FOLDER}'`)
          if (existing[0]?.id) return existing[0].id
          const created = await this.requestJson('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: this.rootFolderName, mimeType: DRIVE_MIME_FOLDER }),
          })
          return created.id
        }
        async ensureFolder(parentFolderId, name) {
          this.requireSignIn()
          const existing = await this.listFolder(parentFolderId, `name = '${escapeDriveQuery(name)}' and mimeType = '${DRIVE_MIME_FOLDER}'`)
          if (existing[0]?.id) return existing[0].id
          const created = await this.requestJson('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, parents: [parentFolderId], mimeType: DRIVE_MIME_FOLDER }),
          })
          return created.id
        }
        async uploadJson(parentFolderId, name, data) {
          return this.upsertFile(parentFolderId, name, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
        }
        async uploadBlob(parentFolderId, name, blob, mimeType) {
          const nextBlob = mimeType && blob.type !== mimeType ? blob.slice(0, blob.size, mimeType) : blob
          return this.upsertFile(parentFolderId, name, nextBlob)
        }
        async downloadJson(fileId) {
          return this.requestJson(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
        }
        async downloadBlob(fileId) {
          return (await this.requestRaw(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)).blob()
        }
        async listFolder(parentFolderId, query = '') {
          this.requireSignIn()
          const url = new URL('https://www.googleapis.com/drive/v3/files')
          const base = `'${escapeDriveQuery(parentFolderId)}' in parents and trashed = false`
          url.searchParams.set('q', query ? `${base} and ${query}` : base)
          url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size)')
          const payload = await this.requestJson(url.toString())
          return payload.files || []
        }
        async upsertFile(parentFolderId, name, blob) {
          this.requireSignIn()
          const existing = await this.listFolder(parentFolderId, `name = '${escapeDriveQuery(name)}' and mimeType != '${DRIVE_MIME_FOLDER}'`)
          const existingId = existing[0]?.id
          const boundary = `easylab_${crypto.randomUUID()}`
          const metadata = existingId ? { name } : { name, parents: [parentFolderId] }
          const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
            `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
            blob,
            `\r\n--${boundary}--`,
          ], { type: `multipart/related; boundary=${boundary}` })
          const url = existingId
            ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id`
            : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id'
          const uploaded = await this.requestJson(url, { method: existingId ? 'PATCH' : 'POST', body })
          return uploaded.id
        }
        async requestJson(url, init = {}) {
          const response = await this.requestRaw(url, init)
          return response.json()
        }
        async requestRaw(url, init = {}) {
          this.requireSignIn()
          const headers = new Headers(init.headers)
          headers.set('Authorization', `Bearer ${this.token}`)
          const response = await fetch(url, { ...init, headers })
          if (!response.ok) {
            const detail = await response.text().catch(() => '')
            throw new Error(`Drive request failed (${response.status}): ${detail || response.statusText}`)
          }
          return response
        }
        requireSignIn() {
          if (!this.signedIn) throw new Error('Token Drive client is not signed in.')
        }
      }

      const dbSuffix = crypto.randomUUID()
      const desktopDevice = {
        id: 'dev-real-loop-desktop',
        name: 'Desktop real Drive loop',
        platform: 'desktop',
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
      }
      const mobileDevice = {
        id: 'dev-real-loop-mobile',
        name: 'Android emulator PWA real Drive loop',
        platform: 'mobile',
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
      }
      const desktopEntry = {
        id: `entry-real-loop-${dbSuffix}`,
        authorId: 'user-1',
        title: 'Real Drive desktop-mobile loop',
        dateBucket: '2026-05-31',
        isDaily: true,
        createdDatetime: nowIso(),
        lastEditedDatetime: nowIso(),
        content: [{ id: 'desktop-block', type: 'paragraph', text: 'desktop seeded note over real Drive' }],
        tags: ['real-drive'],
        searchTerms: ['real', 'drive', 'desktop', 'mobile'],
        linkedFiles: [],
        pinnedRegions: [],
        updatedByDeviceId: desktopDevice.id,
      }

      const desktopStore = await createIndexedDbJournalStore(
        desktopDevice,
        await createJournalRepositories({ dbName: `real-drive-loop-desktop-${dbSuffix}` })
      )
      const mobileStore = await createIndexedDbJournalStore(
        mobileDevice,
        await createJournalRepositories({ dbName: `real-drive-loop-mobile-${dbSuffix}` })
      )
      const desktopBlobs = new IndexedDbBlobStore(await createJournalRepositories({ dbName: `real-drive-loop-desktop-blobs-${dbSuffix}` }))
      const mobileBlobs = new IndexedDbBlobStore(await createJournalRepositories({ dbName: `real-drive-loop-mobile-blobs-${dbSuffix}` }))
      const makeProvider = () => new GoogleDriveSyncProvider({
        clientId: 'token-cache',
        folderName,
        client: new TokenFolderDriveClient(accessToken, folderName),
      })

      await desktopStore.saveSnapshot({
        entries: { [desktopEntry.id]: desktopEntry },
        attachments: [],
        fileBoxItems: [],
        transfers: [],
        conflicts: [],
        tombstones: [],
        device: desktopDevice,
      })

      const desktopInitialPush = await syncOnce({
        provider: makeProvider(),
        store: desktopStore,
        device: desktopDevice,
        blobStore: desktopBlobs,
        downloadRemoteBlobs: false,
      })
      const mobileInitialPull = await syncOnce({
        provider: makeProvider(),
        store: mobileStore,
        device: mobileDevice,
        blobStore: mobileBlobs,
        downloadRemoteBlobs: false,
      })

      const mobileSnapshot = await mobileStore.getSnapshot()
      const captureBlob = await mobileBlobs.put('cache-real-mobile-camera', new Blob(['real drive emulator camera bytes'], { type: 'image/jpeg' }))
      const capturedAttachment = {
        id: `att-real-loop-camera-${dbSuffix}`,
        entryId: desktopEntry.id,
        type: 'image',
        filename: 'emulator-camera.jpg',
        filesize: '1 KB',
        bytes: captureBlob.size,
        storagePath: `attachments/2026-05-31/att-real-loop-camera-${dbSuffix}-emulator-camera.jpg`,
        cachedPath: 'idb://cache-real-mobile-camera',
        cacheKey: 'cache-real-mobile-camera',
        contentType: captureBlob.mimeType,
        mimeType: captureBlob.mimeType,
        sha256: captureBlob.sha256,
        syncStatus: 'queued',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      mobileSnapshot.entries[desktopEntry.id] = {
        ...mobileSnapshot.entries[desktopEntry.id],
        linkedFiles: [capturedAttachment.id],
        lastEditedDatetime: nowIso(),
        updatedByDeviceId: mobileDevice.id,
      }
      mobileSnapshot.attachments.push(capturedAttachment)
      mobileSnapshot.fileBoxItems.push({
        id: `fb-real-loop-camera-${dbSuffix}`,
        entryId: desktopEntry.id,
        attachmentId: capturedAttachment.id,
        filename: capturedAttachment.filename,
        filesize: capturedAttachment.filesize,
        contentType: capturedAttachment.contentType,
        sourceDeviceId: mobileDevice.id,
        sourceDeviceName: mobileDevice.name,
        status: 'available',
        createdAt: capturedAttachment.createdAt,
        updatedAt: capturedAttachment.updatedAt,
      })
      mobileSnapshot.transfers.push({
        id: `tr-real-loop-camera-${dbSuffix}`,
        fileBoxItemId: `fb-real-loop-camera-${dbSuffix}`,
        entryId: desktopEntry.id,
        attachmentId: capturedAttachment.id,
        filename: capturedAttachment.filename,
        fromDeviceId: mobileDevice.id,
        fromDeviceName: mobileDevice.name,
        provider: 'google-drive',
        status: 'available',
        bytesTotal: captureBlob.size,
        createdAt: capturedAttachment.createdAt,
        updatedAt: capturedAttachment.updatedAt,
      })
      await mobileStore.saveSnapshot(mobileSnapshot)

      const mobileCapturePush = await syncOnce({
        provider: makeProvider(),
        store: mobileStore,
        device: mobileDevice,
        blobStore: mobileBlobs,
        downloadRemoteBlobs: false,
      })
      const desktopMetadataPull = await syncOnce({
        provider: makeProvider(),
        store: desktopStore,
        device: desktopDevice,
        blobStore: desktopBlobs,
        downloadRemoteBlobs: false,
      })
      const desktopAfterMetadata = await desktopStore.getSnapshot()
      const remoteOnlyAttachment = desktopAfterMetadata.attachments.find((attachment) => attachment.id === capturedAttachment.id)
      if (!remoteOnlyAttachment) throw new Error('Desktop did not receive mobile attachment metadata from real Drive.')
      const desktopBlobBeforeOpen = await desktopBlobs.get('cache-real-mobile-camera')
      const downloadProvider = makeProvider()
      await downloadProvider.signIn()
      await downloadProvider.ensureWorkspace()
      const explicitDownload = await downloadAttachmentBlob({
        attachment: remoteOnlyAttachment,
        entries: desktopAfterMetadata.entries,
        provider: downloadProvider,
        blobStore: desktopBlobs,
      })
      const desktopBlobAfterOpen = explicitDownload.attachment.cacheKey ? await desktopBlobs.get(explicitDownload.attachment.cacheKey) : null
      const listingProvider = makeProvider()
      await listingProvider.signIn()
      const remotePaths = (await listingProvider.listManagedFiles()).map((file) => file.path).sort()
      return {
        folderName,
        desktopInitialPush,
        mobileInitialPull,
        mobileCapturePush,
        desktopMetadataPull,
        desktopEntryTitleOnMobile: mobileSnapshot.entries[desktopEntry.id]?.title,
        desktopAttachmentStatusBeforeDownload: remoteOnlyAttachment.syncStatus,
        desktopAttachmentHasCacheBeforeDownload: Boolean(remoteOnlyAttachment.cacheKey),
        desktopBlobBeforeOpen: await desktopBlobBeforeOpen?.text(),
        explicitDownload,
        desktopBlobAfterOpen: await desktopBlobAfterOpen?.text(),
        remotePaths,
        fileBoxCount: desktopAfterMetadata.fileBoxItems.length,
        transferCount: desktopAfterMetadata.transfers.length,
        conflictCount: desktopAfterMetadata.conflicts.length,
        expectedBlobText: 'real drive emulator camera bytes',
      }
    }, { accessToken, folderName })

    if (result.desktopInitialPush.pushedEntries !== 1) throw new Error('Desktop entry was not pushed to real Drive.')
    if (result.mobileInitialPull.pulledEntries !== 1) throw new Error('Mobile profile did not pull desktop entry from real Drive.')
    if (result.mobileCapturePush.uploadedBlobs !== 1 || result.mobileCapturePush.pushedAttachments !== 1) {
      throw new Error('Mobile capture attachment was not pushed to real Drive.')
    }
    if (result.desktopMetadataPull.pulledAttachments !== 1 || result.desktopMetadataPull.downloadedBlobs !== 0) {
      throw new Error('Desktop did not pull mobile metadata without downloading blob.')
    }
    if (result.desktopAttachmentStatusBeforeDownload !== 'remote-available') throw new Error('Desktop attachment was not remote-available before open.')
    if (result.desktopAttachmentHasCacheBeforeDownload) throw new Error('Desktop had blob cached before explicit download.')
    if (result.desktopBlobBeforeOpen) throw new Error('Desktop blob existed before explicit download.')
    if (!result.explicitDownload.downloaded) throw new Error('Desktop explicit blob download did not run.')
    if (result.desktopBlobAfterOpen !== result.expectedBlobText) throw new Error('Desktop downloaded blob content did not match mobile capture.')

    writeResult({
      ok: true,
      stage: 'passed',
      message: 'Real Google Drive desktop-mobile-desktop sync loop passed with metadata-first attachment pull and on-demand blob download.',
      folderName,
      remotePaths: result.remotePaths,
      counts: {
        desktopInitialPush: result.desktopInitialPush,
        mobileInitialPull: result.mobileInitialPull,
        mobileCapturePush: result.mobileCapturePush,
        desktopMetadataPull: result.desktopMetadataPull,
        fileBoxCount: result.fileBoxCount,
        transferCount: result.transferCount,
        conflictCount: result.conflictCount,
      },
      desktopAttachmentStatusBeforeDownload: result.desktopAttachmentStatusBeforeDownload,
      blobDownloadedOnDemand: result.explicitDownload.downloaded,
      authMode: 'cached-refresh-token',
    })
  } finally {
    await browser.close().catch(() => {})
    vite.child.kill('SIGTERM')
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
