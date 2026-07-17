const ACCOUNT_ID = 'local-workspace'
const ACCOUNT_PREFIX = `labnote.account.${ACCOUNT_ID}`
const SEED_VERSION = '2026-01-17-daily-entry'

const pad = (value) => String(value).padStart(2, '0')

function dateParts(referenceDate, daysAgo) {
  const date = new Date(referenceDate)
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - daysAgo)
  const dateBucket = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return {
    date,
    dateBucket,
    timestamp: date.toISOString(),
    title: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date),
  }
}

function paragraph(id, text, timestamp) {
  return { id, type: 'paragraph', text, updatedAt: timestamp, updatedBy: 'reviewer' }
}

function heading(id, text, timestamp) {
  return { id, type: 'heading', level: 2, text, updatedAt: timestamp, updatedBy: 'reviewer' }
}

function makeWorkbookData() {
  const rows = Array.from({ length: 24 }, () => Array.from({ length: 8 }, () => ''))
  rows[0] = ['Condition', 'Dose', 'Replicate', 'Iba1 MFI', 'CD68 MFI', 'Viability', 'Plate', 'Notes']
  rows[1] = ['Vehicle', '0 ng/mL', '1', '1420', '865', '96%', 'A1', 'Baseline']
  rows[2] = ['Vehicle', '0 ng/mL', '2', '1388', '842', '95%', 'A2', 'Baseline']
  rows[3] = ['TNF', '1 ng/mL', '1', '1675', '1098', '94%', 'B1', 'Mild response']
  rows[4] = ['TNF', '1 ng/mL', '2', '1712', '1124', '93%', 'B2', 'Mild response']
  rows[5] = ['TNF', '10 ng/mL', '1', '2310', '1764', '91%', 'C1', 'Expected response']
  rows[6] = ['TNF', '10 ng/mL', '2', '2268', '1729', '90%', 'C2', 'Expected response']
  rows[7] = ['TNF', '50 ng/mL', '1', '2782', '2140', '82%', 'D1', 'Viability drop']
  return rows
}

function makeEntry({
  id,
  daysAgo,
  projectId,
  experimentId,
  content,
  projectTags = [],
  experimentTags = [],
  linkedFiles = [],
  referenceDate,
}) {
  const date = dateParts(referenceDate, daysAgo)
  return {
    id,
    experimentId,
    projectId,
    createdDatetime: date.timestamp,
    lastEditedDatetime: date.timestamp,
    authorId: 'review-user',
    title: date.title,
    dateBucket: date.dateBucket,
    isDaily: true,
    content,
    tags: [],
    projectTags,
    experimentTags,
    searchTerms: [...projectTags, ...experimentTags],
    linkedFiles,
    pinnedRegions: [],
  }
}

export function buildUiReviewFixture(referenceDate = new Date()) {
  const today = dateParts(referenceDate, 0)
  const yesterday = dateParts(referenceDate, 1)
  const twoDaysAgo = dateParts(referenceDate, 2)
  const fourDaysAgo = dateParts(referenceDate, 4)
  const sixDaysAgo = dateParts(referenceDate, 6)

  const projects = [
    {
      id: 'review-project-aging',
      labId: 'review-lab',
      title: 'Aging neuroinflammation',
      description: 'IL-17-dependent changes in microglial activation during aging.',
      tags: ['IL-17', 'aging', 'microglia'],
      archived: false,
    },
    {
      id: 'review-project-tnf',
      labId: 'review-lab',
      title: 'TNF microglia activation',
      description: 'Dose-response and imaging pilot for acute TNF stimulation.',
      tags: ['TNF', 'cell culture'],
      archived: false,
    },
  ]

  const experiments = [
    {
      id: 'review-exp-tnf',
      projectId: 'review-project-tnf',
      title: 'TNF dose-response pilot',
      protocolRef: 'MICRO-TNF-02',
      cellLine: 'Primary mouse microglia',
      startDatetime: today.timestamp,
    },
    {
      id: 'review-exp-if',
      projectId: 'review-project-aging',
      title: 'Iba1 and CD68 immunofluorescence',
      protocolRef: 'IF-IBA1-04',
      animalModel: 'IL-17 WT and KO, 12 months',
      startDatetime: yesterday.timestamp,
    },
    {
      id: 'review-exp-facs',
      projectId: 'review-project-aging',
      title: 'Microglia flow panel acquisition',
      protocolRef: 'FACS-MG-03',
      animalModel: 'IL-17 WT and KO, 12 months',
      startDatetime: twoDaysAgo.timestamp,
    },
    {
      id: 'review-exp-genotype',
      projectId: 'review-project-aging',
      title: 'IL-17 colony genotype review',
      protocolRef: 'PCR-IL17-01',
      startDatetime: fourDaysAgo.timestamp,
    },
  ]

  const richContent = [
    heading('review-today-summary-heading', 'Summary', today.timestamp),
    paragraph(
      'review-today-summary',
      'Primary microglia were stimulated with TNF for 6 hours to define a working dose before the aging cohort experiment. The 10 ng/mL condition increased Iba1 and CD68 without a marked loss of viability.',
      today.timestamp,
    ),
    heading('review-today-samples-heading', 'Samples', today.timestamp),
    {
      id: 'review-today-samples',
      type: 'table',
      headerRow: true,
      caption: 'TNF stimulation groups',
      data: [
        ['Sample', 'Condition', 'Replicates', 'Readout'],
        ['MG-01', 'Vehicle', '2', 'Iba1, CD68, viability'],
        ['MG-02', 'TNF 1 ng/mL', '2', 'Iba1, CD68, viability'],
        ['MG-03', 'TNF 10 ng/mL', '2', 'Iba1, CD68, viability'],
        ['MG-04', 'TNF 50 ng/mL', '1', 'Iba1, CD68, viability'],
      ],
      updatedAt: today.timestamp,
      updatedBy: 'reviewer',
    },
    heading('review-today-checklist-heading', 'Run checklist', today.timestamp),
    {
      id: 'review-today-checklist',
      type: 'checklist',
      items: [
        { id: 'review-check-1', text: 'Confirm plate map and treatment labels', done: true },
        { id: 'review-check-2', text: 'Capture 20x fields using the same exposure', done: true },
        { id: 'review-check-3', text: 'Export blinded intensity measurements', done: false },
      ],
      updatedAt: today.timestamp,
      updatedBy: 'reviewer',
    },
    heading('review-today-observation-heading', 'Observation', today.timestamp),
    paragraph(
      'The 50 ng/mL group showed rounded cells and lower confluence. Keep 10 ng/mL as the primary dose and repeat the high-dose condition only if a toxicity control is required.',
      today.timestamp,
    ),
    {
      id: 'review-today-workbook',
      type: 'workbook',
      title: 'TNF dose-response measurements',
      data: makeWorkbookData(),
      styles: {
        A1: { bold: true }, B1: { bold: true }, C1: { bold: true }, D1: { bold: true },
        E1: { bold: true }, F1: { bold: true }, G1: { bold: true }, H1: { bold: true },
      },
      updatedAt: today.timestamp,
      updatedBy: 'reviewer',
    },
  ]

  const entries = [
    makeEntry({
      id: 'review-entry-today',
      daysAgo: 0,
      projectId: 'review-project-tnf',
      experimentId: 'review-exp-tnf',
      content: richContent,
      projectTags: ['TNF microglia activation'],
      experimentTags: ['Cell culture', 'Immunofluorescence'],
      linkedFiles: ['review-att-image', 'review-att-csv', 'review-att-pdf'],
      referenceDate,
    }),
    makeEntry({
      id: 'review-entry-if',
      daysAgo: 1,
      projectId: 'review-project-aging',
      experimentId: 'review-exp-if',
      content: [
        heading('review-if-aim-heading', 'Aim', yesterday.timestamp),
        paragraph('review-if-aim', 'Compare Iba1 and CD68 staining between age-matched IL-17 WT and KO cortex sections.', yesterday.timestamp),
        heading('review-if-observation-heading', 'Observation', yesterday.timestamp),
        paragraph('review-if-observation', 'KO sections showed fewer CD68-high cells in layer V. Exposure and threshold settings were held constant.', yesterday.timestamp),
      ],
      projectTags: ['IL-17 WT KO aging project'],
      experimentTags: ['Immunofluorescence'],
      linkedFiles: ['review-att-if-image'],
      referenceDate,
    }),
    makeEntry({
      id: 'review-entry-facs',
      daysAgo: 2,
      projectId: 'review-project-aging',
      experimentId: 'review-exp-facs',
      content: [
        heading('review-facs-heading', 'Acquisition notes', twoDaysAgo.timestamp),
        paragraph('review-facs-note', 'Recorded 80,000 live singlets per sample. Compensation controls passed and the CD11b-positive gate remained stable across batches.', twoDaysAgo.timestamp),
      ],
      projectTags: ['IL-17 WT KO aging project'],
      experimentTags: ['Flow cytometry'],
      linkedFiles: ['review-att-fcs'],
      referenceDate,
    }),
    makeEntry({
      id: 'review-entry-genotype',
      daysAgo: 4,
      projectId: 'review-project-aging',
      experimentId: 'review-exp-genotype',
      content: [
        heading('review-genotype-heading', 'Result', fourDaysAgo.timestamp),
        paragraph('review-genotype-note', 'All samples matched the expected genotype. Mouse 24-118 was repeated because the first WT band was faint.', fourDaysAgo.timestamp),
      ],
      projectTags: ['IL-17 WT KO aging project'],
      experimentTags: ['Genotyping'],
      referenceDate,
    }),
    makeEntry({
      id: 'review-entry-blank',
      daysAgo: 6,
      projectId: 'review-project-tnf',
      experimentId: 'review-exp-tnf',
      content: [paragraph('review-blank-paragraph', '', sixDaysAgo.timestamp)],
      referenceDate,
    }),
  ]

  const attachments = [
    {
      id: 'review-att-image',
      entryId: 'review-entry-today',
      type: 'image',
      filename: 'microglia_field_07.tif',
      filesize: '18.4 MB',
      bytes: 19293798,
      storagePath: 'review/evidence/microglia_field_07.tif',
      contentType: 'image/tiff',
      mimeType: 'image/tiff',
      driveFileId: 'review-file-image-07',
      syncStatus: 'synced',
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
    },
    {
      id: 'review-att-csv',
      entryId: 'review-entry-today',
      type: 'raw',
      filename: 'TNF_timecourse_quantification.csv',
      filesize: '46 KB',
      bytes: 47104,
      storagePath: 'review/evidence/TNF_timecourse_quantification.csv',
      contentType: 'text/csv',
      mimeType: 'text/csv',
      driveFileId: 'review-file-csv-01',
      syncStatus: 'synced',
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
    },
    {
      id: 'review-att-pdf',
      entryId: 'review-entry-today',
      type: 'pdf',
      filename: 'TNF_stimulation_plate_map.pdf',
      filesize: '284 KB',
      bytes: 290816,
      storagePath: 'review/evidence/TNF_stimulation_plate_map.pdf',
      contentType: 'application/pdf',
      mimeType: 'application/pdf',
      driveFileId: 'review-file-pdf-01',
      syncStatus: 'synced',
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
    },
    {
      id: 'review-att-if-image',
      entryId: 'review-entry-if',
      type: 'image',
      filename: 'IL17KO_CD68_20x_field03.tif',
      filesize: '22.1 MB',
      bytes: 23173530,
      storagePath: 'review/evidence/IL17KO_CD68_20x_field03.tif',
      contentType: 'image/tiff',
      mimeType: 'image/tiff',
      driveFileId: 'review-file-if-03',
      syncStatus: 'remote-available',
      createdAt: yesterday.timestamp,
      updatedAt: yesterday.timestamp,
    },
    {
      id: 'review-att-fcs',
      entryId: 'review-entry-facs',
      type: 'raw',
      filename: 'IL17KO_microglia_panel_batch2.fcs',
      filesize: '7.8 MB',
      bytes: 8178892,
      storagePath: 'review/evidence/IL17KO_microglia_panel_batch2.fcs',
      contentType: 'application/octet-stream',
      mimeType: 'application/octet-stream',
      driveFileId: 'review-file-fcs-02',
      syncStatus: 'synced',
      createdAt: twoDaysAgo.timestamp,
      updatedAt: twoDaysAgo.timestamp,
    },
    {
      id: 'review-att-inbox-csv',
      entryId: 'review-entry-today',
      type: 'raw',
      filename: 'TNF_repeat_rep2.csv',
      filesize: '39 KB',
      bytes: 39936,
      storagePath: 'review/inbox/TNF_repeat_rep2.csv',
      contentType: 'text/csv',
      mimeType: 'text/csv',
      driveFileId: 'review-inbox-csv-02',
      syncStatus: 'remote-available',
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
    },
    {
      id: 'review-att-inbox-image',
      entryId: 'review-entry-today',
      type: 'image',
      filename: 'microglia_field_08.tif',
      filesize: '17.9 MB',
      bytes: 18769510,
      storagePath: 'review/inbox/microglia_field_08.tif',
      contentType: 'image/tiff',
      mimeType: 'image/tiff',
      syncStatus: 'queued',
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
    },
  ]

  const protocols = [
    {
      id: 'review-protocol-if',
      title: 'Iba1 and CD68 immunofluorescence',
      createdDatetime: fourDaysAgo.timestamp,
      lastEditedDatetime: yesterday.timestamp,
      tags: ['Immunofluorescence', 'SOP'],
      searchTerms: ['Iba1', 'CD68', 'staining'],
      content: [
        heading('review-protocol-if-aim-h', 'Aim', yesterday.timestamp),
        paragraph('review-protocol-if-aim', 'Stain fixed brain sections for Iba1 and CD68 using matched exposure settings.', yesterday.timestamp),
        heading('review-protocol-if-materials-h', 'Materials', yesterday.timestamp),
        {
          id: 'review-protocol-if-materials',
          type: 'checklist',
          items: [
            { id: 'review-protocol-if-m1', text: 'Rabbit anti-Iba1', done: false },
            { id: 'review-protocol-if-m2', text: 'Rat anti-CD68', done: false },
            { id: 'review-protocol-if-m3', text: 'Fluorophore-conjugated secondary antibodies', done: false },
          ],
          updatedAt: yesterday.timestamp,
          updatedBy: 'reviewer',
        },
        heading('review-protocol-if-steps-h', 'Procedure', yesterday.timestamp),
        paragraph('review-protocol-if-steps', 'Block for 1 hour, incubate primary antibodies overnight at 4°C, wash, then incubate secondary antibodies for 2 hours.', yesterday.timestamp),
      ],
    },
    {
      id: 'review-protocol-tnf',
      title: 'Primary microglia TNF stimulation',
      createdDatetime: fourDaysAgo.timestamp,
      lastEditedDatetime: today.timestamp,
      tags: ['Cell culture', 'TNF'],
      searchTerms: ['TNF', 'microglia', 'dose response'],
      content: [
        heading('review-protocol-tnf-aim-h', 'Aim', today.timestamp),
        paragraph('review-protocol-tnf-aim', 'Apply a controlled TNF dose series to primary microglia and preserve matched untreated controls.', today.timestamp),
        heading('review-protocol-tnf-steps-h', 'Procedure', today.timestamp),
        paragraph('review-protocol-tnf-steps', 'Prepare fresh TNF dilutions, replace half the medium, incubate for 6 hours, and collect imaging plus viability readouts.', today.timestamp),
      ],
    },
    {
      id: 'review-protocol-facs',
      title: 'Microglia flow cytometry panel',
      createdDatetime: sixDaysAgo.timestamp,
      lastEditedDatetime: twoDaysAgo.timestamp,
      tags: ['Flow cytometry'],
      searchTerms: ['CD11b', 'CD45', 'microglia'],
      content: [
        heading('review-protocol-facs-aim-h', 'Aim', twoDaysAgo.timestamp),
        paragraph('review-protocol-facs-aim', 'Identify live CD11b-positive, CD45-low microglia and record at least 80,000 singlets per sample.', twoDaysAgo.timestamp),
      ],
    },
  ]

  const fileBoxItems = [
    {
      id: 'review-filebox-csv',
      entryId: 'review-entry-today',
      attachmentId: 'review-att-inbox-csv',
      filename: 'TNF_repeat_rep2.csv',
      filesize: '39 KB',
      contentType: 'text/csv',
      sourceDeviceId: 'review-device-phone',
      sourceDeviceName: 'Lab phone',
      status: 'available',
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
      driveFileId: 'review-inbox-csv-02',
    },
    {
      id: 'review-filebox-image',
      entryId: 'review-entry-today',
      attachmentId: 'review-att-inbox-image',
      filename: 'microglia_field_08.tif',
      filesize: '17.9 MB',
      contentType: 'image/tiff',
      sourceDeviceId: 'review-device-phone',
      sourceDeviceName: 'Lab phone',
      status: 'queued',
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
    },
  ]

  const transfers = [
    {
      id: 'review-transfer-csv',
      fileBoxItemId: 'review-filebox-csv',
      entryId: 'review-entry-today',
      attachmentId: 'review-att-inbox-csv',
      filename: 'TNF_repeat_rep2.csv',
      fromDeviceId: 'review-device-phone',
      fromDeviceName: 'Lab phone',
      toDeviceId: 'review-device-desktop',
      toDeviceName: 'Lab desktop',
      provider: 'google-drive',
      status: 'available',
      bytesTotal: 39936,
      bytesTransferred: 39936,
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
      completedAt: today.timestamp,
      driveFileId: 'review-inbox-csv-02',
    },
    {
      id: 'review-transfer-image',
      fileBoxItemId: 'review-filebox-image',
      entryId: 'review-entry-today',
      attachmentId: 'review-att-inbox-image',
      filename: 'microglia_field_08.tif',
      fromDeviceId: 'review-device-phone',
      fromDeviceName: 'Lab phone',
      toDeviceId: 'review-device-desktop',
      toDeviceName: 'Lab desktop',
      provider: 'google-drive',
      status: 'queued',
      bytesTotal: 18769510,
      bytesTransferred: 0,
      createdAt: today.timestamp,
      updatedAt: today.timestamp,
    },
  ]

  const driveConnection = {
    provider: 'google-drive',
    storageMode: 'google-drive',
    clientId: '',
    folderName: 'Easylab Lab Notebook',
    folderId: 'review-workspace',
    connectedAccount: {
      provider: 'google',
      email: '',
      name: 'Researcher',
      subject: ACCOUNT_ID,
    },
    connectedAt: sixDaysAgo.timestamp,
    lastSyncAt: today.timestamp,
    status: 'ready',
  }

  const storage = {
    'labnote.seedVersion': SEED_VERSION,
    'labnote.setupComplete': '1',
    'labnote.connected.googleDrive': JSON.stringify(driveConnection),
    [`${ACCOUNT_PREFIX}.labnote.projects`]: JSON.stringify(projects),
    [`${ACCOUNT_PREFIX}.labnote.experiments`]: JSON.stringify(experiments),
    [`${ACCOUNT_PREFIX}.labnote.entries`]: JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.id, entry]))),
    [`${ACCOUNT_PREFIX}.labnote.protocols`]: JSON.stringify(protocols),
    [`${ACCOUNT_PREFIX}.labnote.attachments`]: JSON.stringify(attachments),
    [`${ACCOUNT_PREFIX}.labnote.projectTags`]: JSON.stringify(['IL-17 WT KO aging project', 'TNF microglia activation']),
    [`${ACCOUNT_PREFIX}.labnote.experimentTags`]: JSON.stringify(['Cell culture', 'Immunofluorescence', 'Flow cytometry', 'Genotyping']),
    [`${ACCOUNT_PREFIX}.labnote.connected.fileBox`]: JSON.stringify(fileBoxItems),
    [`${ACCOUNT_PREFIX}.labnote.connected.transfers`]: JSON.stringify(transfers),
    [`${ACCOUNT_PREFIX}.labnote.connected.conflicts`]: JSON.stringify([]),
    [`${ACCOUNT_PREFIX}.labnote.connected.device`]: JSON.stringify({
      id: 'review-device-desktop',
      name: 'Lab desktop',
      platform: 'desktop',
      createdAt: sixDaysAgo.timestamp,
      lastSeenAt: today.timestamp,
      appVersion: 'review',
    }),
  }

  return {
    storage,
    ids: {
      populatedEntry: 'review-entry-today',
      blankEntry: 'review-entry-blank',
      blankEntryDateBucket: sixDaysAgo.dateBucket,
      protocol: 'review-protocol-if',
    },
    summary: {
      entries: entries.length,
      projects: projects.length,
      protocols: protocols.length,
      attachments: attachments.length,
      waitingFiles: fileBoxItems.length,
      transfers: transfers.length,
    },
  }
}

export async function installUiReviewFixture(context, fixture = buildUiReviewFixture()) {
  await context.addInitScript(({ storage }) => {
    window.localStorage.clear()
    for (const [key, value] of Object.entries(storage)) {
      window.localStorage.setItem(key, value)
    }
  }, { storage: fixture.storage })
}
