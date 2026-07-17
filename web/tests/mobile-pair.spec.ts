import { test, expect, type Page } from '@playwright/test'

const testPaths = {
  dataRoot: 'C:\\\\Easylab\\\\data',
  attachmentsRoot: 'C:\\\\Easylab\\\\attachments',
  exportRoot: 'C:\\\\Easylab\\\\exports',
  syncRoot: 'C:\\\\Easylab\\\\sync',
}

const testDriveConnection = {
  provider: 'google-drive',
  storageMode: 'google-drive',
  clientId: '',
  webClientId: '252347596316-dpi31hrfh0bl3ggnut5blq02bth0diip.apps.googleusercontent.com',
  desktopClientId: '',
  desktopClientSecret: '',
  folderName: 'Easylab Lab Notebook',
  folderId: 'drive-folder-mobile-test',
  connectedAt: '2026-06-04T10:00:00.000Z',
  lastSyncAt: '2026-06-04T10:05:00.000Z',
  status: 'ready',
  connectedAccount: {
    provider: 'google',
    email: 'scientist@example.com',
    name: 'Scientist Example',
    subject: 'google-subject-mobile-test',
  },
}

async function seedConnectedDrive(page: Page) {
  await page.addInitScript(({ paths, connection }) => {
    window.localStorage.clear()
    window.localStorage.setItem('labnote.setupComplete', '1')
    window.localStorage.setItem('labnote.appPaths', JSON.stringify(paths))
    window.localStorage.setItem('labnote.masterSyncPath', paths.syncRoot)
    window.localStorage.setItem('labnote.connected.googleDrive', JSON.stringify(connection))
    window.localStorage.setItem('labnote.account.google-subject-mobile-test.migration.localNotebookUploaded', '1')
  }, { paths: testPaths, connection: testDriveConnection })
}

async function selectFirstEntry(page: Page) {
  await page.getByTestId('mobile-nav-today').click()
  if (await page.getByTestId('edit-note-btn').count()) return
  if (await page.getByTestId('entry-view').count()) return
  if (await page.getByTestId('slate-editor').count()) return
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
  await page.addInitScript(({ paths, connection }) => {
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
    window.localStorage.setItem('labnote.appPaths', JSON.stringify(paths))
    window.localStorage.setItem('labnote.masterSyncPath', paths.syncRoot)
    window.localStorage.setItem('labnote.connected.googleDrive', JSON.stringify(connection))
    window.localStorage.setItem('labnote.account.google-subject-mobile-test.migration.localNotebookUploaded', '1')
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
  }, { paths: testPaths, connection: testDriveConnection })
}

test('mobile settings hides phone pairing setup and keeps camera capture support', async ({ page }) => {
  await seedConnectedDrive(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await selectFirstEntry(page)
  await page.getByTestId('mobile-nav-entries').click()
  await page.getByTestId('settings-button').click()
  const settingsSurface = page.getByRole('dialog')
  await expect(settingsSurface.getByTestId('mobile-pair-card')).toHaveCount(0)
  await expect(settingsSurface.getByTestId('mobile-pair-link')).toHaveCount(0)
  await expect(settingsSurface.getByTestId('mobile-pair-qr')).toHaveCount(0)
  await expect(settingsSurface.getByText(/Phone access/i)).toHaveCount(0)
  await settingsSurface.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByTestId('editor-tab-note').click()
  await ensureNoteEditMode(page)
  await expect(page.getByTestId('camera-input')).toHaveAttribute('accept', 'image/*')
  await expect(page.getByTestId('camera-input')).toHaveAttribute('capture', 'environment')
  await expect(page.getByTestId('mobile-capture-input')).toHaveAttribute(
    'accept',
    'image/*,.pdf,.csv,.tsv,.xlsx,.xls,.doc,.docx,text/*'
  )
  await expect(page.getByTestId('mobile-capture-input')).not.toHaveAttribute('capture', /.+/)
  await expect(page.getByTestId('mobile-capture-camera-input')).toHaveAttribute('capture', 'environment')

  const toolbarButtonSizes = await page
    .getByTestId('mobile-editor-toolbar')
    .locator('button')
    .evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }))
  expect(toolbarButtonSizes).toHaveLength(6)
  expect(toolbarButtonSizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true)

  const moreFormattingButton = page.getByRole('button', { name: 'More formatting options' })
  await moreFormattingButton.click()
  const formattingMenu = page.locator('#mobile-formatting-menu')
  await expect(formattingMenu).toBeVisible()
  await expect(formattingMenu.getByRole('menuitem', { name: 'Take photo' })).toBeVisible()
  const formattingMenuBox = await formattingMenu.boundingBox()
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  expect(formattingMenuBox).not.toBeNull()
  if (formattingMenuBox) {
    expect(formattingMenuBox.y).toBeGreaterThanOrEqual(0)
    expect(formattingMenuBox.y + formattingMenuBox.height).toBeLessThanOrEqual(viewportHeight)
  }
  await page.keyboard.press('Escape')
  await expect(formattingMenu).toBeHidden()
  await expect(moreFormattingButton).toBeFocused()
})

test('long mobile notes stay within the phone canvas and remain scrollable', async ({ page }) => {
  await seedConnectedDrive(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await selectFirstEntry(page)
  await page.getByTestId('editor-tab-note').click()
  await ensureNoteEditMode(page)
  const editor = page.getByTestId('slate-editor')
  await editor.click()

  for (let line = 1; line <= 72; line += 1) {
    await page.keyboard.insertText(`Mobile bounded line ${line}`)
    await page.keyboard.press('Enter')
  }

  const mobileLayout = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('[data-testid="slate-editor"]')
    if (!editor) return null
    const style = window.getComputedStyle(editor)
    let scrollContainer: HTMLElement | null = editor
    while (scrollContainer && scrollContainer !== document.body) {
      const containerStyle = window.getComputedStyle(scrollContainer)
      if (
        /(auto|scroll)/.test(containerStyle.overflowY) &&
        scrollContainer.scrollHeight > scrollContainer.clientHeight
      ) {
        break
      }
      scrollContainer = scrollContainer.parentElement
    }
    return {
      viewportWidth: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      editorScrollWidth: editor.scrollWidth,
      editorClientWidth: editor.clientWidth,
      editorScrollHeight: editor.scrollHeight,
      editorClientHeight: editor.clientHeight,
      scrollContainerScrollHeight: scrollContainer?.scrollHeight ?? 0,
      scrollContainerClientHeight: scrollContainer?.clientHeight ?? 0,
      overflowWrap: style.overflowWrap,
    }
  })

  expect(mobileLayout).not.toBeNull()
  expect(mobileLayout?.pageScrollWidth).toBeLessThanOrEqual(mobileLayout?.viewportWidth ?? 0)
  expect(mobileLayout?.editorScrollWidth).toBeLessThanOrEqual(mobileLayout?.editorClientWidth ?? 0)
  expect(
    (mobileLayout?.pageScrollHeight ?? 0) > (mobileLayout?.viewportHeight ?? 0) ||
      (mobileLayout?.editorScrollHeight ?? 0) > (mobileLayout?.editorClientHeight ?? 0) ||
      (mobileLayout?.scrollContainerScrollHeight ?? 0) > (mobileLayout?.scrollContainerClientHeight ?? 0)
  ).toBe(true)
  expect(mobileLayout?.overflowWrap).toBe('anywhere')
})

test('fresh mobile launch blocks notebook until Google Drive sign-in', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
  await page.goto('/')

  await expect(page.getByTestId('auth-gate')).toBeVisible()
  await expect(page.getByTestId('auth-gate-connect')).toContainText('Continue with Google')
  await expect(page.getByTestId('mobile-nav-today')).toHaveCount(0)
  await expect(page.getByTestId('sync-pane')).toHaveCount(0)
})

test('mobile sync pane keeps account workspace simple after connection', async ({ page }) => {
  await seedConnectedDrive(page)
  await page.goto('/')

  await page.getByTestId('mobile-nav-sync').click()
  await expect(page.getByTestId('sync-pane')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Google Drive' })).toBeVisible()
  await expect(page.getByText('scientist@example.com', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Sync now/ })).toBeVisible()
  await expect(page.getByText('Developer OAuth setup', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Advanced OAuth client IDs', { exact: true })).toHaveCount(0)
  await expect(page.getByPlaceholder('Web OAuth client ID for browser/PWA')).toHaveCount(0)
})

test('mobile auth gate keeps embedded browser OAuth on the app screen', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
  await page.goto('/?embeddedOAuthWarning=1')

  await expect(page.getByTestId('auth-gate')).toBeVisible()
  await expect(page.getByTestId('embedded-oauth-warning')).toContainText('Google sign-in cannot finish inside this embedded browser.')

  await page.getByTestId('auth-gate-connect').click()
  await expect(page).toHaveURL(/embeddedOAuthWarning=1/)
  await expect(page.getByTestId('auth-gate-error')).toContainText('Google sign-in cannot finish inside this embedded browser.')
})

test('mobile File Hub shows Drive files as on-demand until opened', async ({ page }) => {
  await seedRemoteDriveAttachment(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await expect(page.getByTestId('mobile-nav-files')).toBeVisible()
  await page.getByTestId('mobile-nav-files').click({ force: true })
  const fileHub = page.getByTestId('file-hub-pane')
  await expect(fileHub).toBeVisible()
  const fileBoxRow = fileHub.locator('.filebox-row.has-recovery').filter({ hasText: 'pixel-camera.jpg' })
  await expect(fileBoxRow).toHaveCount(1)
  await expect(fileBoxRow).toContainText('Remote only')
  await expect(fileBoxRow).toContainText('Download the file only when you need to open or attach the local blob.')
  await expect(fileBoxRow.getByRole('button', { name: 'Download' })).toBeVisible()
})

test('mobile bottom navigation keeps stable geometry while switching panes', async ({ page }) => {
  await seedRemoteDriveAttachment(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const nav = page.locator('.mobile-pwa-nav')
  await expect(nav).toBeVisible()
  const targets = [
    page.getByTestId('mobile-nav-today'),
    page.getByTestId('mobile-nav-files'),
    page.getByTestId('mobile-nav-sync'),
    page.getByTestId('mobile-nav-today'),
  ]
  const snapshots: string[] = []

  const readNavGeometry = async () =>
    JSON.stringify(
      await nav.evaluate((element) => {
        const round = (value: number) => Math.round(value)
        const parent = element.getBoundingClientRect()
        return {
          nav: {
            x: round(parent.x),
            y: round(parent.y),
            width: round(parent.width),
            height: round(parent.height),
          },
          buttons: Array.from(element.querySelectorAll('button')).map((button) => {
            const box = button.getBoundingClientRect()
            return {
              text: button.textContent?.trim(),
              x: round(box.x - parent.x),
              y: round(box.y - parent.y),
              width: round(box.width),
              height: round(box.height),
            }
          }),
        }
      })
    )

  for (const target of targets) {
    await target.click()
    await expect(nav.locator('button')).toHaveCount(5)
    snapshots.push(await readNavGeometry())
  }

  expect(new Set(snapshots).size).toBe(1)
})

test('mobile capture is contained in navigation and opens an accessible action sheet', async ({ page }) => {
  await seedConnectedDrive(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await expect(page.locator('.mobile-capture-dock')).toHaveCount(0)
  await page.getByTestId('mobile-nav-capture').click()
  const sheet = page.getByTestId('mobile-capture-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: /Write note/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /Take photo/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /Choose files/ })).toBeVisible()
  await sheet.getByRole('button', { name: 'Close capture menu' }).click()
  await expect(sheet).toHaveCount(0)
})

test('mobile entry editing hides primary navigation until editing finishes', async ({ page }) => {
  await seedConnectedDrive(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  await selectFirstEntry(page)
  await ensureNoteEditMode(page)
  await expect(page.locator('.mobile-pwa-nav')).toBeHidden()
  await page.getByTestId('entry-save').click()
  await expect(page.locator('.mobile-pwa-nav')).toBeVisible()
})
