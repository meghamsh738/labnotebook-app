package com.easylab.labnotebook.auth

import android.content.Context
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDao
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.toEntity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class RoomAuthAccountStore(
    context: Context,
    private val dao: LabNotebookDao,
    private val nowIso: () -> String = ::currentIsoTimestamp,
) : AuthAccountStore {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override suspend fun active(): AuthSession? {
        val accountId = preferences.getString(ACTIVE_ACCOUNT_ID, null)?.takeIf(String::isNotBlank) ?: return null
        return dao.account(accountId)?.let { account ->
            AuthSession(
                accountId = AccountId(account.accountId),
                email = account.email,
                displayName = account.displayName,
                pictureUrl = account.pictureUrl,
            )
        }
    }

    override suspend fun save(session: AuthSession) {
        dao.upsertAccount(session.toEntity(nowIso()))
        check(preferences.edit().putString(ACTIVE_ACCOUNT_ID, session.accountId.value).commit()) {
            "Could not remember the active Google account on this device."
        }
    }

    override suspend fun clearActive() {
        check(preferences.edit().remove(ACTIVE_ACCOUNT_ID).commit()) {
            "Could not clear the active Google account on this device."
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "easylab-native-auth"
        const val ACTIVE_ACCOUNT_ID = "active-google-subject"
    }
}

private fun currentIsoTimestamp(): String = SimpleDateFormat(
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    Locale.US,
).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date())
