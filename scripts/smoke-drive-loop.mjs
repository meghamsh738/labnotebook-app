import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(process.env.LABNOTE_DRIVE_LOOP_OUTPUT_DIR || path.join(root, '.labnote-smoke', 'drive-loop'))
const resultFile = path.join(outputDir, 'result.json')
const stdoutFile = path.join(outputDir, 'stdout.log')
const stderrFile = path.join(outputDir, 'stderr.log')
const webRoot = path.join(root, 'web')
const playwrightCli = path.join(webRoot, 'node_modules', '@playwright', 'test', 'cli.js')
const testArgs = [
  playwrightCli,
  'test',
  '--project=desktop-chromium',
  '-g',
  'desktop-mobile-desktop capture sync',
]
const commandDisplay = `${process.execPath} ${testArgs.map((value) => JSON.stringify(value)).join(' ')}`

function writeResult(payload) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify({
    ...payload,
    writtenAt: new Date().toISOString(),
  }, null, 2))
}

fs.mkdirSync(outputDir, { recursive: true })
for (const child of ['result.json', 'stdout.log', 'stderr.log']) {
  fs.rmSync(path.join(outputDir, child), { force: true })
}

writeResult({ ok: null, stage: 'running', command: commandDisplay })
const startedAt = Date.now()
const result = spawnSync(process.execPath, testArgs, {
  cwd: webRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    CI: process.env.CI || '1',
  },
  maxBuffer: 10 * 1024 * 1024,
})
const elapsedMs = Date.now() - startedAt

fs.writeFileSync(stdoutFile, result.stdout || '')
fs.writeFileSync(stderrFile, result.stderr || '')

if (result.error) {
  writeResult({
    ok: false,
    stage: 'failed-to-start',
    message: result.error.message,
    command: commandDisplay,
    elapsedMs,
    stdoutFile,
    stderrFile,
  })
  console.error(result.error.message)
  process.exit(1)
}

if (result.status !== 0) {
  writeResult({
    ok: false,
    stage: 'failed',
    exitCode: result.status,
    signal: result.signal,
    command: commandDisplay,
    elapsedMs,
    stdoutFile,
    stderrFile,
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  process.exit(result.status || 1)
}

writeResult({
  ok: true,
  stage: 'passed',
  message: 'Desktop-mobile-desktop Drive loop smoke passed with on-demand attachment blobs.',
  command: commandDisplay,
  elapsedMs,
  stdoutFile,
  stderrFile,
})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
console.log(`Drive loop smoke evidence written to ${resultFile}`)
