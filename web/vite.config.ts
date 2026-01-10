import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

const STATE_VERSION = 1
const PROJECT_ROOT = path.resolve(process.cwd(), '..')
const DATA_DIR = process.env.LABNOTE_DATA_DIR ?? path.join(PROJECT_ROOT, '.labnote-data')
const DATA_FILE = path.join(DATA_DIR, 'labnote-state.json')
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
const UPLOAD_URL_PREFIX = '/labnote-uploads/'
const DIST_DIR = process.env.LABNOTE_DIST_DIR ?? path.join(PROJECT_ROOT, '.labnote-dist', 'web')

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

function getStateInfo() {
  ensureDataDir()
  const stateExists = fs.existsSync(DATA_FILE)
  const stateStat = stateExists ? fs.statSync(DATA_FILE) : undefined
  return {
    ok: true,
    dataDir: DATA_DIR,
    uploadsDir: UPLOADS_DIR,
    uploadsUrl: UPLOAD_URL_PREFIX,
    stateFile: DATA_FILE,
    stateUpdatedAt: stateStat ? stateStat.mtime.toISOString() : undefined,
    serverTime: new Date().toISOString(),
    hostname: os.hostname(),
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
  return {
    name: 'labnote-store',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/info', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const info = getStateInfo()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(info))
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

        if (req.method === 'GET') {
          const state = readState()
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(state))
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
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
          return
        }

        return next()
      })

      server.middlewares.use('/api/reset', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const state = seedState()
        writeState(state)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(state))
      })

      server.middlewares.use('/api/upload', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const body = (await readJsonBody(req)) as { filename?: string; dataUrl?: string; type?: string }
          if (!body?.dataUrl) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: 'Missing dataUrl' }))
            return
          }
          const parsed = parseDataUrl(body.dataUrl)
          if (!parsed) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: 'Invalid dataUrl' }))
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
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, url: `${UPLOAD_URL_PREFIX}${finalName}` }))
        } catch (err) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: String(err) }))
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
