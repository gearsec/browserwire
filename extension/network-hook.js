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
          let responseBody = null;
          let bodyTruncated = false;
          let bodySizeBytes = null;

          if (JSON_CT_RE.test(ct)) {
            const clone = response.clone();
            const text = await clone.text();
            bodySizeBytes = text.length;
            if (text.length <= MAX_BODY_BYTES) {
              responseBody = JSON.parse(text);
            } else {
              bodyTruncated = true;
              try { responseBody = JSON.parse(text.slice(0, MAX_BODY_BYTES)); } catch {}
            }
          }

          let queryParams = null;
          try {
            const u = new URL(reqUrl);
            if (u.search) queryParams = Object.fromEntries(u.searchParams);
          } catch {}

          post("entry", {
            id: ++_idCounter,
            transport: "fetch",
            url: reqUrl, method: reqMethod, status: response.status,
            contentType: ct,
            timestamp: startTime, durationMs: Date.now() - startTime,
            requestBody, queryParams,
            responseBody, bodySizeBytes, bodyTruncated
          });
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
          let responseBody = null;
          let bodyTruncated = false;
          let bodySizeBytes = null;

          if (JSON_CT_RE.test(ct) && this.responseText) {
            const respText = this.responseText;
            bodySizeBytes = respText.length;
            if (respText.length <= MAX_BODY_BYTES) {
              responseBody = JSON.parse(respText);
            } else {
              bodyTruncated = true;
              try { responseBody = JSON.parse(respText.slice(0, MAX_BODY_BYTES)); } catch {}
            }
          }

          let queryParams = null;
          try {
            const u = new URL(reqUrl, window.location.origin);
            if (u.search) queryParams = Object.fromEntries(u.searchParams);
          } catch {}

          post("entry", {
            id: ++_idCounter,
            transport: "xhr",
            url: reqUrl, method: reqMethod, status: this.status,
            contentType: ct,
            timestamp: startTime, durationMs: Date.now() - startTime,
            requestBody, queryParams,
            responseBody, bodySizeBytes, bodyTruncated
          });
        } catch {}
        post("req_end", { url: reqUrl });
      }
    }, { once: true });

    return _origSend.call(this, body);
  };
  // ─── SSR Embedded Data Extraction ───────────────────────────────────

  const extractEmbeddedData = () => {
    // 1. Collect visible text strings from the DOM
    const samples = [];
    const candidates = document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, [role="heading"], p, span, a, td, th, li, label, figcaption, blockquote, dt, dd, caption'
    );
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        samples.push(text);
      }
    }

    if (samples.length === 0) return;

    // 2. Scan all <script> tags for JSON containing visible text
    const found = [];
    const scripts = document.querySelectorAll('script');

    for (const el of scripts) {
      try {
        const raw = el.textContent || '';
        if (!raw) continue;

        // Check if any sampled text appears in this script
        const matchedSamples = samples.filter(s => raw.includes(s));
        if (matchedSamples.length === 0) continue;

        // Extract JSON
        let data = null;
        let jsonStr = null;

        if (el.type === 'application/json' || el.type === 'application/ld+json') {
          jsonStr = raw;
        } else {
          // JS assignment pattern: window.X = {...} or var X = [...]
          const m = raw.match(/=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/);
          if (m) jsonStr = m[1];
        }

        if (!jsonStr) continue;

        try { data = JSON.parse(jsonStr); } catch { continue; }

        const source = el.id
          ? `script#${el.id}`
          : el.type === 'application/json' || el.type === 'application/ld+json'
            ? `script[type=${el.type}]`
            : 'script (inline)';

        found.push({
          source,
          sizeBytes: jsonStr.length,
          matchedSamples: matchedSamples.length,
          data
        });
      } catch {}
    }

    if (found.length > 0) {
      post("embedded_data", { entries: found });
    }
  };

  // Run once after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', extractEmbeddedData, { once: true });
  } else {
    setTimeout(extractEmbeddedData, 0);
  }
})();
