export type Role = 'PI' | 'student' | 'tech' | 'guest'

export type ThemeName = 'light' | 'neo-brutal' | 'sage'

export interface UserSettings {
  theme: ThemeName
  defaultLabId?: string
  defaultProjectId?: string
}

export interface User {
  id: string
  name: string
  email: string
  role: Role
  settings: UserSettings
}

export interface LabMember {
  userId: string
  permission: 'owner' | 'editor' | 'viewer'
}

export interface Lab {
  id: string
  name: string
  members: LabMember[]
  storageConfig: {
    location: 'local' | 's3' | 'institutional'
    path: string
  }
}

export interface Project {
  id: string
  labId: string
  title: string
  description?: string
  tags: string[]
  archived?: boolean
}

export interface Experiment {
  id: string
  projectId: string
  title: string
  protocolRef?: string
  animalModel?: string
  cellLine?: string
  startDatetime?: string
  endDatetime?: string
  defaultRawDataPath?: string
}

export interface Protocol {
  id: string
  title: string
  createdDatetime: string
  lastEditedDatetime: string
  content: Block[]
  tags: string[]
  searchTerms: string[]
}

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'table'
  | 'workbook'
  | 'image'
  | 'file'
  | 'checklist'
  | 'list'
  | 'quote'
  | 'divider'

export interface TextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  superscript?: boolean
  subscript?: boolean
  font?: 'body' | 'display' | 'mono'
  fontSize?: 12 | 14 | 16 | 18 | 20 | 24 | 28
  color?: string
  highlight?: string
}

export interface BlockBase {
  id: string
  type: BlockType
  updatedAt?: string
  updatedBy?: string
  locked?: boolean
  align?: 'left' | 'center' | 'right' | 'justify'
}

export interface HeadingBlock extends BlockBase {
  type: 'heading'
  text: string
  level?: 1 | 2 | 3
  runs?: TextRun[]
}

export interface ParagraphBlock extends BlockBase {
  type: 'paragraph'
  text: string
  runs?: TextRun[]
  guide?: string
}

export interface TableBlock extends BlockBase {
  type: 'table'
  data: string[][]
  caption?: string
  headerRow?: boolean
}

export interface WorkbookCellStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  align?: 'left' | 'center' | 'right'
}

export interface WorkbookBlock extends BlockBase {
  type: 'workbook'
  data: string[][]
  title?: string
  styles?: Record<string, WorkbookCellStyle>
}

export interface ImageBlock extends BlockBase {
  type: 'image'
  attachmentId: string
  caption?: string
}

export interface FileBlock extends BlockBase {
  type: 'file'
  attachmentId: string
  label?: string
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
  timerMinutes?: number
  runs?: TextRun[]
  guide?: string
}

export interface ChecklistBlock extends BlockBase {
  type: 'checklist'
  items: ChecklistItem[]
}

export type ListStyle = 'dot' | 'circle' | 'square' | 'dash' | 'arrow'

export interface ListItem {
  id: string
  text: string
  runs?: TextRun[]
  guide?: string
}

export interface ListBlock extends BlockBase {
  type: 'list'
  items: ListItem[]
  style?: ListStyle
}

export interface QuoteBlock extends BlockBase {
  type: 'quote'
  text: string
  runs?: TextRun[]
  guide?: string
}

export interface DividerBlock extends BlockBase {
  type: 'divider'
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | TableBlock
  | WorkbookBlock
  | ImageBlock
  | FileBlock
  | ChecklistBlock
  | ListBlock
  | QuoteBlock
  | DividerBlock

export interface Attachment {
  id: string
  entryId: string
  type: 'image' | 'pdf' | 'file' | 'raw'
  filename: string
  filesize: string
  bytes?: number
  storagePath: string
  thumbnail?: string
  linkedRegionId?: string
  tag?: string
  sampleId?: string
  pinnedOffline?: boolean
  cachedPath?: string
  source?: 'whatsapp' | 'telegram'
  sourceMessageId?: string
  sourceMediaId?: string
  contentType?: string
  mimeType?: string
  sha256?: string
  cacheKey?: string
  driveFileId?: string
  syncStatus?: JournalSyncStatus
  createdAt?: string
  updatedAt?: string
}

export type SyncProviderKind = 'google-drive'

export type DevicePlatform = 'desktop' | 'mobile' | 'tablet' | 'web'

export type JournalSyncStatus = 'local' | 'queued' | 'syncing' | 'synced' | 'remote-available' | 'failed' | 'conflict'

export interface DeviceProfile {
  id: string
  name: string
  platform: DevicePlatform
  createdAt: string
  lastSeenAt: string
  userAgent?: string
  appVersion?: string
}

export interface SyncManifest {
  version: 1
  provider: SyncProviderKind
  rootFolderName: string
  createdAt: string
  updatedAt: string
  devices: DeviceProfile[]
  entryCount: number
  attachmentCount: number
  fileBoxCount: number
  transferCount: number
}

export interface SyncEntityEnvelope<T> {
  id: string
  kind: 'entry' | 'attachment' | 'fileBoxItem' | 'transfer' | 'device' | 'tombstone'
  version: 1
  updatedAt: string
  updatedByDeviceId: string
  deletedAt?: string
  payload: T
}

export type FileBoxStatus = 'queued' | 'uploading' | 'available' | 'attached' | 'rejected' | 'failed' | 'removed'

export interface FileBoxItem {
  id: string
  entryId: string
  attachmentId?: string
  filename: string
  filesize: string
  contentType?: string
  sourceDeviceId: string
  sourceDeviceName: string
  status: FileBoxStatus
  createdAt: string
  updatedAt: string
  driveFileId?: string
  localObjectUrl?: string
  lastError?: string
}

export type TransferStatus = 'queued' | 'uploading' | 'available' | 'attached' | 'failed' | 'conflict' | 'removed'

export interface TransferRecord {
  id: string
  fileBoxItemId?: string
  entryId?: string
  attachmentId?: string
  filename: string
  fromDeviceId: string
  fromDeviceName: string
  toDeviceId?: string
  toDeviceName?: string
  provider: SyncProviderKind
  status: TransferStatus
  bytesTotal?: number
  bytesTransferred?: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  driveFileId?: string
  lastError?: string
}

export interface SyncConflict {
  id: string
  entityKind: SyncEntityEnvelope<unknown>['kind']
  entityId: string
  localUpdatedAt: string
  remoteUpdatedAt: string
  detectedAt: string
  resolution: 'pending' | 'local-won' | 'remote-won' | 'kept-copy'
  summary: string
  localCopy?: unknown
  remoteCopy?: unknown
}

export interface SyncQueueItem {
  id: string
  entityKind: SyncEntityEnvelope<unknown>['kind']
  entityId: string
  operation: 'upsert' | 'delete'
  status: JournalSyncStatus
  queuedAt: string
  updatedAt: string
  updatedByDeviceId: string
  baseVersion?: number
  lastError?: string
}

export interface TombstoneRecord {
  id: string
  entityKind: SyncEntityEnvelope<unknown>['kind']
  entityId: string
  deletedAt: string
  deletedByDeviceId: string
  reason?: string
}

export interface PinnedRegion {
  id: string
  entryId: string
  label: string
  blockIds: string[]
  linkedAttachments: string[]
  summary?: string
}

export interface WhatsAppCapture {
  messageId: string
  sender: string
  sentAt: string
  receivedAt: string
  type: 'text' | 'image' | 'unsupported'
  text?: string
  blockIds: string[]
  attachmentIds: string[]
  mediaIds?: string[]
}

export interface TelegramCapture {
  messageId: string
  chatId: string
  telegramMessageId: string
  fromUsername?: string
  fromName?: string
  sentAt: string
  receivedAt: string
  type: 'text' | 'image' | 'file'
  text?: string
  blockIds: string[]
  attachmentIds: string[]
  mediaIds?: string[]
}

export interface Entry {
  id: string
  experimentId?: string
  projectId?: string
  createdDatetime: string
  lastEditedDatetime: string
  authorId: string
  title: string
  dateBucket: string
  isDaily?: boolean
  content: Block[]
  tags: string[]
  projectTags?: string[]
  experimentTags?: string[]
  searchTerms: string[]
  linkedFiles: string[]
  pinnedRegions: PinnedRegion[]
  syncPath?: string
  version?: number
  updatedByDeviceId?: string
  syncStatus?: JournalSyncStatus
  source?: 'manual' | 'whatsapp' | 'telegram'
  whatsappCaptures?: WhatsAppCapture[]
  telegramCaptures?: TelegramCapture[]
}

export interface SearchIndexItem {
  id: string
  type: 'entry' | 'attachment' | 'region'
  title: string
  preview: string
  tags: string[]
  path: string
}
