'use strict';

const wsBadge      = document.getElementById('ws-badge');
const xsrfBadge    = document.getElementById('xsrf-badge');
const portValue    = document.getElementById('port-value');
const btnReconnect = document.getElementById('btn-reconnect');
const btnMarkRead  = document.getElementById('btn-mark-read');
const markStatus   = document.getElementById('mark-status');

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

    portValue.textContent = String(state.port || 7891);
  });
}

btnMarkRead.addEventListener('click', () => {
  btnMarkRead.disabled = true;
  markStatus.textContent = 'Marking…';
  markStatus.className = '';

  chrome.runtime.sendMessage({ type: 'MARK_ALL_READ' }, (response) => {
    btnMarkRead.disabled = false;
    if (chrome.runtime.lastError || !response) {
      markStatus.textContent = 'Error: ' + (chrome.runtime.lastError?.message ?? 'no response');
      markStatus.className = 'error';
      return;
    }
    if (response.ok) {
      const { marked, total } = response.data ?? {};
      markStatus.textContent = total === 0
        ? 'Nothing to mark as read.'
        : `Marked ${marked} of ${total} space${total !== 1 ? 's' : ''} as read.`;
      markStatus.className = 'ok';
    } else {
      markStatus.textContent = 'Error: ' + (response.error ?? 'unknown');
      markStatus.className = 'error';
    }
    // Clear message after 4 s
    setTimeout(() => { markStatus.textContent = ''; markStatus.className = ''; }, 4000);
  });
});

btnReconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RECONNECT_WS' }, () => {
    setTimeout(refresh, 500);
  });
});

// Initial load + poll every 2 s while popup is open
refresh();
const interval = setInterval(refresh, 2000);
window.addEventListener('unload', () => clearInterval(interval));
