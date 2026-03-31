import { describe, expect, it, vi } from 'vitest';

import { GoogleChatClient } from '../src/core/client.ts';
import type { SelfUser, WorldItemSummary } from '../src/core/types.ts';

function makeItem(overrides: Partial<WorldItemSummary>): WorldItemSummary {
  return {
    id: 'item',
    name: 'Item',
    type: 'space',
    unreadCount: 0,
    unreadSubscribedTopicCount: 0,
    unreadReplyCount: 0,
    isSubscribedToSpace: false,
    notificationCategory: 'none',
    ...overrides,
  };
}

function makeClient(items: WorldItemSummary[]): GoogleChatClient {
  const client = new GoogleChatClient({} as never);

  vi.spyOn(client, 'fetchWorldItems').mockResolvedValue({
    items,
    raw: {},
  } as never);
  vi.spyOn(client, 'getSelfUser').mockResolvedValue({
    userId: 'self-user',
  } as SelfUser);

  return client;
}

describe('notification unread promotion', () => {
  it('parses thread unread markers from paginated world items', () => {
    const client = new GoogleChatClient({} as never);

    const readState: unknown[] = [];
    readState[1] = '1773139768579000';
    readState[3] = 0;
    readState[6] = '0';
    readState[17] = '0';
    readState[20] = [null, true, [null, 'fakeThread001', [['AAAAtestSpc01']]]];
    readState[21] = 3;
    readState[27] = '1773087094398655';

    const message: unknown[] = [];
    message[9] = 'Has anyone tested the new feature yet?';

    const item: unknown[] = [];
    item[0] = [['AAAAtestSpc01']];
    item[2] = 1773092368097903;
    item[3] = readState;
    item[4] = 'Team Watercooler';
    item[12] = message;

    const payload = ['dfe.w.pw', null, null, null, [item]];
    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.unreadSubscribedTopicCount).toBe(1);
    expect(parsed.subscribedThreadId).toBe('fakeThread001');
    expect(parsed.notificationCategory).toBe('none');
  });

  it('does not keep DMs unread from stale pending notification timestamps', () => {
    const client = new GoogleChatClient({} as never);

    const readState: unknown[] = [];
    readState[1] = '1773141277058000';
    readState[6] = '0';
    readState[17] = '1773111159996751';
    readState[27] = '1773111159996751';

    const message: unknown[] = [];
    message[9] = 'Sounds good, thanks!';

    const item: unknown[] = [];
    item[0] = [null, null, [['DMtestDm0001']]];
    item[2] = '1773111159996751';
    item[4] = 'Alice Johnson, Bob Williams';
    item[3] = readState;
    item[12] = message;

    const payload = ['dfe.w.pw', null, null, null, [item]];
    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.type).toBe('dm');
    expect(parsed.notificationCategory).toBe('none');
  });

  it('does not keep spaces lit up from stale sort timestamps when notif timestamp is older than watermark', () => {
    const client = new GoogleChatClient({} as never);

    const readState: unknown[] = [];
    readState[1] = '1773146549701000';
    readState[6] = '0';
    readState[27] = '1773087094398655';

    const item: unknown[] = [];
    item[0] = [['AAAAtestSpc01']];
    item[2] = '1773092368097903';
    item[3] = readState;
    item[4] = 'Team Watercooler';

    const payload = ['dfe.w.pw', null, null, null, [item]];
    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.type).toBe('space');
    expect(parsed.notificationCategory).toBe('none');
  });

  it('still falls back to sort timestamp when notif timestamp is missing', () => {
    const client = new GoogleChatClient({} as never);

    const readState: unknown[] = [];
    readState[1] = '1773141277058000';
    readState[6] = '0';

    const item: unknown[] = [];
    item[0] = [['space-1']];
    item[2] = '1773142277058000';
    item[3] = readState;
    item[4] = 'Fallback Space';

    const payload = ['dfe.w.pw', null, null, null, [item]];
    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.notificationCategory).toBe('lit_up');
  });

  it('collects all known thread ids for a space from paginated world data', () => {
    const client = new GoogleChatClient({} as never);

    const item: unknown[] = [];
    item[0] = [['AAAAtestSpc01']];
    item[2] = 1773092368097903;
    item[3] = [null, '1773139768579000', null, 0, true, '1773139769041719', '0'];
    item[4] = 'Team Watercooler';
    item[12] = [null, null, null, null, null, null, null, null, null, 'Has anyone tested the new feature yet?'];

    const threadGroup1 = [
      [null, 'fakeThread002', [['AAAAtestSpc01']]],
      '1714492257070639',
    ];
    const threadGroup2 = [
      [null, 'fakeThread003', [['AAAAtestSpc01']]],
      '1719244489452079',
    ];

    const payload = [
      'dfe.w.pw',
      null,
      null,
      null,
      [item],
      null,
      null,
      [[threadGroup1], [threadGroup2]],
    ];

    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.threadIds).toEqual(['fakeThread002', 'fakeThread003']);
  });

  it('promotes thread-unread spaces into unread notifications', async () => {
    const items = [
      makeItem({
        id: 'dm-1',
        name: 'Badged DM',
        type: 'dm',
        notificationCategory: 'badged',
        badgeCount: 1,
      }),
      makeItem({
        id: 'space-1',
        name: 'Lit Up Space',
        notificationCategory: 'lit_up',
      }),
      makeItem({
        id: 'space-2',
        name: 'Thread Space',
        notificationCategory: 'none',
        unreadSubscribedTopicCount: 1,
      }),
      makeItem({
        id: 'space-3',
        name: 'Read Space',
        notificationCategory: 'none',
      }),
    ];

    const client = makeClient(items);
    const result = await client.getUnreadNotifications();

    expect(result.directMessages.map((item) => item.spaceId)).toEqual(['dm-1']);
    expect(result.spaces.map((item) => item.spaceId)).toEqual(['space-1', 'space-2']);
    expect(result.spaces.find((item) => item.spaceId === 'space-2')?.promotedThreadUnread).toBe(true);
    expect(result.badges.totalUnread).toBe(3);
    expect(result.badges.threadUnreadCount).toBe(1);
    expect(result.allUnreads.map((item) => item.id)).toEqual(['dm-1', 'space-1', 'space-2']);
  });

  it('merges subscribedThreadId into threadIds when pw[7] is empty', () => {
    const client = new GoogleChatClient({} as never);

    const readState: unknown[] = [];
    readState[1] = '1773139768579000';
    readState[3] = 0;
    readState[6] = '0';
    readState[20] = [null, true, [null, 'fakeThread004', [['AAAAtestSpc02']]]];
    readState[21] = 3;

    const item: unknown[] = [];
    item[0] = [['AAAAtestSpc02']];
    item[2] = '1773092368097903';
    item[3] = readState;
    item[4] = 'Test Space';

    // No thread sections (pw[7]/pw[8]) — subscribedThreadId should still appear
    const payload = ['dfe.w.pw', null, null, null, [item]];
    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.subscribedThreadId).toBe('fakeThread004');
    expect(parsed.threadIds).toEqual(['fakeThread004']);
  });

  it('merges subscribedThreadId into threadIds when pw[7] has different threads', () => {
    const client = new GoogleChatClient({} as never);

    const readState: unknown[] = [];
    readState[1] = '1773139768579000';
    readState[3] = 0;
    readState[6] = '0';
    readState[20] = [null, true, [null, 'fakeThread004', [['AAAAtestSpc02']]]];
    readState[21] = 3;

    const item: unknown[] = [];
    item[0] = [['AAAAtestSpc02']];
    item[2] = '1773092368097903';
    item[3] = readState;
    item[4] = 'Test Space';

    // pw[7] has a DIFFERENT thread (fakeThread005) from the subscribedThreadId (fakeThread004)
    const threadGroup = [
      [null, 'fakeThread005', [['AAAAtestSpc02']]],
      '1719244489452079',
    ];
    const payload = ['dfe.w.pw', null, null, null, [item], null, null, [[threadGroup]]];
    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.subscribedThreadId).toBe('fakeThread004');
    // subscribedThreadId should be first (it's the unread one), followed by pw[7] thread
    expect(parsed.threadIds).toContain('fakeThread004');
    expect(parsed.threadIds).toContain('fakeThread005');
    expect(parsed.threadIds![0]).toBe('fakeThread004');
  });

  it('does not duplicate subscribedThreadId when it already exists in pw[7]', () => {
    const client = new GoogleChatClient({} as never);

    const readState: unknown[] = [];
    readState[1] = '1773139768579000';
    readState[20] = [null, true, [null, 'fakeThread002', [['AAAAtestSpc01']]]];

    const item: unknown[] = [];
    item[0] = [['AAAAtestSpc01']];
    item[2] = '1773092368097903';
    item[3] = readState;
    item[4] = 'Test Space';

    // pw[7] already contains the same thread as subscribedThreadId
    const threadGroup = [
      [null, 'fakeThread002', [['AAAAtestSpc01']]],
      '1714492257070639',
    ];
    const payload = ['dfe.w.pw', null, null, null, [item], null, null, [[threadGroup]]];
    const [parsed] = (client as unknown as { parseWorldItems: (data: unknown) => WorldItemSummary[] }).parseWorldItems(payload);

    expect(parsed.threadIds).toEqual(['fakeThread002']);
  });

  it('parses dfe.rs.mtrs response correctly without false -1 error', () => {
    const client = new GoogleChatClient({} as never);
    const parse = (client as unknown as {
      parseTopicReadstateResponse: (data: unknown[], groupId: string) => unknown;
    }).parseTopicReadstateResponse.bind(client);

    // Real response shape from live data
    const response = [
      ['dfe.rs.mtrs', [
        [null, 'thread123', [['space123']]],  // identity
        '1773155000000000',                      // lastReadTime
        null,
        '0',                                     // unreadCount
        '5',                                     // readCount
        null,
        -1,                                      // subscriptionState (NOT an error)
        1773155000,                               // serverTimestamp
        null,
        '5',                                     // totalCount
      ], []],
    ];

    const result = parse(response, 'space123') as { success: boolean; lastReadTime: number; unreadMessageCount: number };
    expect(result.success).toBe(true);
    expect(result.lastReadTime).toBe(1773155000000000);
    expect(result.unreadMessageCount).toBe(0);
  });

  it('merges lit-up and promoted thread spaces into unreadSpaces', async () => {
    const items = [
      makeItem({
        id: 'space-1',
        name: 'Lit Up Space',
        notificationCategory: 'lit_up',
      }),
      makeItem({
        id: 'space-2',
        name: 'Thread Space',
        notificationCategory: 'none',
        unreadReplyCount: 2,
      }),
      makeItem({
        id: 'space-3',
        name: 'Badged Space',
        notificationCategory: 'badged',
        badgeCount: 3,
      }),
    ];

    const client = makeClient(items);

    const allResult = await client.getNotifications();
    expect(allResult.unreadSpaces.map((item) => item.id)).toEqual(['space-1', 'space-2']);
    expect(allResult.badges.threadUnreadCount).toBe(1);

    const threadsOnly = await client.getNotifications({ threads: true });
    expect(threadsOnly.pagination.total).toBe(1);
    expect(threadsOnly.badges.threadUnreadCount).toBe(1);

    const spacesOnly = await client.getNotifications({ spaces: true });
    expect(spacesOnly.unreadSpaces.map((item) => item.id)).toEqual(['space-1', 'space-2']);
    expect(spacesOnly.pagination.total).toBe(2);
  });
});
