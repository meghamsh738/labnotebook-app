package com.easylab.labnotebook.data.local

import android.content.Context
import java.util.UUID

class InstallDeviceIdentity(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "easylab-native-device",
        Context.MODE_PRIVATE,
    )

    val id: String by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        preferences.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() }
            ?: "android-${UUID.randomUUID()}".also { generated ->
                preferences.edit().putString(KEY_DEVICE_ID, generated).apply()
            }
    }

    private companion object {
        const val KEY_DEVICE_ID = "install-device-id"
    }
}
