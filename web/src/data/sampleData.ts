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
    settings: { theme: 'dark', defaultLabId: 'lab-main', defaultProjectId: 'proj-guided' },
  },
  {
    id: 'u2',
    name: 'Dr. Rana Iyer',
    email: 'rana.iyer@northlab.edu',
    role: 'PI',
    settings: { theme: 'dark', defaultLabId: 'lab-main', defaultProjectId: 'proj-guided' },
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
        guide: 'What question are you answering today? Include model, conditions, and expected outcome.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-setup-h', type: 'heading', level: 2, text: 'Setup', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-setup',
        type: 'checklist',
        items: [
          { id: 'c-setup-1', text: 'Sample IDs and groups confirmed', guide: 'Sample IDs and groups confirmed', done: false },
          { id: 'c-setup-2', text: '', guide: 'Controls + blanks prepared', done: false },
          { id: 'c-setup-3', text: '', guide: 'Reagents + lot IDs logged', done: false },
        ],
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-proc-h', type: 'heading', level: 2, text: 'Procedure', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-proc',
        type: 'paragraph',
        text: '',
        guide: 'Step-by-step protocol. Note timing windows and any deviations from SOP.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-obs-h', type: 'heading', level: 2, text: 'Observations', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-obs',
        type: 'paragraph',
        text: 'Alpha context',
        guide: 'Record time-stamped observations, anomalies, and instrument readouts.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-next-h', type: 'heading', level: 2, text: 'Next steps', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-next',
        type: 'paragraph',
        text: '',
        guide: 'What happens next? Add follow-ups, analysis tasks, or handoff notes.',
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
      { id: 'region-setup', entryId: 'entry-guided', label: 'Setup', blockIds: ['b-setup-h', 'b-setup'], linkedAttachments: [] },
      { id: 'region-proc', entryId: 'entry-guided', label: 'Procedure', blockIds: ['b-proc-h', 'b-proc'], linkedAttachments: [] },
      { id: 'region-obs', entryId: 'entry-guided', label: 'Observations', blockIds: ['b-obs-h', 'b-obs'], linkedAttachments: [] },
      { id: 'region-next', entryId: 'entry-guided', label: 'Next steps', blockIds: ['b-next-h', 'b-next'], linkedAttachments: [] },
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
        guide: 'What question are you answering today? Include model, conditions, and expected outcome.',
        updatedAt: seedYesterdayTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-y-setup-h', type: 'heading', level: 2, text: 'Setup', locked: true, updatedAt: seedYesterdayTimestamp, updatedBy: 'me' },
      {
        id: 'b-y-setup',
        type: 'checklist',
        items: [
          { id: 'c-y-setup-1', text: 'Sample IDs and groups confirmed', guide: 'Sample IDs and groups confirmed', done: false },
          { id: 'c-y-setup-2', text: '', guide: 'Controls + blanks prepared', done: false },
          { id: 'c-y-setup-3', text: '', guide: 'Reagents + lot IDs logged', done: false },
        ],
        updatedAt: seedYesterdayTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-y-proc-h', type: 'heading', level: 2, text: 'Procedure', locked: true, updatedAt: seedYesterdayTimestamp, updatedBy: 'me' },
      {
        id: 'b-y-proc',
        type: 'paragraph',
        text: '',
        guide: 'Step-by-step protocol. Note timing windows and any deviations from SOP.',
        updatedAt: seedYesterdayTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-y-obs-h', type: 'heading', level: 2, text: 'Observations', locked: true, updatedAt: seedYesterdayTimestamp, updatedBy: 'me' },
      {
        id: 'b-y-obs',
        type: 'paragraph',
        text: 'Beta context',
        guide: 'Record time-stamped observations, anomalies, and instrument readouts.',
        updatedAt: seedYesterdayTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-y-next-h', type: 'heading', level: 2, text: 'Next steps', locked: true, updatedAt: seedYesterdayTimestamp, updatedBy: 'me' },
      {
        id: 'b-y-next',
        type: 'paragraph',
        text: '',
        guide: 'What happens next? Add follow-ups, analysis tasks, or handoff notes.',
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
      { id: 'region-y-setup', entryId: 'entry-yesterday', label: 'Setup', blockIds: ['b-y-setup-h', 'b-y-setup'], linkedAttachments: [] },
      { id: 'region-y-proc', entryId: 'entry-yesterday', label: 'Procedure', blockIds: ['b-y-proc-h', 'b-y-proc'], linkedAttachments: [] },
      { id: 'region-y-obs', entryId: 'entry-yesterday', label: 'Observations', blockIds: ['b-y-obs-h', 'b-y-obs'], linkedAttachments: [] },
      { id: 'region-y-next', entryId: 'entry-yesterday', label: 'Next steps', blockIds: ['b-y-next-h', 'b-y-next'], linkedAttachments: [] },
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
