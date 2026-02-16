import { test, expect, type Page } from '@playwright/test'

async function boot(
  page: Page,
  opts?: { noFail?: '0' | '1'; failNext?: boolean; stubPicker?: boolean }
) {
  await page.request.post('/api/reset')
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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
}

async function selectCalendarDate(page: Page, isoDate: string) {
  const target = page.getByTestId(`calendar-day-${isoDate}`)
  for (let i = 0; i < 14; i += 1) {
    if (await target.count()) break
    await page.getByRole('button', { name: /previous month/i }).click()
  }
  await expect(target).toBeVisible()
  await target.click()
}

async function selectFirstEntry(page: Page) {
  await selectCalendarDate(page, '2025-12-07')
  const seeded = page.locator('[data-testid="entry-list-item-entry-1"]')
  if (await seeded.count()) {
    await seeded.first().click()
    return
  }
  await page.locator('[data-testid^="entry-list-item-"]').first().click()
}

const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const formatUiDate = (isoDate: string) => dateFormatter.format(new Date(`${isoDate}T12:00:00`))

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(page.getByRole('heading', { name: /lab notebook/i })).toBeVisible()
    await expect(page.getByTestId('sidebar-today-entry')).toBeVisible()
    await expect(page.getByPlaceholder('Search notes, samples, files')).toHaveCount(0)
    await expect(page.getByTestId('viewer-bar')).toBeVisible()
  })

  test('viewer mode navigates by date order', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const title = page.locator('.editor-header h1')
    await expect(title).toBeVisible()
    const initial = await title.textContent()

    const prevBtn = page.getByTestId('viewer-prev')
    await expect(prevBtn).toBeEnabled()
    await prevBtn.click()
    await expect(title).not.toHaveText(initial ?? '')
  })

  test('keeps header close to view tabs', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)

    const editor = page.locator('.editor')
    await editor.evaluate((node) => {
      node.scrollTop = 0
    })

    const tab = page.getByTestId('editor-tab-note')
    const header = page.locator('.editor-header')
    await expect(tab).toBeVisible()
    await expect(header).toBeVisible()

    const tabBox = await tab.boundingBox()
    const headerBox = await header.boundingBox()
    expect(tabBox).not.toBeNull()
    expect(headerBox).not.toBeNull()
    const gap = (headerBox?.y ?? 0) - ((tabBox?.y ?? 0) + (tabBox?.height ?? 0))
    expect(gap).toBeLessThan(48)
  })

  test('entry list filters to the selected day', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectCalendarDate(page, '2025-12-07')
    const entries = page.locator('[data-testid^="entry-list-item-"]')
    await expect(entries).toHaveCount(1)
    await expect(entries.first()).toContainText(formatUiDate('2025-12-07'))
  })

  test('tags can be added and templates reused', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('editor-tab-details').click()

    const tagBlocks = page.locator('.tag-panel-block')
    const currentTags = tagBlocks.nth(0).locator('.chip-row')
    await page.getByTestId('tag-input').fill('E2E tag')
    await page.getByTestId('tag-add-btn').click()
    await expect(currentTags.getByText('E2E tag', { exact: true })).toBeVisible()

    await page.getByPlaceholder('Template name').fill('E2E template')
    await page.getByTestId('template-save-btn').click()
    const templateButton = page.locator('.template-list .pill', { hasText: 'E2E template' })
    await expect(templateButton).toBeVisible()

    await page.getByTestId('tag-input').fill('Extra tag')
    await page.getByTestId('tag-add-btn').click()
    await expect(currentTags.getByText('Extra tag', { exact: true })).toBeVisible()

    await templateButton.click()
    await expect(currentTags.getByText('E2E template', { exact: true })).toBeVisible()
    await expect(currentTags.getByText('E2E tag', { exact: true })).not.toBeVisible()
    await expect(currentTags.getByText('Extra tag', { exact: true })).not.toBeVisible()
  })

  test('today entry button opens edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('sidebar-today-entry').click()
    await expect(page.getByTestId('save-note-btn')).toBeVisible()
  })

  test('shows capture photo option on landing', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('edit-note-btn').click()
    await expect(page.getByTestId('editor-camera-input')).toHaveAttribute('accept', 'image/*')
    await expect(page.getByTestId('editor-camera-input')).toHaveAttribute('capture', 'environment')
  })

  test('shared upload defaults on when server is available', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('edit-note-btn').click()
    const toggle = page.getByTestId('upload-shared-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeEnabled()
    await expect(toggle).toHaveClass(/active-pill/)
  })

  test('editor toolbar exposes rich text controls', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('edit-note-btn').click()
    await expect(page.getByTestId('editor-font-select')).toBeVisible()
    await expect(page.getByTestId('editor-font-size')).toBeVisible()
    await expect(page.getByTestId('editor-font-color')).toBeVisible()
    await expect(page.getByTestId('editor-highlight-color')).toBeVisible()
    await expect(page.getByTestId('editor-highlight-clear')).toBeVisible()
    await expect(page.getByTestId('editor-superscript')).toBeVisible()
    await expect(page.getByTestId('editor-subscript')).toBeVisible()
    await expect(page.getByTestId('editor-list-bulleted')).toBeVisible()
    await expect(page.getByTestId('editor-align-center')).toBeVisible()
    await expect(page.getByTestId('editor-indent')).toBeVisible()
    await expect(page.getByTestId('editor-outdent')).toBeVisible()
    await expect(page.getByTestId('editor-bold')).toBeVisible()
  })

  test('supports undo with control z', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('edit-note-btn').click()
    const editor = page.locator('.slate-editor')
    await editor.click()
    await page.keyboard.type('UNDO-CHECK')
    await expect(editor).toContainText('UNDO-CHECK')
    await page.keyboard.press('Control+Z')
    await expect(editor).not.toContainText('UNDO-CHECK')
  })

  test('table formatting toggles update table styles', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)

    const table = page.locator('.table-wrap').first()
    await expect(page.getByTestId('table-header-toggle')).toBeVisible()
    await expect(table.locator('td.th')).toHaveCount(3)

    await page.getByTestId('table-header-toggle').click()
    await expect(table.locator('td.th')).toHaveCount(0)

    await page.getByTestId('table-striped-toggle').click()
    await expect(table).toHaveClass(/table-striped/)

    await page.getByTestId('table-compact-toggle').click()
    await expect(table).toHaveClass(/table-compact/)
  })

  test('mobile sync check panel shows server info', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('editor-tab-details').click()
    const panel = page.getByTestId('mobile-sync-check')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Server URL')
    await expect(panel).toContainText('Shared upload')
  })

  test('desktop owner can generate one-time pair code', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('editor-tab-details').click()
    const panel = page.getByTestId('mobile-sync-check')
    await expect(panel).toContainText('Paired')
    await page.getByTestId('pair-code-generate').click()
    await expect(page.getByTestId('pair-code-display')).toContainText(/^\d{6}$/)
  })

  test('persists entries after local storage reset', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectCalendarDate(page, '2025-12-09')
    await page.getByTestId('edit-note-btn').click()
    await page.getByTestId('save-note-btn').click()
    await expect(page.getByRole('heading', { name: formatUiDate('2025-12-09') })).toBeVisible()

    await page.waitForTimeout(600)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()

    await selectCalendarDate(page, '2025-12-09')
    await expect(page.getByRole('heading', { name: formatUiDate('2025-12-09') })).toBeVisible()
  })

  test('workspace tabs support split view', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('viewer-toggle').click()
    await selectCalendarDate(page, '2025-12-07')
    await page.getByTestId('entry-list-item-entry-1').click()
    await selectCalendarDate(page, '2025-12-05')
    await page.getByTestId('entry-list-item-entry-2').click()

    const tabs = page.getByTestId('workspace-tabs')
    await expect(tabs).toBeVisible()
    const tabItems = tabs.locator('[data-testid^="workspace-tab-"]')
    expect(await tabItems.count()).toBeGreaterThanOrEqual(2)
    await expect(tabs).toContainText(formatUiDate('2025-12-07'))
    await expect(tabs).toContainText(formatUiDate('2025-12-05'))

    await page.getByTestId('split-toggle').click()
    const splitSelect = page.getByTestId('split-secondary-select')
    await expect(splitSelect).toBeVisible()
    await expect(splitSelect).not.toHaveValue('')
    await expect(page.getByTestId('split-secondary-panel')).toBeVisible()
  })

  test('view-mode checklist toggle syncs', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)

    const firstChecklist = page.getByRole('checkbox').first()
    await expect(firstChecklist).toBeVisible()
    await firstChecklist.click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText('Synced')
  })

  test('sync failures can be retried', async ({ page }) => {
    await boot(page, { noFail: '0', failNext: true })
    await selectFirstEntry(page)

    const firstChecklist = page.getByRole('checkbox').first()
    await firstChecklist.click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText(/failed/i)

    await page.getByTestId('editor-tab-details').click()
    await page.getByTestId('sync-now-btn').click()
    await expect(statusChip).toContainText('Synced')
  })

  test('export markdown fallback triggers downloads', async ({ page }) => {
    let dialogText = ''
    page.on('dialog', (d) => {
      dialogText = d.message()
      d.dismiss()
    })

    await boot(page, { noFail: '1', stubPicker: true })
    await selectFirstEntry(page)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-md-btn').click(),
    ])
    expect(download.suggestedFilename().endsWith('.md')).toBeTruthy()
    await expect.poll(() => dialogText).toContain('manifest')
  })

  test('export pdf opens printable page', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByTestId('export-pdf-btn').click(),
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

  test('today entry button reuses the day entry', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const title = page.locator('.editor-header h1')
    await expect(title).toBeVisible()
    const before = await title.textContent()
    await page.getByTestId('sidebar-today-entry').click()
    await expect(page.getByTestId('save-note-btn')).toBeVisible()
    await expect(title).toHaveText(before ?? '')
  })
})
