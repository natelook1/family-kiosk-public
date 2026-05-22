// PLACE AT: kiosk-apk/app/build.gradle.kts (replacing existing)
//
// This version uses a proper release keystore instead of the debug key.
// BEFORE BUILDING:
//   1. Generate the keystore once:
//        keytool -genkey -v -keystore C:/dev/keystores/family-kiosk-release.jks ^
//          -keyalg RSA -keysize 2048 -validity 10000 -alias family-kiosk
//   2. Set env vars (or edit the fallbacks below once, then never again):
//        setx KIOSK_KEYSTORE_PASSWORD "your-store-pass"
//        setx KIOSK_KEY_PASSWORD      "your-key-pass"
//      (then restart PowerShell)
//   3. BACK UP the .jks file. If you lose it, no field tablet can ever
//      be updated again without a factory reset.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ca.looknet.familykiosk"
    compileSdk = 34

    defaultConfig {
        applicationId = "ca.looknet.familykiosk"
        minSdk = 26
        targetSdk = 34

        // Ensure this is HIGHER than what is on the device
        versionCode = 63
        versionName = "63.0"

        buildConfigField("String", "KIOSK_URL",  "\"https://family-kiosk.looknet.ca\"")
        buildConfigField("String", "API_BASE",   "\"https://family.looknet.ca\"")
        buildConfigField("String", "UNLOCK_PIN", "\"1234\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            // Absolute path so builds work regardless of CWD.
            storeFile     = file("C:/dev/keystores/family-kiosk-release.jks")
            storePassword = System.getenv("KIOSK_KEYSTORE_PASSWORD") ?: "CHANGEME"
            keyAlias      = "family-kiosk"
            keyPassword   = System.getenv("KIOSK_KEY_PASSWORD") ?: "CHANGEME"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable    = false
            signingConfig   = signingConfigs.getByName("release")

            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
            signingConfig   = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
