package com.easylab.labnotebook

import android.content.Context
import com.easylab.labnotebook.auth.AndroidCredentialIdentityGateway
import com.easylab.labnotebook.auth.AndroidDriveAuthorizationGateway
import com.easylab.labnotebook.auth.GoogleOAuthUserInfoGateway
import com.easylab.labnotebook.auth.NativeAuthRepository
import com.easylab.labnotebook.auth.NativeAuthActivityHost
import com.easylab.labnotebook.auth.RoomAuthAccountStore
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.repository.AuthRepository

object NativeAuthFactory {
    @Volatile
    internal var testCreator: ((Context, NativeAuthActivityHost) -> AuthRepository)? = null

    @JvmStatic
    fun create(context: Context, activityHost: NativeAuthActivityHost): AuthRepository {
        testCreator?.let { return it(context, activityHost) }
        val applicationContext = context.applicationContext
        val database = LabNotebookDatabase.get(applicationContext)
        return NativeAuthRepository(
            identityGateway = AndroidCredentialIdentityGateway(
                applicationContext,
                activityHost,
                BuildConfig.GOOGLE_WEB_CLIENT_ID,
            ),
            authorizationGateway = AndroidDriveAuthorizationGateway(applicationContext, activityHost),
            userInfoGateway = GoogleOAuthUserInfoGateway(),
            accountStore = RoomAuthAccountStore(applicationContext, database.dao()),
        )
    }
}
