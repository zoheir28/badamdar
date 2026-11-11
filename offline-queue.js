/*
 * صف آفلاین فرم‌ها — بادامدار
 * وقتی گوشی آفلاین است، ارسال فرم‌ها (فرم معمولی، fetch و XMLHttpRequest از نوع POST به همین سایت)
 * در IndexedDB ذخیره می‌شود و به‌محض آنلاین شدن به‌ترتیب ارسال می‌گردد.
 */
(function () {
  'use strict';
  if (window.__pfmOfflineLoaded) return;
  window.__pfmOfflineLoaded = true;

  /* ---------- تنظیمات ---------- */
  // درخواست‌هایی که هرگز نباید صف شوند (پیامک/OTP، ورود، پرداخت...). آدرس و مقدار فیلد action بررسی می‌شود.
  var EXCLUDE = /otp|sms|verify|login|logout|password|payment|checkout|gateway|nonce/i;
  var RETRY_MS = 30000;
  var FAKE_OK = { success: true, data: { offline_queued: true, message: 'ذخیره شد؛ پس از اتصال به اینترنت ارسال می‌شود.' } };

  var DB_NAME = 'pfm_offline_queue', STORE = 'items';
  var origFetch = window.fetch ? window.fetch.bind(window) : null;

  /* ---------- IndexedDB ---------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function dbRun(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var r = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(r && r.result); db.close(); };
        t.onerror = t.onabort = function () { reject(t.error); db.close(); };
      });
    });
  }
  function addItem(item) { return dbRun('readwrite', function (s) { return s.add(item); }); }
  function putItem(item) { return dbRun('readwrite', function (s) { return s.put(item); }); }
  function delItem(id) { return dbRun('readwrite', function (s) { return s.delete(id); }); }
  function allItems() { return dbRun('readonly', function (s) { return s.getAll(); }).then(function (r) { return r || []; }); }

  /* ---------- ابزارها ---------- */
  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
  }
  function toAbs(url) { return new URL(url, location.href).href; }
  function fa(n) { try { return Number(n).toLocaleString('fa-IR'); } catch (e) { return String(n); } }

  function toast(msg) {
    var run = function () {
      var d = document.createElement('div');
      d.textContent = msg;
      d.setAttribute('style', 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);max-width:88%;background:#004c42;color:#fff;padding:12px 18px;border-radius:12px;font:14px/1.8 Tahoma,Arial,sans-serif;z-index:2147483647;direction:rtl;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.25)');
      document.documentElement.appendChild(d);
      setTimeout(function () { d.remove(); }, 4000);
    };
    if (document.documentElement) run(); else document.addEventListener('DOMContentLoaded', run);
  }

  function isExcluded(url, actionValue, bodyText) {
    return EXCLUDE.test(url || '') || EXCLUDE.test(actionValue || '') || EXCLUDE.test(bodyText || '');
  }

  /* قالب ذخیره: { kind:'form', fields:[[name, value|File]...] } یا { kind:'raw', body, ct } */
  function packBody(body, contentType) {
    if (body instanceof FormData) {
      return { kind: 'form', fields: Array.from(body.entries()) };
    }
    if (body instanceof URLSearchParams) {
      return { kind: 'raw', body: body.toString(), ct: 'application/x-www-form-urlencoded;charset=UTF-8' };
    }
    if (typeof body === 'string') {
      var ct = contentType || (body.charAt(0) === '{' || body.charAt(0) === '[' ? 'application/json' : 'application/x-www-form-urlencoded;charset=UTF-8');
      return { kind: 'raw', body: body, ct: ct };
    }
    return null; // Blob/ArrayBuffer و ... پشتیبانی نمی‌شود
  }
  function actionOf(packed) {
    if (!packed) return '';
    if (packed.kind === 'form') {
      for (var i = 0; i < packed.fields.length; i++) {
        if (packed.fields[i][0] === 'action' && typeof packed.fields[i][1] === 'string') return packed.fields[i][1];
      }
      return '';
    }
    var m = /(?:^|&)action=([^&]*)/.exec(packed.body || '');
    return m ? decodeURIComponent(m[1]) : '';
  }
  function bodyText(packed) {
    if (!packed) return '';
    return packed.kind === 'raw' ? packed.body : '';
  }

  function enqueue(url, method, packed) {
    return addItem({
      url: toAbs(url), method: method, packed: packed,
      page: location.href, title: document.title || '', time: Date.now(), status: 'pending', note: ''
    }).then(function (r) { refreshBadge(); return r; });
  }

  function queueable(method, url, packed) {
    if (!/^(POST|PUT|PATCH|DELETE)$/.test(method)) return false;
    if (!sameOrigin(url) || !packed) return false;
    return !isExcluded(url, actionOf(packed), bodyText(packed));
  }

  /* ---------- fetch ---------- */
  if (origFetch) {
    window.fetch = function (input, init) {
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var packed = (init && init.body != null) ? packBody(init.body, init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) : null;
      if (!queueable(method, url, packed)) return origFetch(input, init);

      var fake = function () {
        return enqueue(url, method, packed).then(function () {
          toast(FAKE_OK.data.message);
          return new Response(JSON.stringify(FAKE_OK), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
      };
      if (!navigator.onLine) return fake();
      return origFetch(input, init).catch(function (err) {
        if (err instanceof TypeError) return fake(); // قطعی شبکه
        throw err;
      });
    };
  }

  /* ---------- XMLHttpRequest (jQuery / admin-ajax) ---------- */
  var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XP) {
    var oOpen = XP.open, oSend = XP.send, oSetHeader = XP.setRequestHeader;
    XP.open = function (m, u) {
      this.__pfm = { method: String(m || 'GET').toUpperCase(), url: u, ct: '' };
      return oOpen.apply(this, arguments);
    };
    XP.setRequestHeader = function (k, v) {
      if (this.__pfm && /^content-type$/i.test(k)) this.__pfm.ct = v;
      return oSetHeader.apply(this, arguments);
    };
    XP.send = function (body) {
      var meta = this.__pfm, xhr = this;
      if (meta && !navigator.onLine && body != null) {
        var packed = packBody(body, meta.ct);
        if (queueable(meta.method, meta.url, packed)) {
          enqueue(meta.url, meta.method, packed).then(function () {
            toast(FAKE_OK.data.message);
            var txt = JSON.stringify(FAKE_OK);
            [['readyState', 4], ['status', 200], ['statusText', 'OK'], ['responseURL', toAbs(meta.url)],
              ['responseText', txt], ['response', xhr.responseType === 'json' ? FAKE_OK : txt]].forEach(function (p) {
              try { Object.defineProperty(xhr, p[0], { value: p[1], configurable: true }); } catch (e) { /* ignore */ }
            });
            ['readystatechange', 'load', 'loadend'].forEach(function (t) { xhr.dispatchEvent(new Event(t)); });
          });
          return;
        }
      }
      return oSend.apply(this, arguments);
    };
  }

  /* ---------- فرم معمولی (ارسال با صفحه‌ی جدید) ---------- */
  // روی window و در فاز bubble: اگر خود صفحه submit را با AJAX گرفته باشد (defaultPrevented) دخالت نمی‌کنیم.
  window.addEventListener('submit', function (e) {
    if (e.defaultPrevented || navigator.onLine) return;
    var f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    var method = (f.getAttribute('method') || 'get').toUpperCase();
    if (method !== 'POST') return;
    var url = f.action || location.href;
    var fd = new FormData(f);
    if (e.submitter && e.submitter.name) fd.append(e.submitter.name, e.submitter.value);
    var packed = packBody(fd);
    if (!queueable('POST', url, packed)) { toast('اینترنت وصل نیست؛ این فرم در حالت آفلاین قابل ثبت نیست.'); e.preventDefault(); return; }
    e.preventDefault();
    enqueue(url, 'POST', packed).then(function () {
      toast('فرم ذخیره شد؛ به‌محض اتصال به اینترنت ارسال می‌شود.');
      try { f.reset(); } catch (err) { /* ignore */ }
    }).catch(function () { toast('ذخیره‌ی آفلاین ناموفق بود.'); });
  }, false);

  /* ---------- ارسال صف ---------- */
  var flushing = false;

  function buildRequest(item) {
    var p = item.packed, init = { method: item.method, credentials: 'same-origin' };
    if (p.kind === 'form') {
      var fd = new FormData();
      p.fields.forEach(function (kv) {
        if (kv[1] instanceof Blob) fd.append(kv[0], kv[1], kv[1].name || 'file'); else fd.append(kv[0], kv[1]);
      });
      init.body = fd;
    } else {
      init.body = p.body;
      init.headers = { 'Content-Type': p.ct };
    }
    return init;
  }

  function looksFailed(text) {
    var t = (text || '').trim();
    if (t === '-1' || t === '0') return true; // پاسخ‌های خطای admin-ajax وردپرس
    try { var j = JSON.parse(t); return !!(j && j.success === false); } catch (e) { return false; }
  }

  function sendOne(item) {
    return origFetch(item.url, buildRequest(item)).then(function (res) {
      if (res.status >= 500) throw new Error('server');           // بعداً دوباره تلاش می‌شود
      if (res.status >= 400) {
        item.status = 'failed'; item.note = 'خطای ' + res.status + ' (ممکن است نیاز به ورود مجدد باشد یا فرم منقضی شده باشد)';
        return putItem(item).then(function () { return 'failed'; });
      }
      return res.text().then(function (txt) {
        if (looksFailed(txt)) {
          item.status = 'failed'; item.note = 'سایت درخواست را نپذیرفت (ممکن است فرم منقضی شده باشد)';
          return putItem(item).then(function () { return 'failed'; });
        }
        return delItem(item.id).then(function () { return 'sent'; });
      });
    });
  }

  function flush() {
    if (flushing || !navigator.onLine || !origFetch) return Promise.resolve();
    flushing = true;
    var sent = 0, failed = 0;
    return allItems().then(function (items) {
      items = items.filter(function (i) { return i.status !== 'failed'; });
      var chain = Promise.resolve();
      var stop = false;
      items.forEach(function (item) {
        chain = chain.then(function () {
          if (stop) return;
          return sendOne(item).then(function (r) { if (r === 'sent') sent++; else failed++; })
            .catch(function () { stop = true; }); // شبکه/سرور در دسترس نیست: ادامه نده
        });
      });
      return chain;
    }).catch(function () { /* ignore */ }).then(function () {
      flushing = false;
      refreshBadge();
      if (sent) toast(fa(sent) + ' مورد ذخیره‌شده با موفقیت به سایت ارسال شد.');
      if (failed) toast(fa(failed) + ' مورد ارسال نشد؛ از نشان پایین صفحه بررسی کنید.');
    });
  }
  window.__pfmFlush = flush;

  /* ---------- نشانگر و فهرست موارد در انتظار ---------- */
  var badge, panel;
  function ensureUI() {
    if (badge || !document.body) return;
    badge = document.createElement('div');
    badge.setAttribute('style', 'position:fixed;right:12px;bottom:14px;background:#07584f;color:#fff;padding:10px 14px;border-radius:24px;font:13px Tahoma,Arial,sans-serif;z-index:2147483646;direction:rtl;display:none;box-shadow:0 3px 12px rgba(0,0,0,.3)');
    badge.addEventListener('click', togglePanel);
    document.body.appendChild(badge);
    panel = document.createElement('div');
    panel.setAttribute('style', 'position:fixed;right:12px;left:12px;bottom:64px;max-height:55vh;overflow:auto;background:#fff;color:#1b2b1b;border-radius:14px;padding:12px;font:13px/1.8 Tahoma,Arial,sans-serif;z-index:2147483646;direction:rtl;display:none;box-shadow:0 4px 20px rgba(0,0,0,.35)');
    document.body.appendChild(panel);
  }
  function togglePanel() {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') renderPanel();
  }
  function renderPanel() {
    allItems().then(function (items) {
      panel.innerHTML = '';
      if (!items.length) { panel.textContent = 'موردی در انتظار ارسال نیست.'; return; }
      items.forEach(function (it) {
        var row = document.createElement('div');
        row.setAttribute('style', 'border-bottom:1px solid #e3e8e3;padding:8px 0');
        var t = document.createElement('div');
        t.textContent = (it.title || it.url) + ' — ' + new Date(it.time).toLocaleString('fa-IR') + (it.status === 'failed' ? ' — ناموفق: ' + it.note : ' — در انتظار ارسال');
        row.appendChild(t);
        var del = document.createElement('button');
        del.textContent = 'حذف';
        del.setAttribute('style', 'margin-top:4px;padding:4px 12px;border:0;border-radius:8px;background:#c62828;color:#fff');
        del.onclick = function () { delItem(it.id).then(function () { refreshBadge(); renderPanel(); }); };
        row.appendChild(del);
        if (it.status === 'failed') {
          var retry = document.createElement('button');
          retry.textContent = 'تلاش دوباره';
          retry.setAttribute('style', 'margin:4px 8px 0 0;padding:4px 12px;border:0;border-radius:8px;background:#07584f;color:#fff');
          retry.onclick = function () { it.status = 'pending'; it.note = ''; putItem(it).then(function () { return flush(); }).then(renderPanel); };
          row.appendChild(retry);
        }
        panel.appendChild(row);
      });
    });
  }
  function refreshBadge() {
    ensureUI();
    if (!badge) return;
    allItems().then(function (items) {
      if (!items.length) { badge.style.display = 'none'; if (panel) panel.style.display = 'none'; return; }
      badge.textContent = '📤 ' + fa(items.length) + ' مورد در انتظار ارسال';
      badge.style.display = 'block';
    }).catch(function () { /* ignore */ });
  }

  /* ---------- راه‌اندازی ---------- */
  window.addEventListener('online', function () { setTimeout(flush, 800); });
  document.addEventListener('DOMContentLoaded', function () { refreshBadge(); flush(); });
  setInterval(function () { if (navigator.onLine) flush(); }, RETRY_MS);
})();
