import type React from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createEditor, Editor, Element as SlateElement, Node, Path, Range, Text, Transforms } from 'slate'
import type { Descendant } from 'slate'
import { Slate, Editable, withReact, ReactEditor, useSlate, useSlateStatic } from 'slate-react'
import type { RenderElementProps, RenderLeafProps } from 'slate-react'
import lunr from 'lunr'
import { cacheFile, getCachedFile } from './idb'
import { writeFileToCache, restoreCacheHandle, ensureCacheDir, pickCacheDir, clearCacheHandle } from './fileCache'
import './App.css'
import {
  sampleData,
} from './data/sampleData'
import type {
  Attachment,
  Block,
  Entry,
  Experiment,
  Project,
  ChecklistItem,
  PinnedRegion,
  TextRun,
} from './domain/types'

const dtFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const dateOnly = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

function newId(prefix: string) {
  return `${prefix}${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

type EntryTemplateId = 'experiment' | 'blank'
type SyncStatus = 'pending' | 'synced' | 'failed'

type ChangeQueueItem = {
  id: string
  entryId: string
  blocks: string[]
  status: SyncStatus
  updatedAt: string
  attempts: number
  lastTriedAt?: string
  lastError?: string
}

const LOCKED_TEMPLATE_SECTION_LABELS = new Set(['Summary', 'Protocol', 'Objective', 'Aim', 'Procedure', 'Experiment', 'Results'])

function applyLockedTemplateHeadings(entry: Entry): Entry {
  const lockedIds = new Set<string>()
  for (const region of entry.pinnedRegions ?? []) {
    if (!LOCKED_TEMPLATE_SECTION_LABELS.has(region.label)) continue
    for (const blockId of region.blockIds) lockedIds.add(blockId)
  }

  if (lockedIds.size === 0) return entry

  let changed = false
  const nextContent = entry.content.map((block) => {
    if (block.type !== 'heading') return block
    if (!lockedIds.has(block.id)) return block
    if (block.locked === true) return block
    changed = true
    return { ...block, locked: true }
  })

  return changed ? { ...entry, content: nextContent } : entry
}

function buildTemplate(templateId: EntryTemplateId, entryId: string, nowIso: string): { content: Block[]; pinnedRegions: PinnedRegion[] } {
  if (templateId === 'blank') {
    return {
      content: [{ id: newId('b-'), type: 'paragraph', text: '' }],
      pinnedRegions: [],
    }
  }

  const aimHeadingId = newId('b-')
  const aimBodyId = newId('b-')
  const experimentHeadingId = newId('b-')
  const experimentChecklistId = newId('b-')
  const experimentNotesId = newId('b-')
  const resultsHeadingId = newId('b-')
  const resultsBodyId = newId('b-')

  const content: Block[] = [
    { id: aimHeadingId, type: 'heading', level: 2, text: 'Aim', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    { id: aimBodyId, type: 'paragraph', text: 'What is the goal of this experiment?', updatedAt: nowIso, updatedBy: 'me' },
    { id: experimentHeadingId, type: 'heading', level: 2, text: 'Experiment', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: experimentChecklistId,
      type: 'checklist',
      items: [
        { id: newId('ci-'), text: 'Step 1…', done: false },
      ],
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: experimentNotesId, type: 'paragraph', text: 'Notes, deviations, timings.', updatedAt: nowIso, updatedBy: 'me' },
    { id: resultsHeadingId, type: 'heading', level: 2, text: 'Results', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    { id: resultsBodyId, type: 'paragraph', text: 'Key observations, metrics, anomalies.', updatedAt: nowIso, updatedBy: 'me' },
  ]

  const pinnedRegions: PinnedRegion[] = [
    {
      id: newId('region-'),
      entryId,
      label: 'Aim',
      blockIds: [aimHeadingId, aimBodyId],
      linkedAttachments: [],
    },
    {
      id: newId('region-'),
      entryId,
      label: 'Experiment',
      blockIds: [experimentHeadingId, experimentChecklistId, experimentNotesId],
      linkedAttachments: [],
    },
    {
      id: newId('region-'),
      entryId,
      label: 'Results',
      blockIds: [resultsHeadingId, resultsBodyId],
      linkedAttachments: [],
    },
  ]

  return { content, pinnedRegions }
}

function safeFileName(name: string): string {
  const trimmed = name.trim()
  const cleaned = trimmed.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim()
  const normalized = cleaned.replace(/[^a-zA-Z0-9 ._()-]+/g, '_').replace(/[ ]+/g, '_')
  return normalized.replace(/^_+|_+$/g, '') || 'export'
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function escapeMd(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\*/g, '\\*').replace(/_/g, '\\_')
}

type FsPermissionMode = 'read' | 'readwrite'
type DirectoryPickerOptions = { mode: FsPermissionMode; id?: string }
type DirectoryPicker = (options: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>
type DirectoryPickerWindow = Window & { showDirectoryPicker?: DirectoryPicker }
type FsDirectoryWithPerm = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: FsPermissionMode }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: FsPermissionMode }) => Promise<PermissionState>
}
type MockSyncOverrides = { noFail?: boolean; failNext?: boolean }
type MockSyncWindow = Window & { __labnoteMockSync?: MockSyncOverrides }

function blockToSearchText(block: Block): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return block.text
    case 'table':
      return block.data.flat().join(' ')
    case 'checklist':
      return block.items.map((i) => i.text).join(' ')
    case 'image':
      return block.caption ?? ''
    case 'file':
      return block.label ?? ''
    case 'divider':
      return ''
    default:
      return ''
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return 'name' in err && (err as { name?: unknown }).name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBlock(value: unknown): value is Block {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.type === 'string'
}

function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

async function mockSyncApi(change: ChangeQueueItem): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 450))
  if (typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false) {
    throw new Error('Offline')
  }

  const overrides = (window as unknown as MockSyncWindow).__labnoteMockSync
  if (overrides?.noFail) return
  if (overrides?.failNext) {
    overrides.failNext = false
    throw new Error('Mock API error (forced)')
  }

  try {
    const noFail = window.localStorage.getItem('labnote.mockSync.noFail') === '1'
    if (noFail) return

    const failNext = window.localStorage.getItem('labnote.mockSync.failNext') === '1'
    if (failNext) {
      window.localStorage.removeItem('labnote.mockSync.failNext')
      throw new Error('Mock API error (forced)')
    }
  } catch {
    // ignore localStorage access errors
  }

  // Deterministic fail-on-first-try so retries demonstrate UX.
  const shouldFail = change.attempts === 0 && hashString(change.id) % 5 === 0
  if (shouldFail) {
    throw new Error('Mock API error (500)')
  }
}

function blocksToMarkdown(blocks: Block[], attachmentsById: Record<string, Attachment>, attachmentExportPathById: Record<string, string>) {
  const parts: string[] = []

  const mdTable = (data: string[][]) => {
    if (!data.length) return ''
    const header = data[0]
    const body = data.slice(1)
    const headerLine = `| ${header.map((c) => escapeMd(c)).join(' | ')} |`
    const sepLine = `| ${header.map(() => '---').join(' | ')} |`
    const bodyLines = body.map((row) => `| ${row.map((c) => escapeMd(c)).join(' | ')} |`)
    return [headerLine, sepLine, ...bodyLines].join('\n')
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const level = block.level ?? 2
        const prefix = '#'.repeat(Math.max(1, Math.min(6, level)))
        parts.push(`${prefix} ${escapeMd(block.text)}`)
        break
      }
      case 'paragraph':
        parts.push(block.text)
        break
      case 'quote':
        parts.push(block.text.split('\n').map((l) => `> ${l}`).join('\n'))
        break
      case 'divider':
        parts.push('---')
        break
      case 'checklist':
        parts.push(block.items.map((i) => `- [${i.done ? 'x' : ' '}] ${escapeMd(i.text)}`).join('\n'))
        break
      case 'table':
        parts.push(mdTable(block.data))
        if (block.caption) parts.push(`*${escapeMd(block.caption)}*`)
        break
      case 'image': {
        const att = attachmentsById[block.attachmentId]
        const label = block.caption ?? att?.filename ?? 'image'
        const path = attachmentExportPathById[block.attachmentId] ?? att?.storagePath
        if (path) {
          parts.push(`![${escapeMd(label)}](${path})`)
        } else {
          parts.push(`![${escapeMd(label)}](missing)`)
        }
        break
      }
      case 'file': {
        const att = attachmentsById[block.attachmentId]
        const label = block.label ?? att?.filename ?? 'file'
        const path = attachmentExportPathById[block.attachmentId] ?? att?.storagePath
        if (path) {
          parts.push(`[${escapeMd(label)}](${path})`)
        } else {
          parts.push(`${escapeMd(label)} (missing)`)
        }
        break
      }
      default:
        break
    }
    parts.push('')
  }

  return parts.join('\n').trim() + '\n'
}

function blocksToHtml(blocks: Block[], attachmentsById: Record<string, Attachment>, attachmentUrls: Record<string, string>) {
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  const renderTable = (data: string[][]) => {
    if (!data.length) return ''
    const header = data[0]
    const body = data.slice(1)
    return `
      <table>
        <thead>
          <tr>${header.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${body.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    `
  }

  return blocks
    .map((block) => {
      switch (block.type) {
        case 'heading': {
          const level = block.level ?? 2
          const tag = level <= 1 ? 'h1' : level === 3 ? 'h3' : 'h2'
          return `<${tag}>${esc(block.text)}</${tag}>`
        }
        case 'paragraph':
          return `<p>${esc(block.text)}</p>`
        case 'quote':
          return `<blockquote>${esc(block.text)}</blockquote>`
        case 'divider':
          return `<hr />`
        case 'checklist':
          return `<ul class="checklist">${block.items.map((i) => `<li><span class="cb">${i.done ? '☑' : '☐'}</span> ${esc(i.text)}</li>`).join('')}</ul>`
        case 'table':
          return `<div class="table-wrap">${renderTable(block.data)}${block.caption ? `<div class="caption">${esc(block.caption)}</div>` : ''}</div>`
        case 'image': {
          const att = attachmentsById[block.attachmentId]
          const src = attachmentUrls[block.attachmentId] ?? att?.thumbnail
          const caption = block.caption ?? att?.filename ?? 'Image'
          return `
            <figure>
              ${src ? `<img src="${esc(src)}" alt="${esc(caption)}" />` : `<div class="placeholder">Image</div>`}
              <figcaption>${esc(caption)}</figcaption>
            </figure>
          `
        }
        case 'file': {
          const att = attachmentsById[block.attachmentId]
          const label = block.label ?? att?.filename ?? 'File'
          const path = att?.storagePath ?? ''
          return `<div class="file"><strong>${esc(label)}</strong>${path ? `<div class="muted">${esc(path)}</div>` : ''}</div>`
        }
        default:
          return ''
      }
    })
    .join('\n')
}

function withChecklists(editor: ReactEditor) {
  const { normalizeNode } = editor

  editor.normalizeNode = (entry) => {
    const [node, path] = entry

    if (SlateElement.isElement(node)) {
      if (node.type === 'check-item') {
        const patch: Record<string, unknown> = {}
        if (typeof node.itemId !== 'string') patch.itemId = newId('ci-')
        if (typeof node.done !== 'boolean') patch.done = false
        if (Object.keys(patch).length) {
          Transforms.setNodes(editor, patch, { at: path })
          return
        }
      }

      if (node.type === 'checklist') {
        if (node.children.length === 0) {
          Transforms.insertNodes(
            editor,
            { type: 'check-item', itemId: newId('ci-'), done: false, children: [{ text: '' }] },
            { at: path.concat(0) }
          )
          return
        }
      }
    }

    normalizeNode(entry)
  }

  return editor
}

type EditorAttachmentContextValue = {
  attachmentsById: Record<string, Attachment>
  attachmentUrls: Record<string, string>
}

const EditorAttachmentContext = createContext<EditorAttachmentContextValue | null>(null)

function App() {
  const [projects, setProjects] = useState<Project[]>(() => {
    if (typeof window === 'undefined') return sampleData.projects
    try {
      const saved = window.localStorage.getItem('labnote.projects')
      if (saved) {
        const parsed = JSON.parse(saved) as Project[]
        const byId = new Map(parsed.map((p) => [p.id, p]))
        for (const seeded of sampleData.projects) {
          if (!byId.has(seeded.id)) byId.set(seeded.id, seeded)
        }
        return Array.from(byId.values())
      }
    } catch (err) {
      console.warn('Unable to read cached projects', err)
    }
    return sampleData.projects
  })
  const [experiments, setExperiments] = useState<Experiment[]>(() => {
    if (typeof window === 'undefined') return sampleData.experiments
    try {
      const saved = window.localStorage.getItem('labnote.experiments')
      if (saved) {
        const parsed = JSON.parse(saved) as Experiment[]
        const byId = new Map(parsed.map((ex) => [ex.id, ex]))
        for (const seeded of sampleData.experiments) {
          if (!byId.has(seeded.id)) byId.set(seeded.id, seeded)
        }
        return Array.from(byId.values())
      }
    } catch (err) {
      console.warn('Unable to read cached experiments', err)
    }
    return sampleData.experiments
  })
  const [entryDrafts, setEntryDrafts] = useState<Record<string, Entry>>(() => {
    if (typeof window === 'undefined') {
      return Object.fromEntries(sampleData.entries.map((e) => [e.id, e]))
    }
    try {
      const saved = window.localStorage.getItem('labnote.entries')
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, Entry>
        return Object.fromEntries(Object.entries(parsed).map(([id, entry]) => [id, applyLockedTemplateHeadings(entry)]))
      }
    } catch (err) {
      console.warn('Unable to read cached entries', err)
    }
    return Object.fromEntries(sampleData.entries.map((e) => [e.id, e]))
  })
  const entryList = useMemo(() => Object.values(entryDrafts), [entryDrafts])
  const [selectedEntryId, setSelectedEntryId] = useState(
    sampleData.entries[0]?.id ?? ''
  )
  const [newEntryOpen, setNewEntryOpen] = useState(false)
  const [newExperimentOpen, setNewExperimentOpen] = useState(false)
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [selectedProject, setSelectedProject] = useState<string>('all')
  const [selectedExperiment, setSelectedExperiment] = useState<string>('all')
  const [filterHasImage, setFilterHasImage] = useState(false)
  const [filterHasFile, setFilterHasFile] = useState(false)
  const [datePreset, setDatePreset] = useState<'all' | '7d' | '30d'>('all')
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})
  const [missingAttachments, setMissingAttachments] = useState<Set<string>>(new Set())
  const [changeQueue, setChangeQueue] = useState<ChangeQueueItem[]>([])
  const [syncing, setSyncing] = useState(false)
  const [fsEnabled, setFsEnabled] = useState(false)
  const [fsNeedsPermission, setFsNeedsPermission] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    try {
      const saved = window.localStorage.getItem('labnote.theme')
      if (saved === 'dark' || saved === 'light') return saved
    } catch (err) {
      console.warn('Unable to read cached theme', err)
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  }, [theme])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem('labnote.theme', theme)
    } catch (err) {
      console.warn('Unable to cache theme', err)
    }
  }, [theme])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem('labnote.projects', JSON.stringify(projects))
      } catch (err) {
        console.warn('Unable to cache projects', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [projects])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem('labnote.experiments', JSON.stringify(experiments))
      } catch (err) {
        console.warn('Unable to cache experiments', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [experiments])

  const createProject = useCallback(
    (title: string): string => {
      const cleaned = title.trim().replace(/\s+/g, ' ')
      if (!cleaned) {
        throw new Error('Project name is required.')
      }

      const existing = projects.find((p) => p.title.trim().toLowerCase() === cleaned.toLowerCase())
      if (existing) return existing.id

      const project: Project = {
        id: newId('proj-'),
        labId: sampleData.labs[0]?.id ?? sampleData.users[0]?.settings.defaultLabId ?? 'lab',
        title: cleaned,
        tags: [],
      }

      setProjects((prev) => [...prev, project])
      return project.id
    },
    [projects]
  )

  const createExperiment = useCallback(
    (opts: { title: string; projectId: string; protocolRef?: string; defaultRawDataPath?: string }): string => {
      const cleanedTitle = opts.title.trim().replace(/\s+/g, ' ')
      if (!cleanedTitle) throw new Error('Experiment name is required.')
      if (!opts.projectId) throw new Error('Project is required.')

      const existing = experiments.find(
        (ex) => ex.projectId === opts.projectId && ex.title.trim().toLowerCase() === cleanedTitle.toLowerCase()
      )
      if (existing) return existing.id

      const experiment: Experiment = {
        id: newId('exp-'),
        projectId: opts.projectId,
        title: cleanedTitle,
        protocolRef: opts.protocolRef?.trim() || undefined,
        defaultRawDataPath: opts.defaultRawDataPath?.trim() || undefined,
        startDatetime: new Date().toISOString(),
      }

      setExperiments((prev) => [...prev, experiment])
      return experiment.id
    },
    [experiments]
  )

  const refreshFsState = useCallback(async () => {
    try {
      const handle = await restoreCacheHandle()
      if (!handle) {
        setFsEnabled(false)
        setFsNeedsPermission(false)
        return
      }

      const handleWithPerm = handle as FsDirectoryWithPerm
      if (handleWithPerm.queryPermission) {
        const perm = await handleWithPerm.queryPermission({ mode: 'readwrite' })
        setFsEnabled(perm === 'granted')
        setFsNeedsPermission(perm !== 'granted')
        return
      }

      setFsEnabled(true)
      setFsNeedsPermission(false)
    } catch {
      setFsEnabled(false)
      setFsNeedsPermission(false)
    }
  }, [])

  useEffect(() => {
    // Warm attempt to restore filesystem handle silently (no permission prompts)
    void refreshFsState()
  }, [refreshFsState])

  const handlePromptFs = useCallback(async () => {
    try {
      await ensureCacheDir()
    } finally {
      await refreshFsState()
    }
  }, [refreshFsState])

  const handlePickCacheDir = useCallback(async () => {
    try {
      await pickCacheDir()
    } finally {
      await refreshFsState()
    }
  }, [refreshFsState])

  const handleDisconnectCacheDir = useCallback(async () => {
    try {
      await clearCacheHandle()
    } finally {
      await refreshFsState()
    }
  }, [refreshFsState])

  const validateDiskCache = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const handle = await restoreCacheHandle()
    if (!handle) return { ok: false, message: 'No cache folder selected.' }

    const handleWithPerm = handle as FsDirectoryWithPerm
    if (handleWithPerm.queryPermission) {
      const perm = await handleWithPerm.queryPermission({ mode: 'readwrite' })
      if (perm !== 'granted') return { ok: false, message: 'Permission not granted (read/write). Click “Enable” or re-pick the folder.' }
    }

    try {
      const testName = `.labnote_write_test_${Date.now()}.txt`
      const fileHandle = await handle.getFileHandle(testName, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write('ok')
      await writable.close()
      await handle.removeEntry(testName)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Write test failed.' }
    }
  }, [])

  const handleCreateEntry = useCallback(
    (opts: { title?: string; projectId?: string; experimentId?: string; templateId: EntryTemplateId; quickCapture?: boolean }) => {
      const now = new Date()
      const nowIso = now.toISOString()
      const dateBucket = nowIso.slice(0, 10)

      const entryId = newId('entry-')
      const title =
        opts.title?.trim() ||
        (opts.quickCapture
          ? `Quick capture – ${dtFormat.format(now)}`
          : `Untitled note – ${dateOnly.format(now)}`)

      const projectId =
        opts.projectId ??
        (selectedProject !== 'all' ? selectedProject : sampleData.users[1]?.settings.defaultProjectId)

      const { content, pinnedRegions } = buildTemplate(opts.templateId, entryId, nowIso)

      const entry: Entry = {
        id: entryId,
        experimentId: opts.experimentId,
        projectId,
        createdDatetime: nowIso,
        lastEditedDatetime: nowIso,
        authorId: sampleData.users[1]?.id ?? sampleData.users[0]?.id ?? 'me',
        title,
        dateBucket,
        content,
        tags: [],
        searchTerms: [],
        linkedFiles: [],
        pinnedRegions,
      }

      setEntryDrafts((prev) => ({ ...prev, [entryId]: entry }))
      setSelectedEntryId(entryId)
      setQuery('')
      setSelectedTags([])
      setAutoEditEntryId(entryId)
      setNewEntryOpen(false)
    },
    [selectedProject]
  )

  const syncRunningRef = useRef(false)

  const processSync = useCallback(async (changes: ChangeQueueItem[]) => {
    if (syncRunningRef.current) return
    if (changes.length === 0) return

    syncRunningRef.current = true
    setSyncing(true)
    try {
      for (const change of changes) {
        const startedAt = new Date().toISOString()
        setChangeQueue((prev) =>
          prev.map((c) =>
            c.id === change.id
              ? {
                  ...c,
                  status: 'pending',
                  attempts: c.attempts + 1,
                  lastTriedAt: startedAt,
                  lastError: undefined,
                }
              : c
          )
        )

        try {
          await mockSyncApi(change)
          setChangeQueue((prev) =>
            prev.map((c) => (c.id === change.id ? { ...c, status: 'synced', lastError: undefined } : c))
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Sync failed.'
          setChangeQueue((prev) =>
            prev.map((c) => (c.id === change.id ? { ...c, status: 'failed', lastError: message } : c))
          )
        }
      }
    } finally {
      setSyncing(false)
      syncRunningRef.current = false
    }
  }, [])

  const syncNow = useCallback(
    async (opts?: { entryId?: string; includeFailed?: boolean }) => {
      const includeFailed = opts?.includeFailed ?? true
      const changes = changeQueue.filter((c) => {
        if (opts?.entryId && c.entryId !== opts.entryId) return false
        if (c.status === 'pending') return true
        if (includeFailed && c.status === 'failed') return true
        return false
      })
      await processSync(changes)
    },
    [changeQueue, processSync]
  )

  const retryChange = useCallback(
    async (changeId: string) => {
      const change = changeQueue.find((c) => c.id === changeId)
      if (!change) return
      await processSync([change])
    },
    [changeQueue, processSync]
  )

  const clearSyncedChanges = useCallback((entryId?: string) => {
    setChangeQueue((prev) =>
      prev.filter((c) => {
        if (c.status !== 'synced') return true
        if (!entryId) return false
        return c.entryId !== entryId
      })
    )
  }, [])

  useEffect(() => {
    if (syncing) return
    if (!changeQueue.some((c) => c.status === 'pending')) return
    const id = window.setTimeout(() => {
      void syncNow({ includeFailed: false })
    }, 900)
    return () => window.clearTimeout(id)
  }, [changeQueue, syncNow, syncing])
  const [attachmentsStore, setAttachmentsStore] = useState<Attachment[]>(() => {
    if (typeof window === 'undefined') return sampleData.attachments
    try {
      const saved = window.localStorage.getItem('labnote.attachments')
      if (saved) return JSON.parse(saved) as Attachment[]
    } catch (err) {
      console.warn('Unable to read cached attachments', err)
    }
    return sampleData.attachments
  })

  // Persist drafts to localStorage for quick offline reloads
  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem('labnote.entries', JSON.stringify(entryDrafts))
      } catch (err) {
        console.warn('Unable to cache entries', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [entryDrafts])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem('labnote.attachments', JSON.stringify(attachmentsStore))
      } catch (err) {
        console.warn('Unable to cache attachments', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [attachmentsStore])

  const attachmentsForEntry = useCallback(
    (entryId: string) => attachmentsStore.filter((a) => a.entryId === entryId),
    [attachmentsStore]
  )

  const addAttachments = useCallback(
    async (entryId: string, files: File[]) => {
      if (!files.length) return []

      const saved: Attachment[] = []

      for (const file of files) {
        const id = `att-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
        const type = file.type.startsWith('image')
          ? 'image'
          : file.type === 'application/pdf'
            ? 'pdf'
            : 'file'

        // Try filesystem cache first; fallback to IndexedDB
        const fsPath = await writeFileToCache(file)
        let cachePath = fsPath ?? ''
        if (!fsPath) {
          const key = await cacheFile(file)
          cachePath = `idb://${key}`
        } else {
          setFsEnabled(true)
        }

        saved.push({
          id,
          entryId,
          type,
          filename: file.name,
          filesize: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          storagePath: cachePath,
          cachedPath: cachePath,
          pinnedOffline: type === 'image',
          thumbnail: type === 'image' ? URL.createObjectURL(file) : undefined,
        })
      }

      setAttachmentsStore((prev) => [...saved, ...prev])

      setEntryDrafts((prev) => {
        const current = prev[entryId]
        if (!current) return prev
        const updatedLinked = Array.from(new Set([...current.linkedFiles, ...saved.map((a) => a.id)]))
        return {
          ...prev,
          [entryId]: {
            ...current,
            linkedFiles: updatedLinked,
            lastEditedDatetime: new Date().toISOString(),
          },
        }
      })

      return saved
    },
    []
  )

  const addFileDestination = useCallback((entryId: string, val: { path: string; label?: string }): Attachment => {
    const rawPath = val.path.trim()
    if (!rawPath) {
      throw new Error('Path is required.')
    }

    const filename = rawPath.split(/[\\/]/).filter(Boolean).pop() ?? val.label ?? 'file'
    const id = `att-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
    const att: Attachment = {
      id,
      entryId,
      type: 'raw',
      filename: filename.trim() || 'file',
      filesize: '—',
      storagePath: rawPath,
    }

    setAttachmentsStore((prev) => [att, ...prev])
    setEntryDrafts((prev) => {
      const current = prev[entryId]
      if (!current) return prev
      const updatedLinked = Array.from(new Set([...current.linkedFiles, att.id]))
      return {
        ...prev,
        [entryId]: {
          ...current,
          linkedFiles: updatedLinked,
          lastEditedDatetime: new Date().toISOString(),
        },
      }
    })

    return att
  }, [])

  // Hydrate cached attachment thumbnails/URLs from IndexedDB and fs handles
	  useEffect(() => {
	    let cancelled = false
	    const load = async () => {
	      const urlMap: Record<string, string> = {}
	      const missing = new Set<string>()
	      const fsDir = await restoreCacheHandle()
	      const fsDirWithPerm = fsDir ? (fsDir as FsDirectoryWithPerm) : null
	      const fsCanRead =
	        !fsDirWithPerm?.queryPermission ?
	          !!fsDir :
	          (await fsDirWithPerm.queryPermission({ mode: 'read' })) === 'granted'

	      for (const att of attachmentsStore) {
	        if (att.cachedPath?.startsWith('idb://')) {
	          const key = att.cachedPath.replace('idb://', '')
	          try {
            const blob = await getCachedFile(key)
            if (blob) {
              urlMap[att.id] = URL.createObjectURL(blob)
            } else {
              missing.add(att.id)
            }
          } catch (err) {
	            console.warn('Unable to load cached file', att.id, err)
	            missing.add(att.id)
	          }
	        } else if (att.cachedPath?.startsWith('fs://')) {
	          const name = att.cachedPath.replace('fs://', '')
	          if (fsDir && fsCanRead) {
	            try {
	              const handle = await fsDir.getFileHandle(name)
	              const blob = await handle.getFile()
	              urlMap[att.id] = URL.createObjectURL(blob)
	            } catch (err) {
	              console.warn('Unable to read filesystem cached file', att.id, err)
	              missing.add(att.id)
	              if (att.thumbnail) urlMap[att.id] = att.thumbnail
	            }
	          } else {
	            missing.add(att.id)
	            if (att.thumbnail) urlMap[att.id] = att.thumbnail
	          }
	        } else if (att.thumbnail) {
	          urlMap[att.id] = att.thumbnail
	        }
	      }
      if (!cancelled) {
        setAttachmentUrls(urlMap)
        setMissingAttachments(missing)
      }
    }
    load()
    return () => {
      cancelled = true
      Object.values(attachmentUrls).forEach((url) => URL.revokeObjectURL(url))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentsStore])

  const togglePinned = useCallback((attachmentId: string) => {
    setAttachmentsStore((prev) =>
      prev.map((a) => (a.id === attachmentId ? { ...a, pinnedOffline: !a.pinnedOffline } : a))
    )
  }, [])

  const exportExperiment = useCallback(
    async (experimentId: string, format: 'markdown' | 'pdf') => {
      const experiment = experiments.find((ex) => ex.id === experimentId)
      if (!experiment) {
        window.alert('Experiment not found.')
        return
      }
      const project = projects.find((p) => p.id === experiment.projectId)
      const entries = entryList
        .filter((e) => e.experimentId === experimentId)
        .sort((a, b) => a.createdDatetime.localeCompare(b.createdDatetime))

      const entryIds = new Set(entries.map((e) => e.id))
      const attachments = attachmentsStore.filter((a) => entryIds.has(a.entryId))
      const attachmentsById = Object.fromEntries(attachments.map((a) => [a.id, a]))

      if (format === 'pdf') {
        const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeFileName(experiment.title)}</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 28px; color: #111113; }
      header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 18px; }
      h1 { margin: 0; font-size: 22px; }
      h2 { margin: 18px 0 6px; font-size: 18px; }
      h3 { margin: 14px 0 6px; font-size: 15px; color: #5E5E66; }
      .meta { color: #5E5E66; font-size: 12px; }
      .entry { border-top: 1px solid #E7E7EA; padding-top: 14px; margin-top: 14px; }
      blockquote { border-left: 3px solid #4F7CF7; padding: 10px 12px; margin: 10px 0; background: rgba(79,124,247,0.14); }
      ul.checklist { list-style: none; padding-left: 0; }
      ul.checklist li { margin: 6px 0; }
      .cb { display: inline-block; width: 20px; }
      figure { margin: 12px 0; }
      figure img { max-width: 100%; border-radius: 10px; border: 1px solid #E7E7EA; }
      figcaption { font-size: 12px; color: #5E5E66; margin-top: 6px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #E7E7EA; padding: 8px 10px; font-size: 12px; text-align: left; }
      th { background: #FBFBFC; }
      .caption { font-size: 12px; color: #5E5E66; margin-top: 6px; }
      .toolbar { margin-top: 8px; }
      .toolbar button { border-radius: 10px; border: 1px solid #D7D7DD; background: #ffffff; padding: 8px 12px; cursor: pointer; }
      @media print { .toolbar { display: none; } body { margin: 0.5in; } }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>${experiment.title}</h1>
        <div class="meta">
          ${project ? `Project: ${project.title} · ` : ''}
          ${experiment.protocolRef ? `Protocol: ${experiment.protocolRef} · ` : ''}
          Exported: ${new Date().toLocaleString()}
        </div>
      </div>
      <div class="toolbar">
        <button onclick="window.print()">Print / Save to PDF</button>
      </div>
    </header>

    ${entries
      .map(
        (e) => `
      <section class="entry">
        <h2>${e.title}</h2>
        <div class="meta">Created ${new Date(e.createdDatetime).toLocaleString()} · Last edited ${new Date(e.lastEditedDatetime).toLocaleString()}</div>
        ${blocksToHtml(e.content, attachmentsById, attachmentUrls)}
      </section>
    `
      )
      .join('\n')}
  </body>
</html>
        `.trim()

        const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
        const win = window.open(blobUrl, '_blank', 'noopener,noreferrer')
        if (!win) {
          URL.revokeObjectURL(blobUrl)
          window.alert('Pop-up blocked. Allow pop-ups to export PDF.')
          return
        }
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000)
        return
      }

      const exportedAt = new Date().toISOString()
      const dateBucket = exportedAt.slice(0, 10)
      const folderName = safeFileName(`labnote_${dateBucket}_${experiment.title}`)
      const exportMdName = safeFileName(`${experiment.title}.md`)

      const attachmentExportNameById: Record<string, string> = {}
      attachments.forEach((a) => {
        const base = safeFileName(a.filename)
        attachmentExportNameById[a.id] = `${a.id}-${base}`
      })

      const attachmentExportPathById: Record<string, string> = Object.fromEntries(
        Object.entries(attachmentExportNameById).map(([id, name]) => [id, `attachments/${name}`])
      )

      const content = [
        `# ${experiment.title}`,
        '',
        project ? `- Project: ${project.title}` : '',
        experiment.protocolRef ? `- Protocol: ${experiment.protocolRef}` : '',
        `- Exported: ${exportedAt}`,
        '',
        ...entries.flatMap((e) => {
          const header = `## ${e.title}`
          const meta = `Created ${dateOnly.format(new Date(e.createdDatetime))} · Last edited ${dateOnly.format(new Date(e.lastEditedDatetime))}`
          const md = blocksToMarkdown(e.content, attachmentsById, attachmentExportPathById)
          return [header, meta, '', md, '']
        }),
      ]
        .filter(Boolean)
        .join('\n')

      const manifest = {
        exportedAt,
        scope: {
          type: 'experiment',
          experimentId: experiment.id,
          experimentTitle: experiment.title,
          projectId: project?.id ?? null,
          projectTitle: project?.title ?? null,
        },
        entries: entries.map((e) => ({
          id: e.id,
          title: e.title,
          dateBucket: e.dateBucket,
          createdDatetime: e.createdDatetime,
          lastEditedDatetime: e.lastEditedDatetime,
          tags: e.tags,
          linkedFiles: e.linkedFiles,
        })),
        attachments: attachments.map((a) => ({
          id: a.id,
          entryId: a.entryId,
          type: a.type,
          filename: a.filename,
          filesize: a.filesize,
          storagePath: a.storagePath,
          cachedPath: a.cachedPath ?? null,
          pinnedOffline: !!a.pinnedOffline,
          tag: a.tag ?? null,
          sampleId: a.sampleId ?? null,
          exportPath: attachmentExportPathById[a.id] ?? null,
        })),
      }

      const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker
      if (typeof picker !== 'function') {
        downloadBlob(exportMdName, new Blob([content], { type: 'text/markdown;charset=utf-8' }))
        downloadBlob('manifest.json', new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }))
        window.alert('Downloaded Markdown + manifest. For a folder bundle, use Chrome/Edge desktop.')
        return
      }

      const readAttachmentBlob = async (att: Attachment): Promise<Blob | null> => {
        const url = attachmentUrls[att.id] ?? att.thumbnail
        if (att.cachedPath?.startsWith('idb://')) {
          const key = att.cachedPath.replace('idb://', '')
          try {
            return (await getCachedFile(key)) ?? null
          } catch {
            return null
          }
        }

	        if (att.cachedPath?.startsWith('fs://')) {
	          const name = att.cachedPath.replace('fs://', '')
	          const dir = await restoreCacheHandle()
	          if (!dir) return null
	          try {
	            const dirWithPerm = dir as FsDirectoryWithPerm
	            const permFn = dirWithPerm.queryPermission
	            const reqFn = dirWithPerm.requestPermission
	            if (permFn) {
	              const perm = await permFn({ mode: 'read' })
	              if (perm !== 'granted' && reqFn) {
	                const req = await reqFn({ mode: 'read' })
	                if (req !== 'granted') return null
	              }
	            }
	            const handle = await dir.getFileHandle(name)
	            return await handle.getFile()
	          } catch {
	            return null
	          }
	        }

        if (url) {
          try {
            const res = await fetch(url)
            if (!res.ok) return null
            return await res.blob()
          } catch {
            return null
          }
        }

        return null
      }

	      try {
	        const root = await picker({ mode: 'readwrite', id: 'labnote-export' })
	        const dir = await root.getDirectoryHandle(folderName, { create: true })

	        const writeText = async (targetDir: FileSystemDirectoryHandle, name: string, text: string) => {
	          const handle = await targetDir.getFileHandle(name, { create: true })
	          const writable = await handle.createWritable()
	          await writable.write(new Blob([text], { type: 'text/plain;charset=utf-8' }))
	          await writable.close()
	        }

	        const ensureDir = async (targetDir: FileSystemDirectoryHandle, name: string) =>
	          await targetDir.getDirectoryHandle(name, { create: true })

        await writeText(dir, exportMdName, content)
        await writeText(dir, 'manifest.json', JSON.stringify(manifest, null, 2))

        const entriesDir = await ensureDir(dir, 'entries')
        for (const e of entries) {
          const entryMd = [
            `# ${e.title}`,
            '',
            `- Created: ${e.createdDatetime}`,
            `- Last edited: ${e.lastEditedDatetime}`,
            e.tags.length ? `- Tags: ${e.tags.join(', ')}` : '',
            '',
            blocksToMarkdown(e.content, attachmentsById, attachmentExportPathById),
          ]
            .filter(Boolean)
            .join('\n')
          await writeText(entriesDir, `${safeFileName(`${e.dateBucket}_${e.id}`)}.md`, entryMd)
        }

        const attachmentsDir = await ensureDir(dir, 'attachments')
        for (const att of attachments) {
          const blob = await readAttachmentBlob(att)
          if (!blob) continue
          const handle = await attachmentsDir.getFileHandle(attachmentExportNameById[att.id]!, { create: true })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
        }
	
	        window.alert('Export complete.')
	      } catch (err: unknown) {
	        if (isAbortError(err)) return
	        console.warn('Export failed', err)
	        window.alert('Export failed. Check console for details.')
	      }
    },
    [attachmentsStore, attachmentUrls, entryList, experiments, projects]
	  )

  const index = useMemo(() => {
    return lunr(function (this: lunr.Builder) {
      this.ref('id')
      this.field('title')
      this.field('tags')
      this.field('body')
      this.field('attachments')

	      entryList.forEach((entry) => {
	        const attachments = attachmentsForEntry(entry.id)
	        const body = entry.content.map(blockToSearchText).join(' ')
	        const doc = {
	          id: entry.id,
	          title: entry.title,
	          tags: entry.tags.join(' '),
	          body,
	          attachments: attachments.map((a) => `${a.filename} ${a.sampleId ?? ''}`).join(' '),
	        }
	        this.add(doc as Record<string, string>)
	      })
	    })
	  }, [entryList, attachmentsForEntry])

  const matchedIds = useMemo(() => {
    const q = query.trim()
    if (!q) return entryList.map((e) => e.id)
	    try {
	      return index.search(q).map((r: lunr.Index.Result) => r.ref)
	    } catch {
	      return []
	    }
	  }, [index, query, entryList])

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    const now = new Date()
    return entryList.filter((entry) => {
      if (selectedProject !== 'all' && entry.projectId !== selectedProject) return false
      if (selectedExperiment === 'none') {
        if (entry.experimentId) return false
      } else if (selectedExperiment !== 'all' && entry.experimentId !== selectedExperiment) {
        return false
      }
      if (selectedTags.length && !selectedTags.every((t) => entry.tags.includes(t))) return false
      if (filterHasImage) {
        const hasImage = attachmentsForEntry(entry.id).some((a) => a.type === 'image')
        if (!hasImage) return false
      }
      if (filterHasFile) {
        const hasFile = attachmentsForEntry(entry.id).some((a) => a.type === 'file' || a.type === 'raw' || a.type === 'pdf')
        if (!hasFile) return false
      }

      if (datePreset !== 'all') {
        const entryDate = new Date(entry.dateBucket)
        const days = datePreset === '7d' ? 7 : 30
        const diffDays = (now.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24)
        if (diffDays > days) return false
      }

      if (!q) return matchedIds.includes(entry.id)
      return matchedIds.includes(entry.id)
    })
  }, [
    query,
    selectedProject,
    selectedExperiment,
    selectedTags,
    filterHasImage,
    filterHasFile,
    matchedIds,
    datePreset,
    entryList,
    attachmentsForEntry,
  ])

  // Keep experiment filter in sync with project filter.
  useEffect(() => {
    if (selectedExperiment === 'all' || selectedExperiment === 'none') return
    const ex = experiments.find((e) => e.id === selectedExperiment)
    if (!ex) {
      setSelectedExperiment('all')
      return
    }
    if (selectedProject !== 'all' && ex.projectId !== selectedProject) {
      setSelectedExperiment('all')
    }
  }, [experiments, selectedExperiment, selectedProject])

  const entry = entryDrafts[selectedEntryId]
  const project = entry?.projectId ? projects.find((p) => p.id === entry.projectId) : undefined
  const experiment = entry?.experimentId ? experiments.find((ex) => ex.id === entry.experimentId) : undefined
  const attachments = entry ? attachmentsForEntry(entry.id) : []

  const selectedExperimentObj =
    selectedExperiment !== 'all' && selectedExperiment !== 'none'
      ? experiments.find((ex) => ex.id === selectedExperiment)
      : undefined
  const fallbackProjectId = sampleData.users[1]?.settings.defaultProjectId ?? projects[0]?.id ?? ''
  const defaultProjectIdForNewEntry =
    selectedProject !== 'all'
      ? selectedProject
      : selectedExperimentObj?.projectId ?? fallbackProjectId

  // Keep selection in sync with filtered list
  useEffect(() => {
    if (filteredEntries.length === 0) return
    const stillVisible = filteredEntries.some((e) => e.id === selectedEntryId)
    if (!stillVisible) {
      setSelectedEntryId(filteredEntries[0].id)
    }
  }, [filteredEntries, selectedEntryId])

  return (
    <div className="app-bg">
      <div className="app-shell">
        <Sidebar
          labs={sampleData.labs}
          projects={projects}
          experiments={experiments}
          entries={filteredEntries}
          selectedEntryId={selectedEntryId}
          query={query}
          onQueryChange={setQuery}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
          selectedExperiment={selectedExperiment}
          onSelectExperiment={setSelectedExperiment}
          selectedTags={selectedTags}
          onToggleTag={(tag) =>
            setSelectedTags((prev) =>
              prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
            )
          }
          filterHasImage={filterHasImage}
          filterHasFile={filterHasFile}
          onToggleHasImage={() => setFilterHasImage((v) => !v)}
          onToggleHasFile={() => setFilterHasFile((v) => !v)}
          datePreset={datePreset}
          onSelectDatePreset={setDatePreset}
          onSelectEntry={setSelectedEntryId}
          onNewEntry={() => setNewEntryOpen(true)}
          onNewExperiment={() => setNewExperimentOpen(true)}
          onQuickCapture={() => handleCreateEntry({ templateId: 'blank', quickCapture: true })}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <EditorPane
          entry={entry}
          project={project}
          experiment={experiment}
          attachments={attachments}
          attachmentUrls={attachmentUrls}
          onUpdateEntry={(entryId, content) =>
            setEntryDrafts((prev) => {
              const current = prev[entryId]
              if (!current) return prev
              return {
                ...prev,
                [entryId]: {
                  ...current,
                  content,
                  lastEditedDatetime: new Date().toISOString(),
                },
              }
            })
          }
          onAddAttachments={addAttachments}
          onAddFileDestination={addFileDestination}
          onEnqueueChange={(entryId, blockIds, ts) =>
            setChangeQueue((prev) => [
              {
                id: `chg-${ts}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
                entryId,
                blocks: blockIds,
                status: 'pending',
                updatedAt: ts,
                attempts: 0,
              },
              ...prev,
            ])
          }
          changeQueue={changeQueue.filter((c) => c.entryId === selectedEntryId)}
          syncing={syncing}
          onOpenDetails={() => setDetailsOpen(true)}
          autoEditEntryId={autoEditEntryId}
          onConsumeAutoEdit={() => setAutoEditEntryId(null)}
          onExportExperiment={exportExperiment}
        />
      </div>

      {detailsOpen && (
        <div className="drawer-overlay" role="presentation" onMouseDown={() => setDetailsOpen(false)}>
          <div className="drawer" role="presentation" onMouseDown={(e) => e.stopPropagation()}>
            <MetaPanel
              entry={entry}
              project={project}
              experiment={experiment}
              attachments={attachments}
              onTogglePinned={togglePinned}
              missing={missingAttachments}
              attachmentUrls={attachmentUrls}
              changeQueue={changeQueue.filter((c) => c.entryId === selectedEntryId)}
              syncing={syncing}
              onSyncNow={() => syncNow({ entryId: selectedEntryId, includeFailed: true })}
              onRetryChange={retryChange}
              onClearSynced={() => clearSyncedChanges(selectedEntryId)}
              onClose={() => setDetailsOpen(false)}
            />
          </div>
        </div>
      )}
      {newEntryOpen && (
        <NewEntryModal
          onClose={() => setNewEntryOpen(false)}
          projects={projects}
          experiments={experiments}
          defaultProjectId={defaultProjectIdForNewEntry}
          defaultExperimentId={selectedExperiment !== 'all' && selectedExperiment !== 'none' ? selectedExperiment : ''}
          onCreateProject={createProject}
          onCreateExperiment={createExperiment}
          onCreate={(val) => handleCreateEntry(val)}
        />
      )}
      {newExperimentOpen && (
        <NewExperimentModal
          onClose={() => setNewExperimentOpen(false)}
          projects={projects}
          defaultProjectId={defaultProjectIdForNewEntry}
          onCreateProject={createProject}
          onCreate={(val) => {
            createExperiment(val)
            setNewExperimentOpen(false)
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          theme={theme}
          onThemeChange={setTheme}
          fsEnabled={fsEnabled}
          fsNeedsPermission={fsNeedsPermission}
          fsSupported={typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === 'function'}
          onEnable={handlePromptFs}
          onPickDir={handlePickCacheDir}
          onDisconnect={handleDisconnectCacheDir}
          onValidate={validateDiskCache}
        />
      )}
    </div>
  )
}

interface SidebarProps {
  labs: typeof sampleData.labs
  projects: Project[]
  experiments: Experiment[]
  entries: Entry[]
  selectedEntryId: string
  query: string
  onQueryChange: (val: string) => void
  selectedProject: string
  onSelectProject: (id: string) => void
  selectedExperiment: string
  onSelectExperiment: (id: string) => void
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  filterHasImage: boolean
  filterHasFile: boolean
  onToggleHasImage: () => void
  onToggleHasFile: () => void
  datePreset: 'all' | '7d' | '30d'
  onSelectDatePreset: (val: 'all' | '7d' | '30d') => void
  onSelectEntry: (id: string) => void
  onNewEntry: () => void
  onNewExperiment: () => void
  onQuickCapture: () => void
  onOpenSettings: () => void
}

function Sidebar({
  labs,
  projects,
  experiments,
  entries,
  selectedEntryId,
  query,
  onQueryChange,
  selectedProject,
  onSelectProject,
  selectedExperiment,
  onSelectExperiment,
  selectedTags,
  onToggleTag,
  filterHasImage,
  filterHasFile,
  onToggleHasImage,
  onToggleHasFile,
  datePreset,
  onSelectDatePreset,
  onSelectEntry,
  onNewEntry,
  onNewExperiment,
  onQuickCapture,
  onOpenSettings,
}: SidebarProps) {
  const activeLab = labs[0]
  const allTags = useMemo(
    () => Array.from(new Set(projects.flatMap((p) => p.tags))).slice(0, 12),
    [projects]
  )
  const visibleExperiments = useMemo(() => {
    if (selectedProject === 'all') return experiments
    return experiments.filter((ex) => ex.projectId === selectedProject)
  }, [experiments, selectedProject])
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <aside className="panel sidebar">
      <div className="lab-head">
        <div>
          <p className="eyebrow">Lab</p>
          <h2>{activeLab?.name ?? 'Lab'}</h2>
          <p className="muted">Storage: {activeLab?.storageConfig.path}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="status-chip success">Sync ready</div>
          <button className="pill soft" onClick={onOpenSettings} type="button">Settings</button>
        </div>
      </div>

      <div className="search-box">
        <input
          placeholder="Search notes, samples, files"
          value={query}
          ref={searchRef}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <span className="kbd">Ctrl + K</span>
      </div>

      <div className="quick-actions">
        <button className="ghost" onClick={onNewEntry}>+ New Entry</button>
        <button className="ghost" onClick={onNewExperiment}>New Experiment</button>
        <button className="accent" onClick={onQuickCapture}>Quick Capture</button>
      </div>

      <section className="sidebar-section">
        <div className="section-title">Filter</div>
        <label className="field">
          <span className="muted tiny">Project</span>
          <select value={selectedProject} onChange={(e) => onSelectProject(e.target.value)}>
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="muted tiny">Experiment</span>
          <select value={selectedExperiment} onChange={(e) => onSelectExperiment(e.target.value)}>
            <option value="all">All experiments</option>
            <option value="none">General notes</option>
            {visibleExperiments.map((ex) => (
              <option key={ex.id} value={ex.id}>{ex.title}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="sidebar-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div className="section-title">Entries</div>
          <button className="pill soft" type="button" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Less' : 'More'}
          </button>
        </div>
        <div className="muted tiny" style={{ marginBottom: 6 }}>
          Showing {entries.length} item{entries.length === 1 ? '' : 's'}
        </div>
        <div className="entry-list">
          {entries.length === 0 && (
            <div className="muted tiny">No entries match these filters.</div>
          )}
          {entries.map((e) => (
            <button
              key={e.id}
              className={`entry-item ${selectedEntryId === e.id ? 'active' : ''}`}
              onClick={() => onSelectEntry(e.id)}
            >
              <div>
                <div className="title-sm">{e.title}</div>
                <p className="muted tiny">{dateOnly.format(new Date(e.createdDatetime))}</p>
              </div>
              {e.tags[0] ? (
                <div className="pill ghost-pill">{e.tags[0]}</div>
              ) : (
                <div className="pill soft">Draft</div>
              )}
            </button>
          ))}
        </div>

        {showAdvanced && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div className="section-title">Tag filters</div>
              <div className="chip-row">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    className={`pill soft ${selectedTags.includes(tag) ? 'active-pill' : ''}`}
                    onClick={() => onToggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="section-title">Attachments</div>
              <div className="chip-row">
                <button
                  className={`pill soft ${filterHasImage ? 'active-pill' : ''}`}
                  onClick={onToggleHasImage}
                >
                  Has image
                </button>
                <button
                  className={`pill soft ${filterHasFile ? 'active-pill' : ''}`}
                  onClick={onToggleHasFile}
                >
                  Has file/raw/pdf
                </button>
              </div>
            </div>

            <div>
              <div className="section-title">Date</div>
              <div className="chip-row">
                <button
                  className={`pill soft ${datePreset === 'all' ? 'active-pill' : ''}`}
                  onClick={() => onSelectDatePreset('all')}
                >
                  All time
                </button>
                <button
                  className={`pill soft ${datePreset === '7d' ? 'active-pill' : ''}`}
                  onClick={() => onSelectDatePreset('7d')}
                >
                  Last 7d
                </button>
                <button
                  className={`pill soft ${datePreset === '30d' ? 'active-pill' : ''}`}
                  onClick={() => onSelectDatePreset('30d')}
                >
                  Last 30d
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </aside>
  )
}

interface EditorPaneProps {
  entry?: Entry
  project?: Project
  experiment?: Experiment
  attachments: Attachment[]
  attachmentUrls: Record<string, string>
  onUpdateEntry: (entryId: string, content: Block[]) => void
  onAddAttachments: (entryId: string, files: File[]) => Promise<Attachment[]>
  onAddFileDestination: (entryId: string, val: { path: string; label?: string }) => Attachment
  onEnqueueChange: (entryId: string, blockIds: string[], timestamp: string) => void
  changeQueue: ChangeQueueItem[]
  syncing: boolean
  onOpenDetails: () => void
  autoEditEntryId: string | null
  onConsumeAutoEdit: () => void
  onExportExperiment: (experimentId: string, format: 'markdown' | 'pdf') => Promise<void>
}

function EditorPane({
  entry,
  project,
  experiment,
  attachments,
  attachmentUrls,
  onUpdateEntry,
  onAddAttachments,
  onAddFileDestination,
  onEnqueueChange,
  changeQueue,
  syncing,
  onOpenDetails,
  autoEditEntryId,
  onConsumeAutoEdit,
  onExportExperiment,
}: EditorPaneProps) {
  const [exporting, setExporting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editor] = useState(() => withChecklists(withReact(createEditor() as ReactEditor)))
  const [editorValue, setEditorValue] = useState<Descendant[]>(
    () => blocksToSlate(entry?.content ?? [{ id: 'b-empty', type: 'paragraph', text: '' }])
  )

  useEffect(() => {
    if (!entry) return
    setIsEditing(false)
    setEditorValue(blocksToSlate(entry.content))
  }, [entry])

  useEffect(() => {
    if (!entry) return
    if (autoEditEntryId && entry.id === autoEditEntryId) {
      setIsEditing(true)
      onConsumeAutoEdit()
    }
  }, [autoEditEntryId, entry, onConsumeAutoEdit])

  const attachmentMap = useMemo(
    () => Object.fromEntries(attachments.map((a) => [a.id, a])),
    [attachments]
  )

  const pendingCount = changeQueue.filter((c) => c.status === 'pending').length
  const failedCount = changeQueue.filter((c) => c.status === 'failed').length
  const hasWork = pendingCount > 0 || failedCount > 0

  const handleUpdateBlock = useCallback(
    (updated: Block) => {
      if (!entry) return
      const timestamp = new Date().toISOString()
      const next = entry.content.map((b) =>
        b.id === updated.id ? { ...updated, updatedAt: timestamp, updatedBy: 'me' } : b
      )
      onUpdateEntry(entry.id, next)
      onEnqueueChange(entry.id, [updated.id], timestamp)
    },
    [entry, onUpdateEntry, onEnqueueChange]
  )

  const viewSections = useMemo(() => {
    const blocks = entry?.content ?? []
    const sections: Array<{ key: string; blocks: Block[] }> = []
    let current: { key: string; blocks: Block[] } | null = null

    for (const block of blocks) {
      if (block.type === 'heading' && block.level === 2) {
        current = { key: block.id, blocks: [block] }
        sections.push(current)
        continue
      }

      if (!current) {
        current = { key: 'intro', blocks: [] }
        sections.push(current)
      }

      current.blocks.push(block)
    }

    return sections
  }, [entry?.content])

  if (!entry) {
    return (
      <main className="panel editor">
        <div className="empty">Select or create a note to get started.</div>
      </main>
    )
  }

  const handleSave = () => {
    const updatedBlocks = slateToBlocks(editorValue)
    const timestamp = new Date().toISOString()
    updatedBlocks.forEach((b) => {
      b.updatedAt = timestamp
      b.updatedBy = 'me'
    })
    onUpdateEntry(entry.id, updatedBlocks)
    onEnqueueChange(entry.id, updatedBlocks.map((b) => b.id), timestamp)
    setIsEditing(false)
  }

  const handleDrop: React.DragEventHandler = (event) => {
    event.preventDefault()
    const files = Array.from(event.dataTransfer.files)
    void (async () => {
      const saved = await onAddAttachments(entry.id, files)
      if (!isEditing) return
      const blocks: Block[] = saved.map((att) => {
        const blockId = newId('b-')
        if (att.type === 'image') return { id: blockId, type: 'image', attachmentId: att.id, caption: att.filename }
        return { id: blockId, type: 'file', attachmentId: att.id, label: att.filename }
      })
      insertAttachmentMetaBlocks(editor, blocks)
    })()
  }

  const handlePaste: React.ClipboardEventHandler = (event) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length) {
      event.preventDefault()
      void (async () => {
        const saved = await onAddAttachments(entry.id, files)
        if (!isEditing) return
        const blocks: Block[] = saved.map((att) => {
          const blockId = newId('b-')
          if (att.type === 'image') return { id: blockId, type: 'image', attachmentId: att.id, caption: att.filename }
          return { id: blockId, type: 'file', attachmentId: att.id, label: att.filename }
        })
        insertAttachmentMetaBlocks(editor, blocks)
      })()
    }
  }

  return (
    <main className="panel editor" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()} onPaste={handlePaste}>
      <div className="editor-header">
        <div className="editor-header-inner">
          <div className="breadcrumbs">
            <span>{project?.title ?? 'Project'}</span>
            <span>/</span>
            <span>{experiment?.title ?? 'General note'}</span>
            <span className="pill soft">{entry.dateBucket}</span>
            <span className={`status-chip ${syncing || hasWork ? 'warning' : 'success'}`}>
              {syncing ? 'Syncing…' : failedCount ? `${failedCount} failed` : pendingCount ? `${pendingCount} pending` : 'Synced'}
            </span>
            <div className="spacer" />
            {experiment ? (
              <>
                <button
                  className="ghost"
                  disabled={exporting}
                  onClick={async () => {
                    setExporting(true)
                    try {
                      await onExportExperiment(experiment.id, 'pdf')
                    } finally {
                      setExporting(false)
                    }
                  }}
                >
                  Export PDF
                </button>
                <button
                  className="ghost"
                  disabled={exporting}
                  onClick={async () => {
                    setExporting(true)
                    try {
                      await onExportExperiment(experiment.id, 'markdown')
                    } finally {
                      setExporting(false)
                    }
                  }}
                >
                  Export MD
                </button>
              </>
            ) : (
              <button className="ghost" disabled title="Attach this note to an experiment to export a bundle.">
                Export PDF
              </button>
            )}
            <button className="ghost" type="button" onClick={onOpenDetails}>
              Details
            </button>
            {!isEditing ? (
              <button className="accent" onClick={() => setIsEditing(true)}>
                Edit
              </button>
            ) : (
              <div className="edit-actions">
                <button className="ghost" onClick={() => setIsEditing(false)}>
                  Cancel
                </button>
                <button className="accent" onClick={handleSave}>
                  Save
                </button>
              </div>
            )}
          </div>
          <div className="meta-row">
            <span className="muted tiny">Created {dtFormat.format(new Date(entry.createdDatetime))}</span>
            <span className="dot" />
            <span className="muted tiny">Last edited {dtFormat.format(new Date(entry.lastEditedDatetime))}</span>
          </div>
          <div className="title-row">
            <h1>{entry.title}</h1>
            {experiment?.protocolRef && <span className="pill">{experiment.protocolRef}</span>}
          </div>
        </div>
      </div>

      {!isEditing && (
        <div className="blocks">
          {viewSections.map((section) => (
            <section key={section.key} className="content-section">
              {section.blocks.map((block) => (
                <div key={block.id} className="block-shell">
                  <BlockRenderer
                    block={block}
                    attachments={attachmentMap}
                    attachmentUrls={attachmentUrls}
                    onUpdateBlock={handleUpdateBlock}
                  />
                  {block.updatedAt && (
                    <div className="block-meta muted tiny">
                      Updated {dtFormat.format(new Date(block.updatedAt))}
                      {block.updatedBy ? ` · ${block.updatedBy}` : ''}
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}

      {isEditing && (
        <div className="editor-surface">
          <EditorAttachmentContext.Provider value={{ attachmentsById: attachmentMap, attachmentUrls }}>
            <Slate
              key={entry.id}
              editor={editor}
              initialValue={editorValue}
              onChange={setEditorValue}
            >
              <EditorInsertBar
                entryId={entry.id}
                onAddAttachments={onAddAttachments}
                onAddFileDestination={onAddFileDestination}
              />
              <Editable
                renderElement={renderElement}
                renderLeaf={renderLeaf}
                className="slate-editor"
                placeholder="Type your lab note..."
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                    const key = event.key.toLowerCase()
                    if (key === 'b') {
                      event.preventDefault()
                      toggleMark(editor, 'bold')
                      return
                    }
                    if (key === 'i') {
                      event.preventDefault()
                      toggleMark(editor, 'italic')
                      return
                    }
                    if (key === 'u') {
                      event.preventDefault()
                      toggleMark(editor, 'underline')
                      return
                    }
                  }

                  if (event.key !== 'Enter' && event.key !== 'Backspace') return

                  const selection = editor.selection
                  if (!selection) return

                  const checkItemEntry = Editor.above(editor, {
                    match: (n) => SlateElement.isElement(n) && n.type === 'check-item',
                  })

                  if (!checkItemEntry) return

                  const [checkItemNode, checkItemPath] = checkItemEntry
                  const checklistPath = Path.parent(checkItemPath)

                  if (event.key === 'Enter') {
                    event.preventDefault()

                    Transforms.splitNodes(editor, {
                      at: selection,
                      match: (n) => SlateElement.isElement(n) && n.type === 'check-item',
                    })

                    const newEntry = Editor.above(editor, {
                      match: (n) => SlateElement.isElement(n) && n.type === 'check-item',
                    })

                    if (newEntry) {
                      const [, newPath] = newEntry
                      Transforms.setNodes(editor, { done: false, itemId: newId('ci-') }, { at: newPath })
                    }
                    return
                  }

                  if (event.key === 'Backspace') {
                    if (!Range.isCollapsed(selection)) return
                    if (!Editor.isStart(editor, selection.anchor, checkItemPath)) return
                    if (Node.string(checkItemNode).trim() !== '') return

                    event.preventDefault()

                    const checklistNode = Node.get(editor, checklistPath)
                    const itemCount =
                      SlateElement.isElement(checklistNode) && checklistNode.type === 'checklist'
                        ? checklistNode.children.length
                        : 0

                    if (itemCount <= 1) {
                      const blockId =
                        SlateElement.isElement(checklistNode) && typeof checklistNode.blockId === 'string'
                          ? checklistNode.blockId
                          : undefined
                      Transforms.removeNodes(editor, { at: checklistPath })
                      Transforms.insertNodes(
                        editor,
                        { type: 'paragraph', blockId, children: [{ text: '' }] },
                        { at: checklistPath, select: true }
                      )
                      return
                    }

                    const idx = checkItemPath[checkItemPath.length - 1] as number
                    const fallbackPath = idx > 0 ? Path.previous(checkItemPath) : checkItemPath
                    Transforms.removeNodes(editor, { at: checkItemPath })
                    Transforms.select(editor, Editor.end(editor, fallbackPath))
                  }
                }}
              />
            </Slate>
          </EditorAttachmentContext.Provider>
          <div className="muted tiny">
            Tip: use the insert bar above; drag/drop or paste files into the editor.
          </div>
        </div>
      )}
    </main>
  )
}

interface MetaPanelProps {
  entry?: Entry
  project?: Project
  experiment?: Experiment
  attachments: Attachment[]
  onTogglePinned: (attachmentId: string) => void
  missing: Set<string>
  attachmentUrls: Record<string, string>
  changeQueue: ChangeQueueItem[]
  syncing: boolean
  onSyncNow: () => void
  onRetryChange: (changeId: string) => void
  onClearSynced: () => void
  onClose?: () => void
}

function MetaPanel({
  entry,
  project,
  experiment,
  attachments,
  onTogglePinned,
  missing,
  attachmentUrls,
  changeQueue,
  syncing,
  onSyncNow,
  onRetryChange,
  onClearSynced,
  onClose,
}: MetaPanelProps) {
  const pinned = entry?.pinnedRegions ?? []

  return (
    <aside className="panel meta">
      {onClose && (
        <div className="drawer-head">
          <div>
            <div className="title-sm">Details</div>
            {entry?.title && <div className="muted tiny">{entry.title}</div>}
          </div>
          <button className="ghost" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      )}
      <section>
        <div className="section-title">Project</div>
        {project ? (
          <div className="meta-card">
            <div className="title-sm">{project.title}</div>
            {project.description && <p className="muted tiny">{project.description}</p>}
            <div className="chip-row">
              {project.tags.map((tag) => (
                <span key={tag} className="pill soft">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="muted tiny">No project linked</div>
        )}
      </section>

      <section>
        <div className="section-title">Experiment</div>
        {experiment ? (
          <div className="meta-card">
            <div>
              <div className="title-sm">{experiment.title}</div>
              <p className="muted tiny">{experiment.protocolRef}</p>
              <p className="muted tiny">Default path: {experiment.defaultRawDataPath ?? '—'}</p>
            </div>
          </div>
        ) : (
          <div className="muted tiny">No experiment linked</div>
        )}
      </section>

      <section>
        <div className="section-title">Tags</div>
        <div className="chip-row">
          {entry?.tags.map((tag) => (
            <span key={tag} className="pill">
              {tag}
            </span>
          ))}
        </div>
      </section>

      <section>
        <div className="section-title">Pinned regions</div>
        <div className="pinned-list">
          {pinned.map((region) => (
            <div key={region.id} className="pinned-card">
              <div className="title-sm">{region.label}</div>
              {region.summary && <p className="muted tiny">{region.summary}</p>}
              <div className="chip-row">
                <span className="pill soft">{region.blockIds.length} blocks</span>
                {region.linkedAttachments.length > 0 && (
                  <span className="pill soft">{region.linkedAttachments.length} files</span>
                )}
              </div>
            </div>
          ))}
          {pinned.length === 0 && <div className="muted tiny">No pinned regions yet.</div>}
        </div>
      </section>

      <section>
        <div className="section-title">Attachments</div>
        <div className="attachment-list">
          {attachments.map((file) => (
            <AttachmentRow
              key={file.id}
              attachment={file}
              onTogglePinned={onTogglePinned}
              missing={missing.has(file.id)}
              url={attachmentUrls[file.id]}
            />
          ))}
          {attachments.length === 0 && <div className="muted tiny">No files linked.</div>}
        </div>
      </section>

      <section>
        <div className="section-title">Sync queue</div>
        <div className="muted tiny" style={{ marginBottom: 6 }}>
          {syncing
            ? 'Syncing changes…'
            : changeQueue.some((c) => c.status === 'failed')
              ? `${changeQueue.filter((c) => c.status === 'failed').length} failed`
              : changeQueue.some((c) => c.status === 'pending')
                ? `${changeQueue.filter((c) => c.status === 'pending').length} pending`
                : 'All synced.'}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <button
            className="ghost"
            type="button"
            disabled={syncing || !changeQueue.some((c) => c.status === 'pending' || c.status === 'failed')}
            onClick={onSyncNow}
          >
            {changeQueue.some((c) => c.status === 'failed') ? 'Retry failed' : 'Sync now'}
          </button>
          <button
            className="ghost"
            type="button"
            disabled={syncing || !changeQueue.some((c) => c.status === 'synced')}
            onClick={onClearSynced}
          >
            Clear synced
          </button>
        </div>

        <div className="pinned-list">
          {changeQueue.slice(0, 6).map((c) => (
            <div key={c.id} className="meta-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div>
                  <div className="title-sm">Change</div>
                  <div className="muted tiny">
                    Updated {dtFormat.format(new Date(c.updatedAt))}
                    {c.lastTriedAt ? ` · Tried ${dtFormat.format(new Date(c.lastTriedAt))}` : ''}
                  </div>
                </div>
                <div className={`status-chip ${c.status === 'synced' ? 'success' : 'warning'}`}>{c.status}</div>
              </div>
              <div className="chip-row" style={{ marginTop: 8 }}>
                <span className="pill soft">{c.blocks.length} block{c.blocks.length === 1 ? '' : 's'}</span>
                <span className="pill soft">{c.attempts} try{c.attempts === 1 ? '' : 'ies'}</span>
                {c.status === 'failed' && (
                  <button className="pill soft" type="button" disabled={syncing} onClick={() => onRetryChange(c.id)}>
                    Retry
                  </button>
                )}
              </div>
              {c.lastError && <div className="muted tiny" style={{ marginTop: 8, color: 'var(--danger)' }}>{c.lastError}</div>}
            </div>
          ))}
          {changeQueue.length === 0 && <div className="muted tiny">No local changes queued.</div>}
        </div>
      </section>

      <section>
        <div className="section-title">Backlinks</div>
        <div className="muted tiny">Will list entries mentioning this experiment or sample IDs.</div>
      </section>
    </aside>
  )
}

function AttachmentRow({ attachment, onTogglePinned, missing, url }: { attachment: Attachment; onTogglePinned: (id: string) => void; missing?: boolean; url?: string }) {
  const icon = {
    image: '🖼️',
    pdf: '📄',
    file: '📁',
    raw: '🧪',
  }[attachment.type]

  return (
    <div className="attachment-row">
      <div className="attachment-icon">{icon}</div>
      <div className="attachment-body">
        <div className="title-sm">{attachment.filename}</div>
        <p className="muted tiny">{attachment.filesize}</p>
        <p className="muted tiny">Path: {attachment.cachedPath ?? attachment.storagePath}</p>
        {attachment.type === 'image' && url && !missing && (
          <img src={url} alt={attachment.filename} style={{ width: 80, borderRadius: 8 }} />
        )}
        {missing && <p className="muted tiny" style={{ color: 'var(--danger)' }}>Cached blob missing</p>}
      </div>
      {attachment.tag && <span className="pill soft">{attachment.tag}</span>}
      {attachment.sampleId && <span className="pill ghost-pill">{attachment.sampleId}</span>}
      <button className={`pill soft ${attachment.pinnedOffline ? 'active-pill' : ''}`} onClick={() => onTogglePinned(attachment.id)}>
        {attachment.pinnedOffline ? 'Pinned offline' : 'Pin offline'}
      </button>
    </div>
  )
}

interface BlockRendererProps {
  block: Block
  attachments: Record<string, Attachment>
  attachmentUrls: Record<string, string>
  onUpdateBlock?: (block: Block) => void
}

const renderElement = (props: RenderElementProps) => {
  const { element, attributes, children } = props
  const align = isTextAlignValue(element.align) ? element.align : undefined
  const style: React.CSSProperties | undefined = align ? { textAlign: align } : undefined
  const locked = element.locked === true
  switch (element.type) {
    case 'heading-two':
      return locked ? (
        <h2 className="block-heading h2 locked-block" {...attributes} style={style} contentEditable={false}>
          {children}
        </h2>
      ) : (
        <h2 className="block-heading h2" {...attributes} style={style}>
          {children}
        </h2>
      )
    case 'heading-three':
      return locked ? (
        <h3 className="block-heading h3 locked-block" {...attributes} style={style} contentEditable={false}>
          {children}
        </h3>
      ) : (
        <h3 className="block-heading h3" {...attributes} style={style}>
          {children}
        </h3>
      )
    case 'quote':
      return (
        <blockquote className="quote" {...attributes} style={style}>
          {children}
        </blockquote>
      )
    case 'checklist':
      return <ChecklistElement {...props} />
    case 'check-item':
      return <CheckItemElement {...props} />
    case 'attachment':
      return <AttachmentElement {...props} />
    case 'divider':
      return (
        <div {...attributes} contentEditable={false} className="readonly-block">
          <hr className="divider" />
          {children}
        </div>
      )
    case 'readonly':
      return (
        <div {...attributes} contentEditable={false} className="readonly-block">
          <span className="pill soft">{typeof element.label === 'string' ? element.label : 'Attachment'}</span>
          {children}
        </div>
      )
    default:
      return (
        <p className="block-paragraph" {...attributes} style={style}>
          {children}
        </p>
      )
  }
}

const renderLeaf = ({ attributes, children, leaf }: RenderLeafProps) => {
  let content = children
  if ((leaf as unknown as { underline?: boolean }).underline) content = <u>{content}</u>
  if ((leaf as unknown as { italic?: boolean }).italic) content = <em>{content}</em>
  if ((leaf as unknown as { bold?: boolean }).bold) content = <strong>{content}</strong>
  return <span {...attributes}>{content}</span>
}

type MarkFormat = 'bold' | 'italic' | 'underline'
type TextAlign = 'left' | 'center' | 'right' | 'justify'

function isTextAlignValue(value: unknown): value is TextAlign {
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify'
}

function isMarkActive(editor: ReactEditor, format: MarkFormat): boolean {
  const marks = Editor.marks(editor) as Record<string, unknown> | null
  return marks?.[format] === true
}

function toggleMark(editor: ReactEditor, format: MarkFormat) {
  if (isMarkActive(editor, format)) {
    Editor.removeMark(editor, format)
  } else {
    Editor.addMark(editor, format, true)
  }
}

function getActiveBlockEntry(editor: ReactEditor): [SlateElement, Path] | null {
  const entry = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && typeof (n as { blockId?: unknown }).blockId === 'string',
  })
  return entry ? (entry as [SlateElement, Path]) : null
}

function insertHeadingBlock(editor: ReactEditor, level: 2 | 3 = 2) {
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]
  const blockId = newId('b-')
  const headingNode: Descendant = {
    type: level === 3 ? 'heading-three' : 'heading-two',
    blockId,
    children: [{ text: '' }],
  }
  const paragraphNode: Descendant = { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] }
  Transforms.insertNodes(editor, [headingNode, paragraphNode], { at: insertAt })
  Transforms.select(editor, Editor.start(editor, insertAt))
  ReactEditor.focus(editor)
}

function insertSection(editor: ReactEditor, label: string) {
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]
  const headingNode: Descendant = {
    type: 'heading-two',
    blockId: newId('b-'),
    children: [{ text: label }],
  }
  const paragraphNode: Descendant = { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] }
  Transforms.insertNodes(editor, [headingNode, paragraphNode], { at: insertAt })
  const paragraphPath = Path.next(insertAt)
  Transforms.select(editor, Editor.start(editor, paragraphPath))
  ReactEditor.focus(editor)
}

function insertSectionWithChecklist(editor: ReactEditor, label: string) {
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]
  const headingNode: Descendant = {
    type: 'heading-two',
    blockId: newId('b-'),
    children: [{ text: label }],
  }
  const checklistNode: Descendant = {
    type: 'checklist',
    blockId: newId('b-'),
    children: [{ type: 'check-item', itemId: newId('ci-'), done: false, children: [{ text: '' }] }],
  }
  const paragraphNode: Descendant = { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] }
  Transforms.insertNodes(editor, [headingNode, checklistNode, paragraphNode], { at: insertAt })

  const base = typeof insertAt[0] === 'number' ? (insertAt[0] as number) : editor.children.length
  const checklistTextPath: Path = [base + 1, 0, 0]
  Transforms.select(editor, Editor.start(editor, checklistTextPath))
  ReactEditor.focus(editor)
}

function insertAttachmentMetaBlocks(editor: ReactEditor, blocks: Array<Block>) {
  if (blocks.length === 0) return
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]

  const nodes: Descendant[] = blocks.map((block) => ({
    type: 'attachment',
    blockId: block.id,
    meta: block,
    children: [{ text: '' }],
  }))
  const paragraphNode: Descendant = { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] }

  Transforms.insertNodes(editor, [...nodes, paragraphNode], { at: insertAt })

  const base = typeof insertAt[0] === 'number' ? (insertAt[0] as number) : editor.children.length
  const paragraphPath: Path = [base + nodes.length]
  Transforms.select(editor, Editor.start(editor, paragraphPath))
  ReactEditor.focus(editor)
}

function insertChecklistBlock(editor: ReactEditor) {
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]
  const blockId = newId('b-')
  const checklistNode: Descendant = {
    type: 'checklist',
    blockId,
    children: [{ type: 'check-item', itemId: newId('ci-'), done: false, children: [{ text: '' }] }],
  }
  Transforms.insertNodes(editor, checklistNode, { at: insertAt })
  Transforms.select(editor, Editor.start(editor, insertAt.concat(0, 0)))
  ReactEditor.focus(editor)
}

function insertDividerBlock(editor: ReactEditor) {
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]
  const blockId = newId('b-')
  const dividerNode: Descendant = { type: 'divider', blockId, meta: { id: blockId, type: 'divider' }, children: [{ text: '' }] }
  Transforms.insertNodes(editor, dividerNode, { at: insertAt })

  const paragraphPath = Path.next(insertAt)
  const paragraphNode: Descendant = { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] }
  Transforms.insertNodes(editor, paragraphNode, { at: paragraphPath })
  Transforms.select(editor, Editor.start(editor, paragraphPath.concat(0)))
  ReactEditor.focus(editor)
}

function FileDestinationModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (val: { path: string; label?: string }) => void
}) {
  const [label, setLabel] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pathRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    window.setTimeout(() => pathRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 'min(640px, 100%)' }}>
        <div className="modal-head">
          <div>
            <div className="title-sm">Add file destination</div>
            <div className="muted tiny">Store a path to raw data or output files (no upload).</div>
          </div>
          <button className="ghost" onClick={onClose} type="button">Close</button>
        </div>

        <div className="modal-grid">
          <label className="field">
            <span className="muted tiny">Label (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. qPCR export (CT)" />
          </label>

          <label className="field">
            <span className="muted tiny">Path</span>
            <input
              ref={pathRef}
              value={path}
              onChange={(e) => {
                setError(null)
                setPath(e.target.value)
              }}
              placeholder="e.g. \\\\labserver\\project\\2025-12-17\\run1.csv"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const cleaned = path.trim()
                if (!cleaned) {
                  setError('Path is required.')
                  return
                }
                onSubmit({ path: cleaned, label: label.trim() || undefined })
              }}
            />
            {error && <div className="field-error tiny">{error}</div>}
          </label>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Cancel</button>
          <button
            className="accent"
            type="button"
            onClick={() => {
              const cleaned = path.trim()
              if (!cleaned) {
                setError('Path is required.')
                return
              }
              onSubmit({ path: cleaned, label: label.trim() || undefined })
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

function EditorInsertBar({
  entryId,
  onAddAttachments,
  onAddFileDestination,
}: {
  entryId: string
  onAddAttachments: (entryId: string, files: File[]) => Promise<Attachment[]>
  onAddFileDestination: (entryId: string, val: { path: string; label?: string }) => Attachment
}) {
  const editor = useSlate()
  const imgRef = useRef<HTMLInputElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [destOpen, setDestOpen] = useState(false)

  const insertFromAttachments = useCallback(
    (attachments: Attachment[]) => {
      const blocks: Block[] = attachments.map((att) => {
        const blockId = newId('b-')
        if (att.type === 'image') {
          return { id: blockId, type: 'image', attachmentId: att.id, caption: att.filename }
        }
        return { id: blockId, type: 'file', attachmentId: att.id, label: att.filename }
      })
      insertAttachmentMetaBlocks(editor, blocks)
    },
    [editor]
  )

  const pickAndInsert = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return
      const saved = await onAddAttachments(entryId, Array.from(files))
      insertFromAttachments(saved)
    },
    [entryId, insertFromAttachments, onAddAttachments]
  )

  return (
    <>
      <div className="editor-toolbar" contentEditable={false}>
        <div className="toolbar-group">
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertHeadingBlock(editor, 2)}>
            + Header
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertChecklistBlock(editor)}>
            + Checks
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSection(editor, 'Aim')}>
            + Aim
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSectionWithChecklist(editor, 'Experiment')}>
            + Experiment
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSection(editor, 'Results')}>
            + Results
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => imgRef.current?.click()}>
            + Image
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>
            + File
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setDestOpen(true)}>
            + File destination
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertDividerBlock(editor)}>
            + Divider
          </button>
        </div>
      </div>

      <input
        ref={imgRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          void pickAndInsert(e.target.files)
          e.currentTarget.value = ''
        }}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          void pickAndInsert(e.target.files)
          e.currentTarget.value = ''
        }}
      />

      {destOpen && (
        <FileDestinationModal
          onClose={() => setDestOpen(false)}
          onSubmit={(val) => {
            const attachment = onAddFileDestination(entryId, val)
            const blockId = newId('b-')
            const block: Block = { id: blockId, type: 'file', attachmentId: attachment.id, label: val.label ?? attachment.filename }
            insertAttachmentMetaBlocks(editor, [block])
            setDestOpen(false)
          }}
        />
      )}
    </>
  )
}

function ChecklistElement({ element, attributes, children }: RenderElementProps) {
  const editor = useSlateStatic()
  const canAdd = element.locked !== true

  return (
    <div className="checklist" {...attributes}>
      {children}
      <div className="checklist-actions" contentEditable={false}>
        <button
          type="button"
          className="pill soft"
          disabled={!canAdd}
          title={canAdd ? 'Add a new checklist item' : 'This checklist is locked'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!canAdd) return
            const checklistPath = ReactEditor.findPath(editor, element)
            const nextIndex = Array.isArray(element.children) ? element.children.length : 0
            const itemPath = checklistPath.concat(nextIndex)
            Transforms.insertNodes(
              editor,
              { type: 'check-item', itemId: newId('ci-'), done: false, children: [{ text: '' }] },
              { at: itemPath }
            )
            Transforms.select(editor, Editor.start(editor, itemPath.concat(0)))
            ReactEditor.focus(editor)
          }}
        >
          + Step
        </button>
        <span className="muted tiny">Tip: press Enter to add a step</span>
      </div>
    </div>
  )
}

function CheckItemElement({ element, attributes, children }: RenderElementProps) {
  const editor = useSlateStatic()
  const checked = element.done === true

  return (
    <div className="check-item" data-done={checked ? 'true' : 'false'} {...attributes}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          const path = ReactEditor.findPath(editor, element)
          Transforms.setNodes(editor, { done: e.target.checked }, { at: path })
          ReactEditor.focus(editor)
        }}
        onMouseDown={(e) => e.preventDefault()}
        contentEditable={false}
      />
      <span>{children}</span>
    </div>
  )
}

function AttachmentElement({ element, attributes, children }: RenderElementProps) {
  const ctx = useContext(EditorAttachmentContext)
  const meta = isBlock(element.meta) ? element.meta : undefined
  const attachmentId = meta && (meta.type === 'image' || meta.type === 'file') ? meta.attachmentId : undefined
  const attachment = attachmentId ? ctx?.attachmentsById[attachmentId] : undefined
  const url = attachmentId ? (ctx?.attachmentUrls[attachmentId] ?? attachment?.thumbnail) : undefined

  const icon = {
    image: '🖼️',
    pdf: '📄',
    file: '📁',
    raw: '🧪',
  }[attachment?.type ?? 'file']

  const elementLabel = typeof element.label === 'string' ? element.label : 'Attachment'
  const title =
    meta?.type === 'image'
      ? meta.caption ?? attachment?.filename ?? 'Image'
      : meta?.type === 'file'
        ? meta.label ?? attachment?.filename ?? 'File'
        : elementLabel

  const href =
    url ??
    (typeof attachment?.storagePath === 'string' && attachment.storagePath.startsWith('http')
      ? attachment.storagePath
      : undefined)

  return (
    <div {...attributes} contentEditable={false} className="readonly-block attachment-block">
      <div className="att-left">
        <div className="att-thumb">
          {meta?.type === 'image' && url ? (
            <img src={url} alt={attachment?.filename ?? 'Image'} />
          ) : (
            <span className="muted tiny">{icon}</span>
          )}
        </div>
        <div className="att-meta">
          <div className="title-sm">{title}</div>
          {attachment?.filename && meta?.type !== 'file' && <div className="muted tiny">{attachment.filename}</div>}
        </div>
      </div>
      <div className="att-actions">
        {href ? (
          <a className="pill soft pill-link" href={href} target="_blank" rel="noopener noreferrer">
            {meta?.type === 'image' ? 'View' : 'Open'}
          </a>
        ) : (
          <span className="pill soft disabled">No preview</span>
        )}
        {attachment?.filesize && <span className="pill soft">{attachment.filesize}</span>}
      </div>
      {children}
    </div>
  )
}

function mergeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const run of runs) {
    const prev = out[out.length - 1]
    const sameMarks =
      prev &&
      (prev.bold ?? false) === (run.bold ?? false) &&
      (prev.italic ?? false) === (run.italic ?? false) &&
      (prev.underline ?? false) === (run.underline ?? false)

    if (prev && sameMarks) {
      prev.text += run.text
    } else {
      out.push({ ...run })
    }
  }
  return out
}

function runsFromSlateChildren(children: Descendant[]): TextRun[] | undefined {
  const raw: TextRun[] = []
  for (const child of children) {
    if (Text.isText(child)) {
      raw.push({
        text: child.text,
        bold: (child as unknown as { bold?: boolean }).bold === true ? true : undefined,
        italic: (child as unknown as { italic?: boolean }).italic === true ? true : undefined,
        underline: (child as unknown as { underline?: boolean }).underline === true ? true : undefined,
      })
      continue
    }

    // Fallback (should be rare for this prototype): flatten nested nodes to plain text.
    raw.push({ text: Node.string(child) })
  }

  const merged = mergeRuns(raw)
  const hasFormatting = merged.some((r) => r.bold || r.italic || r.underline) || merged.length > 1
  return hasFormatting ? merged : undefined
}

function slateTextChildrenFromRuns(runs: TextRun[] | undefined, fallbackText: string): Descendant[] {
  if (runs && runs.length) {
    return runs.map((r) => ({
      text: r.text,
      bold: r.bold === true ? true : undefined,
      italic: r.italic === true ? true : undefined,
      underline: r.underline === true ? true : undefined,
    }))
  }
  return [{ text: fallbackText }]
}

function renderTextRuns(runs: TextRun[] | undefined, fallbackText: string) {
  if (!runs || runs.length === 0) return fallbackText
  return runs.map((run, idx) => {
    let node: React.ReactNode = run.text
    if (run.underline) node = <u>{node}</u>
    if (run.italic) node = <em>{node}</em>
    if (run.bold) node = <strong>{node}</strong>
    return <span key={idx}>{node}</span>
  })
}

const blocksToSlate = (blocks: Block[]): Descendant[] => {
  return blocks.map((block) => {
    switch (block.type) {
      case 'heading':
        return {
          type: block.level === 3 ? 'heading-three' : 'heading-two',
          blockId: block.id,
          locked: block.locked === true,
          align: block.align,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'paragraph':
        return {
          type: 'paragraph',
          blockId: block.id,
          align: block.align,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'quote':
        return {
          type: 'quote',
          blockId: block.id,
          align: block.align,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'checklist':
        return {
          type: 'checklist',
          blockId: block.id,
          children: block.items.map((item) => ({
            type: 'check-item',
            itemId: item.id,
            done: item.done,
            children: slateTextChildrenFromRuns(item.runs, item.text),
          })),
        }
      case 'divider':
        return { type: 'divider', blockId: block.id, meta: block, children: [{ text: '' }] }
      case 'image':
      case 'file':
        return { type: 'attachment', blockId: block.id, meta: block, children: [{ text: '' }] }
      default:
        return {
          type: 'readonly',
          blockId: block.id,
          label: block.type,
          meta: block,
          children: [{ text: '' }],
        }
    }
  })
}

const slateToBlocks = (nodes: Descendant[]): Block[] => {
  const ensureId = (existing?: string) => existing ?? crypto.randomUUID?.() ?? `b-${Date.now()}`
  return nodes.map((node) => {
    if (!SlateElement.isElement(node)) {
      return { id: ensureId(), type: 'paragraph', text: '' }
    }

    const blockId = typeof node.blockId === 'string' ? node.blockId : undefined
    const align = isTextAlignValue(node.align) ? node.align : undefined
    switch (node.type) {
      case 'heading-two':
        return {
          id: ensureId(blockId),
          type: 'heading',
          level: 2,
          locked: node.locked === true,
          align,
          text: Node.string(node),
          runs: runsFromSlateChildren(node.children as unknown as Descendant[]),
        }
      case 'heading-three':
        return {
          id: ensureId(blockId),
          type: 'heading',
          level: 3,
          locked: node.locked === true,
          align,
          text: Node.string(node),
          runs: runsFromSlateChildren(node.children as unknown as Descendant[]),
        }
      case 'quote':
        return {
          id: ensureId(blockId),
          type: 'quote',
          align,
          text: Node.string(node),
          runs: runsFromSlateChildren(node.children as unknown as Descendant[]),
        }
      case 'checklist':
        return {
          id: ensureId(blockId),
          type: 'checklist',
          align,
          items: (node.children as unknown as Descendant[])
            .filter((child): child is SlateElement => SlateElement.isElement(child))
            .map((child) => ({
              id: typeof child.itemId === 'string' ? child.itemId : newId('ci-'),
              text: Node.string(child),
              done: child.done === true,
              runs: runsFromSlateChildren(child.children as unknown as Descendant[]),
            })),
        }
      case 'divider':
      case 'attachment':
      case 'readonly':
        return isBlock(node.meta)
          ? node.meta
          : {
          id: ensureId(blockId),
          type: 'divider',
        }
      default:
        return {
          id: ensureId(blockId),
          type: 'paragraph',
          align,
          text: Node.string(node),
          runs: runsFromSlateChildren(node.children as unknown as Descendant[]),
        }
    }
  })
}

function BlockRenderer({ block, attachments, attachmentUrls, onUpdateBlock }: BlockRendererProps) {
  const style = block.align ? ({ textAlign: block.align } as const) : undefined
  switch (block.type) {
    case 'heading':
      if (block.level === 1) return <h1 className="block-heading h1" style={style}>{renderTextRuns(block.runs, block.text)}</h1>
      if (block.level === 3) return <h3 className="block-heading h3" style={style}>{renderTextRuns(block.runs, block.text)}</h3>
      return <h2 className="block-heading h2" style={style}>{renderTextRuns(block.runs, block.text)}</h2>
    case 'paragraph':
      return <p className="block-paragraph" style={style}>{renderTextRuns(block.runs, block.text)}</p>
    case 'checklist':
      // View-mode quick toggle (edit mode uses Slate)
      return (
        <div className="checklist">
          {block.items.map((item) => (
            <ChecklistRow
              key={item.id}
              item={item}
              onToggleDone={
                onUpdateBlock
                  ? (done) =>
                      onUpdateBlock({
                        ...block,
                        items: block.items.map((it) => (it.id === item.id ? { ...it, done } : it)),
                      })
                  : undefined
              }
            />
          ))}
        </div>
      )
    case 'table':
      return (
        <div className="table-wrap">
          <table>
            <tbody>
              {block.data.map((row, idx) => (
                <tr key={idx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className={idx === 0 ? 'th' : ''}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.caption && <div className="muted tiny">{block.caption}</div>}
        </div>
      )
    case 'image': {
      const attachment = attachments[block.attachmentId]
      const src = attachmentUrls[block.attachmentId] ?? attachment?.thumbnail
      return (
        <figure className="media-card">
          <div className="media-thumb">
            {src ? (
              <img src={src} alt={block.caption ?? attachment?.filename} />
            ) : (
              <div className="media-placeholder">Image</div>
            )}
          </div>
          <figcaption>
            <div className="title-sm">{block.caption ?? attachment?.filename ?? 'Image'}</div>
            <p className="muted tiny">{attachment?.filesize ?? ''}</p>
          </figcaption>
        </figure>
      )
    }
    case 'file': {
      const attachment = attachments[block.attachmentId]
      return (
        <div className="file-card">
          <div>
            <div className="title-sm">{block.label ?? attachment?.filename ?? 'File'}</div>
            <p className="muted tiny">{attachment?.storagePath}</p>
          </div>
          <div className="pill soft">{attachment?.filesize}</div>
        </div>
      )
    }
    case 'quote':
      return <blockquote className="quote" style={style}>{renderTextRuns(block.runs, block.text)}</blockquote>
    case 'divider':
      return <hr className="divider" />
    default:
      return null
  }
}

function ChecklistRow({ item, onToggleDone }: { item: ChecklistItem; onToggleDone?: (done: boolean) => void }) {
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={item.done}
        onChange={(e) => onToggleDone?.(e.target.checked)}
        disabled={!onToggleDone}
      />
      <span>{renderTextRuns(item.runs, item.text)}</span>
      {item.timerMinutes && <span className="pill soft">{item.timerMinutes} min</span>}
    </label>
  )
}

export default App

function NewEntryModal({
  onClose,
  projects,
  experiments,
  defaultProjectId,
  defaultExperimentId,
  onCreateProject,
  onCreateExperiment,
  onCreate,
}: {
  onClose: () => void
  projects: Project[]
  experiments: Experiment[]
  defaultProjectId: string
  defaultExperimentId?: string
  onCreateProject: (title: string) => string
  onCreateExperiment: (opts: { title: string; projectId: string }) => string
  onCreate: (val: { title?: string; projectId?: string; experimentId?: string; templateId: EntryTemplateId }) => void
}) {
  const [title, setTitle] = useState('')
  const resolvedDefaultProjectId = projects.some((p) => p.id === defaultProjectId)
    ? defaultProjectId
    : (projects[0]?.id ?? '')
  const [projectId, setProjectId] = useState(resolvedDefaultProjectId)
  const resolvedDefaultExperimentId =
    defaultExperimentId && experiments.some((ex) => ex.id === defaultExperimentId && ex.projectId === resolvedDefaultProjectId)
      ? defaultExperimentId
      : ''
  const [experimentId, setExperimentId] = useState<string>(resolvedDefaultExperimentId)
  const [templateId, setTemplateId] = useState<EntryTemplateId>('experiment')
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectTitle, setNewProjectTitle] = useState('')
  const [projectError, setProjectError] = useState<string | null>(null)
  const [creatingExperiment, setCreatingExperiment] = useState(false)
  const [newExperimentTitle, setNewExperimentTitle] = useState('')
  const [experimentError, setExperimentError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const newProjectRef = useRef<HTMLInputElement | null>(null)
  const newExperimentRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    window.setTimeout(() => titleRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const projectExperiments = experiments.filter((ex) => (projectId ? ex.projectId === projectId : true))

  const handleAddProject = () => {
    const cleaned = newProjectTitle.trim().replace(/\s+/g, ' ')
    if (!cleaned) {
      setProjectError('Project name is required.')
      return
    }
    try {
      const id = onCreateProject(cleaned)
      setProjectId(id)
      setExperimentId('')
      setCreatingProject(false)
      setNewProjectTitle('')
      setProjectError(null)
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Unable to create project.')
    }
  }

  const handleAddExperiment = () => {
    const cleaned = newExperimentTitle.trim().replace(/\s+/g, ' ')
    if (!cleaned) {
      setExperimentError('Experiment name is required.')
      return
    }
    if (!projectId) {
      setExperimentError('Select a project first.')
      return
    }
    try {
      const id = onCreateExperiment({ title: cleaned, projectId })
      setExperimentId(id)
      setCreatingExperiment(false)
      setNewExperimentTitle('')
      setExperimentError(null)
    } catch (err) {
      setExperimentError(err instanceof Error ? err.message : 'Unable to create experiment.')
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="title-sm">New entry</div>
            <div className="muted tiny">Choose a template and where it belongs.</div>
          </div>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        <div className="modal-grid">
          <label className="field">
            <span className="muted tiny">Title</span>
            <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled note" />
          </label>

          <label className="field">
            <span className="muted tiny">Project</span>
            {!creatingProject ? (
              <div className="field-row">
                <select
                  value={projectId}
                  onChange={(e) => {
                    const nextProjectId = e.target.value
                    setProjectId(nextProjectId)
                    if (!experimentId) return
                    const stillValid = experiments.some((ex) => ex.id === experimentId && ex.projectId === nextProjectId)
                    if (!stillValid) setExperimentId('')
                  }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setCreatingProject(true)
                    setProjectError(null)
                    setNewProjectTitle('')
                    window.setTimeout(() => newProjectRef.current?.focus(), 0)
                  }}
                >
                  + Project
                </button>
              </div>
            ) : (
              <div className="field-row">
                <input
                  ref={newProjectRef}
                  value={newProjectTitle}
                  onChange={(e) => {
                    setProjectError(null)
                    setNewProjectTitle(e.target.value)
                  }}
                  placeholder="New project name"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    handleAddProject()
                  }}
                />
                <button className="accent" type="button" onClick={handleAddProject}>
                  Add
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setCreatingProject(false)
                    setProjectError(null)
                    setNewProjectTitle('')
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            {projectError && <div className="field-error tiny">{projectError}</div>}
          </label>

          <label className="field">
            <span className="muted tiny">Experiment (optional)</span>
            {!creatingExperiment ? (
              <div className="field-row">
                <select value={experimentId} onChange={(e) => setExperimentId(e.target.value)}>
                  <option value="">General note</option>
                  {projectExperiments.map((ex) => (
                    <option key={ex.id} value={ex.id}>{ex.title}</option>
                  ))}
                </select>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setCreatingExperiment(true)
                    setExperimentError(null)
                    setNewExperimentTitle('')
                    window.setTimeout(() => newExperimentRef.current?.focus(), 0)
                  }}
                >
                  + Experiment
                </button>
              </div>
            ) : (
              <div className="field-row">
                <input
                  ref={newExperimentRef}
                  value={newExperimentTitle}
                  onChange={(e) => {
                    setExperimentError(null)
                    setNewExperimentTitle(e.target.value)
                  }}
                  placeholder="New experiment name"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    handleAddExperiment()
                  }}
                />
                <button className="accent" type="button" onClick={handleAddExperiment}>
                  Add
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setCreatingExperiment(false)
                    setExperimentError(null)
                    setNewExperimentTitle('')
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            {experimentError && <div className="field-error tiny">{experimentError}</div>}
          </label>

          <div className="field">
            <span className="muted tiny">Template</span>
            <div className="template-row">
              <button
                type="button"
                className={`template-card ${templateId === 'experiment' ? 'active' : ''}`}
                onClick={() => setTemplateId('experiment')}
              >
                <div className="title-sm">Experiment note</div>
                <div className="muted tiny">Prefills Aim / Experiment / Results sections.</div>
              </button>
              <button
                type="button"
                className={`template-card ${templateId === 'blank' ? 'active' : ''}`}
                onClick={() => setTemplateId('blank')}
              >
                <div className="title-sm">Blank</div>
                <div className="muted tiny">Start from an empty page.</div>
              </button>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button
            className="accent"
            onClick={() =>
              onCreate({
                title: title.trim() || undefined,
                projectId: projectId || undefined,
                experimentId: experimentId || undefined,
                templateId,
              })
            }
          >
            Create entry
          </button>
        </div>
      </div>
    </div>
  )
}

function NewExperimentModal({
  onClose,
  projects,
  defaultProjectId,
  onCreateProject,
  onCreate,
}: {
  onClose: () => void
  projects: Project[]
  defaultProjectId: string
  onCreateProject: (title: string) => string
  onCreate: (val: { title: string; projectId: string; protocolRef?: string; defaultRawDataPath?: string }) => void
}) {
  const resolvedDefaultProjectId = projects.some((p) => p.id === defaultProjectId)
    ? defaultProjectId
    : (projects[0]?.id ?? '')

  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(resolvedDefaultProjectId)
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectTitle, setNewProjectTitle] = useState('')
  const [projectError, setProjectError] = useState<string | null>(null)
  const [protocolRef, setProtocolRef] = useState('')
  const [defaultRawDataPath, setDefaultRawDataPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const newProjectRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    window.setTimeout(() => titleRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleAddProject = () => {
    const cleaned = newProjectTitle.trim().replace(/\s+/g, ' ')
    if (!cleaned) {
      setProjectError('Project name is required.')
      return
    }
    try {
      const id = onCreateProject(cleaned)
      setProjectId(id)
      setCreatingProject(false)
      setNewProjectTitle('')
      setProjectError(null)
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Unable to create project.')
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="title-sm">New experiment</div>
            <div className="muted tiny">Create an experiment under a project.</div>
          </div>
          <button className="ghost" onClick={onClose} type="button">Close</button>
        </div>

        <div className="modal-grid">
          <label className="field">
            <span className="muted tiny">Title</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => {
                setError(null)
                setTitle(e.target.value)
              }}
              placeholder="e.g. Day 5 – imaging session"
            />
          </label>

          <label className="field">
            <span className="muted tiny">Project</span>
            {!creatingProject ? (
              <div className="field-row">
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setCreatingProject(true)
                    setProjectError(null)
                    setNewProjectTitle('')
                    window.setTimeout(() => newProjectRef.current?.focus(), 0)
                  }}
                >
                  + Project
                </button>
              </div>
            ) : (
              <div className="field-row">
                <input
                  ref={newProjectRef}
                  value={newProjectTitle}
                  onChange={(e) => {
                    setProjectError(null)
                    setNewProjectTitle(e.target.value)
                  }}
                  placeholder="New project name"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    handleAddProject()
                  }}
                />
                <button className="accent" type="button" onClick={handleAddProject}>
                  Add
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setCreatingProject(false)
                    setProjectError(null)
                    setNewProjectTitle('')
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            {projectError && <div className="field-error tiny">{projectError}</div>}
          </label>

          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="muted tiny">Protocol ref (optional)</span>
            <input
              value={protocolRef}
              onChange={(e) => setProtocolRef(e.target.value)}
              placeholder="e.g. PR-2025-12-IMAGING"
            />
          </label>

          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="muted tiny">Default raw data path (optional)</span>
            <input
              value={defaultRawDataPath}
              onChange={(e) => setDefaultRawDataPath(e.target.value)}
              placeholder="e.g. \\\\labserver\\project\\2025-12-17\\"
            />
            {error && <div className="field-error tiny">{error}</div>}
          </label>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Cancel</button>
          <button
            className="accent"
            type="button"
            onClick={() => {
              const cleaned = title.trim().replace(/\s+/g, ' ')
              if (!cleaned) {
                setError('Experiment title is required.')
                return
              }
              if (!projectId) {
                setError('Project is required.')
                return
              }
              onCreate({
                title: cleaned,
                projectId,
                protocolRef: protocolRef.trim() || undefined,
                defaultRawDataPath: defaultRawDataPath.trim() || undefined,
              })
            }}
          >
            Create experiment
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsModal({
  onClose,
  theme,
  onThemeChange,
  fsEnabled,
  fsNeedsPermission,
  fsSupported,
  onEnable,
  onPickDir,
  onDisconnect,
  onValidate,
}: {
  onClose: () => void
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
  fsEnabled: boolean
  fsNeedsPermission: boolean
  fsSupported: boolean
  onEnable: () => void
  onPickDir: () => void
  onDisconnect: () => void
  onValidate: () => Promise<{ ok: boolean; message?: string }>
}) {
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<{ ok: boolean; message?: string } | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const status = !fsSupported ? 'Unavailable' : fsEnabled ? 'Enabled' : fsNeedsPermission ? 'Needs permission' : 'Off'
  const badgeClass = fsEnabled ? 'success' : fsNeedsPermission ? 'warning' : 'warning'

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="title-sm">Settings</div>
            <div className="muted tiny">Storage and sync options (local-first).</div>
          </div>
          <button className="ghost" onClick={onClose} type="button">Close</button>
        </div>

        <div className="meta-card">
          <div className="settings-row">
            <div>
              <div className="title-sm">Disk cache</div>
              <div className="muted tiny">Keeps attachments on disk (Chrome/Edge desktop) with IndexedDB fallback.</div>
            </div>
            <div className={`status-chip ${badgeClass}`}>{status}</div>
          </div>

          {!fsSupported && (
            <div className="muted tiny" style={{ marginTop: 8 }}>
              File System Access API is not available in this browser. Attachments will use IndexedDB.
            </div>
          )}

          {fsSupported && (
            <div className="settings-actions" style={{ marginTop: 10 }}>
              {!fsEnabled && (
                <button className="ghost" type="button" onClick={onEnable}>
                  {fsNeedsPermission ? 'Grant permission' : 'Enable'}
                </button>
              )}
              <button className="ghost" type="button" onClick={onPickDir}>
                {fsEnabled ? 'Change folder' : 'Choose folder'}
              </button>
              <button className="ghost" type="button" onClick={onDisconnect}>
                Disconnect
              </button>
              <button
                className="accent"
                type="button"
                disabled={!fsEnabled || validating}
                onClick={async () => {
                  setValidating(true)
                  try {
                    const res = await onValidate()
                    setValidation(res)
                  } finally {
                    setValidating(false)
                  }
                }}
              >
                Validate write access
              </button>
            </div>
          )}

          {validation && (
            <div className="muted tiny" style={{ marginTop: 10, color: validation.ok ? 'var(--accent)' : 'var(--danger)' }}>
              {validation.ok ? 'Disk cache looks good.' : `Disk cache error: ${validation.message ?? 'Unknown error'}`}
            </div>
          )}
        </div>

        <div className="meta-card">
          <div className="settings-row">
            <div>
              <div className="title-sm">Appearance</div>
              <div className="muted tiny">Quiet neutral theme with a single accent.</div>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label className="field">
              <span className="muted tiny">Theme</span>
              <select value={theme} onChange={(e) => onThemeChange(e.target.value === 'dark' ? 'dark' : 'light')}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Done</button>
        </div>
      </div>
    </div>
  )
}
