package com.blitzraw.missioncontrol

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import ai.moonshine.voice.MicTranscriber
import java.util.concurrent.Executors
import org.json.JSONObject

// Speech written out on the phone itself, with Moonshine's newest live English model (medium streaming), so dictation works
// with the PC off. The page asks through window.MCSpeech (start, stop, cancel) and hears back through window.MCSpeechEvent(e):
// progress while the model downloads (the first time only, about 400 MB, kept in the app's own storage), listening once the
// microphone is on, text with all the words so far each time they change, done with the final words after stop, and error.
// The model loads on the first start and stays loaded while the app runs.
class PhoneSpeech(private val activity: Activity, private val webView: WebView) {
  private val worker = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private var mic: MicTranscriber? = null
  // A start, a stop or a cancel moves it on, so a late answer from an older one is dropped.
  @Volatile private var session = 0
  @Volatile private var loaded = false
  // Main thread only: the lines heard so far (Moonshine may still correct one), the line in progress, and whether it listens.
  private val lines = LinkedHashMap<Long, String>()
  private var partial = ""
  private var open = false

  private fun words(): String =
    (lines.values + partial).map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")

  private fun emit(k: String, put: (JSONObject) -> Unit = {}) {
    val e = JSONObject().put("k", k).also(put)
    main.post { webView.evaluateJavascript("window.MCSpeechEvent&&window.MCSpeechEvent($e)", null) }
  }

  private fun transcriber(): MicTranscriber = mic ?: MicTranscriber(activity)
    .callbacksOnMainThread(true)
    .onText { t -> if (open) { partial = t ?: ""; emit("text") { it.put("t", words()) } } }
    .onLine { l -> if (open) { lines[l.id] = l.text ?: ""; partial = ""; emit("text") { it.put("t", words()) } } }
    .onError { e -> if (open) emit("error") { it.put("m", e.message ?: "Speech recognition failed") } }
    .onProgress { f, _ -> emit("progress") { it.put("p", f.toDouble()) } }
    .also { mic = it }

  @JavascriptInterface
  fun start() = main.post {
    val s = ++session
    lines.clear(); partial = ""; open = true
    val m = transcriber()
    worker.execute {
      try {
        if (!loaded) {
          m.load(); loaded = true
          // Words Moonshine would otherwise miss; a library without this still writes the rest out.
          try { m.setKeyterms(listOf("Claude", "Mission Control", "BlitzVoice", "BlitzRaw", "Haiku", "Sonnet", "Opus")) } catch (e: Throwable) {}
        }
        if (s != session) return@execute
        m.start() // asks for the microphone first when it may not be used yet, and waits
        main.post { if (s == session) emit("listening") else worker.execute { m.stop() } }
      } catch (e: Throwable) {
        main.post { if (s == session) { open = false; emit("error") { it.put("m", e.message ?: "The speech model did not start") } } }
      }
    }
  }

  // The last words arrive just after the microphone stops, so done waits a moment for them.
  @JavascriptInterface
  fun stop() = main.post {
    val s = session
    val m = mic ?: return@post
    worker.execute {
      try { m.stop() } catch (e: Throwable) {}
      main.postDelayed({ if (s == session) { open = false; session++; emit("done") { it.put("t", words()) } } }, 350)
    }
  }

  @JavascriptInterface
  fun cancel() = main.post {
    session++; open = false
    val m = mic ?: return@post
    worker.execute { try { if (m.isRunning()) m.stop() } catch (e: Throwable) {} }
  }

  fun close() {
    session++; open = false
    val m = mic; mic = null
    worker.execute { try { m?.close() } catch (e: Throwable) {} }
    worker.shutdown()
  }
}
