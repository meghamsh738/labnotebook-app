import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'

async function boot(
  page: Page,
  opts?: { noFail?: '0' | '1'; failNext?: boolean; stubPicker?: boolean }
) {
  await page.addInitScript((o) => {
    window.localStorage.clear()
    ;(window as unknown as { __labnoteMockSync?: { noFail?: boolean; failNext?: boolean } }).__labnoteMockSync = {
      noFail: o?.noFail === '1',
      failNext: !!o?.failNext,
    }
    if (o?.noFail) window.localStorage.setItem('labnote.mockSync.noFail', o.noFail)
    if (o?.failNext) window.localStorage.setItem('labnote.mockSync.failNext', '1')
    if (o?.stubPicker) {
      ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined
    }
  }, opts ?? { noFail: '1' })
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

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(page.getByRole('heading', { name: /neuroimmunology lab/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /today's entry/i })).toBeVisible()
    await expect(page.getByPlaceholder('Search notes, samples, files')).toBeVisible()
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
    await expect(page.getByTestId('calendar')).toBeVisible()
  })

  test('today entry opens with the guided template', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible()
  })

  test('guided template prompts clear on input', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const guideText =
      'What question are you answering today? Include model, conditions, and expected outcome.'
    const guideLocator = page.getByText(guideText)
    await expect(guideLocator).toBeVisible()

    const editor = page.getByTestId('slate-editor')
    await editor.locator('p.block-paragraph').first().click({ force: true })
    await page.keyboard.type('Testing placeholder clearing')

    await expect(guideLocator).toHaveCount(0)
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
    await page.keyboard.press('Home')
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
    await page.getByRole('button', { name: 'Add' }).click()

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

  test('protocols can be created and searched', async ({ page }) => {
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

    await page.getByPlaceholder('Search protocols').fill('Laser settings')
    const protocolList = page.getByTestId('protocol-list')
    await expect(protocolList.getByText('Microscopy SOP')).toBeVisible()
  })

  test('view mode does not accumulate context across entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureViewMode(page)
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(new Date())
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayTitle = formatter.format(yesterday)

    await page.getByTestId('calendar-clear').click()
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
    await page.getByTestId('calendar-clear').click()

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

  test('tag search filters project and experiment tags', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByRole('button', { name: 'More' }).click()

    await page.getByTestId('tag-search').fill('gen')

    const projectList = page.getByTestId('project-tag-list')
    await expect(projectList.getByText('No tags found.')).toBeVisible()

    const experimentList = page.getByTestId('experiment-tag-list')
    await expect(experimentList.getByRole('button', { name: 'Genotyping' })).toBeVisible()
    await expect(experimentList.getByRole('button', { name: 'FACS' })).toHaveCount(0)
  })

  test('entries can be deleted', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayTitle = formatter.format(yesterday)

    await page.getByTestId('calendar-clear').click()
    await page.getByTestId('entry-list').getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await page.getByRole('tab', { name: /details/i }).click()

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByTestId('delete-entry').click()

    await expect(page.getByRole('heading', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
    await expect(page.getByRole('button', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
  })
})
