import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(process.env.LABNOTE_PREFLIGHT_OUTPUT_DIR || path.join(root, '.labnote-smoke', 'drive-oauth-preflight'))
const resultFile = path.join(outputDir, 'result.json')
const configPath = path.resolve(process.env.LABNOTE_OAUTH_CONFIG_FILE || path.join(root, '.labnote-local', 'oauth.desktop.json'))
const envClientId = process.env.LABNOTE_DESKTOP_CLIENT_ID?.trim() || ''
const envClientSecret = process.env.LABNOTE_DESKTOP_CLIENT_SECRET?.trim() || ''

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

function warn(message, extra = {}) {
  writeResult({ ok: true, warning: message, ...extra })
  console.warn(message)
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`Could not parse OAuth JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      configPath: filePath,
    })
  }
}

function parseConfig(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, clientId: '', clientSecret: '', kind: 'missing' }
  const parsed = readJson(filePath)
  const section = parsed.installed || parsed.web || parsed
  const kind = parsed.installed ? 'installed' : parsed.web ? 'web' : String(parsed.type || 'flat')
  return {
    exists: true,
    kind,
    clientId: String(section.client_id || section.clientId || '').trim(),
    clientSecret: String(section.client_secret || section.clientSecret || '').trim(),
  }
}

function getTrackedStatus(filePath) {
  try {
    const relative = path.relative(root, filePath)
    execFileSync('git', ['ls-files', '--error-unmatch', relative], { cwd: root, stdio: 'ignore' })
    return 'tracked'
  } catch {
    return 'not-tracked'
  }
}

const localConfig = parseConfig(configPath)
const clientId = envClientId || localConfig.clientId
const clientSecret = envClientSecret || localConfig.clientSecret
const source = envClientId ? 'environment' : localConfig.exists ? 'local-config' : 'missing'
const trackedStatus = localConfig.exists ? getTrackedStatus(configPath) : 'not-present'

if (!clientId) {
  fail('Desktop OAuth client ID is missing. Set LABNOTE_DESKTOP_CLIENT_ID or place a downloaded Google Desktop OAuth JSON at .labnote-local/oauth.desktop.json.', {
    source,
    configPath,
    localConfigExists: localConfig.exists,
    trackedStatus,
    nextStep: 'In Google Cloud Console, create or download an OAuth client with Application type: Desktop app, then keep the JSON under .labnote-local/ or import it in the app Sync settings.',
  })
}

if (trackedStatus === 'tracked') {
  fail('OAuth JSON appears to be tracked by Git. Remove it from Git before running OAuth smoke.', {
    configPath,
    trackedStatus,
  })
}

if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
  fail('OAuth client ID does not look like a Google OAuth client ID ending in .apps.googleusercontent.com.', {
    source,
    configPath: localConfig.exists ? configPath : undefined,
    localConfigKind: localConfig.kind,
    hasClientSecret: Boolean(clientSecret),
  })
}

if (localConfig.kind === 'web' && !envClientId) {
  fail('OAuth JSON contains a web client, but packaged desktop OAuth smoke requires a Desktop app OAuth client.', {
    source,
    configPath,
    localConfigKind: localConfig.kind,
    hasClientSecret: Boolean(clientSecret),
    nextStep: 'Create/download a Google OAuth client with Application type: Desktop app.',
  })
}

const result = {
  ok: true,
  message: 'Desktop OAuth preflight passed.',
  source,
  configPath: localConfig.exists ? configPath : undefined,
  localConfigKind: localConfig.kind,
  trackedStatus,
  hasClientSecret: Boolean(clientSecret),
}

if (!clientSecret) {
  warn('Desktop OAuth preflight passed without a client secret. That is expected for public installed apps when PKCE is used.', result)
} else {
  writeResult(result)
  console.log('Desktop OAuth preflight passed.')
}
