/**
 * Background service worker for Google Chat Notification Wizard.
 *
 * Minimal — no WebSocket server, no bridge. Just:
 *   1. Store/serve the XSRF token
 *   2. Find the Google Chat tab for API proxying
 *   3. Relay API requests from the popup to the content script
 */

let xsrfToken = null;

// ── Find a Google Chat tab ──────────────────────────────────────────────────

async function findChatTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://chat.google.com/*', 'https://mail.google.com/chat/*'],
  });
  return tabs[0] || null;
}

// ── Re-inject content scripts if disconnected ───────────────────────────────

async function reinjectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['scripts/page.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['scripts/content.js'],
    });
    await new Promise(r => setTimeout(r, 300));
  } catch (err) {
    throw new Error(`Failed to re-inject content scripts: ${err.message}`);
  }
}

// ── Proxy an API request through the Chat tab ───────────────────────────────

async function proxyApiRequest(url, method, headers, body) {
  const tab = await findChatTab();
  if (!tab) {
    throw new Error('No Google Chat tab found. Open chat.google.com first.');
  }

  const message = { type: 'API_REQUEST', url, method, headers, body };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, message);
      if (!result) {
        throw new Error('No response from content script');
      }
      return result;
    } catch (err) {
      const isDisconnected =
        err.message?.includes('Receiving end does not exist') ||
        err.message?.includes('Could not establish connection') ||
        err.message?.includes('Extension context invalidated');

      if (isDisconnected && attempt === 0) {
        await reinjectContentScripts(tab.id);
        continue;
      }
      throw new Error(`API proxy failed: ${err.message}. Try reloading Google Chat.`);
    }
  }
}

// ── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // XSRF token from content script
  if (request.type === 'XSRF_TOKEN') {
    xsrfToken = request.token;
    sendResponse({ ok: true });
    return false;
  }

  // Popup asking for current state
  if (request.type === 'GET_STATE') {
    findChatTab().then(tab => {
      sendResponse({
        hasTab: !!tab,
        hasXsrf: !!xsrfToken,
        xsrfToken,
      });
    });
    return true;
  }

  // Popup requesting an API call
  if (request.type === 'PROXY_API') {
    proxyApiRequest(request.url, request.method, request.headers, request.body)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, status: 0, error: err.message }));
    return true;
  }

  // Force XSRF refresh from page
  if (request.type === 'REFRESH_XSRF') {
    findChatTab().then(async tab => {
      if (!tab) {
        sendResponse({ token: null });
        return;
      }
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_XSRF' });
        if (result?.token) {
          xsrfToken = result.token;
        }
        sendResponse({ token: xsrfToken });
      } catch (err) {
        sendResponse({ token: xsrfToken });
      }
    });
    return true;
  }
});

console.log('[GChat Wizard] Background service worker initialized');
