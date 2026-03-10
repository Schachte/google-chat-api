/**
 * Injected into the PAGE context (world: "MAIN") at document_start.
 *
 * Captures the XSRF token from outgoing Google Chat requests by
 * monkey-patching XMLHttpRequest and fetch before any Chat JS executes.
 *
 * Also provides a page-context fetch proxy so the content script can
 * make API calls using the browser's full cookie jar automatically.
 */
(function () {
  // Guard against double-injection (e.g., when background re-injects scripts)
  if (window.__gchatBridgeInterceptorLoaded) {
    return;
  }
  window.__gchatBridgeInterceptorLoaded = true;

  let xsrfCaptured = false;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function bodyToArray(body) {
    try {
      if (body instanceof Uint8Array) return Array.from(body);
      if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
      if (ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    } catch (_) {}
    return null;
  }

  // ─── XHR intercept ───────────────────────────────────────────────────────

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._gchatUrl = typeof url === "string" ? url : url?.toString() || "";
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (
      !xsrfCaptured &&
      name.toLowerCase() === "x-framework-xsrf-token" &&
      value
    ) {
      xsrfCaptured = true;
      window.postMessage({ type: "GCHAT_BRIDGE_XSRF_TOKEN", token: value }, "*");
    }
    return origSetHeader.call(this, name, value);
  };

  // ─── Fetch intercept ─────────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    // Capture XSRF token from outgoing headers
    try {
      const headers = init?.headers;
      if (headers && !xsrfCaptured) {
        let token = null;
        if (headers instanceof Headers) {
          token = headers.get("x-framework-xsrf-token");
        } else if (typeof headers === "object") {
          for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === "x-framework-xsrf-token") {
              token = v;
              break;
            }
          }
        }
        if (token) {
          xsrfCaptured = true;
          window.postMessage({ type: "GCHAT_BRIDGE_XSRF_TOKEN", token }, "*");
        }
      }
    } catch (_) {}

    return origFetch.apply(this, arguments);
  };

  // ─── Page-context API proxy ──────────────────────────────────────────────
  // The Node.js bridge server sends API requests through the extension;
  // the content script relays them here where the browser attaches cookies.

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "GCHAT_BRIDGE_API_REQUEST") return;

    const { requestId, url, method, headers, body, bodyType } = event.data;

    try {
      const fetchInit = {
        method: method || "POST",
        credentials: "include",
        headers: headers || {},
      };

      // Reconstruct binary body if needed.
      // The bridge encodes Uint8Array bodies as base64 strings (bodyType="base64").
      if (bodyType === "base64" && body) {
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
      const text = await response.text();

      window.postMessage(
        {
          type: "GCHAT_BRIDGE_API_RESPONSE",
          requestId,
          ok: response.ok,
          status: response.status,
          body: text,
        },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          type: "GCHAT_BRIDGE_API_RESPONSE",
          requestId,
          ok: false,
          status: 0,
          error: err.message,
        },
        "*",
      );
    }
  });
})();
