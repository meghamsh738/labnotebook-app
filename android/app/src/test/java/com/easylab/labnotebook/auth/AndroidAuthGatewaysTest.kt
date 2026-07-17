package com.easylab.labnotebook.auth

import com.google.android.gms.common.api.Scope
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AndroidAuthGatewaysTest {
    @Test
    fun authorizationRequestIsBoundToCredentialManagerSelection() {
        val request = buildDriveAuthorizationRequest(
            email = "  Researcher@Example.com  ",
            scopes = listOf(Scope("openid"), Scope("https://www.googleapis.com/auth/drive.file")),
        )

        assertEquals("Researcher@Example.com", request.account?.name)
        assertEquals("com.google", request.account?.type)
    }
}
