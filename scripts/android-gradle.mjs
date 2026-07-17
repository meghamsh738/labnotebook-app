import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const androidDir = join(repoRoot, 'android')
const candidates = [
  process.env.JAVA_HOME,
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  join(homedir(), '.cache', 'labnote-jdk21'),
].filter(Boolean)

const javaHome = candidates.find((candidate) => existsSync(join(candidate, 'bin', 'java')))
if (!javaHome) {
  console.error('Java 21 was not found. Install Android Studio or set JAVA_HOME before building Android.')
  process.exit(1)
}

const args = process.argv.slice(2)
const result = spawnSync(join(androidDir, 'gradlew'), args, {
  cwd: androidDir,
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
  },
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
