// Google Chat Web UI - v2 (with mark-as-read)
console.log('[app.js] Loaded v2 with mark-as-read support');
const API_BASE = '/api';
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const DEV_MODE_STORAGE_KEY = 'gchat.developerMode';
const SIDEBAR_AUTO_COLLAPSE_KEY = 'gchat.sidebar.autoCollapse';
const SIDEBAR_SECTION_WEIGHTS_KEY = 'gchat.sidebar.sectionWeights.v1';
const SIDEBAR_COLLAPSED_SECTIONS_KEY = 'gchat.sidebar.collapsedSections.v1';

// State
let currentUser = null;
let spaces = [];
let dms = [];
let favorites = [];
let selectedChannel = null;
let selectedType = null; // 'space' or 'dm'
let ws = null;
let reconnectAttempts = 0;
let eventCount = 0;
let eventLogExpanded = false;
let developerMode = false;
let dmPresenceMap = new Map(); // Map<dmId, { userId, presence, presenceLabel, dndState, dndLabel, name, avatarUrl, customStatus? }>
let dmUserIdToDmId = new Map(); // Map<userId, dmId>
let pendingUserStatusByUserId = new Map(); // Map<userId, userStatus> - applied once dmId mapping is known
let sidebarAutoCollapse = false;
let sidebarSectionWeights = {};
let sidebarCollapsedSections = {};
let pendingSends = new Map(); // Map<pendingId, { channelId, channelType, topicId?, text, createdAt }>

// DOM Elements
const userInfoEl = document.getElementById('user-info');
const spacesListEl = document.getElementById('spaces-list');
const dmsListEl = document.getElementById('dms-list');
const spacesCountEl = document.getElementById('spaces-count');
const dmsCountEl = document.getElementById('dms-count');
const channelNameEl = document.getElementById('channel-name');
const channelInfoEl = document.getElementById('channel-info');
const messagesContainerEl = document.getElementById('messages-container');
const messagesListEl = document.getElementById('messages-list');
const emptyStateEl = document.getElementById('empty-state');
const loadingOverlayEl = document.getElementById('loading-overlay');
const threadPanelEl = document.getElementById('thread-panel');
const threadMessagesEl = document.getElementById('thread-messages');
const closeThreadBtn = document.getElementById('close-thread');
const favoritesSectionEl = document.getElementById('favorites-section');
const favoritesListEl = document.getElementById('favorites-list');
const favoritesCountEl = document.getElementById('favorites-count');
const connectionStatusEl = document.getElementById('connection-status');
const eventLogEl = document.getElementById('event-log');
const eventLogHeaderEl = document.getElementById('event-log-header');
const eventLogContentEl = document.getElementById('event-log-content');
const eventCountEl = document.getElementById('event-count');
const clearEventsBtnEl = document.getElementById('clear-events-btn');
const newMessageIndicatorEl = document.getElementById('new-message-indicator');
const devToggleEl = document.getElementById('dev-toggle');
const devEventsBtnEl = document.getElementById('dev-events-btn');
const sidebarAutoCollapseEl = document.getElementById('sidebar-auto-collapse');

// Composers
const composeFormEl = document.getElementById('compose-form');
const composeInputEl = document.getElementById('compose-input');
const composeSendEl = document.getElementById('compose-send');
const threadFormEl = document.getElementById('thread-form');
const threadInputEl = document.getElementById('thread-input');
const threadSendEl = document.getElementById('thread-send');

let currentThread = null; // { channelId, topicId, type }

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupEventListeners();
  initDeveloperMode();
  initSidebarLayout();
  setupWebSocket();
  await loadUser();
  // Load favorites first so star icons render correctly
  await loadFavorites();
  await Promise.all([loadSpaces(), loadDMs()]);
  // Load DM presence after DMs are loaded
  await loadDMPresence();
  await restoreLastViewed();
}

function isNearBottom(scrollEl, thresholdPx = 150) {
  if (!scrollEl) return true;
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < thresholdPx;
}

function scrollToBottom(scrollEl) {
  if (!scrollEl) return;
  requestAnimationFrame(() => {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });
}

function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function normalizeUrl(url) {
  const str = String(url || '').trim();
  if (!str) return '';
  if (str.startsWith('//')) return `https:${str}`;
  return str;
}

function shouldProxyUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname || '';
    return host.endsWith('google.com') || host.endsWith('googleusercontent.com') || host.endsWith('ggpht.com');
  } catch {
    return false;
  }
}

function proxyMediaUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return '';
  if (!shouldProxyUrl(normalized)) return normalized;
  return `${API_BASE}/proxy?url=${encodeURIComponent(normalized)}`;
}

function setComposerEnabled(enabled) {
  if (!composeInputEl || !composeSendEl) return;
  composeInputEl.disabled = !enabled;
  composeSendEl.disabled = !enabled || !String(composeInputEl.value || '').trim();
}

function setThreadComposerEnabled(enabled) {
  if (!threadInputEl || !threadSendEl) return;
  threadInputEl.disabled = !enabled;
  threadSendEl.disabled = !enabled || !String(threadInputEl.value || '').trim();
}

function clearEventLog() {
  eventLogContentEl.innerHTML = '';
  eventCount = 0;
  eventCountEl.textContent = '0';
}

function setEventLogVisible(visible) {
  if (!eventLogEl) return;
  eventLogEl.classList.toggle('is-hidden', !visible);
  if (!visible) {
    eventLogExpanded = false;
    eventLogEl.classList.remove('expanded');
  } else {
    eventLogExpanded = true;
    eventLogEl.classList.add('expanded');
  }
  if (devEventsBtnEl) {
    devEventsBtnEl.textContent = visible ? 'Hide events' : 'Events';
    devEventsBtnEl.title = visible ? 'Hide real-time events' : 'Show real-time events';
  }
}

function setDeveloperMode(enabled) {
  developerMode = !!enabled;
  try {
    window.localStorage.setItem(DEV_MODE_STORAGE_KEY, developerMode ? '1' : '0');
  } catch {
    // ignore
  }

  if (devToggleEl) {
    devToggleEl.classList.toggle('active', developerMode);
  }
  if (devEventsBtnEl) {
    devEventsBtnEl.style.display = developerMode ? 'inline-flex' : 'none';
  }

  // Always hide the event log unless explicitly opened in developer mode.
  setEventLogVisible(false);
  if (!developerMode) {
    clearEventLog();
  }
}

function initDeveloperMode() {
  let enabled = false;
  try {
    enabled = window.localStorage.getItem(DEV_MODE_STORAGE_KEY) === '1';
  } catch {
    enabled = false;
  }
  setDeveloperMode(enabled);
}

function setupEventListeners() {
  // Section toggles
  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
      const key = header.dataset.toggle;
      if (!key) return;

      const currentlyCollapsed = header.classList.contains('collapsed');
      setSidebarSectionCollapsed(key, !currentlyCollapsed, { userInitiated: true });

      // Optional accordion behavior
      if (sidebarAutoCollapse && currentlyCollapsed) {
        for (const otherKey of ['favorites', 'spaces', 'dms']) {
          if (otherKey !== key) {
            setSidebarSectionCollapsed(otherKey, true, { userInitiated: false });
          }
        }
      }
    });
  });

  // Close thread panel
  closeThreadBtn.addEventListener('click', () => {
    threadPanelEl.style.display = 'none';
    currentThread = null;
    if (threadInputEl) threadInputEl.value = '';
    setThreadComposerEnabled(false);
  });

  // Event log toggle
  eventLogHeaderEl.addEventListener('click', () => {
    eventLogExpanded = !eventLogExpanded;
    eventLogEl.classList.toggle('expanded', eventLogExpanded);
  });

  // Clear events
  clearEventsBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    clearEventLog();
  });

  // Developer mode toggle + event log visibility
  devToggleEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    setDeveloperMode(!developerMode);
  });

  devEventsBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!developerMode) return;
    const isHidden = eventLogEl.classList.contains('is-hidden');
    setEventLogVisible(isHidden);
  });

  // New message indicator click
  newMessageIndicatorEl.addEventListener('click', () => {
    scrollToBottom(messagesContainerEl);
    newMessageIndicatorEl.style.display = 'none';
  });

  // Sidebar auto-collapse toggle
  sidebarAutoCollapseEl?.addEventListener('change', () => {
    sidebarAutoCollapse = !!sidebarAutoCollapseEl.checked;
    try {
      window.localStorage.setItem(SIDEBAR_AUTO_COLLAPSE_KEY, sidebarAutoCollapse ? '1' : '0');
    } catch {
      // ignore
    }
  });

  // Scroll handler for messages
  messagesContainerEl.addEventListener('scroll', () => {
    if (isNearBottom(messagesContainerEl, 100)) {
      newMessageIndicatorEl.style.display = 'none';
    }
  });

  // Main composer
  composeInputEl.addEventListener('input', () => {
    autoResizeTextarea(composeInputEl);
    setComposerEnabled(!!selectedChannel);
  });

  composeInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composeFormEl.requestSubmit();
    }
  });

  composeFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = String(composeInputEl.value || '').trim();
    if (!text || !selectedChannel || !selectedType) return;
    await sendMessage(selectedChannel, selectedType, text);
  });

  // Thread composer
  threadInputEl.addEventListener('input', () => {
    autoResizeTextarea(threadInputEl);
    setThreadComposerEnabled(!!currentThread);
  });

  threadInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      threadFormEl.requestSubmit();
    }
  });

  threadFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = String(threadInputEl.value || '').trim();
    if (!text || !currentThread) return;
    await replyInThread(currentThread, text);
  });
}

function isElementVisible(el) {
  if (!el) return false;
  if (el.style?.display === 'none') return false;
  return !!el.offsetParent;
}

function readJsonStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJsonStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function initSidebarLayout() {
  try {
    sidebarAutoCollapse = window.localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_KEY) === '1';
  } catch {
    sidebarAutoCollapse = false;
  }
  if (sidebarAutoCollapseEl) {
    sidebarAutoCollapseEl.checked = sidebarAutoCollapse;
  }

  const weights = readJsonStorage(SIDEBAR_SECTION_WEIGHTS_KEY, {});
  sidebarSectionWeights = (weights && typeof weights === 'object' && !Array.isArray(weights)) ? weights : {};
  const collapsed = readJsonStorage(SIDEBAR_COLLAPSED_SECTIONS_KEY, {});
  sidebarCollapsedSections = (collapsed && typeof collapsed === 'object' && !Array.isArray(collapsed)) ? collapsed : {};

  // Apply collapsed state first (so layout uses header-only sections).
  for (const key of ['favorites', 'spaces', 'dms']) {
    setSidebarSectionCollapsed(key, sidebarCollapsedSections?.[key] === true, { skipPersist: true });
  }

  applySidebarSectionWeights();
  initSidebarResizers();
  updateSidebarResizers();
}

function getSidebarSectionEl(key) {
  return document.getElementById(`${key}-section`);
}

function getSidebarListEl(key) {
  return document.getElementById(`${key}-list`);
}

function getSidebarHeaderEl(key) {
  return document.querySelector(`.section-header[data-toggle="${key}"]`);
}

function getDefaultSectionWeight(sectionEl) {
  if (!sectionEl?.id) return 220;
  const defaults = {
    'favorites-section': 140,
    'spaces-section': 260,
    'dms-section': 340,
  };
  return defaults[sectionEl.id] || 220;
}

function applySectionWeight(sectionEl) {
  if (!sectionEl?.id) return;
  const stored = sidebarSectionWeights?.[sectionEl.id];
  const weight =
    typeof stored === 'number' && Number.isFinite(stored) && stored > 0
      ? stored
      : getDefaultSectionWeight(sectionEl);
  sectionEl.style.flex = `${Math.round(weight)} 1 0`;
  sidebarSectionWeights[sectionEl.id] = Math.round(weight);
}

function applySidebarSectionWeights() {
  for (const key of ['favorites', 'spaces', 'dms']) {
    const sectionEl = getSidebarSectionEl(key);
    if (!sectionEl || !isElementVisible(sectionEl)) {
      continue;
    }
    if (sectionEl.classList.contains('is-collapsed')) {
      sectionEl.style.flex = '0 0 auto';
      continue;
    }
    applySectionWeight(sectionEl);
  }
  saveJsonStorage(SIDEBAR_SECTION_WEIGHTS_KEY, sidebarSectionWeights);
}

function setSidebarSectionCollapsed(key, collapsed, opts = {}) {
  const sectionEl = getSidebarSectionEl(key);
  const headerEl = getSidebarHeaderEl(key);
  const listEl = getSidebarListEl(key);
  if (!sectionEl || !headerEl || !listEl) return;

  headerEl.classList.toggle('collapsed', collapsed);
  listEl.classList.toggle('collapsed', collapsed);
  sectionEl.classList.toggle('is-collapsed', collapsed);

  if (collapsed) {
    sectionEl.style.flex = '0 0 auto';
  } else {
    applySectionWeight(sectionEl);
  }

  sidebarCollapsedSections[key] = collapsed;
  if (!opts.skipPersist) {
    saveJsonStorage(SIDEBAR_COLLAPSED_SECTIONS_KEY, sidebarCollapsedSections);
    saveJsonStorage(SIDEBAR_SECTION_WEIGHTS_KEY, sidebarSectionWeights);
  }

  updateSidebarResizers();
}

function getSidebarSectionMinHeight(sectionEl) {
  const headerEl = sectionEl.querySelector('.section-header');
  const headerHeight = headerEl?.getBoundingClientRect?.().height || 32;
  return headerHeight + 64;
}

function initSidebarResizers() {
  document.querySelectorAll('.sidebar-resizer').forEach((handle) => {
    if (handle.dataset.bound === '1') return;
    handle.dataset.bound = '1';

    handle.addEventListener('pointerdown', (e) => {
      if (handle.classList.contains('is-disabled') || handle.classList.contains('is-hidden')) return;
      if (typeof e.button === 'number' && e.button !== 0) return;

      const beforeId = handle.dataset.before;
      const afterId = handle.dataset.after;
      if (!beforeId || !afterId) return;

      const beforeEl = document.getElementById(beforeId);
      const afterEl = document.getElementById(afterId);
      if (!beforeEl || !afterEl) return;
      if (!isElementVisible(beforeEl) || !isElementVisible(afterEl)) return;
      if (beforeEl.classList.contains('is-collapsed') || afterEl.classList.contains('is-collapsed')) return;

      const startY = e.clientY;
      const startBeforeHeight = beforeEl.getBoundingClientRect().height;
      const startAfterHeight = afterEl.getBoundingClientRect().height;
      const total = startBeforeHeight + startAfterHeight;

      const minBefore = getSidebarSectionMinHeight(beforeEl);
      const minAfter = getSidebarSectionMinHeight(afterEl);

      let active = true;
      document.body.classList.add('is-resizing');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      const onMove = (ev) => {
        if (!active) return;
        const delta = ev.clientY - startY;
        const maxBefore = Math.max(minBefore, total - minAfter);
        const nextBefore = Math.max(minBefore, Math.min(startBeforeHeight + delta, maxBefore));
        const nextAfter = Math.max(minAfter, total - nextBefore);

        beforeEl.style.flex = `${Math.round(nextBefore)} 1 0`;
        afterEl.style.flex = `${Math.round(nextAfter)} 1 0`;
        sidebarSectionWeights[beforeEl.id] = Math.round(nextBefore);
        sidebarSectionWeights[afterEl.id] = Math.round(nextAfter);
      };

      const onUp = () => {
        if (!active) return;
        active = false;
        document.body.classList.remove('is-resizing');
        saveJsonStorage(SIDEBAR_SECTION_WEIGHTS_KEY, sidebarSectionWeights);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  });
}

function updateSidebarResizers() {
  document.querySelectorAll('.sidebar-resizer').forEach((handle) => {
    const beforeId = handle.dataset.before;
    const afterId = handle.dataset.after;
    const beforeEl = beforeId ? document.getElementById(beforeId) : null;
    const afterEl = afterId ? document.getElementById(afterId) : null;

    const visible = isElementVisible(beforeEl) && isElementVisible(afterEl);
    handle.classList.toggle('is-hidden', !visible);

    const disabled =
      !visible ||
      !!beforeEl?.classList.contains('is-collapsed') ||
      !!afterEl?.classList.contains('is-collapsed');
    handle.classList.toggle('is-disabled', disabled);
  });
}

function createPendingId(prefix = 'pending') {
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}`;
}

function schedulePendingSendCleanup(pendingId) {
  setTimeout(() => {
    pendingSends.delete(pendingId);
  }, 2 * 60 * 1000);
}

function getDateLabel(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

function ensureMessagesVisible() {
  messagesListEl.style.display = 'block';
  emptyStateEl.style.display = 'none';
}

function appendLocalMessageToMainList(localMsg) {
  ensureMessagesVisible();

  const dateLabel = getDateLabel(localMsg.timestamp);
  const separatorSpans = messagesListEl.querySelectorAll('.date-separator span');
  const lastSep = separatorSpans.length > 0 ? separatorSpans[separatorSpans.length - 1] : null;
  const lastDate = lastSep ? String(lastSep.textContent || '') : '';
  if (lastDate !== dateLabel) {
    messagesListEl.insertAdjacentHTML('beforeend', `<div class="date-separator"><span>${escapeHtml(dateLabel)}</span></div>`);
  }

  messagesListEl.insertAdjacentHTML('beforeend', renderMessage(localMsg));
  newMessageIndicatorEl.style.display = 'none';
  scrollToBottom(messagesContainerEl);
}

function appendLocalMessageToThread(localMsg) {
  threadMessagesEl.insertAdjacentHTML('beforeend', renderMessage(localMsg));
  scrollToBottom(threadMessagesEl);
}

function updatePendingMessageUI(pendingId, update) {
  const selector = `.message[data-pending-id="${pendingId}"]`;
  const els = document.querySelectorAll(selector);
  if (els.length === 0) return;

  els.forEach((el) => {
    if (update.messageId) {
      el.setAttribute('data-msg-id', update.messageId);
    }

    // Remove the pending marker once we have a confirmed send. Keep it on failure so
    // a late WS ack can still "adopt" the optimistic message.
    if (update.state !== 'failed') {
      el.removeAttribute('data-pending-id');
    }
    el.classList.remove('is-pending');

    const statusEl = el.querySelector('.message-status');
    if (statusEl) statusEl.remove();

    if (update.state === 'failed') {
      el.classList.add('is-failed');
      const header = el.querySelector('.message-header');
      if (header) {
        const err = document.createElement('span');
        err.className = 'message-status message-status-error';
        err.title = update.error || 'Failed to send';
        err.textContent = 'Failed';
        header.appendChild(err);
      }
    } else {
      el.classList.remove('is-failed');
    }

    if (update.messageId) {
      // If a WS message already rendered with this id, prefer it and remove the optimistic copy.
      const root = messagesListEl?.contains(el) ? messagesListEl : (threadMessagesEl?.contains(el) ? threadMessagesEl : null);
      if (root) {
        const dupes = root.querySelectorAll(`.message[data-msg-id="${update.messageId}"]`);
        if (dupes.length > 1) {
          // Keep the first element that wasn't optimistic (no longer has data-pending-id).
          const keep = Array.from(dupes).find((n) => n !== el) || dupes[0];
          if (keep !== el) {
            el.remove();
          } else {
            dupes.forEach((n) => {
              if (n !== keep) n.remove();
            });
          }
        }
      }
    }
  });
}

function tryAdoptPendingSendFromWs(eventData, message) {
  if (!currentUser || !message) return false;

  const creator = message.creator || {};
  const isSelf =
    (creator.id && currentUser.userId && creator.id === currentUser.userId) ||
    (creator.email && currentUser.email && creator.email === currentUser.email);
  if (!isSelf) return false;

  const groupId = eventData?.groupId;
  const channelId = groupId?.id;
  const channelType = groupId?.type;
  const text = String(message.text || '').trim();
  if (!channelId || !channelType || !text) return false;

  const now = Date.now();
  let best = null;
  for (const [pendingId, meta] of pendingSends.entries()) {
    if (meta.channelId !== channelId || meta.channelType !== channelType) continue;
    if (meta.topicId && message.topic_id && meta.topicId !== message.topic_id) continue;
    if (meta.topicId && !message.topic_id) continue;
    if (String(meta.text || '').trim() !== text) continue;
    if (now - meta.createdAt > 2 * 60 * 1000) continue; // only match recent sends
    if (!best || meta.createdAt > best.createdAt) {
      best = { pendingId, createdAt: meta.createdAt };
    }
  }

  if (!best) return false;

  updatePendingMessageUI(best.pendingId, { state: 'sent', messageId: message.id });
  pendingSends.delete(best.pendingId);
  return true;
}

async function sendMessage(channelId, channelType, text) {
  const pendingId = createPendingId('send');
  const now = new Date();

  pendingSends.set(pendingId, {
    channelId,
    channelType,
    text,
    createdAt: Date.now(),
  });

  // Optimistically render in the current view.
  if (selectedChannel === channelId && selectedType === channelType) {
    appendLocalMessageToMainList({
      message_id: undefined,
      text,
      timestamp: now.toISOString(),
      sender: currentUser?.name || currentUser?.email || 'You',
      sender_avatar_url: currentUser?.avatarUrl || '',
      _pending: true,
      _pendingId: pendingId,
    });
  }

  // Clear composer immediately and re-enable typing.
  composeInputEl.value = '';
  autoResizeTextarea(composeInputEl);
  setComposerEnabled(!!selectedChannel);

  try {
    const endpoint = channelType === 'dm'
      ? `/dms/${encodeURIComponent(channelId)}/messages`
      : `/spaces/${encodeURIComponent(channelId)}/messages`;

    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    const messageId = data.message_id || data.topic_id;
    if (messageId) {
      updatePendingMessageUI(pendingId, { state: 'sent', messageId: String(messageId) });
    } else {
      updatePendingMessageUI(pendingId, { state: 'sent' });
    }
    pendingSends.delete(pendingId);
  } catch (err) {
    console.error('Failed to send message:', err);
    updatePendingMessageUI(pendingId, { state: 'failed', error: (err && err.message) ? err.message : 'Failed to send' });
    schedulePendingSendCleanup(pendingId);
  }
}

async function replyInThread(threadCtx, text) {
  const pendingId = createPendingId('reply');
  const now = new Date();

  pendingSends.set(pendingId, {
    channelId: threadCtx.channelId,
    channelType: threadCtx.type,
    topicId: threadCtx.topicId,
    text,
    createdAt: Date.now(),
  });

  appendLocalMessageToThread({
    message_id: undefined,
    text,
    timestamp: now.toISOString(),
    sender: currentUser?.name || currentUser?.email || 'You',
    sender_avatar_url: currentUser?.avatarUrl || '',
    _pending: true,
    _pendingId: pendingId,
  });

  // Clear composer immediately and re-enable typing.
  threadInputEl.value = '';
  autoResizeTextarea(threadInputEl);
  setThreadComposerEnabled(!!currentThread);

  try {
    const endpoint = threadCtx.type === 'dm'
      ? `/dms/${encodeURIComponent(threadCtx.channelId)}/threads/${encodeURIComponent(threadCtx.topicId)}/replies`
      : `/spaces/${encodeURIComponent(threadCtx.channelId)}/threads/${encodeURIComponent(threadCtx.topicId)}/replies`;

    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    const messageId = data.message_id || data.topic_id;
    if (messageId) {
      updatePendingMessageUI(pendingId, { state: 'sent', messageId: String(messageId) });
    } else {
      updatePendingMessageUI(pendingId, { state: 'sent' });
    }
    pendingSends.delete(pendingId);
  } catch (err) {
    console.error('Failed to reply in thread:', err);
    updatePendingMessageUI(pendingId, { state: 'failed', error: (err && err.message) ? err.message : 'Failed to send' });
    schedulePendingSendCleanup(pendingId);
  }
}

// API Helpers
async function fetchAPI(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('API Error:', err);
    throw err;
  }
}

// Load current user
async function loadUser() {
  try {
    currentUser = await fetchAPI('/whoami');
    renderUser();
  } catch (err) {
    userInfoEl.textContent = 'Not authenticated';
  }
}

function renderUser() {
  if (!currentUser) return;
  const avatarUrl = proxyMediaUrl(currentUser.avatarUrl || '');
  userInfoEl.innerHTML = `
    <img src="${escapeHtml(avatarUrl || TRANSPARENT_PIXEL)}" alt="" onerror="this.style.display='none'">
    <span>${currentUser.name || currentUser.email}</span>
  `;
}

// Load spaces with pagination
async function loadSpaces() {
  const MAX_SPACES = 1000;  // Safety limit
  const PAGE_SIZE = 100;

  try {
    spaces = [];
    let cursor = undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore && spaces.length < MAX_SPACES) {
      // Build URL with pagination params
      const url = new URL('/api/spaces', window.location.origin);
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      if (cursor !== undefined) {
        url.searchParams.set('cursor', String(cursor));
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const newSpaces = data.spaces || [];

      // Deduplicate by ID
      const seenIds = new Set(spaces.map(s => s.id));
      for (const space of newSpaces) {
        if (!seenIds.has(space.id)) {
          spaces.push(space);
          seenIds.add(space.id);
        }
      }

      // Update count progressively
      spacesCountEl.textContent = spaces.length;
      pageCount++;

      // Check pagination
      hasMore = data.pagination?.hasMore === true;
      cursor = data.pagination?.nextCursor;

      // Safety check - if no new spaces were added, stop
      if (newSpaces.length === 0) {
        break;
      }

      console.log(`[loadSpaces] Page ${pageCount}: loaded ${newSpaces.length} spaces, total: ${spaces.length}, hasMore: ${hasMore}`);
    }

    renderSpaces();
    console.log(`[loadSpaces] Complete: ${spaces.length} spaces loaded in ${pageCount} pages`);
  } catch (err) {
    console.error('Failed to load spaces:', err);
  }
}

function renderSpaces() {
  spacesListEl.innerHTML = spaces.map(space => {
    const spaceName = space.name || space.id;
    const fav = isFavorite(space.id);
    return `
      <li class="channel-item ${fav ? 'is-favorite' : ''}" data-id="${space.id}" data-type="space">
        <span class="channel-icon">#</span>
        <span class="channel-name" title="${escapeHtml(spaceName)}">${escapeHtml(spaceName)}</span>
        <button class="favorite-btn ${fav ? 'is-favorite' : ''}" data-id="${space.id}" data-type="space" data-name="${escapeHtml(spaceName)}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '★' : '☆'}</button>
      </li>
    `;
  }).join('');

  // Add click handlers
  spacesListEl.querySelectorAll('.channel-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.classList.contains('favorite-btn')) {
        selectChannel(item.dataset.id, 'space');
      }
    });
  });

  // Add favorite button handlers
  spacesListEl.querySelectorAll('.favorite-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.id, btn.dataset.type, btn.dataset.name);
    });
  });
}

// Load DMs with pagination
async function loadDMs() {
  const MAX_DMS = 500;  // Safety limit
  const PAGE_SIZE = 50;

  try {
    dms = [];
    let offset = 0;
    let pageCount = 0;
    let hasMore = true;

    while (hasMore && dms.length < MAX_DMS) {
      // Build URL with pagination params
      const url = new URL('/api/dms', window.location.origin);
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('offset', String(offset));

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const newDMs = data.dms || [];

      // Deduplicate by ID
      const seenIds = new Set(dms.map(d => d.id));
      for (const dm of newDMs) {
        if (!seenIds.has(dm.id)) {
          dms.push(dm);
          seenIds.add(dm.id);
        }
      }

      // Update count progressively
      dmsCountEl.textContent = dms.length;
      pageCount++;

      // Check if there are more - if we got fewer than requested, we're done
      hasMore = newDMs.length >= PAGE_SIZE;
      offset += newDMs.length;

      // Safety check - if no new DMs were added, stop
      if (newDMs.length === 0) {
        break;
      }

      console.log(`[loadDMs] Page ${pageCount}: loaded ${newDMs.length} DMs, total: ${dms.length}, hasMore: ${hasMore}`);
    }

    renderDMs();
    console.log(`[loadDMs] Complete: ${dms.length} DMs loaded in ${pageCount} pages`);
  } catch (err) {
    console.error('Failed to load DMs:', err);
  }
}

// Load presence for all DM users
async function loadDMPresence() {
  try {
    // Reset mapping each load; presence entries are keyed by DM id.
    dmUserIdToDmId.clear();

    // Get DM IDs to fetch presence for
    const dmIds = dms.map(dm => dm.id).slice(0, 50);
    if (dmIds.length === 0) {
      console.log('[loadDMPresence] No DMs to load presence for');
      return;
    }

    // Try the /api/dms/presence endpoint which extracts user IDs from DM messages
    const url = new URL('/api/dms/presence', window.location.origin);
    url.searchParams.set('dmIds', dmIds.join(','));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log(`[loadDMPresence] Loaded presence for ${data.total} DMs via /api/dms/presence`);

    // Store in presence map - keyed by DM ID since that's what we have
    for (const presence of data.presences) {
      if (presence.dmId) {
        if (presence.userId) {
          dmUserIdToDmId.set(presence.userId, presence.dmId);
        }
        dmPresenceMap.set(presence.dmId, {
          userId: presence.userId,
          presence: presence.presence,
          presenceLabel: presence.presenceLabel,
          dndState: presence.dndState,
          dndLabel: presence.dndLabel,
          name: presence.name,
          avatarUrl: presence.avatarUrl,
          customStatus: presence.customStatus,
        });
      }
    }

    // Apply any pending realtime USER_STATUS_UPDATED updates now that we have userId->dmId mapping.
    for (const [userId, userStatus] of pendingUserStatusByUserId.entries()) {
      const dmId = dmUserIdToDmId.get(userId);
      if (!dmId) continue;
      pendingUserStatusByUserId.delete(userId);
      applyUserStatusUpdate(userStatus, dmId);
    }

    // If that didn't return data, try direct user ID approach as fallback
    if (data.total === 0) {
      console.log('[loadDMPresence] No presence from DM endpoint, trying direct user IDs');
      const userIds = dms
        .map(dm => dm.id)
        .filter(id => /^\d+$/.test(id))
        .slice(0, 100);

      if (userIds.length > 0) {
        const presenceUrl = new URL('/api/presence', window.location.origin);
        presenceUrl.searchParams.set('userIds', userIds.join(','));
        presenceUrl.searchParams.set('include', 'profile');

        const presenceRes = await fetch(presenceUrl);
        if (presenceRes.ok) {
          const presenceData = await presenceRes.json();
          console.log(`[loadDMPresence] Fallback loaded ${presenceData.total} presences`);
          for (const presence of presenceData.presences) {
            dmUserIdToDmId.set(presence.userId, presence.userId);
            dmPresenceMap.set(presence.userId, {
              userId: presence.userId,
              presence: presence.presence,
              presenceLabel: presence.presenceLabel,
              dndState: presence.dndState,
              dndLabel: presence.dndLabel,
              name: presence.name,
              avatarUrl: presence.avatarUrl,
              customStatus: presence.customStatus,
            });
          }
        }
      }
    }

    // Flush pending updates again in case we populated mapping via fallback.
    for (const [userId, userStatus] of pendingUserStatusByUserId.entries()) {
      const dmId = dmUserIdToDmId.get(userId);
      if (!dmId) continue;
      pendingUserStatusByUserId.delete(userId);
      applyUserStatusUpdate(userStatus, dmId);
    }

    // Re-render DMs with presence indicators
    renderDMs();
  } catch (err) {
    console.error('Failed to load DM presence:', err);
  }
}

// Get presence indicator HTML for a user
function getPresenceIndicator(dmId) {
  const presence = dmPresenceMap.get(dmId);
  if (!presence) {
    return '<span class="presence-dot presence-unknown" title="Offline"></span>';
  }

  // Determine the status class and title
  let statusClass = 'presence-unknown';
  let statusTitle = 'Offline';

  if (presence.dndLabel === 'dnd') {
    statusClass = 'presence-dnd';
    statusTitle = 'Do Not Disturb';
  } else if (presence.presenceLabel === 'active') {
    statusClass = 'presence-active';
    statusTitle = 'Online';
  } else if (presence.presenceLabel === 'inactive') {
    statusClass = 'presence-inactive';
    statusTitle = 'Away';
  } else if (presence.presenceLabel === 'sharing_disabled') {
    statusClass = 'presence-disabled';
    statusTitle = 'Status hidden';
  }

  if (presence.customStatus?.statusText) {
    statusTitle = `${statusTitle} — ${presence.customStatus.statusText}`;
  }

  return `<span class="presence-dot ${statusClass}" title="${statusTitle}"></span>`;
}

function renderDMs() {
  dmsListEl.innerHTML = dms.map(dm => {
    const dmName = dm.name || dm.id;
    const hasUnread = dm.unreadCount > 0;
    const fav = isFavorite(dm.id);
    const presenceInfo = dmPresenceMap.get(dm.id);
    const avatarUrl = proxyMediaUrl(presenceInfo?.avatarUrl || '');
    const presenceIndicator = getPresenceIndicator(dm.id);
    const dmUserId = presenceInfo?.userId || '';
    return `
      <li class="channel-item ${hasUnread ? 'unread' : ''} ${fav ? 'is-favorite' : ''}" data-id="${dm.id}" data-type="dm" data-user-id="${escapeHtml(dmUserId)}">
        <div class="dm-avatar-container">
          <img class="dm-avatar" src="${escapeHtml(avatarUrl || TRANSPARENT_PIXEL)}" alt="" onerror="this.style.background='var(--bg-hover)'">
          ${presenceIndicator}
        </div>
        <span class="channel-name" title="${escapeHtml(dmName)}">${escapeHtml(dmName)}</span>
        ${hasUnread ? `<span class="unread-badge">${dm.unreadCount}</span>` : ''}
        <button class="favorite-btn ${fav ? 'is-favorite' : ''}" data-id="${dm.id}" data-type="dm" data-name="${escapeHtml(dmName)}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '★' : '☆'}</button>
      </li>
    `;
  }).join('');

  // Add click handlers
  dmsListEl.querySelectorAll('.channel-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.classList.contains('favorite-btn')) {
        selectChannel(item.dataset.id, 'dm');
      }
    });
  });

  // Add favorite button handlers
  dmsListEl.querySelectorAll('.favorite-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.id, btn.dataset.type, btn.dataset.name);
    });
  });
}

// Select a channel or DM
async function selectChannel(id, type) {
  // Update selection state
  selectedChannel = id;
  selectedType = type;

  // Save last viewed to database
  saveLastViewed(id, type);

  // Get unread count before clearing (for the API call)
  const item = type === 'space'
    ? spaces.find(s => s.id === id)
    : dms.find(d => d.id === id);
  const unreadCount = item?.unreadCount || 0;

  // Update UI active state and clear unread indicator for selected channel
  document.querySelectorAll('.channel-item').forEach(el => {
    const isSelected = el.dataset.id === id && el.dataset.type === type;
    el.classList.toggle('active', isSelected);
    if (isSelected) {
      el.classList.remove('has-new-message');
      el.classList.remove('unread');
      // Remove unread badge
      const badge = el.querySelector('.unread-badge');
      if (badge) badge.remove();
    }
  });

  // Update header
  channelNameEl.textContent = item?.name || id;
  channelInfoEl.textContent = type === 'space' ? 'Space' : 'Direct Message';

  setComposerEnabled(true);

  // Always mark as read on the server when selecting a channel
  console.log('[selectChannel] Marking as read:', id, 'type:', type, 'unreadCount:', unreadCount);
  markChannelAsRead(id, unreadCount || 1);

  // Update local state to clear unread count
  if (type === 'dm') {
    const dm = dms.find(d => d.id === id);
    if (dm) dm.unreadCount = 0;
  } else if (type === 'space') {
    const space = spaces.find(s => s.id === id);
    if (space) space.unreadCount = 0;
  }

  // Load messages
  await loadMessages(id, type);
}

// Queue for mark-as-read requests
const markReadQueue = [];
let isProcessingMarkRead = false;

// Mark a channel as read on the server (queued async)
function markChannelAsRead(id, unreadCount) {
  // Add to queue
  markReadQueue.push({ id, unreadCount, timestamp: Date.now() });
  console.log('[markAsRead] Queued:', id, 'unreadCount:', unreadCount);

  // Process queue if not already processing
  processMarkReadQueue();
}

async function processMarkReadQueue() {
  if (isProcessingMarkRead || markReadQueue.length === 0) return;

  isProcessingMarkRead = true;

  while (markReadQueue.length > 0) {
    const { id, unreadCount } = markReadQueue.shift();

    try {
      console.log('[markAsRead] Sending request for:', id);
      const response = await fetch(`${API_BASE}/notifications/mark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: id, action: 'read', unreadCount })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('[markAsRead] Failed:', response.status, data);
      } else if (data.success) {
        console.log('[markAsRead] Success:', id, data);
      } else {
        console.error('[markAsRead] API returned failure:', data.error);
      }
    } catch (err) {
      console.error('[markAsRead] Network error:', err);
    }

    // Small delay between requests to avoid hammering the server
    if (markReadQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  isProcessingMarkRead = false;
}

// Load messages for a channel
async function loadMessages(id, type) {
  showLoading(true);
  emptyStateEl.style.display = 'none';
  messagesListEl.style.display = 'none';
  threadPanelEl.style.display = 'none';

  try {
    let data;
    if (type === 'dm') {
      data = await fetchAPI(`/dms/${encodeURIComponent(id)}/threads?pageSize=50&format=threaded`);
    } else {
      data = await fetchAPI(`/spaces/${encodeURIComponent(id)}/threads?pageSize=50&format=threaded`);
    }

    renderMessages(data, type);
  } catch (err) {
    console.error('Failed to load messages:', err);
    messagesListEl.innerHTML = `<div class="empty-state"><p>Failed to load messages</p></div>`;
    messagesListEl.style.display = 'block';
  } finally {
    showLoading(false);
  }
}

function renderMessages(data, type) {
  const topics = data.topics || [];
  const messages = data.messages || [];

  if (topics.length === 0 && messages.length === 0) {
    emptyStateEl.innerHTML = `
      <div class="empty-icon">💬</div>
      <p>No messages yet</p>
    `;
    emptyStateEl.style.display = 'flex';
    messagesListEl.style.display = 'none';
    return;
  }

  // Group messages by date
  const messagesByDate = {};
  const allMessages = [];

  if (topics.length > 0) {
    // Flatten topics into messages with thread info
    topics.forEach(topic => {
      const replies = topic.replies || [];
      if (replies.length > 0) {
        const firstMsg = replies[0];
        firstMsg._isTopicStart = true;
        firstMsg._replyCount = replies.length - 1;
        firstMsg._topicId = topic.topic_id;
        allMessages.push(firstMsg);

        // Add remaining replies
        replies.slice(1).forEach(reply => {
          reply._isReply = true;
          reply._topicId = topic.topic_id;
          allMessages.push(reply);
        });
      }
    });
  } else if (messages.length > 0) {
    // Fallback for APIs that return flat messages only
    messages.forEach(msg => allMessages.push(msg));
  }

  // Sort by timestamp
  allMessages.sort((a, b) => {
    const timeA = a.timestamp_usec || new Date(a.timestamp).getTime() * 1000;
    const timeB = b.timestamp_usec || new Date(b.timestamp).getTime() * 1000;
    return timeA - timeB;
  });

  // Group by date
  allMessages.forEach(msg => {
    const date = new Date(msg.timestamp).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
    if (!messagesByDate[date]) messagesByDate[date] = [];
    messagesByDate[date].push(msg);
  });

  // Render
  let html = '';
  Object.entries(messagesByDate).forEach(([date, msgs]) => {
    html += `<div class="date-separator"><span>${date}</span></div>`;
    msgs.forEach(msg => {
      html += renderMessage(msg);
    });
  });

  messagesListEl.innerHTML = html;
  messagesListEl.style.display = 'block';
  emptyStateEl.style.display = 'none';

  // Scroll to bottom
  scrollToBottom(messagesContainerEl);

  // Add click handlers for thread indicators
  messagesListEl.querySelectorAll('.thread-indicator').forEach(indicator => {
    indicator.addEventListener('click', () => {
      const topicId = indicator.dataset.topicId;
      loadThread(selectedChannel, topicId, selectedType);
    });
  });
}

function renderMessage(msg) {
  const time = new Date(msg.timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });

  const sender = msg.sender || 'Unknown';
  const text = formatMessageText(msg.text || '');
  const avatarUrl = proxyMediaUrl(msg.sender_avatar_url || '');
  const isReply = msg._isReply;
  const hasReplies = msg._replyCount > 0;
  const isPending = msg._pending === true;
  const isFailed = msg._failed === true;
  const pendingId = typeof msg._pendingId === 'string' ? msg._pendingId : '';
  const msgId = typeof msg.message_id === 'string' ? msg.message_id : (typeof msg.id === 'string' ? msg.id : '');

  const classes = ['message'];
  if (isReply) classes.push('is-reply');
  if (isPending) classes.push('is-pending');
  if (isFailed) classes.push('is-failed');

  const attrs = [];
  if (msgId) attrs.push(`data-msg-id="${escapeHtml(msgId)}"`);
  if (pendingId) attrs.push(`data-pending-id="${escapeHtml(pendingId)}"`);

  const statusHtml = isPending
    ? `<span class="message-status" title="Sending"><span class="spinner-mini" aria-hidden="true"></span></span>`
    : (isFailed ? `<span class="message-status message-status-error" title="Failed to send">Failed</span>` : '');

  return `
    <div class="${classes.join(' ')}" ${attrs.join(' ')}>
      <img class="message-avatar" src="${escapeHtml(avatarUrl || TRANSPARENT_PIXEL)}" alt="" onerror="this.style.background='var(--bg-hover)'">
      <div class="message-content">
        <div class="message-header">
          <span class="message-author">${escapeHtml(sender)}</span>
          <span class="message-time">${time}</span>
          ${statusHtml}
        </div>
        <div class="message-text">${text}</div>
        ${hasReplies ? `
          <div class="thread-indicator" data-topic-id="${msg._topicId}">
            💬 ${msg._replyCount} ${msg._replyCount === 1 ? 'reply' : 'replies'}
          </div>
        ` : ''}
        ${msg.attachments ? renderAttachments(msg.attachments) : ''}
      </div>
    </div>
  `;
}

function renderAttachments(attachments) {
  if (!attachments || attachments.length === 0) return '';

  return `
    <div class="message-attachments">
      ${attachments.map(att => {
        const name = att.content_name || att.name || 'Attachment';
        const contentType = att.content_type || att.contentType || '';
        const downloadUrl = att.download_url || att.url || '';
        const href = downloadUrl ? proxyMediaUrl(downloadUrl) : '';
        if (contentType?.startsWith('image/') && href) {
          return `
            <a class="attachment attachment-image" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
              <img src="${escapeHtml(href)}" alt="${escapeHtml(name)}" loading="lazy">
            </a>
          `;
        }
        if (href) {
          return `
            <a class="attachment" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
              <span class="attachment-icon">📎</span>
              <span>${escapeHtml(name)}</span>
            </a>
          `;
        }
        return `
          <div class="attachment">
            <span class="attachment-icon">📎</span>
            <span>${escapeHtml(name)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Load thread
async function loadThread(channelId, topicId, type) {
  threadPanelEl.style.display = 'flex';
  threadMessagesEl.innerHTML = '<div class="spinner"></div>';
  currentThread = { channelId, topicId, type };
  setThreadComposerEnabled(true);

  try {
    const endpoint = type === 'dm'
      ? `/dms/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(topicId)}`
      : `/spaces/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(topicId)}`;

    const data = await fetchAPI(endpoint);
    renderThread(data);
    scrollToBottom(threadMessagesEl);
    threadInputEl.focus();
  } catch (err) {
    console.error('Failed to load thread:', err);
    threadMessagesEl.innerHTML = '<p>Failed to load thread</p>';
  }
}

function renderThread(data) {
  const messages = data.messages || [];

  if (messages.length === 0) {
    threadMessagesEl.innerHTML = '<p>No messages in thread</p>';
    return;
  }

  threadMessagesEl.innerHTML = messages.map(msg => renderMessage(msg)).join('');
}

// Helpers
function showLoading(show) {
  loadingOverlayEl.style.display = show ? 'flex' : 'none';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatMessageText(text) {
  if (!text) return '';

  const URL_TOKEN_START = '\uE000';
  const URL_TOKEN_END = '\uE001';
  const CODE_TOKEN_START = '\uE002';
  const CODE_TOKEN_END = '\uE003';

  const splitUrlTrailing = (raw) => {
    let url = raw;
    let trailing = '';
    while (url.length > 0) {
      const last = url[url.length - 1];

      if (last === ')') {
        const open = (url.match(/\(/g) || []).length;
        const close = (url.match(/\)/g) || []).length;
        if (close > open) {
          trailing = last + trailing;
          url = url.slice(0, -1);
          continue;
        }
        break;
      }

      if (last === ']' || last === '}' || last === '.' || last === ',' || last === '!' || last === '?') {
        trailing = last + trailing;
        url = url.slice(0, -1);
        continue;
      }

      break;
    }
    return { url, trailing };
  };

  let formatted = escapeHtml(text);

  // Protect inline code spans first.
  const codeParts = [];
  formatted = formatted.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeParts.length;
    codeParts.push(code);
    return `${CODE_TOKEN_START}${idx}${CODE_TOKEN_END}`;
  });

  // Extract URLs so later formatting doesn't break them.
  const urlParts = [];
  formatted = formatted.replace(/https?:\/\/[^\s<]+/g, (match) => {
    const { url, trailing } = splitUrlTrailing(match);
    const idx = urlParts.length;
    urlParts.push(url);
    return `${URL_TOKEN_START}${idx}${URL_TOKEN_END}${trailing}`;
  });

  // Basic formatting
  formatted = formatted.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  formatted = formatted.replace(/\n/g, '<br>');

  // Restore URLs
  const urlTokenRe = new RegExp(`${URL_TOKEN_START}(\\d+)${URL_TOKEN_END}`, 'g');
  formatted = formatted.replace(urlTokenRe, (_m, idxStr) => {
    const idx = Number(idxStr);
    const url = urlParts[idx] || '';
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // Restore code
  const codeTokenRe = new RegExp(`${CODE_TOKEN_START}(\\d+)${CODE_TOKEN_END}`, 'g');
  formatted = formatted.replace(codeTokenRe, (_m, idxStr) => {
    const idx = Number(idxStr);
    const code = codeParts[idx] || '';
    return `<code>${code}</code>`;
  });

  return formatted;
}

// === Favorites Management ===

async function loadFavorites() {
  try {
    const data = await fetchAPI('/favorites');
    favorites = data.favorites || [];
    renderFavorites();
  } catch (err) {
    console.error('Failed to load favorites:', err);
    favorites = [];
  }
}

function renderFavorites() {
  if (favorites.length === 0) {
    favoritesSectionEl.style.display = 'none';
    updateSidebarResizers();
    return;
  }

  favoritesSectionEl.style.display = 'block';
  applySidebarSectionWeights();
  updateSidebarResizers();
  favoritesCountEl.textContent = favorites.length;

  favoritesListEl.innerHTML = favorites.map(fav => {
    const isSpace = fav.type === 'space';
    const icon = isSpace ? '#' : '';
    const displayName = fav.name || fav.id;
    return `
      <li class="channel-item is-favorite" data-id="${fav.id}" data-type="${fav.type}">
        ${isSpace ? `<span class="channel-icon">${icon}</span>` : '<img class="dm-avatar" src="" alt="" onerror="this.style.background=\'var(--bg-hover)\'">'}
        <span class="channel-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
        <button class="favorite-btn is-favorite" data-id="${fav.id}" data-type="${fav.type}" data-name="${escapeHtml(fav.name || '')}" title="Remove from favorites">★</button>
      </li>
    `;
  }).join('');

  // Add click handlers
  favoritesListEl.querySelectorAll('.channel-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.classList.contains('favorite-btn')) {
        selectChannel(item.dataset.id, item.dataset.type);
      }
    });
  });

  // Add favorite button handlers
  favoritesListEl.querySelectorAll('.favorite-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.id, btn.dataset.type, btn.dataset.name);
    });
  });
}

function isFavorite(channelId) {
  return favorites.some(f => f.id === channelId);
}

async function toggleFavorite(channelId, channelType, channelName) {
  try {
    if (isFavorite(channelId)) {
      await fetch(`${API_BASE}/favorites/${encodeURIComponent(channelId)}`, {
        method: 'DELETE'
      });
    } else {
      await fetch(`${API_BASE}/favorites/${encodeURIComponent(channelId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: channelName || channelId, type: channelType })
      });
    }
    // Reload favorites and re-render lists
    await loadFavorites();
    renderSpaces();
    renderDMs();
  } catch (err) {
    console.error('Failed to toggle favorite:', err);
  }
}

// === Last Viewed Management ===

async function restoreLastViewed() {
  try {
    const data = await fetchAPI('/last-viewed');
    if (data.lastViewed) {
      const { channel_id, channel_type } = data.lastViewed;
      // Try to restore - if channel doesn't exist, loadMessages will handle gracefully
      await selectChannel(channel_id, channel_type);
    }
  } catch (err) {
    console.error('Failed to restore last viewed:', err);
  }
}

async function saveLastViewed(channelId, channelType) {
  try {
    await fetch(`${API_BASE}/last-viewed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, channelType })
    });
  } catch (err) {
    console.error('Failed to save last viewed:', err);
  }
}

// === WebSocket Real-time Events ===

function setupWebSocket() {
  console.log('[WS] Connecting to', WS_URL);
  updateConnectionStatus('connecting');

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[WS] Failed to create WebSocket:', err);
    updateConnectionStatus('disconnected');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[WS] WebSocket opened');
    reconnectAttempts = 0;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    } catch (err) {
      console.error('[WS] Failed to parse message:', err);
    }
  };

  ws.onclose = (event) => {
    console.log('[WS] Disconnected, code:', event.code);
    updateConnectionStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  console.log(`[WS] Reconnecting in ${delay}ms... (attempt ${reconnectAttempts})`);
  setTimeout(setupWebSocket, delay);
}

function handleWebSocketMessage(data) {
  logEvent(data);

  switch (data.type) {
    case 'connected':
      console.log('[WS] Connected to server');
      if (data.channelStatus === 'connected') {
        updateConnectionStatus('connected');
      } else {
        updateConnectionStatus('connecting');
      }
      break;

    case 'channel_status':
      console.log('[WS] Channel status:', data.status);
      updateConnectionStatus(data.status);
      break;

    case 'channel_connected':
      updateConnectionStatus('connected');
      break;

    case 'channel_disconnected':
      updateConnectionStatus('disconnected');
      break;

    case 'channel_error':
      updateConnectionStatus('error');
      break;

    case 'message':
      handleNewMessage(data);
      break;

    case 'typing':
      handleTypingIndicator(data);
      break;

    case 'readReceipt':
      // Could update read receipts UI
      break;

    case 'userStatus':
      handleUserStatus(data);
      break;

    case 'groupChanged':
      handleGroupChanged(data);
      break;

    case 'event':
      // Generic event - already logged
      break;
  }
}

function handleGroupChanged(data) {
  // This is a backup notification - MESSAGE_POSTED events handle actual messages
  // Just mark channels as having new content (for non-current channels)
  const eventData = data.event || data;
  const groupId = eventData.groupId;
  
  if (!groupId) return;
  
  const isCurrentChannel = selectedChannel &&
    ((groupId.type === 'space' && selectedType === 'space' && groupId.id === selectedChannel) ||
     (groupId.type === 'dm' && selectedType === 'dm' && groupId.id === selectedChannel));
  
  // Only mark non-current channels - current channel gets updates via handleNewMessage
  if (!isCurrentChannel) {
    const channelEl = document.querySelector(`[data-id="${groupId.id}"]`);
    if (channelEl && !channelEl.classList.contains('has-new-message')) {
      channelEl.classList.add('has-new-message');
    }
  }
}

function updateConnectionStatus(status) {
  connectionStatusEl.className = 'connection-status ' + status;
  const dotEl = connectionStatusEl.querySelector('.status-dot');
  const textEl = connectionStatusEl.querySelector('.status-text');

  switch (status) {
    case 'connected':
      textEl.textContent = 'Connected';
      break;
    case 'connecting':
      textEl.textContent = 'Connecting...';
      break;
    case 'disconnected':
      textEl.textContent = 'Disconnected';
      break;
    case 'error':
      textEl.textContent = 'Error';
      break;
    default:
      textEl.textContent = status;
  }
}

function logEvent(data) {
  if (!developerMode) {
    return;
  }

  eventCount++;
  eventCountEl.textContent = eventCount;

  const time = new Date().toLocaleTimeString();
  const eventType = data.type || 'unknown';
  const groupId = data.groupId ? `${data.groupId.type}:${data.groupId.id}` : '';

  const eventEl = document.createElement('div');
  eventEl.className = `event-item event-${eventType}`;
  eventEl.innerHTML = `
    <span class="event-time">${time}</span>
    <span class="event-type">${eventType}</span>
    ${groupId ? `<span class="event-group">${groupId}</span>` : ''}
    ${data.message?.text ? `<span class="event-preview">${escapeHtml(data.message.text.substring(0, 50))}${data.message.text.length > 50 ? '...' : ''}</span>` : ''}
  `;

  eventLogContentEl.insertBefore(eventEl, eventLogContentEl.firstChild);

  // Keep only last 100 events
  while (eventLogContentEl.children.length > 100) {
    eventLogContentEl.removeChild(eventLogContentEl.lastChild);
  }
}

function handleNewMessage(data) {
  console.log('[WS] New message:', data);

  // Extract event data - server sends { type: 'message', event: { groupId, body } }
  const eventData = data.event || data;
  const groupId = eventData.groupId;
  const message = eventData.body?.message;

  if (!groupId || !message) return;

  // Check for duplicate message (by ID)
  const msgId = message.id;
  if (msgId && document.querySelector(`[data-msg-id="${msgId}"]`)) {
    console.log('[WS] Duplicate message ignored:', msgId);
    return;
  }

  // If this message corresponds to an optimistic send, adopt it instead of appending a duplicate.
  if (tryAdoptPendingSendFromWs(eventData, message)) {
    return;
  }

  const isCurrentChannel = selectedChannel &&
    ((groupId.type === 'space' && selectedType === 'space' && groupId.id === selectedChannel) ||
     (groupId.type === 'dm' && selectedType === 'dm' && groupId.id === selectedChannel));

  if (isCurrentChannel) {
    // Add the new message to the current view
    const msgEl = document.createElement('div');
    msgEl.className = 'message new-message';
    if (message.id) {
      msgEl.setAttribute('data-msg-id', message.id);
    }
    msgEl.innerHTML = renderMessageHTML(message);
    messagesListEl.appendChild(msgEl);

    // Check if user is near bottom of scroll
    const nearBottom = isNearBottom(messagesContainerEl, 150);

    if (nearBottom) {
      // Auto-scroll to bottom
      scrollToBottom(messagesContainerEl);
    } else {
      // Show new message indicator
      newMessageIndicatorEl.style.display = 'flex';
    }

    // Remove 'new-message' class after animation
    setTimeout(() => msgEl.classList.remove('new-message'), 2000);
  } else {
    // Message for a different channel - show unread indicator
    updateUnreadIndicator(groupId);
  }
}

function renderMessageHTML(msg) {
  const time = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const sender = msg.creator?.name || msg.creator?.email || 'Unknown';
  const text = formatMessageText(msg.text || '');
  const avatarUrl = proxyMediaUrl(msg.creator?.avatarUrl || '');

  return `
    <img class="message-avatar" src="${escapeHtml(avatarUrl || TRANSPARENT_PIXEL)}" alt="" onerror="this.style.background='var(--bg-hover)'">
    <div class="message-content">
      <div class="message-header">
        <span class="message-author">${escapeHtml(sender)}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-text">${text}</div>
    </div>
  `;
}

function handleTypingIndicator(data) {
  // Could show typing indicator in the UI
  console.log('[WS] Typing:', data);
}

function handleUserStatus(data) {
  const eventData = data.event || data;
  const userStatus = eventData.body?.userStatus;
  if (!userStatus || !userStatus.userId) return;

  const userId = userStatus.userId;

  let dmId = dmUserIdToDmId.get(userId);
  if (!dmId) {
    // Fallback: if the row has a data-user-id set, use it to recover the dmId.
    const dmItemByUserId = document.querySelector(`.channel-item[data-type="dm"][data-user-id="${userId}"]`);
    dmId = dmItemByUserId?.dataset?.id;
  }

  // Some installs use numeric DM IDs that match the other user's ID.
  if (!dmId && dms.some(dm => dm.id === userId)) {
    dmId = userId;
  }

  if (!dmId) {
    pendingUserStatusByUserId.set(userId, userStatus);
    return;
  }

  applyUserStatusUpdate(userStatus, dmId);
}

function applyUserStatusUpdate(userStatus, dmId) {
  if (!userStatus?.userId || !dmId) return;

  const userId = userStatus.userId;
  dmUserIdToDmId.set(userId, dmId);
  pendingUserStatusByUserId.delete(userId);

  const presenceLabels = {
    0: 'undefined',
    1: 'active',
    2: 'inactive',
    3: 'unknown',
    4: 'sharing_disabled',
  };
  const dndLabels = {
    0: 'unknown',
    1: 'available',
    2: 'dnd',
  };

  const presenceValue =
    typeof userStatus.presence === 'number'
      ? userStatus.presence
      : (typeof userStatus.presence === 'string' && /^\d+$/.test(userStatus.presence) ? parseInt(userStatus.presence, 10) : 0);
  const dndValue =
    typeof userStatus.dndState === 'number'
      ? userStatus.dndState
      : (typeof userStatus.dndState === 'string' && /^\d+$/.test(userStatus.dndState) ? parseInt(userStatus.dndState, 10) : 0);

  const existingPresence = dmPresenceMap.get(dmId) || { userId };
  dmPresenceMap.set(dmId, {
    ...existingPresence,
    userId,
    presence: presenceValue,
    presenceLabel: userStatus.presenceLabel || presenceLabels[presenceValue] || 'undefined',
    dndState: dndValue,
    dndLabel: userStatus.dndLabel || dndLabels[dndValue] || 'unknown',
    activeUntilUsec: userStatus.activeUntilUsec,
    customStatus: userStatus.customStatus,
  });

  // Update the presence indicator in the DOM without re-rendering everything
  const dmItem = document.querySelector(`.channel-item[data-id="${dmId}"][data-type="dm"]`);
  if (dmItem) {
    dmItem.dataset.userId = userId;
    const container = dmItem.querySelector('.dm-avatar-container');
    if (container) {
      const oldIndicator = container.querySelector('.presence-dot');
      if (oldIndicator) {
        oldIndicator.outerHTML = getPresenceIndicator(dmId);
      }
    }
  }

  console.log(`[WS] Updated presence for ${userId} (dmId=${dmId}): ${userStatus.presenceLabel} (DND: ${userStatus.dndLabel})`);
}

function updateUnreadIndicator(groupId) {
  // Find the channel in sidebar and add unread class
  const selector = `.channel-item[data-id="${groupId.id}"][data-type="${groupId.type}"]`;
  const item = document.querySelector(selector);
  if (item && !item.classList.contains('active')) {
    item.classList.add('has-new-message');
  }
}
