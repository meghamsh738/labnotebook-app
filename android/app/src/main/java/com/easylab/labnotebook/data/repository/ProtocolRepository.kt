package com.easylab.labnotebook.data.repository

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDao
import com.easylab.labnotebook.data.local.ProtocolEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

/**
 * Local-only protocol storage. This contract deliberately has no Drive repository or sync-queue dependency;
 * native remote writes remain disabled and Drive v1 does not contain protocol records in this milestone.
 */
interface ProtocolRepository {
    fun observeProtocols(accountId: AccountId): Flow<List<ProtocolEntity>>
    suspend fun getProtocol(accountId: AccountId, protocolId: String): ProtocolEntity?
    suspend fun createProtocol(accountId: AccountId, protocol: ProtocolEntity): ProtocolEntity
    suspend fun updateProtocol(
        accountId: AccountId,
        protocol: ProtocolEntity,
        expectedUpdatedAt: String,
    ): ProtocolEntity
    suspend fun deleteProtocol(accountId: AccountId, protocolId: String): Boolean
}

private fun validateProtocol(accountId: AccountId, protocol: ProtocolEntity) {
    require(protocol.accountId == accountId.value) { "Protocol belongs to a different account." }
    require(protocol.id.isNotBlank()) { "Protocol id must not be blank." }
    require(protocol.title.trim().isNotEmpty()) { "Protocol title must not be blank." }
    require(protocol.title.length <= 240) { "Protocol title is too long." }
    require(protocol.createdAt.isNotBlank()) { "Protocol creation timestamp must not be blank." }
    require(protocol.updatedAt.isNotBlank()) { "Protocol update timestamp must not be blank." }
    require(protocol.contentJson.length <= 1_000_000) { "Protocol content is too large." }
    require(Json.parseToJsonElement(protocol.contentJson) is JsonArray) { "Protocol content must be a JSON array." }
    require(Json.parseToJsonElement(protocol.tagsJson) is JsonArray) { "Protocol tags must be a JSON array." }
    require(Json.parseToJsonElement(protocol.searchTermsJson) is JsonArray) {
        "Protocol search terms must be a JSON array."
    }
}

class RoomProtocolRepository(private val dao: LabNotebookDao) : ProtocolRepository {
    override fun observeProtocols(accountId: AccountId) = dao.observeProtocols(accountId.value)

    override suspend fun getProtocol(accountId: AccountId, protocolId: String) =
        dao.protocol(accountId.value, protocolId)

    override suspend fun createProtocol(accountId: AccountId, protocol: ProtocolEntity): ProtocolEntity {
        validateProtocol(accountId, protocol)
        val normalized = protocol.copy(title = protocol.title.trim())
        dao.insertProtocol(normalized)
        return normalized
    }

    override suspend fun updateProtocol(
        accountId: AccountId,
        protocol: ProtocolEntity,
        expectedUpdatedAt: String,
    ): ProtocolEntity {
        validateProtocol(accountId, protocol)
        require(protocol.updatedAt != expectedUpdatedAt) { "Protocol update timestamp must advance." }
        val normalized = protocol.copy(title = protocol.title.trim())
        check(
            dao.compareAndSetProtocol(
                accountId = accountId.value,
                protocolId = normalized.id,
                expectedUpdatedAt = expectedUpdatedAt,
                createdAt = normalized.createdAt,
                title = normalized.title,
                updatedAt = normalized.updatedAt,
                contentJson = normalized.contentJson,
                tagsJson = normalized.tagsJson,
                searchTermsJson = normalized.searchTermsJson,
            ) == 1,
        ) { "Protocol changed after editing began, was deleted, or its account is no longer active. Reload it before saving." }
        return normalized
    }

    override suspend fun deleteProtocol(accountId: AccountId, protocolId: String): Boolean =
        dao.deleteProtocol(accountId.value, protocolId) == 1
}

/** Account-qualified local store used by Compose previews and deterministic UI tests. */
class InMemoryProtocolRepository : ProtocolRepository {
    private val protocols = MutableStateFlow<Map<Pair<String, String>, ProtocolEntity>>(emptyMap())

    override fun observeProtocols(accountId: AccountId): Flow<List<ProtocolEntity>> = protocols.map { values ->
        values.filterKeys { it.first == accountId.value }.values
            .sortedWith(compareByDescending<ProtocolEntity> { it.updatedAt }.thenBy { it.title.lowercase() })
    }

    override suspend fun getProtocol(accountId: AccountId, protocolId: String) =
        protocols.value[accountId.value to protocolId]

    override suspend fun createProtocol(accountId: AccountId, protocol: ProtocolEntity): ProtocolEntity {
        validateProtocol(accountId, protocol)
        val key = accountId.value to protocol.id
        check(key !in protocols.value) { "A protocol with this id already exists." }
        val normalized = protocol.copy(title = protocol.title.trim())
        protocols.value = protocols.value + (key to normalized)
        return normalized
    }

    override suspend fun updateProtocol(
        accountId: AccountId,
        protocol: ProtocolEntity,
        expectedUpdatedAt: String,
    ): ProtocolEntity {
        validateProtocol(accountId, protocol)
        require(protocol.updatedAt != expectedUpdatedAt) { "Protocol update timestamp must advance." }
        val key = accountId.value to protocol.id
        val current = checkNotNull(protocols.value[key]) { "Protocol no longer exists." }
        check(current.updatedAt == expectedUpdatedAt) { "Protocol changed after editing began. Reload it before saving." }
        check(current.createdAt == protocol.createdAt) { "Protocol creation metadata cannot be changed." }
        val normalized = protocol.copy(title = protocol.title.trim())
        protocols.value = protocols.value + (key to normalized)
        return normalized
    }

    override suspend fun deleteProtocol(accountId: AccountId, protocolId: String): Boolean {
        val key = accountId.value to protocolId
        if (key !in protocols.value) return false
        protocols.value = protocols.value - key
        return true
    }
}
