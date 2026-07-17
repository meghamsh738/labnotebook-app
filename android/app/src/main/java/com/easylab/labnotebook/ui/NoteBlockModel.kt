package com.easylab.labnotebook.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

internal enum class NoteAlignment(val driveValue: String) {
    Left("left"),
    Center("center"),
    Right("right"),
    Justify("justify");

    companion object {
        fun fromDriveValue(value: String?): NoteAlignment? = entries.firstOrNull { it.driveValue == value }
    }
}

internal enum class NoteTextFont(val driveValue: String) {
    Body("body"),
    Display("display"),
    Mono("mono");

    companion object {
        fun fromDriveValue(value: String?): NoteTextFont? = entries.firstOrNull { it.driveValue == value }
    }
}

internal enum class NoteListStyle(val driveValue: String) {
    Dot("dot"),
    Circle("circle"),
    Square("square"),
    Dash("dash"),
    Arrow("arrow");

    companion object {
        fun fromDriveValue(value: String?): NoteListStyle? = entries.firstOrNull { it.driveValue == value }
    }
}

internal data class NoteTextRun(
    val text: String,
    val bold: Boolean? = null,
    val italic: Boolean? = null,
    val underline: Boolean? = null,
    val superscript: Boolean? = null,
    val subscript: Boolean? = null,
    val font: NoteTextFont? = null,
    val fontSize: Int? = null,
    val color: String? = null,
    val highlight: String? = null,
    val source: JsonObject = JsonObject(emptyMap()),
)

internal data class NoteBlockMetadata(
    val id: String,
    val updatedAt: String? = null,
    val updatedBy: String? = null,
    val locked: Boolean? = null,
    val align: NoteAlignment? = null,
    val source: JsonObject = JsonObject(emptyMap()),
    val sourceId: String? = null,
)

internal data class NativeChecklistItem(
    val id: String,
    val text: String,
    val done: Boolean,
    val timerMinutes: Double? = null,
    val runs: List<NoteTextRun>? = null,
    val guide: String? = null,
    val source: JsonObject = JsonObject(emptyMap()),
    val sourceId: String? = null,
)

internal data class NativeListItem(
    val id: String,
    val text: String,
    val runs: List<NoteTextRun>? = null,
    val guide: String? = null,
    val source: JsonObject = JsonObject(emptyMap()),
    val sourceId: String? = null,
)

internal data class NativeWorkbookCellStyle(
    val bold: Boolean? = null,
    val italic: Boolean? = null,
    val underline: Boolean? = null,
    val align: WorkbookAlignment? = null,
    val source: JsonObject = JsonObject(emptyMap()),
)

internal sealed interface NativeNoteBlock {
    val metadata: NoteBlockMetadata

    data class Heading(
        override val metadata: NoteBlockMetadata,
        val text: String,
        val level: Int? = null,
        val runs: List<NoteTextRun>? = null,
    ) : NativeNoteBlock

    data class Paragraph(
        override val metadata: NoteBlockMetadata,
        val text: String,
        val runs: List<NoteTextRun>? = null,
        val guide: String? = null,
    ) : NativeNoteBlock

    data class Table(
        override val metadata: NoteBlockMetadata,
        val data: List<List<String>>,
        val caption: String? = null,
        val headerRow: Boolean? = null,
    ) : NativeNoteBlock

    data class Workbook(
        override val metadata: NoteBlockMetadata,
        val data: List<List<String>>,
        val title: String? = null,
        val styles: Map<String, NativeWorkbookCellStyle>? = null,
    ) : NativeNoteBlock

    data class Image(
        override val metadata: NoteBlockMetadata,
        val attachmentId: String,
        val caption: String? = null,
    ) : NativeNoteBlock

    data class File(
        override val metadata: NoteBlockMetadata,
        val attachmentId: String,
        val label: String? = null,
    ) : NativeNoteBlock

    data class Checklist(
        override val metadata: NoteBlockMetadata,
        val items: List<NativeChecklistItem>,
    ) : NativeNoteBlock

    data class ListBlock(
        override val metadata: NoteBlockMetadata,
        val items: List<NativeListItem>,
        val style: NoteListStyle? = null,
    ) : NativeNoteBlock

    data class Quote(
        override val metadata: NoteBlockMetadata,
        val text: String,
        val runs: List<NoteTextRun>? = null,
        val guide: String? = null,
    ) : NativeNoteBlock

    data class Divider(override val metadata: NoteBlockMetadata) : NativeNoteBlock
}

internal object NoteBlockCodec {
    private val json = Json { explicitNulls = false }
    private val supportedFontSizes = setOf(12, 14, 16, 18, 20, 24, 28)

    fun decode(rawJson: String): List<NativeNoteBlock> {
        val array = json.parseToJsonElement(rawJson) as? JsonArray
            ?: throw IllegalArgumentException("Note content must be an array.")
        return array.mapIndexed { index, element -> parseBlock(element, index) }.also { blocks ->
            requireUniqueIds(blocks.map { it.metadata.id }, "Note content block ids")
        }
    }

    fun encode(blocks: List<NativeNoteBlock>): String {
        requireUniqueIds(blocks.map { it.metadata.id }, "Note content block ids")
        val encodedArray = JsonArray(
            blocks.mapIndexed { index, block ->
                validateForEncode(block, index)
                encodeBlock(block).also { parseBlock(it, index) }
            },
        )
        encodedArray.requireFiniteNumbers("Note content")
        val encoded = encodedArray.toString()
        json.parseToJsonElement(encoded)
        return encoded
    }

    private fun parseBlock(element: JsonElement, index: Int): NativeNoteBlock {
        val block = element as? JsonObject
            ?: throw IllegalArgumentException("Note content[$index] must be an object.")
        val type = block.requiredString("type", "Note content[$index].type")
        val rootRuns = block.textRuns("runs", "Note content[$index]")
        val metadata = block.metadata(index, type)
        return when (type) {
            "heading" -> NativeNoteBlock.Heading(
                metadata = metadata,
                text = block.requiredStringValue("text", "Note content[$index].text"),
                level = block.optionalIntOrNull("level")?.takeIf { it in 1..3 },
                runs = rootRuns,
            )
            "paragraph" -> NativeNoteBlock.Paragraph(
                metadata = metadata,
                text = block.requiredStringValue("text", "Note content[$index].text"),
                runs = rootRuns,
                guide = block.optionalStringOrNull("guide"),
            )
            "table" -> NativeNoteBlock.Table(
                metadata = metadata,
                data = block.stringMatrix("data", index),
                caption = block.optionalStringOrNull("caption"),
                headerRow = block.optionalBooleanOrNull("headerRow"),
            )
            "workbook" -> NativeNoteBlock.Workbook(
                metadata = metadata,
                data = block.stringMatrix("data", index),
                title = block.optionalStringOrNull("title"),
                styles = block.workbookStyles(index),
            )
            "image" -> NativeNoteBlock.Image(
                metadata = metadata,
                attachmentId = block.requiredString("attachmentId", "Note content[$index].attachmentId"),
                caption = block.optionalStringOrNull("caption"),
            )
            "file" -> NativeNoteBlock.File(
                metadata = metadata,
                attachmentId = block.requiredString("attachmentId", "Note content[$index].attachmentId"),
                label = block.optionalStringOrNull("label"),
            )
            "checklist" -> NativeNoteBlock.Checklist(
                metadata = metadata,
                items = block.array("items", index).mapIndexed { itemIndex, itemElement ->
                    val item = itemElement as? JsonObject
                        ?: throw IllegalArgumentException("Note content[$index].items[$itemIndex] must be an object.")
                    val itemId = item.requiredString("id", "Note content[$index].items[$itemIndex].id")
                    NativeChecklistItem(
                        id = itemId,
                        text = item.requiredStringValue("text", "Note content[$index].items[$itemIndex].text"),
                        done = item.requiredBoolean("done", "Note content[$index].items[$itemIndex].done"),
                        timerMinutes = item.optionalNumberOrNull("timerMinutes"),
                        runs = item.textRuns("runs", "Note content[$index].items[$itemIndex]"),
                        guide = item.optionalStringOrNull("guide"),
                        source = item.itemPassthrough(checklist = true),
                        sourceId = itemId,
                    )
                }.also { items -> requireUniqueIds(items.map { it.id }, "Note content[$index] checklist item ids") },
            )
            "list" -> NativeNoteBlock.ListBlock(
                metadata = metadata,
                items = block.array("items", index).mapIndexed { itemIndex, itemElement ->
                    val item = itemElement as? JsonObject
                        ?: throw IllegalArgumentException("Note content[$index].items[$itemIndex] must be an object.")
                    val itemId = item.requiredString("id", "Note content[$index].items[$itemIndex].id")
                    NativeListItem(
                        id = itemId,
                        text = item.requiredStringValue("text", "Note content[$index].items[$itemIndex].text"),
                        runs = item.textRuns("runs", "Note content[$index].items[$itemIndex]"),
                        guide = item.optionalStringOrNull("guide"),
                        source = item.itemPassthrough(checklist = false),
                        sourceId = itemId,
                    )
                }.also { items -> requireUniqueIds(items.map { it.id }, "Note content[$index] list item ids") },
                style = NoteListStyle.fromDriveValue(block.optionalStringOrNull("style")),
            )
            "quote" -> NativeNoteBlock.Quote(
                metadata = metadata,
                text = block.requiredStringValue("text", "Note content[$index].text"),
                runs = rootRuns,
                guide = block.optionalStringOrNull("guide"),
            )
            "divider" -> NativeNoteBlock.Divider(metadata)
            else -> throw IllegalArgumentException("Note content[$index].type is not supported by Drive v1.")
        }
    }

    private fun encodeBlock(block: NativeNoteBlock): JsonObject = buildJsonObject {
        putSource(block.metadata.source)
        putMetadata(block.metadata)
        when (block) {
            is NativeNoteBlock.Heading -> {
                put("type", "heading")
                put("text", block.text)
                block.level?.let { put("level", it) }
                block.runs?.let { put("runs", encodeRuns(it)) }
            }
            is NativeNoteBlock.Paragraph -> {
                put("type", "paragraph")
                put("text", block.text)
                block.runs?.let { put("runs", encodeRuns(it)) }
                block.guide?.let { put("guide", it) }
            }
            is NativeNoteBlock.Table -> {
                put("type", "table")
                put("data", encodeMatrix(block.data))
                block.caption?.let { put("caption", it) }
                block.headerRow?.let { put("headerRow", it) }
            }
            is NativeNoteBlock.Workbook -> {
                put("type", "workbook")
                put("data", encodeMatrix(block.data))
                block.title?.let { put("title", it) }
                block.styles?.let { styles ->
                    put("styles", JsonObject(styles.mapValues { (_, style) -> encodeWorkbookStyle(style) }))
                }
            }
            is NativeNoteBlock.Image -> {
                put("type", "image")
                put("attachmentId", block.attachmentId)
                block.caption?.let { put("caption", it) }
            }
            is NativeNoteBlock.File -> {
                put("type", "file")
                put("attachmentId", block.attachmentId)
                block.label?.let { put("label", it) }
            }
            is NativeNoteBlock.Checklist -> {
                put("type", "checklist")
                put("items", JsonArray(block.items.map(::encodeChecklistItem)))
            }
            is NativeNoteBlock.ListBlock -> {
                put("type", "list")
                put("items", JsonArray(block.items.map(::encodeListItem)))
                block.style?.let { put("style", it.driveValue) }
            }
            is NativeNoteBlock.Quote -> {
                put("type", "quote")
                put("text", block.text)
                block.runs?.let { put("runs", encodeRuns(it)) }
                block.guide?.let { put("guide", it) }
            }
            is NativeNoteBlock.Divider -> put("type", "divider")
        }
    }

    private fun JsonObject.metadata(index: Int, type: String): NoteBlockMetadata {
        val id = requiredString("id", "Note content[$index].id")
        val alignValue = optionalStringOrNull("align")
        return NoteBlockMetadata(
            id = id,
            updatedAt = optionalStringOrNull("updatedAt"),
            updatedBy = optionalStringOrNull("updatedBy"),
            locked = optionalBooleanOrNull("locked"),
            align = NoteAlignment.fromDriveValue(alignValue),
            source = blockPassthrough(type),
            sourceId = id,
        )
    }

    private fun JsonObject.textRuns(key: String, label: String): List<NoteTextRun>? {
        val value = this[key] ?: return null
        if (value is JsonNull) return null
        val runs = value as? JsonArray
            ?: throw IllegalArgumentException("$label.$key must be an array.")
        return runs.mapIndexed { runIndex, element ->
            val run = element as? JsonObject
                ?: throw IllegalArgumentException("$label.$key[$runIndex] must be an object.")
            val fontSize = run.optionalIntOrNull("fontSize")?.takeIf { it in supportedFontSizes }
            val fontValue = run.optionalStringOrNull("font")
            NoteTextRun(
                text = run.requiredStringValue("text", "$label.$key[$runIndex].text"),
                bold = run.optionalBooleanOrNull("bold"),
                italic = run.optionalBooleanOrNull("italic"),
                underline = run.optionalBooleanOrNull("underline"),
                superscript = run.optionalBooleanOrNull("superscript"),
                subscript = run.optionalBooleanOrNull("subscript"),
                font = NoteTextFont.fromDriveValue(fontValue),
                fontSize = fontSize,
                color = run.optionalStringOrNull("color"),
                highlight = run.optionalStringOrNull("highlight"),
                source = run.runPassthrough(),
            )
        }
    }

    private fun JsonObject.stringMatrix(key: String, blockIndex: Int): List<List<String>> =
        array(key, blockIndex).mapIndexed { rowIndex, rowElement ->
            val row = rowElement as? JsonArray
                ?: throw IllegalArgumentException("Note content[$blockIndex].$key[$rowIndex] must be an array.")
            row.mapIndexed { columnIndex, cell ->
                val primitive = cell as? JsonPrimitive
                require(primitive?.isString == true) {
                    "Note content[$blockIndex].$key[$rowIndex][$columnIndex] must be a string."
                }
                primitive.content
            }
        }

    private fun JsonObject.workbookStyles(blockIndex: Int): Map<String, NativeWorkbookCellStyle>? {
        val value = this["styles"] ?: return null
        if (value is JsonNull) return null
        val styles = value as? JsonObject ?: return null
        if (styles.values.any { it !is JsonObject }) return null
        return styles.mapValues { (key, styleElement) ->
            val style = styleElement as JsonObject
            val alignValue = style.optionalStringOrNull("align")
            NativeWorkbookCellStyle(
                bold = style.optionalBooleanOrNull("bold"),
                italic = style.optionalBooleanOrNull("italic"),
                underline = style.optionalBooleanOrNull("underline"),
                align = WorkbookAlignment.fromDriveValue(alignValue),
                source = style.workbookStylePassthrough(),
            )
        }
    }

    private fun JsonObject.blockPassthrough(type: String): JsonObject {
        val consumed = mutableSetOf("id", "type")
        consumeString(consumed, "updatedAt")
        consumeString(consumed, "updatedBy")
        consumeBoolean(consumed, "locked")
        if (this["align"] is JsonNull || NoteAlignment.fromDriveValue(optionalStringOrNull("align")) != null) {
            consumed += "align"
        }

        when (type) {
            "heading" -> {
                consumed += "text"
                consumeRuns(consumed)
                if (this["level"] is JsonNull || optionalIntOrNull("level")?.let { it in 1..3 } == true) {
                    consumed += "level"
                }
            }
            "paragraph", "quote" -> {
                consumed += "text"
                consumeRuns(consumed)
                consumeString(consumed, "guide")
            }
            "table" -> {
                consumed += "data"
                consumeString(consumed, "caption")
                consumeBoolean(consumed, "headerRow")
            }
            "workbook" -> {
                consumed += "data"
                consumeString(consumed, "title")
                val styles = this["styles"] as? JsonObject
                if (this["styles"] is JsonNull || styles != null && styles.values.all { it is JsonObject }) {
                    consumed += "styles"
                }
            }
            "image" -> {
                consumed += "attachmentId"
                consumeString(consumed, "caption")
            }
            "file" -> {
                consumed += "attachmentId"
                consumeString(consumed, "label")
            }
            "checklist" -> consumed += "items"
            "list" -> {
                consumed += "items"
                if (this["style"] is JsonNull || NoteListStyle.fromDriveValue(optionalStringOrNull("style")) != null) {
                    consumed += "style"
                }
            }
            "divider" -> Unit
        }
        return withoutKeys(consumed)
    }

    private fun JsonObject.runPassthrough(): JsonObject {
        val consumed = mutableSetOf("text")
        listOf("bold", "italic", "underline", "superscript", "subscript").forEach {
            consumeBoolean(consumed, it)
        }
        if (this["font"] is JsonNull || NoteTextFont.fromDriveValue(optionalStringOrNull("font")) != null) {
            consumed += "font"
        }
        if (this["fontSize"] is JsonNull || optionalIntOrNull("fontSize")?.let(supportedFontSizes::contains) == true) {
            consumed += "fontSize"
        }
        consumeString(consumed, "color")
        consumeString(consumed, "highlight")
        return withoutKeys(consumed)
    }

    private fun JsonObject.itemPassthrough(checklist: Boolean): JsonObject {
        val consumed = mutableSetOf("id", "text")
        if (checklist) consumed += "done"
        consumeRuns(consumed)
        consumeString(consumed, "guide")
        if (this["timerMinutes"] is JsonNull || optionalNumberOrNull("timerMinutes") != null) {
            consumed += "timerMinutes"
        }
        return withoutKeys(consumed)
    }

    private fun JsonObject.workbookStylePassthrough(): JsonObject {
        val consumed = mutableSetOf<String>()
        listOf("bold", "italic", "underline").forEach { consumeBoolean(consumed, it) }
        if (this["align"] is JsonNull || WorkbookAlignment.fromDriveValue(optionalStringOrNull("align")) != null) {
            consumed += "align"
        }
        return withoutKeys(consumed)
    }

    private fun JsonObject.consumeString(consumed: MutableSet<String>, key: String) {
        if (this[key] is JsonNull || (this[key] as? JsonPrimitive)?.isString == true) consumed += key
    }

    private fun JsonObject.consumeBoolean(consumed: MutableSet<String>, key: String) {
        if (this[key] is JsonNull || optionalBooleanOrNull(key) != null) consumed += key
    }

    private fun JsonObject.consumeRuns(consumed: MutableSet<String>) {
        if (this["runs"] is JsonNull || this["runs"] is JsonArray) consumed += "runs"
    }

    private fun JsonObject.withoutKeys(keys: Set<String>): JsonObject =
        JsonObject(filterKeys { it !in keys })

    private fun JsonElement.requireFiniteNumbers(label: String) {
        when (this) {
            is JsonArray -> forEachIndexed { index, value ->
                value.requireFiniteNumbers("$label[$index]")
            }
            is JsonObject -> forEach { (key, value) ->
                value.requireFiniteNumbers("$label.$key")
            }
            is JsonPrimitive -> if (!isString) {
                doubleOrNull?.let { number ->
                    require(number.isFinite()) { "$label must contain a finite JSON number." }
                }
            }
        }
    }

    private fun encodeRuns(runs: List<NoteTextRun>): JsonArray = JsonArray(runs.map { run ->
        buildJsonObject {
            putSource(run.source)
            put("text", run.text)
            run.bold?.let { put("bold", it) }
            run.italic?.let { put("italic", it) }
            run.underline?.let { put("underline", it) }
            run.superscript?.let { put("superscript", it) }
            run.subscript?.let { put("subscript", it) }
            run.font?.let { put("font", it.driveValue) }
            run.fontSize?.let { put("fontSize", it) }
            run.color?.let { put("color", it) }
            run.highlight?.let { put("highlight", it) }
        }
    })

    private fun encodeMatrix(rows: List<List<String>>): JsonArray =
        JsonArray(rows.map { row -> JsonArray(row.map(::JsonPrimitive)) })

    private fun encodeWorkbookStyle(style: NativeWorkbookCellStyle): JsonObject = buildJsonObject {
        putSource(style.source)
        style.bold?.let { put("bold", it) }
        style.italic?.let { put("italic", it) }
        style.underline?.let { put("underline", it) }
        style.align?.let { put("align", it.driveValue) }
    }

    private fun encodeChecklistItem(item: NativeChecklistItem): JsonObject = buildJsonObject {
        putSource(item.source)
        put("id", item.id)
        put("text", item.text)
        put("done", item.done)
        item.timerMinutes?.let { timerMinutes ->
            val encodedTimer = if (
                timerMinutes >= Long.MIN_VALUE.toDouble() &&
                timerMinutes < Long.MAX_VALUE.toDouble() &&
                timerMinutes % 1.0 == 0.0
            ) {
                JsonPrimitive(timerMinutes.toLong())
            } else {
                JsonPrimitive(timerMinutes)
            }
            put("timerMinutes", encodedTimer)
        }
        item.runs?.let { put("runs", encodeRuns(it)) }
        item.guide?.let { put("guide", it) }
    }

    private fun encodeListItem(item: NativeListItem): JsonObject = buildJsonObject {
        putSource(item.source)
        put("id", item.id)
        put("text", item.text)
        item.runs?.let { put("runs", encodeRuns(it)) }
        item.guide?.let { put("guide", it) }
    }

    private fun JsonObjectBuilder.putMetadata(metadata: NoteBlockMetadata) {
        put("id", metadata.id)
        metadata.updatedAt?.let { put("updatedAt", it) }
        metadata.updatedBy?.let { put("updatedBy", it) }
        metadata.locked?.let { put("locked", it) }
        metadata.align?.let { put("align", it.driveValue) }
    }

    private fun JsonObjectBuilder.putSource(source: JsonObject) {
        source.forEach { (key, value) -> put(key, value) }
    }

    private fun validateForEncode(block: NativeNoteBlock, index: Int) {
        require(!block.metadata.id.isDriveV1Blank()) { "Note content[$index].id is required." }
        requireSourceIdentity(
            hasPassthrough = block.hasPassthrough(),
            sourceId = block.metadata.sourceId,
            currentId = block.metadata.id,
            label = "Note content[$index]",
        )
        when (block) {
            is NativeNoteBlock.Heading -> {
                block.level?.let { require(it in 1..3) { "Note content[$index].level is invalid." } }
                validateRuns(block.runs, "Note content[$index].runs")
            }
            is NativeNoteBlock.Paragraph -> validateRuns(block.runs, "Note content[$index].runs")
            is NativeNoteBlock.Table -> Unit
            is NativeNoteBlock.Workbook -> block.styles?.forEach { (key, style) ->
                validateWorkbookStyle(style, "Note content[$index].styles[$key]")
            }
            is NativeNoteBlock.Image -> require(!block.attachmentId.isDriveV1Blank()) {
                "Note content[$index].attachmentId is required."
            }
            is NativeNoteBlock.File -> require(!block.attachmentId.isDriveV1Blank()) {
                "Note content[$index].attachmentId is required."
            }
            is NativeNoteBlock.Checklist -> block.items.forEachIndexed { itemIndex, item ->
                require(!item.id.isDriveV1Blank()) { "Note content[$index].items[$itemIndex].id is required." }
                requireSourceIdentity(
                    hasPassthrough = item.hasPassthrough(),
                    sourceId = item.sourceId,
                    currentId = item.id,
                    label = "Note content[$index].items[$itemIndex]",
                )
                item.timerMinutes?.let { require(it.isFinite()) {
                    "Note content[$index].items[$itemIndex].timerMinutes is invalid."
                } }
                validateRuns(item.runs, "Note content[$index].items[$itemIndex].runs")
            }.also { requireUniqueIds(block.items.map { it.id }, "Note content[$index] checklist item ids") }
            is NativeNoteBlock.ListBlock -> block.items.forEachIndexed { itemIndex, item ->
                require(!item.id.isDriveV1Blank()) { "Note content[$index].items[$itemIndex].id is required." }
                requireSourceIdentity(
                    hasPassthrough = item.hasPassthrough(),
                    sourceId = item.sourceId,
                    currentId = item.id,
                    label = "Note content[$index].items[$itemIndex]",
                )
                validateRuns(item.runs, "Note content[$index].items[$itemIndex].runs")
            }.also { requireUniqueIds(block.items.map { it.id }, "Note content[$index] list item ids") }
            is NativeNoteBlock.Quote -> validateRuns(block.runs, "Note content[$index].runs")
            is NativeNoteBlock.Divider -> Unit
        }
    }

    private fun requireSourceIdentity(
        hasPassthrough: Boolean,
        sourceId: String?,
        currentId: String,
        label: String,
    ) {
        require(!hasPassthrough || sourceId == currentId) {
            "$label passthrough fields belong to a different stable id."
        }
    }

    private fun NativeNoteBlock.hasPassthrough(): Boolean = metadata.source.isNotEmpty() || when (this) {
        is NativeNoteBlock.Heading -> runs.hasPassthrough()
        is NativeNoteBlock.Paragraph -> runs.hasPassthrough()
        is NativeNoteBlock.Table -> false
        is NativeNoteBlock.Workbook -> styles.orEmpty().values.any { it.source.isNotEmpty() }
        is NativeNoteBlock.Image -> false
        is NativeNoteBlock.File -> false
        is NativeNoteBlock.Checklist -> items.any { it.hasPassthrough() }
        is NativeNoteBlock.ListBlock -> items.any { it.hasPassthrough() }
        is NativeNoteBlock.Quote -> runs.hasPassthrough()
        is NativeNoteBlock.Divider -> false
    }

    private fun NativeChecklistItem.hasPassthrough(): Boolean =
        source.isNotEmpty() || runs.hasPassthrough()

    private fun NativeListItem.hasPassthrough(): Boolean =
        source.isNotEmpty() || runs.hasPassthrough()

    private fun List<NoteTextRun>?.hasPassthrough(): Boolean =
        orEmpty().any { it.source.isNotEmpty() }

    private fun requireUniqueIds(ids: List<String>, label: String) {
        require(ids.size == ids.toSet().size) { "$label must be unique." }
    }

    private fun validateRuns(runs: List<NoteTextRun>?, label: String) {
        runs.orEmpty().forEachIndexed { runIndex, run ->
            run.fontSize?.let { require(it in supportedFontSizes) {
                "$label[$runIndex].fontSize is invalid."
            } }
        }
    }

    private fun validateWorkbookStyle(style: NativeWorkbookCellStyle, label: String) {
        style.align?.driveValue ?: return
        require(style.align in setOf(WorkbookAlignment.Left, WorkbookAlignment.Center, WorkbookAlignment.Right)) {
            "$label.align is invalid."
        }
    }

    private fun JsonObject.array(key: String, blockIndex: Int): JsonArray =
        this[key] as? JsonArray
            ?: throw IllegalArgumentException("Note content[$blockIndex].$key must be an array.")

    private fun JsonObject.requiredString(key: String, label: String): String =
        requiredStringValue(key, label).also {
            require(!it.isDriveV1Blank()) { "$label is required." }
        }

    private fun JsonObject.requiredStringValue(key: String, label: String): String {
        val value = this[key] as? JsonPrimitive
        require(value?.isString == true) { "$label must be a string." }
        return value.content
    }

    private fun JsonObject.optionalStringOrNull(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun JsonObject.optionalBooleanOrNull(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

    private fun JsonObject.requiredBoolean(key: String, label: String): Boolean {
        val value = this[key] as? JsonPrimitive
        return value?.takeUnless { it.isString }?.booleanOrNull
            ?: throw IllegalArgumentException("$label must be a boolean.")
    }

    private fun JsonObject.optionalIntOrNull(key: String): Int? =
        (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull

    private fun JsonObject.optionalNumberOrNull(key: String): Double? =
        (this[key] as? JsonPrimitive)
            ?.takeUnless { it.isString }
            ?.doubleOrNull
            ?.takeIf { it.isFinite() }

    private fun String.isDriveV1Blank(): Boolean = all { character ->
        Character.isWhitespace(character) || Character.isSpaceChar(character) || character == '\uFEFF'
    }
}
