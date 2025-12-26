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
  const startModal = page.locator('.start-day-modal')
  try {
    await startModal.waitFor({ state: 'visible', timeout: 2000 })
    await startModal.getByRole('button', { name: /later|skip/i }).first().click()
  } catch {
    // modal not shown yet
  }
}

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(page.getByRole('heading', { name: /neuroimmunology lab/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /new entry/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /quick capture/i })).toBeVisible()
    await expect(page.getByPlaceholder('Search notes, samples, files')).toBeVisible()
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
    await expect(page.getByTestId('calendar')).toBeVisible()
  })

  test('creates a new entry from the guided template', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByRole('button', { name: /new entry/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByLabel('Title').fill('E2E guided note')
    await page.getByRole('button', { name: 'Create entry' }).click()

    await expect(page.getByRole('heading', { name: 'E2E guided note' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible()
  })

  test('view-mode checklist toggle syncs', async ({ page }) => {
    await boot(page, { noFail: '1' })

    const firstChecklist = page.locator('.check-row').first()
    await expect(firstChecklist).toBeVisible()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.locator('.breadcrumbs .status-chip')
    await expect(statusChip).toContainText('Synced')
  })

  test('quick capture opens in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })

    await page.getByTestId('quick-capture').click()
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()

    const editor = page.getByTestId('slate-editor')
    await editor.locator('p').last().click()
    await page.keyboard.type('Quick capture note')
    await expect(editor).toContainText('Quick capture note')
  })

  test('sync failures can be retried', async ({ page }) => {
    await boot(page, { noFail: '0', failNext: true })

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

    await page.getByTestId(`calendar-day-${yesterdayIso}`).click()
    await expect(page.getByText('No entries match these filters.')).toBeVisible()
    await page.getByTestId(`calendar-day-${todayIso}`).click()
    await expect(page.getByText('No entries match these filters.')).toBeHidden()
  })
})
