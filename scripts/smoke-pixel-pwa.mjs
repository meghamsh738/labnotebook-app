import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultAdb = 'D:\\CodexTools\\android-platform-tools\\platform-tools\\adb.exe'
const adb = process.env.LABNOTE_ADB?.trim() || (fs.existsSync(defaultAdb) ? defaultAdb : 'adb')
const outputDir = path.resolve(process.env.LABNOTE_PIXEL_OUTPUT_DIR || path.join(root, '.labnote-device-smoke', 'pixel-pwa'))
const resultFile = path.join(outputDir, 'result.json')
const screenshotFile = path.join(outputDir, 'pixel-pwa.png')
const uiDumpFile = path.join(outputDir, 'ui.xml')
const packageName = process.env.LABNOTE_PIXEL_PACKAGE || 'org.chromium.webapk.af305fafacabb5a1e_v2'
const activityName = process.env.LABNOTE_PIXEL_ACTIVITY || 'org.chromium.webapk.shell_apk.h2o.H2OOpaqueMainActivity'
const port = Number(process.env.LABNOTE_PIXEL_PORT || 4173)
const minScreenshotBytes = Number(process.env.LABNOTE_PIXEL_MIN_SCREENSHOT_BYTES || 50000)
const requestedPane = (process.env.LABNOTE_PIXEL_PANE || 'sync').toLowerCase()

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

function getConnectedDevices() {
  const raw = runAdb(['devices', '-l'])
  return raw
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\sdevice\s/.test(line))
}

function getPowerAndWindowState() {
  const power = runAdb(['shell', 'dumpsys', 'power'])
  const windowState = runAdb(['shell', 'dumpsys', 'window'])
  const lockscreen = /mDreamingLockscreen=true|mShowingLockscreen=true/.test(windowState)
  const notificationShade = /mCurrentFocus=Window\{[^}]+ NotificationShade\}/.test(windowState)
  const awake = /mWakefulness=Awake|mWakefulness=1/.test(power)
  const focusMatch = windowState.match(/mCurrentFocus=([^\r\n]+)/)
  const focusedAppMatch = windowState.match(/mFocusedApp=([^\r\n]+)/)
  return {
    awake,
    lockscreen,
    notificationShade,
    currentFocus: focusMatch?.[1]?.trim() ?? '',
    focusedApp: focusedAppMatch?.[1]?.trim() ?? '',
  }
}

function hasExpectedForeground(state) {
  const focus = `${state.currentFocus} ${state.focusedApp}`
  if (focus.includes(packageName) || focus.includes(activityName)) return true
  return /com\.android\.chrome/.test(focus) && /WebApk|SameTaskWebApkActivity|webapp/i.test(focus)
}

function tryWakeAndLaunch() {
  const safe = (args) => {
    try {
      runAdb(args)
    } catch {
      // Continue; the final state check decides whether the run is usable.
    }
  }

  safe(['reverse', `tcp:${port}`, `tcp:${port}`])
  safe(['shell', 'svc', 'power', 'stayon', 'true'])
  safe(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  safe(['shell', 'wm', 'dismiss-keyguard'])
  safe(['shell', 'input', 'keyevent', 'BACK'])
  safe(['shell', 'am', 'start', '-n', `${packageName}/${activityName}`])
}

function tapRequestedPane() {
  if (requestedPane === 'none') return
  const sizeRaw = runAdb(['shell', 'wm', 'size'])
  const match = sizeRaw.match(/Physical size:\s*(\d+)x(\d+)/)
  const width = match ? Number(match[1]) : 1080
  const height = match ? Number(match[2]) : 2400
  const paneRatios = {
    today: 0.13,
    days: 0.31,
    files: 0.5,
    sync: 0.7,
    settings: 0.88,
  }
  const ratio = paneRatios[requestedPane] ?? paneRatios.sync
  const x = Math.round(width * ratio)
  const y = Math.round(height - 145)
  runAdb(['shell', 'input', 'tap', String(x), String(y)])
}

function captureEvidence() {
  const remoteScreenshot = '/sdcard/labnote-pixel-pwa-smoke.png'
  runAdb(['shell', 'screencap', '-p', remoteScreenshot])
  runAdb(['pull', remoteScreenshot, screenshotFile])
  try {
    const uiRaw = runAdb(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
    fs.writeFileSync(uiDumpFile, uiRaw)
  } catch {
    // Some lockscreen states do not allow a useful UI dump. Screenshot and state still diagnose the failure.
  }
}

fs.mkdirSync(outputDir, { recursive: true })
for (const child of ['pixel-pwa.png', 'ui.xml', 'result.json']) {
  fs.rmSync(path.join(outputDir, child), { force: true })
}

try {
  const devices = getConnectedDevices()
  if (devices.length === 0) {
    fail('No connected Android device is available through adb.', { adb })
  }

  tryWakeAndLaunch()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)

  let state = getPowerAndWindowState()
  if (state.lockscreen || state.notificationShade) {
    fail('Pixel PWA smoke cannot proceed because the device is still on the lockscreen or NotificationShade. Unlock the Pixel 7a and leave it on the app before rerunning.', {
      adb,
      packageName,
      activityName,
      state,
    })
  }
  if (!hasExpectedForeground(state)) {
    fail('Pixel PWA smoke cannot proceed because Lab Notebook is not the foreground app after launch.', {
      adb,
      packageName,
      activityName,
      state,
    })
  }

  tapRequestedPane()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  state = getPowerAndWindowState()
  if (!hasExpectedForeground(state)) {
    fail('Pixel PWA smoke cannot accept evidence because Lab Notebook is no longer the foreground app.', {
      adb,
      packageName,
      activityName,
      state,
    })
  }
  captureEvidence()

  const screenshotSize = fs.existsSync(screenshotFile) ? fs.statSync(screenshotFile).size : 0
  if (screenshotSize < minScreenshotBytes) {
    fail('Pixel screenshot is too small and likely black/locked; it was not accepted as visual evidence.', {
      adb,
      packageName,
      activityName,
      state,
      screenshotFile,
      screenshotSize,
      minScreenshotBytes,
    })
  }

  const uiText = fs.existsSync(uiDumpFile) ? fs.readFileSync(uiDumpFile, 'utf8') : ''
  const hasLabNotebookUi = /Lab Notebook|Easylab Lab Notebook|Google Drive Sync|Device-owned sync without an Easylab cloud server|Connect \/ Sync Drive|Offline storage/i.test(uiText)
  if (!hasLabNotebookUi) {
    fail('Pixel UI dump did not contain Lab Notebook navigation text, so the capture was not accepted as app evidence.', {
      adb,
      packageName,
      activityName,
      state,
      screenshotFile,
      screenshotSize,
      uiDumpFile,
    })
  }

  writeResult({
    ok: true,
    message: 'Pixel PWA smoke screenshot accepted.',
    adb,
    packageName,
    activityName,
    pane: requestedPane,
    state,
    screenshotFile,
    screenshotSize,
    uiDumpFile,
  })
  console.log(`Pixel PWA smoke screenshot accepted: ${screenshotFile}`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
