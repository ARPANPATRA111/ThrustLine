package io.github.arpanpatra111.thrustline

import android.content.pm.ActivityInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.browser.trusted.TrustedWebActivityDisplayMode

class LauncherActivity : com.google.androidbrowserhelper.trusted.LauncherActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (isFinishing) return

        // Android 8.0 crashes when a translucent activity requests an orientation.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
        }

        if (isOnline()) launchTwa() else showOffline()
    }

    override fun shouldLaunchImmediately() = false

    override fun getDisplayMode(): TrustedWebActivityDisplayMode {
        val cutout = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        } else {
            0
        }
        return TrustedWebActivityDisplayMode.ImmersiveMode(true, cutout)
    }

    private fun isOnline(): Boolean {
        val connectivity = getSystemService(ConnectivityManager::class.java) ?: return true
        val network = connectivity.activeNetwork ?: return false
        val capabilities = connectivity.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showOffline() {
        setContentView(R.layout.offline)
        val message = findViewById<View>(R.id.offline_message)
        findViewById<View>(R.id.retry).setOnClickListener {
            if (isOnline()) {
                launchTwa()
            } else {
                message.animate().cancel()
                message.alpha = 0.3f
                message.animate().alpha(1f).setDuration(400).start()
            }
        }
    }
}
