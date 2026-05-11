import type React from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createEditor, Editor, Element as SlateElement, Node, Path, Range, Text, Transforms } from 'slate'
import { HistoryEditor, withHistory } from 'slate-history'
import type { Descendant } from 'slate'
import { Slate, Editable, withReact, ReactEditor, useSlateStatic } from 'slate-react'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import type { RenderElementProps, RenderLeafProps } from 'slate-react'
import { toDataURL as toQrDataUrl } from 'qrcode'
import { cacheFile, getCachedFile } from './idb'
import { writeFileToCache, restoreCacheHandle, ensureCacheDir, pickCacheDir, clearCacheHandle } from './fileCache'
import { GuidedTutorial, type TutorialStep } from './GuidedTutorial'
import './App.css'
import logoMark from './assets/logo.svg'
import { sampleData, seedVersion } from './data/sampleData'
import type {
  Attachment,
  Block,
  Entry,
  Experiment,
  Project,
  Protocol,
  ChecklistItem,
  ListItem,
  PinnedRegion,
  TextRun,
  ThemeName,
  ListStyle,
  WorkbookCellStyle,
} from './domain/types'

const dateOnly = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

const APP_NAME = 'Easylab'
const APP_OWNER = 'Meghamsh Teja'
const APP_GITHUB_URL = 'https://github.com/meghamsh738'
const APP_SETUP_KEY = 'labnote.setupComplete'
const APP_PATHS_KEY = 'labnote.appPaths'
const APP_MOBILE_PAIR_LINK_KEY = 'labnote.mobilePairLink'
const SHARED_API_PREFIX = '/labnote-api'
const SHARED_API_INFO_URL = `${SHARED_API_PREFIX}/info`
const SHARED_API_STATE_URL = `${SHARED_API_PREFIX}/state`
const SHARED_API_UPLOAD_URL = `${SHARED_API_PREFIX}/upload`
const SHARED_STATE_VERSION = 1

type AppPaths = {
  dataRoot: string
  attachmentsRoot: string
  exportRoot: string
  syncRoot: string
}

type DateRange = {
  start: string
  end: string
}

type UiIconName =
  | 'alert'
  | 'book'
  | 'camera'
  | 'check'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronUp'
  | 'download'
  | 'edit'
  | 'file'
  | 'folder'
  | 'image'
  | 'layout'
  | 'list'
  | 'minus'
  | 'note'
  | 'paperclip'
  | 'plus'
  | 'refresh'
  | 'save'
  | 'settings'
  | 'spark'
  | 'tag'
  | 'table'
  | 'trash'
  | 'x'

function UiIcon({ name, className, title }: { name: UiIconName; className?: string; title?: string }) {
  const common = {
    className: ['ui-icon', className].filter(Boolean).join(' '),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': title ? undefined : true,
    role: title ? 'img' : undefined,
  }

  const titleNode = title ? <title>{title}</title> : null
  switch (name) {
    case 'alert':
      return <svg {...common}>{titleNode}<path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 4.3 2.8 18a1.6 1.6 0 0 0 1.4 2.3h15.6a1.6 1.6 0 0 0 1.4-2.3L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" /></svg>
    case 'book':
      return <svg {...common}>{titleNode}<path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h12v16H7a2.5 2.5 0 0 0-2.5 2.5v-16Z" /><path d="M7 3v16" /><path d="M10 7h6" /><path d="M10 11h5" /></svg>
    case 'camera':
      return <svg {...common}>{titleNode}<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.2-2h5l1.2 2h1.8A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z" /><circle cx="12" cy="12.5" r="3" /></svg>
    case 'check':
      return <svg {...common}>{titleNode}<path d="m5 12.5 4.2 4.2L19 7" /></svg>
    case 'chevronDown':
      return <svg {...common}>{titleNode}<path d="m6 9 6 6 6-6" /></svg>
    case 'chevronLeft':
      return <svg {...common}>{titleNode}<path d="m15 18-6-6 6-6" /></svg>
    case 'chevronRight':
      return <svg {...common}>{titleNode}<path d="m9 18 6-6-6-6" /></svg>
    case 'chevronUp':
      return <svg {...common}>{titleNode}<path d="m18 15-6-6-6 6" /></svg>
    case 'download':
      return <svg {...common}>{titleNode}<path d="M12 4v10" /><path d="m7.5 10 4.5 4.5L16.5 10" /><path d="M5 20h14" /></svg>
    case 'edit':
      return <svg {...common}>{titleNode}<path d="M4 20h4.6L19.3 9.3a2.1 2.1 0 0 0 0-3l-1.6-1.6a2.1 2.1 0 0 0-3 0L4 15.4V20Z" /><path d="m13.7 5.7 4.6 4.6" /></svg>
    case 'file':
      return <svg {...common}>{titleNode}<path d="M6.5 3.5h7L18.5 8v12.5h-12V3.5Z" /><path d="M13.5 3.5V8h5" /><path d="M9 13h6" /><path d="M9 17h4" /></svg>
    case 'folder':
      return <svg {...common}>{titleNode}<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z" /></svg>
    case 'image':
      return <svg {...common}>{titleNode}<rect x="4" y="5" width="16" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.5" /><path d="m7 17 4.2-4.2a1.5 1.5 0 0 1 2.1 0L18 17" /></svg>
    case 'layout':
      return <svg {...common}>{titleNode}<rect x="4" y="5" width="16" height="14" rx="2.5" /><path d="M9 5v14" /><path d="M4 10h16" /></svg>
    case 'list':
      return <svg {...common}>{titleNode}<path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></svg>
    case 'minus':
      return <svg {...common}>{titleNode}<path d="M5 12h14" /></svg>
    case 'note':
      return <svg {...common}>{titleNode}<path d="M6 4h9l3 3v13H6V4Z" /><path d="M15 4v4h4" /><path d="M9 12h6" /><path d="M9 16h4" /></svg>
    case 'paperclip':
      return <svg {...common}>{titleNode}<path d="m9.5 12.8 5.4-5.4a3 3 0 0 1 4.2 4.2l-7 7a5 5 0 0 1-7.1-7.1l7.3-7.3" /><path d="m8.6 15.7 7.1-7.1" /></svg>
    case 'plus':
      return <svg {...common}>{titleNode}<path d="M12 5v14" /><path d="M5 12h14" /></svg>
    case 'refresh':
      return <svg {...common}>{titleNode}<path d="M20 12a8 8 0 0 1-13.7 5.7" /><path d="M4 12A8 8 0 0 1 17.7 6.3" /><path d="M18 3v4h-4" /><path d="M6 21v-4h4" /></svg>
    case 'save':
      return <svg {...common}>{titleNode}<path d="M5 4h11l3 3v13H5V4Z" /><path d="M8 4v6h8" /><path d="M8 20v-6h8v6" /></svg>
    case 'settings':
      return <svg {...common}>{titleNode}<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1-2.1 3.6-.2-.1a1.8 1.8 0 0 0-2 .3 1.8 1.8 0 0 0-.6 1.9h-4a1.8 1.8 0 0 0-.6-1.9 1.8 1.8 0 0 0-2-.3l-.2.1-2.1-3.6.1-.1a1.8 1.8 0 0 0 .4-2A1.8 1.8 0 0 0 5 13.7H4V10h1a1.8 1.8 0 0 0 1.6-1.2 1.8 1.8 0 0 0-.4-2l-.1-.1 2.1-3.6.2.1a1.8 1.8 0 0 0 2-.3A1.8 1.8 0 0 0 11 1h4a1.8 1.8 0 0 0 .6 1.9 1.8 1.8 0 0 0 2 .3l.2-.1 2.1 3.6-.1.1a1.8 1.8 0 0 0-.4 2A1.8 1.8 0 0 0 21 10h1v3.7h-1a1.8 1.8 0 0 0-1.6 1.3Z" /></svg>
    case 'spark':
      return <svg {...common}>{titleNode}<path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z" /><path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></svg>
    case 'tag':
      return <svg {...common}>{titleNode}<path d="M4 12.2V5h7.2l8.4 8.4a2.2 2.2 0 0 1 0 3.1l-3.1 3.1a2.2 2.2 0 0 1-3.1 0L4 12.2Z" /><circle cx="8" cy="8" r="1.2" /></svg>
    case 'table':
      return <svg {...common}>{titleNode}<rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16" /><path d="M4 15h16" /><path d="M10 5v14" /><path d="M16 5v14" /></svg>
    case 'trash':
      return <svg {...common}>{titleNode}<path d="M5 7h14" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M8 7l1-3h6l1 3" /><path d="M7 7l1 13h8l1-13" /></svg>
    case 'x':
      return <svg {...common}>{titleNode}<path d="m6 6 12 12" /><path d="M18 6 6 18" /></svg>
    default:
      return null
  }
}

function newId(prefix: string) {
  return `${prefix}${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

const SEED_VERSION_KEY = 'labnote.seedVersion'

const shouldResetSeed = () => {
  if (typeof window === 'undefined') return true
  try {
    const existingEntries = window.localStorage.getItem('labnote.entries')
    if (existingEntries) {
      try {
        const parsed = JSON.parse(existingEntries) as Record<string, Entry>
        if (parsed && Object.keys(parsed).length > 0) return false
      } catch {
        // If we can't parse existing entries, avoid clearing to prevent data loss.
        return false
      }
    }
    return window.localStorage.getItem(SEED_VERSION_KEY) !== seedVersion
  } catch (err) {
    console.warn('Unable to read seed version', err)
    return true
  }
}

const suggestedRoot = 'C:\\Easylab'
const suggestedPaths: AppPaths = {
  dataRoot: `${suggestedRoot}\\data`,
  attachmentsRoot: `${suggestedRoot}\\attachments`,
  exportRoot: `${suggestedRoot}\\exports`,
  syncRoot: `${suggestedRoot}\\sync`,
}

const readStoredPaths = (): AppPaths | null => {
  if (typeof window === 'undefined') return null
  try {
    const saved = window.localStorage.getItem(APP_PATHS_KEY)
    if (!saved) return null
    const parsed = JSON.parse(saved) as Partial<AppPaths>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      dataRoot: String(parsed.dataRoot ?? ''),
      attachmentsRoot: String(parsed.attachmentsRoot ?? ''),
      exportRoot: String(parsed.exportRoot ?? ''),
      syncRoot: String(parsed.syncRoot ?? ''),
    }
  } catch (err) {
    console.warn('Unable to read stored paths', err)
    return null
  }
}

const writeStoredPaths = (paths: AppPaths) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(APP_PATHS_KEY, JSON.stringify(paths))
    window.localStorage.setItem(APP_SETUP_KEY, '1')
  } catch (err) {
    console.warn('Unable to persist app paths', err)
  }
}

const isSetupComplete = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(APP_SETUP_KEY) === '1'
  } catch {
    return false
  }
}

const shouldAutoBootstrapMobileSetup = () => {
  if (typeof window === 'undefined') return false
  const hasDesktopBridge = !!window.electronAPI?.selectDirectory
  if (hasDesktopBridge) return false
  return window.matchMedia?.('(max-width: 900px)').matches ?? false
}

type EntryTemplateId = 'guided' | 'blank' | 'day'
type SyncStatus = 'pending' | 'synced' | 'failed'
type PairLinkStatus = 'idle' | 'checking' | 'online' | 'offline'
type PairingLinkInfo = {
  url: string
  candidates: string[]
  tailscaleConnected: boolean
  source: 'none' | 'tailscale' | 'lan'
}
type HistoryReactEditor = ReactEditor & HistoryEditor

const monthStartFromIso = (isoDate: string) => {
  const parts = isoDate.split('-')
  const year = Number(parts[0] ?? new Date().getFullYear())
  const month = Number(parts[1] ?? 1) - 1
  return new Date(year, Math.max(0, month), 1)
}

const dateFromBucket = (bucket: string) => {
  const [yearStr, monthStr, dayStr] = bucket.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (!year || !month || !day) return new Date()
  return new Date(year, month - 1, day, 12, 0, 0, 0)
}

const timestampFromDateString = (value: string) => {
  if (!value) return null
  const parsed = Date.parse(`${value}T00:00:00`)
  return Number.isNaN(parsed) ? null : parsed
}

type ParsedMarkdownEntry = {
  entry: Entry
  attachments: Attachment[]
  projectTitle?: string
  experimentTitle?: string
}

const entrySortTimestamp = (entry: Entry) => {
  const candidates = [entry.dateBucket, entry.createdDatetime, entry.lastEditedDatetime]
  for (const value of candidates) {
    if (!value) continue
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

const parseMarkdownLink = (line: string) => {
  const imageMatch = line.match(/^!\[(.*?)\]\((.*?)\)$/)
  if (imageMatch) {
    return { type: 'image' as const, label: imageMatch[1] ?? '', path: imageMatch[2] ?? '' }
  }
  const fileMatch = line.match(/^\[(.*?)\]\((.*?)\)$/)
  if (fileMatch) {
    return { type: 'file' as const, label: fileMatch[1] ?? '', path: fileMatch[2] ?? '' }
  }
  return null
}

const WORKBOOK_MIN_ROWS = 24
const WORKBOOK_MIN_COLS = 8
const WORKBOOK_MAX_ROWS = 80
const WORKBOOK_MAX_COLS = 16
const WORKBOOK_COLUMN_LABELS = Array.from({ length: WORKBOOK_MAX_COLS }, (_, idx) => {
  let label = ''
  let n = idx
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
})
type WorkbookCellStyles = Record<string, WorkbookCellStyle>
type WorkbookCellPosition = { rowIdx: number; colIdx: number }

const workbookCellKey = (rowIdx: number, colIdx: number) => `${rowIdx}:${colIdx}`

const workbookStyleHasContent = (style?: WorkbookCellStyle) =>
  Boolean(style?.bold || style?.italic || style?.underline || style?.align)

const makeEmptyWorkbookData = (rows = WORKBOOK_MIN_ROWS, cols = WORKBOOK_MIN_COLS) =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''))

const workbookHasContent = (data: string[][]) =>
  data.some((row) => row.some((cell) => String(cell ?? '').trim().length > 0))

const normalizeWorkbookData = (data: string[][] = [], minRows = WORKBOOK_MIN_ROWS, minCols = WORKBOOK_MIN_COLS) => {
  const rowCount = Math.min(Math.max(data.length, minRows), WORKBOOK_MAX_ROWS)
  const colCount = Math.min(
    Math.max(data.reduce((max, row) => Math.max(max, row.length), 0), minCols),
    WORKBOOK_MAX_COLS
  )

  return Array.from({ length: rowCount }, (_, rowIdx) =>
    Array.from({ length: colCount }, (_, colIdx) => String(data[rowIdx]?.[colIdx] ?? ''))
  )
}

const compactWorkbookData = (data: string[][]) => {
  let lastRow = -1
  let lastCol = -1
  data.forEach((row, rowIdx) => {
    row.forEach((cell, colIdx) => {
      if (String(cell ?? '').trim()) {
        lastRow = Math.max(lastRow, rowIdx)
        lastCol = Math.max(lastCol, colIdx)
      }
    })
  })
  if (lastRow < 0 || lastCol < 0) return []
  return data.slice(0, lastRow + 1).map((row) =>
    row.slice(0, lastCol + 1).map((cell) => String(cell ?? ''))
  )
}

const normalizeWorkbookStyles = (styles?: WorkbookCellStyles): WorkbookCellStyles => {
  if (!styles) return {}
  return Object.fromEntries(
    Object.entries(styles).filter(([key, style]) => {
      const [row, col] = key.split(':').map(Number)
      return (
        Number.isInteger(row) &&
        Number.isInteger(col) &&
        row >= 0 &&
        col >= 0 &&
        row < WORKBOOK_MAX_ROWS &&
        col < WORKBOOK_MAX_COLS &&
        workbookStyleHasContent(style)
      )
    })
  )
}

const compactWorkbookStyles = (styles: WorkbookCellStyles, compactData: string[][]): WorkbookCellStyles => {
  const rowCount = compactData.length
  const colCount = compactData[0]?.length ?? 0
  if (!rowCount || !colCount) return {}
  return Object.fromEntries(
    Object.entries(normalizeWorkbookStyles(styles)).filter(([key]) => {
      const [row, col] = key.split(':').map(Number)
      return row < rowCount && col < colCount
    })
  )
}

const getWorkbookBlock = (entry?: Entry | null) =>
  entry?.content.find((block): block is Extract<Block, { type: 'workbook' }> => block.type === 'workbook') ?? null

const getWorkbookDataForEntry = (entry?: Entry | null) =>
  normalizeWorkbookData(getWorkbookBlock(entry)?.data ?? [])

const getWorkbookStylesForEntry = (entry?: Entry | null) =>
  normalizeWorkbookStyles(getWorkbookBlock(entry)?.styles)

const getNoteBlocksForEntry = (entry?: Entry | null) =>
  entry?.content.filter((block) => block.type !== 'workbook') ?? [{ id: 'b-empty', type: 'paragraph', text: '' } satisfies Block]

const parseEntryMarkdown = (markdown: string, folderName: string): ParsedMarkdownEntry | null => {
  const lines = markdown.split(/\r?\n/)
  let idx = 0
  let title = ''
  let createdDatetime = ''
  let lastEditedDatetime = ''
  let projectTitle: string | undefined
  let experimentTitle: string | undefined
  let pendingListStyle: ListStyle | undefined

  if (lines[idx]?.startsWith('# ')) {
    title = lines[idx].slice(2).trim()
    idx += 1
  }

  while (idx < lines.length && lines[idx].startsWith('- ')) {
    const meta = lines[idx].slice(2).trim()
    if (meta.startsWith('Project:')) {
      projectTitle = meta.replace('Project:', '').trim()
    } else if (meta.startsWith('Experiment:')) {
      experimentTitle = meta.replace('Experiment:', '').trim()
    } else if (meta.startsWith('Created:')) {
      const parsed = new Date(meta.replace('Created:', '').trim())
      if (!Number.isNaN(parsed.getTime())) createdDatetime = parsed.toISOString()
    } else if (meta.startsWith('Last edited:')) {
      const parsed = new Date(meta.replace('Last edited:', '').trim())
      if (!Number.isNaN(parsed.getTime())) lastEditedDatetime = parsed.toISOString()
    }
    idx += 1
  }

  while (idx < lines.length && lines[idx].trim() === '') idx += 1

  const dateBucket = folderName.slice(0, 10)
  const fallbackDate = dateBucket ? `${dateBucket}T12:00:00.000Z` : new Date().toISOString()
  const created = createdDatetime || fallbackDate
  const edited = lastEditedDatetime || created
  const entryTitle = title || dateOnly.format(new Date(created))
  const entryId = `entry-bundle-${folderName}`

  const blocks: Block[] = []
  const attachments: Attachment[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    const text = paragraph.join('\n').trim()
    if (text) {
      blocks.push({ id: newId('b-'), type: 'paragraph', text })
    }
    paragraph = []
  }

  const parseTableRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  while (idx < lines.length) {
    const line = lines[idx]
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph()
      idx += 1
      continue
    }

    const listStyleMatch = trimmed.match(/^<!--\s*list:([a-z-]+)\s*-->$/i)
    if (listStyleMatch) {
      const style = normalizeListStyle(listStyleMatch[1]?.toLowerCase())
      if (style) pendingListStyle = style
      idx += 1
      continue
    }

    if (trimmed === '---') {
      flushParagraph()
      pendingListStyle = undefined
      blocks.push({ id: newId('b-'), type: 'divider' })
      idx += 1
      continue
    }

    if (trimmed.startsWith('## ')) {
      flushParagraph()
      pendingListStyle = undefined
      blocks.push({ id: newId('b-'), type: 'heading', level: 2, text: trimmed.slice(3).trim() })
      idx += 1
      continue
    }

    if (trimmed.startsWith('### ')) {
      flushParagraph()
      pendingListStyle = undefined
      blocks.push({ id: newId('b-'), type: 'heading', level: 3, text: trimmed.slice(4).trim() })
      idx += 1
      continue
    }

    if (trimmed.startsWith('> ')) {
      flushParagraph()
      pendingListStyle = undefined
      const quoteLines: string[] = []
      while (idx < lines.length && lines[idx].trim().startsWith('> ')) {
        quoteLines.push(lines[idx].trim().replace(/^>\s?/, ''))
        idx += 1
      }
      blocks.push({ id: newId('b-'), type: 'quote', text: quoteLines.join('\n') })
      continue
    }

    if (trimmed.startsWith('- [')) {
      flushParagraph()
      pendingListStyle = undefined
      const items: ChecklistItem[] = []
      while (idx < lines.length && lines[idx].trim().startsWith('- [')) {
        const itemLine = lines[idx].trim()
        const done = itemLine.startsWith('- [x]')
        const text = itemLine.replace(/^- \[[ x]\]\s?/, '').trim()
        items.push({ id: newId('ci-'), text, done })
        idx += 1
      }
      blocks.push({ id: newId('b-'), type: 'checklist', items })
      continue
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph()
      const items: ListItem[] = []
      while (idx < lines.length && /^[-*+]\s+/.test(lines[idx].trim()) && !lines[idx].trim().startsWith('- [')) {
        const itemLine = lines[idx].trim().replace(/^[-*+]\s+/, '').trim()
        items.push({ id: newId('li-'), text: itemLine })
        idx += 1
      }
      blocks.push({
        id: newId('b-'),
        type: 'list',
        style: pendingListStyle ?? 'dot',
        items,
      })
      pendingListStyle = undefined
      continue
    }

    if (trimmed.startsWith('|')) {
      flushParagraph()
      pendingListStyle = undefined
      const tableLines: string[] = []
      while (idx < lines.length && lines[idx].trim().startsWith('|')) {
        tableLines.push(lines[idx])
        idx += 1
      }
      let headerRow = false
      let data: string[][] = []
      if (tableLines.length >= 2 && tableLines[1].replace(/\s|\|/g, '').includes('---')) {
        headerRow = true
        const header = parseTableRow(tableLines[0])
        const body = tableLines.slice(2).map(parseTableRow)
        data = [header, ...body]
      } else {
        data = tableLines.map(parseTableRow)
      }
      const tableBlock: Block = { id: newId('b-'), type: 'table', data, headerRow }
      blocks.push(tableBlock)
      if (idx < lines.length && lines[idx].trim().match(/^\*.+\*$/)) {
        const caption = lines[idx].trim().replace(/^\*/, '').replace(/\*$/, '')
        if (caption) {
          tableBlock.caption = caption
        }
        idx += 1
      }
      continue
    }

    const link = parseMarkdownLink(trimmed)
    if (link) {
      flushParagraph()
      pendingListStyle = undefined
      const path = link.path
      const filename = path.split('/').filter(Boolean).pop() ?? (link.label || 'file')
      const attId = `att-import-${folderName}-${attachments.length + 1}`
      attachments.push({
        id: attId,
        entryId,
        type: link.type,
        filename: filename,
        filesize: '—',
        storagePath: path || filename,
      })
      if (link.type === 'image') {
        blocks.push({ id: newId('b-'), type: 'image', attachmentId: attId, caption: link.label || filename })
      } else {
        blocks.push({ id: newId('b-'), type: 'file', attachmentId: attId, label: link.label || filename })
      }
      idx += 1
      continue
    }

    paragraph.push(line)
    idx += 1
  }

  flushParagraph()

  const entry: Entry = {
    id: entryId,
    createdDatetime: created,
    lastEditedDatetime: edited,
    authorId: sampleData.users[1]?.id ?? sampleData.users[0]?.id ?? 'me',
    title: entryTitle,
    dateBucket: dateBucket || created.slice(0, 10),
    content: blocks.length ? blocks : [{ id: newId('b-'), type: 'paragraph', text: '' }],
    tags: [],
    projectTags: [],
    experimentTags: [],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [],
  }

  return { entry, attachments, projectTitle, experimentTitle }
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
  'Samples',
  'Protocol run',
  'Deviations',
  'Raw data',
  'Summary',
  'Protocol',
  'Objective',
  'Aim',
  'Experiment',
  'Results',
])
const LEGACY_DAILY_SECTION_LABELS = new Set(['Setup', 'Procedure', 'Observations', 'Next steps'])
const DAY_CONTEXT_GUIDE = '• ........................................\n• ........................................\n• ........................................'

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

type ThemeOption = {
  id: ThemeName
  label: string
  description: string
  preview: {
    bg: string
    surface: string
    accent: string
    border: string
  }
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'light',
    label: 'Studio',
    description: 'Cool slate, cobalt accents.',
    preview: { bg: '#F4F6FB', surface: '#FFFFFF', accent: '#2F6AF6', border: '#0F172A' },
  },
  {
    id: 'neo-brutal',
    label: 'Neo Brutal',
    description: 'Punchy contrast, bold shadows.',
    preview: { bg: '#FFF3DB', surface: '#FFFDF6', accent: '#FF4D2E', border: '#111111' },
  },
  {
    id: 'sage',
    label: 'Sage',
    description: 'Calm greens with crisp contrast.',
    preview: { bg: '#F3F6F1', surface: '#FFFFFF', accent: '#1C8C5A', border: '#173023' },
  },
]

const isThemeName = (value: string | null): value is ThemeName =>
  !!value && THEME_OPTIONS.some((opt) => opt.id === value)

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

function findContextBlocks(entry: Entry): {
  heading: Extract<Block, { type: 'heading' }> | null
  paragraph: Extract<Block, { type: 'paragraph' }> | null
} {
  let contextHeading: Extract<Block, { type: 'heading' }> | null = null
  let contextParagraph: Extract<Block, { type: 'paragraph' }> | null = null

  for (let idx = 0; idx < entry.content.length; idx += 1) {
    const block = entry.content[idx]
    if (block.type !== 'heading') continue
    if (block.text.trim().toLowerCase() !== 'context') continue
    contextHeading = block

    for (let next = idx + 1; next < entry.content.length; next += 1) {
      const candidate = entry.content[next]
      if (candidate.type === 'heading') break
      if (candidate.type === 'paragraph') {
        contextParagraph = candidate
        break
      }
    }
    break
  }

  if (!contextParagraph) {
    const firstParagraph = entry.content.find((block): block is Extract<Block, { type: 'paragraph' }> => block.type === 'paragraph')
    contextParagraph = firstParagraph ?? null
  }

  return { heading: contextHeading, paragraph: contextParagraph }
}

function blockHasMeaningfulContent(block: Block): boolean {
  switch (block.type) {
    case 'paragraph':
    case 'quote':
      return block.text.trim().length > 0
    case 'checklist':
      return block.items.some((item) => item.done || item.text.trim().length > 0)
    case 'list':
      return block.items.some((item) => item.text.trim().length > 0)
    case 'table':
    case 'workbook':
      return block.data.some((row) => row.some((cell) => cell.trim().length > 0))
    case 'image':
    case 'file':
      return true
    case 'heading': {
      const label = block.text.trim()
      if (!label) return false
      return !LOCKED_TEMPLATE_SECTION_LABELS.has(label)
    }
    case 'divider':
      return false
    default:
      return false
  }
}

function shouldCondenseLegacyDailyEntry(entry: Entry): boolean {
  if (!entry.isDaily) return false
  const hasLegacySections =
    entry.content.some(
      (block) => block.type === 'heading' && LEGACY_DAILY_SECTION_LABELS.has(block.text.trim())
    ) ||
    (entry.pinnedRegions ?? []).some((region) => LEGACY_DAILY_SECTION_LABELS.has(region.label))
  if (!hasLegacySections) return false

  const { heading: contextHeading, paragraph: contextParagraph } = findContextBlocks(entry)
  const contextIds = new Set<string>()
  if (contextHeading) contextIds.add(contextHeading.id)
  if (contextParagraph) contextIds.add(contextParagraph.id)

  const hasLinkedLegacyRegionAttachments = (entry.pinnedRegions ?? []).some(
    (region) =>
      LEGACY_DAILY_SECTION_LABELS.has(region.label) &&
      Array.isArray(region.linkedAttachments) &&
      region.linkedAttachments.length > 0
  )
  if (hasLinkedLegacyRegionAttachments) return false

  for (const block of entry.content) {
    if (contextIds.has(block.id)) continue
    if (block.type === 'heading' && LEGACY_DAILY_SECTION_LABELS.has(block.text.trim())) continue
    if (blockHasMeaningfulContent(block)) return false
  }

  return true
}

function condenseLegacyDailyEntry(entry: Entry): Entry {
  if (!shouldCondenseLegacyDailyEntry(entry)) return entry

  const nowIso = new Date().toISOString()
  const { heading: contextHeading, paragraph: contextParagraph } = findContextBlocks(entry)
  const headingId = contextHeading?.id ?? newId('b-')
  const paragraphId = contextParagraph?.id ?? newId('b-')
  const contextRegion = (entry.pinnedRegions ?? []).find((region) => region.label.trim().toLowerCase() === 'context')

  const compactHeading: Extract<Block, { type: 'heading' }> = {
    id: headingId,
    type: 'heading',
    level: 2,
    text: 'Context',
    locked: true,
    align: contextHeading?.align,
    runs: contextHeading?.runs,
    updatedAt: contextHeading?.updatedAt ?? nowIso,
    updatedBy: contextHeading?.updatedBy ?? 'me',
  }
  const compactParagraph: Extract<Block, { type: 'paragraph' }> = {
    id: paragraphId,
    type: 'paragraph',
    text: contextParagraph?.text ?? '',
    runs: contextParagraph?.runs,
    align: contextParagraph?.align,
    guide: DAY_CONTEXT_GUIDE,
    updatedAt: contextParagraph?.updatedAt ?? nowIso,
    updatedBy: contextParagraph?.updatedBy ?? 'me',
  }

  const nextRegion: PinnedRegion = {
    id: contextRegion?.id ?? newId('region-'),
    entryId: entry.id,
    label: 'Context',
    blockIds: [headingId, paragraphId],
    linkedAttachments: contextRegion?.linkedAttachments ?? [],
    summary: contextRegion?.summary,
  }

  return {
    ...entry,
    content: [compactHeading, compactParagraph],
    pinnedRegions: [nextRegion],
  }
}

function buildTemplate(templateId: EntryTemplateId, entryId: string, nowIso: string): { content: Block[]; pinnedRegions: PinnedRegion[] } {
  if (templateId === 'blank') {
    return {
      content: [{ id: newId('b-'), type: 'paragraph', text: '' }],
      pinnedRegions: [],
    }
  }

  if (templateId === 'day') {
    const aimHeadingId = newId('b-')
    const aimBodyId = newId('b-')
    const samplesHeadingId = newId('b-')
    const samplesBodyId = newId('b-')
    const protocolHeadingId = newId('b-')
    const protocolChecklistId = newId('b-')
    const deviationsHeadingId = newId('b-')
    const deviationsBodyId = newId('b-')
    const observationsHeadingId = newId('b-')
    const observationsBodyId = newId('b-')
    const rawDataHeadingId = newId('b-')
    const rawDataBodyId = newId('b-')
    const nextStepsHeadingId = newId('b-')
    const nextStepsBodyId = newId('b-')
    return {
      content: [
        { id: aimHeadingId, type: 'heading', level: 2, text: 'Aim', locked: true, updatedAt: nowIso, updatedBy: 'me' },
        {
          id: aimBodyId,
          type: 'paragraph',
          text: '',
          guide: 'What are you testing today? Include the biological question, model, condition, and expected readout.',
          updatedAt: nowIso,
          updatedBy: 'me',
        },
        { id: samplesHeadingId, type: 'heading', level: 2, text: 'Samples', locked: true, updatedAt: nowIso, updatedBy: 'me' },
        {
          id: samplesBodyId,
          type: 'table',
          data: [
            ['Sample / animal / culture', 'Group', 'Treatment', 'Notes'],
            ['', '', '', ''],
          ],
          caption: 'Samples and experimental groups',
          updatedAt: nowIso,
          updatedBy: 'me',
        },
        { id: protocolHeadingId, type: 'heading', level: 2, text: 'Protocol run', locked: true, updatedAt: nowIso, updatedBy: 'me' },
        {
          id: protocolChecklistId,
          type: 'checklist',
          items: [
            { id: newId('ci-'), text: '', guide: 'Protocol version / SOP recorded', done: false },
            { id: newId('ci-'), text: '', guide: 'Critical timing windows noted', done: false },
            { id: newId('ci-'), text: '', guide: 'Raw data destination confirmed', done: false },
          ],
          updatedAt: nowIso,
          updatedBy: 'me',
        },
        { id: deviationsHeadingId, type: 'heading', level: 2, text: 'Deviations', locked: true, updatedAt: nowIso, updatedBy: 'me' },
        {
          id: deviationsBodyId,
          type: 'paragraph',
          text: '',
          guide: 'Record anything that differed from the protocol, including timing, reagent lots, instrument settings, or sample exclusions.',
          updatedAt: nowIso,
          updatedBy: 'me',
        },
        { id: observationsHeadingId, type: 'heading', level: 2, text: 'Observations', locked: true, updatedAt: nowIso, updatedBy: 'me' },
        {
          id: observationsBodyId,
          type: 'paragraph',
          text: '',
          guide: 'Add timestamped observations, images, instrument readouts, and phone captures as they happen.',
          updatedAt: nowIso,
          updatedBy: 'me',
        },
        { id: rawDataHeadingId, type: 'heading', level: 2, text: 'Raw data', locked: true, updatedAt: nowIso, updatedBy: 'me' },
        {
          id: rawDataBodyId,
          type: 'paragraph',
          text: '',
          guide: 'Drag raw files/images here or link the folder. Note where the original data lives.',
          updatedAt: nowIso,
          updatedBy: 'me',
        },
        { id: nextStepsHeadingId, type: 'heading', level: 2, text: 'Next steps', locked: true, updatedAt: nowIso, updatedBy: 'me' },
        {
          id: nextStepsBodyId,
          type: 'paragraph',
          text: '',
          guide: 'What needs to be analyzed, repeated, exported, or handed off next?',
          updatedAt: nowIso,
          updatedBy: 'me',
        },
      ],
      pinnedRegions: [
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
          label: 'Samples',
          blockIds: [samplesHeadingId, samplesBodyId],
          linkedAttachments: [],
        },
        {
          id: newId('region-'),
          entryId,
          label: 'Protocol run',
          blockIds: [protocolHeadingId, protocolChecklistId],
          linkedAttachments: [],
        },
        {
          id: newId('region-'),
          entryId,
          label: 'Deviations',
          blockIds: [deviationsHeadingId, deviationsBodyId],
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
          label: 'Raw data',
          blockIds: [rawDataHeadingId, rawDataBodyId],
          linkedAttachments: [],
        },
        {
          id: newId('region-'),
          entryId,
          label: 'Next steps',
          blockIds: [nextStepsHeadingId, nextStepsBodyId],
          linkedAttachments: [],
        },
      ],
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
      text: '',
      guide: 'What question are you answering today? Include model, conditions, and expected outcome.',
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: setupHeadingId, type: 'heading', level: 2, text: 'Setup', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: setupChecklistId,
      type: 'checklist',
      items: [
        { id: newId('ci-'), text: '', guide: 'Sample IDs and groups confirmed', done: false },
        { id: newId('ci-'), text: '', guide: 'Controls + blanks prepared', done: false },
        { id: newId('ci-'), text: '', guide: 'Reagents + lot IDs logged', done: false },
      ],
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: procedureHeadingId, type: 'heading', level: 2, text: 'Procedure', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: procedureBodyId,
      type: 'paragraph',
      text: '',
      guide: 'Step-by-step protocol. Note timing windows and any deviations from SOP.',
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: observationsHeadingId, type: 'heading', level: 2, text: 'Observations', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: observationsBodyId,
      type: 'paragraph',
      text: '',
      guide: 'Record time-stamped observations, anomalies, and instrument readouts.',
      updatedAt: nowIso,
      updatedBy: 'me',
    },
    { id: nextStepsHeadingId, type: 'heading', level: 2, text: 'Next steps', locked: true, updatedAt: nowIso, updatedBy: 'me' },
    {
      id: nextStepsBodyId,
      type: 'paragraph',
      text: '',
      guide: 'What happens next? Add follow-ups, analysis tasks, or handoff notes.',
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

const isLikelyUrl = (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)
const isHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
const isLoopbackHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}
const TAILSCALE_V4_PATTERN = /^100\.(\d{1,3}\.){2}\d{1,3}$/
const isTailscaleHost = (host: string) => host.toLowerCase().endsWith('.ts.net') || TAILSCALE_V4_PATTERN.test(host)
const isTailscaleUrl = (value: string) => {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isTailscaleHost(parsed.hostname)
  } catch {
    return false
  }
}
const isWindowsDriveRoot = (value: string) => /^[a-zA-Z]:[\\/]*$/.test(value)
const shortEntryId = (entryId: string) => entryId.replace(/^entry-/, '').slice(0, 8) || entryId
const entryBundleFolderName = (entry: Entry) => safeFileName(`${entry.dateBucket}-${shortEntryId(entry.id)}`)
const entryBundleFileBase = (entry: Entry) => safeFileName(`${entry.dateBucket}-${entry.title}`) || 'entry'
const attachmentExportName = (attachment: Attachment) => `${attachment.id}-${safeFileName(attachment.filename)}`
const LIST_STYLE_SYMBOLS: Record<ListStyle, string> = {
  dot: '•',
  circle: '◦',
  square: '▪',
  dash: '–',
  arrow: '→',
}
const LIST_STYLE_OPTIONS: Array<{ id: ListStyle; label: string; symbol: string }> = [
  { id: 'dot', label: 'Dot list', symbol: LIST_STYLE_SYMBOLS.dot },
  { id: 'circle', label: 'Circle list', symbol: LIST_STYLE_SYMBOLS.circle },
  { id: 'square', label: 'Square list', symbol: LIST_STYLE_SYMBOLS.square },
  { id: 'dash', label: 'Dash list', symbol: LIST_STYLE_SYMBOLS.dash },
  { id: 'arrow', label: 'Arrow list', symbol: LIST_STYLE_SYMBOLS.arrow },
]
const normalizeListStyle = (value: unknown): ListStyle | undefined => {
  if (value === 'dot' || value === 'circle' || value === 'square' || value === 'dash' || value === 'arrow') return value
  return undefined
}
const getListSymbol = (style?: ListStyle) => LIST_STYLE_SYMBOLS[style ?? 'dot'] ?? '•'
const DATE_BUCKET_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const toLocalDateBucket = (value: string) => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
}

const ensureEntryDateBucket = (entry: Entry) => {
  const createdBucket = toLocalDateBucket(entry.createdDatetime)
  if (!createdBucket) return entry
  if (entry.dateBucket === createdBucket) return entry
  if (!entry.dateBucket || !DATE_BUCKET_PATTERN.test(entry.dateBucket) || entry.dateBucket !== createdBucket) {
    return { ...entry, dateBucket: createdBucket }
  }
  return entry
}

const normalizeSyncRoot = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (isWindowsDriveRoot(trimmed)) {
    return `${trimmed[0]}:\\`
  }
  return trimmed.replace(/[\\/]+$/, '')
}

const isAbsolutePath = (value: string) =>
  isLikelyUrl(value) ||
  /^[a-zA-Z]:[\\/]/.test(value) ||
  value.startsWith('\\\\') ||
  value.startsWith('/') ||
  value.startsWith('~/')

const resolveRelativePath = (root: string, value: string) => {
  const cleaned = value.trim()
  if (!cleaned) return cleaned
  if (!root) return cleaned
  if (isAbsolutePath(cleaned)) return cleaned

  const separator = isLikelyUrl(root) ? '/' : root.startsWith('\\\\') || root.includes('\\') || /^[a-zA-Z]:/.test(root) ? '\\' : '/'
  const rootBase = isWindowsDriveRoot(root) ? root.replace(/[\\/]*$/, '') : root.replace(/[\\/]+$/, '')
  const leaf = cleaned.replace(/^[\\/]+/, '')
  return `${rootBase}${separator}${leaf}`
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Unable to read file as data URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file'))
    reader.readAsDataURL(file)
  })
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
    case 'workbook':
      return block.data.flat().join(' ')
    case 'checklist':
      return block.items.map((i) => i.text).join(' ')
    case 'list':
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

const entryPreviewLines = (entry: Entry, maxLines = 3) => {
  const lines: string[] = []
  for (const block of entry.content) {
    const text = blockToSearchText(block).replace(/\s+/g, ' ').trim()
    if (!text) continue
    const clipped = text.length > 90 ? `${text.slice(0, 90)}...` : text
    lines.push(clipped)
    if (lines.length >= maxLines) break
  }
  if (lines.length === 0) lines.push('No notes yet.')
  return lines
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return 'name' in err && (err as { name?: unknown }).name === 'AbortError'
}

const inferDefaultMobilePairLink = () => {
  if (typeof window === 'undefined') return ''
  const { protocol, hostname, origin } = window.location
  if (protocol !== 'http:' && protocol !== 'https:') return ''
  if (hostname === 'localhost' || hostname === '127.0.0.1') return ''
  return origin
}

const normalizePairingLinkInfo = (value: unknown): PairingLinkInfo | null => {
  if (!value || typeof value !== 'object') return null
  const payload = value as Partial<PairingLinkInfo>
  const url = typeof payload.url === 'string' ? payload.url.trim() : ''
  const source = payload.source === 'tailscale' || payload.source === 'lan' || payload.source === 'none' ? payload.source : 'none'
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates.filter((candidate): candidate is string => typeof candidate === 'string')
    : []
  const tailscaleConnected = payload.tailscaleConnected === true
  return { url, source, candidates, tailscaleConnected }
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
        parts.push(
          block.items
            .filter((i) => i.text.trim() || !i.guide)
            .map((i) => `- [${i.done ? 'x' : ' '}] ${escapeMd(i.text)}`)
            .join('\n')
        )
        break
      case 'list': {
        const filtered = block.items.filter((i) => i.text.trim() || !i.guide)
        if (block.style && block.style !== 'dot') {
          parts.push(`<!-- list:${block.style} -->`)
        }
        parts.push(filtered.map((i) => `- ${escapeMd(i.text)}`).join('\n'))
        break
      }
      case 'table':
        parts.push(mdTable(block.data, block.headerRow !== false))
        if (block.caption) parts.push(`*${escapeMd(block.caption)}*`)
        break
      case 'workbook':
        parts.push('## Workbook')
        parts.push(mdTable(block.data, true))
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
          return `<ul class="checklist">${block.items
            .filter((i) => i.text.trim() || !i.guide)
            .map((i) => `<li><span class="cb">${i.done ? '☑' : '☐'}</span> ${esc(i.text)}</li>`)
            .join('')}</ul>`
        case 'list': {
          const symbol = getListSymbol(block.style)
          return `<ul class="symbol-list">${block.items
            .filter((i) => i.text.trim() || !i.guide)
            .map((i) => `<li><span class="symbol">${esc(symbol)}</span> ${esc(i.text)}</li>`)
            .join('')}</ul>`
        }
        case 'table':
          return `<div class="table-wrap">${renderTable(block.data, block.headerRow !== false)}${block.caption ? `<div class="caption">${esc(block.caption)}</div>` : ''}</div>`
        case 'workbook':
          return `<h2>Workbook</h2><div class="table-wrap workbook-export">${renderTable(block.data, true)}</div>`
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

function buildEntryMarkdown(
  entry: Entry,
  project: Project | undefined,
  experiment: Experiment | undefined,
  attachmentsById: Record<string, Attachment>,
  attachmentExportPathById: Record<string, string>
) {
  const header = [
    `# ${entry.title || 'Untitled note'}`,
    '',
    project ? `- Project: ${project.title}` : '',
    experiment ? `- Experiment: ${experiment.title}` : '',
    experiment?.protocolRef ? `- Protocol: ${experiment.protocolRef}` : '',
    `- Created: ${dateOnly.format(new Date(entry.createdDatetime))}`,
    `- Last edited: ${dateOnly.format(new Date(entry.lastEditedDatetime))}`,
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const body = blocksToMarkdown(entry.content, attachmentsById, attachmentExportPathById)
  return `${header}\n${body}`.trim() + '\n'
}

function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    const width = font.widthOfTextAtSize(next, size)
    if (width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

async function buildEntryPdf(
  entry: Entry,
  project: Project | undefined,
  experiment: Experiment | undefined,
  attachmentsById: Record<string, Attachment>
) {
  const pdf = await PDFDocument.create()
  const pageSize: [number, number] = [595.28, 841.89]
  let page = pdf.addPage(pageSize)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const margin = 48
  const maxWidth = page.getWidth() - margin * 2
  let y = page.getHeight() - margin

  const ensureSpace = (size: number) => {
    if (y < margin + size) {
      page = pdf.addPage(pageSize)
      y = page.getHeight() - margin
    }
  }

  const drawLines = (lines: string[], f: PDFFont, size: number, color = rgb(0.1, 0.1, 0.12)) => {
    for (const line of lines) {
      ensureSpace(size)
      page.drawText(line, { x: margin, y, size, font: f, color })
      y -= size + 4
    }
  }

  const addParagraph = (text: string, f: PDFFont, size: number, gap = 8, color?: ReturnType<typeof rgb>) => {
    if (!text.trim()) return
    const lines = wrapPdfText(text, f, size, maxWidth)
    drawLines(lines, f, size, color)
    y -= gap
  }

  addParagraph(entry.title || 'Untitled note', fontBold, 18, 10)
  const metaLine = [
    project ? `Project: ${project.title}` : '',
    experiment ? `Experiment: ${experiment.title}` : '',
    experiment?.protocolRef ? `Protocol: ${experiment.protocolRef}` : '',
    `Created ${dateOnly.format(new Date(entry.createdDatetime))}`,
    `Last edited ${dateOnly.format(new Date(entry.lastEditedDatetime))}`,
  ]
    .filter(Boolean)
    .join(' · ')
  addParagraph(metaLine, font, 10, 12, rgb(0.45, 0.45, 0.5))

  for (const block of entry.content) {
    switch (block.type) {
      case 'heading': {
        const size = block.level === 3 ? 12 : 14
        addParagraph(block.text, fontBold, size, 8)
        break
      }
      case 'paragraph':
        addParagraph(block.text, font, 11)
        break
      case 'quote':
        addParagraph(`“${block.text}”`, font, 11, 10, rgb(0.3, 0.3, 0.35))
        break
      case 'checklist':
        block.items
          .filter((item) => item.text.trim() || !item.guide)
          .forEach((item) => addParagraph(`[${item.done ? 'x' : ' '}] ${item.text}`, font, 11, 4))
        y -= 6
        break
      case 'list': {
        const symbol = getListSymbol(block.style)
        block.items
          .filter((item) => item.text.trim() || !item.guide)
          .forEach((item) => addParagraph(`${symbol} ${item.text}`, font, 11, 4))
        y -= 6
        break
      }
      case 'table':
        block.data.forEach((row) => addParagraph(row.join(' | '), font, 10, 2))
        y -= 6
        break
      case 'workbook':
        addParagraph('Workbook', fontBold, 14, 6)
        block.data.forEach((row) => addParagraph(row.join(' | '), font, 10, 2))
        y -= 6
        break
      case 'image': {
        const attachment = attachmentsById[block.attachmentId]
        addParagraph(`Image: ${block.caption ?? attachment?.filename ?? 'Image'}`, font, 11, 6)
        break
      }
      case 'file': {
        const attachment = attachmentsById[block.attachmentId]
        addParagraph(`File: ${block.label ?? attachment?.filename ?? 'File'}`, font, 11, 6)
        break
      }
      case 'divider':
        y -= 10
        break
      default:
        break
    }
  }

  return await pdf.save()
}

function pdfBytesToBlob(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes)
  return new Blob([copy], { type: 'application/pdf' })
}

async function getWritableCacheDir(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await restoreCacheHandle()
  if (!handle) return null
  const handleWithPerm = handle as FsDirectoryWithPerm
  if (handleWithPerm.queryPermission) {
    const perm = await handleWithPerm.queryPermission({ mode: 'readwrite' })
    if (perm === 'granted') return handle
    if (handleWithPerm.requestPermission) {
      const req = await handleWithPerm.requestPermission({ mode: 'readwrite' })
      if (req === 'granted') return handle
    }
    return null
  }
  return handle
}

async function readAttachmentBlob(
  attachment: Attachment,
  attachmentUrls: Record<string, string>
): Promise<Blob | null> {
  if (attachment.cachedPath?.startsWith('idb://')) {
    const key = attachment.cachedPath.replace('idb://', '')
    try {
      return (await getCachedFile(key)) ?? null
    } catch {
      return null
    }
  }

  if (attachment.cachedPath?.startsWith('fs://')) {
    const name = attachment.cachedPath.replace('fs://', '')
    const dir = await restoreCacheHandle()
    const dirWithPerm = dir ? (dir as FsDirectoryWithPerm) : null
    if (dirWithPerm?.queryPermission) {
      const perm = await dirWithPerm.queryPermission({ mode: 'read' })
      if (perm !== 'granted') return null
    }
    if (dir) {
      try {
        const handle = await dir.getFileHandle(name)
        return await handle.getFile()
      } catch {
        return null
      }
    }
  }

  const url = attachmentUrls[attachment.id] ?? attachment.thumbnail
  if (url) {
    try {
      const res = await fetch(url)
      return await res.blob()
    } catch {
      return null
    }
  }

  return null
}

async function writeBlobToDir(dir: FileSystemDirectoryHandle, filename: string, blob: Blob) {
  const handle = await dir.getFileHandle(filename, { create: true })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
}

function withChecklists(editor: ReactEditor) {
  const { normalizeNode, deleteBackward, insertBreak } = editor

  editor.insertBreak = () => {
    const selection = editor.selection
    const guideEntry = selection
      ? Editor.above(editor, {
          match: (n) => SlateElement.isElement(n) && typeof (n as { guide?: unknown }).guide === 'string',
        })
      : null

    insertBreak()

    if (!guideEntry) return
    const nextEntry = Editor.above(editor, {
      match: (n) => SlateElement.isElement(n) && typeof (n as { guide?: unknown }).guide === 'string',
    })
    if (!nextEntry) return
    const [, nextPath] = nextEntry
    Transforms.setNodes(editor, { guide: undefined }, { at: nextPath })
  }

  editor.deleteBackward = (...args) => {
    const selection = editor.selection
    if (selection && Range.isCollapsed(selection)) {
      const blockEntry = Editor.above(editor, {
        match: (n) => SlateElement.isElement(n) && typeof (n as { blockId?: unknown }).blockId === 'string',
      })
      if (blockEntry) {
        const [blockNode, blockPath] = blockEntry
        if (
          SlateElement.isElement(blockNode) &&
          blockNode.type === 'paragraph' &&
          Editor.isStart(editor, selection.anchor, blockPath)
        ) {
          if (blockPath[blockPath.length - 1] === 0) return
          const prevPath = Path.previous(blockPath)
          if (Node.has(editor, prevPath)) {
            const prevNode = Node.get(editor, prevPath)
            if (
              SlateElement.isElement(prevNode) &&
              prevNode.type === 'heading-two' &&
              (prevNode as { locked?: boolean }).locked === true
            ) {
              return
            }
          }
        }
      }
    }
    deleteBackward(...args)
  }

  editor.normalizeNode = (entry) => {
    const [node, path] = entry

    if (SlateElement.isElement(node)) {
      if (node.type === 'heading-two' && (node as { locked?: boolean }).locked === true && path.length === 1) {
        const nextPath = Path.next(path)
        const hasNext = Node.has(editor, nextPath)
        if (!hasNext) {
          Transforms.insertNodes(
            editor,
            { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] },
            { at: nextPath }
          )
          return
        }
        const nextNode = Node.get(editor, nextPath)
        if (SlateElement.isElement(nextNode) && nextNode.type === 'heading-two') {
          Transforms.insertNodes(
            editor,
            { type: 'paragraph', blockId: newId('b-'), children: [{ text: '' }] },
            { at: nextPath }
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
const TableEditContext = createContext<{ isEditing: boolean } | null>(null)
const ListSymbolContext = createContext<string>('•')

function App() {
  const resetSeed = shouldResetSeed()
  const labStoragePath = sampleData.labs[0]?.storageConfig.path ?? ''
  const storedPaths = readStoredPaths()
  const [appPaths, setAppPaths] = useState<AppPaths>(() => storedPaths ?? suggestedPaths)
  const [setupOpen, setSetupOpen] = useState(() => {
    if (isSetupComplete() || storedPaths) return false
    return !shouldAutoBootstrapMobileSetup()
  })
  const [appInfo, setAppInfo] = useState<{ name: string; version: string; platform: string } | null>(null)
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
      return Object.fromEntries(sampleData.entries.map((e) => [e.id, ensureEntryDateBucket(e)]))
    }
    try {
      const saved = window.localStorage.getItem('labnote.entries')
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, Entry>
        return Object.fromEntries(
          Object.entries(parsed).map(([id, entry]) => [
            id,
            condenseLegacyDailyEntry(ensureEntryDateBucket(applyLockedTemplateHeadings(entry))),
          ])
        )
      }
    } catch (err) {
      console.warn('Unable to read cached entries', err)
    }
    return Object.fromEntries(sampleData.entries.map((e) => [e.id, ensureEntryDateBucket(e)]))
  })
  const [protocols, setProtocols] = useState<Protocol[]>(() => {
    if (typeof window === 'undefined' || resetSeed) return sampleData.protocols
    try {
      const saved = window.localStorage.getItem('labnote.protocols')
      if (saved) return JSON.parse(saved) as Protocol[]
    } catch (err) {
      console.warn('Unable to read cached protocols', err)
    }
    return sampleData.protocols
  })
  const entryList = useMemo(() => {
    const entries = Object.values(entryDrafts)
    return entries.sort((a, b) => {
      const aTime = entrySortTimestamp(a)
      const bTime = entrySortTimestamp(b)
      if (aTime !== bTime) return bTime - aTime
      const aEdited = Date.parse(a.lastEditedDatetime ?? '') || 0
      const bEdited = Date.parse(b.lastEditedDatetime ?? '') || 0
      if (aEdited !== bEdited) return bEdited - aEdited
      return (a.title ?? '').localeCompare(b.title ?? '')
    })
  }, [entryDrafts])
  const todaySeed = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }, [])
  const initialCalendarSeed = todaySeed
  const [selectedEntryId, setSelectedEntryId] = useState(
    sampleData.entries[0]?.id ?? ''
  )
  const [selectedProtocolId, setSelectedProtocolId] = useState(
    protocols[0]?.id ?? ''
  )
  const [activePane, setActivePane] = useState<'entries' | 'protocols'>('entries')
  const [openEntryIds, setOpenEntryIds] = useState<string[]>(() =>
    sampleData.entries[0]?.id ? [sampleData.entries[0].id] : []
  )
  const dailySeededRef = useRef(false)
  const openEntries = useMemo(
    () => openEntryIds.map((id) => entryDrafts[id]).filter(Boolean) as Entry[],
    [entryDrafts, openEntryIds]
  )
  const [newProtocolOpen, setNewProtocolOpen] = useState(false)
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | null>(null)
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
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>({ start: '', end: '' })
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => monthStartFromIso(initialCalendarSeed))
  const [masterSyncPath, setMasterSyncPath] = useState<string>(() => {
    if (typeof window === 'undefined' || resetSeed) return labStoragePath
    try {
      const saved = window.localStorage.getItem('labnote.masterSyncPath')
      if (saved) return saved
    } catch (err) {
      console.warn('Unable to read master sync path', err)
    }
    if (storedPaths?.syncRoot) return storedPaths.syncRoot
    return labStoragePath
  })
  const [mobilePairLink, setMobilePairLink] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    try {
      const saved = window.localStorage.getItem(APP_MOBILE_PAIR_LINK_KEY)
      if (saved && isHttpUrl(saved)) return saved
    } catch (err) {
      console.warn('Unable to read mobile pairing link', err)
    }
    return inferDefaultMobilePairLink()
  })
  const [mobilePairStatus, setMobilePairStatus] = useState<PairLinkStatus>('idle')
  const [mobilePairQrDataUrl, setMobilePairQrDataUrl] = useState('')
  const [mobilePairAutoMessage, setMobilePairAutoMessage] = useState('')
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === 'undefined' || !('onLine' in navigator) ? true : navigator.onLine
  )
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})
  const [changeQueue, setChangeQueue] = useState<ChangeQueueItem[]>([])
  const [syncing, setSyncing] = useState(false)
  const [fsEnabled, setFsEnabled] = useState(false)
  const [fsNeedsPermission, setFsNeedsPermission] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [autoImportAttempted, setAutoImportAttempted] = useState(false)
  const canPickPaths = typeof window !== 'undefined' && !!window.electronAPI?.selectDirectory
  const [sharedApiAvailable, setSharedApiAvailable] = useState(false)
  const [sharedStateReady, setSharedStateReady] = useState(false)
  const sharedStateFingerprintRef = useRef('')

  useEffect(() => {
    if (!selectedEntryId) return
    setOpenEntryIds((prev) => (prev.includes(selectedEntryId) ? prev : [selectedEntryId, ...prev].slice(0, 5)))
  }, [selectedEntryId])

  useEffect(() => {
    const loadInfo = async () => {
      try {
        if (window.electronAPI?.getAppInfo) {
          const info = await window.electronAPI.getAppInfo()
          if (info) {
            setAppInfo({ name: info.name, version: info.version, platform: info.platform })
          }
        }
      } catch (err) {
        console.warn('Unable to load app info', err)
      }
    }
    loadInfo()
  }, [])

  useEffect(() => {
    const shouldProbeSharedApi = (() => {
      if (typeof window === 'undefined') return false
      if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false
      const params = new URLSearchParams(window.location.search)
      if (params.get('sharedApi') === '1') return true
      return window.location.port === '8030'
    })()

    if (!shouldProbeSharedApi) {
      setSharedStateReady(true)
      return
    }

    let cancelled = false
    const probeSharedApi = async () => {
      try {
        const response = await fetch(SHARED_API_INFO_URL, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (!cancelled) setSharedApiAvailable(true)
      } catch {
        if (!cancelled) setSharedStateReady(true)
      }
    }
    void probeSharedApi()
    return () => {
      cancelled = true
    }
  }, [])

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

  const removeProjectTagOption = useCallback((tag: string) => {
    const cleaned = normalizeTag(tag)
    if (!cleaned) return
    const ok = window.confirm(`Remove project tag "${cleaned}" from all entries?`)
    if (!ok) return
    setProjectTagOptions((prev) => prev.filter((t) => t !== cleaned))
    setSelectedProjectTags((prev) => prev.filter((t) => t !== cleaned))
    setEntryDrafts((prev) => {
      let changed = false
      const next: Record<string, Entry> = { ...prev }
      Object.entries(prev).forEach(([id, entry]) => {
        const tags = entry.projectTags ?? []
        if (!tags.includes(cleaned)) return
        changed = true
        next[id] = {
          ...entry,
          projectTags: tags.filter((t) => t !== cleaned),
          lastEditedDatetime: new Date().toISOString(),
        }
      })
      return changed ? next : prev
    })
  }, [])

  const removeExperimentTagOption = useCallback((tag: string) => {
    const cleaned = normalizeTag(tag)
    if (!cleaned) return
    const ok = window.confirm(`Remove experiment tag "${cleaned}" from all entries?`)
    if (!ok) return
    setExperimentTagOptions((prev) => prev.filter((t) => t !== cleaned))
    setSelectedExperimentTags((prev) => prev.filter((t) => t !== cleaned))
    setEntryDrafts((prev) => {
      let changed = false
      const next: Record<string, Entry> = { ...prev }
      Object.entries(prev).forEach(([id, entry]) => {
        const tags = entry.experimentTags ?? []
        if (!tags.includes(cleaned)) return
        changed = true
        next[id] = {
          ...entry,
          experimentTags: tags.filter((t) => t !== cleaned),
          lastEditedDatetime: new Date().toISOString(),
        }
      })
      return changed ? next : prev
    })
  }, [])

  const handleSetupComplete = useCallback(
    (paths: AppPaths) => {
      setAppPaths(paths)
      writeStoredPaths(paths)
      if (paths.syncRoot) {
        setMasterSyncPath(paths.syncRoot)
      }
      setSetupOpen(false)
    },
    [setMasterSyncPath]
  )

  const handleEditSetup = useCallback(() => {
    setSettingsOpen(false)
    setSetupOpen(true)
  }, [])

  const copyMobilePairLink = useCallback(async () => {
    const value = mobilePairLink.trim()
    if (!value || !isHttpUrl(value)) return false
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch (err) {
      console.warn('Unable to copy mobile pairing link', err)
      return false
    }
  }, [mobilePairLink])

  const autoDetectMobilePairLink = useCallback(async (force = false) => {
    if (typeof window === 'undefined' || !window.electronAPI?.getPairingLink) return
    try {
      const detectedRaw = await window.electronAPI.getPairingLink()
      const detected = normalizePairingLinkInfo(detectedRaw)
      if (!detected) {
        setMobilePairAutoMessage('Auto-detect is unavailable in this build.')
        return
      }
      if (!detected.url || !isHttpUrl(detected.url)) {
        setMobilePairAutoMessage(
          detected.tailscaleConnected
            ? 'Tailscale is running, but no app link was detected yet.'
            : 'No pairing link was detected. Start Tailscale on desktop to auto-fill the mobile URL.'
        )
        return
      }

      let replaced = false
      setMobilePairLink((prev) => {
        const current = prev.trim()
        const shouldReplace = force || !current || isLoopbackHttpUrl(current)
        if (!shouldReplace || current === detected.url) return prev
        replaced = true
        return detected.url
      })

      if (replaced) {
        setMobilePairAutoMessage(
          detected.source === 'tailscale'
            ? `Auto-detected Tailscale link: ${detected.url}`
            : `Auto-detected network link: ${detected.url}`
        )
      } else if (force) {
        setMobilePairAutoMessage('Keeping your existing custom mobile link.')
      }
    } catch (err) {
      console.warn('Unable to auto-detect mobile pairing link', err)
      setMobilePairAutoMessage('Auto-detect failed. You can still paste a custom link.')
    }
  }, [])

  const initialAutoPairingAttempt = useRef(false)
  useEffect(() => {
    if (initialAutoPairingAttempt.current) return
    initialAutoPairingAttempt.current = true
    void autoDetectMobilePairLink(false)
  }, [autoDetectMobilePairLink])

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

  const [theme, setTheme] = useState<ThemeName>(() => {
    if (typeof window === 'undefined') return 'light'
    try {
      const saved = window.localStorage.getItem('labnote.theme')
      if (isThemeName(saved)) return saved
    } catch (err) {
      console.warn('Unable to read cached theme', err)
    }
    return 'light'
  })
  const [diskSyncEnabled, setDiskSyncEnabled] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem('labnote.diskSync') === '1'
    } catch (err) {
      console.warn('Unable to read disk sync flag', err)
      return false
    }
  })

  useEffect(() => {
    if (!shouldAutoBootstrapMobileSetup()) return
    if (isSetupComplete()) return
    writeStoredPaths(appPaths)
    setSetupOpen(false)
  }, [appPaths])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (resetSeed) {
      try {
        window.localStorage.removeItem('labnote.entries')
        window.localStorage.removeItem('labnote.attachments')
        window.localStorage.removeItem('labnote.projects')
        window.localStorage.removeItem('labnote.experiments')
        window.localStorage.removeItem('labnote.protocols')
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
    document.documentElement.setAttribute('data-theme', theme)
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
    try {
      window.localStorage.setItem('labnote.diskSync', diskSyncEnabled ? '1' : '0')
    } catch (err) {
      console.warn('Unable to cache disk sync flag', err)
    }
  }, [diskSyncEnabled])

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
        window.localStorage.setItem(APP_MOBILE_PAIR_LINK_KEY, mobilePairLink)
      } catch (err) {
        console.warn('Unable to cache mobile pairing link', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [mobilePairLink])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleOnline = () => setBrowserOnline(true)
    const handleOffline = () => setBrowserOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    const url = mobilePairLink.trim()
    if (!url || !isHttpUrl(url)) {
      setMobilePairQrDataUrl('')
      return
    }

    let cancelled = false
    void toQrDataUrl(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      .then((result) => {
        if (!cancelled) setMobilePairQrDataUrl(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMobilePairQrDataUrl('')
          console.warn('Unable to generate mobile pairing QR', err)
        }
      })

    return () => {
      cancelled = true
    }
  }, [mobilePairLink, settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const url = mobilePairLink.trim()
    if (!url || !isHttpUrl(url)) {
      setMobilePairStatus('idle')
      return
    }
    if (!browserOnline) {
      setMobilePairStatus('offline')
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 4500)
    setMobilePairStatus('checking')

    void (async () => {
      try {
        const target = new URL(url)
        const sameOrigin = typeof window !== 'undefined' && target.origin === window.location.origin
        await fetch(target.toString(), {
          method: 'GET',
          cache: 'no-store',
          mode: sameOrigin ? 'same-origin' : 'no-cors',
          signal: controller.signal,
        })
        setMobilePairStatus('online')
      } catch (err) {
        if (isAbortError(err)) return
        setMobilePairStatus('offline')
      } finally {
        window.clearTimeout(timeout)
      }
    })()

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [browserOnline, mobilePairLink, settingsOpen])

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

  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem('labnote.protocols', JSON.stringify(protocols))
      } catch (err) {
        console.warn('Unable to cache protocols', err)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [protocols])

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

  const handleDateRangeChange = useCallback((range: DateRange) => {
    setDateRange(range)
    setSelectedDate(null)
  }, [])

  const handleClearFilters = useCallback(() => {
    setSelectedProjectTags([])
    setSelectedExperimentTags([])
    setFilterHasImage(false)
    setFilterHasFile(false)
    setDateRange({ start: '', end: '' })
    setSelectedDate(null)
    setSelectedProject('all')
    setSelectedExperiment('all')
  }, [])

  const handleSelectEntry = useCallback(
    (entryId: string) => {
      const entry = entryDrafts[entryId]
      if (entry && selectedDate && entry.dateBucket && entry.dateBucket !== selectedDate) {
        handleSelectDate(entry.dateBucket)
      }
      setSelectedEntryId(entryId)
      setActivePane('entries')
    },
    [entryDrafts, handleSelectDate, selectedDate]
  )

  const handleSelectProtocol = useCallback((protocolId: string) => {
    setSelectedProtocolId(protocolId)
    setActivePane('protocols')
  }, [])

  const handleDeleteEntry = useCallback(
    (entryId: string) => {
      const entry = entryDrafts[entryId]
      if (!entry) return
      const ok = window.confirm(`Delete "${entry.title || 'Untitled note'}"? This cannot be undone.`)
      if (!ok) return

      const remainingIds = Object.keys(entryDrafts).filter((id) => id !== entryId)

      setEntryDrafts((prev) => {
        const next = { ...prev }
        delete next[entryId]
        return next
      })
      setAttachmentsStore((prev) => prev.filter((att) => att.entryId !== entryId))
      setChangeQueue((prev) => prev.filter((c) => c.entryId !== entryId))
      setOpenEntryIds((prev) => prev.filter((id) => id !== entryId))
      setSelectedEntryId((prev) => (prev === entryId ? (remainingIds[0] ?? '') : prev))
    },
    [entryDrafts]
  )

  const selectedExperimentObj =
    selectedExperiment !== 'all' && selectedExperiment !== 'none'
      ? experiments.find((ex) => ex.id === selectedExperiment)
      : undefined
  const fallbackProjectId = sampleData.users[1]?.settings.defaultProjectId ?? projects[0]?.id ?? ''
  const defaultProjectIdForEntry =
    selectedProject !== 'all'
      ? selectedProject
      : selectedExperimentObj?.projectId ?? fallbackProjectId

  const openDailyEntry = useCallback(
    (date: Date, opts?: { autoEdit?: boolean; focusDate?: boolean }) => {
      const nowIso = date.toISOString()
      const dateBucket = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
      ).padStart(2, '0')}`
      let entry = entryList.find((item) => item.dateBucket === dateBucket)

      if (!entry) {
        const entryId = newId('entry-')
        const experimentId =
          selectedExperiment !== 'all' && selectedExperiment !== 'none' ? selectedExperiment : undefined
        const { content, pinnedRegions } = buildTemplate('day', entryId, nowIso)

        const newEntry: Entry = {
          id: entryId,
          experimentId,
          projectId: defaultProjectIdForEntry,
          createdDatetime: nowIso,
          lastEditedDatetime: nowIso,
          authorId: sampleData.users[1]?.id ?? sampleData.users[0]?.id ?? 'me',
          title: dateOnly.format(date),
          dateBucket,
          isDaily: true,
          content,
          tags: [],
          projectTags: [],
          experimentTags: [],
          searchTerms: [],
          linkedFiles: [],
          pinnedRegions,
        }

        entry = newEntry
        setEntryDrafts((prev) => ({ ...prev, [entryId]: newEntry }))
      } else {
        const compacted = condenseLegacyDailyEntry(entry)
        if (compacted !== entry) {
          entry = compacted
          const compactedId = compacted.id
          setEntryDrafts((prev) => ({ ...prev, [compactedId]: compacted }))
        }
      }

      setSelectedEntryId(entry.id)
      setActivePane('entries')
      if (opts?.focusDate !== false) {
        handleSelectDate(dateBucket)
      }
      setSelectedProjectTags([])
      setSelectedExperimentTags([])
      if (opts?.autoEdit) setAutoEditEntryId(entry.id)
    },
    [defaultProjectIdForEntry, entryList, handleSelectDate, selectedExperiment]
  )

  const handleCreateEntryForDate = useCallback(
    (dateBucket: string) => {
      if (!dateBucket) return
      openDailyEntry(dateFromBucket(dateBucket), { autoEdit: true })
    },
    [openDailyEntry]
  )

  const handleOpenToday = useCallback(() => {
    openDailyEntry(new Date(), { autoEdit: true })
  }, [openDailyEntry])

  useEffect(() => {
    if (dailySeededRef.current) return
    openDailyEntry(new Date(), { autoEdit: true, focusDate: false })
    dailySeededRef.current = true
  }, [openDailyEntry])

  const handleCreateProtocol = useCallback(
    (opts: { title?: string; templateId: EntryTemplateId }) => {
      const now = new Date()
      const nowIso = now.toISOString()
      const protocolId = newId('protocol-')
      const title = opts.title?.trim() || `Untitled protocol – ${dateOnly.format(now)}`
      const { content } = buildTemplate(opts.templateId, protocolId, nowIso)

      const protocol: Protocol = {
        id: protocolId,
        title,
        createdDatetime: nowIso,
        lastEditedDatetime: nowIso,
        content,
        tags: [],
        searchTerms: [],
      }

      setProtocols((prev) => [protocol, ...prev])
      setSelectedProtocolId(protocolId)
      setActivePane('protocols')
      setNewProtocolOpen(false)
    },
    []
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

  const parseSharedStatePayload = useCallback((raw: unknown) => {
    const state = isRecord(raw) && isRecord(raw.state) ? raw.state : raw
    if (!isRecord(state)) return null
    if (!Array.isArray(state.projects) || !Array.isArray(state.experiments) || !isRecord(state.entries) || !Array.isArray(state.attachments)) {
      return null
    }
    return {
      projects: state.projects as Project[],
      experiments: state.experiments as Experiment[],
      entries: state.entries as Record<string, Entry>,
      attachments: state.attachments as Attachment[],
    }
  }, [])

  const applySharedStatePayload = useCallback(
    (payload: { projects: Project[]; experiments: Experiment[]; entries: Record<string, Entry>; attachments: Attachment[] }) => {
      const normalizedEntries = Object.fromEntries(
        Object.entries(payload.entries).map(([id, entry]) => [
          id,
          condenseLegacyDailyEntry(ensureEntryDateBucket(applyLockedTemplateHeadings(entry))),
        ])
      )

      const nextState = {
        version: SHARED_STATE_VERSION,
        projects: payload.projects,
        experiments: payload.experiments,
        entries: normalizedEntries,
        attachments: payload.attachments,
      }
      sharedStateFingerprintRef.current = JSON.stringify(nextState)

      setProjects(payload.projects)
      setExperiments(payload.experiments)
      setEntryDrafts(normalizedEntries)
      setAttachmentsStore(payload.attachments)

      const sortedEntries = Object.values(normalizedEntries).sort((a, b) => {
        const aTime = entrySortTimestamp(a)
        const bTime = entrySortTimestamp(b)
        if (aTime !== bTime) return bTime - aTime
        return (a.title ?? '').localeCompare(b.title ?? '')
      })
      const firstEntryId = sortedEntries[0]?.id ?? ''
      setSelectedEntryId((prev) => (prev && normalizedEntries[prev] ? prev : firstEntryId))
      setOpenEntryIds((prev) => {
        const next = prev.filter((id) => Boolean(normalizedEntries[id]))
        if (firstEntryId && !next.includes(firstEntryId)) next.unshift(firstEntryId)
        return next.slice(0, 5)
      })
    },
    []
  )

  useEffect(() => {
    if (!sharedApiAvailable || sharedStateReady) return
    let cancelled = false
    const loadSharedState = async () => {
      try {
        const response = await fetch(SHARED_API_STATE_URL, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const parsed = parseSharedStatePayload(await response.json())
        if (!parsed || cancelled) return
        applySharedStatePayload(parsed)
      } catch (err) {
        console.warn('Unable to load shared notebook state', err)
      } finally {
        if (!cancelled) setSharedStateReady(true)
      }
    }
    void loadSharedState()
    return () => {
      cancelled = true
    }
  }, [applySharedStatePayload, parseSharedStatePayload, sharedApiAvailable, sharedStateReady])

  useEffect(() => {
    if (!sharedApiAvailable || !sharedStateReady) return
    let cancelled = false
    const refreshSharedState = async () => {
      try {
        const response = await fetch(SHARED_API_STATE_URL, { cache: 'no-store' })
        if (!response.ok) return
        const parsed = parseSharedStatePayload(await response.json())
        if (!parsed || cancelled) return
        const incomingFingerprint = JSON.stringify({
          version: SHARED_STATE_VERSION,
          projects: parsed.projects,
          experiments: parsed.experiments,
          entries: parsed.entries,
          attachments: parsed.attachments,
        })
        if (incomingFingerprint === sharedStateFingerprintRef.current) return
        applySharedStatePayload(parsed)
      } catch {
        // Best-effort refresh when window focus changes.
      }
    }
    const onFocus = () => {
      void refreshSharedState()
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      void refreshSharedState()
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [applySharedStatePayload, parseSharedStatePayload, sharedApiAvailable, sharedStateReady])

  const applyLegacyData = useCallback(
    async (
      parsed: {
        version?: number
        projects?: Project[]
        experiments?: Experiment[]
        entries?: Record<string, Entry>
        attachments?: Attachment[]
      },
      opts?: { enableDiskSync?: boolean }
    ): Promise<{ ok: boolean; message: string }> => {
      const incomingProjects = Array.isArray(parsed.projects) ? parsed.projects : []
      const incomingExperiments = Array.isArray(parsed.experiments) ? parsed.experiments : []
      const incomingEntries = parsed.entries ?? {}
      const incomingAttachments = Array.isArray(parsed.attachments) ? parsed.attachments : []
      const nowIso = new Date().toISOString()

      const normalizeEntry = (entry: Entry, fallbackId: string): Entry => {
        const id = entry.id || fallbackId
        const createdDatetime = entry.createdDatetime || nowIso
        const lastEditedDatetime = entry.lastEditedDatetime || createdDatetime
        const dateBucket = entry.dateBucket || createdDatetime.slice(0, 10)
        const title = entry.title || dateOnly.format(new Date(createdDatetime))

        const normalized = condenseLegacyDailyEntry(
          ensureEntryDateBucket(
            applyLockedTemplateHeadings({
              ...entry,
              id,
              createdDatetime,
              lastEditedDatetime,
              dateBucket,
              title,
              authorId: entry.authorId || sampleData.users[1]?.id || sampleData.users[0]?.id || 'me',
              content: Array.isArray(entry.content) && entry.content.length > 0
                ? entry.content
                : [{ id: newId('b-'), type: 'paragraph', text: '' }],
              tags: Array.isArray(entry.tags) ? entry.tags : [],
              projectTags: Array.isArray(entry.projectTags) ? entry.projectTags : [],
              experimentTags: Array.isArray(entry.experimentTags) ? entry.experimentTags : [],
              searchTerms: Array.isArray(entry.searchTerms) ? entry.searchTerms : [],
              linkedFiles: Array.isArray(entry.linkedFiles) ? entry.linkedFiles : [],
              pinnedRegions: Array.isArray(entry.pinnedRegions) ? entry.pinnedRegions : [],
            })
          )
        )
        return normalized
      }

      const normalizedEntries: Record<string, Entry> = {}
      for (const [id, entry] of Object.entries(incomingEntries)) {
        if (!entry) continue
        normalizedEntries[entry.id ?? id] = normalizeEntry(entry as Entry, id)
      }

      const normalizedAttachments: Attachment[] = incomingAttachments
        .filter((att) => att && typeof att === 'object')
        .map((att) => ({
          id: att.id,
          entryId: att.entryId,
          type: att.type ?? 'file',
          filename: att.filename ?? 'file',
          filesize: att.filesize ?? '—',
          storagePath: att.storagePath ?? '',
          thumbnail: att.thumbnail,
          linkedRegionId: att.linkedRegionId,
          tag: att.tag,
          sampleId: att.sampleId,
          pinnedOffline: att.pinnedOffline,
          cachedPath: att.cachedPath,
          source: att.source,
          sourceMessageId: att.sourceMessageId,
          sourceMediaId: att.sourceMediaId,
          contentType: att.contentType,
          sha256: att.sha256,
        }))
        .filter((att) => att.id && att.entryId)

      const mergedProjects = incomingProjects.length
        ? Array.from(new Map([...projects, ...incomingProjects].map((p) => [p.id, p])).values())
        : projects
      const mergedExperiments = incomingExperiments.length
        ? Array.from(new Map([...experiments, ...incomingExperiments].map((e) => [e.id, e])).values())
        : experiments

      const mergedEntries: Record<string, Entry> = { ...entryDrafts }
      Object.values(normalizedEntries).forEach((incoming) => {
        const existing = mergedEntries[incoming.id]
        if (!existing) {
          mergedEntries[incoming.id] = incoming
          return
        }
        const existingTime = Date.parse(existing.lastEditedDatetime) || 0
        const incomingTime = Date.parse(incoming.lastEditedDatetime) || 0
        mergedEntries[incoming.id] = incomingTime >= existingTime ? incoming : existing
      })

      const mergedAttachments = (() => {
        const byId = new Map(attachmentsStore.map((att) => [att.id, att]))
        normalizedAttachments.forEach((att) => {
          if (!byId.has(att.id)) byId.set(att.id, att)
        })
        return Array.from(byId.values())
      })()

      setProjects(mergedProjects)
      setExperiments(mergedExperiments)
      setEntryDrafts(mergedEntries)
      setAttachmentsStore(mergedAttachments)
      setSelectedDate(null)
      setSelectedProject('all')
      setSelectedExperiment('all')
      setActivePane('entries')
      setSelectedProjectTags([])
      setSelectedExperimentTags([])
      setFilterHasImage(false)
      setFilterHasFile(false)

      try {
        window.localStorage.setItem('labnote.entries', JSON.stringify(mergedEntries))
        window.localStorage.setItem('labnote.attachments', JSON.stringify(mergedAttachments))
        window.localStorage.setItem('labnote.projects', JSON.stringify(mergedProjects))
        window.localStorage.setItem('labnote.experiments', JSON.stringify(mergedExperiments))
        if (opts?.enableDiskSync ?? false) {
          window.localStorage.setItem('labnote.diskSync', '1')
        }
      } catch (err) {
        console.warn('Unable to persist imported state immediately', err)
      }

      const sorted = Object.values(mergedEntries).sort((a, b) => entrySortTimestamp(b) - entrySortTimestamp(a))
      if (sorted[0]) {
        setSelectedEntryId(sorted[0].id)
        setOpenEntryIds([sorted[0].id])
      }

      await refreshFsState()
      if (opts?.enableDiskSync ?? false) setDiskSyncEnabled(true)

      return {
        ok: true,
        message: `Imported ${Object.keys(normalizedEntries).length} entries and ${normalizedAttachments.length} attachments.`,
      }
    },
    [
      attachmentsStore,
      entryDrafts,
      experiments,
      projects,
      refreshFsState,
    ]
  )

  const readEntryBundles = useCallback(
    async (dir: FileSystemDirectoryHandle, existingSignatures: Set<string>) => {
      const entries: Record<string, Entry> = {}
      const attachments: Attachment[] = []
      // @ts-expect-error async iterable support in FS Access API
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'directory') continue
        if (!/^\d{4}-\d{2}-\d{2}-/.test(name)) continue
        try {
          const entryHandle = await handle.getFileHandle('entry.md')
          const file = await entryHandle.getFile()
          const parsed = parseEntryMarkdown(await file.text(), name)
          if (!parsed) continue

          const signature = `${parsed.entry.dateBucket}::${parsed.entry.title.toLowerCase()}`
          if (existingSignatures.has(signature)) continue

          if (parsed.projectTitle) {
            const match = projects.find((p) => p.title === parsed.projectTitle)
            if (match) {
              parsed.entry.projectId = match.id
            } else {
              parsed.entry.projectTags = Array.from(
                new Set([...(parsed.entry.projectTags ?? []), parsed.projectTitle])
              )
            }
          }

          if (parsed.experimentTitle) {
            const match = experiments.find((e) => e.title === parsed.experimentTitle)
            if (match) {
              parsed.entry.experimentId = match.id
            } else {
              parsed.entry.experimentTags = Array.from(
                new Set([...(parsed.entry.experimentTags ?? []), parsed.experimentTitle])
              )
            }
          }

          entries[parsed.entry.id] = parsed.entry
          attachments.push(...parsed.attachments)
          existingSignatures.add(signature)
        } catch (err) {
          console.warn('Unable to read entry bundle', name, err)
        }
      }
      return { entries, attachments }
    },
    [experiments, projects]
  )

  const applyLegacyImport = useCallback(
    async (
      dir: FileSystemDirectoryHandle,
      opts?: { enableDiskSync?: boolean }
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        let handle: FileSystemFileHandle
        try {
          handle = await dir.getFileHandle('labnote-state.json')
        } catch {
          return { ok: false, message: 'labnote-state.json not found in that folder.' }
        }

        const file = await handle.getFile()
        const text = await file.text()
        const parsed = JSON.parse(text) as {
          version?: number
          projects?: Project[]
        experiments?: Experiment[]
        entries?: Record<string, Entry>
        attachments?: Attachment[]
      }
        const existingSignatures = new Set<string>()
        Object.values(entryDrafts).forEach((entry) =>
          existingSignatures.add(`${entry.dateBucket}::${entry.title.toLowerCase()}`)
        )
        Object.values(parsed.entries ?? {}).forEach((entry) => {
          if (!entry) return
          existingSignatures.add(`${entry.dateBucket}::${entry.title.toLowerCase()}`)
        })

        const bundleData = await readEntryBundles(dir, existingSignatures)
        if (Object.keys(bundleData.entries).length) {
          parsed.entries = { ...bundleData.entries, ...(parsed.entries ?? {}) }
        }
        if (bundleData.attachments.length) {
          parsed.attachments = [...(parsed.attachments ?? []), ...bundleData.attachments]
        }

        return await applyLegacyData(parsed, { enableDiskSync: opts?.enableDiskSync })
      } catch (err) {
        console.warn('Import failed', err)
        return { ok: false, message: 'Import failed. Check console for details.' }
      }
    },
    [applyLegacyData, entryDrafts, readEntryBundles]
  )

  const importLegacyState = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    if (typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker !== 'function') {
      return { ok: false, message: 'Folder picker not supported in this browser. Use “Import from file” instead.' }
    }
    const dir = await pickCacheDir()
    if (!dir) return { ok: false, message: 'No folder selected.' }
    return applyLegacyImport(dir, { enableDiskSync: true })
  }, [applyLegacyImport])

  const importLegacyFile = useCallback(async (file: File): Promise<{ ok: boolean; message: string }> => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as {
        version?: number
        projects?: Project[]
        experiments?: Experiment[]
        entries?: Record<string, Entry>
        attachments?: Attachment[]
      }
      return await applyLegacyData(parsed, { enableDiskSync: false })
    } catch (err) {
      console.warn('Import file failed', err)
      return { ok: false, message: 'Import failed. Ensure you selected labnote-state.json.' }
    }
  }, [applyLegacyData])

  const persistDiskState = useCallback(async () => {
    if (!diskSyncEnabled) return
    const dir = await getWritableCacheDir()
    if (!dir) return
    const payload = {
      version: 1,
      projects,
      experiments,
      entries: entryDrafts,
      attachments: attachmentsStore,
    }
    await writeBlobToDir(
      dir,
      'labnote-state.json',
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    )
  }, [attachmentsStore, entryDrafts, experiments, projects, diskSyncEnabled])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const id = window.setTimeout(() => {
      void persistDiskState()
    }, 600)
    return () => window.clearTimeout(id)
  }, [persistDiskState])

  useEffect(() => {
    if (autoImportAttempted) return
    if (typeof window === 'undefined') return

    const run = async () => {
      const dir = await restoreCacheHandle()
      if (!dir) {
        setAutoImportAttempted(true)
        return
      }
      const dirWithPerm = dir as FsDirectoryWithPerm
      if (dirWithPerm.queryPermission) {
        const perm = await dirWithPerm.queryPermission({ mode: 'read' })
        if (perm !== 'granted') {
          setAutoImportAttempted(true)
          return
        }
      }
      await applyLegacyImport(dir, { enableDiskSync: true })
      setAutoImportAttempted(true)
    }

    void run()
  }, [autoImportAttempted, applyLegacyImport])

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
    if (!sharedApiAvailable || !sharedStateReady) return
    const payload = {
      version: SHARED_STATE_VERSION,
      projects,
      experiments,
      entries: entryDrafts,
      attachments: attachmentsStore,
    }
    const serialized = JSON.stringify(payload)
    if (serialized === sharedStateFingerprintRef.current) return

    const id = window.setTimeout(async () => {
      try {
        const response = await fetch(SHARED_API_STATE_URL, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: serialized,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        sharedStateFingerprintRef.current = serialized
      } catch (err) {
        console.warn('Unable to sync shared notebook state', err)
      }
    }, 350)

    return () => window.clearTimeout(id)
  }, [attachmentsStore, entryDrafts, experiments, projects, sharedApiAvailable, sharedStateReady])

  const attachmentsForEntry = useCallback(
    (entryId: string) => attachmentsStore.filter((a) => a.entryId === entryId),
    [attachmentsStore]
  )

  const addAttachments = useCallback(
    async (entryId: string, files: File[]) => {
      if (!files.length) return []

      const syncRoot = normalizeSyncRoot(masterSyncPath)
      const entry = entryDrafts[entryId]
      const bundleFolder = entry ? entryBundleFolderName(entry) : 'entry'
      const saved: Attachment[] = []

      for (const file of files) {
        const id = `att-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
        const type = file.type.startsWith('image')
          ? 'image'
          : file.type === 'application/pdf'
            ? 'pdf'
            : 'file'

        if (sharedApiAvailable) {
          try {
            const dataUrl = await readFileAsDataUrl(file)
            const uploadResponse = await fetch(SHARED_API_UPLOAD_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                filename: file.name,
                dataUrl,
                type: file.type,
              }),
            })
            if (uploadResponse.ok) {
              const uploadJson = (await uploadResponse.json()) as { url?: unknown }
              if (typeof uploadJson.url === 'string' && uploadJson.url.trim()) {
                const sharedUrl = new URL(uploadJson.url, window.location.origin).toString()
                saved.push({
                  id,
                  entryId,
                  type,
                  filename: file.name,
                  filesize: `${Math.max(1, Math.round(file.size / 1024))} KB`,
                  storagePath: sharedUrl,
                  pinnedOffline: false,
                  thumbnail: type === 'image' ? sharedUrl : undefined,
                })
                continue
              }
            }
          } catch (err) {
            console.warn('Shared upload failed; falling back to local cache', err)
          }
        }

        let cachePath = ''
        try {
          // Try filesystem cache first; fallback to IndexedDB.
          const fsPath = await writeFileToCache(file)
          if (fsPath) {
            cachePath = fsPath
            setFsEnabled(true)
          } else {
            const key = await cacheFile(file)
            cachePath = `idb://${key}`
          }
        } catch (err) {
          // Mobile/private contexts can block IndexedDB or FS APIs.
          // Keep metadata so the upload still appears in-note immediately.
          console.warn('Attachment cache failed; keeping metadata-only attachment', err)
        }

        const exportName = `${id}-${safeFileName(file.name)}`
        const relativePath = `${bundleFolder}/attachments/${exportName}`
        const storagePath = syncRoot ? resolveRelativePath(syncRoot, relativePath) : cachePath || file.name

        saved.push({
          id,
          entryId,
          type,
          filename: file.name,
          filesize: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          storagePath,
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
    [entryDrafts, masterSyncPath, sharedApiAvailable]
  )

  const addFileDestination = useCallback((entryId: string, val: { path: string; label?: string }): Attachment => {
    const rawPath = val.path.trim()
    if (!rawPath) {
      throw new Error('Path is required.')
    }

    const syncRoot = normalizeSyncRoot(masterSyncPath)
    const storagePath = resolveRelativePath(syncRoot, rawPath)
    const filename = rawPath.split(/[\\/]/).filter(Boolean).pop() ?? val.label ?? 'file'
    const id = `att-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
    const att: Attachment = {
      id,
      entryId,
      type: 'raw',
      filename: filename.trim() || 'file',
      filesize: '—',
      storagePath,
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
  }, [masterSyncPath])

  const autoSaveEntryBundle = useCallback(
    async (entryId: string, content: Block[]) => {
      const current = entryDrafts[entryId]
      if (!current) return

      const entry: Entry = {
        ...current,
        content,
        lastEditedDatetime: new Date().toISOString(),
      }

      const entryAttachments = attachmentsStore.filter((a) => a.entryId === entryId)
      const attachmentsById = Object.fromEntries(entryAttachments.map((a) => [a.id, a]))
      const project = entry.projectId ? projects.find((p) => p.id === entry.projectId) : undefined
      const experiment = entry.experimentId ? experiments.find((e) => e.id === entry.experimentId) : undefined

      const attachmentExportNameById: Record<string, string> = {}
      const attachmentExportPathById: Record<string, string> = {}
      entryAttachments.forEach((att) => {
        const name = attachmentExportName(att)
        attachmentExportNameById[att.id] = name
        if (att.type === 'raw') {
          attachmentExportPathById[att.id] = att.storagePath
        } else {
          attachmentExportPathById[att.id] = `attachments/${name}`
        }
      })

      const markdown = buildEntryMarkdown(entry, project, experiment, attachmentsById, attachmentExportPathById)
      const pdfBytes = await buildEntryPdf(entry, project, experiment, attachmentsById)

      const cacheDir = await getWritableCacheDir()
      if (!cacheDir) {
        if (sharedApiAvailable) return
        downloadBlob(
          `${entryBundleFileBase(entry)}.md`,
          new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
        )
        return
      }

      const bundleFolder = entryBundleFolderName(entry)
      const entryDir = await cacheDir.getDirectoryHandle(bundleFolder, { create: true })
      const attachmentsDir = await entryDir.getDirectoryHandle('attachments', { create: true })

      await writeBlobToDir(entryDir, 'entry.md', new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
      await writeBlobToDir(entryDir, 'entry.pdf', pdfBytesToBlob(pdfBytes))

      for (const att of entryAttachments) {
        if (att.type === 'raw') continue
        const blob = await readAttachmentBlob(att, attachmentUrls)
        if (!blob) continue
        const name = attachmentExportNameById[att.id]
        await writeBlobToDir(attachmentsDir, name, blob)
      }
    },
    [attachmentsStore, attachmentUrls, entryDrafts, projects, experiments, sharedApiAvailable]
  )

  // Hydrate cached attachment thumbnails/URLs from IndexedDB and fs handles
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const urlMap: Record<string, string> = {}
      const fsDir = await restoreCacheHandle()
      const fsDirWithPerm = fsDir ? (fsDir as FsDirectoryWithPerm) : null
      const fsCanRead =
        !fsDirWithPerm?.queryPermission
          ? !!fsDir
          : (await fsDirWithPerm.queryPermission({ mode: 'read' })) === 'granted'

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
          } else if (att.thumbnail) {
            urlMap[att.id] = att.thumbnail
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
      ul.symbol-list { list-style: none; padding-left: 0; }
      ul.symbol-list li { margin: 6px 0; display: flex; gap: 8px; }
      ul.symbol-list .symbol { width: 18px; display: inline-block; text-align: center; font-weight: 600; }
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

  const filteredEntries = useMemo(() => {
    let rangeStart = timestampFromDateString(dateRange.start)
    let rangeEnd = timestampFromDateString(dateRange.end)
    if (rangeStart !== null && rangeEnd !== null && rangeStart > rangeEnd) {
      const temp = rangeStart
      rangeStart = rangeEnd
      rangeEnd = temp
    }
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
      if (!selectedDate && (rangeStart !== null || rangeEnd !== null)) {
        const entryTime = timestampFromDateString(entry.dateBucket)
        if (entryTime === null) return false
        if (rangeStart !== null && entryTime < rangeStart) return false
        if (rangeEnd !== null && entryTime > rangeEnd) return false
      }
      return true
    })
  }, [
    dateRange,
    selectedProject,
    selectedExperiment,
    selectedProjectTags,
    selectedExperimentTags,
    filterHasImage,
    filterHasFile,
    selectedDate,
    entryList,
    attachmentsForEntry,
  ])

  const filteredProtocols = useMemo(() => {
    return protocols
  }, [protocols])

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
  const protocol = protocols.find((p) => p.id === selectedProtocolId)

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

  useEffect(() => {
    if (filteredProtocols.length === 0) {
      if (selectedProtocolId) setSelectedProtocolId('')
      return
    }
    const stillVisible = filteredProtocols.some((p) => p.id === selectedProtocolId)
    if (!stillVisible) {
      setSelectedProtocolId(filteredProtocols[0].id)
    }
  }, [filteredProtocols, selectedProtocolId])

  const sidebarEntrySignals = useMemo<Record<string, SidebarEntrySignal>>(() => {
    return Object.fromEntries(
      entryList.map((entryItem) => {
        const entryAttachments = attachmentsForEntry(entryItem.id)
        const queueItems = changeQueue.filter((change) => change.entryId === entryItem.id)
        return [
          entryItem.id,
          {
            attachments: entryAttachments.length,
            images: entryAttachments.filter((att) => att.type === 'image').length,
            intake: (entryItem.telegramCaptures?.length ?? 0) + (entryItem.whatsappCaptures?.length ?? 0),
            pending: queueItems.filter((change) => change.status === 'pending').length,
            failed: queueItems.filter((change) => change.status === 'failed').length,
            verified: entryAttachments.filter((att) => Boolean(att.sha256)).length,
            source: entryItem.source,
          },
        ]
      })
    )
  }, [attachmentsForEntry, changeQueue, entryList])

  return (
    <div className="app-bg">
      <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar
          labs={sampleData.labs}
          projects={projects}
          experiments={experiments}
          entries={filteredEntries}
          allEntries={entryList}
          entrySignals={sidebarEntrySignals}
          selectedEntryId={selectedEntryId}
          protocols={filteredProtocols}
          selectedProtocolId={selectedProtocolId}
          mode={activePane}
          onModeChange={setActivePane}
          selectedProjectTags={selectedProjectTags}
          selectedExperimentTags={selectedExperimentTags}
          projectTagOptions={projectTagOptions}
          experimentTagOptions={experimentTagOptions}
          onRemoveProjectTag={removeProjectTagOption}
          onRemoveExperimentTag={removeExperimentTagOption}
          onClearFilters={handleClearFilters}
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
          onSelectEntry={handleSelectEntry}
          onSelectProtocol={handleSelectProtocol}
          onTodayEntry={handleOpenToday}
          onNewProtocol={() => {
            setActivePane('protocols')
            setNewProtocolOpen(true)
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
          selectedDate={selectedDate}
          onSelectDate={handleSelectDate}
          dateRange={dateRange}
          onDateRangeChange={handleDateRangeChange}
          onCreateEntryForDate={handleCreateEntryForDate}
          calendarMonth={calendarMonth}
          onCalendarMonthChange={setCalendarMonth}
        />
        {activePane === 'protocols' ? (
          <ProtocolPane
            key={protocol?.id ?? 'protocol-empty'}
            protocol={protocol}
            onUpdateProtocol={(protocolId, content) =>
              setProtocols((prev) =>
                prev.map((p) =>
                  p.id === protocolId
                    ? { ...p, content, lastEditedDatetime: new Date().toISOString() }
                    : p
                )
              )
            }
            onUpdateProtocolMeta={(protocolId, updates) =>
              setProtocols((prev) =>
                prev.map((p) =>
                  p.id === protocolId
                    ? { ...p, ...updates, lastEditedDatetime: new Date().toISOString() }
                    : p
                )
              )
            }
          />
        ) : (
          <EditorPane
            entry={entry}
            project={project}
            experiment={experiment}
            openEntries={openEntries}
            allEntries={entryList}
            selectedEntryId={selectedEntryId}
            onSelectEntry={handleSelectEntry}
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
            onDeleteEntry={handleDeleteEntry}
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
            onAutoSaveEntry={autoSaveEntryBundle}
            changeQueue={changeQueue.filter((c) => c.entryId === selectedEntryId)}
            syncing={syncing}
            onSyncNow={(includeFailed) => syncNow({ entryId: selectedEntryId, includeFailed })}
            autoEditEntryId={autoEditEntryId}
            onConsumeAutoEdit={() => setAutoEditEntryId(null)}
            onExportExperiment={exportExperiment}
          />
        )}
      </div>
      {newProtocolOpen && (
        <NewProtocolModal
          onClose={() => setNewProtocolOpen(false)}
          onCreate={(val) => handleCreateProtocol(val)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          theme={theme}
          onThemeChange={setTheme}
          appName={APP_NAME}
          appOwner={APP_OWNER}
          appInfo={appInfo}
          appPaths={appPaths}
          onEditSetup={handleEditSetup}
          masterSyncPath={masterSyncPath}
          onMasterSyncPathChange={setMasterSyncPath}
          mobilePairLink={mobilePairLink}
          onMobilePairLinkChange={setMobilePairLink}
          onAutoDetectMobilePairLink={() => autoDetectMobilePairLink(true)}
          mobilePairAutoMessage={mobilePairAutoMessage}
          mobilePairStatus={mobilePairStatus}
          mobilePairQrDataUrl={mobilePairQrDataUrl}
          onCopyMobilePairLink={copyMobilePairLink}
          labStoragePath={labStoragePath}
          fsEnabled={fsEnabled}
          fsNeedsPermission={fsNeedsPermission}
          fsSupported={typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === 'function'}
          onEnable={handlePromptFs}
          onPickDir={handlePickCacheDir}
          onDisconnect={handleDisconnectCacheDir}
          onValidate={validateDiskCache}
          onImportLegacy={importLegacyState}
          onImportLegacyFile={importLegacyFile}
        />
      )}
      {setupOpen && (
        <SetupWizard
          initialPaths={appPaths}
          onComplete={handleSetupComplete}
          canPickPaths={canPickPaths}
          appName={APP_NAME}
        />
      )}
    </div>
  )
}

type SidebarEntrySignal = {
  attachments: number
  images: number
  intake: number
  pending: number
  failed: number
  verified: number
  source?: Entry['source']
}

interface SidebarProps {
  labs: typeof sampleData.labs
  projects: Project[]
  experiments: Experiment[]
  entries: Entry[]
  allEntries: Entry[]
  entrySignals: Record<string, SidebarEntrySignal>
  selectedEntryId: string
  protocols: Protocol[]
  selectedProtocolId: string
  mode: 'entries' | 'protocols'
  onModeChange: (val: 'entries' | 'protocols') => void
  selectedProjectTags: string[]
  selectedExperimentTags: string[]
  projectTagOptions: string[]
  experimentTagOptions: string[]
  onRemoveProjectTag: (tag: string) => void
  onRemoveExperimentTag: (tag: string) => void
  onToggleProjectTag: (tag: string) => void
  onToggleExperimentTag: (tag: string) => void
  onClearFilters: () => void
  filterHasImage: boolean
  filterHasFile: boolean
  onToggleHasImage: () => void
  onToggleHasFile: () => void
  onSelectEntry: (id: string) => void
  onSelectProtocol: (id: string) => void
  onTodayEntry: () => void
  onNewProtocol: () => void
  onOpenSettings: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
  dateRange: DateRange
  onDateRangeChange: (range: DateRange) => void
  onCreateEntryForDate: (dateBucket: string) => void
  calendarMonth: Date
  onCalendarMonthChange: (next: Date) => void
}

function Sidebar({
  labs,
  projects,
  experiments,
  entries,
  allEntries,
  entrySignals,
  selectedEntryId,
  protocols,
  selectedProtocolId,
  mode,
  onModeChange,
  selectedProjectTags,
  selectedExperimentTags,
  projectTagOptions,
  experimentTagOptions,
  onRemoveProjectTag,
  onRemoveExperimentTag,
  onToggleProjectTag,
  onToggleExperimentTag,
  onClearFilters,
  filterHasImage,
  filterHasFile,
  onToggleHasImage,
  onToggleHasFile,
  onSelectEntry,
  onSelectProtocol,
  onTodayEntry,
  onNewProtocol,
  onOpenSettings,
  collapsed,
  onToggleCollapsed,
  selectedDate,
  onSelectDate,
  dateRange,
  onDateRangeChange,
  onCreateEntryForDate,
  calendarMonth,
  onCalendarMonthChange,
}: SidebarProps) {
  const activeLab = labs[0]
  const projectLookup = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const experimentLookup = useMemo(() => new Map(experiments.map((e) => [e.id, e])), [experiments])
  const isEntriesMode = mode === 'entries'
  const calendarLabel = useMemo(() => {
    return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(calendarMonth)
  }, [calendarMonth])

  const entryDateSet = useMemo(() => new Set(allEntries.map((entry) => entry.dateBucket)), [allEntries])
  const selectedDateHasEntry = selectedDate ? entryDateSet.has(selectedDate) : false
  const selectedDateLabel = selectedDate ? dateOnly.format(dateFromBucket(selectedDate)) : ''

  const getEntryPill = useCallback(
    (entry: Entry) => {
      const experimentTitle = entry.experimentId ? experimentLookup.get(entry.experimentId)?.title : undefined
      const projectTitle = entry.projectId ? projectLookup.get(entry.projectId)?.title : undefined

      if (experimentTitle) {
        return { label: experimentTitle, className: 'pill ghost-pill' }
      }
      if (entry.experimentTags?.[0]) {
        return { label: entry.experimentTags[0], className: 'pill ghost-pill' }
      }
      if (projectTitle) {
        return { label: projectTitle, className: 'pill ghost-pill' }
      }
      if (entry.projectTags?.[0]) {
        return { label: entry.projectTags[0], className: 'pill ghost-pill' }
      }
      if (entry.tags[0]) {
        return { label: entry.tags[0], className: 'pill ghost-pill' }
      }
      return { label: 'Entry', className: 'pill soft' }
    },
    [experimentLookup, projectLookup]
  )

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
    <aside className={`panel sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Lab navigation">
      <div className="sidebar-header">
        <div className="brand-row">
          <img src={logoMark} alt={`${APP_NAME} logo`} className="brand-mark" />
          <div className="brand-meta">
            <div className="brand-title">{APP_NAME}</div>
            <div className="muted tiny">{activeLab?.name ?? 'Active lab'}</div>
          </div>
        </div>
        <div className="sidebar-header-actions">
          <div className="status-chip success">Sync ready</div>
          <button className="pill soft icon-button" onClick={onOpenSettings} type="button" data-testid="settings-button">
            <span className="icon"><UiIcon name="settings" /></span>
            <span className="icon-label">Settings</span>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="sidebar-content">
          <div className="lab-card">
            <div className="eyebrow">Lab details</div>
            <h2 className="title-sm lab-title">{activeLab?.name ?? 'Lab'}</h2>
            <div className="muted tiny">Storage: {activeLab?.storageConfig.path ?? 'Not set'}</div>
            <div className="lab-card-meta">
              <div className="pill ghost-pill">{entries.length} entries</div>
              <div className="pill ghost-pill">{protocols.length} protocols</div>
            </div>
          </div>

          <div className="mode-toggle" role="tablist" aria-label="Entries and protocols">
            <button
              className={`pill soft ${isEntriesMode ? 'active-pill' : ''}`}
              type="button"
              role="tab"
              aria-selected={isEntriesMode}
              onClick={() => onModeChange('entries')}
            >
              Entries
            </button>
            <button
              className={`pill soft ${!isEntriesMode ? 'active-pill' : ''}`}
              type="button"
              role="tab"
              aria-selected={!isEntriesMode}
              onClick={() => onModeChange('protocols')}
            >
              Protocols
            </button>
          </div>

          {isEntriesMode ? (
            <div className="quick-actions">
              <button className="accent" onClick={onTodayEntry} data-testid="today-entry">
                <span className="icon"><UiIcon name="plus" /></span>
                Today's Entry
              </button>
            </div>
          ) : (
            <div className="quick-actions">
              <button className="accent" onClick={onNewProtocol} data-testid="new-protocol">
                <span className="icon"><UiIcon name="book" /></span>
                New Protocol
              </button>
            </div>
          )}

          {isEntriesMode && (
            <button className="sidebar-search-reference" type="button" onClick={() => onModeChange('entries')}>
              <span>Search entries</span>
              <kbd>Ctrl K</kbd>
            </button>
          )}

          {isEntriesMode ? (
            <>
              <section className="sidebar-section sidebar-filter-section">
                <div className="section-row">
                  <div className="section-title">Filters</div>
                  <button className="ghost subtle" type="button" onClick={onClearFilters} data-testid="clear-filters">
                    Clear
                  </button>
                </div>
                <div className="tag-filter-stack">
                  <TagFilterDropdown
                    label="Project tags"
                    icon="🗂"
                    options={projectTagOptions}
                    selected={selectedProjectTags}
                    onToggle={onToggleProjectTag}
                    onRemoveOption={onRemoveProjectTag}
                    testId="project-tag-filter"
                    placeholder="Project tags"
                  />
                  <TagFilterDropdown
                    label="Experiment tags"
                    icon="🧪"
                    options={experimentTagOptions}
                    selected={selectedExperimentTags}
                    onToggle={onToggleExperimentTag}
                    onRemoveOption={onRemoveExperimentTag}
                    testId="experiment-tag-filter"
                    placeholder="Experiment tags"
                  />
                </div>

                <div>
                  <div className="section-title">Attachments</div>
                  <div className="chip-row">
                    <button
                      className={`pill soft filter-chip ${filterHasImage ? 'active-pill' : ''}`}
                      onClick={onToggleHasImage}
                    >
                      Images
                    </button>
                    <button
                      className={`pill soft filter-chip ${filterHasFile ? 'active-pill' : ''}`}
                      onClick={onToggleHasFile}
                    >
                      Files
                    </button>
                  </div>
                </div>
              </section>

              <section className="sidebar-section sidebar-calendar-section">
                <div className="section-title">Calendar</div>
                <div className="calendar-range">
                  <label className="field">
                    <span className="muted tiny">From</span>
                    <input
                      type="date"
                      value={dateRange.start}
                      onChange={(e) => onDateRangeChange({ start: e.target.value, end: dateRange.end })}
                      data-testid="date-range-start"
                    />
                  </label>
                  <label className="field">
                    <span className="muted tiny">To</span>
                    <input
                      type="date"
                      value={dateRange.end}
                      onChange={(e) => onDateRangeChange({ start: dateRange.start, end: e.target.value })}
                      data-testid="date-range-end"
                    />
                  </label>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => onDateRangeChange({ start: '', end: '' })}
                    data-testid="date-range-clear"
                  >
                    All
                  </button>
                </div>
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
                        ‹
                      </button>
                      <button
                        type="button"
                        aria-label="Next month"
                        onClick={() =>
                          onCalendarMonthChange(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))
                        }
                      >
                        ›
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
                      const hasEntry = entryDateSet.has(day.iso)
                      return (
                        <button
                          key={day.iso}
                          type="button"
                          className={`calendar-day${day.isOutside ? ' outside' : ''}${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}${hasEntry ? ' has-entry' : ''}`}
                          onClick={() => {
                            if (isSelected) {
                              onSelectDate(null)
                              return
                            }
                            onSelectDate(day.iso)
                          }}
                          aria-pressed={isSelected}
                          aria-label={`${day.day} ${calendarLabel}${hasEntry ? ' (has entry)' : ''}`}
                          data-testid={`calendar-day-${day.iso}`}
                        >
                          {day.day}
                          {hasEntry && <span className="calendar-dot" aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                  {selectedDate && !selectedDateHasEntry && (
                    <div className="calendar-create">
                      <div className="muted tiny">No entry for {selectedDateLabel} yet.</div>
                      <button
                        className="accent"
                        type="button"
                        onClick={() => onCreateEntryForDate(selectedDate)}
                        data-testid="calendar-create-entry"
                      >
                        <span className="icon"><UiIcon name="plus" /></span>
                        Add entry for {selectedDateLabel}
                      </button>
                    </div>
                  )}
                </div>
              </section>

              <section className="sidebar-section sidebar-entries-section">
                <div className="section-title">Recent entries</div>
                <div className="muted tiny" style={{ marginBottom: 6 }}>
                  Showing {entries.length} item{entries.length === 1 ? '' : 's'}
                </div>
                <div className="entry-list" data-testid="entry-list">
                  {entries.length === 0 && (
                    <div className="muted tiny">No entries match these filters.</div>
                  )}
                  {entries.map((e, index) => {
                    const signals = entrySignals[e.id]
                    const pill = getEntryPill(e)
                    const syncLabel = signals?.failed
                      ? 'Sync failed'
                      : signals?.pending
                        ? 'Sync pending'
                        : 'Synced'
                    const signalSummary = signals?.intake
                      ? `${signals.intake} intake`
                      : signals?.attachments
                        ? `${signals.attachments} file${signals.attachments === 1 ? '' : 's'}`
                        : ''
                    return (
                      <button
                        key={e.id}
                        className={`entry-item ${selectedEntryId === e.id ? 'active' : ''}`}
                        onClick={() => onSelectEntry(e.id)}
                        data-testid={`entry-list-item-${e.id}`}
                        style={{ '--row-index': index } as React.CSSProperties}
                      >
                        <div>
                          <div className="title-sm">{e.title}</div>
                          <p className="muted tiny">{dateOnly.format(new Date(e.createdDatetime))}</p>
                        </div>
                        <div className="entry-signal-row">
                          <span className={pill.className}>{pill.label}</span>
                          {signalSummary ? <span className="entry-signal summary">{signalSummary}</span> : null}
                          <span className={`entry-signal ${signals?.failed ? 'danger' : signals?.pending ? 'warning' : 'success'}`}>
                            {syncLabel}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>
            </>
          ) : (
            <section className="sidebar-section">
              <div className="section-title">Protocols</div>
              <div className="muted tiny" style={{ marginBottom: 6 }}>
                Showing {protocols.length} item{protocols.length === 1 ? '' : 's'}
              </div>
              <div className="entry-list" data-testid="protocol-list">
                {protocols.length === 0 && (
                  <div className="muted tiny">No protocols yet. Create one to get started.</div>
                )}
                {protocols.map((protocol, index) => (
                  <button
                    key={protocol.id}
                    className={`entry-item ${selectedProtocolId === protocol.id ? 'active' : ''}`}
                    onClick={() => onSelectProtocol(protocol.id)}
                    data-testid={`protocol-list-item-${protocol.id}`}
                    style={{ '--row-index': index } as React.CSSProperties}
                  >
                    <div>
                      <div className="title-sm">{protocol.title}</div>
                      <p className="muted tiny">Updated {dateOnly.format(new Date(protocol.lastEditedDatetime))}</p>
                    </div>
                    {protocol.tags[0] ? (
                      <div className="pill ghost-pill">{protocol.tags[0]}</div>
                    ) : (
                      <div className="pill soft">Protocol</div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="sidebar-footer">
        <button
          className="pill soft sidebar-toggle"
          type="button"
          onClick={onToggleCollapsed}
          data-testid="sidebar-toggle"
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show panel' : 'Hide panel'}
        </button>
        <div className="sidebar-footer-meta">
          <span className="muted tiny">Made by {APP_OWNER}</span>
        </div>
      </div>
    </aside>
  )
}

interface EditorPaneProps {
  entry?: Entry
  project?: Project
  experiment?: Experiment
  openEntries: Entry[]
  allEntries: Entry[]
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
  onDeleteEntry: (entryId: string) => void
  onEnqueueChange: (entryId: string, blockIds: string[], timestamp: string) => void
  onAutoSaveEntry: (entryId: string, content: Block[]) => Promise<void>
  changeQueue: ChangeQueueItem[]
  syncing: boolean
  onSyncNow: (includeFailed: boolean) => void
  autoEditEntryId: string | null
  onConsumeAutoEdit: () => void
  onExportExperiment: (experimentId: string, format: 'markdown' | 'pdf') => Promise<void>
}

interface ProtocolPaneProps {
  protocol?: Protocol
  onUpdateProtocol: (protocolId: string, content: Block[]) => void
  onUpdateProtocolMeta: (protocolId: string, updates: Partial<Protocol>) => void
}

function EditorPane({
  entry,
  project,
  experiment,
  openEntries,
  allEntries,
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
  onDeleteEntry,
  onEnqueueChange,
  onAutoSaveEntry,
  changeQueue,
  syncing,
  onSyncNow,
  autoEditEntryId,
  onConsumeAutoEdit,
  onExportExperiment,
}: EditorPaneProps) {
  const [exporting, setExporting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [activeTab, setActiveTab] = useState<'note' | 'workbook' | 'files' | 'details'>('note')
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const [contextCollapsed, setContextCollapsed] = useState(false)
  const [editor] = useState<HistoryReactEditor>(() =>
    withHistory(withChecklists(withReact(createEditor() as ReactEditor))) as HistoryReactEditor
  )
  const [tabsViewOpen, setTabsViewOpen] = useState(false)
  const lastEntryIdRef = useRef<string | null>(null)
  const [editorRevision, setEditorRevision] = useState(0)
  const [editorValue, setEditorValue] = useState<Descendant[]>(
    () => blocksToSlate(getNoteBlocksForEntry(entry))
  )
  const [workbookData, setWorkbookData] = useState<string[][]>(() => getWorkbookDataForEntry(entry))
  const [workbookStyles, setWorkbookStyles] = useState<WorkbookCellStyles>(() => getWorkbookStylesForEntry(entry))
  const focusEditor = useCallback(() => {
    try {
      const start = Editor.start(editor, [])
      Transforms.select(editor, start)
      ReactEditor.focus(editor)
    } catch {
      // Slate can briefly expose an empty root while switching entries; focus will retry on the next edit action.
    }
  }, [editor])

  useEffect(() => {
    if (!entry) return
    const isNewEntry = lastEntryIdRef.current !== entry.id
    if (isNewEntry) {
      lastEntryIdRef.current = entry.id
      setIsEditing(false)
      setEditorValue(blocksToSlate(getNoteBlocksForEntry(entry)))
      setWorkbookData(getWorkbookDataForEntry(entry))
      setWorkbookStyles(getWorkbookStylesForEntry(entry))
      setActiveTab('note')
      return
    }
    if (!isEditing) {
      setEditorValue(blocksToSlate(getNoteBlocksForEntry(entry)))
      setWorkbookData(getWorkbookDataForEntry(entry))
      setWorkbookStyles(getWorkbookStylesForEntry(entry))
    }
  }, [entry, isEditing])

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
  const imageCount = attachments.filter((a) => a.type === 'image').length
  const fileCount = attachments.length - imageCount
  const intakeCount = (entry?.telegramCaptures?.length ?? 0) + (entry?.whatsappCaptures?.length ?? 0)
  const latestAttachments = attachments.slice(0, 3)
  const verifiedAttachmentCount = attachments.filter((a) => Boolean(a.sha256)).length
  const hasWorkbook = workbookHasContent(workbookData)
  const saveStateLabel = syncing
    ? 'Syncing changes'
    : failedCount
      ? `${failedCount} sync issue${failedCount === 1 ? '' : 's'}`
      : pendingCount
        ? 'Saved locally · sync pending'
        : 'Saved locally · synced'

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
    const blocks = getNoteBlocksForEntry(entry)
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
  }, [entry])

  const toggleHeader = useCallback(() => {
    setHeaderCollapsed((prev) => {
      const next = !prev
      if (next) setTabsViewOpen(false)
      return next
    })
  }, [])

  const tutorialSteps: TutorialStep[] = useMemo(
    () => [
      {
        selector: '[data-testid="tabs-view-toggle"]',
        title: 'Tab navigator',
        description: 'Use Tabs view to switch quickly between open entries and browse the full notebook list.',
      },
      {
        selector: '[data-testid="entry-date-bucket"]',
        title: 'Entry context',
        description: 'This date bucket shows which entry is active in the current editor panel.',
      },
      {
        selector: '[data-testid="editor-tab-note"]',
        title: 'Note tab',
        description: 'Main writing space for protocols, observations, and decisions.',
      },
      {
        selector: '[data-testid="edit-note-btn"]',
        title: 'Enter edit mode',
        description: 'Click Edit to switch from read mode into the rich editor.',
      },
      {
        selector: '[data-testid="editor-toolbar"]',
        title: 'Formatting toolbar',
        description: 'In edit mode, apply fonts, highlights, emphasis, alignment, and structured blocks.',
      },
      {
        selector: '[data-testid="editor-tab-files"]',
        title: 'Files tab',
        description: 'Review and manage uploaded attachments linked to this note.',
      },
      {
        selector: '[data-testid="editor-tab-workbook"]',
        title: 'Workbook tab',
        description: 'Paste spreadsheet-style data into the day entry only when the entry needs tabular calculations or raw values.',
      },
      {
        selector: '[data-testid="editor-tab-details"]',
        title: 'Details tab',
        description: 'Manage note metadata, tags, and sync controls for this entry.',
      },
      {
        selector: '[data-testid="entry-tags-inline"]',
        title: 'Inline tags',
        description: 'Apply project and experiment tags directly from the main editor header.',
      },
      {
        selector: '[data-testid="sync-status-chip"]',
        title: 'Sync status',
        description: 'Tracks whether this entry is synced, pending, syncing, or failed.',
      },
      {
        selector: '[data-testid="export-pdf"]',
        title: 'Export output (final step)',
        description: 'Export experiment records to PDF after review and tagging are complete.',
      },
    ],
    []
  )

  if (!entry) {
    return (
      <main className="panel editor">
        <div className="empty">Select or create a note to get started.</div>
      </main>
    )
  }

  const handleSave = () => {
    const timestamp = new Date().toISOString()
    const noteBlocks = slateToBlocks(editorValue).map((block) => ({
      ...block,
      updatedAt: timestamp,
      updatedBy: 'me',
    }))
    const existingWorkbook = getWorkbookBlock(entry)
    const compactWorkbook = compactWorkbookData(workbookData)
    const compactStyles = compactWorkbookStyles(workbookStyles, compactWorkbook)
    const workbookBlock: Block | null = compactWorkbook.length
      ? {
          id: existingWorkbook?.id ?? newId('b-workbook-'),
          type: 'workbook',
          title: 'Workbook',
          data: compactWorkbook,
          ...(Object.keys(compactStyles).length ? { styles: compactStyles } : {}),
          updatedAt: timestamp,
          updatedBy: 'me',
        }
      : null
    const updatedBlocks = workbookBlock ? [...noteBlocks, workbookBlock] : noteBlocks
    onUpdateEntry(entry.id, updatedBlocks)
    onEnqueueChange(entry.id, updatedBlocks.map((b) => b.id), timestamp)
    void onAutoSaveEntry(entry.id, updatedBlocks)
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
      <div className={`editor-header ${headerCollapsed ? 'collapsed' : ''}`} data-testid="editor-header">
        <div className="editor-header-inner">
          <div className="entry-tabs-row">
            {openEntries.length > 1 && (
              <div className="entry-tabs" role="tablist" aria-label="Open entries">
                {openEntries.map((tab) => {
                  const tabTestId = tab.dateBucket ? `entry-tab-${tab.dateBucket}` : `entry-tab-${tab.id}`
                  return (
                  <div key={tab.id} className={`entry-tab ${selectedEntryId === tab.id ? 'active' : ''}`}>
                    <button
                      type="button"
                      className="entry-tab-main"
                      role="tab"
                      aria-selected={selectedEntryId === tab.id}
                      onClick={() => onSelectEntry(tab.id)}
                      data-testid={tabTestId}
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
                  )
                })}
              </div>
            )}
            <button
              className={`pill soft tabs-view-toggle ${tabsViewOpen ? 'active-pill' : ''}`}
              type="button"
              onClick={() => setTabsViewOpen((prev) => !prev)}
              data-testid="tabs-view-toggle"
              aria-expanded={tabsViewOpen}
            >
              Tabs view
            </button>
          </div>
          {tabsViewOpen && (
            <div className="tabs-view-panel" data-testid="tabs-view">
              <div className="tabs-view-head">
                <div>
                  <div className="section-title">Open tabs</div>
                  <div className="muted tiny">Showing {openEntries.length} open tab{openEntries.length === 1 ? '' : 's'}.</div>
                </div>
                <button
                  className="pill soft"
                  type="button"
                  onClick={() => setTabsViewOpen(false)}
                  data-testid="tabs-view-close"
                >
                  Close
                </button>
              </div>
              <div className="tabs-view-slide-grid">
                {openEntries.map((tab, index) => {
                  const previewLines = entryPreviewLines(tab, 3)
                  return (
                    <div
                      key={`panel-${tab.id}`}
                      className={`tabs-view-slide ${selectedEntryId === tab.id ? 'active' : ''}`}
                      data-testid={`tabs-view-slide-${tab.id}`}
                      style={{ '--stagger': index } as React.CSSProperties}
                    >
                      <button
                        type="button"
                        className="tabs-view-slide-main"
                        onClick={() => onSelectEntry(tab.id)}
                        aria-pressed={selectedEntryId === tab.id}
                      >
                        <div className="tabs-view-slide-header">
                          <span className="tabs-view-slide-title">{tab.title}</span>
                          <span className="tabs-view-slide-date">{tab.dateBucket}</span>
                        </div>
                        <div className="tabs-view-slide-body">
                          {previewLines.map((line, lineIdx) => (
                            <div key={`${tab.id}-line-${lineIdx}`} className="tabs-view-slide-line">
                              <span className="tabs-view-slide-text">{line}</span>
                            </div>
                          ))}
                        </div>
                        <div className="tabs-view-slide-footer">
                          <span>Slide {index + 1}</span>
                          {selectedEntryId === tab.id && <span className="tabs-view-slide-active">Active</span>}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="tabs-view-slide-close"
                        onClick={() => onCloseEntryTab(tab.id)}
                        aria-label={`Close ${tab.title}`}
                        disabled={openEntries.length <= 1}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
                {openEntries.length === 0 && <div className="muted tiny">No open tabs yet.</div>}
              </div>
              <div className="tabs-view-head">
                <div>
                  <div className="section-title">Browse entries</div>
                  <div className="muted tiny">Showing {allEntries.length} total entries.</div>
                </div>
              </div>
              <div className="tabs-view-list">
                {allEntries.length === 0 && <div className="muted tiny">No entries available.</div>}
                {allEntries.map((entryItem) => (
                  <button
                    key={`browse-${entryItem.id}`}
                    className={`entry-item ${selectedEntryId === entryItem.id ? 'active' : ''}`}
                    onClick={() => onSelectEntry(entryItem.id)}
                  >
                    <div>
                      <div className="title-sm">{entryItem.title}</div>
                      <p className="muted tiny">{dateOnly.format(new Date(entryItem.createdDatetime))}</p>
                    </div>
                    {entryItem.experimentTags?.[0] ? (
                      <div className="pill ghost-pill">{entryItem.experimentTags[0]}</div>
                    ) : entryItem.projectTags?.[0] ? (
                      <div className="pill ghost-pill">{entryItem.projectTags[0]}</div>
                    ) : entryItem.tags[0] ? (
                      <div className="pill ghost-pill">{entryItem.tags[0]}</div>
                    ) : (
                      <div className="pill soft">Entry</div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="breadcrumb-row">
            <div className="breadcrumbs">
              <span>{project?.title ?? 'Project'}</span>
              <span>/</span>
              <span>{experiment?.title ?? 'General note'}</span>
              <span className="pill soft" data-testid="entry-date-bucket">{entry.dateBucket}</span>
              <span className={`status-chip ${syncing || hasWork ? 'warning' : 'success'}`} data-testid="sync-status-chip">
                {syncing ? 'Syncing…' : failedCount ? `${failedCount} failed` : pendingCount ? `${pendingCount} pending` : 'Synced'}
              </span>
            </div>

            <div className="editor-actions">
              <GuidedTutorial
                steps={tutorialSteps}
                startLabel="Tutorial"
                onStart={() => {
                  setHeaderCollapsed(false)
                  setActiveTab('note')
                }}
              />
              <button className="ghost icon-btn" type="button" onClick={toggleHeader} data-testid="header-toggle">
                <span className="icon"><UiIcon name={headerCollapsed ? 'chevronDown' : 'chevronUp'} /></span>
                {headerCollapsed ? 'Show header' : 'Hide header'}
              </button>
              {(pendingCount > 0 || failedCount > 0) && (
                <button
                  className="ghost icon-btn"
                  type="button"
                  data-testid="sync-action"
                  onClick={() => onSyncNow(failedCount > 0)}
                  disabled={syncing}
                >
                  <span className="icon"><UiIcon name="refresh" /></span>
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
                    <span className="icon"><UiIcon name="download" /></span>
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
                    <span className="icon"><UiIcon name="download" /></span>
                    Export MD
                  </button>
                </>
              ) : (
                <button className="ghost icon-btn" disabled title="Attach this note to an experiment to export a bundle.">
                  <span className="icon"><UiIcon name="download" /></span>
                  Export PDF
                </button>
              )}
              {!isEditing ? (
                <button className="accent icon-btn" onClick={() => setIsEditing(true)} data-testid="edit-note-btn">
                  <span className="icon"><UiIcon name="edit" /></span>
                  Edit
                </button>
              ) : (
                <div className="edit-actions">
                  <button
                    className="ghost icon-btn"
                    onClick={() => {
                      setIsEditing(false)
                      setEditorValue(blocksToSlate(getNoteBlocksForEntry(entry)))
                      setWorkbookData(getWorkbookDataForEntry(entry))
                      setWorkbookStyles(getWorkbookStylesForEntry(entry))
                    }}
                  >
                    <span className="icon"><UiIcon name="x" /></span>
                    Cancel
                  </button>
                  <button className="accent icon-btn" onClick={handleSave} data-testid="entry-save">
                    <span className="icon"><UiIcon name="save" /></span>
                    Save
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="title-row">
            <h1>{entry.title}</h1>
            {experiment?.protocolRef && <span className="pill">{experiment.protocolRef}</span>}
            <span className={`status-chip provenance-chip ${failedCount ? 'danger' : pendingCount || syncing ? 'warning' : 'success'}`}>
              {saveStateLabel}
            </span>
          </div>
          <div className="tag-editor" data-testid="entry-tags-inline">
            <TagPicker
              variant="inline"
              label="Project tags"
              icon="🗂"
              options={projectTagOptions}
              selected={entry.projectTags ?? []}
              onToggle={(tag) => {
                const next = new Set(entry.projectTags ?? [])
                if (next.has(tag)) next.delete(tag)
                else next.add(tag)
                onUpdateEntryMeta(entry.id, { projectTags: Array.from(next) })
              }}
              onAdd={onAddProjectTagOption}
              testId="entry-project-tags-inline"
            />
            <TagPicker
              variant="inline"
              label="Experiment tags"
              icon="🧪"
              options={experimentTagOptions}
              selected={entry.experimentTags ?? []}
              onToggle={(tag) => {
                const next = new Set(entry.experimentTags ?? [])
                if (next.has(tag)) next.delete(tag)
                else next.add(tag)
                onUpdateEntryMeta(entry.id, { experimentTags: Array.from(next) })
              }}
              onAdd={onAddExperimentTagOption}
              testId="entry-experiment-tags-inline"
            />
          </div>
          <div className="meta-row">
            <span className="muted tiny">Edited {dateOnly.format(new Date(entry.lastEditedDatetime))}</span>
          </div>
          <div className="editor-tabs" role="tablist">
            <button
              type="button"
              className={`tab-button ${activeTab === 'note' ? 'active' : ''}`}
              onClick={() => setActiveTab('note')}
              role="tab"
              aria-selected={activeTab === 'note'}
              data-testid="editor-tab-note"
            >
              <span className="icon"><UiIcon name="note" /></span>
              Note
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'workbook' ? 'active' : ''}`}
              onClick={() => setActiveTab('workbook')}
              role="tab"
              aria-selected={activeTab === 'workbook'}
              data-testid="editor-tab-workbook"
            >
              <span className="icon"><UiIcon name="table" /></span>
              Workbook
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'files' ? 'active' : ''}`}
              onClick={() => setActiveTab('files')}
              role="tab"
              aria-selected={activeTab === 'files'}
              data-testid="editor-tab-files"
            >
              <span className="icon"><UiIcon name="folder" /></span>
              Files
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'details' ? 'active' : ''}`}
              onClick={() => setActiveTab('details')}
              role="tab"
              aria-selected={activeTab === 'details'}
              data-testid="editor-tab-details"
            >
              <span className="icon"><UiIcon name="tag" /></span>
              Details
            </button>
          </div>
          {isEditing && activeTab === 'note' && (
            <div className="editor-toolbar-dock">
              <EditorInsertBar
                editor={editor}
                revision={editorRevision}
                entryId={entry.id}
                onAddAttachments={onAddAttachments}
                onAddFileDestination={onAddFileDestination}
                onShowTags={() => setActiveTab('details')}
                syncRoot={normalizeSyncRoot(masterSyncPath)}
              />
            </div>
          )}
        </div>
      </div>

      <div className={`editor-workspace ${contextCollapsed ? 'context-collapsed' : ''}`}>
        <aside className="entry-browser-rail" aria-label="Entries">
          <div className="entry-browser-head">
            <div>
              <div className="section-title">Entries</div>
              <div className="muted tiny">{allEntries.length} notebook records</div>
            </div>
            <button className="ghost subtle" type="button" onClick={() => setTabsViewOpen((prev) => !prev)}>
              Browse
            </button>
          </div>
          <div className="entry-browser-list">
            {allEntries.slice(0, 8).map((item) => {
              const tag = item.experimentTags?.[0] ?? item.projectTags?.[0] ?? item.tags[0]
              return (
                <button
                  key={`rail-${item.id}`}
                  type="button"
                  className={`entry-browser-item ${item.id === selectedEntryId ? 'active' : ''}`}
                  onClick={() => onSelectEntry(item.id)}
                >
                  <span className="entry-browser-date">{item.dateBucket}</span>
                  <strong>{item.title}</strong>
                  <span className="entry-browser-meta">
                    {tag ? <span className="pill soft">{tag}</span> : <span>General note</span>}
                    <span className="status-dot success" aria-hidden="true" />
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <div className="editor-main-stack">

      {activeTab === 'note' && !isEditing && (
        <div className="blocks" data-testid="entry-view" key={`entry-view-${entry.id}`}>
          {viewSections.map((section) => (
            <section key={`${entry.id}-${section.key}`} className="content-section">
              {section.blocks.map((block) => (
                <div key={`${entry.id}-${block.id}`} className="block-shell">
                  <BlockRenderer
                    block={block}
                    attachments={attachmentMap}
                    attachmentUrls={attachmentUrls}
                    onUpdateBlock={handleUpdateBlock}
                  />
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
                  onChange={(value) => {
                    setEditorValue(value)
                    setEditorRevision((rev) => rev + 1)
                  }}
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
                        if (key === 'z') {
                          event.preventDefault()
                          if (event.shiftKey) {
                            HistoryEditor.redo(editor)
                          } else {
                            HistoryEditor.undo(editor)
                          }
                          return
                        }
                        if (key === 'y') {
                          event.preventDefault()
                          HistoryEditor.redo(editor)
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

                      if (event.key === 'Backspace' && Range.isCollapsed(selection)) {
                        const blockEntry = Editor.above(editor, {
                          match: (n) => SlateElement.isElement(n) && typeof (n as { blockId?: unknown }).blockId === 'string',
                        })
                        if (blockEntry) {
                          const [blockNode, blockPath] = blockEntry
                          if (
                            SlateElement.isElement(blockNode) &&
                            blockNode.type === 'paragraph' &&
                            Editor.isStart(editor, selection.anchor, blockPath)
                          ) {
                            if (blockPath[blockPath.length - 1] === 0) return
                            const prevPath = Path.previous(blockPath)
                            if (!Node.has(editor, prevPath)) return
                            const prevNode = Node.get(editor, prevPath)
                            if (
                              SlateElement.isElement(prevNode) &&
                              prevNode.type === 'heading-two' &&
                              (prevNode as { locked?: boolean }).locked === true
                            ) {
                              event.preventDefault()
                              return
                            }
                          }
                        }
                      }

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
                          Transforms.setNodes(editor, { done: false, itemId: newId('ci-'), guide: undefined }, { at: newPath })
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

      {activeTab === 'workbook' && (
        <div className="tab-panel workbook-tab-panel">
          <div className="panel-card workbook-card">
            <div className="panel-card-head">
              <div>
                <div className="section-title">Workbook</div>
                <div className="muted tiny">
                  Paste tabular data from Excel, Prism, instruments, or CSV/TSV exports. Empty workbooks are ignored on save.
                </div>
              </div>
              <span className={`status-chip ${workbookHasContent(workbookData) ? 'success' : 'warning'}`}>
                {workbookHasContent(workbookData) ? 'Will save with entry' : 'Not saved while empty'}
              </span>
            </div>
            <WorkbookSheet
              data={workbookData}
              styles={workbookStyles}
              isEditing={isEditing}
              onRequestEdit={() => setIsEditing(true)}
              onChange={setWorkbookData}
              onStylesChange={setWorkbookStyles}
            />
            {!isEditing && !workbookHasContent(workbookData) && (
              <div className="file-drop-empty workbook-empty-state">
                <strong>No workbook data for this day</strong>
                <span>Click any cell or paste a table to start editing. If the grid is cleared later, the workbook block is removed from the entry.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'files' && (
        <div className="tab-panel">
          <div className="panel-card">
            <div className="section-title">Master sync folder</div>
            <label className="field">
              <span className="muted tiny">Root for file destinations + attachment references (local or cloud)</span>
              <div className="field-row">
                <input
                  data-testid="master-sync-input-files"
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
            <div className="muted tiny">New file destinations resolve under this root.</div>
          </div>

          <div className="panel-card">
            <div className="panel-card-head">
              <div>
                <div className="section-title">Files</div>
                <div className="muted tiny">
                  {attachments.length
                    ? `${verifiedAttachmentCount}/${attachments.length} files have checksums recorded.`
                    : 'Drop files, raw exports, PDFs, or microscope images into the note to link evidence.'}
                </div>
              </div>
              <span className={`status-chip ${attachments.length && verifiedAttachmentCount === attachments.length ? 'success' : 'warning'}`}>
                {attachments.length ? (verifiedAttachmentCount === attachments.length ? 'Verified manifest' : 'Verification pending') : 'No files yet'}
              </span>
            </div>
            {attachments.length === 0 && (
              <div className="file-drop-empty">
                <strong>Attach evidence to this entry</strong>
                <span>Drag files into the editor or use + File / + Image in the toolbar. Source, path, size, and checksum status will appear here.</span>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="attachment-list">
                {attachments.map((file) => (
                  <div key={file.id} className="attachment-row">
                    <div className="attachment-icon"><UiIcon name="paperclip" /></div>
                    <div className="attachment-body">
                      <div className="title-sm">{file.filename}</div>
                      <div className="muted tiny">{file.storagePath}</div>
                      <div className="attachment-row-meta">
                        <span>Source: {file.source ? file.source : 'manual'}</span>
                        <span>{file.contentType ? `Type: ${file.contentType}` : `Kind: ${file.type}`}</span>
                        <span>{file.sha256 ? `Checksum: ${file.sha256.slice(0, 12)}...` : 'Checksum: pending'}</span>
                      </div>
                    </div>
                    <span className="pill soft">{file.type.toUpperCase()}</span>
                    <span className="pill soft">{file.filesize}</span>
                    <span className={`pill soft ${file.sha256 ? 'verified-pill' : 'warning-pill'}`}>
                      {file.sha256 ? 'Verified' : 'Needs hash'}
                    </span>
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
              icon="🗂"
              options={projectTagOptions}
              selected={entry.projectTags ?? []}
              onToggle={(tag) => {
                const next = new Set(entry.projectTags ?? [])
                if (next.has(tag)) next.delete(tag)
                else next.add(tag)
                onUpdateEntryMeta(entry.id, { projectTags: Array.from(next) })
              }}
              onAdd={onAddProjectTagOption}
              testId="entry-project-tags"
            />
            <TagPicker
              label="Experiment tags"
              icon="🧪"
              options={experimentTagOptions}
              selected={entry.experimentTags ?? []}
              onToggle={(tag) => {
                const next = new Set(entry.experimentTags ?? [])
                if (next.has(tag)) next.delete(tag)
                else next.add(tag)
                onUpdateEntryMeta(entry.id, { experimentTags: Array.from(next) })
              }}
              onAdd={onAddExperimentTagOption}
              testId="entry-experiment-tags"
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
                <span className="icon"><UiIcon name="refresh" /></span>
                {failedCount > 0 ? 'Retry failed' : 'Sync now'}
              </button>
            )}
          </div>

          <div className="panel-card danger-card">
            <div className="section-title">Delete entry</div>
            <div className="muted tiny">Removes this entry and its attachments from the notebook.</div>
            <button
              className="ghost danger"
              type="button"
              data-testid="delete-entry"
              onClick={() => onDeleteEntry(entry.id)}
            >
              Delete entry
            </button>
          </div>
        </div>
      )}
        </div>

        <aside className="entry-context-panel" aria-label="Entry context">
          <button
            className="ghost context-toggle"
            type="button"
            onClick={() => setContextCollapsed((prev) => !prev)}
            aria-expanded={!contextCollapsed}
            data-testid="context-panel-toggle"
          >
            <span className="icon"><UiIcon name={contextCollapsed ? 'chevronLeft' : 'chevronRight'} /></span>
            <span>{contextCollapsed ? 'Open details' : 'Hide details'}</span>
          </button>

          {!contextCollapsed && (
            <div className="context-panel-body">
              <section className="context-card context-card-primary">
                <div className="context-card-head">
                  <div>
                    <div className="section-title">Entry status</div>
                    <div className="title-sm">{entry.dateBucket}</div>
                  </div>
                  <span className={`status-chip ${syncing || hasWork ? 'warning' : 'success'}`}>
                    {syncing ? 'Syncing' : failedCount ? `${failedCount} failed` : pendingCount ? `${pendingCount} pending` : 'Synced'}
                  </span>
                </div>
                <div className="context-metrics">
                  <button type="button" className="context-metric" onClick={() => setActiveTab('files')}>
                    <span>{attachments.length}</span>
                    <small>Files</small>
                  </button>
                  <button type="button" className="context-metric" onClick={() => setActiveTab('files')}>
                    <span>{imageCount}</span>
                    <small>Images</small>
                  </button>
                  <button type="button" className="context-metric" onClick={() => setActiveTab('details')}>
                    <span>{intakeCount}</span>
                    <small>Intake</small>
                  </button>
                  <button type="button" className="context-metric" onClick={() => setActiveTab('workbook')}>
                    <span>{hasWorkbook ? 1 : 0}</span>
                    <small>Workbook</small>
                  </button>
                </div>
              </section>

              <section className="context-card">
                <div className="context-card-head">
                  <div>
                    <div className="section-title">Workspace</div>
                    <div className="muted tiny">{project?.title ?? 'No project selected'}</div>
                  </div>
                  <button className="ghost subtle" type="button" onClick={() => setActiveTab('details')}>
                    Edit
                  </button>
                </div>
                <div className="context-chip-row">
                  {(entry.projectTags ?? []).slice(0, 3).map((tag) => (
                    <span key={`ctx-project-${tag}`} className="pill soft">{tag}</span>
                  ))}
                  {(entry.experimentTags ?? []).slice(0, 3).map((tag) => (
                    <span key={`ctx-exp-${tag}`} className="pill ghost-pill">{tag}</span>
                  ))}
                  {!(entry.projectTags?.length || entry.experimentTags?.length) && (
                    <span className="muted tiny">No tags yet.</span>
                  )}
                </div>
              </section>

              <section className="context-card">
                <div className="context-card-head">
                  <div>
                    <div className="section-title">Attachments</div>
                    <div className="muted tiny">{imageCount} images · {fileCount} files</div>
                  </div>
                  <button className="ghost subtle" type="button" onClick={() => setActiveTab('files')}>
                    View
                  </button>
                </div>
                <div className="context-list">
                  {latestAttachments.length === 0 && <div className="muted tiny">Drop files into the note to attach them.</div>}
                  {latestAttachments.map((file) => (
                    <button key={`ctx-file-${file.id}`} type="button" className="context-list-item" onClick={() => setActiveTab('files')}>
                      <span className="context-file-icon">{file.type === 'image' ? 'IMG' : 'FILE'}</span>
                      <span>
                        <strong>{file.filename}</strong>
                        <small>{file.filesize}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="context-card">
                <div className="section-title">Capture inbox</div>
                <div className="context-intake-grid">
                  <div>
                    <span>{entry.telegramCaptures?.length ?? 0}</span>
                    <small>Telegram</small>
                  </div>
                  <div>
                    <span>{entry.whatsappCaptures?.length ?? 0}</span>
                    <small>WhatsApp</small>
                  </div>
                </div>
                <div className="muted tiny">Phone intake stays local and appears here when messages are imported.</div>
              </section>

              <section className="context-card">
                <div className="section-title">Quick actions</div>
                <div className="context-actions">
                  <button className="ghost" type="button" onClick={() => setActiveTab('note')}>Note</button>
                  <button className="ghost" type="button" onClick={() => setActiveTab('workbook')}>Workbook</button>
                  <button className="ghost" type="button" onClick={() => setActiveTab('files')}>Files</button>
                  <button className="ghost" type="button" onClick={() => setActiveTab('details')}>Details</button>
                  {experiment && (
                    <button
                      className="accent"
                      type="button"
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
                      Export
                    </button>
                  )}
                </div>
              </section>
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}

function ProtocolPane({ protocol, onUpdateProtocol, onUpdateProtocolMeta }: ProtocolPaneProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(protocol?.title ?? '')
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const [editor] = useState<HistoryReactEditor>(() =>
    withHistory(withChecklists(withReact(createEditor() as ReactEditor))) as HistoryReactEditor
  )
  const [editorRevision, setEditorRevision] = useState(0)
  const [editorValue, setEditorValue] = useState<Descendant[]>(
    () => blocksToSlate(protocol?.content ?? [{ id: 'b-empty', type: 'paragraph', text: '' }])
  )

  const focusEditor = useCallback(() => {
    try {
      const start = Editor.start(editor, [])
      Transforms.select(editor, start)
      ReactEditor.focus(editor)
    } catch {
      // Slate can briefly expose an empty root while switching protocols; focus will retry on the next edit action.
    }
  }, [editor])

  useEffect(() => {
    if (!isEditing) return
    window.requestAnimationFrame(() => focusEditor())
  }, [focusEditor, isEditing])

  const viewSections = useMemo(() => {
    const blocks = protocol?.content ?? []
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
  }, [protocol?.content])

  if (!protocol) {
    return (
      <main className="panel editor">
        <div className="empty">Select or create a protocol to get started.</div>
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
    onUpdateProtocol(protocol.id, updatedBlocks)
    if (draftTitle.trim() && draftTitle.trim() !== protocol.title) {
      onUpdateProtocolMeta(protocol.id, { title: draftTitle.trim() })
    } else if (!draftTitle.trim()) {
      setDraftTitle(protocol.title)
    }
    setIsEditing(false)
  }

  return (
    <main className="panel editor">
      <div className={`editor-header ${headerCollapsed ? 'collapsed' : ''}`} data-testid="protocol-header">
        <div className="editor-header-inner">
          <div className="breadcrumb-row">
            <div className="breadcrumbs">
              <span>Protocol</span>
              <span>/</span>
              <span className="pill soft">Library</span>
            </div>
            <div className="editor-actions">
              <button
                className="ghost icon-btn"
                type="button"
                onClick={() => setHeaderCollapsed((prev) => !prev)}
                data-testid="protocol-header-toggle"
              >
                <span className="icon"><UiIcon name={headerCollapsed ? 'chevronDown' : 'chevronUp'} /></span>
                {headerCollapsed ? 'Show header' : 'Hide header'}
              </button>
              {!isEditing ? (
                <button className="accent icon-btn" onClick={() => setIsEditing(true)}>
                  <span className="icon"><UiIcon name="edit" /></span>
                  Edit
                </button>
              ) : (
                <div className="edit-actions">
                  <button
                    className="ghost icon-btn"
                    onClick={() => {
                      setIsEditing(false)
                      setEditorValue(blocksToSlate(protocol.content))
                      setDraftTitle(protocol.title)
                    }}
                  >
                    <span className="icon"><UiIcon name="x" /></span>
                    Cancel
                  </button>
                  <button className="accent icon-btn" onClick={handleSave} data-testid="protocol-save">
                    <span className="icon"><UiIcon name="save" /></span>
                    Save
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="meta-row">
            <span className="muted tiny">Edited {dateOnly.format(new Date(protocol.lastEditedDatetime))}</span>
          </div>
          <div className="title-row">
            {isEditing ? (
              <input
                className="protocol-title-input"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Protocol title"
              />
            ) : (
              <h1>{protocol.title}</h1>
            )}
          </div>
          {isEditing && (
            <div className="editor-toolbar-dock">
              <ProtocolInsertBar editor={editor} revision={editorRevision} />
            </div>
          )}
        </div>
      </div>

      {!isEditing ? (
        <div className="blocks" data-testid="protocol-view" key={`protocol-view-${protocol.id}`}>
          {viewSections.map((section) => (
            <section key={`${protocol.id}-${section.key}`} className="content-section">
              {section.blocks.map((block) => (
                <div key={`${protocol.id}-${block.id}`} className="block-shell">
                  <BlockRenderer block={block} attachments={{}} attachmentUrls={{}} />
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="editor-surface">
          <Slate
            key={protocol.id}
            editor={editor}
            initialValue={editorValue}
            onChange={(value) => {
              setEditorValue(value)
              setEditorRevision((rev) => rev + 1)
            }}
          >
            <Editable
              renderElement={renderElement}
              renderLeaf={renderLeaf}
              className="slate-editor"
              placeholder="Write your protocol..."
              data-testid="protocol-editor"
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                  const key = event.key.toLowerCase()
                  if (key === 'z') {
                    event.preventDefault()
                    if (event.shiftKey) {
                      HistoryEditor.redo(editor)
                    } else {
                      HistoryEditor.undo(editor)
                    }
                    return
                  }
                  if (key === 'y') {
                    event.preventDefault()
                    HistoryEditor.redo(editor)
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
              }}
            />
          </Slate>
          <div className="muted tiny">Tip: use the insert bar above to add sections.</div>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBlock(value: unknown): value is Block {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.type === 'string'
}

const renderElement = (props: RenderElementProps) => {
  const { element, attributes, children } = props
  const style = getBlockStyle(element.align)
  const locked = element.locked === true
  const guideText = typeof element.guide === 'string' ? element.guide : ''
  const showGuide = guideText && Node.string(element) === ''
  const guideEl = showGuide ? (
    <span className="slate-placeholder" contentEditable={false}>
      {guideText}
    </span>
  ) : null
  switch (element.type) {
    case 'heading-two':
      return locked ? (
        <h2
          className="block-heading h2 locked-block"
          {...attributes}
          style={style}
          data-block-id={(element as { blockId?: string }).blockId}
          contentEditable={false}
        >
          {children}
        </h2>
      ) : (
        <h2
          className="block-heading h2"
          {...attributes}
          style={style}
          data-block-id={(element as { blockId?: string }).blockId}
        >
          {children}
        </h2>
      )
    case 'heading-three':
      return locked ? (
        <h3
          className="block-heading h3 locked-block"
          {...attributes}
          style={style}
          data-block-id={(element as { blockId?: string }).blockId}
          contentEditable={false}
        >
          {children}
        </h3>
      ) : (
        <h3
          className="block-heading h3"
          {...attributes}
          style={style}
          data-block-id={(element as { blockId?: string }).blockId}
        >
          {children}
        </h3>
      )
    case 'quote':
      return (
        <blockquote className="quote" {...attributes} style={style} data-block-id={(element as { blockId?: string }).blockId}>
          {guideEl}
          {children}
        </blockquote>
      )
    case 'paragraph':
      return (
        <p className="block-paragraph" {...attributes} style={style} data-block-id={(element as { blockId?: string }).blockId}>
          {guideEl}
          {children}
        </p>
      )
    case 'checklist':
      return <ChecklistElement {...props} />
    case 'check-item':
      return <CheckItemElement {...props} />
    case 'list':
      return <ListElement {...props} />
    case 'list-item':
      return <ListItemElement {...props} />
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

const ALIGNABLE_TYPES = new Set(['paragraph', 'heading-two', 'heading-three', 'quote', 'checklist', 'list'])

function getBlockStyle(align?: unknown): React.CSSProperties | undefined {
  if (!isTextAlignValue(align)) return undefined
  return { textAlign: align }
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

function AlignIcon({ align }: { align: TextAlign }) {
  return (
    <span className={`align-icon align-icon-${align}`} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  )
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

function insertListBlock(editor: ReactEditor, style: ListStyle = 'dot') {
  const entry = getActiveBlockEntry(editor)
  const insertAt = entry ? Path.next(entry[1]) : [editor.children.length]
  const blockId = newId('b-')
  const listNode: Descendant = {
    type: 'list',
    blockId,
    listStyle: style,
    children: [{ type: 'list-item', itemId: newId('li-'), children: [{ text: '' }] }],
  }
  Transforms.insertNodes(editor, listNode, { at: insertAt })
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

function parseWorkbookClipboard(text: string): string[][] {
  const trimmed = text.replace(/\r/g, '').trimEnd()
  if (!trimmed) return [['']]
  return trimmed.split('\n').map((row) => {
    const delimiter = row.includes('\t') ? '\t' : ','
    return row.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"'))
  })
}

function WorkbookSheet({
  data,
  styles,
  isEditing,
  onRequestEdit,
  onChange,
  onStylesChange,
}: {
  data: string[][]
  styles: WorkbookCellStyles
  isEditing: boolean
  onRequestEdit: () => void
  onChange: (data: string[][]) => void
  onStylesChange: (styles: WorkbookCellStyles) => void
}) {
  const grid = normalizeWorkbookData(data)
  const [selectedCell, setSelectedCell] = useState<WorkbookCellPosition>({ rowIdx: 0, colIdx: 0 })
  const selectedKey = workbookCellKey(selectedCell.rowIdx, selectedCell.colIdx)
  const selectedStyle = styles[selectedKey] ?? {}

  const ensureEditing = () => {
    if (!isEditing) onRequestEdit()
  }

  const updateCell = (rowIdx: number, colIdx: number, value: string) => {
    ensureEditing()
    const next = normalizeWorkbookData(grid)
    next[rowIdx][colIdx] = value
    onChange(next)
  }

  const updateCellStyle = (patch: Partial<WorkbookCellStyle>) => {
    ensureEditing()
    const nextStyle: WorkbookCellStyle = { ...(styles[selectedKey] ?? {}), ...patch }
    ;(Object.keys(nextStyle) as Array<keyof WorkbookCellStyle>).forEach((key) => {
      if (!nextStyle[key]) delete nextStyle[key]
    })
    const nextStyles = { ...styles }
    if (workbookStyleHasContent(nextStyle)) nextStyles[selectedKey] = nextStyle
    else delete nextStyles[selectedKey]
    onStylesChange(nextStyles)
  }

  const clearCellStyle = () => {
    ensureEditing()
    const nextStyles = { ...styles }
    delete nextStyles[selectedKey]
    onStylesChange(nextStyles)
  }

  const pasteCells = (startRow: number, startCol: number, text: string) => {
    ensureEditing()
    const pasted = parseWorkbookClipboard(text)
    const next = normalizeWorkbookData(grid)
    pasted.slice(0, WORKBOOK_MAX_ROWS - startRow).forEach((row, rowOffset) => {
      row.slice(0, WORKBOOK_MAX_COLS - startCol).forEach((cell, colOffset) => {
        next[startRow + rowOffset][startCol + colOffset] = cell
      })
    })
    onChange(normalizeWorkbookData(next))
  }

  const addRows = () => {
    ensureEditing()
    onChange(normalizeWorkbookData([...grid, ...makeEmptyWorkbookData(5, grid[0]?.length ?? WORKBOOK_MIN_COLS)]))
  }

  const addColumn = () => {
    ensureEditing()
    const next = grid.map((row) => row.length < WORKBOOK_MAX_COLS ? [...row, ''] : row)
    onChange(normalizeWorkbookData(next, grid.length, Math.min((grid[0]?.length ?? WORKBOOK_MIN_COLS) + 1, WORKBOOK_MAX_COLS)))
  }

  const clearWorkbook = () => {
    ensureEditing()
    onChange(makeEmptyWorkbookData())
    onStylesChange({})
  }

  const renderFormatButton = (
    label: string,
    active: boolean,
    onClick: () => void,
    title: string,
    className = ''
  ) => (
    <button
      className={`workbook-format-button ${active ? 'active' : ''} ${className}`.trim()}
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      {label}
    </button>
  )

  return (
    <div className="workbook-shell" data-testid="entry-workbook">
      <div className="workbook-toolbar">
        <div className="muted tiny">
          {grid.length} rows - {grid[0]?.length ?? 0} columns
          <span className="workbook-selection">
            Selected {WORKBOOK_COLUMN_LABELS[selectedCell.colIdx]}{selectedCell.rowIdx + 1}
          </span>
        </div>
        <div className="workbook-actions">
          <button className="pill soft" type="button" onClick={addRows} disabled={grid.length >= WORKBOOK_MAX_ROWS}>
            <UiIcon name="plus" />
            Rows
          </button>
          <button className="pill soft" type="button" onClick={addColumn} disabled={(grid[0]?.length ?? 0) >= WORKBOOK_MAX_COLS}>
            <UiIcon name="plus" />
            Column
          </button>
          <button className="pill soft" type="button" onClick={clearWorkbook} disabled={!workbookHasContent(grid)}>
            <UiIcon name="trash" />
            Clear
          </button>
        </div>
      </div>
      <div className="workbook-formatbar" aria-label="Workbook cell formatting">
        <span className="workbook-format-label">Cell</span>
        {renderFormatButton('B', Boolean(selectedStyle.bold), () => updateCellStyle({ bold: !selectedStyle.bold }), 'Bold selected cell', 'bold')}
        {renderFormatButton('I', Boolean(selectedStyle.italic), () => updateCellStyle({ italic: !selectedStyle.italic }), 'Italic selected cell', 'italic')}
        {renderFormatButton('U', Boolean(selectedStyle.underline), () => updateCellStyle({ underline: !selectedStyle.underline }), 'Underline selected cell', 'underline')}
        <span className="workbook-format-divider" />
        {renderFormatButton('Left', selectedStyle.align === 'left' || !selectedStyle.align, () => updateCellStyle({ align: 'left' }), 'Align selected cell left')}
        {renderFormatButton('Center', selectedStyle.align === 'center', () => updateCellStyle({ align: 'center' }), 'Align selected cell center')}
        {renderFormatButton('Right', selectedStyle.align === 'right', () => updateCellStyle({ align: 'right' }), 'Align selected cell right')}
        <span className="workbook-format-divider" />
        <button className="workbook-format-button" type="button" onClick={clearCellStyle}>
          Clear format
        </button>
        {!isEditing && <span className="workbook-edit-hint">Click a cell to edit</span>}
      </div>
      <div className="workbook-grid-wrap">
        <table className="workbook-grid">
          <thead>
            <tr>
              <th className="workbook-corner" aria-label="Workbook row numbers" />
              {(grid[0] ?? []).map((_, colIdx) => (
                <th key={`col-${colIdx}`}>{WORKBOOK_COLUMN_LABELS[colIdx]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, rowIdx) => (
              <tr key={`row-${rowIdx}`}>
                <th>{rowIdx + 1}</th>
                {row.map((cell, colIdx) => {
                  const key = workbookCellKey(rowIdx, colIdx)
                  const cellStyle = styles[key] ?? {}
                  const cellCss: React.CSSProperties = {
                    fontWeight: cellStyle.bold ? 700 : undefined,
                    fontStyle: cellStyle.italic ? 'italic' : undefined,
                    textDecoration: cellStyle.underline ? 'underline' : undefined,
                    textAlign: cellStyle.align ?? 'left',
                  }
                  const isSelected = selectedCell.rowIdx === rowIdx && selectedCell.colIdx === colIdx

                  return (
                    <td key={`${rowIdx}-${colIdx}`} className={isSelected ? 'is-selected' : undefined}>
                      <input
                        value={cell}
                        style={cellCss}
                        aria-label={`Cell ${WORKBOOK_COLUMN_LABELS[colIdx]}${rowIdx + 1}`}
                        onFocus={() => {
                          setSelectedCell({ rowIdx, colIdx })
                          ensureEditing()
                        }}
                        onClick={() => setSelectedCell({ rowIdx, colIdx })}
                        onChange={(event) => updateCell(rowIdx, colIdx, event.target.value)}
                        onPaste={(event) => {
                          const text = event.clipboardData.getData('text/plain')
                          if (!text || (!text.includes('\t') && !text.includes('\n') && !text.includes(','))) return
                          event.preventDefault()
                          setSelectedCell({ rowIdx, colIdx })
                          pasteCells(rowIdx, colIdx, text)
                        }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
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
  syncRoot,
}: {
  onClose: () => void
  onSubmit: (val: { path: string; label?: string }) => void
  syncRoot?: string
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
              data-testid="file-destination-path"
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
            {syncRoot && (
              <div className="muted tiny" style={{ marginTop: 6 }}>
                Relative paths save under: {syncRoot}
              </div>
            )}
          </label>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Cancel</button>
          <button
            className="accent"
            type="button"
            data-testid="file-destination-add"
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
  revision,
  entryId,
  onAddAttachments,
  onAddFileDestination,
  onShowTags,
  syncRoot,
}: {
  editor: HistoryReactEditor
  revision: number
  entryId: string
  onAddAttachments: (entryId: string, files: File[]) => Promise<Attachment[]>
  onAddFileDestination: (entryId: string, val: { path: string; label?: string }) => Attachment
  onShowTags?: () => void
  syncRoot: string
}) {
  const imgRef = useRef<HTMLInputElement | null>(null)
  const cameraRef = useRef<HTMLInputElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [destOpen, setDestOpen] = useState(false)
  void revision
  const activeFont = getActiveFont(editor)
  const activeFontSize = getActiveFontSize(editor)
  const activeColor = getActiveColor(editor)
  const activeHighlight = getActiveHighlight(editor)
  const activeAlign = getActiveAlign(editor)
  const isSuperscript = isScriptActive(editor, 'superscript')
  const isSubscript = isScriptActive(editor, 'subscript')
  const canUndo = HistoryEditor.isHistoryEditor(editor) ? editor.history.undos.length > 0 : false
  const canRedo = HistoryEditor.isHistoryEditor(editor) ? editor.history.redos.length > 0 : false

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
      <div className="editor-toolbar" contentEditable={false} data-testid="editor-toolbar">
        <div className="toolbar-group">
          <button
            className="pill soft"
            type="button"
            disabled={!canUndo}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => HistoryEditor.undo(editor)}
            aria-label="Undo"
            data-testid="editor-undo"
          >
            ↶
          </button>
          <button
            className="pill soft"
            type="button"
            disabled={!canRedo}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => HistoryEditor.redo(editor)}
            aria-label="Redo"
            data-testid="editor-redo"
          >
            ↷
          </button>
        </div>

        <div className="toolbar-sep" />

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
            className={`pill soft align-pill ${activeAlign === 'left' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'left')}
            aria-label="Align left"
            data-testid="editor-align-left"
          >
            <AlignIcon align="left" />
          </button>
          <button
            className={`pill soft align-pill ${activeAlign === 'center' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'center')}
            aria-label="Align center"
            data-testid="editor-align-center"
          >
            <AlignIcon align="center" />
          </button>
          <button
            className={`pill soft align-pill ${activeAlign === 'right' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'right')}
            aria-label="Align right"
            data-testid="editor-align-right"
          >
            <AlignIcon align="right" />
          </button>
          <button
            className={`pill soft align-pill ${activeAlign === 'justify' ? 'active-pill' : ''}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(editor, 'justify')}
            aria-label="Justify"
            data-testid="editor-align-justify"
          >
            <AlignIcon align="justify" />
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group">
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertHeadingBlock(editor, 2)}>
            <UiIcon name="note" />
            Header
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertChecklistBlock(editor)}>
            <UiIcon name="check" />
            Checks
          </button>
          {LIST_STYLE_OPTIONS.map((option) => (
            <button
              key={option.id}
              className="pill soft"
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertListBlock(editor, option.id)}
              aria-label={option.label}
              data-testid={`editor-list-${option.id}`}
            >
              {option.symbol}
            </button>
          ))}
          {onShowTags && (
            <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={onShowTags}>
              <UiIcon name="tag" />
              Tags
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
            <UiIcon name="image" />
            Image
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cameraRef.current?.click()}>
            <UiIcon name="camera" />
            Camera
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertTableBlock(editor, [['Sample', 'Value']])}>
            <UiIcon name="table" />
            Table
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>
            <UiIcon name="file" />
            File
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setDestOpen(true)}>
            <UiIcon name="folder" />
            File destination
          </button>
          <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertDividerBlock(editor)}>
            <UiIcon name="minus" />
            Divider
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
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        data-testid="camera-input"
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
          syncRoot={syncRoot}
        />
      )}
    </>
  )
}

function ProtocolInsertBar({ editor, revision }: { editor: HistoryReactEditor; revision: number }) {
  void revision
  const activeFont = getActiveFont(editor)
  const activeFontSize = getActiveFontSize(editor)
  const activeColor = getActiveColor(editor)
  const activeHighlight = getActiveHighlight(editor)
  const activeAlign = getActiveAlign(editor)
  const isSuperscript = isScriptActive(editor, 'superscript')
  const isSubscript = isScriptActive(editor, 'subscript')
  const canUndo = HistoryEditor.isHistoryEditor(editor) ? editor.history.undos.length > 0 : false
  const canRedo = HistoryEditor.isHistoryEditor(editor) ? editor.history.redos.length > 0 : false

  return (
    <div className="editor-toolbar" contentEditable={false} data-testid="protocol-toolbar">
      <div className="toolbar-group">
        <button
          className="pill soft"
          type="button"
          disabled={!canUndo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => HistoryEditor.undo(editor)}
          aria-label="Undo"
          data-testid="protocol-undo"
        >
          ↶
        </button>
        <button
          className="pill soft"
          type="button"
          disabled={!canRedo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => HistoryEditor.redo(editor)}
          aria-label="Redo"
          data-testid="protocol-redo"
        >
          ↷
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <label className="toolbar-label">
          Font
          <select
            value={activeFont}
            onChange={(event) => setFontMark(editor, event.target.value as FontStyle)}
            data-testid="protocol-font-select"
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
            data-testid="protocol-font-size"
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
            data-testid="protocol-font-color"
          />
        </label>
        <button
          className="pill soft"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => clearColorMark(editor)}
          data-testid="protocol-color-clear"
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
            data-testid="protocol-highlight-color"
          />
        </label>
        <button
          className="pill soft"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => clearHighlightMark(editor)}
          data-testid="protocol-highlight-clear"
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
              data-testid={`protocol-highlight-swatch-${idx}`}
            />
          ))}
        </div>
        <button
          className={`pill soft ${isMarkActive(editor, 'bold') ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMark(editor, 'bold')}
          aria-label="Bold"
          data-testid="protocol-bold"
        >
          B
        </button>
        <button
          className={`pill soft ${isMarkActive(editor, 'italic') ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMark(editor, 'italic')}
          aria-label="Italic"
          data-testid="protocol-italic"
        >
          I
        </button>
        <button
          className={`pill soft ${isMarkActive(editor, 'underline') ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMark(editor, 'underline')}
          aria-label="Underline"
          data-testid="protocol-underline"
        >
          U
        </button>
        <button
          className={`pill soft ${isSuperscript ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleScript(editor, 'superscript')}
          aria-label="Superscript"
          data-testid="protocol-superscript"
        >
          Sup
        </button>
        <button
          className={`pill soft ${isSubscript ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleScript(editor, 'subscript')}
          aria-label="Subscript"
          data-testid="protocol-subscript"
        >
          Sub
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button
          className={`pill soft align-pill ${activeAlign === 'left' ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign(editor, 'left')}
          aria-label="Align left"
          data-testid="protocol-align-left"
        >
          <AlignIcon align="left" />
        </button>
        <button
          className={`pill soft align-pill ${activeAlign === 'center' ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign(editor, 'center')}
          aria-label="Align center"
          data-testid="protocol-align-center"
        >
          <AlignIcon align="center" />
        </button>
        <button
          className={`pill soft align-pill ${activeAlign === 'right' ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign(editor, 'right')}
          aria-label="Align right"
          data-testid="protocol-align-right"
        >
          <AlignIcon align="right" />
        </button>
        <button
          className={`pill soft align-pill ${activeAlign === 'justify' ? 'active-pill' : ''}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign(editor, 'justify')}
          aria-label="Justify"
          data-testid="protocol-align-justify"
        >
          <AlignIcon align="justify" />
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertHeadingBlock(editor, 2)}>
          <UiIcon name="note" />
          Header
        </button>
        <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertChecklistBlock(editor)}>
          <UiIcon name="check" />
          Checks
        </button>
        {LIST_STYLE_OPTIONS.map((option) => (
          <button
            key={option.id}
            className="pill soft"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertListBlock(editor, option.id)}
            aria-label={option.label}
            data-testid={`protocol-list-${option.id}`}
          >
            {option.symbol}
          </button>
        ))}
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSection(editor, 'Aim')}>
          + Aim
        </button>
        <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSectionWithChecklist(editor, 'Materials')}>
          + Materials
        </button>
        <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSection(editor, 'Procedure')}>
          + Procedure
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertTableBlock(editor, [['Step', 'Notes']])}>
          <UiIcon name="table" />
          Table
        </button>
        <button className="pill soft" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertDividerBlock(editor)}>
          <UiIcon name="minus" />
          Divider
          </button>
        </div>
      </div>
  )
}

function ChecklistElement({ element, attributes, children }: RenderElementProps) {
  const editor = useSlateStatic()
  const canAdd = element.locked !== true
  const style = getBlockStyle((element as { align?: unknown }).align)

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
  const guideText = typeof element.guide === 'string' ? element.guide : ''
  const showGuide = guideText && Node.string(element) === ''

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
      <span className="check-item-text" data-testid="check-item-text">
        {showGuide && (
          <span className="slate-placeholder" contentEditable={false}>
            {guideText}
          </span>
        )}
        {children}
      </span>
    </div>
  )
}

function ListElement({ element, attributes, children }: RenderElementProps) {
  const editor = useSlateStatic()
  const canAdd = element.locked !== true
  const style = getBlockStyle((element as { align?: unknown }).align)
  const listStyle = normalizeListStyle((element as { listStyle?: unknown }).listStyle) ?? 'dot'
  const symbol = getListSymbol(listStyle)

  return (
    <ListSymbolContext.Provider value={symbol}>
      <div className="symbol-list" {...attributes} style={style}>
        {children}
        <div className="checklist-actions" contentEditable={false}>
          <button
            type="button"
            className="pill soft"
            disabled={!canAdd}
            title={canAdd ? 'Add a new list item' : 'This list is locked'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!canAdd) return
              const listPath = ReactEditor.findPath(editor, element)
              const nextIndex = Array.isArray(element.children) ? element.children.length : 0
              const itemPath = listPath.concat(nextIndex)
              Transforms.insertNodes(
                editor,
                { type: 'list-item', itemId: newId('li-'), children: [{ text: '' }] },
                { at: itemPath }
              )
              Transforms.select(editor, Editor.start(editor, itemPath.concat(0)))
              ReactEditor.focus(editor)
            }}
          >
            + Item
          </button>
          <span className="muted tiny">Tip: press Enter to add a line</span>
        </div>
      </div>
    </ListSymbolContext.Provider>
  )
}

function ListItemElement({ element, attributes, children }: RenderElementProps) {
  const symbol = useContext(ListSymbolContext)
  const guideText = typeof element.guide === 'string' ? element.guide : ''
  const showGuide = guideText && Node.string(element) === ''

  return (
    <div className="symbol-row" {...attributes}>
      <span className="symbol-bullet" contentEditable={false} data-testid="list-symbol">
        {symbol}
      </span>
      <span className="symbol-item-text" data-testid="list-item-text">
        {showGuide && (
          <span className="slate-placeholder" contentEditable={false}>
            {guideText}
          </span>
        )}
        {children}
      </span>
    </div>
  )
}

function AttachmentElement({ element, attributes, children }: RenderElementProps) {
  const ctx = useContext(EditorAttachmentContext)
  const meta = isBlock(element.meta) ? element.meta : undefined
  const attachmentId = meta && (meta.type === 'image' || meta.type === 'file') ? meta.attachmentId : undefined
  const attachment = attachmentId ? ctx?.attachmentsById[attachmentId] : undefined
  const url = attachmentId ? (ctx?.attachmentUrls[attachmentId] ?? attachment?.thumbnail) : undefined
  const isImageAttachment = meta?.type === 'image'

  const iconName: UiIconName = attachment?.type === 'image' ? 'image' : attachment?.type === 'raw' ? 'spark' : 'file'

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
    <div
      {...attributes}
      contentEditable={false}
      className={`readonly-block attachment-block ${isImageAttachment ? 'attachment-block-image' : ''}`}
    >
      <div className="att-left">
        <div className="att-thumb">
          {isImageAttachment && url ? (
            <>
              <img className="att-thumb-preview" src={url} alt={attachment?.filename ?? 'Image'} />
              <span className="att-thumb-icon muted tiny" aria-hidden="true"><UiIcon name="image" /></span>
            </>
          ) : (
            <span className="muted tiny"><UiIcon name={iconName} /></span>
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
          guide: block.guide,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'quote':
        return {
          type: 'quote',
          blockId: block.id,
          align: block.align,
          guide: block.guide,
          children: slateTextChildrenFromRuns(block.runs, block.text),
        }
      case 'checklist':
        return {
          type: 'checklist',
          blockId: block.id,
          align: block.align,
          children: block.items.map((item) => ({
            type: 'check-item',
            itemId: item.id,
            done: item.done,
            guide: item.guide,
            children: slateTextChildrenFromRuns(item.runs, item.text),
          })),
        }
      case 'list':
        return {
          type: 'list',
          blockId: block.id,
          align: block.align,
          listStyle: block.style,
          children: block.items.map((item) => ({
            type: 'list-item',
            itemId: item.id,
            guide: item.guide,
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
      case 'workbook':
        return { type: 'readonly', blockId: block.id, meta: block, label: 'Workbook', children: [{ text: '' }] }
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
          guide: typeof node.guide === 'string' ? node.guide : undefined,
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
              guide: typeof child.guide === 'string' ? child.guide : undefined,
            })),
        }
      case 'list':
        return {
          id: ensureId(blockId),
          type: 'list',
          align,
          style: normalizeListStyle((node as { listStyle?: unknown }).listStyle) ?? 'dot',
          items: (node.children as unknown as Descendant[])
            .filter((child): child is SlateElement => SlateElement.isElement(child))
            .map((child) => ({
              id: typeof child.itemId === 'string' ? child.itemId : newId('li-'),
              text: Node.string(child),
              runs: runsFromSlateChildren(child.children as unknown as Descendant[]),
              guide: typeof child.guide === 'string' ? child.guide : undefined,
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
          guide: typeof node.guide === 'string' ? node.guide : undefined,
        }
    }
  })
}

function BlockRenderer({ block, attachments, attachmentUrls, onUpdateBlock }: BlockRendererProps) {
  const style = getBlockStyle(block.align)
  switch (block.type) {
    case 'heading':
      if (block.level === 1) return <h1 className="block-heading h1" style={style}>{renderTextRuns(block.runs, block.text)}</h1>
      if (block.level === 3) return <h3 className="block-heading h3" style={style}>{renderTextRuns(block.runs, block.text)}</h3>
      return <h2 className="block-heading h2" style={style}>{renderTextRuns(block.runs, block.text)}</h2>
    case 'paragraph':
      return <p className="block-paragraph" style={style}>{renderTextRuns(block.runs, block.text)}</p>
    case 'checklist': {
      const visibleItems = block.items.filter((item) => item.text.trim() || !item.guide)
      return (
        <div className="checklist" style={style}>
          {visibleItems.map((item) => (
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
    }
    case 'list': {
      const visibleItems = block.items.filter((item) => item.text.trim() || !item.guide)
      const symbol = getListSymbol(block.style)
      return (
        <div className="symbol-list" style={style}>
          {visibleItems.map((item) => (
            <div key={item.id} className="symbol-row">
              <span className="symbol-bullet">{symbol}</span>
              <span className="symbol-item-text">{renderTextRuns(item.runs, item.text)}</span>
            </div>
          ))}
        </div>
      )
    }
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
    case 'workbook': {
      return (
        <div className="table-wrap workbook-preview">
          <div className="section-title">Workbook</div>
          <table>
            <tbody>
              {block.data.map((row, idx) => (
                <tr key={idx}>
                  {row.map((cell, cIdx) => {
                    const style = block.styles?.[workbookCellKey(idx, cIdx)]
                    const cellCss: React.CSSProperties = {
                      fontWeight: style?.bold ? 700 : undefined,
                      fontStyle: style?.italic ? 'italic' : undefined,
                      textDecoration: style?.underline ? 'underline' : undefined,
                      textAlign: style?.align ?? undefined,
                    }

                    return (
                      <td key={cIdx} className={idx === 0 ? 'th' : ''} style={cellCss}>
                        {cell}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'image': {
      const attachment = attachments[block.attachmentId]
      const src = attachmentUrls[block.attachmentId] ?? attachment?.thumbnail
      const imageTitle = block.caption ?? attachment?.filename ?? 'Image'
      return (
        <figure className="media-card media-image-card" data-testid="image-block-card">
          <div className="media-thumb media-desktop-preview" data-testid="image-block-preview">
            {src ? (
              <img src={src} alt={imageTitle} />
            ) : (
              <div className="media-placeholder">Image</div>
            )}
          </div>
          <div className="media-mobile-row" data-testid="image-block-mobile">
            <span className="media-mobile-icon" aria-hidden="true">
              🖼️
            </span>
            <div className="media-mobile-meta">
              <div className="title-sm">{imageTitle}</div>
              {attachment?.filesize ? <p className="muted tiny">{attachment.filesize}</p> : null}
            </div>
          </div>
          <figcaption>
            <div className="title-sm">{imageTitle}</div>
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

function TagFilterDropdown({
  label,
  icon,
  options,
  selected,
  onToggle,
  onRemoveOption,
  testId,
  placeholder,
}: {
  label: string
  icon?: string
  options: string[]
  selected: string[]
  onToggle: (tag: string) => void
  onRemoveOption?: (tag: string) => void
  testId: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const closePanel = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])
  const togglePanel = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      if (!next) setQuery('')
      return next
    })
  }, [])
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return options
    return options.filter((tag) => tag.toLowerCase().includes(normalized))
  }, [options, query])

  useEffect(() => {
    if (!open) return
    window.setTimeout(() => searchRef.current?.focus(), 0)
  }, [closePanel, open])

  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      closePanel()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [closePanel, open])

  return (
    <div className="tag-filter" data-testid={testId}>
      <div className="tag-filter-head">
        <div className="tag-filter-title">
          {icon && <span className="tag-filter-icon">{icon}</span>}
          <span className="title-sm">{label}</span>
        </div>
        {selected.length ? <span className="pill soft">{selected.length} selected</span> : <span className="muted tiny">All</span>}
      </div>
      <button
        ref={triggerRef}
        type="button"
        className={`tag-filter-trigger ${open ? 'open' : ''}`}
        onClick={togglePanel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`${testId}-trigger`}
      >
        <span>{selected.length ? `${selected.length} selected` : placeholder ?? `Select ${label.toLowerCase()}`}</span>
        <span className="icon">▾</span>
      </button>
      {selected.length > 0 && (
        <div className="tag-selected-row" data-testid={`${testId}-selected`}>
          {selected.map((tag) => (
            <button
              key={tag}
              type="button"
              className="pill soft active-pill"
              onClick={() => onToggle(tag)}
              aria-label={`Remove ${tag}`}
            >
              {tag}
              <span className="icon" aria-hidden="true">
                ×
              </span>
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="tag-filter-panel" ref={panelRef} role="listbox" aria-label={`${label} options`} data-testid={`${testId}-panel`}>
          <div className="tag-filter-search">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tags"
              aria-label={`Search ${label.toLowerCase()}`}
              data-testid={`${testId}-search`}
            />
          </div>
          <div className="tag-option-list">
            {filteredOptions.map((tag) => {
              const isSelected = selected.includes(tag)
              return (
                <div key={tag} className={`tag-option ${isSelected ? 'selected' : ''}`} data-tag={tag}>
                  <button
                    type="button"
                    className="tag-option-main"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => onToggle(tag)}
                  >
                    <span className="tag-option-check" aria-hidden="true">
                      {isSelected ? <UiIcon name="check" /> : ''}
                    </span>
                    <span>{tag}</span>
                  </button>
                  {onRemoveOption && (
                    <button
                      type="button"
                      className="tag-option-remove"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemoveOption(tag)
                      }}
                      aria-label={`Delete tag ${tag}`}
                    >
                      <UiIcon name="x" />
                    </button>
                  )}
                </div>
              )
            })}
            {filteredOptions.length === 0 && <span className="muted tiny">No tags found.</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function TagPicker({
  label,
  icon,
  options,
  selected,
  onToggle,
  onAdd,
  testId,
  variant = 'default',
}: {
  label: string
  icon?: string
  options: string[]
  selected: string[]
  onToggle: (tag: string) => void
  onAdd?: (tag: string) => void
  testId?: string
  variant?: 'default' | 'inline'
}) {
  const [draft, setDraft] = useState('')
  const showMeta = variant !== 'inline' || selected.length > 0

  const handleAdd = () => {
    if (!onAdd) return
    const cleaned = normalizeTag(draft)
    if (!cleaned) return
    onAdd(cleaned)
    if (!selected.includes(cleaned)) onToggle(cleaned)
    setDraft('')
  }

  return (
    <div className={`tag-picker ${variant === 'inline' ? 'inline' : ''}`}>
      <div className="tag-picker-head">
        <div className="tag-picker-title">
          {icon && (
            <span className="tag-picker-icon" aria-hidden="true">
              {icon}
            </span>
          )}
          <span className="title-sm">{label}</span>
        </div>
        {showMeta &&
          (selected.length ? (
            <span className="pill soft">{selected.length} selected</span>
          ) : (
            <span className="muted tiny">No tags yet</span>
          ))}
      </div>
      <div className="chip-row" data-testid={testId}>
        {options.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`pill soft ${selected.includes(tag) ? 'active-pill' : ''}`}
            onClick={() => onToggle(tag)}
            data-selected={selected.includes(tag)}
            data-tag={tag}
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

export default App

function NewProtocolModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (val: { title?: string; templateId: EntryTemplateId }) => void
}) {
  const [title, setTitle] = useState('')
  const [templateId, setTemplateId] = useState<EntryTemplateId>('guided')
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

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="title-sm">New protocol</div>
            <div className="muted tiny">Write reusable procedures and SOPs.</div>
          </div>
          <button className="ghost" onClick={onClose} type="button">Close</button>
        </div>

        <div className="modal-grid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="muted tiny">Title</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Immunostaining SOP"
            />
          </label>
        </div>

        <div>
          <div className="section-title">Template</div>
          <div className="template-row">
            <button
              type="button"
              className={`template-card ${templateId === 'guided' ? 'active' : ''}`}
              onClick={() => setTemplateId('guided')}
            >
              <div className="title-sm">Guided protocol</div>
              <div className="muted tiny">Aim, materials, procedure, notes.</div>
            </button>
            <button
              type="button"
              className={`template-card ${templateId === 'blank' ? 'active' : ''}`}
              onClick={() => setTemplateId('blank')}
            >
              <div className="title-sm">Blank protocol</div>
              <div className="muted tiny">Start from a clean page.</div>
            </button>
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Cancel</button>
          <button
            className="accent"
            type="button"
            onClick={() => onCreate({ title: title.trim() || undefined, templateId })}
          >
            Create protocol
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
  appName,
  appOwner,
  appInfo,
  appPaths,
  onEditSetup,
  masterSyncPath,
  onMasterSyncPathChange,
  mobilePairLink,
  onMobilePairLinkChange,
  onAutoDetectMobilePairLink,
  mobilePairAutoMessage,
  mobilePairStatus,
  mobilePairQrDataUrl,
  onCopyMobilePairLink,
  labStoragePath,
  fsEnabled,
  fsNeedsPermission,
  fsSupported,
  onEnable,
  onPickDir,
  onDisconnect,
  onValidate,
  onImportLegacy,
  onImportLegacyFile,
}: {
  onClose: () => void
  theme: ThemeName
  onThemeChange: (theme: ThemeName) => void
  appName: string
  appOwner: string
  appInfo: { name: string; version: string; platform: string } | null
  appPaths: AppPaths
  onEditSetup: () => void
  masterSyncPath: string
  onMasterSyncPathChange: (value: string) => void
  mobilePairLink: string
  onMobilePairLinkChange: (value: string) => void
  onAutoDetectMobilePairLink: () => Promise<void>
  mobilePairAutoMessage: string
  mobilePairStatus: PairLinkStatus
  mobilePairQrDataUrl: string
  onCopyMobilePairLink: () => Promise<boolean>
  labStoragePath: string
  fsEnabled: boolean
  fsNeedsPermission: boolean
  fsSupported: boolean
  onEnable: () => void
  onPickDir: () => void
  onDisconnect: () => void
  onValidate: () => Promise<{ ok: boolean; message?: string }>
  onImportLegacy: () => Promise<{ ok: boolean; message: string }>
  onImportLegacyFile: (file: File) => Promise<{ ok: boolean; message: string }>
}) {
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<{ ok: boolean; message?: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [pairCopyState, setPairCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const importFileRef = useRef<HTMLInputElement | null>(null)
  const versionLabel = appInfo?.version ? `v${appInfo.version}` : 'Preview build'
  const platformLabel = appInfo?.platform ?? 'Web'
  const mobilePairLinkTrimmed = mobilePairLink.trim()
  const mobilePairLinkIsValid = isHttpUrl(mobilePairLinkTrimmed)
  const mobilePairIsTailscale = mobilePairLinkIsValid && isTailscaleUrl(mobilePairLinkTrimmed)
  const mobilePairConnected = mobilePairLinkIsValid && mobilePairStatus === 'online'
  const mobilePairStatusLabel =
    !mobilePairLinkIsValid
      ? 'Add link'
      : mobilePairStatus === 'online'
        ? 'Link online'
        : mobilePairStatus === 'checking'
          ? 'Checking'
          : mobilePairStatus === 'offline'
            ? 'Link offline'
            : 'Idle'
  const mobilePairStatusClass =
    !mobilePairLinkIsValid
      ? 'warning'
      : mobilePairStatus === 'online'
        ? 'success'
        : mobilePairStatus === 'offline'
          ? 'danger'
          : 'warning'
  const mobilePairConnectedLabel =
    !mobilePairLinkIsValid
      ? 'Awaiting link'
      : mobilePairConnected
        ? 'Reachable from phone'
        : mobilePairStatus === 'checking'
          ? 'Checking connectivity'
          : 'Not reachable yet'
  const mobilePairConnectedClass =
    !mobilePairLinkIsValid
      ? 'warning'
      : mobilePairConnected
        ? 'success'
        : mobilePairStatus === 'checking'
          ? 'warning'
          : 'danger'

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
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
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
              <div className="title-sm">Storage locations</div>
              <div className="muted tiny">Base folders used for notes, uploaded files, exports, and sync.</div>
            </div>
            <button className="ghost" type="button" onClick={onEditSetup}>
              Edit setup
            </button>
          </div>
          <div className="settings-grid">
            <div>
              <div className="muted tiny">Data root</div>
              <div className="settings-path">{appPaths.dataRoot || 'Not set'}</div>
            </div>
            <div>
              <div className="muted tiny">Attachments</div>
              <div className="settings-path">{appPaths.attachmentsRoot || 'Not set'}</div>
            </div>
            <div>
              <div className="muted tiny">Exports</div>
              <div className="settings-path">{appPaths.exportRoot || 'Not set'}</div>
            </div>
            <div>
              <div className="muted tiny">Sync root</div>
              <div className="settings-path">{appPaths.syncRoot || 'Not set'}</div>
            </div>
          </div>
          <div className="settings-notes">
            <div className="muted tiny">
              <strong>Notes and metadata:</strong> saved under <code>{appPaths.dataRoot || 'Data root'}</code>.
            </div>
            <div className="muted tiny">
              <strong>Uploaded files and cached attachments:</strong> stored under{' '}
              <code>{appPaths.attachmentsRoot || 'Attachments'}</code>.
            </div>
          </div>
        </div>

        <div className="meta-card">
          <div className="settings-row">
            <div>
              <div className="title-sm">Master sync folder</div>
              <div className="muted tiny">Root for file destinations + attachment references (local folder or cloud URL).</div>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label className="field">
              <span className="muted tiny">Folder or URL</span>
              <div className="field-row">
                <input
                  data-testid="master-sync-input-settings"
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

        <details className="meta-card settings-disclosure" data-testid="mobile-pair-card">
          <summary className="settings-disclosure-summary">
            <div>
              <div className="title-sm">Phone access</div>
              <div className="muted tiny">Optional QR link for opening this notebook from your phone.</div>
            </div>
            <div className="settings-status-row">
              <div className={`status-chip ${mobilePairStatusClass}`} data-testid="mobile-pair-status">
                <span className={`status-dot ${mobilePairStatusClass}`} aria-hidden="true" />
                {mobilePairStatusLabel}
              </div>
              <div className={`status-chip ${mobilePairConnectedClass}`} data-testid="mobile-pair-connected">
                <span className={`status-dot ${mobilePairConnectedClass}`} aria-hidden="true" />
                {mobilePairConnectedLabel}
              </div>
            </div>
          </summary>

          <div className="settings-disclosure-body">
            <label className="field">
              <span className="muted tiny">Phone link</span>
              <div className="field-row">
                <input
                  data-testid="mobile-pair-link"
                  value={mobilePairLink}
                  onChange={(e) => {
                    setPairCopyState('idle')
                    onMobilePairLinkChange(e.target.value)
                  }}
                  placeholder="Paste a reachable http(s) notebook link"
                />
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    void onAutoDetectMobilePairLink()
                  }}
                >
                  Detect
                </button>
                <button
                  className="ghost"
                  type="button"
                  disabled={!mobilePairLinkIsValid}
                  onClick={async () => {
                    const ok = await onCopyMobilePairLink()
                    setPairCopyState(ok ? 'copied' : 'error')
                  }}
                >
                  Copy link
                </button>
              </div>
            </label>

            <div className="muted tiny" style={{ marginTop: 8 }}>
              {pairCopyState === 'copied'
                ? 'Link copied to clipboard.'
                  : pairCopyState === 'error'
                    ? 'Unable to copy link from this browser session.'
                    : 'Use any private network or local URL your phone can open. Leave this blank if you only use the desktop app.'}
            </div>

            {mobilePairAutoMessage ? (
              <div className="muted tiny" style={{ marginTop: 4 }}>
                {mobilePairAutoMessage}
              </div>
            ) : null}

            <div className="muted tiny mobile-pair-hint">
              {mobilePairIsTailscale
                ? 'Private network link detected. The QR code will work when the phone can reach the same network.'
                : 'This is optional. It does not affect Telegram, WhatsApp, desktop notes, or local file storage.'}
            </div>

            {mobilePairQrDataUrl ? (
              <div className="mobile-pair-grid">
                <img
                  src={mobilePairQrDataUrl}
                  alt="QR code for mobile pairing link"
                  className="mobile-pair-qr"
                  data-testid="mobile-pair-qr"
                />
                <div className="muted tiny">
                  Scan the QR code from your phone camera to open this notebook.
                  <br />
                  Connectivity checks run only while Settings is open.
                </div>
              </div>
            ) : (
              <div className="muted tiny" style={{ marginTop: 10 }}>
                Enter a valid http(s) link to generate the QR code.
              </div>
            )}
          </div>
        </details>

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
              <div className="title-sm">Import existing notes</div>
              <div className="muted tiny">Load labnote-state.json from a folder (for example OneDrive).</div>
            </div>
          </div>

          <div className="settings-actions" style={{ marginTop: 10 }}>
            <button
              className="accent"
              type="button"
              data-testid="import-legacy"
              disabled={importing}
              onClick={async () => {
                setImporting(true)
                try {
                  const res = await onImportLegacy()
                  setImportStatus(res)
                } finally {
                  setImporting(false)
                }
              }}
            >
              {importing ? 'Importing…' : 'Import from folder'}
            </button>
            <button
              className="ghost"
              type="button"
              data-testid="import-legacy-file"
              disabled={importing}
              onClick={() => importFileRef.current?.click()}
            >
              Import from file
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json"
              data-testid="import-legacy-file-input"
              style={{ display: 'none' }}
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                setImporting(true)
                try {
                  const res = await onImportLegacyFile(file)
                  setImportStatus(res)
                } finally {
                  setImporting(false)
                  event.target.value = ''
                }
              }}
            />
          </div>

          {importStatus && (
            <div className="muted tiny" style={{ marginTop: 10, color: importStatus.ok ? 'var(--accent)' : 'var(--danger)' }}>
              {importStatus.message}
            </div>
          )}
        </div>

        <div className="meta-card">
          <div className="settings-row">
            <div>
              <div className="title-sm">Appearance</div>
              <div className="muted tiny">Pick a visual style for your notebook.</div>
            </div>
          </div>

          <div className="theme-grid" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((option) => (
              <label
                key={option.id}
                className={`theme-card ${theme === option.id ? 'active' : ''}`}
                data-testid={`theme-option-${option.id}`}
                style={
                  {
                    '--preview-bg': option.preview.bg,
                    '--preview-surface': option.preview.surface,
                    '--preview-accent': option.preview.accent,
                    '--preview-border': option.preview.border,
                  } as React.CSSProperties
                }
              >
                <input
                  className="theme-radio"
                  type="radio"
                  name="theme"
                  value={option.id}
                  checked={theme === option.id}
                  onChange={() => onThemeChange(option.id)}
                />
                <div className="theme-card-inner">
                  <div className="theme-preview" aria-hidden="true">
                    <div className="theme-preview-surface" />
                    <div className="theme-preview-accent" />
                    <div className="theme-preview-chip" />
                  </div>
                  <div>
                    <div className="title-sm">{option.label}</div>
                    <div className="muted tiny">{option.description}</div>
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="meta-card">
          <div className="settings-row">
            <div>
              <div className="title-sm">Help & support</div>
              <div className="muted tiny">Questions, feature requests, and issue reports.</div>
            </div>
          </div>
          <div className="settings-grid">
            <div>
              <div className="muted tiny">GitHub</div>
              <a
                className="settings-path settings-link"
                href={APP_GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                data-testid="help-github"
              >
                github.com/meghamsh738
              </a>
            </div>
          </div>
        </div>

        <div className="meta-card">
          <div className="settings-row">
            <div>
              <div className="title-sm">About</div>
              <div className="muted tiny">{appName}</div>
            </div>
          </div>
          <div className="settings-grid">
            <div>
              <div className="muted tiny">Made by</div>
              <div className="title-sm">{appOwner}</div>
            </div>
            <div>
              <div className="muted tiny">Version</div>
              <div className="settings-path">{versionLabel}</div>
            </div>
            <div>
              <div className="muted tiny">Platform</div>
              <div className="settings-path">{platformLabel}</div>
            </div>
            <div>
              <div className="muted tiny">License</div>
              <div className="settings-path">All Rights Reserved</div>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} type="button">Done</button>
        </div>
      </div>
    </div>
  )
}

function SetupWizard({
  initialPaths,
  onComplete,
  canPickPaths,
  appName,
}: {
  initialPaths: AppPaths
  onComplete: (paths: AppPaths) => void
  canPickPaths: boolean
  appName: string
}) {
  const [paths, setPaths] = useState<AppPaths>(initialPaths)
  const [error, setError] = useState<string | null>(null)
  const canCreateFolders = typeof window !== 'undefined' && !!window.electronAPI?.ensureDirectories
  const [createFolders, setCreateFolders] = useState(canCreateFolders)
  const [creating, setCreating] = useState(false)

  const updateField = (key: keyof AppPaths, value: string) => {
    setError(null)
    setPaths((prev) => ({ ...prev, [key]: value }))
  }

  const handlePick = async (key: keyof AppPaths, label: string) => {
    if (!window.electronAPI?.selectDirectory) return
    try {
      const selection = await window.electronAPI.selectDirectory({
        title: `Select ${label}`,
        defaultPath: paths[key],
      })
      if (selection) updateField(key, selection)
    } catch (err) {
      console.warn('Unable to select directory', err)
    }
  }

  const handleComplete = async () => {
    if (!paths.dataRoot || !paths.attachmentsRoot || !paths.exportRoot || !paths.syncRoot) {
      setError('Fill in all storage paths to continue.')
      return
    }
    if (createFolders && canCreateFolders && window.electronAPI?.ensureDirectories) {
      setCreating(true)
      try {
        const res = await window.electronAPI.ensureDirectories(paths)
        if (!res?.ok) {
          setError(res?.message || 'Unable to create folders. Check permissions.')
          return
        }
      } finally {
        setCreating(false)
      }
    }
    onComplete(paths)
  }

  return (
    <div className="setup-overlay" role="dialog" aria-modal="true" data-testid="setup-dialog">
      <div className="setup-card">
        <div className="setup-header">
          <div className="setup-brand">
            <img src={logoMark} alt={`${appName} logo`} className="brand-mark" />
            <div>
              <div className="brand-title">{appName}</div>
              <div className="muted tiny">First-time storage setup</div>
            </div>
          </div>
          <span className="pill soft">Required</span>
        </div>

        <div className="setup-body">
          <p className="muted tiny">
            Choose where data, attachments, exports, and sync files should live on this machine. You can edit these later
            in Settings.
          </p>
          <p className="muted tiny">
            These folders do not need to exist yet — Easylab will create them when you finish setup.
          </p>

          <div className="setup-grid">
            <label className="field">
              <span className="muted tiny">Data root</span>
              <div className="field-row">
                <input
                  data-testid="setup-data-root"
                  value={paths.dataRoot}
                  onChange={(e) => updateField('dataRoot', e.target.value)}
                  placeholder={suggestedPaths.dataRoot}
                />
                {canPickPaths && (
                  <button className="ghost" type="button" onClick={() => handlePick('dataRoot', 'data root')}>
                    Browse
                  </button>
                )}
              </div>
            </label>

            <label className="field">
              <span className="muted tiny">Attachments cache</span>
              <div className="field-row">
                <input
                  data-testid="setup-attachments-root"
                  value={paths.attachmentsRoot}
                  onChange={(e) => updateField('attachmentsRoot', e.target.value)}
                  placeholder={suggestedPaths.attachmentsRoot}
                />
                {canPickPaths && (
                  <button className="ghost" type="button" onClick={() => handlePick('attachmentsRoot', 'attachments')}>
                    Browse
                  </button>
                )}
              </div>
            </label>

            <label className="field">
              <span className="muted tiny">Exports</span>
              <div className="field-row">
                <input
                  data-testid="setup-export-root"
                  value={paths.exportRoot}
                  onChange={(e) => updateField('exportRoot', e.target.value)}
                  placeholder={suggestedPaths.exportRoot}
                />
                {canPickPaths && (
                  <button className="ghost" type="button" onClick={() => handlePick('exportRoot', 'exports')}>
                    Browse
                  </button>
                )}
              </div>
            </label>

            <label className="field">
              <span className="muted tiny">Sync folder</span>
              <div className="field-row">
                <input
                  data-testid="setup-sync-root"
                  value={paths.syncRoot}
                  onChange={(e) => updateField('syncRoot', e.target.value)}
                  placeholder={suggestedPaths.syncRoot}
                />
                {canPickPaths && (
                  <button className="ghost" type="button" onClick={() => handlePick('syncRoot', 'sync folder')}>
                    Browse
                  </button>
                )}
              </div>
            </label>
          </div>

          {error && <div className="setup-error">{error}</div>}
        </div>

        <div className="setup-actions">
          <button
            className="ghost"
            type="button"
            onClick={() => {
              setError(null)
              setPaths(suggestedPaths)
            }}
          >
            Use suggested layout
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {canCreateFolders && (
              <label className="check-row" style={{ padding: '8px 10px' }}>
                <input
                  type="checkbox"
                  checked={createFolders}
                  onChange={(e) => setCreateFolders(e.target.checked)}
                />
                <span className="muted tiny">Create folders now</span>
              </label>
            )}
            <button
              className="accent"
              type="button"
              data-testid="setup-complete"
              onClick={handleComplete}
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Finish setup'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
