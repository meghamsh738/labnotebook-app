package com.easylab.labnotebook.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.ProtocolEntity
import com.easylab.labnotebook.data.repository.ProtocolRepository
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlinx.coroutines.launch

@Composable
internal fun ProtocolsScreen(
    accountId: AccountId,
    repository: ProtocolRepository,
    now: () -> String = ::protocolNowIso,
    idFactory: () -> String = { "protocol-${UUID.randomUUID()}" },
) {
    val protocols by repository.observeProtocols(accountId).collectAsStateWithLifecycle(initialValue = emptyList())
    var selectedProtocolId by remember(accountId) { mutableStateOf<String?>(null) }
    var createOpen by remember(accountId) { mutableStateOf(false) }
    val selected = protocols.firstOrNull { it.id == selectedProtocolId }
    val scope = rememberCoroutineScope()

    fun createProtocol(title: String, template: ProtocolTemplate) {
        val timestamp = now()
        val protocol = ProtocolEntity(
            accountId = accountId.value,
            id = idFactory(),
            title = title.trim().ifBlank { "Untitled protocol" },
            createdAt = timestamp,
            updatedAt = timestamp,
            contentJson = ProtocolContentCodec.encode(ProtocolContentCodec.template(template), timestamp),
        )
        scope.launch {
            runCatching { repository.createProtocol(accountId, protocol) }
                .onSuccess {
                    selectedProtocolId = it.id
                    createOpen = false
                }
        }
    }


    BoxWithConstraints(Modifier.fillMaxSize()) {
        val expanded = maxWidth >= 720.dp
        LaunchedEffect(expanded, protocols, selectedProtocolId) {
            if (selectedProtocolId != null && selected == null) selectedProtocolId = null
            if (expanded && selectedProtocolId == null && protocols.isNotEmpty()) {
                selectedProtocolId = protocols.first().id
            }
        }

        if (expanded) {
            Row(Modifier.fillMaxSize()) {
                ProtocolListPane(
                    protocols = protocols,
                    selectedProtocolId = selectedProtocolId,
                    onSelect = {
                        selectedProtocolId = it
                        createOpen = false
                    },
                    onCreate = { createOpen = true },
                    modifier = Modifier.width(340.dp).fillMaxHeight(),
                )
                VerticalDivider()
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    if (createOpen) {
                        NewProtocolForm(
                            onDismiss = { createOpen = false },
                            onCreate = ::createProtocol,
                        )
                    } else if (selected == null) {
                        ProtocolSelectionEmptyState(onCreate = { createOpen = true })
                    } else {
                        ProtocolDetailPane(
                            protocol = selected,
                            repository = repository,
                            accountId = accountId,
                            now = now,
                            showBack = false,
                            onBack = {},
                        )
                    }
                }
            }
        } else if (createOpen) {
            NewProtocolForm(
                onDismiss = { createOpen = false },
                onCreate = ::createProtocol,
            )
        } else if (selected == null) {
            ProtocolListPane(
                protocols = protocols,
                selectedProtocolId = null,
                onSelect = { selectedProtocolId = it },
                onCreate = { createOpen = true },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            ProtocolDetailPane(
                protocol = selected,
                repository = repository,
                accountId = accountId,
                now = now,
                showBack = true,
                onBack = { selectedProtocolId = null },
            )
        }
    }

}

@Composable
private fun ProtocolListPane(
    protocols: List<ProtocolEntity>,
    selectedProtocolId: String?,
    onSelect: (String) -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier,
) {
    LazyColumn(
        modifier = modifier.testTag("protocol-list"),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Protocols",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        "Reusable methods saved on this device.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = onCreate, modifier = Modifier.testTag("protocol-new")) {
                    Icon(Icons.Outlined.Add, contentDescription = "New protocol")
                }
            }
        }
        if (protocols.isEmpty()) {
            item { ProtocolLibraryEmptyState(onCreate) }
        } else {
            items(protocols, key = { it.id }) { protocol ->
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelect(protocol.id) }
                        .semantics { selected = protocol.id == selectedProtocolId }
                        .testTag("protocol-item-${protocol.id}"),
                    shape = RoundedCornerShape(14.dp),
                    color = if (protocol.id == selectedProtocolId) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.surface
                    },
                    tonalElevation = if (protocol.id == selectedProtocolId) 2.dp else 0.dp,
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(
                            protocol.title,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            "Updated ${protocolDateLabel(protocol.updatedAt)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ProtocolLibraryEmptyState(onCreate: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().testTag("protocol-empty"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Build a protocol library", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(
                "Start from a blank document or use guided Aim, Materials, Procedure, and Notes sections.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(onClick = onCreate) { Text("Create protocol") }
        }
    }
}

@Composable
private fun ProtocolSelectionEmptyState(onCreate: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Select a protocol", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text("Choose a method from the library or create a new one.")
            OutlinedButton(onClick = onCreate) { Text("Create protocol") }
        }
    }
}


@Composable
private fun ProtocolDetailPane(
    protocol: ProtocolEntity,
    repository: ProtocolRepository,
    accountId: AccountId,
    now: () -> String,
    showBack: Boolean,
    onBack: () -> Unit,
) {
    var editing by remember(protocol.id) { mutableStateOf(false) }
    var draft by remember(protocol.id) { mutableStateOf(ProtocolEditorDraft.from(protocol)) }
    var baseUpdatedAt by remember(protocol.id) { mutableStateOf(protocol.updatedAt) }
    var saveError by remember(protocol.id) { mutableStateOf<String?>(null) }
    var confirmDelete by remember(protocol.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val safelyEditable = ProtocolContentCodec.isSafelyEditable(protocol.contentJson)

    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("protocol-detail-${protocol.id}"),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                if (showBack) {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("protocol-back")) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to protocols")
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        if (editing) "Edit protocol" else "Protocol",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        "Updated ${protocolDateLabel(protocol.updatedAt)} · On this device",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (!editing && safelyEditable) {
                    IconButton(
                        onClick = {
                            draft = ProtocolEditorDraft.from(protocol)
                            baseUpdatedAt = protocol.updatedAt
                            saveError = null
                            editing = true
                        },
                        modifier = Modifier.testTag("protocol-edit"),
                    ) { Icon(Icons.Outlined.Edit, contentDescription = "Edit protocol") }
                }
                if (!editing) {
                    IconButton(
                        onClick = { confirmDelete = true },
                        modifier = Modifier.testTag("protocol-delete"),
                    ) { Icon(Icons.Outlined.Delete, contentDescription = "Delete protocol") }
                }
            }
        }
        if (editing) {
            item {
                OutlinedTextField(
                    value = draft.title,
                    onValueChange = { if (it.length <= 240) draft = draft.copy(title = it) },
                    label = { Text("Protocol title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("protocol-title-editor"),
                    isError = draft.title.isBlank(),
                    supportingText = if (draft.title.isBlank()) ({ Text("Enter a title before saving.") }) else null,
                )
            }
            items(draft.sections, key = { it.id }) { section ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Section", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                            IconButton(
                                onClick = { draft = draft.copy(sections = draft.sections.filterNot { it.id == section.id }) },
                            ) { Icon(Icons.Outlined.Delete, contentDescription = "Remove ${section.title} section") }
                        }
                        OutlinedTextField(
                            value = section.title,
                            onValueChange = { value ->
                                draft = draft.copy(sections = draft.sections.map {
                                    if (it.id == section.id) it.copy(title = value) else it
                                })
                            },
                            label = { Text("Section heading") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth().testTag("protocol-section-title-${section.id}"),
                        )
                        OutlinedTextField(
                            value = section.body,
                            onValueChange = { value ->
                                draft = draft.copy(sections = draft.sections.map {
                                    if (it.id == section.id) it.copy(body = value) else it
                                })
                            },
                            label = { Text(section.guide ?: "Section content") },
                            minLines = 4,
                            modifier = Modifier.fillMaxWidth().testTag("protocol-section-body-${section.id}"),
                        )
                    }
                }
            }
            item {
                OutlinedButton(
                    onClick = { draft = draft.copy(sections = draft.sections + ProtocolContentCodec.newSection()) },
                    modifier = Modifier.fillMaxWidth().testTag("protocol-add-section"),
                ) {
                    Icon(Icons.Outlined.Add, contentDescription = null)
                    Text("Add section")
                }
            }
            saveError?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                    TextButton(
                        onClick = {
                            draft = ProtocolEditorDraft.from(protocol)
                            saveError = null
                            editing = false
                        },
                        modifier = Modifier.testTag("protocol-cancel"),
                    ) { Text("Cancel") }
                    Button(
                        onClick = {
                            val timestamp = now()
                            scope.launch {
                                runCatching {
                                    repository.updateProtocol(
                                        accountId = accountId,
                                        protocol = protocol.copy(
                                            title = draft.title,
                                            updatedAt = timestamp,
                                            contentJson = ProtocolContentCodec.encode(draft.sections, timestamp),
                                        ),
                                        expectedUpdatedAt = baseUpdatedAt,
                                    )
                                }.onSuccess {
                                    saveError = null
                                    editing = false
                                }.onFailure { saveError = it.message ?: "Unable to save this protocol." }
                            }
                        },
                        enabled = draft.title.isNotBlank(),
                        modifier = Modifier.testTag("protocol-save"),
                    ) { Text("Save") }
                }
            }
        } else {
            item {
                Text(
                    protocol.title,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.semantics { heading() }.testTag("protocol-read-title"),
                )
            }
            val sections = ProtocolContentCodec.decode(protocol.contentJson)
            if (sections.isEmpty()) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Blank protocol", fontWeight = FontWeight.SemiBold)
                            Text("Add sections when you are ready to document this method.")
                        }
                    }
                }
            } else {
                items(sections, key = { it.id }) { section ->
                    Column(
                        modifier = Modifier.fillMaxWidth().testTag("protocol-read-section-${section.id}"),
                        verticalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Text(
                            section.title,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.semantics { heading() },
                        )
                        if (section.body.isBlank()) {
                            Text(
                                section.guide ?: "No content added yet.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            Text(section.body, style = MaterialTheme.typography.bodyLarge)
                        }
                        HorizontalDivider(Modifier.padding(top = 4.dp))
                    }
                }
            }
            if (!safelyEditable) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Text(
                            "This protocol contains richer blocks that the native editor cannot safely rewrite. It remains read-only so no content is lost.",
                            modifier = Modifier.padding(16.dp).testTag("protocol-rich-content-read-only"),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete protocol?") },
            text = { Text("This permanently deletes \"${protocol.title}\" from this device.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch {
                            runCatching { check(repository.deleteProtocol(accountId, protocol.id)) }
                                .onSuccess { confirmDelete = false }
                                .onFailure {
                                    confirmDelete = false
                                    saveError = it.message ?: "Unable to delete this protocol."
                                }
                        }
                    },
                    modifier = Modifier.testTag("protocol-delete-confirm"),
                ) { Text("Delete") }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmDelete = false },
                    modifier = Modifier.testTag("protocol-delete-cancel"),
                ) { Text("Cancel") }
            },
        )
    }
}

private fun protocolNowIso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).run {
    timeZone = TimeZone.getTimeZone("UTC")
    format(Date())
}

private fun protocolDateLabel(timestamp: String): String = when {
    timestamp.length >= 10 -> timestamp.substring(0, 10)
    else -> timestamp
}
