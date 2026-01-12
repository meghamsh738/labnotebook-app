import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

test.skip(process.env.GENERATE_SCREENSHOTS !== '1', 'Set GENERATE_SCREENSHOTS=1 to generate screenshots.')

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', '..', 'screenshots')
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const formatUiDate = (isoDate: string) => dateFormatter.format(new Date(`${isoDate}T12:00:00`))

async function selectCalendarDate(page: Page, isoDate: string) {
  const target = page.getByTestId(`calendar-day-${isoDate}`)
  for (let i = 0; i < 14; i += 1) {
    if (await target.count()) break
    await page.getByRole('button', { name: /previous month/i }).click()
  }
  await target.click()
}

test('generate feature screenshots', async ({ page }) => {
  test.setTimeout(120_000)

  fs.mkdirSync(outDir, { recursive: true })

  await page.request.post('/api/reset')
  await page.addInitScript(() => {
    window.localStorage.clear()
    window.localStorage.setItem('labnote.mockSync.noFail', '1')
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined
    ;(window as unknown as { __labnoteMockSync?: { noFail?: boolean; failNext?: boolean } }).__labnoteMockSync = {
      noFail: true,
      failNext: false,
    }
  })

  page.on('dialog', (d) => d.dismiss())

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await selectCalendarDate(page, '2025-12-07')
  const seeded = page.locator('[data-testid="entry-list-item-entry-1"]')
  if (await seeded.count()) {
    await seeded.first().click()
  } else {
    await page.locator('[data-testid^="entry-list-item-"]').first().click()
  }
  await expect(page.getByRole('heading', { name: formatUiDate('2025-12-07') })).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '01-dashboard.png'), fullPage: true })

  await page.getByTestId('sidebar-new-entry').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '02-new-entry-modal.png') })
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByTestId('sidebar-new-entry').click()
  await page.getByRole('button', { name: 'Create entry' }).click()
  await expect(page.getByTestId('save-note-btn')).toBeVisible()
  await page.getByTestId('save-note-btn').click()
  await page.screenshot({ path: path.join(outDir, '03-template-entry.png'), fullPage: true })

  await selectCalendarDate(page, '2025-12-07')
  if (await seeded.count()) {
    await seeded.first().click()
  } else {
    await page.locator('[data-testid^="entry-list-item-"]').first().click()
  }
  await page.getByTestId('edit-note-btn').click()
  await expect(page.getByTestId('save-note-btn')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '04-edit-mode.png'), fullPage: true })

  await page.getByRole('button', { name: 'Settings' }).click()
  const settingsDialog = page.getByRole('dialog')
  await expect(settingsDialog).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '05-settings.png') })
  await settingsDialog.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByTestId('cancel-edit-btn').click()
  await expect(page.getByTestId('edit-note-btn')).toBeVisible()
  await page.getByTestId('editor-tab-note').click()
  await selectCalendarDate(page, '2025-12-07')
  const seededAgain = page.locator('[data-testid="entry-list-item-entry-1"]')
  if (await seededAgain.count()) {
    await seededAgain.first().click()
  } else {
    await page.locator('[data-testid^="entry-list-item-"]').first().click()
  }
  const statusChip = page.getByTestId('sync-status-chip')
  await expect(statusChip).toContainText('Synced')
  await page.context().setOffline(true)
  await page.getByRole('checkbox').first().click()
  await expect(statusChip).toContainText(/failed/i)

  await page.getByTestId('editor-tab-details').click()
  await expect(page.getByText('Sync queue')).toBeVisible()
  await page.getByText('Sync queue').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(outDir, '06-sync-failed.png'), fullPage: true })
  await page.context().setOffline(false)
  await page.getByTestId('sync-now-btn').click()
  await expect(statusChip).toContainText('Synced')
  await page.getByTestId('editor-tab-note').click()
  await selectCalendarDate(page, '2025-12-07')
  const exportEntry = page.locator('[data-testid="entry-list-item-entry-1"]')
  if (await exportEntry.count()) {
    await exportEntry.first().click()
  } else {
    await page.locator('[data-testid^="entry-list-item-"]').first().click()
  }
  const exportPdf = page.getByTestId('export-pdf-btn')
  await expect(exportPdf).toBeEnabled()

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    exportPdf.click(),
  ])
  await expect(popup.locator('text=Print / Save to PDF')).toBeVisible()
  await popup.setViewportSize({ width: 1100, height: 780 })
  await popup.screenshot({ path: path.join(outDir, '07-export-pdf.png'), fullPage: true })
  await popup.close()
})

test('mobile landing', async ({ page }) => {
  await page.request.post('/api/reset')
  await page.addInitScript(() => {
    window.localStorage.clear()
    window.localStorage.setItem('labnote.mockSync.noFail', '1')
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined
    ;(window as unknown as { __labnoteMockSync?: { noFail?: boolean; failNext?: boolean } }).__labnoteMockSync = {
      noFail: true,
      failNext: false,
    }
  })

  page.on('dialog', (d) => d.dismiss())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByTestId('viewer-bar')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '08-mobile-landing.png'), fullPage: true })
})
