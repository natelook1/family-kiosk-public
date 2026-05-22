package ca.looknet.familykiosk.family

import okhttp3.ResponseBody
import okhttp3.OkHttpClient
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.*
import java.util.concurrent.TimeUnit

data class PairRequest(
    val token: String,
    val fcmToken: String,
    val deviceId: String,
    val platform: String = "android"
)

data class PairResponse(
    val patientName: String,
    val deviceToken: String,
    val patientPhotoUrl: String?
)

data class PatientStatusResponse(
    val inCall: Boolean,
    val joinUrl: String?,
    val patientPhotoUrl: String?,
    val patientName: String?,
    val lastSeenAt: Long?
)

data class CallRecord(
    val callId: String,
    val startedAt: Long,
    val answered: Int,
    val declined: Int,
    val contactName: String
)

data class CallHistoryResponse(
    val calls: List<CallRecord>
)

data class CallResponse(
    val joinUrl: String?,
    val patientName: String?,
    val callId: String?
)

data class CallbackResponse(
    val requestId: String?,
    val createdAt: Long?
)

data class Release(val version: Int, val url: String, val sha256: String)

data class FcmTokenPayload(
    val fcmToken: String
)

interface FamilyApiService {
    @POST("family/pair")
    suspend fun pairDevice(@Body body: PairRequest): Response<PairResponse>

    @POST("family/device/{deviceId}/call")
    suspend fun initiateCall(
        @Path("deviceId") deviceId: String,
        @Header("x-device-token") deviceToken: String
    ): Response<CallResponse>

    @GET("family/device/{deviceId}/patient-status")
    suspend fun getPatientStatus(
        @Path("deviceId") deviceId: String,
        @Header("x-device-token") deviceToken: String
    ): Response<PatientStatusResponse>

    @POST("family/device/{deviceId}/callback-request")
    suspend fun requestCallback(
        @Path("deviceId") deviceId: String,
        @Header("x-device-token") deviceToken: String
    ): Response<CallbackResponse>

    @DELETE("family/device/{deviceId}/callback-request/{requestId}")
    suspend fun cancelCallback(
        @Path("deviceId") deviceId: String,
        @Path("requestId") requestId: String,
        @Header("x-device-token") deviceToken: String
    ): Response<Unit>

    @PUT("family/device/{deviceId}/fcm-token")
    suspend fun updateFcmToken(
        @Path("deviceId") deviceId: String,
        @Header("x-device-token") deviceToken: String,
        @Body body: FcmTokenPayload
    ): Response<Unit>

    @GET("family/device/{deviceId}/call-history")
    suspend fun getCallHistory(
        @Path("deviceId") deviceId: String,
        @Header("x-device-token") deviceToken: String
    ): Response<CallHistoryResponse>

    @GET("family/apk/latest")
    suspend fun fetchLatestRelease(): Response<Release>

    @Streaming
    @GET
    suspend fun downloadFile(@Url fileUrl: String): ResponseBody
}

object NetworkClient {
    private val apiBase = BuildConfig.API_BASE.removeSuffix("/webhook").let { if (it.endsWith("/")) it else "$it/" }

    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    // Separate client for APK downloads — stream can take minutes on slow connections
    private val downloadClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(5, TimeUnit.MINUTES)
        .build()

    val api: FamilyApiService by lazy {
        Retrofit.Builder()
            .baseUrl(apiBase)
            .client(okHttpClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(FamilyApiService::class.java)
    }

    val downloadApi: FamilyApiService by lazy {
        Retrofit.Builder()
            .baseUrl(apiBase)
            .client(downloadClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(FamilyApiService::class.java)
    }
}