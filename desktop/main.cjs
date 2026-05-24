const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')

const userDataDir = process.env.EASYLAB_LABNOTE_USER_DATA_DIR?.trim()
if (userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
}

const isDev = process.env.EASYLAB_LABNOTE_DEV === '1'

function appRoot(...parts) {
  return isDev
    ? path.join(__dirname, '..', 'web', ...parts)
    : path.join(process.resourcesPath, 'web', ...parts)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: 'Easylab Lab Notebook',
    backgroundColor: '#f4efe5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    win.loadURL(process.env.EASYLAB_LABNOTE_DEV_URL || 'http://127.0.0.1:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(appRoot('index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
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

async function requestGoogleDriveToken({ clientId, clientSecret, scope }) {
  if (!clientId || !String(clientId).trim()) throw new Error('Google OAuth client ID is required.')
  writeOAuthEvent('request-start', { hasClientSecret: Boolean(clientSecret) })
  const requestedScope = scope || 'https://www.googleapis.com/auth/drive.file'
  const optionalClientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
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
          res.end('<h1>Easylab Google Drive sign-in failed</h1><p>You can close this tab.</p>')
          finish(new Error(error))
          return
        }

        const code = requestUrl.searchParams.get('code')
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end('<h1>Missing authorization code</h1><p>You can close this tab.</p>')
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

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>Easylab Lab Notebook is connected to Google Drive</h1><p>You can close this tab and return to the app.</p>')
        finish(null, {
          accessToken: tokenJson.access_token,
          expiresIn: tokenJson.expires_in,
          scope: tokenJson.scope,
          tokenType: tokenJson.token_type,
        })
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>Easylab Google Drive sign-in failed</h1><p>You can close this tab.</p>')
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

app.whenReady().then(() => {
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }))

  ipcMain.handle('dialog:select-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog({
      title: options.title || 'Select folder',
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] || null
  })

  ipcMain.handle('fs:ensure-directories', async (_event, paths) => {
    try {
      for (const value of Object.values(paths || {})) {
        if (typeof value === 'string' && value.trim()) fs.mkdirSync(value, { recursive: true })
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('google-drive:request-token', async (_event, options) => requestGoogleDriveToken(options || {}))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
