package ca.looknet.familykiosk.family

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import java.io.File
import java.security.MessageDigest

class UpdateManager(private val context: Context) {

    private val tag     = "FamilyUpdate"
    private val nm      = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val notifId get() = NOTIF_ID
    private val channel = "update_progress"
    private val api = NetworkClient.api
    private val downloadApi = NetworkClient.downloadApi

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(channel, "App Updates", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun notify(text: String, ongoing: Boolean = true) {
        ensureChannel()
        val notif = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Family App Update")
            .setContentText(text)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .build()
        nm.notify(notifId, notif)
        Log.i(tag, text)
    }

    private fun notifyDone(text: String) {
        ensureChannel()
        val notif = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Family App Update")
            .setContentText(text)
            .setOngoing(false)
            .setAutoCancel(true)
            .build()
        nm.notify(notifId, notif)
        Log.i(tag, text)
    }

    private fun notifyError(text: String) {
        ensureChannel()
        val notif = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Family App Update Failed")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(false)
            .setAutoCancel(true)
            .build()
        nm.notify(notifId, notif)
        Log.e(tag, text)
    }

    fun checkAndUpdate() {
        CoroutineScope(Dispatchers.IO + SupervisorJob()).launch {
            Log.i(tag, "checkAndUpdate() — current versionCode=${BuildConfig.VERSION_CODE}")
            val release = runCatching { fetchLatest() }.getOrElse {
                notifyError("Version check failed: ${it.javaClass.simpleName}: ${it.message}")
                Log.e(tag, "Version check exception", it)
                return@launch
            }
            Log.i(tag, "Server version=${release.version}, local=${BuildConfig.VERSION_CODE}")
            if (release.version > BuildConfig.VERSION_CODE) {
                notify("Downloading v${release.version}…")
                downloadAndInstall(release)
            } else {
                Log.d(tag, "Up to date (v${BuildConfig.VERSION_CODE})")
                nm.cancel(notifId)
            }
        }
    }

    private suspend fun fetchLatest(): Release {
        val response = api.fetchLatestRelease()
        if (response.isSuccessful) {
            return response.body()!!
        } else {
            throw Exception("HTTP ${response.code()} during version check")
        }
    }

    private suspend fun downloadAndInstall(release: Release) {
        val apkFile = File(context.cacheDir, "family-update-v${release.version}.apk")
        try {
            Log.i(tag, "Downloading from ${release.url}")
            val responseBody = downloadApi.downloadFile(release.url)

            // Stream binary data directly to the cache file
            responseBody.byteStream().use { input ->
                apkFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            Log.i(tag, "Downloaded ${apkFile.length()} bytes to ${apkFile.path}")

            notify("Verifying download…")
            val digest = MessageDigest.getInstance("SHA-256")
            apkFile.inputStream().use { digest.update(it.readBytes()) }
            val computed = digest.digest().joinToString("") { "%02x".format(it) }
            Log.i(tag, "SHA-256 computed : $computed")
            Log.i(tag, "SHA-256 expected : ${release.sha256}")
            if (!computed.equals(release.sha256, ignoreCase = true)) {
                notifyError("SHA-256 mismatch — update aborted\nExpected: ${release.sha256.take(16)}…\nGot:      ${computed.take(16)}…")
                apkFile.delete()
                return
            }

            notify("Installing v${release.version}…")
            installApk(apkFile, release.version)
        } catch (e: Exception) {
            notifyError("Download/install failed: ${e.javaClass.simpleName}: ${e.message}")
            Log.e(tag, "downloadAndInstall exception", e)
            apkFile.delete()
        }
    }

    private fun installApk(apkFile: File, version: Int) {
        val installer = context.packageManager.packageInstaller
        val params    = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            Log.i(tag, "USER_ACTION_NOT_REQUIRED set (API ${Build.VERSION.SDK_INT})")
        } else {
            Log.i(tag, "API ${Build.VERSION.SDK_INT} < 31 — user action may be required")
        }
        val sessionId = installer.createSession(params)
        Log.i(tag, "PackageInstaller session created: $sessionId")
        installer.openSession(sessionId).use { session ->
            session.openWrite("package", 0, apkFile.length()).use { out ->
                apkFile.inputStream().copyTo(out)
                session.fsync(out)
            }
            // FLAG_MUTABLE is required — PackageInstaller fills in EXTRA_STATUS on the callback
            // intent, which FLAG_IMMUTABLE silently blocks, causing the receiver to never fire.
            val pi = PendingIntent.getBroadcast(
                context, sessionId,
                Intent(context, UpdateReceiver::class.java).putExtra("version", version),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            session.commit(pi.intentSender)
            Log.i(tag, "Session $sessionId committed")
        }
    }

    companion object {
        const val NOTIF_ID = 2001
    }

    fun notifyInstallResult(success: Boolean, version: Int, detail: String?) {
        if (success) {
            notifyDone("v$version installed successfully")
        } else {
            notifyError("Install failed (v$version): ${detail ?: "unknown error"}")
        }
    }
}
