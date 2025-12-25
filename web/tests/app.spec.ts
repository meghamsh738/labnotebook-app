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
  await page.goto('/')
}

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(page.getByRole('heading', { name: /neuroimmunology lab/i })).toBeVisible()
    await expect(page.getByRole('button', { name: '+ New Entry' })).toBeVisible()
    await expect(page.getByRole('button', { name: /quick capture/i })).toBeVisible()
    await expect(page.getByPlaceholder('Search notes, samples, files')).toBeVisible()
  })

  test('creates a new entry from template and pins regions', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByRole('button', { name: '+ New Entry' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByLabel('Title').fill('E2E template note')
    await page.getByRole('button', { name: 'Create entry' }).click()

    await expect(page.getByRole('heading', { name: 'E2E template note' })).toBeVisible()
    await expect(page.getByTestId('save-note-btn')).toBeVisible()

    await page.getByTestId('save-note-btn').click()
    await expect(page.getByTestId('edit-note-btn')).toBeVisible()

    await page.getByTestId('details-btn').click()
    const pinned = page.getByTestId('pinned-regions-list')
    await expect(pinned.getByText('Aim', { exact: true })).toBeVisible()
    await expect(pinned.getByText('Experiment', { exact: true })).toBeVisible()
    await expect(pinned.getByText('Results', { exact: true })).toBeVisible()
  })

  test('view-mode checklist toggle syncs', async ({ page }) => {
    await boot(page, { noFail: '1' })

    const firstChecklist = page.locator('.check-row').first()
    await expect(firstChecklist).toBeVisible()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText('Synced')
  })

  test('sync failures can be retried', async ({ page }) => {
    await boot(page, { noFail: '0', failNext: true })

    const firstChecklist = page.locator('.check-row').first()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText(/failed/i)

    await page.getByTestId('details-btn').click()
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
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-md-btn').click(),
    ])
    expect(download.suggestedFilename().endsWith('.md')).toBeTruthy()
    await expect.poll(() => dialogText).toContain('manifest')
  })

  test('export pdf opens printable page', async ({ page }) => {
    await boot(page, { noFail: '1' })
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
