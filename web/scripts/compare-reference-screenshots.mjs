import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { PNG } from 'pngjs'

const root = path.resolve(import.meta.dirname, '..', '..')

const pairs = [
  {
    name: 'note editor',
    screenshot: 'screenshots/01-dashboard.png',
    reference: 'chatgpt-generated-note-editor-reference.png',
    maxMad: 19,
    maxChanged24: 16,
    maxChanged48: 8.5,
  },
  {
    name: 'workbook',
    screenshot: 'screenshots/07-workbook.png',
    reference: 'chatgpt-generated-workbook-reference.png',
    maxMad: 19,
    maxChanged24: 17,
    maxChanged48: 8.5,
  },
  {
    name: 'file hub',
    screenshot: 'screenshots/06-file-hub.png',
    reference: 'chatgpt-generated-filehub-reference.png',
    maxMad: 18,
    maxChanged24: 12,
    maxChanged48: 8.5,
  },
]

function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value.startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args.set(value.slice(2), argv[index + 1])
      index += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const referenceDir = args.get('reference-dir') || process.env.LABNOTE_REFERENCE_DIR

if (!referenceDir) {
  console.error('Missing generated reference directory.')
  console.error('Set LABNOTE_REFERENCE_DIR or pass --reference-dir <folder> containing the ChatGPT reference PNGs.')
  process.exit(2)
}

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath))
}

function sampleNearest(image, x, y) {
  const sx = Math.max(0, Math.min(image.width - 1, Math.round(x)))
  const sy = Math.max(0, Math.min(image.height - 1, Math.round(y)))
  const index = (sy * image.width + sx) * 4
  return [image.data[index], image.data[index + 1], image.data[index + 2]]
}

function compareToScaledReference(screenshot, reference) {
  const pixelCount = screenshot.width * screenshot.height
  let totalDelta = 0
  let changed24 = 0
  let changed48 = 0

  for (let y = 0; y < screenshot.height; y += 1) {
    for (let x = 0; x < screenshot.width; x += 1) {
      const [referenceR, referenceG, referenceB] = sampleNearest(
        reference,
        (x * (reference.width - 1)) / (screenshot.width - 1),
        (y * (reference.height - 1)) / (screenshot.height - 1)
      )
      const screenshotIndex = (y * screenshot.width + x) * 4
      const delta =
        (Math.abs(screenshot.data[screenshotIndex] - referenceR) +
          Math.abs(screenshot.data[screenshotIndex + 1] - referenceG) +
          Math.abs(screenshot.data[screenshotIndex + 2] - referenceB)) /
        3

      totalDelta += delta
      if (delta > 24) changed24 += 1
      if (delta > 48) changed48 += 1
    }
  }

  return {
    mad: Number((totalDelta / pixelCount).toFixed(2)),
    changed24: Number(((changed24 * 100) / pixelCount).toFixed(2)),
    changed48: Number(((changed48 * 100) / pixelCount).toFixed(2)),
  }
}

let failures = 0

for (const pair of pairs) {
  const screenshotPath = path.resolve(root, pair.screenshot)
  const referencePath = path.resolve(referenceDir, pair.reference)

  if (!fs.existsSync(screenshotPath)) {
    console.error(`Missing screenshot for ${pair.name}: ${screenshotPath}`)
    failures += 1
    continue
  }

  if (!fs.existsSync(referencePath)) {
    console.error(`Missing generated reference for ${pair.name}: ${referencePath}`)
    failures += 1
    continue
  }

  const screenshot = readPng(screenshotPath)
  const reference = readPng(referencePath)
  const metrics = compareToScaledReference(screenshot, reference)
  const passed =
    metrics.mad <= pair.maxMad &&
    metrics.changed24 <= pair.maxChanged24 &&
    metrics.changed48 <= pair.maxChanged48

  const status = passed ? 'PASS' : 'FAIL'
  console.log(
    `${status} ${pair.name}: MAD ${metrics.mad}/${pair.maxMad}, ` +
      `changed>24 ${metrics.changed24}%/${pair.maxChanged24}%, ` +
      `changed>48 ${metrics.changed48}%/${pair.maxChanged48}%`
  )

  if (!passed) failures += 1
}

if (failures > 0) {
  process.exit(1)
}
