package com.easylab.labnotebook.sync

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import androidx.work.Configuration
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.NativeAuthViewModel
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncWorkerTest {
    @Test
    fun uniqueWorkNamesDoNotCollideForKnownJavaHashCollision() {
        assertEquals("Aa".hashCode(), "BB".hashCode())
        assertNotEquals(
            syncUniqueWorkName(AccountId("Aa")),
            syncUniqueWorkName(AccountId("BB")),
        )
        assertEquals(
            syncUniqueWorkName(AccountId("Aa")),
            syncUniqueWorkName(AccountId("Aa")),
        )
    }

    @Test
    fun signInRequiredCompletesWorkerSoReconnectCanEnqueueFreshWork() {
        val result = syncWorkerResult(
            SyncExecutionOutcome.Failure(0, SyncMessages.SIGN_IN_REQUIRED),
        )

        assertEquals("Success", result.javaClass.simpleName)
        assertTrue(result.toString().contains(SyncMessages.SIGN_IN_REQUIRED))
    }

    @Test
    fun permanentSyncProblemStillFailsWorker() {
        val result = syncWorkerResult(
            SyncExecutionOutcome.Failure(0, "${SyncMessages.ERROR_PREFIX} forbidden"),
        )

        assertEquals("Failure", result.javaClass.simpleName)
    }

    @Test
    fun successfulInteractiveReconnectRequestsAccountScopedMetadataSync() {
        val account = AccountId("connected-account")
        val auth = FakeAuthRepository(AuthSession(account, "researcher@example.com"))
        val coordinator = RecordingSyncCoordinator()
        val viewModel = NativeAuthViewModel(
            ApplicationProvider.getApplicationContext<Application>(),
            auth,
            coordinator,
        )

        viewModel.connect()

        assertEquals(1, auth.connectCalls)
        assertEquals(listOf(SyncRequest(account, "interactive_reconnect")), coordinator.requests)
    }

    @Test
    fun failedInteractiveReconnectDoesNotRequestSync() {
        val auth = FakeAuthRepository(null)
        val coordinator = RecordingSyncCoordinator()
        val viewModel = NativeAuthViewModel(
            ApplicationProvider.getApplicationContext<Application>(),
            auth,
            coordinator,
        )

        viewModel.connect()

        assertEquals(1, auth.connectCalls)
        assertTrue(coordinator.requests.isEmpty())
    }

    @Test
    fun repeatedSuccessfulReconnectsTargetSameUniqueAccountWork() {
        val account = AccountId("same-account")
        val auth = FakeAuthRepository(AuthSession(account, "researcher@example.com"))
        val coordinator = RecordingSyncCoordinator()
        val viewModel = NativeAuthViewModel(
            ApplicationProvider.getApplicationContext<Application>(),
            auth,
            coordinator,
        )

        viewModel.connect()
        viewModel.connect()

        assertEquals(2, auth.connectCalls)
        assertEquals(2, coordinator.requests.size)
        assertEquals(1, coordinator.requests.map { syncUniqueWorkName(it.accountId) }.distinct().size)
    }

    @Test
    fun interactiveReconnectReplacesStaleAccountWorkInWorkManager() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        shadowOf(connectivityManager).setActiveNetworkInfo(null)
        val workManager = getOrInitializeWorkManager(context)
        val account = AccountId("reconnect-race-account")
        val uniqueWorkName = syncUniqueWorkName(account)
        val staleRequest = OneTimeWorkRequestBuilder<JournalSyncWorker>()
            .setInitialDelay(1, TimeUnit.DAYS)
            .setInputData(
                Data.Builder()
                    .putString(JournalSyncWorker.KEY_ACCOUNT_ID, account.value)
                    .putString(JournalSyncWorker.KEY_REASON, "background")
                    .build(),
            )
            .build()

        workManager.enqueueUniqueWork(uniqueWorkName, ExistingWorkPolicy.KEEP, staleRequest)
            .result.get(5, TimeUnit.SECONDS)
        assertTrue(
            workManager.getWorkInfosForUniqueWork(uniqueWorkName).get(5, TimeUnit.SECONDS)
                .any { it.id == staleRequest.id && !it.state.isFinished },
        )

        WorkManagerSyncCoordinator(context).requestSync(account, "interactive_reconnect")

        val work = awaitUniqueWork(workManager, uniqueWorkName) { infos ->
            infos.none { it.id == staleRequest.id && !it.state.isFinished } &&
                infos.any { it.id != staleRequest.id }
        }
        assertTrue(work.none { it.id == staleRequest.id && !it.state.isFinished })
        assertTrue(work.any { it.id != staleRequest.id })
    }

    @Test
    fun ordinaryBackgroundRequestsKeepExistingAccountWork() {
        fun policyFor(reason: String) = syncExistingWorkPolicy(
            Data.Builder().putString(JournalSyncWorker.KEY_REASON, reason).build(),
        )

        assertEquals(ExistingWorkPolicy.KEEP, policyFor("background"))
        assertEquals(ExistingWorkPolicy.KEEP, policyFor("manual"))
        assertEquals(ExistingWorkPolicy.REPLACE, policyFor("interactive_reconnect"))
    }

    private fun awaitUniqueWork(
        workManager: WorkManager,
        uniqueWorkName: String,
        predicate: (List<WorkInfo>) -> Boolean,
    ): List<WorkInfo> {
        repeat(50) {
            val infos = workManager.getWorkInfosForUniqueWork(uniqueWorkName).get(5, TimeUnit.SECONDS)
            if (predicate(infos)) return infos
            Thread.sleep(20)
        }
        return workManager.getWorkInfosForUniqueWork(uniqueWorkName).get(5, TimeUnit.SECONDS)
    }

    private fun getOrInitializeWorkManager(context: Context): WorkManager = try {
        WorkManager.getInstance(context)
    } catch (_: IllegalStateException) {
        WorkManager.initialize(context, Configuration.Builder().build())
        WorkManager.getInstance(context)
    }

    private data class SyncRequest(val accountId: AccountId, val reason: String)

    private class RecordingSyncCoordinator : SyncCoordinator {
        val requests = mutableListOf<SyncRequest>()

        override fun observeStatus(accountId: AccountId): Flow<SyncStatus> = flowOf(SyncStatus())

        override fun requestSync(accountId: AccountId, reason: String) {
            requests += SyncRequest(accountId, reason)
        }

        override fun cancel(accountId: AccountId) = Unit
    }

    private class FakeAuthRepository(private val connectedSession: AuthSession?) : AuthRepository {
        private val mutableSession = MutableStateFlow<AuthSession?>(null)
        private val mutableDriveAccess = MutableStateFlow<DriveAccessState>(DriveAccessState.SignedOut)
        var connectCalls = 0

        override val session: StateFlow<AuthSession?> = mutableSession
        override val driveAccess: StateFlow<DriveAccessState> = mutableDriveAccess

        override suspend fun restore() = Unit

        override suspend fun connect(): Result<AuthSession> {
            connectCalls += 1
            val session = connectedSession ?: return Result.failure(IllegalStateException("sign-in failed"))
            mutableSession.value = session
            return Result.success(session)
        }

        override suspend fun disconnect() = Unit
        override suspend fun invalidateAccessToken(accountId: AccountId) = Unit
        override fun accessToken(accountId: AccountId): String? = null
    }
}
