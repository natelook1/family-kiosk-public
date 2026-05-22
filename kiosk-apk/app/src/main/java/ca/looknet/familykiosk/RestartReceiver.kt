package ca.looknet.familykiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class RestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i("RestartReceiver", "Daily restart alarm fired")
        
        val launchIntent = context.packageManager
            .getLaunchIntentForPackage(context.packageName)
            ?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }

        if (launchIntent != null) {
            context.startActivity(launchIntent)
        }

        android.os.Process.killProcess(android.os.Process.myPid())
    }
}
