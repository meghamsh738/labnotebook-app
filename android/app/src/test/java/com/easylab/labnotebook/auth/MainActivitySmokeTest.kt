package com.easylab.labnotebook.auth

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.ViewModelProvider
import com.easylab.labnotebook.MainActivity
import com.easylab.labnotebook.NativeShareViewModel
import com.easylab.labnotebook.NativeAuthFactory
import com.easylab.labnotebook.NativeAuthViewModel
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MainActivitySmokeTest {
    @Test
    fun javaLauncherHostsKotlinAuthRepositoryAndRetainsItAcrossRecreation() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val first = ViewModelProvider(controller.get())[NativeAuthViewModel::class.java]

        controller.recreate()

        val second = ViewModelProvider(controller.get())[NativeAuthViewModel::class.java]
        assertSame(first, second)
        assertNotNull(second.authRepository)
        assertNotNull(second.activityHost.currentActivity())
        controller.close()
    }

    @Test
    fun inFlightConnectCompletesOnceAfterActivityRecreation() {
        lateinit var repository: RecreationAuthRepository
        NativeAuthFactory.testCreator = { context, host ->
            RecreationAuthRepository(context, host).also { repository = it }
        }
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()

        try {
            val first = ViewModelProvider(controller.get())[NativeAuthViewModel::class.java]
            // Keep the resolver pending without launching an external Google activity in Robolectric.
            first.activityHost.attach(controller.get()) { }
            first.connect()

            assertEquals(1, repository.connectCalls)
            assertTrue(repository.consentPending)

            controller.recreate()
            val second = ViewModelProvider(controller.get())[NativeAuthViewModel::class.java]
            assertSame(first, second)

            second.activityHost.onResult(Activity.RESULT_OK, Intent("easylab-test-consent"))

            assertEquals(1, repository.connectCalls)
            assertEquals(repository.connectedSession, second.authRepository.session.value)
            assertTrue(second.authRepository.driveAccess.value is DriveAccessState.Granted)
        } finally {
            controller.close()
            NativeAuthFactory.testCreator = null
        }
    }

    @Test
    fun incomingShareSurvivesActivityRecreationWithoutBeingDuplicated() {
        val intent = Intent(Intent.ACTION_SEND)
            .setType("application/pdf")
            .putExtra(Intent.EXTRA_STREAM, Uri.parse("content://instrument/result"))
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).setup()

        val first = ViewModelProvider(controller.get())[NativeShareViewModel::class.java]
        val requestId = checkNotNull(first.pendingShare.value).id
        controller.recreate()
        val second = ViewModelProvider(controller.get())[NativeShareViewModel::class.java]

        assertSame(first, second)
        assertEquals(requestId, second.pendingShare.value?.id)
        controller.close()
    }

    private class RecreationAuthRepository(
        context: Context,
        private val activityHost: NativeAuthActivityHost,
    ) : AuthRepository {
        private val mutableSession = MutableStateFlow<AuthSession?>(null)
        private val mutableDriveAccess = MutableStateFlow<DriveAccessState>(DriveAccessState.SignedOut)
        private val pendingIntent = PendingIntent.getActivity(
            context,
            41,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val connectedSession = AuthSession(AccountId("recreated-subject"), "researcher@example.com")
        var connectCalls = 0
        var consentPending = false

        override val session: StateFlow<AuthSession?> = mutableSession
        override val driveAccess: StateFlow<DriveAccessState> = mutableDriveAccess

        override suspend fun restore() {
            mutableDriveAccess.value = DriveAccessState.SignedOut
        }

        override suspend fun connect(): Result<AuthSession> {
            connectCalls += 1
            consentPending = true
            activityHost.resolve(pendingIntent)
            consentPending = false
            mutableSession.value = connectedSession
            mutableDriveAccess.value = DriveAccessState.Granted(
                accountId = connectedSession.accountId,
                grantedScopes = setOf("https://www.googleapis.com/auth/drive.file"),
            )
            return Result.success(connectedSession)
        }

        override suspend fun disconnect() {
            mutableSession.value = null
            mutableDriveAccess.value = DriveAccessState.SignedOut
        }

        override suspend fun invalidateAccessToken(accountId: AccountId) = Unit
        override fun accessToken(accountId: AccountId) = null
    }
}
