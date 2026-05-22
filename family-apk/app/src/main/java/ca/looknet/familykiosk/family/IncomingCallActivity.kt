package ca.looknet.familykiosk.family

import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class IncomingCallActivity : AppCompatActivity() {

    private val handler          = Handler(Looper.getMainLooper())
    private val autoTimeout      = Runnable { finish() } // auto-dismiss after 60s
    private var ringtone: Ringtone? = null
    private var audioFocusRequest: AudioFocusRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep screen on and show over lock screen
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON  or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
        )

        val patientName = intent.getStringExtra("patient_name") ?: "Someone"
        val roomName    = intent.getStringExtra("room_name")    ?: ""
        val contactName = intent.getStringExtra("contact_name") ?: ""
        val autoAccept  = intent.getBooleanExtra("auto_accept", false)

        buildUI(patientName, roomName, contactName)
        hideSystemUI()

        handler.postDelayed(autoTimeout, 60_000)

        playRingtone()

        if (autoAccept) answerCall(roomName, patientName, contactName)
    }

    private fun playRingtone() {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            // Requesting audio focus stops the one-shot ringtone the notification channel
            // already started, so only our looping version plays (no double-ring).
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                .build()
            audioFocusRequest = req
            am.requestAudioFocus(req)

            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(this, uri)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ringtone?.isLooping = true
            }
            ringtone?.play()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun buildUI(patientName: String, roomName: String, contactName: String) {
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#111827"))
        }

        // Centre column
        val centre = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity     = Gravity.CENTER_HORIZONTAL
        }
        val centreParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER }

        // Avatar circle
        val avatarSize = (140 * resources.displayMetrics.density).toInt()
        val avatar = View(this).apply {
            background = createAvatarDrawable(patientName)
        }

        // Initial letter overlaid on avatar circle
        val initial = TextView(this).apply {
            text      = patientName.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
            textSize  = 56f
            setTextColor(Color.WHITE)
            gravity   = Gravity.CENTER
        }
        val avatarFrame = FrameLayout(this)
        avatarFrame.addView(avatar,  FrameLayout.LayoutParams(avatarSize, avatarSize))
        avatarFrame.addView(initial, FrameLayout.LayoutParams(avatarSize, avatarSize))

        val dp16 = (16 * resources.displayMetrics.density).toInt()
        val dp8  = (8  * resources.displayMetrics.density).toInt()

        centre.addView(avatarFrame, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER_HORIZONTAL })

        // "Incoming video call"
        centre.addView(TextView(this).apply {
            text     = "Incoming video call"
            textSize = 16f
            setTextColor(Color.parseColor("#9CA3AF"))
            gravity  = Gravity.CENTER
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, dp16, 0, dp8) })

        // Patient name
        centre.addView(TextView(this).apply {
            text     = patientName
            textSize = 36f
            setTextColor(Color.WHITE)
            gravity  = Gravity.CENTER
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ))

        root.addView(centre, centreParams)

        // Slide to answer / decline
        val sliderParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity      = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            bottomMargin = (64 * resources.displayMetrics.density).toInt()
            marginStart  = (32 * resources.displayMetrics.density).toInt()
            marginEnd    = (32 * resources.displayMetrics.density).toInt()
        }
        root.addView(buildSlider(roomName, patientName, contactName), sliderParams)
        setContentView(root)

        // Pad the root so buttons always sit above the navigation bar / gesture handle,
        // even when hideSystemUI() doesn't fully work over a lock screen.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val navBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
            val statusTop = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top
            view.setPadding(0, statusTop, 0, navBottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun buildSlider(roomName: String, patientName: String, contactName: String): LinearLayout {
        val dp      = resources.displayMetrics.density
        val trackH  = (68 * dp).toInt()
        val thumbSz = (52 * dp).toInt()
        val endSz   = trackH

        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity     = Gravity.CENTER_HORIZONTAL
        }

        val hint = TextView(this).apply {
            text     = "← Decline          Answer →"
            textSize = 12f
            setTextColor(Color.parseColor("#6B7280"))
            gravity  = Gravity.CENTER
            setPadding(0, 0, 0, (10 * dp).toInt())
        }

        val track = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#1F2937"))
                cornerRadius = trackH / 2f
            }
        }

        val declineIcon = TextView(this).apply {
            text     = "✕"
            textSize = 20f
            setTextColor(Color.parseColor("#EF4444"))
            gravity  = Gravity.CENTER
            alpha    = 0.45f
        }
        val answerIcon = TextView(this).apply {
            text     = "✓"
            textSize = 20f
            setTextColor(Color.parseColor("#22C55E"))
            gravity  = Gravity.CENTER
            alpha    = 0.45f
        }
        val thumb = TextView(this).apply {
            text      = "☎"
            textSize  = 22f
            setTextColor(Color.parseColor("#1F2937"))
            gravity   = Gravity.CENTER
            elevation = (6 * dp)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.WHITE)
            }
        }

        track.addView(declineIcon, FrameLayout.LayoutParams(endSz, trackH).apply { gravity = Gravity.START or Gravity.CENTER_VERTICAL })
        track.addView(answerIcon,  FrameLayout.LayoutParams(endSz, trackH).apply { gravity = Gravity.END   or Gravity.CENTER_VERTICAL })
        track.addView(thumb,       FrameLayout.LayoutParams(thumbSz, thumbSz).apply { gravity = Gravity.CENTER })

        var startX = 0f
        var startTx = 0f

        thumb.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX  = event.rawX
                    startTx = v.translationX
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val maxSlide = track.width / 2f - thumbSz / 2f - (8 * dp)
                    val tx = (startTx + event.rawX - startX).coerceIn(-maxSlide, maxSlide)
                    v.translationX = tx
                    val frac = if (maxSlide > 0f) tx / maxSlide else 0f
                    declineIcon.alpha = 0.45f + 0.55f * (-frac).coerceIn(0f, 1f)
                    answerIcon.alpha  = 0.45f + 0.55f * frac.coerceIn(0f, 1f)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val maxSlide = track.width / 2f - thumbSz / 2f - (8 * dp)
                    val frac = if (maxSlide > 0f) v.translationX / maxSlide else 0f
                    when {
                        frac >  0.55f -> answerCall(roomName, patientName, contactName)
                        frac < -0.55f -> declineCall()
                        else -> {
                            v.animate().translationX(0f).setDuration(220).start()
                            declineIcon.animate().alpha(0.45f).setDuration(220).start()
                            answerIcon.animate().alpha(0.45f).setDuration(220).start()
                        }
                    }
                    true
                }
                else -> false
            }
        }

        outer.addView(hint)
        outer.addView(track, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, trackH))
        return outer
    }

    private fun createAvatarDrawable(name: String): android.graphics.drawable.GradientDrawable {
        val colors = listOf(0xFF3B82F6, 0xFF8B5CF6, 0xFF10B981, 0xFFF59E0B, 0xFFEF4444)
        val color  = colors[name.hashCode().and(0x7FFFFFFF) % colors.size]
        return android.graphics.drawable.GradientDrawable().apply {
            shape  = android.graphics.drawable.GradientDrawable.OVAL
            setColor(color.toInt())
        }
    }

    private fun answerCall(roomName: String, patientName: String, contactName: String) {
        handler.removeCallbacks(autoTimeout)
        dismissNotification()
        ringtone?.stop()
        startActivity(
            Intent(this, CallWebViewActivity::class.java).apply {
                putExtra("room_name",    roomName)
                putExtra("patient_name", patientName)
                putExtra("contact_name", contactName)
            }
        )
        finish()
    }

    private fun declineCall() {
        handler.removeCallbacks(autoTimeout)
        dismissNotification()
        ringtone?.stop()
        finish()
    }

    private fun dismissNotification() {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(FcmService.CALL_NOTIF_ID)
    }

    private fun hideSystemUI() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            )
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(autoTimeout)
        ringtone?.stop()
        audioFocusRequest?.let {
            (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(it)
        }
    }
}
