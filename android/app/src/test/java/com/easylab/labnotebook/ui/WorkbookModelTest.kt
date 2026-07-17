package com.easylab.labnotebook.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkbookModelTest {
    @Test
    fun normalizesToWebWorkbookBounds() {
        val state = WorkbookState.create(listOf(listOf("Dose", "Viability")))

        assertEquals(WORKBOOK_MIN_ROWS, state.data.size)
        assertEquals(WORKBOOK_MIN_COLUMNS, state.data.first().size)
        assertEquals("Dose", state.data[0][0])
        assertEquals("Viability", state.data[0][1])

        val oversized = WorkbookState.create(
            List(WORKBOOK_MAX_ROWS + 5) { row ->
                List(WORKBOOK_MAX_COLUMNS + 5) { column -> "$row:$column" }
            },
        )
        assertEquals(WORKBOOK_MAX_ROWS, oversized.data.size)
        assertEquals(WORKBOOK_MAX_COLUMNS, oversized.data.first().size)
        assertTrue(oversized.truncatedRows)
        assertTrue(oversized.truncatedColumns)
        assertTrue(oversized.inputWasTruncated)
    }

    @Test
    fun enterAndTabCommitThenMoveWithinBounds() {
        var state = WorkbookState.create()
            .beginEditing()
            .updateDraft("A1 value")
            .commitAndMove(WorkbookMove.Down)

        assertEquals("A1 value", state.data[0][0])
        assertEquals(WorkbookCellPosition(1, 0), state.selection)
        assertEquals("A2", state.selectedLabel)
        assertFalse(state.isEditing)

        state = state.beginEditing().updateDraft("A2 value").commitAndMove(WorkbookMove.Right)
        assertEquals("A2 value", state.data[1][0])
        assertEquals(WorkbookCellPosition(1, 1), state.selection)
        assertEquals("B2", state.selectedLabel)

        val topLeft = state.select(WorkbookCellPosition(0, 0)).move(WorkbookMove.Up).move(WorkbookMove.Left)
        assertEquals(WorkbookCellPosition(0, 0), topLeft.selection)
    }

    @Test
    fun cancelEditingRestoresTheStoredCellValue() {
        val original = WorkbookState.create(listOf(listOf("Original")))
        val cancelled = original.beginEditing().updateDraft("Changed").cancelEditing()

        assertEquals("Original", cancelled.selectedValue)
        assertEquals(original.data, cancelled.data)
        assertFalse(cancelled.isEditing)
    }

    @Test
    fun commitEditingStoresTheDraftWithoutMovingSelection() {
        val committed = WorkbookState.create()
            .beginEditing()
            .updateDraft("Observed")
            .commitEditing()

        assertEquals("Observed", committed.selectedValue)
        assertEquals(WorkbookCellPosition(0, 0), committed.selection)
        assertFalse(committed.isEditing)
    }

    @Test
    fun changingADraftRequiresAnActiveEditSession() {
        assertTrue(runCatching { WorkbookState.create().updateDraft("Changed") }.isFailure)
    }

    @Test
    fun selectionMovementCannotDiscardAnActiveDraft() {
        val editing = WorkbookState.create().beginEditing().updateDraft("Uncommitted")

        assertTrue(runCatching { editing.move(WorkbookMove.Down) }.isFailure)
        assertEquals("Uncommitted", editing.draftValue)
        assertEquals("", editing.selectedValue)
    }

    @Test
    fun driveCompactionPreservesOnlyUsedCellsAndStyles() {
        val style = WorkbookCellStyle(bold = true, align = WorkbookAlignment.Right)
        val state = WorkbookState.create(
            title = "Dose response",
            data = listOf(
                listOf("Dose", "Viability", ""),
                listOf("10", "94%", ""),
            ),
            styles = mapOf(
                "0:0" to style,
                "5:5" to WorkbookCellStyle(italic = true),
                "not-a-cell" to WorkbookCellStyle(underline = true),
                "1:1" to WorkbookCellStyle(),
            ),
        )

        val snapshot = state.compactForDrive()

        assertEquals(listOf(listOf("Dose", "Viability"), listOf("10", "94%")), snapshot.data)
        assertEquals(mapOf("0:0" to style), snapshot.styles)
        assertEquals("Dose response", snapshot.title)
        assertEquals("right", snapshot.styles.getValue("0:0").align?.driveValue)
        assertEquals(WorkbookAlignment.Right, WorkbookAlignment.fromDriveValue("right"))
    }

    @Test
    fun emptyWorkbookCompactsToTheExistingDriveRepresentation() {
        val snapshot = WorkbookState.create().compactForDrive()

        assertTrue(snapshot.data.isEmpty())
        assertTrue(snapshot.styles.isEmpty())
    }

    @Test
    fun raggedInputIsPaddedAndCommitAtBottomRightStaysInBounds() {
        val state = WorkbookState.create(
            data = listOf(listOf("A"), listOf("B", "C", "D")),
            selection = WorkbookCellPosition(WORKBOOK_MAX_ROWS - 1, WORKBOOK_MAX_COLUMNS - 1),
        )

        assertEquals("", state.data[0][2])
        assertEquals("D", state.data[1][2])

        val committed = state.beginEditing().updateDraft("Edge").commitAndMove(WorkbookMove.Down)
        assertEquals("Edge", committed.selectedValue)
        assertEquals(
            WorkbookCellPosition(WORKBOOK_MIN_ROWS - 1, WORKBOOK_MIN_COLUMNS - 1),
            committed.selection,
        )
    }

    @Test
    fun cellLabelsMatchSpreadsheetCoordinates() {
        assertEquals("A1", workbookCellLabel(WorkbookCellPosition(0, 0)))
        assertEquals("P80", workbookCellLabel(WorkbookCellPosition(79, 15)))
        assertEquals("AA1", workbookCellLabel(WorkbookCellPosition(0, 26)))
    }
}
