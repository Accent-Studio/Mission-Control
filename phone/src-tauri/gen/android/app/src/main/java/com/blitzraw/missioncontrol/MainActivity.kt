package com.blitzraw.missioncontrol

import android.content.Context
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.net.Uri
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // Wi-Fi power saving lets the radio doze between beacons, and the link to the PC then goes silent for seconds at a
  // time. While the app is on screen this lock keeps Wi-Fi fully awake; it is let go as soon as the app is not.
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onResume() {
    super.onResume()
    val lock = wifiLock ?: run {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
      @Suppress("DEPRECATION")
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifi.createWifiLock(mode, "MissionControl:link").also { it.setReferenceCounted(false); wifiLock = it }
    }
    if (!lock.isHeld) lock.acquire()
  }

  override fun onPause() {
    wifiLock?.let { if (it.isHeld) it.release() }
    super.onPause()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Dark only: light icons on transparent bars.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)

    // With the newest target version the app is always drawn edge to edge and the web view
    // reports no insets of its own, so the pages cannot pad themselves. Pad the view that holds
    // the web view instead: the status bar, the camera hole, the gesture bar and the keyboard
    // never cover the page, and no page needs phone-only styling for it.
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val room = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(room.left, room.top, room.right, room.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(root)
  }

  // The web view's history starts with the app's own page, which only opens the PC's pages. Back on the
  // first PC page would land there and it would open the PC again, so Back leaves the app instead
  // (it moves to the background, like the Home button). Everywhere else Back goes back one page.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val list = webView.copyBackForwardList()
        val index = list.currentIndex
        val here = list.getItemAtIndex(index)?.url
        val before = if (index > 0) list.getItemAtIndex(index - 1)?.url else null
        if (index > 0 && !isShell(here) && !isShell(before)) {
          webView.goBack()
        } else {
          moveTaskToBack(true)
        }
      }
    })
  }

  private fun isShell(url: String?): Boolean = url != null && Uri.parse(url).host == "tauri.localhost"
}
