/**
 * Background service worker for Google Chat API Bridge.
 *
 * Responsibilities:
 *   1. Maintain a WebSocket connection to the local Node.js bridge server
 *   2. Store the XSRF token relayed from content.js (persisted to chrome.storage)
 *   3. Proxy API requests from the bridge server through the page context
 *      (so the browser attaches first-party cookies automatically)
 *
 * Protocol (bridge server ↔ extension):
 *   Server → Extension: { type: "hello" }
 *   Server → Extension: { type: "ping" }          (keepalive — prevents MV3 worker suspension)
 *   Extension → Server: { type: "hello:ack", hasXsrf: bool }
 *   Extension → Server: { type: "pong" }           (keepalive response)
 *
 *   Server → Extension: { type: "api:request", id, url, method, headers, body, bodyType, bodyBytes }
 *   Extension → Server: { type: "api:response", id, ok, status, headers, body, error? }
 *
 *   Extension → Server: { type: "xsrf:update", token: string }   (whenever token changes)
 *   Extension → Server: { type: "status", connected: true, hasXsrf: bool }
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_WS_HOST = "localhost";
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
let wsHost = DEFAULT_WS_HOST;
let wsPort = DEFAULT_WS_PORT;

// Pending command responses: id → { resolve, reject, timer }
const pendingCmds = new Map();

// ─── Host:Port Helpers ───────────────────────────────────────────────────────

/**
 * Parse a "host:port" string (or just "port", or just "host").
 * Returns { host, port } with current values as fallbacks.
 *
 * Examples:
 *   "8000"              → { host: <current>, port: 8000 }
 *   "192.168.1.5:8000"  → { host: "192.168.1.5", port: 8000 }
 *   "my-server:7891"    → { host: "my-server",   port: 7891 }
 *   "my-server"         → { host: "my-server",   port: <current> }
 *   ""                  → { host: <default>,      port: <default> }
 */
function parseServerAddress(input) {
  if (!input || typeof input !== "string") {
    return { host: wsHost, port: wsPort };
  }
  const trimmed = input.trim();
  if (!trimmed) return { host: DEFAULT_WS_HOST, port: DEFAULT_WS_PORT };

  // Pure number → port only
  if (/^\d+$/.test(trimmed)) {
    return { host: wsHost, port: parseInt(trimmed, 10) };
  }

  // host:port
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0) {
    const hostPart = trimmed.slice(0, lastColon);
    const portPart = trimmed.slice(lastColon + 1);
    const portNum = parseInt(portPart, 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
      return { host: hostPart, port: portNum };
    }
  }

  // Just a hostname
  return { host: trimmed, port: wsPort };
}

function getServerAddress() {
  return `${wsHost}:${wsPort}`;
}

// ─── WebSocket Client ────────────────────────────────────────────────────────

function getWsUrl() {
  return `ws://${wsHost}:${wsPort}/ws`;
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = getWsUrl();
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error("[GChatBridge] WebSocket creation failed:", err.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log(`[GChatBridge] Connected to bridge server at ${getServerAddress()}`);
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

    case "ping":
      // Application-level keepalive.  Responding executes JS in the
      // service worker, which resets Chrome's ~30 s idle suspension timer.
      wsSend({ type: "pong" });
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
      // Legacy: allow the server to tell the extension which port it's on
      if (typeof msg.port === "number") {
        wsPort = msg.port;
        chrome.storage.local.set({ bridgePort: wsPort });
      }
      break;

    case "server:set":
      // Allow the server to tell the extension the full host:port
      if (typeof msg.address === "string") {
        const parsed = parseServerAddress(msg.address);
        wsHost = parsed.host;
        wsPort = parsed.port;
        chrome.storage.local.set({ bridgeHost: wsHost, bridgePort: wsPort });
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
  if (tabs[0]) return tabs[0];

  // Also check full mail.google.com (Gmail's embedded Chat panel)
  const gmailTabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  return gmailTabs[0] || null;
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

async function proxyApiRequest(url, method, headers, body, bodyType, bodyBytes) {
  const tab = await findChatTab();
  if (!tab) {
    throw new Error("No Google Chat tab found. Please open chat.google.com first.");
  }

  const message = {
    type: "API_REQUEST",
    url,
    method,
    headers,
    body,
    bodyType,
    bodyBytes: bodyBytes || null,
  };

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
        console.warn("[GChatBridge] Content script unreachable, re-injecting…");
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
  const { id, url, method, headers, body, bodyType, bodyBytes } = msg;

  try {
    const result = await proxyApiRequest(url, method, headers, body, bodyType, bodyBytes);
    wsSend({
      type: "api:response",
      id,
      ok: result.ok,
      status: result.status,
      headers: result.headers || {},
      body: result.body,
    });
  } catch (err) {
    wsSend({
      type: "api:response",
      id,
      ok: false,
      status: 0,
      headers: {},
      body: null,
      error: err.message,
    });
  }
}

// ─── Chrome Message Listener (from content.js and popup) ─────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "XSRF_TOKEN") {
    const isNew = xsrfToken !== request.token;
    xsrfToken = request.token;
    chrome.storage.local.set({ xsrfToken });
    if (isNew) {
      console.log("[GChatBridge] XSRF token captured from", sender.tab?.url || "unknown tab");
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
      host: wsHost,
      port: wsPort,
      address: getServerAddress(),
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
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectWebSocket();
    sendResponse({ ok: true });
    return false;
  }

  // SET_SERVER — accepts "host:port", "port", or "host"
  if (request.type === "SET_SERVER") {
    const parsed = parseServerAddress(request.address);
    wsHost = parsed.host;
    wsPort = parsed.port;
    chrome.storage.local.set({ bridgeHost: wsHost, bridgePort: wsPort });
    // Reconnect on new address
    if (ws) {
      ws.close();
    }
    reconnectAttempts = 0;
    connectWebSocket();
    sendResponse({ ok: true, host: wsHost, port: wsPort, address: getServerAddress() });
    return false;
  }

  // Legacy: SET_PORT (numeric port only)
  if (request.type === "SET_PORT") {
    wsPort = request.port || DEFAULT_WS_PORT;
    chrome.storage.local.set({ bridgePort: wsPort });
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

// ─── Keepalive alarm (prevents MV3 service worker from sleeping) ─────────────
// Belt-and-suspenders alongside the server's application-level pings.

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (ws === null || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  } else {
    wsSend({ type: "ping" });
  }
});

// ─── Initialization ──────────────────────────────────────────────────────────

// Load persisted host, port, and XSRF token
chrome.storage.local.get(["bridgeHost", "bridgePort", "xsrfToken"]).then((data) => {
  if (data.bridgeHost && typeof data.bridgeHost === "string") {
    wsHost = data.bridgeHost;
  }
  if (data.bridgePort && typeof data.bridgePort === "number") {
    wsPort = data.bridgePort;
  }
  if (typeof data.xsrfToken === "string") {
    xsrfToken = data.xsrfToken;
  }
  connectWebSocket();
}).catch(() => {
  connectWebSocket();
});

console.log("[GChatBridge] Background service worker initialized");
