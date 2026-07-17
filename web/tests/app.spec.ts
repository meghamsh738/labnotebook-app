import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { sampleData } from '../src/data/sampleData'

const here = path.dirname(fileURLToPath(import.meta.url))

const defaultPaths = {
  dataRoot: 'C:\\Easylab\\data',
  attachmentsRoot: 'C:\\Easylab\\attachments',
  exportRoot: 'C:\\Easylab\\exports',
  syncRoot: 'C:\\Easylab\\sync',
}

const defaultDriveConnection = {
  provider: 'google-drive',
  storageMode: 'google-drive',
  clientId: '',
  webClientId: '252347596316-dpi31hrfh0bl3ggnut5blq02bth0diip.apps.googleusercontent.com',
  desktopClientId: '',
  desktopClientSecret: '',
  folderName: 'Easylab Lab Notebook',
  folderId: 'drive-folder-app-test',
  connectedAt: '2026-06-04T10:00:00.000Z',
  lastSyncAt: '2026-06-04T10:05:00.000Z',
  status: 'ready',
  connectedAccount: {
    provider: 'google',
    email: 'scientist@example.com',
    name: 'Scientist Example',
    subject: 'google-subject-app-test',
  },
}

function makeExportableEntry() {
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate()
  ).padStart(2, '0')}`
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const title = formatter.format(today)
  const nowIso = `${todayIso}T11:00:00.000Z`

  return {
    'entry-guided': {
      id: 'entry-guided',
      experimentId: 'exp-guided',
      projectId: 'proj-guided',
      createdDatetime: nowIso,
      lastEditedDatetime: nowIso,
      authorId: 'u1',
      title,
      dateBucket: todayIso,
      isDaily: false,
      content: [
        { id: 'export-heading', type: 'heading', level: 2, text: 'Summary' },
        { id: 'export-body', type: 'paragraph', text: 'Experiment export body.' },
      ],
      tags: [],
      projectTags: ['IL-17 WT KO aging project'],
      experimentTags: ['Genotyping'],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions: [],
    },
  }
}

const exportExperimentFixture = [{
  id: 'exp-guided',
  projectId: 'proj-guided',
  title: 'Export experiment',
  createdAt: '2026-05-23T09:00:00.000Z',
}]

async function boot(
  page: Page,
  opts?: {
    noFail?: '0' | '1'
    failNext?: boolean
    stubPicker?: boolean
    setupComplete?: boolean
    appPaths?: typeof defaultPaths
    driveConnected?: boolean
    entries?: Record<string, unknown>
    attachments?: unknown[]
    fileBoxItems?: unknown[]
    transfers?: unknown[]
    conflicts?: unknown[]
    projects?: unknown[]
    experiments?: unknown[]
    protocols?: unknown[]
  }
) {
  const initOpts = { noFail: '1', setupComplete: true, ...opts }
  const initPayload = {
    ...initOpts,
    entries: opts?.entries ?? Object.fromEntries(sampleData.entries.map((entry) => [entry.id, entry])),
    projects: opts?.projects ?? sampleData.projects,
    experiments: opts?.experiments ?? sampleData.experiments,
    protocols: opts?.protocols ?? sampleData.protocols,
    driveConnection: initOpts.driveConnected === false ? undefined : defaultDriveConnection,
  }
  if (initOpts.setupComplete !== false && !initOpts.appPaths) {
    initPayload.appPaths = defaultPaths
  }
  await page.addInitScript((o) => {
    window.localStorage.clear()
    ;(window as unknown as { __labnoteMockSync?: { noFail?: boolean; failNext?: boolean } }).__labnoteMockSync = {
      noFail: o?.noFail === '1',
      failNext: !!o?.failNext,
    }
    if (o?.noFail) window.localStorage.setItem('labnote.mockSync.noFail', o.noFail)
    if (o?.failNext) window.localStorage.setItem('labnote.mockSync.failNext', '1')
    if (o?.setupComplete !== false) {
      const paths = o?.appPaths
      window.localStorage.setItem('labnote.setupComplete', '1')
      window.localStorage.setItem('labnote.appPaths', JSON.stringify(paths))
      window.localStorage.setItem('labnote.masterSyncPath', paths.syncRoot)
    }
    if (o?.driveConnection) {
      window.localStorage.setItem('labnote.connected.googleDrive', JSON.stringify(o.driveConnection))
      window.localStorage.setItem('labnote.account.google-subject-app-test.migration.localNotebookUploaded', '1')
    }
    if (o?.entries) {
      window.localStorage.setItem('labnote.entries', JSON.stringify(o.entries))
    }
    if (o?.attachments) {
      window.localStorage.setItem('labnote.attachments', JSON.stringify(o.attachments))
    }
    if (o?.fileBoxItems) {
      window.localStorage.setItem('labnote.connected.fileBox', JSON.stringify(o.fileBoxItems))
    }
    if (o?.transfers) {
      window.localStorage.setItem('labnote.connected.transfers', JSON.stringify(o.transfers))
    }
    if (o?.conflicts) {
      window.localStorage.setItem('labnote.connected.conflicts', JSON.stringify(o.conflicts))
    }
    if (o?.projects) {
      window.localStorage.setItem('labnote.projects', JSON.stringify(o.projects))
    }
    if (o?.experiments) {
      window.localStorage.setItem('labnote.experiments', JSON.stringify(o.experiments))
    }
    if (o?.protocols) {
      window.localStorage.setItem('labnote.protocols', JSON.stringify(o.protocols))
    }
    if (o?.stubPicker) {
      ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined
    }
  }, initPayload)
  await page.goto('/')
}

async function openToday(page: Page) {
  await page
    .getByRole('complementary', { name: 'Lab navigation' })
    .getByRole('tab', { name: 'Today', exact: true })
    .click()
}

async function ensureEditMode(page: Page) {
  await page.waitForSelector('[data-testid="entry-save"], button:has-text("Edit")')
  const saveButton = page.getByTestId('entry-save')
  if ((await saveButton.count()) === 0) {
    const editButton = page.getByTestId('edit-note-btn')
    await editButton.click()
  }
  await expect(saveButton).toBeVisible()
}

async function ensureViewMode(page: Page) {
  await page.waitForSelector('[data-testid="entry-save"], button:has-text("Edit")')
  const saveButton = page.getByTestId('entry-save')
  if ((await saveButton.count()) && (await saveButton.isVisible())) {
    const cancelButton = page.getByRole('button', { name: 'Cancel' }).first()
    if ((await cancelButton.count()) && (await cancelButton.isVisible())) {
      await cancelButton.click()
    } else {
      await saveButton.click()
    }
  }
  await expect(page.getByTestId('edit-note-btn')).toBeVisible()
}

async function ensureChecklistInEditMode(page: Page) {
  const checklistRows = page.getByTestId('check-item-text')
  if ((await checklistRows.count()) === 0) {
    await page.getByRole('button', { name: 'Checklist', exact: true }).click()
  }
  await expect(checklistRows.first()).toBeVisible()
}

async function focusBlockById(page: Page, blockId: string) {
  await page.evaluate((id) => {
    const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
    editor?.focus()
    const block = document.querySelector(`[data-block-id="${id}"]`)
    if (!block) return
    const textSpan = block.querySelector('[data-slate-node="text"]')
    const range = document.createRange()
    if (textSpan) {
      range.selectNodeContents(textSpan)
      range.collapse(true)
    } else {
      range.selectNodeContents(block)
      range.collapse(true)
    }
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  }, blockId)
}

async function focusFirstEditableBlock(page: Page) {
  await page.evaluate(() => {
    const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
    editor?.focus()
    const block = editor?.querySelector('[data-block-id]') ?? editor
    if (!block) return
    const textSpan = block.querySelector('[data-slate-node="text"]')
    const range = document.createRange()
    range.selectNodeContents(textSpan ?? block)
    range.collapse(true)
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })
}

async function focusTestIdText(page: Page, testId: string) {
  await page.evaluate((id) => {
    const target = document.querySelector(`[data-testid="${id}"]`)
    if (!target) return
    const textSpan = target.querySelector('[data-slate-node="text"]')
    const range = document.createRange()
    if (textSpan) {
      range.selectNodeContents(textSpan)
      range.collapse(true)
    } else {
      range.selectNodeContents(target)
      range.collapse(true)
    }
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
    const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
    editor?.focus()
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  }, testId)
}

async function clearDateFilters(page: Page) {
  const clearButton = page.getByTestId('calendar-clear')
  if ((await clearButton.count()) && (await clearButton.isVisible())) {
    await clearButton.click()
  }
  const rangeClear = page.getByTestId('date-range-clear')
  if ((await rangeClear.count()) && (await rangeClear.isVisible())) {
    await rangeClear.click()
  }
}

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(
      page.getByRole('complementary', { name: 'Lab navigation' }).getByText('Easylab').first()
    ).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Today', exact: true })).toBeVisible()
    await expect(page.getByTestId('project-tag-filter-trigger')).toBeVisible()
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
    await expect(page.locator('.mobile-close-sidebar')).toBeHidden()
    await expect(page.getByTestId('calendar')).toBeVisible()
  })

  test('auth gate blocks notebook until Google Drive is connected', async ({ page }) => {
    await boot(page, { noFail: '1', driveConnected: false })
    await expect(page.getByTestId('auth-gate')).toBeVisible()
    await expect(page.getByTestId('auth-gate-connect')).toContainText('Continue with Google')
    await expect(page.getByTestId('editor-header')).toHaveCount(0)
    await expect(page.getByTestId('mobile-nav-today')).toHaveCount(0)
  })

  test('sign out clears live notebook state before another Google account opens', async ({ page }) => {
    const accountAEntries = makeExportableEntry()
    await boot(page, { noFail: '1', entries: accountAEntries })
    await page.getByRole('tab', { name: 'Sync', exact: true }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).first().click()
    await expect(page.getByTestId('auth-gate')).toBeVisible()

    const scopedA = 'easylab-journal-core--account-google-subject-app-test'
    await expect.poll(async () => page.evaluate(async (dbName) => {
      const databases = await indexedDB.databases()
      return databases.some((database) => database.name === dbName)
    }, scopedA)).toBe(true)

    const accountBConnection = {
      ...defaultDriveConnection,
      folderId: 'drive-folder-account-b',
      connectedAccount: {
        provider: 'google',
        email: 'researcher-b@example.com',
        name: 'Researcher B',
        subject: 'google-subject-account-b',
      },
    }
    const context = page.context()
    await page.close()
    const accountBPage = await context.newPage()
    await accountBPage.addInitScript(({ key, connection }) => {
      window.localStorage.setItem(key, JSON.stringify(connection))
    }, { key: 'labnote.connected.googleDrive', connection: accountBConnection })
    await accountBPage.goto('/')

    await expect(accountBPage.getByTestId('auth-gate')).toHaveCount(0)
    await expect(accountBPage.getByText('Experiment export body.')).toHaveCount(0)
    await expect.poll(async () => accountBPage.evaluate(async () => {
      const dbName = 'easylab-journal-core--account-google-subject-account-b'
      const databases = await indexedDB.databases()
      if (!databases.some((database) => database.name === dbName)) return -1
      return await new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(dbName)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction('entries', 'readonly')
          const count = transaction.objectStore('entries').count()
          count.onsuccess = () => {
            db.close()
            resolve(count.result)
          }
          count.onerror = () => {
            db.close()
            reject(count.error)
          }
        }
      })
    })).toBe(0)
  })

  test('seed version changes never replace a connected account notebook', async ({ page }) => {
    const cachedEntries = makeExportableEntry()
    const cachedProjects = [{ id: 'proj-guided', title: 'Connected project' }]
    const cachedExperiments = exportExperimentFixture
    const expectedIds = {
      entries: Object.keys(cachedEntries),
      projects: cachedProjects.map(({ id }) => id),
      experiments: cachedExperiments.map(({ id }) => id),
    }
    await boot(page, {
      noFail: '1',
      entries: cachedEntries,
      projects: cachedProjects,
      experiments: cachedExperiments,
    })
    await expect(page.getByText('Experiment export body.')).toBeVisible()
    const readConnectedCacheIds = () => page.evaluate(() => {
      const prefix = 'labnote.account.google-subject-app-test.'
      const entries = JSON.parse(window.localStorage.getItem(`${prefix}labnote.entries`) || '{}') as Record<string, unknown>
      const projects = JSON.parse(window.localStorage.getItem(`${prefix}labnote.projects`) || '[]') as Array<{ id: string }>
      const experiments = JSON.parse(window.localStorage.getItem(`${prefix}labnote.experiments`) || '[]') as Array<{ id: string }>
      return {
        entries: Object.keys(entries).sort(),
        projects: projects.map(({ id }) => id).sort(),
        experiments: experiments.map(({ id }) => id).sort(),
      }
    })
    await expect.poll(readConnectedCacheIds).toEqual(expectedIds)
    await expect.poll(async () => page.evaluate(async () => {
      const dbName = 'easylab-journal-core--account-google-subject-app-test'
      const databases = await indexedDB.databases()
      if (!databases.some((database) => database.name === dbName)) return 0
      return new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(dbName)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const count = db.transaction('entries', 'readonly').objectStore('entries').count()
          count.onsuccess = () => { db.close(); resolve(count.result) }
          count.onerror = () => { db.close(); reject(count.error) }
        }
      })
    })).toBe(1)

    await page.evaluate(() => {
      window.localStorage.removeItem('labnote.entries')
      window.localStorage.setItem('labnote.seedVersion', 'outdated-seed')
    })
    await page.reload()

    await expect(page.getByText('Experiment export body.')).toBeVisible()
    await expect.poll(readConnectedCacheIds).toEqual(expectedIds)
    await expect.poll(async () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('easylab-journal-core--account-google-subject-app-test')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise<number>((resolve, reject) => {
          const request = db.transaction('entries', 'readonly').objectStore('entries').count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    })).toBe(1)
  })

  test('snapshot persistence preserves sync-engine checkpoints', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const dataCorePath = '/src/sync/dataCore.ts'
      const repositoriesPath = '/src/sync/repositories.ts'
      const { persistJournalSnapshot } = await import(/* @vite-ignore */ dataCorePath)
      const { createJournalRepositories } = await import(/* @vite-ignore */ repositoriesPath)
      const accountScope = `checkpoint-${crypto.randomUUID()}`
      const repositories = await createJournalRepositories({ accountScope })
      const syncMeta = {
        id: 'sync-engine',
        updatedAt: '2026-05-23T10:00:00.000Z',
        value: {
          entryHashes: { 'entry-1': 'entry-hash' },
          attachmentHashes: {},
          fileBoxHashes: {},
          transferHashes: {},
          driveChangesToken: 'drive-token-2',
        },
      }
      await repositories.meta.put(syncMeta)
      const testDevice = {
        id: 'checkpoint-device',
        name: 'Desktop',
        platform: 'desktop',
        createdAt: '2026-05-23T00:00:00.000Z',
        lastSeenAt: '2026-05-23T00:00:00.000Z',
      }
      const testEntry = {
        id: 'entry-1',
        authorId: 'user-1',
        title: 'Checkpoint entry',
        dateBucket: '2026-05-23',
        isDaily: true,
        createdDatetime: '2026-05-23T08:00:00.000Z',
        lastEditedDatetime: '2026-05-23T11:00:00.000Z',
        content: [{ id: 'block-entry-1', type: 'paragraph', text: 'note' }],
        tags: [],
        searchTerms: [],
        linkedFiles: [],
        pinnedRegions: [],
      }
      await persistJournalSnapshot({
        entries: { [testEntry.id]: testEntry },
        attachments: [],
        fileBoxItems: [],
        transfers: [],
        conflicts: [],
        tombstones: [],
        device: testDevice,
      }, { device: testDevice, accountScope })
      return {
        engine: await repositories.meta.get('sync-engine'),
        snapshot: await repositories.meta.get('snapshot'),
      }
    })

    expect(result.engine).toMatchObject({
      id: 'sync-engine',
      value: { driveChangesToken: 'drive-token-2' },
    })
    expect(result.snapshot).toMatchObject({ id: 'snapshot' })
  })

  test('dev Drive preview opens the polished Today shell', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear())
    await page.goto('/?devDrivePreview=1')
    await expect(page.getByTestId('auth-gate')).toHaveCount(0)
    await expect(page.getByTestId('editor-header')).toBeVisible()
    await expect(page.getByTestId('journal-page-title')).toBeVisible()
    await expect(page.getByTestId('journal-page-title')).not.toContainText("Today's Entry")
    await expect(page.getByRole('tab', { name: 'Today' })).toBeVisible()
    await expect(page.locator('.entry-context-panel')).toBeHidden()
    await expect(page.getByTestId('mobile-nav-today')).toBeHidden()
  })

  test('UI review fixture never appears in the normal development preview', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear())
    await page.goto('/?devDrivePreview=1')
    await expect(page.getByTestId('entry-list-item-review-entry-today')).toHaveCount(0)
    await expect(page.getByText('TNF dose-response measurements')).toHaveCount(0)
  })

  test('first run setup requires storage paths', async ({ page }) => {
    await boot(page, { noFail: '1', setupComplete: false })
    const setupDialog = page.getByTestId('setup-dialog')
    await expect(setupDialog).toBeVisible()

    await page.getByTestId('setup-data-root').fill('C:\\\\LabNotes\\\\Alpha\\\\data')
    await page.getByTestId('setup-attachments-root').fill('C:\\\\LabNotes\\\\Alpha\\\\attachments')
    await page.getByTestId('setup-export-root').fill('C:\\\\LabNotes\\\\Alpha\\\\exports')
    await page.getByTestId('setup-sync-root').fill('C:\\\\LabNotes\\\\Alpha\\\\sync')
    await page.getByTestId('setup-complete').click()

    await expect(page.getByTestId('setup-dialog')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
  })

  test('today entry opens as a fresh editable note', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await openToday(page)
    await ensureEditMode(page)

    await page.getByTestId('entry-save').click()
    await expect(page.getByTestId('edit-note-btn')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Context' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Setup' })).toHaveCount(0)
  })

  test('legacy daily scaffold is compacted to a blank daily note', async ({ page }) => {
    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const title = formatter.format(today)
    const legacyEntryId = 'entry-legacy-scaffold'
    const nowIso = `${todayIso}T09:00:00.000Z`

    const legacyEntries = {
      [legacyEntryId]: {
        id: legacyEntryId,
        createdDatetime: nowIso,
        lastEditedDatetime: nowIso,
        authorId: 'u1',
        title,
        dateBucket: todayIso,
        isDaily: true,
        content: [
          { id: 'legacy-context-h', type: 'heading', level: 2, text: 'Context', locked: true },
          {
            id: 'legacy-context',
            type: 'paragraph',
            text: '',
            guide: 'What question are you answering today? Include model, conditions, and expected outcome.',
          },
          { id: 'legacy-setup-h', type: 'heading', level: 2, text: 'Setup', locked: true },
          {
            id: 'legacy-setup',
            type: 'checklist',
            items: [
              { id: 'legacy-setup-1', text: '', done: false, guide: 'Sample IDs and groups confirmed' },
              { id: 'legacy-setup-2', text: '', done: false, guide: 'Controls + blanks prepared' },
            ],
          },
          { id: 'legacy-proc-h', type: 'heading', level: 2, text: 'Procedure', locked: true },
          { id: 'legacy-proc', type: 'paragraph', text: '' },
          { id: 'legacy-obs-h', type: 'heading', level: 2, text: 'Observations', locked: true },
          { id: 'legacy-obs', type: 'paragraph', text: '' },
          { id: 'legacy-next-h', type: 'heading', level: 2, text: 'Next steps', locked: true },
          { id: 'legacy-next', type: 'paragraph', text: '' },
        ],
        tags: [],
        projectTags: [],
        experimentTags: [],
        searchTerms: [],
        linkedFiles: [],
        pinnedRegions: [
          {
            id: 'legacy-region-context',
            entryId: legacyEntryId,
            label: 'Context',
            blockIds: ['legacy-context-h', 'legacy-context'],
            linkedAttachments: [],
          },
          {
            id: 'legacy-region-setup',
            entryId: legacyEntryId,
            label: 'Setup',
            blockIds: ['legacy-setup-h', 'legacy-setup'],
            linkedAttachments: [],
          },
        ],
      },
    }

    await boot(page, { noFail: '1', entries: legacyEntries })
    await ensureViewMode(page)

    await expect(page.getByRole('heading', { name: 'Context' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Setup' })).toHaveCount(0)
    await ensureEditMode(page)
    await expect(page.getByTestId('slate-editor')).toBeVisible()
  })

  test('alignment controls render icon buttons', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await expect(page.getByTestId('editor-align-left').locator('.align-icon-left')).toBeVisible()
    await expect(page.getByTestId('editor-align-center').locator('.align-icon-center')).toBeVisible()
    await expect(page.getByTestId('editor-align-right').locator('.align-icon-right')).toBeVisible()
    await expect(page.getByTestId('editor-align-justify').locator('.align-icon-justify')).toBeVisible()

    await page.getByRole('tab', { name: 'Protocols' }).click()
    await page.getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByTestId('protocol-align-left').locator('.align-icon-left')).toBeVisible()
    await expect(page.getByTestId('protocol-align-center').locator('.align-icon-center')).toBeVisible()
    await expect(page.getByTestId('protocol-align-right').locator('.align-icon-right')).toBeVisible()
    await expect(page.getByTestId('protocol-align-justify').locator('.align-icon-justify')).toBeVisible()
  })

  test('compact header keeps tools visible', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await openToday(page)
    await ensureEditMode(page)

    const header = page.getByTestId('editor-header')
    await expect(header).toBeVisible()
    await expect(page.getByTestId('entry-tags-inline')).toBeVisible()
    await expect(page.getByTestId('editor-toolbar')).toBeVisible()
    await expect(page.getByTestId('editor-tab-note')).toBeVisible()
    await expect(page.getByTestId('editor-tab-workbook')).toBeVisible()
    await expect(page.getByTestId('editor-tab-files')).toBeVisible()
    await expect(page.getByTestId('editor-tab-details')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Inbox' })).toHaveCount(0)
    const toolbarBox = await page.getByTestId('editor-toolbar').boundingBox()
    const moreBox = await page.getByRole('button', { name: 'More editor options' }).boundingBox()
    expect(toolbarBox).not.toBeNull()
    expect(moreBox).not.toBeNull()
    if (toolbarBox && moreBox) {
      expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width + 1)
    }
  })

  test('entry tabs keep one accessible order and support arrow-key navigation', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await openToday(page)

    const noteTab = page.getByTestId('editor-tab-note')
    await noteTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('editor-tab-workbook')).toBeFocused()
    await expect(page.getByTestId('entry-workbook')).toBeVisible()
    await page.keyboard.press('End')
    await expect(page.getByTestId('editor-tab-details')).toBeFocused()
    await expect(page.locator('#entry-panel-details')).toBeVisible()
    await page.keyboard.press('Home')
    await expect(noteTab).toBeFocused()
    await expect(page.locator('#entry-panel-note')).toBeVisible()
  })

  test('can add a missed entry from the calendar', async ({ page }) => {
    await boot(page, { noFail: '1' })

    const targetIso = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid^="calendar-day-"]'))
      const candidate = buttons.find((btn) => !btn.classList.contains('has-entry') && !btn.classList.contains('outside'))
      if (!candidate) return null
      const testId = candidate.getAttribute('data-testid') ?? ''
      return testId.replace('calendar-day-', '')
    })

    if (!targetIso) throw new Error('No available calendar day without entry.')

    await page.getByTestId(`calendar-day-${targetIso}`).click()
    const createButton = page.getByTestId('calendar-create-entry')
    await expect(createButton).toBeVisible()
    await createButton.click()
    await ensureEditMode(page)
    await expect(page.getByTestId('entry-date-bucket')).toHaveText(targetIso)
  })

  test('fresh daily note starts blank and accepts typing', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await openToday(page)
    await expect(page.getByTestId('blank-note-empty-state')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Write note' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add files' })).toBeVisible()
    await ensureEditMode(page)

    const guideText = '• Microglia activation measured by CD68 and Iba1.'
    await expect(page.getByText(guideText)).toHaveCount(0)
    await focusFirstEditableBlock(page)
    await page.keyboard.type('Testing placeholder clearing')

    await expect(page.getByTestId('slate-editor')).toContainText('Testing placeholder clearing')
    await expect(page.getByText(guideText)).toHaveCount(0)
  })

  test('fresh daily note line breaks do not recreate guided prompts', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await openToday(page)
    await ensureEditMode(page)

    const guideText = '• Microglia activation measured by CD68 and Iba1.'

    await focusFirstEditableBlock(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await expect(page.getByText(guideText)).toHaveCount(0)
  })

  test('undo and redo restore the latest edit', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.evaluate((blockId) => {
      const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      editor?.focus()
      const block = document.querySelector(`[data-block-id="${blockId}"]`)
      if (!block) return
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    }, 'b-context')
    await page.keyboard.insertText('Undo me')

    const editor = page.getByTestId('slate-editor')
    await expect(editor).toContainText('Undo me')
    await expect(page.getByTestId('editor-undo')).toBeEnabled()
    await page.getByTestId('editor-undo').click()
    await expect(editor).not.toContainText('Undo me')
    await expect(page.getByTestId('editor-redo')).toBeEnabled()
    await page.getByTestId('editor-redo').click()
    await expect(editor).toContainText('Undo me')
  })

  test('symbol list inserts a bulleted line', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.getByTestId('editor-list-dot').click()
    await focusTestIdText(page, 'list-item-text')
    await page.keyboard.type('Bullet item')

    await expect(page.getByTestId('list-symbol').first()).toContainText('•')
    await expect(page.getByTestId('slate-editor')).toContainText('Bullet item')
  })

  test('camera input is available for mobile capture', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)
    const cameraInput = page.getByTestId('camera-input')
    await expect(cameraInput).toHaveAttribute('capture', 'environment')
  })

  test('mobile image upload inserts into today entry and stays visible after save', async ({ page }) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page, { noFail: '1' })
    await page.getByTestId('mobile-nav-today').click()
    await ensureEditMode(page)

    const imageInput = page.locator('input[type="file"][accept="image/*"]:not([capture])').first()
    await expect(page.locator('input[type="file"][accept="image/*"]:not([capture])')).toHaveCount(1)
    await imageInput.setInputFiles({
      name: 'mobile-upload.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2fXU4AAAAASUVORK5CYII=',
        'base64'
      ),
    })
    await expect.poll(async () => page.evaluate(() => {
      const raw =
        window.localStorage.getItem('labnote.account.google-subject-app-test.labnote.attachments') ||
        window.localStorage.getItem('labnote.attachments')
      try {
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed.length : 0
      } catch {
        return 0
      }
    })).toBeGreaterThan(0)

    const editor = page.getByTestId('slate-editor')
    await expect(editor).toContainText('mobile-upload.png')
    await expect(page.locator('.attachment-block-image').first()).toBeVisible()

    await page.getByTestId('entry-save').click()
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    const imageCard = page.getByTestId('image-block-card').first()
    await expect(imageCard).toBeVisible()
    await expect(imageCard.getByTestId('image-block-mobile')).toBeVisible()
    await expect(imageCard).toContainText('mobile-upload.png')
  })

  test('mobile navigation exposes older entries and protocols', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page, { noFail: '1' })

    await expect(page.getByTestId('mobile-open-sidebar')).toBeVisible()
    await page.getByTestId('mobile-open-sidebar').click()
    const sidebar = page.getByRole('complementary', { name: 'Lab navigation' })
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByTestId('entry-list').getByRole('button')).not.toHaveCount(0)

    await sidebar.getByRole('tab', { name: 'Protocols', exact: true }).click()
    await expect(page.locator('aside[aria-label="Lab navigation"]')).not.toHaveClass(/mobile-open/)
    await expect(page.getByTestId('protocol-view')).toBeVisible()
  })

  test('tablet drawer preserves editor width and closes before entry actions', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 })
    await boot(page, { noFail: '1' })

    await page.getByTestId('mobile-open-sidebar').click()
    const sidebar = page.getByRole('complementary', { name: 'Lab navigation' })
    const editor = page.locator('main.panel.editor')
    await expect(sidebar).toHaveClass(/mobile-open/)
    await expect.poll(() => editor.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(700)

    const editorBounds = await editor.boundingBox()
    expect(editorBounds).not.toBeNull()
    expect(editorBounds!.x).toBeGreaterThanOrEqual(63)
    expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(821)

    await sidebar.getByTestId('entry-list').getByRole('button').last().click()
    await expect(sidebar).not.toHaveClass(/mobile-open/)

    await page.getByTestId('editor-tab-workbook').click()
    await expect(page.getByTestId('entry-workbook')).toBeVisible()
    await page.getByTestId('editor-tab-note').click()
    await page.getByTestId('edit-note-btn').click()
    await expect(page.getByTestId('entry-save')).toBeVisible()
  })

  test('phone drawer does not remain stale after entry selection', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page, { noFail: '1' })

    await page.getByTestId('mobile-open-sidebar').click()
    const sidebar = page.locator('aside[aria-label="Lab navigation"]')
    await expect(sidebar).toHaveClass(/mobile-open/)
    await sidebar.getByTestId('entry-list').getByRole('button').last().click()
    await expect(sidebar).not.toHaveClass(/mobile-open/)

    await page.getByTestId('editor-tab-files').click()
    await expect(page.locator('.files-tab-panel')).toBeVisible()
  })

  test('tablet collapsed rail keeps the editor aligned after resize', async ({ page }) => {
    await page.setViewportSize({ width: 1212, height: 720 })
    await boot(page, { noFail: '1' })
    await page.getByTestId('sidebar-toggle').click()
    await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/)

    await page.setViewportSize({ width: 820, height: 1180 })
    const sidebar = page.locator('aside[aria-label="Lab navigation"]')
    const editor = page.locator('main.panel.editor')
    await expect.poll(async () => {
      const sidebarBounds = await sidebar.boundingBox()
      const editorBounds = await editor.boundingBox()
      if (!sidebarBounds || !editorBounds) return -1
      return editorBounds.x - (sidebarBounds.x + sidebarBounds.width)
    }).toBeGreaterThanOrEqual(0)
    await expect.poll(() => editor.evaluate((element) => element.getBoundingClientRect().x)).toBeGreaterThanOrEqual(63)
  })

  for (const [label, expectedTestId] of [['Files', 'file-hub-pane'], ['Sync', 'sync-pane']] as const) {
    test(`phone drawer closes when selecting ${label}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await boot(page, { noFail: '1' })
      await page.getByTestId('mobile-open-sidebar').click()
      const sidebar = page.locator('aside[aria-label="Lab navigation"]')
      await sidebar.getByRole('tab', { name: label, exact: true }).click()
      await expect(sidebar).not.toHaveClass(/mobile-open/)
      await expect(page.getByTestId(expectedTestId)).toBeVisible()
    })
  }

  test('mobile uses compact image rows while desktop keeps preview images', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const title = formatter.format(today)
    const entryId = 'entry-mobile-image'
    const imageId = 'att-mobile-image'
    const nowIso = `${todayIso}T10:00:00.000Z`
    const imageDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2fXU4AAAAASUVORK5CYII='

    await boot(page, {
      noFail: '1',
      entries: {
        [entryId]: {
          id: entryId,
          createdDatetime: nowIso,
          lastEditedDatetime: nowIso,
          authorId: 'u1',
          title,
          dateBucket: todayIso,
          isDaily: true,
          content: [
            { id: 'ctx-h', type: 'heading', level: 2, text: 'Context', locked: true },
            { id: 'ctx-p', type: 'paragraph', text: 'Camera capture attached.' },
            { id: 'img-1', type: 'image', attachmentId: imageId, caption: 'mobile-capture.png' },
          ],
          tags: [],
          projectTags: [],
          experimentTags: [],
          searchTerms: [],
          linkedFiles: [imageId],
          pinnedRegions: [
            { id: 'region-ctx', entryId, label: 'Context', blockIds: ['ctx-h', 'ctx-p'], linkedAttachments: [] },
          ],
        },
      },
      attachments: [
        {
          id: imageId,
          entryId,
          type: 'image',
          filename: 'mobile-capture.png',
          filesize: '12 KB',
          storagePath: 'mobile-capture.png',
          thumbnail: imageDataUrl,
        },
      ],
    })
    await ensureViewMode(page)

    const imageCard = page.getByTestId('image-block-card').first()
    await expect(imageCard).toBeVisible()
    await expect(imageCard.getByTestId('image-block-mobile')).toBeVisible()
    await expect(imageCard.getByTestId('image-block-preview')).toBeHidden()
    await expect(imageCard).toContainText('mobile-capture.png')

    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(imageCard.getByTestId('image-block-preview')).toBeVisible()
    await expect(imageCard.getByTestId('image-block-mobile')).toBeHidden()
  })

  test('context stays editable after backspace at start', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await focusBlockById(page, 'b-context')
    await page.keyboard.insertText('Start text')
    const editor = page.getByTestId('slate-editor')
    await expect(editor).toContainText('Start text')

    await focusBlockById(page, 'b-context')
    await page.keyboard.press('Home')
    await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorOffset ?? -1)).toBe(0)
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText('X')

    await expect(editor).toContainText('XStart text')
  })

  test('context draft persists when toggling tags', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.evaluate((blockId) => {
      const editor = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      editor?.focus()
      const block = document.querySelector(`[data-block-id="${blockId}"]`)
      if (!block) return
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    }, 'b-context')
    await page.keyboard.insertText('Tag-safe draft')

    await page.getByRole('tab', { name: /Details/i }).click()
    await page.getByTestId('entry-project-tags').locator('button').first().click()

    await page.getByRole('tab', { name: /Note/i }).click()
    const editor = page.getByTestId('slate-editor')
    await expect(editor).toContainText('Tag-safe draft')
  })

  test('header metadata opens the details tag editor', async ({ page }) => {
    await boot(page, { noFail: '1' })

    await page.getByTestId('entry-tags-inline').click()
    await expect(page.getByTestId('editor-tab-details')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('entry-project-tags')).toBeVisible()
  })

  test('tabs switch between note, files, and details in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.getByRole('tab', { name: /Details/i }).click()
    await expect(page.getByTestId('entry-project-tags')).toBeVisible()

    await page.getByTestId('editor-tab-files').click()
    await expect(page.locator('.files-card')).toBeVisible()
    await expect(page.locator('.files-card').getByRole('button', { name: 'Add evidence' })).toBeVisible()

    await page.getByRole('tab', { name: /Note/i }).click()
    await expect(page.getByTestId('slate-editor')).toBeVisible()
  })

  test('entry selection switches across calendar filters', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureViewMode(page)

    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const yesterdayIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(
      yesterday.getDate()
    ).padStart(2, '0')}`
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const yesterdayTitle = formatter.format(yesterday)

    await clearDateFilters(page)
    await page.getByTestId('entry-list').getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await page.getByTestId(`calendar-day-${todayIso}`).click()
    await expect(page.getByTestId('entry-date-bucket')).toHaveText(todayIso)

    await page.getByTestId(`calendar-day-${yesterdayIso}`).click()
    await expect(page.getByTestId('entry-date-bucket')).toHaveText(yesterdayIso)
  })

  test('checklist text flows horizontally in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)
    await ensureChecklistInEditMode(page)

    const firstItem = page.getByTestId('check-item-text').first()
    await expect(firstItem).toBeVisible()
    const box = await page.locator('.check-item').first().boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.width).toBeGreaterThan(120)
      expect(box.width).toBeGreaterThan(box.height)
    }
  })

  test('master sync root prefixes file destinations', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await openToday(page)
    await ensureEditMode(page)

    await page.getByRole('tab', { name: /Note/ }).click()
    await page.getByRole('button', { name: 'More editor options' }).click()
    await page.getByRole('menuitem', { name: 'Link file path' }).click()
    await page.getByTestId('file-destination-path').fill('run1.csv')
    await page.getByTestId('file-destination-add').click()

    await page.getByTestId('editor-tab-files').click()
    await expect(page.locator('.attachment-row').filter({ hasText: 'run1.csv' })).toBeVisible()
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw =
            window.localStorage.getItem('labnote.account.google-subject-app-test.labnote.attachments') ||
            window.localStorage.getItem('labnote.attachments') ||
            '[]'
          const attachments = JSON.parse(raw) as Array<{ storagePath?: string }>
          return attachments.some(
            (attachment) => attachment.storagePath === 'C:\\Easylab\\sync\\run1.csv'
          )
        })
      )
      .toBe(true)

  })

  test('auto-save downloads when disk cache is unavailable', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await openToday(page)
    await ensureEditMode(page)

    const editor = page.getByTestId('slate-editor')
    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="slate-editor"]') as HTMLElement | null
      if (!root) return
      const block = root.querySelector('p.block-paragraph') as HTMLElement | null
      if (!block) return
      root.focus()
      const textSpan = block.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      if (textSpan) {
        range.selectNodeContents(textSpan)
        range.collapse(true)
      } else {
        range.selectNodeContents(block)
        range.collapse(true)
      }
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(range)
    })
    await page.keyboard.insertText('Auto-save download text')
    await expect(editor).toContainText('Auto-save download text')
    await expect(page.getByTestId('entry-save')).toBeVisible()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('entry-save').click(),
    ])
    const path = await download.path()
    const buffer = fs.readFileSync(path as string)
    expect(buffer.toString('utf8')).toContain('Auto-save download text')
  })

  test('view-mode checklist toggle syncs', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)
    await ensureChecklistInEditMode(page)
    await page.getByTestId('entry-save').click()
    await ensureViewMode(page)

    const firstChecklist = page.locator('.check-row').first()
    await expect(firstChecklist).toBeVisible()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText('Saved to Drive')
  })

  test('today entry opens in view mode and exposes an explicit edit action', async ({ page }) => {
    await boot(page, { noFail: '1' })

    await expect(page.getByTestId('entry-save')).toHaveCount(0)
    await expect(page.getByTestId('edit-note-btn')).toBeVisible()
    await expect(page.getByTestId('blank-note-empty-state')).toBeVisible()
  })

  test('workbook Enter commits the cell and moves focus down', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('editor-tab-workbook').click()

    const firstCell = page.getByRole('textbox', { name: 'Cell A1', exact: true })
    const nextCell = page.getByRole('textbox', { name: 'Cell A2', exact: true })
    await firstCell.fill('sample value')
    await firstCell.press('Enter')

    await expect(firstCell).toHaveValue('sample value')
    await expect(nextCell).toBeFocused()

    const formulaBar = page.getByRole('textbox', { name: 'Formula bar for A2', exact: true })
    await formulaBar.fill('formula bar value')
    await formulaBar.press('Enter')

    const thirdCell = page.getByRole('textbox', { name: 'Cell A3', exact: true })
    await expect(nextCell).toHaveValue('formula bar value')
    await expect(thirdCell).toBeFocused()

    await thirdCell.press('Shift+Enter')
    await expect(nextCell).toBeFocused()
  })

  test('long note content stays inside a scrollable writing surface', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)
    const editor = page.getByTestId('slate-editor')
    await editor.click()

    for (let line = 1; line <= 36; line += 1) {
      await page.keyboard.insertText(`Contained line ${line}`)
      await page.keyboard.press('Enter')
    }

    const containment = await page.locator('.editor-surface').evaluate((surface) => {
      const editable = surface.querySelector<HTMLElement>('[data-testid="slate-editor"]')
      const status = surface.querySelector<HTMLElement>('.editor-note-status')
      if (!editable || !status) return null
      const surfaceRect = surface.getBoundingClientRect()
      const editableRect = editable.getBoundingClientRect()
      const statusRect = status.getBoundingClientRect()
      const style = window.getComputedStyle(editable)
      return {
        overflowY: style.overflowY,
        hasInternalScroll: editable.scrollHeight > editable.clientHeight,
        editorInsideSurface: editableRect.bottom <= surfaceRect.bottom + 1,
        statusInsideSurface: statusRect.bottom <= surfaceRect.bottom + 1,
      }
    })

    expect(containment).not.toBeNull()
    expect(containment?.overflowY).toBe('auto')
    expect(containment?.hasInternalScroll).toBe(true)
    expect(containment?.editorInsideSurface).toBe(true)
    expect(containment?.statusInsideSurface).toBe(true)
  })

  test('sync failures can be retried', async ({ page }) => {
    await boot(page, { noFail: '0', failNext: true })
    await ensureEditMode(page)
    await ensureChecklistInEditMode(page)
    await page.getByTestId('entry-save').click()
    await ensureViewMode(page)

    const firstChecklist = page.locator('.check-row').first()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText(/failed/i)

    await page.getByTestId('entry-more-trigger').click()
    await expect(page.getByTestId('sync-action')).toHaveText(/retry sync/i)
    await page.getByTestId('sync-action').click()
    await expect(statusChip).toContainText('Saved to Drive')
  })

  test('export markdown fallback triggers downloads', async ({ page }) => {
    let dialogText = ''
    page.on('dialog', (d) => {
      dialogText = d.message()
      d.dismiss()
    })

    await boot(page, {
      noFail: '1',
      stubPicker: true,
      entries: makeExportableEntry(),
      experiments: exportExperimentFixture,
    })
    await page.getByTestId('entry-more-trigger').click()
    await expect(page.getByTestId('export-md')).toBeVisible()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-md').click(),
    ])
    expect(download.suggestedFilename().endsWith('.md')).toBeTruthy()
    await expect.poll(() => dialogText).toContain('manifest')
  })

  test('export pdf opens printable page', async ({ page }) => {
    await boot(page, {
      noFail: '1',
      entries: makeExportableEntry(),
      experiments: exportExperimentFixture,
    })
    await page.getByTestId('entry-more-trigger').click()
    await expect(page.getByTestId('export-pdf')).toBeVisible()
    const [popup] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByTestId('export-pdf').click(),
    ])
    await popup.waitForLoadState('domcontentloaded')
    await expect(popup.locator('text=Print / Save to PDF')).toBeVisible()
  })

  test('settings modal opens', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('settings-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Notebook', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Drive notebook', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Appearance', { exact: true })).toHaveCount(0)
    await expect(dialog.getByTestId('mobile-pair-card')).toHaveCount(0)

    const advanced = dialog.getByTestId('settings-advanced')
    await advanced.locator('summary').click()
    await expect(advanced.getByText('File access', { exact: true })).toBeVisible()
    await expect(dialog.getByTestId('import-legacy')).toBeVisible()
    await expect(dialog.getByTestId('import-legacy-file')).toBeVisible()
    await expect(advanced.getByText('Notebook data', { exact: true })).toBeVisible()
    await expect(advanced.getByText('Attachments', { exact: true })).toBeVisible()
    await expect(advanced.getByText('Exports', { exact: true })).toBeVisible()
  })

  test('connected file hub panes are reachable', async ({ page }) => {
    await boot(page, { noFail: '1' })

    await page.getByTestId('editor-tab-files').click()
    await expect(page.locator('.files-card').getByText('Evidence', { exact: true })).toBeVisible()
    await expect(page.getByTestId('entry-filebox-panel')).toHaveCount(0)

    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: 'Files' }).click()
    await expect(page.getByTestId('file-hub-pane')).toBeVisible()
    await expect(page.getByTestId('file-hub-pane').getByRole('heading', { name: 'Files' })).toBeVisible()
    await expect(page.getByTestId('file-hub-pane')).toContainText(/Evidence/i)

    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: /^Sync/i }).click()
    await expect(page.getByTestId('sync-pane')).toBeVisible()
    await expect(page.getByTestId('sync-pane').getByRole('heading', { name: 'Google Drive' })).toBeVisible()
    await expect(page.getByTestId('sync-pane').getByText('Account', { exact: true })).toBeVisible()
    await expect(page.getByTestId('sync-pane').locator('.section-title').filter({ hasText: /^Notebook$/ })).toBeVisible()
    await page.getByTestId('sync-pane').locator('summary').filter({ hasText: 'Notebook settings' }).click()
    await expect(page.getByText('Notebook name', { exact: true })).toBeVisible()
    await expect(page.getByText('Last saved', { exact: true })).toBeVisible()
    await expect(page.getByText('Developer OAuth setup', { exact: true })).toHaveCount(0)
    await expect(page.getByPlaceholder('Desktop OAuth client ID for Electron')).toHaveCount(0)
    await expect(page.getByPlaceholder('Web OAuth client ID for browser/PWA')).toHaveCount(0)
    await expect(page.getByTestId('import-oauth-json')).toHaveCount(0)
    await page.locator('summary').filter({ hasText: 'Advanced' }).click()
    await expect(page.getByRole('button', { name: 'Export backup' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore backup' })).toBeVisible()
  })

  test('primary app routes avoid prototype and developer language', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const forbidden = [
      /workspace@easylab\.local/i,
      /\bSync queue\b/i,
      /\bDiagnostics\b/i,
      /\bDevice id\b/i,
      /\bDrive presence\b/i,
      /\bLocal-first\b/i,
      /\bTelegram\b/i,
      /\bWhatsApp\b/i,
      /\bTailscale\b/i,
      /\bQR\b/i,
      /\bOAuth client\b/i,
      /\bDeveloper OAuth\b/i,
      /\bRequest persistent storage\b/i,
      /\bValidate write access\b/i,
      /\bStorage folders\b/i,
      /\bImport from folder\b/i,
      /\bImport from file\b/i,
    ]
    const expectPrimaryCopyClean = async (label: string) => {
      const text = await page.locator('body').innerText()
      for (const pattern of forbidden) {
        expect(text, `${label} should not expose ${pattern}`).not.toMatch(pattern)
      }
    }

    await expectPrimaryCopyClean('Today')
    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: 'Files' }).click()
    await expect(page.getByTestId('file-hub-pane')).toBeVisible()
    await expectPrimaryCopyClean('Files')
    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: /^Sync/i }).click()
    await expect(page.getByTestId('sync-pane')).toBeVisible()
    await expectPrimaryCopyClean('Sync')
    await page.getByTestId('settings-button').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expectPrimaryCopyClean('Settings')
  })

  test('sync pane reports PWA storage health and can request persistence', async ({ page }) => {
    await page.addInitScript(() => {
      let persisted = false
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: {
          persisted: async () => persisted,
          persist: async () => {
            persisted = true
            return true
          },
          estimate: async () => ({ usage: 4096, quota: 1024 * 1024 * 64 }),
        },
      })
    })
    await boot(page, { noFail: '1' })

    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: 'Files' }).click()
    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: /^Sync/i }).click()
    await page.locator('summary').filter({ hasText: 'Advanced' }).click()
    await expect(page.getByTestId('storage-health-card')).toBeVisible()
    await expect(page.getByText('The notebook keeps an offline copy on this device. Files download when opened.')).toBeVisible()
    await expect(page.getByTestId('storage-persistence-status')).toHaveText('Best effort')
    await expect(page.getByText('4 KB')).toBeVisible()
    await expect(page.getByText('64 MB')).toBeVisible()

    await page.getByTestId('storage-persist-button').click()
    await expect(page.getByTestId('storage-persistence-status')).toHaveText('Persistent')
  })

  test('file hub shows actionable recovery for failed transfers', async ({ page }) => {
    const entry = {
      id: 'entry-recovery-day',
      createdDatetime: '2026-05-24T09:00:00.000Z',
      lastEditedDatetime: '2026-05-24T10:00:00.000Z',
      authorId: 'u1',
      title: 'Recovery day',
      dateBucket: '2026-05-24',
      isDaily: true,
      content: [{ id: 'recovery-block', type: 'paragraph', text: 'file recovery note' }],
      tags: [],
      searchTerms: [],
      linkedFiles: ['att-failed-drive'],
      pinnedRegions: [],
    }
    await boot(page, {
      noFail: '1',
      entries: { [entry.id]: entry },
      attachments: [{
        id: 'att-failed-drive',
        entryId: entry.id,
        type: 'file',
        filename: 'failed-upload.csv',
        filesize: '12 KB',
        storagePath: 'attachments/2026-05-24/failed-upload.csv',
        driveFileId: 'drive-file-failed',
        syncStatus: 'failed',
      }],
      fileBoxItems: [{
        id: 'fb-failed-drive',
        entryId: entry.id,
        attachmentId: 'att-failed-drive',
        filename: 'failed-upload.csv',
        filesize: '12 KB',
        sourceDeviceId: 'dev-desktop',
        sourceDeviceName: 'Desktop Lab Notebook',
        status: 'failed',
        createdAt: '2026-05-24T10:00:00.000Z',
        updatedAt: '2026-05-24T10:05:00.000Z',
        driveFileId: 'drive-file-failed',
        lastError: 'Google Drive request failed (503): remote upload failed',
      }],
      transfers: [{
        id: 'tr-failed-drive',
        fileBoxItemId: 'fb-failed-drive',
        entryId: entry.id,
        attachmentId: 'att-failed-drive',
        filename: 'failed-upload.csv',
        fromDeviceId: 'dev-desktop',
        fromDeviceName: 'Desktop Lab Notebook',
        provider: 'google-drive',
        status: 'failed',
        bytesTotal: 12000,
        createdAt: '2026-05-24T10:00:00.000Z',
        updatedAt: '2026-05-24T10:05:00.000Z',
        lastError: 'remote upload failed',
      }],
    })

    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: 'Files' }).click()
    const fileHub = page.getByTestId('file-hub-pane')
    const failedRow = fileHub.locator('.filebox-row.has-recovery').filter({ hasText: 'failed-upload.csv' }).filter({ hasText: 'Sync failed' })
    await expect(failedRow).toHaveCount(1)
    await expect(failedRow.getByRole('button', { name: 'Retry sync' })).toBeVisible()
    await expect(failedRow.getByRole('button', { name: 'Attach' })).toBeDisabled()
  })

  test('remote Drive attachments are shown as on-demand until downloaded', async ({ page }) => {
    const entry = {
      id: 'entry-remote-drive-day',
      createdDatetime: '2026-05-24T09:00:00.000Z',
      lastEditedDatetime: '2026-05-24T10:00:00.000Z',
      authorId: 'u1',
      title: 'Remote Drive day',
      dateBucket: '2026-05-24',
      isDaily: true,
      content: [{ id: 'remote-block', type: 'paragraph', text: 'remote attachment note' }],
      tags: [],
      searchTerms: [],
      linkedFiles: ['att-remote-drive'],
      pinnedRegions: [],
    }

    await boot(page, {
      noFail: '1',
      entries: { [entry.id]: entry },
      attachments: [{
        id: 'att-remote-drive',
        entryId: entry.id,
        type: 'image',
        filename: 'phone-capture.jpg',
        filesize: '2 MB',
        bytes: 2_000_000,
        storagePath: 'attachments/2026-05-24/att-remote-drive-phone-capture.jpg',
        contentType: 'image/jpeg',
        mimeType: 'image/jpeg',
        sha256: 'abc123remotehash',
        driveFileId: 'drive-file-remote',
        syncStatus: 'remote-available',
        createdAt: '2026-05-24T10:00:00.000Z',
        updatedAt: '2026-05-24T10:05:00.000Z',
      }],
      fileBoxItems: [{
        id: 'fb-remote-drive',
        entryId: entry.id,
        attachmentId: 'att-remote-drive',
        filename: 'phone-capture.jpg',
        filesize: '2 MB',
        contentType: 'image/jpeg',
        sourceDeviceId: 'dev-pixel',
        sourceDeviceName: 'Pixel 7a',
        status: 'available',
        createdAt: '2026-05-24T10:00:00.000Z',
        updatedAt: '2026-05-24T10:05:00.000Z',
        driveFileId: 'drive-file-remote',
      }],
      transfers: [{
        id: 'tr-remote-drive',
        fileBoxItemId: 'fb-remote-drive',
        entryId: entry.id,
        attachmentId: 'att-remote-drive',
        filename: 'phone-capture.jpg',
        fromDeviceId: 'dev-pixel',
        fromDeviceName: 'Pixel 7a',
        provider: 'google-drive',
        status: 'available',
        bytesTotal: 2_000_000,
        createdAt: '2026-05-24T10:00:00.000Z',
        updatedAt: '2026-05-24T10:05:00.000Z',
        driveFileId: 'drive-file-remote',
      }],
    })

    await clearDateFilters(page)
    await page.getByTestId('entry-list').getByRole('button', { name: /Remote Drive day/ }).click()
    await page.getByTestId('editor-tab-files').click()
    const filesPanel = page.locator('.files-tab-panel')
    const fileRow = filesPanel.locator('.attachment-row.remote-only').filter({ hasText: 'phone-capture.jpg' })
    await expect(fileRow).toHaveCount(1)
    await expect(fileRow).toContainText('Drive only')
    await expect(fileRow.getByRole('button', { name: 'Download' })).toBeVisible()
    await expect(fileRow.getByRole('button', { name: 'Open' })).toHaveCount(0)
    await expect(fileRow.getByRole('button', { name: 'Remove local' })).toHaveCount(0)

    const fileBox = page.getByTestId('entry-filebox-panel')
    const fileBoxRow = fileBox.locator('.filebox-row.has-recovery').filter({ hasText: 'phone-capture.jpg' })
    await expect(fileBoxRow).toHaveCount(1)
    await expect(fileBoxRow).toContainText('Remote only')
    await expect(fileBoxRow).toContainText('Download the file only when you need to open or attach the local blob.')
    await expect(fileBoxRow.getByRole('button', { name: 'Download' })).toBeVisible()
  })

  test('sync conflict actions can keep both entry copies', async ({ page }) => {
    const entry = {
      id: 'entry-conflict-day',
      createdDatetime: '2026-05-24T09:00:00.000Z',
      lastEditedDatetime: '2026-05-24T10:00:00.000Z',
      authorId: 'u1',
      title: 'Local conflict day',
      dateBucket: '2026-05-24',
      isDaily: true,
      content: [{ id: 'local-block', type: 'paragraph', text: 'local note' }],
      tags: [],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions: [],
    }
    await boot(page, {
      noFail: '1',
      entries: { [entry.id]: entry },
      conflicts: [{
        id: 'conf-entry-conflict-day',
        entityKind: 'entry',
        entityId: entry.id,
        localUpdatedAt: '2026-05-24T10:00:00.000Z',
        remoteUpdatedAt: '2026-05-24T10:05:00.000Z',
        detectedAt: '2026-05-24T10:06:00.000Z',
        resolution: 'pending',
        summary: 'Both devices edited this daily entry.',
        localCopy: { entry },
        remoteCopy: { entry: { ...entry, title: 'Drive conflict day', content: [{ id: 'remote-block', type: 'paragraph', text: 'drive note' }] } },
      }],
    })

    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: 'Files' }).click()
    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: /^Sync/i }).click()
    await page.locator('summary').filter({ hasText: 'Advanced' }).click()
    await page.getByRole('button', { name: 'Keep both' }).click()
    await expect(page.getByText('kept-copy')).toBeVisible()
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw =
            window.localStorage.getItem('labnote.account.google-subject-app-test.labnote.entries') ||
            window.localStorage.getItem('labnote.entries') ||
            '{}'
          const entries = JSON.parse(raw) as Record<string, { title?: string }>
          return Object.values(entries).some((candidate) => candidate.title === 'Drive conflict day (conflict copy)')
        })
      )
      .toBe(true)
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('easylab-journal-core--account-google-subject-app-test')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          try {
            const tx = db.transaction(['entries', 'conflicts'], 'readonly')
            const [entries, conflicts] = await Promise.all([
              new Promise<Array<{ payload?: { title?: string } }>>((resolve, reject) => {
                const request = tx.objectStore('entries').getAll()
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
              }),
              new Promise<Array<{ id?: string; resolution?: string }>>((resolve, reject) => {
                const request = tx.objectStore('conflicts').getAll()
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
              }),
            ])
            return {
              copiedEntry: entries.some((candidate) => candidate.payload?.title === 'Drive conflict day (conflict copy)'),
              resolvedConflict: conflicts.some((candidate) =>
                candidate.id === 'conf-entry-conflict-day' && candidate.resolution === 'kept-copy'
              ),
            }
          } finally {
            db.close()
          }
        })
      )
      .toEqual({ copiedEntry: true, resolvedConflict: true })
  })

  test('journal data core migrates local entries into IndexedDB', async ({ page }) => {
    const accountDbName = 'easylab-journal-core--account-google-subject-app-test'
    await boot(page, { noFail: '1' })
    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: 'Files' }).click()
    await page.getByRole('complementary', { name: 'Lab navigation' }).getByRole('tab', { name: /^Sync/i }).click()
    await expect(page.getByTestId('sync-pane').getByRole('heading', { name: 'Google Drive' })).toBeVisible()
    await expect(page.getByTestId('sync-pane').locator('.section-title').filter({ hasText: /^Account$/ })).toBeVisible()

    await expect
      .poll(async () => {
        const counts = await page.evaluate(async (dbName) => {
          if (typeof indexedDB.databases === 'function') {
            const databases = await indexedDB.databases()
            if (!databases.some((database) => database.name === dbName)) return { entries: 0, queue: 0 }
            if (databases.some((database) => database.name === 'easylab-journal-core')) {
              return { entries: 0, queue: 0 }
            }
          }
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          const countStore = (storeName: string) =>
            new Promise<number>((resolve, reject) => {
              const tx = db.transaction(storeName, 'readonly')
              const request = tx.objectStore(storeName).count()
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            })
          const [entries, queue] = await Promise.all([countStore('entries'), countStore('syncQueue')])
          db.close()
          return { entries, queue }
        }, accountDbName)
        return counts.entries > 0 && counts.queue > 0
      })
      .toBe(true)

    const counts = await page.evaluate(async (dbName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const countStore = (storeName: string) =>
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly')
          const request = tx.objectStore(storeName).count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const result = { entries: await countStore('entries'), queue: await countStore('syncQueue') }
      db.close()
      return result
    }, accountDbName)
    expect(counts.entries).toBeGreaterThan(0)
    expect(counts.queue).toBeGreaterThan(0)
  })

  test('settings keeps phone pairing and QR setup out of the finished UI', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('settings-button').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('mobile-pair-card')).toHaveCount(0)
    await expect(dialog.getByTestId('mobile-pair-link')).toHaveCount(0)
    await expect(dialog.getByTestId('mobile-pair-qr')).toHaveCount(0)
    await expect(dialog.getByText(/Phone access/i)).toHaveCount(0)
  })

  test('legacy import from file loads entries', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('settings-button').click()
    const input = page.getByTestId('import-legacy-file-input')
    const filePath = path.join(here, 'fixtures', 'legacy-state.json')
    await input.setInputFiles(filePath)
    await expect(page.getByTestId('entry-list')).toContainText('Legacy note import')
  })

  test('settings ships a single polished theme without a visible picker', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('settings-button').click()
    await expect(page.getByTestId('theme-option-neo-brutal')).toHaveCount(0)
    await expect(page.getByText('Appearance', { exact: true })).toHaveCount(0)
    await expect
      .poll(async () => page.evaluate(() => window.localStorage.getItem('labnote.theme')))
      .toBeNull()
  })

  test('protocols can be created', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByRole('tab', { name: 'Protocols' }).click()
    await page.getByTestId('new-protocol').click()
    await page.getByLabel('Title').fill('Microscopy SOP')
    await page.getByRole('button', { name: 'Create protocol' }).click()

    await page.getByRole('button', { name: 'Edit' }).click()
    await page.evaluate(() => {
      const editor = document.querySelector('[data-testid="protocol-editor"]') as HTMLElement | null
      editor?.focus()
      const paragraph = editor?.querySelector('p.block-paragraph') ?? editor?.querySelector('[data-slate-node="element"]')
      if (!paragraph) return
      const textSpan = paragraph.querySelector('[data-slate-node="text"]')
      const range = document.createRange()
      range.selectNodeContents(textSpan ?? paragraph)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
    })
    await page.keyboard.type('Laser settings and exposure notes.')
    await page.getByTestId('protocol-save').click()
    await expect(page.getByTestId('protocol-view')).toContainText('Laser settings and exposure notes.')
    await expect(page.getByTestId('protocol-list').getByText('Microscopy SOP')).toBeVisible()
  })

  test('view mode does not accumulate context across entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(new Date())
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayTitle = formatter.format(yesterday)

    await clearDateFilters(page)
    const entryView = page.getByTestId('entry-view')
    const entryList = page.getByTestId('entry-list')

    await entryList.getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await ensureEditMode(page)
    await focusBlockById(page, 'b-y-context')
    await page.keyboard.insertText('Beta context')
    await page.getByTestId('entry-save').click()

    await entryList.getByRole('button', { name: new RegExp(todayTitle) }).click()
    await ensureEditMode(page)
    await focusBlockById(page, 'b-context')
    await page.keyboard.insertText('Alpha context')
    await page.getByTestId('entry-save').click()

    await entryList.getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await expect(entryView).toContainText('Beta context')
    await expect(entryView).not.toContainText('Alpha context')

    await entryList.getByRole('button', { name: new RegExp(todayTitle) }).click()
    await expect(entryView).toContainText('Alpha context')
    await expect(entryView).not.toContainText('Beta context')

    await entryList.getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await expect(entryView).toContainText('Beta context')
    await expect(entryView).not.toContainText('Alpha context')
  })

  test('entries list sorts newest first', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await clearDateFilters(page)

    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(today)
    const yesterdayTitle = formatter.format(yesterday)

    const entryItems = page.getByTestId('entry-list').getByRole('button')
    await expect(entryItems.nth(0)).toContainText(todayTitle)
    await expect(entryItems.nth(1)).toContainText(yesterdayTitle)
  })

  test('sidebar can be collapsed and expanded', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const toggle = page.getByTestId('sidebar-toggle')
    await toggle.click()
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/)
    await toggle.click()
    await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/)
  })

  test('sidebar mode options keep stable geometry when switching sections', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const modeToggle = page.locator('.connected-mode-toggle')
    const labels = ['Today', 'Protocols', 'Files', 'Sync', 'Today']

    for (const label of labels) {
      await modeToggle.getByRole('tab', { name: label }).click()
      await expect(modeToggle.getByRole('tab')).toHaveCount(4)
      await expect(modeToggle.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true')
      await page.getByTestId('sidebar-toggle').click()
      await expect(page.locator('.sidebar')).toHaveClass(/collapsed/)
      await page.getByTestId('sidebar-toggle').click()
      await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/)
      await expect(modeToggle).toBeVisible()
      await expect(modeToggle.getByRole('tab')).toHaveCount(4)
      await expect(modeToggle.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true')
    }
  })

  test('generated-reference typography stays on Inter with mono reserved for technical data', async ({ page }) => {
    await boot(page, { noFail: '1' })

    const typography = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const style = window.getComputedStyle(element)
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
        }
      }

      const rootStyle = window.getComputedStyle(document.documentElement)
      return {
        rootBody: rootStyle.getPropertyValue('--font-body'),
        rootDisplay: rootStyle.getPropertyValue('--font-display'),
        rootMono: rootStyle.getPropertyValue('--font-mono'),
        body: read('body'),
        brandTitle: read('.brand-title'),
        modePill: read('.connected-mode-toggle .pill'),
        editorTitle: read('.editor-header h1'),
        editorTab: read('.editor-tabs .tab-button'),
        calendarDay: read('.calendar-day'),
      }
    })

    expect(typography.rootBody).toContain('Inter')
    expect(typography.rootDisplay).toContain('Inter')
    expect(typography.rootMono).toContain('IBM Plex Mono')
    expect(typography.body?.fontFamily).toContain('Inter')
    expect(typography.brandTitle?.fontFamily).toContain('Inter')
    expect(typography.modePill?.fontFamily).toContain('Inter')
    expect(typography.editorTitle?.fontFamily).toContain('Inter')
    expect(typography.editorTab?.fontFamily).toContain('Inter')
    expect(typography.calendarDay?.fontFamily).toContain('Inter')
    expect(typography.editorTitle?.letterSpacing).toBe('normal')

    await page.getByTestId('editor-tab-workbook').click()
    await expect(page.locator('.workbook-grid')).toBeVisible()
    const workbookFont = await page.locator('.workbook-grid').evaluate((element) => window.getComputedStyle(element).fontFamily)
    expect(workbookFont).toContain('IBM Plex Mono')
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
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(today)
    const yesterdayTitle = formatter.format(yesterday)

    await page.getByTestId(`calendar-day-${yesterdayIso}`).click()
    await expect(page.getByTestId('entry-list').getByRole('button', { name: new RegExp(yesterdayTitle) })).toBeVisible()
    await page.getByTestId(`calendar-day-${todayIso}`).click()
    await expect(page.getByTestId('entry-list').getByRole('button', { name: new RegExp(todayTitle) })).toBeVisible()
  })

  test('date range filters entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const yesterdayIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(
      yesterday.getDate()
    ).padStart(2, '0')}`
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const todayTitle = formatter.format(today)
    const yesterdayTitle = formatter.format(yesterday)

    await page.getByTestId('date-range-start').fill(yesterdayIso)
    await page.getByTestId('date-range-end').fill(yesterdayIso)

    const entryList = page.getByTestId('entry-list')
    await expect(entryList.getByRole('button', { name: new RegExp(yesterdayTitle) })).toBeVisible()
    await expect(entryList.getByRole('button', { name: new RegExp(todayTitle) })).toHaveCount(0)
  })

  test('calendar marks days that have entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const dayButton = page.getByTestId(`calendar-day-${todayIso}`)
    await expect(dayButton).toHaveClass(/has-entry/)
    await expect(dayButton.locator('.calendar-dot')).toBeVisible()
  })

  test('short desktop keeps the calendar reachable and recent entries independently scrollable', async ({ page }) => {
    await page.setViewportSize({ width: 1212, height: 656 })
    const entryTemplate = Object.values(makeExportableEntry())[0]
    const entries = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => {
        const id = `calendar-scroll-entry-${index}`
        return [
          id,
          {
            ...entryTemplate,
            id,
            title: `Calendar scroll entry ${index + 1}`,
            createdDatetime: new Date(Date.now() - index * 60_000).toISOString(),
            lastEditedDatetime: new Date(Date.now() - index * 60_000).toISOString(),
          },
        ]
      })
    )
    await boot(page, { noFail: '1', entries })

    const sidebar = page.locator('aside.sidebar')
    const toggle = page.getByTestId('sidebar-calendar-toggle')
    const calendar = page.getByTestId('calendar')

    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(calendar).toBeHidden()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(calendar).toBeVisible()

    const geometry = await page.evaluate(() => {
      const sidebarElement = document.querySelector<HTMLElement>('aside.sidebar')
      const calendarElement = document.querySelector<HTMLElement>('[data-testid="calendar"]')
      const listElement = document.querySelector<HTMLElement>('[data-testid="entry-list"]')
      const listParent = listElement?.parentElement
      if (!sidebarElement || !calendarElement || !listElement || !listParent) return null
      const sidebarRect = sidebarElement.getBoundingClientRect()
      const calendarRect = calendarElement.getBoundingClientRect()
      const listStyle = window.getComputedStyle(listElement)
      return {
        calendarInsideSidebar: calendarRect.top >= sidebarRect.top && calendarRect.bottom <= sidebarRect.bottom,
        calendarContentFits: calendarElement.scrollHeight <= calendarElement.clientHeight + 1,
        listInsideParent: listElement.getBoundingClientRect().bottom <= listParent.getBoundingClientRect().bottom + 1,
        listOverflowY: listStyle.overflowY,
        listCanScroll: listElement.scrollHeight > listElement.clientHeight,
      }
    })

    expect(geometry?.calendarInsideSidebar).toBe(true)
    expect(geometry?.calendarContentFits).toBe(true)
    expect(geometry?.listInsideParent).toBe(true)
    expect(geometry?.listOverflowY).toBe('auto')
    expect(geometry?.listCanScroll).toBe(true)

    const entryList = page.getByTestId('entry-list')
    const scrollTopBefore = await entryList.evaluate((element) => element.scrollTop)
    await entryList.hover()
    await page.mouse.wheel(0, 500)
    await expect.poll(() => entryList.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollTopBefore)
    await expect(sidebar.getByRole('tab', { name: 'Today' })).toBeVisible()
  })

  test('720px desktop retains visible filters and a complete calendar', async ({ page }) => {
    await page.setViewportSize({ width: 1212, height: 720 })
    await boot(page, { noFail: '1' })

    await expect(page.getByTestId('project-tag-filter-trigger')).toBeVisible()
    await expect(page.getByTestId('experiment-tag-filter-trigger')).toBeVisible()
    await expect(page.getByTestId('sidebar-calendar-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('calendar')).toBeVisible()
    expect(
      await page.getByTestId('calendar').evaluate((element) => element.scrollHeight <= element.clientHeight + 1)
    ).toBe(true)
  })

  test('mobile drawer exposes the expanded calendar controlled by its toggle', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page, { noFail: '1' })

    await page.getByTestId('mobile-open-sidebar').click()
    const toggle = page.getByTestId('sidebar-calendar-toggle')
    const calendar = page.getByTestId('calendar')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(calendar).toBeVisible()
    await expect(calendar.locator('[data-testid^="calendar-day-"]')).toHaveCount(42)

    expect(await calendar.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(calendar).toBeHidden()
  })

  test('tag dropdown search filters project and experiment tags', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('project-tag-filter-trigger').click()
    await page.getByTestId('project-tag-filter-search').fill('gen')

    const projectPanel = page.getByTestId('project-tag-filter-panel')
    await expect(projectPanel.getByText('No tags found.')).toBeVisible()
    await page.getByTestId('project-tag-filter-trigger').click()

    await page.getByTestId('experiment-tag-filter-trigger').click()
    await page.getByTestId('experiment-tag-filter-search').fill('gen')

    const experimentPanel = page.getByTestId('experiment-tag-filter-panel')
    await expect(experimentPanel.getByRole('button', { name: 'Genotyping' })).toBeVisible()
    await expect(experimentPanel.getByRole('button', { name: 'FACS' })).toHaveCount(0)
  })

  test('deleting a tag removes it from filters and entries', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('experiment-tag-filter-trigger').click()
    const experimentPanel = page.getByTestId('experiment-tag-filter-panel')
    await expect(experimentPanel.getByRole('button', { name: 'Genotyping' })).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    await experimentPanel.getByRole('button', { name: 'Delete tag Genotyping' }).click()
    await expect(experimentPanel.getByRole('button', { name: 'Genotyping' })).toHaveCount(0)

    await page.getByRole('tab', { name: /details/i }).click()
    await expect(page.getByTestId('entry-experiment-tags').getByRole('button', { name: 'Genotyping' })).toHaveCount(0)
  })

  test('entries can be deleted', async ({ page }) => {
    await boot(page, { noFail: '1' })
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayTitle = formatter.format(yesterday)

    await clearDateFilters(page)
    await page.getByTestId('entry-list').getByRole('button', { name: new RegExp(yesterdayTitle) }).click()
    await page.getByRole('tab', { name: /details/i }).click()

    page.once('dialog', (dialog) => dialog.accept())
    await page.locator('summary').filter({ hasText: 'Delete entry' }).click()
    await page.getByTestId('delete-entry').click()
    await page.getByRole('button', { name: 'Delete permanently' }).click()

    await expect(page.getByRole('heading', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
    await expect(page.getByRole('button', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
  })
})
