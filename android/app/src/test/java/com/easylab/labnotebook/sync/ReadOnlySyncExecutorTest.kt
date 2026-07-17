package com.easylab.labnotebook.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveHttpException
import com.easylab.labnotebook.data.repository.DriveRepository
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import java.io.IOException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReadOnlySyncExecutorTest {
    private lateinit var database: LabNotebookDatabase
    private val accountA = AccountId("account-a")
    private val accountB = AccountId("account-b")

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun missingProcessTokenReturnsSignInRequiredFailureWithoutCreatingOrCallingDrive() = runTest {
        val auth = FakeAuthRepository(tokens = mutableMapOf(accountB to "account-b-token"))
        var factoryCalls = 0
        val drive = FakeDriveRepository.successful()
        val executor = executor(auth) {
            factoryCalls += 1
            drive
        }

        val outcome = executor.execute(accountA)

        assertTrue(outcome is SyncExecutionOutcome.Failure)
        assertEquals(SyncMessages.SIGN_IN_REQUIRED, outcome.message)
        assertEquals(0, outcome.pendingCount)
        assertEquals(0, factoryCalls)
        assertEquals(0, drive.listCalls)
        assertEquals(listOf(accountA), auth.tokenRequests)
        assertTrue(auth.invalidatedAccounts.isEmpty())
        assertEquals(SyncMessages.SIGN_IN_REQUIRED, database.dao().syncState(accountA.value)?.lastMessage)
    }

    @Test
    fun http401InvalidatesOnlyRequestedAccountAndReturnsFailureWithoutRetrying() = runTest {
        val auth = FakeAuthRepository(
            tokens = mutableMapOf(accountA to "account-a-token", accountB to "account-b-token"),
        )
        val drive = FakeDriveRepository.failure(DriveHttpException(401, "expired token"))

        val outcome = executor(auth, drive).execute(accountA)

        assertTrue(outcome is SyncExecutionOutcome.Failure)
        assertFalse(outcome is SyncExecutionOutcome.Retry)
        assertEquals(SyncMessages.SIGN_IN_REQUIRED, outcome.message)
        assertEquals(listOf(accountA), auth.invalidatedAccounts)
        assertEquals(null, auth.accessToken(accountA))
        assertEquals("account-b-token", auth.accessToken(accountB))
        assertEquals(1, drive.listCalls)
        assertEquals(listOf(accountA), drive.listAccounts)
    }

    @Test
    fun http403IsPermanentFailure() = runTest {
        val auth = authenticated()
        val drive = FakeDriveRepository.failure(DriveHttpException(403, "workspace forbidden"))

        val outcome = executor(auth, drive).execute(accountA)

        assertTrue(outcome is SyncExecutionOutcome.Failure)
        assertFalse(outcome is SyncExecutionOutcome.Retry)
        assertTrue(outcome.message.contains("workspace forbidden"))
        assertTrue(auth.invalidatedAccounts.isEmpty())
        assertEquals(1, drive.listCalls)
    }

    @Test
    fun retryableHttpStatusesReturnRetry() = runTest {
        listOf(408, 429, 500).forEach { status ->
            val auth = authenticated()
            val drive = FakeDriveRepository.failure(DriveHttpException(status, "HTTP $status"))

            val outcome = executor(auth, drive).execute(accountA)

            assertTrue("status $status", outcome is SyncExecutionOutcome.Retry)
            assertEquals("status $status", 1, drive.listCalls)
            assertTrue("status $status", auth.invalidatedAccounts.isEmpty())
        }
    }

    @Test
    fun ioExceptionReturnsRetry() = runTest {
        val drive = FakeDriveRepository.failure(IOException("connection reset"))

        val outcome = executor(authenticated(), drive).execute(accountA)

        assertTrue(outcome is SyncExecutionOutcome.Retry)
        assertTrue(outcome.message.contains("Drive could not be reached"))
        assertEquals(1, drive.listCalls)
    }

    @Test
    fun malformedManifestIsPermanentFailure() = runTest {
        val drive = FakeDriveRepository.withManifest("{not-json")

        val outcome = executor(authenticated(), drive).execute(accountA)

        assertTrue(outcome is SyncExecutionOutcome.Failure)
        assertFalse(outcome is SyncExecutionOutcome.Retry)
        assertTrue(outcome.message.startsWith(SyncMessages.ERROR_PREFIX))
        assertEquals(1, drive.listCalls)
        assertEquals(listOf("manifest.json"), drive.jsonReads)
        assertTrue(database.dao().devices(accountA.value).isEmpty())
        assertEquals(null, database.dao().syncState(accountA.value)?.lastSyncedAt)
    }

    @Test
    fun successReturnsAppliedCountAndNeverEnablesOrUsesDriveWrites() = runTest {
        val drive = FakeDriveRepository.withManifest(validManifest)

        val outcome = executor(authenticated(), drive).execute(accountA)

        assertTrue(outcome is SyncExecutionOutcome.Success)
        outcome as SyncExecutionOutcome.Success
        assertEquals(1, outcome.appliedCount)
        assertEquals(0, outcome.pendingCount)
        assertEquals("manifest-device", database.dao().devices(accountA.value).single().id)
        assertEquals(DriveWriteCapability.DisabledPendingContractParity, drive.writeCapability)
        assertEquals(0, drive.jsonWrites)
        assertEquals(0, drive.blobWrites)
        assertEquals(1, drive.listCalls)
        assertEquals(listOf("manifest.json"), drive.jsonReads)
    }

    private fun authenticated() = FakeAuthRepository(
        tokens = mutableMapOf(accountA to "account-a-token", accountB to "account-b-token"),
    )

    private fun executor(auth: AuthRepository, drive: DriveRepository) = executor(auth) { drive }

    private fun executor(
        auth: AuthRepository?,
        driveFactory: (AuthRepository) -> DriveRepository,
    ) = ReadOnlySyncExecutor(
        database = database,
        authRepository = auth,
        driveFactory = driveFactory,
        now = { ATTEMPT_AT },
    )

    private class FakeAuthRepository(
        private val tokens: MutableMap<AccountId, String>,
    ) : AuthRepository {
        private val mutableSession = MutableStateFlow<AuthSession?>(null)
        private val mutableDriveAccess = MutableStateFlow<DriveAccessState>(DriveAccessState.SignedOut)
        override val session: StateFlow<AuthSession?> = mutableSession
        override val driveAccess: StateFlow<DriveAccessState> = mutableDriveAccess
        val tokenRequests = mutableListOf<AccountId>()
        val invalidatedAccounts = mutableListOf<AccountId>()

        override suspend fun restore() = Unit

        override suspend fun connect(): Result<AuthSession> =
            Result.failure(AssertionError("Executor must not initiate sign-in."))

        override suspend fun disconnect() = Unit

        override suspend fun invalidateAccessToken(accountId: AccountId) {
            invalidatedAccounts += accountId
            tokens.remove(accountId)
        }

        override fun accessToken(accountId: AccountId): String? {
            tokenRequests += accountId
            return tokens[accountId]
        }
    }

    private class FakeDriveRepository private constructor(
        private val refsResult: Result<List<DriveFileRef>>,
        private val jsonByPath: Map<String, String>,
    ) : DriveRepository {
        override val writeCapability = DriveWriteCapability.DisabledPendingContractParity
        var listCalls = 0
        val listAccounts = mutableListOf<AccountId>()
        val jsonReads = mutableListOf<String>()
        var jsonWrites = 0
        var blobWrites = 0

        override suspend fun listManagedFiles(
            accountId: AccountId,
            prefix: String?,
        ): Result<List<DriveFileRef>> {
            listCalls += 1
            listAccounts += accountId
            return refsResult
        }

        override suspend fun readJson(accountId: AccountId, path: String): Result<String?> {
            jsonReads += path
            return Result.success(jsonByPath[path])
        }

        override suspend fun putJson(
            accountId: AccountId,
            path: String,
            json: String,
        ): Result<DriveFileRef> {
            jsonWrites += 1
            return Result.failure(AssertionError("Read-only sync must not write JSON."))
        }

        override suspend fun putBlob(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
        ): Result<DriveFileRef> {
            blobWrites += 1
            return Result.failure(AssertionError("Read-only sync must not write blobs."))
        }

        companion object {
            fun successful() = withManifest(validManifest)

            fun withManifest(manifest: String): FakeDriveRepository {
                val ref = DriveFileRef(
                    id = "manifest-drive-id",
                    path = "manifest.json",
                    name = "manifest.json",
                    mimeType = "application/json",
                    size = manifest.length.toLong(),
                    updatedAt = ATTEMPT_AT,
                )
                return FakeDriveRepository(Result.success(listOf(ref)), mapOf(ref.path to manifest))
            }

            fun failure(error: Throwable) = FakeDriveRepository(Result.failure(error), emptyMap())
        }
    }

    companion object {
        private const val ATTEMPT_AT = "2026-07-16T12:00:00.000Z"
        private val validManifest = """
            {
              "version": 1,
              "provider": "google-drive",
              "rootFolderName": "Easylab Lab Notebook",
              "createdAt": "2026-07-16T10:00:00.000Z",
              "updatedAt": "2026-07-16T11:00:00.000Z",
              "devices": [{
                "id": "manifest-device",
                "name": "Manifest device",
                "platform": "mobile",
                "createdAt": "2026-07-16T10:00:00.000Z",
                "lastSeenAt": "2026-07-16T11:00:00.000Z"
              }],
              "entryCount": 0,
              "attachmentCount": 0,
              "fileBoxCount": 0,
              "transferCount": 0
            }
        """.trimIndent()
    }
}
