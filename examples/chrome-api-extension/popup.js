/**
 * Popup UI logic for Google Chat Notification Manager.
 *
 * Communicates with the background service worker via chrome.runtime.sendMessage.
 * Uses the official Google Chat REST API (no XSRF, no page injection).
 */

// ── State ───────────────────────────────────────────────────────────────────

let allItems = [];
let selectedIds = new Set();
let activeFilter = 'all'; // 'all' | 'space' | 'dm'
let searchQuery = '';
let settingsSpaceName = null; // space currently being configured
let expandedSpaces = new Map(); // spaceName -> { threads: [], loading: bool, error: string|null }
let cachedAt = 0; // timestamp when allItems were last fetched
let dmNameResolutionSupported = true;
let dmDebugToastShown = false;
let _refreshBaseItems = [];

// ── Sections state ───────────────────────────────────────────────────────────

let allSections = [];           // Array<{name, displayName, sortOrder}>
let spaceToSection = new Map(); // spaceName -> { sectionName, displayName, itemName }
let sectionsSupported = true;   // false if API not available (Developer Preview)
let activeMainTab = 'notifications'; // 'notifications' | 'sections'
let openMenuSpaceName = null;   // which item's ellipsis menu is open

// Color palette — auto-assigned by section index
const SECTION_COLORS = [
  '#4285f4', // Google blue
  '#0f9d58', // Google green
  '#db4437', // Google red
  '#f4b400', // Google yellow
  '#ab47bc', // purple
  '#00acc1', // cyan
  '#ff7043', // deep orange
  '#8d6e63', // brown
];

function getSectionColor(sectionName) {
  const idx = allSections.findIndex((s) => s.name === sectionName);
  return SECTION_COLORS[idx >= 0 ? idx % SECTION_COLORS.length : 0];
}

// ── Persistent cache ────────────────────────────────────────────────────────

const CACHE_KEY = 'popupCache';

function slimItem(item) {
  return {
    name: item.name,
    displayName: item.displayName || undefined,
    resolvedName: item.resolvedName || undefined,
    spaceType: item.spaceType,
    displayType: item.displayType,
    lastActiveTime: item.lastActiveTime || undefined,
    muteSetting: item.muteSetting || undefined,
    notificationSetting: item.notificationSetting || undefined,
    isUnread: item.isUnread,
    readState: item.readState
      ? { lastReadTime: item.readState.lastReadTime }
      : null,
  };
}

async function saveCache() {
  try {
    const slim = allItems.map(slimItem);
    await chrome.storage.local.set({
      [CACHE_KEY]: { items: slim, cachedAt: cachedAt || Date.now() },
    });
  } catch (err) {
    console.warn('[GChat] Failed to save cache:', err.message);
  }
}

async function saveMergedCache() {
  if (_pendingItems === null) return saveCache();
  try {
    const newNames = new Set(_pendingItems.map((i) => i.name));
    const merged = [..._pendingItems];
    for (const old of _refreshBaseItems) {
      if (!newNames.has(old.name)) merged.push(old);
    }
    const slim = merged.map(slimItem);
    await chrome.storage.local.set({
      [CACHE_KEY]: { items: slim, cachedAt: Date.now() },
    });
  } catch (err) {
    console.warn('[GChat] Failed to save merged cache:', err.message);
  }
}

function shouldRenderBufferedProgress(filter) {
  return _pendingItems !== null && (filter === 'dm' || activeFilter === 'dm');
}

function renderBufferedProgress() {
  if (_pendingItems === null) return;
  const newNames = new Set(_pendingItems.map((i) => i.name));
  const merged = [..._pendingItems];
  for (const old of _refreshBaseItems) {
    if (!newNames.has(old.name)) merged.push(old);
  }
  allItems = merged;
  sortItems();
  updateUI();
}

async function loadCache() {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    return result[CACHE_KEY] || null;
  } catch (err) {
    console.warn('[GChat] Failed to load cache:', err.message);
    return null;
  }
}

async function clearCache() {
  try {
    await chrome.storage.local.remove(CACHE_KEY);
  } catch (_) {}
}

function matchesScope(item, scope) {
  if (scope === 'all') return true;
  return item.displayType === scope;
}

async function clearCacheScope(scope = 'all') {
  if (activePort) {
    try { activePort.disconnect(); } catch (_) {}
    activePort = null;
  }
  _pendingItems = null;

  try {
    await sendMessage({ type: 'CLEAR_CACHE_SCOPE', scope });
  } catch (err) {
    showToast(`Failed to clear cache: ${err.message}`, 'error');
    return;
  }

  if (scope === 'all') {
    allItems = [];
    selectedIds.clear();
    expandedSpaces.clear();
    cachedAt = 0;
    await clearCache();
    updateConnectionStatus(true, 'Cache cleared');
  } else {
    allItems = allItems.filter((item) => !matchesScope(item, scope));
    selectedIds = new Set(
      [...selectedIds].filter((name) => allItems.some((item) => item.name === name)),
    );
    expandedSpaces = new Map(
      [...expandedSpaces.entries()].filter(([name]) => allItems.some((item) => item.name === name)),
    );
    cachedAt = Date.now();
    updateConnectionStatus(true, `${allItems.length} unread (cache updated)`);
    await saveCache();
  }

  updateUI();

  const scopeLabel = scope === 'all' ? 'all' : scope === 'dm' ? 'DM' : 'space';
  showToast(`Cleared ${scopeLabel} cache`);
}

// ── DOM refs ────────────────────────────────────────────────────────────────

const authOverlay      = document.getElementById('auth-overlay');
const btnSignIn        = document.getElementById('btn-sign-in');
const btnSignOut       = document.getElementById('btn-sign-out');
const statusDot        = document.getElementById('status-dot');
const statusLabel      = document.getElementById('status-label');
const btnRefresh       = document.getElementById('btn-refresh');
const selectedCountEl  = document.getElementById('selected-count');
const selectedCountText = document.getElementById('selected-count-text');
const searchInput      = document.getElementById('search-input');
const listEl           = document.getElementById('notification-list');
const toastEl          = document.getElementById('toast');
const btnClearDms      = document.getElementById('btn-clear-dms');
const btnClearSpaces   = document.getElementById('btn-clear-spaces');
const btnClearSelected = document.getElementById('btn-clear-selected');
const btnCacheAll      = document.getElementById('btn-cache-all');
const btnCacheDms      = document.getElementById('btn-cache-dms');
const btnCacheSpaces   = document.getElementById('btn-cache-spaces');
const selectAllBar     = document.getElementById('select-all-bar');
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const selectAllLabel   = document.getElementById('select-all-label');
const filterTabs       = document.querySelectorAll('.filter-tab');
const navTabs          = document.querySelectorAll('.nav-tab');
const notifPanel       = document.getElementById('notifications-panel');
const sectionsPanelEl  = document.getElementById('sections-panel');
const sectionsList     = document.getElementById('sections-list');
const sectionNameInput = document.getElementById('section-name-input');
const sectionCreateBtn = document.getElementById('section-create-btn');
const sectionsUnavailableEl = document.getElementById('sections-unavailable');
const contextMenuEl    = document.getElementById('context-menu');
const contextMenuSections = document.getElementById('context-menu-sections');
const contextMenuRemove = document.getElementById('context-menu-remove');

// Settings panel
const settingsPanel    = document.getElementById('settings-panel');
const settingsBack     = document.getElementById('settings-back');
const settingsTitle    = document.getElementById('settings-title');
const settingsNotifLevel = document.getElementById('settings-notif-level');
const settingsMuteToggle = document.getElementById('settings-mute-toggle');
const muteLabel        = document.getElementById('mute-label');
const settingsSave     = document.getElementById('settings-save');

// ── SVG icon templates ──────────────────────────────────────────────────────

const ICON_DM = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
</svg>`;

const ICON_SPACE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
</svg>`;

const ICON_BELL = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
</svg>`;

const ICON_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="9 18 15 12 9 6"/>
</svg>`;

const ICON_THREAD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  <line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="13" y2="13"/>
</svg>`;

const ICON_ELLIPSIS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
  <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
</svg>`;

// ── Background messaging ────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

// ── Space type helpers ──────────────────────────────────────────────────────

function getDisplayType(space) {
  if (space.spaceType === 'DIRECT_MESSAGE' || space.spaceType === 'GROUP_CHAT') return 'dm';
  return 'space';
}

function isGenericDmLabel(label) {
  return label === 'Direct Message' || label === 'Group Chat';
}

function needsDmResolution(item) {
  return item.displayType === 'dm' && (
    !item.resolvedName &&
    (!item.displayName || isGenericDmLabel(item.displayName))
  );
}

function getSpaceName(space) {
  if (space.resolvedName) return space.resolvedName;
  if (space.displayName) return space.displayName;
  if (space.spaceType === 'DIRECT_MESSAGE') return 'Direct Message';
  if (space.spaceType === 'GROUP_CHAT') return 'Group Chat';
  return space.name;
}

function getIcon(displayType) {
  return displayType === 'dm' ? ICON_DM : ICON_SPACE;
}

async function resolveMissingDmNames() {
  if (!dmNameResolutionSupported) return;

  const unresolved = allItems.filter((i) => needsDmResolution(i));
  if (unresolved.length === 0) return;

  try {
    const { resolved, diagnostics } = await sendMessage({
      type: 'RESOLVE_DM_NAMES',
      spaceNames: unresolved.map((i) => i.name),
    });
    if (!resolved) return;

    let changed = false;
    for (const item of unresolved) {
      if (resolved[item.name]) {
        item.resolvedName = resolved[item.name];
        changed = true;
      }
    }
    if (changed) {
      updateUI();
      saveCache();
    }
    for (const item of unresolved) {
      if (!resolved[item.name] && diagnostics?.[item.name]?.detail) {
        showDmDebugToast(item.name, diagnostics[item.name].detail);
      }
    }
  } catch (err) {
    if ((err.message || '').includes('Unknown message type: RESOLVE_DM_NAMES')) {
      dmNameResolutionSupported = false;
      return;
    }
    console.warn('[GChat] DM name resolution failed:', err.message);
  }
}

function getDisplayLabel(item) {
  const name = getSpaceName(item);
  return item.displayType === 'dm' ? `[DM] ${name}` : name;
}

function showDmDebugToast(spaceName, detail) {
  console.warn('[GChat Debug] DM name unresolved:', spaceName, detail);
  if (dmDebugToastShown) return;
  dmDebugToastShown = true;
  showToast(`DM ${spaceName.replace('spaces/', '')}: ${detail}`, 'error');
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
    items = items.filter((i) => i.displayType === activeFilter);
  }
  if (searchQuery) {
    items = items.filter((i) => fuzzyMatch(searchQuery, getSpaceName(i)));
  }
  return items;
}

// ── Section badge HTML ───────────────────────────────────────────────────────

function renderSectionBadge(item) {
  if (!sectionsSupported) return '';
  const sec = spaceToSection.get(item.name);
  if (!sec) return '';
  const color = getSectionColor(sec.sectionName);
  return `<span class="section-badge" style="background:${color}" title="${escapeHtml(sec.displayName)}">${escapeHtml(sec.displayName)}</span>`;
}

// ── Render notification list (grouped by section) ────────────────────────────

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

  // Group items by section (if sections are supported and any sections exist)
  const hasSections = sectionsSupported && allSections.length > 0;

  if (hasSections) {
    renderGroupedList(visible);
  } else {
    renderFlatList(visible);
  }
}

function buildItemHtml(item) {
  const isSelected = selectedIds.has(item.name);
  const icon = getIcon(item.displayType);
  const label = getDisplayLabel(item);
  const typeClass = `type-${item.displayType}`;
  const expanded = expandedSpaces.has(item.name);
  const expandState = expanded ? expandedSpaces.get(item.name) : null;

  let threadsHtml = '';
  if (expanded) {
    if (expandState.loading) {
      threadsHtml = `<div class="thread-list"><div class="thread-loading">Loading threads...</div></div>`;
    } else if (expandState.error) {
      threadsHtml = `<div class="thread-list"><div class="thread-error">${escapeHtml(expandState.error)}</div></div>`;
    } else if (expandState.threads.length === 0) {
      threadsHtml = `<div class="thread-list"><div class="thread-empty">No unread threads found</div></div>`;
    } else {
      const rows = expandState.threads.map((t) => {
        const time = t.latestTime ? formatRelativeTime(t.latestTime) : '';
        const sender = t.senderName ? escapeHtml(t.senderName) : '';
        const snippet = t.snippet ? escapeHtml(t.snippet) : '';
        const countBadge = t.messageCount > 1 ? `<span class="thread-count">${t.messageCount}</span>` : '';
        return `
        <div class="thread-row">
          <div class="thread-icon">${ICON_THREAD}</div>
          <div class="thread-content">
            <div class="thread-header">
              ${sender ? `<span class="thread-sender">${sender}</span>` : ''}
              ${countBadge}
              ${time ? `<span class="thread-time">${time}</span>` : ''}
            </div>
            <div class="thread-snippet">${snippet}</div>
          </div>
        </div>`;
      }).join('');
      threadsHtml = `<div class="thread-list">${rows}</div>`;
    }
  }

  const sectionBadge = renderSectionBadge(item);
  const inSection = spaceToSection.has(item.name);
  const ellipsisBtn = sectionsSupported
    ? `<button class="notif-ellipsis-btn" data-name="${escapeAttr(item.name)}" title="Section options">${ICON_ELLIPSIS}</button>`
    : '';

  return `
  <div class="notif-item-wrapper${expanded ? ' expanded' : ''}">
    <div class="notif-item ${typeClass}${isSelected ? ' selected' : ''}" data-name="${escapeAttr(item.name)}">
      <button class="notif-expand-btn${expanded ? ' expanded' : ''}" data-name="${escapeAttr(item.name)}" title="Show threads">
        ${ICON_CHEVRON_RIGHT}
      </button>
      <div class="notif-checkbox"></div>
      <div class="notif-icon">${icon}</div>
      <div class="notif-name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
      ${sectionBadge}
      ${item.muteSetting === 'MUTED' ? '<span class="notif-muted-badge">muted</span>' : ''}
      <button class="notif-settings-btn" data-name="${escapeAttr(item.name)}" title="Notification settings">
        ${ICON_BELL}
      </button>
      ${ellipsisBtn}
    </div>
    ${threadsHtml}
  </div>`;
}

function attachListHandlers() {
  // Selection
  listEl.querySelectorAll('.notif-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.notif-settings-btn')) return;
      if (e.target.closest('.notif-expand-btn')) return;
      if (e.target.closest('.notif-ellipsis-btn')) return;
      const name = el.dataset.name;
      if (selectedIds.has(name)) {
        selectedIds.delete(name);
      } else {
        selectedIds.add(name);
      }
      updateUI();
    });
  });

  // Expand threads
  listEl.querySelectorAll('.notif-expand-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleThreadExpansion(btn.dataset.name);
    });
  });

  // Notification settings
  listEl.querySelectorAll('.notif-settings-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNotificationSettings(btn.dataset.name);
    });
  });

  // Ellipsis / context menu
  listEl.querySelectorAll('.notif-ellipsis-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openContextMenu(btn.dataset.name, btn);
    });
  });
}

function renderFlatList(visible) {
  listEl.innerHTML = visible.map(buildItemHtml).join('');
  attachListHandlers();
}

function renderGroupedList(visible) {
  // Build groups: custom sections in sortOrder, then an "Other" group for unsectioned
  const groups = new Map(); // sectionName|'__other__' -> { header, items[] }

  // Initialize section groups in order
  for (const sec of allSections) {
    groups.set(sec.name, { section: sec, items: [] });
  }
  groups.set('__other__', { section: null, items: [] });

  for (const item of visible) {
    const sec = spaceToSection.get(item.name);
    const key = sec ? sec.sectionName : '__other__';
    if (!groups.has(key)) groups.set('__other__', { section: null, items: [] });
    const group = groups.get(key) || groups.get('__other__');
    group.items.push(item);
  }

  let html = '';
  for (const [key, group] of groups) {
    if (group.items.length === 0) continue;

    if (key === '__other__') {
      // Unsectioned — render without a header if there are also sectioned items,
      // or with no header at all if everything is unsectioned
      const hasSectionedItems = [...groups.entries()].some(
        ([k, g]) => k !== '__other__' && g.items.length > 0,
      );
      if (hasSectionedItems) {
        html += `<div class="notif-group-header notif-group-other">
          <span class="notif-group-dot" style="background:var(--text-dim)"></span>
          <span class="notif-group-name">Other</span>
          <span class="notif-group-count">${group.items.length}</span>
        </div>`;
      }
    } else {
      const color = getSectionColor(key);
      html += `<div class="notif-group-header">
        <span class="notif-group-dot" style="background:${color}"></span>
        <span class="notif-group-name">${escapeHtml(group.section.displayName)}</span>
        <span class="notif-group-count">${group.items.length}</span>
      </div>`;
    }

    html += group.items.map(buildItemHtml).join('');
  }

  listEl.innerHTML = html;
  attachListHandlers();
}

// ── Thread expansion ────────────────────────────────────────────────────────

async function toggleThreadExpansion(spaceName) {
  if (expandedSpaces.has(spaceName)) {
    expandedSpaces.delete(spaceName);
    updateUI();
    return;
  }

  const item = allItems.find((i) => i.name === spaceName);
  const sinceTime = item?.readState?.lastReadTime || null;

  expandedSpaces.set(spaceName, { threads: [], loading: true, error: null });
  updateUI();

  try {
    const { threads } = await sendMessage({
      type: 'GET_UNREAD_THREADS',
      spaceName,
      sinceTime,
    });
    expandedSpaces.set(spaceName, { threads, loading: false, error: null });
  } catch (err) {
    expandedSpaces.set(spaceName, {
      threads: [],
      loading: false,
      error: err.message || 'Failed to load threads',
    });
  }

  updateUI();
}

// ── Context menu (ellipsis) ──────────────────────────────────────────────────

function openContextMenu(spaceName, anchorEl) {
  // Close if already open for the same item
  if (openMenuSpaceName === spaceName) {
    closeContextMenu();
    return;
  }

  openMenuSpaceName = spaceName;

  // Populate sections
  const inSection = spaceToSection.get(spaceName);

  let sectionsHtml = '';
  if (allSections.length === 0) {
    sectionsHtml = `<div class="context-menu-empty">No custom sections yet.<br>Create one in the Sections tab.</div>`;
  } else {
    sectionsHtml = allSections.map((sec) => {
      const color = getSectionColor(sec.name);
      const isCurrent = inSection?.sectionName === sec.name;
      return `<button class="context-menu-item${isCurrent ? ' context-menu-item-current' : ''}"
        data-section="${escapeAttr(sec.name)}"
        data-label="${escapeAttr(sec.displayName)}">
        <span class="context-menu-dot" style="background:${color}"></span>
        ${escapeHtml(sec.displayName)}
        ${isCurrent ? '<span class="context-menu-check">&#10003;</span>' : ''}
      </button>`;
    }).join('');
  }
  contextMenuSections.innerHTML = sectionsHtml;

  // Show/hide "Remove from section"
  contextMenuRemove.style.display = inSection ? 'flex' : 'none';

  // Position menu near anchor
  contextMenuEl.style.display = 'block';
  const rect = anchorEl.getBoundingClientRect();
  const menuW = contextMenuEl.offsetWidth || 180;
  const menuH = contextMenuEl.offsetHeight || 120;
  const bodyW = document.body.offsetWidth;
  const bodyH = document.body.offsetHeight;

  let left = rect.right - menuW;
  let top = rect.bottom + 4;

  if (left < 4) left = 4;
  if (left + menuW > bodyW - 4) left = bodyW - menuW - 4;
  if (top + menuH > bodyH - 4) top = rect.top - menuH - 4;

  contextMenuEl.style.left = `${left}px`;
  contextMenuEl.style.top = `${top}px`;

  // Section item clicks
  contextMenuEl.querySelectorAll('[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleMoveToSection(spaceName, btn.dataset.section, btn.dataset.label);
    });
  });
}

function closeContextMenu() {
  openMenuSpaceName = null;
  contextMenuEl.style.display = 'none';
  contextMenuSections.innerHTML = '';
}

async function handleMoveToSection(spaceName, targetSectionName, sectionDisplayName) {
  closeContextMenu();
  showToast(`Moving to "${sectionDisplayName}"...`);
  try {
    const result = await sendMessage({
      type: 'MOVE_TO_SECTION',
      spaceName,
      targetSectionName,
    });
    // Update local sections state from response
    applyRemoteSectionsUpdate(result);
    showToast(`Moved to "${sectionDisplayName}"`);
    updateUI();
  } catch (err) {
    showToast(`Failed to move: ${err.message}`, 'error');
  }
}

async function handleRemoveFromSection(spaceName) {
  closeContextMenu();
  const sec = spaceToSection.get(spaceName);
  const label = sec?.displayName || 'section';
  showToast(`Removing from "${label}"...`);
  try {
    const result = await sendMessage({ type: 'REMOVE_FROM_SECTION', spaceName });
    applyRemoteSectionsUpdate(result);
    showToast(`Removed from "${label}"`);
    updateUI();
  } catch (err) {
    showToast(`Failed to remove: ${err.message}`, 'error');
  }
}

function applyRemoteSectionsUpdate(result) {
  if (!result) return;
  if (result.sections !== undefined) {
    allSections = result.sections;
  }
  if (result.spaceToSection !== undefined) {
    spaceToSection.clear();
    for (const [k, v] of Object.entries(result.spaceToSection)) {
      spaceToSection.set(k, v);
    }
  }
  if (result.sectionsSupported !== undefined) {
    sectionsSupported = result.sectionsSupported;
  }
}

// ── Context menu close on outside click ─────────────────────────────────────

document.addEventListener('click', (e) => {
  if (openMenuSpaceName && !contextMenuEl.contains(e.target)) {
    closeContextMenu();
  }
});

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

  const visibleNames = visible.map((i) => i.name);
  const selectedVisible = visibleNames.filter((n) => selectedIds.has(n)).length;

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
  btnClearDms.disabled = !allItems.some((i) => i.displayType === 'dm');
  btnClearSpaces.disabled = !allItems.some((i) => i.displayType === 'space');
  btnCacheAll.disabled = allItems.length === 0;
  btnCacheDms.disabled = !allItems.some((i) => i.displayType === 'dm');
  btnCacheSpaces.disabled = !allItems.some((i) => i.displayType === 'space');
}

function updateConnectionStatus(connected, label) {
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

// ── Per-item visual feedback ────────────────────────────────────────────────

function setItemState(spaceName, state) {
  const el = listEl.querySelector(`.notif-item[data-name="${CSS.escape(spaceName)}"]`);
  if (!el) return;
  el.classList.remove('clearing', 'cleared', 'clear-failed');
  if (state) el.classList.add(state);
}

function setItemsState(names, state) {
  for (const n of names) setItemState(n, state);
}

// ── Bulk mark-as-read ───────────────────────────────────────────────────────

async function bulkMarkRead(spaceNames, { onItemDone, onItemFail } = {}) {
  const items = allItems.filter((i) => spaceNames.has(i.name));
  if (items.length === 0) return { done: 0, failed: 0, clearedNames: new Set() };

  const CONCURRENCY = 5;
  let done = 0;
  let failed = 0;
  const clearedNames = new Set();

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        try {
          await sendMessage({ type: 'MARK_AS_READ', spaceName: item.name });
          clearedNames.add(item.name);
          if (onItemDone) onItemDone(item);
        } catch (err) {
          if (onItemFail) onItemFail(item, err);
          throw err;
        }
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') done++;
      else failed++;
    }
  }

  return { done, failed, clearedNames };
}

function removeClearedItems(clearedNames) {
  if (clearedNames.size === 0) return;
  setTimeout(() => {
    allItems = allItems.filter((i) => !clearedNames.has(i.name));
    for (const n of clearedNames) {
      selectedIds.delete(n);
      expandedSpaces.delete(n);
    }
    updateConnectionStatus(true, `${allItems.length} unread`);
    updateUI();
    saveCache();
  }, 600);
}

// ── Notification settings panel ─────────────────────────────────────────────

let currentMuteState = false;

async function openNotificationSettings(spaceName) {
  settingsSpaceName = spaceName;
  const item = allItems.find((i) => i.name === spaceName);
  settingsTitle.textContent = item ? getSpaceName(item) : 'Settings';

  settingsPanel.style.display = 'flex';
  listEl.style.display = 'none';
  document.querySelector('.search-container').style.display = 'none';
  selectAllBar.style.display = 'none';
  document.querySelector('.footer').style.display = 'none';

  try {
    const { setting } = await sendMessage({
      type: 'GET_NOTIFICATION_SETTING',
      spaceName,
    });
    settingsNotifLevel.value = setting.notificationSetting || 'ALL';
    currentMuteState = setting.muteSetting === 'MUTED';
    updateMuteToggle();
  } catch (err) {
    showToast(`Failed to load settings: ${err.message}`, 'error');
    closeNotificationSettings();
  }
}

function closeNotificationSettings() {
  settingsSpaceName = null;
  settingsPanel.style.display = 'none';
  listEl.style.display = '';
  document.querySelector('.search-container').style.display = '';
  document.querySelector('.footer').style.display = '';
  updateUI();
}

function updateMuteToggle() {
  settingsMuteToggle.classList.toggle('active', currentMuteState);
  muteLabel.textContent = currentMuteState ? 'Muted' : 'Unmuted';
}

settingsBack.addEventListener('click', closeNotificationSettings);

settingsMuteToggle.addEventListener('click', () => {
  currentMuteState = !currentMuteState;
  updateMuteToggle();
});

settingsSave.addEventListener('click', async () => {
  if (!settingsSpaceName) return;
  settingsSave.disabled = true;
  settingsSave.textContent = 'Saving...';
  try {
    await sendMessage({
      type: 'UPDATE_NOTIFICATION_SETTING',
      spaceName: settingsSpaceName,
      settings: {
        notificationSetting: settingsNotifLevel.value,
        muteSetting: currentMuteState ? 'MUTED' : 'UNMUTED',
      },
    });
    showToast('Settings saved');
    closeNotificationSettings();
  } catch (err) {
    showToast(`Failed to save: ${err.message}`, 'error');
  } finally {
    settingsSave.disabled = false;
    settingsSave.textContent = 'Save Settings';
  }
});

// ── Sections tab ─────────────────────────────────────────────────────────────

async function loadSectionsData() {
  try {
    const result = await sendMessage({ type: 'GET_SECTIONS_WITH_ITEMS' });
    applyRemoteSectionsUpdate(result);
  } catch (err) {
    console.warn('[GChat] Failed to load sections:', err.message);
    sectionsSupported = false;
  }
}

function renderSectionsTab() {
  if (!sectionsSupported) {
    sectionsList.style.display = 'none';
    document.querySelector('.section-create-area').style.display = 'none';
    sectionsUnavailableEl.style.display = 'flex';
    return;
  }

  sectionsUnavailableEl.style.display = 'none';
  document.querySelector('.section-create-area').style.display = 'block';
  sectionsList.style.display = 'block';

  if (allSections.length === 0) {
    sectionsList.innerHTML = `
      <div class="empty-state" style="padding: 32px 20px">
        <div class="title">No custom sections</div>
        <div class="subtitle">Create a section above to organise your spaces and DMs</div>
      </div>`;
    return;
  }

  sectionsList.innerHTML = allSections.map((sec) => {
    const color = getSectionColor(sec.name);
    // Count how many (potentially all) spaces are in this section
    let itemCount = 0;
    for (const [, v] of spaceToSection) {
      if (v.sectionName === sec.name) itemCount++;
    }
    return `
    <div class="section-card" data-section="${escapeAttr(sec.name)}">
      <div class="section-card-left">
        <span class="section-card-dot" style="background:${color}"></span>
        <div class="section-card-info">
          <span class="section-card-name" id="section-name-${escapeAttr(sec.name)}">${escapeHtml(sec.displayName)}</span>
          <span class="section-card-count">${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="section-card-actions">
        <button class="section-card-btn section-edit-btn" data-section="${escapeAttr(sec.name)}" data-name="${escapeAttr(sec.displayName)}" title="Rename">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="section-card-btn section-delete-btn" data-section="${escapeAttr(sec.name)}" data-name="${escapeAttr(sec.displayName)}" title="Delete">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>`;
  }).join('');

  // Attach handlers
  sectionsList.querySelectorAll('.section-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => startEditSection(btn.dataset.section, btn.dataset.name));
  });
  sectionsList.querySelectorAll('.section-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => confirmDeleteSection(btn.dataset.section, btn.dataset.name));
  });
}

function startEditSection(sectionName, currentName) {
  const card = sectionsList.querySelector(`.section-card[data-section="${CSS.escape(sectionName)}"]`);
  if (!card) return;

  const nameEl = card.querySelector('.section-card-name');
  const actionsEl = card.querySelector('.section-card-actions');

  // Replace name + actions with inline edit form
  const oldHtml = nameEl.outerHTML;
  nameEl.outerHTML = `<input class="section-inline-input" id="edit-input-${escapeAttr(sectionName)}" value="${escapeAttr(currentName)}" maxlength="80" />`;

  actionsEl.innerHTML = `
    <button class="section-card-btn section-save-btn" data-section="${escapeAttr(sectionName)}" title="Save">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </button>
    <button class="section-card-btn section-cancel-btn" title="Cancel">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>`;

  const input = card.querySelector(`#edit-input-${CSS.escape(sectionName)}`);
  input?.focus();
  input?.select();

  card.querySelector('.section-save-btn').addEventListener('click', () => {
    const newName = input?.value?.trim();
    if (newName) saveEditSection(sectionName, newName);
    else renderSectionsTab(); // cancel if empty
  });

  card.querySelector('.section-cancel-btn').addEventListener('click', () => renderSectionsTab());

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const newName = input.value.trim();
      if (newName) saveEditSection(sectionName, newName);
      else renderSectionsTab();
    }
    if (e.key === 'Escape') renderSectionsTab();
  });
}

async function saveEditSection(sectionName, newDisplayName) {
  try {
    await sendMessage({ type: 'UPDATE_SECTION', sectionName, displayName: newDisplayName });
    // Update local allSections
    const sec = allSections.find((s) => s.name === sectionName);
    if (sec) sec.displayName = newDisplayName;
    // Also update spaceToSection
    for (const [k, v] of spaceToSection) {
      if (v.sectionName === sectionName) v.displayName = newDisplayName;
    }
    showToast(`Renamed to "${newDisplayName}"`);
    renderSectionsTab();
    // Re-render the list to update badges
    if (activeMainTab === 'notifications') updateUI();
  } catch (err) {
    showToast(`Failed to rename: ${err.message}`, 'error');
    renderSectionsTab();
  }
}

async function confirmDeleteSection(sectionName, displayName) {
  // Show inline confirmation in the card
  const card = sectionsList.querySelector(`.section-card[data-section="${CSS.escape(sectionName)}"]`);
  if (!card) return;

  card.innerHTML = `
    <div class="section-confirm-delete">
      <span class="section-confirm-text">Delete "<strong>${escapeHtml(displayName)}</strong>"?</span>
      <div class="section-confirm-actions">
        <button class="btn btn-danger-sm section-confirm-yes" data-section="${escapeAttr(sectionName)}" data-name="${escapeAttr(displayName)}">Delete</button>
        <button class="btn section-confirm-no" style="font-size:11px;padding:4px 8px">Cancel</button>
      </div>
    </div>`;

  card.querySelector('.section-confirm-yes').addEventListener('click', () => doDeleteSection(sectionName, displayName));
  card.querySelector('.section-confirm-no').addEventListener('click', () => renderSectionsTab());
}

async function doDeleteSection(sectionName, displayName) {
  try {
    const result = await sendMessage({ type: 'DELETE_SECTION', sectionName });
    applyRemoteSectionsUpdate(result);
    showToast(`Deleted "${displayName}"`);
    renderSectionsTab();
    if (activeMainTab === 'notifications') updateUI();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
    renderSectionsTab();
  }
}

sectionCreateBtn.addEventListener('click', async () => {
  const name = sectionNameInput.value.trim();
  if (!name) { sectionNameInput.focus(); return; }

  sectionCreateBtn.disabled = true;
  sectionCreateBtn.textContent = 'Creating...';
  try {
    const result = await sendMessage({ type: 'CREATE_SECTION', displayName: name });
    applyRemoteSectionsUpdate(result);
    sectionNameInput.value = '';
    showToast(`Section "${name}" created`);
    renderSectionsTab();
    if (activeMainTab === 'notifications') updateUI();
  } catch (err) {
    showToast(`Failed to create: ${err.message}`, 'error');
  } finally {
    sectionCreateBtn.disabled = false;
    sectionCreateBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Create`;
  }
});

sectionNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sectionCreateBtn.click();
});

contextMenuRemove.addEventListener('click', () => {
  if (openMenuSpaceName) handleRemoveFromSection(openMenuSpaceName);
});

// ── Tab navigation ───────────────────────────────────────────────────────────

navTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    navTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    activeMainTab = tab.dataset.tab;

    if (activeMainTab === 'notifications') {
      notifPanel.style.display = '';
      sectionsPanelEl.style.display = 'none';
    } else {
      notifPanel.style.display = 'none';
      sectionsPanelEl.style.display = 'flex';
      renderSectionsTab();
    }
  });
});

// ── Load notifications (streaming) ──────────────────────────────────────────

let activePort = null;

function sortItems() {
  const notifPriority = { ALL: 0, MAIN_CONVERSATIONS: 1, FOR_YOU: 2, OFF: 3 };

  allItems.sort((a, b) => {
    // Section-aware sort: items with sections come before unsectioned, sorted by section order
    const aSection = spaceToSection.get(a.name);
    const bSection = spaceToSection.get(b.name);
    if (aSection && !bSection) return -1;
    if (!aSection && bSection) return 1;
    if (aSection && bSection && aSection.sectionName !== bSection.sectionName) {
      const aIdx = allSections.findIndex((s) => s.name === aSection.sectionName);
      const bIdx = allSections.findIndex((s) => s.name === bSection.sectionName);
      return aIdx - bIdx;
    }

    // Within same section (or both unsectioned): DMs first
    const typeOrder = { dm: 0, space: 1 };
    const ta = typeOrder[a.displayType] ?? 1;
    const tb = typeOrder[b.displayType] ?? 1;
    if (ta !== tb) return ta - tb;

    // Muted items sink
    const aMuted = a.muteSetting === 'MUTED' ? 1 : 0;
    const bMuted = b.muteSetting === 'MUTED' ? 1 : 0;
    if (aMuted !== bMuted) return aMuted - bMuted;

    // Notification level
    const aPri = notifPriority[a.notificationSetting] ?? 0;
    const bPri = notifPriority[b.notificationSetting] ?? 0;
    if (aPri !== bPri) return aPri - bPri;

    // Most recently active first
    const timeA = a.lastActiveTime ? new Date(a.lastActiveTime).getTime() : 0;
    const timeB = b.lastActiveTime ? new Date(b.lastActiveTime).getTime() : 0;
    return timeB - timeA;
  });
}

let _pendingItems = null;

function loadNotifications(filter = 'all') {
  if (activePort) {
    try { activePort.disconnect(); } catch (_) {}
    _pendingItems = null;
  }

  const isPartial = filter !== 'all';
  const filterLabel = filter === 'dm' ? 'DMs' : filter === 'space' ? 'spaces' : 'spaces';
  dmDebugToastShown = false;

  const hasExistingData = allItems.length > 0;
  _refreshBaseItems = [...allItems];

  if (hasExistingData) {
    _pendingItems = isPartial
      ? allItems.filter((i) => i.displayType !== filter)
      : [];
    updateConnectionStatus(true, `Refreshing ${filterLabel}...`);
  } else {
    _pendingItems = null;
    selectedIds.clear();
    expandedSpaces.clear();
    listEl.innerHTML = '<div class="loading-spinner"></div>';
    updateConnectionStatus(true, `Loading ${filterLabel}...`);
  }

  let totalToCheck = 0;

  const port = chrome.runtime.connect({ name: 'spaces-stream' });
  activePort = port;

  port.onMessage.addListener((msg) => {
    const isBuffered = _pendingItems !== null;
    const target = isBuffered ? _pendingItems : allItems;

    switch (msg.type) {
      case 'TOTAL':
        totalToCheck = msg.total;
        updateConnectionStatus(true, `${isBuffered ? 'Refreshing' : 'Checking'} 0/${totalToCheck} ${filterLabel}...`);
        break;

      case 'BATCH': {
        const newItems = msg.spaces.map((s) => ({
          ...s,
          displayType: getDisplayType(s),
        }));
        target.push(...newItems);
        updateConnectionStatus(true, `${isBuffered ? 'Refreshing' : 'Checking'} ${msg.checked}/${totalToCheck} ${filterLabel}...`);
        if (!isBuffered) {
          sortItems();
          updateUI();
          cachedAt = Date.now();
          saveCache();
        } else {
          if (shouldRenderBufferedProgress(filter)) renderBufferedProgress();
          saveMergedCache();
        }
        break;
      }

      case 'FETCHING_SETTINGS': {
        const count = isBuffered ? _pendingItems.length : allItems.length;
        updateConnectionStatus(true, `${count} unread — checking priorities...`);
        break;
      }

      case 'NOTIF_SETTING': {
        const item = target.find((i) => i.name === msg.spaceName);
        if (item) {
          item.muteSetting = msg.muteSetting;
          item.notificationSetting = msg.notificationSetting;
          if (isBuffered) {
            if (shouldRenderBufferedProgress(filter)) renderBufferedProgress();
            saveMergedCache();
          }
        }
        break;
      }

      case 'RESOLVING_NAMES': {
        const count = isBuffered ? _pendingItems.length : allItems.length;
        updateConnectionStatus(true, `${count} unread — resolving names...`);
        break;
      }

      case 'DM_NAME': {
        const item = target.find((i) => i.name === msg.spaceName);
        if (item) {
          item.resolvedName = msg.resolvedName;
          if (!isBuffered) updateUI();
          else {
            if (shouldRenderBufferedProgress(filter)) renderBufferedProgress();
            saveMergedCache();
          }
        }
        break;
      }

      case 'DM_NAME_DEBUG': {
        showDmDebugToast(msg.spaceName, msg.detail || `source=${msg.source || 'unknown'}`);
        break;
      }

      case 'DONE': {
        if (isBuffered) {
          allItems = _pendingItems;
          _pendingItems = null;
        }
        sortItems();

        const currentNames = new Set(allItems.map((i) => i.name));
        for (const n of [...selectedIds]) {
          if (!currentNames.has(n)) selectedIds.delete(n);
        }
        for (const n of expandedSpaces.keys()) {
          if (!currentNames.has(n)) expandedSpaces.delete(n);
        }

        cachedAt = Date.now();
        updateConnectionStatus(true, `${allItems.length} unread`);
        updateUI();
        saveCache();
        activePort = null;
        break;
      }

      case 'ERROR':
        console.error('Stream error:', msg.error);
        if (isBuffered) {
          _pendingItems = null;
          updateConnectionStatus(false, 'Refresh failed');
          showToast(msg.error, 'error');
        } else {
          updateConnectionStatus(false, 'Error');
          listEl.innerHTML = `
            <div class="empty-state">
              <div class="icon">&#9888;</div>
              <div class="title">Failed to load</div>
              <div class="subtitle">${escapeHtml(msg.error)}</div>
            </div>`;
        }
        activePort = null;
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    activePort = null;
    if (_pendingItems !== null) {
      const newNames = new Set(_pendingItems.map((i) => i.name));
      for (const old of _refreshBaseItems) {
        if (!newNames.has(old.name)) _pendingItems.push(old);
      }
      allItems = _pendingItems;
      _pendingItems = null;
      sortItems();
      cachedAt = Date.now();
      updateConnectionStatus(true, `${allItems.length} unread`);
      updateUI();
      saveCache();
    } else if (allItems.length > 0) {
      cachedAt = Date.now();
      saveCache();
    }
  });

  port.postMessage({ type: 'START_STREAM', filter });
}

async function refreshNotifications() {
  try {
    await sendMessage({ type: 'INVALIDATE_CACHE' });
  } catch (err) {
    console.warn('[GChat] Failed to invalidate background cache before refresh:', err.message);
  }
  loadNotifications('all');
}

// ── Escape helpers ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;');
}

function formatRelativeTime(isoTime) {
  const now = Date.now();
  const then = new Date(isoTime).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(isoTime).toLocaleDateString();
}

// ── Event handlers ──────────────────────────────────────────────────────────

filterTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    filterTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    activeFilter = tab.dataset.filter;
    updateUI();
  });
});

selectAllBar.addEventListener('click', () => {
  const visible = getVisibleItems();
  const visibleNames = visible.map((i) => i.name);
  const allSelected = visibleNames.every((n) => selectedIds.has(n));
  if (allSelected) {
    visibleNames.forEach((n) => selectedIds.delete(n));
  } else {
    visibleNames.forEach((n) => selectedIds.add(n));
  }
  updateUI();
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  updateUI();
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.classList.add('spinning');
  refreshNotifications();
  const checkDone = setInterval(() => {
    if (!activePort) {
      btnRefresh.classList.remove('spinning');
      clearInterval(checkDone);
    }
  }, 500);
});

btnCacheAll.addEventListener('click', async () => { await clearCacheScope('all'); });
btnCacheDms.addEventListener('click', async () => { await clearCacheScope('dm'); });
btnCacheSpaces.addEventListener('click', async () => { await clearCacheScope('space'); });

btnClearDms.addEventListener('click', async () => {
  const names = new Set(allItems.filter((i) => i.displayType === 'dm').map((i) => i.name));
  if (names.size === 0) return;
  btnClearDms.disabled = true;
  setItemsState(names, 'clearing');
  showToast(`Clearing ${names.size} DM(s)...`);
  const { done, failed, clearedNames } = await bulkMarkRead(names, {
    onItemDone: (item) => setItemState(item.name, 'cleared'),
    onItemFail: (item) => setItemState(item.name, 'clear-failed'),
  });
  showToast(
    failed > 0 ? `Cleared ${done}, ${failed} failed` : `Cleared ${done} DM(s)`,
    failed > 0 ? 'error' : 'success',
  );
  removeClearedItems(clearedNames);
});

btnClearSpaces.addEventListener('click', async () => {
  const names = new Set(allItems.filter((i) => i.displayType === 'space').map((i) => i.name));
  if (names.size === 0) return;
  btnClearSpaces.disabled = true;
  setItemsState(names, 'clearing');
  showToast(`Clearing ${names.size} space(s)...`);
  const { done, failed, clearedNames } = await bulkMarkRead(names, {
    onItemDone: (item) => setItemState(item.name, 'cleared'),
    onItemFail: (item) => setItemState(item.name, 'clear-failed'),
  });
  showToast(
    failed > 0 ? `Cleared ${done}, ${failed} failed` : `Cleared ${done} space(s)`,
    failed > 0 ? 'error' : 'success',
  );
  removeClearedItems(clearedNames);
});

btnClearSelected.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  const names = new Set(selectedIds);
  const count = names.size;
  btnClearSelected.disabled = true;
  setItemsState(names, 'clearing');
  showToast(`Clearing ${count} notification(s)...`);
  const { done, failed, clearedNames } = await bulkMarkRead(names, {
    onItemDone: (item) => setItemState(item.name, 'cleared'),
    onItemFail: (item) => setItemState(item.name, 'clear-failed'),
  });
  selectedIds.clear();
  showToast(
    failed > 0 ? `Cleared ${done}, ${failed} failed` : `Cleared ${done} notification(s)`,
    failed > 0 ? 'error' : 'success',
  );
  removeClearedItems(clearedNames);
});

btnSignIn.addEventListener('click', async () => {
  btnSignIn.disabled = true;
  btnSignIn.textContent = 'Signing in...';
  try {
    await sendMessage({ type: 'SIGN_IN' });
    authOverlay.style.display = 'none';
    loadNotifications();
    loadSectionsData();
  } catch (err) {
    showToast(`Sign in failed: ${err.message}`, 'error');
  } finally {
    btnSignIn.disabled = false;
    btnSignIn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg> Sign in with Google`;
  }
});

btnSignOut.addEventListener('click', async () => {
  await sendMessage({ type: 'SIGN_OUT' });
  allItems = [];
  allSections = [];
  spaceToSection.clear();
  selectedIds.clear();
  expandedSpaces.clear();
  cachedAt = 0;
  clearCache();
  authOverlay.style.display = 'flex';
  listEl.innerHTML = '';
  updateConnectionStatus(false, 'Signed out');
  showToast('Signed out');
});

// ── Initialize ──────────────────────────────────────────────────────────────

async function init() {
  try {
    const { isAuthenticated } = await sendMessage({ type: 'GET_AUTH_STATE' });

    if (!isAuthenticated) {
      authOverlay.style.display = 'flex';
      updateConnectionStatus(false, 'Not signed in');
      listEl.innerHTML = '';
      return;
    }

    authOverlay.style.display = 'none';

    // Load sections in parallel with restoring from cache — non-blocking
    const sectionsPromise = loadSectionsData();

    const cached = await loadCache();
    if (cached && cached.items !== undefined && cached.cachedAt) {
      allItems = cached.items;
      cachedAt = cached.cachedAt;
      sortItems();
      const ago = formatRelativeTime(new Date(cachedAt).toISOString());
      const count = allItems.length;
      updateConnectionStatus(true, `${count} unread (cached ${ago})`);
      updateUI();
      resolveMissingDmNames();
      refreshNotifications();
    } else {
      loadNotifications();
    }

    // Wait for sections to finish then re-render badges
    sectionsPromise.then(() => {
      sortItems(); // resort with section info
      updateUI();
    });

  } catch (err) {
    updateConnectionStatus(false, 'Error');
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9888;</div>
        <div class="title">Error</div>
        <div class="subtitle">${escapeHtml(err.message)}</div>
      </div>`;
  }
}

init();
