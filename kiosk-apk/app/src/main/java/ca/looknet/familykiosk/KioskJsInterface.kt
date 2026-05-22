package ca.looknet.familykiosk

import android.app.admin.DevicePolicyManager
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Looper
import android.net.ConnectivityManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToInt

class KioskJsInterface(private val activity: MainActivity) {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var prefetchJob: Job? = null
    private var currentRingtone: Ringtone? = null
    private var cachedRingtones: JSONArray? = null

    // Ringback tone — played while kiosk is waiting for family to answer
    private var ringbackTone: ToneGenerator? = null
    private val ringbackHandler = android.os.Handler(Looper.getMainLooper())
    private var isRinging = false
    private val ringbackRunnable = object : Runnable {
        override fun run() {
            if (!isRinging) return
            try {
                if (ringbackTone == null) ringbackTone = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 100)
                ringbackTone?.stopTone()
                ringbackTone?.startTone(ToneGenerator.TONE_SUP_RINGTONE, 2000)
            } catch (e: Exception) {
                Log.e("KioskRingback", "ToneGenerator failed", e)
            }
            ringbackHandler.postDelayed(this, 4000)
        }
    }

    // ── Native call service context ───────────────────────────────

    @JavascriptInterface
    fun setDeviceContext(deviceId: String, patientId: String, apiKey: String) {
        activity.getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE).edit()
            .putString("device_id_native", deviceId)
            .putString("patient_id", patientId)
            .putString("api_key", apiKey)
            .apply()
    }

    // ── System UI ──────────────────────────────────────────────────

    @JavascriptInterface
    fun returnToKiosk() {
        activity.runOnUiThread { activity.hideSystemUI() }
    }

    // ── Remote config (settings pushed from backend on every sync) ─

    @JavascriptInterface
    fun updateConfig(json: String) {
        val config = runCatching { JSONObject(json) }.getOrNull() ?: return
        val prefs  = activity.getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)
        val admin  = ComponentName(activity, DeviceAdminReceiver::class.java)
        val dpm    = activity.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val am     = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

        // PIN
        config.optString("unlockPin").takeIf { it.isNotEmpty() }?.let {
            prefs.edit().putString("unlock_pin", it).apply()
        }

        // Daily restart schedule
        val restartHour = config.optInt("restartHour", Int.MIN_VALUE)
        if (restartHour != Int.MIN_VALUE) {
            try {
                if (restartHour in 0..23) activity.scheduleRestart(restartHour)
                else activity.cancelRestartAlarm()
            } catch (_: SecurityException) {}
        }

        // Ring / call / media volume (0–100 %)
        val ringVolume = config.optInt("ringVolume", -1)
        if (ringVolume in 0..100) {
            prefs.edit().putInt("ring_volume", ringVolume).apply()
            for (stream in listOf(AudioManager.STREAM_RING, AudioManager.STREAM_VOICE_CALL, AudioManager.STREAM_MUSIC)) {
                val max = am.getStreamMaxVolume(stream)
                am.setStreamVolume(stream, (max * ringVolume / 100.0).roundToInt(), 0)
            }
        }

        // Screen timeout — Device Owner: setMaximumTimeToLock (0 = never)
        val screenTimeoutMs = config.optLong("screenTimeoutMs", -1L)
        if (screenTimeoutMs >= 0) {
            runCatching { dpm.setMaximumTimeToLock(admin, screenTimeoutMs) }
                .onFailure { Log.e("KioskConfig", "setMaximumTimeToLock failed", it) }
        }

        // Timezone — Device Owner
        config.optString("timezone").takeIf { it.isNotEmpty() }?.let { tz ->
            runCatching {
                dpm.setGlobalSetting(admin, android.provider.Settings.Global.AUTO_TIME_ZONE, "0")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    dpm.setTimeZone(admin, tz)
                } else {
                    val am = activity.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
                    am.setTimeZone(tz)
                }
            }.onFailure { Log.e("KioskConfig", "setTimezone failed", it) }
        }

        // Font scale — persisted in prefs, applied as WebView textZoom
        val fontScale = config.optDouble("fontScale", -1.0).toFloat()
        if (fontScale > 0f) {
            prefs.edit().putFloat("font_scale", fontScale).apply()
            activity.runOnUiThread { activity.applyFontScale(fontScale) }
        }

        // Screen orientation
        config.optString("orientation").takeIf { it.isNotEmpty() }?.let { mode ->
            prefs.edit().putString("orientation", mode).apply()
            activity.runOnUiThread { activity.applyOrientation(mode) }
        }

        // Preferred Bluetooth headset address (empty string = disabled)
        val btAddr = config.optString("btDeviceAddress")
        prefs.edit().putString("bt_device_address", btAddr).apply()
        // Re-configure audio routing immediately when BT pref changes
        activity.runOnUiThread { activity.configureAudio() }

        // One-shot commands (type field)
        when (config.optString("type")) {
            "restart" -> activity.runOnUiThread { activity.performRestart() }
            "set-brightness" -> {
                val level = config.optDouble("level", -1.0).toFloat()
                if (level in 0f..1f) activity.runOnUiThread {
                    val lp = activity.window.attributes
                    lp.screenBrightness = level
                    activity.window.attributes = lp
                }
            }
            "clear-cache" -> scope.launch {
                File(activity.filesDir, "photo_cache").listFiles()?.forEach { it.delete() }
            }
            "factory-reset" -> activity.runOnUiThread {
                dpm.wipeData(0)
            }
        }
    }

    // ── Ringtones ─────────────────────────────────────────────────

    @JavascriptInterface
    fun getRingtones(): String = buildRingtonesArray().toString()

    @JavascriptInterface
    fun playRingtone(uri: String) {
        activity.runOnUiThread {
            try {
                currentRingtone?.stop()
                currentRingtone = RingtoneManager.getRingtone(activity, Uri.parse(uri))
                currentRingtone?.play()
            } catch (e: Exception) {
                Log.e("KioskRing", "playRingtone error: ${e.message}")
            }
        }
    }

    @JavascriptInterface
    fun stopRingtone() {
        activity.runOnUiThread {
            try { currentRingtone?.stop(); currentRingtone = null } catch (e: Exception) {
                Log.e("KioskRing", "stopRingtone error", e)
            }
        }
    }

    @JavascriptInterface
    fun startRingback() {
        activity.runOnUiThread {
            isRinging = true
            ringbackHandler.post(ringbackRunnable)
        }
    }

    @JavascriptInterface
    fun stopRingback() {
        activity.runOnUiThread {
            isRinging = false
            ringbackHandler.removeCallbacks(ringbackRunnable)
            try { ringbackTone?.stopTone(); ringbackTone?.release(); ringbackTone = null } catch (_: Exception) {}
        }
    }

    private fun buildRingtonesArray(): JSONArray {
        cachedRingtones?.let { return it }
        val result = JSONArray()
        try {
            val rm = RingtoneManager(activity)
            rm.setType(RingtoneManager.TYPE_RINGTONE)
            val cursor = rm.cursor
            try {
                while (cursor.moveToNext()) {
                    result.put(JSONObject().apply {
                        put("name", cursor.getString(RingtoneManager.TITLE_COLUMN_INDEX))
                        put("uri",  rm.getRingtoneUri(cursor.position).toString())
                    })
                }
            } finally {
                cursor.close()
            }
        } catch (e: Exception) {
            Log.e("KioskRing", "buildRingtonesArray error", e)
        }
        cachedRingtones = result
        return result
    }

    // ── Bluetooth ─────────────────────────────────────────────────

    @JavascriptInterface
    fun getBluetoothDevices(): String = buildBluetoothArray().toString()

    private fun buildBluetoothArray(): JSONArray {
        val result = JSONArray()
        try {
            val bm      = activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
            val adapter = bm.adapter ?: return result
            if (!adapter.isEnabled) return result
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                activity.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) return result

            val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val connectedAddresses: Set<String> =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                        .filter { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                                  it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
                        .map { it.address }
                        .toSet()
                } else emptySet()

            adapter.bondedDevices?.sortedBy { it.name }?.forEach { device ->
                result.put(JSONObject().apply {
                    put("name",      device.name ?: "Unknown")
                    put("address",   device.address)
                    put("connected", connectedAddresses.contains(device.address))
                })
            }
        } catch (e: Exception) {
            Log.e("KioskBT", "getBluetoothDevices error", e)
        }
        return result
    }

    // ── Photo caching ──────────────────────────────────────────────

    @JavascriptInterface
    fun prefetchPhotos(urlsJson: String) {
        val urls = runCatching { JSONArray(urlsJson) }.getOrNull() ?: return
        val cacheDir = File(activity.filesDir, "photo_cache").also { it.mkdirs() }

        prefetchJob?.cancel()
        prefetchJob = scope.launch {
            Log.d("KioskCache", "prefetch: ${urls.length()} URLs queued")
            for (i in 0 until urls.length()) {
                ensureActive()
                val rawUrl = urls.optString(i).takeIf { it.isNotEmpty() } ?: continue
                val uri = android.net.Uri.parse(rawUrl)
                val filename = uri.path?.replace("/", "_")?.trim('_')
                    ?.takeIf { it.isNotEmpty() && it.contains(".") } ?: continue
                val dest = File(cacheDir, filename)

                if (dest.exists() && dest.length() > 0) {
                dest.setLastModified(System.currentTimeMillis())
                Log.d("KioskCache", "CACHED  $filename (${dest.length()}B)")
                continue
                }

                val tmp = File(cacheDir, "$filename.tmp")
                runCatching {
                    val conn = URL(rawUrl).openConnection() as HttpURLConnection
                    conn.connectTimeout = 15_000
                    conn.readTimeout    = 30_000
                    if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                        throw Exception("HTTP ${conn.responseCode}")
                    }
                    conn.inputStream.use { input ->
                        tmp.outputStream().use { output ->
                            val buffer = ByteArray(8192)
                            var bytesRead: Int
                            while (input.read(buffer).also { bytesRead = it } >= 0) {
                                ensureActive()
                                output.write(buffer, 0, bytesRead)
                            }
                        }
                    }
                    if (tmp.length() > 0) {
                        tmp.renameTo(dest)
                        Log.d("KioskCache", "FETCHED $filename (${dest.length()}B)")
                    } else {
                        Log.w("KioskCache", "EMPTY   $filename — download produced 0 bytes")
                        tmp.delete()
                        KioskCallService.scheduleUrgentFlush()
                    }
                }.onFailure {
                    tmp.delete()
                    if (it is CancellationException) throw it
                    Log.e("KioskCache", "FAILED  $filename: ${it.message}")
                    KioskCallService.scheduleUrgentFlush()
                }
            }
            Log.d("KioskCache", "prefetch done")
            evictCacheIfNeeded(cacheDir)
        }
    }

    private fun evictCacheIfNeeded(cacheDir: File, maxBytes: Long = 50L * 1024 * 1024 * 1024L) {
        val files = cacheDir.listFiles()?.filter { it.isFile } ?: return
        val total = files.sumOf { it.length() }
        if (total <= maxBytes) return
        var freed = 0L
        val needed = total - maxBytes
        // thenBy name breaks ties when filesystem timestamp resolution causes equal lastModified(),
        // which otherwise violates TimSort's transitivity contract and throws IllegalArgumentException.
        files.map { it to it.lastModified() }
            .sortedWith(compareBy({ it.second }, { it.first.name }))
            .forEach { (f, _) ->
            if (freed >= needed) return
            freed += f.length()
            f.delete()
            Log.d("KioskCache", "EVICT ${f.name} (freed ${freed}B / ${needed}B needed)")
        }
    }

    @JavascriptInterface
    fun getCachedPhotos(): String {
        val cacheDir = File(activity.filesDir, "photo_cache")
        val files = cacheDir.listFiles()?.filter { it.isFile && it.length() > 0 }?.map { it.name } ?: emptyList()
        return JSONArray(files).toString()
    }

    // ── Device health report ───────────────────────────────────────

    @JavascriptInterface
    fun getStorageInfo(): String {
        val prefs    = activity.getSharedPreferences("kiosk_prefs", Context.MODE_PRIVATE)
        val cacheDir = File(activity.filesDir, "photo_cache")
        val cacheBytes  = cacheDir.listFiles()?.sumOf { it.length() } ?: 0L
        val photoCount  = cacheDir.listFiles()?.size ?: 0
        val freeBytes   = activity.filesDir.freeSpace
        val totalBytes  = activity.filesDir.totalSpace

        // Battery
        val bm = activity.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val batteryLevel    = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val batteryCharging = bm.isCharging

        // Lock task
        val actMgr = activity.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val locked  = actMgr.lockTaskModeState != android.app.ActivityManager.LOCK_TASK_MODE_NONE

        // Uptime
        val uptimeMs = SystemClock.elapsedRealtime()

        // WiFi — connected
        val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION") val wifiInfo = wm.connectionInfo
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wifiConnected = cm.activeNetworkInfo?.type == ConnectivityManager.TYPE_WIFI
        @Suppress("DEPRECATION") val ssid = wifiInfo.ssid?.removePrefix("\"")?.removeSuffix("\"") ?: ""
        @Suppress("DEPRECATION") val signalLevel = WifiManager.calculateSignalLevel(wifiInfo.rssi, 5)

        // WiFi — scan results
        val available = JSONArray()
        try {
            @Suppress("DEPRECATION")
            wm.scanResults.orEmpty()
                .filter { it.SSID.isNotBlank() && it.SSID != "<unknown ssid>" }
                .groupBy { it.SSID }
                .mapValues { (_, aps) -> aps.maxByOrNull { it.level }!! }
                .values.sortedByDescending { it.level }.take(15)
                .forEach { ap ->
                    available.put(JSONObject().apply {
                        put("ssid",     ap.SSID)
                        put("signal",   WifiManager.calculateSignalLevel(ap.level, 5))
                        put("security", if (ap.capabilities.contains("WPA")) "WPA" else "OPEN")
                    })
                }
        } catch (_: Exception) {}

        // WiFi — app-provisioned networks
        val known = JSONArray()
        try {
            val seen = mutableSetOf<String>()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                wm.networkSuggestions.forEach { s ->
                    val sugSsid = s.ssid ?: return@forEach
                    if (sugSsid.isNotBlank() && seen.add(sugSsid))
                        known.put(JSONObject().apply { put("ssid", sugSsid) })
                }
            } else {
                @Suppress("DEPRECATION")
                wm.configuredNetworks?.forEach { cfg ->
                    val cfgSsid = cfg.SSID?.removePrefix("\"")?.removeSuffix("\"") ?: ""
                    if (cfgSsid.isNotBlank() && seen.add(cfgSsid))
                        known.put(JSONObject().apply { put("ssid", cfgSsid) })
                }
            }
        } catch (_: Exception) {}

        // RAM — Java heap + native heap via ActivityManager.MemoryInfo
        val memInfo = android.app.ActivityManager.MemoryInfo()
        actMgr.getMemoryInfo(memInfo)
        val ramTotalBytes = memInfo.totalMem
        val ramFreeBytes  = memInfo.availMem
        val ramUsedBytes  = ramTotalBytes - ramFreeBytes
        val ramLowMemory  = memInfo.lowMemory

        // Audio — current ring volume as %
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val ringMax = am.getStreamMaxVolume(AudioManager.STREAM_RING)
        val ringCur = am.getStreamVolume(AudioManager.STREAM_RING)
        val volumeRing = if (ringMax > 0) (ringCur * 100 / ringMax) else 0

        // Bluetooth — connected audio device
        var btConnected  = false
        var btDeviceName = ""
        try {
            val btMgr   = activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
            val adapter = btMgr.adapter
            if (adapter != null && adapter.isEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val btOutputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                    .filter { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                              it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
                if (btOutputs.isNotEmpty()) {
                    btConnected = true
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                        activity.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        val addr   = btOutputs.first().address
                        btDeviceName = adapter.bondedDevices?.find { it.address == addr }?.name
                            ?: btOutputs.first().productName.toString()
                    } else {
                        btDeviceName = btOutputs.first().productName.toString()
                    }
                }
            }
        } catch (_: Exception) {}

        return JSONObject().apply {
            // Storage
            put("cacheBytes",        cacheBytes)
            put("freeBytes",         freeBytes)
            put("totalBytes",        totalBytes)
            put("cachedPhotoCount",  photoCount)
            // Battery
            put("batteryLevel",      batteryLevel)
            put("batteryCharging",   batteryCharging)
            // System
            put("lockTaskActive",    locked)
            put("uptimeMs",          uptimeMs)
            // WiFi
            put("wifiSsid",          ssid)
            put("wifiSignal",        signalLevel)
            put("wifiConnected",     wifiConnected)
            put("wifiAvailable",     available)
            put("wifiKnown",         known)
            // Audio
            put("volumeRing",        volumeRing)
            // Bluetooth
            put("btConnected",       btConnected)
            put("btDeviceName",      btDeviceName)
            put("btDevices",         buildBluetoothArray())
            // Ringtones (cached after first call)
            put("ringtones",         buildRingtonesArray())
            // Device identity
            put("deviceManufacturer", Build.MANUFACTURER)
            put("deviceModel",        Build.MODEL)
            put("androidVersion",     Build.VERSION.RELEASE)
            put("androidSdk",         Build.VERSION.SDK_INT)
            // Current applied settings (for drift detection)
            put("timezone",    java.util.TimeZone.getDefault().id)
            put("fontScale",   prefs.getFloat("font_scale",   1.0f))
            put("orientation", prefs.getString("orientation", "landscape") ?: "landscape")
            // RAM
            put("ramTotalBytes", ramTotalBytes)
            put("ramUsedBytes",  ramUsedBytes)
            put("ramFreeBytes",  ramFreeBytes)
            put("ramLowMemory",  ramLowMemory)
            // APK version
            put("apkVersion",  BuildConfig.VERSION_CODE)
        }.toString()
    }

    // ── WiFi management ───────────────────────────────────────────

    @JavascriptInterface
    fun removeWifiNetwork(ssid: String) {
        scope.launch {
            runCatching {
                val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val existing = wm.networkSuggestions.filter { it.ssid == ssid }
                    if (existing.isNotEmpty()) {
                        val status = wm.removeNetworkSuggestions(existing)
                        Log.i("KioskWifi", "removeNetworkSuggestions($ssid) result: $status")
                    }
                } else {
                    @Suppress("DEPRECATION")
                    wm.configuredNetworks?.filter { cfg ->
                        cfg.SSID?.removePrefix("\"")?.removeSuffix("\"") == ssid
                    }?.forEach { cfg ->
                        @Suppress("DEPRECATION")
                        wm.removeNetwork(cfg.networkId)
                    }
                    @Suppress("DEPRECATION")
                    wm.saveConfiguration()
                }
                Unit
            }.onFailure { Log.e("KioskWifi", "removeWifiNetwork error", it) }
        }
    }

    @JavascriptInterface
    fun addWifiNetwork(ssid: String, password: String, security: String) {
        scope.launch {
            runCatching {
                val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val existing = wm.networkSuggestions.filter { it.ssid != null && it.ssid == ssid }
                    if (existing.isNotEmpty()) wm.removeNetworkSuggestions(existing)
                    val builder = android.net.wifi.WifiNetworkSuggestion.Builder().setSsid(ssid)
                    when (security.uppercase()) {
                        "WPA", "WPA2" -> builder.setWpa2Passphrase(password)
                        else -> { /* No-op for open networks */ }
                    }
                    val status = wm.addNetworkSuggestions(listOf(builder.build()))
                    Log.i("KioskWifi", "addNetworkSuggestions result: $status")
                } else {
                    @Suppress("DEPRECATION")
                    val config = android.net.wifi.WifiConfiguration().apply {
                        SSID = "\"$ssid\""
                        when (security.uppercase()) {
                            "WPA", "WPA2" -> {
                                preSharedKey = "\"$password\""
                                allowedKeyManagement.set(android.net.wifi.WifiConfiguration.KeyMgmt.WPA_PSK)
                            }
                            else -> allowedKeyManagement.set(android.net.wifi.WifiConfiguration.KeyMgmt.NONE)
                        }
                    }
                    @Suppress("DEPRECATION")
                    val id = wm.addNetwork(config)
                    if (id != -1) {
                        @Suppress("DEPRECATION")
                        wm.enableNetwork(id, true)
                        @Suppress("DEPRECATION")
                        wm.reconnect()
                    }
                }
                Unit
            }.onFailure { Log.e("KioskWifi", "addWifiNetwork error", it) }
        }
    }
}
