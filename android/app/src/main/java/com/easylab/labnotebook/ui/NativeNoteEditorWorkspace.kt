package com.easylab.labnotebook.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.FormatListBulleted
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.GridOn
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import java.util.UUID

@Composable
internal fun NativeNoteEditorWorkspace(
    initialBlocks: List<NativeNoteBlock>,
    stateKey: String,
    onSave: (NativeNoteEditorState) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    saving: Boolean = false,
    errorMessage: String? = null,
    idFactory: () -> String = { UUID.randomUUID().toString() },
) {
    var state by remember(stateKey, initialBlocks) { mutableStateOf(NativeNoteEditorState.create(initialBlocks)) }

    Column(modifier = modifier.fillMaxSize().testTag("note-editor")) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Edit note",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("note-cancel"),
            ) { Text("Cancel") }
            Button(
                onClick = { onSave(state) },
                enabled = state.hasChanges && !saving,
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("note-save"),
            ) { Text(if (saving) "Saving…" else "Save") }
        }
        errorMessage?.let { message ->
            Text(
                message,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f).testTag("note-block-list"),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        ) {
            itemsIndexed(state.blocks, key = { _, block -> block.metadata.id }) { index, block ->
                NativeNoteBlockEditor(
                    block = block,
                    index = index,
                    blockCount = state.blocks.size,
                    onTextChange = { value -> state = state.updateText(block.metadata.id, value) },
                    onChecklistTextChange = { itemId, value ->
                        state = state.updateChecklistItem(block.metadata.id, itemId, value)
                    },
                    onChecklistToggle = { itemId -> state = state.toggleChecklistItem(block.metadata.id, itemId) },
                    onListTextChange = { itemId, value -> state = state.updateListItem(block.metadata.id, itemId, value) },
                    onAddItem = { state = state.addItem(block.metadata.id, idFactory()) },
                    onRemoveItem = { itemId -> state = state.removeItem(block.metadata.id, itemId) },
                    onMove = { offset -> state = state.moveBlock(block.metadata.id, offset) },
                    onRemove = { state = state.removeBlock(block.metadata.id) },
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            item(key = "add-block") {
                AddBlockMenu(
                    onAdd = { type -> state = state.insertBlock(type, idFactory()) },
                    modifier = Modifier.padding(vertical = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun NativeNoteBlockEditor(
    block: NativeNoteBlock,
    index: Int,
    blockCount: Int,
    onTextChange: (String) -> Unit,
    onChecklistTextChange: (String, String) -> Unit,
    onChecklistToggle: (String) -> Unit,
    onListTextChange: (String, String) -> Unit,
    onAddItem: () -> Unit,
    onRemoveItem: (String) -> Unit,
    onMove: (Int) -> Unit,
    onRemove: () -> Unit,
) {
    val locked = block.metadata.locked == true
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp).testTag("note-block-${block.metadata.id}"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(modifier = Modifier.weight(1f)) {
            when (block) {
                is NativeNoteBlock.Heading -> EditableTextBlock(
                    value = block.text,
                    placeholder = "Heading",
                    textStyle = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
                    enabled = !locked,
                    onValueChange = onTextChange,
                    testTag = "note-heading-${block.metadata.id}",
                )
                is NativeNoteBlock.Paragraph -> EditableTextBlock(
                    value = block.text,
                    placeholder = "Write an observation…",
                    textStyle = MaterialTheme.typography.bodyLarge,
                    enabled = !locked,
                    onValueChange = onTextChange,
                    testTag = "note-paragraph-${block.metadata.id}",
                )
                is NativeNoteBlock.Quote -> EditableTextBlock(
                    value = block.text,
                    placeholder = "Quote or callout…",
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontStyle = FontStyle.Italic),
                    enabled = !locked,
                    onValueChange = onTextChange,
                    testTag = "note-quote-${block.metadata.id}",
                )
                is NativeNoteBlock.Checklist -> ChecklistBlockEditor(
                    block = block,
                    enabled = !locked,
                    onTextChange = onChecklistTextChange,
                    onToggle = onChecklistToggle,
                    onAddItem = onAddItem,
                    onRemoveItem = onRemoveItem,
                )
                is NativeNoteBlock.ListBlock -> ListBlockEditor(
                    block = block,
                    enabled = !locked,
                    onTextChange = onListTextChange,
                    onAddItem = onAddItem,
                    onRemoveItem = onRemoveItem,
                )
                is NativeNoteBlock.Divider -> Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("Divider", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                }
                else -> ProtectedNoteBlock(block)
            }
        }
        BlockActionsMenu(
            canMoveUp = index > 0 && !locked,
            canMoveDown = index < blockCount - 1 && !locked,
            canRemove = block is NativeNoteBlock.Heading || block is NativeNoteBlock.Paragraph ||
                block is NativeNoteBlock.Quote || block is NativeNoteBlock.Checklist ||
                block is NativeNoteBlock.ListBlock || block is NativeNoteBlock.Divider,
            locked = locked,
            onMove = onMove,
            onRemove = onRemove,
        )
    }
}

@Composable
private fun EditableTextBlock(
    value: String,
    placeholder: String,
    textStyle: TextStyle,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().padding(vertical = 6.dp).testTag(testTag),
        textStyle = textStyle.copy(color = MaterialTheme.colorScheme.onSurface),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Sentences,
            keyboardType = KeyboardType.Text,
        ),
        decorationBox = { inner ->
            if (value.isBlank()) {
                Text(placeholder, style = textStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            inner()
        },
    )
}

@Composable
private fun ChecklistBlockEditor(
    block: NativeNoteBlock.Checklist,
    enabled: Boolean,
    onTextChange: (String, String) -> Unit,
    onToggle: (String) -> Unit,
    onAddItem: () -> Unit,
    onRemoveItem: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Checklist", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        block.items.forEach { item ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = item.done,
                    onCheckedChange = if (enabled) ({ onToggle(item.id) }) else null,
                    modifier = Modifier.testTag("note-check-${item.id}"),
                )
                EditableTextBlock(
                    value = item.text,
                    placeholder = "Checklist item",
                    textStyle = MaterialTheme.typography.bodyLarge,
                    enabled = enabled,
                    onValueChange = { onTextChange(item.id, it) },
                    testTag = "note-check-text-${item.id}",
                    modifier = Modifier.weight(1f),
                )
                if (enabled) {
                    IconButton(onClick = { onRemoveItem(item.id) }, modifier = Modifier.sizeIn(48.dp, 48.dp)) {
                        Icon(Icons.Outlined.DeleteOutline, contentDescription = "Remove checklist item")
                    }
                }
            }
        }
        if (enabled) {
            TextButton(onClick = onAddItem, modifier = Modifier.testTag("note-add-checklist-item")) {
                Icon(Icons.Outlined.Add, contentDescription = null)
                Text("Add item")
            }
        }
    }
}

@Composable
private fun ListBlockEditor(
    block: NativeNoteBlock.ListBlock,
    enabled: Boolean,
    onTextChange: (String, String) -> Unit,
    onAddItem: () -> Unit,
    onRemoveItem: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("List", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        block.items.forEachIndexed { index, item ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${index + 1}.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                EditableTextBlock(
                    value = item.text,
                    placeholder = "List item",
                    textStyle = MaterialTheme.typography.bodyLarge,
                    enabled = enabled,
                    onValueChange = { onTextChange(item.id, it) },
                    testTag = "note-list-text-${item.id}",
                    modifier = Modifier.weight(1f),
                )
                if (enabled) {
                    IconButton(onClick = { onRemoveItem(item.id) }, modifier = Modifier.sizeIn(48.dp, 48.dp)) {
                        Icon(Icons.Outlined.DeleteOutline, contentDescription = "Remove list item")
                    }
                }
            }
        }
        if (enabled) {
            TextButton(onClick = onAddItem, modifier = Modifier.testTag("note-add-list-item")) {
                Icon(Icons.Outlined.Add, contentDescription = null)
                Text("Add item")
            }
        }
    }
}

@Composable
private fun ProtectedNoteBlock(block: NativeNoteBlock) {
    val (icon, title, detail) = when (block) {
        is NativeNoteBlock.Table -> Triple(Icons.Outlined.GridOn, "Table", "${block.data.size} rows")
        is NativeNoteBlock.Workbook -> Triple(Icons.Outlined.GridOn, block.title ?: "Workbook", "Edit from the Workbook tab")
        is NativeNoteBlock.Image -> Triple(Icons.Outlined.Description, "Image evidence", block.caption ?: "Attached to this entry")
        is NativeNoteBlock.File -> Triple(Icons.Outlined.Description, block.label ?: "File evidence", "Attached to this entry")
        else -> Triple(Icons.Outlined.Description, "Entry content", "Stored with this entry")
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Column(modifier = Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun BlockActionsMenu(
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    canRemove: Boolean,
    locked: Boolean,
    onMove: (Int) -> Unit,
    onRemove: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    IconButton(
        onClick = { expanded = true },
        modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
    ) {
        Icon(Icons.Outlined.MoreVert, contentDescription = "Block actions")
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        if (locked) {
            DropdownMenuItem(text = { Text("Locked") }, onClick = {}, enabled = false)
        } else {
            DropdownMenuItem(
                text = { Text("Move up") },
                onClick = { expanded = false; onMove(-1) },
                enabled = canMoveUp,
            )
            DropdownMenuItem(
                text = { Text("Move down") },
                onClick = { expanded = false; onMove(1) },
                enabled = canMoveDown,
            )
            if (canRemove) {
                DropdownMenuItem(
                    text = { Text("Delete block") },
                    onClick = { expanded = false; onRemove() },
                    leadingIcon = { Icon(Icons.Outlined.DeleteOutline, contentDescription = null) },
                )
            }
        }
    }
}

@Composable
private fun AddBlockMenu(onAdd: (InsertableNoteBlock) -> Unit, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier = modifier) {
        TextButton(onClick = { expanded = true }, modifier = Modifier.sizeIn(minHeight = 48.dp).testTag("note-add-block")) {
            Icon(Icons.Outlined.Add, contentDescription = null)
            Text("Add block")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            listOf(
                InsertableNoteBlock.Paragraph to "Paragraph",
                InsertableNoteBlock.Heading to "Heading",
                InsertableNoteBlock.Checklist to "Checklist",
                InsertableNoteBlock.List to "List",
                InsertableNoteBlock.Quote to "Quote",
                InsertableNoteBlock.Divider to "Divider",
            ).forEach { (type, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = { expanded = false; onAdd(type) },
                    leadingIcon = {
                        Icon(
                            when (type) {
                                InsertableNoteBlock.Checklist -> Icons.Outlined.CheckBox
                                InsertableNoteBlock.List -> Icons.Outlined.FormatListBulleted
                                InsertableNoteBlock.Quote -> Icons.Outlined.FormatQuote
                                else -> Icons.Outlined.Description
                            },
                            contentDescription = null,
                        )
                    },
                )
            }
        }
    }
}
