import type React from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createEditor, Editor, Element as SlateElement, Node, Path, Range, Text, Transforms } from 'slate'
import type { Descendant } from 'slate'
import { Slate, Editable, withReact, ReactEditor, useSlate, useSlateStatic } from 'slate-react'
import type { RenderElementProps, RenderLeafProps } from 'slate-react'
import lunr from 'lunr'
import { type LucideIcon, ArrowLeft, ArrowRight, Calendar, Camera, Columns2, Files, Info, NotebookPen, Paperclip, Pin, PinOff, Plus, Search, X } from 'lucide-react'
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
  ListItem,
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

function getDateBucket(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10)
}

function dateFromBucket(bucket: string): Date {
  const [year, month, day] = bucket.split('-').map((part) => Number(part))
  return new Date(year || 0, Math.max(0, (month || 1) - 1), Math.max(1, day || 1), 9, 0, 0)
}

function cloneSlateValue(value: Descendant[]): Descendant[] {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as Descendant[]
}

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function mergeTags(...groups: Array<string[] | undefined>) {
  const tags: string[] = []
  groups.forEach((group) => {
    if (!group) return
    group.forEach((tag) => {
      const cleaned = normalizeTag(tag)
      if (!cleaned) return
      if (!tags.includes(cleaned)) tags.push(cleaned)
    })
  })
  return tags
}

function isEntryContentEmpty(entry: Entry) {
  return entry.content.every((block) => {
    if (block.type === 'divider') return true
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote') {
      return block.text.trim().length === 0
    }
    if (block.type === 'checklist') {
      return block.items.every((item) => item.text.trim().length === 0)
    }
    if (block.type === 'list') {
      return block.items.every((item) => item.text.trim().length === 0)
    }
    if (block.type === 'table') {
      return block.data.every((row) => row.every((cell) => cell.trim().length === 0))
    }
    return false
  })
}

function shouldReplaceTitle(title: string) {
  const lowered = title.toLowerCase()
  return (
    lowered.startsWith('untitled note') ||
    lowered.startsWith('today\'s entry') ||
    lowered.startsWith('daily note') ||
    lowered.startsWith('daily entry') ||
    lowered.startsWith('quick capture')
  )
}

function isEntryMeaningful(entry: Entry) {
  if (!isEntryContentEmpty(entry)) return true
  if (entry.tags.length > 0) return true
  return !shouldReplaceTitle(entry.title)
}

function pickDailyEntry(entries: Entry[]) {
  if (entries.length === 0) return undefined
  const meaningful = entries.filter(isEntryMeaningful)
  const source = meaningful.length ? meaningful : entries
  return [...source].sort((a, b) => getEntryTimestamp(b) - getEntryTimestamp(a))[0]
}

function monthStartFromIso(isoDate: string) {
  const parts = isoDate.split('-')
  const year = Number(parts[0] ?? new Date().getFullYear())
  const month = Number(parts[1] ?? 1) - 1
  return new Date(year, Math.max(0, month), 1)
}

type EntryTemplateId = 'experiment' | 'blank'
type SyncStatus = 'pending' | 'synced' | 'failed'
type EditorTab = 'note' | 'files' | 'details'

type TagTemplate = {
  id: string
  name: string
  tags: string[]
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

type LabnoteServerState = {
  version: number
  projects: Project[]
  experiments: Experiment[]
  entries: Record<string, Entry>
  attachments: Attachment[]
}

const SERVER_STATE_URL = '/api/state'
const SERVER_INFO_URL = '/api/info'

type LabnoteServerInfo = {
  ok?: boolean
  dataDir?: string
  uploadsDir?: string
  uploadsUrl?: string
  stateFile?: string
  stateUpdatedAt?: string
  serverTime?: string
  hostname?: string
}

const TAG_TEMPLATE_KEY = 'labnote.tagTemplates'
const TAG_MIGRATION_KEY = 'labnote.tagsOnlyMigration'

function getEntryTimestamp(entry?: Entry): number {
  if (!entry) return 0
  const raw = entry.lastEditedDatetime || entry.createdDatetime
  const ts = Date.parse(raw)
  return Number.isNaN(ts) ? 0 : ts
}

function mergeById<T extends { id: string }>(serverItems: T[], localItems: T[]): T[] {
  const byId = new Map<string, T>()
  for (const item of serverItems) byId.set(item.id, item)
  for (const item of localItems) byId.set(item.id, item)
  return Array.from(byId.values())
}

function mergeEntries(serverEntries: Record<string, Entry>, localEntries: Record<string, Entry>): Record<string, Entry> {
  const merged: Record<string, Entry> = { ...serverEntries }
  for (const [id, localEntry] of Object.entries(localEntries)) {
    const serverEntry = serverEntries[id]
    if (!serverEntry || getEntryTimestamp(localEntry) >= getEntryTimestamp(serverEntry)) {
      merged[id] = localEntry
    }
  }
  return Object.fromEntries(
    Object.entries(merged).map(([id, entry]) => [id, applyLockedTemplateHeadings(entry)])
  )
}

function toEntryRecord(value: unknown): Record<string, Entry> {
  if (!value) return {}
  if (Array.isArray(value)) {
    const entries = value.filter((item): item is Entry => !!item && typeof item === 'object' && 'id' in item)
    return Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  }
  if (typeof value === 'object') return value as Record<string, Entry>
  return {}
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function fetchServerState(): Promise<LabnoteServerState | null> {
  try {
    const res = await fetch(SERVER_STATE_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as Partial<LabnoteServerState>
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      projects: Array.isArray(data.projects) ? data.projects : [],
      experiments: Array.isArray(data.experiments) ? data.experiments : [],
      entries: toEntryRecord(data.entries),
      attachments: Array.isArray(data.attachments) ? data.attachments : [],
    }
  } catch {
    return null
  }
}

async function fetchServerInfo(): Promise<LabnoteServerInfo | null> {
  try {
    const res = await fetch(SERVER_INFO_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as LabnoteServerInfo
    if (!data || typeof data !== 'object') return null
    return data
  } catch {
    return null
  }
}

async function patchServerState(partial: Partial<LabnoteServerState>) {
  try {
    const res = await fetch(SERVER_STATE_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    })
    return res.ok
  } catch {
    // Ignore network failures; local storage remains the fallback.
    return false
  }
}

async function uploadImageToServer(file: File): Promise<{ url: string } | null> {
  if (!file.type.startsWith('image/')) return null
  try {
    const dataUrl = await readFileAsDataUrl(file)
    if (!dataUrl.startsWith('data:')) return null
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, type: file.type, dataUrl }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { url?: string }
    if (!data?.url) return null
    return { url: data.url }
  } catch {
    return null
  }
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
    case 'list': {
      const collect = (items: ListItem[]): string[] =>
        items.flatMap((item) => [item.text, ...(item.children ? collect(item.children) : [])])
      return collect(block.items).join(' ')
    }
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

async function mockSyncApi(): Promise<void> {
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

  const listLines = (items: ListItem[], ordered: boolean, depth = 0): string[] => {
    const indent = '  '.repeat(depth)
    const lines: string[] = []
    items.forEach((item, idx) => {
      const prefix = ordered ? `${idx + 1}.` : '-'
      lines.push(`${indent}${prefix} ${escapeMd(item.text)}`)
      if (item.children?.length) {
        lines.push(...listLines(item.children, ordered, depth + 1))
      }
    })
    return lines
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
      case 'list': {
        parts.push(listLines(block.items, block.ordered === true).join('\n'))
        break
      }
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

  const styleAttr = (block: Block) => {
    const styles: string[] = []
    if (block.align) styles.push(`text-align:${block.align}`)
    if (typeof block.indent === 'number' && block.indent > 0) {
      styles.push(`margin-left:${block.indent * INDENT_PX}px`)
    }
    return styles.length ? ` style="${styles.join(';')}"` : ''
  }

  const runsToHtml = (runs: TextRun[] | undefined, fallbackText: string) => {
    if (!runs || runs.length === 0) return esc(fallbackText)
    return runs
      .map((run) => {
        let node = esc(run.text)
        if (run.underline) node = `<u>${node}</u>`
        if (run.italic) node = `<em>${node}</em>`
        if (run.bold) node = `<strong>${node}</strong>`
        if (run.superscript) {
          node = `<sup>${node}</sup>`
        } else if (run.subscript) {
          node = `<sub>${node}</sub>`
        }
        const styles: string[] = []
        if (run.font) styles.push(`font-family:${FONT_STYLE_EXPORT_MAP[run.font]}`)
        if (run.fontSize) styles.push(`font-size:${run.fontSize}px`)
        if (run.color) styles.push(`color:${run.color}`)
        if (run.highlight) {
          styles.push(`background-color:${run.highlight}`)
          styles.push('padding:0 2px')
          styles.push('border-radius:2px')
          styles.push('box-decoration-break:clone')
        }
        if (styles.length) {
          return `<span style="${styles.join(';')}">${node}</span>`
        }
        return node
      })
      .join('')
  }

  const renderTable = (data: string[][], headerEnabled: boolean) => {
    if (!data.length) return ''
    const header = headerEnabled ? data[0] : []
    const body = headerEnabled ? data.slice(1) : data
    const headHtml = headerEnabled
      ? `
        <thead>
          <tr>${header.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
        </thead>
      `
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

  const renderListItems = (items: ListItem[], ordered: boolean): string => {
    const tag = ordered ? 'ol' : 'ul'
    return `<${tag}>${items
      .map((item) => {
        const children = item.children?.length
          ? renderListItems(item.children, ordered)
          : ''
        return `<li>${runsToHtml(item.runs, item.text)}${children}</li>`
      })
      .join('')}</${tag}>`
  }

  return blocks
    .map((block) => {
      switch (block.type) {
        case 'heading': {
          const level = block.level ?? 2
          const tag = level <= 1 ? 'h1' : level === 3 ? 'h3' : 'h2'
          return `<${tag}${styleAttr(block)}>${runsToHtml(block.runs, block.text)}</${tag}>`
        }
        case 'paragraph':
          return `<p${styleAttr(block)}>${runsToHtml(block.runs, block.text)}</p>`
        case 'quote':
          return `<blockquote${styleAttr(block)}>${runsToHtml(block.runs, block.text)}</blockquote>`
        case 'divider':
          return `<hr />`
        case 'checklist':
          return `<ul class="checklist"${styleAttr(block)}>${block.items
            .map((i) => `<li><span class="cb">${i.done ? '☑' : '☐'}</span> ${runsToHtml(i.runs, i.text)}</li>`)
            .join('')}</ul>`
        case 'list': {
          const listHtml = renderListItems(block.items, block.ordered === true)
          return block.indent
            ? `<div${styleAttr(block)}>${listHtml}</div>`
            : listHtml
        }
        case 'table': {
          const tableClasses = ['table-wrap']
          if (block.striped) tableClasses.push('table-striped')
          if (block.compact) tableClasses.push('table-compact')
          return `<div class="${tableClasses.join(' ')}"${styleAttr(block)}>${renderTable(block.data, block.header !== false)}${block.caption ? `<div class="caption">${esc(block.caption)}</div>` : ''}</div>`
        }
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
      if (node.type === 'list-item') {
        const patch: Record<string, unknown> = {}
        if (typeof node.itemId !== 'string') patch.itemId = newId('li-')
        if (Object.keys(patch).length) {
          Transforms.setNodes(editor, patch, { at: path })
          return
        }
      }

      if (node.type === 'bulleted-list' || node.type === 'numbered-list') {
        if (node.children.length === 0) {
          Transforms.insertNodes(
            editor,
            { type: 'list-item', itemId: newId('li-'), children: [{ text: '' }] },
            { at: path.concat(0) }
          )
          return
        }
      }

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
  const legacyProjects = useMemo(() => {
    if (typeof window === 'undefined') return sampleData.projects
    try {
      const saved = window.localStorage.getItem('labnote.projects')
      if (saved) return JSON.parse(saved) as Project[]
    } catch (err) {
      console.warn('Unable to read cached projects', err)
    }
    return sampleData.projects
  }, [])
  const legacyExperiments = useMemo(() => {
    if (typeof window === 'undefined') return sampleData.experiments
    try {
      const saved = window.localStorage.getItem('labnote.experiments')
      if (saved) return JSON.parse(saved) as Experiment[]
    } catch (err) {
      console.warn('Unable to read cached experiments', err)
    }
    return sampleData.experiments
  }, [])
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
  const entryDatesWithEntries = useMemo(() => new Set(entryList.map((entry) => entry.dateBucket)), [entryList])
  const availableTags = useMemo(() => {
    const tags = new Set<string>()
    entryList.forEach((entry) => entry.tags.forEach((tag) => tags.add(tag)))
    return Array.from(tags).sort((a, b) => a.localeCompare(b))
  }, [entryList])
  const [openEntryIds, setOpenEntryIds] = useState<string[]>([])
  const [pinnedEntryIds, setPinnedEntryIds] = useState<string[]>([])
  const [splitViewEnabled, setSplitViewEnabled] = useState(false)
  const [secondaryEntryId, setSecondaryEntryId] = useState<string | null>(null)
  const todayBucket = useMemo(() => getDateBucket(new Date()), [])
  const todayEntry = useMemo(() => {
    const matches = entryList.filter((entry) => entry.dateBucket === todayBucket)
    return pickDailyEntry(matches)
  }, [entryList, todayBucket])
  const [selectedEntryId, setSelectedEntryId] = useState('')
  const [hasUserSelectedEntry, setHasUserSelectedEntry] = useState(false)
  const [editorTab, setEditorTab] = useState<EditorTab>('note')
  const [newEntryOpen, setNewEntryOpen] = useState(false)
  const [viewerMode, setViewerMode] = useState(true)
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => monthStartFromIso(getDateBucket(new Date())))
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
  const [serverAvailable, setServerAvailable] = useState(false)
  const [serverHydrated, setServerHydrated] = useState(false)
  const [serverInfo, setServerInfo] = useState<LabnoteServerInfo | null>(null)
  const [lastServerSync, setLastServerSync] = useState<string | null>(null)
  const [uploadShared, setUploadShared] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem('labnote.uploadShared') !== '0'
  })
  const [tagTemplates, setTagTemplates] = useState<TagTemplate[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const saved = window.localStorage.getItem(TAG_TEMPLATE_KEY)
      if (saved) return JSON.parse(saved) as TagTemplate[]
    } catch (err) {
      console.warn('Unable to read tag templates', err)
    }
    return []
  })
  const [tagsOnlyMigrated, setTagsOnlyMigrated] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(TAG_MIGRATION_KEY) === '1'
  })

  const openEntries = useMemo(() => {
    if (viewerMode) {
      const active = entryDrafts[selectedEntryId]
      return active ? [active] : []
    }
    return openEntryIds.map((id) => entryDrafts[id]).filter(Boolean) as Entry[]
  }, [entryDrafts, openEntryIds, selectedEntryId, viewerMode])

  useEffect(() => {
    if (!viewerMode) return
    if (!splitViewEnabled) return
    setSplitViewEnabled(false)
  }, [splitViewEnabled, viewerMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('labnote.uploadShared', uploadShared ? '1' : '0')
  }, [uploadShared])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(TAG_TEMPLATE_KEY, JSON.stringify(tagTemplates))
      } catch (err) {
        console.warn('Unable to cache tag templates', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [tagTemplates])

  useEffect(() => {
    const bucket = entryDrafts[selectedEntryId]?.dateBucket
    if (!bucket) return
    setSelectedDate(bucket)
    setCalendarMonth(monthStartFromIso(bucket))
  }, [entryDrafts, selectedEntryId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (tagsOnlyMigrated) return

    const projectMap = new Map(legacyProjects.map((p) => [p.id, p.title]))
    const experimentMap = new Map(legacyExperiments.map((ex) => [ex.id, ex]))

    setEntryDrafts((prev) => {
      const next: Record<string, Entry> = {}
      Object.entries(prev).forEach(([id, entry]) => {
        const projectTag = entry.projectId ? projectMap.get(entry.projectId) : undefined
        const experiment = entry.experimentId ? experimentMap.get(entry.experimentId) : undefined
        const experimentTag = experiment?.title
        const experimentProjectTag = experiment?.projectId ? projectMap.get(experiment.projectId) : undefined
        const tags = mergeTags(entry.tags, projectTag ? [projectTag] : undefined, experimentTag ? [experimentTag] : undefined, experimentProjectTag ? [experimentProjectTag] : undefined)
        next[id] = {
          ...entry,
          tags,
          projectId: undefined,
          experimentId: undefined,
        }
      })
      return next
    })

    if (tagTemplates.length === 0) {
      const templates: TagTemplate[] = []
      legacyProjects.forEach((project) => {
        templates.push({ id: newId('tpl-'), name: project.title, tags: [project.title] })
      })
      legacyExperiments.forEach((experiment) => {
        const projectTag = experiment.projectId ? projectMap.get(experiment.projectId) : undefined
        const tags = mergeTags([experiment.title], projectTag ? [projectTag] : undefined)
        templates.push({ id: newId('tpl-'), name: experiment.title, tags })
      })
      setTagTemplates(templates)
    }

    window.localStorage.setItem(TAG_MIGRATION_KEY, '1')
    setTagsOnlyMigrated(true)
  }, [legacyExperiments, legacyProjects, tagTemplates.length, tagsOnlyMigrated])

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

  const selectEntry = useCallback(
    (entryId: string, opts?: { autoEdit?: boolean; tab?: EditorTab }) => {
      if (!entryId) return
      if (!viewerMode) {
        setOpenEntryIds((prev) => (prev.includes(entryId) ? prev : [...prev, entryId]))
      }
      setSelectedEntryId(entryId)
      setHasUserSelectedEntry(true)
      setEditorTab(opts?.tab ?? 'note')
      if (opts?.autoEdit) {
        setAutoEditEntryId(entryId)
      }
    },
    [viewerMode]
  )

  const openEntryForBucket = useCallback(
    (bucket: string, opts?: { autoEdit?: boolean }) => {
      const matches = entryList.filter((entry) => entry.dateBucket === bucket)
      const primary = pickDailyEntry(matches)
      if (primary) {
        selectEntry(primary.id, { autoEdit: opts?.autoEdit })
        return
      }

      const bucketDate = dateFromBucket(bucket)
      const nowIso = bucketDate.toISOString()
      const entryId = newId('entry-')
      const { content, pinnedRegions } = buildTemplate('blank', entryId, nowIso)
      const isToday = bucket === getDateBucket(new Date())
      const entry: Entry = {
        id: entryId,
        experimentId: undefined,
        projectId: undefined,
        createdDatetime: nowIso,
        lastEditedDatetime: nowIso,
        authorId: sampleData.users[1]?.id ?? sampleData.users[0]?.id ?? 'me',
        title: `${isToday ? 'Today\'s entry' : 'Daily entry'} – ${dateOnly.format(bucketDate)}`,
        dateBucket: bucket,
        content,
        tags: [],
        searchTerms: [],
        linkedFiles: [],
        pinnedRegions,
      }
      setEntryDrafts((prev) => ({ ...prev, [entryId]: entry }))
      selectEntry(entryId, { autoEdit: opts?.autoEdit })
    },
    [entryList, selectEntry]
  )

  const handleSelectDate = useCallback((date: string | null) => {
    if (!date) return
    setSelectedDate(date)
    setCalendarMonth(monthStartFromIso(date))
    setDatePreset('all')
    openEntryForBucket(date)
  }, [openEntryForBucket])

  const handleCreateEntry = useCallback(
    (opts: { title?: string; templateId: EntryTemplateId; quickCapture?: boolean; tags?: string[] }) => {
      const now = new Date()
      const nowIso = now.toISOString()
      const targetBucket = selectedDate ?? getDateBucket(now)
      const matches = entryList.filter((entry) => entry.dateBucket === targetBucket)
      const primary = pickDailyEntry(matches)
      if (primary) {
        const trimmedTitle = opts.title?.trim()
        const nextTags = opts.tags?.length ? mergeTags(primary.tags, opts.tags) : undefined
        const shouldApplyTemplate = opts.templateId !== 'blank' && isEntryContentEmpty(primary)
        const template = shouldApplyTemplate ? buildTemplate(opts.templateId, primary.id, nowIso) : null
        const updates: Partial<Entry> = {}
        if (trimmedTitle && shouldReplaceTitle(primary.title)) {
          updates.title = trimmedTitle
        }
        if (nextTags) {
          updates.tags = nextTags
        }
        if (template) {
          updates.content = template.content
          updates.pinnedRegions = template.pinnedRegions
        }
        if (Object.keys(updates).length > 0) {
          updates.lastEditedDatetime = nowIso
          setEntryDrafts((prev) => {
            const current = prev[primary.id]
            if (!current) return prev
            return {
              ...prev,
              [primary.id]: {
                ...current,
                ...updates,
                tags: updates.tags ?? current.tags,
              },
            }
          })
          const blockIds = (updates.content ?? primary.content).map((block) => block.id)
          setChangeQueue((prev) => [
            {
              id: `chg-${nowIso}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
              entryId: primary.id,
              blocks: blockIds,
              status: 'pending',
              updatedAt: nowIso,
              attempts: 0,
            },
            ...prev,
          ])
        }
        selectEntry(primary.id, { autoEdit: true })
        setQuery('')
        setSelectedTags([])
        setNewEntryOpen(false)
        return
      }

      const entryId = newId('entry-')
      const bucketDate = dateFromBucket(targetBucket)
      const title =
        opts.title?.trim() ||
        (opts.quickCapture
          ? `Quick capture – ${dtFormat.format(now)}`
          : `Untitled note – ${dateOnly.format(bucketDate)}`)

      const { content, pinnedRegions } = buildTemplate(opts.templateId, entryId, nowIso)

      const entry: Entry = {
        id: entryId,
        experimentId: undefined,
        projectId: undefined,
        createdDatetime: nowIso,
        lastEditedDatetime: nowIso,
        authorId: sampleData.users[1]?.id ?? sampleData.users[0]?.id ?? 'me',
        title,
        dateBucket: targetBucket,
        content,
        tags: mergeTags(opts.tags ?? []),
        searchTerms: [],
        linkedFiles: [],
        pinnedRegions,
      }

      setEntryDrafts((prev) => ({ ...prev, [entryId]: entry }))
      selectEntry(entryId, { autoEdit: true })
      setQuery('')
      setSelectedTags([])
      setNewEntryOpen(false)
    },
    [entryList, selectedDate, selectEntry]
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
          await mockSyncApi()
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

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false

    const load = async () => {
      const state = await fetchServerState()
      if (cancelled) return

      if (state) {
        setServerAvailable(true)
        setEntryDrafts((local) => mergeEntries(state.entries, local))
        setAttachmentsStore((local) => mergeById(state.attachments, local))
      } else {
        setServerAvailable(false)
      }

      setServerHydrated(true)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshServerInfo = useCallback(async () => {
    if (!serverAvailable) {
      setServerInfo(null)
      return
    }
    const info = await fetchServerInfo()
    setServerInfo(info)
  }, [serverAvailable])

  useEffect(() => {
    if (!serverHydrated) return
    void refreshServerInfo()
  }, [refreshServerInfo, serverHydrated])

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

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!serverHydrated || !serverAvailable) return
    const id = window.setTimeout(() => {
      void (async () => {
        const ok = await patchServerState({
          projects: [],
          experiments: [],
          entries: entryDrafts,
          attachments: attachmentsStore,
        })
        if (ok) {
          setLastServerSync(new Date().toISOString())
          void refreshServerInfo()
        }
      })()
    }, 400)
    return () => window.clearTimeout(id)
  }, [attachmentsStore, entryDrafts, refreshServerInfo, serverAvailable, serverHydrated])

  const attachmentsForEntry = useCallback(
    (entryId: string) => attachmentsStore.filter((a) => a.entryId === entryId),
    [attachmentsStore]
  )

  const addAttachments = useCallback(
    async (entryId: string, files: File[]) => {
      if (!files.length) return []

      const saved: Attachment[] = []
      const shouldUpload = uploadShared && serverAvailable

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

        let storagePath = cachePath
        let thumbnail = type === 'image' ? URL.createObjectURL(file) : undefined

        if (shouldUpload && type === 'image') {
          const uploaded = await uploadImageToServer(file)
          if (uploaded?.url) {
            storagePath = uploaded.url
            thumbnail = uploaded.url
          }
        }

        saved.push({
          id,
          entryId,
          type,
          filename: file.name,
          filesize: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          storagePath,
          cachedPath: cachePath,
          pinnedOffline: type === 'image',
          thumbnail,
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
    [serverAvailable, uploadShared]
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
        const remoteFallback =
          att.storagePath?.startsWith('http') || att.storagePath?.startsWith('/labnote-uploads/')
            ? att.storagePath
            : undefined
        if (att.cachedPath?.startsWith('idb://')) {
          const key = att.cachedPath.replace('idb://', '')
          try {
            const blob = await getCachedFile(key)
            if (blob) {
              urlMap[att.id] = URL.createObjectURL(blob)
            } else {
              if (remoteFallback) {
                urlMap[att.id] = remoteFallback
              } else if (att.thumbnail) {
                urlMap[att.id] = att.thumbnail
              } else {
                missing.add(att.id)
              }
            }
          } catch (err) {
            console.warn('Unable to load cached file', att.id, err)
            if (remoteFallback) {
              urlMap[att.id] = remoteFallback
            } else if (att.thumbnail) {
              urlMap[att.id] = att.thumbnail
            } else {
              missing.add(att.id)
            }
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
              if (remoteFallback) {
                urlMap[att.id] = remoteFallback
              } else if (att.thumbnail) {
                urlMap[att.id] = att.thumbnail
              } else {
                missing.add(att.id)
              }
            }
          } else {
            if (remoteFallback) {
              urlMap[att.id] = remoteFallback
            } else if (att.thumbnail) {
              urlMap[att.id] = att.thumbnail
            } else {
              missing.add(att.id)
            }
          }
        } else if (remoteFallback) {
          urlMap[att.id] = remoteFallback
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

  const exportEntry = useCallback(
    async (entryId: string, format: 'markdown' | 'pdf') => {
      const entry = entryDrafts[entryId]
      if (!entry) {
        window.alert('Entry not found.')
        return
      }
      const attachments = attachmentsStore.filter((a) => a.entryId === entryId)
      const attachmentsById = Object.fromEntries(attachments.map((a) => [a.id, a]))

      if (format === 'pdf') {
        const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeFileName(entry.title)}</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 28px; color: #0b1220; }
      header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 18px; }
      h1 { margin: 0; font-size: 22px; }
      h2 { margin: 18px 0 6px; font-size: 18px; }
      h3 { margin: 14px 0 6px; font-size: 15px; color: #243048; }
      .meta { color: #475569; font-size: 12px; }
      blockquote { border-left: 3px solid #10b981; padding: 10px 12px; margin: 10px 0; background: #f0fdf4; }
      ul.checklist { list-style: none; padding-left: 0; }
      ul.checklist li { margin: 6px 0; }
      .cb { display: inline-block; width: 20px; }
      figure { margin: 12px 0; }
      figure img { max-width: 100%; border-radius: 10px; border: 1px solid #e2e8f0; }
      figcaption { font-size: 12px; color: #475569; margin-top: 6px; }
      .table-wrap { border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; }
      .table-wrap table { border-collapse: collapse; width: 100%; }
      .table-wrap th, .table-wrap td { border: 1px solid #e2e8f0; padding: 8px 10px; font-size: 12px; text-align: left; }
      .table-wrap th { background: #f8fafc; }
      .table-wrap.table-striped tbody tr:nth-child(even) td { background: #f1f5f9; }
      .table-wrap.table-compact th, .table-wrap.table-compact td { padding: 6px 8px; font-size: 11px; }
      .caption { font-size: 12px; color: #475569; margin-top: 6px; }
      .toolbar { margin-top: 8px; }
      .toolbar button { border-radius: 10px; border: 1px solid #cbd5e1; background: #ffffff; padding: 8px 12px; cursor: pointer; }
      @media print { .toolbar { display: none; } body { margin: 0.5in; } }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>${entry.title}</h1>
        <div class="meta">
          ${entry.dateBucket} · Created ${new Date(entry.createdDatetime).toLocaleString()} · Last edited ${new Date(entry.lastEditedDatetime).toLocaleString()}
        </div>
        ${entry.tags.length ? `<div class="meta">Tags: ${entry.tags.join(', ')}</div>` : ''}
      </div>
      <div class="toolbar">
        <button onclick="window.print()">Print / Save to PDF</button>
      </div>
    </header>

    ${blocksToHtml(entry.content, attachmentsById, attachmentUrls)}
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
      const folderName = safeFileName(`labnote_${entry.dateBucket}_${entry.title}`)
      const exportMdName = safeFileName(`${entry.title}.md`)

      const attachmentExportNameById: Record<string, string> = {}
      attachments.forEach((a) => {
        const base = safeFileName(a.filename)
        attachmentExportNameById[a.id] = `${a.id}-${base}`
      })

      const attachmentExportPathById: Record<string, string> = Object.fromEntries(
        Object.entries(attachmentExportNameById).map(([id, name]) => [id, `attachments/${name}`])
      )

      const content = [
        `# ${entry.title}`,
        '',
        `- Date: ${entry.dateBucket}`,
        `- Created: ${entry.createdDatetime}`,
        `- Last edited: ${entry.lastEditedDatetime}`,
        entry.tags.length ? `- Tags: ${entry.tags.join(', ')}` : '',
        `- Exported: ${exportedAt}`,
        '',
        blocksToMarkdown(entry.content, attachmentsById, attachmentExportPathById),
      ]
        .filter(Boolean)
        .join('\n')

      const manifest = {
        exportedAt,
        scope: {
          type: 'entry',
          entryId: entry.id,
          entryTitle: entry.title,
        },
        entry: {
          id: entry.id,
          title: entry.title,
          dateBucket: entry.dateBucket,
          createdDatetime: entry.createdDatetime,
          lastEditedDatetime: entry.lastEditedDatetime,
          tags: entry.tags,
          linkedFiles: entry.linkedFiles,
        },
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
    [attachmentUrls, attachmentsStore, entryDrafts]
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

  const orderedEntries = useMemo(() => {
    return [...entryList].sort((a, b) => {
      const bucketCompare = b.dateBucket.localeCompare(a.dateBucket)
      if (bucketCompare !== 0) return bucketCompare
      return b.createdDatetime.localeCompare(a.createdDatetime)
    })
  }, [entryList])

  const matchedIds = useMemo(() => {
    const q = query.trim()
    if (!q) return orderedEntries.map((e) => e.id)
    try {
      return index.search(q).map((r: lunr.Index.Result) => r.ref)
    } catch {
      return []
    }
  }, [index, query, orderedEntries])

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    const now = new Date()
    return orderedEntries.filter((entry) => {
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
    selectedTags,
    filterHasImage,
    filterHasFile,
    matchedIds,
    datePreset,
    orderedEntries,
    attachmentsForEntry,
  ])

  const dailyEntries = useMemo(() => {
    const byDate = new Map<string, Entry[]>()
    filteredEntries.forEach((entry) => {
      const group = byDate.get(entry.dateBucket) ?? []
      group.push(entry)
      byDate.set(entry.dateBucket, group)
    })
    return Array.from(byDate.values())
      .map((entries) => pickDailyEntry(entries))
      .filter((entry): entry is Entry => !!entry)
  }, [filteredEntries])

  const listEntries = useMemo(() => {
    if (!selectedDate) return dailyEntries
    return dailyEntries.filter((entry) => entry.dateBucket === selectedDate)
  }, [dailyEntries, selectedDate])

  const viewerEntries = useMemo(() => {
    return [...dailyEntries].sort((a, b) => {
      const bucketCompare = a.dateBucket.localeCompare(b.dateBucket)
      if (bucketCompare !== 0) return bucketCompare
      return a.createdDatetime.localeCompare(b.createdDatetime)
    })
  }, [dailyEntries])
  const viewerIndex = useMemo(
    () => viewerEntries.findIndex((item) => item.id === selectedEntryId),
    [selectedEntryId, viewerEntries]
  )
  const hasPrevEntry = viewerIndex > 0
  const hasNextEntry = viewerIndex >= 0 && viewerIndex < viewerEntries.length - 1

  const handleViewPrev = useCallback(() => {
    if (!hasPrevEntry) return
    const prev = viewerEntries[viewerIndex - 1]
    if (prev) selectEntry(prev.id)
  }, [hasPrevEntry, viewerEntries, viewerIndex, selectEntry])

  const handleViewNext = useCallback(() => {
    if (!hasNextEntry) return
    const next = viewerEntries[viewerIndex + 1]
    if (next) selectEntry(next.id)
  }, [hasNextEntry, viewerEntries, viewerIndex, selectEntry])

  const entry = entryDrafts[selectedEntryId]
  const attachments = entry ? attachmentsForEntry(entry.id) : []

  useEffect(() => {
    if (!serverHydrated) return
    if (todayEntry) return
    const now = new Date()
    const nowIso = now.toISOString()
    const entryId = newId('entry-')
    const { content, pinnedRegions } = buildTemplate('blank', entryId, nowIso)
    const entry: Entry = {
      id: entryId,
      experimentId: undefined,
      projectId: undefined,
      createdDatetime: nowIso,
      lastEditedDatetime: nowIso,
      authorId: sampleData.users[1]?.id ?? sampleData.users[0]?.id ?? 'me',
      title: `Today's entry – ${dateOnly.format(now)}`,
      dateBucket: todayBucket,
      content,
      tags: [],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions,
    }
    setEntryDrafts((prev) => ({ ...prev, [entryId]: entry }))
  }, [serverHydrated, todayBucket, todayEntry])

  useEffect(() => {
    if (!serverHydrated) return
    if (!todayEntry) return
    setSelectedEntryId((current) => (hasUserSelectedEntry && current ? current : todayEntry.id))
    if (!hasUserSelectedEntry) {
      setHasUserSelectedEntry(true)
      setEditorTab('note')
    }
  }, [hasUserSelectedEntry, serverHydrated, todayEntry])

  const openEntry = useCallback(
    (entryId: string, opts?: { autoEdit?: boolean; tab?: EditorTab }) => {
      selectEntry(entryId, opts)
    },
    [selectEntry]
  )

  const updateEntryMeta = useCallback((entryId: string, updates: Partial<Entry>) => {
    const timestamp = new Date().toISOString()
    const blocks = entryDrafts[entryId]?.content.map((block) => block.id) ?? []
    const normalizedUpdates = {
      ...updates,
      ...(updates.tags ? { tags: mergeTags(updates.tags) } : null),
    }
    setEntryDrafts((prev) => {
      const current = prev[entryId]
      if (!current) return prev
      return {
        ...prev,
        [entryId]: {
          ...current,
          ...normalizedUpdates,
          lastEditedDatetime: timestamp,
        },
      }
    })
    setChangeQueue((prev) => [
      {
        id: `chg-${timestamp}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
        entryId,
        blocks,
        status: 'pending',
        updatedAt: timestamp,
        attempts: 0,
      },
      ...prev,
    ])
  }, [entryDrafts])

  const handleSaveTagTemplate = useCallback((template: TagTemplate) => {
    setTagTemplates((prev) => {
      if (prev.some((item) => item.id === template.id)) {
        return prev.map((item) => (item.id === template.id ? template : item))
      }
      return [...prev, template]
    })
  }, [])

  const handleDeleteTagTemplate = useCallback((templateId: string) => {
    setTagTemplates((prev) => prev.filter((item) => item.id !== templateId))
  }, [])

  const togglePinEntry = useCallback((entryId: string) => {
    setPinnedEntryIds((prev) => (
      prev.includes(entryId) ? prev.filter((id) => id !== entryId) : [...prev, entryId]
    ))
  }, [])

  const closeEntry = useCallback((entryId: string) => {
    setOpenEntryIds((prev) => {
      const next = prev.filter((id) => id !== entryId)
      setPinnedEntryIds((pins) => pins.filter((id) => id !== entryId))
      setSecondaryEntryId((current) => (current === entryId ? null : current))
      setSelectedEntryId((current) => {
        if (current !== entryId) return current
        return next[0] ?? ''
      })
      return next
    })
  }, [])

  useEffect(() => {
    if (!selectedEntryId) return
    if (viewerMode) return
    if (openEntryIds.includes(selectedEntryId)) return
    setOpenEntryIds((prev) => [...prev, selectedEntryId])
  }, [openEntryIds, selectedEntryId, viewerMode])

  useEffect(() => {
    if (!splitViewEnabled) return
    const available = openEntryIds.filter((id) => id !== selectedEntryId)
    if (available.length === 0) {
      setSecondaryEntryId(null)
      return
    }
    if (!secondaryEntryId || !available.includes(secondaryEntryId)) {
      setSecondaryEntryId(available[0])
    }
  }, [splitViewEnabled, openEntryIds, selectedEntryId, secondaryEntryId])

  // Keep selection in sync with filtered list
  useEffect(() => {
    if (!hasUserSelectedEntry) return
    if (dailyEntries.length === 0) return
    const stillVisible = dailyEntries.some((e) => e.id === selectedEntryId)
    if (!stillVisible) {
      setSelectedEntryId(dailyEntries[0].id)
    }
  }, [dailyEntries, selectedEntryId, hasUserSelectedEntry])

  return (
    <div className="app-bg">
      <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar
          labs={sampleData.labs}
          entries={listEntries}
          availableTags={availableTags}
          storagePath={serverInfo?.dataDir ?? sampleData.labs[0]?.storageConfig.path ?? '—'}
          selectedEntryId={selectedEntryId}
          query={query}
          onQueryChange={setQuery}
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
          selectedDate={selectedDate}
          onSelectDate={handleSelectDate}
          calendarMonth={calendarMonth}
          onCalendarMonthChange={setCalendarMonth}
          entryDatesWithEntries={entryDatesWithEntries}
          onSelectEntry={(id) => openEntry(id)}
          onNewEntry={() => setNewEntryOpen(true)}
          onQuickCapture={() => openEntryForBucket(todayBucket, { autoEdit: true })}
          onOpenSettings={() => setSettingsOpen(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
        />
        <EditorPane
          entry={entry}
          todayEntry={todayEntry}
          openEntries={openEntries}
          activeEntryId={selectedEntryId}
          pinnedEntryIds={pinnedEntryIds}
          attachments={attachments}
          attachmentUrls={attachmentUrls}
          missingAttachments={missingAttachments}
          onOpenEntry={openEntry}
          onNewEntry={() => setNewEntryOpen(true)}
          onQuickCapture={() => openEntryForBucket(todayBucket, { autoEdit: true })}
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
          onUpdateEntryMeta={updateEntryMeta}
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
          autoEditEntryId={autoEditEntryId}
          onConsumeAutoEdit={() => setAutoEditEntryId(null)}
          onExportEntry={exportEntry}
          onTogglePinned={togglePinned}
          onSyncNow={() => syncNow({ entryId: selectedEntryId, includeFailed: true })}
          onRetryChange={retryChange}
          onClearSynced={() => clearSyncedChanges(selectedEntryId)}
          activeTab={editorTab}
          onTabChange={setEditorTab}
          onTogglePinEntry={togglePinEntry}
          onCloseEntry={closeEntry}
          splitViewEnabled={splitViewEnabled}
          secondaryEntryId={secondaryEntryId}
          onToggleSplitView={(next) => setSplitViewEnabled(next)}
          onSelectSecondaryEntry={(id) => setSecondaryEntryId(id)}
          getAttachmentsForEntry={attachmentsForEntry}
          uploadShared={uploadShared}
          onToggleUploadShared={() => setUploadShared((prev) => !prev)}
          serverAvailable={serverAvailable}
          serverHydrated={serverHydrated}
          serverInfo={serverInfo}
          lastServerSync={lastServerSync}
          viewerMode={viewerMode}
          onToggleViewerMode={() => setViewerMode((prev) => !prev)}
          viewerIndex={viewerIndex}
          viewerTotal={viewerEntries.length}
          hasPrevEntry={hasPrevEntry}
          hasNextEntry={hasNextEntry}
          onViewPrev={handleViewPrev}
          onViewNext={handleViewNext}
          tagTemplates={tagTemplates}
          onSaveTagTemplate={handleSaveTagTemplate}
          onDeleteTagTemplate={handleDeleteTagTemplate}
        />
      </div>
      {newEntryOpen && (
        <NewEntryModal
          onClose={() => setNewEntryOpen(false)}
          tagTemplates={tagTemplates}
          onCreate={(val) => handleCreateEntry(val)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
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
  entries: Entry[]
  availableTags: string[]
  storagePath: string
  selectedEntryId: string
  query: string
  onQueryChange: (val: string) => void
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  filterHasImage: boolean
  filterHasFile: boolean
  onToggleHasImage: () => void
  onToggleHasFile: () => void
  datePreset: 'all' | '7d' | '30d'
  onSelectDatePreset: (val: 'all' | '7d' | '30d') => void
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
  calendarMonth: Date
  onCalendarMonthChange: (next: Date) => void
  entryDatesWithEntries: Set<string>
  onSelectEntry: (id: string) => void
  onNewEntry: () => void
  onQuickCapture: () => void
  onOpenSettings: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

function Sidebar({
  labs,
  entries,
  availableTags,
  storagePath,
  selectedEntryId,
  query,
  onQueryChange,
  selectedTags,
  onToggleTag,
  filterHasImage,
  filterHasFile,
  onToggleHasImage,
  onToggleHasFile,
  datePreset,
  onSelectDatePreset,
  selectedDate,
  onSelectDate,
  calendarMonth,
  onCalendarMonthChange,
  entryDatesWithEntries,
  onSelectEntry,
  onNewEntry,
  onQuickCapture,
  onOpenSettings,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const activeLab = labs[0]
  const allTags = useMemo(() => availableTags.slice(0, 24), [availableTags])
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [tagQuery, setTagQuery] = useState('')
  const calendarLabel = useMemo(() => {
    return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(calendarMonth)
  }, [calendarMonth])

  const normalizedTagQuery = tagQuery.trim().toLowerCase()
  const filteredTags = useMemo(
    () =>
      normalizedTagQuery
        ? allTags.filter((tag) => tag.toLowerCase().includes(normalizedTagQuery))
        : allTags,
    [allTags, normalizedTagQuery]
  )

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
              <p className="muted">Storage: {storagePath}</p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="status-chip success">Sync ready</div>
              <button className="pill soft" onClick={onOpenSettings} type="button">Settings</button>
            </div>
          </div>

          <div className="search-box">
            <Search className="icon" aria-hidden="true" />
            <input
              placeholder="Search notes, samples, files"
              value={query}
              ref={searchRef}
              onChange={(e) => onQueryChange(e.target.value)}
            />
            <span className="kbd">Ctrl + K</span>
          </div>

          <div className="quick-actions">
            <button className="ghost" onClick={onNewEntry} data-testid="sidebar-new-entry">
              <Plus className="icon" aria-hidden="true" />
              New Entry
            </button>
            <button className="accent" onClick={onQuickCapture} data-testid="sidebar-quick-capture">
              <Camera className="icon" aria-hidden="true" />
              Quick Capture
            </button>
          </div>

          <section className="sidebar-section">
            <div className="section-title">Tags</div>
            <label className="field">
              <span className="muted tiny">Search tags</span>
              <input
                value={tagQuery}
                onChange={(e) => setTagQuery(e.target.value)}
                placeholder="Filter tags…"
                data-testid="tag-search"
              />
            </label>
            <div className="chip-row" data-testid="tag-list">
              {filteredTags.map((tag) => (
                <button
                  key={tag}
                  className={`pill soft ${selectedTags.includes(tag) ? 'active-pill' : ''}`}
                  onClick={() => onToggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
              {filteredTags.length === 0 && <span className="muted tiny">No tags found.</span>}
            </div>
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
                <span>{selectedDate ? `Viewing: ${selectedDate}` : 'Pick a date to view entries.'}</span>
                <button
                  type="button"
                  className="calendar-clear"
                  onClick={() => onSelectDate(todayIso)}
                  data-testid="calendar-today"
                >
                  Today
                </button>
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
                  const hasEntry = entryDatesWithEntries.has(day.iso)
                  return (
                    <button
                      key={day.iso}
                      type="button"
                      className={`calendar-day${day.isOutside ? ' outside' : ''}${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}${hasEntry ? ' has-entry' : ''}`}
                      onClick={() => {
                        onSelectDate(day.iso)
                      }}
                      aria-pressed={isSelected}
                      aria-label={`${day.day} ${calendarLabel}`}
                      data-testid={`calendar-day-${day.iso}`}
                    >
                      <span>{day.day}</span>
                      {hasEntry && <span className="calendar-dot" aria-hidden="true" />}
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
            <div className="entry-list" data-testid="entry-list">
              {entries.length === 0 && (
                <div className="muted tiny">No entries match these filters.</div>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`entry-item ${selectedEntryId === entry.id ? 'active' : ''}`}
                  onClick={() => onSelectEntry(entry.id)}
                  data-testid={`entry-list-item-${entry.id}`}
                >
                  <div>
                    <div className="title-sm">{entry.title}</div>
                    <p className="muted tiny">{dateOnly.format(new Date(entry.createdDatetime))}</p>
                  </div>
                  {entry.tags[0] ? (
                    <span className="pill ghost-pill">{entry.tags[0]}</span>
                  ) : (
                    <span className="pill soft">Draft</span>
                  )}
                </button>
              ))}
            </div>

            {showAdvanced && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                  <div className="section-title">Date range</div>
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
        </div>
      )}
    </aside>
  )
}

interface EditorPaneProps {
  entry?: Entry
  todayEntry?: Entry
  openEntries: Entry[]
  activeEntryId: string
  pinnedEntryIds: string[]
  attachments: Attachment[]
  attachmentUrls: Record<string, string>
  missingAttachments: Set<string>
  onOpenEntry: (entryId: string, opts?: { autoEdit?: boolean; tab?: EditorTab }) => void
  onNewEntry: () => void
  onQuickCapture: () => void
  onUpdateEntry: (entryId: string, content: Block[]) => void
  onUpdateEntryMeta: (entryId: string, updates: Partial<Entry>) => void
  onAddAttachments: (entryId: string, files: File[]) => Promise<Attachment[]>
  onAddFileDestination: (entryId: string, val: { path: string; label?: string }) => Attachment
  onEnqueueChange: (entryId: string, blockIds: string[], timestamp: string) => void
  changeQueue: ChangeQueueItem[]
  syncing: boolean
  autoEditEntryId: string | null
  onConsumeAutoEdit: () => void
  onExportEntry: (entryId: string, format: 'markdown' | 'pdf') => Promise<void>
  onTogglePinned: (attachmentId: string) => void
  onSyncNow: () => void
  onRetryChange: (changeId: string) => void
  onClearSynced: () => void
  activeTab: EditorTab
  onTabChange: (tab: EditorTab) => void
  onTogglePinEntry: (entryId: string) => void
  onCloseEntry: (entryId: string) => void
  splitViewEnabled: boolean
  secondaryEntryId: string | null
  onToggleSplitView: (next: boolean) => void
  onSelectSecondaryEntry: (entryId: string) => void
  getAttachmentsForEntry: (entryId: string) => Attachment[]
  uploadShared: boolean
  onToggleUploadShared: () => void
  serverAvailable: boolean
  serverHydrated: boolean
  serverInfo: LabnoteServerInfo | null
  lastServerSync: string | null
  viewerMode: boolean
  onToggleViewerMode: () => void
  viewerIndex: number
  viewerTotal: number
  hasPrevEntry: boolean
  hasNextEntry: boolean
  onViewPrev: () => void
  onViewNext: () => void
  tagTemplates: TagTemplate[]
  onSaveTagTemplate: (template: TagTemplate) => void
  onDeleteTagTemplate: (templateId: string) => void
}

function EditorPane({
  entry,
  todayEntry,
  openEntries,
  activeEntryId,
  pinnedEntryIds,
  attachments,
  attachmentUrls,
  missingAttachments,
  onOpenEntry,
  onNewEntry,
  onQuickCapture,
  onUpdateEntry,
  onUpdateEntryMeta,
  onAddAttachments,
  onAddFileDestination,
  onEnqueueChange,
  changeQueue,
  syncing,
  autoEditEntryId,
  onConsumeAutoEdit,
  onExportEntry,
  onTogglePinned,
  onSyncNow,
  onRetryChange,
  onClearSynced,
  activeTab,
  onTabChange,
  onTogglePinEntry,
  onCloseEntry,
  splitViewEnabled,
  secondaryEntryId,
  onToggleSplitView,
  onSelectSecondaryEntry,
  getAttachmentsForEntry,
  uploadShared,
  onToggleUploadShared,
  serverAvailable,
  serverHydrated,
  serverInfo,
  lastServerSync,
  viewerMode,
  onToggleViewerMode,
  viewerIndex,
  viewerTotal,
  hasPrevEntry,
  hasNextEntry,
  onViewPrev,
  onViewNext,
  tagTemplates,
  onSaveTagTemplate,
  onDeleteTagTemplate,
}: EditorPaneProps) {
  const [exporting, setExporting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editor] = useState(() => withChecklists(withReact(createEditor() as ReactEditor)))
  const [editorValue, setEditorValue] = useState<Descendant[]>(
    () => blocksToSlate(entry?.content ?? [{ id: 'b-empty', type: 'paragraph', text: '' }])
  )
  const lastEntryIdRef = useRef<string | null>(null)
  const skipAutosaveRef = useRef(false)
  const editorValueRef = useRef(editorValue)
  const undoStackRef = useRef<Descendant[][]>([])
  const redoStackRef = useRef<Descendant[][]>([])
  const isHistoryActionRef = useRef(false)

  useEffect(() => {
    editorValueRef.current = cloneSlateValue(editorValue)
  }, [editorValue])

  useEffect(() => {
    if (!entry) return
    if (lastEntryIdRef.current !== entry.id) {
      lastEntryIdRef.current = entry.id
      undoStackRef.current = []
      redoStackRef.current = []
      skipAutosaveRef.current = true
      setIsEditing(false)
      setEditorValue(blocksToSlate(entry.content))
      window.setTimeout(() => {
        skipAutosaveRef.current = false
      }, 0)
      return
    }
    if (!isEditing) {
      setEditorValue(blocksToSlate(entry.content))
    }
  }, [entry, isEditing])

  useEffect(() => {
    if (!entry) return
    if (autoEditEntryId && entry.id === autoEditEntryId) {
      setIsEditing(true)
      onTabChange('note')
      onConsumeAutoEdit()
    }
  }, [autoEditEntryId, entry, onConsumeAutoEdit, onTabChange])

  const attachmentMap = useMemo(
    () => Object.fromEntries(attachments.map((a) => [a.id, a])),
    [attachments]
  )

  const pendingCount = changeQueue.filter((c) => c.status === 'pending').length
  const failedCount = changeQueue.filter((c) => c.status === 'failed').length
  const hasWork = pendingCount > 0 || failedCount > 0
  const attachInputRef = useRef<HTMLInputElement | null>(null)
  const captureInputRef = useRef<HTMLInputElement | null>(null)
  const orderedOpenEntries = useMemo(() => {
    const pinned = openEntries.filter((item) => pinnedEntryIds.includes(item.id))
    const others = openEntries.filter((item) => !pinnedEntryIds.includes(item.id))
    return [...pinned, ...others]
  }, [openEntries, pinnedEntryIds])
  const secondaryEntry = useMemo(
    () => (secondaryEntryId ? openEntries.find((item) => item.id === secondaryEntryId) : undefined),
    [openEntries, secondaryEntryId]
  )
  const secondaryAttachments = useMemo(
    () => (secondaryEntry ? getAttachmentsForEntry(secondaryEntry.id) : []),
    [secondaryEntry, getAttachmentsForEntry]
  )
  const secondaryAttachmentMap = useMemo(
    () => Object.fromEntries(secondaryAttachments.map((att) => [att.id, att])),
    [secondaryAttachments]
  )

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

  const tabItems: { id: EditorTab; label: string; icon: LucideIcon }[] = [
    { id: 'note', label: 'Note', icon: NotebookPen },
    { id: 'files', label: attachments.length ? `Files (${attachments.length})` : 'Files', icon: Files },
    { id: 'details', label: 'Details', icon: Info },
  ]

  const todayDate = todayEntry ? new Date(todayEntry.createdDatetime) : new Date()
  const todayTitle = todayEntry?.title ?? `Today's entry – ${dateOnly.format(todayDate)}`
  const todayUpdated = todayEntry?.lastEditedDatetime
  const todayHasContent = (todayEntry?.content ?? []).some((block) => {
    if (block.type === 'paragraph' || block.type === 'quote') return block.text.trim().length > 0
    if (block.type === 'checklist') return block.items.some((item) => item.text.trim().length > 0)
    return block.type !== 'divider'
  })

  const handleAttachFiles = (files: File[]) => {
    if (!todayEntry || files.length === 0) return
    void (async () => {
      await onAddAttachments(todayEntry.id, files)
      onOpenEntry(todayEntry.id, { tab: 'files' })
    })()
  }

  const emptyMessage =
    activeTab === 'files'
      ? 'Select a note to view files.'
      : activeTab === 'details'
        ? 'Select a note to view details.'
        : 'Select or create a note to get started.'

  const persistDraft = useCallback(
    (value: Descendant[]) => {
      if (!entry) return
      const updatedBlocks = slateToBlocks(value)
      const timestamp = new Date().toISOString()
      updatedBlocks.forEach((b) => {
        b.updatedAt = timestamp
        b.updatedBy = 'me'
      })
      onUpdateEntry(entry.id, updatedBlocks)
      onEnqueueChange(entry.id, updatedBlocks.map((b) => b.id), timestamp)
    },
    [entry, onUpdateEntry, onEnqueueChange]
  )

  const applyHistoryValue = useCallback(
    (next: Descendant[]) => {
      const working = cloneSlateValue(next)
      const snapshot = cloneSlateValue(next)
      isHistoryActionRef.current = true
      Editor.withoutNormalizing(editor, () => {
        for (let i = editor.children.length - 1; i >= 0; i -= 1) {
          Transforms.removeNodes(editor, { at: [i] })
        }
        if (working.length > 0) {
          Transforms.insertNodes(editor, working, { at: [0] })
        } else {
          Transforms.insertNodes(editor, [{ type: 'paragraph', children: [{ text: '' }] }], { at: [0] })
        }
      })
      setEditorValue(working)
      editorValueRef.current = snapshot
      window.setTimeout(() => {
        isHistoryActionRef.current = false
      }, 0)
    },
    [editor]
  )

  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current
    if (!stack.length) return
    const previous = stack.pop()
    if (!previous) return
    redoStackRef.current.push(editorValueRef.current)
    applyHistoryValue(previous)
  }, [applyHistoryValue])

  const handleRedo = useCallback(() => {
    const stack = redoStackRef.current
    if (!stack.length) return
    const next = stack.pop()
    if (!next) return
    undoStackRef.current.push(editorValueRef.current)
    applyHistoryValue(next)
  }, [applyHistoryValue])

  const handleEditorChange = useCallback(
    (value: Descendant[]) => {
      const hasContentChange = editor.operations.some((op) => op.type !== 'set_selection')
      if (isEditing && hasContentChange && !isHistoryActionRef.current) {
        undoStackRef.current.push(editorValueRef.current)
        if (undoStackRef.current.length > 120) {
          undoStackRef.current.shift()
        }
        redoStackRef.current = []
      }
      setEditorValue(value)
      editorValueRef.current = cloneSlateValue(value)
    },
    [editor, isEditing]
  )

  const handleTabSwitch = useCallback(
    (nextTab: EditorTab) => {
      if (isEditing && nextTab !== 'note') {
        persistDraft(editorValue)
        setIsEditing(false)
      }
      onTabChange(nextTab)
    },
    [editorValue, isEditing, onTabChange, persistDraft]
  )

  const handleViewPrevSafe = useCallback(() => {
    if (isEditing) {
      persistDraft(editorValue)
      setIsEditing(false)
    }
    onViewPrev()
  }, [editorValue, isEditing, onViewPrev, persistDraft])

  const handleViewNextSafe = useCallback(() => {
    if (isEditing) {
      persistDraft(editorValue)
      setIsEditing(false)
    }
    onViewNext()
  }, [editorValue, isEditing, onViewNext, persistDraft])

  const viewerPosition = viewerTotal > 0 && viewerIndex >= 0 ? `${viewerIndex + 1} / ${viewerTotal}` : `0 / ${viewerTotal}`

  const viewerBar = (
    <div className="viewer-bar" data-testid="viewer-bar">
      <div className="viewer-nav">
        <button
          className="ghost"
          type="button"
          onClick={handleViewPrevSafe}
          disabled={!hasPrevEntry}
          data-testid="viewer-prev"
        >
          <ArrowLeft className="icon" aria-hidden="true" />
          Prev
        </button>
        <button
          className="ghost"
          type="button"
          onClick={handleViewNextSafe}
          disabled={!hasNextEntry}
          data-testid="viewer-next"
        >
          Next
          <ArrowRight className="icon" aria-hidden="true" />
        </button>
      </div>
      <div className="viewer-meta">
        <span className="pill soft">{viewerPosition}</span>
        {entry?.dateBucket && <span className="pill">{entry.dateBucket}</span>}
      </div>
      <button className="ghost" type="button" onClick={onToggleViewerMode} data-testid="viewer-toggle">
        Tabs view
      </button>
    </div>
  )

  const workspaceBar = (
    <div className="workspace-bar">
      <div className="workspace-tabs" role="tablist" aria-label="Open entries" data-testid="workspace-tabs">
        {orderedOpenEntries.length === 0 && (
          <div className="muted tiny">No open entries yet.</div>
        )}
        {orderedOpenEntries.map((open) => {
          const isPinned = pinnedEntryIds.includes(open.id)
          return (
            <div
              key={open.id}
              className={`workspace-tab ${activeEntryId === open.id ? 'active' : ''}`}
              data-testid={`workspace-tab-${open.id}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeEntryId === open.id}
                className="workspace-tab-button"
                onClick={() => onOpenEntry(open.id)}
              >
                <NotebookPen className="icon" aria-hidden="true" />
                <span className="workspace-tab-title">{open.title}</span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={isPinned ? 'Unpin entry' : 'Pin entry'}
                onClick={() => onTogglePinEntry(open.id)}
                data-testid={`workspace-pin-${open.id}`}
              >
                {isPinned ? <PinOff className="icon" aria-hidden="true" /> : <Pin className="icon" aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Close entry"
                onClick={() => onCloseEntry(open.id)}
                data-testid={`workspace-close-${open.id}`}
              >
                <X className="icon" aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="workspace-controls">
        <button
          className="ghost"
          type="button"
          onClick={onToggleViewerMode}
          data-testid="viewer-toggle"
        >
          Viewer mode
        </button>
        <button
          className={`ghost ${splitViewEnabled ? 'active-pill' : ''}`}
          type="button"
          disabled={orderedOpenEntries.length < 2}
          onClick={() => onToggleSplitView(!splitViewEnabled)}
          data-testid="split-toggle"
        >
          <Columns2 className="icon" aria-hidden="true" />
          Split view
        </button>
        {splitViewEnabled && (
          <label className="field">
            <span className="muted tiny">Second entry</span>
            <select
              value={secondaryEntryId ?? ''}
              onChange={(event) => onSelectSecondaryEntry(event.target.value)}
              data-testid="split-secondary-select"
            >
              <option value="">Select entry</option>
              {orderedOpenEntries
                .filter((item) => item.id !== activeEntryId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
    </div>
  )

  useEffect(() => {
    if (!entry || !isEditing) return
    if (skipAutosaveRef.current) return
    const timer = window.setTimeout(() => {
      persistDraft(editorValue)
    }, 900)
    return () => window.clearTimeout(timer)
  }, [editorValue, entry, isEditing, persistDraft])

  if (!entry) {
    return (
      <main className="panel editor">
        {viewerMode ? viewerBar : workspaceBar}
        <div className="editor-tabs" role="tablist" aria-label="Note views">
          {tabItems.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              id={`editor-tab-${tab.id}`}
              className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => onTabChange(tab.id)}
              data-testid={`editor-tab-${tab.id}`}
            >
              <tab.icon className="icon" aria-hidden="true" />
              {tab.label}
            </button>
          ))}
        </div>
        {activeTab === 'note' ? (
          <div className="landing" data-testid="today-landing">
            <div className="today-card" data-testid="today-entry-card">
              <div className="today-head">
                <div>
                  <div className="eyebrow">Today</div>
                  <h2>{todayTitle}</h2>
                  <div className="muted tiny">
                    <Calendar className="icon" aria-hidden="true" />
                    {dateOnly.format(todayDate)}
                  </div>
                </div>
                <span className="pill soft">{todayHasContent ? 'In progress' : 'Ready'}</span>
              </div>
              <p className="muted">
                Log your work, attach raw data, and keep everything organized with tags. Autosave is on by default.
              </p>
              <div className="today-actions">
                <button
                  className="accent"
                  type="button"
                  onClick={() => todayEntry && onOpenEntry(todayEntry.id, { autoEdit: true })}
                  disabled={!todayEntry}
                  data-testid="today-continue-btn"
                >
                  Continue writing
                  <ArrowRight className="icon" aria-hidden="true" />
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => todayEntry && onOpenEntry(todayEntry.id)}
                  disabled={!todayEntry}
                  data-testid="today-open-btn"
                >
                  Open entry
                </button>
              </div>
              {todayUpdated && (
                <div className="muted tiny">
                  Last edited {dtFormat.format(new Date(todayUpdated))}
                </div>
              )}
            </div>

            <div className="action-grid">
              <button className="action-card" type="button" onClick={onNewEntry} data-testid="today-new-entry">
                <Plus className="icon" aria-hidden="true" />
                <div>
                  <div className="title-sm">New entry</div>
                  <div className="muted tiny">Start a separate note or protocol run.</div>
                </div>
              </button>
              <button className="action-card" type="button" onClick={onQuickCapture} data-testid="today-quick-capture">
                <NotebookPen className="icon" aria-hidden="true" />
                <div>
                  <div className="title-sm">Quick capture</div>
                  <div className="muted tiny">Fast scratchpad with autosave.</div>
                </div>
              </button>
              <button
                className="action-card"
                type="button"
                onClick={() => captureInputRef.current?.click()}
                disabled={!todayEntry}
                data-testid="today-capture-photo"
              >
                <Camera className="icon" aria-hidden="true" />
                <div>
                  <div className="title-sm">Capture photo</div>
                  <div className="muted tiny">Use your camera and attach it instantly.</div>
                </div>
              </button>
              <button
                className="action-card"
                type="button"
                onClick={() => attachInputRef.current?.click()}
                disabled={!todayEntry}
                data-testid="today-attach-files"
              >
                <Paperclip className="icon" aria-hidden="true" />
                <div>
                  <div className="title-sm">Attach files</div>
                  <div className="muted tiny">Drop images, PDFs, or raw data.</div>
                </div>
              </button>
              <button
                className="action-card"
                type="button"
                onClick={() => todayEntry && onOpenEntry(todayEntry.id, { tab: 'files' })}
                disabled={!todayEntry}
                data-testid="today-view-files"
              >
                <Files className="icon" aria-hidden="true" />
                <div>
                  <div className="title-sm">Browse files</div>
                  <div className="muted tiny">See all attachments for today.</div>
                </div>
              </button>
              <button
                className="action-card"
                type="button"
                onClick={() => todayEntry && onOpenEntry(todayEntry.id, { tab: 'details' })}
                disabled={!todayEntry}
                data-testid="today-view-details"
              >
                <Info className="icon" aria-hidden="true" />
                <div>
                  <div className="title-sm">Tags & details</div>
                  <div className="muted tiny">Manage tags, templates, and sync status.</div>
                </div>
              </button>
            </div>
            {serverHydrated && (
              <div className="upload-toggle">
                <button
                  className={`pill soft ${uploadShared && serverAvailable ? 'active-pill' : ''}`}
                  type="button"
                  onClick={onToggleUploadShared}
                  disabled={!serverAvailable}
                  data-testid="upload-shared-toggle-landing"
                >
                  Shared upload
                </button>
                <div className="muted tiny">
                  {serverAvailable
                    ? 'Uploads images to the shared notebook for mobile + desktop.'
                    : 'Shared upload unavailable (offline or server not reachable).'}
                </div>
              </div>
            )}
            <input
              ref={attachInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              data-testid="today-attach-input"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                handleAttachFiles(files)
                event.currentTarget.value = ''
              }}
            />
            <input
              ref={captureInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              data-testid="today-capture-input"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                handleAttachFiles(files)
                event.currentTarget.value = ''
              }}
            />
          </div>
        ) : (
          <div className="empty" data-testid="empty-editor">
            {emptyMessage}
          </div>
        )}
      </main>
    )
  }

  const handleSave = () => {
    persistDraft(editorValue)
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

  const primaryPanel = (
    <section className="editor-panel primary" data-testid="primary-editor-panel">
      {activeTab === 'note' && (
        <div className="tab-panel" role="tabpanel" aria-labelledby="editor-tab-note">
          {!isEditing && (
            <div className="blocks">
              {entry.content.map((block) => (
                <div key={block.id} className="block-shell">
                  <BlockRenderer
                    block={block}
                    attachments={attachmentMap}
                    attachmentUrls={attachmentUrls}
                    onUpdateBlock={handleUpdateBlock}
                  />
                </div>
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
                  onChange={handleEditorChange}
                >
                  <EditorInsertBar
                    entryId={entry.id}
                    onAddAttachments={onAddAttachments}
                    onAddFileDestination={onAddFileDestination}
                    uploadShared={uploadShared}
                    onToggleUploadShared={onToggleUploadShared}
                    serverAvailable={serverAvailable}
                    serverHydrated={serverHydrated}
                  />
                  <Editable
                    renderElement={renderElement}
                    renderLeaf={renderLeaf}
                    className="slate-editor"
                    placeholder="Type your lab note..."
                    onKeyDown={(event) => {
                      if (event.key === 'Tab') {
                        event.preventDefault()
                        const activeList = getActiveListType(editor)
                        if (activeList) {
                          if (event.shiftKey) {
                            outdentListItem(editor)
                          } else {
                            indentListItem(editor, activeList)
                          }
                        } else {
                          const currentIndent = getActiveIndent(editor)
                          setIndent(editor, currentIndent + (event.shiftKey ? -INDENT_STEP : INDENT_STEP))
                        }
                        return
                      }
                      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                        const key = event.key.toLowerCase()
                        if (key === 'z') {
                          event.preventDefault()
                          if (event.shiftKey) {
                            handleRedo()
                          } else {
                            handleUndo()
                          }
                          return
                        }
                        if (key === 'y') {
                          event.preventDefault()
                          handleRedo()
                          return
                        }
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
        </div>
      )}

      {activeTab === 'files' && (
        <div className="tab-panel files-pane" role="tabpanel" aria-labelledby="editor-tab-files" data-testid="files-pane">
          <div className="section-title">Files</div>
          {attachments.length === 0 && (
            <div className="muted tiny">No files linked to this note yet.</div>
          )}
          {attachments.length > 0 && (
            <div className="attachment-list">
              {attachments.map((file) => (
                <AttachmentRow
                  key={file.id}
                  attachment={file}
                  onTogglePinned={onTogglePinned}
                  missing={missingAttachments.has(file.id)}
                  url={attachmentUrls[file.id]}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'details' && (
        <div className="tab-panel details-pane" role="tabpanel" aria-labelledby="editor-tab-details" data-testid="details-pane">
          <div className="details-head">
            <div>
              <div className="title-sm">Details</div>
              <div className="muted tiny">{entry.title}</div>
            </div>
          </div>
          <TagPanel
            entry={entry}
            tagTemplates={tagTemplates}
            onUpdateEntryMeta={onUpdateEntryMeta}
            onSaveTemplate={onSaveTagTemplate}
            onDeleteTemplate={onDeleteTagTemplate}
          />
          <MetaPanelContent
            entry={entry}
            attachments={attachments}
            onTogglePinned={onTogglePinned}
            missing={missingAttachments}
            attachmentUrls={attachmentUrls}
            changeQueue={changeQueue}
            syncing={syncing}
            onSyncNow={onSyncNow}
            onRetryChange={onRetryChange}
            onClearSynced={onClearSynced}
            serverAvailable={serverAvailable}
            serverHydrated={serverHydrated}
            serverInfo={serverInfo}
            lastServerSync={lastServerSync}
            uploadShared={uploadShared}
          />
        </div>
      )}
    </section>
  )

  const secondaryPanel = splitViewEnabled ? (
    <section className="editor-panel secondary" data-testid="split-secondary-panel" aria-label="Secondary entry">
      {!secondaryEntry ? (
        <div className="empty">Select a second entry to compare.</div>
      ) : (
        <>
          <div className="secondary-header">
            <div>
              <div className="eyebrow">Reference</div>
              <h2>{secondaryEntry.title}</h2>
              <div className="muted tiny">
                Last edited {dtFormat.format(new Date(secondaryEntry.lastEditedDatetime))}
              </div>
            </div>
            <span className="pill soft">{secondaryEntry.dateBucket}</span>
          </div>
          <div className="secondary-meta">
            {secondaryEntry.tags.length > 0 ? (
              <>
                {secondaryEntry.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="pill">
                    {tag}
                  </span>
                ))}
                {secondaryEntry.tags.length > 3 && (
                  <span className="pill soft">+{secondaryEntry.tags.length - 3}</span>
                )}
              </>
            ) : (
              <span className="pill soft">No tags</span>
            )}
            <span className="pill ghost-pill">{secondaryAttachments.length} files</span>
          </div>
          {secondaryEntry.content.length === 0 ? (
            <div className="muted tiny">No content yet.</div>
          ) : (
            <div className="blocks">
              {secondaryEntry.content.map((block) => (
                <div key={block.id} className="block-shell">
                  <BlockRenderer
                    block={block}
                    attachments={secondaryAttachmentMap}
                    attachmentUrls={attachmentUrls}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  ) : null

  return (
    <main className="panel editor" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()} onPaste={handlePaste}>
      {viewerMode ? viewerBar : workspaceBar}
      <div className="editor-tabs" role="tablist" aria-label="Note views">
        {tabItems.map((tab) => {
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              id={`editor-tab-${tab.id}`}
              className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => handleTabSwitch(tab.id)}
              data-testid={`editor-tab-${tab.id}`}
            >
              <tab.icon className="icon" aria-hidden="true" />
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="editor-header">
        <div className="breadcrumbs">
          <span className="pill soft">{entry.dateBucket}</span>
          {entry.tags.length > 0 ? (
            <>
              {entry.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="pill">
                  {tag}
                </span>
              ))}
              {entry.tags.length > 3 && (
                <span className="pill soft">+{entry.tags.length - 3}</span>
              )}
            </>
          ) : (
            <span className="muted tiny">No tags yet</span>
          )}
          <span className={`status-chip ${syncing || hasWork ? 'warning' : 'success'}`} data-testid="sync-status-chip">
            {syncing ? 'Syncing…' : failedCount ? `${failedCount} failed` : pendingCount ? `${pendingCount} pending` : 'Synced'}
          </span>
          <div className="spacer" />
          <button
            className="ghost"
            disabled={exporting}
            data-testid="export-pdf-btn"
            onClick={async () => {
              setExporting(true)
              try {
                await onExportEntry(entry.id, 'pdf')
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
            data-testid="export-md-btn"
            onClick={async () => {
              setExporting(true)
              try {
                await onExportEntry(entry.id, 'markdown')
              } finally {
                setExporting(false)
              }
            }}
          >
            Export MD
          </button>
          {!isEditing ? (
            <button
              className="accent"
              onClick={() => {
                onTabChange('note')
                setIsEditing(true)
              }}
              data-testid="edit-note-btn"
            >
              Edit
            </button>
          ) : (
            <div className="edit-actions">
              <button
                className="ghost"
                onClick={() => {
                  persistDraft(editorValue)
                  setIsEditing(false)
                }}
                data-testid="cancel-edit-btn"
              >
                Exit
              </button>
              <button className="accent" onClick={handleSave} data-testid="save-note-btn">
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
        </div>
      </div>
      <div className={`editor-body ${splitViewEnabled ? 'split' : ''}`}>
        {primaryPanel}
        {secondaryPanel}
      </div>
    </main>
  )
}

interface MetaPanelProps {
  entry?: Entry
  attachments: Attachment[]
  onTogglePinned: (attachmentId: string) => void
  missing: Set<string>
  attachmentUrls: Record<string, string>
  changeQueue: ChangeQueueItem[]
  syncing: boolean
  onSyncNow: () => void
  onRetryChange: (changeId: string) => void
  onClearSynced: () => void
  serverAvailable: boolean
  serverHydrated: boolean
  serverInfo: LabnoteServerInfo | null
  lastServerSync: string | null
  uploadShared: boolean
}

function TagPanel({
  entry,
  tagTemplates,
  onUpdateEntryMeta,
  onSaveTemplate,
  onDeleteTemplate,
}: {
  entry: Entry
  tagTemplates: TagTemplate[]
  onUpdateEntryMeta: (entryId: string, updates: Partial<Entry>) => void
  onSaveTemplate: (template: TagTemplate) => void
  onDeleteTemplate: (templateId: string) => void
}) {
  const [tagInput, setTagInput] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [templateError, setTemplateError] = useState<string | null>(null)

  const handleAddTag = () => {
    const cleaned = normalizeTag(tagInput)
    if (!cleaned) return
    onUpdateEntryMeta(entry.id, { tags: mergeTags(entry.tags, [cleaned]) })
    setTagInput('')
    setTemplateError(null)
  }

  const handleRemoveTag = (tag: string) => {
    onUpdateEntryMeta(entry.id, { tags: entry.tags.filter((item) => item !== tag) })
  }

  const handleApplyTemplate = (template: TagTemplate) => {
    onUpdateEntryMeta(entry.id, { tags: mergeTags(entry.tags, template.tags) })
  }

  const handleUpdateTemplate = (template: TagTemplate) => {
    if (entry.tags.length === 0) {
      setTemplateError('Add tags before updating a template.')
      return
    }
    onSaveTemplate({ ...template, tags: mergeTags(entry.tags) })
    setTemplateError(null)
  }

  const handleSaveTemplate = () => {
    const name = normalizeTag(templateName)
    if (!name) {
      setTemplateError('Template name is required.')
      return
    }
    if (entry.tags.length === 0) {
      setTemplateError('Add tags before saving a template.')
      return
    }
    const template: TagTemplate = {
      id: newId('tpl-'),
      name,
      tags: mergeTags(entry.tags),
    }
    onSaveTemplate(template)
    setTemplateName('')
    setTemplateError(null)
  }

  return (
    <section className="link-panel tag-panel">
      <div className="section-title">Tags & templates</div>
      <div className="tag-editor">
        <div className="chip-row">
          {entry.tags.map((tag) => (
            <span key={tag} className="pill soft tag-chip">
              {tag}
              <button
                type="button"
                className="icon-button"
                onClick={() => handleRemoveTag(tag)}
                aria-label={`Remove tag ${tag}`}
              >
                <X className="icon" aria-hidden="true" />
              </button>
            </span>
          ))}
          {entry.tags.length === 0 && <span className="muted tiny">No tags yet. Add your first tag below.</span>}
        </div>
        <div className="field-row">
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder="Add a tag"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              handleAddTag()
            }}
            data-testid="tag-input"
          />
          <button className="accent" type="button" onClick={handleAddTag} data-testid="tag-add-btn">
            Add
          </button>
        </div>
      </div>

      <div className="template-block">
        <div className="section-title">Templates</div>
        <div className="muted tiny" style={{ marginBottom: 8 }}>
          Save tag sets and re-apply them in one click. Use Update to overwrite a template with the current tags.
        </div>
        {tagTemplates.length === 0 && (
          <div className="muted tiny">No templates yet. Save the current tags to reuse later.</div>
        )}
        <div className="template-grid">
          {tagTemplates.map((template) => (
            <div key={template.id} className="template-card">
              <div>
                <div className="title-sm">{template.name}</div>
                {template.tags.length > 0 && (
                  <div className="chip-row">
                    {template.tags.map((tag) => (
                      <span key={tag} className="pill soft">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="template-actions">
                <button
                  className="ghost"
                  type="button"
                  onClick={() => handleApplyTemplate(template)}
                  data-testid={`template-apply-${template.id}`}
                >
                  Apply
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => handleUpdateTemplate(template)}
                  disabled={entry.tags.length === 0}
                  data-testid={`template-update-${template.id}`}
                >
                  Update
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => onDeleteTemplate(template.id)}
                  data-testid={`template-delete-${template.id}`}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="muted tiny">Save current tags as a template</span>
        <div className="field-row">
          <input
            value={templateName}
            onChange={(e) => {
              setTemplateName(e.target.value)
              setTemplateError(null)
            }}
            placeholder="Template name"
          />
          <button className="ghost" type="button" onClick={handleSaveTemplate} data-testid="template-save-btn">
            Save
          </button>
        </div>
        {templateError && <div className="field-error tiny">{templateError}</div>}
      </div>
    </section>
  )
}

function MetaPanelContent({
  entry,
  attachments,
  onTogglePinned,
  missing,
  attachmentUrls,
  changeQueue,
  syncing,
  onSyncNow,
  onRetryChange,
  onClearSynced,
  serverAvailable,
  serverHydrated,
  serverInfo,
  lastServerSync,
  uploadShared,
}: MetaPanelProps) {
  const pinned = entry?.pinnedRegions ?? []
  const serverOrigin = typeof window === 'undefined' ? '' : window.location.origin
  const formatMaybeDate = (value?: string | null) => {
    if (!value) return '—'
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : dtFormat.format(parsed)
  }
  const serverStatus = !serverHydrated ? 'Checking…' : serverAvailable ? 'Reachable' : 'Offline'

  return (
    <>
      <section>
        <div className="section-title">Pinned regions</div>
        <div className="pinned-list" data-testid="pinned-regions-list">
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
            data-testid="sync-now-btn"
          >
            {changeQueue.some((c) => c.status === 'failed') ? 'Retry failed' : 'Sync now'}
          </button>
          <button
            className="ghost"
            type="button"
            disabled={syncing || !changeQueue.some((c) => c.status === 'synced')}
            onClick={onClearSynced}
            data-testid="clear-synced-btn"
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
                  <button
                    className="pill soft"
                    type="button"
                    disabled={syncing}
                    data-testid="retry-change-btn"
                    onClick={() => onRetryChange(c.id)}
                  >
                    Retry
                  </button>
                )}
              </div>
              {c.lastError && <div className="muted tiny text-warning" style={{ marginTop: 8 }}>{c.lastError}</div>}
            </div>
          ))}
          {changeQueue.length === 0 && <div className="muted tiny">No local changes queued.</div>}
        </div>
      </section>

      <section>
        <div className="section-title">Mobile sync check</div>
        <div className="meta-card sync-check" data-testid="mobile-sync-check">
          <div className="sync-row">
            <span className="muted tiny">Server status</span>
            <span className={`status-chip ${serverAvailable ? 'success' : 'warning'}`}>{serverStatus}</span>
          </div>
          <div className="sync-row">
            <span className="muted tiny">Server URL</span>
            <span className="title-sm">{serverOrigin || '—'}</span>
          </div>
          <div className="sync-row">
            <span className="muted tiny">Shared upload</span>
            <span className={`pill soft ${uploadShared && serverAvailable ? 'active-pill' : ''}`}>
              {uploadShared ? 'On' : 'Off'}
            </span>
          </div>
          <div className="sync-row">
            <span className="muted tiny">Last sync (this client)</span>
            <span className="muted tiny">{formatMaybeDate(lastServerSync)}</span>
          </div>
          <div className="sync-row">
            <span className="muted tiny">Server state updated</span>
            <span className="muted tiny">{formatMaybeDate(serverInfo?.stateUpdatedAt)}</span>
          </div>
          <div className="sync-row">
            <span className="muted tiny">Uploads endpoint</span>
            <span className="muted tiny">{serverInfo?.uploadsUrl ?? '/labnote-uploads/'}</span>
          </div>
          <div className="sync-row">
            <span className="muted tiny">Data folder</span>
            <span className="muted tiny">{serverInfo?.dataDir ?? '—'}</span>
          </div>
        </div>
        <div className="muted tiny">
          Open this URL on mobile to connect to the same server instance.
        </div>
      </section>

      <section>
        <div className="section-title">Backlinks</div>
        <div className="muted tiny">Will list entries mentioning this experiment or sample IDs.</div>
      </section>
    </>
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
        {missing && <p className="muted tiny text-warning">Cached blob missing</p>}
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
  const style = getBlockStyle((element as { align?: unknown }).align, (element as { indent?: unknown }).indent)
  const locked = element.locked === true
  switch (element.type) {
    case 'heading-two':
      return (
        <h2 className={`block-heading h2${locked ? ' locked-block' : ''}`} {...attributes} style={style}>
          {children}
        </h2>
      )
    case 'heading-three':
      return (
        <h3 className={`block-heading h3${locked ? ' locked-block' : ''}`} {...attributes} style={style}>
          {children}
        </h3>
      )
    case 'quote':
      return (
        <blockquote className="quote" {...attributes} style={style}>
          {children}
        </blockquote>
      )
    case 'bulleted-list':
      return (
        <ul className="list-block list-bulleted" {...attributes} style={style}>
          {children}
        </ul>
      )
    case 'numbered-list':
      return (
        <ol className="list-block list-numbered" {...attributes} style={style}>
          {children}
        </ol>
      )
    case 'list-item':
      return (
        <li className="list-item" {...attributes}>
          {children}
        </li>
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
  const superscript = (leaf as unknown as { superscript?: boolean }).superscript === true
  const subscript = (leaf as unknown as { subscript?: boolean }).subscript === true
  const font = isFontStyle((leaf as unknown as { font?: unknown }).font)
    ? ((leaf as unknown as { font?: FontStyle }).font as FontStyle)
    : undefined
  const fontSize = isFontSize((leaf as unknown as { fontSize?: unknown }).fontSize)
    ? ((leaf as unknown as { fontSize?: FontSize }).fontSize as FontSize)
    : undefined
  const color = normalizeColor((leaf as unknown as { color?: unknown }).color)
  const highlight = normalizeColor((leaf as unknown as { highlight?: unknown }).highlight)
  const style: React.CSSProperties = {}
  if (font) style.fontFamily = FONT_STYLE_MAP[font]
  if (fontSize) style.fontSize = `${fontSize}px`
  if (color) style.color = color
  if (highlight) {
    style.backgroundColor = highlight
    style.padding = '0 2px'
    style.borderRadius = '2px'
    style.boxDecorationBreak = 'clone'
  }
  const hasStyle = Object.keys(style).length > 0
  if (superscript) {
    content = <sup>{content}</sup>
  } else if (subscript) {
    content = <sub>{content}</sub>
  }
  return (
    <span {...attributes} style={hasStyle ? style : undefined}>
      {content}
    </span>
  )
}

type MarkFormat = 'bold' | 'italic' | 'underline'
type ScriptFormat = 'superscript' | 'subscript'
type FontStyle = 'body' | 'display' | 'mono'
type FontSize = 12 | 14 | 16 | 18 | 20 | 24 | 28
type TextAlign = 'left' | 'center' | 'right' | 'justify'

const FONT_STYLE_MAP: Record<FontStyle, string> = {
  body: 'var(--font-body)',
  display: 'var(--font-display)',
  mono: 'var(--font-mono)',
}

const FONT_STYLE_EXPORT_MAP: Record<FontStyle, string> = {
  body: "'Space Grotesk', 'Segoe UI', system-ui, -apple-system, sans-serif",
  display: "'Chakra Petch', 'Space Grotesk', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
}

const FONT_SIZE_OPTIONS: FontSize[] = [12, 14, 16, 18, 20, 24, 28]
const DEFAULT_FONT_SIZE: FontSize = 16
const FONT_COLOR_SWATCHES = ['#0f172a', '#1d4ed8', '#0f766e', '#b45309', '#b91c1c', '#7c3aed']
const DEFAULT_HIGHLIGHT = '#fef08a'
const HIGHLIGHT_SWATCHES = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca', '#fed7aa', '#e9d5ff']

function isTextAlignValue(value: unknown): value is TextAlign {
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify'
}

function isFontStyle(value: unknown): value is FontStyle {
  return value === 'body' || value === 'display' || value === 'mono'
}

function isFontSize(value: unknown): value is FontSize {
  return typeof value === 'number' && FONT_SIZE_OPTIONS.includes(value as FontSize)
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed) || /^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed
  return undefined
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

function isScriptActive(editor: ReactEditor, format: ScriptFormat): boolean {
  const marks = Editor.marks(editor) as Record<string, unknown> | null
  return marks?.[format] === true
}

function toggleScript(editor: ReactEditor, format: ScriptFormat) {
  const other: ScriptFormat = format === 'superscript' ? 'subscript' : 'superscript'
  if (isScriptActive(editor, format)) {
    Editor.removeMark(editor, format)
  } else {
    Editor.removeMark(editor, other)
    Editor.addMark(editor, format, true)
  }
}

function getActiveFont(editor: ReactEditor): FontStyle {
  const marks = Editor.marks(editor) as Record<string, unknown> | null
  const current = marks?.font
  return isFontStyle(current) ? current : 'body'
}

function setFontMark(editor: ReactEditor, font: FontStyle) {
  if (font === 'body') {
    Editor.removeMark(editor, 'font')
  } else {
    Editor.addMark(editor, 'font', font)
  }
}

function getActiveFontSize(editor: ReactEditor): FontSize {
  const marks = Editor.marks(editor) as Record<string, unknown> | null
  const current = marks?.fontSize
  return isFontSize(current) ? current : DEFAULT_FONT_SIZE
}

function setFontSizeMark(editor: ReactEditor, size: FontSize) {
  if (size === DEFAULT_FONT_SIZE) {
    Editor.removeMark(editor, 'fontSize')
  } else {
    Editor.addMark(editor, 'fontSize', size)
  }
}

function getActiveColor(editor: ReactEditor): string {
  const marks = Editor.marks(editor) as Record<string, unknown> | null
  return normalizeColor(marks?.color) ?? '#0f172a'
}

function setColorMark(editor: ReactEditor, color: string) {
  const normalized = normalizeColor(color)
  if (!normalized || normalized === '#0f172a') {
    Editor.removeMark(editor, 'color')
  } else {
    Editor.addMark(editor, 'color', normalized)
  }
}

function clearColorMark(editor: ReactEditor) {
  Editor.removeMark(editor, 'color')
}

function getActiveHighlight(editor: ReactEditor): string {
  const marks = Editor.marks(editor) as Record<string, unknown> | null
  return normalizeColor(marks?.highlight) ?? DEFAULT_HIGHLIGHT
}

function setHighlightMark(editor: ReactEditor, color: string) {
  const normalized = normalizeColor(color)
  if (!normalized) {
    Editor.removeMark(editor, 'highlight')
  } else {
    Editor.addMark(editor, 'highlight', normalized)
  }
}

function toggleHighlight(editor: ReactEditor, color: string) {
  const normalized = normalizeColor(color)
  if (!normalized) {
    Editor.removeMark(editor, 'highlight')
    return
  }
  const marks = Editor.marks(editor) as Record<string, unknown> | null
  const current = normalizeColor(marks?.highlight)
  if (current === normalized) {
    Editor.removeMark(editor, 'highlight')
  } else {
    Editor.addMark(editor, 'highlight', normalized)
  }
}

function clearHighlightMark(editor: ReactEditor) {
  Editor.removeMark(editor, 'highlight')
}

function getActiveBlockEntry(editor: ReactEditor): [SlateElement, Path] | null {
  const entry = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && typeof (n as { blockId?: unknown }).blockId === 'string',
  })
  return entry ? (entry as [SlateElement, Path]) : null
}

const ALIGNABLE_TYPES = new Set([
  'paragraph',
  'heading-two',
  'heading-three',
  'quote',
  'checklist',
  'bulleted-list',
  'numbered-list',
])
const INDENTABLE_TYPES = new Set(['paragraph', 'heading-two', 'heading-three', 'quote', 'checklist'])
const LIST_TYPES = new Set(['bulleted-list', 'numbered-list'])
const INDENT_STEP = 1
const MAX_INDENT = 6
const INDENT_PX = 24

function getBlockStyle(align?: unknown, indent?: unknown): React.CSSProperties | undefined {
  const style: React.CSSProperties = {}
  if (isTextAlignValue(align)) style.textAlign = align
  if (typeof indent === 'number' && indent > 0) {
    style.marginLeft = `${indent * INDENT_PX}px`
  }
  return Object.keys(style).length ? style : undefined
}

function getActiveAlign(editor: ReactEditor): TextAlign {
  const entry = getActiveBlockEntry(editor)
  const align = entry ? (entry[0] as { align?: unknown }).align : undefined
  return isTextAlignValue(align) ? align : 'left'
}

function setAlign(editor: ReactEditor, align: TextAlign) {
  const value = align === 'left' ? undefined : align
  Transforms.setNodes(
    editor,
    { align: value },
    {
      match: (n) => SlateElement.isElement(n) && ALIGNABLE_TYPES.has(String((n as { type?: unknown }).type)),
      split: true,
    }
  )
}

function getActiveIndent(editor: ReactEditor): number {
  const entry = getActiveBlockEntry(editor)
  const indent = entry ? (entry[0] as { indent?: unknown }).indent : undefined
  return typeof indent === 'number' && indent > 0 ? indent : 0
}

function setIndent(editor: ReactEditor, nextIndent: number) {
  const clamped = Math.max(0, Math.min(MAX_INDENT, nextIndent))
  Transforms.setNodes(
    editor,
    { indent: clamped === 0 ? undefined : clamped },
    {
      match: (n) => SlateElement.isElement(n) && INDENTABLE_TYPES.has(String((n as { type?: unknown }).type)),
      split: true,
    }
  )
}

function indentListItem(editor: ReactEditor, listType: 'bulleted-list' | 'numbered-list') {
  const itemEntry = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && n.type === 'list-item',
  }) as [SlateElement, Path] | undefined
  if (!itemEntry) return
  const [, itemPath] = itemEntry
  if (itemPath[itemPath.length - 1] === 0) return
  const listEntry = Editor.parent(editor, itemPath) as [SlateElement, Path] | undefined
  if (!listEntry) return
  const [listNode] = listEntry
  if (!SlateElement.isElement(listNode) || !LIST_TYPES.has(String(listNode.type))) return

  const prevItemPath = Path.previous(itemPath)
  const prevItemEntry = Editor.node(editor, prevItemPath) as [SlateElement, Path]
  const [prevItem] = prevItemEntry
  if (!SlateElement.isElement(prevItem) || prevItem.type !== 'list-item') return

  let nestedListPath = prevItemPath.concat(prevItem.children.length)
  const lastChild = prevItem.children[prevItem.children.length - 1]
  if (SlateElement.isElement(lastChild) && LIST_TYPES.has(String(lastChild.type))) {
    nestedListPath = prevItemPath.concat(prevItem.children.length - 1)
  } else {
    const newList: Descendant = { type: listType, children: [] }
    Transforms.insertNodes(editor, newList, { at: nestedListPath })
  }

  const nestedListEntry = Editor.node(editor, nestedListPath) as [SlateElement, Path]
  const nestedListNode = nestedListEntry[0]
  if (!SlateElement.isElement(nestedListNode)) return
  const targetPath = nestedListPath.concat(nestedListNode.children.length)
  Transforms.moveNodes(editor, { at: itemPath, to: targetPath })
}

function outdentListItem(editor: ReactEditor) {
  const itemEntry = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && n.type === 'list-item',
  }) as [SlateElement, Path] | undefined
  if (!itemEntry) return
  const [, itemPath] = itemEntry
  const parentListEntry = Editor.parent(editor, itemPath) as [SlateElement, Path] | undefined
  if (!parentListEntry) return
  const [, listPath] = parentListEntry
  const parentItemEntry = Editor.parent(editor, listPath) as [SlateElement, Path] | undefined
  if (!parentItemEntry) return
  const [parentItem, parentItemPath] = parentItemEntry
  if (!SlateElement.isElement(parentItem) || parentItem.type !== 'list-item') return
  const outerListEntry = Editor.parent(editor, parentItemPath) as [SlateElement, Path] | undefined
  if (!outerListEntry) return

  const targetPath = Path.next(parentItemPath)
  Transforms.moveNodes(editor, { at: itemPath, to: targetPath })

  const parentListNode = parentListEntry[0]
  if (SlateElement.isElement(parentListNode) && parentListNode.children.length === 1) {
    Transforms.removeNodes(editor, { at: listPath })
  }
}

function getActiveListType(editor: ReactEditor): 'bulleted-list' | 'numbered-list' | null {
  const entry = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && LIST_TYPES.has(String((n as { type?: unknown }).type)),
  })
  if (!entry) return null
  const element = entry[0]
  if (!SlateElement.isElement(element)) return null
  return element.type === 'numbered-list' ? 'numbered-list' : 'bulleted-list'
}

function toggleList(editor: ReactEditor, listType: 'bulleted-list' | 'numbered-list') {
  const isActive = getActiveListType(editor) === listType
  Transforms.unwrapNodes(editor, {
    match: (n) => SlateElement.isElement(n) && LIST_TYPES.has(String((n as { type?: unknown }).type)),
    split: true,
  })
  const isTextBlockType = (value: unknown) =>
    value === 'paragraph' || value === 'heading-two' || value === 'heading-three' || value === 'quote'
  Transforms.setNodes(
    editor,
    { type: isActive ? 'paragraph' : 'list-item' },
    { match: (n) => SlateElement.isElement(n) && isTextBlockType(n.type), split: true }
  )

  if (!isActive) {
    const list: Descendant = { type: listType, blockId: newId('b-'), children: [] }
    Transforms.wrapNodes(editor, list, {
      match: (n) => SlateElement.isElement(n) && n.type === 'list-item',
    })
  }
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
              placeholder="e.g. \\\\fileserver\\labshare\\2025-12-17\\run1.csv"
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
  uploadShared,
  onToggleUploadShared,
  serverAvailable,
  serverHydrated,
}: {
  entryId: string
  onAddAttachments: (entryId: string, files: File[]) => Promise<Attachment[]>
  onAddFileDestination: (entryId: string, val: { path: string; label?: string }) => Attachment
  uploadShared: boolean
  onToggleUploadShared: () => void
  serverAvailable: boolean
  serverHydrated: boolean
}) {
  const editor = useSlate()
  const imgRef = useRef<HTMLInputElement | null>(null)
  const cameraRef = useRef<HTMLInputElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [destOpen, setDestOpen] = useState(false)
  const activeFont = getActiveFont(editor)
  const activeFontSize = getActiveFontSize(editor)
  const activeColor = getActiveColor(editor)
  const activeHighlight = getActiveHighlight(editor)
  const activeAlign = getActiveAlign(editor)
  const activeList = getActiveListType(editor)
  const isSuperscript = isScriptActive(editor, 'superscript')
  const isSubscript = isScriptActive(editor, 'subscript')

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
          <label className="toolbar-label">
            Font
            <select
              value={activeFont}
              onChange={(event) => setFontMark(editor, event.target.value as FontStyle)}
              data-testid="editor-font-select"
            >
              <option value="body">Body</option>
              <option value="display">Display</option>
              <option value="mono">Mono</option>
            </select>
          </label>
          <label className="toolbar-label">
            Size
            <select
              value={activeFontSize}
              onChange={(event) => setFontSizeMark(editor, Number(event.target.value) as FontSize)}
              data-testid="editor-font-size"
            >
              {FONT_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </label>
          <label className="toolbar-label">
            Color
            <input
              type="color"
              value={activeColor}
              onChange={(event) => setColorMark(editor, event.target.value)}
              data-testid="editor-font-color"
            />
          </label>
          <button
            className="pill soft"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => clearColorMark(editor)}
            data-testid="editor-color-clear"
          >
            Clear
          </button>
          <div className="color-swatches">
            {FONT_COLOR_SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className="color-swatch"
                style={{ backgroundColor: swatch }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setColorMark(editor, swatch)}
                aria-label={`Set color ${swatch}`}
              />
            ))}
          </div>
          <label className="toolbar-label">
            Highlight
            <input
              type="color"
              value={activeHighlight}
              onChange={(event) => setHighlightMark(editor, event.target.value)}
              data-testid="editor-highlight-color"
            />
          </label>
          <button
            className="pill soft"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => clearHighlightMark(editor)}
            data-testid="editor-highlight-clear"
          >
            Clear HL
          </button>
          <div className="color-swatches">
            {HIGHLIGHT_SWATCHES.map((swatch, idx) => (
              <button
                key={swatch}
                type="button"
                className="color-swatch"
                style={{ backgroundColor: swatch }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleHighlight(editor, swatch)}
                aria-label={`Set highlight ${swatch}`}
                data-testid={`editor-highlight-swatch-${idx}`}
              />
            ))}
          </div>
          <button
            className={`pill soft ${isMarkActive(editor, 'bold') ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMark(editor, 'bold')}
            aria-label="Bold"
            data-testid="editor-bold"
          >
            B
          </button>
          <button
            className={`pill soft ${isMarkActive(editor, 'italic') ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMark(editor, 'italic')}
            aria-label="Italic"
            data-testid="editor-italic"
          >
            I
          </button>
          <button
            className={`pill soft ${isMarkActive(editor, 'underline') ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMark(editor, 'underline')}
            aria-label="Underline"
            data-testid="editor-underline"
          >
            U
          </button>
          <button
            className={`pill soft ${isSuperscript ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleScript(editor, 'superscript')}
            aria-label="Superscript"
            data-testid="editor-superscript"
          >
            Sup
          </button>
          <button
            className={`pill soft ${isSubscript ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleScript(editor, 'subscript')}
            aria-label="Subscript"
            data-testid="editor-subscript"
          >
            Sub
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button
            className={`pill soft ${activeAlign === 'left' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'left')}
            aria-label="Align left"
            data-testid="editor-align-left"
          >
            Left
          </button>
          <button
            className={`pill soft ${activeAlign === 'center' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'center')}
            aria-label="Align center"
            data-testid="editor-align-center"
          >
            Center
          </button>
          <button
            className={`pill soft ${activeAlign === 'right' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'right')}
            aria-label="Align right"
            data-testid="editor-align-right"
          >
            Right
          </button>
          <button
            className={`pill soft ${activeAlign === 'justify' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'justify')}
            aria-label="Justify"
            data-testid="editor-align-justify"
          >
            Justify
          </button>
          <button
            className="pill soft"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const activeList = getActiveListType(editor)
              if (activeList) {
                indentListItem(editor, activeList)
              } else {
                setIndent(editor, getActiveIndent(editor) + INDENT_STEP)
              }
            }}
            aria-label="Indent"
            data-testid="editor-indent"
          >
            Indent
          </button>
          <button
            className="pill soft"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const activeList = getActiveListType(editor)
              if (activeList) {
                outdentListItem(editor)
              } else {
                setIndent(editor, getActiveIndent(editor) - INDENT_STEP)
              }
            }}
            aria-label="Outdent"
            data-testid="editor-outdent"
          >
            Outdent
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button
            className={`pill soft ${activeList === 'bulleted-list' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleList(editor, 'bulleted-list')}
            aria-label="Bulleted list"
            data-testid="editor-list-bulleted"
          >
            • List
          </button>
          <button
            className={`pill soft ${activeList === 'numbered-list' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleList(editor, 'numbered-list')}
            aria-label="Numbered list"
            data-testid="editor-list-numbered"
          >
            1. List
          </button>
        </div>

        <div className="toolbar-sep" />

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
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cameraRef.current?.click()}>
            + Camera
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

        {serverHydrated && (
          <>
            <div className="toolbar-sep" />
            <div className="toolbar-group">
              <button
                className={`pill soft ${uploadShared && serverAvailable ? 'active-pill' : ''}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onToggleUploadShared}
                disabled={!serverAvailable}
                data-testid="upload-shared-toggle"
              >
                Shared upload
              </button>
            </div>
          </>
        )}
      </div>

      <input
        ref={imgRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        data-testid="editor-image-input"
        onChange={(e) => {
          void pickAndInsert(e.target.files)
          e.currentTarget.value = ''
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        data-testid="editor-camera-input"
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
        data-testid="editor-file-input"
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
  const style = getBlockStyle((element as { align?: unknown }).align, (element as { indent?: unknown }).indent)

  return (
    <div className="checklist" {...attributes} style={style}>
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
      (prev.underline ?? false) === (run.underline ?? false) &&
      (prev.superscript ?? false) === (run.superscript ?? false) &&
      (prev.subscript ?? false) === (run.subscript ?? false) &&
      (prev.font ?? 'body') === (run.font ?? 'body') &&
      (prev.fontSize ?? DEFAULT_FONT_SIZE) === (run.fontSize ?? DEFAULT_FONT_SIZE) &&
      (prev.color ?? '') === (run.color ?? '') &&
      (prev.highlight ?? '') === (run.highlight ?? '')

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
        superscript: (child as unknown as { superscript?: boolean }).superscript === true ? true : undefined,
        subscript: (child as unknown as { subscript?: boolean }).subscript === true ? true : undefined,
        font: isFontStyle((child as unknown as { font?: unknown }).font)
          ? ((child as unknown as { font?: FontStyle }).font as FontStyle)
          : undefined,
        fontSize: isFontSize((child as unknown as { fontSize?: unknown }).fontSize)
          ? ((child as unknown as { fontSize?: FontSize }).fontSize as FontSize)
          : undefined,
        color: normalizeColor((child as unknown as { color?: unknown }).color),
        highlight: normalizeColor((child as unknown as { highlight?: unknown }).highlight),
      })
      continue
    }

    // Fallback (should be rare for this prototype): flatten nested nodes to plain text.
    raw.push({ text: Node.string(child) })
  }

  const merged = mergeRuns(raw)
  const hasFormatting =
    merged.some((r) =>
      r.bold ||
      r.italic ||
      r.underline ||
      r.superscript ||
      r.subscript ||
      r.font ||
      r.fontSize ||
      r.color ||
      r.highlight
    ) || merged.length > 1
  return hasFormatting ? merged : undefined
}

function slateTextChildrenFromRuns(runs: TextRun[] | undefined, fallbackText: string): Descendant[] {
  if (runs && runs.length) {
    return runs.map((r) => ({
      text: r.text,
      bold: r.bold === true ? true : undefined,
      italic: r.italic === true ? true : undefined,
      underline: r.underline === true ? true : undefined,
      superscript: r.superscript === true ? true : undefined,
      subscript: r.subscript === true ? true : undefined,
      font: r.font,
      fontSize: r.fontSize,
      color: r.color,
      highlight: r.highlight,
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
    if (run.superscript) {
      node = <sup>{node}</sup>
    } else if (run.subscript) {
      node = <sub>{node}</sub>
    }
    const style: React.CSSProperties = {}
    if (run.font) style.fontFamily = FONT_STYLE_MAP[run.font]
    if (run.fontSize) style.fontSize = `${run.fontSize}px`
    if (run.color) style.color = run.color
    if (run.highlight) {
      style.backgroundColor = run.highlight
      style.padding = '0 2px'
      style.borderRadius = '2px'
      style.boxDecorationBreak = 'clone'
    }
    const hasStyle = Object.keys(style).length > 0
    return (
      <span key={idx} style={hasStyle ? style : undefined}>
        {node}
      </span>
    )
  })
}

const listItemsToSlate = (items: ListItem[], listType: 'bulleted-list' | 'numbered-list'): Descendant[] =>
  items.map((item) => {
    const children: Descendant[] = slateTextChildrenFromRuns(item.runs, item.text)
    if (item.children?.length) {
      children.push({ type: listType, children: listItemsToSlate(item.children, listType) })
    }
    return {
      type: 'list-item',
      itemId: item.id,
      children,
    }
  })

const blocksToSlate = (blocks: Block[]): Descendant[] => {
  return blocks.map((block) => {
    switch (block.type) {
      case 'heading':
        return {
          type: block.level === 3 ? 'heading-three' : 'heading-two',
          blockId: block.id,
          locked: block.locked === true,
          align: block.align,
          indent: block.indent,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'paragraph':
        return {
          type: 'paragraph',
          blockId: block.id,
          align: block.align,
          indent: block.indent,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'quote':
        return {
          type: 'quote',
          blockId: block.id,
          align: block.align,
          indent: block.indent,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'checklist':
        return {
          type: 'checklist',
          blockId: block.id,
          align: block.align,
          indent: block.indent,
          children: block.items.map((item) => ({
            type: 'check-item',
            itemId: item.id,
            done: item.done,
            children: slateTextChildrenFromRuns(item.runs, item.text),
          })),
        }
      case 'list':
        return {
          type: block.ordered ? 'numbered-list' : 'bulleted-list',
          blockId: block.id,
          align: block.align,
          indent: block.indent,
          children: listItemsToSlate(block.items, block.ordered ? 'numbered-list' : 'bulleted-list'),
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

const listItemsFromSlate = (listNode: SlateElement): ListItem[] => {
  return (listNode.children as Descendant[])
    .filter((child): child is SlateElement => SlateElement.isElement(child))
    .filter((child) => child.type === 'list-item')
    .map((child) => {
      const textChildren = (child.children as Descendant[]).filter(
        (c) => !(SlateElement.isElement(c) && LIST_TYPES.has(String(c.type)))
      )
      const nestedList = (child.children as Descendant[]).find(
        (c) => SlateElement.isElement(c) && LIST_TYPES.has(String(c.type))
      ) as SlateElement | undefined
      const runs = runsFromSlateChildren(textChildren as Descendant[])
      const text = textChildren.map((c) => (Text.isText(c) ? c.text : Node.string(c))).join('')
      return {
        id: typeof child.itemId === 'string' ? child.itemId : newId('li-'),
        text,
        runs,
        children: nestedList ? listItemsFromSlate(nestedList) : undefined,
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
          indent: typeof node.indent === 'number' ? node.indent : undefined,
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
          indent: typeof node.indent === 'number' ? node.indent : undefined,
          text: Node.string(node),
          runs: runsFromSlateChildren(node.children as unknown as Descendant[]),
        }
      case 'quote':
        return {
          id: ensureId(blockId),
          type: 'quote',
          align,
          indent: typeof node.indent === 'number' ? node.indent : undefined,
          text: Node.string(node),
          runs: runsFromSlateChildren(node.children as unknown as Descendant[]),
        }
      case 'checklist':
        return {
          id: ensureId(blockId),
          type: 'checklist',
          align,
          indent: typeof node.indent === 'number' ? node.indent : undefined,
          items: (node.children as unknown as Descendant[])
            .filter((child): child is SlateElement => SlateElement.isElement(child))
            .map((child) => ({
              id: typeof child.itemId === 'string' ? child.itemId : newId('ci-'),
              text: Node.string(child),
              done: child.done === true,
              runs: runsFromSlateChildren(child.children as unknown as Descendant[]),
            })),
        }
      case 'bulleted-list':
      case 'numbered-list':
        return {
          id: ensureId(blockId),
          type: 'list',
          ordered: node.type === 'numbered-list',
          align,
          indent: typeof node.indent === 'number' ? node.indent : undefined,
          items: listItemsFromSlate(node),
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
          indent: typeof (node as { indent?: unknown }).indent === 'number' ? (node as { indent?: number }).indent : undefined,
          text: Node.string(node),
          runs: runsFromSlateChildren(node.children as unknown as Descendant[]),
        }
    }
  })
}

function BlockRenderer({ block, attachments, attachmentUrls, onUpdateBlock }: BlockRendererProps) {
  const style = getBlockStyle(block.align, block.indent)
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
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      const renderItems = (items: ListItem[]) =>
        items.map((item) => (
          <li key={item.id} className="list-item">
            {renderTextRuns(item.runs, item.text)}
            {item.children?.length ? (
              <Tag className="list-block nested">
                {renderItems(item.children)}
              </Tag>
            ) : null}
          </li>
        ))
      return (
        <Tag className="list-block" style={style}>
          {renderItems(block.items)}
        </Tag>
      )
    }
    case 'table': {
      const hasHeader = block.header !== false
      const striped = block.striped === true
      const compact = block.compact === true
      return (
        <div className={`table-wrap${striped ? ' table-striped' : ''}${compact ? ' table-compact' : ''}`} style={style}>
          {onUpdateBlock && (
            <div className="table-controls" contentEditable={false}>
              <button
                type="button"
                className={`pill soft ${hasHeader ? 'active-pill' : ''}`}
                onClick={() => onUpdateBlock({ ...block, header: hasHeader ? false : true })}
                data-testid="table-header-toggle"
              >
                Header row
              </button>
              <button
                type="button"
                className={`pill soft ${striped ? 'active-pill' : ''}`}
                onClick={() => onUpdateBlock({ ...block, striped: !striped })}
                data-testid="table-striped-toggle"
              >
                Striped
              </button>
              <button
                type="button"
                className={`pill soft ${compact ? 'active-pill' : ''}`}
                onClick={() => onUpdateBlock({ ...block, compact: !compact })}
                data-testid="table-compact-toggle"
              >
                Compact
              </button>
              <div className="table-align">
                <button
                  type="button"
                  className={`pill soft ${block.align === 'left' || !block.align ? 'active-pill' : ''}`}
                  onClick={() => onUpdateBlock({ ...block, align: undefined })}
                >
                  Left
                </button>
                <button
                  type="button"
                  className={`pill soft ${block.align === 'center' ? 'active-pill' : ''}`}
                  onClick={() => onUpdateBlock({ ...block, align: 'center' })}
                >
                  Center
                </button>
                <button
                  type="button"
                  className={`pill soft ${block.align === 'right' ? 'active-pill' : ''}`}
                  onClick={() => onUpdateBlock({ ...block, align: 'right' })}
                >
                  Right
                </button>
              </div>
            </div>
          )}
          <table>
            <tbody>
              {block.data.map((row, idx) => (
                <tr key={idx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className={hasHeader && idx === 0 ? 'th' : ''}>
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

export default App

function NewEntryModal({
  onClose,
  tagTemplates,
  onCreate,
}: {
  onClose: () => void
  tagTemplates: TagTemplate[]
  onCreate: (val: { title?: string; templateId: EntryTemplateId; tags?: string[] }) => void
}) {
  const [title, setTitle] = useState('')
  const [templateId, setTemplateId] = useState<EntryTemplateId>('experiment')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
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

  const handleAddTag = () => {
    const cleaned = normalizeTag(tagInput)
    if (!cleaned) return
    setTags((prev) => mergeTags(prev, [cleaned]))
    setTagInput('')
  }

  const handleRemoveTag = (tag: string) => {
    setTags((prev) => prev.filter((item) => item !== tag))
  }

  const handleApplyTemplate = (template: TagTemplate) => {
    setTags((prev) => mergeTags(prev, template.tags))
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="title-sm">New entry</div>
            <div className="muted tiny">Pick a template and add tags.</div>
          </div>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        <div className="modal-grid">
          <label className="field">
            <span className="muted tiny">Title</span>
            <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled note" />
          </label>

          <div className="field">
            <span className="muted tiny">Tags</span>
            <div className="chip-row">
              {tags.map((tag) => (
                <span key={tag} className="pill soft tag-chip">
                  {tag}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => handleRemoveTag(tag)}
                  >
                    <X className="icon" aria-hidden="true" />
                  </button>
                </span>
              ))}
              {tags.length === 0 && <span className="muted tiny">No tags yet.</span>}
            </div>
            <div className="field-row">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Add a tag"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  handleAddTag()
                }}
              />
              <button className="ghost" type="button" onClick={handleAddTag}>
                Add
              </button>
            </div>
          </div>

          <div className="field">
            <span className="muted tiny">Templates</span>
            {tagTemplates.length === 0 ? (
              <div className="muted tiny">No templates saved yet.</div>
            ) : (
              <div className="chip-row">
                {tagTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="pill soft"
                    onClick={() => handleApplyTemplate(template)}
                    data-testid={`new-entry-template-${template.id}`}
                  >
                    {template.name}
                  </button>
                ))}
              </div>
            )}
            <div className="muted tiny" style={{ marginTop: 6 }}>
              Manage templates in the Details tab of any entry.
            </div>
          </div>

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
                templateId,
                tags,
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


function SettingsModal({
  onClose,
  fsEnabled,
  fsNeedsPermission,
  fsSupported,
  onEnable,
  onPickDir,
  onDisconnect,
  onValidate,
}: {
  onClose: () => void
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
            <div className={`muted tiny ${validation.ok ? 'text-success' : 'text-warning'}`} style={{ marginTop: 10 }}>
              {validation.ok ? 'Disk cache looks good.' : `Disk cache error: ${validation.message ?? 'Unknown error'}`}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Done</button>
        </div>
      </div>
    </div>
  )
}
