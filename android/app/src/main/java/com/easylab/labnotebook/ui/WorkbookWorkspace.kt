package com.easylab.labnotebook.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.ScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions

private val WorkbookRowHeaderWidth = 48.dp
private val WorkbookCellWidth = 112.dp

@Composable
internal fun ReadOnlyWorkbookWorkspace(
    block: ReadOnlyBlock.GridBlock,
    stateKey: String,
    modifier: Modifier = Modifier,
) {
    var state by remember(stateKey, block.rows, block.styles, block.title) {
        mutableStateOf(
            WorkbookState.create(
                data = block.rows,
                styles = block.styles,
                title = block.title,
            ),
        )
    }
    Column(modifier = modifier.fillMaxSize().testTag("workbook-workspace")) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    state.title ?: "Workbook",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "View only on this device",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "${state.data.size} × ${state.data.first().size}",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                state.selectedLabel,
                modifier = Modifier.width(48.dp).testTag("workbook-selected-address"),
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                state.selectedValue.ifBlank { "Empty cell" },
                modifier = Modifier.weight(1f).testTag("workbook-selected-value"),
                color = if (state.selectedValue.isBlank()) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        if (block.inputWasTruncated || state.inputWasTruncated) {
            Text(
                "Only the first 80 rows and 16 columns can be shown.",
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        WorkbookGrid(
            state = state,
            stateKey = stateKey,
            onSelect = { position -> state = state.select(position) },
            modifier = Modifier.fillMaxWidth().weight(1f),
        )
    }
}

@Composable
internal fun EditableWorkbookWorkspace(
    initialState: WorkbookState,
    stateKey: String,
    onSave: (WorkbookDriveSnapshot) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    saving: Boolean = false,
    errorMessage: String? = null,
) {
    var state by remember(stateKey, initialState.data, initialState.styles, initialState.title) {
        mutableStateOf(initialState)
    }
    val hasChanges = state.data != initialState.data || state.styles != initialState.styles || state.isEditing

    fun commit(move: WorkbookMove? = null) {
        state = if (move == null) state.commitEditing() else state.commitAndMove(move)
    }

    Column(modifier = modifier.fillMaxSize().testTag("workbook-editor")) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                state.title ?: "Workbook",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("workbook-cancel"),
            ) { Text("Cancel") }
            Button(
                onClick = {
                    val committed = if (state.isEditing) state.commitEditing() else state
                    state = committed
                    onSave(committed.compactForDrive())
                },
                enabled = hasChanges && !saving,
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("workbook-save"),
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

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                state.selectedLabel,
                modifier = Modifier.width(48.dp).testTag("workbook-selected-address"),
                fontWeight = FontWeight.SemiBold,
            )
            OutlinedTextField(
                value = state.draftValue ?: state.selectedValue,
                onValueChange = { value ->
                    val editing = if (state.isEditing) state else state.beginEditing()
                    state = editing.updateDraft(value)
                },
                modifier = Modifier
                    .weight(1f)
                    .testTag("workbook-cell-value-editor")
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown || !state.isEditing) return@onPreviewKeyEvent false
                        when (event.key) {
                            Key.Enter -> commit(if (event.isShiftPressed) WorkbookMove.Up else WorkbookMove.Down)
                            Key.Tab -> commit(if (event.isShiftPressed) WorkbookMove.Left else WorkbookMove.Right)
                            Key.Escape -> state = state.cancelEditing()
                            else -> return@onPreviewKeyEvent false
                        }
                        true
                    },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { if (state.isEditing) commit(WorkbookMove.Down) }),
                label = { Text("Cell value") },
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        WorkbookGrid(
            state = state,
            stateKey = stateKey,
            onSelect = { position ->
                val committed = if (state.isEditing) state.commitEditing() else state
                state = committed.select(position)
            },
            modifier = Modifier.fillMaxWidth().weight(1f),
        )
    }
}

@Composable
private fun WorkbookGrid(
    state: WorkbookState,
    stateKey: String,
    onSelect: (WorkbookCellPosition) -> Unit,
    modifier: Modifier = Modifier,
) {
    val horizontalScroll = remember(stateKey) { ScrollState(0) }
    val verticalScroll = remember(stateKey) { LazyListState() }
    val gridWidth = WorkbookRowHeaderWidth + (WorkbookCellWidth * state.data.first().size)
    Box(modifier = modifier.horizontalScroll(horizontalScroll).testTag("workbook-grid-scroll")) {
        LazyColumn(
            state = verticalScroll,
            modifier = Modifier.width(gridWidth).fillMaxHeight().testTag("workbook-grid"),
        ) {
            stickyHeader { WorkbookHeaderRow(state.data.first().size) }
            itemsIndexed(state.data, key = { rowIndex, _ -> rowIndex }) { rowIndex, row ->
                WorkbookDataRow(rowIndex, row, state, onSelect)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}

@Composable
private fun WorkbookHeaderRow(columnCount: Int) {
    Row(modifier = Modifier.fillMaxWidth()) {
        WorkbookHeaderCell("", WorkbookRowHeaderWidth, "Workbook row numbers")
        repeat(columnCount) { columnIndex ->
            val label = workbookCellLabel(WorkbookCellPosition(0, columnIndex)).dropLast(1)
            WorkbookHeaderCell(label, WorkbookCellWidth, "Column $label")
        }
    }
}

@Composable
private fun WorkbookHeaderCell(text: String, width: androidx.compose.ui.unit.Dp, description: String) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.width(width).heightIn(min = 44.dp).semantics { contentDescription = description },
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 8.dp, vertical = 10.dp)) {
            Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun WorkbookDataRow(
    rowIndex: Int,
    row: List<String>,
    state: WorkbookState,
    onSelect: (WorkbookCellPosition) -> Unit,
) {
    Row {
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.width(WorkbookRowHeaderWidth).heightIn(min = 48.dp),
        ) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 6.dp, vertical = 12.dp)) {
                Text("${rowIndex + 1}", style = MaterialTheme.typography.labelMedium)
            }
        }
        row.forEachIndexed { columnIndex, value ->
            val position = WorkbookCellPosition(rowIndex, columnIndex)
            val label = workbookCellLabel(position)
            val isSelected = state.selection == position
            val style = state.styles[workbookCellKey(position)]
            Surface(
                onClick = { onSelect(position) },
                color = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
                border = BorderStroke(
                    width = if (isSelected) 2.dp else 0.5.dp,
                    color = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                ),
                modifier = Modifier
                    .width(WorkbookCellWidth)
                    .heightIn(min = 48.dp)
                    .testTag("workbook-cell-$label")
                    .semantics {
                        contentDescription = "Cell $label, ${value.ifBlank { "empty" }}"
                        if (isSelected) stateDescription = "Selected"
                    },
            ) {
                Text(
                    value.ifBlank { " " },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = if (style?.bold == true) FontWeight.Bold else FontWeight.Normal,
                    fontStyle = if (style?.italic == true) FontStyle.Italic else FontStyle.Normal,
                    textDecoration = if (style?.underline == true) TextDecoration.Underline else TextDecoration.None,
                    textAlign = when (style?.align) {
                        WorkbookAlignment.Center -> TextAlign.Center
                        WorkbookAlignment.Right -> TextAlign.Right
                        else -> TextAlign.Left
                    },
                )
            }
        }
    }
}
