import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

test.skip(process.env.GENERATE_SCREENSHOTS !== '1', 'Set GENERATE_SCREENSHOTS=1 to generate screenshots.')

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', '..', 'screenshots')

test('generate feature screenshots', async ({ page }) => {
  test.setTimeout(120_000)

  fs.mkdirSync(outDir, { recursive: true })

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
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /day 3/i })).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '01-dashboard.png'), fullPage: true })

  await page.getByRole('button', { name: '+ New Entry' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '02-new-entry-modal.png') })
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: '+ New Entry' }).click()
  await page.getByLabel('Title').fill('Template example')
  await page.getByRole('button', { name: 'Create entry' }).click()
  await expect(page.getByTestId('save-note-btn')).toBeVisible()
  await page.getByTestId('save-note-btn').click()
  await page.screenshot({ path: path.join(outDir, '03-template-entry.png'), fullPage: true })

  await page.locator('.entry-item').first().click()
  await page.getByTestId('edit-note-btn').click()
  await expect(page.getByTestId('save-note-btn')).toBeVisible()
  await page.getByRole('link', { name: /view|open/i }).first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(outDir, '04-edit-mode.png'), fullPage: true })

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: path.join(outDir, '05-settings.png') })
  await page.getByRole('button', { name: 'Close' }).click()

  await page.getByTestId('cancel-edit-btn').click()
  await expect(page.getByTestId('edit-note-btn')).toBeVisible()
  const statusChip = page.getByTestId('sync-status-chip')
  await expect(statusChip).toContainText('Synced')
  await page.context().setOffline(true)
  await page.locator('.check-row input[type="checkbox"]').first().click()
  await expect(statusChip).toContainText(/failed/i)

  await page.getByTestId('details-btn').click()
  await expect(page.getByText('Sync queue')).toBeVisible()
  await page.getByText('Sync queue').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(outDir, '06-sync-failed.png'), fullPage: true })
  await page.context().setOffline(false)
  await page.getByTestId('sync-now-btn').click()
  await expect(statusChip).toContainText('Synced')
  await page.locator('.drawer-head').getByRole('button', { name: 'Close' }).click()

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByTestId('export-pdf-btn').click(),
  ])
  await expect(popup.locator('text=Print / Save to PDF')).toBeVisible()
  await popup.setViewportSize({ width: 1100, height: 780 })
  await popup.screenshot({ path: path.join(outDir, '07-export-pdf.png'), fullPage: true })
  await popup.close()
})
