import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { Attachment, Entry, Experiment, Project } from './src/domain/types'
import { sampleData } from './src/data/sampleData'

type LabnoteServerState = {
  version: number
  projects: Project[]
  experiments: Experiment[]
  entries: Record<string, Entry>
  attachments: Attachment[]
}

type SessionRole = 'owner' | 'member'

type LabnoteAuthSession = {
  id: string
  role: SessionRole
  tokenHash: string
  deviceName: string
  createdAt: string
  lastSeenAt: string
}

type LabnotePairCode = {
  codeHash: string
  createdAt: string
  expiresAt: string
  createdBySessionId: string
}

type LabnoteAuthState = {
  sessions: LabnoteAuthSession[]
  pairCode?: LabnotePairCode
}

const STATE_VERSION = 1
const PROJECT_ROOT = path.resolve(process.cwd(), '..')
const DATA_DIR = process.env.LABNOTE_DATA_DIR ?? path.join(PROJECT_ROOT, '.labnote-data')
const DATA_FILE = path.join(DATA_DIR, 'labnote-state.json')
const AUTH_FILE = path.join(DATA_DIR, 'labnote-auth.json')
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
const UPLOAD_URL_PREFIX = '/labnote-uploads/'
const DIST_DIR = process.env.LABNOTE_DIST_DIR ?? path.join(PROJECT_ROOT, '.labnote-dist', 'web')
const SESSION_HEADER = 'x-labnote-session'
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const PAIR_CODE_DEFAULT_TTL_MS = 5 * 60 * 1000
const PAIR_CODE_MIN_TTL_MS = 60 * 1000
const PAIR_CODE_MAX_TTL_MS = 15 * 60 * 1000
const PAIR_ATTEMPT_WINDOW_MS = 10 * 60 * 1000
const PAIR_ATTEMPT_LIMIT = 8
const PAIR_ATTEMPT_BLOCK_MS = 10 * 60 * 1000

function seedState(): LabnoteServerState {
  return {
    version: STATE_VERSION,
    projects: sampleData.projects,
    experiments: sampleData.experiments,
    entries: Object.fromEntries(sampleData.entries.map((entry) => [entry.id, entry])),
    attachments: sampleData.attachments,
  }
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function ensureUploadsDir() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

function nowIso() {
  return new Date().toISOString()
}

function hashSecret(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

function createPairCode(): string {
  return String(100000 + Math.floor(Math.random() * 900000))
}

function clampPairTtlSeconds(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed)) return Math.floor(PAIR_CODE_DEFAULT_TTL_MS / 1000)
  const ms = Math.round(parsed * 1000)
  const bounded = Math.max(PAIR_CODE_MIN_TTL_MS, Math.min(PAIR_CODE_MAX_TTL_MS, ms))
  return Math.floor(bounded / 1000)
}

function normalizePairCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').trim().toUpperCase()
}

function normalizeDeviceName(raw: unknown, fallback = 'Lab device'): string {
  const value = typeof raw === 'string' ? raw : ''
  const cleaned = value.trim().replace(/\s+/g, ' ')
  if (!cleaned) return fallback
  return cleaned.slice(0, 80)
}

function extensionForMime(mime: string): string {
  const normalized = mime.toLowerCase()
  if (normalized.includes('jpeg')) return '.jpg'
  if (normalized.includes('png')) return '.png'
  if (normalized.includes('gif')) return '.gif'
  if (normalized.includes('webp')) return '.webp'
  if (normalized.includes('svg')) return '.svg'
  if (normalized.includes('pdf')) return '.pdf'
  return ''
}

function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}

function safeBaseName(filename: string): string {
  const base = path.basename(filename || 'upload')
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'upload'
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') }
}

function normalizeEntries(value: unknown, fallback: Record<string, Entry>): Record<string, Entry> {
  if (!value) return fallback
  if (Array.isArray(value)) {
    const entries = value.filter((item): item is Entry => !!item && typeof item === 'object' && 'id' in item)
    return Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  }
  if (typeof value === 'object') return value as Record<string, Entry>
  return fallback
}

function readState(): LabnoteServerState {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LabnoteServerState>
    return {
      version: parsed.version ?? STATE_VERSION,
      projects: Array.isArray(parsed.projects) ? parsed.projects : sampleData.projects,
      experiments: Array.isArray(parsed.experiments) ? parsed.experiments : sampleData.experiments,
      entries: normalizeEntries(parsed.entries, Object.fromEntries(sampleData.entries.map((entry) => [entry.id, entry]))),
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : sampleData.attachments,
    }
  } catch {
    return seedState()
  }
}

function writeState(state: LabnoteServerState) {
  ensureDataDir()
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

function seedAuthState(): LabnoteAuthState {
  return { sessions: [] }
}

function pruneAuthState(state: LabnoteAuthState): LabnoteAuthState {
  const now = Date.now()
  const sessions = (state.sessions ?? []).filter((session) => {
    const lastSeenAt = Date.parse(session.lastSeenAt || session.createdAt)
    if (Number.isNaN(lastSeenAt)) return false
    return now - lastSeenAt < SESSION_MAX_AGE_MS
  })

  const pairCode = state.pairCode && Date.parse(state.pairCode.expiresAt) > now
    ? state.pairCode
    : undefined

  return { sessions, pairCode }
}

function readAuthState(): LabnoteAuthState {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LabnoteAuthState>
    return pruneAuthState({
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      pairCode: parsed.pairCode,
    })
  } catch {
    return seedAuthState()
  }
}

function writeAuthState(state: LabnoteAuthState) {
  ensureDataDir()
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(pruneAuthState(state), null, 2)}\n`, 'utf-8')
}

function getSessionTokenFromRequest(req: { headers?: Record<string, string | string[] | undefined> }): string {
  const headerValue = req.headers?.[SESSION_HEADER]
  if (Array.isArray(headerValue)) return headerValue[0] ?? ''
  return typeof headerValue === 'string' ? headerValue : ''
}

function getRequestHost(req: { headers?: Record<string, string | string[] | undefined> }): string {
  const host = req.headers?.host
  if (Array.isArray(host)) return host[0] ?? ''
  return typeof host === 'string' ? host : ''
}

function getStateInfo(
  req: { headers?: Record<string, string | string[] | undefined> },
  authState: LabnoteAuthState,
  session: LabnoteAuthSession | null
) {
  ensureDataDir()
  const stateExists = fs.existsSync(DATA_FILE)
  const stateStat = stateExists ? fs.statSync(DATA_FILE) : undefined
  const host = getRequestHost(req)
  const isTailscaleHost = host.includes('.ts.net')
  const serverOrigin = host ? `${isTailscaleHost ? 'https' : 'http'}://${host}` : undefined
  const ownerExists = authState.sessions.some((item) => item.role === 'owner')
  const now = nowIso()
  return {
    ok: true,
    dataDir: DATA_DIR,
    uploadsDir: UPLOADS_DIR,
    uploadsUrl: UPLOAD_URL_PREFIX,
    stateFile: DATA_FILE,
    stateUpdatedAt: stateStat ? stateStat.mtime.toISOString() : undefined,
    serverTime: now,
    hostname: os.hostname(),
    serverOrigin,
    pairingRequired: true,
    paired: Boolean(session),
    pairCanGenerate: session?.role === 'owner',
    pairOwnerMissing: !ownerExists,
    pairCodeActive: Boolean(authState.pairCode),
    pairCodeExpiresAt: authState.pairCode?.expiresAt,
    sessionRole: session?.role,
    sessionDeviceName: session?.deviceName,
    tailscaleHost: isTailscaleHost ? host : undefined,
  }
}

function readJsonBody(req: { on: (event: string, handler: (chunk?: Buffer) => void) => void }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk?: Buffer) => {
      if (chunk) body += chunk.toString()
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function labnoteStore(): Plugin {
  const redeemAttempts = new Map<string, { attempts: number; windowStart: number; blockedUntil?: number }>()

  const loadAuthState = () => {
    const state = readAuthState()
    writeAuthState(state)
    return state
  }

  const findSession = (state: LabnoteAuthState, token: string) => {
    if (!token) return { index: -1, session: null as LabnoteAuthSession | null }
    const tokenHash = hashSecret(token)
    const index = state.sessions.findIndex((item) => item.tokenHash === tokenHash)
    if (index < 0) return { index: -1, session: null as LabnoteAuthSession | null }
    return { index, session: state.sessions[index] }
  }

  const touchSession = (state: LabnoteAuthState, index: number) => {
    if (index < 0) return
    state.sessions[index] = { ...state.sessions[index], lastSeenAt: nowIso() }
    writeAuthState(state)
  }

  const sendJson = (res: { setHeader: (name: string, value: string) => void; end: (chunk?: string) => void }, body: unknown) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  const unauthorized = (
    res: {
      statusCode: number
      setHeader: (name: string, value: string) => void
      end: (chunk?: string) => void
    },
    message = 'Pair code required.'
  ) => {
    res.statusCode = 401
    sendJson(res, { ok: false, unauthorized: true, error: message })
  }

  const forbidden = (
    res: {
      statusCode: number
      setHeader: (name: string, value: string) => void
      end: (chunk?: string) => void
    },
    message = 'Owner session required.'
  ) => {
    res.statusCode = 403
    sendJson(res, { ok: false, error: message })
  }

  const requireSession = (
    req: { headers?: Record<string, string | string[] | undefined> },
    res: {
      statusCode: number
      setHeader: (name: string, value: string) => void
      end: (chunk?: string) => void
    },
    opts?: { ownerOnly?: boolean }
  ) => {
    const state = loadAuthState()
    const token = getSessionTokenFromRequest(req)
    const { index, session } = findSession(state, token)
    if (!session) {
      unauthorized(res)
      return null
    }
    if (opts?.ownerOnly && session.role !== 'owner') {
      forbidden(res)
      return null
    }
    touchSession(state, index)
    return { state: loadAuthState(), session }
  }

  const getClientKey = (req: {
    headers?: Record<string, string | string[] | undefined>
    socket?: { remoteAddress?: string }
  }) => {
    const forwarded = req.headers?.['x-forwarded-for']
    const forwardedRaw = Array.isArray(forwarded) ? forwarded[0] : forwarded
    if (typeof forwardedRaw === 'string' && forwardedRaw.trim()) {
      return forwardedRaw.split(',')[0]?.trim() || 'unknown'
    }
    return req.socket?.remoteAddress ?? 'unknown'
  }

  const checkRateLimit = (clientKey: string) => {
    const now = Date.now()
    const existing = redeemAttempts.get(clientKey)
    if (!existing) {
      redeemAttempts.set(clientKey, { attempts: 0, windowStart: now })
      return { blocked: false, retryAfterSec: 0 }
    }
    if (existing.blockedUntil && existing.blockedUntil > now) {
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((existing.blockedUntil - now) / 1000)) }
    }
    if (now - existing.windowStart > PAIR_ATTEMPT_WINDOW_MS) {
      redeemAttempts.set(clientKey, { attempts: 0, windowStart: now })
      return { blocked: false, retryAfterSec: 0 }
    }
    return { blocked: false, retryAfterSec: 0 }
  }

  const noteFailedAttempt = (clientKey: string) => {
    const now = Date.now()
    const existing = redeemAttempts.get(clientKey)
    if (!existing || now - existing.windowStart > PAIR_ATTEMPT_WINDOW_MS) {
      redeemAttempts.set(clientKey, { attempts: 1, windowStart: now })
      return
    }
    const attempts = existing.attempts + 1
    if (attempts >= PAIR_ATTEMPT_LIMIT) {
      redeemAttempts.set(clientKey, {
        attempts,
        windowStart: existing.windowStart,
        blockedUntil: now + PAIR_ATTEMPT_BLOCK_MS,
      })
      return
    }
    redeemAttempts.set(clientKey, { ...existing, attempts })
  }

  const resetAttemptWindow = (clientKey: string) => {
    redeemAttempts.delete(clientKey)
  }

  return {
    name: 'labnote-store',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/info', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const authState = loadAuthState()
        const token = getSessionTokenFromRequest(req)
        const { index, session } = findSession(authState, token)
        if (index >= 0) touchSession(authState, index)
        const info = getStateInfo(req, loadAuthState(), session)
        res.setHeader('Cache-Control', 'no-store')
        sendJson(res, info)
      })

      server.middlewares.use('/api/pair/bootstrap', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const body = (await readJsonBody(req)) as { deviceName?: string }
          const authState = loadAuthState()
          if (authState.sessions.length > 0) {
            res.statusCode = 409
            sendJson(res, { ok: false, error: 'Pairing owner already exists.' })
            return
          }

          const sessionToken = createToken()
          const current = nowIso()
          authState.sessions.push({
            id: crypto.randomUUID(),
            role: 'owner',
            tokenHash: hashSecret(sessionToken),
            deviceName: normalizeDeviceName(body.deviceName, 'Primary desktop'),
            createdAt: current,
            lastSeenAt: current,
          })
          writeAuthState(authState)
          sendJson(res, { ok: true, sessionToken, role: 'owner' as const })
        } catch (err) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: String(err) })
        }
      })

      server.middlewares.use('/api/pair/code', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const sessionCtx = requireSession(req, res, { ownerOnly: true })
        if (!sessionCtx) return
        try {
          const body = (await readJsonBody(req)) as { ttlSeconds?: number }
          const ttlSeconds = clampPairTtlSeconds(body.ttlSeconds)
          const code = createPairCode()
          const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
          const authState = loadAuthState()
          authState.pairCode = {
            codeHash: hashSecret(normalizePairCode(code)),
            createdAt: nowIso(),
            expiresAt,
            createdBySessionId: sessionCtx.session.id,
          }
          writeAuthState(authState)
          sendJson(res, { ok: true, code, expiresAt, ttlSeconds })
        } catch (err) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: String(err) })
        }
      })

      server.middlewares.use('/api/pair/redeem', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const clientKey = getClientKey(req)
        const limit = checkRateLimit(clientKey)
        if (limit.blocked) {
          res.statusCode = 429
          sendJson(res, { ok: false, error: 'Too many attempts. Try again later.', retryAfterSec: limit.retryAfterSec })
          return
        }

        try {
          const body = (await readJsonBody(req)) as { code?: string; deviceName?: string }
          const normalizedCode = normalizePairCode(body.code ?? '')
          if (!normalizedCode) {
            noteFailedAttempt(clientKey)
            res.statusCode = 400
            sendJson(res, { ok: false, error: 'Pair code is required.' })
            return
          }

          const authState = loadAuthState()
          const pairCode = authState.pairCode
          if (!pairCode || Date.parse(pairCode.expiresAt) <= Date.now()) {
            authState.pairCode = undefined
            writeAuthState(authState)
            noteFailedAttempt(clientKey)
            res.statusCode = 400
            sendJson(res, { ok: false, error: 'Pair code expired. Generate a new code.' })
            return
          }

          if (pairCode.codeHash !== hashSecret(normalizedCode)) {
            noteFailedAttempt(clientKey)
            res.statusCode = 400
            sendJson(res, { ok: false, error: 'Invalid pair code.' })
            return
          }

          const sessionToken = createToken()
          const current = nowIso()
          authState.pairCode = undefined
          authState.sessions.push({
            id: crypto.randomUUID(),
            role: 'member',
            tokenHash: hashSecret(sessionToken),
            deviceName: normalizeDeviceName(body.deviceName, 'Paired mobile'),
            createdAt: current,
            lastSeenAt: current,
          })
          writeAuthState(authState)
          resetAttemptWindow(clientKey)
          sendJson(res, { ok: true, sessionToken, role: 'member' as const })
        } catch (err) {
          noteFailedAttempt(clientKey)
          res.statusCode = 400
          sendJson(res, { ok: false, error: String(err) })
        }
      })

      server.middlewares.use('/api/pair/logout', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const state = loadAuthState()
        const token = getSessionTokenFromRequest(req)
        const { index } = findSession(state, token)
        if (index < 0) {
          unauthorized(res)
          return
        }
        state.sessions.splice(index, 1)
        writeAuthState(state)
        sendJson(res, { ok: true })
      })

      server.middlewares.use(UPLOAD_URL_PREFIX, (req, res, next) => {
        if (!req.url) return next()
        if (req.method && req.method !== 'GET' && req.method !== 'HEAD') return next()
        const rel = decodeURIComponent(req.url.split('?')[0] ?? '').replace(/^\//, '')
        const fullPath = path.resolve(UPLOADS_DIR, rel)
        const root = path.resolve(UPLOADS_DIR)
        if (!fullPath.startsWith(root)) {
          res.statusCode = 400
          res.end()
          return
        }
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('Content-Type', mimeForExtension(path.extname(fullPath)))
        res.setHeader('Cache-Control', 'public, max-age=604800')
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        fs.createReadStream(fullPath).pipe(res)
      })

      server.middlewares.use('/api/state', async (req, res, next) => {
        if (!req.method) return next()
        const sessionCtx = requireSession(req, res)
        if (!sessionCtx) return

        if (req.method === 'GET') {
          const state = readState()
          res.setHeader('Cache-Control', 'no-store')
          sendJson(res, state)
          return
        }

        if (req.method === 'PATCH' || req.method === 'PUT') {
          try {
            const incoming = (await readJsonBody(req)) as Partial<LabnoteServerState>
            const current = readState()
            const nextState: LabnoteServerState = {
              version: STATE_VERSION,
              projects: Array.isArray(incoming.projects) ? incoming.projects : current.projects,
              experiments: Array.isArray(incoming.experiments) ? incoming.experiments : current.experiments,
              entries: normalizeEntries(incoming.entries, current.entries),
              attachments: Array.isArray(incoming.attachments) ? incoming.attachments : current.attachments,
            }
            writeState(nextState)
            sendJson(res, { ok: true })
          } catch (err) {
            res.statusCode = 400
            sendJson(res, { ok: false, error: String(err) })
          }
          return
        }

        return next()
      })

      server.middlewares.use('/api/reset', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const state = seedState()
        writeState(state)
        writeAuthState(seedAuthState())
        redeemAttempts.clear()
        sendJson(res, state)
      })

      server.middlewares.use('/api/upload', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const sessionCtx = requireSession(req, res)
        if (!sessionCtx) return
        try {
          const body = (await readJsonBody(req)) as { filename?: string; dataUrl?: string; type?: string }
          if (!body?.dataUrl) {
            res.statusCode = 400
            sendJson(res, { ok: false, error: 'Missing dataUrl' })
            return
          }
          const parsed = parseDataUrl(body.dataUrl)
          if (!parsed) {
            res.statusCode = 400
            sendJson(res, { ok: false, error: 'Invalid dataUrl' })
            return
          }
          ensureUploadsDir()
          const original = safeBaseName(body.filename ?? 'upload')
          const ext = path.extname(original) || extensionForMime(parsed.mime)
          const stem = original.replace(new RegExp(`${ext.replace('.', '\\.')}$`), '') || 'upload'
          const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const finalName = `${stem}-${suffix}${ext}`
          const fullPath = path.join(UPLOADS_DIR, finalName)
          fs.writeFileSync(fullPath, parsed.buffer)
          sendJson(res, { ok: true, url: `${UPLOAD_URL_PREFIX}${finalName}` })
        } catch (err) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: String(err) })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), labnoteStore()],
  publicDir: false,
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
  },
})
