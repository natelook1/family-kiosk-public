package ca.looknet.familykiosk.family

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.SharedPreferences
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class FcmService : FirebaseMessagingService() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onNewToken(token: String) {
        // 1. Use your secure encrypted preferences container instead of legacy file
        val prefs = SecurityUtils.getSecurePrefs(this)
        prefs.edit().putString("fcm_token", token).apply()

        val deviceId = prefs.getString("device_id", null) ?: return
        val deviceToken = prefs.getString("device_token", "") ?: ""

        // 2. Delegate the network task cleanly via Retrofit
        serviceScope.launch {
            runCatching {
                NetworkClient.api.updateFcmToken(deviceId, deviceToken, FcmTokenPayload(token))
            }
        }
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data

        if (data["type"] == "update_check") {
            UpdateManager(this).checkAndUpdate()
            return
        }

        val room    = data["roomName"]    ?: return
        val patient = data["patientName"] ?: "Someone"
        val contact = data["contactName"] ?: ""

        val screenOn = (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive

        if (screenOn) {
            // Screen is already on — startActivity works from a high-priority FCM message.
            // Skip the notification entirely to avoid showing a banner and then a full-screen
            // intent at the same time.
            startActivity(
                Intent(this, IncomingCallActivity::class.java).apply {
                    putExtra("room_name",    room)
                    putExtra("patient_name", patient)
                    putExtra("contact_name", contact)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
            )
        } else {
            // Screen is off — background activity starts are blocked by the OS.
            // Use the full-screen intent in the notification to wake the device.
            showIncomingCall(room, patient, contact)
        }
    }

    private fun showIncomingCall(roomName: String, patientName: String, contactName: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // High importance channel is strictly required by Android 10+ to allow
        // full-screen intents to wake up the device from the background.
        val channelId = "incoming_calls_v5"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.deleteNotificationChannel("incoming_video_calls")
            nm.deleteNotificationChannel("incoming_calls_v2")
            nm.deleteNotificationChannel("incoming_calls_v3")
            nm.deleteNotificationChannel("incoming_calls_v4")
            val channel = NotificationChannel(
                channelId,
                "Incoming Calls",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Video call notifications"
                setSound(null, null)
                enableVibration(false)
            }
            nm.createNotificationChannel(channel)
        }

        // Tap notification body → open IncomingCallActivity
        val callIntent = Intent(this, IncomingCallActivity::class.java).apply {
            putExtra("room_name",    roomName)
            putExtra("patient_name", patientName)
            putExtra("contact_name", contactName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPi = PendingIntent.getActivity(
            this, 0, callIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Accept action
        val acceptIntent = Intent(this, IncomingCallActivity::class.java).apply {
            putExtra("room_name",    roomName)
            putExtra("patient_name", patientName)
            putExtra("contact_name", contactName)
            putExtra("auto_accept",  true)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val acceptPi = PendingIntent.getActivity(
            this, 1, acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Decline action
        val declinePi = PendingIntent.getBroadcast(
            this, 2,
            Intent(this, DeclineReceiver::class.java).putExtra("notification_id", CALL_NOTIF_ID),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("$patientName is calling")
            .setContentText("Tap to answer")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(contentPi)
            .setFullScreenIntent(contentPi, true)
            .addAction(android.R.drawable.ic_menu_call, "Answer", acceptPi)
            .addAction(android.R.drawable.ic_delete,    "Decline", declinePi)
            .setAutoCancel(true)
            .setOngoing(true)
            .build()

        nm.notify(CALL_NOTIF_ID, notif)
    }

    companion object {
        const val CALL_NOTIF_ID = 1001
    }
}
