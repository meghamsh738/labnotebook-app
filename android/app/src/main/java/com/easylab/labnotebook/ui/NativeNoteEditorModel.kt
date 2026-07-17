package com.easylab.labnotebook.ui

internal enum class InsertableNoteBlock {
    Paragraph,
    Heading,
    Checklist,
    List,
    Quote,
    Divider,
}

internal class NativeNoteEditorState private constructor(
    private val initialBlocks: List<NativeNoteBlock>,
    val blocks: List<NativeNoteBlock>,
) {
    val hasChanges: Boolean
        get() = blocks != initialBlocks

    fun updateText(blockId: String, value: String): NativeNoteEditorState = updateBlock(blockId) { block ->
        when (block) {
            is NativeNoteBlock.Heading -> block.copy(
                text = value,
                runs = block.runs.updatedForTextChange(block.text, value),
            )
            is NativeNoteBlock.Paragraph -> block.copy(
                text = value,
                runs = block.runs.updatedForTextChange(block.text, value),
            )
            is NativeNoteBlock.Quote -> block.copy(
                text = value,
                runs = block.runs.updatedForTextChange(block.text, value),
            )
            else -> block
        }
    }

    fun updateChecklistItem(blockId: String, itemId: String, value: String): NativeNoteEditorState =
        updateBlock(blockId) { block ->
            if (block !is NativeNoteBlock.Checklist) return@updateBlock block
            block.copy(
                items = block.items.map { item ->
                    if (item.id != itemId) item else item.copy(
                        text = value,
                        runs = item.runs.updatedForTextChange(item.text, value),
                    )
                },
            )
        }

    fun toggleChecklistItem(blockId: String, itemId: String): NativeNoteEditorState =
        updateBlock(blockId) { block ->
            if (block !is NativeNoteBlock.Checklist) return@updateBlock block
            block.copy(items = block.items.map { item -> if (item.id == itemId) item.copy(done = !item.done) else item })
        }

    fun updateListItem(blockId: String, itemId: String, value: String): NativeNoteEditorState =
        updateBlock(blockId) { block ->
            if (block !is NativeNoteBlock.ListBlock) return@updateBlock block
            block.copy(
                items = block.items.map { item ->
                    if (item.id != itemId) item else item.copy(
                        text = value,
                        runs = item.runs.updatedForTextChange(item.text, value),
                    )
                },
            )
        }

    fun addItem(blockId: String, itemId: String): NativeNoteEditorState {
        require(itemId.isNotBlank()) { "Note item id must not be blank." }
        val parent = blocks.firstOrNull { it.metadata.id == blockId }
        require(parent == null || itemId !in parent.itemIds()) { "Note item ids must be unique within their block." }
        return updateBlock(blockId) { block ->
            when (block) {
                is NativeNoteBlock.Checklist -> block.copy(
                    items = block.items + NativeChecklistItem(id = itemId, text = "", done = false),
                )
                is NativeNoteBlock.ListBlock -> block.copy(
                    items = block.items + NativeListItem(id = itemId, text = ""),
                )
                else -> block
            }
        }
    }

    fun removeItem(blockId: String, itemId: String): NativeNoteEditorState = updateBlock(blockId) { block ->
        when (block) {
            is NativeNoteBlock.Checklist -> block.copy(items = block.items.filterNot { it.id == itemId })
            is NativeNoteBlock.ListBlock -> block.copy(items = block.items.filterNot { it.id == itemId })
            else -> block
        }
    }

    fun insertBlock(type: InsertableNoteBlock, blockId: String): NativeNoteEditorState {
        require(blockId.isNotBlank()) { "Note block id must not be blank." }
        require(blocks.none { it.metadata.id == blockId }) { "Note block ids must be unique." }
        val metadata = NoteBlockMetadata(blockId)
        val block = when (type) {
            InsertableNoteBlock.Paragraph -> NativeNoteBlock.Paragraph(metadata, "")
            InsertableNoteBlock.Heading -> NativeNoteBlock.Heading(metadata, "", level = 2)
            InsertableNoteBlock.Checklist -> NativeNoteBlock.Checklist(metadata, emptyList())
            InsertableNoteBlock.List -> NativeNoteBlock.ListBlock(metadata, emptyList())
            InsertableNoteBlock.Quote -> NativeNoteBlock.Quote(metadata, "")
            InsertableNoteBlock.Divider -> NativeNoteBlock.Divider(metadata)
        }
        return updated(blocks + block)
    }

    fun removeBlock(blockId: String): NativeNoteEditorState {
        val block = blocks.firstOrNull { it.metadata.id == blockId } ?: return this
        if (block.metadata.locked == true) return this
        return updated(blocks.filterNot { it.metadata.id == blockId })
    }

    fun moveBlock(blockId: String, offset: Int): NativeNoteEditorState {
        if (offset == 0) return this
        val current = blocks.indexOfFirst { it.metadata.id == blockId }
        if (current < 0 || blocks[current].metadata.locked == true) return this
        val target = (current + offset).coerceIn(0, blocks.lastIndex)
        if (target == current) return this
        val mutable = blocks.toMutableList()
        val block = mutable.removeAt(current)
        mutable.add(target, block)
        return updated(mutable)
    }

    fun snapshot(editedAt: String, deviceId: String): List<NativeNoteBlock> {
        require(editedAt.isNotBlank()) { "Edit timestamp must not be blank." }
        require(deviceId.isNotBlank()) { "Editing device id must not be blank." }
        val original = initialBlocks.associateBy { it.metadata.id }
        return blocks.map { block ->
            val sanitized = block.withBlankDraftItemsRemoved()
            if (original[block.metadata.id] == sanitized) sanitized else sanitized.withMetadata(
                sanitized.metadata.copy(updatedAt = editedAt, updatedBy = deviceId),
            )
        }
    }

    private fun updateBlock(blockId: String, transform: (NativeNoteBlock) -> NativeNoteBlock): NativeNoteEditorState {
        val index = blocks.indexOfFirst { it.metadata.id == blockId }
        if (index < 0 || blocks[index].metadata.locked == true) return this
        val replacement = transform(blocks[index])
        if (replacement == blocks[index]) return this
        return updated(blocks.toMutableList().also { it[index] = replacement })
    }

    private fun updated(nextBlocks: List<NativeNoteBlock>): NativeNoteEditorState =
        NativeNoteEditorState(initialBlocks, nextBlocks)

    companion object {
        fun create(blocks: List<NativeNoteBlock>): NativeNoteEditorState {
            require(blocks.map { it.metadata.id }.distinct().size == blocks.size) { "Note block ids must be unique." }
            blocks.forEach { block ->
                val itemIds = block.itemIds()
                require(itemIds.distinct().size == itemIds.size) { "Note item ids must be unique within their block." }
            }
            return NativeNoteEditorState(blocks, blocks)
        }
    }
}

private fun List<NoteTextRun>?.updatedForTextChange(oldText: String, newText: String): List<NoteTextRun>? = when {
    oldText == newText -> this
    this == null -> null
    joinToString(separator = "") { it.text } != oldText -> null
    size == 1 -> listOf(single().copy(text = newText))
    else -> null
}

private fun NativeNoteBlock.itemIds(): List<String> = when (this) {
    is NativeNoteBlock.Checklist -> items.map { it.id }
    is NativeNoteBlock.ListBlock -> items.map { it.id }
    else -> emptyList()
}

private fun NativeNoteBlock.withBlankDraftItemsRemoved(): NativeNoteBlock = when (this) {
    is NativeNoteBlock.Checklist -> copy(items = items.filter { it.text.isNotBlank() })
    is NativeNoteBlock.ListBlock -> copy(items = items.filter { it.text.isNotBlank() })
    else -> this
}

private fun NativeNoteBlock.withMetadata(value: NoteBlockMetadata): NativeNoteBlock = when (this) {
    is NativeNoteBlock.Heading -> copy(metadata = value)
    is NativeNoteBlock.Paragraph -> copy(metadata = value)
    is NativeNoteBlock.Table -> copy(metadata = value)
    is NativeNoteBlock.Workbook -> copy(metadata = value)
    is NativeNoteBlock.Image -> copy(metadata = value)
    is NativeNoteBlock.File -> copy(metadata = value)
    is NativeNoteBlock.Checklist -> copy(metadata = value)
    is NativeNoteBlock.ListBlock -> copy(metadata = value)
    is NativeNoteBlock.Quote -> copy(metadata = value)
    is NativeNoteBlock.Divider -> copy(metadata = value)
}
