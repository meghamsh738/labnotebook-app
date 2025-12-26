import type React from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createEditor, Editor, Element as SlateElement, Node, Path, Range, Text, Transforms } from 'slate'
import type { Descendant } from 'slate'
import { Slate, Editable, withReact, ReactEditor, useSlateStatic } from 'slate-react'
import type { RenderElementProps, RenderLeafProps } from 'slate-react'
import lunr from 'lunr'
import { cacheFile, getCachedFile } from './idb'
import { writeFileToCache, restoreCacheHandle, ensureCacheDir, pickCacheDir, clearCacheHandle } from './fileCache'
import './App.css'
import { sampleData, seedVersion } from './data/sampleData'
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

const SEED_VERSION_KEY = 'labnote.seedVersion'

const shouldResetSeed = () => {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(SEED_VERSION_KEY) !== seedVersion
  } catch (err) {
    console.warn('Unable to read seed version', err)
    return true
  }
}

type EntryTemplateId = 'guided' | 'blank'
type SyncStatus = 'pending' | 'synced' | 'failed'

const monthStartFromIso = (isoDate: string) => {
  const parts = isoDate.split('-')
  const year = Number(parts[0] ?? new Date().getFullYear())
  const month = Number(parts[1] ?? 1) - 1
  return new Date(year, Math.max(0, month), 1)
}

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

const LOCKED_TEMPLATE_SECTION_LABELS = new Set([
  'Context',
  'Setup',
  'Procedure',
  'Observations',
  'Next steps',
  'Summary',
  'Protocol',
  'Objective',
  'Aim',
  'Experiment',
  'Results',
])

const DEFAULT_PROJECT_TAGS = [
  'IL-17 WT KO aging project',
  'TNF dose + microglia activation',
  'Neuroimmune baseline',
]

const DEFAULT_EXPERIMENT_TAGS = [
  'FACS',
  'Immunofluorescence',
  'Genotyping',
  'Behaviour',
  'qPCR',
  'ELISA',
  'Sequencing',
]

const normalizeTag = (value: string) => value.trim().replace(/\s+/g, ' ')

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

  const contextHeadingId = newId('b-')
  const contextBodyId = newId('b-')
  const setupHeadingId = newId('b-')
  const setupChecklistId = newId('b-')
  const procedureHeadingId = newId('b-')
  const procedureBodyId = newId('b-')
  const observationsHeadingId = newId('b-')
  const observationsBodyId = newId('b-')
  const nextStepsHeadingId = newId('b-')
  const nextStepsBodyId = newId('b-')

  const content: Block[] = [
    { id: contextHeadingId, type: 'heading', level: 2, text: 'Context', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: contextBodyId,
      type: 'paragraph',
      text: 'What question are you answering today? Include model, conditions, and expected outcome.',
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: setupHeadingId, type: 'heading', level: 2, text: 'Setup', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: setupChecklistId,
      type: 'checklist',
      items: [
        { id: newId('ci-'), text: 'Sample IDs and groups confirmed', done: false },
        { id: newId('ci-'), text: 'Controls + blanks prepared', done: false },
        { id: newId('ci-'), text: 'Reagents + lot IDs logged', done: false },
      ],
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: procedureHeadingId, type: 'heading', level: 2, text: 'Procedure', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: procedureBodyId,
      type: 'paragraph',
      text: 'Step-by-step protocol. Note timing windows and any deviations from SOP.',
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: observationsHeadingId, type: 'heading', level: 2, text: 'Observations', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: observationsBodyId,
      type: 'paragraph',
      text: 'Record time-stamped observations, anomalies, and instrument readouts.',
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: nextStepsHeadingId, type: 'heading', level: 2, text: 'Next steps', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: nextStepsBodyId,
      type: 'paragraph',
      text: 'What happens next? Add follow-ups, analysis tasks, or handoff notes.',
      updatedAt: nowIso,
      updatedBy: 'me',
    },
  ]

  const pinnedRegions: PinnedRegion[] = [
    {
      id: newId('region-'),
      entryId,
      label: 'Context',
      blockIds: [contextHeadingId, contextBodyId],
      linkedAttachments: [],
    },
    {
      id: newId('region-'),
      entryId,
      label: 'Setup',
      blockIds: [setupHeadingId, setupChecklistId],
      linkedAttachments: [],
    },
    {
      id: newId('region-'),
      entryId,
      label: 'Procedure',
      blockIds: [procedureHeadingId, procedureBodyId],
      linkedAttachments: [],
    },
    {
      id: newId('region-'),
      entryId,
      label: 'Observations',
      blockIds: [observationsHeadingId, observationsBodyId],
      linkedAttachments: [],
    },
    {
      id: newId('region-'),
      entryId,
      label: 'Next steps',
      blockIds: [nextStepsHeadingId, nextStepsBodyId],
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

  const mdTable = (data: string[][], headerRow = true) => {
    if (!data.length) return ''
    const header = headerRow ? data[0] : data[0].map((_, idx) => `Col ${idx + 1}`)
    const body = headerRow ? data.slice(1) : data
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
        parts.push(mdTable(block.data, block.headerRow !== false))
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

  const renderTable = (data: string[][], headerRow = true) => {
    if (!data.length) return ''
    const header = headerRow ? data[0] : []
    const body = headerRow ? data.slice(1) : data
    const headHtml = headerRow
      ? `<thead><tr>${header.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
      : ''
    return `
      <table>
        ${headHtml}
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
          return `<div class="table-wrap">${renderTable(block.data, block.headerRow !== false)}${block.caption ? `<div class="caption">${esc(block.caption)}</div>` : ''}</div>`
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
const TableEditContext = createContext<{ isEditing: boolean } | null>(null)

function App() {
  const resetSeed = shouldResetSeed()
  const labStoragePath = sampleData.labs[0]?.storageConfig.path ?? ''
  const [projects, setProjects] = useState<Project[]>(() => {
    if (typeof window === 'undefined' || resetSeed) return sampleData.projects
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
    if (typeof window === 'undefined' || resetSeed) return sampleData.experiments
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
    if (typeof window === 'undefined' || resetSeed) {
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
  const todaySeed = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }, [])
  const initialCalendarSeed = todaySeed
  const todaysDailyEntry = useMemo(
    () => entryList.find((entry) => entry.isDaily && entry.dateBucket === todaySeed),
    [entryList, todaySeed]
  )
  const [selectedEntryId, setSelectedEntryId] = useState(
    sampleData.entries[0]?.id ?? ''
  )
  const [openEntryIds, setOpenEntryIds] = useState<string[]>(() =>
    sampleData.entries[0]?.id ? [sampleData.entries[0].id] : []
  )
  const openEntries = useMemo(
    () => openEntryIds.map((id) => entryDrafts[id]).filter(Boolean) as Entry[],
    [entryDrafts, openEntryIds]
  )
  const [newEntryOpen, setNewEntryOpen] = useState(false)
  const [newExperimentOpen, setNewExperimentOpen] = useState(false)
  const [startDayOpen, setStartDayOpen] = useState(true)
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedProjectTags, setSelectedProjectTags] = useState<string[]>([])
  const [selectedExperimentTags, setSelectedExperimentTags] = useState<string[]>([])
  const [selectedProject, setSelectedProject] = useState<string>('all')
  const [selectedExperiment, setSelectedExperiment] = useState<string>('all')
  const [projectTagOptions, setProjectTagOptions] = useState<string[]>(() => {
    if (typeof window === 'undefined' || resetSeed) return DEFAULT_PROJECT_TAGS
    try {
      const saved = window.localStorage.getItem('labnote.projectTags')
      if (saved) return JSON.parse(saved) as string[]
    } catch (err) {
      console.warn('Unable to read project tags', err)
    }
    return DEFAULT_PROJECT_TAGS
  })
  const [experimentTagOptions, setExperimentTagOptions] = useState<string[]>(() => {
    if (typeof window === 'undefined' || resetSeed) return DEFAULT_EXPERIMENT_TAGS
    try {
      const saved = window.localStorage.getItem('labnote.experimentTags')
      if (saved) return JSON.parse(saved) as string[]
    } catch (err) {
      console.warn('Unable to read experiment tags', err)
    }
    return DEFAULT_EXPERIMENT_TAGS
  })
  const [filterHasImage, setFilterHasImage] = useState(false)
  const [filterHasFile, setFilterHasFile] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(() => todaySeed)
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => monthStartFromIso(initialCalendarSeed))
  const [masterSyncPath, setMasterSyncPath] = useState<string>(() => {
    if (typeof window === 'undefined' || resetSeed) return labStoragePath
    try {
      const saved = window.localStorage.getItem('labnote.masterSyncPath')
      if (saved) return saved
    } catch (err) {
      console.warn('Unable to read master sync path', err)
    }
    return labStoragePath
  })
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})
  const [changeQueue, setChangeQueue] = useState<ChangeQueueItem[]>([])
  const [syncing, setSyncing] = useState(false)
  const [fsEnabled, setFsEnabled] = useState(false)
  const [fsNeedsPermission, setFsNeedsPermission] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    if (!selectedEntryId) return
    setOpenEntryIds((prev) => (prev.includes(selectedEntryId) ? prev : [selectedEntryId, ...prev].slice(0, 5)))
  }, [selectedEntryId])

  const addProjectTagOption = useCallback((value: string) => {
    const cleaned = normalizeTag(value)
    if (!cleaned) return
    setProjectTagOptions((prev) => (prev.includes(cleaned) ? prev : [...prev, cleaned]))
  }, [])

  const addExperimentTagOption = useCallback((value: string) => {
    const cleaned = normalizeTag(value)
    if (!cleaned) return
    setExperimentTagOptions((prev) => (prev.includes(cleaned) ? prev : [...prev, cleaned]))
  }, [])

  const handleCloseEntryTab = useCallback(
    (entryId: string) => {
      setOpenEntryIds((prev) => {
        if (prev.length <= 1) return prev
        const next = prev.filter((id) => id !== entryId)
        if (selectedEntryId === entryId) {
          setSelectedEntryId(next[0] ?? '')
        }
        return next
      })
    },
    [selectedEntryId]
  )

  const dismissStartDay = useCallback(() => {
    setStartDayOpen(false)
  }, [])
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
    if (typeof window === 'undefined') return
    if (resetSeed) {
      try {
        window.localStorage.removeItem('labnote.entries')
        window.localStorage.removeItem('labnote.attachments')
        window.localStorage.removeItem('labnote.projects')
        window.localStorage.removeItem('labnote.experiments')
        window.localStorage.removeItem('labnote.projectTags')
        window.localStorage.removeItem('labnote.experimentTags')
        window.localStorage.removeItem('labnote.masterSyncPath')
      } catch (err) {
        console.warn('Unable to clear stored seed data', err)
      }
    }
    try {
      window.localStorage.setItem(SEED_VERSION_KEY, seedVersion)
    } catch (err) {
      console.warn('Unable to persist seed version', err)
    }
  }, [resetSeed])

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
        window.localStorage.setItem('labnote.projectTags', JSON.stringify(projectTagOptions))
      } catch (err) {
        console.warn('Unable to cache project tags', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [projectTagOptions])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem('labnote.experimentTags', JSON.stringify(experimentTagOptions))
      } catch (err) {
        console.warn('Unable to cache experiment tags', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [experimentTagOptions])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem('labnote.masterSyncPath', masterSyncPath)
      } catch (err) {
        console.warn('Unable to cache master sync path', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [masterSyncPath])

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

  const handleSelectDate = useCallback((date: string | null) => {
    setSelectedDate(date)
    if (!date) return
    setCalendarMonth(monthStartFromIso(date))
  }, [])

  const handleCreateEntry = useCallback(
    (opts: {
      title?: string
      projectId?: string
      experimentId?: string
      templateId: EntryTemplateId
      quickCapture?: boolean
      projectTags?: string[]
      experimentTags?: string[]
      isDaily?: boolean
    }) => {
      const now = new Date()
      const nowIso = now.toISOString()
      const dateBucket = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const existingDaily = entryList.find((entry) => entry.isDaily && entry.dateBucket === dateBucket)

      if ((opts.quickCapture || opts.isDaily) && existingDaily) {
        setSelectedEntryId(existingDaily.id)
        setQuery('')
        handleSelectDate(dateBucket)
        setSelectedProjectTags([])
        setSelectedExperimentTags([])
        setAutoEditEntryId(existingDaily.id)
        return
      }

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
        isDaily: opts.isDaily ?? opts.quickCapture ?? false,
        content,
        tags: [],
        projectTags: opts.projectTags ?? [],
        experimentTags: opts.experimentTags ?? [],
        searchTerms: [],
        linkedFiles: [],
        pinnedRegions,
      }

      setEntryDrafts((prev) => ({ ...prev, [entryId]: entry }))
      setSelectedEntryId(entryId)
      setQuery('')
      handleSelectDate(dateBucket)
      setSelectedProjectTags([])
      setSelectedExperimentTags([])
      setAutoEditEntryId(entryId)
      setNewEntryOpen(false)
    },
    [entryList, handleSelectDate, selectedProject]
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

  useEffect(() => {
    if (syncing) return
    if (!changeQueue.some((c) => c.status === 'pending')) return
    const id = window.setTimeout(() => {
      void syncNow({ includeFailed: false })
    }, 900)
    return () => window.clearTimeout(id)
  }, [changeQueue, syncNow, syncing])
  const [attachmentsStore, setAttachmentsStore] = useState<Attachment[]>(() => {
    if (typeof window === 'undefined' || resetSeed) return sampleData.attachments
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
            }
          } catch (err) {
	            console.warn('Unable to load cached file', att.id, err)
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
	              if (att.thumbnail) urlMap[att.id] = att.thumbnail
	            }
	          } else {
	            if (att.thumbnail) urlMap[att.id] = att.thumbnail
	          }
	        } else if (att.thumbnail) {
	          urlMap[att.id] = att.thumbnail
	        }
	      }
      if (!cancelled) {
        setAttachmentUrls(urlMap)
      }
    }
    load()
    return () => {
      cancelled = true
      Object.values(attachmentUrls).forEach((url) => URL.revokeObjectURL(url))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentsStore])

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
          projectTags: e.projectTags ?? [],
          experimentTags: e.experimentTags ?? [],
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
            (e.tags.length || (e.projectTags?.length ?? 0) || (e.experimentTags?.length ?? 0))
              ? `- Tags: ${[...e.tags, ...(e.projectTags ?? []), ...(e.experimentTags ?? [])].join(', ')}`
              : '',
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
          const combinedTags = [
            ...entry.tags,
            ...(entry.projectTags ?? []),
            ...(entry.experimentTags ?? []),
          ]
	        const doc = {
	          id: entry.id,
	          title: entry.title,
	          tags: combinedTags.join(' '),
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
    return entryList.filter((entry) => {
      if (selectedProject !== 'all' && entry.projectId !== selectedProject) return false
      if (selectedExperiment === 'none') {
        if (entry.experimentId) return false
      } else if (selectedExperiment !== 'all' && entry.experimentId !== selectedExperiment) {
        return false
      }
      if (selectedProjectTags.length) {
        const entryProjectTags = entry.projectTags ?? []
        if (!selectedProjectTags.every((t) => entryProjectTags.includes(t))) return false
      }
      if (selectedExperimentTags.length) {
        const entryExperimentTags = entry.experimentTags ?? []
        if (!selectedExperimentTags.every((t) => entryExperimentTags.includes(t))) return false
      }
      if (filterHasImage) {
        const hasImage = attachmentsForEntry(entry.id).some((a) => a.type === 'image')
        if (!hasImage) return false
      }
      if (filterHasFile) {
        const hasFile = attachmentsForEntry(entry.id).some((a) => a.type === 'file' || a.type === 'raw' || a.type === 'pdf')
        if (!hasFile) return false
      }

      if (selectedDate && entry.dateBucket !== selectedDate) return false

      if (!q) return matchedIds.includes(entry.id)
      return matchedIds.includes(entry.id)
    })
  }, [
    query,
    selectedProject,
    selectedExperiment,
    selectedProjectTags,
    selectedExperimentTags,
    filterHasImage,
    filterHasFile,
    matchedIds,
    selectedDate,
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
    if (filteredEntries.length === 0) {
      if (selectedEntryId) setSelectedEntryId('')
      return
    }
    const stillVisible = filteredEntries.some((e) => e.id === selectedEntryId)
    if (!stillVisible) {
      setSelectedEntryId(filteredEntries[0].id)
    }
  }, [filteredEntries, selectedEntryId])

  return (
    <div className="app-bg">
      <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
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
          selectedProjectTags={selectedProjectTags}
          selectedExperimentTags={selectedExperimentTags}
          projectTagOptions={projectTagOptions}
          experimentTagOptions={experimentTagOptions}
          onToggleProjectTag={(tag) =>
            setSelectedProjectTags((prev) =>
              prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
            )
          }
          onToggleExperimentTag={(tag) =>
            setSelectedExperimentTags((prev) =>
              prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
            )
          }
          filterHasImage={filterHasImage}
          filterHasFile={filterHasFile}
          onToggleHasImage={() => setFilterHasImage((v) => !v)}
          onToggleHasFile={() => setFilterHasFile((v) => !v)}
          onSelectEntry={setSelectedEntryId}
          onNewEntry={() => setNewEntryOpen(true)}
          onNewExperiment={() => setNewExperimentOpen(true)}
          onQuickCapture={() => handleCreateEntry({ templateId: 'guided', quickCapture: true, isDaily: true })}
          onOpenSettings={() => setSettingsOpen(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
          selectedDate={selectedDate}
          onSelectDate={handleSelectDate}
          calendarMonth={calendarMonth}
          onCalendarMonthChange={setCalendarMonth}
        />
        <EditorPane
          entry={entry}
          project={project}
          experiment={experiment}
          openEntries={openEntries}
          selectedEntryId={selectedEntryId}
          onSelectEntry={setSelectedEntryId}
          onCloseEntryTab={handleCloseEntryTab}
          projectTagOptions={projectTagOptions}
          experimentTagOptions={experimentTagOptions}
          onAddProjectTagOption={addProjectTagOption}
          onAddExperimentTagOption={addExperimentTagOption}
          masterSyncPath={masterSyncPath}
          onUpdateMasterSyncPath={setMasterSyncPath}
          labStoragePath={labStoragePath}
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
          onUpdateEntryMeta={(entryId, updates) =>
            setEntryDrafts((prev) => {
              const current = prev[entryId]
              if (!current) return prev
              return {
                ...prev,
                [entryId]: {
                  ...current,
                  ...updates,
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
          onSyncNow={(includeFailed) => syncNow({ entryId: selectedEntryId, includeFailed })}
          autoEditEntryId={autoEditEntryId}
          onConsumeAutoEdit={() => setAutoEditEntryId(null)}
          onExportExperiment={exportExperiment}
        />
      </div>
      {newEntryOpen && (
        <NewEntryModal
          onClose={() => setNewEntryOpen(false)}
          projects={projects}
          experiments={experiments}
          defaultProjectId={defaultProjectIdForNewEntry}
          defaultExperimentId={selectedExperiment !== 'all' && selectedExperiment !== 'none' ? selectedExperiment : ''}
          projectTagOptions={projectTagOptions}
          experimentTagOptions={experimentTagOptions}
          onAddProjectTag={addProjectTagOption}
          onAddExperimentTag={addExperimentTagOption}
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
          masterSyncPath={masterSyncPath}
          onMasterSyncPathChange={setMasterSyncPath}
          labStoragePath={labStoragePath}
          fsEnabled={fsEnabled}
          fsNeedsPermission={fsNeedsPermission}
          fsSupported={typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === 'function'}
          onEnable={handlePromptFs}
          onPickDir={handlePickCacheDir}
          onDisconnect={handleDisconnectCacheDir}
          onValidate={validateDiskCache}
        />
      )}
      {startDayOpen && (
        <StartDayModal
          onClose={dismissStartDay}
          onCreate={(val) => {
            handleCreateEntry({
              ...val,
              templateId: 'guided',
              isDaily: true,
            })
            dismissStartDay()
          }}
          onOpenExisting={() => {
            if (!todaysDailyEntry) {
              handleCreateEntry({ templateId: 'guided', isDaily: true })
              dismissStartDay()
              return
            }
            setSelectedEntryId(todaysDailyEntry.id)
            setQuery('')
            handleSelectDate(todaySeed)
            setSelectedProjectTags([])
            setSelectedExperimentTags([])
            setAutoEditEntryId(todaysDailyEntry.id)
            dismissStartDay()
          }}
          projects={projects}
          experiments={experiments}
          defaultProjectId={defaultProjectIdForNewEntry}
          projectTagOptions={projectTagOptions}
          experimentTagOptions={experimentTagOptions}
          onAddProjectTag={addProjectTagOption}
          onAddExperimentTag={addExperimentTagOption}
          todayBucket={todaySeed}
          hasExisting={!!todaysDailyEntry}
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
  selectedProjectTags: string[]
  selectedExperimentTags: string[]
  projectTagOptions: string[]
  experimentTagOptions: string[]
  onToggleProjectTag: (tag: string) => void
  onToggleExperimentTag: (tag: string) => void
  filterHasImage: boolean
  filterHasFile: boolean
  onToggleHasImage: () => void
  onToggleHasFile: () => void
  onSelectEntry: (id: string) => void
  onNewEntry: () => void
  onNewExperiment: () => void
  onQuickCapture: () => void
  onOpenSettings: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
  calendarMonth: Date
  onCalendarMonthChange: (next: Date) => void
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
  selectedProjectTags,
  selectedExperimentTags,
  projectTagOptions,
  experimentTagOptions,
  onToggleProjectTag,
  onToggleExperimentTag,
  filterHasImage,
  filterHasFile,
  onToggleHasImage,
  onToggleHasFile,
  onSelectEntry,
  onNewEntry,
  onNewExperiment,
  onQuickCapture,
  onOpenSettings,
  collapsed,
  onToggleCollapsed,
  selectedDate,
  onSelectDate,
  calendarMonth,
  onCalendarMonthChange,
}: SidebarProps) {
  const activeLab = labs[0]
  const visibleExperiments = useMemo(() => {
    if (selectedProject === 'all') return experiments
    return experiments.filter((ex) => ex.projectId === selectedProject)
  }, [experiments, selectedProject])
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const calendarLabel = useMemo(() => {
    return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(calendarMonth)
  }, [calendarMonth])

  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear()
    const month = calendarMonth.getMonth()
    const firstDay = new Date(year, month, 1)
    const startIndex = (firstDay.getDay() + 6) % 7
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const prevMonthDays = new Date(year, month, 0).getDate()

    return Array.from({ length: 42 }, (_, index) => {
      const dayNum = index - startIndex + 1
      let day = dayNum
      let isOutside = false
      let date: Date

      if (dayNum < 1) {
        isOutside = true
        day = prevMonthDays + dayNum
        date = new Date(year, month - 1, day)
      } else if (dayNum > daysInMonth) {
        isOutside = true
        day = dayNum - daysInMonth
        date = new Date(year, month + 1, day)
      } else {
        date = new Date(year, month, dayNum)
      }

      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      return { day, iso, isOutside }
    })
  }, [calendarMonth])

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

  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  return (
    <aside className={`panel sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-toggle-row">
        <button
          className="pill soft sidebar-toggle"
          type="button"
          onClick={onToggleCollapsed}
          data-testid="sidebar-toggle"
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show panel' : 'Hide panel'}
        </button>
      </div>

      {!collapsed && (
        <div className="sidebar-content">
          <div className="lab-head">
            <div>
              <p className="eyebrow">Lab</p>
              <h2>{activeLab?.name ?? 'Lab'}</h2>
              <p className="muted">Storage: {activeLab?.storageConfig.path}</p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="status-chip success">Sync ready</div>
              <button className="pill soft" onClick={onOpenSettings} type="button">
                <span className="icon">⚙</span>
                Settings
              </button>
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
            <button className="ghost" onClick={onNewEntry}>
              <span className="icon">✚</span>
              New Entry
            </button>
            <button className="ghost" onClick={onNewExperiment}>
              <span className="icon">🧪</span>
              New Experiment
            </button>
            <button className="accent" onClick={onQuickCapture} data-testid="quick-capture">
              <span className="icon">⚡</span>
              Quick Capture
            </button>
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
            <div className="section-title">Calendar</div>
            <div className="calendar" data-testid="calendar">
              <div className="calendar-header">
                <div className="calendar-month">{calendarLabel}</div>
                <div className="calendar-nav">
                  <button
                    type="button"
                    aria-label="Previous month"
                    onClick={() =>
                      onCalendarMonthChange(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))
                    }
                  >
                    ^
                  </button>
                  <button
                    type="button"
                    aria-label="Next month"
                    onClick={() =>
                      onCalendarMonthChange(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))
                    }
                  >
                    v
                  </button>
                </div>
              </div>
              <div className="calendar-meta">
                <span>{selectedDate ? `Selected: ${selectedDate}` : 'All dates'}</span>
                {selectedDate && (
                  <button
                    type="button"
                    className="calendar-clear"
                    onClick={() => onSelectDate(null)}
                    data-testid="calendar-clear"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="calendar-weekdays">
                {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((day) => (
                  <div key={day}>{day}</div>
                ))}
              </div>
              <div className="calendar-grid">
                {calendarDays.map((day) => {
                  const isSelected = selectedDate === day.iso
                  const isToday = todayIso === day.iso
                  return (
                    <button
                      key={day.iso}
                      type="button"
                      className={`calendar-day${day.isOutside ? ' outside' : ''}${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}`}
                      onClick={() => {
                        if (isSelected) {
                          onSelectDate(null)
                          return
                        }
                        onSelectDate(day.iso)
                      }}
                      aria-pressed={isSelected}
                      aria-label={`${day.day} ${calendarLabel}`}
                      data-testid={`calendar-day-${day.iso}`}
                    >
                      {day.day}
                    </button>
                  )
                })}
              </div>
            </div>
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
                  {e.experimentTags?.[0] ? (
                    <div className="pill ghost-pill">{e.experimentTags[0]}</div>
                  ) : e.projectTags?.[0] ? (
                    <div className="pill ghost-pill">{e.projectTags[0]}</div>
                  ) : e.tags[0] ? (
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
              <div className="section-title">Project tags</div>
              <div className="chip-row">
                {projectTagOptions.map((tag) => (
                  <button
                    key={tag}
                    className={`pill soft ${selectedProjectTags.includes(tag) ? 'active-pill' : ''}`}
                    onClick={() => onToggleProjectTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="section-title">Experiment tags</div>
              <div className="chip-row">
                {experimentTagOptions.map((tag) => (
                  <button
                    key={tag}
                    className={`pill soft ${selectedExperimentTags.includes(tag) ? 'active-pill' : ''}`}
                    onClick={() => onToggleExperimentTag(tag)}
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
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}

interface EditorPaneProps {
  entry?: Entry
  project?: Project
  experiment?: Experiment
  openEntries: Entry[]
  selectedEntryId: string
  onSelectEntry: (id: string) => void
  onCloseEntryTab: (id: string) => void
  projectTagOptions: string[]
  experimentTagOptions: string[]
  onAddProjectTagOption: (value: string) => void
  onAddExperimentTagOption: (value: string) => void
  masterSyncPath: string
  onUpdateMasterSyncPath: (value: string) => void
  labStoragePath: string
  attachments: Attachment[]
  attachmentUrls: Record<string, string>
  onUpdateEntry: (entryId: string, content: Block[]) => void
  onUpdateEntryMeta: (entryId: string, updates: Partial<Entry>) => void
  onAddAttachments: (entryId: string, files: File[]) => Promise<Attachment[]>
  onAddFileDestination: (entryId: string, val: { path: string; label?: string }) => Attachment
  onEnqueueChange: (entryId: string, blockIds: string[], timestamp: string) => void
  changeQueue: ChangeQueueItem[]
  syncing: boolean
  onSyncNow: (includeFailed: boolean) => void
  autoEditEntryId: string | null
  onConsumeAutoEdit: () => void
  onExportExperiment: (experimentId: string, format: 'markdown' | 'pdf') => Promise<void>
}

function EditorPane({
  entry,
  project,
  experiment,
  openEntries,
  selectedEntryId,
  onSelectEntry,
  onCloseEntryTab,
  projectTagOptions,
  experimentTagOptions,
  onAddProjectTagOption,
  onAddExperimentTagOption,
  masterSyncPath,
  onUpdateMasterSyncPath,
  labStoragePath,
  attachments,
  attachmentUrls,
  onUpdateEntry,
  onUpdateEntryMeta,
  onAddAttachments,
  onAddFileDestination,
  onEnqueueChange,
  changeQueue,
  syncing,
  onSyncNow,
  autoEditEntryId,
  onConsumeAutoEdit,
  onExportExperiment,
}: EditorPaneProps) {
  const [exporting, setExporting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [activeTab, setActiveTab] = useState<'note' | 'files' | 'details'>('note')
  const [editor] = useState(() => withChecklists(withReact(createEditor() as ReactEditor)))
  const [editorValue, setEditorValue] = useState<Descendant[]>(
    () => blocksToSlate(entry?.content ?? [{ id: 'b-empty', type: 'paragraph', text: '' }])
  )
  const focusEditor = useCallback(() => {
    try {
      const start = Editor.start(editor, [])
      Transforms.select(editor, start)
      ReactEditor.focus(editor)
    } catch (err) {
      console.warn('Unable to focus editor', err)
    }
  }, [editor])

  useEffect(() => {
    if (!entry) return
    setIsEditing(false)
    setEditorValue(blocksToSlate(entry.content))
    setActiveTab('note')
  }, [entry])

  useEffect(() => {
    if (!entry) return
    if (autoEditEntryId && entry.id === autoEditEntryId) {
      setIsEditing(true)
      window.requestAnimationFrame(() => focusEditor())
      onConsumeAutoEdit()
    }
  }, [autoEditEntryId, entry, focusEditor, onConsumeAutoEdit])

  useEffect(() => {
    if (!isEditing) return
    window.requestAnimationFrame(() => focusEditor())
  }, [focusEditor, isEditing])

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
          {openEntries.length > 1 && (
            <div className="entry-tabs" role="tablist" aria-label="Open entries">
              {openEntries.map((tab) => (
                <div key={tab.id} className={`entry-tab ${selectedEntryId === tab.id ? 'active' : ''}`}>
                  <button
                    type="button"
                    className="entry-tab-main"
                    role="tab"
                    aria-selected={selectedEntryId === tab.id}
                    onClick={() => onSelectEntry(tab.id)}
                  >
                    <span className="tab-title">{tab.title}</span>
                    <span className="tab-date">{tab.dateBucket}</span>
                  </button>
                  <button
                    type="button"
                    className="entry-tab-close"
                    onClick={() => onCloseEntryTab(tab.id)}
                    aria-label={`Close ${tab.title}`}
                    disabled={openEntries.length <= 1}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="breadcrumb-row">
            <div className="breadcrumbs">
              <span>{project?.title ?? 'Project'}</span>
              <span>/</span>
              <span>{experiment?.title ?? 'General note'}</span>
              <span className="pill soft">{entry.dateBucket}</span>
              <span className={`status-chip ${syncing || hasWork ? 'warning' : 'success'}`}>
                {syncing ? 'Syncing…' : failedCount ? `${failedCount} failed` : pendingCount ? `${pendingCount} pending` : 'Synced'}
              </span>
            </div>

            <div className="editor-actions">
              {(pendingCount > 0 || failedCount > 0) && (
                <button
                  className="ghost icon-btn"
                  type="button"
                  data-testid="sync-action"
                  onClick={() => onSyncNow(failedCount > 0)}
                  disabled={syncing}
                >
                  <span className="icon">⟳</span>
                  {failedCount > 0 ? 'Retry failed' : 'Sync now'}
                </button>
              )}
              {experiment ? (
                <>
                  <button
                    className="ghost icon-btn"
                    disabled={exporting}
                    data-testid="export-pdf"
                    onClick={async () => {
                      setExporting(true)
                      try {
                        await onExportExperiment(experiment.id, 'pdf')
                      } finally {
                        setExporting(false)
                      }
                    }}
                  >
                    <span className="icon">⬇</span>
                    Export PDF
                  </button>
                  <button
                    className="ghost icon-btn"
                    disabled={exporting}
                    data-testid="export-md"
                    onClick={async () => {
                      setExporting(true)
                      try {
                        await onExportExperiment(experiment.id, 'markdown')
                      } finally {
                        setExporting(false)
                      }
                    }}
                  >
                    <span className="icon">⬇</span>
                    Export MD
                  </button>
                </>
              ) : (
                <button className="ghost icon-btn" disabled title="Attach this note to an experiment to export a bundle.">
                  <span className="icon">⬇</span>
                  Export PDF
                </button>
              )}
              {!isEditing ? (
                <button className="accent icon-btn" onClick={() => setIsEditing(true)}>
                  <span className="icon">✎</span>
                  Edit
                </button>
              ) : (
                <div className="edit-actions">
                  <button className="ghost icon-btn" onClick={() => setIsEditing(false)}>
                    <span className="icon">✕</span>
                    Cancel
                  </button>
                  <button className="accent icon-btn" onClick={handleSave}>
                    <span className="icon">✓</span>
                    Save
                  </button>
                </div>
              )}
            </div>
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
          <div className="tag-row">
            {(entry.projectTags ?? []).map((tag) => (
              <span key={`project-${tag}`} className="pill soft">#{tag}</span>
            ))}
            {(entry.experimentTags ?? []).map((tag) => (
              <span key={`experiment-${tag}`} className="pill ghost-pill">#{tag}</span>
            ))}
            {!entry.projectTags?.length && !entry.experimentTags?.length && (
              <span className="muted tiny">No tags yet.</span>
            )}
          </div>
          <div className="editor-tabs" role="tablist">
            <button
              type="button"
              className={`tab-button ${activeTab === 'note' ? 'active' : ''}`}
              onClick={() => setActiveTab('note')}
              role="tab"
              aria-selected={activeTab === 'note'}
            >
              <span className="icon">✍</span>
              Note
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'files' ? 'active' : ''}`}
              onClick={() => setActiveTab('files')}
              role="tab"
              aria-selected={activeTab === 'files'}
            >
              <span className="icon">📁</span>
              Files
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'details' ? 'active' : ''}`}
              onClick={() => setActiveTab('details')}
              role="tab"
              aria-selected={activeTab === 'details'}
            >
              <span className="icon">🏷</span>
              Details
            </button>
          </div>
          {isEditing && activeTab === 'note' && (
            <div className="editor-toolbar-dock">
              <EditorInsertBar
                editor={editor}
                entryId={entry.id}
                onAddAttachments={onAddAttachments}
                onAddFileDestination={onAddFileDestination}
                onShowTags={() => setActiveTab('details')}
              />
            </div>
          )}
        </div>
      </div>

      {activeTab === 'note' && !isEditing && (
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

      {activeTab === 'note' && isEditing && (
        <>
          <div className="editor-surface">
            <EditorAttachmentContext.Provider value={{ attachmentsById: attachmentMap, attachmentUrls }}>
              <TableEditContext.Provider value={{ isEditing }}>
                <Slate
                  key={entry.id}
                  editor={editor}
                  initialValue={editorValue}
                  onChange={setEditorValue}
                >
                  <Editable
                    renderElement={renderElement}
                    renderLeaf={renderLeaf}
                    className="slate-editor"
                    placeholder="Type your lab note..."
                    data-testid="slate-editor"
                    onPaste={(event) => {
                      const text = event.clipboardData.getData('text/plain')
                      if (!text) return
                      const table = parseTableFromClipboard(text)
                      if (!table) return
                      event.preventDefault()
                      insertTableBlock(editor, table)
                    }}
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
              </TableEditContext.Provider>
            </EditorAttachmentContext.Provider>
            <div className="muted tiny">
              Tip: use the insert bar above; drag/drop or paste files into the editor.
            </div>
          </div>
        </>
      )}

      {activeTab === 'files' && (
        <div className="tab-panel">
          <div className="panel-card">
            <div className="section-title">Master sync folder</div>
            <label className="field">
              <span className="muted tiny">Default for all entries (can be local or cloud)</span>
              <div className="field-row">
                <input
                  value={masterSyncPath}
                  onChange={(e) => onUpdateMasterSyncPath(e.target.value)}
                  placeholder="e.g. D:\\lab-notes\\sync or https://drive.company.com/lab"
                />
                {labStoragePath && (
                  <button className="ghost" type="button" onClick={() => onUpdateMasterSyncPath(labStoragePath)}>
                    Use lab storage
                  </button>
                )}
              </div>
            </label>
            <div className="muted tiny">All entries sync to this folder.</div>
          </div>

          <div className="panel-card">
            <div className="section-title">Files</div>
            {attachments.length === 0 && <div className="muted tiny">No files linked.</div>}
            {attachments.length > 0 && (
              <div className="attachment-list">
                {attachments.map((file) => (
                  <div key={file.id} className="attachment-row">
                    <div className="attachment-icon">📎</div>
                    <div className="attachment-body">
                      <div className="title-sm">{file.filename}</div>
                      <div className="muted tiny">{file.storagePath}</div>
                    </div>
                    <span className="pill soft">{file.type.toUpperCase()}</span>
                    <span className="pill soft">{file.filesize}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'details' && (
        <div className="tab-panel">
          <div className="panel-card">
            <div className="section-title">Entry tags</div>
            <TagPicker
              label="Project tags"
              options={projectTagOptions}
              selected={entry.projectTags ?? []}
              onToggle={(tag) => {
                const next = new Set(entry.projectTags ?? [])
                if (next.has(tag)) next.delete(tag)
                else next.add(tag)
                onUpdateEntryMeta(entry.id, { projectTags: Array.from(next) })
              }}
              onAdd={onAddProjectTagOption}
            />
            <TagPicker
              label="Experiment tags"
              options={experimentTagOptions}
              selected={entry.experimentTags ?? []}
              onToggle={(tag) => {
                const next = new Set(entry.experimentTags ?? [])
                if (next.has(tag)) next.delete(tag)
                else next.add(tag)
                onUpdateEntryMeta(entry.id, { experimentTags: Array.from(next) })
              }}
              onAdd={onAddExperimentTagOption}
            />
          </div>

          <div className="panel-card">
            <div className="section-title">Assignment</div>
            <div className="muted tiny">Project: {project?.title ?? '—'}</div>
            <div className="muted tiny">Experiment: {experiment?.title ?? '—'}</div>
          </div>

          <div className="panel-card">
            <div className="section-title">Sync queue</div>
            <div className="muted tiny" style={{ marginBottom: 6 }}>
              {syncing
                ? 'Syncing changes…'
                : failedCount
                  ? `${failedCount} failed`
                  : pendingCount
                    ? `${pendingCount} pending`
                    : 'All synced.'}
            </div>
            {(pendingCount > 0 || failedCount > 0) && (
              <button
                className="ghost icon-btn"
                type="button"
                onClick={() => onSyncNow(failedCount > 0)}
                disabled={syncing}
              >
                <span className="icon">⟳</span>
                {failedCount > 0 ? 'Retry failed' : 'Sync now'}
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  )
}

interface BlockRendererProps {
  block: Block
  attachments: Record<string, Attachment>
  attachmentUrls: Record<string, string>
  onUpdateBlock?: (block: Block) => void
}

type MarkFormat = 'bold' | 'italic' | 'underline'
type TextAlign = 'left' | 'center' | 'right' | 'justify'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBlock(value: unknown): value is Block {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.type === 'string'
}

function isTextAlignValue(value: unknown): value is TextAlign {
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify'
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
    case 'table': {
      return <TableElement {...props} />
    }
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

function parseTableFromClipboard(text: string): string[][] | null {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((row) => row.split('\t'))
    .filter((row) => row.length > 0)
  const hasTable = rows.some((row) => row.length > 1)
  if (!hasTable || rows.length === 0) return null
  return rows
}

function insertTableBlock(editor: ReactEditor, data: string[][]) {
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]
  const blockId = newId('b-')
  const block: Block = { id: blockId, type: 'table', data, headerRow: true }
  const tableNode: Descendant = { type: 'table', blockId, meta: block, children: [{ text: '' }] }
  const paragraphNode: Descendant = { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] }
  Transforms.insertNodes(editor, [tableNode, paragraphNode], { at: insertAt })
  const paragraphPath = Path.next(insertAt)
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
  editor,
  entryId,
  onAddAttachments,
  onAddFileDestination,
  onShowTags,
}: {
  editor: ReactEditor
  entryId: string
  onAddAttachments: (entryId: string, files: File[]) => Promise<Attachment[]>
  onAddFileDestination: (entryId: string, val: { path: string; label?: string }) => Attachment
  onShowTags?: () => void
}) {
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
          {onShowTags && (
            <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={onShowTags}>
              + Tags
            </button>
          )}
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSection(editor, 'Context')}>
            + Context
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSectionWithChecklist(editor, 'Setup')}>
            + Setup
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSection(editor, 'Observations')}>
            + Observations
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => imgRef.current?.click()}>
            + Image
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertTableBlock(editor, [['Sample', 'Value']])}>
            + Table
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

function TableElement({ element, attributes, children }: RenderElementProps) {
  const editor = useSlateStatic()
  const tableCtx = useContext(TableEditContext)
  const isEditing = tableCtx?.isEditing ?? false
  const meta = isBlock(element.meta) && element.meta.type === 'table' ? element.meta : undefined
  const data = Array.isArray(meta?.data) && meta.data.length > 0 ? meta.data : [['']]
  const headerRow = meta?.headerRow !== false
  const path = ReactEditor.findPath(editor, element)

  const updateTable = (nextData: string[][], nextHeader = headerRow) => {
    const blockId =
      typeof element.blockId === 'string'
        ? element.blockId
        : typeof meta?.id === 'string'
          ? meta.id
          : newId('b-')
    const nextMeta: Block = { id: blockId, type: 'table', data: nextData, headerRow: nextHeader }
    Transforms.setNodes(editor, { meta: nextMeta }, { at: path })
  }

  const addRow = () => {
    const columns = Math.max(1, ...data.map((row) => row.length))
    updateTable([...data, Array.from({ length: columns }, () => '')])
  }

  const addColumn = () => {
    updateTable(data.map((row) => [...row, '']))
  }

  const toggleHeader = () => {
    updateTable(data, !headerRow)
  }

  return (
    <div {...attributes} contentEditable={false} className="readonly-block table-block">
      {isEditing && (
        <div className="table-toolbar">
          <button className="pill soft" type="button" onClick={addRow}>
            + Row
          </button>
          <button className="pill soft" type="button" onClick={addColumn}>
            + Column
          </button>
          <button className="pill soft" type="button" onClick={toggleHeader}>
            {headerRow ? 'Header on' : 'Header off'}
          </button>
        </div>
      )}
      <div className="table-editor">
        <table>
          <tbody>
            {data.map((row, rIdx) => (
              <tr key={`${meta?.id ?? 'row'}-${rIdx}`} className={headerRow && rIdx === 0 ? 'header-row' : ''}>
                {row.map((cell, cIdx) => (
                  <td key={`${meta?.id ?? 'cell'}-${rIdx}-${cIdx}`} className={headerRow && rIdx === 0 ? 'th' : ''}>
                    <input
                      value={cell}
                      disabled={!isEditing}
                      onChange={(e) => {
                        const next = data.map((rowData, rowIndex) =>
                          rowIndex === rIdx
                            ? rowData.map((val, colIndex) => (colIndex === cIdx ? e.target.value : val))
                            : rowData
                        )
                        updateTable(next)
                      }}
                      placeholder={headerRow && rIdx === 0 ? 'Header' : 'Value'}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
      case 'table':
        return {
          type: 'table',
          blockId: block.id,
          meta: { ...block, headerRow: block.headerRow !== false },
          children: [{ text: '' }],
        }
      case 'image':
      case 'file':
        return { type: 'attachment', blockId: block.id, meta: block, children: [{ text: '' }] }
      default:
        return { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] }
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
      case 'table': {
        const meta = isBlock(node.meta) && node.meta.type === 'table' ? node.meta : undefined
        const data = Array.isArray(meta?.data) ? meta.data : []
        return {
          id: ensureId(blockId ?? (typeof meta?.id === 'string' ? meta.id : undefined)),
          type: 'table',
          data,
          headerRow: meta?.headerRow !== false,
        }
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
    case 'table': {
      const headerRow = block.headerRow !== false
      return (
        <div className="table-wrap">
          <table>
            <tbody>
              {block.data.map((row, idx) => (
                <tr key={idx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className={headerRow && idx === 0 ? 'th' : ''}>
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
    }
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

function TagPicker({
  label,
  options,
  selected,
  onToggle,
  onAdd,
}: {
  label: string
  options: string[]
  selected: string[]
  onToggle: (tag: string) => void
  onAdd?: (tag: string) => void
}) {
  const [draft, setDraft] = useState('')

  const handleAdd = () => {
    if (!onAdd) return
    const cleaned = normalizeTag(draft)
    if (!cleaned) return
    onAdd(cleaned)
    if (!selected.includes(cleaned)) onToggle(cleaned)
    setDraft('')
  }

  return (
    <div className="tag-picker">
      <div className="tag-picker-head">
        <div className="title-sm">{label}</div>
        {selected.length ? <span className="pill soft">{selected.length} selected</span> : <span className="muted tiny">No tags yet</span>}
      </div>
      <div className="chip-row">
        {options.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`pill soft ${selected.includes(tag) ? 'active-pill' : ''}`}
            onClick={() => onToggle(tag)}
          >
            {tag}
          </button>
        ))}
        {options.length === 0 && <span className="muted tiny">No tags yet.</span>}
      </div>
      {onAdd && (
        <div className="tag-add-row">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a tag"
            aria-label={`${label} add`}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              handleAdd()
            }}
          />
          <button className="ghost" type="button" onClick={handleAdd}>
            + Add
          </button>
        </div>
      )}
    </div>
  )
}

function StartDayModal({
  onClose,
  onCreate,
  onOpenExisting,
  projects,
  experiments,
  defaultProjectId,
  projectTagOptions,
  experimentTagOptions,
  onAddProjectTag,
  onAddExperimentTag,
  todayBucket,
  hasExisting,
}: {
  onClose: () => void
  onCreate: (val: {
    title?: string
    projectId?: string
    experimentId?: string
    projectTags?: string[]
    experimentTags?: string[]
  }) => void
  onOpenExisting: () => void
  projects: Project[]
  experiments: Experiment[]
  defaultProjectId: string
  projectTagOptions: string[]
  experimentTagOptions: string[]
  onAddProjectTag: (value: string) => void
  onAddExperimentTag: (value: string) => void
  todayBucket: string
  hasExisting: boolean
}) {
  const [title, setTitle] = useState('')
  const resolvedDefaultProjectId = projects.some((p) => p.id === defaultProjectId)
    ? defaultProjectId
    : (projects[0]?.id ?? '')
  const [projectId, setProjectId] = useState(resolvedDefaultProjectId)
  const [experimentId, setExperimentId] = useState('')
  const [projectTags, setProjectTags] = useState<string[]>([])
  const [experimentTags, setExperimentTags] = useState<string[]>([])
  const titleRef = useRef<HTMLInputElement | null>(null)

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
  const formattedDate = dateOnly.format(new Date(`${todayBucket}T00:00:00`))

  return (
    <div className="modal-overlay start-day-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal start-day-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="title-sm">Start today&apos;s entry</div>
            <div className="muted tiny">{formattedDate} · Daily lab log</div>
          </div>
          <button className="ghost" onClick={onClose} type="button">Later</button>
        </div>

        {hasExisting && (
          <div className="banner start-day-banner">
            <div>
              <div className="title-sm">You already have a daily entry for today.</div>
              <div className="muted tiny">Open it to continue your log and keep one entry per day.</div>
            </div>
            <button className="ghost" type="button" onClick={onOpenExisting}>
              Open entry
            </button>
          </div>
        )}

        <div className="modal-grid">
          <label className="field">
            <span className="muted tiny">Title (optional)</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`Daily log – ${formattedDate}`}
            />
          </label>

          <label className="field">
            <span className="muted tiny">Project</span>
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
          </label>

          <label className="field">
            <span className="muted tiny">Experiment (optional)</span>
            <select value={experimentId} onChange={(e) => setExperimentId(e.target.value)}>
              <option value="">General note</option>
              {projectExperiments.map((ex) => (
                <option key={ex.id} value={ex.id}>{ex.title}</option>
              ))}
            </select>
          </label>

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <TagPicker
              label="Project tags"
              options={projectTagOptions}
              selected={projectTags}
              onToggle={(tag) =>
                setProjectTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
              }
              onAdd={onAddProjectTag}
            />
          </div>

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <TagPicker
              label="Experiment tags"
              options={experimentTagOptions}
              selected={experimentTags}
              onToggle={(tag) =>
                setExperimentTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
              }
              onAdd={onAddExperimentTag}
            />
          </div>

        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Skip</button>
          {hasExisting && (
            <button className="ghost" onClick={onOpenExisting} type="button">
              Open today
            </button>
          )}
          <button
            className="accent"
            onClick={() =>
              onCreate({
                title: title.trim() || undefined,
                projectId: projectId || undefined,
                experimentId: experimentId || undefined,
                projectTags,
                experimentTags,
              })
            }
          >
            Start day entry
          </button>
        </div>
      </div>
    </div>
  )
}

export default App

function NewEntryModal({
  onClose,
  projects,
  experiments,
  defaultProjectId,
  defaultExperimentId,
  projectTagOptions,
  experimentTagOptions,
  onAddProjectTag,
  onAddExperimentTag,
  onCreateProject,
  onCreateExperiment,
  onCreate,
}: {
  onClose: () => void
  projects: Project[]
  experiments: Experiment[]
  defaultProjectId: string
  defaultExperimentId?: string
  projectTagOptions: string[]
  experimentTagOptions: string[]
  onAddProjectTag: (value: string) => void
  onAddExperimentTag: (value: string) => void
  onCreateProject: (title: string) => string
  onCreateExperiment: (opts: { title: string; projectId: string }) => string
  onCreate: (val: {
    title?: string
    projectId?: string
    experimentId?: string
    projectTags?: string[]
    experimentTags?: string[]
    templateId: EntryTemplateId
  }) => void
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
  const [templateId, setTemplateId] = useState<EntryTemplateId>('guided')
  const [projectTags, setProjectTags] = useState<string[]>([])
  const [experimentTags, setExperimentTags] = useState<string[]>([])
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

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <TagPicker
              label="Project tags"
              options={projectTagOptions}
              selected={projectTags}
              onToggle={(tag) =>
                setProjectTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
              }
              onAdd={onAddProjectTag}
            />
          </div>

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <TagPicker
              label="Experiment tags"
              options={experimentTagOptions}
              selected={experimentTags}
              onToggle={(tag) =>
                setExperimentTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
              }
              onAdd={onAddExperimentTag}
            />
          </div>

          <div className="field">
            <span className="muted tiny">Template</span>
            <div className="template-row">
              <button
                type="button"
                className={`template-card ${templateId === 'guided' ? 'active' : ''}`}
                onClick={() => setTemplateId('guided')}
              >
                <div className="title-sm">Guided template</div>
                <div className="muted tiny">Context, setup, procedure, observations, next steps.</div>
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
                projectTags,
                experimentTags,
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
  masterSyncPath,
  onMasterSyncPathChange,
  labStoragePath,
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
  masterSyncPath: string
  onMasterSyncPathChange: (value: string) => void
  labStoragePath: string
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
              <div className="title-sm">Master sync folder</div>
              <div className="muted tiny">Default location for all entries (local folder or cloud URL).</div>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label className="field">
              <span className="muted tiny">Folder or URL</span>
              <div className="field-row">
                <input
                  value={masterSyncPath}
                  onChange={(e) => onMasterSyncPathChange(e.target.value)}
                  placeholder="e.g. D:\\lab-notes\\sync or https://drive.company.com/lab"
                />
                {labStoragePath && (
                  <button className="ghost" type="button" onClick={() => onMasterSyncPathChange(labStoragePath)}>
                    Use lab storage
                  </button>
                )}
              </div>
            </label>
          </div>
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
