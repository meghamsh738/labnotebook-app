package com.easylab.labnotebook.ui

internal const val WORKBOOK_MIN_ROWS = 24
internal const val WORKBOOK_MIN_COLUMNS = 8
internal const val WORKBOOK_MAX_ROWS = 80
internal const val WORKBOOK_MAX_COLUMNS = 16

internal enum class WorkbookAlignment(val driveValue: String) {
    Left("left"),
    Center("center"),
    Right("right");

    companion object {
        fun fromDriveValue(value: String?): WorkbookAlignment? = entries.firstOrNull { it.driveValue == value }
    }
}

internal data class WorkbookCellStyle(
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val align: WorkbookAlignment? = null,
) {
    val hasContent: Boolean
        get() = bold || italic || underline || align != null
}

internal data class WorkbookCellPosition(
    val rowIndex: Int,
    val columnIndex: Int,
)

internal enum class WorkbookMove(val rowDelta: Int, val columnDelta: Int) {
    Up(-1, 0),
    Down(1, 0),
    Left(0, -1),
    Right(0, 1),
}

internal data class WorkbookDriveSnapshot(
    val title: String?,
    val data: List<List<String>>,
    val styles: Map<String, WorkbookCellStyle>,
)

internal class WorkbookState private constructor(
    val title: String?,
    val data: List<List<String>>,
    val styles: Map<String, WorkbookCellStyle>,
    val selection: WorkbookCellPosition,
    val draftValue: String?,
    val truncatedRows: Boolean,
    val truncatedColumns: Boolean,
) {
    val isEditing: Boolean
        get() = draftValue != null

    val selectedValue: String
        get() = data[selection.rowIndex][selection.columnIndex]

    val selectedLabel: String
        get() = workbookCellLabel(selection)

    val inputWasTruncated: Boolean
        get() = truncatedRows || truncatedColumns

    fun select(position: WorkbookCellPosition): WorkbookState {
        check(!isEditing) { "Commit or cancel the workbook draft before changing selection." }
        return updated(selection = position.clamped(data.size, data.first().size))
    }

    fun move(move: WorkbookMove): WorkbookState = select(selection.moved(move))

    fun beginEditing(): WorkbookState = if (isEditing) this else updated(draftValue = selectedValue)

    fun updateDraft(value: String): WorkbookState {
        check(isEditing) { "Begin editing before changing a workbook draft." }
        return updated(draftValue = value)
    }

    fun cancelEditing(): WorkbookState = updated(draftValue = null)

    fun commitEditing(): WorkbookState {
        val nextData = draftValue?.let { value -> data.replacing(selection, value) } ?: data
        return updated(data = nextData, draftValue = null)
    }

    fun commitAndMove(move: WorkbookMove): WorkbookState {
        val committed = commitEditing()
        val nextSelection = selection.moved(move).clamped(committed.data.size, committed.data.first().size)
        return committed.updated(selection = nextSelection)
    }

    fun compactForDrive(): WorkbookDriveSnapshot {
        var lastRow = -1
        var lastColumn = -1
        data.forEachIndexed { rowIndex, row ->
            row.forEachIndexed { columnIndex, value ->
                if (value.isNotBlank()) {
                    lastRow = maxOf(lastRow, rowIndex)
                    lastColumn = maxOf(lastColumn, columnIndex)
                }
            }
        }
        if (lastRow < 0 || lastColumn < 0) return WorkbookDriveSnapshot(title, emptyList(), emptyMap())

        val compactData = data.take(lastRow + 1).map { row -> row.take(lastColumn + 1) }
        val compactStyles = styles.filterKeys { key ->
            val position = parseWorkbookCellKey(key) ?: return@filterKeys false
            position.rowIndex <= lastRow && position.columnIndex <= lastColumn
        }
        return WorkbookDriveSnapshot(title, compactData, compactStyles)
    }

    private fun updated(
        title: String? = this.title,
        data: List<List<String>> = this.data,
        styles: Map<String, WorkbookCellStyle> = this.styles,
        selection: WorkbookCellPosition = this.selection,
        draftValue: String? = this.draftValue,
        truncatedRows: Boolean = this.truncatedRows,
        truncatedColumns: Boolean = this.truncatedColumns,
    ): WorkbookState = WorkbookState(
        title,
        data,
        styles,
        selection,
        draftValue,
        truncatedRows,
        truncatedColumns,
    )

    companion object {
        fun create(
            data: List<List<String>> = emptyList(),
            styles: Map<String, WorkbookCellStyle> = emptyMap(),
            selection: WorkbookCellPosition = WorkbookCellPosition(0, 0),
            title: String? = null,
        ): WorkbookState {
            val normalizedData = normalizeWorkbookData(data)
            return WorkbookState(
                title = title?.takeIf { it.isNotBlank() },
                data = normalizedData,
                styles = normalizeWorkbookStyles(styles),
                selection = selection.clamped(normalizedData.size, normalizedData.first().size),
                draftValue = null,
                truncatedRows = data.size > WORKBOOK_MAX_ROWS,
                truncatedColumns = data.any { it.size > WORKBOOK_MAX_COLUMNS },
            )
        }
    }
}

internal fun workbookCellKey(position: WorkbookCellPosition): String =
    "${position.rowIndex}:${position.columnIndex}"

internal fun workbookCellLabel(position: WorkbookCellPosition): String =
    "${workbookColumnLabel(position.columnIndex)}${position.rowIndex + 1}"

private fun workbookColumnLabel(columnIndex: Int): String {
    require(columnIndex >= 0) { "Workbook column index must be non-negative." }
    var index = columnIndex
    var label = ""
    do {
        label = ('A'.code + (index % 26)).toChar() + label
        index = (index / 26) - 1
    } while (index >= 0)
    return label
}

private fun normalizeWorkbookData(data: List<List<String>>): List<List<String>> {
    val rowCount = data.size.coerceIn(WORKBOOK_MIN_ROWS, WORKBOOK_MAX_ROWS)
    val sourceColumnCount = data.maxOfOrNull { it.size } ?: 0
    val columnCount = sourceColumnCount.coerceIn(WORKBOOK_MIN_COLUMNS, WORKBOOK_MAX_COLUMNS)
    return List(rowCount) { rowIndex ->
        List(columnCount) { columnIndex -> data.getOrNull(rowIndex)?.getOrNull(columnIndex).orEmpty() }
    }
}

private fun normalizeWorkbookStyles(styles: Map<String, WorkbookCellStyle>): Map<String, WorkbookCellStyle> =
    styles.filter { (key, style) ->
        val position = parseWorkbookCellKey(key) ?: return@filter false
        position.rowIndex in 0 until WORKBOOK_MAX_ROWS &&
            position.columnIndex in 0 until WORKBOOK_MAX_COLUMNS &&
            style.hasContent
    }

private fun parseWorkbookCellKey(key: String): WorkbookCellPosition? {
    val parts = key.split(':')
    if (parts.size != 2) return null
    val rowIndex = parts[0].toIntOrNull() ?: return null
    val columnIndex = parts[1].toIntOrNull() ?: return null
    if (rowIndex < 0 || columnIndex < 0) return null
    return WorkbookCellPosition(rowIndex, columnIndex)
}

private fun WorkbookCellPosition.moved(move: WorkbookMove): WorkbookCellPosition =
    WorkbookCellPosition(rowIndex + move.rowDelta, columnIndex + move.columnDelta)

private fun WorkbookCellPosition.clamped(rowCount: Int, columnCount: Int): WorkbookCellPosition =
    WorkbookCellPosition(
        rowIndex = rowIndex.coerceIn(0, rowCount - 1),
        columnIndex = columnIndex.coerceIn(0, columnCount - 1),
    )

private fun List<List<String>>.replacing(position: WorkbookCellPosition, value: String): List<List<String>> =
    mapIndexed { rowIndex, row ->
        if (rowIndex != position.rowIndex) row
        else row.mapIndexed { columnIndex, cell -> if (columnIndex == position.columnIndex) value else cell }
    }
