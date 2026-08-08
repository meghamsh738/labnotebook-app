package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.DriveFileRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveResumableOperationStoreTest {
    @Test
    fun immutableIdentitySurvivesStoreRecreationAndPersistsCompletion() = runTest {
        val persistence = FakePersistence()
        val identity = identity()

        DriveResumableOperationStore(persistence).begin(identity)
        val recreated = DriveResumableOperationStore(persistence)
        assertEquals(identity, recreated.begin(identity).identity)

        recreated.markCompleted(
            identity,
            DriveFileRef(
                id = identity.fileId,
                path = identity.path,
                name = "large.bin",
                mimeType = identity.mimeType,
                size = identity.byteSize,
                updatedAt = "2026-07-26T12:00:00Z",
                version = identity.expectedVersion + 1,
            ),
        )

        val completed = DriveResumableOperationStore(persistence).record(
            identity.accountId,
            identity.operationId,
        )
        assertEquals(DriveResumableOperationState.Completed, completed?.state)
        assertEquals(identity.expectedVersion + 1, completed?.completedVersion)
    }

    @Test
    fun staleOperationIdentityCannotBeRebound() = runTest {
        val persistence = FakePersistence()
        val store = DriveResumableOperationStore(persistence)
        val original = identity()
        store.begin(original)

        val error = runCatching {
            store.begin(original.copy(sha256 = "b".repeat(64)))
        }.exceptionOrNull()

        assertTrue(error is DriveResumableOperationIdentityConflictException)
        assertEquals(original, store.record(original.accountId, original.operationId)?.identity)
    }

    @Test
    fun sameOperationIdIsIsolatedByAccount() = runTest {
        val persistence = FakePersistence()
        val store = DriveResumableOperationStore(persistence)
        val accountA = identity(accountId = AccountId("account-a"))
        val accountB = identity(accountId = AccountId("account-b"))

        store.begin(accountA)
        store.begin(accountB)

        assertEquals(accountA, store.record(accountA.accountId, accountA.operationId)?.identity)
        assertEquals(accountB, store.record(accountB.accountId, accountB.operationId)?.identity)
        assertEquals(2, persistence.size())
    }

    @Test
    fun concurrentStoresCannotBindOneOperationIdToTwoWrites() = runTest {
        val persistence = FakePersistence()
        val first = identity(sha256 = "a".repeat(64))
        val second = identity(sha256 = "b".repeat(64))
        val outcomes = listOf(first, second).map { candidate ->
            async(Dispatchers.Default) {
                runCatching {
                    DriveResumableOperationStore(persistence).begin(candidate)
                }
            }
        }.awaitAll()

        assertEquals(1, outcomes.count(Result<DriveResumableOperationRecord>::isSuccess))
        assertEquals(
            1,
            outcomes.count { it.exceptionOrNull() is DriveResumableOperationIdentityConflictException },
        )
        assertNotNull(
            DriveResumableOperationStore(persistence).record(first.accountId, first.operationId),
        )
        assertEquals(1, persistence.size())
    }

    @Test
    fun ambiguousOutcomePersistsAcrossStoreRecreation() = runTest {
        val persistence = FakePersistence()
        val identity = identity()
        val store = DriveResumableOperationStore(persistence)
        store.begin(identity)
        store.markAmbiguous(identity)

        val record = DriveResumableOperationStore(persistence).record(
            identity.accountId,
            identity.operationId,
        )

        assertEquals(DriveResumableOperationState.Ambiguous, record?.state)
        assertEquals(null, record?.completedVersion)
    }

    @Test
    fun completedOutcomeCannotBeDowngradedToAmbiguous() = runTest {
        val persistence = FakePersistence()
        val identity = identity()
        val store = DriveResumableOperationStore(persistence)
        store.begin(identity)
        store.markCompleted(
            identity,
            DriveFileRef(
                id = identity.fileId,
                path = identity.path,
                name = "large.bin",
                mimeType = identity.mimeType,
                size = identity.byteSize,
                updatedAt = "2026-07-26T12:00:00Z",
                version = identity.expectedVersion + 1,
            ),
        )

        store.markAmbiguous(identity)

        val record = store.record(identity.accountId, identity.operationId)
        assertEquals(DriveResumableOperationState.Completed, record?.state)
        assertEquals(identity.expectedVersion + 1, record?.completedVersion)
    }

    @Test
    fun generatedIdCreationTargetIsImmutableAndCompletesAtFirstPositiveVersion() = runTest {
        val persistence = FakePersistence()
        val identity = DriveResumableOperationIdentity(
            accountId = AccountId("account-a"),
            operationId = "create-operation-1",
            path = "attachments/2026-07-26/new-large.bin",
            fileId = "generated-file-id",
            sha256 = "c".repeat(64),
            byteSize = 6L * 1024 * 1024,
            mimeType = "application/octet-stream",
            creationFingerprint = "d".repeat(64),
        )
        val store = DriveResumableOperationStore(persistence)

        store.begin(identity)
        val stale = runCatching {
            store.begin(identity.copy(creationFingerprint = "e".repeat(64)))
        }.exceptionOrNull()
        store.markCompleted(
            identity,
            DriveFileRef(
                id = identity.fileId,
                path = identity.path,
                name = "new-large.bin",
                mimeType = identity.mimeType,
                size = identity.byteSize,
                updatedAt = "2026-07-26T12:00:00Z",
                version = 1,
            ),
        )

        val record = store.record(identity.accountId, identity.operationId)
        assertTrue(stale is DriveResumableOperationIdentityConflictException)
        assertTrue(record?.identity?.target is DriveResumableOperationTarget.New)
        assertEquals(1L, record?.completedVersion)
    }

    @Test(expected = IllegalArgumentException::class)
    fun generatedIdCreationTargetRejectsNonzeroExpectedVersion() {
        DriveResumableOperationIdentity(
            accountId = AccountId("account-a"),
            operationId = "create-operation-invalid",
            path = "attachments/2026-07-26/new-large.bin",
            fileId = "generated-file-id",
            expectedVersion = 1,
            sha256 = "c".repeat(64),
            byteSize = 6L * 1024 * 1024,
            mimeType = "application/octet-stream",
            creationFingerprint = "d".repeat(64),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun operationIdentityRejectsNonCanonicalSha256() {
        identity(sha256 = "A".repeat(64))
    }

    private fun identity(
        accountId: AccountId = AccountId("account-a"),
        sha256: String = "a".repeat(64),
    ) = DriveResumableOperationIdentity(
        accountId = accountId,
        operationId = "operation-1",
        path = "attachments/2026-07-26/large.bin",
        fileId = "large-file",
        expectedVersion = 7,
        sha256 = sha256,
        byteSize = 6L * 1024 * 1024,
        mimeType = "application/octet-stream",
    )

    private class FakePersistence : DriveResumableOperationPersistence {
        private val values = mutableMapOf<String, String>()

        override suspend fun read(key: String): String? = synchronized(values) { values[key] }

        override suspend fun bindIfAbsent(key: String, value: String): String = synchronized(values) {
            values.getOrPut(key) { value }
        }

        override suspend fun compareAndSet(
            key: String,
            expected: String,
            value: String,
        ): Boolean = synchronized(values) {
            if (values[key] != expected) {
                false
            } else {
                values[key] = value
                true
            }
        }

        fun size(): Int = synchronized(values) { values.size }
    }
}
