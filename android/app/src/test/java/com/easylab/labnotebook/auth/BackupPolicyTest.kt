package com.easylab.labnotebook.auth

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class BackupPolicyTest {
    @Test
    @Config(sdk = [30])
    fun legacyBackupIsDisabledAndExplicitlyExcludesLocalState() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
        val manifest = sourceFile("src/main/AndroidManifest.xml").readText()
        val rules = sourceFile("src/main/res/xml/backup_rules.xml").readText()
        assertTrue(manifest.contains("android:fullBackupContent=\"@xml/backup_rules\""))
        assertTrue(rules.contains("<exclude domain=\"database\" path=\".\""))
        assertTrue(rules.contains("<exclude domain=\"sharedpref\" path=\".\""))
    }

    @Test
    @Config(sdk = [35])
    fun modernCloudBackupAndDeviceTransferAreExplicitlyExcluded() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
        val manifest = sourceFile("src/main/AndroidManifest.xml").readText()
        val rules = sourceFile("src/main/res/xml/data_extraction_rules.xml").readText()
        assertTrue(manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""))
        assertTrue(rules.contains("<cloud-backup>"))
        assertTrue(rules.contains("<device-transfer>"))
        assertTrue(rules.contains("<exclude domain=\"device_database\" path=\".\""))
        assertTrue(rules.contains("<exclude domain=\"device_sharedpref\" path=\".\""))
    }

    private fun sourceFile(path: String): File = sequenceOf(
        File(path),
        File("android/app/$path"),
    ).firstOrNull(File::exists) ?: error("Could not locate Android source file: $path")
}
