/**
 * Standalone Google Chat API module for browser extension use.
 *
 * Ported from packages/gchat/src/core/client.ts — no Node.js dependencies.
 * All functions are pure JS operating on PBLite (positional JSON) arrays
 * that Google Chat uses as its wire format.
 */

// ── PBLite helpers ──────────────────────────────────────────────────────────

/**
 * Read a protobuf field from a PBLite array.
 * PBLite is a positional JSON encoding where array index = field number - 1,
 * with a possible +1 offset when the first element is a string tag.
 */
export function getPbliteField(payload, fieldNumber) {
  if (!Array.isArray(payload)) return undefined;
  const offset = typeof payload[0] === 'string' && payload.length > 1 ? 1 : 0;
  return payload[fieldNumber - 1 + offset];
}

export function getNestedPbliteString(payload, fieldNumber, innerFieldNumber) {
  const nested = getPbliteField(payload, fieldNumber);
  return getPbliteField(nested, innerFieldNumber);
}

export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function toOptionalNumber(value) {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
  if (typeof value === 'string') {
    if (value.length === 0) return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

// ── Capabilities & request header ───────────────────────────────────────────

const CAPABILITIES = [
  null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null,
  null, 2, 2, null, null, null, null, 2, 2, 2, 2, null, 2, null, null, 2,
  null, 2, 2, 2, 2, null, 2,
];

const CAPABILITIES_EXTENDED = [
  ...CAPABILITIES, null, null, null, null, null, null, 2, 2,
];

export function buildPbliteRequestHeader() {
  return ["0", 7, 1, "en", CAPABILITIES];
}

export function buildMutationRequestHeader() {
  return [0, 3, 1, 'en', CAPABILITIES_EXTENDED];
}

// ── Notification categorization ─────────────────────────────────────────────

export function categorizeNotification(
  badgeCount,
  lastNotifWorthyEventTimestamp,
  readWatermarkTimestamp,
  sortTimestamp,
  pendingNotificationTimestamp,
) {
  if (badgeCount > 0) return 'badged';

  if (pendingNotificationTimestamp != null && pendingNotificationTimestamp > 0) {
    if (readWatermarkTimestamp == null || pendingNotificationTimestamp > readWatermarkTimestamp) {
      return 'lit_up';
    }
  }
  if (
    lastNotifWorthyEventTimestamp != null &&
    readWatermarkTimestamp != null &&
    lastNotifWorthyEventTimestamp > readWatermarkTimestamp
  ) {
    return 'lit_up';
  }
  if (
    lastNotifWorthyEventTimestamp == null &&
    sortTimestamp != null &&
    readWatermarkTimestamp != null &&
    sortTimestamp > readWatermarkTimestamp
  ) {
    return 'lit_up';
  }
  return 'none';
}

// ── User name map extraction ────────────────────────────────────────────────

function extractUserNameMap(payload) {
  const map = new Map();
  const memberSection = getPbliteField(payload, 8);
  if (!Array.isArray(memberSection)) return map;

  for (const entry of memberSection) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const userInfoWrapper = entry[1];
    if (!Array.isArray(userInfoWrapper)) continue;

    for (const level1 of userInfoWrapper) {
      if (!Array.isArray(level1)) continue;
      for (const userData of level1) {
        if (!Array.isArray(userData) || userData.length < 2) continue;
        const uidArr = userData[0];
        const displayName = userData[1];
        if (
          Array.isArray(uidArr) &&
          uidArr.length > 0 &&
          typeof uidArr[0] === 'string' &&
          typeof displayName === 'string'
        ) {
          if (!map.has(uidArr[0])) {
            map.set(uidArr[0], displayName);
          }
        }
      }
    }
  }
  return map;
}

// ── DM name resolution ──────────────────────────────────────────────────────

function resolveDmName(item, userNameMap, selfUserId) {
  const membersField = getPbliteField(item, 6);
  if (!Array.isArray(membersField) || membersField.length === 0) return undefined;

  const memberIdArrays = membersField[0];
  if (!Array.isArray(memberIdArrays)) return undefined;

  // Try to detect self from item[6] (field 7)
  let selfId = selfUserId;
  if (!selfId) {
    const actorField = getPbliteField(item, 7);
    if (Array.isArray(actorField) && actorField.length > 0) {
      const actorIdArr = actorField[0];
      if (Array.isArray(actorIdArr) && actorIdArr.length > 0 && typeof actorIdArr[0] === 'string') {
        selfId = actorIdArr[0];
      } else if (typeof actorIdArr === 'string') {
        selfId = actorIdArr;
      }
    }
  }

  const otherNames = [];
  for (const m of memberIdArrays) {
    if (!Array.isArray(m) || m.length === 0 || typeof m[0] !== 'string') continue;
    const uid = m[0];
    if (selfId && uid === selfId) continue;
    const name = userNameMap.get(uid);
    if (name) otherNames.push(name);
  }

  return otherNames.length > 0 ? otherNames.join(', ') : undefined;
}

function extractDmMemberIds(item) {
  const membersField = getPbliteField(item, 6);
  if (!Array.isArray(membersField) || membersField.length === 0) return undefined;

  const memberIdArrays = membersField[0];
  if (!Array.isArray(memberIdArrays)) return undefined;

  const ids = [];
  for (const m of memberIdArrays) {
    if (Array.isArray(m) && m.length > 0 && typeof m[0] === 'string') {
      ids.push(m[0]);
    }
  }
  return ids.length > 0 ? ids : undefined;
}

// ── Thread IDs extraction ───────────────────────────────────────────────────

function extractThreadIdsBySpace(payload) {
  const map = new Map();
  const threadSections = [getPbliteField(payload, 7), getPbliteField(payload, 8)];

  for (const threadSection of threadSections) {
    if (!Array.isArray(threadSection)) continue;

    for (const entry of threadSection) {
      if (!Array.isArray(entry)) continue;
      const meta = getPbliteField(entry, 1);
      if (!Array.isArray(meta)) continue;

      const threadRef = getPbliteField(meta, 1);
      const threadId = getPbliteField(threadRef, 2);
      const spaceWrapper = getPbliteField(threadRef, 3);
      const spaceId = getNestedPbliteString(spaceWrapper, 1, 1);
      if (spaceId && threadId) {
        if (!map.has(spaceId)) map.set(spaceId, []);
        if (!map.get(spaceId).includes(threadId)) {
          map.get(spaceId).push(threadId);
        }
      }
    }
  }
  return map;
}

// ── Parse paginated_world response into WorldItemSummary[] ──────────────────

export function parseWorldItems(data) {
  const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
    ? data[0]
    : data;

  const items = getPbliteField(payload, 4);
  if (!Array.isArray(items)) return [];

  const userNameMap = extractUserNameMap(payload);
  const threadIdsBySpace = extractThreadIdsBySpace(payload);
  const results = [];

  for (const item of items) {
    if (!Array.isArray(item)) continue;

    const groupId = getPbliteField(item, 1);
    const spaceId = getNestedPbliteString(groupId, 1, 1);
    const dmId = getNestedPbliteString(groupId, 3, 1);
    const id = spaceId ?? dmId;
    if (!id) continue;

    // Sort timestamp
    let sortTimestamp;
    const spaceEntry = item[1];
    if (Array.isArray(spaceEntry)) {
      for (let si = 8; si < Math.min(spaceEntry.length, 20); si++) {
        const val = spaceEntry[si];
        if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
          sortTimestamp = parseInt(val, 10);
          break;
        }
      }
    }
    if (!sortTimestamp) {
      sortTimestamp = toOptionalNumber(getPbliteField(item, 3));
    }

    const readState = getPbliteField(item, 4);
    const message = getPbliteField(item, 13);

    const unreadCount = toNumber(getPbliteField(readState, 4));
    const lastMentionTime = toOptionalNumber(getPbliteField(message, 7));
    const unreadReplyCount = toNumber(getPbliteField(message, 9));
    const lastMessageText = getPbliteField(message, 10);

    let badgeCount;
    let lastNotifWorthyEventTimestamp;
    let readWatermarkTimestamp;
    let notificationLevel;
    let pendingNotificationTimestamp;
    let unreadSubscribedTopicCount = 0;
    let subscribedThreadId;

    if (Array.isArray(readState)) {
      const rawThreadUnreadState = getPbliteField(readState, 21);
      badgeCount = toOptionalNumber(getPbliteField(readState, 7));
      lastNotifWorthyEventTimestamp = toOptionalNumber(getPbliteField(readState, 28));
      readWatermarkTimestamp = toOptionalNumber(getPbliteField(readState, 2));
      notificationLevel = toOptionalNumber(getPbliteField(readState, 22));
      pendingNotificationTimestamp = toOptionalNumber(getPbliteField(readState, 18));

      if (Array.isArray(rawThreadUnreadState)) {
        const hasThreadUnread = getPbliteField(rawThreadUnreadState, 2) === true;
        unreadSubscribedTopicCount = hasThreadUnread ? 1 : 0;
        const rawSubscribedThread = getPbliteField(rawThreadUnreadState, 3);
        if (Array.isArray(rawSubscribedThread)) {
          subscribedThreadId = getPbliteField(rawSubscribedThread, 2);
        }
      }
    }

    const type = dmId ? 'dm' : 'space';
    const notificationCategory = categorizeNotification(
      badgeCount ?? 0,
      lastNotifWorthyEventTimestamp,
      readWatermarkTimestamp,
      sortTimestamp,
      pendingNotificationTimestamp,
    );

    let name = getPbliteField(item, 5);

    // DM name resolution
    let memberUserIds;
    if (type === 'dm') {
      memberUserIds = extractDmMemberIds(item);
    }

    if (type === 'dm' && !name) {
      const field3 = getPbliteField(item, 3);
      if (typeof field3 === 'string') {
        name = field3;
      }
      if (!name && userNameMap.size > 0) {
        name = resolveDmName(item, userNameMap);
      }
    }

    results.push({
      id,
      name,
      type,
      unreadCount,
      unreadSubscribedTopicCount,
      lastMentionTime,
      unreadReplyCount,
      lastMessageText,
      subscribedThreadId,
      threadIds: type === 'space' ? threadIdsBySpace.get(id) : undefined,
      notificationCategory,
      badgeCount,
      lastNotifWorthyEventTimestamp,
      readWatermarkTimestamp,
      notificationLevel,
      pendingNotificationTimestamp,
      sortTimestamp,
      _memberUserIds: memberUserIds,
    });
  }

  return results;
}

// ── Build paginated_world request payload ───────────────────────────────────

export function buildPaginatedWorldPayload(pageSize = 200) {
  const header = [0, 3, 1, "en", CAPABILITIES_EXTENDED];

  const s = (ps, filter, ...rest) => [ps, null, null, filter, ...rest];

  const sectionRequests = [
    s(pageSize, [null,null,null,null,null,null,null,null,null,null,null,1,null,null,null,[[3]]],
      null,null,null,null, [null,[[1]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
    s(pageSize, [null,null,null,null,null,null,4,null,null,null,null,1,null,null,[[5]],[[3]]],
      null,null,null,null, [1,[[1],[2]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
    s(pageSize, [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1],
      null,null,null,null, [null,[[1]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
    s(pageSize, [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1],
      null,null,null,null, [1,[[1],[2]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
    s(pageSize, [1], null,null,null,null, null,null, [3], null, 1),
    s(pageSize, [2,null,null,null,null,null,null,null,null,null,null,1], null,null,null,null, null,null, [5], null, 1),
    s(pageSize, [2,null,null,null,null,null,null,null,null,null,null,2], null,null,null,null, null,null, [5], null, 1),
    s(pageSize, [2,null,null,null,null,null,2,null,null,null,null,2], null,null,null,null, null,null, [5], null, 1),
    s(pageSize, [2,null,null,null,null,null,2,null,null,null,null,1], null,null,null,null, null,null, [5], null, 1),
    s(pageSize, [1,1,2,null,null,2,null,null,1,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
    s(pageSize, [1,1,2,null,null,2,2,null,1,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
    s(pageSize, [1,1,2,null,2,1,null,null,null,null,null,null,null,null,[[8]],[[4]]], null,null,null,null, null,null, [3]),
    s(pageSize, [1,1,2,null,2,1,2,null,null,null,null,null,null,null,[[8]],[[4]]], null,null,null,null, null,null, [3]),
    s(pageSize, [1,1,2,null,1,null,null,2,2,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
    s(pageSize, [1,1,2,null,1,null,2,2,2,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
    s(pageSize, [2,1,2,null,null,2,null,null,1,null,null,2,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,null,2,null,null,1,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,null,2,2,null,1,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,1,null,null,2,2,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,1,null,null,2,2,null,null,2,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,1,null,2,2,2,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,2,1,null,null,null,null,null,2,null,null,[[8]],[[4]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,2,1,null,null,null,null,null,1,null,null,[[8]],[[4]]], null,null,null,null, null,null, [5]),
    s(pageSize, [2,1,2,null,2,1,2,null,null,null,null,1,null,null,[[8]],[[4]]], null,null,null,null, null,null, [5]),
    s(1, [null,null,null,null,null,2,null,null,null,null,[1]], null,null, 2),
    s(1, [null,null,null,null,null,2,null,null,null,null,[2]], null,null, 2),
  ];

  return [
    header,
    sectionRequests,
    null,
    [4, 2, 5, 6, 7, 3],
    null, null, null, null,
    1,
    null,
    1,
  ];
}

// ── Mark as read/unread payload builders ────────────────────────────────────

export function buildMarkReadPayload(groupId, isDm) {
  const payload = new Array(99).fill(null);
  payload[0] = isDm ? [null, null, [groupId]] : [[groupId]];
  payload[1] = Date.now() * 1000;
  payload[98] = buildMutationRequestHeader();
  return payload;
}

export function buildMarkUnreadPayload(groupId, isDm) {
  const payload = new Array(99).fill(null);
  payload[0] = isDm ? [null, null, [groupId]] : [[groupId]];
  payload[1] = 0;
  payload[98] = buildMutationRequestHeader();
  return payload;
}

export function buildSetMarkAsUnreadTimestampPayload(groupId, isDm, timestampMicros) {
  const payload = new Array(99).fill(null);
  payload[0] = isDm ? [null, null, [groupId]] : [[groupId]];
  payload[1] = timestampMicros;
  payload[98] = buildMutationRequestHeader();
  return payload;
}

export function buildMarkTopicReadPayload(spaceId, topicId, timestampMicros) {
  const payload = new Array(99).fill(null);
  const isDm = !String(spaceId).startsWith('AAAA');
  payload[0] = [null, topicId, isDm ? [null, null, [spaceId]] : [[spaceId]]];
  payload[1] = timestampMicros;
  payload[98] = buildMutationRequestHeader();
  return payload;
}

export function buildListMessagesPayload(groupId, topicId, pageSize = 100, isDm = false) {
  return [
    buildPbliteRequestHeader(),
    [[isDm ? [null, null, [groupId]] : [[groupId]], topicId]],
    pageSize,
  ];
}

export function parseThreadMessages(data, spaceId, topicId) {
  const messages = [];

  const parseMessage = (arr) => {
    if (!Array.isArray(arr) || arr.length < 10) return null;

    const text = typeof arr[9] === 'string' ? arr[9] : null;
    if (!text) return null;

    let timestampUsec;
    const ts = arr[2];
    if (typeof ts === 'string' && /^\d+$/.test(ts)) {
      timestampUsec = parseInt(ts, 10);
    } else if (typeof ts === 'number') {
      timestampUsec = ts;
    }

    return {
      message_id: Array.isArray(arr[0]) && typeof arr[0][1] === 'string' ? arr[0][1] : undefined,
      topic_id: topicId,
      space_id: spaceId,
      text,
      timestamp_usec: timestampUsec,
      sender: Array.isArray(arr[1]) && typeof arr[1][1] === 'string' ? arr[1][1] : undefined,
    };
  };

  if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][1])) {
    for (const raw of data[0][1]) {
      const msg = parseMessage(raw);
      if (msg) messages.push(msg);
    }
  }

  messages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));
  return messages;
}

// ── XSSI response parsing ──────────────────────────────────────────────────

const XSSI_PREFIX = ")]}'\n";

export function stripXssi(text) {
  if (text.startsWith(XSSI_PREFIX)) {
    return text.slice(XSSI_PREFIX.length);
  }
  // Some responses use just ")]}" without the newline
  if (text.startsWith(")]}'")) {
    return text.slice(4);
  }
  return text;
}

// ── Classify items into display types ────────────────────────────────────────

/**
 * Determine if a space item is actually a thread-unread notification.
 * These are spaces where the user follows a thread that has new messages,
 * but the space itself has no top-level notification (notificationCategory === 'none').
 */
export function isThreadUnread(item) {
  return (
    item.type === 'space' &&
    item.notificationCategory === 'none' &&
    (item.unreadSubscribedTopicCount > 0 || item.unreadReplyCount > 0)
  );
}

/**
 * Get the display type for an item: 'dm', 'space', or 'thread'.
 * Thread-unread spaces are promoted to their own 'thread' type for the UI.
 */
export function getDisplayType(item) {
  if (item.type === 'dm') return 'dm';
  if (isThreadUnread(item)) return 'thread';
  return 'space';
}

/**
 * Filter items to only those with unread notifications, including
 * thread-unread spaces. Adds a `displayType` field to each item.
 */
export function filterUnreadItems(items) {
  return items
    .filter(item => {
      if (item.notificationCategory === 'badged' || item.notificationCategory === 'lit_up') {
        return true;
      }
      if (isThreadUnread(item)) {
        return true;
      }
      return false;
    })
    .map(item => ({
      ...item,
      displayType: getDisplayType(item),
    }));
}

// ── DM name enrichment ──────────────────────────────────────────────────────

/**
 * Build a PBLite JSON payload for the get_members API.
 * This uses the same JSON approach as paginated_world — Google Chat accepts
 * PBLite JSON at /api/get_members with ?alt=protojson&key=<API_KEY>.
 *
 * Protobuf schema for GetMembersRequest:
 *   message GetMembersRequest {
 *     repeated MemberId member_ids = 1;  // MemberId { UserId user_id = 1; }
 *     RequestHeader request_header = 3;  // UserId { string id = 1; UserType type = 2; }
 *   }
 *
 * In PBLite: [ [[userId, 0], ...], null, requestHeader ]
 */
export function buildGetMembersPayload(userIds) {
  const memberIds = userIds.map(uid => [[uid, 0]]);
  return [
    memberIds,
    null,
    buildPbliteRequestHeader(),
  ];
}

/**
 * Parse a get_members PBLite JSON response to extract userId → displayName.
 * Response structure: response[0] = array of member entries
 *   Each member: member[0] = user wrapper → member[0][0][0] = userId
 *                member[1] = displayName
 */
export function parseMemberNames(data) {
  const names = {};
  const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
    ? data[0]
    : data;

  const members = getPbliteField(payload, 1);
  if (Array.isArray(members)) {
    for (const entry of members) {
      if (!Array.isArray(entry)) continue;
      const user = getPbliteField(entry, 1);
      if (!user) continue;
      const userId = getNestedPbliteString(user, 1, 1);
      const displayName = getPbliteField(user, 2);
      if (userId && typeof displayName === 'string') {
        names[userId] = displayName;
      }
    }
  }

  // Fallback: try flat array format
  if (Object.keys(names).length === 0 && Array.isArray(payload)) {
    for (const entry of payload) {
      if (!Array.isArray(entry)) continue;
      const user = getPbliteField(entry, 1);
      if (!user) continue;
      const userId = getNestedPbliteString(user, 1, 1);
      const displayName = getPbliteField(user, 2);
      if (userId && typeof displayName === 'string') {
        names[userId] = displayName;
      }
    }
  }

  return names;
}

/**
 * Given a list of items with _memberUserIds, collect all unique user IDs
 * from unnamed DMs that need resolution.
 */
export function collectUnresolvedDmUserIds(items) {
  const userIds = new Set();
  // Detect self: the user ID that appears in the most DMs is likely self
  const idFrequency = new Map();

  for (const item of items) {
    if (item.type !== 'dm' || item.name || !item._memberUserIds?.length) continue;
    for (const uid of item._memberUserIds) {
      idFrequency.set(uid, (idFrequency.get(uid) || 0) + 1);
    }
  }

  // Most frequent ID across DMs is likely self
  let selfId = null;
  let maxFreq = 0;
  for (const [uid, freq] of idFrequency) {
    if (freq > maxFreq) {
      maxFreq = freq;
      selfId = uid;
    }
  }

  for (const item of items) {
    if (item.type !== 'dm' || item.name || !item._memberUserIds?.length) continue;
    for (const uid of item._memberUserIds) {
      if (uid !== selfId) {
        userIds.add(uid);
      }
    }
  }

  return { userIds: Array.from(userIds), selfId };
}

/**
 * Apply resolved names to unnamed DMs.
 */
export function applyDmNames(items, nameMap, selfId) {
  for (const item of items) {
    if (item.type !== 'dm' || item.name || !item._memberUserIds?.length) continue;

    const otherNames = [];
    for (const uid of item._memberUserIds) {
      if (selfId && uid === selfId) continue;
      const name = nameMap[uid];
      if (name) otherNames.push(name);
    }

    if (otherNames.length > 0) {
      item.name = otherNames.join(', ');
    }
  }
}
