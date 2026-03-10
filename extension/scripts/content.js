/**
 * Content script for Google Chat API Bridge (isolated world).
 *
 * Bridges between:
 *   - Page context (interceptor.js) — XSRF token capture, API proxy
 *   - Background service worker     — WebSocket relay to Node.js bridge server
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

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "GCHAT_BRIDGE_XSRF_TOKEN" && event.data.token) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: "XSRF_TOKEN",
      token: event.data.token,
    });
  }
});

// ─── API Request Proxy ───────────────────────────────────────────────────────
// The background service worker receives API requests from the Node.js bridge
// and forwards them here; we relay into the page context (interceptor.js)
// so the browser attaches first-party cookies automatically.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!checkContext()) return;

  if (request.type === "API_REQUEST") {
    const requestId =
      "api_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    // One-time listener for the response from page context
    const responseHandler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== "GCHAT_BRIDGE_API_RESPONSE") return;
      if (event.data.requestId !== requestId) return;

      window.removeEventListener("message", responseHandler);

      sendResponse({
        ok: event.data.ok,
        status: event.data.status,
        body: event.data.body,
        error: event.data.error,
      });
    };

    window.addEventListener("message", responseHandler);

    // Forward request to page context
    window.postMessage(
      {
        type: "GCHAT_BRIDGE_API_REQUEST",
        requestId,
        url: request.url,
        method: request.method || "POST",
        headers: request.headers || {},
        body: request.body,
        bodyType: request.bodyType,
      },
      "*",
    );

    // Keep channel open for async response
    return true;
  }
});
