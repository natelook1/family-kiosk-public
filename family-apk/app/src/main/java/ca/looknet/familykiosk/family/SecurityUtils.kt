package ca.looknet.familykiosk.family

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.KeyStore

private const val PREFS_NAME = "family_kiosk_secure"
private const val KEYSTORE_ALIAS = "_androidx_security_master_key"

object SecurityUtils {
    @Volatile
    private var instance: SharedPreferences? = null

    fun getSecurePrefs(context: Context): SharedPreferences {
        return instance ?: synchronized(this) {
            instance ?: createPrefs(context.applicationContext).also { instance = it }
        }
    }

    private fun createPrefs(appContext: Context): SharedPreferences {
        return try {
            openEncryptedPrefs(appContext)
        } catch (e: Exception) {
            Log.w("SecurityUtils", "EncryptedSharedPreferences failed, wiping and retrying", e)
            // Delete the corrupt pref file and the Keystore entry so the next attempt
            // gets a clean slate rather than hitting the same broken key again.
            runCatching {
                appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
                val ks = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
                if (ks.containsAlias(KEYSTORE_ALIAS)) ks.deleteEntry(KEYSTORE_ALIAS)
            }
            try {
                openEncryptedPrefs(appContext)
            } catch (e2: Exception) {
                // Total keystore failure (rare hardware fault) — fall back to plaintext.
                // The device will re-pair on next launch, which is preferable to a crash loop.
                Log.e("SecurityUtils", "Keystore unrecoverable, falling back to plaintext prefs", e2)
                appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            }
        }
    }

    private fun openEncryptedPrefs(appContext: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            appContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
}