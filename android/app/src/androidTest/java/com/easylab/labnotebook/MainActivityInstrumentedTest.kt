package com.easylab.labnotebook

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityInstrumentedTest {
    @Test
    fun applicationUsesProductionPackage() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        assertEquals("com.easylab.labnotebook", context.packageName)
    }

    @Test
    fun nativeActivityLaunchesAndResumes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            scenario.onActivity { activity ->
                assertEquals(
                    androidx.lifecycle.Lifecycle.State.RESUMED,
                    activity.lifecycle.currentState,
                )
            }
        }
    }
}
