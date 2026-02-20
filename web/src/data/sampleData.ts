import type {
  Attachment,
  Entry,
  Experiment,
  Lab,
  Protocol,
  Project,
  User,
} from '../domain/types'

export const seedVersion = '2026-01-17-daily-entry'

const users: User[] = [
  {
    id: 'u1',
    name: 'Megha Sharma',
    email: 'megha@northlab.edu',
    role: 'student',
    settings: { theme: 'light', defaultLabId: 'lab-main', defaultProjectId: 'proj-guided' },
  },
  {
    id: 'u2',
    name: 'Dr. Rana Iyer',
    email: 'rana.iyer@northlab.edu',
    role: 'PI',
    settings: { theme: 'light', defaultLabId: 'lab-main', defaultProjectId: 'proj-guided' },
  },
]

const labs: Lab[] = [
  {
    id: 'lab-main',
    name: 'Neuroimmunology Lab',
    members: [
      { userId: 'u1', permission: 'editor' },
      { userId: 'u2', permission: 'owner' },
    ],
    storageConfig: {
      location: 'institutional',
      path: '\\\\labserver\\tnf_project\\2025',
    },
  },
]

const projects: Project[] = [
  {
    id: 'proj-guided',
    labId: 'lab-main',
    title: 'Guided lab notebook',
    description: 'A clean starting point for new experiment notes and quick capture.',
    tags: ['template', 'starter'],
    archived: false,
  },
]

const seedNow = new Date()
const seedTimestamp = seedNow.toISOString()
const seedDateBucket = `${seedNow.getFullYear()}-${String(seedNow.getMonth() + 1).padStart(2, '0')}-${String(
  seedNow.getDate()
).padStart(2, '0')}`
const seedYesterday = new Date(seedNow)
seedYesterday.setDate(seedNow.getDate() - 1)
const seedYesterdayTimestamp = seedYesterday.toISOString()
const seedYesterdayBucket = `${seedYesterday.getFullYear()}-${String(seedYesterday.getMonth() + 1).padStart(2, '0')}-${String(
  seedYesterday.getDate()
).padStart(2, '0')}`
const dateTitleFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const seedTitle = dateTitleFormat.format(seedNow)
const seedYesterdayTitle = dateTitleFormat.format(seedYesterday)

const experiments: Experiment[] = [
  {
    id: 'exp-guided',
    projectId: 'proj-guided',
    title: 'Guided template entry',
    protocolRef: 'TEMPLATE-01',
    startDatetime: seedTimestamp,
  },
]

const entries: Entry[] = [
  {
    id: 'entry-guided',
    experimentId: 'exp-guided',
    projectId: 'proj-guided',
    createdDatetime: seedTimestamp,
    lastEditedDatetime: seedTimestamp,
    authorId: 'u1',
    title: seedTitle,
    dateBucket: seedDateBucket,
    isDaily: true,
    content: [
      { id: 'b-context-h', type: 'heading', level: 2, text: 'Context', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-context',
        type: 'paragraph',
        text: '',
        guide: '• ........................................\n• ........................................\n• ........................................',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
    ],
    tags: [],
    projectTags: ['IL-17 WT KO aging project'],
    experimentTags: ['Genotyping'],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [
      { id: 'region-context', entryId: 'entry-guided', label: 'Context', blockIds: ['b-context-h', 'b-context'], linkedAttachments: [] },
    ],
  },
  {
    id: 'entry-yesterday',
    experimentId: 'exp-guided',
    projectId: 'proj-guided',
    createdDatetime: seedYesterdayTimestamp,
    lastEditedDatetime: seedYesterdayTimestamp,
    authorId: 'u1',
    title: seedYesterdayTitle,
    dateBucket: seedYesterdayBucket,
    isDaily: true,
    content: [
      { id: 'b-y-context-h', type: 'heading', level: 2, text: 'Context', locked: true, updatedAt: seedYesterdayTimestamp, updatedBy: 'me' },
      {
        id: 'b-y-context',
        type: 'paragraph',
        text: '',
        guide: '• ........................................\n• ........................................\n• ........................................',
        updatedAt: seedYesterdayTimestamp,
        updatedBy: 'me',
      },
    ],
    tags: [],
    projectTags: ['IL-17 WT KO aging project'],
    experimentTags: ['Genotyping'],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [
      { id: 'region-y-context', entryId: 'entry-yesterday', label: 'Context', blockIds: ['b-y-context-h', 'b-y-context'], linkedAttachments: [] },
    ],
  },
]

const attachments: Attachment[] = []

const protocols: Protocol[] = [
  {
    id: 'protocol-guided',
    title: 'Immunostaining SOP',
    createdDatetime: seedTimestamp,
    lastEditedDatetime: seedTimestamp,
    content: [
      { id: 'b-proto-aim-h', type: 'heading', level: 2, text: 'Aim', updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-proto-aim',
        type: 'paragraph',
        text: 'Summarize the purpose of this protocol and any expected outcomes.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-proto-mats-h', type: 'heading', level: 2, text: 'Materials', updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-proto-mats',
        type: 'checklist',
        items: [
          { id: 'b-proto-mats-1', text: 'Primary antibody', done: false },
          { id: 'b-proto-mats-2', text: 'Secondary antibody', done: false },
          { id: 'b-proto-mats-3', text: 'Slides + cover slips', done: false },
        ],
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-proto-proc-h', type: 'heading', level: 2, text: 'Procedure', updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-proto-proc',
        type: 'paragraph',
        text: 'Step-by-step instructions including timing, temperatures, and wash steps.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-proto-notes-h', type: 'heading', level: 2, text: 'Notes', updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-proto-notes',
        type: 'paragraph',
        text: 'Record troubleshooting tips and critical checkpoints.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
    ],
    tags: ['SOP'],
    searchTerms: [],
  },
]

export const sampleData = {
  users,
  labs,
  projects,
  experiments,
  entries,
  protocols,
  attachments,
}

export const findEntryById = (id: string) => entries.find((e) => e.id === id)

export const attachmentsForEntry = (entryId: string) =>
  attachments.filter((a) => a.entryId === entryId)

export const projectForEntry = (entryId: string) => {
  const entry = findEntryById(entryId)
  if (!entry) return undefined
  return projects.find((p) => p.id === entry.projectId)
}

export const experimentForEntry = (entryId: string) => {
  const entry = findEntryById(entryId)
  if (!entry?.experimentId) return undefined
  return experiments.find((ex) => ex.id === entry.experimentId)
}

export const findProtocolById = (id: string) => protocols.find((p) => p.id === id)
