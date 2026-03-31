/**
 * Popup UI logic for Google Chat Notification Wizard.
 *
 * Fetches notifications via background -> content -> page proxy chain,
 * renders the list, and handles mark-read/unread actions.
 * Supports DMs, Spaces, and Thread-unread notifications.
 */

import {
  buildPaginatedWorldPayload,
  buildMarkReadPayload,
  buildMarkTopicReadPayload,
  buildSetMarkAsUnreadTimestampPayload,
  buildGetMembersPayload,
  parseWorldItems,
  parseMemberNames,
  filterUnreadItems,
  collectUnresolvedDmUserIds,
  applyDmNames,
  stripXssi,
} from './gchat-api.js';

// ── State ───────────────────────────────────────────────────────────────────

const API_BASE = 'https://chat.google.com/u/0';
const API_KEY = 'AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k';

let allItems = [];       // items from last fetch, with displayType added
let selectedIds = new Set();
let activeFilter = 'all'; // 'all' | 'space' | 'dm' | 'thread'
let searchQuery = '';
let xsrfToken = null;
let requestCounter = 1;
let isConnected = false;

// ── DOM refs ────────────────────────────────────────────────────────────────

const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const btnRefresh = document.getElementById('btn-refresh');
const selectedCountEl = document.getElementById('selected-count');
const selectedCountText = document.getElementById('selected-count-text');
const searchInput = document.getElementById('search-input');
const listEl = document.getElementById('notification-list');
const toastEl = document.getElementById('toast');
const btnClearDms = document.getElementById('btn-clear-dms');
const btnClearSpaces = document.getElementById('btn-clear-spaces');
const btnClearSelected = document.getElementById('btn-clear-selected');
const selectAllBar = document.getElementById('select-all-bar');
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const selectAllLabel = document.getElementById('select-all-label');
const filterTabs = document.querySelectorAll('.filter-tab');

// ── SVG icon templates ──────────────────────────────────────────────────────

const ICON_DM = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
</svg>`;

const ICON_SPACE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
</svg>`;

const ICON_THREAD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  <line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="13" y2="13"/>
</svg>`;

// ── Proxy API call through background -> content -> page ────────────────────

function proxyFetch(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'PROXY_API', url, method, headers, body },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from background'));
          return;
        }
        resolve(response);
      }
    );
  });
}

// ── Get extension state ─────────────────────────────────────────────────────

function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
      if (chrome.runtime.lastError || !state) {
        resolve({ hasTab: false, hasXsrf: false, xsrfToken: null });
        return;
      }
      resolve(state);
    });
  });
}

// ── Refresh XSRF token ─────────────────────────────────────────────────────

function refreshXsrf() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'REFRESH_XSRF' }, (result) => {
      if (result?.token) {
        xsrfToken = result.token;
      }
      resolve(xsrfToken);
    });
  });
}

// ── Fetch notifications ─────────────────────────────────────────────────────

async function fetchNotifications() {
  const payload = buildPaginatedWorldPayload();
  const counter = requestCounter++;
  const url = `${API_BASE}/api/paginated_world?c=${counter}`;

  const headers = {
    'Content-Type': 'application/json',
  };
  if (xsrfToken) {
    headers['x-framework-xsrf-token'] = xsrfToken;
  }

  const result = await proxyFetch(url, 'POST', headers, JSON.stringify(payload));

  if (!result.ok) {
    throw new Error(`API error: ${result.status} ${result.error || ''}`);
  }

  const json = JSON.parse(stripXssi(result.body));
  return parseWorldItems(json);
}

// ── Resolve DM names via get_members API ────────────────────────────────────

async function enrichDmNames(items) {
  const { userIds, selfId } = collectUnresolvedDmUserIds(items);
  if (userIds.length === 0) return;

  const BATCH_SIZE = 50;
  const allNames = {};

  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    try {
      const payload = buildGetMembersPayload(batch);
      const counter = requestCounter++;
      const url = `${API_BASE}/api/get_members?alt=protojson&key=${API_KEY}`;

      const headers = {
        'Content-Type': 'application/json',
      };
      if (xsrfToken) {
        headers['x-framework-xsrf-token'] = xsrfToken;
      }

      const result = await proxyFetch(url, 'POST', headers, JSON.stringify(payload));
      if (result.ok && result.body) {
        const data = JSON.parse(stripXssi(result.body));
        const names = parseMemberNames(data);
        Object.assign(allNames, names);
      }
    } catch (err) {
      console.warn('DM name enrichment batch failed:', err);
    }
  }

  if (Object.keys(allNames).length > 0) {
    applyDmNames(items, allNames, selfId);
  }
}

// ── Mark as read ────────────────────────────────────────────────────────────

async function markAsRead(groupId, isDm) {
  if (!xsrfToken) {
    throw new Error('No XSRF token available');
  }

  const payload = buildMarkReadPayload(groupId, isDm);
  const counter = requestCounter++;
  const url = `${API_BASE}/api/mark_group_readstate?c=${counter}`;

  const headers = {
    'Content-Type': 'application/json',
    'x-framework-xsrf-token': xsrfToken,
    'x-goog-chat-space-id': groupId,
  };

  const result = await proxyFetch(url, 'POST', headers, JSON.stringify(payload));
  if (!result.ok) {
    throw new Error(`mark_group_readstate failed: HTTP ${result.status} - ${result.error || result.body?.slice(0, 200) || ''}`);
  }
  // Check for errors in response body
  if (result.body && (result.body.includes('"error"') || result.body.includes('"Error"'))) {
    throw new Error(`mark_group_readstate response error: ${result.body.slice(0, 200)}`);
  }

  const clearPayload = buildSetMarkAsUnreadTimestampPayload(groupId, isDm, 0);
  const clearUrl = `${API_BASE}/api/set_mark_as_unread_timestamp?c=${requestCounter++}`;
  const clearResult = await proxyFetch(clearUrl, 'POST', headers, JSON.stringify(clearPayload));
  if (!clearResult.ok) {
    throw new Error(`set_mark_as_unread_timestamp failed: HTTP ${clearResult.status} - ${clearResult.error || clearResult.body?.slice(0, 200) || ''}`);
  }
  if (clearResult.body && (clearResult.body.includes('"error"') || clearResult.body.includes('"Error"'))) {
    throw new Error(`set_mark_as_unread_timestamp response error: ${clearResult.body.slice(0, 200)}`);
  }
}

async function markThreadAsRead(spaceId, topicId, timestampMicros) {
  if (!xsrfToken) {
    throw new Error('No XSRF token available');
  }

  // Use provided timestamp, or default to "now" (same approach mark_group_readstate uses).
  // Avoids the extra list_messages round-trip that can fail through the proxy.
  const resolvedTimestamp = timestampMicros ?? Date.now() * 1000;
  const counter = requestCounter++;
  const url = `${API_BASE}/api/mark_topic_readstate?c=${counter}`;

  const headers = {
    'Content-Type': 'application/json',
    'x-framework-xsrf-token': xsrfToken,
    'x-goog-chat-space-id': spaceId,
  };

  const attempts = [
    buildMarkTopicReadPayload(spaceId, topicId, resolvedTimestamp),
    (() => {
      const payload = buildMarkTopicReadPayload(spaceId, topicId, resolvedTimestamp);
      payload[98] = ["0", 7, 1, "en", payload[98][4]];
      return payload;
    })(),
  ];

  let lastError = 'Unknown error';
  for (const payload of attempts) {
    const result = await proxyFetch(url, 'POST', headers, JSON.stringify(payload));
    if (!result.ok) {
      lastError = `mark_topic_readstate failed: HTTP ${result.status} - ${result.error || result.body?.slice(0, 200) || ''}`;
      continue;
    }
    if (result.body && result.body.includes('"dfe.rs.mtrs"') && result.body.includes(',null,-1,')) {
      lastError = 'mark_topic_readstate returned status -1';
      continue;
    }
    if (result.body && (result.body.includes('"error"') || result.body.includes('"Error"'))) {
      lastError = `mark_topic_readstate response error: ${result.body.slice(0, 200)}`;
      continue;
    }
    return;
  }

  throw new Error(lastError);
}

// ── Fuzzy match ─────────────────────────────────────────────────────────────

function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = (text || '').toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ── Get visible (filtered) items ────────────────────────────────────────────

function getVisibleItems() {
  let items = allItems;
  if (activeFilter !== 'all') {
    items = items.filter(i => i.displayType === activeFilter);
  }
  if (searchQuery) {
    items = items.filter(i => fuzzyMatch(searchQuery, i.name || i.id));
  }
  return items;
}

// ── Render notification list ────────────────────────────────────────────────

function getIcon(displayType) {
  switch (displayType) {
    case 'dm': return ICON_DM;
    case 'thread': return ICON_THREAD;
    default: return ICON_SPACE;
  }
}

function getDisplayName(item) {
  switch (item.displayType) {
    case 'dm':
      return `[DM] ${item.name || item.id}`;
    case 'thread': {
      const spaceName = item.name || item.id;
      return `[Thread] ${spaceName}`;
    }
    default:
      return item.name || item.id;
  }
}

function getBadgeCount(item) {
  if (item.badgeCount > 0) return item.badgeCount;
  if (item.unreadCount > 0) return item.unreadCount;
  if (item.unreadReplyCount > 0) return item.unreadReplyCount;
  if (item.unreadSubscribedTopicCount > 0) return item.unreadSubscribedTopicCount;
  return 1;
}

function renderList() {
  const visible = getVisibleItems();

  if (visible.length === 0 && allItems.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#10024;</div>
        <div class="title">All caught up!</div>
        <div class="subtitle">No unread notifications</div>
      </div>`;
    return;
  }

  if (visible.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="title">No matches</div>
        <div class="subtitle">Try a different filter or search term</div>
      </div>`;
    return;
  }

  const html = visible.map(item => {
    const isSelected = selectedIds.has(item.id);
    const icon = getIcon(item.displayType);
    const displayName = getDisplayName(item);
    const badge = getBadgeCount(item);
    const typeClass = `type-${item.displayType}`;

    return `
      <div class="notif-item ${typeClass}${isSelected ? ' selected' : ''}" data-id="${item.id}">
        <div class="notif-checkbox"></div>
        <div class="notif-icon">${icon}</div>
        <div class="notif-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
        <div class="notif-badge">${badge}</div>
      </div>`;
  }).join('');

  listEl.innerHTML = html;

  // Attach click handlers
  listEl.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
      updateUI();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Update all UI state ─────────────────────────────────────────────────────

function updateUI() {
  renderList();
  updateSelectionCount();
  updateSelectAll();
  updateButtons();
}

function updateSelectionCount() {
  const count = selectedIds.size;
  if (count > 0) {
    selectedCountEl.style.display = 'flex';
    selectedCountText.textContent = `${count} selected`;
  } else {
    selectedCountEl.style.display = 'none';
  }
}

function updateSelectAll() {
  const visible = getVisibleItems();
  if (visible.length === 0) {
    selectAllBar.style.display = 'none';
    return;
  }
  selectAllBar.style.display = 'flex';

  const visibleIds = visible.map(i => i.id);
  const selectedVisible = visibleIds.filter(id => selectedIds.has(id)).length;

  selectAllCheckbox.classList.remove('checked', 'indeterminate');
  if (selectedVisible === visible.length) {
    selectAllCheckbox.classList.add('checked');
    selectAllLabel.textContent = `Deselect all (${visible.length})`;
  } else if (selectedVisible > 0) {
    selectAllCheckbox.classList.add('indeterminate');
    selectAllLabel.textContent = `Select all (${visible.length})`;
  } else {
    selectAllLabel.textContent = `Select all (${visible.length})`;
  }
}

function updateButtons() {
  btnClearSelected.disabled = selectedIds.size === 0;
  btnClearDms.disabled = !allItems.some(i => i.displayType === 'dm');
  btnClearSpaces.disabled = !allItems.some(i => i.displayType === 'space' || i.displayType === 'thread');
}

function updateConnectionStatus(connected, label) {
  isConnected = connected;
  statusDot.className = 'status-dot' + (connected ? '' : ' disconnected');
  statusLabel.className = 'status-label' + (connected ? '' : ' disconnected');
  statusLabel.textContent = label || (connected ? 'Connected' : 'Disconnected');
}

// ── Toast notification ──────────────────────────────────────────────────────

let toastTimer = null;
function showToast(message, type = 'success') {
  if (toastTimer) clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast ${type} visible`;
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3000);
}

// ── Per-item visual feedback helpers ─────────────────────────────────────────

function setItemState(itemId, state) {
  const el = listEl.querySelector(`.notif-item[data-id="${itemId}"]`);
  if (!el) return;
  el.classList.remove('clearing', 'cleared', 'clear-failed');
  if (state) el.classList.add(state);
}

function setItemsState(itemIds, state) {
  for (const id of itemIds) setItemState(id, state);
}

// ── Bulk mark-as-read ───────────────────────────────────────────────────────

/**
 * Collect all thread IDs that need clearing for a thread-type item.
 * Includes both the subscribedThreadId (the actual unread thread from
 * readState[20]) and any threadIds from pw[7]/pw[8].
 * The server-side mergeThreadIds already handles this, but we also
 * handle it here for resilience in case the API response is cached or stale.
 */
function getThreadIdsToClear(item) {
  const ids = new Set();

  // The subscribedThreadId is the actual unread thread — always include it
  if (typeof item.subscribedThreadId === 'string' && item.subscribedThreadId.length > 0) {
    ids.add(item.subscribedThreadId);
  }

  // Also include any threadIds from the paginated_world thread sections
  if (Array.isArray(item.threadIds)) {
    for (const id of item.threadIds) {
      if (typeof id === 'string' && id.length > 0) {
        ids.add(id);
      }
    }
  }

  return [...ids];
}

async function bulkMarkRead(itemIds, { onItemDone, onItemFail } = {}) {
  const items = allItems.filter(i => itemIds.has(i.id));
  if (items.length === 0) return { done: 0, failed: 0 };

  const CONCURRENCY = 5;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        try {
          if (item.displayType === 'thread') {
            const threadIds = getThreadIdsToClear(item);
            if (threadIds.length > 0) {
              // Clear each subscribed thread via mark_topic_readstate
              await Promise.all(
                threadIds.map(tid => markThreadAsRead(item.id, tid))
              );
            } else {
              // No thread IDs found — fall back to space-level mark-read
              await markAsRead(item.id, false);
            }
          } else {
            const isDm = item.type === 'dm';
            await markAsRead(item.id, isDm);
          }
          if (onItemDone) onItemDone(item);
        } catch (err) {
          if (onItemFail) onItemFail(item, err);
          throw err;
        }
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') done++;
      else failed++;
    }
  }

  return { done, failed };
}

// ── Load notifications ──────────────────────────────────────────────────────

async function loadNotifications() {
  listEl.innerHTML = '<div class="loading-spinner"></div>';

  try {
    const worldItems = await fetchNotifications();

    // Enrich unnamed DMs with display names before filtering
    await enrichDmNames(worldItems);

    allItems = filterUnreadItems(worldItems);

    // Sort: badged first, then lit_up, then threads, then by badge count
    allItems.sort((a, b) => {
      const catOrder = { badged: 0, lit_up: 1, none: 2 };
      const ca = catOrder[a.notificationCategory] ?? 2;
      const cb = catOrder[b.notificationCategory] ?? 2;
      if (ca !== cb) return ca - cb;
      // Within same category, DMs before spaces before threads
      const typeOrder = { dm: 0, space: 1, thread: 2 };
      const ta = typeOrder[a.displayType] ?? 1;
      const tb = typeOrder[b.displayType] ?? 1;
      if (ta !== tb) return ta - tb;
      return (b.badgeCount ?? 0) - (a.badgeCount ?? 0);
    });

    // Remove previously selected items that are no longer present
    const currentIds = new Set(allItems.map(i => i.id));
    for (const id of selectedIds) {
      if (!currentIds.has(id)) selectedIds.delete(id);
    }

    updateConnectionStatus(true, 'Connected');
    updateUI();
  } catch (err) {
    console.error('Failed to load notifications:', err);
    updateConnectionStatus(false, 'Error');
    const msg = err?.message || String(err);
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9888;</div>
        <div class="title">Failed to load</div>
        <div class="subtitle">${escapeHtml(msg)}</div>
      </div>`;
  }
}

// ── Event handlers ──────────────────────────────────────────────────────────

// Filter tabs
filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    filterTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeFilter = tab.dataset.filter;
    updateUI();
  });
});

// Select all / deselect all
selectAllBar.addEventListener('click', () => {
  const visible = getVisibleItems();
  const visibleIds = visible.map(i => i.id);
  const allSelected = visibleIds.every(id => selectedIds.has(id));

  if (allSelected) {
    visibleIds.forEach(id => selectedIds.delete(id));
  } else {
    visibleIds.forEach(id => selectedIds.add(id));
  }
  updateUI();
});

// Search
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  updateUI();
});

// Refresh
btnRefresh.addEventListener('click', async () => {
  btnRefresh.classList.add('spinning');
  await loadNotifications();
  btnRefresh.classList.remove('spinning');
});

// Clear DMs
btnClearDms.addEventListener('click', async () => {
  const dmIds = new Set(allItems.filter(i => i.displayType === 'dm').map(i => i.id));
  if (dmIds.size === 0) return;

  btnClearDms.disabled = true;
  setItemsState(dmIds, 'clearing');
  showToast(`Clearing ${dmIds.size} DM(s)...`);

  const { done, failed } = await bulkMarkRead(dmIds, {
    onItemDone: (item) => setItemState(item.id, 'cleared'),
    onItemFail: (item) => setItemState(item.id, 'clear-failed'),
  });
  showToast(
    failed > 0 ? `Cleared ${done}, ${failed} failed` : `Cleared ${done} DM(s)`,
    failed > 0 ? 'error' : 'success'
  );

  await loadNotifications();
});

// Clear Spaces (includes thread-unread spaces)
btnClearSpaces.addEventListener('click', async () => {
  const spaceIds = new Set(
    allItems
      .filter(i => i.displayType === 'space' || i.displayType === 'thread')
      .map(i => i.id)
  );
  if (spaceIds.size === 0) return;

  btnClearSpaces.disabled = true;
  setItemsState(spaceIds, 'clearing');
  showToast(`Clearing ${spaceIds.size} space(s)...`);

  const { done, failed } = await bulkMarkRead(spaceIds, {
    onItemDone: (item) => setItemState(item.id, 'cleared'),
    onItemFail: (item) => setItemState(item.id, 'clear-failed'),
  });
  showToast(
    failed > 0 ? `Cleared ${done}, ${failed} failed` : `Cleared ${done} space(s)`,
    failed > 0 ? 'error' : 'success'
  );

  await loadNotifications();
});

// Clear selected
btnClearSelected.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;

  const ids = new Set(selectedIds);
  const count = ids.size;
  btnClearSelected.disabled = true;
  setItemsState(ids, 'clearing');
  showToast(`Clearing ${count} notification(s)...`);

  const { done, failed } = await bulkMarkRead(ids, {
    onItemDone: (item) => setItemState(item.id, 'cleared'),
    onItemFail: (item) => setItemState(item.id, 'clear-failed'),
  });
  selectedIds.clear();

  showToast(
    failed > 0 ? `Cleared ${done}, ${failed} failed` : `Cleared ${done} notification(s)`,
    failed > 0 ? 'error' : 'success'
  );

  await loadNotifications();
});

// ── Initialize ──────────────────────────────────────────────────────────────

async function init() {
  const state = await getState();

  if (state.xsrfToken) {
    xsrfToken = state.xsrfToken;
  }

  if (!state.hasTab) {
    updateConnectionStatus(false, 'No Chat tab');
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#128172;</div>
        <div class="title">No Google Chat tab found</div>
        <div class="subtitle">Open chat.google.com and try again</div>
      </div>`;
    return;
  }

  if (!xsrfToken) {
    updateConnectionStatus(false, 'Waiting for token');
    await refreshXsrf();
    if (!xsrfToken) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">&#128274;</div>
          <div class="title">Waiting for XSRF token</div>
          <div class="subtitle">Interact with Google Chat to capture the auth token</div>
        </div>`;
      const pollInterval = setInterval(async () => {
        await refreshXsrf();
        if (xsrfToken) {
          clearInterval(pollInterval);
          await loadNotifications();
        }
      }, 2000);
      return;
    }
  }

  updateConnectionStatus(true, 'Connected');
  await loadNotifications();
}

init();
