import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const playwrightCli = path.join(
  here,
  '..',
  'node_modules',
  'playwright',
  'cli.js'
)
const child = spawn(
  process.execPath,
  [playwrightCli, 'test', 'screenshots.spec.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      GENERATE_SCREENSHOTS: '1',
    },
  }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
