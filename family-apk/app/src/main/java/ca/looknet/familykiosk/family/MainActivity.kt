package ca.looknet.familykiosk.family

import android.Manifest
import android.animation.ValueAnimator
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.*
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : AppCompatActivity() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val api   = NetworkClient.api

    // Persistent state
    private var pairedDeviceId: String? = null
    private var pendingCallbackId: String? = null
    private var currentJoinUrl: String?   = null
    private var currentPatientPhotoUrl: String? = null
    private var statusPollJob: Job? = null

    // Settings (stored in plain SharedPreferences — purely UI, not sensitive)
    private val settingsPrefs by lazy { getSharedPreferences("app_settings", Context.MODE_PRIVATE) }
    private var accentColor: String
        get()      = settingsPrefs.getString("accent_color", "green") ?: "green"
        set(value) = settingsPrefs.edit().putString("accent_color", value).apply()
    private var controlsAutoHide: Boolean
        get()      = settingsPrefs.getBoolean("controls_auto_hide", true)
        set(value) = settingsPrefs.edit().putBoolean("controls_auto_hide", value).apply()
    private var cameraOnByDefault: Boolean
        get()      = settingsPrefs.getBoolean("camera_on_default", true)
        set(value) = settingsPrefs.edit().putBoolean("camera_on_default", value).apply()

    // View refs for dynamic updates
    private var callCircleView:   View?     = null
    private var callStatusView:   TextView? = null
    private var callbackBtnView:  TextView? = null
    private var callbackMsgView:  TextView? = null
    private var avatarImageView:  ImageView? = null
    private var avatarLetterView: TextView? = null
    private var statusRingView:   View?     = null
    private var onlineDotView:    View?     = null
    private var nameLabel:        TextView? = null
    private var lastSeenLabel:    TextView? = null
    private var callHistoryContainer: LinearLayout? = null
    private var callHistorySection:   View? = null
    private var refreshSpinner:   View?     = null
    private var breathingRing1:   View?     = null
    private var breathingRing2:   View?     = null

    // Pull-to-refresh
    private var touchStartY = 0f
    private var pullDelta   = 0f
    private val pullThresholdDp = 72f

    private var lastInCall = false
    private var lastIsOnline = false

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { }

    private val qrLauncher = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        val raw = result.contents ?: return@registerForActivityResult
        val token = if (raw.startsWith("familykiosk://")) {
            android.net.Uri.parse(raw).getQueryParameter("token") ?: raw
        } else raw
        pendingPairCallback?.invoke(token)
    }
    private var pendingPairCallback: ((String) -> Unit)? = null

    // ── Accent colour helpers ─────────────────────────────────────────────────

    private data class Accent(val bg: Int, val dark: Int, val text: Int, val ring: Int)
    private fun accent(): Accent = when (accentColor) {
        "blue"   -> Accent(Color.parseColor("#3B82F6"), Color.parseColor("#2563EB"), Color.parseColor("#60A5FA"), Color.parseColor("#3B82F6"))
        "purple" -> Accent(Color.parseColor("#A855F7"), Color.parseColor("#9333EA"), Color.parseColor("#C084FC"), Color.parseColor("#A855F7"))
        "orange" -> Accent(Color.parseColor("#F97316"), Color.parseColor("#EA6C0A"), Color.parseColor("#FB923C"), Color.parseColor("#F97316"))
        else     -> Accent(Color.parseColor("#22C55E"), Color.parseColor("#16A34A"), Color.parseColor("#4ADE80"), Color.parseColor("#22C55E"))
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestPermissionsIfNeeded()
        checkFullScreenIntentPermission()
        checkInstallPackagesPermission()
        UpdateManager(this).checkAndUpdate()
        schedulePeriodicUpdateCheck()

        val deepLinkToken = intent?.data
            ?.takeIf { it.scheme == "familykiosk" && it.host == "pair" }
            ?.getQueryParameter("token")

        if (deepLinkToken != null) { showPairing(prefillToken = deepLinkToken); return }

        val prefs    = SecurityUtils.getSecurePrefs(this)
        val deviceId = prefs.getString("device_id", null)
        if (deviceId != null) {
            showPairedScreen(
                deviceId       = deviceId,
                patientName    = prefs.getString("patient_name",      null) ?: "Your person",
                patientPhotoUrl = prefs.getString("patient_photo_url", null)
            )
        } else {
            showPairing()
        }
    }

    override fun onResume() {
        super.onResume()
        pairedDeviceId?.let { startStatusPoll(it) }
    }

    override fun onPause() {
        super.onPause()
        statusPollJob?.cancel()
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }

    // ── Permissions ───────────────────────────────────────────────────────────

    private fun requestPermissionsIfNeeded() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            needed.add(Manifest.permission.CAMERA)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            needed.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
            needed.add(Manifest.permission.BLUETOOTH_CONNECT)
        if (needed.isNotEmpty()) permLauncher.launch(needed.toTypedArray())
    }

    private fun checkFullScreenIntentPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val nm = getSystemService(NotificationManager::class.java)
            if (!nm.canUseFullScreenIntent()) {
                AlertDialog.Builder(this)
                    .setTitle("Allow full-screen calls")
                    .setMessage("To show incoming calls over the lock screen, grant \"Display over other apps\" in settings.")
                    .setPositiveButton("Open Settings") { _, _ ->
                        startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
                    }
                    .setNegativeButton("Later", null).show()
            }
        }
    }

    private fun checkInstallPackagesPermission() {
        if (!packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(this)
                .setTitle("Allow app updates")
                .setMessage("To receive automatic updates, allow this app to install packages in settings.")
                .setPositiveButton("Open Settings") { _, _ ->
                    startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                }
                .setNegativeButton("Later", null).show()
        }
    }

    // ── Paired screen ─────────────────────────────────────────────────────────

    private fun showPairedScreen(deviceId: String, patientName: String, patientPhotoUrl: String?) {
        pairedDeviceId = deviceId
        currentPatientPhotoUrl = patientPhotoUrl
        val dp = resources.displayMetrics.density

        // Root: black full-screen frame
        val rootFrame = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
        }

        // Scrollable column
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity     = Gravity.CENTER_HORIZONTAL
        }
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(col, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
        rootFrame.addView(scroll, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        // ── Header: "FAMILY KIOSK" label + gear ──────────────────────────────
        val header = FrameLayout(this).apply {
            setPadding((20 * dp).toInt(), (48 * dp).toInt(), (20 * dp).toInt(), (8 * dp).toInt())
        }
        val headerLabel = TextView(this).apply {
            text      = "FAMILY KIOSK"
            textSize  = 11f
            setTextColor(Color.parseColor("#4D4D4D"))
            letterSpacing = 0.15f
        }
        val gearBtn = TextView(this).apply {
            text      = "⚙"
            textSize  = 20f
            setTextColor(Color.parseColor("#4D4D4D"))
            gravity   = Gravity.CENTER
            val size  = (36 * dp).toInt()
            background = ovalDrawable(Color.parseColor("#141414"))
            isClickable = true
            isFocusable = true
            setOnClickListener { showSettingsSheet(deviceId) }
        }
        header.addView(headerLabel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
        })
        header.addView(gearBtn, FrameLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt()).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
        })
        col.addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        // ── Pull-to-refresh spinner (hidden by default) ───────────────────────
        val spinner = progressSpinner(dp)
        spinner.visibility = View.INVISIBLE
        refreshSpinner = spinner
        col.addView(spinner, LinearLayout.LayoutParams((24 * dp).toInt(), (24 * dp).toInt()).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            setMargins(0, (4 * dp).toInt(), 0, 0)
        })

        // ── Avatar with breathing rings ───────────────────────────────────────
        val avatarContainer = FrameLayout(this)
        val ringSize1 = (208 * dp).toInt()
        val ringSize2 = (176 * dp).toInt()
        val ringSize3 = (144 * dp).toInt()
        val avatarSize = (128 * dp).toInt()

        val ring1 = View(this).apply { background = ovalDrawable(Color.parseColor("#0A0A0A")) }
        val ring2 = View(this).apply { background = ovalDrawable(Color.parseColor("#0D0D0D")) }
        val statusRing = View(this).apply { background = ovalDrawable(Color.TRANSPARENT).also {
            (it as GradientDrawable).setStroke((4 * dp).toInt(), Color.parseColor("#1A1A1A"))
        }}
        breathingRing1 = ring1
        breathingRing2 = ring2
        statusRingView = statusRing

        avatarContainer.addView(ring1, FrameLayout.LayoutParams(ringSize1, ringSize1).apply { gravity = Gravity.CENTER })
        avatarContainer.addView(ring2, FrameLayout.LayoutParams(ringSize2, ringSize2).apply { gravity = Gravity.CENTER })
        avatarContainer.addView(statusRing, FrameLayout.LayoutParams(ringSize3, ringSize3).apply { gravity = Gravity.CENTER })

        val avatarLetter = TextView(this).apply {
            text     = patientName.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
            textSize = 48f
            setTextColor(Color.WHITE)
            gravity  = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            background = ovalDrawable(Color.parseColor("#1A1A1A"))
        }
        val avatarImage = ImageView(this).apply {
            scaleType  = ImageView.ScaleType.CENTER_CROP
            visibility = View.GONE
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
            }
            clipToOutline = true
        }
        avatarLetterView = avatarLetter
        avatarImageView  = avatarImage
        avatarContainer.addView(avatarLetter, FrameLayout.LayoutParams(avatarSize, avatarSize).apply { gravity = Gravity.CENTER })
        avatarContainer.addView(avatarImage,  FrameLayout.LayoutParams(avatarSize, avatarSize).apply { gravity = Gravity.CENTER })

        // Online dot
        val onlineDot = View(this).apply {
            background = ovalDrawable(Color.parseColor("#4ADE80")).also {
                (it as GradientDrawable).setStroke((2 * dp).toInt(), Color.BLACK)
            }
            visibility = View.GONE
        }
        onlineDotView = onlineDot
        val dotSize = (16 * dp).toInt()
        val dotOffset = ((avatarSize / 2 + avatarSize / 2 * 0.707) - dotSize / 2 + ringSize1 / 2 - avatarSize / 2).toInt()
        avatarContainer.addView(onlineDot, FrameLayout.LayoutParams(dotSize, dotSize).apply {
            gravity = Gravity.CENTER
            leftMargin  =  dotOffset
            topMargin   =  dotOffset
        })

        col.addView(avatarContainer, LinearLayout.LayoutParams(ringSize1, ringSize1).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            setMargins(0, (24 * dp).toInt(), 0, 0)
        })

        // ── Name + last-seen ──────────────────────────────────────────────────
        val nameTv = TextView(this).apply {
            text     = patientName
            textSize = 24f
            setTextColor(Color.WHITE)
            gravity  = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, (20 * dp).toInt(), 0, 0)
        }
        nameLabel = nameTv
        col.addView(nameTv)

        val lastSeenTv = TextView(this).apply {
            text     = "Waiting for a call"
            textSize = 14f
            setTextColor(Color.parseColor("#666666"))
            gravity  = Gravity.CENTER
            setPadding(0, (4 * dp).toInt(), 0, 0)
        }
        lastSeenLabel = lastSeenTv
        col.addView(lastSeenTv)

        // ── Call button ───────────────────────────────────────────────────────
        val callBtnSize = (72 * dp).toInt()
        val callCircle = TextView(this).apply {
            text       = "📞"
            textSize   = 28f
            gravity    = Gravity.CENTER
            background = ovalGradientDrawable(Color.parseColor("#22C55E"), Color.parseColor("#16A34A"))
            elevation  = (6 * dp)
            isClickable = true
            isFocusable = true
        }
        callCircleView = callCircle

        val callStatus = TextView(this).apply {
            textSize = 13f
            gravity  = Gravity.CENTER
            setTextColor(Color.parseColor("#666666"))
            setPadding(0, (10 * dp).toInt(), 0, 0)
        }
        callStatusView = callStatus

        callCircle.setOnClickListener {
            val joinUrl = currentJoinUrl
            if (joinUrl != null) {
                callStatus.text = "Joining…"
                startActivity(Intent(this, CallWebViewActivity::class.java).apply { putExtra("url", joinUrl) })
            } else {
                callCircle.isClickable = false
                callStatus.text = "Checking…"
                checkThenCall(deviceId, callCircle, callStatus)
            }
        }

        col.addView(callCircle, LinearLayout.LayoutParams(callBtnSize, callBtnSize).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            setMargins(0, (40 * dp).toInt(), 0, 0)
        })
        col.addView(TextView(this).apply {
            text     = "Video Call"
            textSize = 12f
            setTextColor(Color.parseColor("#555555"))
            gravity  = Gravity.CENTER
            setPadding(0, (6 * dp).toInt(), 0, 0)
        })
        col.addView(callStatus)

        // ── Callback button ───────────────────────────────────────────────────
        val px24 = (24 * dp).toInt()
        val callbackBtn = TextView(this).apply {
            text        = "Request a callback"
            textSize    = 15f
            gravity     = Gravity.CENTER
            setTextColor(Color.parseColor("#AAAAAA"))
            setPadding(px24, (14 * dp).toInt(), px24, (14 * dp).toInt())
            isClickable = true
            isFocusable = true
            background  = roundedBorderDrawable(Color.TRANSPARENT, Color.parseColor("#2A2A2A"), (12 * dp).toInt())
        }
        val callbackMsg = TextView(this).apply {
            textSize = 12f
            gravity  = Gravity.CENTER
            setTextColor(Color.parseColor("#555555"))
            setPadding(0, (4 * dp).toInt(), 0, 0)
        }
        callbackBtnView = callbackBtn
        callbackMsgView = callbackMsg

        callbackBtn.setOnClickListener {
            if (pendingCallbackId != null) cancelCallback(deviceId, callbackBtn, callbackMsg)
            else sendCallbackRequest(deviceId, callbackBtn, callbackMsg)
        }

        col.addView(callbackBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            setMargins(px24, (20 * dp).toInt(), px24, 0)
        })
        col.addView(callbackMsg, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            setMargins(px24, 0, px24, 0)
        })

        // ── Recent calls ──────────────────────────────────────────────────────
        val callsHeader = TextView(this).apply {
            text     = "RECENT CALLS"
            textSize = 10f
            setTextColor(Color.parseColor("#4D4D4D"))
            letterSpacing = 0.15f
            setPadding(px24, (28 * dp).toInt(), px24, (10 * dp).toInt())
        }
        val callsCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background  = roundedBorderDrawable(Color.parseColor("#0D0D0D"), Color.parseColor("#1A1A1A"), (16 * dp).toInt())
        }
        callHistoryContainer = callsCard
        val callsSection = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility  = View.GONE
            addView(callsHeader)
            addView(callsCard, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                setMargins(px24, 0, px24, 0)
            })
        }
        callHistorySection = callsSection
        col.addView(callsSection, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        // Bottom padding
        col.addView(View(this), LinearLayout.LayoutParams(1, (48 * dp).toInt()))

        setContentView(rootFrame)

        // Load avatar photo
        if (patientPhotoUrl != null) {
            scope.launch {
                val bmp = loadBitmapFromUrl(patientPhotoUrl)
                if (bmp != null) {
                    avatarImage.setImageBitmap(bmp)
                    avatarImage.visibility = View.VISIBLE
                    avatarLetter.visibility = View.GONE
                }
            }
        }

        // Pull-to-refresh touch handling
        scroll.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN  -> { touchStartY = event.y; false }
                MotionEvent.ACTION_MOVE  -> {
                    val delta = event.y - touchStartY
                    val atTop = !scroll.canScrollVertically(-1)
                    if (atTop && delta > 0) {
                        pullDelta = delta
                        val progress = (delta / (pullThresholdDp * dp)).coerceIn(0f, 1f)
                        spinner.alpha = progress
                        spinner.visibility = if (progress > 0) View.VISIBLE else View.INVISIBLE
                    }
                    false
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (pullDelta >= pullThresholdDp * dp) {
                        spinner.visibility = View.VISIBLE
                        scope.launch {
                            refreshData(deviceId)
                            spinner.visibility = View.INVISIBLE
                        }
                    } else {
                        spinner.visibility = View.INVISIBLE
                    }
                    pullDelta = 0f
                    false
                }
                else -> false
            }
        }

        startStatusPoll(deviceId)
    }

    // ── Settings sheet ────────────────────────────────────────────────────────

    private fun showSettingsSheet(deviceId: String) {
        val dp = resources.displayMetrics.density
        val dialog = android.app.Dialog(this, android.R.style.Theme_Translucent_NoTitleBar)
        dialog.window?.apply {
            setLayout(android.view.WindowManager.LayoutParams.MATCH_PARENT, android.view.WindowManager.LayoutParams.MATCH_PARENT)
            setGravity(Gravity.BOTTOM)
        }

        val overlay = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#CC000000")) }
        overlay.setOnClickListener { dialog.dismiss() }

        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#1C1C1E"))
            background = roundedTopDrawable(Color.parseColor("#1C1C1E"), (24 * dp).toInt())
            setPadding(0, 0, 0, (32 * dp).toInt())
        }

        // Handle bar
        sheet.addView(View(this).apply {
            background = roundedRect(Color.parseColor("#3A3A3C"), (2 * dp).toInt())
        }, LinearLayout.LayoutParams((40 * dp).toInt(), (4 * dp).toInt()).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            setMargins(0, (12 * dp).toInt(), 0, (8 * dp).toInt())
        })

        // Title row
        val titleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding((24 * dp).toInt(), (8 * dp).toInt(), (24 * dp).toInt(), (20 * dp).toInt())
        }
        titleRow.addView(TextView(this).apply {
            text     = "Settings"
            textSize = 20f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        titleRow.addView(TextView(this).apply {
            text       = "Done"
            textSize   = 16f
            setTextColor(Color.parseColor("#3B82F6"))
            isClickable = true
            isFocusable = true
            setOnClickListener { dialog.dismiss() }
        })
        sheet.addView(titleRow)

        // Setting row: Auto-hide controls
        sheet.addView(settingToggleRow(
            label       = "Auto-hide call controls",
            description = "Controls fade after 4 s; tap screen to show",
            value       = controlsAutoHide,
            dp          = dp
        ) { controlsAutoHide = it })

        // Setting row: Camera on by default
        sheet.addView(settingToggleRow(
            label       = "Camera on when answering",
            description = "Start each call with camera enabled",
            value       = cameraOnByDefault,
            dp          = dp
        ) { cameraOnByDefault = it })

        // Accent colour
        val accentSection = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((24 * dp).toInt(), (16 * dp).toInt(), (24 * dp).toInt(), 0)
        }
        accentSection.addView(TextView(this).apply {
            text     = "Accent colour"
            textSize = 14f
            setTextColor(Color.parseColor("#AAAAAA"))
            setPadding(0, 0, 0, (12 * dp).toInt())
        })
        val accentRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity     = Gravity.START
        }
        val accents = listOf(
            "green"  to Color.parseColor("#22C55E"),
            "blue"   to Color.parseColor("#3B82F6"),
            "purple" to Color.parseColor("#A855F7"),
            "orange" to Color.parseColor("#F97316")
        )
        accents.forEach { (key, color) ->
            val dot = FrameLayout(this)
            val circle = View(this).apply { background = ovalDrawable(color) }
            val check = TextView(this).apply {
                text     = "✓"
                textSize = 14f
                setTextColor(Color.WHITE)
                gravity  = Gravity.CENTER
                visibility = if (accentColor == key) View.VISIBLE else View.GONE
            }
            val size = (40 * dp).toInt()
            dot.addView(circle, FrameLayout.LayoutParams(size, size))
            dot.addView(check,  FrameLayout.LayoutParams(size, size))
            dot.isClickable = true
            dot.isFocusable = true
            dot.setOnClickListener {
                accentColor = key
                for (i in 0 until accentRow.childCount) {
                    val f = accentRow.getChildAt(i) as? FrameLayout ?: continue
                    (f.getChildAt(1) as? TextView)?.visibility = View.GONE
                }
                check.visibility = View.VISIBLE
                applyAccentToCallButton()
                dialog.dismiss()
            }
            accentRow.addView(dot, LinearLayout.LayoutParams(size, size).apply {
                setMargins(0, 0, (12 * dp).toInt(), 0)
            })
        }
        accentSection.addView(accentRow)
        sheet.addView(accentSection)

        // Divider
        sheet.addView(View(this).apply { setBackgroundColor(Color.parseColor("#2C2C2E")) },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1).apply {
                setMargins(0, (24 * dp).toInt(), 0, 0)
            })

        // Unpair button
        sheet.addView(TextView(this).apply {
            text        = "Unpair device"
            textSize    = 16f
            gravity     = Gravity.CENTER
            setTextColor(Color.parseColor("#EF4444"))
            setPadding(0, (20 * dp).toInt(), 0, 0)
            isClickable = true
            isFocusable = true
            setOnClickListener {
                dialog.dismiss()
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Unpair device?")
                    .setMessage("You'll need to scan a pairing code to reconnect.")
                    .setPositiveButton("Unpair") { _, _ ->
                        statusPollJob?.cancel()
                        SecurityUtils.getSecurePrefs(this@MainActivity).edit().clear().apply()
                        recreate()
                    }
                    .setNegativeButton("Cancel", null).show()
            }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            setMargins((24 * dp).toInt(), 0, (24 * dp).toInt(), 0)
        })

        overlay.addView(sheet, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.BOTTOM
        })
        dialog.setContentView(overlay)
        dialog.show()
    }

    private fun settingToggleRow(label: String, description: String, value: Boolean, dp: Float, onChange: (Boolean) -> Unit): View {
        var current = value
        val row = FrameLayout(this).apply {
            setPadding((24 * dp).toInt(), (14 * dp).toInt(), (24 * dp).toInt(), (14 * dp).toInt())
        }
        val textCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        textCol.addView(TextView(this).apply {
            text     = label
            textSize = 16f
            setTextColor(Color.WHITE)
        })
        textCol.addView(TextView(this).apply {
            text     = description
            textSize = 12f
            setTextColor(Color.parseColor("#666666"))
            setPadding(0, (2 * dp).toInt(), 0, 0)
        })

        val trackColor   = if (current) Color.parseColor("#22C55E") else Color.parseColor("#3A3A3C")
        val track = View(this).apply {
            background = roundedRect(trackColor, (14 * dp).toInt())
        }
        val thumb = View(this).apply {
            background = ovalDrawable(Color.WHITE)
            elevation  = (2 * dp)
        }
        val toggleFrame = FrameLayout(this).apply {
            val w = (48 * dp).toInt(); val h = (28 * dp).toInt()
            addView(track, FrameLayout.LayoutParams(w, h))
            val thumbSize = (20 * dp).toInt()
            val thumbMargin = (4 * dp).toInt()
            addView(thumb, FrameLayout.LayoutParams(thumbSize, thumbSize).apply {
                gravity    = Gravity.CENTER_VERTICAL
                leftMargin = if (current) (w - thumbSize - thumbMargin) else thumbMargin
            })
            isClickable = true
            isFocusable = true
            setOnClickListener {
                current = !current
                onChange(current)
                val thumbParams = thumb.layoutParams as FrameLayout.LayoutParams
                val w2 = (48 * dp).toInt()
                val thumbSize2 = (20 * dp).toInt()
                val thumbMargin2 = (4 * dp).toInt()
                thumbParams.leftMargin = if (current) (w2 - thumbSize2 - thumbMargin2) else thumbMargin2
                thumb.layoutParams = thumbParams
                track.background = roundedRect(
                    if (current) Color.parseColor("#22C55E") else Color.parseColor("#3A3A3C"),
                    (14 * dp).toInt()
                )
            }
        }

        row.addView(textCol, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            marginEnd = ((48 + 16) * dp).toInt()
        })
        row.addView(toggleFrame, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
        })

        // Bottom border
        val wrapper = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        wrapper.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        wrapper.addView(View(this).apply { setBackgroundColor(Color.parseColor("#2C2C2E")) },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1).apply {
                setMargins((24 * dp).toInt(), 0, 0, 0)
            })
        return wrapper
    }

    // ── Status update from poll ───────────────────────────────────────────────

    private fun updateUI(inCall: Boolean, joinUrl: String?, lastSeenAt: Long?, patientName: String?, patientPhotoUrl: String?) {
        val isOnline = lastSeenAt != null && (System.currentTimeMillis() - lastSeenAt) < 5 * 60_000L
        val dp = resources.displayMetrics.density
        val acc = accent()

        // Call button
        currentJoinUrl = joinUrl
        val circle = callCircleView ?: return
        val status = callStatusView ?: return
        if (!circle.isClickable && status.text.toString() == "Calling…") return

        if (joinUrl != null) {
            circle.isClickable = true; circle.alpha = 1f
            status.setTextColor(acc.text); status.text = "Tap to join call"
        } else if (inCall) {
            circle.isClickable = false; circle.alpha = 0.35f
            status.setTextColor(Color.parseColor("#EF4444")); status.text = "Currently on a call"
        } else {
            circle.isClickable = true; circle.alpha = 1f
            status.setTextColor(Color.parseColor("#555555")); status.text = ""
        }

        // Status ring colour
        val ringColor = when {
            inCall   -> acc.ring
            isOnline -> Color.parseColor("#22C55E")
            else     -> Color.parseColor("#2A2A2A")
        }
        (statusRingView?.background as? GradientDrawable)?.setStroke((4 * dp).toInt(), ringColor)

        // Breathing rings tint when in-call
        if (inCall != lastInCall) {
            val ringTint = if (inCall) Color.argb(10, Color.red(acc.bg), Color.green(acc.bg), Color.blue(acc.bg)) else Color.parseColor("#0A0A0A")
            breathingRing1?.background = ovalDrawable(ringTint)
            breathingRing2?.background = ovalDrawable(ringTint)
            lastInCall = inCall
        }

        // Online dot
        onlineDotView?.visibility = if (isOnline || inCall) View.VISIBLE else View.GONE
        if (inCall) {
            (onlineDotView?.background as? GradientDrawable)?.setColor(acc.bg)
        } else {
            (onlineDotView?.background as? GradientDrawable)?.setColor(Color.parseColor("#4ADE80"))
        }

        // Last-seen label
        if (patientName != null) nameLabel?.text = patientName
        lastSeenLabel?.apply {
            val label = when {
                inCall   -> "In a call"
                isOnline -> "Active now"
                lastSeenAt != null -> {
                    val diff = System.currentTimeMillis() - lastSeenAt
                    when {
                        diff < 60_000L         -> "Active now"
                        diff < 3_600_000L      -> "${diff / 60_000}m ago"
                        diff < 86_400_000L     -> "${diff / 3_600_000}h ago"
                        else                   -> "${diff / 86_400_000}d ago"
                    }
                }
                else -> "Waiting for a call"
            }
            text = label
            setTextColor(when {
                inCall   -> acc.text
                isOnline -> Color.parseColor("#4ADE80")
                else     -> Color.parseColor("#555555")
            })
        }

        // Update photo if changed
        if (patientPhotoUrl != null && patientPhotoUrl != currentPatientPhotoUrl) {
            currentPatientPhotoUrl = patientPhotoUrl
            SecurityUtils.getSecurePrefs(this).edit().putString("patient_photo_url", patientPhotoUrl).apply()
            scope.launch {
                val bmp = loadBitmapFromUrl(patientPhotoUrl)
                if (bmp != null) {
                    avatarImageView?.setImageBitmap(bmp)
                    avatarImageView?.visibility = View.VISIBLE
                    avatarLetterView?.visibility = View.GONE
                }
            }
        }
    }

    private fun updateCallHistory(calls: List<CallRecord>) {
        val dp = resources.displayMetrics.density
        val recent = calls.take(3)
        if (recent.isEmpty()) { callHistorySection?.visibility = View.GONE; return }
        callHistorySection?.visibility = View.VISIBLE
        val container = callHistoryContainer ?: return
        container.removeAllViews()
        recent.forEachIndexed { index, call ->
            val answered = call.answered == 1
            val declined = call.declined == 1
            val row = FrameLayout(this).apply {
                setPadding((16 * dp).toInt(), (12 * dp).toInt(), (16 * dp).toInt(), (12 * dp).toInt())
            }
            // Icon
            val iconBg = View(this).apply {
                background = ovalDrawable(
                    if (answered) Color.parseColor("#1A3D2B") else Color.parseColor("#3D1A1A")
                )
            }
            val iconTv = TextView(this).apply {
                text     = if (answered) "📞" else "📵"
                textSize = 14f
                gravity  = Gravity.CENTER
            }
            val iconSize = (32 * dp).toInt()
            val iconFrame = FrameLayout(this).apply {
                addView(iconBg, FrameLayout.LayoutParams(iconSize, iconSize))
                addView(iconTv, FrameLayout.LayoutParams(iconSize, iconSize))
            }

            // Text
            val textCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding((12 * dp).toInt(), 0, 0, 0)
            }
            textCol.addView(TextView(this).apply {
                text     = call.contactName
                textSize = 14f
                setTextColor(Color.parseColor("#CCCCCC"))
                setTypeface(typeface, Typeface.BOLD)
            })
            textCol.addView(TextView(this).apply {
                text     = formatCallTime(call.startedAt)
                textSize = 12f
                setTextColor(Color.parseColor("#555555"))
            })

            // Status label
            val statusTv = TextView(this).apply {
                text     = if (answered) "Answered" else if (declined) "Declined" else "Missed"
                textSize = 12f
                setTextColor(
                    if (answered) Color.parseColor("#4ADE80")
                    else Color.parseColor("#EF4444")
                )
            }

            row.addView(iconFrame, FrameLayout.LayoutParams(iconSize, iconSize).apply { gravity = Gravity.START or Gravity.CENTER_VERTICAL })
            row.addView(textCol, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
                gravity    = Gravity.START or Gravity.CENTER_VERTICAL
                leftMargin = iconSize + (12 * dp).toInt()
            })
            row.addView(statusTv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
            })
            container.addView(row)

            // Divider between rows
            if (index < recent.size - 1) {
                container.addView(View(this).apply { setBackgroundColor(Color.parseColor("#1A1A1A")) },
                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1).apply {
                        setMargins((16 * dp).toInt(), 0, 0, 0)
                    })
            }
        }
    }

    private fun applyAccentToCallButton() {
        val acc = accent()
        (callCircleView?.background as? GradientDrawable)?.colors = intArrayOf(acc.bg, acc.dark)
    }

    // ── Polling ───────────────────────────────────────────────────────────────

    private fun startStatusPoll(deviceId: String) {
        statusPollJob?.cancel()
        statusPollJob = scope.launch {
            while (true) {
                refreshData(deviceId)
                delay(30_000)
            }
        }
    }

    private suspend fun refreshData(deviceId: String) {
        val deviceToken = SecurityUtils.getSecurePrefs(this).getString("device_token", "") ?: ""
        val statusResult  = runCatching { api.getPatientStatus(deviceId, deviceToken) }.getOrNull()
        val historyResult = runCatching { api.getCallHistory(deviceId, deviceToken) }.getOrNull()

        if (statusResult?.isSuccessful == true) {
            val body = statusResult.body()!!
            updateUI(body.inCall, body.joinUrl, body.lastSeenAt, body.patientName, body.patientPhotoUrl)
        }
        if (historyResult?.isSuccessful == true) {
            updateCallHistory(historyResult.body()?.calls ?: emptyList())
        }
    }

    // ── Call initiation ───────────────────────────────────────────────────────

    private fun checkThenCall(deviceId: String, callView: View, statusText: TextView) {
        scope.launch {
            val deviceToken = SecurityUtils.getSecurePrefs(this@MainActivity).getString("device_token", "") ?: ""
            val response    = runCatching { api.getPatientStatus(deviceId, deviceToken) }.getOrNull()
            val body        = response?.body()
            when {
                body?.joinUrl != null -> {
                    updateUI(body.inCall, body.joinUrl, body.lastSeenAt, body.patientName, body.patientPhotoUrl)
                    callView.isClickable = true; statusText.text = ""
                }
                body?.inCall == true -> {
                    callView.isClickable = true; statusText.text = ""
                    showAlreadyInCallDialog(deviceId)
                }
                else -> initiateCall(deviceId, callView, statusText)
            }
        }
    }

    private fun initiateCall(deviceId: String, callView: View, statusText: TextView) {
        scope.launch {
            val deviceToken = SecurityUtils.getSecurePrefs(this@MainActivity).getString("device_token", "") ?: ""
            val response    = runCatching { api.initiateCall(deviceId, deviceToken) }.getOrNull()
            when {
                response?.code() == 409 -> {
                    callView.isClickable = true; statusText.text = ""
                    showAlreadyInCallDialog(deviceId)
                }
                response?.isSuccessful == true -> {
                    val joinUrl = response.body()?.joinUrl
                    statusText.text = ""
                    startActivity(Intent(this@MainActivity, CallWebViewActivity::class.java).apply { putExtra("url", joinUrl) })
                    callView.isClickable = true
                }
                else -> {
                    statusText.setTextColor(Color.parseColor("#EF4444"))
                    statusText.text = "Call failed. Check your connection."
                    callView.isClickable = true
                }
            }
        }
    }

    private fun showAlreadyInCallDialog(deviceId: String) {
        AlertDialog.Builder(this)
            .setTitle("Currently on a call")
            .setMessage("They're already in a call. Send a callback request instead?")
            .setPositiveButton("Request callback") { _, _ ->
                callbackBtnView?.let { btn -> callbackMsgView?.let { msg -> sendCallbackRequest(deviceId, btn, msg) } }
            }
            .setNegativeButton("Cancel", null).show()
    }

    // ── Callback ──────────────────────────────────────────────────────────────

    private fun sendCallbackRequest(deviceId: String, btn: TextView, msg: TextView) {
        btn.isClickable = false
        msg.setTextColor(Color.parseColor("#555555")); msg.text = "Sending…"
        scope.launch {
            val deviceToken = SecurityUtils.getSecurePrefs(this@MainActivity).getString("device_token", "") ?: ""
            val response    = runCatching { api.requestCallback(deviceId, deviceToken) }.getOrNull()
            if (response?.isSuccessful == true) {
                pendingCallbackId = response.body()?.requestId
                btn.text = "Callback requested — tap to cancel"
                btn.setTextColor(Color.parseColor("#F59E0B"))
                msg.setTextColor(Color.parseColor("#4ADE80")); msg.text = "They'll be notified"
            } else {
                msg.setTextColor(Color.parseColor("#EF4444")); msg.text = "Couldn't send. Try again."
            }
            btn.isClickable = true
        }
    }

    private fun cancelCallback(deviceId: String, btn: TextView, msg: TextView) {
        val requestId = pendingCallbackId ?: return
        btn.isClickable = false; msg.text = "Cancelling…"
        scope.launch {
            val deviceToken = SecurityUtils.getSecurePrefs(this@MainActivity).getString("device_token", "") ?: ""
            runCatching { api.cancelCallback(deviceId, requestId, deviceToken) }
            pendingCallbackId = null
            btn.text = "Request a callback"
            btn.setTextColor(Color.parseColor("#AAAAAA"))
            msg.setTextColor(Color.parseColor("#555555")); msg.text = ""
            btn.isClickable = true
        }
    }

    // ── Pairing screen ────────────────────────────────────────────────────────

    private fun showPairing(prefillToken: String? = null) {
        val dp   = resources.displayMetrics.density
        val px24 = (24 * dp).toInt()

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val col  = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity     = Gravity.CENTER_HORIZONTAL
            setPadding(px24, (64 * dp).toInt(), px24, px24)
        }
        root.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        col.addView(TextView(this).apply {
            text     = "Family Kiosk"
            textSize = 32f
            setTextColor(Color.WHITE)
            gravity  = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
        })
        col.addView(TextView(this).apply {
            text     = "Enter the pairing code shown in the admin panel to link this phone."
            textSize = 15f
            setTextColor(Color.parseColor("#666666"))
            gravity  = Gravity.CENTER
            setPadding(0, (12 * dp).toInt(), 0, 0)
        })

        val codeField = EditText(this).apply {
            hint      = "Pairing code"
            textSize  = 18f
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#444444"))
            gravity   = Gravity.CENTER
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            imeOptions = EditorInfo.IME_ACTION_DONE
            setBackgroundColor(Color.parseColor("#1A1A1A"))
            setPadding(px24, (14 * dp).toInt(), px24, (14 * dp).toInt())
            if (prefillToken != null) setText(prefillToken)
        }
        col.addView(codeField, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            setMargins(0, (24 * dp).toInt(), 0, 0)
        })

        val statusTv = TextView(this).apply {
            textSize = 14f; gravity = Gravity.CENTER
            setPadding(0, (8 * dp).toInt(), 0, 0)
        }
        col.addView(statusTv)

        val pairBtn = Button(this).apply {
            text = "Pair device"; textSize = 16f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#22C55E"))
        }
        pairBtn.setOnClickListener {
            val token = codeField.text.toString().trim()
            if (token.isEmpty()) { statusTv.text = "Enter a pairing code"; return@setOnClickListener }
            pairDevice(token, statusTv, pairBtn)
        }
        col.addView(pairBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            setMargins(0, (16 * dp).toInt(), 0, 0)
        })

        val scanBtn = Button(this).apply {
            text = "📷  Scan QR Code"; textSize = 15f
            setTextColor(Color.parseColor("#22C55E"))
            setBackgroundColor(Color.TRANSPARENT)
        }
        scanBtn.setOnClickListener {
            pendingPairCallback = { token ->
                codeField.setText(token)
                pairDevice(token, statusTv, pairBtn)
            }
            qrLauncher.launch(ScanOptions().setPrompt("Scan the pairing QR code").setBeepEnabled(true).setOrientationLocked(false))
        }
        col.addView(scanBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            setMargins(0, (4 * dp).toInt(), 0, 0)
        })

        if (prefillToken != null) pairDevice(prefillToken, statusTv, pairBtn)
        setContentView(root)
    }

    private fun pairDevice(token: String, statusText: TextView, pairBtn: Button) {
        pairBtn.isEnabled = false
        statusText.setTextColor(Color.parseColor("#666666")); statusText.text = "Pairing…"
        FirebaseMessaging.getInstance().token.addOnSuccessListener { fcmToken ->
            scope.launch {
                val deviceId = UUID.randomUUID().toString()
                val response = runCatching { api.pairDevice(PairRequest(token, fcmToken, deviceId)) }.getOrNull()
                if (response?.isSuccessful == true) {
                    val result = response.body()!!
                    SecurityUtils.getSecurePrefs(this@MainActivity).edit()
                        .putString("device_id",         deviceId)
                        .putString("fcm_token",          fcmToken)
                        .putString("patient_name",       result.patientName)
                        .putString("device_token",       result.deviceToken)
                        .putString("patient_photo_url",  result.patientPhotoUrl ?: "")
                        .apply()
                    statusText.setTextColor(Color.parseColor("#22C55E")); statusText.text = "Paired!"
                    delay(1200)
                    showPairedScreen(deviceId, result.patientName, result.patientPhotoUrl)
                } else {
                    statusText.setTextColor(Color.parseColor("#EF4444")); statusText.text = "Invalid or expired code. Try again."
                    pairBtn.isEnabled = true
                }
            }
        }.addOnFailureListener {
            statusText.setTextColor(Color.parseColor("#EF4444")); statusText.text = "Couldn't get device token. Check your connection."
            pairBtn.isEnabled = true
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    private suspend fun loadBitmapFromUrl(url: String): android.graphics.Bitmap? = withContext(Dispatchers.IO) {
        var conn: java.net.HttpURLConnection? = null
        runCatching {
            conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            conn?.apply { connectTimeout = 8000; readTimeout = 8000; doInput = true; instanceFollowRedirects = false }
            conn?.inputStream?.use { android.graphics.BitmapFactory.decodeStream(it) }
        }.also { conn?.disconnect() }.getOrNull()
    }

    private fun formatCallTime(ts: Long): String {
        val d   = Date(ts)
        val now = Date()
        val fmt = SimpleDateFormat("h:mm a", Locale.getDefault())
        val daySdf = SimpleDateFormat("yyyyMMdd", Locale.getDefault())
        return when (daySdf.format(d)) {
            daySdf.format(now) -> "Today ${fmt.format(d)}"
            daySdf.format(Date(now.time - 86_400_000)) -> "Yesterday ${fmt.format(d)}"
            else -> SimpleDateFormat("MMM d", Locale.getDefault()).format(d) + " ${fmt.format(d)}"
        }
    }

    private fun ovalDrawable(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL; setColor(color)
    }

    private fun ovalGradientDrawable(top: Int, bottom: Int) = GradientDrawable(
        GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(top, bottom)
    ).apply { shape = GradientDrawable.OVAL }

    private fun roundedBorderDrawable(fill: Int, stroke: Int, radius: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE; cornerRadius = radius.toFloat()
        setColor(fill); setStroke(2, stroke)
    }

    private fun roundedRect(color: Int, radius: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE; cornerRadius = radius.toFloat(); setColor(color)
    }

    private fun roundedTopDrawable(color: Int, radius: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadii = floatArrayOf(radius.toFloat(), radius.toFloat(), radius.toFloat(), radius.toFloat(), 0f, 0f, 0f, 0f)
        setColor(color)
    }

    private fun progressSpinner(dp: Float): View {
        // Simple indeterminate ring drawn as a View with rotation animator
        val ring = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.TRANSPARENT)
                setStroke((2 * dp).toInt(), Color.parseColor("#555555"))
            }
        }
        val animator = ValueAnimator.ofFloat(0f, 360f).apply {
            duration = 800; repeatCount = ValueAnimator.INFINITE
            interpolator = DecelerateInterpolator()
            addUpdateListener { ring.rotation = it.animatedValue as Float }
        }
        ring.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { animator.start() }
            override fun onViewDetachedFromWindow(v: View) { animator.cancel() }
        })
        return ring
    }

    private fun schedulePeriodicUpdateCheck() {
        scope.launch {
            while (true) {
                delay(6 * 60 * 60 * 1000L)
                UpdateManager(this@MainActivity).checkAndUpdate()
            }
        }
    }
}
