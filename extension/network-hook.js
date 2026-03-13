/**
 * network-hook.js — MAIN world network interceptor
 *
 * Runs in the page's MAIN world to intercept actual fetch/XHR calls.
 * Captured entries are posted to the ISOLATED world content script
 * via window.postMessage.
 */
(function() {
  const SKIP_URL_RE = /google-analytics|segment\.io|sentry\.io|hotjar|intercom|doubleclick|fonts\.(googleapis|gstatic)|\.woff2?|\.ttf|\.css(\?|$)|\.png|\.jpg|\.svg|\.gif/i;
  const JSON_CT_RE = /application\/(?:.*\+)?json/i;
  const MAX_BODY_BYTES = 50 * 1024;
  let _idCounter = 0;

  const post = (type, detail) => {
    window.postMessage({ source: "browserwire-network-hook", type, detail }, "*");
  };

  // ─── Fetch Hook ────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
    const req = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
    const reqUrl = req.url;
    const reqMethod = req.method || 'GET';
    const shouldCapture = !SKIP_URL_RE.test(reqUrl);
    const startTime = Date.now();

    // Signal request start (for idle tracking)
    if (shouldCapture) post("req_start", { url: reqUrl });

    // Capture request body for POST/PUT/PATCH
    let requestBody = null;
    if (shouldCapture && ['POST','PUT','PATCH'].includes(reqMethod)) {
      const rawBody = args[1]?.body;
      if (typeof rawBody === 'string') {
        try { requestBody = JSON.parse(rawBody); } catch {}
      } else if (args[0] instanceof Request) {
        try {
          const cloned = req.clone();
          const text = await cloned.text();
          if (text) requestBody = JSON.parse(text);
        } catch {}
      }
    }

    try {
      const response = await _origFetch.apply(this, args);
      if (shouldCapture) {
        try {
          const ct = response.headers.get('content-type') || '';
          if (JSON_CT_RE.test(ct)) {
            const clone = response.clone();
            const text = await clone.text();
            if (text.length <= MAX_BODY_BYTES) {
              let queryParams = null;
              try {
                const u = new URL(reqUrl);
                if (u.search) queryParams = Object.fromEntries(u.searchParams);
              } catch {}

              post("entry", {
                id: ++_idCounter,
                transport: "fetch",
                url: reqUrl, method: reqMethod, status: response.status,
                timestamp: startTime, durationMs: Date.now() - startTime,
                requestBody,
                queryParams,
                responseBody: JSON.parse(text), bodySizeBytes: text.length
              });
            }
          }
        } catch {}
        post("req_end", { url: reqUrl });
      }
      return response;
    } catch (err) {
      if (shouldCapture) post("req_end", { url: reqUrl });
      throw err;
    }
  };

  // ─── history.pushState / replaceState Hook ─────────────────────────
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;

  history.pushState = function(...args) {
    const result = _origPushState.apply(this, args);
    post("pushstate", { url: window.location.href });
    return result;
  };

  history.replaceState = function(...args) {
    const result = _origReplaceState.apply(this, args);
    post("pushstate", { url: window.location.href });
    return result;
  };

  // ─── XHR Hook ──────────────────────────────────────────────────────
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._bwMethod = method;
    this._bwUrl = typeof url === 'string' ? url : String(url);
    return _origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const reqUrl = this._bwUrl || '';
    const reqMethod = (this._bwMethod || 'GET').toUpperCase();
    const shouldCapture = !SKIP_URL_RE.test(reqUrl);
    const startTime = Date.now();

    if (shouldCapture) post("req_start", { url: reqUrl });

    let requestBody = null;
    if (shouldCapture && body && ['POST','PUT','PATCH'].includes(reqMethod)) {
      try {
        requestBody = typeof body === 'string' ? JSON.parse(body) : null;
      } catch {}
    }

    this.addEventListener('loadend', () => {
      if (shouldCapture) {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (JSON_CT_RE.test(ct) && this.responseText && this.responseText.length <= MAX_BODY_BYTES) {
            let queryParams = null;
            try {
              const u = new URL(reqUrl, window.location.origin);
              if (u.search) queryParams = Object.fromEntries(u.searchParams);
            } catch {}

            post("entry", {
              id: ++_idCounter,
              transport: "xhr",
              url: reqUrl, method: reqMethod, status: this.status,
              timestamp: startTime, durationMs: Date.now() - startTime,
              requestBody,
              queryParams,
              responseBody: JSON.parse(this.responseText), bodySizeBytes: this.responseText.length
            });
          }
        } catch {}
        post("req_end", { url: reqUrl });
      }
    }, { once: true });

    return _origSend.call(this, body);
  };
})();
