package ca.looknet.familykiosk.family

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

/**
 * Receives status updates from the PackageInstaller session.
 */
class UpdateReceiver : BroadcastReceiver() {
    private val tag = "FamilyUpdateReceiver"

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return

        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val version = intent.getIntExtra("version", 0)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        
        val updateManager = UpdateManager(context.applicationContext)

        when (status) {
            PackageInstaller.STATUS_SUCCESS -> {
                Log.i(tag, "Upgrade successful for v$version")
                updateManager.notifyInstallResult(success = true, version = version, detail = null)
            }
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // The OS calls this when user confirmation is required (the "Update?" dialog)
                Log.i(tag, "Prompting user for installation confirmation...")
                val confirmationIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                
                confirmationIntent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(confirmationIntent)
            }
            else -> {
                // Handle cancellations (STATUS_FAILURE_ABORTED), invalid certs, or storage issues
                Log.e(tag, "PackageInstaller failed/canceled: status=$status, message=$message")
                updateManager.notifyInstallResult(success = false, version = version, detail = message)
            }
        }
    }
}