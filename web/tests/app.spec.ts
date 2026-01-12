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

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(page.getByRole('heading', { name: /neuroimmunology lab/i })).toBeVisible()
    await expect(page.getByTestId('sidebar-new-entry')).toBeVisible()
    await expect(page.getByTestId('sidebar-quick-capture')).toBeVisible()
    await expect(page.getByPlaceholder('Search notes, samples, files')).toBeVisible()
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

  test('entry list filters to the selected day', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectCalendarDate(page, '2025-12-07')
    const entries = page.locator('[data-testid^="entry-list-item-"]')
    await expect(entries).toHaveCount(1)
    await expect(entries.first()).toContainText(/day 3/i)
  })

  test('tags can be added and templates reused', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)
    await page.getByTestId('editor-tab-details').click()

    const tagEditor = page.locator('.tag-editor')
    await page.getByTestId('tag-input').fill('E2E tag')
    await page.getByTestId('tag-add-btn').click()
    await expect(tagEditor.getByText('E2E tag', { exact: true })).toBeVisible()

    await page.getByPlaceholder('Template name').fill('E2E template')
    await page.getByTestId('template-save-btn').click()
    await expect(page.getByText('E2E template', { exact: true })).toBeVisible()

    await page.getByLabel('Remove tag E2E tag').click()
    await expect(tagEditor.getByText('E2E tag', { exact: true })).not.toBeVisible()

    const templateCard = page.locator('.template-card', { hasText: 'E2E template' })
    await templateCard.getByRole('button', { name: 'Apply' }).click()
    await expect(tagEditor.getByText('E2E tag', { exact: true })).toBeVisible()
  })

  test('creates a new entry from template and pins regions', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('sidebar-new-entry').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByLabel('Title').fill('E2E template note')
    await page.getByRole('button', { name: 'Create entry' }).click()

    await expect(page.getByRole('heading', { name: 'E2E template note' })).toBeVisible()
    await expect(page.getByTestId('save-note-btn')).toBeVisible()

    await page.getByTestId('save-note-btn').click()
    await expect(page.getByTestId('edit-note-btn')).toBeVisible()

    await page.getByTestId('editor-tab-details').click()
    const pinned = page.getByTestId('pinned-regions-list')
    await expect(pinned.getByText('Aim', { exact: true })).toBeVisible()
    await expect(pinned.getByText('Experiment', { exact: true })).toBeVisible()
    await expect(pinned.getByText('Results', { exact: true })).toBeVisible()
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

  test('persists entries after local storage reset', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('sidebar-new-entry').click()
    await page.getByLabel('Title').fill('Server persistence note')
    await page.getByRole('button', { name: 'Create entry' }).click()
    await page.getByTestId('save-note-btn').click()
    await expect(page.getByRole('heading', { name: 'Server persistence note' })).toBeVisible()

    await page.waitForTimeout(600)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()

    await page.locator('[data-testid^="entry-list-item-"]', { hasText: 'Server persistence note' }).first().click()
    await expect(page.getByRole('heading', { name: 'Server persistence note' })).toBeVisible()
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
    await expect(tabs).toContainText('Day 3')
    await expect(tabs).toContainText('Microglia')

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

  test('quick capture reuses the day entry', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const title = page.locator('.editor-header h1')
    await expect(title).toBeVisible()
    const before = await title.textContent()
    await page.getByTestId('sidebar-quick-capture').click()
    await expect(page.getByTestId('save-note-btn')).toBeVisible()
    await expect(title).toHaveText(before ?? '')
  })
})
