'use strict';

const wsBadge        = document.getElementById('ws-badge');
const xsrfBadge      = document.getElementById('xsrf-badge');
const serverInput    = document.getElementById('server-input');
const btnSaveServer  = document.getElementById('btn-save-server');
const serverStatus   = document.getElementById('server-status');
const btnReconnect   = document.getElementById('btn-reconnect');

// Track whether the user is actively editing the server field
let userEditing = false;

// ─── State rendering ─────────────────────────────────────────────────────────

function applyBadge(el, connected, label) {
  el.textContent = label;
  el.className = 'badge ' + (connected ? 'connected' : connected === null ? 'waiting' : 'disconnected');
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (chrome.runtime.lastError || !state) return;

    applyBadge(wsBadge, state.connected,
      state.connected ? 'Connected' : 'Disconnected');

    applyBadge(xsrfBadge, state.hasXsrf || null,
      state.hasXsrf ? 'Captured' : 'Not captured');

    // Only update the input if the user isn't actively editing it
    if (!userEditing) {
      serverInput.value = state.address || `${state.host || 'localhost'}:${state.port || 7891}`;
    }
  });
}

// ─── Server address editing ──────────────────────────────────────────────────

serverInput.addEventListener('focus', () => { userEditing = true; });
serverInput.addEventListener('blur', () => {
  // Small delay so the Save button click registers before we reset
  setTimeout(() => { userEditing = false; }, 200);
});

// Save on Enter key
serverInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveServer();
  }
});

btnSaveServer.addEventListener('click', saveServer);

function saveServer() {
  const address = serverInput.value.trim();
  if (!address) {
    serverStatus.textContent = 'Enter a server address';
    serverStatus.className = 'error';
    return;
  }

  btnSaveServer.disabled = true;
  serverStatus.textContent = 'Saving\u2026';
  serverStatus.className = '';

  chrome.runtime.sendMessage({ type: 'SET_SERVER', address }, (response) => {
    btnSaveServer.disabled = false;
    userEditing = false;

    if (chrome.runtime.lastError || !response) {
      serverStatus.textContent = 'Error: ' + (chrome.runtime.lastError?.message ?? 'no response');
      serverStatus.className = 'error';
      return;
    }

    if (response.ok) {
      serverInput.value = response.address;
      serverStatus.textContent = 'Connecting to ' + response.address + '\u2026';
      serverStatus.className = 'ok';
      setTimeout(refresh, 800);
    } else {
      serverStatus.textContent = 'Error: ' + (response.error ?? 'unknown');
      serverStatus.className = 'error';
    }

    setTimeout(() => { serverStatus.textContent = ''; serverStatus.className = ''; }, 3000);
  });
}

// ─── Reconnect ───────────────────────────────────────────────────────────────

btnReconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RECONNECT_WS' }, () => {
    setTimeout(refresh, 500);
  });
});

// ─── Init ────────────────────────────────────────────────────────────────────

// On popup open, check state and auto-reconnect if disconnected.
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (chrome.runtime.lastError || !state) return;
  if (!state.connected) {
    chrome.runtime.sendMessage({ type: 'RECONNECT_WS' });
  }
});

refresh();
const interval = setInterval(refresh, 2000);
window.addEventListener('unload', () => clearInterval(interval));
