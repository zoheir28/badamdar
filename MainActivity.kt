package ir.badamdar.market

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * اپلیکیشن بادامدار: نمایش کامل سایت داخل WebView
 * + باز شدن صفحات دیده‌شده در حالت آفلاین
 * + صف‌بندی فرم‌ها در حالت آفلاین و ارسال خودکار پس از اتصال (اسکریپت assets/offline-queue.js)
 */
class MainActivity : AppCompatActivity() {

    private val siteUrl = "https://market.badamdar.ir/"
    private val siteHost = "market.badamdar.ir"

    private lateinit var webView: WebView
    private lateinit var cm: ConnectivityManager
    private lateinit var queueScript: String
    private var docStartInjected = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            fileCallback?.onReceiveValue(uris)
            fileCallback = null
        }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            val req = pendingPermission
            pendingPermission = null
            if (req != null) {
                if (granted.values.all { it }) req.grant(req.resources) else req.deny()
            }
        }

    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runOnUiThread {
                applyCacheMode()
                // به‌محض آنلاین شدن، فرم‌های ذخیره‌شده ارسال شوند
                webView.evaluateJavascript("window.__pfmFlush && window.__pfmFlush()", null)
            }
        }

        override fun onLost(network: Network) {
            runOnUiThread { applyCacheMode() }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        queueScript = assets.open("offline-queue.js").bufferedReader().use { it.readText() }

        webView = WebView(this)
        setContentView(webView)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true) // برای درگاه‌های پرداخت
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true      // لازم برای IndexedDB / localStorage
            databaseEnabled = true
            allowFileAccess = false       // فایل‌های assets همچنان قابل بارگذاری‌اند
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            userAgentString = userAgentString + " BadamdarApp/1.0"
        }
        applyCacheMode()

        // تزریق اسکریپت صف آفلاین پیش از اجرای اسکریپت‌های صفحه (فقط برای دامنه سایت)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, queueScript, setOf("https://$siteHost"))
            docStartInjected = true
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val scheme = uri.scheme ?: return false
                if (scheme == "http" || scheme == "https") return false // همه‌ی صفحات (از جمله درگاه پرداخت) داخل اپ
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri)) // tel:, mailto:, sms:, اپ بانک ...
                    true
                } catch (e: ActivityNotFoundException) {
                    true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                // روش جایگزین برای دستگاه‌هایی که document-start را پشتیبانی نمی‌کنند
                if (!docStartInjected && Uri.parse(url).host == siteHost) {
                    view.evaluateJavascript(queueScript, null)
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOfflinePage(request.url.toString())
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // انتخاب فایل (عکس/ویدیو) در فرم‌ها
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    fileChooserLauncher.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }

            // دسترسی دوربین/میکروفون (مثلاً ضبط ویدیو داخل فرم)
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.origin.host != siteHost) {
                        request.deny(); return@runOnUiThread
                    }
                    val needed = mutableListOf<String>()
                    request.resources.forEach {
                        when (it) {
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> needed += Manifest.permission.CAMERA
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> needed += Manifest.permission.RECORD_AUDIO
                        }
                    }
                    val missing = needed.filter {
                        checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
                    }
                    if (missing.isEmpty()) {
                        request.grant(request.resources)
                    } else {
                        pendingPermission = request
                        permissionLauncher.launch(missing.toTypedArray())
                    }
                }
            }
        }

        // دانلود فایل‌ها با مرورگر
        webView.setDownloadListener { url, _, _, _, _ ->
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) webView.loadUrl(siteUrl) else webView.restoreState(savedInstanceState)
    }

    private fun isOnline(): Boolean {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** آنلاین: رفتار عادی. آفلاین: صفحه‌های ذخیره‌شده در کش حتی اگر منقضی شده باشند نمایش داده می‌شوند. */
    private fun applyCacheMode() {
        webView.settings.cacheMode =
            if (isOnline()) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
    }

    private fun showOfflinePage(failedUrl: String) {
        val html = assets.open("offline.html").bufferedReader().use { it.readText() }
        // baseURL = آدرس صفحه‌ی ناموفق، تا دکمه «تلاش دوباره» همان صفحه را دوباره بارگذاری کند
        webView.loadDataWithBaseURL(failedUrl, html, "text/html", "utf-8", failedUrl)
    }

    override fun onStart() {
        super.onStart()
        cm.registerDefaultNetworkCallback(netCallback)
    }

    override fun onStop() {
        super.onStop()
        try { cm.unregisterNetworkCallback(netCallback) } catch (_: Exception) {}
        CookieManager.getInstance().flush()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        applyCacheMode()
        webView.evaluateJavascript("window.__pfmFlush && window.__pfmFlush()", null)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
