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

async function openOrCreateCalendarEntry(page: Page, isoDate: string) {
  await selectCalendarDate(page, isoDate)
  const createEntry = page.getByTestId('calendar-create-entry')
  if (await createEntry.isVisible().catch(() => false)) {
    await createEntry.click()
    return
  }
  const seeded = page.locator('[data-testid="entry-list-item-entry-1"]')
  if (await seeded.count()) {
    await seeded.first().click()
    return
  }
  await page.locator('[data-testid^="entry-list-item-"]').first().click()
}

test('generate feature screenshots', async ({ page }) => {
  test.setTimeout(120_000)

  fs.mkdirSync(outDir, { recursive: true })

  await page.request.post('/api/reset')
  await page.addInitScript(() => {
    window.localStorage.clear()
    window.localStorage.setItem('labnote.mockSync.noFail', '1')
    window.localStorage.setItem('labnote.setupComplete', '1')
    window.localStorage.setItem('labnote.appPaths', JSON.stringify({
      dataRoot: 'C:\\\\Easylab\\\\screenshots\\\\data',
      attachmentsRoot: 'C:\\\\Easylab\\\\screenshots\\\\attachments',
      exportRoot: 'C:\\\\Easylab\\\\screenshots\\\\exports',
      syncRoot: 'C:\\\\Easylab\\\\screenshots\\\\sync',
    }))
    window.localStorage.setItem('labnote.masterSyncPath', 'C:\\\\Easylab\\\\screenshots\\\\sync')
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
  await openOrCreateCalendarEntry(page, '2025-12-07')
  await expect(page.getByRole('heading', { name: formatUiDate('2025-12-07') })).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '01-dashboard.png'), fullPage: true })

  await page.getByTestId('editor-tab-workbook').click()
  await expect(page.getByTestId('entry-workbook')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '07-workbook.png'), fullPage: true })
  await page.getByTestId('editor-tab-note').click()

  await page.getByTestId('editor-tab-details').click()
  await page.screenshot({ path: path.join(outDir, '02-details.png'), fullPage: true })
  await page.getByTestId('editor-tab-note').click()

  await openOrCreateCalendarEntry(page, '2025-12-07')
  await page.getByTestId('edit-note-btn').click()
  await expect(page.getByTestId('entry-save')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '03-edit-mode.png'), fullPage: true })

  await page.getByTestId('settings-button').click()
  const settingsDialog = page.getByRole('dialog')
  await expect(settingsDialog).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '04-settings.png') })
  await settingsDialog.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('edit-note-btn')).toBeVisible()
  await page.getByTestId('editor-tab-note').click()
  await openOrCreateCalendarEntry(page, '2025-12-07')
  await page.getByTestId('editor-tab-details').click()
  await expect(page.getByText('Sync queue')).toBeVisible()
  await page.getByText('Sync queue').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(outDir, '05-sync-details.png'), fullPage: true })
  await page.getByRole('tab', { name: 'File Hub' }).click()
  await expect(page.getByTestId('file-hub-pane')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '06-file-hub.png'), fullPage: true })
  await page.getByRole('tab', { name: 'Devices' }).click()
  await expect(page.getByTestId('devices-pane')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '06b-devices.png'), fullPage: true })
  await page.getByRole('tab', { name: 'Transfers' }).click()
  await expect(page.getByTestId('transfers-pane')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '06c-transfers.png'), fullPage: true })
  await page.getByRole('tab', { name: 'Sync' }).click()
  await expect(page.getByTestId('sync-pane')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '07-sync-pane.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Entries' }).click()
  await openOrCreateCalendarEntry(page, '2025-12-07')
  await page.evaluate(() => {
    window.localStorage.setItem('labnote.mockSync.noFail', '0')
    window.localStorage.setItem('labnote.mockSync.failNext', '1')
    ;(window as unknown as { __labnoteMockSync?: { noFail?: boolean; failNext?: boolean } }).__labnoteMockSync = {
      noFail: false,
      failNext: true,
    }
  })
  await page.getByTestId('edit-note-btn').click()
  await page.getByTestId('slate-editor').click()
  await page.keyboard.type(' Failed sync screenshot note.')
  await page.getByTestId('entry-save').click()
  await expect(page.getByTestId('sync-status-chip')).toContainText(/failed/i)
  await page.screenshot({ path: path.join(outDir, '05-sync-failed.png'), fullPage: true })

  const [popup] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('export-pdf').click(),
  ])
  await popup.waitForLoadState('domcontentloaded')
  await expect(popup.locator('text=Print / Save to PDF')).toBeVisible()
  await popup.screenshot({ path: path.join(outDir, '06-export-pdf.png'), fullPage: true })
  await popup.close()
})

test('mobile landing', async ({ page }) => {
  await page.request.post('/api/reset')
  await page.addInitScript(() => {
    window.localStorage.clear()
    window.localStorage.setItem('labnote.mockSync.noFail', '1')
    window.localStorage.setItem('labnote.setupComplete', '1')
    window.localStorage.setItem('labnote.appPaths', JSON.stringify({
      dataRoot: 'C:\\\\Easylab\\\\screenshots\\\\data',
      attachmentsRoot: 'C:\\\\Easylab\\\\screenshots\\\\attachments',
      exportRoot: 'C:\\\\Easylab\\\\screenshots\\\\exports',
      syncRoot: 'C:\\\\Easylab\\\\screenshots\\\\sync',
    }))
    window.localStorage.setItem('labnote.masterSyncPath', 'C:\\\\Easylab\\\\screenshots\\\\sync')
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
  await expect(page.locator('.mobile-pwa-nav')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '08-mobile-landing.png'), fullPage: true })
  await page.getByTestId('mobile-nav-days').click()
  await page.waitForTimeout(260)
  await page.screenshot({ path: path.join(outDir, '09-mobile-days.png'), fullPage: true })
  await page.getByTestId('mobile-nav-files').click()
  await page.waitForTimeout(260)
  await expect(page.getByTestId('file-hub-pane')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '10-mobile-files.png'), fullPage: true })
  await page.getByTestId('mobile-nav-sync').click()
  await page.waitForTimeout(260)
  await expect(page.getByTestId('sync-pane')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '11-mobile-sync.png'), fullPage: true })
  await page.getByTestId('mobile-nav-settings').click()
  await page.waitForTimeout(260)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '12-mobile-settings.png'), fullPage: true })
})
