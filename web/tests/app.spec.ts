import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))

const defaultPaths = {
  dataRoot: 'C:\\\\Easylab\\\\data',
  attachmentsRoot: 'C:\\\\Easylab\\\\attachments',
  exportRoot: 'C:\\\\Easylab\\\\exports',
  syncRoot: 'C:\\\\Easylab\\\\sync',
}

async function boot(
  page: Page,
  opts?: {
    noFail?: '0' | '1'
    failNext?: boolean
    stubPicker?: boolean
    setupComplete?: boolean
    appPaths?: typeof defaultPaths
  }
) {
  const initOpts = { noFail: '1', setupComplete: true, ...opts }
  if (initOpts.setupComplete !== false && !initOpts.appPaths) {
    initOpts.appPaths = defaultPaths
  }
  await page.addInitScript((o) => {
    window.localStorage.clear()
    ;(window as unknown as { __labnoteMockSync?: { noFail?: boolean; failNext?: boolean } }).__labnoteMockSync = {
      noFail: o?.noFail === '1',
      failNext: !!o?.failNext,
    }
    if (o?.noFail) window.localStorage.setItem('labnote.mockSync.noFail', o.noFail)
    if (o?.failNext) window.localStorage.setItem('labnote.mockSync.failNext', '1')
    if (o?.setupComplete !== false) {
      const paths = o?.appPaths
      window.localStorage.setItem('labnote.setupComplete', '1')
      window.localStorage.setItem('labnote.appPaths', JSON.stringify(paths))
      window.localStorage.setItem('labnote.masterSyncPath', paths.syncRoot)
    }
    if (o?.stubPicker) {
      ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined
    }
  }, initOpts)
  await page.goto('/')
}

async function ensureEditMode(page: Page) {
  await page.waitForSelector('[data-testid="entry-save"], button:has-text("Edit")')
  const saveButton = page.getByTestId('entry-save')
  if ((await saveButton.count()) === 0) {
    const editButton = page.getByRole('button', { name: 'Edit' })
    await editButton.click()
  }
  await expect(saveButton).toBeVisible()
}

async function ensureViewMode(page: Page) {
  await page.waitForSelector('[data-testid="entry-save"], button:has-text("Edit")')
  const saveButton = page.getByTestId('entry-save')
  if (await saveButton.count()) {
    await page.getByRole('button', { name: 'Cancel' }).click()
  }
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
}

async function focusBlockById(page: Page, blockId: string) {
  await page.evaluate((id) => {
    const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
    editor?.focus()
    const block = document.querySelector(`[data-block-id="${id}"]`)
    if (!block) return
    const textSpan = block.querySelector('[data-slate-node="text"]')
    const range = document.createRange()
    if (textSpan) {
      range.selectNodeContents(textSpan)
      range.collapse(true)
    } else {
      range.selectNodeContents(block)
      range.collapse(true)
    }
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
  }, blockId)
}

async function focusTestIdText(page: Page, testId: string) {
  await page.evaluate((id) => {
    const target = document.querySelector(`[data-testid="${id}"]`)
    if (!target) return
    const textSpan = target.querySelector('[data-slate-node="text"]')
    const range = document.createRange()
    if (textSpan) {
      range.selectNodeContents(textSpan)
      range.collapse(true)
    } else {
      range.selectNodeContents(target)
      range.collapse(true)
    }
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
    const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
    editor?.focus()
  }, testId)
}

async function clearDateFilters(page: Page) {
  const clearButton = page.getByTestId('calendar-clear')
  if (await clearButton.count()) {
    await clearButton.click()
  }
  const rangeClear = page.getByTestId('date-range-clear')
  if (await rangeClear.count()) {
    await rangeClear.click()
  }
}

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(page.getByRole('heading', { name: /neuroimmunology lab/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /today's entry/i })).toBeVisible()
    await expect(page.getByTestId('project-tag-filter-trigger')).toBeVisible()
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
    await expect(page.getByTestId('calendar')).toBeVisible()
  })

  test('first run setup requires storage paths', async ({ page }) => {
    await boot(page, { noFail: '1', setupComplete: false })
    const setupDialog = page.getByTestId('setup-dialog')
    await expect(setupDialog).toBeVisible()

    await page.getByTestId('setup-data-root').fill('C:\\\\LabNotes\\\\Alpha\\\\data')
    await page.getByTestId('setup-attachments-root').fill('C:\\\\LabNotes\\\\Alpha\\\\attachments')
    await page.getByTestId('setup-export-root').fill('C:\\\\LabNotes\\\\Alpha\\\\exports')
    await page.getByTestId('setup-sync-root').fill('C:\\\\LabNotes\\\\Alpha\\\\sync')
    await page.getByTestId('setup-complete').click()

    await expect(page.getByTestId('setup-dialog')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
  })

  test('today entry opens with the guided template', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible()
  })

  test('header collapses while keeping tools visible', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const header = page.getByTestId('editor-header')
    await expect(header).toBeVisible()
    await expect(page.getByTestId('entry-tags-inline')).toBeVisible()

    await page.getByTestId('header-toggle').click()
    await expect(header).toHaveClass(/collapsed/)
    await expect(page.getByTestId('entry-tags-inline')).toBeHidden()
    await expect(page.getByTestId('editor-toolbar')).toBeVisible()

    await page.getByTestId('header-toggle').click()
    await expect(page.getByTestId('entry-tags-inline')).toBeVisible()
  })

  test('can add a missed entry from the calendar', async ({ page }) => {
    await boot(page, { noFail: '1' })

    const targetIso = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid^="calendar-day-"]'))
      const candidate = buttons.find((btn) => !btn.classList.contains('has-entry') && !btn.classList.contains('outside'))
      if (!candidate) return null
      const testId = candidate.getAttribute('data-testid') ?? ''
      return testId.replace('calendar-day-', '')
    })

    if (!targetIso) throw new Error('No available calendar day without entry.')

    await page.getByTestId(`calendar-day-${targetIso}`).click()
    const createButton = page.getByTestId('calendar-create-entry')
    await expect(createButton).toBeVisible()
    await createButton.click()
    await ensureEditMode(page)
    await expect(page.getByTestId('entry-date-bucket')).toHaveText(targetIso)
  })

  test('guided template prompts clear on input', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const guideText =
      'What question are you answering today? Include model, conditions, and expected outcome.'
    const guideLocator = page.getByText(guideText)
    await expect(guideLocator).toBeVisible()

    await focusBlockById(page, 'b-context')
    await page.keyboard.type('Testing placeholder clearing')

    await expect(guideLocator).toHaveCount(0)
  })

  test('guided template prompt does not duplicate on line breaks', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const guideText =
      'What question are you answering today? Include model, conditions, and expected outcome.'

    await focusBlockById(page, 'b-context')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await expect(page.getByText(guideText)).toHaveCount(1)
  })

  test('undo and redo restore the latest edit', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.evaluate((blockId) => {
      const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      editor?.focus()
      const block = document.querySelector(`[data-block-id="${blockId}"]`)
      if (!block) return
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    }, 'b-context')
    await page.keyboard.insertText('Undo me')

    const editor = page.getByTestId('slate-editor')
    await expect(editor).toContainText('Undo me')
    await expect(page.getByTestId('editor-undo')).toBeEnabled()
    await page.getByTestId('editor-undo').click()
    await expect(editor).not.toContainText('Undo me')
    await expect(page.getByTestId('editor-redo')).toBeEnabled()
    await page.getByTestId('editor-redo').click()
    await expect(editor).toContainText('Undo me')
  })

  test('symbol list inserts a bulleted line', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.getByTestId('editor-list-dot').click()
    await focusTestIdText(page, 'list-item-text')
    await page.keyboard.type('Bullet item')

    await expect(page.getByTestId('list-symbol').first()).toContainText('•')
    await expect(page.getByTestId('slate-editor')).toContainText('Bullet item')
  })

  test('camera input is available for mobile capture', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)
    const cameraInput = page.getByTestId('camera-input')
    await expect(cameraInput).toHaveAttribute('capture', 'environment')
  })

  test('context stays editable after backspace at start', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.evaluate((blockId) => {
      const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      editor?.focus()
      const block = document.querySelector(`[data-block-id="${blockId}"]`)
      if (!block) return
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    }, 'b-context')
    await page.keyboard.type('Start text')
    await page.evaluate((blockId) => {
      const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      editor?.focus()
      const block = document.querySelector(`[data-block-id="${blockId}"]`)
      if (!block) return
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    }, 'b-context')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('X')

    const editor = page.getByTestId('slate-editor')
    await expect(editor).toContainText('XStart text')
  })

  test('context draft persists when toggling tags', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.evaluate((blockId) => {
      const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      editor?.focus()
      const block = document.querySelector(`[data-block-id="${blockId}"]`)
      if (!block) return
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    }, 'b-context')
    await page.keyboard.type('Tag-safe draft')

    await page.getByRole('tab', { name: /Details/i }).click()
    await page.getByTestId('entry-project-tags').locator('button').first().click()

    await page.getByRole('tab', { name: /Note/i }).click()
    const editor = page.getByTestId('slate-editor')
    await expect(editor).toContainText('Tag-safe draft')
  })

  test('inline tag editor syncs with details tags', async ({ page }) => {
    await boot(page, { noFail: '1' })

    const inlineTags = page.getByTestId('entry-project-tags-inline')
    const targetTag = inlineTags.locator('button[data-selected="false"]').first()
    const tagLabel = (await targetTag.textContent())?.trim()
    if (!tagLabel) throw new Error('No unselected tag found in inline tags.')

    const tagButton = inlineTags.getByRole('button', { name: tagLabel })
    await tagButton.click()
    await expect(tagButton).toHaveAttribute('data-selected', 'true')

    await page.getByRole('tab', { name: /details/i }).click()
    const detailsTag = page.getByTestId('entry-project-tags').getByRole('button', { name: tagLabel })
    await expect(detailsTag).toHaveAttribute('data-selected', 'true')
  })

  test('tabs switch between note, files, and details in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.getByRole('tab', { name: /Details/i }).click()
    await expect(page.getByTestId('entry-project-tags')).toBeVisible()

    await page.getByRole('tab', { name: /Files/i }).click()
    await expect(page.getByTestId('master-sync-input-files')).toBeVisible()

    await page.getByRole('tab', { name: /Note/i }).click()
    await expect(page.getByTestId('slate-editor')).toBeVisible()
  })

  test('open tabs switch across calendar filters', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureViewMode(page)

    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const yesterdayIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(
      yesterday.getDate()
    ).padStart(2, '0')}`
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const yesterdayTitle = formatter.format(yesterday)

    await clearDateFilters(page)
    await page.getByTestId('entry-list').getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await page.getByTestId(`calendar-day-${todayIso}`).click()
    await expect(page.getByTestId('entry-date-bucket')).toHaveText(todayIso)

    await page.getByTestId(`entry-tab-${yesterdayIso}`).click()
    await expect(page.getByTestId('entry-date-bucket')).toHaveText(yesterdayIso)
  })

  test('checklist text flows horizontally in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    const firstItem = page.getByTestId('check-item-text').first()
    await expect(firstItem).toBeVisible()
    const box = await firstItem.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.width).toBeGreaterThan(120)
      expect(box.width).toBeGreaterThan(box.height)
    }
  })

  test('master sync root prefixes file destinations', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    await page.getByRole('tab', { name: /Files/ }).click()
    await page
      .getByTestId('master-sync-input-files')
      .fill('C:\\OneDrive - Trinity College Dublin\\Lab notebook')

    await page.getByRole('tab', { name: /Note/ }).click()
    await page.getByRole('button', { name: '+ File destination' }).click()
    await page.getByTestId('file-destination-path').fill('run1.csv')
    await page.getByTestId('file-destination-add').click()

    await page.getByRole('tab', { name: /Files/ }).click()
    await expect(
      page.getByText('C:\\OneDrive - Trinity College Dublin\\Lab notebook\\run1.csv')
    ).toBeVisible()
  })

  test('auto-save downloads when disk cache is unavailable', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const editor = page.getByTestId('slate-editor')
    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      if (!root) return
      const block = root.querySelector('p.block-paragraph') as HTMLElement | null
      if (!block) return
      root.focus()
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    })
    await page.keyboard.insertText('Auto-save download text')
    await expect(editor).toContainText('Auto-save download text')
    await expect(page.getByTestId('entry-save')).toBeVisible()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('entry-save').click(),
    ])
    const path = await download.path()
    const buffer = fs.readFileSync(path as string)
    expect(buffer.toString('utf8')).toContain('Auto-save download text')
  })

  test('view-mode checklist toggle syncs', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureViewMode(page)

    const firstChecklist = page.locator('.check-row').first()
    await expect(firstChecklist).toBeVisible()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.locator('.breadcrumbs .status-chip')
    await expect(statusChip).toContainText('Synced')
  })

  test('today entry opens in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })

    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()

    const editor = page.getByTestId('slate-editor')
    await expect(editor).toHaveAttribute('contenteditable', 'true')
  })

  test('sync failures can be retried', async ({ page }) => {
    await boot(page, { noFail: '0', failNext: true })
    await ensureViewMode(page)

    const firstChecklist = page.locator('.check-row').first()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.locator('.breadcrumbs .status-chip')
    await expect(statusChip).toContainText(/failed/i)

    await expect(page.getByTestId('sync-action')).toHaveText(/retry failed/i)
    await page.getByTestId('sync-action').click()
    await expect(statusChip).toContainText('Synced')
  })

  test('export markdown fallback triggers downloads', async ({ page }) => {
    let dialogText = ''
    page.on('dialog', (d) => {
      dialogText = d.message()
      d.dismiss()
    })

    await boot(page, { noFail: '1', stubPicker: true })
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-md').click(),
    ])
    expect(download.suggestedFilename().endsWith('.md')).toBeTruthy()
    await expect.poll(() => dialogText).toContain('manifest')
  })

  test('export pdf opens printable page', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByTestId('export-pdf').click(),
    ])
    await popup.waitForLoadState('domcontentloaded')
    await expect(popup.locator('text=Print / Save to PDF')).toBeVisible()
  })

  test('settings modal opens', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Disk cache', { exact: true })).toBeVisible()
    await expect(dialog.getByTestId('import-legacy')).toBeVisible()
    await expect(dialog.getByTestId('import-legacy-file')).toBeVisible()
    await expect(dialog.getByText('Notes and metadata:', { exact: false })).toBeVisible()
    await expect(dialog.getByText('Uploaded files and cached attachments:', { exact: false })).toBeVisible()
  })

  test('settings shows mobile pairing QR and link status', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByRole('button', { name: 'Settings' }).click()

    const dialog = page.getByRole('dialog')
    const pairLink = dialog.getByTestId('mobile-pair-link')
    await pairLink.fill(page.url())

    const status = dialog.getByTestId('mobile-pair-status')
    await expect(status).toBeVisible()
    await expect.poll(async () => await status.textContent()).toContain('Link online')
    await expect(dialog.getByTestId('mobile-pair-qr')).toBeVisible()
  })

  test('legacy import from file loads entries', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByRole('button', { name: 'Settings' }).click()
    const input = page.getByTestId('import-legacy-file-input')
    const filePath = path.join(here, 'fixtures', 'legacy-state.json')
    await input.setInputFiles(filePath)
    await expect(page.getByTestId('entry-list')).toContainText('Legacy note import')
  })

  test('theme selection updates the active theme', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByRole('button', { name: 'Settings' }).click()
    const neoBrutal = page.getByTestId('theme-option-neo-brutal')
    await neoBrutal.click()
    await expect(neoBrutal).toHaveClass(/active/)
    await expect.poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'neo-brutal'
    )
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem('labnote.theme'))).toBe(
      'neo-brutal'
    )
  })

  test('protocols can be created', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByRole('tab', { name: 'Protocols' }).click()
    await page.getByTestId('new-protocol').click()
    await page.getByLabel('Title').fill('Microscopy SOP')
    await page.getByRole('button', { name: 'Create protocol' }).click()

    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByTestId('protocol-editor').locator('p.block-paragraph').first().click({ force: true })
    await page.keyboard.type('Laser settings and exposure notes.')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('protocol-view')).toContainText('Laser settings and exposure notes.')
    await expect(page.getByTestId('protocol-list').getByText('Microscopy SOP')).toBeVisible()
  })

  test('view mode does not accumulate context across entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureViewMode(page)
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(new Date())
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayTitle = formatter.format(yesterday)

    await clearDateFilters(page)
    const entryView = page.getByTestId('entry-view')
    const entryList = page.getByTestId('entry-list')
    await entryList.getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await expect(entryView).toContainText('Beta context')
    await expect(entryView).not.toContainText('Alpha context')

    await entryList.getByRole('button', { name: new RegExp(todayTitle) }).click()
    await expect(entryView).toContainText('Alpha context')
    await expect(entryView).not.toContainText('Beta context')

    await entryList.getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await expect(entryView).toContainText('Beta context')
    await expect(entryView).not.toContainText('Alpha context')
  })

  test('entries list sorts newest first', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await clearDateFilters(page)

    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(today)
    const yesterdayTitle = formatter.format(yesterday)

    const entryItems = page.getByTestId('entry-list').getByRole('button')
    await expect(entryItems.nth(0)).toContainText(todayTitle)
    await expect(entryItems.nth(1)).toContainText(yesterdayTitle)
  })

  test('sidebar can be collapsed and expanded', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const toggle = page.getByTestId('sidebar-toggle')
    await toggle.click()
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/)
    await toggle.click()
    await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/)
  })

  test('calendar filters entries by date', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const yesterdayIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(
      yesterday.getDate()
    ).padStart(2, '0')}`
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(today)
    const yesterdayTitle = formatter.format(yesterday)

    await page.getByTestId(`calendar-day-${yesterdayIso}`).click()
    await expect(page.getByTestId('entry-list').getByRole('button', { name: new RegExp(yesterdayTitle) })).toBeVisible()
    await page.getByTestId(`calendar-day-${todayIso}`).click()
    await expect(page.getByTestId('entry-list').getByRole('button', { name: new RegExp(todayTitle) })).toBeVisible()
  })

  test('date range filters entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const yesterdayIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(
      yesterday.getDate()
    ).padStart(2, '0')}`
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(today)
    const yesterdayTitle = formatter.format(yesterday)

    await page.getByTestId('date-range-start').fill(yesterdayIso)
    await page.getByTestId('date-range-end').fill(yesterdayIso)

    const entryList = page.getByTestId('entry-list')
    await expect(entryList.getByRole('button', { name: new RegExp(yesterdayTitle) })).toBeVisible()
    await expect(entryList.getByRole('button', { name: new RegExp(todayTitle) })).toHaveCount(0)
  })

  test('calendar marks days that have entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const dayButton = page.getByTestId(`calendar-day-${todayIso}`)
    await expect(dayButton).toHaveClass(/has-entry/)
    await expect(dayButton.locator('.calendar-dot')).toBeVisible()
  })

  test('tag dropdown search filters project and experiment tags', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('project-tag-filter-trigger').click()
    await page.getByTestId('project-tag-filter-search').fill('gen')

    const projectPanel = page.getByTestId('project-tag-filter-panel')
    await expect(projectPanel.getByText('No tags found.')).toBeVisible()
    await page.getByTestId('project-tag-filter-trigger').click()

    await page.getByTestId('experiment-tag-filter-trigger').click()
    await page.getByTestId('experiment-tag-filter-search').fill('gen')

    const experimentPanel = page.getByTestId('experiment-tag-filter-panel')
    await expect(experimentPanel.getByRole('button', { name: 'Genotyping' })).toBeVisible()
    await expect(experimentPanel.getByRole('button', { name: 'FACS' })).toHaveCount(0)
  })

  test('deleting a tag removes it from filters and entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('experiment-tag-filter-trigger').click()
    const experimentPanel = page.getByTestId('experiment-tag-filter-panel')
    await expect(experimentPanel.getByRole('button', { name: 'Genotyping' })).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    await experimentPanel.getByRole('button', { name: 'Delete tag Genotyping' }).click()
    await expect(experimentPanel.getByRole('button', { name: 'Genotyping' })).toHaveCount(0)

    await page.getByRole('tab', { name: /details/i }).click()
    await expect(page.getByTestId('entry-experiment-tags').getByRole('button', { name: 'Genotyping' })).toHaveCount(0)
  })

  test('entries can be deleted', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayTitle = formatter.format(yesterday)

    await clearDateFilters(page)
    await page.getByTestId('entry-list').getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await page.getByRole('tab', { name: /details/i }).click()

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByTestId('delete-entry').click()

    await expect(page.getByRole('heading', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
    await expect(page.getByRole('button', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
  })
})
