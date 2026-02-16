import { test, expect, type Page } from '@playwright/test'

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

test('mobile client pairs with one-time code and keeps camera capture support', async ({ page, request }) => {
  await request.post('/api/reset')

  const boot = await request.post('/api/pair/bootstrap', {
    data: { deviceName: 'Desktop pairing owner' },
  })
  expect(boot.ok()).toBeTruthy()
  const bootBody = (await boot.json()) as { sessionToken?: string }
  const ownerToken = bootBody.sessionToken ?? ''
  expect(ownerToken).not.toBe('')

  const codeRes = await request.post('/api/pair/code', {
    headers: { 'x-labnote-session': ownerToken },
    data: { ttlSeconds: 300 },
  })
  expect(codeRes.ok()).toBeTruthy()
  const codeBody = (await codeRes.json()) as { code?: string }
  const pairCode = codeBody.code ?? ''
  expect(pairCode).toMatch(/^\d{6}$/)

  await page.addInitScript(() => {
    window.localStorage.clear()
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await selectFirstEntry(page)
  await page.getByTestId('editor-tab-details').click()
  await expect(page.getByTestId('pairing-controls')).toBeVisible()
  await page.getByTestId('pair-code-input').fill(pairCode)
  await page.getByTestId('pair-code-submit').click()
  await expect(page.getByTestId('mobile-sync-check')).toContainText('Paired')

  await page.getByTestId('editor-tab-note').click()
  await page.getByTestId('edit-note-btn').click()
  await expect(page.getByTestId('editor-camera-input')).toHaveAttribute('accept', 'image/*')
  await expect(page.getByTestId('editor-camera-input')).toHaveAttribute('capture', 'environment')
})
