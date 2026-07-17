package com.easylab.labnotebook.ui

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeNoteEditorModelTest {
    @Test
    fun editsTextAndPreservesUntouchedDriveFields() {
        val source = JsonObject(mapOf("future" to JsonPrimitive("kept")))
        val blocks = listOf(
            NativeNoteBlock.Paragraph(
                metadata = NoteBlockMetadata("paragraph", source = source, sourceId = "paragraph"),
                text = "Before",
                runs = listOf(NoteTextRun("Before", bold = true, source = source)),
            ),
            NativeNoteBlock.Workbook(
                metadata = NoteBlockMetadata("workbook", source = source, sourceId = "workbook"),
                data = listOf(listOf("A")),
                styles = mapOf("0:0" to NativeWorkbookCellStyle(bold = true, source = source)),
            ),
        )

        val state = NativeNoteEditorState.create(blocks).updateText("paragraph", "After")
        val saved = state.snapshot("2026-07-17T10:00:00.000Z", "android-device")

        assertTrue(state.hasChanges)
        val paragraph = saved[0] as NativeNoteBlock.Paragraph
        assertEquals("After", paragraph.text)
        assertEquals("After", paragraph.runs?.single()?.text)
        assertEquals(true, paragraph.runs?.single()?.bold)
        assertEquals(source, paragraph.runs?.single()?.source)
        assertEquals(source, paragraph.metadata.source)
        assertEquals("android-device", paragraph.metadata.updatedBy)
        assertEquals(blocks[1], saved[1])
        assertEquals(blocks[1], NoteBlockCodec.decode(NoteBlockCodec.encode(saved))[1])
    }

    @Test
    fun mixedFormattingIsClearedOnlyWhenItsTextChanges() {
        val paragraph = NativeNoteBlock.Paragraph(
            metadata = NoteBlockMetadata("paragraph"),
            text = "Bold plain",
            runs = listOf(NoteTextRun("Bold", bold = true), NoteTextRun(" plain")),
        )
        val unchanged = NativeNoteEditorState.create(listOf(paragraph))
        assertEquals(paragraph, unchanged.snapshot("time", "device").single())

        val edited = unchanged.updateText("paragraph", "New text")
            .snapshot("time", "device")
            .single() as NativeNoteBlock.Paragraph
        assertNull(edited.runs)
    }

    @Test
    fun editsChecklistAndDropsOnlyBlankDraftItemsAtSave() {
        val checklist = NativeNoteBlock.Checklist(
            NoteBlockMetadata("checklist"),
            listOf(NativeChecklistItem("one", "Record temperature", false)),
        )
        val state = NativeNoteEditorState.create(listOf(checklist))
            .toggleChecklistItem("checklist", "one")
            .addItem("checklist", "two")
            .updateChecklistItem("checklist", "two", "  ")

        val saved = state.snapshot("time", "device").single() as NativeNoteBlock.Checklist
        assertEquals(1, saved.items.size)
        assertTrue(saved.items.single().done)
        assertEquals("device", saved.metadata.updatedBy)
    }

    @Test
    fun insertsMovesAndRemovesBlocksWithoutMutatingLockedContent() {
        val locked = NativeNoteBlock.Paragraph(NoteBlockMetadata("locked", locked = true), "Protected")
        val state = NativeNoteEditorState.create(listOf(locked))
            .updateText("locked", "Changed")
            .removeBlock("locked")
            .insertBlock(InsertableNoteBlock.Heading, "heading")
            .moveBlock("heading", -1)

        assertEquals(listOf("heading", "locked"), state.blocks.map { it.metadata.id })
        assertEquals("Protected", (state.blocks[1] as NativeNoteBlock.Paragraph).text)
        assertTrue(state.hasChanges)
        assertFalse(NativeNoteEditorState.create(listOf(locked)).hasChanges)
    }
}
