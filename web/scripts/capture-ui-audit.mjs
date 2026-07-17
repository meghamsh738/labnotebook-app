import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildUiReviewFixture, installUiReviewFixture } from './ui-review-fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const baseUrl = process.env.UI_AUDIT_BASE_URL ?? 'http://127.0.0.1:5173'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve(
  process.env.UI_AUDIT_OUT ?? path.join(repoRoot, 'output', `extended-pro-review-${stamp}`),
)
const screenshotDir = path.join(outDir, 'screenshots')
const fixture = buildUiReviewFixture()
const requestedViewports = new Set((process.env.UI_AUDIT_VIEWPORTS ?? '').split(',').filter(Boolean))
const requestedStates = new Set((process.env.UI_AUDIT_STATES ?? '').split(',').filter(Boolean))

const viewports = [
  ['desktop-1212x656', { width: 1212, height: 656 }],
  ['wide-1440x900', { width: 1440, height: 900 }],
  ['tablet-820x1180', { width: 820, height: 1180 }],
  ['phone-390x844', { width: 390, height: 844 }],
]

const states = [
  {
    name: 'auth-gate',
    url: '/',
    fixture: false,
    expectedSelector: '[data-testid="auth-gate"]',
  },
  {
    name: 'today-note-view',
    expectedSelector: '[data-testid="entry-view"]',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-note"]')
      await ensureEntryViewMode(page)
    },
  },
  {
    name: 'today-note-edit',
    expectedSelector: '[data-testid="slate-editor"]',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-note"]')
      await ensureEntryEditMode(page)
      const editor = page.getByTestId('slate-editor')
      if (await editor.isVisible().catch(() => false)) {
        await editor.click()
        await page.keyboard.press('End')
      }
    },
  },
  {
    name: 'today-note-more-menu',
    expectedSelector: '.toolbar-popover',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-note"]')
      await ensureEntryEditMode(page)
      const mobileMore = page.getByRole('button', { name: 'More formatting options' })
      if (await mobileMore.isVisible().catch(() => false)) {
        await mobileMore.click()
        return
      }
      const desktopMore = page.getByTestId('editor-toolbar').getByRole('button', { name: /more/i }).last()
      if (await desktopMore.isVisible().catch(() => false)) await desktopMore.click()
    },
  },
  {
    name: 'mobile-capture-sheet',
    viewports: ['phone-390x844'],
    expectedSelector: '[data-testid="mobile-capture-sheet"]',
    action: async (page) => {
      const capture = page.getByTestId('mobile-nav-capture')
      if (await capture.isVisible().catch(() => false)) await capture.click()
    },
  },
  {
    name: 'today-workbook',
    expectedSelector: '[data-testid="entry-workbook"]',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-workbook"]')
    },
  },
  {
    name: 'today-workbook-enter',
    expectedSelector: 'input[data-workbook-row="2"][data-workbook-col="0"]:focus',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-workbook"]')
      const cell = page.locator('input[data-workbook-row="1"][data-workbook-col="0"]')
      if (await cell.isVisible().catch(() => false)) {
        await cell.click()
        await page.keyboard.press('Enter')
      }
    },
  },
  {
    name: 'today-files-tab',
    expectedSelector: '.files-tab-panel',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-files"]')
    },
  },
  {
    name: 'today-details',
    expectedSelector: '.details-tab-panel',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      const openedFromTab = await clickIfVisible(page, '[data-testid="editor-tab-details"]')
      if (!openedFromTab) await clickIfVisible(page, '[data-testid="entry-tags-inline"]')
    },
  },
  {
    name: 'today-files-incoming',
    expectedSelector: '[data-testid="entry-filebox-panel"]',
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.populatedEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-files"]')
    },
  },
  {
    name: 'blank-entry-note',
    expectedSelector: '[data-testid="entry-view"]',
    verify: async (page) => {
      const dateBucket = page.getByTestId('entry-date-bucket')
      return (await dateBucket.count()) > 0 && (await dateBucket.textContent())?.trim() === fixture.ids.blankEntryDateBucket
    },
    action: async (page) => {
      await selectFixtureEntry(page, fixture.ids.blankEntry)
      await clickIfVisible(page, '[data-testid="editor-tab-note"]')
      await ensureEntryViewMode(page)
    },
  },
  {
    name: 'protocols',
    expectedSelector: '[data-testid="protocol-view"]',
    action: async (page) => {
      await navigateToPrimaryPane(page, 'Protocols')
      await clickIfVisible(page, `[data-testid="protocol-list"] button`)
    },
  },
  {
    name: 'file-hub',
    expectedSelector: '[data-testid="file-hub-pane"]',
    action: async (page) => {
      await navigateToPrimaryPane(page, 'Files')
    },
  },
  {
    name: 'file-hub-search',
    expectedSelector: '[data-testid="file-hub-pane"]',
    action: async (page) => {
      await navigateToPrimaryPane(page, 'Files')
      const search = page.locator('.filehub-search input')
      if (await search.isVisible().catch(() => false)) await search.fill('TNF')
    },
  },
  {
    name: 'sync',
    expectedSelector: '[data-testid="sync-pane"]',
    action: async (page) => {
      await navigateToPrimaryPane(page, 'Sync')
    },
  },
  {
    name: 'sync-notebook-settings',
    expectedSelector: '[data-testid="sync-pane"] .sync-status-card details[open]',
    action: async (page) => {
      await navigateToPrimaryPane(page, 'Sync')
      await clickDetailsSummary(page, 'Notebook settings')
    },
  },
  {
    name: 'sync-advanced',
    expectedSelector: '[data-testid="sync-pane"] .sync-diagnostics[open]',
    action: async (page) => {
      await navigateToPrimaryPane(page, 'Sync')
      await page.evaluate(() => {
        const disclosure = document.querySelector('[data-testid="sync-pane"] .sync-diagnostics')
        if (disclosure instanceof HTMLDetailsElement) disclosure.open = true
      })
      await page.waitForTimeout(180)
    },
  },
  {
    name: 'settings',
    expectedSelector: '[data-testid="mobile-settings-pane"], [role="dialog"]',
    action: async (page) => {
      await openSettings(page)
    },
  },
  {
    name: 'settings-advanced',
    expectedSelector: '[data-testid="settings-advanced"][open]',
    action: async (page) => {
      await openSettings(page)
      const mobileDisclosure = page.locator('[data-testid="mobile-settings-pane"] .mobile-settings-disclosure > summary')
      if (await mobileDisclosure.isVisible().catch(() => false)) {
        await mobileDisclosure.click()
        await page.waitForTimeout(120)
      }
      const openAdvanced = page.getByRole('button', { name: 'Open Advanced' })
      if (await openAdvanced.isVisible().catch(() => false)) await openAdvanced.click()
      const advanced = page.getByTestId('settings-advanced')
      if (await advanced.isVisible().catch(() => false)) {
        const isOpen = await advanced.evaluate((element) => element.hasAttribute('open'))
        if (!isOpen) await advanced.locator('summary').click()
      }
    },
  },
]

async function clickIfVisible(page, selector) {
  const locator = page.locator(selector).first()
  if ((await locator.count()) === 0) return false
  if (!(await locator.isVisible())) return false
  await locator.click({ timeout: 1_200 })
  await page.waitForTimeout(180)
  return true
}

async function selectFixtureEntry(page, entryId) {
  const entry = page.getByTestId(`entry-list-item-${entryId}`)
  if (await entry.isVisible().catch(() => false)) {
    await entry.click()
    await assertNarrowSidebarClosed(page)
    return
  }
  const mobileMenu = page.getByTestId('mobile-open-sidebar')
  if (await mobileMenu.isVisible().catch(() => false)) {
    await mobileMenu.click()
    await page.waitForTimeout(120)
    if (await entry.isVisible().catch(() => false)) {
      await entry.click()
      await assertNarrowSidebarClosed(page)
      return
    }
  }
  throw new Error(`Required fixture entry was not reachable: ${entryId}`)
}

async function assertNarrowSidebarClosed(page) {
  const viewportWidth = page.viewportSize()?.width ?? Number.POSITIVE_INFINITY
  if (viewportWidth > 1023) return
  await page
    .locator('aside[aria-label="Lab navigation"].mobile-open')
    .waitFor({ state: 'detached', timeout: 1_200 })
}

async function ensureEntryViewMode(page) {
  const save = page.getByTestId('entry-save')
  if (!(await save.isVisible().catch(() => false))) return
  const cancel = page.locator('.editor-header .edit-actions').getByRole('button', { name: 'Cancel' })
  if (await cancel.isVisible().catch(() => false)) await cancel.click()
}

async function ensureEntryEditMode(page) {
  const save = page.getByTestId('entry-save')
  if (await save.isVisible().catch(() => false)) return
  const edit = page.getByTestId('edit-note-btn')
  if (await edit.isVisible().catch(() => false)) await edit.click()
}

async function navigateToPrimaryPane(page, label) {
  const mobileTestId = {
    Files: 'mobile-nav-files',
    Sync: 'mobile-nav-sync',
  }[label]
  if (mobileTestId) {
    const mobileButton = page.getByTestId(mobileTestId)
    if (await mobileButton.isVisible().catch(() => false)) {
      await mobileButton.click()
      await page.waitForTimeout(180)
      return true
    }
  }

  const tab = page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: label, exact: true })
  if (await tab.isVisible().catch(() => false)) {
    await tab.click()
    await page.waitForTimeout(180)
    return true
  }

  const mobileMenu = page.getByTestId('mobile-open-sidebar')
  if (await mobileMenu.isVisible().catch(() => false)) {
    await mobileMenu.click()
    await page.waitForTimeout(120)
    if (await tab.isVisible().catch(() => false)) {
      await tab.click()
      await page.waitForTimeout(180)
      return true
    }
  }
  return false
}

async function clickDetailsSummary(page, label) {
  const summary = page.locator('summary').filter({ hasText: label }).first()
  if (await summary.isVisible().catch(() => false)) {
    await summary.click()
    await page.waitForTimeout(180)
    return true
  }
  return false
}

async function openSettings(page) {
  if (await navigateToPrimaryPane(page, 'Settings')) return true
  const settings = page.getByTestId('settings-button')
  if (await settings.isVisible().catch(() => false)) {
    await settings.click()
    await page.waitForTimeout(180)
    return true
  }
  return false
}

async function diagnostics(page, consoleMessages) {
  const pageDiagnostics = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const root = document.scrollingElement ?? document.documentElement
    const visible = (element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const intersectsViewport = (element) => {
      const rect = element.getBoundingClientRect()
      return rect.right > 0 && rect.left < viewportWidth && rect.bottom > 0 && rect.top < viewportHeight
    }
    const hasScrollableAncestor = (element) => {
      let node = element.parentElement
      while (node && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node)
        const scrollsX = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 2
        const scrollsY = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2
        if (scrollsX || scrollsY) return true
        node = node.parentElement
      }
      return false
    }
    const describe = (element) => {
      const rect = element.getBoundingClientRect()
      return {
        selector: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        testId: element.getAttribute('data-testid') ?? '',
        text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }

    const candidates = Array.from(document.querySelectorAll(
      'main, aside, section, header, button, input, summary, [role="tab"], .pill, .status-chip',
    )).filter(visible)
    const outOfBounds = candidates
      .filter((element) => !hasScrollableAncestor(element))
      .map(describe)
      .filter((item) => item.right > viewportWidth + 2 || item.left < -2 || item.top < -40 || (!root.scrollHeight && item.bottom > viewportHeight + 40))
      .slice(0, 40)
    const clippedControls = Array.from(document.querySelectorAll('button, summary, [role="tab"], .pill'))
      .filter(visible)
      .filter((element) => element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)
      .map(describe)
      .slice(0, 40)
    const undersizedTapTargets = viewportWidth <= 820
      ? Array.from(document.querySelectorAll('button, summary, [role="tab"], input[type="button"], input[type="submit"]'))
        .filter((element) => visible(element) && intersectsViewport(element))
        .map(describe)
        .filter((item) => item.width < 40 || item.height < 40)
        .slice(0, 50)
      : []
    const blankSurfaces = Array.from(document.querySelectorAll(
      'main.panel.editor, .editor-workspace .tab-panel, .editor-workspace .editor-surface',
    ))
      .filter(visible)
      .map((element) => ({ ...describe(element), contentLength: (element.textContent ?? '').trim().length }))
      .filter((item) => item.contentLength < 35 && item.height > 160)
    const fixedElements = Array.from(document.querySelectorAll('*'))
      .filter(visible)
      .filter((element) => ['fixed', 'sticky'].includes(window.getComputedStyle(element).position))
      .map(describe)
      .slice(0, 30)
    const header = document.querySelector('.editor-header')
    const workspace = document.querySelector('.editor-workspace')
    const visibleTabSurface = Array.from(document.querySelectorAll(
      '.editor-workspace .tab-panel, .editor-workspace .editor-surface, .editor-workspace [data-testid="entry-view"].blocks',
    )).find(visible)
    const rectTop = (element) => element ? Math.round(element.getBoundingClientRect().top) : null
    const rectBottom = (element) => element ? Math.round(element.getBoundingClientRect().bottom) : null
    const frameworkOverlay = Array.from(document.querySelectorAll('body *')).some((element) => {
      const text = (element.textContent ?? '').toLowerCase()
      return visible(element) && (text.includes('vite internal server error') || text.includes('uncaught runtime error'))
    })

    return {
      title: document.title,
      url: location.href,
      viewport: { width: viewportWidth, height: viewportHeight },
      scroll: { width: root.scrollWidth, height: root.scrollHeight },
      overflowX: root.scrollWidth > viewportWidth + 1,
      overflowY: root.scrollHeight > viewportHeight + 1,
      outOfBounds,
      clippedControls,
      undersizedTapTargets,
      blankSurfaces,
      fixedElements,
      frameworkOverlay,
      editorBaseline: {
        headerBottom: rectBottom(header),
        workspaceTop: rectTop(workspace),
        contentTop: rectTop(visibleTabSurface),
      },
      activeElement: document.activeElement ? describe(document.activeElement) : null,
    }
  })

  return { ...pageDiagnostics, consoleMessages }
}

async function createContactSheet(browser, viewportName, screenshots) {
  if (!screenshots.length) return null
  const isNarrow = viewportName.startsWith('phone') || viewportName.startsWith('tablet')
  const columns = viewportName.startsWith('phone') ? 4 : viewportName.startsWith('tablet') ? 3 : 2
  const cardWidth = viewportName.startsWith('phone') ? 300 : viewportName.startsWith('tablet') ? 390 : 650
  const encoded = await Promise.all(screenshots.map(async ({ stateName, filePath }) => ({
    stateName,
    src: `data:image/png;base64,${(await fs.readFile(filePath)).toString('base64')}`,
  })))
  const page = await browser.newPage({ viewport: { width: columns * cardWidth + 48, height: 900 } })
  await page.setContent(`<!doctype html>
    <html><head><style>
      *{box-sizing:border-box}body{margin:0;padding:18px;background:#e7ebe8;color:#10231d;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      h1{margin:0 0 14px;font-size:22px}.grid{display:grid;grid-template-columns:repeat(${columns},${cardWidth}px);gap:14px}
      figure{margin:0;background:white;border:1px solid #bfc9c4;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(16,35,29,.08)}
      figcaption{padding:8px 10px;font-weight:700;border-bottom:1px solid #dce3df;text-transform:capitalize}
      img{display:block;width:100%;height:auto;background:white}${isNarrow ? 'figure{align-self:start}' : ''}
    </style></head><body><h1>Easylab · ${viewportName}</h1><div class="grid">
      ${encoded.map(({ stateName, src }) => `<figure><figcaption>${stateName.replaceAll('-', ' ')}</figcaption><img src="${src}" /></figure>`).join('')}
    </div></body></html>`)
  await page.waitForLoadState('load')
  const filePath = path.join(outDir, `contact-sheet-${viewportName}.png`)
  await page.screenshot({ path: filePath, fullPage: true })
  await page.close()
  return filePath
}

function markdownTable(rows) {
  return [
    '| Viewport | State | Reached | Screenshot |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.viewportName} | ${row.stateName} | ${row.reached ? 'Yes' : 'No'} | screenshots/${path.basename(row.filePath)} |`),
  ].join('\n')
}

await fs.mkdir(screenshotDir, { recursive: true })

const browser = await chromium.launch()
const results = []
const screenshotGroups = new Map()

for (const [viewportName, viewport] of viewports) {
  if (requestedViewports.size && !requestedViewports.has(viewportName)) continue
  for (const state of states) {
    if (requestedStates.size && !requestedStates.has(state.name)) continue
    if (state.viewports && !state.viewports.includes(viewportName)) continue
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    if (state.fixture !== false) await installUiReviewFixture(context, fixture)
    const page = await context.newPage()
    const consoleMessages = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push({ type: message.type(), text: message.text().slice(0, 500) })
      }
    })
    page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: String(error).slice(0, 500) }))
    const url = `${baseUrl}${state.url ?? '/'}`
    const captureName = `${viewportName}-${state.name}`
    const filePath = path.join(screenshotDir, `${captureName}.png`)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      await page.waitForTimeout(700)
      if (state.action) await state.action(page)
      await page.waitForTimeout(260)
      const expected = page.locator(state.expectedSelector).first()
      const reached = state.verify
        ? await state.verify(page)
        : (await expected.count()) > 0 && await expected.isVisible().catch(() => false)
      await page.screenshot({ path: filePath, fullPage: false })
      const result = {
        viewportName,
        stateName: state.name,
        filePath,
        ok: true,
        reached,
        expectedSelector: state.expectedSelector,
        ...(await diagnostics(page, consoleMessages)),
      }
      results.push(result)
      if (!screenshotGroups.has(viewportName)) screenshotGroups.set(viewportName, [])
      screenshotGroups.get(viewportName).push({ stateName: state.name, filePath })
    } catch (error) {
      results.push({
        viewportName,
        stateName: state.name,
        filePath,
        ok: false,
        reached: false,
        expectedSelector: state.expectedSelector,
        error: String(error),
        consoleMessages,
      })
    } finally {
      await context.close()
    }
  }
}

const contactSheets = []
for (const [viewportName, screenshots] of screenshotGroups.entries()) {
  const contactSheet = await createContactSheet(browser, viewportName, screenshots)
  if (contactSheet) contactSheets.push(contactSheet)
}
await browser.close()

await fs.writeFile(path.join(outDir, 'diagnostics.json'), JSON.stringify(results, null, 2))
await fs.writeFile(path.join(outDir, 'fixture-summary.json'), JSON.stringify(fixture.summary, null, 2))

const failedStates = results.filter((result) => !result.ok || !result.reached)
const issueSummary = {
  states: results.length,
  failedCaptures: results.filter((result) => !result.ok).length,
  unreachableStates: results.filter((result) => result.ok && !result.reached).map((result) => `${result.viewportName}/${result.stateName}`),
  overflowX: results.filter((result) => result.overflowX).map((result) => `${result.viewportName}/${result.stateName}`),
  clippedControls: results.reduce((count, result) => count + (result.clippedControls?.length ?? 0), 0),
  outOfBounds: results.reduce((count, result) => count + (result.outOfBounds?.length ?? 0), 0),
  blankSurfaces: results.reduce((count, result) => count + (result.blankSurfaces?.length ?? 0), 0),
  relevantConsoleMessages: results.reduce((count, result) => count + (result.consoleMessages?.length ?? 0), 0),
}
await fs.writeFile(path.join(outDir, 'diagnostics-summary.json'), JSON.stringify(issueSummary, null, 2))

await fs.writeFile(path.join(outDir, 'SCREENSHOTS_MANIFEST.md'), `# Easylab UI Review Screenshot Manifest

Generated from the local development preview with fabricated review-only data. No real account, Drive, or lab data is present.

## Fixture

- ${fixture.summary.entries} dated entries, including one populated day and one blank day
- ${fixture.summary.projects} projects
- ${fixture.summary.protocols} protocols
- ${fixture.summary.attachments} attachment records
- ${fixture.summary.waitingFiles} waiting files
- ${fixture.summary.transfers} recent transfers

## Contact Sheets

${contactSheets.map((filePath) => `- ${path.basename(filePath)}`).join('\n')}

## Captures

${markdownTable(results)}

## Capture Health

- Failed captures: ${issueSummary.failedCaptures}
- Unreachable states: ${issueSummary.unreachableStates.length}
- Horizontal overflow states: ${issueSummary.overflowX.length}
- Clipped controls recorded: ${issueSummary.clippedControls}
- Out-of-bounds elements recorded: ${issueSummary.outOfBounds}
- Blank large surfaces recorded: ${issueSummary.blankSurfaces}
- Console warnings/errors recorded: ${issueSummary.relevantConsoleMessages}

${failedStates.length ? `Review diagnostics.json for ${failedStates.length} failed or unreachable states.` : 'Every requested state was reached.'}
`)

await fs.writeFile(path.join(outDir, 'CURRENT_STATE_AND_GOAL.md'), `# Easylab Current State And Review Goal

Easylab is a Google Drive-backed research journal shared across web/PWA, Electron desktop, and Capacitor Android. Local storage is an offline cache scoped to the connected Google account.

## Product Goal

Make the application feel like a finished professional note-taking product for laboratory work, not a project dashboard. Desktop should support detailed writing and workbook work. Phone should prioritize quick notes, camera/files, recent entries, and reliable sync.

## Review Focus

- Awkward or inconsistent placement of actions, tabs, tags, status labels, and floating controls
- Controls that are hidden, clipped, difficult to discover, or placed differently between tabs
- Blank tabs and weak empty states
- Layout movement when switching Note, Workbook, Files, Details, and Inbox
- Mobile density, bottom-navigation safety, one-handed capture, and professional note-taking conventions
- Desktop and tablet use of space, hierarchy, sidebar density, and workbook ergonomics
- Accessibility risks visible from screenshots: contrast, target size, text wrapping, focus/disclosure clarity

## Technical Constraints

- Preserve Google Drive account-first sync
- Preserve Drive schema and folder layout
- Preserve token storage and account isolation
- Preserve the shared React UI used by PWA, Electron, and Capacitor
- Do not recommend a custom backend as part of this UI pass
`)

await fs.writeFile(path.join(outDir, 'PROMPT_FOR_EXTENDED_PRO.md'), `You are reviewing Easylab as a near-release professional research journal, not as a prototype or developer dashboard.

The attached contact sheets and full-resolution screenshots show the same fabricated notebook across desktop (1212x656 and 1440x900), tablet (820x1180), and phone (390x844). The capture process exercised view/edit mode, the editor More menu, workbook keyboard movement, populated and blank entries, Files, Details, Inbox, Protocols, global Files search, Google Drive Sync, and Settings.

Please perform a deep UI and interaction review. Pay special attention to the problems already observed:

- awkward or inconsistent action placement
- buttons that are clipped, hidden, or difficult to discover
- tabs starting at different vertical positions or changing layout when selected
- blank tabs and weak empty states
- excessive whitespace versus cramped controls
- desktop patterns squeezed onto phone
- floating actions or navigation covering content
- toolbar and workbook ergonomics
- visual patterns that make the app feel AI-generated rather than intentionally designed

The phone product should prioritize quick capture: notes, photos/files, recent entries, and sync. Workbook and advanced tools may be secondary, but must remain usable.

Return a decision-complete Codex roadmap with:

1. Overall verdict and the five most important professional-app gaps.
2. P0/P1/P2 findings tied to exact screenshot labels.
3. Screen-by-screen fixes for desktop, tablet, and phone.
4. Navigation and information-architecture changes, including whether Files and Inbox should remain separate.
5. Exact recommendations for action placement, tabs, empty states, toolbar overflow, workbook controls, and responsive behavior.
6. Accessibility risks visible from the evidence and additional checks required beyond screenshots.
7. A practical implementation sequence for React/CSS with acceptance criteria and regression tests.

Constraints: preserve Google Drive account-first behavior, Drive schema, OAuth/token storage, account-scoped offline cache, and the shared React/Capacitor/Electron product. Do not propose a paid backend or a native rewrite in this pass. Do not include generic design advice; every recommendation should point to visible evidence and tell Codex what to change.
`)

console.log(outDir)
