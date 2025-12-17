export type Role = 'PI' | 'student' | 'tech' | 'guest'

export interface UserSettings {
  theme: 'light' | 'dark'
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

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'table'
  | 'image'
  | 'file'
  | 'checklist'
  | 'quote'
  | 'divider'

export interface TextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
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
}

export interface TableBlock extends BlockBase {
  type: 'table'
  data: string[][]
  caption?: string
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
}

export interface ChecklistBlock extends BlockBase {
  type: 'checklist'
  items: ChecklistItem[]
}

export interface QuoteBlock extends BlockBase {
  type: 'quote'
  text: string
  runs?: TextRun[]
}

export interface DividerBlock extends BlockBase {
  type: 'divider'
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | TableBlock
  | ImageBlock
  | FileBlock
  | ChecklistBlock
  | QuoteBlock
  | DividerBlock

export interface Attachment {
  id: string
  entryId: string
  type: 'image' | 'pdf' | 'file' | 'raw'
  filename: string
  filesize: string
  storagePath: string
  thumbnail?: string
  linkedRegionId?: string
  tag?: string
  sampleId?: string
  pinnedOffline?: boolean
  cachedPath?: string
}

export interface PinnedRegion {
  id: string
  entryId: string
  label: string
  blockIds: string[]
  linkedAttachments: string[]
  summary?: string
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
  content: Block[]
  tags: string[]
  searchTerms: string[]
  linkedFiles: string[]
  pinnedRegions: PinnedRegion[]
}

export interface SearchIndexItem {
  id: string
  type: 'entry' | 'attachment' | 'region'
  title: string
  preview: string
  tags: string[]
  path: string
}
