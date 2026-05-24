import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('../web/node_modules/playwright')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultAdb = 'D:\\CodexTools\\android-platform-tools\\platform-tools\\adb.exe'
const adb = process.env.LABNOTE_ADB?.trim() || (fs.existsSync(defaultAdb) ? defaultAdb : 'adb')
const outputDir = path.resolve(process.env.LABNOTE_PIXEL_CAPTURE_OUTPUT_DIR || path.join(root, '.labnote-device-smoke', 'pixel-capture'))
const resultFile = path.join(outputDir, 'result.json')
const screenshotFile = path.join(outputDir, 'pixel-capture-file-hub.png')
const uploadFile = path.join(outputDir, `pixel-pwa-capture-${Date.now()}.png`)
const packageName = process.env.LABNOTE_PIXEL_PACKAGE || 'org.chromium.webapk.af305fafacabb5a1e_v2'
const activityName = process.env.LABNOTE_PIXEL_ACTIVITY || 'org.chromium.webapk.shell_apk.h2o.H2OOpaqueMainActivity'
const port = Number(process.env.LABNOTE_PIXEL_PORT || 4173)
const devtoolsPort = Number(process.env.LABNOTE_PIXEL_DEVTOOLS_PORT || 9222)
const pageUrl = `http://127.0.0.1:${port}/?pwa=1`
const pngOnePixelBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2fXU4AAAAASUVORK5CYII='

function adbArgs(args) {
  const serial = process.env.LABNOTE_PIXEL_SERIAL?.trim()
  return serial ? ['-s', serial, ...args] : args
}

function runAdb(args, options = {}) {
  return execFileSync(adb, adbArgs(args), {
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

function writeResult(payload) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify({
    ...payload,
    writtenAt: new Date().toISOString(),
  }, null, 2))
}

function fail(message, extra = {}) {
  writeResult({ ok: false, message, ...extra })
  console.error(message)
  process.exit(1)
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // Keep polling while the dev server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function ensureDevServer() {
  if (await waitForHttp(pageUrl, 2000)) return null

  const child = spawn('npm', ['--prefix', 'web', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  if (!(await waitForHttp(pageUrl, 45000))) {
    child.kill()
    fail(`Unable to start or reach the Lab Notebook dev server at ${pageUrl}.`)
  }
  return child
}

function getConnectedDevices() {
  const raw = runAdb(['devices', '-l'])
  return raw
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\sdevice\s/.test(line))
}

function getWindowState() {
  const windowState = runAdb(['shell', 'dumpsys', 'window'])
  const focusMatch = windowState.match(/mCurrentFocus=([^\r\n]+)/)
  const focusedAppMatch = windowState.match(/mFocusedApp=([^\r\n]+)/)
  return {
    currentFocus: focusMatch?.[1]?.trim() ?? '',
    focusedApp: focusedAppMatch?.[1]?.trim() ?? '',
    lockscreen: /mDreamingLockscreen=true|mShowingLockscreen=true/.test(windowState),
    notificationShade: /mCurrentFocus=Window\{[^}]+ NotificationShade\}/.test(windowState),
  }
}

function hasExpectedForeground(state) {
  const focus = `${state.currentFocus} ${state.focusedApp}`
  if (focus.includes(packageName) || focus.includes(activityName)) return true
  return /com\.android\.chrome/.test(focus) && /WebApk|SameTaskWebApkActivity|webapp/i.test(focus)
}

function prepareDevice() {
  runAdb(['reverse', `tcp:${port}`, `tcp:${port}`])
  runAdb(['shell', 'svc', 'power', 'stayon', 'true'])
  runAdb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  runAdb(['shell', 'wm', 'dismiss-keyguard'])
  runAdb(['shell', 'input', 'keyevent', 'BACK'])
  runAdb(['shell', 'am', 'force-stop', 'com.google.android.documentsui'])
  runAdb(['shell', 'am', 'force-stop', 'com.android.chrome'])
  try {
    runAdb(['forward', '--remove', `tcp:${devtoolsPort}`])
  } catch {
    // It is fine if the forward was not already registered.
  }
  runAdb(['forward', `tcp:${devtoolsPort}`, 'localabstract:chrome_devtools_remote'])
  runAdb(['shell', 'am', 'start', '-n', `${packageName}/${activityName}`])
}

async function connectToPixelBrowser() {
  const started = Date.now()
  let lastError
  while (Date.now() - started < 30000) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`, { timeout: 3000 })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to connect to Pixel Chrome DevTools.')
}

async function findLabNotebookPage(browser) {
  const started = Date.now()
  while (Date.now() - started < 30000) {
    const pages = browser.contexts().flatMap((context) => context.pages())
    const candidates = pages.filter((page) => page.url().includes(`127.0.0.1:${port}`))
    if (candidates.length) return candidates[0]
    for (const page of pages) {
      const title = await page.title().catch(() => '')
      if (/Easylab Lab Notebook/i.test(title)) return page
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

async function seedSmokeEntry(page, entryId) {
  return page.evaluate(({ entryId: id }) => {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    const dateBucket = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const nowIso = now.toISOString()
    const paths = {
      dataRoot: 'Pixel local cache',
      attachmentsRoot: 'Pixel local cache/attachments',
      exportRoot: 'Pixel local cache/exports',
      syncRoot: 'Google Drive/Easylab Lab Notebook',
    }
    const readJson = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch {
        return fallback
      }
    }
    const withoutPriorSmokeFiles = (items) =>
      Array.isArray(items) ? items.filter((item) => !String(item?.filename ?? '').startsWith('pixel-pwa-capture-')) : []
    const entries = readJson('labnote.entries', {})
    window.localStorage.setItem('labnote.attachments', JSON.stringify(withoutPriorSmokeFiles(readJson('labnote.attachments', []))))
    window.localStorage.setItem(
      'labnote.connected.fileBox',
      JSON.stringify(withoutPriorSmokeFiles(readJson('labnote.connected.fileBox', [])))
    )
    window.localStorage.setItem(
      'labnote.connected.transfers',
      JSON.stringify(withoutPriorSmokeFiles(readJson('labnote.connected.transfers', [])))
    )
    entries[id] = {
      id,
      createdDatetime: nowIso,
      lastEditedDatetime: nowIso,
      authorId: 'pixel-smoke',
      title: `Pixel PWA capture smoke - ${dateBucket}`,
      dateBucket,
      isDaily: true,
      content: [
        { id: `${id}-heading`, type: 'heading', text: 'Pixel PWA capture smoke', level: 2 },
        { id: `${id}-note`, type: 'paragraph', text: 'This entry was seeded for real Pixel PWA capture verification.' },
      ],
      tags: [],
      projectTags: [],
      experimentTags: [],
      searchTerms: ['pixel', 'pwa', 'capture', 'smoke'],
      linkedFiles: [],
      pinnedRegions: [],
      syncStatus: 'local',
      updatedByDeviceId: 'pixel-7a-smoke',
      version: 1,
    }
    window.localStorage.setItem('labnote.setupComplete', '1')
    window.localStorage.setItem('labnote.appPaths', JSON.stringify(paths))
    window.localStorage.setItem('labnote.masterSyncPath', paths.syncRoot)
    window.localStorage.setItem('labnote.enableSmokeHooks', '1')
    window.localStorage.setItem('labnote.entries', JSON.stringify(entries))
    return { dateBucket, title: entries[id].title }
  }, { entryId })
}

async function waitForCaptureState(page, filename, expectedDateBucket, timeoutMs = 20000) {
  const started = Date.now()
  let latest = null
  while (Date.now() - started < timeoutMs) {
    latest = await page.evaluate((name) => {
      const readJson = (key, fallback) => {
        try {
          const raw = window.localStorage.getItem(key)
          return raw ? JSON.parse(raw) : fallback
        } catch {
          return fallback
        }
      }
      const attachments = readJson('labnote.attachments', [])
      const fileBoxItems = readJson('labnote.connected.fileBox', [])
      const transfers = readJson('labnote.connected.transfers', [])
      const entries = readJson('labnote.entries', {})
      const attachment = Array.isArray(attachments) ? attachments.find((item) => item.filename === name) : undefined
      const fileBoxItem = Array.isArray(fileBoxItems) ? fileBoxItems.find((item) => item.filename === name) : undefined
      const transfer = Array.isArray(transfers) ? transfers.find((item) => item.filename === name) : undefined
      const entry = attachment?.entryId && entries && typeof entries === 'object' ? entries[attachment.entryId] : undefined
      return {
        attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
        fileBoxCount: Array.isArray(fileBoxItems) ? fileBoxItems.length : 0,
        transferCount: Array.isArray(transfers) ? transfers.length : 0,
        attachment: attachment
          ? {
              id: attachment.id,
              entryId: attachment.entryId,
              filename: attachment.filename,
              syncStatus: attachment.syncStatus,
              cacheKey: attachment.cacheKey,
              sha256: attachment.sha256,
              pinnedOffline: attachment.pinnedOffline,
            }
          : null,
        entry: entry
          ? {
              id: entry.id,
              title: entry.title,
              dateBucket: entry.dateBucket,
              isDaily: entry.isDaily,
            }
          : null,
        fileBoxItem: fileBoxItem
          ? {
              id: fileBoxItem.id,
              entryId: fileBoxItem.entryId,
              attachmentId: fileBoxItem.attachmentId,
              filename: fileBoxItem.filename,
              status: fileBoxItem.status,
              sourceDeviceName: fileBoxItem.sourceDeviceName,
            }
          : null,
        transfer: transfer
          ? {
              id: transfer.id,
              entryId: transfer.entryId,
              attachmentId: transfer.attachmentId,
              filename: transfer.filename,
              status: transfer.status,
              provider: transfer.provider,
            }
          : null,
      }
    }, filename)
    if (
      latest.attachment &&
      latest.fileBoxItem &&
      latest.transfer &&
      latest.entry?.dateBucket === expectedDateBucket &&
      latest.entry?.isDaily === true
    ) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for Pixel capture state for ${filename}: ${JSON.stringify(latest)}`)
}

async function dispatchSyntheticCapture(page, filename) {
  return page.evaluate(({ name, base64 }) => {
    const input = document.querySelector('[data-testid="mobile-capture-input"]')
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('The mobile capture input was not found in the Pixel PWA DOM.')
    }
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    const file = new File([bytes], name, { type: 'image/png', lastModified: Date.now() })
    window.dispatchEvent(new CustomEvent('labnote:mobile-capture-files', { detail: { files: [file] } }))
    return { filename: file.name, size: file.size, type: file.type, smokeEvent: 'labnote:mobile-capture-files' }
  }, { name: filename, base64: pngOnePixelBase64 })
}

fs.mkdirSync(outputDir, { recursive: true })
for (const child of ['pixel-capture-file-hub.png', 'result.json']) {
  fs.rmSync(path.join(outputDir, child), { force: true })
}
fs.writeFileSync(uploadFile, Buffer.from(pngOnePixelBase64, 'base64'))

let devServer = null
let browser = null

try {
  const devices = getConnectedDevices()
  if (devices.length === 0) fail('No connected Android device is available through adb.', { adb })

  devServer = await ensureDevServer()
  prepareDevice()
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const state = getWindowState()
  if (state.lockscreen || state.notificationShade || !hasExpectedForeground(state)) {
    fail('Pixel PWA capture smoke cannot proceed because the Lab Notebook WebAPK is not foreground and unlocked.', {
      adb,
      packageName,
      activityName,
      state,
    })
  }

  browser = await connectToPixelBrowser()
  const page = await findLabNotebookPage(browser)
  if (!page) fail('Unable to find the Lab Notebook PWA page through Pixel Chrome DevTools.', { devtoolsPort })

  await page.bringToFront()
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  const entryId = `entry-pixel-smoke-${Date.now()}`
  const seeded = await seedSmokeEntry(page, entryId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByTestId('mobile-nav-today').waitFor({ state: 'visible', timeout: 20000 })
  await page.getByTestId('mobile-nav-today').click()
  await page.getByTestId('mobile-capture-input').waitFor({ state: 'attached', timeout: 20000 })
  await page.waitForFunction(() => window.__labnoteSmokeCaptureReady === true, null, { timeout: 20000 })

  const filename = path.basename(uploadFile)
  const dispatchedFile = await dispatchSyntheticCapture(page, filename)
  const captureState = await waitForCaptureState(page, filename, seeded.dateBucket)

  await page.getByTestId('mobile-nav-files').click()
  await page.getByTestId('file-hub-pane').waitFor({ state: 'visible', timeout: 20000 })
  await page.screenshot({ path: screenshotFile, fullPage: false })

  const screenshotSize = fs.existsSync(screenshotFile) ? fs.statSync(screenshotFile).size : 0
  if (screenshotSize < 20000) {
    throw new Error(`Pixel capture screenshot is too small to accept as evidence: ${screenshotSize} bytes.`)
  }

  writeResult({
    ok: true,
    message: 'Pixel PWA capture smoke accepted.',
    adb,
    packageName,
    activityName,
    pageUrl: page.url(),
    pageTitle: await page.title(),
    viewport: await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio })),
    seeded,
    entryId,
    uploadFile,
    filename,
    dispatchedFile,
    captureState,
    screenshotFile,
    screenshotSize,
    notes: [
      'This proves the installed Pixel PWA accepted an image through the mobile capture input and queued an attachment, file box item, and transfer record.',
      'It does not by itself prove the full real Google Drive Pixel-to-desktop round trip.',
    ],
  })
  console.log(`Pixel PWA capture smoke accepted: ${screenshotFile}`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (devServer) devServer.kill()
}
