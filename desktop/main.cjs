const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')
const { refreshFailureDecision, refreshedAuthorizationDecision } = require('./oauthScopes.cjs')

let keytar = null
try {
  keytar = require('keytar')
} catch {
  keytar = null
}

const userDataDir = process.env.EASYLAB_LABNOTE_USER_DATA_DIR?.trim()
if (userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
}

const isDev = process.env.EASYLAB_LABNOTE_DEV === '1'
const openDevTools = process.env.EASYLAB_LABNOTE_OPEN_DEVTOOLS === '1'

function expandUserPath(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return app.getPath('home')
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(app.getPath('home'), value.slice(2))
  }
  return value
}

function appRoot(...parts) {
  return isDev
    ? path.join(__dirname, '..', 'web', ...parts)
    : path.join(process.resourcesPath, 'web', ...parts)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    title: 'Easylab Lab Notebook',
    backgroundColor: '#f6f7f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    win.loadURL(process.env.EASYLAB_LABNOTE_DEV_URL || 'http://127.0.0.1:5173')
    if (openDevTools) win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(appRoot('index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

function oauthStatusPage({ title, message, tone = 'success' }) {
  const isSuccess = tone === 'success'
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #141b18;
        background: #f6f7f5;
      }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 28px;
      }
      main {
        width: min(520px, 100%);
        padding: 28px;
        border: 1px solid rgba(18, 28, 23, 0.11);
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(20, 28, 24, 0.08);
      }
      .mark {
        display: grid;
        width: 42px;
        height: 42px;
        margin-bottom: 20px;
        place-items: center;
        border-radius: 10px;
        background: ${isSuccess ? 'rgba(8, 113, 85, 0.1)' : 'rgba(180, 35, 24, 0.1)'};
        color: ${isSuccess ? '#087155' : '#b42318'};
        font-size: 22px;
        font-weight: 760;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 26px;
        line-height: 1.15;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: #68746e;
        font-size: 15px;
        line-height: 1.55;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">${isSuccess ? '✓' : '!'}</div>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function openGoogleOAuthUrl(url) {
  const capturePath = process.env.EASYLAB_LABNOTE_OAUTH_URL_FILE
  if (capturePath) {
    fs.mkdirSync(path.dirname(capturePath), { recursive: true })
    fs.writeFileSync(capturePath, url, 'utf-8')
  }
  if (process.env.EASYLAB_LABNOTE_OAUTH_SKIP_OPEN === '1') return
  await shell.openExternal(url)
}

function writeOAuthEvent(event, details = {}) {
  const eventPath = process.env.EASYLAB_LABNOTE_OAUTH_EVENT_FILE
  if (!eventPath) return
  fs.mkdirSync(path.dirname(eventPath), { recursive: true })
  fs.appendFileSync(eventPath, `${JSON.stringify({ event, ...details, at: new Date().toISOString() })}\n`, 'utf-8')
}

const GOOGLE_TOKEN_SERVICE = 'Easylab Lab Notebook Google Drive'

function credentialAccount(clientId) {
  return `google-drive:${String(clientId || '').trim()}`
}

function tokenCachePath(clientId) {
  const digest = crypto.createHash('sha256').update(String(clientId || '').trim()).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), `google-drive-${digest}.bin`)
}

async function readStoredRefreshToken(clientId) {
  const account = credentialAccount(clientId)
  if (keytar) {
    const token = await keytar.getPassword(GOOGLE_TOKEN_SERVICE, account)
    if (token) return token
  }

  const filePath = tokenCachePath(clientId)
  if (!fs.existsSync(filePath)) return ''
  try {
    const raw = fs.readFileSync(filePath)
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(raw)
  } catch (error) {
    writeOAuthEvent('token-cache-read-error', { message: error instanceof Error ? error.message : String(error) })
  }
  return ''
}

async function writeStoredRefreshToken(clientId, refreshToken) {
  if (!refreshToken) return
  const account = credentialAccount(clientId)
  if (keytar) {
    await keytar.setPassword(GOOGLE_TOKEN_SERVICE, account, refreshToken)
    return
  }

  if (!safeStorage.isEncryptionAvailable()) {
    writeOAuthEvent('token-cache-unavailable', { reason: 'safeStorage encryption unavailable and keytar missing' })
    return
  }
  const filePath = tokenCachePath(clientId)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, safeStorage.encryptString(refreshToken))
}

async function deleteStoredRefreshToken(clientId) {
  const account = credentialAccount(clientId)
  if (keytar) await keytar.deletePassword(GOOGLE_TOKEN_SERVICE, account)
  const filePath = tokenCachePath(clientId)
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
}

async function fetchGoogleAccount(accessToken) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Google account lookup failed (${response.status}). Please try again.`)
  }
  let profile
  try {
    profile = await response.json()
  } catch {
    throw new Error('Google account lookup returned a malformed response. Please try again.')
  }
  if (!profile?.email) return { status: 'unverifiable' }
  return {
    status: 'verified',
    account: {
      provider: 'google',
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      subject: profile.sub,
    },
  }
}

async function refreshGoogleDriveToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: String(clientId).trim(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const optionalClientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
  if (optionalClientSecret) body.set('client_secret', optionalClientSecret)
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  let tokenJson
  try {
    tokenJson = await tokenResponse.json()
  } catch {
    throw new Error(`Google token refresh returned a malformed response (${tokenResponse.status}). Please try again.`)
  }
  if (!tokenResponse.ok) {
    const error = new Error(tokenJson.error_description || tokenJson.error || `Google token refresh failed (${tokenResponse.status}).`)
    error.oauthError = tokenJson.error
    error.httpStatus = tokenResponse.status
    throw error
  }
  if (!tokenJson.access_token) {
    throw new Error('Google token refresh returned no access token. Please try again.')
  }
  const accountLookup = await fetchGoogleAccount(tokenJson.access_token)
  return {
    accessToken: tokenJson.access_token,
    expiresIn: tokenJson.expires_in,
    scope: tokenJson.scope,
    tokenType: tokenJson.token_type,
    account: accountLookup.account,
    accountLookupStatus: accountLookup.status,
  }
}

async function requestGoogleDriveToken({ clientId, clientSecret, scope, forceConsent }) {
  if (!clientId || !String(clientId).trim()) throw new Error('Google OAuth client ID is required.')
  writeOAuthEvent('request-start', { hasClientSecret: Boolean(clientSecret) })
  const requestedScope = scope || 'https://www.googleapis.com/auth/drive.file'
  const optionalClientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
  if (!forceConsent) {
    const refreshToken = await readStoredRefreshToken(clientId)
    if (refreshToken) {
      try {
        const refreshed = await refreshGoogleDriveToken({ clientId, clientSecret, refreshToken })
        const authorizationDecision = refreshedAuthorizationDecision({
          requestedScope,
          grantedScope: refreshed.scope,
          account: refreshed.account,
          accountLookupStatus: refreshed.accountLookupStatus,
        })
        if (authorizationDecision === 'accept') {
          writeOAuthEvent('refresh-success', { scope: refreshed.scope, tokenType: refreshed.tokenType })
          return refreshed
        }
        writeOAuthEvent('refresh-needs-consent', {
          scope: refreshed.scope,
          reason: refreshed.account ? 'scope-upgrade' : 'account-unverified',
        })
        await deleteStoredRefreshToken(clientId)
      } catch (error) {
        const failureDecision = refreshFailureDecision({
          oauthError: error?.oauthError,
          httpStatus: error?.httpStatus,
        })
        writeOAuthEvent('refresh-error', {
          message: error instanceof Error ? error.message : String(error),
          decision: failureDecision,
        })
        if (failureDecision === 'reconsent') {
          await deleteStoredRefreshToken(clientId)
        } else {
          throw error instanceof Error ? error : new Error(String(error))
        }
      }
    }
  }

  const verifier = base64Url(crypto.randomBytes(48))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())

  return new Promise((resolve, reject) => {
    let settled = false
    const server = http.createServer()

    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      server.close(() => {})
      if (error) {
        writeOAuthEvent('request-error', { message: error.message })
        reject(error)
      } else {
        writeOAuthEvent('request-success', { scope: result?.scope, tokenType: result?.tokenType })
        resolve(result)
      }
    }

    const timeout = setTimeout(() => finish(new Error('Google sign-in timed out.')), 5 * 60 * 1000)

    server.on('request', async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${server.address().port}`)
        if (requestUrl.pathname !== '/oauth2callback') {
          res.writeHead(404)
          res.end('Not found')
          return
        }

        const error = requestUrl.searchParams.get('error')
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(oauthStatusPage({
            title: 'Google Drive sign-in was cancelled',
            message: 'Return to Easylab Lab Notebook to try connecting your Drive workspace again.',
            tone: 'error',
          }))
          finish(new Error(error))
          return
        }

        const code = requestUrl.searchParams.get('code')
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(oauthStatusPage({
            title: 'Google Drive sign-in could not finish',
            message: 'The authorization code was missing. Return to the app and start sign-in again.',
            tone: 'error',
          }))
          finish(new Error('Google authorization code was not returned.'))
          return
        }

        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`
        const body = new URLSearchParams({
          client_id: String(clientId).trim(),
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        })
        if (optionalClientSecret) body.set('client_secret', optionalClientSecret)
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        })
        const tokenJson = await tokenResponse.json().catch(() => ({}))
        if (!tokenResponse.ok || !tokenJson.access_token) {
          throw new Error(tokenJson.error_description || tokenJson.error || `Google token exchange failed (${tokenResponse.status}).`)
        }
        writeOAuthEvent('token-exchanged', { status: tokenResponse.status, scope: tokenJson.scope, tokenType: tokenJson.token_type })
        if (tokenJson.refresh_token) await writeStoredRefreshToken(clientId, tokenJson.refresh_token)

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(oauthStatusPage({
          title: 'Google Drive is connected',
          message: 'Your Easylab notebook can now sync through this Google account. You can close this tab and return to the app.',
        }))
        finish(null, {
          accessToken: tokenJson.access_token,
          expiresIn: tokenJson.expires_in,
          scope: tokenJson.scope,
          tokenType: tokenJson.token_type,
          account: (await fetchGoogleAccount(tokenJson.access_token)).account,
        })
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(oauthStatusPage({
          title: 'Google Drive sign-in failed',
          message: 'Return to Easylab Lab Notebook and try again. If this keeps happening, open the app settings and review developer details.',
          tone: 'error',
        }))
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })

    server.on('error', (error) => finish(error))
    server.listen(0, '127.0.0.1', async () => {
      try {
        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        authUrl.searchParams.set('client_id', String(clientId).trim())
        authUrl.searchParams.set('redirect_uri', redirectUri)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('scope', requestedScope)
        authUrl.searchParams.set('code_challenge', challenge)
        authUrl.searchParams.set('code_challenge_method', 'S256')
        authUrl.searchParams.set('access_type', 'offline')
        authUrl.searchParams.set('prompt', 'consent')
        writeOAuthEvent('auth-url-ready', { redirectUri })
        await openGoogleOAuthUrl(authUrl.toString())
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

async function disconnectGoogleDrive({ clientId } = {}) {
  const cleanedClientId = String(clientId || '').trim()
  if (!cleanedClientId) return { ok: true }
  const refreshToken = await readStoredRefreshToken(cleanedClientId)
  if (refreshToken) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    }).catch(() => undefined)
  }
  await deleteStoredRefreshToken(cleanedClientId)
  return { ok: true }
}

app.whenReady().then(() => {
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }))

  ipcMain.handle('dialog:select-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog({
      title: options.title || 'Select folder',
      defaultPath: expandUserPath(options.defaultPath),
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] || null
  })

  ipcMain.handle('fs:ensure-directories', async (_event, paths) => {
    try {
      for (const value of Object.values(paths || {})) {
        if (typeof value === 'string' && value.trim()) fs.mkdirSync(expandUserPath(value), { recursive: true })
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('google-drive:request-token', async (_event, options) => requestGoogleDriveToken(options || {}))
  ipcMain.handle('google-drive:disconnect', async (_event, options) => disconnectGoogleDrive(options || {}))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
