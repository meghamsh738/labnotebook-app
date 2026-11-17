import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const localOrigin = 'http://127.0.0.1:18530'

test('local notebook previews saved account notes without changing the source cache', async ({ page }) => {
  const originalEntries = JSON.stringify({
    'cached-note-1': {
      id: 'cached-note-1', authorId: 'synthetic-user', title: 'Cached study note', dateBucket: '2025-03-04',
      isDaily: true, createdDatetime: '2025-03-04T09:00:00.000Z', lastEditedDatetime: '2025-03-04T09:30:00.000Z',
      content: [{ id: 'cached-block-1', type: 'paragraph', text: 'Synthetic previous note.' }], tags: [], searchTerms: [],
      linkedFiles: ['cached-attachment-1'], pinnedRegions: [],
    },
  })
  const originalAttachments = JSON.stringify([{
    id: 'cached-attachment-1', entryId: 'cached-note-1', type: 'file', filename: 'missing-source.csv',
    filesize: '1 KB', storagePath: 'https://drive.example.test/missing-source.csv', driveFileId: 'remote-only-id',
    syncStatus: 'remote-available',
  }])
  const originalConnection = JSON.stringify({
    storageMode: 'google-drive',
    connectedAccount: { provider: 'google', email: 'synthetic@example.test', storageScope: 'synthetic-account' },
    folderId: 'synthetic-drive-folder',
  })
  const remoteRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== localOrigin) remoteRequests.push(request.url())
  })
  await page.addInitScript(({ originalEntries, originalAttachments, originalConnection }) => {
    localStorage.setItem('labnote.account.synthetic-account.labnote.entries', originalEntries)
    localStorage.setItem('labnote.account.synthetic-account.labnote.attachments', originalAttachments)
    localStorage.setItem('labnote.connected.googleDrive', originalConnection)
  }, { originalEntries, originalAttachments, originalConnection })
  await page.goto('/')

  await page.getByRole('tab', { name: 'Storage' }).click()
  await expect(page.getByTestId('local-workspace-identity')).toHaveText('This browser')
  await expect(page.getByTestId('local-workspace-identity')).toHaveAttribute('data-workspace-scope', 'local-primary-v1')
  await expect(page.getByTestId('cached-notes-preview')).toBeVisible()
  await page.getByRole('button', { name: 'Preview saved notes' }).click()
  await expect(page.getByTestId('cached-note-list')).toContainText('Cached study note')
  const unavailableCount = page.getByTestId('cached-notes-preview').locator('.connected-table-row').filter({ hasText: 'Attachments unavailable' }).locator('strong')
  await expect(unavailableCount).toHaveText('1')
  await page.getByRole('button', { name: 'Copy these notes here' }).click()
  await page.getByRole('button', { name: /Cached study note/ }).first().click()
  await expect(page.getByTestId('journal-page-title')).toContainText('Cached study note')

  await page.getByTestId('editor-tab-files').click()
  await expect(page.locator('#entry-panel-files').getByText('missing-source.csv')).toBeVisible()
  await expect(page.locator('#entry-panel-files').getByText('Unavailable offline')).toBeVisible()
  await page.getByRole('tab', { name: 'Storage' }).click()
  await expect(page.getByTestId('cached-notes-preview')).toContainText('Copied 1 note and 0 attachment files.')
  const sourceState = await page.evaluate(() => ({
    entries: localStorage.getItem('labnote.account.synthetic-account.labnote.entries'),
    attachments: localStorage.getItem('labnote.account.synthetic-account.labnote.attachments'),
    connection: localStorage.getItem('labnote.connected.googleDrive'),
  }))
  expect(sourceState).toEqual({ entries: originalEntries, attachments: originalAttachments, connection: originalConnection })
  expect(remoteRequests).toEqual([])
})

test('local notes and copied experiment files survive offline reopen and portable restore', async ({ page, browser }) => {
  const notebookContext = page.context()
  let notebookPage = page
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'easylab-local-notebook-'))
  const packagePath = path.join(tempRoot, 'qPCR-run.easylab.json')
  const figurePath = path.join(tempRoot, 'result-figure.png')
  const backupPath = path.join(tempRoot, 'notebook-backup.json')
  const restoredPackagePath = path.join(tempRoot, 'restored-qPCR-run.easylab.json')
  const packageValue = {
    format: 'easylab.qpcr',
    schemaVersion: 1,
    run: { runId: 'offline-run-42', revision: 7, name: 'Offline qPCR run' },
  }
  const packageBytes = Buffer.from(JSON.stringify(packageValue, null, 2))
  const figureBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
  await writeFile(packagePath, packageBytes)
  await writeFile(figurePath, figureBytes)

  const remoteRequests: string[] = []
  let restoredContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== localOrigin) remoteRequests.push(request.url())
  })
  await page.addInitScript(() => {
    const oldEntry = {
      id: 'fixture-old-entry', authorId: 'local-user', title: 'Earlier local note', dateBucket: '2024-01-15',
      isDaily: true, createdDatetime: '2024-01-15T10:00:00.000Z', lastEditedDatetime: '2024-01-15T10:00:00.000Z',
      content: [{ id: 'fixture-old-block', type: 'paragraph', text: 'Earlier note retained locally.' }], tags: [], searchTerms: [],
      linkedFiles: [], pinnedRegions: [],
    }
    localStorage.setItem('labnote.account.local-primary-v1.labnote.entries', JSON.stringify({ [oldEntry.id]: oldEntry }))
  })

  try {
    await page.goto('/')
    await expect(page.getByTestId('blank-note-empty-state')).toBeVisible()
    await expect(page.getByRole('button', { name: /Earlier local note/ }).first()).toBeVisible()
    await page.context().setOffline(true)

    await page.getByRole('button', { name: 'Write note' }).click()
    await page.getByTestId('slate-editor').fill('Offline result: treatment stayed stable at 42 units.')
    await page.getByTestId('entry-save').click()
    await expect(page.getByTestId('entry-view')).toContainText('Offline result: treatment stayed stable at 42 units.')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('labnote.account.local-primary-v1.labnote.entries') ?? ''))
      .toContain('Offline result: treatment stayed stable at 42 units.')

    // Reopen the application against the same local origin, then immediately
    // return offline; the saved note must come back from this browser's storage.
    await notebookContext.setOffline(false)
    await page.close()
    notebookPage = await notebookContext.newPage()
    notebookPage.on('request', (request) => {
      if (new URL(request.url()).origin !== localOrigin) remoteRequests.push(request.url())
    })
    await notebookPage.goto('/')
    await expect(notebookPage.getByTestId('entry-view')).toContainText('Offline result: treatment stayed stable at 42 units.')
    await notebookContext.setOffline(true)
    await notebookPage.getByTestId('editor-tab-files').click()
    await notebookPage.locator('[data-testid="experiment-revision-input"]').setInputFiles(packagePath)
    await expect(notebookPage.getByTestId('experiment-revision-label')).toContainText('Offline qPCR run')
    await expect(notebookPage.getByTestId('experiment-revision-label')).toContainText('revision 7')
    await unlink(packagePath)

    await notebookPage.locator('[data-testid="experiment-figures-input"]').setInputFiles(figurePath)
    await expect(notebookPage.getByRole('status')).toContainText('Added 1 figure file to this note.')
    await notebookPage.getByRole('tab', { name: 'Storage' }).click()
    const exportDownload = notebookPage.waitForEvent('download')
    await notebookPage.getByRole('button', { name: 'Export backup' }).click()
    const backupDownload = await exportDownload
    await backupDownload.saveAs(backupPath)
    await expect(notebookPage.locator('[data-testid="sync-pane"]')).toContainText('Backup exported')
    if (process.env.LABNOTE_EVIDENCE_SCREENSHOT) {
      await notebookPage.screenshot({ path: process.env.LABNOTE_EVIDENCE_SCREENSHOT, fullPage: true })
    }

    const backup = JSON.parse(await readFile(backupPath, 'utf8')) as {
      snapshot: { entries: Record<string, { title: string; dateBucket: string; content: Array<{ text?: string }> }>; attachments: Array<{ filename: string; cacheKey?: string; portablePackage?: { system: string; name?: string; revision?: number } }> }
      blobs: Array<{ id: string; dataBase64: string; size: number; sha256: string }>
    }
    const savedText = Object.values(backup.snapshot.entries).flatMap((entry) => entry.content.map((block) => block.text ?? '')).join('\n')
    expect(savedText).toContain('Offline result: treatment stayed stable at 42 units.')
    const packageAttachment = backup.snapshot.attachments.find((attachment) => attachment.filename === path.basename(packagePath))
    const figureAttachment = backup.snapshot.attachments.find((attachment) => attachment.filename === path.basename(figurePath))
    expect(packageAttachment?.portablePackage).toMatchObject({ system: 'qPCR analysis', name: 'Offline qPCR run', revision: 7 })
    expect(packageAttachment?.cacheKey).toBeTruthy()
    expect(figureAttachment?.cacheKey).toBeTruthy()
    const packageBlob = backup.blobs.find((blob) => blob.id === packageAttachment?.cacheKey)
    const figureBlob = backup.blobs.find((blob) => blob.id === figureAttachment?.cacheKey)
    expect(packageBlob?.size).toBe(packageBytes.length)
    expect(Buffer.from(packageBlob?.dataBase64 ?? '', 'base64')).toEqual(packageBytes)
    expect(figureBlob?.size).toBe(figureBytes.length)
    expect(Buffer.from(figureBlob?.dataBase64 ?? '', 'base64')).toEqual(figureBytes)

    restoredContext = await browser.newContext({ acceptDownloads: true })
    const restoredPage = await restoredContext.newPage()
    restoredPage.on('request', (request) => {
      if (new URL(request.url()).origin !== localOrigin) remoteRequests.push(request.url())
    })
    await restoredPage.goto('/')
    await restoredContext.setOffline(true)
    await restoredPage.getByRole('tab', { name: 'Storage' }).click()
    await restoredPage.locator('[data-testid="restore-backup-input"]').setInputFiles(backupPath)
    await expect(restoredPage.locator('[data-testid="sync-pane"]')).toContainText('Backup restored from')
    await restoredPage.locator('[aria-label="Notebook sections"] [role="tab"][aria-label="Today"]').click()
    await expect(restoredPage.getByTestId('entry-view')).toContainText('Offline result: treatment stayed stable at 42 units.')
    await restoredPage.getByTestId('editor-tab-files').click()
    await expect(restoredPage.getByTestId('experiment-revision-label')).toContainText('revision 7')
    const packageRow = restoredPage.locator('.attachment-row').filter({ hasText: path.basename(packagePath) })
    const packageDownload = restoredPage.waitForEvent('download')
    await packageRow.getByRole('button', { name: 'Open' }).click()
    const restoredDownload = await packageDownload
    await restoredDownload.saveAs(restoredPackagePath)
    expect(await readFile(restoredPackagePath)).toEqual(packageBytes)
    await restoredContext.close()
    restoredContext = undefined

    expect(remoteRequests).toEqual([])
  } finally {
    await notebookContext.setOffline(false).catch(() => undefined)
    await restoredContext?.close().catch(() => undefined)
    await unlink(packagePath).catch(() => undefined)
    await unlink(figurePath).catch(() => undefined)
    await unlink(backupPath).catch(() => undefined)
    await unlink(restoredPackagePath).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
