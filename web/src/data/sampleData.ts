import type {
  Attachment,
  Entry,
  Experiment,
  Lab,
  Project,
  User,
} from '../domain/types'

export const seedVersion = '2025-12-26-guided-template-v2'

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
    title: 'Guided template - start here',
    dateBucket: seedDateBucket,
    isDaily: true,
    content: [
      { id: 'b-context-h', type: 'heading', level: 2, text: 'Context', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-context',
        type: 'paragraph',
        text: 'What question are you answering today? Include model, conditions, and expected outcome.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-setup-h', type: 'heading', level: 2, text: 'Setup', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-setup',
        type: 'checklist',
        items: [
          { id: 'c-setup-1', text: 'Sample IDs and groups confirmed', done: false },
          { id: 'c-setup-2', text: 'Controls + blanks prepared', done: false },
          { id: 'c-setup-3', text: 'Reagents + lot IDs logged', done: false },
        ],
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-proc-h', type: 'heading', level: 2, text: 'Procedure', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-proc',
        type: 'paragraph',
        text: 'Step-by-step protocol. Note timing windows and any deviations from SOP.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-obs-h', type: 'heading', level: 2, text: 'Observations', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-obs',
        type: 'paragraph',
        text: 'Record time-stamped observations, anomalies, and instrument readouts.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
      { id: 'b-next-h', type: 'heading', level: 2, text: 'Next steps', locked: true, updatedAt: seedTimestamp, updatedBy: 'me' },
      {
        id: 'b-next',
        type: 'paragraph',
        text: 'What happens next? Add follow-ups, analysis tasks, or handoff notes.',
        updatedAt: seedTimestamp,
        updatedBy: 'me',
      },
    ],
    tags: [],
    projectTags: ['IL-17 WT KO aging project'],
    experimentTags: ['Genotyping'],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [],
  },
]

const attachments: Attachment[] = []

export const sampleData = {
  users,
  labs,
  projects,
  experiments,
  entries,
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
