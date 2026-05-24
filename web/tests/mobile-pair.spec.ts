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

async function seedRemoteDriveAttachment(page: Page) {
  await page.addInitScript(() => {
    const entry = {
      id: 'entry-mobile-remote-drive-day',
      createdDatetime: '2026-05-24T09:00:00.000Z',
      lastEditedDatetime: '2026-05-24T10:00:00.000Z',
      authorId: 'u1',
      title: 'Mobile remote Drive day',
      dateBucket: '2026-05-24',
      isDaily: true,
      content: [{ id: 'remote-mobile-block', type: 'paragraph', text: 'remote attachment note' }],
      tags: [],
      searchTerms: [],
      linkedFiles: ['att-mobile-remote-drive'],
      pinnedRegions: [],
    }
    window.localStorage.clear()
    window.localStorage.setItem('labnote.setupComplete', '1')
    window.localStorage.setItem('labnote.appPaths', JSON.stringify({
      dataRoot: 'C:\\\\Easylab\\\\data',
      attachmentsRoot: 'C:\\\\Easylab\\\\attachments',
      exportRoot: 'C:\\\\Easylab\\\\exports',
      syncRoot: 'C:\\\\Easylab\\\\sync',
    }))
    window.localStorage.setItem('labnote.masterSyncPath', 'C:\\\\Easylab\\\\sync')
    window.localStorage.setItem('labnote.entries', JSON.stringify({ [entry.id]: entry }))
    window.localStorage.setItem('labnote.attachments', JSON.stringify([{
      id: 'att-mobile-remote-drive',
      entryId: entry.id,
      type: 'image',
      filename: 'pixel-camera.jpg',
      filesize: '2 MB',
      bytes: 2_000_000,
      storagePath: 'attachments/2026-05-24/att-mobile-remote-drive-pixel-camera.jpg',
      contentType: 'image/jpeg',
      mimeType: 'image/jpeg',
      sha256: 'mobile123remotehash',
      driveFileId: 'drive-file-mobile-remote',
      syncStatus: 'remote-available',
      createdAt: '2026-05-24T10:00:00.000Z',
      updatedAt: '2026-05-24T10:05:00.000Z',
    }]))
    window.localStorage.setItem('labnote.connected.fileBox', JSON.stringify([{
      id: 'fb-mobile-remote-drive',
      entryId: entry.id,
      attachmentId: 'att-mobile-remote-drive',
      filename: 'pixel-camera.jpg',
      filesize: '2 MB',
      contentType: 'image/jpeg',
      sourceDeviceId: 'dev-pixel',
      sourceDeviceName: 'Pixel 7a',
      status: 'available',
      createdAt: '2026-05-24T10:00:00.000Z',
      updatedAt: '2026-05-24T10:05:00.000Z',
      driveFileId: 'drive-file-mobile-remote',
    }]))
    window.localStorage.setItem('labnote.connected.transfers', JSON.stringify([{
      id: 'tr-mobile-remote-drive',
      fileBoxItemId: 'fb-mobile-remote-drive',
      entryId: entry.id,
      attachmentId: 'att-mobile-remote-drive',
      filename: 'pixel-camera.jpg',
      fromDeviceId: 'dev-pixel',
      fromDeviceName: 'Pixel 7a',
      provider: 'google-drive',
      status: 'available',
      bytesTotal: 2_000_000,
      createdAt: '2026-05-24T10:00:00.000Z',
      updatedAt: '2026-05-24T10:05:00.000Z',
      driveFileId: 'drive-file-mobile-remote',
    }]))
  })
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

test('mobile File Hub shows Drive files as on-demand until opened', async ({ page }) => {
  await seedRemoteDriveAttachment(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await page.getByTestId('mobile-nav-files').click()
  const fileHub = page.getByTestId('file-hub-pane')
  const fileBoxRow = fileHub.locator('.filebox-row.has-recovery').filter({ hasText: 'pixel-camera.jpg' })
  await expect(fileBoxRow).toHaveCount(1)
  await expect(fileBoxRow).toContainText('Remote only')
  await expect(fileBoxRow).toContainText('Download the file only when you need to open or attach the local blob.')
  await expect(fileBoxRow.getByRole('button', { name: 'Download' })).toBeVisible()
})
