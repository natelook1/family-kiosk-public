package ca.looknet.familykiosk

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class UpdateManager(private val context: Context) {

    private val tag = "UpdateManager"

    data class Release(val version: Int, val url: String, val sha256: String)

    fun checkAndUpdate() {
        CoroutineScope(Dispatchers.IO + SupervisorJob()).launch {
            val release = runCatching { fetchLatest() }.getOrElse {
                Log.w(tag, "Version check failed: ${it.message}")
                return@launch
            }
            if (release.version > BuildConfig.VERSION_CODE) {
                Log.i(tag, "New version ${release.version} available (current: ${BuildConfig.VERSION_CODE})")
                downloadAndInstall(release)
            } else {
                Log.d(tag, "Up to date (version ${BuildConfig.VERSION_CODE})")
            }
        }
    }

    private fun fetchLatest(): Release {
        val conn = URL("${BuildConfig.API_BASE}/kiosk/apk/latest").openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout    = 10_000
        val json = JSONObject(conn.inputStream.bufferedReader().readText())
        return Release(
            version = json.getInt("version"),
            url     = json.optString("url"),
            sha256  = json.optString("sha256"),
        )
    }

    private fun downloadAndInstall(release: Release) {
        val apkFile = File(context.cacheDir, "update-v${release.version}.apk")
        try {
            val conn = URL(release.url).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout    = 120_000
            conn.inputStream.use { input -> apkFile.outputStream().use { input.copyTo(it) } }

            // Verify SHA-256
            val digest = MessageDigest.getInstance("SHA-256")
            apkFile.inputStream().use { digest.update(it.readBytes()) }
            val computed = digest.digest().joinToString("") { "%02x".format(it) }
            if (!computed.equals(release.sha256, ignoreCase = true)) {
                Log.e(tag, "SHA-256 mismatch — aborting install")
                apkFile.delete()
                return
            }

            installApk(apkFile)
        } catch (e: Exception) {
            Log.e(tag, "Download failed: ${e.message}")
            apkFile.delete()
        }
    }

    private fun installApk(apkFile: File) {
        val installer = context.packageManager.packageInstaller
        val params    = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("package", 0, apkFile.length()).use { out ->
                apkFile.inputStream().copyTo(out)
                session.fsync(out)
            }
            val pi = PendingIntent.getBroadcast(
                context, sessionId,
                Intent(context, UpdateReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            session.commit(pi.intentSender)
        }
        Log.i(tag, "Install session committed for v${apkFile.name}")
    }
}
