import { test, expect, type Page } from '@playwright/test'

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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
}

async function selectFirstEntry(page: Page) {
  const seeded = page.locator('[data-testid="entry-tree-item-entry-1"]')
  if (await seeded.count()) {
    await seeded.first().click()
    return
  }
  await page.locator('[data-testid^="entry-tree-item-"]').first().click()
}

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(page.getByRole('heading', { name: /neuroimmunology lab/i })).toBeVisible()
    await expect(page.getByTestId('sidebar-new-entry')).toBeVisible()
    await expect(page.getByTestId('sidebar-quick-capture')).toBeVisible()
    await expect(page.getByPlaceholder('Search notes, samples, files')).toBeVisible()
    await expect(page.getByTestId('today-entry-card')).toBeVisible()
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

  test('workspace tabs support split view', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await selectFirstEntry(page)

    const entryItems = page.locator('[data-testid^="entry-tree-item-"]')
    const entryCount = await entryItems.count()
    expect(entryCount).toBeGreaterThan(1)
    await entryItems.nth(1).click()

    const tabs = page.getByTestId('workspace-tabs')
    await expect(tabs).toBeVisible()
    await expect(tabs.locator('[data-testid^="workspace-tab-"]')).toHaveCount(2)

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
})
