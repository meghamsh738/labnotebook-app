import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))

const defaultPaths = {
  dataRoot: 'C:\\\\Easylab\\\\data',
  attachmentsRoot: 'C:\\\\Easylab\\\\attachments',
  exportRoot: 'C:\\\\Easylab\\\\exports',
  syncRoot: 'C:\\\\Easylab\\\\sync',
}

async function boot(
  page: Page,
  opts?: {
    noFail?: '0' | '1'
    failNext?: boolean
    stubPicker?: boolean
    setupComplete?: boolean
    appPaths?: typeof defaultPaths
    entries?: Record<string, unknown>
    attachments?: unknown[]
    fileBoxItems?: unknown[]
    transfers?: unknown[]
    conflicts?: unknown[]
  }
) {
  const initOpts = { noFail: '1', setupComplete: true, ...opts }
  if (initOpts.setupComplete !== false && !initOpts.appPaths) {
    initOpts.appPaths = defaultPaths
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
    if (o?.stubPicker) {
      ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined
    }
  }, initOpts)
  await page.goto('/')
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
  if (await saveButton.count()) {
    await page.getByRole('button', { name: 'Cancel' }).click()
  }
  await expect(page.getByTestId('edit-note-btn')).toBeVisible()
}

async function ensureChecklistInEditMode(page: Page) {
  const checklistRows = page.getByTestId('check-item-text')
  if ((await checklistRows.count()) === 0) {
    await page.getByRole('button', { name: 'Checks' }).click()
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
  if (await clearButton.count()) {
    await clearButton.click()
  }
  const rangeClear = page.getByTestId('date-range-clear')
  if (await rangeClear.count()) {
    await rangeClear.click()
  }
}

test.describe('Lab note taking app', () => {
  test('loads baseline UI', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await expect(
      page.getByRole('complementary', { name: 'Lab navigation' }).getByText('Neuroimmunology Lab').first()
    ).toBeVisible()
    await expect(page.getByRole('button', { name: /today's entry/i })).toBeVisible()
    await expect(page.getByTestId('project-tag-filter-trigger')).toBeVisible()
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
    await expect(page.getByTestId('calendar')).toBeVisible()
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

  test('today entry opens with the day-entry scaffold', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Setup' })).toHaveCount(0)
  })

  test('legacy daily scaffold is compacted to context-only', async ({ page }) => {
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

    await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Setup' })).toHaveCount(0)
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
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const header = page.getByTestId('editor-header')
    await expect(header).toBeVisible()
    await expect(page.getByTestId('entry-tags-inline')).toBeVisible()
    await expect(page.getByTestId('editor-toolbar')).toBeVisible()
    await expect(page.getByTestId('editor-tab-note')).toBeVisible()
    await expect(page.getByTestId('editor-tab-workbook')).toBeVisible()
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

  test('guided template prompts clear on input', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const guideText = '• ........................................'
    const guideLocator = page.getByText(guideText)
    await expect(guideLocator).toBeVisible()

    await focusBlockById(page, 'b-context')
    await page.keyboard.type('Testing placeholder clearing')

    await expect(guideLocator).toHaveCount(0)
  })

  test('guided template prompt does not duplicate on line breaks', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    const guideText = '• ........................................'

    await focusBlockById(page, 'b-context')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await expect(page.getByText(guideText)).toHaveCount(1)
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
      const raw = window.localStorage.getItem('labnote.attachments')
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

  test('inline tag editor syncs with details tags', async ({ page }) => {
    await boot(page, { noFail: '1' })

    const inlineTags = page.getByTestId('entry-project-tags-inline')
    const targetTag = inlineTags.locator('button[data-selected="false"]').first()
    const tagLabel = (await targetTag.textContent())?.trim()
    if (!tagLabel) throw new Error('No unselected tag found in inline tags.')

    const tagButton = inlineTags.getByRole('button', { name: tagLabel })
    await tagButton.click()
    await expect(tagButton).toHaveAttribute('data-selected', 'true')

    await page.getByRole('tab', { name: /details/i }).click()
    const detailsTag = page.getByTestId('entry-project-tags').getByRole('button', { name: tagLabel })
    await expect(detailsTag).toHaveAttribute('data-selected', 'true')
  })

  test('tabs switch between note, files, and details in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await ensureEditMode(page)

    await page.getByRole('tab', { name: /Details/i }).click()
    await expect(page.getByTestId('entry-project-tags')).toBeVisible()

    await page.getByRole('tab', { name: /Files/i }).click()
    await expect(page.getByTestId('master-sync-input-files')).toBeVisible()

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
    const box = await firstItem.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.width).toBeGreaterThan(120)
      expect(box.width).toBeGreaterThan(box.height)
    }
  })

  test('master sync root prefixes file destinations', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByTestId('today-entry').click()
    await ensureEditMode(page)

    await page.getByRole('tab', { name: /Files/ }).click()
    await page
      .getByTestId('master-sync-input-files')
      .fill('C:\\OneDrive - Trinity College Dublin\\Lab notebook')

    await page.getByRole('tab', { name: /Note/ }).click()
    await page.getByRole('button', { name: 'File destination' }).click()
    await page.getByTestId('file-destination-path').fill('run1.csv')
    await page.getByTestId('file-destination-add').click()

    await page.getByRole('tab', { name: /Files/ }).click()
    await expect(
      page.getByText('C:\\OneDrive - Trinity College Dublin\\Lab notebook\\run1.csv')
    ).toBeVisible()
  })

  test('auto-save downloads when disk cache is unavailable', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('today-entry').click()
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
    await page.getByRole('button', { name: 'Save' }).click()
    await ensureViewMode(page)

    const firstChecklist = page.locator('.check-row').first()
    await expect(firstChecklist).toBeVisible()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText('Saved locally')
  })

  test('today entry opens in edit mode', async ({ page }) => {
    await boot(page, { noFail: '1' })

    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()

    const editor = page.getByTestId('slate-editor')
    await expect(editor).toHaveAttribute('contenteditable', 'true')
  })

  test('sync failures can be retried', async ({ page }) => {
    await boot(page, { noFail: '0', failNext: true })
    await ensureEditMode(page)
    await ensureChecklistInEditMode(page)
    await page.getByRole('button', { name: 'Save' }).click()
    await ensureViewMode(page)

    const firstChecklist = page.locator('.check-row').first()
    await firstChecklist.locator('input[type="checkbox"]').click()

    const statusChip = page.getByTestId('sync-status-chip')
    await expect(statusChip).toContainText(/failed/i)

    await expect(page.getByTestId('sync-action')).toHaveText(/retry failed/i)
    await page.getByTestId('sync-action').click()
    await expect(statusChip).toContainText('Saved locally')
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
    await expect(dialog.getByText('Disk cache', { exact: true })).toBeVisible()
    await expect(dialog.getByTestId('import-legacy')).toBeVisible()
    await expect(dialog.getByTestId('import-legacy-file')).toBeVisible()
    await expect(dialog.getByText('Notebook data and state', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Attachment intake and uploads', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Generated exports', { exact: true })).toBeVisible()
  })

  test('connected file hub panes are reachable', async ({ page }) => {
    await boot(page, { noFail: '1' })

    await page.getByTestId('editor-tab-filebox').click()
    await expect(page.getByTestId('entry-filebox-panel')).toBeVisible()
    await expect(page.getByText('Entry File Box', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'File Hub' }).click()
    await expect(page.getByTestId('file-hub-pane')).toBeVisible()
    await expect(page.getByText('Entry file boxes and incoming lab files', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Devices' }).click()
    await expect(page.getByTestId('devices-pane')).toBeVisible()

    await page.getByRole('tab', { name: 'Transfers' }).click()
    await expect(page.getByTestId('transfers-pane')).toBeVisible()

    await page.getByRole('tab', { name: 'Sync' }).click()
    await expect(page.getByTestId('sync-pane')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Device-owned sync without an Easylab cloud server' })).toBeVisible()
    await expect(page.getByText('First sync setup', { exact: true })).toBeVisible()
    await expect(page.getByText('Advanced OAuth client IDs', { exact: true })).toBeVisible()
    await page.locator('details.sync-advanced summary').click()
    await expect(page.getByPlaceholder('Desktop OAuth client ID for Electron')).toBeVisible()
    await expect(page.getByPlaceholder('Optional; stored locally only when provided')).toBeVisible()
    await expect(page.getByPlaceholder('Web OAuth client ID for browser/PWA')).toBeVisible()
    await expect(page.getByTestId('import-oauth-json')).toBeVisible()
    await page.getByTestId('oauth-json-file').setInputFiles({
      name: 'oauth.desktop.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        installed: {
          client_id: 'desktop-client.apps.googleusercontent.com',
          client_secret: 'desktop-secret',
        },
      })),
    })
    await expect(page.getByTestId('oauth-import-message')).toContainText('Imported desktop client ID')
    await expect(page.getByPlaceholder('Desktop OAuth client ID for Electron')).toHaveValue('desktop-client.apps.googleusercontent.com')
    await expect(page.getByPlaceholder('Optional; stored locally only when provided')).toHaveValue('desktop-secret')
    await expect(page.getByRole('button', { name: 'Export backup' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore backup' })).toBeVisible()
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

    await page.getByRole('tab', { name: 'Sync' }).click()
    await expect(page.getByTestId('storage-health-card')).toBeVisible()
    await expect(page.getByText('Attachment metadata syncs automatically')).toBeVisible()
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

    await page.getByRole('tab', { name: 'File Hub' }).click()
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

    await page.getByTestId('editor-tab-files').click()
    const filesPanel = page.locator('.tab-panel').filter({ hasText: 'Master sync folder' })
    const fileRow = filesPanel.locator('.attachment-row.remote-only').filter({ hasText: 'phone-capture.jpg' })
    await expect(fileRow).toHaveCount(1)
    await expect(fileRow).toContainText('Status: Remote available')
    await expect(fileRow).toContainText('On demand')
    await expect(fileRow.getByRole('button', { name: 'Download' })).toBeVisible()
    await expect(fileRow.getByRole('button', { name: 'Open' })).toHaveCount(0)
    await expect(fileRow.getByRole('button', { name: 'Remove local' })).toHaveCount(0)

    await page.getByTestId('editor-tab-filebox').click()
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

    await page.getByRole('tab', { name: 'Sync' }).click()
    await page.getByRole('button', { name: 'Keep both' }).click()
    await expect(page.getByText('kept-copy')).toBeVisible()
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const entries = JSON.parse(window.localStorage.getItem('labnote.entries') || '{}') as Record<string, { title?: string }>
          return Object.values(entries).some((candidate) => candidate.title === 'Drive conflict day (conflict copy)')
        })
      )
      .toBe(true)
  })

  test('journal data core migrates local entries into IndexedDB', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByRole('tab', { name: 'Sync' }).click()
    await expect(page.getByText('Local data core', { exact: true })).toBeVisible()

    await expect
      .poll(async () => {
        const counts = await page.evaluate(async () => {
          if (typeof indexedDB.databases === 'function') {
            const databases = await indexedDB.databases()
            if (!databases.some((database) => database.name === 'easylab-journal-core')) return { entries: 0, queue: 0 }
          }
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('easylab-journal-core')
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
        })
        return counts.entries > 0 && counts.queue > 0
      })
      .toBe(true)

    const counts = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('easylab-journal-core')
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
    })
    expect(counts.entries).toBeGreaterThan(0)
    expect(counts.queue).toBeGreaterThan(0)
  })

  test('settings shows mobile pairing QR and link status', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('settings-button').click()

    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('mobile-pair-card').locator('summary').click()
    const pairLink = dialog.getByTestId('mobile-pair-link')
    await pairLink.fill(page.url())

    const status = dialog.getByTestId('mobile-pair-status')
    await expect(status).toBeVisible()
    await expect.poll(async () => await status.textContent()).toContain('Link online')
    await expect(dialog.getByTestId('mobile-pair-qr')).toBeVisible()
  })

  test('legacy import from file loads entries', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('settings-button').click()
    const input = page.getByTestId('import-legacy-file-input')
    const filePath = path.join(here, 'fixtures', 'legacy-state.json')
    await input.setInputFiles(filePath)
    await expect(page.getByTestId('entry-list')).toContainText('Legacy note import')
  })

  test('theme selection updates the active theme', async ({ page }) => {
    await boot(page, { noFail: '1', stubPicker: true })
    await page.getByTestId('settings-button').click()
    const neoBrutal = page.getByTestId('theme-option-neo-brutal')
    await neoBrutal.click()
    await expect(neoBrutal).toHaveClass(/active/)
    await expect.poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'neo-brutal'
    )
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem('labnote.theme'))).toBe(
      'neo-brutal'
    )
  })

  test('protocols can be created', async ({ page }) => {
    await boot(page, { noFail: '1' })
    await page.getByRole('tab', { name: 'Protocols' }).click()
    await page.getByTestId('new-protocol').click()
    await page.getByLabel('Title').fill('Microscopy SOP')
    await page.getByRole('button', { name: 'Create protocol' }).click()

    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByTestId('protocol-editor').locator('p.block-paragraph').first().click({ force: true })
    await page.keyboard.type('Laser settings and exposure notes.')
    await page.getByRole('button', { name: 'Save' }).click()
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
    await page.getByRole('button', { name: 'Save' }).click()

    await entryList.getByRole('button', { name: new RegExp(todayTitle) }).click()
    await ensureEditMode(page)
    await focusBlockById(page, 'b-context')
    await page.keyboard.insertText('Alpha context')
    await page.getByRole('button', { name: 'Save' }).click()

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
    await page.getByTestId('delete-entry').click()

    await expect(page.getByRole('heading', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
    await expect(page.getByRole('button', { name: new RegExp(yesterdayTitle) })).toHaveCount(0)
  })
})
