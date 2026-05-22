package ca.looknet.familykiosk

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent

/**
 * Required receiver for Lock Task Mode / device owner.
 *
 * Activate once on the tablet via ADB (factory-reset device preferred):
 *   adb shell dpm set-device-owner ca.looknet.familykiosk/.DeviceAdminReceiver
 *
 * To remove device owner (if needed):
 *   adb shell dpm remove-active-admin ca.looknet.familykiosk/.DeviceAdminReceiver
 */
class DeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {}
    override fun onDisabled(context: Context, intent: Intent) {}
}
