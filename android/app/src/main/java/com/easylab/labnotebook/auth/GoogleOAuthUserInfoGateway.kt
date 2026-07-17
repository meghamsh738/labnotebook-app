package com.easylab.labnotebook.auth

import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

class GoogleOAuthUserInfoGateway(
    private val endpoint: URL = URL(DEFAULT_USERINFO_ENDPOINT),
    private val json: Json = Json { ignoreUnknownKeys = true },
) : GoogleUserInfoGateway {
    override suspend fun fetch(accessToken: String): GoogleUserProfile = withContext(Dispatchers.IO) {
        require(accessToken.isNotBlank()) { "Google access token must not be blank." }
        val connection = endpoint.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = NETWORK_TIMEOUT_MILLIS
            connection.readTimeout = NETWORK_TIMEOUT_MILLIS
            connection.setRequestProperty("Authorization", "Bearer $accessToken")
            connection.setRequestProperty("Accept", "application/json")

            val status = connection.responseCode
            val response = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                .orEmpty()
            check(status in 200..299) { "Google account verification failed ($status)." }

            val payload = json.decodeFromString<UserInfoPayload>(response)
            GoogleUserProfile(
                subject = payload.subject,
                email = payload.email,
                emailVerified = payload.emailVerified == true,
                displayName = payload.name,
                pictureUrl = payload.picture,
            )
        } finally {
            connection.disconnect()
        }
    }

    @Serializable
    private data class UserInfoPayload(
        @SerialName("sub") val subject: String = "",
        val email: String = "",
        @SerialName("email_verified") val emailVerified: Boolean? = null,
        val name: String? = null,
        val picture: String? = null,
    )

    private companion object {
        const val DEFAULT_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo"
        const val NETWORK_TIMEOUT_MILLIS = 15_000
    }
}
