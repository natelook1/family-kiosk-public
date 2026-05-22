package ca.looknet.familykiosk

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class KioskCallService : Service() {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var lastCallId: String? = null
    private lateinit var partialWakeLock: PowerManager.WakeLock
    private var urgentFlushJob: Job? = null

    companion object {
        private const val TAG               = "KioskCallSvc"
        private const val POLL_MS           = 3_000L
        private const val LOG_INTERVAL      = 5 * 60 * 1000L
        private const val URGENT_FLUSH_MS   = 10_000L  // debounce window after an E/W log
        private const val NOTIF_ID          = 1001
        private const val CHANNEL_ID        = "kiosk_bg"
        private const val PREFS_LAST_LOG_AT = "last_log_upload_at"

        // Weak reference so the static call site can reach the live instance without leaking it
        private var instance: java.lang.ref.WeakReference<KioskCallService>? = null

        fun scheduleUrgentFlush() {
            instance?.get()?.scheduleUrgentFlushInternal()
        }
        private val LOG_TAGS = listOf(
            "KioskCallSvc", "KioskJS", "FamilyKiosk", "KioskUpdate",
            "KioskMain", "KioskCache", "UpdateManager",
            "KioskRing", "KioskRingback", "KioskAudio", "KioskBT", "KioskWifi", "KioskConfig",
            "KioskWebView",
            "AndroidRuntime", "ActivityManager",
            "lowmemorykiller", "art", "hwui", "RenderThread"
        )

        fun start(context: Context) {
            val intent = Intent(context, KioskCallService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Synchronous log flush — safe to call just before exit(0) or from an
         * uncaught-exception handler. Blocks the calling thread (max ~12 s).
         */
        fun flushLogsNow(context: Context) {
            try {
                val prefs    = context.getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)
                val deviceId = prefs.getString("device_id_native", "") ?: ""
                val apiKey   = prefs.getString("api_key", "devkey") ?: "devkey"
                if (deviceId.isEmpty()) return

                val lastAt  = prefs.getLong(PREFS_LAST_LOG_AT, 0L)
                val sinceMs = lastAt - 5_000

                val cmd = mutableListOf("logcat", "-d", "-v", "epoch")
                    .apply { addAll(LOG_TAGS.map { "$it:V" }); add("*:S") }
                val proc = Runtime.getRuntime().exec(cmd.toTypedArray())
                val raw  = proc.inputStream.bufferedReader().readText()
                proc.destroy()

                val lines      = mutableListOf<org.json.JSONObject>()
                val epochRegex = Regex("""^(\d+\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([\w./-]+)\s*:\s*(.*)$""")
                for (line in raw.lines()) {
                    val m      = epochRegex.matchEntire(line.trim()) ?: continue
                    val epochMs = (m.groupValues[1].toDoubleOrNull() ?: continue).toLong() * 1000
                    if (epochMs <= sinceMs) continue
                    lines.add(org.json.JSONObject().apply {
                        put("loggedAt", epochMs)
                        put("level",    m.groupValues[2])
                        put("tag",      m.groupValues[3])
                        put("message",  m.groupValues[4])
                    })
                }
                if (lines.isEmpty()) return

                val payload = org.json.JSONObject()
                payload.put("lines", org.json.JSONArray(lines.takeLast(1000)))

                val conn = URL("${BuildConfig.API_BASE}/tablet/$deviceId/logs")
                    .openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Connection", "close")
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("x-api-key", apiKey)
                conn.doOutput      = true
                conn.connectTimeout = 8_000
                conn.readTimeout    = 8_000
                try {
                    conn.outputStream.write(payload.toString().toByteArray())
                    if (conn.responseCode == 200) {
                        prefs.edit().putLong(PREFS_LAST_LOG_AT, System.currentTimeMillis()).apply()
                        Log.i("KioskLogSync", "flushLogsNow: uploaded ${lines.size} lines")
                    } else {
                        Log.w("KioskLogSync", "flushLogsNow: server returned ${conn.responseCode}")
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                Log.e("KioskLogSync", "flushLogsNow failed", e)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = java.lang.ref.WeakReference(this)
        createNotificationChannel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34+: use remoteMessaging (dataSync removed in API 35)
            startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, buildNotification())
        }
        acquirePartialWakeLock()
        startPolling()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        instance = null
        scope.cancel()
        if (::partialWakeLock.isInitialized && partialWakeLock.isHeld) partialWakeLock.release()
        flushLogsNow(this)
        super.onDestroy()
    }

    private fun scheduleUrgentFlushInternal() {
        urgentFlushJob?.cancel()
        urgentFlushJob = scope.launch {
            delay(URGENT_FLUSH_MS)
            try { uploadLogs() } catch (e: Exception) { Log.e(TAG, "urgent flush error", e) }
        }
    }

    @SuppressLint("WakelockTimeout")
    private fun acquirePartialWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        partialWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FamilyKiosk:CallService")
        partialWakeLock.acquire()
    }

    private fun startPolling() {
        scope.launch {
            while (isActive) {
                try {
                    // Ensure the poll operation doesn't hang indefinitely
                    withTimeout(10_000L) { poll() }
                } catch (e: java.io.IOException) {
                    Log.w(TAG, "poll network error: ${e.message}")
                } catch (e: TimeoutCancellationException) {
                    Log.w(TAG, "poll timed out after 10s")
                } catch (e: Exception) { 
                    Log.e(TAG, "poll unexpected error", e) 
                }
                delay(POLL_MS)
            }
        }
        scope.launch {
            while (isActive) {
                delay(LOG_INTERVAL)
                try { uploadLogs() } catch (e: Exception) { Log.e(TAG, "log upload error", e) }
            }
        }
    }

    private fun poll() {
        val prefs     = getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)
        val patientId = prefs.getString("patient_id", "") ?: ""
        val deviceId  = prefs.getString("device_id_native", "") ?: ""
        val apiKey    = prefs.getString("api_key", "devkey") ?: "devkey"
        if (patientId.isEmpty() || deviceId.isEmpty()) return

        val url = "${BuildConfig.API_BASE}/kiosk/patient/$patientId/incoming-call" +
            "?deviceId=${URLEncoder.encode(deviceId, "UTF-8")}&_t=${System.currentTimeMillis()}"

        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8_000
        conn.readTimeout    = 8_000
        // Force connection close to avoid stale sockets during network transitions
        conn.setRequestProperty("Connection", "close")
        conn.setRequestProperty("x-api-key", apiKey)
        try {
            if (conn.responseCode == 200) {
                val body   = conn.inputStream.bufferedReader().readText()
                val call   = runCatching { JSONObject(body) }.getOrNull()
                val callId = call?.optString("callId")?.takeIf { it.isNotEmpty() }
                if (callId != null && callId != lastCallId) {
                    lastCallId = callId
                    wakeAndNotify(call)
                } else if (callId == null) {
                    lastCallId = null
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun uploadLogs() = flushLogsNow(this)

    @SuppressLint("WakelockTimeout")
    private fun wakeAndNotify(call: JSONObject) {
        Log.i(TAG, "Incoming call: ${call.optString("callId")} — waking screen")

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) {
            @Suppress("DEPRECATION")
            val screenWake = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "FamilyKiosk:CallWake"
            )
            screenWake.acquire(10_000L)
        }

        startActivity(
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                putExtra("incoming_call_json", call.toString())
            }
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Kiosk Background", NotificationManager.IMPORTANCE_MIN
            ).apply {
                setShowBadge(false)
                enableLights(false)
                enableVibration(false)
            }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Family Kiosk")
                .setContentText("Ready for calls")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pi)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("Family Kiosk")
                .setContentText("Ready for calls")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pi)
                .setOngoing(true)
                .build()
        }
    }
}
