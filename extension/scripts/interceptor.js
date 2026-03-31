/**
 * Injected into the PAGE context (world: "MAIN") at document_start.
 *
 * Captures the XSRF token from outgoing Google Chat requests by
 * monkey-patching XMLHttpRequest and fetch before any Chat JS executes.
 *
 * Also provides a page-context fetch proxy so the content script can
 * make API calls using the browser's full cookie jar automatically.
 *
 * On chat.google.com and mail.google.com (Gmail's embedded Chat) pages, this
 * monkey-patches XHR.setRequestHeader and window.fetch to intercept the
 * x-framework-xsrf-token header that Google Chat attaches to its API requests.
 * The captured token is relayed to the Node.js bridge server via content.js →
 * background.js → WebSocket, where it is auto-injected into all proxied
 * Google Chat requests.
 */
(function () {
  // Version-aware guard: allows re-injection to supersede an older version.
  // When background.js re-injects after an extension reload, the new version
  // takes over and old event listeners become no-ops via the version check.
  const INTERCEPTOR_VERSION = 2;
  if (window.__gchatBridgeInterceptorVersion === INTERCEPTOR_VERSION) return;
  window.__gchatBridgeInterceptorVersion = INTERCEPTOR_VERSION;

  // Preserve originals before anything on the page can replace them.
  // Only capture on first load — re-injection reuses existing originals.
  const origFetch = window.__gchatBridgeOrigFetch || window.fetch;
  const origXhrOpen = window.__gchatBridgeOrigXhrOpen || XMLHttpRequest.prototype.open;
  const origXhrSetHeader = window.__gchatBridgeOrigXhrSetHeader || XMLHttpRequest.prototype.setRequestHeader;
  window.__gchatBridgeOrigFetch = origFetch;
  window.__gchatBridgeOrigXhrOpen = origXhrOpen;
  window.__gchatBridgeOrigXhrSetHeader = origXhrSetHeader;

  // URL allowlist — only allow proxied requests to Google Chat origins.
  // Acts as defense-in-depth in case the manifest.json content_scripts
  // matches are ever broadened.
  const ALLOWED_ORIGINS = [
    "https://chat.google.com",
    "https://mail.google.com",
  ];

  function isAllowedUrl(url) {
    try {
      const parsed = new URL(url);
      return ALLOWED_ORIGINS.some((origin) => parsed.origin === origin);
    } catch {
      return false;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function bodyToArray(body) {
    try {
      if (body instanceof Uint8Array) return Array.from(body);
      if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
      if (ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    } catch (_) {}
    return null;
  }

  // ─── Google Chat XSRF Token Capture ────────────────────────────────────
  // Activate on chat.google.com and mail.google.com (Gmail's embedded Chat).
  // Uses lastXsrfToken to deduplicate but allows rotation (unlike a boolean
  // flag which would permanently stop capture after the first token).
  const GOOGLE_CHAT_ORIGINS = ["https://chat.google.com", "https://mail.google.com"];
  if (GOOGLE_CHAT_ORIGINS.includes(window.location.origin)) {
    let lastXsrfToken = null;

    function relayXsrfToken(token) {
      if (token === lastXsrfToken) return; // Deduplicate, but allow rotation
      lastXsrfToken = token;
      window.postMessage({ type: "GCHAT_BRIDGE_XSRF_TOKEN", token }, window.location.origin);
    }

    // Monkey-patch XHR to intercept the XSRF header
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._gchatUrl = typeof url === "string" ? url : url?.toString() || "";
      return origXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (name.toLowerCase() === "x-framework-xsrf-token" && value) {
        relayXsrfToken(value);
      }
      return origXhrSetHeader.call(this, name, value);
    };

    // Monkey-patch fetch to intercept the XSRF header from fetch init.headers
    window.fetch = function (input, init) {
      if (init?.headers) {
        let token = null;
        if (init.headers instanceof Headers) {
          token = init.headers.get("x-framework-xsrf-token");
        } else if (Array.isArray(init.headers)) {
          const entry = init.headers.find(
            ([k]) => k.toLowerCase() === "x-framework-xsrf-token"
          );
          if (entry) token = entry[1];
        } else if (typeof init.headers === "object") {
          for (const [k, v] of Object.entries(init.headers)) {
            if (k.toLowerCase() === "x-framework-xsrf-token") {
              token = v;
              break;
            }
          }
        }
        if (token) relayXsrfToken(token);
      }
      return origFetch.apply(this, arguments);
    };
  }

  // ─── Page-context API proxy ──────────────────────────────────────────────
  // The Node.js bridge server sends API requests through the extension;
  // the content script relays them here where the browser attaches cookies.

  const myVersion = INTERCEPTOR_VERSION; // captured in closure
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "GCHAT_BRIDGE_API_REQUEST") return;
    // If a newer interceptor version has been injected, this listener is stale — bail out.
    if (window.__gchatBridgeInterceptorVersion !== myVersion) return;

    const { requestId, url, method, headers, body, bodyType, bodyBytes } = event.data;

    // Reject requests to URLs outside the allowed Google Chat origins
    if (!isAllowedUrl(url)) {
      window.postMessage({
        type: "GCHAT_BRIDGE_API_RESPONSE",
        requestId,
        ok: false,
        status: 403,
        headers: {},
        body: null,
        error: `URL not in allowed origins: ${url}`,
      }, window.location.origin);
      return;
    }

    try {
      const fetchInit = {
        method: method || "POST",
        credentials: "include",
        headers: headers || {},
      };

      // Binary body support — two paths:
      //   1. bodyBytes (number array) — server pre-decoded base64, sent as raw bytes.
      //      Just wrap in Uint8Array, no browser-side base64 decode needed.
      //   2. bodyType="base64" + body (string) — legacy path, decode in browser.
      const hasBB = Array.isArray(bodyBytes);
      if (hasBB && bodyBytes.length > 0) {
        fetchInit.body = new Uint8Array(bodyBytes);
      } else if (bodyType === "base64" && body) {
        const binary = atob(body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        fetchInit.body = bytes;
        // Content-Type is already set correctly in the forwarded headers; don't override.
      } else if (body) {
        fetchInit.body = body;
      }

      const response = await origFetch(url, fetchInit);

      // Only read as text for text-based content types; skip binary data to avoid corruption
      const ct = response.headers.get("content-type") || "";
      const isText =
        ct.includes("text/") ||
        ct.includes("json") ||
        ct.includes("xml") ||
        ct.includes("javascript");
      const responseBody = isText ? await response.text() : null;

      // Relay all response headers that may be useful (e.g. content-type)
      const relayedHeaders = {};
      for (const [k, v] of response.headers.entries()) {
        relayedHeaders[k] = v;
      }

      window.postMessage(
        {
          type: "GCHAT_BRIDGE_API_RESPONSE",
          requestId,
          ok: response.ok,
          status: response.status,
          headers: relayedHeaders,
          body: responseBody,
        },
        window.location.origin,
      );
    } catch (err) {
      window.postMessage(
        {
          type: "GCHAT_BRIDGE_API_RESPONSE",
          requestId,
          ok: false,
          status: 0,
          headers: {},
          body: null,
          error: err.message,
        },
        window.location.origin,
      );
    }
  });
})();
