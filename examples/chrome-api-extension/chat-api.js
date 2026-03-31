/**
 * Google Chat REST API client.
 *
 * Uses the official v1 REST API:
 *   - spaces.list                              — list user's spaces
 *   - users.spaces.getSpaceReadState           — per-space read watermark
 *   - users.spaces.updateSpaceReadState        — mark space as read
 *   - users.spaces.threads.getThreadReadState  — per-thread read watermark
 *   - users.spaces.spaceNotificationSetting    — get/patch notification prefs
 *   - spaces.messages.list                     — list messages (thread discovery)
 *   - spaces.members.list                      — resolve DM display names
 *
 * All functions expect a valid OAuth2 access token as the first argument.
 */

import { API_BASE } from './config.js';

// ── Spaces ──────────────────────────────────────────────────────────────────

/**
 * List all spaces the authenticated user is a member of.
 * Automatically paginates through all results.
 */
export async function listSpaces(token) {
  const spaces = [];
  let pageToken = '';

  do {
    const url = new URL(`${API_BASE}/spaces`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchWithAuth(url, token);
    const data = await res.json();
    if (data.spaces) spaces.push(...data.spaces);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return spaces;
}

// ── Space Read State ────────────────────────────────────────────────────────

/**
 * Get the read state (last-read watermark) for a single space.
 */
export async function getSpaceReadState(token, spaceName) {
  const spaceId = spaceName.replace('spaces/', '');
  const url = `${API_BASE}/users/me/spaces/${spaceId}/spaceReadState`;
  const res = await fetchWithAuth(url, token);
  return res.json();
}

/**
 * Mark a space as read by setting lastReadTime to now.
 */
export async function markSpaceAsRead(token, spaceName) {
  const spaceId = spaceName.replace('spaces/', '');
  const name = `users/me/spaces/${spaceId}/spaceReadState`;

  const url = new URL(`${API_BASE}/${name}`);
  url.searchParams.set('updateMask', 'lastReadTime');

  const res = await fetchWithAuth(url, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      lastReadTime: new Date().toISOString(),
    }),
  });

  return res.json();
}

// ── Thread Read State ───────────────────────────────────────────────────────

/**
 * Get the read state for a specific thread within a space.
 *
 * @param {string} spaceName  - e.g. "spaces/AAAA"
 * @param {string} threadName - e.g. "spaces/AAAA/threads/BBBB"
 */
export async function getThreadReadState(token, spaceName, threadName) {
  const spaceId = spaceName.replace('spaces/', '');
  const threadId = threadName.replace(`spaces/${spaceId}/threads/`, '');
  const url = `${API_BASE}/users/me/spaces/${spaceId}/threads/${threadId}/threadReadState`;
  const res = await fetchWithAuth(url, token);
  return res.json();
}

// ── Messages ────────────────────────────────────────────────────────────────

/**
 * List messages in a space. Supports filtering and ordering.
 *
 * @param {object} opts
 * @param {number}  [opts.pageSize=100]  - Max messages per page
 * @param {string}  [opts.filter]        - Filter expression (e.g. createTime > "2024-01-01T00:00:00Z")
 * @param {string}  [opts.orderBy]       - "createTime asc" or "createTime desc"
 * @param {boolean} [opts.showDeleted]   - Include deleted messages
 * @param {number}  [opts.maxPages=5]    - Max pages to fetch (safety limit)
 */
export async function listMessages(token, spaceName, opts = {}) {
  const { pageSize = 100, filter, orderBy, showDeleted, maxPages = 5 } = opts;
  const messages = [];
  let pageToken = '';
  let pages = 0;

  do {
    const url = new URL(`${API_BASE}/${spaceName}/messages`);
    url.searchParams.set('pageSize', String(pageSize));
    if (filter) url.searchParams.set('filter', filter);
    if (orderBy) url.searchParams.set('orderBy', orderBy);
    if (showDeleted) url.searchParams.set('showDeleted', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchWithAuth(url, token);
    const data = await res.json();
    if (data.messages) messages.push(...data.messages);
    pageToken = data.nextPageToken || '';
    pages++;
  } while (pageToken && pages < maxPages);

  return messages;
}

// ── Composite: unread threads within a space ────────────────────────────────

/**
 * Discover unread threads within a space.
 *
 * Flow:
 *   1. List messages created after the space's lastReadTime
 *   2. Extract unique thread names from those messages
 *   3. Fetch threadReadState for each thread
 *   4. Return threads with their read state and latest message info
 *
 * @param {string} spaceName  - e.g. "spaces/AAAA"
 * @param {string} [sinceTime] - ISO timestamp; defaults to space lastReadTime
 */
export async function getUnreadThreads(token, spaceName, sinceTime) {
  // Build filter: messages since the last-read watermark
  const filter = sinceTime
    ? `createTime > "${sinceTime}"`
    : undefined;

  const messages = await listMessages(token, spaceName, {
    filter,
    orderBy: 'createTime desc',
    pageSize: 200,
    maxPages: 3,
  });

  if (messages.length === 0) return [];

  // Group messages by thread
  const threadMap = new Map(); // threadName -> { messages, latestTime, snippet }
  for (const msg of messages) {
    const threadName = msg.thread?.name;
    if (!threadName) continue;

    if (!threadMap.has(threadName)) {
      threadMap.set(threadName, {
        threadName,
        messages: [],
        latestTime: null,
        snippet: null,
        senderName: null,
      });
    }

    const entry = threadMap.get(threadName);
    entry.messages.push(msg);

    const msgTime = msg.createTime ? new Date(msg.createTime).getTime() : 0;
    if (!entry.latestTime || msgTime > new Date(entry.latestTime).getTime()) {
      entry.latestTime = msg.createTime;
      // Extract a text snippet from the message
      entry.snippet = extractSnippet(msg);
      entry.senderName = msg.sender?.displayName || null;
    }
  }

  // Fetch thread read states (batched)
  const CONCURRENCY = 3;
  const BATCH_DELAY_MS = 200;
  const threads = [...threadMap.values()];
  const results = [];

  for (let i = 0; i < threads.length; i += CONCURRENCY) {
    if (i > 0) await sleep(BATCH_DELAY_MS);

    const batch = threads.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (thread) => {
        try {
          const readState = await getThreadReadState(
            token,
            spaceName,
            thread.threadName,
          );
          const lastRead = readState.lastReadTime
            ? new Date(readState.lastReadTime).getTime()
            : 0;
          const latestMsg = thread.latestTime
            ? new Date(thread.latestTime).getTime()
            : 0;

          return {
            ...thread,
            readState,
            isUnread: latestMsg > lastRead,
            messageCount: thread.messages.length,
          };
        } catch (_) {
          // If read state fails, assume unread
          return {
            ...thread,
            readState: null,
            isUnread: true,
            messageCount: thread.messages.length,
          };
        }
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }

  // Return only unread threads, sorted by latest message time (newest first)
  return results
    .filter((t) => t.isUnread)
    .sort((a, b) => {
      const ta = a.latestTime ? new Date(a.latestTime).getTime() : 0;
      const tb = b.latestTime ? new Date(b.latestTime).getTime() : 0;
      return tb - ta;
    })
    .map((t) => ({
      threadName: t.threadName,
      snippet: t.snippet,
      senderName: t.senderName,
      latestTime: t.latestTime,
      messageCount: t.messageCount,
      readState: t.readState,
    }));
}

/**
 * Extract a short text snippet from a message.
 */
function extractSnippet(msg) {
  // Try plain text first
  if (msg.text) return msg.text.slice(0, 120);
  // Fallback to formatted text
  if (msg.formattedText) return msg.formattedText.replace(/<[^>]*>/g, '').slice(0, 120);
  // Attachment-only messages
  if (msg.attachment?.length > 0) return '[Attachment]';
  // Cards
  if (msg.cardsV2?.length > 0 || msg.cards?.length > 0) return '[Card]';
  return '[Message]';
}

// ── Notification Settings ───────────────────────────────────────────────────

/**
 * Get the notification setting for a space.
 *
 * Returns: { name, notificationSetting, muteSetting }
 *   notificationSetting: "ALL" | "MAIN_CONVERSATIONS" | "FOR_YOU" | "OFF"
 *   muteSetting:         "MUTED" | "UNMUTED"
 */
export async function getNotificationSetting(token, spaceName) {
  const spaceId = spaceName.replace('spaces/', '');
  const url = `${API_BASE}/users/me/spaces/${spaceId}/spaceNotificationSetting`;
  const res = await fetchWithAuth(url, token);
  return res.json();
}

/**
 * Get the authenticated Chat user resource.
 * With user auth, this reliably includes the canonical `name` field.
 */
export async function getCurrentUser(token) {
  const url = `${API_BASE}/users/me`;
  const res = await fetchWithAuth(url, token);
  return res.json();
}

/**
 * Update notification settings for a space.
 *
 * @param {object} settings - Fields to update:
 *   { notificationSetting?: string, muteSetting?: string }
 */
export async function updateNotificationSetting(token, spaceName, settings) {
  const spaceId = spaceName.replace('spaces/', '');
  const name = `users/me/spaces/${spaceId}/spaceNotificationSetting`;

  const fields = [];
  if ('notificationSetting' in settings) fields.push('notificationSetting');
  if ('muteSetting' in settings) fields.push('muteSetting');

  const url = new URL(`${API_BASE}/${name}`);
  url.searchParams.set('updateMask', fields.join(','));

  const res = await fetchWithAuth(url, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...settings }),
  });

  return res.json();
}

// ── Members ─────────────────────────────────────────────────────────────────

/**
 * List members of a space. Used to resolve DM display names.
 * Uses fetchWithAuth for automatic retry on 401/429 rate limits.
 */
export async function listMembers(token, spaceName) {
  const members = [];
  let pageToken = '';

  do {
    const url = new URL(`${API_BASE}/${spaceName}/members`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchWithAuth(url, token);
    const data = await res.json();
    if (data.memberships) members.push(...data.memberships);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return members;
}

/**
 * Resolve a DM/group chat display name from recent message senders.
 *
 * `spaces.members.list` does not reliably populate `member.displayName` for
 * user-authenticated requests, so we derive names from recent messages instead.
 */
export async function resolveDmNameFromMessagesDetailed(token, space, currentUserName) {
  const messages = await listMessages(token, space.name, {
    orderBy: 'createTime desc',
    pageSize: 50,
    maxPages: 2,
  });

  const participants = new Map(); // senderName -> displayName
  for (const msg of messages) {
    const sender = msg.sender;
    if (!sender || sender.type !== 'HUMAN' || !sender.displayName || !sender.name) continue;
    if (currentUserName && sender.name === currentUserName) continue;
    if (!participants.has(sender.name)) participants.set(sender.name, sender.displayName);
  }

  const names = [...participants.values()];
  if (names.length === 0) {
    return {
      name: null,
      reason: messages.length === 0 ? 'no recent messages' : 'no non-self human senders in recent messages',
      messageCount: messages.length,
      participantCount: 0,
    };
  }

  return {
    name: space.spaceType === 'DIRECT_MESSAGE' ? names[0] : names.slice(0, 3).join(', '),
    reason: null,
    messageCount: messages.length,
    participantCount: names.length,
  };
}

export async function resolveDmNameFromMessages(token, space, currentUserName) {
  const result = await resolveDmNameFromMessagesDetailed(token, space, currentUserName);
  return result.name;
}

// ── Composite: unread spaces ────────────────────────────────────────────────

/**
 * List all spaces with their unread status.
 *
 * Flow:
 *   1. List all spaces via spaces.list
 *   2. Fetch read state for each space (batched, parallel)
 *   3. Compare lastActiveTime vs lastReadTime to determine unread status
 */
export async function getUnreadSpaces(token) {
  const spaces = await listSpaces(token);

  const CONCURRENCY = 3;
  const BATCH_DELAY_MS = 200;
  const results = [];

  for (let i = 0; i < spaces.length; i += CONCURRENCY) {
    if (i > 0) await sleep(BATCH_DELAY_MS);

    const batch = spaces.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (space) => {
        try {
          const readState = await getSpaceReadState(token, space.name);

          // If lastActiveTime is missing (common for DMs), assume unread
          if (!space.lastActiveTime) {
            return { ...space, readState, isUnread: true };
          }

          const lastActive = new Date(space.lastActiveTime).getTime();
          const lastRead = readState.lastReadTime
            ? new Date(readState.lastReadTime).getTime()
            : 0;

          return {
            ...space,
            readState,
            isUnread: lastActive > lastRead,
          };
        } catch (_) {
          // If read state fetch fails, assume potentially unread
          return { ...space, readState: null, isUnread: true };
        }
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }

  return results;
}

/**
 * Resolve display names for DM spaces by fetching member lists.
 * Mutates the space objects in place, adding `resolvedName`.
 */
export async function resolveDmNames(token, dmSpaces) {
  const CONCURRENCY = 2;

  for (let i = 0; i < dmSpaces.length; i += CONCURRENCY) {
    if (i > 0) await sleep(200);
    const batch = dmSpaces.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (space) => {
        if (space.displayName) return;

        try {
          const members = await listMembers(token, space.name);
          const otherNames = members
            .filter((m) => m.member?.type === 'HUMAN')
            .map((m) => m.member?.displayName)
            .filter(Boolean);

          if (otherNames.length > 0) {
            space.resolvedName = otherNames.join(', ');
          }
        } catch (_) {
          // Name resolution is best-effort
        }
      }),
    );
  }
}

// ── Sections ────────────────────────────────────────────────────────────────

/**
 * List all sections for the authenticated user.
 * Returns system sections (default-direct-messages, default-spaces, default-apps)
 * and any custom sections the user has created.
 */
export async function listSections(token) {
  const sections = [];
  let pageToken = '';

  do {
    const url = new URL(`${API_BASE}/users/me/sections`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchWithAuth(url, token);
    const data = await res.json();
    if (data.sections) sections.push(...data.sections);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return sections;
}

/**
 * Create a new custom section.
 *
 * @param {string} displayName - Display name (max 80 chars)
 * @returns {Section} The created section
 */
export async function createSection(token, displayName) {
  const url = `${API_BASE}/users/me/sections`;
  const res = await fetchWithAuth(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, type: 'CUSTOM_SECTION' }),
  });
  return res.json();
}

/**
 * Update a custom section's display name.
 *
 * @param {string} sectionName - e.g. "users/me/sections/XXXX"
 * @param {string} displayName - New display name
 */
export async function updateSection(token, sectionName, displayName) {
  const url = new URL(`${API_BASE}/${sectionName}`);
  url.searchParams.set('updateMask', 'displayName');
  const res = await fetchWithAuth(url, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sectionName, displayName }),
  });
  return res.json();
}

/**
 * Delete a custom section.
 * Items in the section revert to the appropriate default system section.
 *
 * @param {string} sectionName - e.g. "users/me/sections/XXXX"
 */
export async function deleteSection(token, sectionName) {
  const res = await fetchWithAuth(`${API_BASE}/${sectionName}`, token, {
    method: 'DELETE',
  });
  // DELETE returns empty body on success
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Section Items ────────────────────────────────────────────────────────────

/**
 * List all items (spaces) in a section.
 * Automatically paginates through all results.
 *
 * @param {string} sectionName - e.g. "users/me/sections/XXXX"
 * @returns {SectionItem[]}
 */
export async function listSectionItems(token, sectionName) {
  const items = [];
  let pageToken = '';

  do {
    const url = new URL(`${API_BASE}/${sectionName}/items`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchWithAuth(url, token);
    const data = await res.json();
    if (data.sectionItems) items.push(...data.sectionItems);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

/**
 * Move a section item from its current section to a different section.
 *
 * @param {string} itemName         - Full resource name, e.g. "users/me/sections/OLD/items/ID"
 * @param {string} targetSectionName - e.g. "users/me/sections/NEW"
 * @returns {{ sectionItem: SectionItem }} Updated item
 */
export async function moveSectionItem(token, itemName, targetSectionName) {
  const url = `${API_BASE}/${itemName}:move`;
  const res = await fetchWithAuth(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetSection: targetSectionName }),
  });
  return res.json();
}

// ── Internal helpers ────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

async function fetchWithAuth(url, token, opts = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        ...opts.headers,
      },
    });

    // Retry on 401 (throttle) or 429 (rate limit) with backoff
    if ((res.status === 401 || res.status === 429) && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Chat API ${res.status}: ${body.slice(0, 300)}`);
    }

    return res;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
