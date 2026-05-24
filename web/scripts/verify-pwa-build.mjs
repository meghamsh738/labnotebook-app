import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd(), '..')
const distDir = process.env.LABNOTE_DIST_DIR
  ? path.resolve(process.env.LABNOTE_DIST_DIR)
  : path.join(root, '.labnote-dist', 'web')

function fail(message) {
  console.error(`PWA build verification failed: ${message}`)
  process.exit(1)
}

function readRequired(relativePath) {
  const fullPath = path.join(distDir, relativePath)
  if (!fs.existsSync(fullPath)) fail(`missing ${relativePath} in ${distDir}`)
  return fs.readFileSync(fullPath, 'utf-8')
}

const indexHtml = readRequired('index.html')
if (!indexHtml.includes('rel="manifest"') || !indexHtml.includes('/manifest.webmanifest')) {
  fail('index.html does not link manifest.webmanifest')
}

const manifest = JSON.parse(readRequired('manifest.webmanifest'))
if (manifest.name !== 'Easylab Lab Notebook') fail('manifest name is incorrect')
if (manifest.display !== 'standalone') fail('manifest display must be standalone')
if (!manifest.start_url || !manifest.scope) fail('manifest start_url and scope are required')
if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) fail('manifest needs at least one icon')
if (!manifest.icons.some((icon) => String(icon.src || '').includes('pwa-icon.svg'))) fail('manifest does not reference pwa-icon.svg')
if (!manifest.share_target?.params?.files?.length) fail('manifest share_target files are missing')

const serviceWorker = readRequired('service-worker.js')
if (!serviceWorker.includes('install') || !serviceWorker.includes('fetch')) {
  fail('service-worker.js does not include install and fetch handlers')
}

readRequired('pwa-icon.svg')

console.log(`PWA build verification passed for ${distDir}`)
