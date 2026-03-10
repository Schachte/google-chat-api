/**
 * Background service worker for Google Chat API Bridge.
 *
 * Responsibilities:
 *   1. Maintain a WebSocket connection to the local Node.js bridge server
 *   2. Store the XSRF token relayed from content.js
 *   3. Proxy API requests from the bridge server through the page context
 *      (so the browser attaches first-party cookies automatically)
 *
 * Protocol (bridge server ↔ extension):
 *   Server → Extension: { type: "hello" }
 *   Extension → Server: { type: "hello:ack", hasXsrf: bool }
 *
 *   Server → Extension: { type: "api:request", id: string, url, method, headers, body, bodyType }
 *   Extension → Server: { type: "api:response", id: string, ok, status, body, error? }
 *
 *   Extension → Server: { type: "xsrf:update", token: string }   (whenever token changes)
 *   Extension → Server: { type: "status", connected: true, hasXsrf: bool }
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_WS_PORT = 7891;
const RECONNECT_DELAY_MS = 3000;
// No hard cap — keep retrying so the extension reconnects whenever the
// Node.js server starts, even if it was started long after the browser.
const MAX_RECONNECT_DELAY_MS = 15000;

// ─── State ───────────────────────────────────────────────────────────────────

let ws = null;
let xsrfToken = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let wsPort = DEFAULT_WS_PORT;

// Pending command responses: id → { resolve, reject, timer }
const pendingCmds = new Map();

// ─── WebSocket Client ────────────────────────────────────────────────────────

function getWsUrl() {
  return `ws://localhost:${wsPort}/ws`;
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(getWsUrl());
  } catch (err) {
    console.error("[GChatBridge] WebSocket creation failed:", err.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log(`[GChatBridge] Connected to bridge server on port ${wsPort}`);
    reconnectAttempts = 0;

    // Announce ourselves and report current state
    wsSend({
      type: "hello:ack",
      clientName: "gchat-bridge-extension",
      hasXsrf: !!xsrfToken,
    });

    // If we already have a token, send it immediately
    if (xsrfToken) {
      wsSend({ type: "xsrf:update", token: xsrfToken });
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error("[GChatBridge] Failed to parse server message:", err.message);
    }
  };

  ws.onclose = () => {
    console.log("[GChatBridge] WebSocket closed");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this; nothing to do here
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  // Cap backoff at MAX_RECONNECT_DELAY_MS — retry forever, just slow down.
  const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
  console.log(`[GChatBridge] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

// ─── Server Message Handler ──────────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case "hello":
      // Bridge server announcing itself; respond with current state
      wsSend({
        type: "hello:ack",
        clientName: "gchat-bridge-extension",
        hasXsrf: !!xsrfToken,
      });
      if (xsrfToken) {
        wsSend({ type: "xsrf:update", token: xsrfToken });
      }
      break;

    case "api:request":
      handleApiRequest(msg);
      break;

    case "cmd:response": {
      const pending = pendingCmds.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCmds.delete(msg.id);
        if (msg.success) {
          pending.resolve(msg.data);
        } else {
          pending.reject(new Error(msg.error || "Command failed"));
        }
      }
      break;
    }

    case "port:set":
      // Allow the server to tell the extension which port it's on (future use)
      if (typeof msg.port === "number") {
        wsPort = msg.port;
      }
      break;

    default:
      console.log("[GChatBridge] Unknown server message:", msg.type);
  }
}

// ─── API Proxy ───────────────────────────────────────────────────────────────

async function findChatTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://chat.google.com/*", "https://mail.google.com/chat/*"],
  });
  return tabs[0] || null;
}

async function reinjectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["scripts/interceptor.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["scripts/content.js"],
    });
    await sleep(300);
  } catch (err) {
    throw new Error(`Failed to re-inject content scripts: ${err.message}`);
  }
}

async function proxyApiRequest(url, method, headers, body, bodyType) {
  const tab = await findChatTab();
  if (!tab) {
    throw new Error("No Google Chat tab found. Please open chat.google.com first.");
  }

  const message = { type: "API_REQUEST", url, method, headers, body, bodyType };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, message);
      if (!result) {
        throw new Error("No response from content script — is the page loaded?");
      }
      return result;
    } catch (err) {
      const isDisconnected =
        err.message?.includes("Receiving end does not exist") ||
        err.message?.includes("Could not establish connection") ||
        err.message?.includes("Extension context invalidated");

      if (isDisconnected && attempt === 0) {
        await reinjectContentScripts(tab.id);
        continue;
      }

      throw new Error(
        `API proxy failed (attempt ${attempt + 1}): ${err.message}. ` +
        "Try reloading the Google Chat tab."
      );
    }
  }
}

async function handleApiRequest(msg) {
  const { id, url, method, headers, body, bodyType } = msg;

  try {
    const result = await proxyApiRequest(url, method, headers, body, bodyType);
    wsSend({
      type: "api:response",
      id,
      ok: result.ok,
      status: result.status,
      body: result.body,
    });
  } catch (err) {
    wsSend({
      type: "api:response",
      id,
      ok: false,
      status: 0,
      error: err.message,
    });
  }
}

// ─── Chrome Message Listener (from content.js and popup) ─────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "XSRF_TOKEN") {
    const isNew = xsrfToken !== request.token;
    xsrfToken = request.token;
    if (isNew) {
      console.log("[GChatBridge] XSRF token captured");
      wsSend({ type: "xsrf:update", token: xsrfToken });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (request.type === "GET_STATE") {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      hasXsrf: !!xsrfToken,
      reconnectAttempts,
      port: wsPort,
    });
    return false;
  }

  if (request.type === "MARK_ALL_READ") {
    sendCmd("mark_all_read")
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open for async response
  }

  if (request.type === "RECONNECT_WS") {
    reconnectAttempts = 0;
    connectWebSocket();
    sendResponse({ ok: true });
    return false;
  }

  if (request.type === "SET_PORT") {
    wsPort = request.port || DEFAULT_WS_PORT;
    // Reconnect on new port
    if (ws) {
      ws.close();
    }
    reconnectAttempts = 0;
    connectWebSocket();
    sendResponse({ ok: true });
    return false;
  }
});

// ─── Command helpers ─────────────────────────────────────────────────────────

/**
 * Send a named command to the Node.js bridge server and return a promise that
 * resolves with the server's response data, or rejects on error / timeout.
 */
function sendCmd(name, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("Not connected to bridge server"));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingCmds.delete(id);
      reject(new Error(`Command "${name}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pendingCmds.set(id, { resolve, reject, timer });
    wsSend({ type: "cmd", id, name, args });
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Initialization ──────────────────────────────────────────────────────────

// Load persisted port setting
chrome.storage.local.get(["bridgePort"]).then((data) => {
  if (data.bridgePort && typeof data.bridgePort === "number") {
    wsPort = data.bridgePort;
  }
  connectWebSocket();
}).catch(() => {
  connectWebSocket();
});

console.log("[GChatBridge] Background service worker initialized");
