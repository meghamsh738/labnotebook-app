import type {
  Attachment,
  Entry,
  Experiment,
  Lab,
  Project,
  User,
  PinnedRegion,
} from '../domain/types'

const users: User[] = [
  {
    id: 'u1',
    name: 'Dr. Rana Iyer',
    email: 'rana.iyer@northlab.edu',
    role: 'PI',
    settings: { theme: 'dark', defaultLabId: 'lab-north', defaultProjectId: 'proj-tnf' },
  },
  {
    id: 'u2',
    name: 'Megha Sharma',
    email: 'megha@northlab.edu',
    role: 'student',
    settings: { theme: 'dark', defaultLabId: 'lab-north', defaultProjectId: 'proj-tnf' },
  },
]

const labs: Lab[] = [
  {
    id: 'lab-north',
    name: 'Neuroimmunology Lab',
    members: [
      { userId: 'u1', permission: 'owner' },
      { userId: 'u2', permission: 'editor' },
    ],
    storageConfig: {
      location: 'institutional',
      path: '\\\\labserver\\tnf_project\\2025',
    },
  },
]

const projects: Project[] = [
  {
    id: 'proj-tnf',
    labId: 'lab-north',
    title: 'TNF dose + microglia activation',
    description: 'Dose escalation of TNF in microglia cultures and in vivo LPS challenge.',
    tags: ['TNF', 'microglia', 'LPS'],
    archived: false,
  },
  {
    id: 'proj-il17',
    labId: 'lab-north',
    title: 'IL-17 ageing cohort',
    description: 'Behaviour + cytokine readouts across ageing IL-17 cohorts.',
    tags: ['IL-17', 'behaviour', 'ageing'],
  },
]

const experiments: Experiment[] = [
  {
    id: 'exp-lps-day3',
    projectId: 'proj-tnf',
    title: 'Day 3 – LPS + TNF ladder',
    protocolRef: 'PR-2025-11-LPS-TNF',
    animalModel: 'C57BL/6J',
    startDatetime: '2025-12-07T09:00:00Z',
    endDatetime: '2025-12-07T18:00:00Z',
    defaultRawDataPath: '/labserver/TNF_project/2025-12-07/',
  },
  {
    id: 'exp-microglia-culture',
    projectId: 'proj-tnf',
    title: 'Microglia culture – TNF preconditioning',
    protocolRef: 'PR-2025-10-MG-TNF',
    cellLine: 'Primary microglia',
    startDatetime: '2025-12-05T08:30:00Z',
  },
]

const pinnedRegions: PinnedRegion[] = [
  {
    id: 'region-summary',
    entryId: 'entry-1',
    label: 'Summary',
    blockIds: ['b1', 'b2', 'b3'],
    linkedAttachments: ['att-plot'],
    summary: 'LPS+TNF ladder complete. Peak sickness at 4h, good survival. Samples frozen at -80C.',
  },
  {
    id: 'region-raw',
    entryId: 'entry-1',
    label: 'Raw data mapping',
    blockIds: ['b6'],
    linkedAttachments: ['att-raw-csv'],
    summary: 'Sample IDs mapped to instrument exports.',
  },
]

const attachments: Attachment[] = [
  {
    id: 'att-plot',
    entryId: 'entry-1',
    type: 'image',
    filename: 'tnf_lps_timecourse.png',
    filesize: '420 KB',
    storagePath: '/attachments/tnf_lps_timecourse.png',
    thumbnail:
      'https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=800&q=60',
    tag: 'Results',
    pinnedOffline: true,
    cachedPath: '/lab-cache/tnf_lps_timecourse.png',
  },
  {
    id: 'att-raw-csv',
    entryId: 'entry-1',
    type: 'raw',
    filename: 'MG_LPS_TNF_plate2_export.csv',
    filesize: '1.2 MB',
    storagePath: '/labserver/TNF_project/2025-12-07/raw/MG_LPS_TNF_plate2_export.csv',
    sampleId: 'TNF-042',
    pinnedOffline: false,
  },
  {
    id: 'att-gel',
    entryId: 'entry-1',
    type: 'image',
    filename: 'gel_scan_day3.tif',
    filesize: '3.6 MB',
    storagePath: '/labserver/TNF_project/2025-12-07/gel_scan_day3.tif',
    thumbnail:
      'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=800&q=60',
    tag: 'Gel',
    pinnedOffline: true,
    cachedPath: '/lab-cache/gel_scan_day3.tif',
  },
  {
    id: 'att-pdf',
    entryId: 'entry-1',
    type: 'pdf',
    filename: 'instrument-run-log.pdf',
    filesize: '890 KB',
    storagePath: '/labserver/TNF_project/2025-12-07/instrument-run-log.pdf',
    pinnedOffline: false,
  },
]

const entries: Entry[] = [
  {
    id: 'entry-1',
    experimentId: 'exp-lps-day3',
    projectId: 'proj-tnf',
    createdDatetime: '2025-12-07T19:15:00Z',
    lastEditedDatetime: '2025-12-10T02:10:00Z',
    authorId: 'u2',
    title: 'Day 3 – LPS injection + TNF ladder',
    dateBucket: '2025-12-07',
    content: [
      { id: 'b1', type: 'heading', text: 'Objective', level: 2 },
      {
        id: 'b2',
        type: 'paragraph',
        text: 'Escalate TNF doses post-LPS (0.25–1 mg/kg) to map cytokine and sickness response windows.',
      },
      { id: 'b3', type: 'heading', text: 'Protocol highlights', level: 3 },
      {
        id: 'b4',
        type: 'checklist',
        items: [
          { id: 'c1', text: 'Dose prep: 0.25, 0.5, 0.75, 1.0 mg/kg TNF aliquots', done: true },
          { id: 'c2', text: 'LPS 0.5 mg/kg IP at 09:00', done: true },
          { id: 'c3', text: 'Vitals @ 1h, 2h, 4h, 8h', done: true },
          { id: 'c4', text: 'Collect serum + hippocampus @ 8h', done: false },
        ],
      },
      {
        id: 'b5',
        type: 'table',
        caption: 'Sample IDs and treatments',
        data: [
          ['Sample ID', 'Condition', 'Notes'],
          ['TNF-041', '0.25 mg/kg + LPS', 'mild hunch at 4h'],
          ['TNF-042', '0.5 mg/kg + LPS', 'target condition'],
          ['TNF-043', '0.75 mg/kg + LPS', 'slower recovery'],
          ['TNF-044', '1.0 mg/kg + LPS', 'monitor overnight'],
        ],
      },
      { id: 'b6', type: 'heading', text: 'Raw data mapping', level: 3 },
      {
        id: 'b7',
        type: 'paragraph',
        text: 'Raw exports live on \\labserver/TNF_project/2025-12-07/. Linked key files to samples below.',
      },
      {
        id: 'b8',
        type: 'file',
        attachmentId: 'att-raw-csv',
        label: 'Plate reader export (MG_LPS_TNF_plate2_export.csv)',
      },
      { id: 'b9', type: 'divider' },
      { id: 'b10', type: 'heading', text: 'Results snapshot', level: 3 },
      {
        id: 'b11',
        type: 'image',
        attachmentId: 'att-plot',
        caption: 'Cytokine timecourse – TNF + LPS',
      },
      {
        id: 'b12',
        type: 'quote',
        text: 'Peak sickness around 4h at 0.75–1 mg/kg; 0.5 mg/kg gives clear cytokine bump with manageable score.',
      },
    ],
    tags: ['TNF', 'LPS', 'microglia', 'planning'],
    searchTerms: ['TNF-041', 'TNF-042', 'LPS', 'C57BL/6J', 'plate reader'],
    linkedFiles: ['att-plot', 'att-raw-csv', 'att-gel', 'att-pdf'],
    pinnedRegions,
  },
  {
    id: 'entry-2',
    experimentId: 'exp-microglia-culture',
    projectId: 'proj-tnf',
    createdDatetime: '2025-12-05T12:00:00Z',
    lastEditedDatetime: '2025-12-06T09:00:00Z',
    authorId: 'u1',
    title: 'Microglia preconditioning – day 1 notes',
    dateBucket: '2025-12-05',
    content: [
      { id: 'b20', type: 'heading', text: 'Objective', level: 2 },
      {
        id: 'b21',
        type: 'paragraph',
        text: 'Prime microglia with low-dose TNF (2 ng/mL) for 16h then challenge with LPS.',
      },
      {
        id: 'b22',
        type: 'checklist',
        items: [
          { id: 'c10', text: 'Seed 6-well plates (1.2M cells/well)', done: true },
          { id: 'c11', text: 'Add TNF 2 ng/mL 18:00', done: true },
          { id: 'c12', text: 'Change media + LPS 50 ng/mL 10:00', done: false },
        ],
      },
      {
        id: 'b23',
        type: 'table',
        caption: 'Plate layout',
        data: [
          ['Well', 'Condition'],
          ['A1', 'TNF pre + LPS'],
          ['A2', 'TNF pre + LPS'],
          ['B1', 'Vehicle'],
          ['B2', 'Vehicle'],
        ],
      },
    ],
    tags: ['TNF', 'microglia', 'analysis'],
    searchTerms: ['microglia', 'LPS 50 ng/mL', 'TNF 2 ng/mL'],
    linkedFiles: [],
    pinnedRegions: [],
  },
]

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
