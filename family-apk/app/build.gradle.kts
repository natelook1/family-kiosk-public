import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

val localProps = Properties().also { props ->
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { props.load(it) }
}

android {
    namespace  = "ca.looknet.familykiosk.family"
    compileSdk = 34

    defaultConfig {
        applicationId = "ca.looknet.familykiosk.family"
        minSdk        = 26
        targetSdk     = 34
        versionCode   = 15
        versionName   = "2.3"

        // Backend URL baked in at build time — override in local.properties if needed
        buildConfigField("String", "API_BASE", "\"https://family.looknet.ca/webhook\"")
        buildConfigField("String", "FAMILY_APP_URL", "\"https://family-call.looknet.ca\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            storeFile     = file((localProps["KEYSTORE_PATH"] as? String) ?: "C:/dev/keystores/family-kiosk-release.jks")
            storePassword = (localProps["KEYSTORE_PASSWORD"] as? String)?.takeIf { it.isNotBlank() }
                            ?: System.getenv("KIOSK_KEYSTORE_PASSWORD") ?: "CHANGEME"
            keyAlias      = (localProps["KEY_ALIAS"] as? String)?.takeIf { it.isNotBlank() }
                            ?: System.getenv("KIOSK_KEY_ALIAS") ?: "family-kiosk"
            keyPassword   = (localProps["KEY_PASSWORD"] as? String)?.takeIf { it.isNotBlank() }
                            ?: System.getenv("KIOSK_KEY_PASSWORD") ?: "CHANGEME"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig   = signingConfigs.getByName("release")
        }
        debug {
            signingConfig   = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation(platform("com.google.firebase:firebase-bom:33.1.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    // Networking
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Security
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
