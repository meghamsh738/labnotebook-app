package com.easylab.labnotebook.auth

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.async
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@OptIn(ExperimentalCoroutinesApi::class)
class NativeAuthActivityHostTest {
    @Test
    fun pendingConsentSurvivesActivityDetachAndReattach() = runTest {
        val host = NativeAuthActivityHost()
        val first = Robolectric.buildActivity(TestActivity::class.java).setup().get()
        val second = Robolectric.buildActivity(TestActivity::class.java).setup().get()
        var launched: IntentSenderRequest? = null
        host.attach(first) { launched = it }
        val result = async { host.resolve(pendingIntent()) }
        runCurrent()
        assertNotNull(launched)

        host.detach(first)
        host.attach(second) { launched = it }
        val returned = Intent("easylab-test-result")
        host.onResult(Activity.RESULT_OK, returned)

        assertEquals("easylab-test-result", result.await().action)
        host.onResult(Activity.RESULT_CANCELED, null)
    }

    @Test
    fun staleRestoredResultIsIgnoredAndNextRequestStillCompletesOnce() = runTest {
        val host = NativeAuthActivityHost()
        val activity = Robolectric.buildActivity(TestActivity::class.java).setup().get()
        host.attach(activity) {}
        host.onResult(Activity.RESULT_OK, Intent("stale"))

        val result = async { host.resolve(pendingIntent()) }
        runCurrent()
        host.onResult(Activity.RESULT_OK, Intent("fresh"))
        host.onResult(Activity.RESULT_OK, Intent("duplicate"))

        assertEquals("fresh", result.await().action)
    }

    private fun pendingIntent(): PendingIntent {
        val context = ApplicationProvider.getApplicationContext<Context>()
        return PendingIntent.getActivity(
            context,
            17,
            Intent(context, TestActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    class TestActivity : ComponentActivity()
}
