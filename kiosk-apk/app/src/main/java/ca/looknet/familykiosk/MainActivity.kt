package ca.looknet.familykiosk

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlarmManager
import android.app.ActivityManager
import android.app.AlertDialog
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import ca.looknet.familykiosk.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.graphics.Color
import android.media.AudioManager
import kotlin.math.roundToInt
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebSettings
import android.net.http.SslError
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import java.io.File
import java.io.FileInputStream
import java.util.Calendar
import java.util.TimeZone
import kotlin.system.exitProcess
import kotlinx.coroutines.*

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var wakeLock: PowerManager.WakeLock
    private var relockButton: Button? = null
    private var updateJob: Job? = null

    private val prefs get() = getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)

    // Secret tap-zone: 5 taps in bottom-right corner within 3 s → PIN dialog
    private var tapCount   = 0
    private var firstTapMs = 0L

    // ── Lifecycle ─────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled", "WakelockTimeout")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        acquireWakeLock()
        enterLockTaskIfOwner()

        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            Log.e("KioskMain", "UNCAUGHT EXCEPTION on ${thread.name}", throwable)
            runCatching {
                KioskCallService.flushLogsNow(applicationContext)
            }
            defaultHandler?.uncaughtException(thread, throwable)
        }

        configureAudio()

        webView = buildWebView()

        // Apply persisted display preferences before the first page load
        val savedPrefs = getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)
        savedPrefs.getFloat("font_scale", 0f).takeIf { it > 0f }?.let { applyFontScale(it) }
        savedPrefs.getString("orientation", "")?.takeIf { it.isNotEmpty() }?.let { applyOrientation(it) }

        val frame = FrameLayout(this)
        frame.addView(webView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // Invisible tap zone in bottom-right corner (staff gesture to show PIN dialog)
        val dp   = resources.displayMetrics.density
        val zone = View(this)
        val zoneParams = FrameLayout.LayoutParams((72 * dp).toInt(), (72 * dp).toInt())
        zoneParams.gravity = Gravity.BOTTOM or Gravity.END
        frame.addView(zone, zoneParams)
        zone.setOnClickListener { onSecretTap() }

        // Floating relock button — only visible while lock task is suspended
        val relock = Button(this)
        relock.text = "Lock Kiosk"
        relock.setBackgroundColor(Color.parseColor("#CC1F2937"))
        relock.setTextColor(Color.WHITE)
        relock.visibility = View.GONE
        val relockParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        )
        relockParams.gravity = Gravity.TOP or Gravity.END
        relockParams.topMargin   = (20 * dp).toInt()
        relockParams.rightMargin = (20 * dp).toInt()
        frame.addView(relock, relockParams)
        relockButton = relock
        relock.setOnClickListener { relockKiosk() }

        setContentView(frame)
        hideSystemUI()

        val url = prefs.getString("kiosk_url", BuildConfig.KIOSK_URL) ?: BuildConfig.KIOSK_URL
        webView.loadUrl(url)

        val runtimePerms = mutableListOf(
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.BLUETOOTH_CONNECT,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runtimePerms.add(android.Manifest.permission.BLUETOOTH_SCAN)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runtimePerms.add(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        // Always request camera + audio — even if policy-granted via setPermissionGrantState,
        // calling requestPermissions registers an explicit user grant that Chromium's native 
        // WebRTC stack requires to function correctly inside a WebView.
        requestPermissions(runtimePerms.toTypedArray(), 1)

        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        Log.i("KioskMain", "isDeviceOwner=${dpm.isDeviceOwnerApp(packageName)} " +
            "RECORD_AUDIO=${checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)} " +
            "CAMERA=${checkSelfPermission(android.Manifest.permission.CAMERA)}")

        // Start background call-detection service
        KioskCallService.start(this)

        // Check for APK updates and schedule re-check every 6 hours
        updateJob = CoroutineScope(Dispatchers.Main).launch {
            while (isActive) {
                UpdateManager(applicationContext).checkAndUpdate()
                delay(6 * 60 * 60 * 1000L)
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val callJson = intent?.getStringExtra("incoming_call_json") ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true)
            setShowWhenLocked(true)
        }
        webView.post {
            webView.evaluateJavascript(
                """window.dispatchEvent(new CustomEvent('incomingCallFromNative',{detail:$callJson}))""",
                null
            )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && relockButton?.visibility != View.VISIBLE) hideSystemUI()
    }

    override fun onResume() {
        super.onResume()
        val lockState = (getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).lockTaskModeState
        Log.i("KioskMain", "onResume: lockTaskState=$lockState staffUnlocked=${relockButton?.visibility == View.VISIBLE}")
        if (relockButton?.visibility != View.VISIBLE) {
            enterLockTaskIfOwner()
        }
    }

    override fun onPause() {
        super.onPause()
        KioskCallService.scheduleUrgentFlush()
    }

    override fun onStop() {
        super.onStop()
        KioskCallService.scheduleUrgentFlush()
    }

    @Deprecated("Handled to block navigation in kiosk mode")
    override fun onBackPressed() {
        // Block back navigation
    }

    override fun onDestroy() {
        super.onDestroy()
        updateJob?.cancel()
        if (::wakeLock.isInitialized && wakeLock.isHeld) wakeLock.release()
        val ctx = applicationContext
        Thread { KioskCallService.flushLogsNow(ctx) }.apply { isDaemon = false; start() }
    }

    fun configureAudio() {
        val am    = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val prefs = getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)

        am.mode = AudioManager.MODE_IN_COMMUNICATION

        val volPct = prefs.getInt("ring_volume", 100)
        for (stream in listOf(AudioManager.STREAM_RING, AudioManager.STREAM_VOICE_CALL, AudioManager.STREAM_MUSIC)) {
            val max = am.getStreamMaxVolume(stream)
            am.setStreamVolume(stream, (max * volPct / 100.0).roundToInt(), 0)
        }

        val btAddress = prefs.getString("bt_device_address", "") ?: ""
        @Suppress("DEPRECATION")
        val scoAvailable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            true else am.isBluetoothScoAvailableOffCall

        if (btAddress.isNotEmpty() && scoAvailable) {
            try {
                am.startBluetoothSco()
                am.isBluetoothScoOn     = true
                am.isSpeakerphoneOn = false
                Log.i("KioskAudio", "BT SCO started for $btAddress")
            } catch (e: Exception) {
                Log.e("KioskAudio", "BT SCO failed, falling back to speaker", e)
                enableSpeakerphoneNative(am)
            }
        } else {
            enableSpeakerphoneNative(am)
        }
    }

    private fun enableSpeakerphoneNative(am: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val speaker = am.availableCommunicationDevices.find { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            if (speaker != null) {
                val result = am.setCommunicationDevice(speaker)
                if (!result) {
                    Log.e("KioskAudio", "Failed to set communication device to speaker")
                }
            }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = true
        }
    }

    fun applyFontScale(scale: Float) {
        webView.settings.textZoom = (scale * 100).roundToInt().coerceIn(80, 200)
    }

    fun applyOrientation(mode: String) {
        requestedOrientation = when (mode.lowercase()) {
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            "auto"     -> ActivityInfo.SCREEN_ORIENTATION_SENSOR
            else       -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
    }

    fun hideSystemUI() = applySystemUIFlags()

    // ── Lock task helpers ─────────────────────────────────────────

    fun enterLockTaskIfOwner() {
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val isOwner = dpm.isDeviceOwnerApp(packageName)
        Log.i("KioskMain", "enterLockTaskIfOwner: isDeviceOwner=$isOwner")
        if (!isOwner) {
            Log.w(
                "KioskMain",
                "Not device owner — lockout cannot be enforced. Provision with ADB."
            )
            return
        }

        val admin = ComponentName(this, DeviceAdminReceiver::class.java)

        try {
            dpm.setLockTaskPackages(admin, arrayOf(packageName))
        } catch (e: Exception) {
            Log.e("KioskMain", "setLockTaskPackages failed: ${e.message}")
        }

        val permissionsToGrant = mutableListOf(
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.CHANGE_WIFI_STATE,
            android.Manifest.permission.REQUEST_INSTALL_PACKAGES,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissionsToGrant.add(android.Manifest.permission.BLUETOOTH_CONNECT)
            permissionsToGrant.add(android.Manifest.permission.BLUETOOTH_SCAN)
        }
        permissionsToGrant.forEach { perm ->
            try {
                dpm.setPermissionGrantState(
                    admin, packageName, perm,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
                )
            } catch (e: Exception) {
                Log.e("KioskMain", "Failed to grant $perm: ${e.message}")
            }
        }

        try {
            val homeFilter = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            dpm.addPersistentPreferredActivity(
                admin, homeFilter,
                ComponentName(packageName, MainActivity::class.java.name)
            )
        } catch (e: Exception) {
            Log.e("KioskMain", "addPersistentPreferredActivity failed: ${e.message}")
        }

        val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val alreadyLocked = am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
        if (alreadyLocked) {
            Log.i("KioskMain", "Already in lock task mode — skipping startLockTask()")
            return
        }
        try {
            startLockTask()
            Log.i("KioskMain", "startLockTask() succeeded")
        } catch (e: Exception) {
            Log.e("KioskMain", "startLockTask() failed: ${e.message}", e)
        }
    }

    private fun relockKiosk() {
        enterLockTaskIfOwner()
        relockButton?.visibility = View.GONE
        hideSystemUI()
    }

    // ── Secret unlock gesture ─────────────────────────────────────

    private fun onSecretTap() {
        val now = System.currentTimeMillis()
        if (now - firstTapMs > 3_000) { tapCount = 0; firstTapMs = now }
        if (++tapCount >= 5) {
            tapCount = 0
            showPinDialog()
        }
    }

    private fun showPinDialog() {
        val pin = prefs.getString("unlock_pin", BuildConfig.UNLOCK_PIN) ?: BuildConfig.UNLOCK_PIN

        val input = EditText(this)
        input.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        input.hint = "Staff PIN"

        AlertDialog.Builder(this)
            .setTitle("Unlock Kiosk")
            .setMessage("Enter staff PIN to exit kiosk mode")
            .setView(input)
            .setPositiveButton("Unlock") { _, _ ->
                if (input.text.toString() == pin) {
                    stopLockTask()
                    relockButton?.visibility = View.VISIBLE
                } else {
                    android.widget.Toast.makeText(this, "Incorrect PIN", android.widget.Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ── Scheduled daily restart ───────────────────────────────────

    fun scheduleRestart(hour: Int) {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (timeInMillis <= System.currentTimeMillis()) add(Calendar.DAY_OF_YEAR, 1)
        }
        val pi = PendingIntent.getBroadcast(
            this, 99,
            Intent(this, RestartReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.timeInMillis, pi)
    }

    fun cancelRestartAlarm() {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = PendingIntent.getBroadcast(
            this, 99,
            Intent(this, RestartReceiver::class.java),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
        )
        pi?.let { am.cancel(it) }
    }

    fun performRestart() {
        Log.i("KioskMain", "Initiating clean restart")

        val launchIntent = packageManager
            .getLaunchIntentForPackage(packageName)
            ?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }

        if (launchIntent != null) {
            val pendingIntent = PendingIntent.getActivity(
                this,
                12345,
                launchIntent,
                PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager

            Log.i("KioskMain", "Scheduling relaunch alarm for +3s")
            alarmManager.setExactAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis() + 3000,
                pendingIntent
            )
        }

        runCatching {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            if (am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
                stopLockTask()
            }
        }

        KioskCallService.flushLogsNow(applicationContext)

        finishAndRemoveTask()

        Handler(Looper.getMainLooper()).postDelayed({
            Log.i("KioskMain", "Killing process now")
            android.os.Process.killProcess(android.os.Process.myPid())
            exitProcess(0)
        }, 1000)
    }

    // ── Private helpers ───────────────────────────────────────────

    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "FamilyKiosk:WakeLock"
        )
        wakeLock.acquire()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val wv = WebView(this)
        wv.setBackgroundColor(Color.BLACK)

        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode  = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode          = WebSettings.LOAD_DEFAULT
            useWideViewPort   = true
            loadWithOverviewMode = true
        }

        wv.addJavascriptInterface(KioskJsInterface(this), "Android")
        wv.webViewClient   = KioskWebViewClient(this)
        wv.webChromeClient = KioskWebChromeClient()

        return wv
    }

    private fun applySystemUIFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
            )
        }
    }
}

// ── WebViewClient with photo cache interception ───────────────────

private class KioskWebViewClient(private val activity: MainActivity) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = false

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
        val url = request?.url?.toString() ?: return null
        if (!url.contains("photos.looknet.ca")) return null

        val uri = android.net.Uri.parse(url)
        val filename = uri.path?.replace("/", "_")?.trim('_')
            ?.takeIf { it.isNotEmpty() && it.contains(".") } ?: return null
        
        val baseCacheDir = File(activity.filesDir, "photo_cache")
        val cacheFile = File(baseCacheDir, filename)

        // Traversal verification check
        if (!cacheFile.canonicalPath.startsWith(baseCacheDir.canonicalPath)) {
            Log.e("KioskCache", "Blocked path traversal attempt: $filename")
            return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, null)
        }

        if (cacheFile.exists() && cacheFile.length() > 0) {
            Log.d("KioskCache", "HIT  $filename (${cacheFile.length()}B)")
            val headers = mapOf("Access-Control-Allow-Origin" to "*")
            return WebResourceResponse(mimeFor(filename), "utf-8", 200, "OK", headers, FileInputStream(cacheFile))
        }

        Log.w("KioskCache", "MISS $filename — falling back to network")
        return null
    }

    override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
        super.onReceivedError(view, request, error)
        if (request?.isForMainFrame == true) {
            Log.w("KioskMain", "Main frame load failed: ${error?.description}. Retrying in 10s...")
            view?.postDelayed({
                if (activity.isFinishing || activity.isDestroyed) return@postDelayed
                val url = activity.getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)
                    .getString("kiosk_url", BuildConfig.KIOSK_URL) ?: BuildConfig.KIOSK_URL
                view.loadUrl(url)
            }, 10_000)
        }
    }

    @Suppress("DEPRECATION")
    override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
        handler?.cancel()
    }

    private fun mimeFor(name: String) = when (name.substringAfterLast(".").lowercase()) {
        "png"  -> "image/png"
        "webp" -> "image/webp"
        else   -> "image/jpeg"
    }
}

// ── WebChromeClient ───────────────────────────────────────────────

private class KioskWebChromeClient : WebChromeClient() {

    override fun onPermissionRequest(request: PermissionRequest?) {
        request?.grant(request.resources)
    }

    override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
        msg ?: return false
        val tag  = "KioskWebView"
        val text = "[${msg.sourceId()}:${msg.lineNumber()}] ${msg.message()}"
        when (msg.messageLevel()) {
            ConsoleMessage.MessageLevel.ERROR   -> Log.e(tag, text)
            ConsoleMessage.MessageLevel.WARNING -> Log.w(tag, text)
            else                                -> Log.d(tag, text)
        }
        return true
    }
}