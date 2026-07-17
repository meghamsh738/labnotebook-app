package com.easylab.labnotebook.ui

import android.net.Uri
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.material3.MaterialTheme
import com.easylab.labnotebook.IncomingShareRequest
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.TransferEntity
import com.easylab.labnotebook.data.capture.CaptureFile
import com.easylab.labnotebook.data.capture.CaptureRepository
import com.easylab.labnotebook.data.capture.CaptureResult
import com.easylab.labnotebook.data.migration.LegacyImportPolicy
import com.easylab.labnotebook.data.migration.LegacyImportResult
import com.easylab.labnotebook.data.migration.LegacyWorkspaceImportRepository
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import com.easylab.labnotebook.data.repository.EntryMutationRepository
import com.easylab.labnotebook.data.repository.InMemoryAttachmentRepository
import com.easylab.labnotebook.data.repository.InMemoryFileHubRepository
import com.easylab.labnotebook.data.repository.InMemoryJournalRepository
import com.easylab.labnotebook.sync.PlaceholderSyncCoordinator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w390dp-h844dp")
class JournalScreensTest {
    @Test
    fun nativeNoteEditorSavesEditedBlocksWithoutTouchingProtectedContent() {
        val paragraph = NativeNoteBlock.Paragraph(NoteBlockMetadata("paragraph"), "Before")
        val workbook = NativeNoteBlock.Workbook(NoteBlockMetadata("workbook"), listOf(listOf("Dose")))
        var saved: NativeNoteEditorState? = null

        compose.setContent {
            MaterialTheme {
                NativeNoteEditorWorkspace(
                    initialBlocks = listOf(paragraph, workbook),
                    stateKey = "entry:1",
                    onSave = { saved = it },
                    onCancel = {},
                )
            }
        }

        compose.onNodeWithTag("note-paragraph-paragraph").performTextReplacement("After")
        compose.onNodeWithTag("note-save").performClick()

        val snapshot = checkNotNull(saved).snapshot("time", "device")
        assertEquals("After", (snapshot[0] as NativeNoteBlock.Paragraph).text)
        assertEquals(workbook, snapshot[1])
    }

    @get:Rule
    val compose = createComposeRule()

    private val accountA = AccountId("researcher-a")
    private val accountB = AccountId("researcher-b")

    @Test
    fun todayAndEntriesUseOnlyTheSignedInAccount() {
        val journal = InMemoryJournalRepository()
        val attachments = InMemoryAttachmentRepository()
        runBlocking {
            journal.upsertEntry(accountA, entry(accountA, "today-a", "TNF dose-response pilot", todayDateBucket()))
            journal.upsertEntry(accountA, entry(accountA, "older-a", "Previous assay result", "2026-05-22"))
            journal.upsertEntry(accountB, entry(accountB, "private-b", "Account B private entry", todayDateBucket()))
        }

        setApp(journal, attachments)

        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("entry-reader-today-a").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("TNF dose-response pilot").assertExists()
        compose.onNodeWithText("Account B private entry").assertDoesNotExist()

        compose.onNodeWithText("Entries").performClick()
        compose.onNodeWithText("Previous assay result").assertExists()
        compose.onNodeWithText("Account B private entry").assertDoesNotExist()
    }

    @Test
    fun blankTodayCreatesAnAccountScopedEntryAndOpensTheNativeEditor() {
        val journal = InMemoryJournalRepository()
        var createdEntry: JournalEntryEntity? = null
        val mutations = object : EntryMutationRepository {
            override suspend fun createEntry(accountId: AccountId, entry: JournalEntryEntity): JournalEntryEntity {
                assertEquals(accountA, accountId)
                assertEquals(accountA.value, entry.accountId)
                assertEquals(todayDateBucket(), entry.dateBucket)
                assertEquals("pixel-test", entry.updatedByDeviceId)
                createdEntry = entry.copy(syncStatus = "queued")
                journal.upsertEntry(accountId, checkNotNull(createdEntry))
                return checkNotNull(createdEntry)
            }

            override suspend fun saveEntry(
                accountId: AccountId,
                entry: JournalEntryEntity,
                contentJson: String,
                editedAt: String,
                deviceId: String,
            ): JournalEntryEntity = entry
        }
        setApp(
            journal = journal,
            attachments = InMemoryAttachmentRepository(),
            entryMutationRepository = mutations,
            deviceId = "pixel-test",
        )

        compose.onNodeWithTag("write-today-note").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("note-editor").fetchSemanticsNodes().isNotEmpty()
        }

        val created = checkNotNull(createdEntry)
        assertEquals("queued", created.syncStatus)
        assertEquals(1, created.version)
        assertEquals("", NoteBlockCodec.decode(created.contentJson).filterIsInstance<NativeNoteBlock.Paragraph>().single().text)
        compose.onNodeWithTag("note-save").assertExists()
        compose.onNodeWithText("No entry for today").assertDoesNotExist()
    }

    @Test
    fun signedInSettingsExposeTheInjectedPreviousBackupImporter() {
        val importer = object : LegacyWorkspaceImportRepository {
            override suspend fun import(
                accountId: AccountId,
                activeDeviceId: String,
                rawJson: String,
                policy: LegacyImportPolicy,
            ) = LegacyImportResult(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        }
        setApp(
            journal = InMemoryJournalRepository(),
            attachments = InMemoryAttachmentRepository(),
            deviceId = "pixel-test",
            legacyImportRepository = importer,
        )

        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Advanced").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("Previous Easylab backup").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Previous Easylab backup").assertExists()
        compose.onNodeWithText("Choose backup").assertExists()
    }

    @Test
    fun captureIsAPrimaryDestinationWhileSettingsRemainInTheAppMenu() {
        val captures = object : CaptureRepository {
            override suspend fun attachToToday(
                accountId: AccountId,
                activeDeviceId: String,
                dateBucket: String,
                capturedAt: String,
                files: List<CaptureFile>,
            ): CaptureResult = error("The picker is not exercised by this navigation test.")
        }
        setApp(
            journal = InMemoryJournalRepository(),
            attachments = InMemoryAttachmentRepository(),
            deviceId = "pixel-test",
            captureRepository = captures,
        )

        compose.onNodeWithText("Capture").performClick()
        compose.onNodeWithTag("capture-quick-note").assertExists()
        compose.onNodeWithTag("capture-take-photo").assertExists()
        compose.onNodeWithTag("capture-choose-files").assertExists()
        compose.onNodeWithText("Quick note").assertExists()
        compose.onNodeWithText("Take photo").assertExists()
        compose.onNodeWithText("Choose files").assertExists()

        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Account and sync settings.").assertExists()
    }

    @Test
    fun quickNoteFromCaptureOpensTodaysNativeEditor() {
        val journal = InMemoryJournalRepository()
        runBlocking {
            journal.upsertEntry(accountA, entry(accountA, "today-a", "TNF dose-response pilot", todayDateBucket()))
        }
        val mutations = object : EntryMutationRepository {
            override suspend fun saveEntry(
                accountId: AccountId,
                entry: JournalEntryEntity,
                contentJson: String,
                editedAt: String,
                deviceId: String,
            ): JournalEntryEntity = entry.copy(contentJson = contentJson)
        }
        setApp(
            journal = journal,
            attachments = InMemoryAttachmentRepository(),
            entryMutationRepository = mutations,
            deviceId = "pixel-test",
        )

        compose.onNodeWithText("Capture").performClick()
        compose.onNodeWithTag("capture-quick-note").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("note-editor").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("note-editor").assertExists()
        compose.onNodeWithTag("note-save").assertExists()
    }

    @Test
    fun incomingAndroidShareOpensCaptureAndCanBeDismissedExplicitly() {
        var consumedRequest: String? = null
        setApp(
            journal = InMemoryJournalRepository(),
            attachments = InMemoryAttachmentRepository(),
            deviceId = "pixel-test",
            pendingShare = IncomingShareRequest(
                id = "share-request",
                uris = listOf(Uri.parse("content://instrument/result.csv")),
                mimeType = "text/csv",
            ),
            onShareConsumed = { consumedRequest = it },
        )

        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("capture-shared-files").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Shared with Easylab").assertExists()
        compose.onNodeWithText("Add to today").assertExists()
        compose.onNodeWithText("Dismiss").performClick()
        assertEquals("share-request", consumedRequest)
    }

    @Test
    fun globalFilesShowsAccountScopedLibraryIncomingAndActivityWithoutWriteActions() {
        val fileHub = InMemoryFileHubRepository()
        runBlocking {
            fileHub.upsertAttachment(
                accountA,
                AttachmentEntity(
                    accountId = accountA.value,
                    id = "library-a",
                    entryId = "entry-a",
                    type = "raw",
                    filename = "dose-response-a.csv",
                    displaySize = "18.4 KB",
                    storagePath = "attachments/dose-response-a.csv",
                    driveFileId = "drive-a",
                    syncStatus = "synced",
                    createdAt = "2026-05-23T10:00:00Z",
                    updatedAt = "2026-05-23T10:00:00Z",
                ),
            )
            fileHub.upsertAttachment(
                accountB,
                AttachmentEntity(
                    accountId = accountB.value,
                    id = "library-b",
                    entryId = "entry-b",
                    type = "raw",
                    filename = "private-b.csv",
                    displaySize = "1 KB",
                    storagePath = "attachments/private-b.csv",
                    createdAt = "2026-05-23T10:00:00Z",
                    updatedAt = "2026-05-23T10:00:00Z",
                ),
            )
            fileHub.upsertFileBoxItem(
                accountA,
                FileBoxItemEntity(
                    accountId = accountA.value,
                    id = "incoming-a",
                    entryId = "entry-a",
                    filename = "incoming-microscopy-a.tiff",
                    filesize = "24 MB",
                    contentType = "image/tiff",
                    sourceDeviceId = "pixel-a",
                    sourceDeviceName = "Lab phone",
                    status = "available",
                    createdAt = "2026-05-24T10:00:00Z",
                    updatedAt = "2026-05-24T10:00:00Z",
                ),
            )
            fileHub.upsertFileBoxItem(
                accountB,
                FileBoxItemEntity(
                    accountId = accountB.value,
                    id = "incoming-b",
                    entryId = "entry-b",
                    filename = "private-incoming-b.tiff",
                    filesize = "4 MB",
                    sourceDeviceId = "pixel-b",
                    sourceDeviceName = "Other phone",
                    status = "available",
                    createdAt = "2026-05-24T10:00:00Z",
                    updatedAt = "2026-05-24T10:00:00Z",
                ),
            )
            fileHub.upsertTransfer(
                accountA,
                TransferEntity(
                    accountId = accountA.value,
                    id = "activity-a",
                    fileBoxItemId = "incoming-a",
                    entryId = "entry-a",
                    filename = "incoming-microscopy-a.tiff",
                    fromDeviceId = "pixel-a",
                    fromDeviceName = "Lab phone",
                    toDeviceId = "desktop-a",
                    toDeviceName = "Lab desktop",
                    provider = "google-drive",
                    status = "completed",
                    createdAt = "2026-05-24T10:00:00Z",
                    updatedAt = "2026-05-24T10:05:00Z",
                    completedAt = "2026-05-24T10:05:00Z",
                ),
            )
            fileHub.upsertTransfer(
                accountB,
                TransferEntity(
                    accountId = accountB.value,
                    id = "activity-b",
                    filename = "private-activity-b.csv",
                    fromDeviceId = "pixel-b",
                    fromDeviceName = "Other phone",
                    provider = "google-drive",
                    status = "completed",
                    createdAt = "2026-05-24T10:00:00Z",
                    updatedAt = "2026-05-24T10:05:00Z",
                ),
            )
        }

        setApp(
            journal = InMemoryJournalRepository(),
            attachments = InMemoryAttachmentRepository(),
            fileHub = fileHub,
        )
        compose.onNodeWithText("Files").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("file-library-library-a").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("dose-response-a.csv").assertExists()
        compose.onNodeWithText("Drive only").assertExists()
        compose.onNodeWithText("private-b.csv").assertDoesNotExist()

        compose.onNodeWithText("Incoming (1)").performClick()
        compose.onNodeWithText("incoming-microscopy-a.tiff").assertExists()
        compose.onNodeWithText("Lab phone · 24 MB · 24 May 2026").assertExists()
        compose.onNodeWithText("Needs attention").assertExists()
        compose.onNodeWithText("private-incoming-b.tiff").assertDoesNotExist()

        compose.onNodeWithText("Activity").performClick()
        compose.onNodeWithText("incoming-microscopy-a.tiff").assertExists()
        compose.onNodeWithText("Lab phone to Lab desktop · 24 May 2026").assertExists()
        compose.onNodeWithText("Complete").assertExists()
        compose.onNodeWithText("private-activity-b.csv").assertDoesNotExist()

        listOf("Open", "Download", "Attach", "Retry", "Reject").forEach { action ->
            compose.onNodeWithText(action).assertDoesNotExist()
        }
    }

    @Test
    fun entryDetailShowsReadOnlyBlocksAndAttachmentMetadataWithoutWriteOrBlobActions() {
        val journal = InMemoryJournalRepository()
        val attachments = InMemoryAttachmentRepository()
        val entry = entry(accountA, "entry-a", "Microglia stimulation", "2026-05-23")
        runBlocking {
            journal.upsertEntry(accountA, entry)
            attachments.upsertAttachment(
                accountA,
                AttachmentEntity(
                    accountId = accountA.value,
                    id = "attachment-a",
                    entryId = entry.id,
                    type = "raw",
                    filename = "microglia-dose-response-results.csv",
                    displaySize = "18.4 KB",
                    storagePath = "attachments/2026-05-23/attachment-a-results.csv",
                    mimeType = "text/csv",
                    createdAt = "2026-05-23T10:00:00Z",
                    updatedAt = "2026-05-23T10:00:00Z",
                    syncStatus = "synced",
                ),
            )
            attachments.upsertAttachment(
                accountB,
                AttachmentEntity(
                    accountId = accountB.value,
                    id = "attachment-a",
                    entryId = entry.id,
                    type = "raw",
                    filename = "account-b-private.csv",
                    displaySize = "1 KB",
                    storagePath = "attachments/private.csv",
                    mimeType = "text/csv",
                    createdAt = "2026-05-23T10:00:00Z",
                    updatedAt = "2026-05-23T10:00:00Z",
                ),
            )
        }

        setApp(journal, attachments)
        compose.onNodeWithText("Entries").performClick()
        compose.onNodeWithText("Microglia stimulation").performClick()

        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("entry-reader-entry-a").fetchSemanticsNodes().isNotEmpty()
        }
        val sectionContent = compose.onNodeWithTag("entry-section-content")
        listOf("note", "workbook", "files", "details").forEach { section ->
            compose.onNodeWithTag("entry-section-$section").assertExists()
        }
        compose.onNodeWithTag("attachment-attachment-a").assertDoesNotExist()
        sectionContent.performScrollToNode(hasText("Vehicle and LPS groups were compared."))
        compose.onNodeWithText("Vehicle and LPS groups were compared.").assertExists()
        sectionContent.performScrollToNode(hasText("Confirm viability"))
        compose.onNodeWithText("Confirm viability").assertExists()

        compose.onNodeWithTag("entry-section-workbook").performClick()
        compose.onNodeWithTag("workbook-workspace").assertExists()
        compose.onNodeWithText("Dose response").assertExists()
        compose.onNodeWithTag("workbook-selected-address").assertTextEquals("A1")
        compose.onNodeWithTag("workbook-selected-value").assertTextEquals("Dose (ng/mL)")
        compose.onNodeWithText("Viability").performClick()
        compose.onNodeWithTag("workbook-selected-address").assertTextEquals("B1")
        compose.onNodeWithTag("workbook-selected-value").assertTextEquals("Viability")

        compose.onNodeWithTag("entry-section-files").performClick()
        compose.onNodeWithText("Evidence · 1").assertExists()
        val filesContent = compose.onNodeWithTag("entry-section-content")
        filesContent.performScrollToNode(hasTestTag("attachment-attachment-a"))
        compose.onNodeWithTag("attachment-attachment-a").assertExists()
        filesContent.performScrollToNode(hasText("CSV · 18.4 KB · Drive only"))
        compose.onNodeWithText("CSV · 18.4 KB · Drive only").assertExists()
        compose.onNodeWithText("account-b-private.csv").assertDoesNotExist()

        compose.onNodeWithTag("entry-section-details").performClick()
        compose.onNodeWithTag("attachment-attachment-a").assertDoesNotExist()
        compose.onNodeWithText("Neuroimmune aging").assertExists()

        listOf("Edit", "Add files", "Open", "Download").forEach { action ->
            compose.onNodeWithText(action).assertDoesNotExist()
        }
    }

    @Test
    fun entryDetailRejectsAnEntryFromAnotherAccount() {
        val attachments = InMemoryAttachmentRepository()
        compose.setContent {
            MaterialTheme {
                EntryDetailScreen(
                    accountId = accountA,
                    entry = entry(accountB, "private-b", "Account B private entry", "2026-05-23"),
                    attachmentRepository = attachments,
                    onBack = {},
                )
            }
        }

        compose.onNodeWithText("Entry unavailable").assertExists()
        compose.onNodeWithText("Account B private entry").assertDoesNotExist()
    }

    @Test
    fun entryWorkbookEditPreservesSiblingBlocksAndUsesTheMutationContract() {
        val sourceEntry = entry(accountA, "editable", "Dose response", "2026-05-24")
        var savedContent: String? = null
        val mutations = object : EntryMutationRepository {
            override suspend fun saveEntry(
                accountId: AccountId,
                entry: JournalEntryEntity,
                contentJson: String,
                editedAt: String,
                deviceId: String,
            ): JournalEntryEntity {
                assertEquals(accountA, accountId)
                assertEquals("pixel-test", deviceId)
                savedContent = contentJson
                return entry.copy(contentJson = contentJson, syncStatus = "queued")
            }
        }
        compose.setContent {
            MaterialTheme {
                EntryDetailScreen(
                    accountId = accountA,
                    entry = sourceEntry,
                    attachmentRepository = InMemoryAttachmentRepository(),
                    entryMutationRepository = mutations,
                    deviceId = "pixel-test",
                    onBack = {},
                )
            }
        }

        compose.onNodeWithTag("entry-section-workbook").performClick()
        compose.onNodeWithTag("edit-workbook").performClick()
        compose.onNodeWithTag("workbook-cell-value-editor").performTextReplacement("25")
        compose.onNodeWithTag("workbook-save").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { savedContent != null }

        val savedBlocks = NoteBlockCodec.decode(checkNotNull(savedContent))
        val workbook = savedBlocks.filterIsInstance<NativeNoteBlock.Workbook>().single()
        assertEquals("25", workbook.data[0][0])
        assertEquals("Vehicle and LPS groups were compared.", savedBlocks.filterIsInstance<NativeNoteBlock.Paragraph>().single().text)
    }

    @Test
    fun entryNoteEditPreservesWorkbookAndUsesTheMutationContract() {
        val sourceEntry = entry(accountA, "editable-note", "Dose response", "2026-05-24")
        var savedContent: String? = null
        var savedAt: String? = null
        val mutations = object : EntryMutationRepository {
            override suspend fun saveEntry(
                accountId: AccountId,
                entry: JournalEntryEntity,
                contentJson: String,
                editedAt: String,
                deviceId: String,
            ): JournalEntryEntity {
                assertEquals(accountA, accountId)
                assertEquals("pixel-test", deviceId)
                savedContent = contentJson
                savedAt = editedAt
                return entry.copy(contentJson = contentJson, syncStatus = "queued")
            }
        }
        compose.setContent {
            MaterialTheme {
                EntryDetailScreen(
                    accountId = accountA,
                    entry = sourceEntry,
                    attachmentRepository = InMemoryAttachmentRepository(),
                    entryMutationRepository = mutations,
                    deviceId = "pixel-test",
                    onBack = {},
                )
            }
        }

        compose.onNodeWithTag("edit-note").performClick()
        compose.onNodeWithTag("note-paragraph-paragraph").performTextReplacement("Native observations saved locally.")
        compose.onNodeWithTag("note-save").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { savedContent != null }

        val savedBlocks = NoteBlockCodec.decode(checkNotNull(savedContent))
        val paragraph = savedBlocks.filterIsInstance<NativeNoteBlock.Paragraph>().single()
        val workbook = savedBlocks.filterIsInstance<NativeNoteBlock.Workbook>().single()
        assertEquals("Native observations saved locally.", paragraph.text)
        assertEquals("pixel-test", paragraph.metadata.updatedBy)
        assertEquals(savedAt, paragraph.metadata.updatedAt)
        assertEquals("Dose response", workbook.title)
        assertEquals("10", workbook.data[1][0])
    }

    @Test
    fun supportedDriveBlocksParseWithoutExposingRawJson() {
        val blocks = parseReadOnlyBlocks(entryContent)

        assertEquals(5, blocks.size)
        assertEquals(ReadOnlyBlock.TextBlock("heading", "Aim", "heading"), blocks[0])
        assertEquals(ReadOnlyBlock.TextBlock("paragraph", "Vehicle and LPS groups were compared.", "paragraph"), blocks[1])
        assertEquals(
            ReadOnlyBlock.ItemBlock(true, listOf(ReadOnlyItem("Confirm viability", true)), "checklist"),
            blocks[2],
        )
        assertEquals(
            ReadOnlyBlock.GridBlock(
                false,
                listOf(listOf("Sample", "Group"), listOf("MG-01", "Vehicle")),
                id = "table",
            ),
            blocks[3],
        )
        assertEquals(
            ReadOnlyBlock.GridBlock(
                workbook = true,
                rows = listOf(listOf("Dose (ng/mL)", "Viability"), listOf("10", "94%")),
                title = "Dose response",
                styles = mapOf(
                    "0:0" to WorkbookCellStyle(bold = true),
                    "1:1" to WorkbookCellStyle(align = WorkbookAlignment.Right),
                ),
                id = "workbook",
            ),
            blocks[4],
        )
    }

    @Test
    fun oversizedDriveGridsAreBoundedBeforeRendering() {
        val workbook = parseReadOnlyBlocks(gridJson("workbook", rows = 81, columns = 17)).single()
            as ReadOnlyBlock.GridBlock
        val table = parseReadOnlyBlocks(gridJson("table", rows = 31, columns = 13)).single()
            as ReadOnlyBlock.GridBlock

        assertEquals(80, workbook.rows.size)
        assertEquals(16, workbook.rows.first().size)
        assertEquals("79:15", workbook.rows.last().last())
        assertEquals(true, workbook.inputWasTruncated)

        assertEquals(30, table.rows.size)
        assertEquals(12, table.rows.first().size)
        assertEquals("29:11", table.rows.last().last())
        assertEquals(true, table.inputWasTruncated)
    }

    @Test
    fun boundedWorkbookWarnsWhenDriveInputWasTruncated() {
        val oversized = parseReadOnlyBlocks(gridJson("workbook", rows = 81, columns = 17)).single()
            as ReadOnlyBlock.GridBlock
        compose.setContent {
            MaterialTheme {
                ReadOnlyWorkbookWorkspace(
                    block = oversized,
                    stateKey = "truncated-workbook",
                )
            }
        }

        compose.onNodeWithText("Only the first 80 rows and 16 columns can be shown.").assertExists()
    }

    @Test
    fun editableWorkbookCommitsCellInputAndReturnsACompactSnapshot() {
        var saved: WorkbookDriveSnapshot? = null
        compose.setContent {
            MaterialTheme {
                EditableWorkbookWorkspace(
                    initialState = WorkbookState.create(title = "Dose response"),
                    stateKey = "editable-workbook",
                    onSave = { saved = it },
                    onCancel = {},
                )
            }
        }

        compose.onNodeWithTag("workbook-cell-value-editor").performTextReplacement("25")
        compose.onNodeWithTag("workbook-cell-value-editor").performImeAction()
        compose.onNodeWithTag("workbook-selected-address").assertTextEquals("A2")
        compose.onNodeWithTag("workbook-save").performClick()

        compose.runOnIdle {
            assertEquals(listOf(listOf("25")), saved?.data)
            assertEquals("Dose response", saved?.title)
        }
    }

    @Test
    fun oversizedRawContentFailsBeforeBuildingAJsonTree() {
        val blocks = parseReadOnlyBlocks("[" + " ".repeat(READ_ONLY_CONTENT_MAX_CHARS) + "]")

        assertEquals(
            listOf(ReadOnlyBlock.Unsupported("note content is too large to preview", "note-content")),
            blocks,
        )
    }

    @Test
    fun malformedBlockDoesNotHideValidSiblingBlocks() {
        val blocks = parseReadOnlyBlocks(
            """[
                {"id":"first","type":"paragraph","text":"First valid block"},
                {"id":"broken","type":"table","data":[[{}]]},
                {"id":"last","type":"quote","text":"Last valid block"}
            ]""",
        )

        assertEquals(ReadOnlyBlock.TextBlock("paragraph", "First valid block", "first"), blocks[0])
        assertEquals(ReadOnlyBlock.Unsupported("content block 2", "block-1"), blocks[1])
        assertEquals(ReadOnlyBlock.TextBlock("quote", "Last valid block", "last"), blocks[2])
    }

    @Test
    fun staleDriveGrantForAnotherAccountRequiresReconnect() {
        val journal = InMemoryJournalRepository()
        val attachments = InMemoryAttachmentRepository()
        setApp(
            journal = journal,
            attachments = attachments,
            authRepository = SignedInAuthRepository(accountA, grantedAccountId = accountB),
        )

        compose.onNodeWithContentDescription("Account").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("Drive sign-in required").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Drive sign-in required").assertExists()
        compose.onNodeWithText("Google Drive ready").assertDoesNotExist()
    }

    private fun setApp(
        journal: InMemoryJournalRepository,
        attachments: InMemoryAttachmentRepository,
        fileHub: InMemoryFileHubRepository = InMemoryFileHubRepository(),
        authRepository: AuthRepository = SignedInAuthRepository(accountA),
        entryMutationRepository: EntryMutationRepository? = null,
        deviceId: String? = null,
        captureRepository: CaptureRepository? = null,
        pendingShare: IncomingShareRequest? = null,
        onShareConsumed: (String) -> Unit = {},
        legacyImportRepository: LegacyWorkspaceImportRepository? = null,
    ) {
        compose.setContent {
            LabNotebookApp(
                authRepository = authRepository,
                journalRepository = journal,
                entryMutationRepository = entryMutationRepository,
                deviceId = deviceId,
                attachmentRepository = attachments,
                fileHubRepository = fileHub,
                captureRepository = captureRepository,
                pendingShare = pendingShare,
                onShareConsumed = onShareConsumed,
                legacyImportRepository = legacyImportRepository,
                syncCoordinator = PlaceholderSyncCoordinator,
            )
        }
    }

    private fun entry(accountId: AccountId, id: String, title: String, date: String) = JournalEntryEntity(
        accountId = accountId.value,
        id = id,
        title = title,
        dateBucket = date,
        createdAt = "${date}T09:00:00Z",
        updatedAt = "${date}T10:00:00Z",
        authorId = accountId.value,
        contentJson = entryContent,
        projectTagsJson = "[\"Neuroimmune aging\"]",
        updatedByDeviceId = "test-device",
        syncStatus = "synced",
    )

    private class SignedInAuthRepository(
        accountId: AccountId,
        grantedAccountId: AccountId = accountId,
    ) : AuthRepository {
        private val signedInSession = AuthSession(accountId, "researcher@example.test", "Researcher")
        override val session: StateFlow<AuthSession?> = MutableStateFlow(signedInSession)
        override val driveAccess: StateFlow<DriveAccessState> = MutableStateFlow(
            DriveAccessState.Granted(
                accountId = grantedAccountId,
                grantedScopes = setOf("https://www.googleapis.com/auth/drive.file"),
            ),
        )
        override suspend fun restore() = Unit
        override suspend fun connect() = Result.success(signedInSession)
        override suspend fun disconnect() = Unit
        override suspend fun invalidateAccessToken(accountId: AccountId) = Unit
        override fun accessToken(accountId: AccountId): String? = null
    }

    private companion object {
        fun gridJson(type: String, rows: Int, columns: Int): String {
            val data = List(rows) { row ->
                List(columns) { column -> "\"$row:$column\"" }
                    .joinToString(prefix = "[", postfix = "]")
            }.joinToString(prefix = "[", postfix = "]")
            return """[{"id":"grid","type":"$type","data":$data}]"""
        }

        val entryContent = """
            [
              {"id":"heading","type":"heading","text":"Aim"},
              {"id":"paragraph","type":"paragraph","text":"Vehicle and LPS groups were compared."},
              {"id":"checklist","type":"checklist","items":[{"id":"check-1","text":"Confirm viability","done":true}]},
              {"id":"table","type":"table","data":[["Sample","Group"],["MG-01","Vehicle"]]},
              {"id":"workbook","type":"workbook","title":"Dose response","data":[["Dose (ng/mL)","Viability"],["10","94%"]],"styles":{"0:0":{"bold":true},"1:1":{"align":"right"}}}
            ]
        """.trimIndent()
    }
}
