package ca.looknet.familykiosk.family

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class MyPackageReplacedReceiver : BroadcastReceiver() {
    private val tag = "KioskBoot"

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            Log.i(tag, "App updated successfully! Relaunching Kiosk Activity...")
            
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
            
            if (launchIntent != null) {
                context.startActivity(launchIntent)
            } else {
                Log.e(tag, "Failed to resolve launch intent for self-restart.")
            }
        }
    }
}