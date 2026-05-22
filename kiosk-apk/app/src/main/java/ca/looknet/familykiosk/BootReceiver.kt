package ca.looknet.familykiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Auto-launches the kiosk after the device boots or restarts.
 * Works for both normal boot and direct-boot (encrypted storage).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                context.startActivity(
                    Intent(context, MainActivity::class.java).apply {
                        // CLEAR_TASK forces a fresh onCreate (so enterLockTaskIfOwner runs)
                        // instead of delivering onNewIntent to a stale task, which would
                        // skip lock-task entry entirely.
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                )
                KioskCallService.start(context)
            }
        }
    }
}
