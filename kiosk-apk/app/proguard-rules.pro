# Keep JavaScript interface methods — ProGuard must not strip or rename these
# as they are called by name from the web app via window.Android.*
-keepclassmembers class ca.looknet.familykiosk.KioskJsInterface {
    @android.webkit.JavascriptInterface <methods>;
}
