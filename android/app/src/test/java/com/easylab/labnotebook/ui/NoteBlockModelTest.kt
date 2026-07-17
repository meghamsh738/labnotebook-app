package com.easylab.labnotebook.ui

import com.easylab.labnotebook.sync.DriveV1Entry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteBlockModelTest {
    private val json = Json

    @Test
    fun goldenDriveEntryContentRoundTripsThroughNativeModel() {
        val envelope = json.parseToJsonElement(fixture("drive-v1/entries/2026-05-23.json")).jsonObject
        val content = envelope.getValue("payload").jsonObject.getValue("content").jsonArray

        val decoded = NoteBlockCodec.decode(content.toString())
        val encoded = json.parseToJsonElement(NoteBlockCodec.encode(decoded))

        assertEquals(content, encoded)
        val paragraph = decoded.single() as NativeNoteBlock.Paragraph
        assertEquals("block-contract", paragraph.metadata.id)
        assertEquals("Golden contract content", paragraph.text)
        assertEquals(true, paragraph.runs?.single()?.bold)
    }

    @Test
    fun everyDriveV1BlockShapeAndOptionalFieldRoundTrips() {
        val source = json.parseToJsonElement(allBlocksJson)
        val decoded = NoteBlockCodec.decode(allBlocksJson)
        val encoded = json.parseToJsonElement(NoteBlockCodec.encode(decoded))

        assertEquals(source, encoded)
        assertEquals(10, decoded.size)

        val heading = decoded[0] as NativeNoteBlock.Heading
        assertEquals(NoteAlignment.Center, heading.metadata.align)
        assertEquals(NoteTextFont.Display, heading.runs?.single()?.font)
        assertEquals(24, heading.runs?.single()?.fontSize)

        val workbook = decoded[3] as NativeNoteBlock.Workbook
        assertEquals(WorkbookAlignment.Right, workbook.styles?.get("1:1")?.align)

        val checklist = decoded[6] as NativeNoteBlock.Checklist
        assertEquals(5.0, checklist.items.single().timerMinutes)
        assertTrue(checklist.items.single().done)

        val list = decoded[7] as NativeNoteBlock.ListBlock
        assertEquals(NoteListStyle.Arrow, list.style)
    }

    @Test
    fun malformedOrUnsupportedBlocksFailClosed() {
        listOf(
            """[{"id":"","type":"paragraph","text":"Missing id"}]""",
            """[{"id":"${'\uFEFF'}","type":"paragraph","text":"Missing id"}]""",
            """[{"id":"bad","type":"unknown"}]""",
            """[{"id":"bad","type":"checklist","items":[{"id":"item","text":"Run"}]}]""",
            """[{"id":"bad","type":"checklist","items":[{"id":"item","text":"Run","done":"false"}]}]""",
            """[{"id":"bad","type":"table","data":[["valid",3]]}]""",
            """[{"id":"bad","type":"paragraph","text":"Text","runs":"not-an-array"}]""",
        ).forEach { malformed ->
            assertTrue("Expected decode to fail for $malformed", runCatching { NoteBlockCodec.decode(malformed) }.isFailure)
        }
    }

    @Test
    fun unknownAndUnsupportedOptionalFieldsRoundTripLosslessly() {
        val source = json.parseToJsonElement(losslessFieldsJson)
        val decoded = NoteBlockCodec.decode(losslessFieldsJson)
        val encoded = json.parseToJsonElement(NoteBlockCodec.encode(decoded))

        assertEquals(source, encoded)

        val heading = decoded[0] as NativeNoteBlock.Heading
        assertEquals(null, heading.level)
        assertEquals(null, heading.metadata.align)
        assertEquals(null, heading.runs?.single()?.fontSize)
        assertEquals(null, heading.runs?.single()?.font)

        val workbook = decoded[1] as NativeNoteBlock.Workbook
        assertEquals(null, workbook.styles?.get("0:0")?.align)

        val checklist = decoded[2] as NativeNoteBlock.Checklist
        assertEquals(2.5, checklist.items.single().timerMinutes)
    }

    @Test
    fun encoderRejectsInvalidConstructedModels() {
        val invalidBlocks = listOf(
            NativeNoteBlock.Heading(NoteBlockMetadata(""), text = "Heading"),
            NativeNoteBlock.Heading(NoteBlockMetadata("heading"), text = "Heading", level = 4),
            NativeNoteBlock.Paragraph(
                NoteBlockMetadata("paragraph"),
                text = "Text",
                runs = listOf(NoteTextRun(text = "Text", fontSize = 15)),
            ),
            NativeNoteBlock.Image(NoteBlockMetadata("image"), attachmentId = ""),
            NativeNoteBlock.Checklist(
                NoteBlockMetadata("checklist"),
                items = listOf(NativeChecklistItem(id = "", text = "Run", done = false)),
            ),
            NativeNoteBlock.Checklist(
                NoteBlockMetadata("timer"),
                items = listOf(
                    NativeChecklistItem(id = "item", text = "Run", done = false, timerMinutes = Double.POSITIVE_INFINITY),
                ),
            ),
        )

        invalidBlocks.forEach { invalid ->
            assertTrue("Expected encode to reject $invalid", runCatching { NoteBlockCodec.encode(listOf(invalid)) }.isFailure)
        }
        assertTrue(
            runCatching {
                NoteBlockCodec.encode(
                    listOf(
                        NativeNoteBlock.Paragraph(
                            metadata = NoteBlockMetadata(
                                id = "non-finite-source",
                                source = buildJsonObject {
                                    put("futureNumber", JsonPrimitive(Double.NaN))
                                },
                            ),
                            text = "Observation",
                        ),
                    ),
                )
            }.isFailure,
        )
    }

    @Test
    fun constructedNativeModelsEncodeToContentTheDecoderAccepts() {
        val blocks = listOf(
            NativeNoteBlock.Paragraph(
                metadata = NoteBlockMetadata("paragraph"),
                text = "Observation",
                runs = listOf(NoteTextRun(text = "Observation", fontSize = 16)),
            ),
            NativeNoteBlock.Checklist(
                metadata = NoteBlockMetadata("checklist"),
                items = listOf(
                    NativeChecklistItem(id = "item", text = "Incubate", done = false, timerMinutes = 2.5),
                ),
            ),
        )

        val decoded = NoteBlockCodec.decode(NoteBlockCodec.encode(blocks))

        assertEquals(2, decoded.size)
        assertEquals(16, (decoded[0] as NativeNoteBlock.Paragraph).runs?.single()?.fontSize)
        assertEquals(2.5, (decoded[1] as NativeNoteBlock.Checklist).items.single().timerMinutes)
    }

    @Test
    fun clearingKnownOptionalFieldsDoesNotResurrectSourceValues() {
        val decoded = NoteBlockCodec.decode(allBlocksJson).toMutableList()
        val heading = decoded[0] as NativeNoteBlock.Heading
        decoded[0] = heading.copy(
            metadata = heading.metadata.copy(updatedAt = null, align = null),
            level = null,
            runs = heading.runs?.map {
                it.copy(bold = null, font = null, fontSize = null, color = null)
            },
        )
        val checklist = decoded[6] as NativeNoteBlock.Checklist
        decoded[6] = checklist.copy(
            items = checklist.items.map {
                it.copy(timerMinutes = null, guide = null, runs = it.runs?.map { run -> run.copy(bold = null) })
            },
        )

        val encoded = json.parseToJsonElement(NoteBlockCodec.encode(decoded)).jsonArray
        val encodedHeading = encoded[0].jsonObject
        val encodedHeadingRun = encodedHeading.getValue("runs").jsonArray.single().jsonObject
        val encodedChecklistItem = encoded[6].jsonObject.getValue("items").jsonArray.single().jsonObject

        listOf("updatedAt", "align", "level").forEach { assertFalse(encodedHeading.containsKey(it)) }
        listOf("bold", "font", "fontSize", "color").forEach { assertFalse(encodedHeadingRun.containsKey(it)) }
        listOf("timerMinutes", "guide").forEach { assertFalse(encodedChecklistItem.containsKey(it)) }
        assertFalse(
            encodedChecklistItem.getValue("runs").jsonArray.single().jsonObject.containsKey("bold"),
        )
    }

    @Test
    fun malformedOptionalTypesAcceptedByDriveV1RoundTripLosslessly() {
        val source = json.parseToJsonElement(malformedOptionalFieldsJson)
        val decoded = NoteBlockCodec.decode(malformedOptionalFieldsJson)
        val encoded = json.parseToJsonElement(NoteBlockCodec.encode(decoded))

        assertEquals(source, encoded)
    }

    @Test
    fun encodedNativeBlocksPassIndependentDriveV1Validation() {
        val encoded = json.parseToJsonElement(
            NoteBlockCodec.encode(NoteBlockCodec.decode(allBlocksJson)),
        ).jsonArray

        DriveV1Entry(
            id = "entry-native-contract",
            createdDatetime = "2026-07-16T10:00:00Z",
            lastEditedDatetime = "2026-07-16T10:00:00Z",
            authorId = "subject-contract",
            title = "Native contract",
            dateBucket = "2026-07-16",
            content = encoded.toList(),
            tags = emptyList(),
            searchTerms = emptyList(),
            linkedFiles = emptyList(),
            pinnedRegions = emptyList(),
        ).requireV1()
    }

    @Test
    fun duplicateBlockAndItemIdsFailClosed() {
        val duplicateBlocks = """[
            {"id":"duplicate","type":"paragraph","text":"First"},
            {"id":"duplicate","type":"paragraph","text":"Second"}
        ]""".trimIndent()
        val duplicateItems = """[
            {
                "id":"checklist",
                "type":"checklist",
                "items":[
                    {"id":"duplicate","text":"First","done":false},
                    {"id":"duplicate","text":"Second","done":true}
                ]
            }
        ]""".trimIndent()

        assertTrue(runCatching { NoteBlockCodec.decode(duplicateBlocks) }.isFailure)
        assertTrue(runCatching { NoteBlockCodec.decode(duplicateItems) }.isFailure)
        assertTrue(
            runCatching {
                NoteBlockCodec.encode(
                    listOf(
                        NativeNoteBlock.Paragraph(NoteBlockMetadata("duplicate"), "First"),
                        NativeNoteBlock.Paragraph(NoteBlockMetadata("duplicate"), "Second"),
                    ),
                )
            }.isFailure,
        )
        assertTrue(
            runCatching {
                NoteBlockCodec.encode(
                    listOf(
                        NativeNoteBlock.Checklist(
                            NoteBlockMetadata("checklist"),
                            listOf(
                                NativeChecklistItem("duplicate", "First", false),
                                NativeChecklistItem("duplicate", "Second", true),
                            ),
                        ),
                    ),
                )
            }.isFailure,
        )
    }

    @Test
    fun passthroughFieldsCannotMoveToReidentifiedBlocksOrItems() {
        val paragraph = NoteBlockCodec.decode(
            """[{"id":"paragraph-old","type":"paragraph","text":"Observation","futureBlock":{"v":2}}]""",
        ).single() as NativeNoteBlock.Paragraph
        val checklist = NoteBlockCodec.decode(
            """[{
                "id":"checklist",
                "type":"checklist",
                "items":[{"id":"item-old","text":"Run","done":false,"futureItem":{"v":2}}]
            }]""".trimIndent(),
        ).single() as NativeNoteBlock.Checklist

        assertTrue(
            runCatching {
                NoteBlockCodec.encode(
                    listOf(paragraph.copy(metadata = paragraph.metadata.copy(id = "paragraph-new"))),
                )
            }.isFailure,
        )
        assertTrue(
            runCatching {
                NoteBlockCodec.encode(
                    listOf(
                        checklist.copy(
                            items = checklist.items.map { it.copy(id = "item-new") },
                        ),
                    ),
                )
            }.isFailure,
        )

        val plainParagraph = NoteBlockCodec.decode(
            """[{"id":"plain-old","type":"paragraph","text":"Observation"}]""",
        ).single() as NativeNoteBlock.Paragraph
        val reidentified = plainParagraph.copy(metadata = plainParagraph.metadata.copy(id = "plain-new"))
        val encoded = json.parseToJsonElement(NoteBlockCodec.encode(listOf(reidentified))).jsonArray.single().jsonObject
        assertEquals("plain-new", (encoded.getValue("id") as JsonPrimitive).content)
    }

    @Test
    fun nestedPassthroughFieldsCannotMoveToReidentifiedOwners() {
        val paragraph = NoteBlockCodec.decode(
            """[{
                "id":"paragraph-old",
                "type":"paragraph",
                "text":"Observation",
                "runs":[{"text":"Observation","futureRun":{"v":2}}]
            }]""".trimIndent(),
        ).single() as NativeNoteBlock.Paragraph
        val checklist = NoteBlockCodec.decode(
            """[{
                "id":"checklist",
                "type":"checklist",
                "items":[{
                    "id":"check-old",
                    "text":"Run",
                    "done":false,
                    "runs":[{"text":"Run","futureRun":{"v":2}}]
                }]
            }]""".trimIndent(),
        ).single() as NativeNoteBlock.Checklist
        val list = NoteBlockCodec.decode(
            """[{
                "id":"list",
                "type":"list",
                "items":[{
                    "id":"list-old",
                    "text":"Collect",
                    "runs":[{"text":"Collect","futureRun":{"v":2}}]
                }]
            }]""".trimIndent(),
        ).single() as NativeNoteBlock.ListBlock
        val workbook = NoteBlockCodec.decode(
            """[{
                "id":"workbook-old",
                "type":"workbook",
                "data":[["Dose"]],
                "styles":{"0:0":{"futureStyle":{"v":2}}}
            }]""".trimIndent(),
        ).single() as NativeNoteBlock.Workbook

        val reidentifiedModels = listOf(
            paragraph.copy(metadata = paragraph.metadata.copy(id = "paragraph-new")),
            checklist.copy(items = checklist.items.map { it.copy(id = "check-new") }),
            list.copy(items = list.items.map { it.copy(id = "list-new") }),
            workbook.copy(metadata = workbook.metadata.copy(id = "workbook-new")),
        )

        reidentifiedModels.forEach { reidentified ->
            assertTrue(
                "Expected nested passthrough ownership to reject $reidentified",
                runCatching { NoteBlockCodec.encode(listOf(reidentified)) }.isFailure,
            )
        }
    }

    @Test
    fun explicitNullKnownOptionalsAreCanonicalizedWhileUnknownNullsSurvive() {
        val raw = """[
            {
                "id":"paragraph",
                "type":"paragraph",
                "updatedAt":null,
                "locked":null,
                "align":null,
                "text":"Observation",
                "runs":null,
                "guide":null,
                "futureBlock":null
            },
            {
                "id":"checklist",
                "type":"checklist",
                "items":[{
                    "id":"item",
                    "text":"Run",
                    "done":false,
                    "timerMinutes":null,
                    "runs":null,
                    "guide":null,
                    "futureItem":null
                }]
            },
            {
                "id":"workbook",
                "type":"workbook",
                "data":[["Value"]],
                "title":null,
                "styles":null,
                "futureWorkbook":null
            }
        ]""".trimIndent()

        val encoded = json.parseToJsonElement(NoteBlockCodec.encode(NoteBlockCodec.decode(raw))).jsonArray
        val paragraph = encoded[0].jsonObject
        listOf("updatedAt", "locked", "align", "runs", "guide").forEach {
            assertFalse(paragraph.containsKey(it))
        }
        assertEquals(JsonNull, paragraph["futureBlock"])

        val item = encoded[1].jsonObject.getValue("items").jsonArray.single().jsonObject
        listOf("timerMinutes", "runs", "guide").forEach { assertFalse(item.containsKey(it)) }
        assertEquals(JsonNull, item["futureItem"])

        val workbook = encoded[2].jsonObject
        listOf("title", "styles").forEach { assertFalse(workbook.containsKey(it)) }
        assertEquals(JsonNull, workbook["futureWorkbook"])
    }

    private fun fixture(path: String): String =
        checkNotNull(javaClass.classLoader?.getResource(path)) { "Missing fixture $path" }.readText()

    private companion object {
        val allBlocksJson = """
            [
              {
                "id":"heading",
                "type":"heading",
                "updatedAt":"2026-07-16T10:00:00Z",
                "updatedBy":"pixel-1",
                "locked":false,
                "align":"center",
                "text":"Aim",
                "level":2,
                "runs":[
                  {
                    "text":"Aim",
                    "bold":true,
                    "italic":false,
                    "underline":true,
                    "superscript":false,
                    "subscript":false,
                    "font":"display",
                    "fontSize":24,
                    "color":"#18211D",
                    "highlight":"#FFFDF8"
                  }
                ]
              },
              {
                "id":"paragraph",
                "type":"paragraph",
                "text":"Measure viability.",
                "runs":[],
                "guide":"Record the biological question."
              },
              {
                "id":"table",
                "type":"table",
                "data":[["Sample","Group"],["MG-01","Vehicle"]],
                "caption":"Sample assignment",
                "headerRow":true
              },
              {
                "id":"workbook",
                "type":"workbook",
                "data":[["Dose","Viability"],["10","94%"]],
                "title":"Dose response",
                "styles":{
                  "0:0":{"bold":true,"italic":false,"underline":false,"align":"left"},
                  "1:1":{"align":"right"}
                }
              },
              {
                "id":"image",
                "type":"image",
                "attachmentId":"image-1",
                "caption":"Iba1 staining"
              },
              {
                "id":"file",
                "type":"file",
                "attachmentId":"file-1",
                "label":"Instrument export"
              },
              {
                "id":"checklist",
                "type":"checklist",
                "items":[
                  {
                    "id":"check-1",
                    "text":"Confirm viability",
                    "done":true,
                    "timerMinutes":5,
                    "runs":[{"text":"Confirm","bold":true}],
                    "guide":"Record exclusions."
                  }
                ]
              },
              {
                "id":"list",
                "type":"list",
                "style":"arrow",
                "items":[
                  {
                    "id":"item-1",
                    "text":"Collect supernatant",
                    "runs":[{"text":"Collect","underline":true}],
                    "guide":"Keep on ice."
                  }
                ]
              },
              {
                "id":"quote",
                "type":"quote",
                "text":"Unexpected morphology observed.",
                "runs":[{"text":"Unexpected","italic":true}],
                "guide":"Add an interpretation."
              },
              {
                "id":"divider",
                "type":"divider"
              }
            ]
        """.trimIndent()

        val losslessFieldsJson = """
            [
              {
                "id":"heading",
                "type":"heading",
                "align":"future-align",
                "text":"Aim",
                "level":4,
                "futureBlock":{"version":2},
                "runs":[
                  {
                    "text":"Aim",
                    "font":"future-font",
                    "fontSize":15,
                    "futureRun":true
                  }
                ]
              },
              {
                "id":"workbook",
                "type":"workbook",
                "data":[["Dose"]],
                "styles":{
                  "0:0":{"align":"baseline","futureStyle":"kept"}
                }
              },
              {
                "id":"checklist",
                "type":"checklist",
                "items":[
                  {
                    "id":"item",
                    "text":"Incubate",
                    "done":false,
                    "timerMinutes":2.5,
                    "futureItem":["kept"]
                  }
                ]
              }
            ]
        """.trimIndent()

        val malformedOptionalFieldsJson = """
            [
              {
                "id":"paragraph",
                "type":"paragraph",
                "updatedAt":42,
                "locked":"false",
                "align":{"future":"center"},
                "text":"Observation",
                "guide":false,
                "runs":[
                  {
                    "text":"Observation",
                    "bold":"false",
                    "fontSize":"16",
                    "color":{"space":"lab"}
                  }
                ]
              },
              {
                "id":"workbook",
                "type":"workbook",
                "data":[["Dose"]],
                "styles":{
                  "0:0":{"bold":"yes","align":{"future":"right"}}
                }
              },
              {
                "id":"checklist",
                "type":"checklist",
                "items":[
                  {
                    "id":"item",
                    "text":"Incubate",
                    "done":false,
                    "timerMinutes":"5",
                    "guide":true
                  }
                ]
              }
            ]
        """.trimIndent()
    }
}
