import { Command, Help } from 'commander';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from 'node:fs';
import * as readline from 'node:readline';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { DEFAULT_CACHE_DIR, createClient, resolveCacheDir } from '../app/client.js';
import { GoogleChatClient } from '../core/client.js';
import { exportChatBatches } from '../utils/export-chat.js';
import { startStayOnline } from '../utils/stay-online.js';
import { parseTimeToUsec } from '../utils/time.js';
import { startApiServer } from '../server/api-server.js';
import {
  getCookies,
  invalidateCookieCache,
  listBrowsersWithProfiles,
  setProfile,
  setBrowser,
  setDebugMode,
  type BrowserType,
} from '../core/auth.js';
import { log, setLogLevel, setLogColors, type LogLevel } from '../core/logger.js';
import type { Message, Space, Topic, WorldItemSummary, UserPresence, UserPresenceWithProfile, ImageMetadata, AttachmentMetadata, UrlMetadata } from '../core/types.js';

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

let useColors = true;

function c(color: keyof typeof colors, text: string): string {
  return useColors ? `${colors[color]}${text}${colors.reset}` : text;
}

function link(url: string, text?: string): string {
  const displayText = text || url;
  if (!useColors) {
    return text ? `${text} (${url})` : url;
  }
  return `\x1b]8;;${url}\x1b\\${c('cyan', displayText)}\x1b]8;;\x1b\\`;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatMessage(msg: Message, indent = '', showTopicId = false): string {
  const ts = msg.timestamp || 'Unknown';
  const sender = msg.sender || '';
  const text = msg.text.length > 300 ? msg.text.slice(0, 300) + '...' : msg.text;
  const prefix = msg.is_thread_reply ? '  ↳ ' : '';

  const mentionsStr = msg.mentions?.length
    ? c('red', ` [@${msg.mentions.map(m => m.display_name || m.user_id).join(', @')}]`)
    : '';

  const topicStr = showTopicId && msg.topic_id && !msg.is_thread_reply
    ? c('cyan', ` [topic: ${msg.topic_id}]`)
    : '';

  const lines: string[] = [
    `${indent}${prefix}${c('dim', `[${ts}]`)} ${c('blue', sender)}${mentionsStr}${topicStr}`,
    `${indent}${prefix}${text}`,
  ];

  if (msg.urls?.length) {
    for (const url of msg.urls) {
      const urlLine = url.title
        ? `${indent}${prefix}  ${c('dim', '🔗')} ${link(url.url, url.title)}`
        : `${indent}${prefix}  ${c('dim', '🔗')} ${link(url.url)}`;
      lines.push(urlLine);
    }
  }

  if (msg.images?.length) {
    for (const img of msg.images) {
      const sizeInfo = img.width && img.height ? ` ${img.width}x${img.height}` : '';
      const typeInfo = img.content_type ? ` [${img.content_type}]` : '';
      const altInfo = img.alt_text ? ` "${img.alt_text}"` : '';
      lines.push(`${indent}${prefix}  ${c('green', '🖼️  IMAGE')}${sizeInfo}${typeInfo}${altInfo}`);
      lines.push(`${indent}${prefix}     ${link(img.image_url)}`);
    }
  }

  if (msg.attachments?.length) {
    for (const att of msg.attachments) {
      const name = att.content_name || 'attachment';
      const size = formatFileSize(att.content_size);
      const typeInfo = att.content_type ? ` [${att.content_type}]` : '';
      lines.push(`${indent}${prefix}  ${c('yellow', '📎 FILE:')} ${name}${size ? ` (${size})` : ''}${typeInfo}`);
      if (att.download_url) {
        lines.push(`${indent}${prefix}     ${link(att.download_url, 'Download')}`);
      }
      if (att.thumbnail_url) {
        lines.push(`${indent}${prefix}     ${c('dim', 'Thumbnail:')} ${link(att.thumbnail_url)}`);
      }
    }
  }

  lines.push(`${indent}${c('dim', '-'.repeat(40))}`);

  return lines.join('\n');
}

function formatSpace(space: Space): string {
  const name = space.name || '(unnamed)';
  const type = c('dim', `[${space.type}]`);
  return `  ${c('cyan', space.id)}  ${name}  ${type}`;
}

function printHeader(text: string): void {
  const line = '='.repeat(60);
  console.log(`\n${c('bold', c('cyan', line))}`);
  console.log(`${c('bold', c('cyan', ` ${text}`))}`);
  console.log(`${c('bold', c('cyan', line))}\n`);
}

function printSection(text: string): void {
  console.log(`\n${c('bold', c('yellow', text))}`);
  console.log(c('dim', '-'.repeat(40)));
}

function printError(text: string): void {
  console.error(c('red', `Error: ${text}`));
}

function printInfo(text: string): void {
  console.log(c('cyan', text));
}

function printSuccess(text: string): void {
  console.log(c('green', text));
}

function printWarning(text: string): void {
  console.log(c('yellow', `Warning: ${text}`));
}

function formatWorldItem(item: WorldItemSummary, showReadStatus = false): string {
  const name = item.name || '(unnamed)';

  const categoryColors: Record<string, keyof typeof colors> = {
    badged: 'red',
    lit_up: 'yellow',
    none: 'dim',
  };
  const categoryLabels: Record<string, string> = {
    badged: `badge(${item.badgeCount ?? '?'})`,
    lit_up: 'bold',
    none: '-',
  };
  const category = item.notificationCategory || 'none';
  const categoryStr = c(categoryColors[category] || 'dim', categoryLabels[category] || category);

  const threadStr = item.subscribedThreadId
    ? c('dim', ` [thread: ${item.subscribedThreadId}]`)
    : '';
  const threadCountStr = item.threadIds?.length
    ? c('dim', ` [threads: ${item.threadIds.length}]`)
    : '';

  const isUnread = category !== 'none';
  const readStatusStr = showReadStatus
    ? (isUnread ? c('red', ' ●') : c('dim', ' ○'))
    : '';

  return `  ${c('cyan', item.id)}  ${name}  ${c('dim', `[${item.type}]`)}  ${categoryStr}${threadStr}${threadCountStr}${readStatusStr}`;
}

async function confirmAction(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function cmdSpaces(options: { refresh?: boolean; json?: boolean; profile?: string }): Promise<void> {
  const client = await createClient();
  const spaces = await client.listSpaces();

  if (options.json) {
    console.log(JSON.stringify(spaces, null, 2));
    return;
  }

  printHeader(`Found ${spaces.length} spaces`);

  const rooms = spaces.filter(s => s.type === 'space');
  const dms = spaces.filter(s => s.type === 'dm');

  if (rooms.length > 0) {
    printSection('SPACES / ROOMS');
    rooms.forEach(s => console.log(formatSpace(s)));
  }

  if (dms.length > 0) {
    printSection('DIRECT MESSAGES');
    dms.slice(0, 10).forEach(s => console.log(formatSpace(s)));
    if (dms.length > 10) {
      console.log(c('dim', `  ... and ${dms.length - 10} more DMs`));
    }
  }
}

async function cmdNotifications(options: {
  refresh?: boolean;
  json?: boolean;
  profile?: string;
  all?: boolean;
  dumpAuth?: boolean;
  showMessages?: boolean;
  messagesLimit?: string;
  mentions?: boolean;
  threads?: boolean;
  spaces?: boolean;
  dms?: boolean;
  read?: boolean;
  unread?: boolean;
  me?: boolean;
  atAll?: boolean;
  space?: string;
  limit?: string;
  offset?: string;
  parallel?: string;
}): Promise<void> {
  const client = await createClient();
  let { items, raw } = await client.fetchWorldItems();

  let mentionsShortcutId: string | undefined;
  if (options.me && !options.space) {
    const mentionsSpaces = await client.findSpaces('mentions');
    const mentionsShortcut = mentionsSpaces.find(s =>
      s.name?.toLowerCase().includes('mentions') ||
      s.name?.toLowerCase() === 'mentions-shortcut'
    );
    if (mentionsShortcut) {
      mentionsShortcutId = mentionsShortcut.id;
      if (!options.json) {
        printInfo(`Using mentions-shortcut channel: ${mentionsShortcut.name || mentionsShortcut.id}`);
      }
      items = items.filter(item => item.id === mentionsShortcutId);
    }
  }

  if (options.space) {
    items = items.filter(item => item.id === options.space);
    if (items.length === 0) {
      printError(`Space ${options.space} not found in world items`);
      return;
    }
  }

  if (options.me || options.atAll) {
    await client.getSelfUser();
  }

  const badgedItems = items.filter(item => item.notificationCategory === 'badged');
  const litUpItems = items.filter(item => item.notificationCategory === 'lit_up');
  const threadUnreadSpaces = items.filter(item => item.type === 'space' && item.notificationCategory === 'none' && (item.unreadSubscribedTopicCount > 0 || item.unreadReplyCount > 0));
  const unreadSpaces = [...litUpItems.filter(item => item.type === 'space'), ...threadUnreadSpaces];
  const readItems = items.filter(item => item.notificationCategory === 'none');
  const unreadDms = items.filter(item => item.type === 'dm' && item.notificationCategory !== 'none');
  const badgedSpaces = items.filter(item => item.type === 'space' && item.notificationCategory === 'badged');

  const hasCategoryFilter = options.mentions || options.threads || options.spaces || options.dms || options.read || options.me || options.atAll;
  const hasReadFilter = options.read || options.unread;
  const needsMentionCheck = options.me || options.atAll;

  const unreads = items.filter(item =>
    item.notificationCategory !== 'none' || threadUnreadSpaces.includes(item)
  );
  const dms = items.filter(item => item.type === 'dm');

  let dumpDir: string | null = null;
  if (options.dumpAuth) {
    dumpDir = join(tmpdir(), 'auth');
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, 'paginated_world.json'), JSON.stringify(raw, null, 2));
    writeFileSync(join(dumpDir, 'world_items.json'), JSON.stringify(items, null, 2));
  }

  let itemsToFetch: WorldItemSummary[] = [];
  if (hasCategoryFilter && !needsMentionCheck) {
    if (options.mentions) itemsToFetch = itemsToFetch.concat(badgedItems);
    if (options.threads) itemsToFetch = itemsToFetch.concat(threadUnreadSpaces);
    if (options.spaces) itemsToFetch = itemsToFetch.concat(unreadSpaces);
    if (options.dms) itemsToFetch = itemsToFetch.concat(unreadDms);
    if (options.read) itemsToFetch = itemsToFetch.concat(readItems);
  } else if (needsMentionCheck) {
    itemsToFetch = badgedItems;
  } else if (options.unread) {
    itemsToFetch = unreads;
  } else {
    itemsToFetch = unreads;
  }

  const totalBeforePagination = itemsToFetch.length;
  const offset = parseInt(options.offset || '0', 10);
  const limit = parseInt(options.limit || '0', 10);  
  if (offset > 0) {
    itemsToFetch = itemsToFetch.slice(offset);
  }
  if (limit > 0) {
    itemsToFetch = itemsToFetch.slice(0, limit);
  }

  const messagesLimit = parseInt(options.messagesLimit || '3', 10);
  const spaceMessages: Map<string, Message[]> = new Map();

  const shouldFetchMessages = options.showMessages || needsMentionCheck;

  const directMeMentionSpaces: WorldItemSummary[] = [];
  const atAllMentionSpaces: WorldItemSummary[] = [];

  const parallelLimit = parseInt(options.parallel || '5', 10);

  if (shouldFetchMessages && itemsToFetch.length > 0) {
    printInfo(`Fetching messages for ${itemsToFetch.length} items (${parallelLimit} parallel)...`);

    for (let i = 0; i < itemsToFetch.length; i += parallelLimit) {
      const batch = itemsToFetch.slice(i, i + parallelLimit);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const result = await client.getThreads(item.id, { pageSize: messagesLimit });
          return { item, result };
        })
      );

      for (const settledResult of results) {
        if (settledResult.status === 'fulfilled') {
          const { item, result } = settledResult.value;
          if (result.messages.length > 0) {
            spaceMessages.set(item.id, result.messages);

            if (needsMentionCheck) {
              let hasDirectMe = false;
              let hasAtAll = false;
              for (const msg of result.messages) {
                if (client.isDirectlyMentioned(msg)) {
                  hasDirectMe = true;
                }
                if (client.hasAllMention(msg)) {
                  hasAtAll = true;
                }
              }
              if (hasDirectMe) {
                directMeMentionSpaces.push(item);
              }
              if (hasAtAll && !hasDirectMe) {
                atAllMentionSpaces.push(item);
              }
            }
          }
        }
      }
    }
  }

  if (options.json) {
    const serverBadgeTotal = items.reduce(
      (sum, i) => sum + (i.badgeCount ?? 0), 0
    );
    const payload: Record<string, unknown> = {
      badged: options.mentions || !hasCategoryFilter ? badgedItems : [],
      unreadSpaces: options.spaces || !hasCategoryFilter ? unreadSpaces : [],
      threadUnreadSpaces: options.threads || !hasCategoryFilter ? threadUnreadSpaces : [],
      unreadDms: options.dms || !hasCategoryFilter ? unreadDms : [],
      readItems: options.read || options.all ? readItems : [],
      directMeMentions: options.me ? directMeMentionSpaces : [],
      atAllMentions: options.atAll ? atAllMentionSpaces : [],
      badges: {
        totalUnread: unreads.length,
        badgedCount: badgedItems.length,
        litUpCount: litUpItems.length,
        threadUnreadCount: threadUnreadSpaces.length,
        serverBadgeTotal,
        directMessages: unreadDms.length,
        badgedSpaces: badgedSpaces.length,
      },
      pagination: {
        total: totalBeforePagination,
        offset,
        limit: limit || totalBeforePagination,
        returned: itemsToFetch.length,
        hasMore: offset + itemsToFetch.length < totalBeforePagination,
      },
      unreads,
      dms,
    };
    if (options.all) {
      payload.all = items;
    }
    if (options.showMessages || needsMentionCheck) {
      payload.messages = Object.fromEntries(spaceMessages);
    }
    if (dumpDir) {
      payload.dumpDir = dumpDir;
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHeader('Notifications');

  if (needsMentionCheck) {
    printInfo(`@Me: ${directMeMentionSpaces.length}  @All: ${atAllMentionSpaces.length}  (of ${badgedItems.length} badged items scanned)`);
  } else {
    printInfo(`Badged: ${badgedItems.length}  Unread spaces: ${unreadSpaces.length}  DMs: ${unreadDms.length}  Read: ${readItems.length}`);
  }

  const showReadStatus = hasReadFilter || options.all;
  const showMessages = options.showMessages || needsMentionCheck;
  const printCategorySection = (title: string, categoryItems: WorldItemSummary[], limit?: number) => {
    if (categoryItems.length === 0) return;
    printSection(title);
    const displayItems = limit ? categoryItems.slice(0, limit) : categoryItems;
    for (const item of displayItems) {
      console.log(formatWorldItem(item, showReadStatus));
      if (showMessages && spaceMessages.has(item.id)) {
        const msgs = spaceMessages.get(item.id)!;
        for (const msg of msgs) {
          console.log(formatMessage(msg, '    ', false));
        }
      }
    }
    if (limit && categoryItems.length > limit) {
      printInfo(`  ... and ${categoryItems.length - limit} more`);
    }
  };

  if (options.me) {
    printCategorySection('DIRECT @ME MENTIONS', directMeMentionSpaces);
  }
  if (options.atAll) {
    printCategorySection('@ALL MENTIONS (not direct @me)', atAllMentionSpaces);
  }
  if (!hasCategoryFilter || options.mentions) {
    printCategorySection('BADGED (numbered badge)', badgedItems);
  }
  if (!hasCategoryFilter || options.spaces) {
    printCategorySection('UNREAD SPACES', unreadSpaces);
  }
  if (options.threads) {
    printCategorySection('THREAD UNREAD SPACES', threadUnreadSpaces);
  }
  if (!hasCategoryFilter || options.dms) {
    printCategorySection('DMs', unreadDms, 20);
  }
  if (options.read) {
    printCategorySection('READ (no activity)', readItems, 50);
  }

  if (options.all) {
    printSection('ALL');
    items.forEach(item => console.log(formatWorldItem(item, true)));
  }

  if (dumpDir) {
    printInfo(`Wrote raw data to ${dumpDir}`);
  }
}

async function cmdMessages(
  spaceId: string,
  options: { refresh?: boolean; json?: boolean; limit?: string; last?: string; profile?: string }
): Promise<void> {
  const client = await createClient();

  if (options.last) {
    const count = parseInt(options.last, 10);
    if (isNaN(count) || count <= 0) {
      printError('--last must be a positive number');
      process.exit(1);
    }

    // Fetch enough pages to collect the requested number of messages
    const maxPages = Math.max(Math.ceil(count / 25), 5);
    const result = await client.getAllMessages(spaceId, {
      maxPages,
      pageSize: 25,
      maxMessages: count,
    });

    // Sort all messages by timestamp (newest last) and take the last N
    const sorted = result.messages
      .filter((msg: Message) => msg.timestamp_usec)
      .sort((a: Message, b: Message) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0))
      .slice(-count);

    if (options.json) {
      console.log(JSON.stringify({ messages: sorted, total: sorted.length }, null, 2));
      return;
    }

    printHeader(`Last ${sorted.length} messages from ${spaceId}`);

    for (const msg of sorted) {
      console.log(formatMessage(msg, '', true));
    }

    if (result.has_more) {
      printInfo(`\nMore messages available beyond the fetched window.`);
    }
    return;
  }

  const limit = parseInt(options.limit || '20', 10);
  const result = await client.getThreads(spaceId, { pageSize: limit });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHeader(`Messages from ${spaceId}`);
  printInfo(`Found ${result.total_messages} messages in ${result.total_topics} threads`);

  for (const msg of result.messages) {
    console.log(formatMessage(msg, '', true));  
  }

  if (result.pagination.has_more) {
    printInfo(`\nMore messages available. Cursor: ${result.pagination.next_cursor}`);
  }
}

async function cmdThreads(
  spaceId: string,
  options: {
    refresh?: boolean;
    json?: boolean;
    pages?: string;
    pageSize?: string;
    full?: boolean;
    cursor?: string;
    profile?: string;
  }
): Promise<void> {
  const client = await createClient();

  const pages = parseInt(options.pages || '1', 10);
  const pageSize = parseInt(options.pageSize || '25', 10);
  const cursor = options.cursor ? parseInt(options.cursor, 10) : undefined;

  let result;
  if (pages > 1) {
    result = await client.getAllMessages(spaceId, {
      maxPages: pages,
      pageSize,
      fetchFullThreads: options.full,
    });
  } else {
    result = await client.getThreads(spaceId, {
      pageSize,
      cursor,
      fetchFullThreads: options.full,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHeader(`Threaded Messages from ${spaceId}`);

  const topics = 'topics' in result ? result.topics : [];
  const pagination = 'pagination' in result ? result.pagination : null;
  const pagesLoaded = 'pages_loaded' in result ? result.pages_loaded : 1;

  printInfo(`Found ${result.messages.length} messages in ${topics.length} threads`);
  if (pagesLoaded > 1) {
    printInfo(`Loaded ${pagesLoaded} pages`);
  }

  for (const topic of topics) {
    console.log(`\n${c('bold', `[THREAD: ${topic.topic_id.slice(0, 30)}...]`)}`);
    console.log(c('cyan', '='.repeat(50)));

    for (const msg of topic.replies) {
      console.log(formatMessage(msg));
    }
  }

  if (pagination?.has_more) {
    printInfo(`\nMore threads available. Cursor: ${pagination.next_cursor}`);
  }
}

async function cmdThread(
  spaceId: string,
  topicId: string,
  options: { refresh?: boolean; json?: boolean; profile?: string }
): Promise<void> {
  const client = await createClient();
  const result = await client.getThread(spaceId, topicId);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHeader(`Thread: ${topicId.slice(0, 30)}...`);
  printInfo(`Found ${result.total_messages} messages`);

  for (const msg of result.messages) {
    console.log(formatMessage(msg));
  }
}

async function cmdDMs(
  options: {
    refresh?: boolean;
    json?: boolean;
    profile?: string;
    limit?: string;
    messagesLimit?: string;
    parallel?: string;
    unread?: boolean;
  }
): Promise<void> {
  const client = await createClient();

  const limit = parseInt(options.limit || '0', 10);
  const messagesPerDM = parseInt(options.messagesLimit || '10', 10);
  const parallel = parseInt(options.parallel || '5', 10);

  printInfo(`Fetching DM conversations${options.unread ? ' (unread only)' : ''}...`);

  const result = await client.getDMs({
    limit,
    messagesPerDM,
    parallel,
    unreadOnly: options.unread,
    includeMessages: true, 
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHeader('Direct Messages');
  printInfo(`Found ${result.total} DM conversations`);

  for (const dm of result.dms) {
    const unreadIndicator = dm.unreadCount > 0 ? c('red', ` (${dm.unreadCount} unread)`) : '';
    printSection(`${dm.name || dm.id}${unreadIndicator}`);

    const messages = dm.messages || [];
    if (messages.length === 0) {
      console.log(c('dim', '  No messages'));
    } else {
      for (const msg of messages) {
        console.log(formatMessage(msg, '  ', false));
      }
    }
  }
}

async function cmdSearch(
  query: string,
  options: { refresh?: boolean; json?: boolean; space?: string; profile?: string }
): Promise<void> {
  const client = await createClient();

  let matches;
  if (options.space) {
    printInfo(`Searching for "${query}" in space ${options.space}...`);
    matches = await client.searchInSpace(options.space, query);
  } else {
    printInfo(`Searching for "${query}" across all spaces...`);
    matches = await client.searchAllSpaces(query);
  }

  if (options.json) {
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  printHeader(`Found ${matches.length} matches`);

  for (const msg of matches) {
    const space = msg.space_name || msg.space_id || '';
    const ts = msg.timestamp || '';
    const snippet = msg.snippet || msg.text.slice(0, 100);

    if (space) {
      console.log(`${c('cyan', `[${space}]`)} ${c('dim', `[${ts}]`)}`);
    } else {
      console.log(c('dim', `[${ts}]`));
    }
    console.log(`  ${snippet}`);
    console.log(c('dim', '-'.repeat(40)));
  }
}

async function cmdFindSpace(
  query: string,
  options: { refresh?: boolean; json?: boolean; profile?: string }
): Promise<void> {
  const client = await createClient();
  const matches = await client.findSpaces(query);

  if (options.json) {
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  printHeader(`Found ${matches.length} matching spaces`);

  for (const space of matches) {
    console.log(formatSpace(space));
  }
}

interface ExportChatState {
  spaceId: string;
  startedAt: string;
  lastUpdatedAt: string;
  oldestTimestamp?: number;
  newestTimestamp?: number;
  totalTopics: number;
  totalMessages: number;
  pagesLoaded: number;
  complete: boolean;
  cursor?: number;
  sortTimeCursor?: string;
  timestampCursor?: string;
  anchorTimestamp?: string;
}

interface ExportChatFile {
  state: ExportChatState;
  topics: Topic[];
}

function createEmptyExport(spaceId: string): ExportChatFile {
  const now = new Date().toISOString();
  return {
    state: {
      spaceId,
      startedAt: now,
      lastUpdatedAt: now,
      totalTopics: 0,
      totalMessages: 0,
      pagesLoaded: 0,
      complete: false,
    },
    topics: [],
  };
}

function formatTimestamp(usec?: number): string {
  if (!usec) return 'N/A';
  return new Date(usec / 1000).toISOString();
}

async function cmdExport(
  spaceId: string,
  options: {
    output?: string;
    batchSize?: string;
    since?: string;
    until?: string;
    fullThreads?: boolean;
    maxPages?: string;
    yes?: boolean;
    dryRun?: boolean;
    verbose?: boolean;
    json?: boolean;
    refresh?: boolean;
    profile?: string;
    cacheDir?: string;
  }
): Promise<void> {
  const client = await createClient();

  const outputFile =
    options.output
      ? (options.output.endsWith('.json') ? options.output : `${options.output}.json`)
      : `export-${spaceId}-${new Date().toISOString().slice(0, 10)}.json`;

  const batchSize = parseInt(options.batchSize || '100', 10);
  const maxPages = parseInt(options.maxPages || '1000', 10);
  const dryRun = options.dryRun || false;
  const verbose = options.verbose || false;

  const sinceUsec = options.since ? parseTimeToUsec(options.since) : undefined;
  const untilUsec = options.until ? parseTimeToUsec(options.until) : undefined;
  if (options.since && sinceUsec === undefined) throw new Error(`Invalid --since value: ${options.since}`);
  if (options.until && untilUsec === undefined) throw new Error(`Invalid --until value: ${options.until}`);

  let exportData = createEmptyExport(spaceId);
  const topicMap = new Map<string, Topic>();

  if (existsSync(outputFile) && !dryRun) {
    try {
      const existing = JSON.parse(readFileSync(outputFile, 'utf8')) as ExportChatFile;
      if (existing?.state?.spaceId && existing.state.spaceId !== spaceId) {
        throw new Error(`Output file is for space ${existing.state.spaceId}, not ${spaceId}`);
      }
      exportData = existing;
      for (const t of existing.topics || []) topicMap.set(t.topic_id, t);
    } catch (err) {
      printWarning(`Could not load existing export (${(err as Error).message}); starting fresh`);
      exportData = createEmptyExport(spaceId);
    }
  }

  let sortTimeCursor: string | undefined =
    exportData.state.sortTimeCursor || (exportData.state.cursor ? String(exportData.state.cursor) : undefined);
  let timestampCursor: string | undefined = exportData.state.timestampCursor;
  let anchorTimestamp: string | undefined = exportData.state.anchorTimestamp;

  printHeader('Export Chat History');
  printInfo(`Space ID:     ${spaceId}`);
  printInfo(`Output:       ${outputFile}${dryRun ? c('yellow', ' (dry-run)') : ''}`);
  printInfo(`Batch size:   ${batchSize} topics/page`);
  printInfo(`Full threads: ${options.fullThreads ? 'yes (fetch ALL replies)' : 'no (embedded replies only)'}`);
  if (options.since) printInfo(`Since:        ${options.since} (${formatTimestamp(sinceUsec)})`);
  if (options.until) printInfo(`Until:        ${options.until} (${formatTimestamp(untilUsec)})`);
  if (topicMap.size > 0) printInfo(`Resume:       ${topicMap.size} existing topics`);
  console.log('');

  if (existsSync(outputFile) && !dryRun && !options.yes) {
    const confirmed = await confirmAction('Output file exists. Resume/overwrite?');
    if (!confirmed) {
      printInfo('Cancelled.');
      return;
    }
  }

  let pagesLoaded = 0;
  let newTopics = 0;
  let newMessages = 0;

  const save = (cursorNum?: number) => {
    if (dryRun) return;
    exportData.state.lastUpdatedAt = new Date().toISOString();
    exportData.state.pagesLoaded = pagesLoaded;
    exportData.state.totalTopics = topicMap.size;
    exportData.state.cursor = cursorNum;
    exportData.state.sortTimeCursor = sortTimeCursor;
    exportData.state.timestampCursor = timestampCursor;
    exportData.state.anchorTimestamp = anchorTimestamp;

    exportData.topics = Array.from(topicMap.values());
    exportData.state.totalMessages = exportData.topics.reduce((sum, t) => sum + (t.replies?.length || 0), 0);
    writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
  };

  try {
    for await (const batch of exportChatBatches(client, spaceId, {
      pageSize: batchSize,
      since: sinceUsec,
      until: untilUsec,
      maxPages,
      fullThreads: options.fullThreads || false,
      cursors: { sortTimeCursor, timestampCursor, anchorTimestamp },
    })) {
      pagesLoaded = batch.page;
      sortTimeCursor = batch.pagination.next_sort_time_cursor;
      timestampCursor = batch.pagination.next_timestamp_cursor;
      anchorTimestamp = batch.pagination.anchor_timestamp || anchorTimestamp;

      for (const topic of batch.topics) {
        if (topicMap.has(topic.topic_id)) continue;
        topicMap.set(topic.topic_id, topic);
        newTopics++;
        newMessages += topic.replies.length;

        const sortTime =
          typeof topic.sort_time === 'number'
            ? topic.sort_time
            : (typeof topic.sort_time === 'string' ? parseInt(topic.sort_time, 10) : undefined);
        if (sortTime) {
          if (!exportData.state.newestTimestamp || sortTime > exportData.state.newestTimestamp) {
            exportData.state.newestTimestamp = sortTime;
          }
          if (!exportData.state.oldestTimestamp || sortTime < exportData.state.oldestTimestamp) {
            exportData.state.oldestTimestamp = sortTime;
          }
        }
      }

      if (verbose) {
        printInfo(
          `Page ${batch.page}: +${batch.topics.length} topics, +${batch.messages.length} messages (total ${topicMap.size} topics)`
        );
      } else {
        process.stdout.write(
          `\r📦 ${topicMap.size} topics (+${newTopics}), ${newMessages} new messages | Range: ${formatTimestamp(exportData.state.oldestTimestamp).slice(0, 10)} → ${formatTimestamp(exportData.state.newestTimestamp).slice(0, 10)}   `
        );
      }

      if (batch.page % 10 === 0) {
        const cursorNum = sortTimeCursor ? parseInt(sortTimeCursor, 10) : undefined;
        save(cursorNum);
        if (verbose) printInfo('Progress saved');
      }
    }

    exportData.state.complete = pagesLoaded < maxPages;
    const cursorNum = sortTimeCursor ? parseInt(sortTimeCursor, 10) : undefined;
    save(cursorNum);

    console.log('');
    printSuccess('Export complete');
    printInfo(`Pages:    ${pagesLoaded}${pagesLoaded >= maxPages ? c('yellow', ' (maxPages reached)') : ''}`);
    printInfo(`Topics:   ${topicMap.size} (+${newTopics})`);
    printInfo(`Messages: ${newMessages} new`);
    if (!dryRun) printInfo(`Saved:    ${outputFile}`);

    if (options.json) {
      console.log(JSON.stringify(exportData.state, null, 2));
    }
  } catch (err) {
    const cursorNum = sortTimeCursor ? parseInt(sortTimeCursor, 10) : undefined;
    save(cursorNum);
    throw err;
  }
}

async function cmdDownload(
  spaceId: string,
  options: {
    output?: string;
    batchSize?: string;
    yes?: boolean;
    json?: boolean;
    refresh?: boolean;
    profile?: string;
    cacheDir?: string;
  }
): Promise<void> {
  printWarning('The "download" command is deprecated. Use "gchat export" instead.');
  await cmdExport(spaceId, {
    ...options,
    output: options.output || `export-${spaceId}.json`,
  });
}

async function cmdStayOnline(options: {
  pingInterval?: string;
  presenceTimeout?: string;
  subscribe?: boolean;
  quiet?: boolean;
  profile?: string;
  cacheDir?: string;
}): Promise<void> {
  const pingIntervalSec = parseInt(options.pingInterval || '60', 10);
  const presenceTimeoutSec = parseInt(options.presenceTimeout || '120', 10);
  const quiet = options.quiet || false;

  printHeader('Stay Online Mode');
  console.log(`  Ping interval: ${pingIntervalSec} seconds`);
  console.log(`  Presence timeout: ${presenceTimeoutSec} seconds`);
  console.log(`  Subscribe to spaces: ${options.subscribe ? 'yes' : 'no'}`);
  console.log(`  Press Ctrl+C to stop\n`);

  const client = await createClient();
  let lastPingCount = 0;
  let isShuttingDown = false;

  const session = await startStayOnline(client, {
    subscribe: !!options.subscribe,
    pingIntervalSec,
    presenceTimeoutSec,
    onEvent: (evt) => {
      const ts = evt.timestamp;
      switch (evt.type) {
        case 'connect':
          console.log(`${c('dim', `[${ts}]`)} ${c('green', '✓')} Connected`);
          break;
        case 'disconnect':
          if (!isShuttingDown) {
            console.log(`${c('dim', `[${ts}]`)} ${c('yellow', '!')} Disconnected (will reconnect)`);
          }
          break;
        case 'subscribed':
          console.log(`${c('dim', `[${ts}]`)} ${c('green', '●')} Subscribed to ${evt.conversations} conversations`);
          break;
        case 'ping':
          lastPingCount = evt.count;
          if (!quiet) console.log(`${c('dim', `[${ts}]`)} ${c('green', '♥')} Ping #${evt.count}`);
          break;
        case 'message': {
          if (quiet) break;
          const msg = evt.event.body?.message;
          const from = msg?.creator?.name || msg?.creator?.email || 'Unknown';
          const text = msg?.text?.substring(0, 50) || '(no text)';
          console.log(`${c('dim', `[${ts}]`)} ${c('cyan', '💬')} ${from}: ${text}${(msg?.text?.length || 0) > 50 ? '...' : ''}`);
          break;
        }
        case 'typing':
          if (!quiet) console.log(`${c('dim', `[${ts}]`)} ${c('dim', '✎')} Typing event`);
          break;
        case 'error':
          console.log(`${c('dim', `[${ts}]`)} ${c('red', '✗')} ${evt.error.message}`);
          break;
      }
    },
  });

  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${c('yellow', 'Shutting down...')}`);
    console.log(`  Total pings: ${lastPingCount}`);
    session.stop();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await session.done;
}

function findBrowserExecutable(browserPreference?: string): string {
  const browserPaths: Record<string, string[]> = {
    brave: [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/usr/bin/brave-browser',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
    chrome: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    chromium: [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    edge: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/microsoft-edge',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    arc: ['/Applications/Arc.app/Contents/MacOS/Arc'],
  };

  const allPaths: string[] = [];
  const defaultOrder = ['brave', 'chrome', 'chromium', 'edge', 'arc'];

  if (browserPreference && browserPreference in browserPaths) {
    allPaths.push(...browserPaths[browserPreference]);
    for (const b of defaultOrder) {
      if (b !== browserPreference) {
        allPaths.push(...browserPaths[b]);
      }
    }
  } else {
    for (const b of defaultOrder) {
      allPaths.push(...browserPaths[b]);
    }
  }

  for (const p of allPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  throw new Error('No supported browser found. Please install Chrome, Brave, Chromium, Edge, or Arc.');
}

async function cmdPresence(options: {
  refreshInterval?: string;
  headless?: boolean;
  debugPort?: string;
  quiet?: boolean;
  browser?: string;
  profile?: string;
  forceLogin?: boolean;
  cacheDir?: string;
  debug?: boolean;
  channel?: string;
}): Promise<void> {
  const refreshIntervalSec = parseInt(options.refreshInterval || '300', 10);
  let headless = options.headless !== false;
  const debugPort = options.debugPort ? parseInt(options.debugPort, 10) : undefined;
  const quiet = options.quiet || false;
  const forceLogin = options.forceLogin || false;
  const debug = options.debug || false;
  const channel = options.channel || 'AAAAWFu1kqo';

  const dbg = (msg: string) => {
    if (debug) {
      const ts = new Date().toISOString();
      console.log(`${c('dim', `[${ts}]`)} ${c('yellow', 'DBG')} ${msg}`);
    }
  };

  printHeader('Playwright Presence');
  console.log(`  Mode: ${headless ? 'headless' : 'visible browser'}`);
  console.log(`  Channel: ${channel}`);
  console.log(`  Typing interval: ${refreshIntervalSec}s`);
  console.log(`  Debug: ${debug ? 'on' : 'off'}`);
  if (debugPort) console.log(`  Debug port: ${debugPort}`);
  console.log(`  Press Ctrl+C to stop\n`);

  const askQuestion = (prompt: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
  };

  const testProfileAuth = (browserType: BrowserType, profile: string): { valid: boolean; keys: string[] } => {
    try {
      setBrowser(browserType);
      setProfile(profile);
      invalidateCookieCache('.');
      const cookies = getCookies();
      const required = ['SID', 'HSID', 'SSID', 'OSID'];
      const found = required.filter(k => k in cookies && cookies[k]);
      return { valid: found.length === required.length, keys: found };
    } catch {
      return { valid: false, keys: [] };
    }
  };

  let selectedBrowserType = options.browser;
  let selectedProfile = options.profile;

  const browsersWithProfiles = listBrowsersWithProfiles();
  dbg(`Discovered ${browsersWithProfiles.length} browser(s)`);

  if (browsersWithProfiles.length === 0) {
    printError('No supported browsers found. Please install Chrome, Brave, Edge, Chromium, or Arc.');
    process.exit(1);
  }

  if (!selectedBrowserType) {
    console.log(c('bold', '\n  Available browsers:\n'));
    browsersWithProfiles.forEach(({ browser: b, profiles }, i) => {
      const profileList = profiles.length > 0 ? ` (${profiles.length} profile${profiles.length > 1 ? 's' : ''})` : '';
      console.log(`    ${c('cyan', `[${i + 1}]`)} ${b.name}${c('dim', profileList)}`);
      dbg(`  ${b.type} → ${b.basePath}`);
    });
    console.log();

    const choice = await askQuestion(`  Select browser [1-${browsersWithProfiles.length}]: `);
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= browsersWithProfiles.length) {
      printError(`Invalid choice: "${choice}"`);
      process.exit(1);
    }
    selectedBrowserType = browsersWithProfiles[idx].browser.type;
    dbg(`User selected browser: ${selectedBrowserType}`);
  }

  setBrowser(selectedBrowserType as BrowserType);

  const matchedEntry = browsersWithProfiles.find(
    e => e.browser.type === selectedBrowserType
  );
  const availableProfiles = matchedEntry?.profiles || [];
  dbg(`Available profiles for ${selectedBrowserType}: ${JSON.stringify(availableProfiles)}`);

  if (availableProfiles.length > 0) {
    printInfo(`Testing auth for ${availableProfiles.length} profile(s)...`);
    console.log();

    const profileResults: Array<{ profile: string; valid: boolean; keys: string[] }> = [];
    for (const p of availableProfiles) {
      const result = testProfileAuth(selectedBrowserType as BrowserType, p);
      profileResults.push({ profile: p, ...result });
      const status = result.valid
        ? c('green', 'valid')
        : result.keys.length > 0
          ? c('yellow', `partial (${result.keys.join(', ')})`)
          : c('red', 'no cookies');
      const isDefault = p === 'Default' ? c('dim', ' (default)') : '';
      const idx = profileResults.length;
      console.log(`    ${c('cyan', `[${idx}]`)} ${p}${isDefault}  →  ${status}`);
      dbg(`  Profile "${p}": valid=${result.valid}, keys=[${result.keys.join(',')}]`);
    }
    console.log();

    if (!selectedProfile) {
      const validProfiles = profileResults.filter(r => r.valid);
      if (validProfiles.length === 1 && availableProfiles.length > 1) {
        selectedProfile = validProfiles[0].profile;
        printInfo(`Auto-selected "${selectedProfile}" (only profile with valid cookies)`);
      } else if (availableProfiles.length === 1) {
        selectedProfile = availableProfiles[0];
        dbg(`Auto-selected only profile: ${selectedProfile}`);
      } else {
        const choice = await askQuestion(`  Select profile [1-${availableProfiles.length}]: `);
        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= availableProfiles.length) {
          printError(`Invalid choice: "${choice}"`);
          process.exit(1);
        }
        selectedProfile = availableProfiles[idx];
        dbg(`User selected profile: ${selectedProfile}`);
      }
    }
  }

  if (selectedProfile) {
    setBrowser(selectedBrowserType as BrowserType);
    setProfile(selectedProfile);
    printInfo(`Using profile: ${selectedProfile}`);
  }

  const cacheDir = resolveCacheDir(options);
  mkdirSync(cacheDir, { recursive: true });
  const stateFilePath = path.join(cacheDir, 'presence-state.json');
  dbg(`Cache dir: ${cacheDir}`);
  dbg(`State file: ${stateFilePath}`);

  if (forceLogin && existsSync(stateFilePath)) {
    printInfo('Clearing saved authentication state...');
    unlinkSync(stateFilePath);
  }

  const executablePath = findBrowserExecutable(selectedBrowserType);
  printInfo(`Using browser executable: ${executablePath}`);

  const { chromium } = await import('playwright-core');

  type PlaywrightBrowser = Awaited<ReturnType<typeof chromium.launch>>;
  type PlaywrightContext = Awaited<ReturnType<PlaywrightBrowser['newContext']>>;
  let browser: PlaywrightBrowser | null = null;
  let context: PlaywrightContext | null = null;
  let isShuttingDown = false;
  let refreshCount = 0;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${c('yellow', 'Shutting down...')}`);
    console.log(`  Total refreshes: ${refreshCount}`);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    printInfo('Launching browser...');
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--window-size=1280,720',
    ];
    if (debugPort) {
      launchArgs.push(`--remote-debugging-port=${debugPort}`);
    }

    const hasState = existsSync(stateFilePath);
    dbg(`Saved state exists: ${hasState}`);
    if (!hasState) {
      printInfo('No saved state — will prompt for login');
      headless = false; 
    }

    dbg(`Launching browser: headless=${headless}, exe=${executablePath}`);
    dbg(`Launch args: ${JSON.stringify(launchArgs)}`);
    browser = await chromium.launch({
      headless,
      executablePath,
      args: launchArgs,
    });
    dbg('Browser launched OK');

    const contextOptions: Record<string, unknown> = {};
    if (hasState) {
      try {
        printInfo('Loading saved authentication state...');
        const raw = readFileSync(stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        dbg(`State file cookies: ${parsed.cookies?.length ?? 0}, origins: ${parsed.origins?.length ?? 0}`);
        contextOptions.storageState = stateFilePath;
      } catch (err) {
        printError(`Failed to load state: ${(err as Error).message}`);
        printInfo('Clearing corrupted state...');
        unlinkSync(stateFilePath);
      }
    }

    context = await browser.newContext({
      ...contextOptions,
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    await context.addInitScript({ content: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined })' });

    const page = await context.newPage();
    dbg('New page created');

    if (debug) {
      page.on('console', msg => dbg(`PAGE ${msg.type()}: ${msg.text()}`));
      page.on('pageerror', err => dbg(`PAGE ERROR: ${err.message}`));
      page.on('requestfailed', req => dbg(`REQUEST FAILED: ${req.url()} → ${req.failure()?.errorText}`));
    }

    const injectBannerAndWait = async (message: string) => {
      await page.evaluate((msg: string) => {
        if ((globalThis as any).__gchat_continue) return;
        (globalThis as any).__gchat_continue = false;

        const banner = (globalThis as any).document.createElement('div');
        banner.id = 'gchat-presence-banner';
        Object.assign(banner.style, {
          position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
          background: 'linear-gradient(135deg, #1a73e8, #174ea6)',
          color: 'white', padding: '14px 24px', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between',
          fontFamily: "'Google Sans', Roboto, Arial, sans-serif",
          fontSize: '14px', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        });

        const span = (globalThis as any).document.createElement('span');
        span.textContent = msg;

        const btn = (globalThis as any).document.createElement('button');
        btn.textContent = 'Save Session & Start';
        Object.assign(btn.style, {
          background: 'white', color: '#1a73e8', border: 'none',
          borderRadius: '4px', padding: '8px 24px', fontSize: '14px',
          fontWeight: '600', cursor: 'pointer', marginLeft: '16px',
          whiteSpace: 'nowrap',
          fontFamily: "'Google Sans', Roboto, Arial, sans-serif",
        });
        btn.addEventListener('click', () => {
          (globalThis as any).__gchat_continue = true;
          banner.remove();
        });

        banner.appendChild(span);
        banner.appendChild(btn);
        (globalThis as any).document.body.appendChild(banner);
      }, message);

      await page.waitForFunction(() => (globalThis as any).__gchat_continue === true, { timeout: 0 });
    };

    const chatUrl = 'https://mail.google.com/chat';
    printInfo(`Navigating to ${chatUrl}...`);
    try {
      await page.goto(chatUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      dbg(`Navigation complete, URL: ${page.url()}`);
    } catch (err) {
      dbg(`Navigation threw: ${(err as Error).message}`);
      printInfo('Initial navigation slow, continuing...');
    }

    dbg('Waiting 5s for page to settle...');
    await new Promise(r => setTimeout(r, 5000));

    const currentUrl = page.url();
    dbg(`Current URL: ${currentUrl}`);
    const pageTitle = await page.title().catch(() => '(unknown)');
    dbg(`Page title: ${pageTitle}`);

    const earlyScreenshot = path.join(tmpdir(), 'gchat-presence-early.png');
    await page.screenshot({ path: earlyScreenshot, fullPage: true }).catch(() => {});
    dbg(`Early screenshot: ${earlyScreenshot}`);

    const isChatPage = (u: string) =>
      u.includes('mail.google.com/chat') ||
      u.includes('chat.google.com') ||
      u.includes('mail.google.com/mail') 
    ;

    if (!isChatPage(currentUrl)) {
      dbg(`Auth required — current URL is not a Chat page: ${currentUrl}`);

      if (currentUrl.includes('workspace.google.com')) {
        dbg('Redirected to marketing page — navigating to accounts.google.com sign-in');
        await page.goto('https://accounts.google.com/ServiceLogin?continue=https://mail.google.com/chat', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        }).catch(() => {});
        dbg(`After sign-in redirect, URL: ${page.url()}`);
      }

      printInfo('Not logged in. Please log in manually in the browser window...');
      printInfo('Waiting for you to reach Google Chat (up to 5 minutes)...');

      try {
        await page.waitForURL(url => isChatPage(url.toString()), {
          timeout: 300000, 
        });
        dbg(`Login redirect detected, new URL: ${page.url()}`);
      } catch {
        const failUrl = page.url();
        dbg(`Login timeout, final URL: ${failUrl}`);
        const failScreenshot = path.join(tmpdir(), 'gchat-presence-login-fail.png');
        await page.screenshot({ path: failScreenshot, fullPage: true }).catch(() => {});
        printError(`Login timeout — stuck at: ${failUrl}`);
        printInfo(`Screenshot: ${failScreenshot}`);
        printInfo('Please try again with --force-login');
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        process.exit(1);
      }

      dbg('Waiting 5s for Chat UI to settle after login...');
      await new Promise(r => setTimeout(r, 5000));
      dbg(`Post-login URL: ${page.url()}`);
    } else {
      printInfo('Already logged in');
    }

    if (!headless) {
      printInfo('Click "Save Session & Start" in the browser when ready...');
      dbg('Injecting confirmation banner...');
      await injectBannerAndWait("gchat presence is ready. Verify you see your chats, then click the button.");
      dbg('User clicked the banner');
    } else {
      dbg('Headless mode — skipping banner confirmation');
    }

    printInfo('Saving authentication state...');
    await context.storageState({ path: stateFilePath });
    printInfo(`Saved to ${stateFilePath}`);
    dbg(`State file size: ${readFileSync(stateFilePath, 'utf-8').length} bytes`);

    const screenshotPath = path.join(tmpdir(), 'gchat-presence-logged-in.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const timestamp = new Date().toISOString();
    console.log(`${c('dim', `[${timestamp}]`)} ${c('green', '✓')} Connected to Google Chat`);
    console.log(`${c('dim', `[${timestamp}]`)} ${c('cyan', '→')} Screenshot: ${screenshotPath}`);

    const cookies = getCookies();
    dbg(`API cookies extracted: ${Object.keys(cookies).length} keys`);
    try {
      printInfo('Verifying user...');
      const client = new GoogleChatClient(cookies, cacheDir);
      await client.authenticate(true);
      const user = await client.getSelfUser();
      if (user?.email) {
        console.log(`${c('dim', `[${timestamp}]`)} ${c('cyan', '→')} Logged in as: ${c('green', user.email)}`);
        if (user.name) {
          console.log(`${c('dim', `[${timestamp}]`)} ${c('cyan', '→')} Name: ${c('blue', user.name)}`);
        }
      }
    } catch (err) {
      dbg(`User verification failed: ${(err as Error).stack}`);
      console.log(`${c('dim', `[${timestamp}]`)} ${c('yellow', '⚠')} Failed to fetch user: ${(err as Error).message}`);
    }

    const channelUrl = `https://mail.google.com/chat/u/0/#chat/space/${channel}`;
    printInfo(`Opening channel: ${channelUrl}`);
    try {
      await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      dbg(`Channel URL loaded: ${page.url()}`);
    } catch {
      dbg('Channel navigation slow, continuing...');
    }

    dbg('Waiting 10s for channel to render...');
    await new Promise(r => setTimeout(r, 10000));

    if (debug) {
      const chanScreenshot = path.join(tmpdir(), 'gchat-presence-channel.png');
      await page.screenshot({ path: chanScreenshot, fullPage: true }).catch(() => {});
      dbg(`Channel screenshot: ${chanScreenshot}`);
    }

    const inputSelectors = [
      'div[role="textbox"][aria-label*="message" i]',
      'div[role="textbox"][aria-label*="Message" i]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="chat" i]',
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[role="textbox"]',
      'textarea[aria-label*="message" i]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="plaintext-only"]',
      'div[contenteditable="true"]',
    ];

    const dumpEditables = async (frame: { evaluate: typeof page.evaluate }, label: string) => {
      try {
        const elements = await frame.evaluate(() => {
          const results: string[] = [];
          (globalThis as any).document.querySelectorAll('[contenteditable], [role="textbox"], textarea, iframe').forEach((el: any) => {
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const aria = el.getAttribute('aria-label') || '';
            const ce = el.getAttribute('contenteditable') || '';
            const ph = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
            const src = tag === 'iframe' ? (el.getAttribute('src') || '').slice(0, 100) : '';
            results.push(`<${tag} role="${role}" aria-label="${aria}" contenteditable="${ce}" placeholder="${ph}"${src ? ` src="${src}"` : ''}>`);
          });
          return results;
        });
        dbg(`[${label}] Found ${elements.length} editable/iframe element(s):`);
        for (const e of elements) dbg(`  ${e}`);
      } catch (err) {
        dbg(`[${label}] Failed to dump editables: ${(err as Error).message}`);
      }
    };

    if (debug) {
      await dumpEditables(page, 'main');
      const frames = page.frames();
      dbg(`Page has ${frames.length} frame(s)`);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        dbg(`  Frame ${i}: ${f.url().slice(0, 120)}`);
        await dumpEditables(f, `frame-${i}`);
      }
    }

    const isComposeBox = async (el: Awaited<ReturnType<typeof page.$>>) => {
      if (!el) return false;
      try {
        const info = await el.evaluate((node: any) => ({
          text: (node.textContent || '').trim(),
          height: node.getBoundingClientRect().height,
          ariaLabel: node.getAttribute('aria-label') || '',
        }));
        dbg(`  Candidate: text="${info.text.slice(0, 40)}" height=${info.height} aria="${info.ariaLabel}"`);
        return info.text.length === 0 && info.height < 200;
      } catch {
        return false;
      }
    };

    const focusInput = async (): Promise<boolean> => {
      const searchFrame = async (frame: typeof page | ReturnType<typeof page.frames>[0], label: string): Promise<boolean> => {
        for (const sel of inputSelectors) {
          try {
            const els = await frame.$$(sel);
            for (const el of els) {
              if (await isComposeBox(el)) {
                await el.click();
                dbg(`Focused compose box [${label}]: ${sel}`);
                return true;
              }
            }
          } catch {}
        }
        return false;
      };

      if (await searchFrame(page, 'main')) return true;

      const frames = page.frames();
      for (let i = 0; i < frames.length; i++) {
        if (await searchFrame(frames[i], `frame-${i}`)) return true;
      }

      dbg('Could not find compose box in any frame');
      return false;
    };

    const simulateTyping = async () => {
      const focused = await focusInput();
      if (!focused) return;

      const numChars = 2 + Math.floor(Math.random() * 3); 
      const chars = 'abcdefghijklmnopqrstuvwxyz';

      for (let i = 0; i < numChars; i++) {
        const ch = chars[Math.floor(Math.random() * chars.length)];
        await page.keyboard.type(ch, { delay: 80 + Math.random() * 120 });
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      }

      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));

      for (let i = 0; i < numChars; i++) {
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
      }
    };

    await new Promise(r => setTimeout(r, 3000));
    console.log(`${c('dim', `[${timestamp}]`)} ${c('cyan', '→')} Starting typing simulation in channel ${channel}...`);
    await simulateTyping();
    console.log(`${c('dim', `[${new Date().toISOString()}]`)} ${c('green', '●')} ONLINE`);

    const refreshLoop = async () => {
      while (!isShuttingDown) {
        await new Promise(resolve => setTimeout(resolve, refreshIntervalSec * 1000));
        if (isShuttingDown) break;

        refreshCount++;
        const ts = new Date().toISOString();
        try {
          await simulateTyping();

          if (!quiet) {
            console.log(`${c('dim', `[${ts}]`)} ${c('green', '♥')} Typing #${refreshCount}`);
          }
        } catch (err) {
          console.log(`${c('dim', `[${ts}]`)} ${c('red', '✗')} Typing #${refreshCount} failed: ${(err as Error).message}`);
        }
      }
    };

    await refreshLoop();
  } catch (err) {
    if (!isShuttingDown) {
      printError((err as Error).message);
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      process.exit(1);
    }
  }
}

const program = new Command();

program
  .name('gchat')
  .description('Google Chat CLI client')
  .version('1.0.0')
  .option('--no-color', 'Disable colored output')
  .option('--json', 'Output as JSON')
  .option('--debug', 'Enable debug output')
  .option('--log-level <level>', 'Set log level (error, warn, info, debug, silent)', 'info')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.color === false || !process.stdout.isTTY) {
      useColors = false;
      setLogColors(false);
    }
    if (opts.debug) {
      setDebugMode(true);
      setLogLevel('debug');
    } else if (opts.logLevel) {
      setLogLevel(opts.logLevel as LogLevel);
    }
  });

program
  .command('spaces')
  .description('List all spaces')
  .action(async () => {
    try {
      await cmdSpaces(program.opts());
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('notifications')
  .description('List unread counts, mentions, and direct messages')
  .option('--all', 'Include all world items in output')
  .option('--dump-auth', 'Write raw paginated_world data to the auth tmp dir')
  .option('-m, --show-messages', 'Fetch and display actual messages for each unread space')
  .option('-n, --messages-limit <num>', 'Number of messages per space (default: 3)', '3')
  .option('--mentions', 'Show only direct @mentions')
  .option('--threads', 'Show only thread-unread spaces')
  .option('--spaces', 'Show only unread spaces')
  .option('--dms', 'Show only direct messages')
  .option('--read', 'Show read items (no unread activity)')
  .option('--unread', 'Show only unread items (default behavior)')
  .option('--me', 'Show only spaces where YOU are directly @mentioned (uses mentions-shortcut channel)')
  .option('--at-all', 'Show only spaces with @all mentions (not direct @me)')
  .option('-s, --space <id>', 'Filter to a specific space ID')
  .option('-l, --limit <num>', 'Limit number of spaces to process (for faster results)')
  .option('-o, --offset <num>', 'Skip first N spaces (for pagination)', '0')
  .option('-p, --parallel <num>', 'Number of parallel requests when fetching messages (default: 5)', '5')
  .action(async (opts) => {
    try {
      await cmdNotifications({ ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('messages <space_id>')
  .description('Get messages from a space')
  .option('-n, --limit <num>', 'Number of messages', '20')
  .option('--last <num>', 'Fetch the most recent N messages (handles pagination automatically)')
  .action(async (spaceId, opts) => {
    try {
      await cmdMessages(spaceId, { ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('threads <space_id>')
  .description('Get threaded messages with pagination')
  .option('-p, --pages <num>', 'Number of pages', '1')
  .option('-s, --page-size <num>', 'Topics per page', '25')
  .option('--full', 'Fetch full thread contents')
  .option('--cursor <timestamp>', 'Pagination cursor')
  .action(async (spaceId, opts) => {
    try {
      await cmdThreads(spaceId, { ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('thread <space_id> <topic_id>')
  .description('Get all messages in a specific thread')
  .action(async (spaceId, topicId) => {
    try {
      await cmdThread(spaceId, topicId, program.opts());
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('dms')
  .description('Get all direct message conversations with messages')
  .option('-l, --limit <num>', 'Limit number of DM conversations to fetch')
  .option('-n, --messages-limit <num>', 'Number of messages per DM (default: 10)', '10')
  .option('-p, --parallel <num>', 'Number of parallel requests (default: 5)', '5')
  .option('--unread', 'Show only unread DMs')
  .action(async (opts) => {
    try {
      await cmdDMs({ ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('search <query>')
  .description('Search messages')
  .option('-s, --space <space_id>', 'Limit to specific space')
  .action(async (query, opts) => {
    try {
      await cmdSearch(query, { ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('find-space <query>')
  .description('Search for spaces by name')
  .action(async (query) => {
    try {
      await cmdFindSpace(query, program.opts());
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('send <space_id> <message>')
  .description('Send a message to a space (new thread or reply to existing thread)')
  .option('-t, --thread <topic_id>', 'Reply to an existing thread instead of creating a new one')
  .option('-i, --image <path>', 'Attach an image file (png, jpg, gif, webp)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (spaceId, message, opts) => {
    try {
      const isReply = !!opts.thread;
      const hasImage = !!opts.image;
      printInfo(`Space:   ${spaceId}`);
      if (isReply) {
        printInfo(`Thread:  ${opts.thread}`);
      }
      printInfo(`Message: ${message}`);
      if (hasImage) {
        printInfo(`Image:   ${opts.image}`);
      }
      if (!opts.yes) {
        const prompt = isReply ? 'Send this reply?' : 'Send this message?';
        const confirmed = await confirmAction(prompt);
        if (!confirmed) {
          printInfo('Cancelled.');
          return;
        }
      }
      const client = await createClient(program.opts());
      if (isReply && hasImage) {
        printInfo(`Replying with image to thread ${opts.thread}...`);
        const result = await client.replyWithImage(spaceId, opts.thread, message, opts.image);
        if (result.success) {
          printSuccess(`Reply with image sent!`);
          printInfo(`  Message ID: ${result.message_id}`);
        } else {
          printError(result.error || 'Failed to send reply with image');
          process.exit(1);
        }
      } else if (isReply) {
        printInfo(`Replying to thread ${opts.thread}...`);
        const result = await client.replyToThread(spaceId, opts.thread, message);
        if (result.success) {
          printSuccess(`Reply sent!`);
          printInfo(`  Message ID: ${result.message_id}`);
        } else {
          printError(result.error || 'Failed to send reply');
          process.exit(1);
        }
      } else if (hasImage) {
        printInfo(`Sending message with image to ${spaceId}...`);
        const result = await client.sendMessageWithImage(spaceId, message, opts.image);
        if (result.success) {
          printSuccess(`Message with image sent!`);
          printInfo(`  Topic ID: ${result.topic_id}`);
          printInfo(`  Message ID: ${result.message_id}`);
        } else {
          printError(result.error || 'Failed to send message with image');
          process.exit(1);
        }
      } else {
        printInfo(`Sending message to ${spaceId}...`);
        const result = await client.sendMessage(spaceId, message);
        if (result.success) {
          printSuccess(`Message sent!`);
          printInfo(`  Topic ID: ${result.topic_id}`);
          printInfo(`  Message ID: ${result.message_id}`);
        } else {
          printError(result.error || 'Failed to send message');
          process.exit(1);
        }
      }
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

// Hidden alias — keeps `gchat reply` working for backward compatibility
program
  .command('reply <space_id> <topic_id> <message>', { hidden: true })
  .description('(deprecated) Use: send <space_id> <message> --thread <topic_id>')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (spaceId, topicId, message, opts) => {
    try {
      printInfo(`Space:   ${spaceId}`);
      printInfo(`Thread:  ${topicId}`);
      printInfo(`Message: ${message}`);
      if (!opts.yes) {
        const confirmed = await confirmAction('Send this reply?');
        if (!confirmed) {
          printInfo('Cancelled.');
          return;
        }
      }
      const client = await createClient(program.opts());
      printInfo(`Replying to thread ${topicId}...`);
      const result = await client.replyToThread(spaceId, topicId, message);
      if (result.success) {
        printSuccess(`Reply sent!`);
        printInfo(`  Message ID: ${result.message_id}`);
      } else {
        printError(result.error || 'Failed to send reply');
        process.exit(1);
      }
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('mark-read <space_id>')
  .description('Mark a space or DM as read')
  .option('--count <number>', 'Unread count (defaults to 1)')
  .action(async (spaceId, opts) => {
    try {
      const client = await createClient(program.opts());
      printInfo(`Marking ${spaceId} as read...`);
      const count = opts.count ? parseInt(opts.count, 10) : undefined;
      const result = await client.markAsRead(spaceId, count);
      if (result.success) {
        printSuccess(`Marked as read!`);
        printInfo(`  Group ID: ${result.groupId}`);
        printInfo(`  Unread Count: ${result.unreadMessageCount}`);
      } else {
        printError(result.error || 'Failed to mark as read');
        process.exit(1);
      }
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('whoami')
  .description('Show current authenticated user info')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const client = await createClient(program.opts());
      printInfo('Fetching user info...');
      const user = await client.getSelfUser();

      if (opts.json) {
        console.log(JSON.stringify(user, null, 2));
        return;
      }

      printHeader('Current User');
      console.log(`  User ID: ${c('cyan', user.userId)}`);
      if (user.name) {
        console.log(`  Name: ${c('blue', user.name)}`);
      }
      if (user.email) {
        console.log(`  Email: ${c('green', user.email)}`);
      }
      if (user.firstName || user.lastName) {
        const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
        console.log(`  Full Name: ${fullName}`);
      }
      if (user.avatarUrl) {
        console.log(`  Avatar: ${c('dim', user.avatarUrl)}`);
      }
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('api', { hidden: true })
  .description('Start JSON API server')
  .option('--port <port>', 'Port to listen on', '3000')
  .option('--host <host>', 'Host to bind to', 'localhost')
  .action(async (opts) => {
    try {
      await startApiServer({ ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('bridge')
  .description('Start the extension bridge WebSocket server (background by default)')
  .option('--port <port>', 'Port to listen on (default: GCHAT_EXTENSION_PORT or 7891)')
  .option('--host <host>', 'Host to bind to (default: GCHAT_EXTENSION_HOST or 0.0.0.0)')
  .option('--foreground', 'Run in the foreground instead of as a background daemon')
  .option('--background', 'Run as a background daemon (default)')
  .action(async (opts) => {
    try {
      if (opts.foreground) {
        // ── Foreground mode ─────────────────────────────────────────────────
        const { ExtensionBridge, DEFAULT_EXTENSION_PORT, DEFAULT_EXTENSION_HOST } = await import('../core/extension-bridge.js');

        const port = parseInt(opts.port ?? process.env.GCHAT_EXTENSION_PORT ?? String(DEFAULT_EXTENSION_PORT), 10);
        const host = opts.host ?? process.env.GCHAT_EXTENSION_HOST ?? DEFAULT_EXTENSION_HOST;

        const bridge = new ExtensionBridge(port, host);
        await bridge.start();

        const display = host === '0.0.0.0' ? 'localhost' : host;
        printHeader('Extension Bridge Server');
        console.log(`  Listening on ws://${display}:${port}/`);
        console.log(`  Waiting for Chrome extension to connect...`);
        console.log();
        printInfo('Open chat.google.com with the extension installed.');
        printInfo('Press Ctrl+C to stop.\n');

        // Graceful shutdown — force-exit if close() hangs
        let shuttingDown = false;
        const shutdown = () => {
          if (shuttingDown) {
            // Second Ctrl+C — force kill immediately
            process.exit(1);
          }
          shuttingDown = true;
          console.log('\nShutting down...');
          // Hard deadline: exit no matter what after 2s
          const forceTimer = setTimeout(() => process.exit(0), 2000);
          forceTimer.unref?.();
          bridge.close().then(() => process.exit(0)).catch(() => process.exit(1));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } else {
        // ── Background mode (default) ───────────────────────────────────────
        const { spawn } = await import('node:child_process');
        const pidFile = join(tmpdir(), 'gchat-bridge.pid');
        const logFile = join(tmpdir(), 'gchat-bridge.log');

        // Check if a bridge is already running from a previous invocation
        if (existsSync(pidFile)) {
          const existingPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          if (existingPid) {
            try {
              process.kill(existingPid, 0);
              printInfo(`Bridge is already running (PID ${existingPid})`);
              printInfo(`  PID file: ${pidFile}`);
              printInfo(`  Log file: ${logFile}`);
              printInfo(`\nTo stop: kill ${existingPid}`);
              return;
            } catch {
              // Process is dead — stale PID file, continue with new spawn
            }
          }
        }

        // Build child process arguments
        const childArgs: string[] = [
          ...process.execArgv,
          process.argv[1],
          'bridge', '--foreground',
        ];
        if (opts.port) childArgs.push('--port', opts.port);
        if (opts.host) childArgs.push('--host', opts.host);

        // Forward relevant global flags
        const globalOpts = program.opts();
        if (globalOpts.debug) childArgs.push('--debug');
        if (globalOpts.logLevel && globalOpts.logLevel !== 'info') {
          childArgs.push('--log-level', globalOpts.logLevel);
        }

        const outFd = openSync(logFile, 'a');
        const errFd = openSync(logFile, 'a');

        const child = spawn(process.execPath, childArgs, {
          detached: true,
          stdio: ['ignore', outFd, errFd],
          env: process.env,
        });

        const pid = child.pid;
        child.unref();

        if (!pid) {
          printError('Failed to spawn bridge process');
          process.exit(1);
        }

        writeFileSync(pidFile, String(pid));

        // Give the process a moment to start (or crash)
        await new Promise(r => setTimeout(r, 1500));

        let running = false;
        try {
          process.kill(pid, 0);
          running = true;
        } catch {
          running = false;
        }

        if (running) {
          printSuccess(`Bridge started (PID ${pid})`);
          printInfo(`  Status:   running`);
          printInfo(`  PID file: ${pidFile}`);
          printInfo(`  Log file: ${logFile}`);
          printInfo(`\nTo stop: kill ${pid}`);
        } else {
          printError(`Bridge failed to start (PID ${pid} exited)`);
          printInfo(`  Status:   not running`);
          printInfo(`  Check log: ${logFile}`);
          try { unlinkSync(pidFile); } catch {}
          process.exit(1);
        }
      }
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('keepalive', { hidden: true })
  .description('Periodically ping Google Chat to keep session cookies alive (runs 9AM-6PM London time)')
  .option('--interval <minutes>', 'Interval between pings in minutes', '3')
  .option('--dormant-check <minutes>', 'How often to check time when dormant', '20')
  .option('--quiet', 'Only log errors, not successful pings')
  .option('--no-time-check', 'Disable London business hours check (9AM-6PM)')
  .action(async (opts) => {
    const intervalMs = parseInt(opts.interval, 10) * 60 * 1000;
    const dormantCheckMs = parseInt(opts.dormantCheck, 10) * 60 * 1000;
    const quiet = opts.quiet || false;
    const timeCheckEnabled = opts.timeCheck !== false;

    const isWithinLondonBusinessHours = (): { inHours: boolean; londonTime: string; hour: number } => {
      const now = new Date();
      const londonTime = now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false });
      const londonHourStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false });
      const hour = parseInt(londonHourStr, 10);
      const inHours = hour >= 9 && hour < 18; 
      return { inHours, londonTime, hour };
    };

    printHeader('Session Keepalive');
    console.log(`  Ping interval: ${opts.interval} minutes`);
    console.log(`  Dormant check interval: ${opts.dormantCheck} minutes`);
    if (timeCheckEnabled) {
      const { londonTime, inHours } = isWithinLondonBusinessHours();
      console.log(`  London time check: ${c('green', 'enabled')} (9AM-6PM)`);
      console.log(`  Current London time: ${londonTime}`);
      console.log(`  Current status: ${inHours ? c('green', 'within business hours') : c('yellow', 'outside business hours (dormant)')}`);
    } else {
      console.log(`  London time check: ${c('yellow', 'disabled')}`);
    }
    console.log(`  Press Ctrl+C to stop\n`);

    let client: GoogleChatClient | null = null;
    let pingCount = 0;
    let errorCount = 0;
    let isActive = false;
    let currentTimer: ReturnType<typeof setTimeout> | null = null;

    const shutdown = (reason?: string) => {
      if (currentTimer) clearTimeout(currentTimer);
      console.log(`\n${c('yellow', 'Shutting down...')}${reason ? ` (${reason})` : ''}`);
      console.log(`  Total pings: ${pingCount}`);
      console.log(`  Errors: ${errorCount}`);
      process.exit(0);
    };

    const ensureClient = async (): Promise<GoogleChatClient> => {
      if (!client) {
        client = await createClient(program.opts());
      }
      return client;
    };

    const ping = async () => {
      pingCount++;
      const timestamp = new Date().toISOString();
      try {
        const c1 = await ensureClient();
        await c1.authenticate(true);

        const spaces = await c1.listSpaces();
        if (!quiet) {
          console.log(`${c('dim', `[${timestamp}]`)} ${c('green', '✓')} Ping #${pingCount} OK - fetched ${spaces.length} spaces`);
        }
      } catch (e) {
        errorCount++;
        console.log(`${c('dim', `[${timestamp}]`)} ${c('red', '✗')} Ping #${pingCount} FAILED - ${(e as Error).message}`);

        if ((e as Error).message.includes('auth') || (e as Error).message.includes('401')) {
          console.log(`${c('yellow', '  → Attempting to re-authenticate...')}`);
          try {
            const c1 = await ensureClient();
            await c1.authenticate(true);
            console.log(`${c('green', '  → Re-authentication successful')}`);
          } catch (authErr) {
            console.log(`${c('red', '  → Re-authentication failed:')} ${(authErr as Error).message}`);
          }
        }
      }
    };

    const enterDormantMode = () => {
      if (!isActive) return; 
      isActive = false;
      const timestamp = new Date().toISOString();
      const { londonTime, hour } = isWithinLondonBusinessHours();
      console.log(`${c('dim', `[${timestamp}]`)} ${c('yellow', '😴')} Entering dormant mode - outside business hours`);
      console.log(`  London time: ${londonTime} (hour: ${hour})`);
      console.log(`  Will check again in ${opts.dormantCheck} minutes`);
    };

    const enterActiveMode = () => {
      if (isActive) return; 
      isActive = true;
      const timestamp = new Date().toISOString();
      const { londonTime } = isWithinLondonBusinessHours();
      console.log(`${c('dim', `[${timestamp}]`)} ${c('green', '🌅')} Entering active mode - within business hours`);
      console.log(`  London time: ${londonTime}`);
      console.log(`  Will ping every ${opts.interval} minutes`);
    };

    const scheduleNext = async () => {
      const { inHours, londonTime, hour } = isWithinLondonBusinessHours();

      if (!timeCheckEnabled || inHours) {
        if (!isActive && timeCheckEnabled) {
          enterActiveMode();
        }
        isActive = true;

        await ping();

        currentTimer = setTimeout(async () => {
          await scheduleNext();
        }, intervalMs);
      } else {
        if (isActive || pingCount === 0) {
          enterDormantMode();
        } else {
          const timestamp = new Date().toISOString();
          if (!quiet) {
            console.log(`${c('dim', `[${timestamp}]`)} ${c('dim', '💤')} Still dormant - London time: ${londonTime} (hour: ${hour})`);
          }
        }
        isActive = false;

        currentTimer = setTimeout(async () => {
          await scheduleNext();
        }, dormantCheckMs);
      }
    };

    await scheduleNext();

    process.on('SIGINT', () => shutdown());
    process.on('SIGTERM', () => shutdown());
  });

program
  .command('export <space_id>')
  .description('Export a space/DM to JSON with batching and resume support')
  .option('-o, --output <file>', 'Output JSON file (default: export-{spaceId}-{date}.json)')
  .option('--batch-size <num>', 'Topics per page (default: 100)', '100')
  .option('--since <time>', 'Oldest boundary (ISO 8601, seconds/usec, or relative like 7d)')
  .option('--until <time>', 'Newest boundary (ISO 8601, seconds/usec, or relative like 24h)')
  .option('--full-threads', 'Fetch ALL replies for each thread (slower but complete)')
  .option('--max-pages <num>', 'Safety limit for pages (default: 1000)', '1000')
  .option('--dry-run', 'Do not write files')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (spaceId, opts) => {
    try {
      await cmdExport(spaceId, { ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('stay-online', { hidden: true })
  .description('Keep your Google Chat presence as "online" by maintaining a channel connection')
  .option('--ping-interval <seconds>', 'Seconds between activity pings', '60')
  .option('--presence-timeout <seconds>', 'Presence shared timeout in seconds', '120')
  .option('--subscribe', 'Subscribe to all spaces for real-time events')
  .option('--quiet', 'Only log errors and connection status')
  .action(async (opts) => {
    try {
      await cmdStayOnline({ ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('presence', { hidden: true })
  .description('Maintain online presence by typing in a channel')
  .option('-c, --channel <id>', 'Space/channel ID to type in (default: AAAAWFu1kqo)', 'AAAAWFu1kqo')
  .option('-r, --refresh-interval <seconds>', 'Seconds between typing bursts (default: 300)', '300')
  .option('--headless', 'Run in headless mode (default: true)', true)
  .option('--no-headless', 'Run in visible mode')
  .option('--debug-port <port>', 'Chrome DevTools remote debugging port')
  .option('--force-login', 'Force re-authentication (clear saved state)')
  .option('--profile <name>', 'Browser profile to use (e.g. "Default", "Profile 1")')
  .option('--debug', 'Enable verbose debug logging')
  .option('-q, --quiet', 'Suppress periodic refresh messages')
  .action(async (opts) => {
    try {
      await cmdPresence({ ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command('download <space_id>')
  .description('[deprecated] Use "gchat export"')
  .option('-o, --output <filename>', 'Output filename (default: channel name)')
  .option('-b, --batch-size <num>', 'Messages per page', '30')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (spaceId, opts) => {
    try {
      await cmdDownload(spaceId, { ...program.opts(), ...opts });
    } catch (e) {
      printError((e as Error).message);
      process.exit(1);
    }
  });

// ── Custom help formatting ──────────────────────────────────────────────────

const COMMAND_CATEGORIES: Array<{ title: string; commands: string[] }> = [
  { title: 'Reading', commands: ['spaces', 'notifications', 'messages', 'threads', 'thread', 'dms', 'search', 'find-space', 'whoami'] },
  { title: 'Actions', commands: ['send', 'mark-read', 'export'] },
  { title: 'Infrastructure', commands: ['bridge'] },
];

/** Colorize <arg> and [options] tokens inside a string. */
function colorizeArgs(text: string): string {
  if (!useColors) return text;
  return text
    .replace(/<([^>]+)>/g, `${colors.dim}<$1>${colors.reset}`)
    .replace(/\[options\]/g, `${colors.dim}[options]${colors.reset}`);
}

/** Colorize -x and --xxx flag tokens inside an option term. */
function colorizeFlags(term: string): string {
  if (!useColors) return term;
  return term.replace(/(-{1,2}[\w][\w-]*)/g, `${colors.green}$1${colors.reset}`);
}

/** Strip ANSI escape sequences (for measuring visible width). */
function stripAnsi(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad a string that may contain ANSI escapes to a target *visible* width. */
function padVisible(str: string, width: number): string {
  const visible = stripAnsi(str);
  return visible >= width ? str : str + ' '.repeat(width - visible);
}

/** Format the root `gchat --help` output with grouped, colored categories. */
function formatRootHelp(cmd: Command, helper: Help): string {
  const lines: string[] = [];

  // ── Header ──
  lines.push('');
  lines.push(`  ${c('bold', c('cyan', 'gchat'))} ${c('dim', '\u2014 Google Chat CLI')}`);
  lines.push('');
  lines.push(`  ${c('bold', 'Usage:')}  ${c('cyan', 'gchat')} ${c('dim', '[command] [options]')}`);
  lines.push('');

  // ── Build command lookup ──
  const visibleCmds = helper.visibleCommands(cmd);
  const cmdMap = new Map<string, Command>();
  for (const sub of visibleCmds) {
    cmdMap.set(sub.name(), sub);
  }

  // ── Compute column width across ALL categories for consistent alignment ──
  let maxTermLen = 0;
  for (const cat of COMMAND_CATEGORIES) {
    for (const name of cat.commands) {
      const sub = cmdMap.get(name);
      if (!sub) continue;
      // Use the raw (un-colored) subcommandTerm for width calculation
      const rawTerm = helper.subcommandTerm(sub).replace(/\s*\[options\]\s*/, ' ').replace(/\s+/g, ' ').trim();
      if (rawTerm.length > maxTermLen) maxTermLen = rawTerm.length;
    }
  }
  const colWidth = maxTermLen + 4; // padding between term and description

  // ── Grouped commands ──
  for (const cat of COMMAND_CATEGORIES) {
    lines.push(`  ${c('bold', c('yellow', cat.title))}`);
    for (const name of cat.commands) {
      const sub = cmdMap.get(name);
      if (!sub) continue;
      // Build a clean term: command name + args (drop [options] — it's noise in the overview)
      const rawTerm = helper.subcommandTerm(sub).replace(/\s*\[options\]\s*/, ' ').replace(/\s+/g, ' ').trim();
      // Colorize: command name in cyan, args in dim
      const parts = rawTerm.split(' ');
      const cmdName = parts[0];
      const args = parts.slice(1).join(' ');
      const coloredTerm = `${c('cyan', cmdName)}${args ? ' ' + colorizeArgs(args) : ''}`;
      const desc = helper.subcommandDescription(sub).split('\n')[0]; // first line only
      lines.push(`    ${padVisible(coloredTerm, colWidth)}${desc}`);
    }
    lines.push('');
  }

  // ── Global options ──
  const opts = helper.visibleOptions(cmd);
  if (opts.length > 0) {
    lines.push(`  ${c('bold', c('yellow', 'Global Options'))}`);
    let maxOptLen = 0;
    const optEntries: Array<{ colored: string; raw: string; desc: string }> = [];
    for (const opt of opts) {
      const raw = helper.optionTerm(opt);
      const colored = colorizeFlags(colorizeArgs(raw));
      const desc = helper.optionDescription(opt).split('\n')[0];
      if (raw.length > maxOptLen) maxOptLen = raw.length;
      optEntries.push({ colored, raw, desc });
    }
    const optColWidth = maxOptLen + 4;
    for (const entry of optEntries) {
      lines.push(`    ${padVisible(entry.colored, optColWidth)}${entry.desc}`);
    }
    lines.push('');
  }

  // ── Footer ──
  lines.push(`  ${c('dim', 'Run')} ${c('cyan', 'gchat <command> --help')} ${c('dim', 'for detailed options.')}`);
  lines.push('');

  return lines.join('\n');
}

/** Format subcommand --help output with colorized flags and args. */
function formatSubcommandHelp(cmd: Command, helper: Help): string {
  const lines: string[] = [];

  // ── Usage ──
  // Commander's commandUsage includes the full ancestor chain (e.g. "gchat notifications [options]").
  // Tokenize and colorize each part individually to avoid regex/ANSI conflicts.
  const rawUsage = helper.commandUsage(cmd);
  const usageParts = rawUsage.split(' ');
  const coloredParts = usageParts.map((part, i) => {
    if (i === 0) return c('cyan', part);                                          // program name
    if (part.startsWith('<') && part.endsWith('>')) return c('dim', part);         // <arg>
    if (part.startsWith('[') && part.endsWith(']')) return c('dim', part);         // [options]
    return c('cyan', part);                                                        // subcommand name
  });
  lines.push('');
  lines.push(`  ${c('bold', 'Usage:')}  ${coloredParts.join(' ')}`);
  lines.push('');

  // ── Description ──
  const desc = helper.commandDescription(cmd);
  if (desc) {
    lines.push(`  ${desc}`);
    lines.push('');
  }

  // ── Arguments ──
  const args = helper.visibleArguments(cmd);
  if (args.length > 0) {
    lines.push(`  ${c('bold', c('yellow', 'Arguments'))}`);
    let maxArgLen = 0;
    const argEntries: Array<{ colored: string; raw: string; desc: string }> = [];
    for (const arg of args) {
      const raw = helper.argumentTerm(arg);
      const colored = colorizeArgs(raw);
      const argDesc = helper.argumentDescription(arg);
      if (raw.length > maxArgLen) maxArgLen = raw.length;
      argEntries.push({ colored, raw, desc: argDesc });
    }
    const argColWidth = maxArgLen + 4;
    for (const entry of argEntries) {
      lines.push(`    ${padVisible(entry.colored, argColWidth)}${entry.desc}`);
    }
    lines.push('');
  }

  // ── Options ──
  const opts = helper.visibleOptions(cmd);
  if (opts.length > 0) {
    lines.push(`  ${c('bold', c('yellow', 'Options'))}`);
    let maxOptLen = 0;
    const optEntries: Array<{ colored: string; raw: string; desc: string }> = [];
    for (const opt of opts) {
      const raw = helper.optionTerm(opt);
      const colored = colorizeFlags(colorizeArgs(raw));
      const optDesc = helper.optionDescription(opt).split('\n')[0];
      if (raw.length > maxOptLen) maxOptLen = raw.length;
      optEntries.push({ colored, raw, desc: optDesc });
    }
    const optColWidth = maxOptLen + 4;
    for (const entry of optEntries) {
      lines.push(`    ${padVisible(entry.colored, optColWidth)}${entry.desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

const helpConfig = {
  formatHelp(cmd: Command, helper: Help): string {
    // --help bypasses the preAction hook, so detect --no-color and non-TTY here
    if (process.argv.includes('--no-color') || !process.stdout.isTTY) {
      useColors = false;
    }
    if (cmd === program) {
      return formatRootHelp(cmd, helper);
    }
    return formatSubcommandHelp(cmd, helper);
  },
};

program.configureHelp(helpConfig);
for (const sub of program.commands) {
  sub.configureHelp(helpConfig);
}

export function createProgram(): Command {
  return program;
}
