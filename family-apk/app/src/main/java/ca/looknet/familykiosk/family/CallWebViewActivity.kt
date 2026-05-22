package ca.looknet.familykiosk.family

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.util.Rational
import android.app.PictureInPictureParams
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.Gravity
import android.util.Log
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.os.Build
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

class CallWebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var statusBar: TextView

    private var toneGenerator: ToneGenerator? = null
    private val ringbackHandler = Handler(Looper.getMainLooper())
    private var isRinging = false

    private var audioFocusRequest: AudioFocusRequest? = null

    inner class FamilyBridge {
        @JavascriptInterface
        fun closeCall() = Handler(Looper.getMainLooper()).post {
            stopRingback()
            webView.loadUrl("about:blank")
            finish()
        }

        @JavascriptInterface
        fun updateStatus(stage: String) = Handler(Looper.getMainLooper()).post {
            statusBar.text = stage
            statusBar.visibility = if (stage.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE
            
            // Stop ringback when connected or disconnected (stage becomes empty)
            if (stage.isEmpty()) {
                stopRingback()
            }
        }

        @JavascriptInterface
        fun enableSpeakerphone() = Handler(Looper.getMainLooper()).post {
            stopRingback()
            routeAudioForCall()
        }

        @JavascriptInterface
        fun switchAudioOutput(target: String) = Handler(Looper.getMainLooper()).post {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            when (target) {
                "handset"   -> routeToEarpiece(am)
                "bluetooth" -> routeToBluetoothSco(am)
                else        -> routeToSpeaker(am)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep showing over the lock screen after IncomingCallActivity hands off the call.
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON  or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
        )

        // Accept either a full pre-built URL or individual parts
        val url = intent.getStringExtra("url") ?: run {
            val roomName    = intent.getStringExtra("room_name")    ?: ""
            val patientName = intent.getStringExtra("patient_name") ?: ""
            val contactName = intent.getStringExtra("contact_name") ?: ""
            val deviceId    = SecurityUtils.getSecurePrefs(this)
                .getString("device_id", "") ?: ""
            val deviceToken = SecurityUtils.getSecurePrefs(this)
                .getString("device_token", "") ?: ""
            buildString {
                append(BuildConfig.FAMILY_APP_URL)
                append("?room="); append(roomName)
                append("&patient="); append(java.net.URLEncoder.encode(patientName, "UTF-8"))
                append("&contact="); append(java.net.URLEncoder.encode(contactName, "UTF-8"))
                append("&deviceId="); append(deviceId)
                append("&deviceToken="); append(deviceToken)
                append("&caller=1")
            }
        }

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled                = true
                domStorageEnabled                = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode                 = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            addJavascriptInterface(FamilyBridge(), "FamilyBridge")
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest?) {
                    request?.grant(request.resources)
                }
                override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                    msg ?: return false
                    val text = "[${msg.sourceId()}:${msg.lineNumber()}] ${msg.message()}"
                    when (msg.messageLevel()) {
                        ConsoleMessage.MessageLevel.ERROR   -> Log.e("FamilyCallWebView", text)
                        ConsoleMessage.MessageLevel.WARNING -> Log.w("FamilyCallWebView", text)
                        else                                -> Log.d("FamilyCallWebView", text)
                    }
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = false
                override fun onPageFinished(view: WebView?, url: String?) {
                    if (url == "about:blank") return
                    val prefs       = SecurityUtils.getSecurePrefs(this@CallWebViewActivity)
                    val deviceId    = prefs.getString("device_id",    "") ?: ""
                    val deviceToken = prefs.getString("device_token", "") ?: ""
                    if (deviceId.isNotEmpty()) {
                        view?.evaluateJavascript(
                            "localStorage.setItem('family_device_id','${deviceId.replace("'","\\'")}');" +
                            "localStorage.setItem('family_device_token','${deviceToken.replace("'","\\'")}');",
                            null
                        )
                    }
                }
            }
        }

        // Native status bar overlaid at the top so we can show call stage from JS
        val dp = resources.displayMetrics.density
        statusBar = TextView(this).apply {
            text       = "Connecting…"
            textSize   = 13f
            setTextColor(Color.WHITE)
            gravity    = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#CC000000"))
            setPadding(0, (28 * dp).toInt(), 0, (10 * dp).toInt())
        }

        val frame = FrameLayout(this)
        frame.addView(webView,   FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        frame.addView(statusBar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))

        setContentView(frame)
        hideSystemUI()
        routeAudioForCall()
        startRingback()
        webView.loadUrl(url)
    }

    override fun onBackPressed() {
        stopRingback()
        webView.loadUrl("about:blank")
        finish()
    }

    override fun onUserLeaveHint() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .build()
            enterPictureInPictureMode(params)
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode)
        statusBar.visibility = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
        if (isInPictureInPictureMode) hideSystemUI()
    }

    override fun onDestroy() {
        stopRingback()
        resetAudio()
        super.onDestroy()
        webView.destroy()
    }

    private val ringbackRunnable = object : Runnable {
        override fun run() {
            if (!isRinging) return
            try {
                if (toneGenerator == null) {
                    toneGenerator = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 100)
                }
                toneGenerator?.stopTone()
                // TONE_SUP_RINGTONE is the standard telephone ringback (the sound the caller hears)
                toneGenerator?.startTone(ToneGenerator.TONE_SUP_RINGTONE, 2000)
            } catch (e: Exception) {
                Log.e("FamilyCallWebView", "ToneGenerator failed", e)
            }
            // Repeat every 4 seconds (2s playing, 2s silence)
            ringbackHandler.postDelayed(this, 4000)
        }
    }

    private fun startRingback() {
        isRinging = true
        ringbackHandler.post(ringbackRunnable)
    }

    private fun stopRingback() {
        isRinging = false
        ringbackHandler.removeCallbacks(ringbackRunnable)
        try {
            toneGenerator?.stopTone()
            toneGenerator?.release()
            toneGenerator = null
        } catch (e: Exception) {
            // ignore
        }
    }

    private fun routeAudioForCall() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager

        // Request audio focus for voice communication
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .build().also { am.requestAudioFocus(it) }
        }

        // MODE_IN_COMMUNICATION is required for WebRTC echo cancellation
        am.mode = AudioManager.MODE_IN_COMMUNICATION

        // Prefer BT SCO if a headset is connected, otherwise use speaker
        if (hasBtScoDevice(am)) {
            routeToBluetoothSco(am)
        } else {
            routeToSpeaker(am)
        }
    }

    private fun hasBtScoDevice(am: AudioManager): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.availableCommunicationDevices.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        } else {
            @Suppress("DEPRECATION")
            am.isBluetoothScoAvailableOffCall
        }
    }

    private fun routeToBluetoothSco(am: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val bt = am.availableCommunicationDevices.find { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            if (bt != null) {
                val ok = am.setCommunicationDevice(bt)
                Log.i("FamilyCallWebView", "BT SCO route set: $ok (${bt.productName})")
                if (!ok) routeToSpeaker(am)
                return
            }
        } else {
            try {
                @Suppress("DEPRECATION")
                am.startBluetoothSco()
                @Suppress("DEPRECATION")
                am.isBluetoothScoOn = true
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
                Log.i("FamilyCallWebView", "BT SCO started (legacy)")
                return
            } catch (e: Exception) {
                Log.e("FamilyCallWebView", "BT SCO start failed", e)
            }
        }
        routeToSpeaker(am)
    }

    private fun routeToSpeaker(am: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val speaker = am.availableCommunicationDevices.find { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            if (speaker != null) {
                val ok = am.setCommunicationDevice(speaker)
                Log.i("FamilyCallWebView", "Speaker route set: $ok")
            }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = true
        }
    }

    private fun routeToEarpiece(am: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val earpiece = am.availableCommunicationDevices.find { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            if (earpiece != null) {
                val ok = am.setCommunicationDevice(earpiece)
                Log.i("FamilyCallWebView", "Earpiece route set: $ok")
                return
            }
        } else {
            @Suppress("DEPRECATION")
            runCatching { am.stopBluetoothSco() }
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = false
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
            Log.i("FamilyCallWebView", "Earpiece route set (legacy)")
        }
    }

    private fun resetAudio() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            runCatching { audioManager.stopBluetoothSco() }
            @Suppress("DEPRECATION")
            audioManager.isBluetoothScoOn  = false
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn  = false
        }

        audioManager.mode = AudioManager.MODE_NORMAL

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            audioFocusRequest = null
        }
    }

    private fun hideSystemUI() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
    }
}
