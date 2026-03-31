/**
 * Background service worker for Google Chat Notification Manager.
 *
 * Handles all communication between the popup and the API layer.
 * Primary data comes from the official REST API; DM name resolution can fall
 * back to the Chat web client payload when the REST API omits user names.
 *
 * Uses two communication channels:
 *   - chrome.runtime.onMessage   — one-shot requests (auth, mark-read, settings)
 *   - chrome.runtime.onConnect   — port-based streaming (space loading)
 *
 * Caching strategy:
 *   - Spaces list, read states, and DM names are cached in memory after the
 *     initial stream.  Browsing / filtering in the popup reads from cache.
 *   - Mutations (mark-as-read, settings change) invalidate the affected cache
 *     entry and the popup optimistically removes the item.
 *   - Thread expansion always fetches fresh data (on-demand).
 *   - The refresh button sends INVALIDATE_CACHE then re-streams.
 */

import { getAccessToken, authenticate, signOut, isAuthenticated } from './auth.js';
import * as chatApi from './chat-api.js';

// Default system section resource names (stable Google Chat constants)
const DEFAULT_SECTION_DM    = 'users/me/sections/default-direct-messages';
const DEFAULT_SECTION_SPACE = 'users/me/sections/default-spaces';
import {
  buildGetMembersRequest,
  buildPaginatedWorldRequest,
  parseMemberNames,
  parseWorldDmNames,
  stripXssi,
} from './private-api.js';

// Note: we use chrome.storage.local (not session) for persistence across browser
// restarts, so no setAccessLevel call is needed.

// ── In-memory cache ─────────────────────────────────────────────────────────
//
// Populated during streamSpaces, read by one-shot handlers.
// Persisted to chrome.storage.local so it survives service worker restarts
// and browser relaunches.

const BG_CACHE_KEY = 'bgCache';
let privateXsrfToken = null;

const cache = {
  spaces: null,           // Array — full spaces list from spaces.list
  currentUserName: null,  // string — canonical users/{id} for the authed user
  readStates: new Map(),  // spaceName -> readState object
  dmNames: new Map(),     // spaceName -> resolved display name string
  manualClears: new Map(), // spaceName -> { lastActiveTime, lastReadTime }
  notifSettings: new Map(), // spaceName -> { notificationSetting, muteSetting }

  // ── Sections ──────────────────────────────────────────────────────────────
  sections: null,              // Array<Section> — custom sections only (type=CUSTOM_SECTION)
  sectionItems: new Map(),     // sectionName -> Array<SectionItem>
  spaceToItem: new Map(),      // spaceName -> SectionItem (for fast move lookup)
  defaultSectionItems: new Map(), // sectionName -> Array<SectionItem> (lazy, default sections)
  sectionsSupported: true,     // false after first 403/404/501 on sections API
};

function invalidateCache() {
  cache.spaces = null;
  cache.currentUserName = null;
  cache.readStates.clear();
  cache.dmNames.clear();
  cache.manualClears.clear();
  cache.notifSettings.clear();
  // Do NOT reset sections here — sections are independent of the spaces stream
  chrome.storage.local.remove(BG_CACHE_KEY).catch(() => {});
}

function invalidateSectionsCache() {
  cache.sections = null;
  cache.sectionItems.clear();
  cache.spaceToItem.clear();
  cache.defaultSectionItems.clear();
}

function clearCacheScope(scope = 'all') {
  if (scope === 'all') {
    invalidateCache();
    return;
  }

  if (!cache.spaces) return;

  const keepSpace = (space) => {
    if (scope === 'dm') return !isDmSpace(space);
    if (scope === 'space') return isDmSpace(space);
    return true;
  };

  cache.spaces = cache.spaces.filter(keepSpace);
  const liveSpaceNames = new Set(cache.spaces.map((space) => space.name));
  pruneCacheMaps(liveSpaceNames);
}

/** Persist the in-memory cache to chrome.storage.local. */
async function persistCache() {
  try {
    await chrome.storage.local.set({
      [BG_CACHE_KEY]: {
        spaces: cache.spaces,
        currentUserName: cache.currentUserName,
        readStates: [...cache.readStates.entries()],
        dmNames: [...cache.dmNames.entries()],
        manualClears: [...cache.manualClears.entries()],
        notifSettings: [...cache.notifSettings.entries()],
        sections: cache.sections,
        sectionItems: [...cache.sectionItems.entries()],
        spaceToItem: [...cache.spaceToItem.entries()],
      },
    });
  } catch (err) {
    console.warn('[GChat] Failed to persist background cache:', err.message);
  }
}

/** Hydrate the in-memory cache from chrome.storage.local on startup. */
async function hydrateCache() {
  try {
    const result = await chrome.storage.local.get(BG_CACHE_KEY);
    const stored = result[BG_CACHE_KEY];
    if (!stored) return;

    cache.spaces = stored.spaces || null;
    cache.currentUserName = stored.currentUserName || null;
    if (stored.readStates) {
      for (const [k, v] of stored.readStates) cache.readStates.set(k, v);
    }
    if (stored.dmNames) {
      for (const [k, v] of stored.dmNames) cache.dmNames.set(k, v);
    }
    if (stored.manualClears) {
      for (const [k, v] of stored.manualClears) cache.manualClears.set(k, v);
    }
    if (stored.notifSettings) {
      for (const [k, v] of stored.notifSettings) cache.notifSettings.set(k, v);
    }
    if (stored.sections) {
      cache.sections = stored.sections;
    }
    if (stored.sectionItems) {
      for (const [k, v] of stored.sectionItems) cache.sectionItems.set(k, v);
    }
    if (stored.spaceToItem) {
      for (const [k, v] of stored.spaceToItem) cache.spaceToItem.set(k, v);
    }
    console.log('[GChat] Hydrated background cache:', cache.spaces?.length ?? 0, 'spaces,',
      cache.sections?.length ?? 0, 'sections');
  } catch (err) {
    console.warn('[GChat] Failed to hydrate background cache:', err.message);
  }
}

// Hydrate cache immediately on service worker start
hydrateCache();

async function findChatTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://chat.google.com/*', 'https://mail.google.com/chat/*'],
  });
  return tabs[0] || null;
}

function getPrivateChatBaseUrl(tabUrl) {
  try {
    const url = new URL(tabUrl);

    let accountPath = '/u/0';
    const accountMatch = url.pathname.match(/\/u\/\d+/);
    if (accountMatch) accountPath = accountMatch[0];

    return `https://chat.google.com${accountPath}`;
  } catch (_) {
    return 'https://chat.google.com/u/0';
  }
}

async function reinjectPrivateContentScripts(tabId) {
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
    await sleep(300);
  } catch (err) {
    throw new Error(`Failed to inject Chat helper scripts: ${err.message}`);
  }
}

async function sendMessageToChatTab(message) {
  const tab = await findChatTab();
  if (!tab) throw new Error('No Google Chat tab found. Open chat.google.com first.');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, message);
      if (!result) throw new Error('No response from content script');
      return result;
    } catch (err) {
      const isDisconnected =
        err.message?.includes('Receiving end does not exist') ||
        err.message?.includes('Could not establish connection') ||
        err.message?.includes('Extension context invalidated');

      if (isDisconnected && attempt === 0) {
        await reinjectPrivateContentScripts(tab.id);
        continue;
      }
      throw new Error(`Chat tab helper failed: ${err.message}`);
    }
  }
}

async function refreshPrivateXsrf() {
  const result = await sendMessageToChatTab({ type: 'PRIVATE_GET_XSRF' });
  if (result?.token) privateXsrfToken = result.token;
  return privateXsrfToken;
}

async function proxyPrivateApiRequest(url, method, headers, body) {
  return sendMessageToChatTab({
    type: 'PRIVATE_API_REQUEST',
    url,
    method,
    headers,
    body,
  });
}

async function resolveDmNamesViaPrivateApi(spaceNames) {
  if (!spaceNames?.length) return { resolved: {}, reason: 'no spaces requested' };

  try {
    const tab = await findChatTab();
    if (!tab?.url) {
      return { resolved: {}, reason: 'no open chat.google.com tab available' };
    }

    if (!privateXsrfToken) await refreshPrivateXsrf();
    if (!privateXsrfToken) {
      return { resolved: {}, reason: 'no Chat XSRF token captured from chat.google.com' };
    }

    const baseUrl = getPrivateChatBaseUrl(tab.url);
    const request = buildPaginatedWorldRequest(baseUrl, privateXsrfToken, Date.now());
    const response = await proxyPrivateApiRequest(
      request.url,
      request.method,
      request.headers,
      request.body,
    );
    if (!response.ok || !response.body) {
      return {
        resolved: {},
        reason: `${response.error || `private API HTTP ${response.status || 0}`} via ${baseUrl}`,
      };
    }

    const privateNames = parseWorldDmNames(JSON.parse(stripXssi(response.body)));
    const resolved = {};
    for (const spaceName of spaceNames) {
      const key = spaceName.replace('spaces/', '');
      if (privateNames[key]) resolved[spaceName] = privateNames[key];
    }
    return {
      resolved,
      reason: Object.keys(resolved).length > 0 ? null : `DM missing from paginated_world payload via ${baseUrl}`,
    };
  } catch (err) {
    console.warn('[GChat] Private DM name lookup unavailable:', err.message);
    return { resolved: {}, reason: err.message };
  }
}

function extractPrivateUserId(userName) {
  if (!userName || typeof userName !== 'string') return null;
  if (!userName.startsWith('users/')) return null;
  return userName.slice('users/'.length) || null;
}

async function resolveDmNamesViaPrivateMembers(token, spaces) {
  if (!spaces?.length) return { resolved: {}, reason: 'no spaces requested' };

  try {
    const tab = await findChatTab();
    if (!tab?.url) {
      return { resolved: {}, reason: 'no open chat.google.com tab available' };
    }

    if (!privateXsrfToken) await refreshPrivateXsrf();
    if (!privateXsrfToken) {
      return { resolved: {}, reason: 'no Chat XSRF token captured from chat.google.com' };
    }

    const baseUrl = getPrivateChatBaseUrl(tab.url);
    const currentUserId = extractPrivateUserId(cache.currentUserName);
    const membersBySpace = new Map();
    const allUserIds = new Set();

    for (const space of spaces) {
      const memberships = await chatApi.listMembers(token, space.name);
      const userIds = memberships
        .filter((membership) => membership.member?.type === 'HUMAN')
        .map((membership) => extractPrivateUserId(membership.member?.name))
        .filter(Boolean)
        .filter((userId) => userId !== currentUserId);

      membersBySpace.set(space.name, userIds);
      for (const userId of userIds) allUserIds.add(userId);
    }

    if (allUserIds.size === 0) {
      return { resolved: {}, reason: `members.list returned no other human members via ${baseUrl}` };
    }

    const nameMap = {};
    const ids = [...allUserIds];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const request = buildGetMembersRequest(baseUrl, privateXsrfToken, batch);
      const response = await proxyPrivateApiRequest(
        request.url,
        request.method,
        request.headers,
        request.body,
      );

      if (!response.ok || !response.body) {
        return {
          resolved: {},
          reason: `${response.error || `get_members HTTP ${response.status || 0}`} via ${baseUrl}`,
        };
      }

      Object.assign(nameMap, parseMemberNames(JSON.parse(stripXssi(response.body))));
    }

    const resolved = {};
    for (const space of spaces) {
      const names = (membersBySpace.get(space.name) || []).map((userId) => nameMap[userId]).filter(Boolean);
      if (names.length === 0) continue;
      resolved[space.name] = space.spaceType === 'DIRECT_MESSAGE' ? names[0] : names.slice(0, 3).join(', ');
    }

    return {
      resolved,
      reason: Object.keys(resolved).length > 0 ? null : `get_members returned no names via ${baseUrl}`,
    };
  } catch (err) {
    console.warn('[GChat] Private member lookup unavailable:', err.message);
    return { resolved: {}, reason: err.message };
  }
}

// ── One-shot message router ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'PRIVATE_XSRF_TOKEN') {
    privateXsrfToken = request.token;
    sendResponse({ ok: true });
    return false;
  }

  handleMessage(request)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(request) {
  switch (request.type) {
    case 'GET_AUTH_STATE': {
      const authed = await isAuthenticated();
      updateExtensionIcon(authed);
      return { isAuthenticated: authed };
    }

    case 'SIGN_IN': {
      await authenticate();
      updateExtensionIcon(true);
      return { ok: true };
    }

    case 'SIGN_OUT': {
      invalidateCache();
      await signOut();
      updateExtensionIcon(false);
      return { ok: true };
    }

    case 'MARK_AS_READ': {
      const token = await requireToken();
      const readState = await chatApi.markSpaceAsRead(token, request.spaceName);
      const space = cache.spaces?.find((s) => s.name === request.spaceName) || null;

      cache.readStates.set(request.spaceName, readState);

      if (space && isDmSpace(space)) {
        cache.manualClears.set(request.spaceName, {
          lastActiveTime: space.lastActiveTime || '',
          lastReadTime: readState.lastReadTime || new Date().toISOString(),
        });
      } else {
        cache.manualClears.delete(request.spaceName);
      }

      await persistCache();
      return { ok: true };
    }

    case 'GET_NOTIFICATION_SETTING': {
      const token = await requireToken();
      const setting = await chatApi.getNotificationSetting(token, request.spaceName);
      return { setting };
    }

    case 'UPDATE_NOTIFICATION_SETTING': {
      const token = await requireToken();
      const setting = await chatApi.updateNotificationSetting(
        token,
        request.spaceName,
        request.settings,
      );
      return { setting };
    }

    case 'GET_UNREAD_THREADS': {
      // Always fetch fresh — this is the on-demand refetch path
      const token = await requireToken();
      const threads = await chatApi.getUnreadThreads(
        token,
        request.spaceName,
        request.sinceTime,
      );
      return { threads };
    }

    case 'REFRESH_SPACE': {
      // Refetch read state for a single space (uses cached space metadata)
      const token = await requireToken();
      const spaceName = request.spaceName;
      const space = cache.spaces?.find((s) => s.name === spaceName);
      if (!space) throw new Error('Space not in cache — do a full refresh');

      const readState = await chatApi.getSpaceReadState(token, spaceName);
      cache.readStates.set(spaceName, readState);

      let isUnread = computeIsUnread(space, readState);
      if (isUnread === null) {
        isUnread = await verifyUnreadViaMessages(token, spaceName, readState.lastReadTime);
      }

      return {
        space: { ...space, readState, isUnread },
      };
    }

    case 'RESOLVE_DM_NAMES': {
      // Resolve display names for a list of DM spaces.
      // Returns from background cache first, falls back to API.
      // Batched with delays to avoid rate-limiting.
      const token = await requireToken();
      await ensureCurrentUserName(token);
      const spaces = (request.spaceNames || []).map((spaceName) =>
        cache.spaces?.find((space) => space.name === spaceName) || {
          name: spaceName,
          spaceType: 'DIRECT_MESSAGE',
        },
      );
      const { resolved, diagnostics } = await resolveDmNamesWithFallback(token, spaces);
      return { resolved, diagnostics };
    }

    case 'INVALIDATE_CACHE': {
      invalidateCache();
      return { ok: true };
    }

    case 'CLEAR_CACHE_SCOPE': {
      clearCacheScope(request.scope || 'all');
      await persistCache();
      return { ok: true };
    }

    // ── Sections ─────────────────────────────────────────────────────────────

    case 'GET_SECTIONS_WITH_ITEMS': {
      // Return cached if available, otherwise fetch fresh
      if (cache.sections !== null) {
        return buildSectionsResponse();
      }
      const token = await requireToken();
      await loadSectionsIntoCache(token);
      return buildSectionsResponse();
    }

    case 'RELOAD_SECTIONS': {
      // Force-refresh sections cache (called after create/update/delete)
      const token = await requireToken();
      await loadSectionsIntoCache(token);
      return buildSectionsResponse();
    }

    case 'CREATE_SECTION': {
      const token = await requireToken();
      const section = await chatApi.createSection(token, request.displayName);
      invalidateSectionsCache();
      await loadSectionsIntoCache(token);
      await persistCache();
      return { section, ...buildSectionsResponse() };
    }

    case 'UPDATE_SECTION': {
      const token = await requireToken();
      const section = await chatApi.updateSection(token, request.sectionName, request.displayName);
      // Update in-memory
      if (cache.sections) {
        const idx = cache.sections.findIndex((s) => s.name === request.sectionName);
        if (idx !== -1) cache.sections[idx] = { ...cache.sections[idx], displayName: request.displayName };
      }
      await persistCache();
      return { section };
    }

    case 'DELETE_SECTION': {
      const token = await requireToken();
      await chatApi.deleteSection(token, request.sectionName);
      invalidateSectionsCache();
      await loadSectionsIntoCache(token);
      await persistCache();
      return buildSectionsResponse();
    }

    case 'MOVE_TO_SECTION': {
      // Move spaceName to targetSectionName.
      // We need the SectionItem resource name (which section it's currently in).
      const token = await requireToken();
      const { spaceName, targetSectionName } = request;

      const itemName = await findItemNameForSpace(token, spaceName);
      if (!itemName) throw new Error(`Could not find section item for space: ${spaceName}`);

      const result = await chatApi.moveSectionItem(token, itemName, targetSectionName);

      // Update local caches
      invalidateSectionsCache();
      await loadSectionsIntoCache(token);
      await persistCache();
      return { sectionItem: result.sectionItem, ...buildSectionsResponse() };
    }

    case 'REMOVE_FROM_SECTION': {
      // Move spaceName back to the appropriate default system section.
      const token = await requireToken();
      const { spaceName } = request;

      const itemName = await findItemNameForSpace(token, spaceName);
      if (!itemName) throw new Error(`Could not find section item for space: ${spaceName}`);

      // Determine target default section based on space type
      const spaceObj = cache.spaces?.find((s) => s.name === spaceName);
      const targetSection = isDmSpace(spaceObj) ? DEFAULT_SECTION_DM : DEFAULT_SECTION_SPACE;

      const result = await chatApi.moveSectionItem(token, itemName, targetSection);

      // Update local caches
      invalidateSectionsCache();
      await loadSectionsIntoCache(token);
      await persistCache();
      return { sectionItem: result.sectionItem, ...buildSectionsResponse() };
    }

    default:
      throw new Error(`Unknown message type: ${request.type}`);
  }
}

// ── Sections helpers ─────────────────────────────────────────────────────────

/**
 * Load all custom sections and their items into cache.
 * Silently marks sectionsSupported=false on 403/404 so graceful degradation works.
 */
async function loadSectionsIntoCache(token) {
  try {
    const allSections = await chatApi.listSections(token);
    const customSections = allSections.filter((s) => s.type === 'CUSTOM_SECTION');

    cache.sections = customSections;
    cache.sectionItems.clear();
    cache.spaceToItem.clear();

    // Fetch items for each custom section (in parallel, small batches)
    const CONCURRENCY = 3;
    for (let i = 0; i < customSections.length; i += CONCURRENCY) {
      const batch = customSections.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (section) => {
          try {
            const items = await chatApi.listSectionItems(token, section.name);
            cache.sectionItems.set(section.name, items);
            for (const item of items) {
              if (item.space) cache.spaceToItem.set(item.space, item);
            }
          } catch (err) {
            console.warn('[GChat] Failed to load items for section', section.name, ':', err.message);
          }
        }),
      );
    }

    cache.sectionsSupported = true;
    console.log('[GChat] Loaded', customSections.length, 'custom sections,', cache.spaceToItem.size, 'section items');
  } catch (err) {
    const status = err.message?.match(/Chat API (\d+)/)?.[1];
    if (status === '403' || status === '404' || status === '501') {
      console.warn('[GChat] Sections API not available (Developer Preview):', err.message);
      cache.sectionsSupported = false;
      cache.sections = [];
    } else {
      throw err;
    }
  }
}

/**
 * Build the serializable sections response payload for the popup.
 * Returns { sections, spaceToSection, sectionsSupported }.
 * spaceToSection maps spaceName -> { sectionName, displayName, itemName }.
 */
function buildSectionsResponse() {
  const spaceToSection = {};
  for (const [spaceName, item] of cache.spaceToItem.entries()) {
    // Derive the section name from the item path: users/*/sections/{sectionId}/items/*
    const parts = item.name.split('/');
    const sectionIdx = parts.indexOf('sections');
    if (sectionIdx !== -1 && sectionIdx + 1 < parts.length) {
      const sectionId = parts[sectionIdx + 1];
      const sectionName = `users/me/sections/${sectionId}`;
      const section = (cache.sections || []).find((s) => s.name === sectionName);
      if (section) {
        spaceToSection[spaceName] = {
          sectionName: section.name,
          displayName: section.displayName,
          itemName: item.name,
        };
      }
    }
  }
  return {
    sections: cache.sections || [],
    spaceToSection,
    sectionsSupported: cache.sectionsSupported,
  };
}

/**
 * Find the SectionItem resource name for a given space.
 * Checks custom section cache first, then lazily loads default sections.
 *
 * @param {string} spaceName - e.g. "spaces/AAAA"
 * @returns {string|null} The item's resource name, or null if not found
 */
async function findItemNameForSpace(token, spaceName) {
  // 1. Check custom section cache
  const item = cache.spaceToItem.get(spaceName);
  if (item) return item.name;

  // 2. Try deriving item name from default sections (optimistic: item ID = space ID)
  const spaceId = spaceName.replace('spaces/', '');
  const spaceObj = cache.spaces?.find((s) => s.name === spaceName);
  const defaultSectionName = isDmSpace(spaceObj) ? DEFAULT_SECTION_DM : DEFAULT_SECTION_SPACE;
  const derivedItemName = `${defaultSectionName}/items/${spaceId}`;

  // Verify the derived name by listing the default section (cache the result)
  if (!cache.defaultSectionItems.has(defaultSectionName)) {
    try {
      const items = await chatApi.listSectionItems(token, defaultSectionName);
      cache.defaultSectionItems.set(defaultSectionName, items);
      for (const it of items) {
        if (it.space) {
          // Build a temporary lookup: spaceName -> item
          const tempKey = it.space;
          if (!cache.defaultSectionItems.has('_lookup')) {
            cache.defaultSectionItems.set('_lookup', new Map());
          }
          cache.defaultSectionItems.get('_lookup').set(tempKey, it);
        }
      }
    } catch (err) {
      console.warn('[GChat] Failed to list default section items:', err.message);
    }
  }

  const lookup = cache.defaultSectionItems.get('_lookup');
  if (lookup) {
    const found = lookup.get(spaceName);
    if (found) return found.name;
  }

  // Fallback: return derived name and let the API call fail if incorrect
  return derivedItemName;
}

// ── Shared unread detection ─────────────────────────────────────────────────

/**
 * Normalize an ISO-8601 timestamp to a consistent format with 6-digit
 * fractional seconds, so that string comparison works reliably even when
 * the API returns mixed precision (e.g. "…00Z" vs "…00.123456Z").
 *
 *   "2024-01-15T10:00:00Z"        → "2024-01-15T10:00:00.000000Z"
 *   "2024-01-15T10:00:00.123Z"    → "2024-01-15T10:00:00.123000Z"
 *   "2024-01-15T10:00:00.123456Z" → "2024-01-15T10:00:00.123456Z" (unchanged)
 */
function normalizeTimestamp(ts) {
  if (!ts) return '';
  let s = ts.replace('Z', '');
  const dot = s.indexOf('.');
  if (dot === -1) s += '.000000';
  else s = s.slice(0, dot + 1) + s.slice(dot + 1).padEnd(6, '0');
  return s + 'Z';
}

function isDmSpace(space) {
  return space?.spaceType === 'DIRECT_MESSAGE' || space?.spaceType === 'GROUP_CHAT';
}

function isGenericDmLabel(label) {
  return label === 'Direct Message' || label === 'Group Chat';
}

function needsDmResolution(space) {
  return isDmSpace(space) && (!space.displayName || isGenericDmLabel(space.displayName));
}

async function resolveDmNamesWithFallback(token, spaces) {
  const resolved = {};
  const diagnostics = {};
  if (!spaces.length) return { resolved, diagnostics };

  const unresolved = [];
  for (const space of spaces) {
    const cached = cache.dmNames.get(space.name);
    if (cached) {
      resolved[space.name] = cached;
      diagnostics[space.name] = { status: 'resolved', source: 'cache', detail: 'cached name hit' };
    } else {
      unresolved.push(space);
    }
  }

  if (unresolved.length === 0) return { resolved, diagnostics };

  const privateLookup = await resolveDmNamesViaPrivateApi(unresolved.map((space) => space.name));
  const privateResolved = privateLookup.resolved || {};
  for (const space of unresolved) {
    const name = privateResolved[space.name];
    if (!name) continue;
    cache.dmNames.set(space.name, name);
    resolved[space.name] = name;
    diagnostics[space.name] = { status: 'resolved', source: 'private-api', detail: 'resolved from paginated_world' };
    console.log('[GChat Debug] DM name resolved via private API:', space.name, '->', name);
  }

  const stillUnresolved = unresolved.filter((space) => !resolved[space.name]);
  const memberLookup = await resolveDmNamesViaPrivateMembers(token, stillUnresolved);
  const memberResolved = memberLookup.resolved || {};
  for (const space of stillUnresolved) {
    const name = memberResolved[space.name];
    if (!name) continue;
    cache.dmNames.set(space.name, name);
    resolved[space.name] = name;
    diagnostics[space.name] = { status: 'resolved', source: 'private-members', detail: 'resolved from get_members + members.list' };
    console.log('[GChat Debug] DM name resolved via private members:', space.name, '->', name);
  }

  const remaining = stillUnresolved.filter((space) => !resolved[space.name]);
  for (const space of remaining) {
    try {
      const result = await chatApi.resolveDmNameFromMessagesDetailed(token, space, cache.currentUserName);
      if (!result.name) {
        diagnostics[space.name] = {
          status: 'unresolved',
          source: 'messages',
          detail: `private=${privateLookup.reason || 'no match'}; members=${memberLookup.reason || 'no match'}; messages=${result.reason}`,
        };
        console.warn('[GChat Debug] DM name unresolved:', space.name, diagnostics[space.name].detail);
        continue;
      }
      cache.dmNames.set(space.name, result.name);
      resolved[space.name] = result.name;
      diagnostics[space.name] = {
        status: 'resolved',
        source: 'messages',
        detail: `resolved from ${result.messageCount} messages / ${result.participantCount} senders`,
      };
      console.log('[GChat Debug] DM name resolved via messages:', space.name, '->', result.name);
    } catch (err) {
      console.warn('[GChat] Failed to resolve DM name for', space.name, ':', err.message);
      diagnostics[space.name] = {
        status: 'unresolved',
        source: 'messages',
        detail: `private=${privateLookup.reason || 'no match'}; members=${memberLookup.reason || 'no match'}; messages error=${err.message}`,
      };
    }
  }

  if (Object.keys(resolved).length > 0) await persistCache();
  return { resolved, diagnostics };
}

function getManualClearOverride(space, readState) {
  if (!isDmSpace(space)) return null;

  const cleared = cache.manualClears.get(space.name);
  if (!cleared) return null;

  const currentActive = normalizeTimestamp(space.lastActiveTime);
  const clearedActive = normalizeTimestamp(cleared.lastActiveTime);
  const currentRead = normalizeTimestamp(readState?.lastReadTime);
  const clearedRead = normalizeTimestamp(cleared.lastReadTime);

  const hasNewActivity =
    (currentActive && clearedActive && currentActive > clearedActive) ||
    (!currentActive && currentRead && clearedRead && currentRead > clearedRead);

  if (hasNewActivity) {
    cache.manualClears.delete(space.name);
    return null;
  }

  const sameActivityAsClear =
    (currentActive && clearedActive && currentActive <= clearedActive) ||
    (!currentActive && currentRead && clearedRead && currentRead <= clearedRead) ||
    (currentActive && !clearedActive && currentRead && clearedRead && currentRead <= clearedRead);

  return sameActivityAsClear ? false : null;
}

function pruneCacheMaps(liveSpaceNames) {
  for (const [spaceName] of cache.readStates) {
    if (!liveSpaceNames.has(spaceName)) cache.readStates.delete(spaceName);
  }
  for (const [spaceName] of cache.dmNames) {
    if (!liveSpaceNames.has(spaceName)) cache.dmNames.delete(spaceName);
  }
  for (const [spaceName] of cache.manualClears) {
    if (!liveSpaceNames.has(spaceName)) cache.manualClears.delete(spaceName);
  }
  for (const [spaceName] of cache.notifSettings) {
    if (!liveSpaceNames.has(spaceName)) cache.notifSettings.delete(spaceName);
  }
}

/**
 * Determine whether a space is unread by comparing lastActiveTime vs lastReadTime.
 *
 * Normalizes both timestamps to 6-digit fractional seconds before comparing
 * so that mixed-precision values from different API endpoints sort correctly.
 *
 * Returns:
 *   - true  — confirmed unread
 *   - false — confirmed read
 *   - null  — ambiguous (caller should verify via messages API)
 *
 * Rules:
 *   - If lastActiveTime is missing AND never read → true (unread)
 *   - If lastActiveTime is missing AND lastReadTime exists → null (ambiguous;
 *     common for DMs where the API doesn't populate lastActiveTime)
 *   - If lastReadTime is missing or empty → never read → true (unread)
 *   - If lastActiveTime > lastReadTime (string compare) → true (unread)
 *   - If lastActiveTime < lastReadTime → false (read)
 *   - If lastActiveTime === lastReadTime (exact string match) → false (read)
 */
function computeIsUnread(space, readState) {
  const manualClearOverride = getManualClearOverride(space, readState);
  if (manualClearOverride !== null) return manualClearOverride;

  if (!space.lastActiveTime) {
    // No lastActiveTime — common for DMs where the API doesn't populate this field.
    // If never read, assume unread. If previously read, return null to signal
    // that the caller should verify via the messages API.
    if (!readState?.lastReadTime) return true;
    return null; // ambiguous — needs message-level verification
  }

  const lastActiveStr = normalizeTimestamp(space.lastActiveTime);
  const lastReadStr = normalizeTimestamp(readState?.lastReadTime);

  if (!lastReadStr) return true; // never read

  // String comparison on normalized timestamps — preserves sub-millisecond precision
  if (lastActiveStr > lastReadStr) return true;
  if (lastActiveStr < lastReadStr) return false;

  // Timestamps are exactly equal, so the latest activity is already read.
  return false;
}

/**
 * Verify unread status by checking for messages newer than lastReadTime.
 * Used when computeIsUnread() returns null (ambiguous — no lastActiveTime
 * but a lastReadTime exists).
 *
 * Fetches the most recent message in the space (orderBy desc, pageSize 1)
 * and compares its createTime against lastReadTime client-side.
 *
 * We avoid relying on the filter operator (`>` vs `>=`) because:
 *   - The Chat API only documents `>` for createTime filters
 *   - The API frequently auto-sets lastReadTime = message.createTime on
 *     delivery, so the unread message sits at exactly lastReadTime
 *   - A strict `>` filter misses it; `>=` is undocumented and unreliable
 *
 * Client-side `>=` comparison handles both cases correctly:
 *   - Auto-set lastReadTime == message time → latestMsg >= lastRead → unread ✓
 *   - Manual markAsRead(now()) → lastRead is after all messages → read ✓
 *
 * @returns {Promise<boolean>} true if unread, false if read
 */
async function verifyUnreadViaMessages(token, spaceName, lastReadTime) {
  try {
    // Use a trivial filter (all messages since epoch) because the Chat API
    // requires filter to be set when using orderBy.
    const messages = await chatApi.listMessages(token, spaceName, {
      filter: 'createTime > "1970-01-01T00:00:00Z"',
      orderBy: 'createTime desc',
      pageSize: 1,
      maxPages: 1,
    });

    if (messages.length === 0) {
      console.log('[GChat Debug] verifyUnreadViaMessages:', spaceName, '→ READ (no messages)');
      return false;
    }

    const latestMsgTime = normalizeTimestamp(messages[0].createTime);
    const lastReadNorm = normalizeTimestamp(lastReadTime);
    const hasUnread = latestMsgTime >= lastReadNorm;

    console.log('[GChat Debug] verifyUnreadViaMessages:', spaceName,
      'latestMsg:', latestMsgTime,
      'lastRead:', lastReadNorm,
      '→', hasUnread ? 'UNREAD' : 'READ');
    return hasUnread;
  } catch (err) {
    console.warn('[GChat Debug] verifyUnreadViaMessages failed for', spaceName, ':', err.message);
    return true; // assume unread on API failure
  }
}

// ── Port-based streaming for space loading ──────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'spaces-stream') return;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'START_STREAM') {
      // filter: 'all' | 'space' | 'dm'
      streamSpaces(port, msg.filter || 'all');
    }
  });
});

/**
 * Stream spaces to the popup.
 *
 * @param {chrome.runtime.Port} port
 * @param {'all'|'space'|'dm'} filter
 *   - 'all'   → full refresh: re-list all spaces, check all read states
 *   - 'space' → partial: re-list all spaces, only refetch read states for spaces
 *   - 'dm'    → partial: re-list all spaces, only refetch read states for DMs
 */
async function streamSpaces(port, filter) {
  const CONCURRENCY = 3;
  const BATCH_DELAY_MS = 200;

  function safeSend(msg) {
    try { port.postMessage(msg); } catch (_) {}
  }

  try {
    const token = await requireToken();
    await ensureCurrentUserName(token);

    // Phase 1 — get the spaces list
    const prevSpaces = cache.spaces;
    const allSpaces = await chatApi.listSpaces(token);
    cache.spaces = allSpaces;
    pruneCacheMaps(new Set(allSpaces.map((space) => space.name)));

    // Apply type filter to decide which spaces to check
    const spacesToCheck = filterSpacesByTab(allSpaces, filter);
    safeSend({ type: 'TOTAL', total: spacesToCheck.length, filter });

    // Debug: log space type breakdown so we can verify DMs are included
    const typeBreakdown = {};
    for (const s of allSpaces) {
      typeBreakdown[s.spaceType] = (typeBreakdown[s.spaceType] || 0) + 1;
    }
    console.log('[GChat Debug] spaces.list returned', allSpaces.length, 'spaces:', JSON.stringify(typeBreakdown));
    console.log('[GChat Debug] spacesToCheck (filter=' + filter + '):', spacesToCheck.length);

    // Phase 2 — fetch read states in small batches, stream unread items.
    //
    // Incremental optimisation: if we have a cached read state for a space
    // AND its lastActiveTime hasn't changed since the last fetch, skip the
    // API call and reuse the cached result.
    const prevLastActive = new Map();
    if (prevSpaces) {
      for (const s of prevSpaces) {
        if (s.lastActiveTime) prevLastActive.set(s.name, s.lastActiveTime);
      }
    }

    let checked = 0;
    let skipped = 0;
    const unreadNames = new Set(); // collected during Phase 2 for use in Phase 2.5+

    for (let i = 0; i < spacesToCheck.length; i += CONCURRENCY) {
      if (i > 0) await sleep(BATCH_DELAY_MS);

      const batch = spacesToCheck.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (space) => {
          // Can we reuse the cached read state?
          const cachedRS = cache.readStates.get(space.name);
          const prevActive = prevLastActive.get(space.name);
          const unchanged = cachedRS && prevActive && prevActive === space.lastActiveTime;

          try {
            let readState;
            if (unchanged) {
              // Space hasn't changed — skip the API call
              readState = cachedRS;
              skipped++;
            } else {
              readState = await chatApi.getSpaceReadState(token, space.name);
              cache.readStates.set(space.name, readState);
            }

            let isUnread = computeIsUnread(space, readState);

            // Ambiguous (null): DM without lastActiveTime but with lastReadTime.
            // Verify by checking for messages newer than lastReadTime.
            if (isUnread === null) {
              isUnread = await verifyUnreadViaMessages(
                token,
                space.name,
                readState.lastReadTime,
              );
            }

            // Debug: log every DM's unread decision
            if (isDmSpace(space)) {
              console.log('[GChat Debug] DM:', space.name,
                'display:', space.displayName || '(none)',
                'lastActive:', space.lastActiveTime,
                'lastRead:', readState.lastReadTime,
                '→ isUnread:', isUnread,
                unchanged ? '(cached)' : '(fetched)');
            }

            return { ...space, readState, isUnread };
          } catch (err) {
            console.warn('[GChat Debug] Failed readState for', space.name, ':', err.message);
            return { ...space, readState: null, isUnread: true };
          }
        }),
      );

      const unread = [];
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value.isUnread) {
          unread.push(r.value);
          unreadNames.add(r.value.name);
        }
      }

      checked += batch.length;
      safeSend({ type: 'BATCH', spaces: unread, checked });
    }

    if (skipped > 0) {
      console.log('[GChat Debug] Incremental refresh: skipped', skipped, '/', spacesToCheck.length, 'read-state checks (unchanged)');
    }

    // Phase 2.5 — fetch notification settings for unread spaces (for sort priority)
    // Only fetches for spaces not already cached. Streams NOTIF_SETTING messages
    // so the popup can sort muted items to the bottom.
    // Uses unreadNames collected during Phase 2 (already verified via messages API
    // for ambiguous cases) — no need to re-derive or re-check.
    safeSend({ type: 'FETCHING_SETTINGS' });

    const unreadToFetchSettings = [...unreadNames].filter(
      (name) => !cache.notifSettings.has(name),
    );

    for (let i = 0; i < unreadToFetchSettings.length; i += CONCURRENCY) {
      if (i > 0) await sleep(BATCH_DELAY_MS);
      const batch = unreadToFetchSettings.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (spaceName) => {
          try {
            const setting = await chatApi.getNotificationSetting(token, spaceName);
            cache.notifSettings.set(spaceName, setting);
            safeSend({
              type: 'NOTIF_SETTING',
              spaceName,
              muteSetting: setting.muteSetting || 'UNMUTED',
              notificationSetting: setting.notificationSetting || 'ALL',
            });
          } catch (_) {
            // Non-critical — default to unmuted
          }
        }),
      );
    }

    // Also stream cached settings for spaces we didn't need to fetch
    for (const name of unreadNames) {
      if (unreadToFetchSettings.includes(name)) continue;
      const setting = cache.notifSettings.get(name);
      if (setting) {
        safeSend({
          type: 'NOTIF_SETTING',
          spaceName: name,
          muteSetting: setting.muteSetting || 'UNMUTED',
          notificationSetting: setting.notificationSetting || 'ALL',
        });
      }
    }

    // Phase 3 — resolve DM names (only for unread DMs that the popup will display)
    if (filter === 'all' || filter === 'dm') {
      // Only resolve names for DMs that are actually unread (in unreadNames)
      const dmsToResolve = spacesToCheck.filter(
        (s) =>
          needsDmResolution(s) &&
          unreadNames.has(s.name),
      );

      if (dmsToResolve.length > 0) {
        console.log('[GChat Debug] Resolving DM names for', dmsToResolve.length, 'unread DMs');
        safeSend({ type: 'RESOLVING_NAMES' });
        for (let i = 0; i < dmsToResolve.length; i += 10) {
          if (i > 0) await sleep(100);
          const batch = dmsToResolve.slice(i, i + 10);
          const { resolved: resolvedNames, diagnostics } = await resolveDmNamesWithFallback(token, batch);
          for (const space of batch) {
            if (resolvedNames[space.name]) {
              safeSend({ type: 'DM_NAME', spaceName: space.name, resolvedName: resolvedNames[space.name] });
            } else if (diagnostics[space.name]) {
              safeSend({
                type: 'DM_NAME_DEBUG',
                spaceName: space.name,
                detail: diagnostics[space.name].detail,
                source: diagnostics[space.name].source,
              });
            }
          }
        }
      }
    }

    safeSend({ type: 'DONE', filter });
    persistCache();
  } catch (err) {
    safeSend({ type: 'ERROR', error: err.message });
  }
}

/**
 * Filter spaces by the active tab type.
 * DMs include both DIRECT_MESSAGE (1:1) and GROUP_CHAT (3+ people).
 */
function filterSpacesByTab(spaces, filter) {
  if (filter === 'dm') {
    return spaces.filter(
      (s) => s.spaceType === 'DIRECT_MESSAGE' || s.spaceType === 'GROUP_CHAT',
    );
  }
  if (filter === 'space') {
    return spaces.filter(
      (s) => s.spaceType !== 'DIRECT_MESSAGE' && s.spaceType !== 'GROUP_CHAT',
    );
  }
  return spaces; // 'all'
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureCurrentUserName(token) {
  if (cache.currentUserName) return cache.currentUserName;
  try {
    const user = await chatApi.getCurrentUser(token);
    cache.currentUserName = user?.name || null;
    if (cache.currentUserName) await persistCache();
  } catch (err) {
    console.warn('[GChat] Failed to fetch current user:', err.message);
  }
  return cache.currentUserName;
}

async function requireToken() {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

// ── Dynamic extension icon (mouth + auth status bubble) ─────────────────────
//
// Draws the icon at multiple sizes using OffscreenCanvas (available in MV3
// service workers).  A green bubble = authenticated, red = not.

async function updateExtensionIcon(authed) {
  try {
    const sizes = [16, 32, 48, 128];
    const imageData = {};

    for (const size of sizes) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      drawMouthIcon(ctx, size);
      drawStatusBubble(ctx, size, authed);
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }

    await chrome.action.setIcon({ imageData });
  } catch (err) {
    console.warn('[GChat Manager] Failed to set icon:', err.message);
  }
}

function drawMouthIcon(ctx, s) {
  const cx = s / 2;
  const cy = s / 2;

  // ── Background circle (light pink) ──
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.46, 0, Math.PI * 2);
  ctx.fillStyle = '#FFF0F0';
  ctx.fill();

  // ── Outer lip shape ──
  ctx.beginPath();
  ctx.moveTo(s * 0.09, cy);
  ctx.quadraticCurveTo(s * 0.23, s * 0.16, cx, s * 0.22);
  ctx.quadraticCurveTo(s * 0.77, s * 0.16, s * 0.91, cy);
  ctx.quadraticCurveTo(s * 0.77, s * 0.87, cx, s * 0.81);
  ctx.quadraticCurveTo(s * 0.23, s * 0.87, s * 0.09, cy);
  ctx.closePath();
  ctx.fillStyle = '#E8838F';
  ctx.fill();
  ctx.strokeStyle = '#2D2D2D';
  ctx.lineWidth = Math.max(1, s * 0.022);
  ctx.stroke();

  // ── Upper lip highlight ──
  ctx.beginPath();
  ctx.moveTo(s * 0.16, s * 0.47);
  ctx.quadraticCurveTo(s * 0.33, s * 0.23, cx, s * 0.28);
  ctx.quadraticCurveTo(s * 0.67, s * 0.23, s * 0.84, s * 0.47);
  ctx.quadraticCurveTo(s * 0.67, s * 0.35, cx, s * 0.33);
  ctx.quadraticCurveTo(s * 0.33, s * 0.35, s * 0.16, s * 0.47);
  ctx.closePath();
  ctx.fillStyle = '#F4A6B0';
  ctx.fill();

  // ── Mouth opening / teeth area (white) ──
  ctx.beginPath();
  ctx.moveTo(s * 0.19, cy);
  ctx.quadraticCurveTo(cx, s * 0.38, s * 0.81, cy);
  ctx.quadraticCurveTo(cx, s * 0.62, s * 0.19, cy);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  // ── Tooth dividers ──
  if (s >= 32) {
    ctx.strokeStyle = '#E0E0E0';
    ctx.lineWidth = Math.max(0.5, s * 0.012);
    const teeth = 5;
    for (let i = 1; i < teeth; i++) {
      const x = s * 0.25 + (s * 0.50) * (i / teeth);
      const topY = cy - s * 0.06;
      const botY = cy + s * 0.06;
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x, botY);
      ctx.stroke();
    }
  }

  // ── Tongue ──
  ctx.beginPath();
  ctx.ellipse(cx, s * 0.61, s * 0.16, s * 0.11, 0, 0, Math.PI);
  ctx.fillStyle = '#E06B7A';
  ctx.fill();

  // Tongue darker center
  ctx.beginPath();
  ctx.ellipse(cx, s * 0.60, s * 0.14, s * 0.08, 0, 0, Math.PI);
  ctx.fillStyle = '#D4546A';
  ctx.fill();

  // Tongue center line
  if (s >= 32) {
    ctx.beginPath();
    ctx.moveTo(cx, s * 0.55);
    ctx.lineTo(cx, s * 0.70);
    ctx.strokeStyle = '#C4445A';
    ctx.lineWidth = Math.max(0.5, s * 0.012);
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

function drawStatusBubble(ctx, s, isAuthenticated) {
  const r = Math.max(2.5, s * 0.14);
  const x = s - r - 0.5;
  const y = r + 0.5;

  // White border ring
  ctx.beginPath();
  ctx.arc(x, y, r + Math.max(1, s * 0.035), 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  // Colored status bubble
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = isAuthenticated ? '#4CAF50' : '#EF5350';
  ctx.fill();
}

// Set icon on startup based on current auth state
isAuthenticated().then((authed) => updateExtensionIcon(authed));

console.log('[GChat Manager] Background service worker initialized');
