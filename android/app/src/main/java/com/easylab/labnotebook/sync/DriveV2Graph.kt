package com.easylab.labnotebook.sync

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

internal object DriveV2Contract {
    const val PROTOCOL = "easylab-drive-v2-append-only"
    const val SCHEMA_VERSION = 2
    const val ROOT_NAME = "Easylab Lab Notebook v2"
    const val FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
    const val JSON_MIME_TYPE = "application/json"
    val MANAGED_FOLDER_ROLES = setOf("objects", "blobs", "commits")
    val WORKSPACE_ID = Regex("^ws-v2-[0-9a-f]{32}$")
    val SHA256 = Regex("^[0-9a-f]{64}$")

    fun objectId(body: JsonObject): String = "obj-v2-${DriveV2CanonicalJson.sha256(body)}"
    fun commitId(body: JsonObject): String = "commit-v2-${DriveV2CanonicalJson.sha256(body)}"
    fun blobId(bytes: ByteArray): String = "blob-v2-${DriveV2CanonicalJson.sha256(bytes)}"

    fun objectPath(id: String): String = "objects/$id.json"
    fun commitPath(id: String): String = "commits/$id.json"
    fun blobPath(id: String): String = "blobs/$id.bin"

    fun appProperties(
        workspaceId: String,
        kind: String,
        canonicalId: String,
        contentSha256: String,
    ): Map<String, String> = sortedMapOf(
        "easylabArtifactKind" to kind,
        "easylabCanonicalId" to canonicalId,
        "easylabContentSha256" to contentSha256,
        "easylabDriveProtocol" to "v2-append-only",
        "easylabWorkspaceId" to workspaceId,
    )
}

internal data class DriveV2ObjectRecord(
    val expectedId: String,
    val body: JsonObject,
)

internal data class DriveV2CommitRecord(
    val expectedId: String,
    val body: JsonObject,
)

internal class DriveV2BlobRecord(
    val expectedId: String,
    bytes: ByteArray,
    val mimeType: String,
) {
    private val contentBytes: ByteArray = bytes.copyOf()
    val bytes: ByteArray get() = contentBytes.copyOf()

    override fun equals(other: Any?): Boolean =
        other is DriveV2BlobRecord &&
            expectedId == other.expectedId &&
            contentBytes.contentEquals(other.contentBytes) &&
            mimeType == other.mimeType

    override fun hashCode(): Int =
        31 * (31 * expectedId.hashCode() + contentBytes.contentHashCode()) + mimeType.hashCode()
}

internal class DriveV2WorkspaceState(
    tips: Collection<String>,
    frontiers: Map<String, List<String>>,
    objectMap: Map<String, DriveV2ObjectRecord>,
    visibleCommitIds: Collection<String>,
    visibleObjectIds: Collection<String>,
) {
    val tips: List<String> = immutableGraphList(tips)
    val frontiers: Map<String, List<String>> = immutableGraphMap(
        frontiers.mapValues { (_, ids) -> immutableGraphList(ids) },
    )
    val objectMap: Map<String, DriveV2ObjectRecord> = immutableGraphMap(objectMap)
    val visibleCommitIds: List<String> = immutableGraphList(visibleCommitIds)
    val visibleObjectIds: List<String> = immutableGraphList(visibleObjectIds)
}

internal data class DriveV2FrontierDecision(
    val decision: String,
    val visible: Boolean,
    val conflictId: String?,
)

internal data class DriveV2Projection(
    val classifications: Map<String, DriveV2FrontierDecision>,
    val visibleTargets: List<String>,
    val suppressedTargets: List<String>,
)

internal object DriveV2GraphValidator {
    private val objectFields = setOf(
        "baseObjectIds",
        "blobIds",
        "entityId",
        "entityKind",
        "operation",
        "payload",
        "protocol",
        "resolutionOf",
        "schemaVersion",
        "tombstone",
        "workspaceId",
    )
    private val commitFields = setOf(
        "blobIds",
        "createdAt",
        "objectIds",
        "operationId",
        "parentCommitIds",
        "protocol",
        "schemaVersion",
        "workspaceId",
    )
    private val requiredParentLinks = mapOf(
        "entry" to emptyList(),
        "attachment" to listOf("entryId"),
        "fileBoxItem" to listOf("entryId", "attachmentId"),
        "transfer" to listOf("entryId", "attachmentId", "fileBoxItemId"),
    )
    private val operations = setOf("upsert", "tombstone", "resolve-upsert", "resolve-tombstone")
    private val canonicalUtc = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")

    fun validateObject(record: DriveV2ObjectRecord, workspaceId: String = record.body.text("workspaceId")): String {
        val body = record.body
        requireExactFields(body, objectFields)
        requireArtifactNumberDomain(body)
        require(body.text("protocol") == DriveV2Contract.PROTOCOL, "artifact-schema-mismatch")
        require(body.int("schemaVersion") == DriveV2Contract.SCHEMA_VERSION, "artifact-schema-mismatch")
        requireWorkspace(body.text("workspaceId"), workspaceId)
        val entityKind = body.nonBlankText("entityKind")
        body.nonBlankText("entityId")
        val operation = body.text("operation")
        require(operation in operations, "artifact-schema-mismatch")
        requireSortedUnique(body.stringList("baseObjectIds"))
        requireSortedUnique(body.stringList("blobIds"))
        requireSortedUnique(body.stringList("resolutionOf"))

        val isUpsert = operation == "upsert" || operation == "resolve-upsert"
        if (isUpsert) {
            val payload = body["payload"] as? JsonObject ?: fail("artifact-schema-mismatch")
            require(body["tombstone"] is JsonNull, "artifact-schema-mismatch")
            for (field in requiredParentLinks[entityKind].orEmpty()) payload.nonBlankText(field, "missing-parent-linkage")
        } else {
            require(body["payload"] is JsonNull, "artifact-schema-mismatch")
            val tombstone = body["tombstone"] as? JsonObject ?: fail("artifact-schema-mismatch")
            requireExactFields(tombstone, setOf("deletedAt", "deletedByDeviceId"))
            requireCanonicalUtc(tombstone.text("deletedAt"))
            tombstone.nonBlankText("deletedByDeviceId")
        }

        val bases = body.stringList("baseObjectIds")
        val resolution = body.stringList("resolutionOf")
        if (operation.startsWith("resolve-")) {
            require(resolution.isNotEmpty() && resolution == bases, "incomplete-resolution-frontier")
        } else {
            require(resolution.isEmpty(), "artifact-schema-mismatch")
        }

        require(record.expectedId == DriveV2Contract.objectId(body), "canonical-id-mismatch")
        return record.expectedId
    }

    fun validateCommit(record: DriveV2CommitRecord, workspaceId: String = record.body.text("workspaceId")): String {
        val body = record.body
        requireExactFields(body, commitFields)
        requireArtifactNumberDomain(body)
        require(body.text("protocol") == DriveV2Contract.PROTOCOL, "artifact-schema-mismatch")
        require(body.int("schemaVersion") == DriveV2Contract.SCHEMA_VERSION, "artifact-schema-mismatch")
        requireWorkspace(body.text("workspaceId"), workspaceId)
        body.nonBlankText("operationId")
        requireCanonicalUtc(body.text("createdAt"))
        requireSortedUnique(body.stringList("parentCommitIds"))
        requireSortedUnique(body.stringList("objectIds"))
        requireSortedUnique(body.stringList("blobIds"))
        require(record.expectedId == DriveV2Contract.commitId(body), "canonical-id-mismatch")
        return record.expectedId
    }

    fun validateWorkspace(
        workspaceId: String,
        objects: List<DriveV2ObjectRecord>,
        blobs: List<DriveV2BlobRecord>,
        commits: List<DriveV2CommitRecord>,
    ): DriveV2WorkspaceState {
        requireWorkspace(workspaceId, workspaceId)
        objects.forEach { validateObject(it, workspaceId) }
        commits.forEach { validateCommit(it, workspaceId) }
        blobs.forEach { blob ->
            require(blob.expectedId == DriveV2Contract.blobId(blob.bytes), "canonical-id-mismatch")
            require(blob.mimeType.isNotBlank(), "artifact-schema-mismatch")
        }
        val objectMap = uniqueMap(objects, DriveV2ObjectRecord::expectedId, "divergent-duplicate")
        val blobMap = uniqueMap(blobs, DriveV2BlobRecord::expectedId, "divergent-duplicate")
        val commitMap = uniqueMap(commits, DriveV2CommitRecord::expectedId, "divergent-duplicate")
        if (commitMap.isEmpty()) {
            return DriveV2WorkspaceState(
                tips = emptyList(),
                frontiers = emptyMap(),
                objectMap = objectMap,
                visibleCommitIds = emptyList(),
                visibleObjectIds = emptyList(),
            )
        }
        val tips = graphTips(commitMap)
        require(commits.count { it.body.stringList("parentCommitIds").isEmpty() } == 1, "multiple-genesis-commits")

        val reachableMemo = mutableMapOf<String, Set<String>>()
        for (commit in commits) {
            val objectIds = commit.body.stringList("objectIds")
            val blobIds = commit.body.stringList("blobIds")
            objectIds.forEach { require(objectMap.containsKey(it), "missing-object-reference") }
            blobIds.forEach { require(blobMap.containsKey(it), "missing-blob-reference") }
            val introduced = objectIds.map(objectMap::getValue)
            require(introduced.map { targetKey(it.body) }.distinct().size == introduced.size, "duplicate-target-in-commit")
            val requiredBlobs = introduced.flatMap { it.body.stringList("blobIds") }.distinct().sorted()
            require(requiredBlobs == blobIds, "commit-blob-reference-mismatch")

            val parentHistory = commit.body.stringList("parentCommitIds")
                .flatMapTo(linkedSetOf()) { reachableObjectIds(it, commitMap, reachableMemo) }
            val parentFrontiers = if (parentHistory.isEmpty()) emptyMap() else frontier(parentHistory, objectMap)
            for (candidate in introduced) {
                val prior = parentFrontiers[targetKey(candidate.body)].orEmpty().map { objectMap.getValue(it) }
                validateTransition(prior, candidate)
            }
            reachableObjectIds(commit.expectedId, commitMap, reachableMemo)
        }

        val reachable = tips.flatMapTo(linkedSetOf()) { reachableObjectIds(it, commitMap, reachableMemo) }
        validateRelationships(reachable, objectMap)
        return DriveV2WorkspaceState(
            tips = tips,
            frontiers = frontier(reachable, objectMap),
            objectMap = objectMap,
            visibleCommitIds = commitMap.keys.sorted(),
            visibleObjectIds = reachable.sorted(),
        )
    }

    fun classify(frontierIds: List<String>, objectMap: Map<String, DriveV2ObjectRecord>): DriveV2FrontierDecision {
        val unique = frontierIds.distinct().sorted()
        require(unique.isNotEmpty(), "missing-object-reference")
        if (unique.size > 1) {
            val target = objectMap.getValue(unique.first()).body
            return DriveV2FrontierDecision(
                decision = "deterministic-pending-conflict",
                visible = false,
                conflictId = deterministicConflictId(target, unique),
            )
        }
        val operation = objectMap.getValue(unique.single()).body.text("operation")
        val deleted = operation == "tombstone" || operation == "resolve-tombstone"
        return DriveV2FrontierDecision(
            decision = if (deleted) "deleted" else "live",
            visible = !deleted,
            conflictId = null,
        )
    }

    fun project(state: DriveV2WorkspaceState): DriveV2Projection {
        val classifications = state.frontiers.mapValues { (_, ids) -> classify(ids, state.objectMap) }
        val visible = classifications.filterValues(DriveV2FrontierDecision::visible).keys.toMutableSet()
        val suppressed = classifications.filterValues { !it.visible }.keys.toMutableSet()
        fun visible(kind: String, id: String?): Boolean = !id.isNullOrBlank() && "$kind:$id" in visible
        var changed: Boolean
        do {
            changed = false
            for (target in visible.toList()) {
                val ids = state.frontiers.getValue(target)
                if (ids.size != 1) continue
                val body = state.objectMap.getValue(ids.single()).body
                val payload = body["payload"] as? JsonObject ?: continue
                val parentsVisible = when (body.text("entityKind")) {
                    "attachment" -> visible("entry", payload.optionalText("entryId"))
                    "fileBoxItem" -> visible("entry", payload.optionalText("entryId")) &&
                        visible("attachment", payload.optionalText("attachmentId"))
                    "transfer" -> visible("entry", payload.optionalText("entryId")) &&
                        visible("attachment", payload.optionalText("attachmentId")) &&
                        visible("fileBoxItem", payload.optionalText("fileBoxItemId"))
                    else -> true
                }
                if (!parentsVisible) {
                    visible -= target
                    suppressed += target
                    changed = true
                }
            }
        } while (changed)
        return DriveV2Projection(
            classifications = classifications.toSortedMap(),
            visibleTargets = visible.sorted(),
            suppressedTargets = suppressed.sorted(),
        )
    }

    fun deterministicConflictId(target: JsonObject, maximalObjectIds: List<String>): String {
        val body = buildJsonObject {
            put("entityId", target.text("entityId"))
            put("entityKind", target.text("entityKind"))
            put(
                "maximalObjectIds",
                buildJsonArray { maximalObjectIds.distinct().sorted().forEach { add(JsonPrimitive(it)) } },
            )
        }
        return "conf-v2-${DriveV2CanonicalJson.sha256(body)}"
    }

    private fun graphTips(commits: Map<String, DriveV2CommitRecord>): List<String> {
        val referenced = mutableSetOf<String>()
        commits.values.forEach { commit ->
            commit.body.stringList("parentCommitIds").forEach { parent ->
                require(commits.containsKey(parent), "missing-commit-parent")
                referenced += parent
            }
        }
        val visiting = mutableSetOf<String>()
        val visited = mutableSetOf<String>()
        fun visit(id: String) {
            if (id in visited) return
            require(id !in visiting, "commit-cycle")
            visiting += id
            commits.getValue(id).body.stringList("parentCommitIds").forEach(::visit)
            visiting -= id
            visited += id
        }
        commits.keys.forEach(::visit)
        return (commits.keys - referenced).sorted()
    }

    private fun reachableObjectIds(
        commitId: String,
        commits: Map<String, DriveV2CommitRecord>,
        memo: MutableMap<String, Set<String>>,
    ): Set<String> = memo.getOrPut(commitId) {
        val commit = commits[commitId] ?: fail("missing-commit-parent")
        buildSet {
            addAll(commit.body.stringList("objectIds"))
            commit.body.stringList("parentCommitIds").forEach { addAll(reachableObjectIds(it, commits, memo)) }
        }
    }

    private fun frontier(
        objectIds: Set<String>,
        objects: Map<String, DriveV2ObjectRecord>,
    ): Map<String, List<String>> {
        val referencedBases = mutableSetOf<String>()
        for (id in objectIds) {
            val record = objects[id] ?: fail("missing-object-reference")
            for (baseId in record.body.stringList("baseObjectIds")) {
                require(baseId in objectIds, "missing-object-base")
                val base = objects[baseId] ?: fail("missing-object-base")
                require(targetKey(base.body) == targetKey(record.body), "cross-target-object-base")
                referencedBases += baseId
            }
        }
        return objectIds.asSequence()
            .filterNot(referencedBases::contains)
            .groupBy { targetKey(objects.getValue(it).body) }
            .mapValues { (_, ids) -> ids.sorted() }
            .toSortedMap()
    }

    private fun validateTransition(parentFrontier: List<DriveV2ObjectRecord>, candidate: DriveV2ObjectRecord) {
        val expected = parentFrontier.map(DriveV2ObjectRecord::expectedId).sorted()
        val actual = candidate.body.stringList("baseObjectIds")
        val operation = candidate.body.text("operation")
        require(actual == expected, if (operation.startsWith("resolve-")) {
            "incomplete-resolution-frontier"
        } else {
            "incomplete-parent-frontier"
        })
        require(parentFrontier.size <= 1 || operation.startsWith("resolve-"), "explicit-resolution-required")
        if (operation.startsWith("resolve-")) {
            require(candidate.body.stringList("resolutionOf") == expected, "incomplete-resolution-frontier")
        }
        if (operation == "upsert") {
            require(parentFrontier.none { it.body.text("operation").endsWith("tombstone") }, "explicit-restore-required")
        }
    }

    private fun validateRelationships(ids: Set<String>, objects: Map<String, DriveV2ObjectRecord>) {
        val byTarget = ids.map(objects::getValue).groupBy { targetKey(it.body) }
        fun requireTarget(kind: String, id: String): List<DriveV2ObjectRecord> {
            val records = byTarget["$kind:$id"] ?: fail("missing-parent-target")
            return records.filter { it.body.text("operation").endsWith("upsert") }
        }
        fun requireLink(records: List<DriveV2ObjectRecord>, field: String, expected: String) {
            require(records.none { it.body["payload"]!!.jsonObject.text(field) != expected }, "inconsistent-parent-linkage")
        }
        ids.map(objects::getValue).forEach { record ->
            val body = record.body
            if (!body.text("operation").endsWith("upsert")) return@forEach
            val payload = body["payload"]!!.jsonObject
            when (body.text("entityKind")) {
                "attachment" -> requireTarget("entry", payload.text("entryId"))
                "fileBoxItem" -> {
                    requireTarget("entry", payload.text("entryId"))
                    requireLink(requireTarget("attachment", payload.text("attachmentId")), "entryId", payload.text("entryId"))
                }
                "transfer" -> {
                    requireTarget("entry", payload.text("entryId"))
                    requireLink(requireTarget("attachment", payload.text("attachmentId")), "entryId", payload.text("entryId"))
                    val fileBox = requireTarget("fileBoxItem", payload.text("fileBoxItemId"))
                    requireLink(fileBox, "entryId", payload.text("entryId"))
                    requireLink(fileBox, "attachmentId", payload.text("attachmentId"))
                }
            }
        }
    }

    private fun targetKey(body: JsonObject): String = "${body.text("entityKind")}:${body.text("entityId")}"

    private fun requireWorkspace(actual: String, expected: String) {
        require(DriveV2Contract.WORKSPACE_ID.matches(actual) && actual == expected, "workspace-marker-switch")
    }

    private fun requireCanonicalUtc(value: String) {
        require(canonicalUtc.matches(value), "noncanonical-utc")
        val year = value.substring(0, 4).toInt()
        val month = value.substring(5, 7).toInt()
        val day = value.substring(8, 10).toInt()
        val hour = value.substring(11, 13).toInt()
        val minute = value.substring(14, 16).toInt()
        val second = value.substring(17, 19).toInt()
        val daysInMonth = when (month) {
            1, 3, 5, 7, 8, 10, 12 -> 31
            4, 6, 9, 11 -> 30
            2 -> if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28
            else -> 0
        }
        require(
            day in 1..daysInMonth && hour in 0..23 && minute in 0..59 && second in 0..59,
            "noncanonical-utc",
        )
    }

    private fun requireSortedUnique(values: List<String>) {
        require(values.all(String::isNotBlank) && values == values.distinct().sorted(), "set-field-not-sorted-unique")
    }

    private fun requireExactFields(value: JsonObject, expected: Set<String>) {
        require(value.keys == expected, "artifact-schema-mismatch")
    }

    private fun requireArtifactNumberDomain(value: JsonElement) {
        when (value) {
            JsonNull -> Unit
            is JsonArray -> value.forEach(::requireArtifactNumberDomain)
            is JsonObject -> value.values.forEach(::requireArtifactNumberDomain)
            is JsonPrimitive -> if (!value.isString && value.booleanOrNull == null) {
                val integer = value.content.toLongOrNull() ?: fail("unsupported-artifact-number")
                require(integer in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER, "unsupported-artifact-number")
            }
        }
    }

    private fun <T> uniqueMap(values: List<T>, id: (T) -> String, code: String): Map<String, T> {
        val output = linkedMapOf<String, T>()
        values.forEach { value -> require(output.put(id(value), value) == null, code) }
        return output
    }

    private fun require(condition: Boolean, code: String) {
        if (!condition) fail(code)
    }

    private fun fail(code: String, cause: Throwable? = null): Nothing = throw DriveV2ContractException(code, cause)

    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}

private fun JsonObject.text(name: String): String {
    val primitive = get(name) as? JsonPrimitive ?: throw DriveV2ContractException("artifact-schema-mismatch")
    if (!primitive.isString) throw DriveV2ContractException("artifact-schema-mismatch")
    return primitive.content
}

private fun <T> immutableGraphList(value: Collection<T>): List<T> =
    java.util.Collections.unmodifiableList(ArrayList(value))

private fun <K, V> immutableGraphMap(value: Map<K, V>): Map<K, V> =
    java.util.Collections.unmodifiableMap(LinkedHashMap(value))

private fun JsonObject.optionalText(name: String): String? {
    val value = get(name) ?: return null
    val primitive = value as? JsonPrimitive ?: throw DriveV2ContractException("artifact-schema-mismatch")
    if (!primitive.isString) throw DriveV2ContractException("artifact-schema-mismatch")
    return primitive.content
}

private fun JsonObject.nonBlankText(name: String, code: String = "artifact-schema-mismatch"): String =
    text(name).also { if (it.isBlank()) throw DriveV2ContractException(code) }

private fun JsonObject.int(name: String): Int {
    val primitive = get(name) as? JsonPrimitive ?: throw DriveV2ContractException("artifact-schema-mismatch")
    if (primitive.isString || primitive.booleanOrNull != null) throw DriveV2ContractException("artifact-schema-mismatch")
    return primitive.content.toIntOrNull() ?: throw DriveV2ContractException("artifact-schema-mismatch")
}

private fun JsonObject.stringList(name: String): List<String> = try {
    getValue(name).jsonArray.map { element ->
        val primitive = element as? JsonPrimitive ?: throw DriveV2ContractException("artifact-schema-mismatch")
        if (!primitive.isString) throw DriveV2ContractException("artifact-schema-mismatch")
        primitive.content
    }
} catch (error: Throwable) {
    if (error is DriveV2ContractException) throw error
    throw DriveV2ContractException("artifact-schema-mismatch", error)
}
