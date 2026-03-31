/**
 * Page-context script (world: "MAIN") — injected at document_start.
 *
 * Responsibilities:
 *   1. Capture the XSRF token from outgoing Google Chat requests
 *   2. Provide a fetch proxy so the content script (and ultimately the popup)
 *      can make API calls using the browser's first-party cookie jar.
 *
 * No WebSocket, no server — all communication is via window.postMessage.
 */
(function () {
  if (window.__gchatWizardPageLoaded) return;
  window.__gchatWizardPageLoaded = true;

  let capturedXsrf = null;

  // ── XHR intercept ───────────────────────────────────────────────────────

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._gchatUrl = typeof url === 'string' ? url : url?.toString() || '';
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === 'x-framework-xsrf-token' && value) {
      if (capturedXsrf !== value) {
        capturedXsrf = value;
        window.postMessage({ type: 'GCHAT_WIZARD_XSRF', token: value }, '*');
      }
    }
    return origSetHeader.call(this, name, value);
  };

  // ── Fetch intercept ─────────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = init?.headers;
      if (headers) {
        let token = null;
        if (headers instanceof Headers) {
          token = headers.get('x-framework-xsrf-token');
        } else if (typeof headers === 'object') {
          for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === 'x-framework-xsrf-token') {
              token = v;
              break;
            }
          }
        }
        if (token && capturedXsrf !== token) {
          capturedXsrf = token;
          window.postMessage({ type: 'GCHAT_WIZARD_XSRF', token }, '*');
        }
      }
    } catch (_) {}

    return origFetch.apply(this, arguments);
  };

  // ── API fetch proxy ─────────────────────────────────────────────────────
  // Receives requests from content.js (relayed from popup), executes them
  // in the page context where the browser attaches first-party cookies.

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'GCHAT_WIZARD_API_REQUEST') return;

    const { requestId, url, method, headers, body } = event.data;

    try {
      const fetchInit = {
        method: method || 'POST',
        credentials: 'include',
        headers: headers || {},
      };

      if (body) {
        fetchInit.body = body;
      }

      const response = await origFetch(url, fetchInit);
      const text = await response.text();

      window.postMessage({
        type: 'GCHAT_WIZARD_API_RESPONSE',
        requestId,
        ok: response.ok,
        status: response.status,
        body: text,
      }, '*');
    } catch (err) {
      window.postMessage({
        type: 'GCHAT_WIZARD_API_RESPONSE',
        requestId,
        ok: false,
        status: 0,
        error: err.message,
      }, '*');
    }
  });

  // ── Provide current XSRF on demand ─────────────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'GCHAT_WIZARD_GET_XSRF') return;

    window.postMessage({
      type: 'GCHAT_WIZARD_XSRF',
      token: capturedXsrf,
    }, '*');
  });
})();
