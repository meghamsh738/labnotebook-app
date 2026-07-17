package com.easylab.labnotebook.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.CheckBoxOutlineBlank
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.GridOn
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.repository.AttachmentRepository
import com.easylab.labnotebook.data.repository.EntryMutationRepository
import com.easylab.labnotebook.data.repository.JournalRepository
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val contentJson = Json { ignoreUnknownKeys = true }
internal const val READ_ONLY_CONTENT_MAX_CHARS = 4 * 1024 * 1024
private const val READ_ONLY_TABLE_MAX_ROWS = 30
private const val READ_ONLY_TABLE_MAX_COLUMNS = 12

internal sealed interface ReadOnlyBlock {
    val id: String

    data class TextBlock(val type: String, val text: String, override val id: String = "") : ReadOnlyBlock
    data class ItemBlock(
        val checklist: Boolean,
        val items: List<ReadOnlyItem>,
        override val id: String = "",
    ) : ReadOnlyBlock
    data class GridBlock(
        val workbook: Boolean,
        val rows: List<List<String>>,
        val title: String? = null,
        val styles: Map<String, WorkbookCellStyle> = emptyMap(),
        val inputWasTruncated: Boolean = false,
        override val id: String = "",
    ) : ReadOnlyBlock
    data class AttachmentReference(
        val type: String,
        val attachmentId: String,
        override val id: String = "",
    ) : ReadOnlyBlock
    data class Divider(override val id: String = "") : ReadOnlyBlock
    data class Unsupported(val label: String, override val id: String = "") : ReadOnlyBlock
}

internal data class ReadOnlyItem(val text: String, val done: Boolean?)

private enum class EntrySection(val label: String) {
    Note("Note"),
    Workbook("Workbook"),
    Files("Files"),
    Details("Details"),
}

internal fun todayDateBucket(now: Date = Date()): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US).format(now)

internal fun nativeEditTimestamp(now: Date = Date()): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(now)

internal fun displayDate(dateBucket: String): String = runCatching {
    val parser = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { isLenient = false }
    val date = requireNotNull(parser.parse(dateBucket))
    SimpleDateFormat("d MMM yyyy", Locale.getDefault()).format(date)
}.getOrDefault(dateBucket)

internal fun parseReadOnlyBlocks(value: String): List<ReadOnlyBlock> {
    if (value.length > READ_ONLY_CONTENT_MAX_CHARS) {
        return listOf(ReadOnlyBlock.Unsupported("note content is too large to preview", "note-content"))
    }
    val blocks = runCatching { contentJson.parseToJsonElement(value).jsonArray }
        .getOrElse { return listOf(ReadOnlyBlock.Unsupported("note content", "note-content")) }
    return blocks.mapIndexed { index, element ->
        runCatching { parseReadOnlyBlock(element, index) }
            .getOrElse { ReadOnlyBlock.Unsupported("content block " + (index + 1), "block-$index") }
    }
}

private fun parseReadOnlyBlock(element: kotlinx.serialization.json.JsonElement, index: Int): ReadOnlyBlock {
    val block = element.jsonObject
    val id = block.string("id").ifBlank { "block-$index" }
    return when (val type = block.string("type")) {
        "heading", "paragraph", "quote" -> ReadOnlyBlock.TextBlock(type, block.string("text"), id)
        "list", "checklist" -> ReadOnlyBlock.ItemBlock(
            checklist = type == "checklist",
            items = block.array("items").mapNotNull { itemElement ->
                val item = itemElement as? JsonObject ?: return@mapNotNull null
                val text = item.string("text")
                if (text.isBlank()) null else ReadOnlyItem(text, item["done"]?.jsonPrimitive?.booleanOrNull)
            },
            id = id,
        )
        "table", "workbook" -> parseReadOnlyGrid(block, workbook = type == "workbook", id = id)
        "image", "file" -> ReadOnlyBlock.AttachmentReference(type, block.string("attachmentId"), id)
        "divider" -> ReadOnlyBlock.Divider(id)
        else -> ReadOnlyBlock.Unsupported(type.ifBlank { "content" }, id)
    }
}

private fun JsonObject.string(key: String): String =
    (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()

private fun JsonObject.array(key: String): JsonArray = get(key) as? JsonArray ?: JsonArray(emptyList())

private fun parseReadOnlyGrid(block: JsonObject, workbook: Boolean, id: String): ReadOnlyBlock.GridBlock {
    val sourceRows = block.array("data")
    val rowLimit = if (workbook) WORKBOOK_MAX_ROWS else READ_ONLY_TABLE_MAX_ROWS
    val columnLimit = if (workbook) WORKBOOK_MAX_COLUMNS else READ_ONLY_TABLE_MAX_COLUMNS
    val visibleRows = sourceRows.take(rowLimit)
    val inputWasTruncated = sourceRows.size > rowLimit || visibleRows.any { row ->
        (row as? JsonArray)?.size?.let { it > columnLimit } == true
    }
    return ReadOnlyBlock.GridBlock(
        workbook = workbook,
        rows = visibleRows.mapNotNull { row ->
            (row as? JsonArray)?.take(columnLimit)?.map { cell ->
                cell.jsonPrimitive.contentOrNull.orEmpty()
            }
        },
        title = block.string("title").takeIf { it.isNotBlank() },
        styles = if (workbook) parseWorkbookStyles(block["styles"]) else emptyMap(),
        inputWasTruncated = inputWasTruncated,
        id = id,
    )
}

private fun parseWorkbookStyles(value: kotlinx.serialization.json.JsonElement?): Map<String, WorkbookCellStyle> {
    val styles = value as? JsonObject ?: return emptyMap()
    return styles.mapNotNull { (key, styleElement) ->
        val record = styleElement as? JsonObject ?: return@mapNotNull null
        val style = WorkbookCellStyle(
            bold = record["bold"]?.jsonPrimitive?.booleanOrNull == true,
            italic = record["italic"]?.jsonPrimitive?.booleanOrNull == true,
            underline = record["underline"]?.jsonPrimitive?.booleanOrNull == true,
            align = WorkbookAlignment.fromDriveValue(record.string("align")),
        )
        if (style.hasContent) key to style else null
    }.toMap()
}

@Composable
internal fun TodayScreen(
    accountId: AccountId,
    journalRepository: JournalRepository,
    attachmentRepository: AttachmentRepository,
    entryMutationRepository: EntryMutationRepository? = null,
    deviceId: String? = null,
    startWritingRequest: Int = 0,
    onWritingStarted: () -> Unit = {},
    onBrowseEntries: () -> Unit,
    onCheckForUpdates: () -> Unit,
) {
    val entries by journalRepository.observeEntries(accountId)
        .collectAsStateWithLifecycle(initialValue = emptyList())
    val dateBucket = todayDateBucket()
    val today = entries.firstOrNull { it.dateBucket == dateBucket }
    var creatingEntry by remember(accountId, dateBucket) { mutableStateOf(false) }
    var createError by remember(accountId, dateBucket) { mutableStateOf<String?>(null) }
    var newEntryId by remember(accountId, dateBucket) { mutableStateOf<String?>(null) }
    var handledWriteRequest by remember(accountId, dateBucket) { mutableIntStateOf(0) }
    val coroutineScope = rememberCoroutineScope()

    fun beginWriting() {
        if (today != null) {
            newEntryId = today.id
        } else if (!creatingEntry && entryMutationRepository != null && !deviceId.isNullOrBlank()) {
            val timestamp = nativeEditTimestamp()
            val entryId = UUID.randomUUID().toString()
            val paragraph = NativeNoteBlock.Paragraph(
                metadata = NoteBlockMetadata(
                    id = UUID.randomUUID().toString(),
                    updatedAt = timestamp,
                    updatedBy = deviceId,
                ),
                text = "",
            )
            val entry = JournalEntryEntity(
                accountId = accountId.value,
                id = entryId,
                title = "Today's note",
                dateBucket = dateBucket,
                createdAt = timestamp,
                updatedAt = timestamp,
                authorId = accountId.value,
                contentJson = NoteBlockCodec.encode(listOf(paragraph)),
                version = 1,
                updatedByDeviceId = deviceId,
                syncStatus = "queued",
                isDaily = true,
            )
            creatingEntry = true
            createError = null
            coroutineScope.launch {
                runCatching { entryMutationRepository.createEntry(accountId, entry) }
                    .onSuccess { created -> newEntryId = created.id }
                    .onFailure { error -> createError = error.message ?: "Today's note could not be created." }
                creatingEntry = false
            }
        }
    }

    LaunchedEffect(startWritingRequest) {
        if (startWritingRequest > handledWriteRequest) {
            handledWriteRequest = startWritingRequest
            if (today == null) beginWriting()
        }
    }

    if (today == null) {
        EmptyToday(
            canWrite = entryMutationRepository != null && !deviceId.isNullOrBlank(),
            creating = creatingEntry,
            errorMessage = createError,
            onWriteNote = ::beginWriting,
            onBrowseEntries = onBrowseEntries,
            onCheckForUpdates = onCheckForUpdates,
        )
    } else {
        EntryReader(
            accountId = accountId,
            entry = today,
            attachmentRepository = attachmentRepository,
            entryMutationRepository = entryMutationRepository,
            deviceId = deviceId,
            startEditingNote = newEntryId == today.id || startWritingRequest > 0,
            onInitialEditStarted = {
                newEntryId = null
                if (startWritingRequest > 0) onWritingStarted()
            },
        )
    }
}

@Composable
private fun EmptyToday(
    canWrite: Boolean,
    creating: Boolean,
    errorMessage: String?,
    onWriteNote: () -> Unit,
    onBrowseEntries: () -> Unit,
    onCheckForUpdates: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("today-empty"),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("No entry for today", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "Start a note now, or open an earlier entry from the notebook.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (canWrite) {
            item {
                Button(
                    onClick = onWriteNote,
                    enabled = !creating,
                    modifier = Modifier.sizeIn(minHeight = 48.dp).testTag("write-today-note"),
                ) { Text(if (creating) "Creating…" else "Write note") }
            }
        }
        errorMessage?.let { message ->
            item { Text(message, color = MaterialTheme.colorScheme.error) }
        }
        item { OutlinedButton(onClick = onBrowseEntries) { Text("Browse entries") } }
        item { OutlinedButton(onClick = onCheckForUpdates) { Text("Check for updates") } }
    }
}

@Composable
internal fun EntriesScreen(
    accountId: AccountId,
    journalRepository: JournalRepository,
    onOpenEntry: (String) -> Unit,
) {
    val entries by journalRepository.observeEntries(accountId)
        .collectAsStateWithLifecycle(initialValue = emptyList())

    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("entries-screen"),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
    ) {
        item {
            Column(Modifier.padding(bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Notebook entries", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    if (entries.isEmpty()) "No synced entries are available on this device."
                    else "${entries.size} ${if (entries.size == 1) "entry" else "entries"}",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        items(entries, key = { it.id }) { entry ->
            EntryListRow(entry = entry, onClick = { onOpenEntry(entry.id) })
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@Composable
private fun EntryListRow(entry: JournalEntryEntity, onClick: () -> Unit) {
    Surface(onClick = onClick, color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    entry.title.ifBlank { displayDate(entry.dateBucket) },
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("entry-title-${entry.id}"),
                )
                Text(
                    displayDate(entry.dateBucket),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text("›", style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
internal fun EntryDetailScreen(
    accountId: AccountId,
    entry: JournalEntryEntity?,
    attachmentRepository: AttachmentRepository,
    entryMutationRepository: EntryMutationRepository? = null,
    deviceId: String? = null,
    onBack: () -> Unit,
) {
    val scopedEntry = entry?.takeIf { it.accountId == accountId.value }
    if (scopedEntry == null) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().testTag("entry-not-found"),
            contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item { Text("Entry unavailable", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold) }
            item { Text("This entry is no longer available in the local notebook.") }
            item { OutlinedButton(onClick = onBack) { Text("Back to entries") } }
        }
        return
    }

    EntryReader(
        accountId = accountId,
        entry = scopedEntry,
        attachmentRepository = attachmentRepository,
        entryMutationRepository = entryMutationRepository,
        deviceId = deviceId,
        onBack = onBack,
    )
}

@Composable
private fun EntryReader(
    accountId: AccountId,
    entry: JournalEntryEntity,
    attachmentRepository: AttachmentRepository,
    entryMutationRepository: EntryMutationRepository? = null,
    deviceId: String? = null,
    onBack: (() -> Unit)? = null,
    startEditingNote: Boolean = false,
    onInitialEditStarted: () -> Unit = {},
) {
    val attachments by attachmentRepository.observeForEntry(accountId, entry.id)
        .collectAsStateWithLifecycle(initialValue = emptyList())
    val blocks = parseReadOnlyBlocks(entry.contentJson)
    val entryStateKey = accountId.value + ":" + entry.id
    var section by rememberSaveable(entryStateKey) { mutableStateOf(EntrySection.Note) }
    val noteBlocks = blocks.filterNot { it is ReadOnlyBlock.GridBlock && it.workbook }
    val workbookBlock = blocks.filterIsInstance<ReadOnlyBlock.GridBlock>().firstOrNull { it.workbook }
    val nativeBlocks = remember(entry.contentJson) { runCatching { NoteBlockCodec.decode(entry.contentJson) }.getOrNull() }
    val nativeWorkbook = nativeBlocks?.filterIsInstance<NativeNoteBlock.Workbook>()?.firstOrNull()
    val canEditNote = nativeBlocks != null && entryMutationRepository != null && !deviceId.isNullOrBlank()
    val canEditWorkbook = nativeWorkbook != null && entryMutationRepository != null && !deviceId.isNullOrBlank()
    var editingNote by rememberSaveable(entryStateKey) { mutableStateOf(false) }
    var editingWorkbook by rememberSaveable(entryStateKey) { mutableStateOf(false) }
    var savingEntry by remember(entryStateKey) { mutableStateOf(false) }
    var entrySaveError by remember(entryStateKey) { mutableStateOf<String?>(null) }
    val coroutineScope = rememberCoroutineScope()
    val sectionListState = key(entryStateKey) { rememberLazyListState() }

    LaunchedEffect(entryStateKey, startEditingNote, canEditNote) {
        if (startEditingNote && canEditNote) {
            section = EntrySection.Note
            editingNote = true
            onInitialEditStarted()
        }
    }

    LaunchedEffect(section, entryStateKey) {
        sectionListState.scrollToItem(0)
    }

    Column(
        modifier = Modifier.fillMaxSize().testTag("entry-reader-${entry.id}"),
    ) {
        if (!editingNote && !editingWorkbook) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                onBack?.let { TextButton(onClick = it, contentPadding = PaddingValues(0.dp)) { Text("‹ All entries") } }
                Text(displayDate(entry.dateBucket), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        entry.title.ifBlank { "Untitled entry" },
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f).testTag("entry-heading"),
                    )
                    val canStartEditing =
                        (section == EntrySection.Note && canEditNote) ||
                            (section == EntrySection.Workbook && canEditWorkbook)
                    if (canStartEditing) {
                        Button(
                            onClick = {
                                entrySaveError = null
                                if (section == EntrySection.Note) editingNote = true else editingWorkbook = true
                            },
                            modifier = Modifier.testTag(if (section == EntrySection.Note) "edit-note" else "edit-workbook"),
                        ) { Text("Edit") }
                    }
                }
                Text(
                    entry.productStatus(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (!editingNote && !editingWorkbook) {
            PrimaryTabRow(
                selectedTabIndex = section.ordinal,
                modifier = Modifier.fillMaxWidth().testTag("entry-sections"),
                divider = { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) },
            ) {
                EntrySection.entries.forEach { item ->
                    Tab(
                        selected = section == item,
                        onClick = { section = item },
                        modifier = Modifier.testTag("entry-section-${item.name.lowercase()}"),
                        text = { Text(item.label, maxLines = 1) },
                    )
                }
            }
        }

        if (section == EntrySection.Note && editingNote && nativeBlocks != null) {
            NativeNoteEditorWorkspace(
                initialBlocks = nativeBlocks,
                stateKey = "$entryStateKey:note:${entry.version}",
                onCancel = { editingNote = false; entrySaveError = null },
                onSave = { editorState ->
                    if (!savingEntry) {
                        val editedAt = nativeEditTimestamp()
                        val encoded = NoteBlockCodec.encode(
                            editorState.snapshot(editedAt = editedAt, deviceId = checkNotNull(deviceId)),
                        )
                        savingEntry = true
                        entrySaveError = null
                        coroutineScope.launch {
                            runCatching {
                                checkNotNull(entryMutationRepository).saveEntry(
                                    accountId = accountId,
                                    entry = entry,
                                    contentJson = encoded,
                                    editedAt = editedAt,
                                    deviceId = checkNotNull(deviceId),
                                )
                            }.onSuccess {
                                editingNote = false
                            }.onFailure { error ->
                                entrySaveError = error.message ?: "Note could not be saved."
                            }
                            savingEntry = false
                        }
                    }
                },
                saving = savingEntry,
                errorMessage = entrySaveError,
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        } else if (section == EntrySection.Workbook && editingWorkbook && nativeWorkbook != null) {
            val editorState = WorkbookState.create(
                data = nativeWorkbook.data,
                title = nativeWorkbook.title,
                styles = nativeWorkbook.styles.orEmpty().mapValues { (_, style) ->
                    WorkbookCellStyle(
                        bold = style.bold == true,
                        italic = style.italic == true,
                        underline = style.underline == true,
                        align = style.align,
                    )
                },
            )
            EditableWorkbookWorkspace(
                initialState = editorState,
                stateKey = "$entryStateKey:${nativeWorkbook.metadata.id}:${entry.version}",
                onCancel = { editingWorkbook = false; entrySaveError = null },
                onSave = { snapshot ->
                    if (!savingEntry) {
                        val editedAt = nativeEditTimestamp()
                        val replacement = nativeWorkbook.copy(
                            metadata = nativeWorkbook.metadata.copy(
                                updatedAt = editedAt,
                                updatedBy = checkNotNull(deviceId),
                            ),
                            data = snapshot.data,
                            title = snapshot.title,
                        )
                        val encoded = NoteBlockCodec.encode(
                            checkNotNull(nativeBlocks).map { block ->
                                if (block.metadata.id == nativeWorkbook.metadata.id) replacement else block
                            },
                        )
                        savingEntry = true
                        entrySaveError = null
                        coroutineScope.launch {
                            runCatching {
                                checkNotNull(entryMutationRepository).saveEntry(
                                    accountId = accountId,
                                    entry = entry,
                                    contentJson = encoded,
                                    editedAt = editedAt,
                                    deviceId = checkNotNull(deviceId),
                                )
                            }.onSuccess {
                                editingWorkbook = false
                            }.onFailure { error ->
                                entrySaveError = error.message ?: "Workbook could not be saved."
                            }
                            savingEntry = false
                        }
                    }
                },
                saving = savingEntry,
                errorMessage = entrySaveError,
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        } else if (section == EntrySection.Workbook && workbookBlock != null) {
            ReadOnlyWorkbookWorkspace(
                block = workbookBlock,
                stateKey = entryStateKey + ":" + workbookBlock.id,
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        } else {
            LazyColumn(
                state = sectionListState,
                modifier = Modifier.fillMaxWidth().weight(1f).testTag("entry-section-content"),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                when (section) {
                EntrySection.Note -> {
                    if (noteBlocks.isEmpty()) {
                        item { EmptyEntrySection("No note content", "This entry does not contain readable note blocks.", "entry-empty-note") }
                    } else {
                        items(noteBlocks) { block ->
                            ReadOnlyBlockView(
                                block = block,
                                attachments = attachments,
                                stateKey = entryStateKey + ":" + block.id,
                            )
                        }
                    }
                }
                EntrySection.Workbook -> {
                    item { EmptyEntrySection("No workbook", "No workbook data is stored with this entry.", "entry-empty-workbook") }
                }
                EntrySection.Files -> {
                    if (attachments.isEmpty()) {
                        item { EmptyEntrySection("No evidence attached", "No synced file metadata is stored with this entry.", "entry-empty-files") }
                    } else {
                        item {
                            Text(
                                "Evidence · ${attachments.size}",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        items(attachments, key = { it.id }) { attachment ->
                            AttachmentMetadataRow(attachment)
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        }
                    }
                }
                EntrySection.Details -> item { EntryDetails(entry) }
            }
            }
        }
    }
}

@Composable
private fun EmptyEntrySection(title: String, body: String, testTag: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.testTag(testTag)) {
        Text(title, fontWeight = FontWeight.SemiBold)
        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EntryDetails(entry: JournalEntryEntity) {
    val projectLabels = parseStringList(entry.projectTagsJson)
        .ifEmpty { if (entry.projectId.isNullOrBlank()) emptyList() else listOf("Assigned") }
    val experimentLabels = parseStringList(entry.experimentTagsJson)
        .ifEmpty { if (entry.experimentId.isNullOrBlank()) emptyList() else listOf("Assigned") }
    val rows = listOf(
        "Project" to projectLabels,
        "Experiment" to experimentLabels,
        "Tags" to parseStringList(entry.tagsJson),
    )
    Column(modifier = Modifier.testTag("entry-details")) {
        rows.forEach { (label, values) ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(label, modifier = Modifier.width(96.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(values.joinToString().ifBlank { "Not assigned" }, modifier = Modifier.weight(1f))
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Updated", modifier = Modifier.width(96.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(displayDate(entry.updatedAt.take(10)), modifier = Modifier.weight(1f))
        }
    }
}

private fun parseStringList(value: String): List<String> = runCatching {
    contentJson.parseToJsonElement(value).jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull }
}.getOrDefault(emptyList())

private fun JournalEntryEntity.productStatus(): String = when (syncStatus.lowercase(Locale.US)) {
    "synced", "remote", "available" -> "Saved to Drive"
    "failed", "conflict" -> "Sync problem"
    "queued", "syncing", "pending" -> "Waiting to sync"
    else -> "Stored on this device"
}

@Composable
private fun ReadOnlyBlockView(
    block: ReadOnlyBlock,
    attachments: List<AttachmentEntity>,
    stateKey: String,
) {
    when (block) {
        is ReadOnlyBlock.TextBlock -> when (block.type) {
            "heading" -> Text(block.text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            "quote" -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("“", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
                Text(block.text, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> Text(block.text, style = MaterialTheme.typography.bodyLarge)
        }
        is ReadOnlyBlock.ItemBlock -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            block.items.forEachIndexed { index, item ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                    if (block.checklist) {
                        Icon(
                            if (item.done == true) Icons.Outlined.CheckBox else Icons.Outlined.CheckBoxOutlineBlank,
                            contentDescription = if (item.done == true) "Complete" else "Not complete",
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    } else {
                        Text("${index + 1}.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(item.text, modifier = Modifier.weight(1f))
                }
            }
        }
        is ReadOnlyBlock.GridBlock -> ReadOnlyGrid(block, stateKey)
        is ReadOnlyBlock.AttachmentReference -> {
            val attachment = attachments.firstOrNull { it.id == block.attachmentId }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.AttachFile, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Text(
                    attachment?.let { "Evidence: ${it.filename}" } ?: "Evidence reference unavailable",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        is ReadOnlyBlock.Divider -> HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        is ReadOnlyBlock.Unsupported -> Text(
            "Unsupported ${block.label}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ReadOnlyGrid(block: ReadOnlyBlock.GridBlock, stateKey: String) {
    val horizontalScroll = remember(stateKey) { androidx.compose.foundation.ScrollState(0) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.GridOn, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(if (block.workbook) "Workbook preview" else "Table", fontWeight = FontWeight.SemiBold)
        }
        if (block.rows.isEmpty()) {
            Text("No cells", color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@Column
        }
        Column(
            modifier = Modifier.fillMaxWidth().clipToBounds().horizontalScroll(horizontalScroll),
        ) {
            block.rows.forEachIndexed { rowIndex, row ->
                Row {
                    row.forEach { cell ->
                        Surface(
                            color = if (rowIndex == 0) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface,
                            modifier = Modifier.width(140.dp),
                        ) {
                            Text(
                                cell.ifBlank { " " },
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                fontWeight = if (rowIndex == 0) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
        if (block.inputWasTruncated) {
            Text(
                "Only the first 30 rows and 12 columns are shown in this preview.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AttachmentMetadataRow(attachment: AttachmentEntity) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("attachment-${attachment.id}"),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.AttachFile, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                attachment.filename,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(
                    attachment.mimeType?.substringAfterLast('/')?.uppercase(Locale.US),
                    attachment.displaySize.takeIf { it.isNotBlank() },
                    attachment.availabilityLabel(),
                ).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun AttachmentEntity.availabilityLabel(): String =
    if (!cachedPath.isNullOrBlank() || !localUri.isNullOrBlank()) "Available on this device" else "Drive only"
