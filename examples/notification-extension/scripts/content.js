/**
 * Content script (isolated world) — bridges popup/background and page context.
 *
 * Message flow:
 *   popup  ──chrome.runtime.sendMessage──>  background  ──chrome.tabs.sendMessage──>  content.js
 *     content.js  ──window.postMessage──>  page.js  ──fetch()──>  Google Chat API
 *     page.js     ──window.postMessage──>  content.js  ──sendResponse──>  background  ──>  popup
 *
 * Also relays captured XSRF tokens from page.js to the background service worker.
 */

let contextInvalidated = false;

function checkContext() {
  if (contextInvalidated) return false;
  try {
    void chrome.runtime.id;
    return true;
  } catch (_) {
    contextInvalidated = true;
    return false;
  }
}

// ── XSRF token relay (page.js -> background.js) ─────────────────────────────

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.type === 'GCHAT_WIZARD_XSRF' && event.data.token) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: 'XSRF_TOKEN',
      token: event.data.token,
    }).catch(() => {});
  }
});

// ── API request relay (background.js -> page.js -> background.js) ────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!checkContext()) return;

  if (request.type === 'API_REQUEST') {
    const requestId = 'api_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    let responded = false;

    const respond = (data) => {
      if (responded) return;
      responded = true;
      window.removeEventListener('message', handler);
      sendResponse(data);
    };

    // One-time listener for response from page context
    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'GCHAT_WIZARD_API_RESPONSE') return;
      if (event.data.requestId !== requestId) return;

      respond({
        ok: event.data.ok,
        status: event.data.status,
        body: event.data.body,
        error: event.data.error,
      });
    };

    window.addEventListener('message', handler);

    // Timeout after 30s
    setTimeout(() => {
      respond({ ok: false, status: 0, error: 'Request timed out' });
    }, 30000);

    // Forward to page context
    window.postMessage({
      type: 'GCHAT_WIZARD_API_REQUEST',
      requestId,
      url: request.url,
      method: request.method || 'POST',
      headers: request.headers || {},
      body: request.body,
    }, '*');

    return true; // keep message channel open for async response
  }

  if (request.type === 'GET_XSRF') {
    let responded = false;

    const respond = (data) => {
      if (responded) return;
      responded = true;
      window.removeEventListener('message', handler);
      sendResponse(data);
    };

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'GCHAT_WIZARD_XSRF') return;
      respond({ token: event.data.token });
    };

    window.addEventListener('message', handler);
    setTimeout(() => {
      respond({ token: null });
    }, 2000);

    window.postMessage({ type: 'GCHAT_WIZARD_GET_XSRF' }, '*');
    return true;
  }
});
