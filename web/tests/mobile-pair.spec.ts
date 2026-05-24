import { test, expect, type Page } from '@playwright/test'

async function selectFirstEntry(page: Page) {
  const mobileDays = page.getByTestId('mobile-nav-days')
  if (await mobileDays.count()) {
    await mobileDays.click()
  }
  const listItems = page.locator('[data-testid^="entry-list-item-"]')
  if ((await listItems.count()) === 0) {
    const hasEntryDay = page.locator('button.has-entry[data-testid^="calendar-day-"]').first()
    if (await hasEntryDay.count()) {
      await hasEntryDay.click()
    } else {
      const todayEntry = page.getByTestId('today-entry')
      if (await todayEntry.count()) {
        await todayEntry.click()
      }
    }
  }
  await expect(listItems.first()).toBeVisible()
  await listItems.first().click()
}

async function ensureNoteEditMode(page: Page) {
  const editBtn = page.getByTestId('edit-note-btn')
  if ((await editBtn.count()) > 0) {
    await editBtn.click()
  }
  await expect(page.getByTestId('entry-save')).toBeVisible()
}

test('mobile layout shows QR pairing and keeps camera capture support', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await selectFirstEntry(page)
  const mobileSettings = page.getByTestId('mobile-nav-settings')
  if (await mobileSettings.count()) {
    await mobileSettings.click()
  } else {
    await page.getByTestId('settings-button').click()
  }
  const dialog = page.getByRole('dialog')
  const mobilePairCard = dialog.getByTestId('mobile-pair-card')
  await expect(mobilePairCard).toBeVisible()
  await mobilePairCard.locator('summary').click()
  const pairLink = dialog.getByTestId('mobile-pair-link')
  await pairLink.fill(page.url())
  await expect(dialog.getByTestId('mobile-pair-status')).toContainText('Link online')
  await expect(dialog.getByTestId('mobile-pair-connected')).toBeVisible()
  await expect(dialog.getByTestId('mobile-pair-qr')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByTestId('editor-tab-note').click()
  await ensureNoteEditMode(page)
  await expect(page.getByTestId('camera-input')).toHaveAttribute('accept', 'image/*')
  await expect(page.getByTestId('camera-input')).toHaveAttribute('capture', 'environment')
})
