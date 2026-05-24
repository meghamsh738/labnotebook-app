import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('../web/node_modules/playwright')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(process.env.LABNOTE_SMOKE_OUTPUT_DIR || path.join(root, '.labnote-smoke', 'packaged-oauth'))
const authUrlFile = path.join(outputDir, 'oauth-url.txt')
const oauthEventFile = path.join(outputDir, 'oauth-events.jsonl')
const resultFile = path.join(outputDir, 'result.json')
const exePath = path.resolve(process.env.LABNOTE_EXE || path.join(root, 'desktop', 'dist', 'win-unpacked', 'Easylab Lab Notebook.exe'))
const localConfigPath = path.resolve(process.env.LABNOTE_OAUTH_CONFIG_FILE || path.join(root, '.labnote-local', 'oauth.desktop.json'))
const localOAuthConfig = readLocalOAuthConfig(localConfigPath)
const clientId = process.env.LABNOTE_DESKTOP_CLIENT_ID?.trim() || localOAuthConfig.clientId
const clientSecret = process.env.LABNOTE_DESKTOP_CLIENT_SECRET?.trim() || localOAuthConfig.clientSecret
const folderName = process.env.LABNOTE_SMOKE_FOLDER_NAME?.trim() || `Easylab Lab Notebook Packaged Smoke ${new Date().toISOString().replace(/[:.]/g, '-')}`
const timeoutMs = Number(process.env.LABNOTE_SMOKE_TIMEOUT_MS || 240000)

function readLocalOAuthConfig(configPath) {
  if (!fs.existsSync(configPath)) return { clientId: '', clientSecret: '' }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''))
    const section = parsed.installed || parsed.web || parsed
    return {
      clientId: String(section.client_id || section.clientId || '').trim(),
      clientSecret: String(section.client_secret || section.clientSecret || '').trim(),
    }
  } catch (error) {
    fail(`Could not read OAuth config JSON at ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function fail(message) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify({ ok: false, message, writtenAt: new Date().toISOString() }, null, 2))
  console.error(message)
  process.exit(1)
}

function requireValue(value, label) {
  if (!value) fail(`${label} is required.`)
}

function writeStatus(stage, extra = {}) {
  fs.writeFileSync(resultFile, JSON.stringify({
    ok: null,
    stage,
    ...extra,
    writtenAt: new Date().toISOString(),
  }, null, 2))
}

async function main() {
  requireValue(clientId, 'LABNOTE_DESKTOP_CLIENT_ID')
  if (!fs.existsSync(exePath)) fail(`Packaged app not found: ${exePath}`)

  fs.mkdirSync(outputDir, { recursive: true })
  for (const child of ['oauth-url.txt', 'oauth-events.jsonl', 'result.json', 'data', 'attachments', 'exports', 'sync', 'electron-user-data']) {
    fs.rmSync(path.join(outputDir, child), { recursive: true, force: true })
  }

  const appPaths = {
    dataRoot: path.join(outputDir, 'data'),
    attachmentsRoot: path.join(outputDir, 'attachments'),
    exportRoot: path.join(outputDir, 'exports'),
    syncRoot: path.join(outputDir, 'sync'),
    userDataRoot: path.join(outputDir, 'electron-user-data'),
  }
  for (const value of Object.values(appPaths)) fs.mkdirSync(value, { recursive: true })

  const app = await electron.launch({
    executablePath: exePath,
    env: {
      ...process.env,
      EASYLAB_LABNOTE_USER_DATA_DIR: appPaths.userDataRoot,
      EASYLAB_LABNOTE_OAUTH_URL_FILE: authUrlFile,
      EASYLAB_LABNOTE_OAUTH_EVENT_FILE: oauthEventFile,
      EASYLAB_LABNOTE_OAUTH_SKIP_OPEN: '1',
    },
  })

  let page
  try {
    writeStatus('launched', { exePath })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    writeStatus('loaded', { title: await page.title(), url: page.url() })
    await page.evaluate(({ appPaths: paths, clientId: desktopClientId, clientSecret: desktopClientSecret, folderName: driveFolderName }) => {
      window.localStorage.clear()
      window.localStorage.setItem('labnote.debugSync', '1')
      window.localStorage.setItem('labnote.setupComplete', '1')
      window.localStorage.setItem('labnote.appPaths', JSON.stringify(paths))
      window.localStorage.setItem('labnote.masterSyncPath', paths.syncRoot)
      window.localStorage.setItem('labnote.connected.googleDrive', JSON.stringify({
        provider: 'google-drive',
        clientId: '',
        desktopClientId,
        desktopClientSecret: desktopClientSecret || '',
        webClientId: '',
        folderName: driveFolderName,
        status: 'needs-auth',
      }))
    }, { appPaths, clientId, clientSecret, folderName })

    writeStatus('configured-local-storage', { folderName, loadedConfigFile: fs.existsSync(localConfigPath), hasClientSecret: Boolean(clientSecret) })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    writeStatus('reloaded-after-configuration', { title: await page.title(), url: page.url() })
    await page.getByRole('tab', { name: 'Sync' }).click()
    writeStatus('opened-sync-pane')
    page.on('console', (message) => {
      fs.appendFileSync(path.join(outputDir, 'renderer-console.log'), `${message.type()}: ${message.text()}\n`, 'utf-8')
    })
    page.on('pageerror', (error) => {
      fs.appendFileSync(path.join(outputDir, 'renderer-console.log'), `pageerror: ${error.message}\n`, 'utf-8')
    })
    await page.getByRole('button', { name: /Connect \/ Sync Drive/ }).click()
    writeStatus('clicked-connect-sync')

    const authStartedAt = Date.now()
    while (!fs.existsSync(authUrlFile)) {
      if (Date.now() - authStartedAt > 30000) {
        const diagnostics = await page.evaluate(() => {
          const raw = window.localStorage.getItem('labnote.connected.googleDrive')
          const drive = raw ? JSON.parse(raw) : null
          if (drive) delete drive.desktopClientSecret
          return {
            hasElectronAPI: Boolean(window.electronAPI?.requestGoogleDriveAccessToken),
            drive,
            bodyText: document.body.innerText.slice(0, 2000),
          }
        }).catch((error) => ({ diagnosticError: error instanceof Error ? error.message : String(error) }))
        await page.screenshot({ path: path.join(outputDir, 'oauth-url-timeout.png'), fullPage: true }).catch(() => {})
        fs.writeFileSync(resultFile, JSON.stringify({
          ok: false,
          message: 'OAuth URL was not captured within 30 seconds.',
          diagnostics,
          screenshot: path.join(outputDir, 'oauth-url-timeout.png'),
          writtenAt: new Date().toISOString(),
        }, null, 2))
        console.error('OAuth URL was not captured within 30 seconds.')
        process.exit(1)
      }
      await page.waitForTimeout(250)
    }

    writeStatus('waiting-for-consent', { authUrlFile, folderName })

    const waitStartedAt = Date.now()
    while (Date.now() - waitStartedAt < timeoutMs) {
      const state = await page.evaluate(() => {
        const raw = window.localStorage.getItem('labnote.connected.googleDrive')
        const parsed = raw ? JSON.parse(raw) : null
        return {
          status: parsed?.status,
          lastError: parsed?.lastError,
          folderId: parsed?.folderId,
          lastSyncAt: parsed?.lastSyncAt,
        }
      })
      if ((state.status === 'synced' || state.status === 'ready') && state.folderId) {
        await page.evaluate(() => {
          const raw = window.localStorage.getItem('labnote.connected.googleDrive')
          if (!raw) return
          const parsed = JSON.parse(raw)
          delete parsed.desktopClientSecret
          window.localStorage.setItem('labnote.connected.googleDrive', JSON.stringify(parsed))
        })
        fs.writeFileSync(resultFile, JSON.stringify({
          ok: true,
          stage: 'synced',
          folderName,
          folderId: state.folderId,
          lastSyncAt: state.lastSyncAt,
          writtenAt: new Date().toISOString(),
        }, null, 2))
        return
      }
      if (state.status === 'failed' || state.status === 'error') {
        fail(`Packaged OAuth sync failed: ${state.lastError || 'unknown error'}`)
      }
      writeStatus('waiting-for-sync', {
        folderName,
        status: state.status,
        lastSyncAt: state.lastSyncAt,
        hasFolderId: Boolean(state.folderId),
      })
      await page.waitForTimeout(1000)
    }

    fail(`Timed out waiting for packaged OAuth sync after ${timeoutMs} ms.`)
  } finally {
    await app.close().catch(() => {})
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
