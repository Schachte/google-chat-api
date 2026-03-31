/**
 * Content script for Google Chat API Bridge (isolated world).
 *
 * Bridges between:
 *   - Page context (interceptor.js) — XSRF token capture, credentialed fetch proxy
 *   - Background service worker     — WebSocket relay to Node.js bridge server
 *
 * Message flow for an API request:
 *   background.js  --[chrome.tabs.sendMessage]--> content.js
 *   content.js     --[window.postMessage]-------> interceptor.js
 *   interceptor.js --[fetch credentials:include]-> Google Chat API
 *   interceptor.js --[window.postMessage]-------> content.js
 *   content.js     --[sendResponse]-------------> background.js
 *
 * Message flow for XSRF token capture:
 *   interceptor.js --[window.postMessage GCHAT_BRIDGE_XSRF_TOKEN]--> content.js
 *   content.js     --[chrome.runtime.sendMessage]-------------------> background.js
 *   background.js  --[WebSocket xsrf:update]-----------------------> Node.js server
 */

let contextInvalidated = false;

function checkContext() {
  if (contextInvalidated) return false;
  try {
    void chrome.runtime.id;
    return true;
  } catch (_) {
    contextInvalidated = true;
    console.warn("[GChatBridge] Extension context invalidated — reload the page");
    return false;
  }
}

// ─── XSRF Token Relay ────────────────────────────────────────────────────────
// Listen for XSRF tokens captured by interceptor.js in the page context and
// forward them to background.js, which sends them to the Node.js server over WS.

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "GCHAT_BRIDGE_XSRF_TOKEN" && event.data.token) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: "XSRF_TOKEN",
      token: event.data.token,
    }).catch(() => {
      // Extension context may have been invalidated — silently ignore
    });
  }
});

// ─── API Request Proxy ───────────────────────────────────────────────────────
// The background service worker receives API requests from the Node.js bridge
// and forwards them here; we relay into the page context (interceptor.js)
// so the browser attaches first-party cookies automatically.

const RESPONSE_TIMEOUT_MS = 35_000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!checkContext()) return;

  if (request.type === "API_REQUEST") {
    const requestId =
      "api_" + (crypto.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2)));

    const responseHandler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== "GCHAT_BRIDGE_API_RESPONSE") return;
      if (event.data.requestId !== requestId) return;

      clearTimeout(cleanupTimer);
      window.removeEventListener("message", responseHandler);

      sendResponse({
        ok: event.data.ok,
        status: event.data.status,
        headers: event.data.headers,
        body: event.data.body,
        error: event.data.error,
      });
    };

    window.addEventListener("message", responseHandler);

    // Cleanup timeout: remove the listener and reject if no response arrives
    const cleanupTimer = setTimeout(() => {
      window.removeEventListener("message", responseHandler);
      sendResponse({
        ok: false,
        status: 0,
        headers: {},
        body: null,
        error: `No response from page context within ${RESPONSE_TIMEOUT_MS / 1000}s`,
      });
    }, RESPONSE_TIMEOUT_MS);

    // Forward request to page context so browser attaches cookies.
    // Pass both bodyBytes (preferred, number array) and body/bodyType (legacy base64).
    window.postMessage(
      {
        type: "GCHAT_BRIDGE_API_REQUEST",
        requestId,
        url: request.url,
        method: request.method || "POST",
        headers: request.headers || {},
        body: request.body || null,
        bodyType: request.bodyType || null,
        bodyBytes: request.bodyBytes || null,
      },
      window.location.origin,
    );

    // Keep channel open for async response
    return true;
  }

  if (request.type === "PING") {
    sendResponse({ ok: true, url: window.location.href });
    return false;
  }
});
