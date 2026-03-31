const API_KEY = 'AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k';

const CAPABILITIES = [
  null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null,
  null, 2, 2, null, null, null, null, 2, 2, 2, 2, null, 2, null, null, 2,
  null, 2, 2, 2, 2, null, 2,
];

const CAPABILITIES_EXTENDED = [
  ...CAPABILITIES, null, null, null, null, null, null, 2, 2,
];

function buildPbliteRequestHeader() {
  return ['0', 7, 1, 'en', CAPABILITIES];
}

function getPbliteField(payload, fieldNumber) {
  if (!Array.isArray(payload)) return undefined;
  const offset = typeof payload[0] === 'string' && payload.length > 1 ? 1 : 0;
  return payload[fieldNumber - 1 + offset];
}

function getNestedPbliteString(payload, fieldNumber, innerFieldNumber) {
  const nested = getPbliteField(payload, fieldNumber);
  return getPbliteField(nested, innerFieldNumber);
}

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
          Array.isArray(uidArr) && uidArr.length > 0 && typeof uidArr[0] === 'string' &&
          typeof displayName === 'string'
        ) {
          if (!map.has(uidArr[0])) map.set(uidArr[0], displayName);
        }
      }
    }
  }

  return map;
}

function extractDmMemberIds(item) {
  const membersField = getPbliteField(item, 6);
  if (!Array.isArray(membersField) || membersField.length === 0) return [];

  const memberIdArrays = membersField[0];
  if (!Array.isArray(memberIdArrays)) return [];

  const ids = [];
  for (const member of memberIdArrays) {
    if (Array.isArray(member) && member.length > 0 && typeof member[0] === 'string') {
      ids.push(member[0]);
    }
  }
  return ids;
}

function resolveDmName(item, userNameMap) {
  const memberIds = extractDmMemberIds(item);
  if (memberIds.length === 0) return undefined;

  const actorField = getPbliteField(item, 7);
  let selfId = null;
  if (Array.isArray(actorField) && actorField.length > 0) {
    const actorIdArr = actorField[0];
    if (Array.isArray(actorIdArr) && actorIdArr.length > 0 && typeof actorIdArr[0] === 'string') {
      selfId = actorIdArr[0];
    } else if (typeof actorIdArr === 'string') {
      selfId = actorIdArr;
    }
  }

  const otherNames = [];
  for (const uid of memberIds) {
    if (selfId && uid === selfId) continue;
    const name = userNameMap.get(uid);
    if (name) otherNames.push(name);
  }

  return otherNames.length > 0 ? otherNames.join(', ') : undefined;
}

export function stripXssi(text) {
  return text.replace(/^\)\]\}'\n/, '');
}

export function buildGetMembersPayload(userIds) {
  const memberIds = userIds.map((uid) => [[uid, 0]]);
  return [
    memberIds,
    null,
    buildPbliteRequestHeader(),
  ];
}

export function parseMemberNames(data) {
  const names = {};
  const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0]) ? data[0] : data;

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

export function buildPaginatedWorldPayload(pageSize = 200) {
  const header = [0, 3, 1, 'en', CAPABILITIES_EXTENDED];
  const s = (ps, filter, ...rest) => [ps, null, null, filter, ...rest];

  const sectionRequests = [
    s(pageSize, [null, null, null, null, null, null, null, null, null, null, null, 1, null, null, null, [[3]]], null, null, null, null, [null, [[1]], null, 1], [[1, 1], [1]], [1], null, null, null, [1]),
    s(pageSize, [null, null, null, null, null, null, 4, null, null, null, null, 1, null, null, [[5]], [[3]]], null, null, null, null, [1, [[1], [2]], null, 1], [[1, 1], [1]], [1], null, null, null, [1]),
    s(pageSize, [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1], null, null, null, null, [null, [[1]], null, 1], [[1, 1], [1]], [1], null, null, null, [1]),
    s(pageSize, [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1], null, null, null, null, [1, [[1], [2]], null, 1], [[1, 1], [1]], [1], null, null, null, [1]),
    s(pageSize, [1], null, null, null, null, null, null, [3], null, 1),
    s(pageSize, [2, null, null, null, null, null, null, null, null, null, null, 1], null, null, null, null, null, null, [5], null, 1),
    s(pageSize, [2, null, null, null, null, null, null, null, null, null, null, 2], null, null, null, null, null, null, [5], null, 1),
    s(pageSize, [2, null, null, null, null, null, 2, null, null, null, null, 2], null, null, null, null, null, null, [5], null, 1),
    s(pageSize, [2, null, null, null, null, null, 2, null, null, null, null, 1], null, null, null, null, null, null, [5], null, 1),
    s(pageSize, [1, 1, 2, null, null, 2, null, null, 1, null, null, null, null, null, null, [[4], [8]]], null, null, null, null, null, null, [3]),
    s(pageSize, [1, 1, 2, null, null, 2, 2, null, 1, null, null, null, null, null, null, [[4], [8]]], null, null, null, null, null, null, [3]),
    s(pageSize, [1, 1, 2, null, 2, 1, null, null, null, null, null, null, null, null, [[8]], [[4]]], null, null, null, null, null, null, [3]),
    s(pageSize, [1, 1, 2, null, 2, 1, 2, null, null, null, null, null, null, null, [[8]], [[4]]], null, null, null, null, null, null, [3]),
    s(pageSize, [1, 1, 2, null, 1, null, null, 2, 2, null, null, null, null, null, null, [[4], [8]]], null, null, null, null, null, null, [3]),
    s(pageSize, [1, 1, 2, null, 1, null, 2, 2, 2, null, null, null, null, null, null, [[4], [8]]], null, null, null, null, null, null, [3]),
    s(pageSize, [2, 1, 2, null, null, 2, null, null, 1, null, null, 2, null, null, null, [[4], [8]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, null, 2, null, null, 1, null, null, 1, null, null, null, [[4], [8]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, null, 2, 2, null, 1, null, null, 1, null, null, null, [[4], [8]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, 1, null, null, 2, 2, null, null, 1, null, null, null, [[4], [8]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, 1, null, null, 2, 2, null, null, 2, null, null, null, [[4], [8]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, 1, null, 2, 2, 2, null, null, 1, null, null, null, [[4], [8]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, 2, 1, null, null, null, null, null, 2, null, null, [[8]], [[4]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, 2, 1, null, null, null, null, null, 1, null, null, [[8]], [[4]]], null, null, null, null, null, null, [5]),
    s(pageSize, [2, 1, 2, null, 2, 1, 2, null, null, null, null, 1, null, null, [[8]], [[4]]], null, null, null, null, null, null, [5]),
    s(1, [null, null, null, null, null, 2, null, null, null, null, [1]], null, null, 2),
    s(1, [null, null, null, null, null, 2, null, null, null, null, [2]], null, null, 2),
  ];

  return [header, sectionRequests, null, [4, 2, 5, 6, 7, 3], null, null, null, null, 1, null, 1];
}

export function parseWorldDmNames(data) {
  const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0]) ? data[0] : data;
  const items = getPbliteField(payload, 4);
  if (!Array.isArray(items)) return {};

  const userNameMap = extractUserNameMap(payload);
  const names = {};

  for (const item of items) {
    if (!Array.isArray(item)) continue;

    const groupId = getPbliteField(item, 1);
    const spaceId = getNestedPbliteString(groupId, 1, 1);
    const dmId = getNestedPbliteString(groupId, 3, 1);
    const id = spaceId ?? dmId;
    if (!id || !dmId) continue;

    let name = getPbliteField(item, 5);
    if (!name) {
      const field3 = getPbliteField(item, 3);
      if (typeof field3 === 'string') name = field3;
    }
    if (!name && userNameMap.size > 0) {
      name = resolveDmName(item, userNameMap);
    }
    if (name) names[id] = name;
  }

  return names;
}

export function buildPaginatedWorldRequest(baseUrl, xsrfToken, counter) {
  const headers = { 'Content-Type': 'application/json' };
  if (xsrfToken) headers['x-framework-xsrf-token'] = xsrfToken;

  return {
    url: `${baseUrl}/api/paginated_world?c=${counter}`,
    method: 'POST',
    headers,
    body: JSON.stringify(buildPaginatedWorldPayload()),
  };
}

export function buildGetMembersRequest(baseUrl, xsrfToken, userIds) {
  const headers = { 'Content-Type': 'application/json' };
  if (xsrfToken) headers['x-framework-xsrf-token'] = xsrfToken;

  return {
    url: `${baseUrl}/api/get_members?alt=protojson&key=${API_KEY}`,
    method: 'POST',
    headers,
    body: JSON.stringify(buildGetMembersPayload(userIds)),
  };
}

export { API_KEY };
