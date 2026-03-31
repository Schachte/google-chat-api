/**
 * Interactive Google Chat notification manager.
 *
 * Usage:
 *   bun run index.ts
 *
 * Requires the Chrome extension to be running and connected.
 * See the project README for setup instructions.
 */

import {
  createClient,
  type GoogleChatClient,
} from "gchat-cli";

// ─── Terminal helpers ──────────────────────────────────────────────────────

const ESC = "\x1b";
const CSI = `${ESC}[`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

const bold = (s: string) => `${CSI}1m${s}${CSI}0m`;
const dim = (s: string) => `${CSI}2m${s}${CSI}0m`;
const cyan = (s: string) => `${CSI}36m${s}${CSI}0m`;
const green = (s: string) => `${CSI}32m${s}${CSI}0m`;
const yellow = (s: string) => `${CSI}33m${s}${CSI}0m`;
const red = (s: string) => `${CSI}31m${s}${CSI}0m`;
const magenta = (s: string) => `${CSI}35m${s}${CSI}0m`;
const bgCyan = (s: string) => `${CSI}46m${CSI}30m${s}${CSI}0m`;

function clearScreen() {
  process.stdout.write(`${CSI}2J${CSI}H`);
}

function moveTo(row: number, col: number) {
  process.stdout.write(`${CSI}${row};${col}H`);
}

function clearLine() {
  process.stdout.write(`${CSI}2K`);
}

/** Read a single keypress from stdin. Returns the raw buffer. */
function readKey(): Promise<Buffer> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      process.stdin.setRawMode(false);
      resolve(data);
    });
  });
}

// ─── Fuzzy matching ────────────────────────────────────────────────────────

/** Case-insensitive fuzzy match: every character in `query` appears in order in `text`. */
function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ─── Type filter modes ─────────────────────────────────────────────────────

type TypeFilter = "all" | "space" | "dm" | "thread";
const TYPE_FILTERS: TypeFilter[] = ["all", "space", "dm", "thread"];

function formatTypeFilter(f: TypeFilter, active: boolean): string {
  const label = f === "all"
    ? "All"
    : f === "space"
      ? "Spaces"
      : f === "dm"
        ? "DMs"
        : "Threads";
  if (!active) return dim(label);
  switch (f) {
    case "all":   return bgCyan(` ${label} `);
    case "space": return bgCyan(` ${label} `);
    case "dm":    return bgCyan(` ${label} `);
    case "thread": return bgCyan(` ${label} `);
  }
}

// ─── Formatting helpers ────────────────────────────────────────────────────

function formatCategory(cat: string): string {
  switch (cat) {
    case "badged":
      return red("badged");
    case "lit_up":
      return yellow("lit up");
    case "thread_unread":
      return yellow("thread");
    case "thread":
      return dim("thread");
    default:
      return dim(cat);
  }
}

function formatType(type: string): string {
  if (type === "dm") return magenta("DM");
  if (type === "thread") return yellow("Thread");
  return cyan("Space");
}

function truncate(text: string, max = 50): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildPreview(sender: string | undefined, text: string | undefined, max = 50): string {
  if (!text) return "";
  const clipped = truncate(text, max);
  return sender ? `${sender}: ${clipped}` : clipped;
}

// ─── Progress bar ──────────────────────────────────────────────────────────

function renderProgressBar(
  current: number,
  total: number,
  width: number = 30,
  label?: string,
) {
  const pct = total === 0 ? 100 : Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const bar = green("\u2588".repeat(filled)) + dim("\u2591".repeat(width - filled));
  const status = label ?? `${current}/${total}`;
  moveTo(process.stdout.rows - 1, 1);
  clearLine();
  process.stdout.write(`  ${bar} ${bold(`${pct}%`)} ${dim(status)}`);
}

// ─── Notification item type ────────────────────────────────────────────────

interface NotifItem {
  id: string;
  groupId: string;
  name: string;
  type: "space" | "dm" | "thread";
  category: string;
  badgeCount: number;
  preview: string;
  threadId?: string;
  unreadTimestamp?: number;
  checked: boolean;
}

// ─── Main notification list view ───────────────────────────────────────────

type ListAction = "mark-read" | "mark-unread" | "refresh" | "quit";

async function notificationList(
  client: GoogleChatClient,
  items: NotifItem[],
  badges: { totalUnread: number; badgedCount: number; litUpCount: number },
): Promise<ListAction> {
  let cursor = 0;
  let query = "";
  let typeFilter: TypeFilter = "all";

  const getVisible = (): NotifItem[] => {
    let pool = items;
    if (typeFilter !== "all") {
      pool = pool.filter((i) => i.type === typeFilter);
    }
    if (query.length > 0) {
      pool = pool.filter((i) => fuzzyMatch(query, i.name));
    }
    return pool;
  };

  const render = () => {
    clearScreen();

    // Header with badge summary
    console.log(bold(cyan("\n  Notifications")));
    console.log(
      `  ${badges.totalUnread} unread  ` +
        `${red(`${badges.badgedCount} badged`)}  ` +
        `${yellow(`${badges.litUpCount} lit up`)}  ` +
        dim(`${items.length} items`),
    );
    console.log();

    // Type filter tabs
    const tabs = TYPE_FILTERS.map((f) =>
      formatTypeFilter(f, f === typeFilter),
    ).join("  ");
    console.log(`  ${tabs}`);
    console.log();

    // Search bar
    if (query.length > 0) {
      console.log(`  ${dim("search:")} ${yellow(query)}${dim("_")}`);
    } else {
      console.log(`  ${dim("type to search...")}`);
    }
    console.log();

    // List
    const visible = getVisible();
    if (visible.length === 0) {
      console.log(dim("  (no matches)"));
    } else {
      const maxRows = Math.max(1, (process.stdout.rows || 30) - 16);
      const display = visible.slice(0, maxRows);
      for (let i = 0; i < display.length; i++) {
        const item = display[i];
        const pointer = i === cursor ? cyan(">") : " ";
        const check = item.checked ? green("[x]") : dim("[ ]");
        const type = formatType(item.type);
        const cat = formatCategory(item.category);
        const badge = item.badgeCount > 0 ? red(` (${item.badgeCount})`) : "";
        const name = i === cursor ? bold(item.name) : item.name;
        const preview = item.preview ? dim(` -- ${item.preview}`) : "";
        console.log(` ${pointer} ${check} ${type} ${cat}${badge}  ${name}${preview}`);
      }
      if (visible.length > maxRows) {
        console.log(dim(`  ... ${visible.length - maxRows} more (type to narrow)`));
      }
    }

    // Selection count
    const selectedCount = items.filter((i) => i.checked).length;
    console.log();
    if (selectedCount > 0) {
      console.log(`  ${green(`${selectedCount} selected`)}`);
    }

    // Footer with keybindings
    console.log();
    const keys: string[] = [
      `${bold("Space")} toggle`,
      `${bold("Tab")} filter type`,
      `${bold("R")} mark read`,
      `${bold("U")} mark unread`,
      `${bold("A")} select all`,
      `${bold("N")} deselect`,
      `${bold("F5")} refresh`,
      `${bold("Esc")} quit`,
    ];
    console.log(dim(`  ${keys.join("  ")}`));
  };

  process.stdout.write(HIDE_CURSOR);
  render();

  try {
    while (true) {
      const key = await readKey();
      const str = key.toString();
      const visible = getVisible();

      // Ctrl+C or Esc (standalone, not arrow sequence)
      if (key[0] === 3 || (key[0] === 27 && key.length === 1)) {
        return "quit";
      }

      // Tab — cycle type filter
      if (key[0] === 9) {
        const idx = TYPE_FILTERS.indexOf(typeFilter);
        typeFilter = TYPE_FILTERS[(idx + 1) % TYPE_FILTERS.length];
        cursor = 0;
        render();
        continue;
      }

      // Enter or R — mark selected as read
      if (key[0] === 13 || str === "r" || str === "R") {
        if (items.some((i) => i.checked)) {
          return "mark-read";
        }
        continue;
      }

      // U — mark selected as unread
      if (str === "u" || str === "U") {
        if (items.some((i) => i.checked)) {
          return "mark-unread";
        }
        continue;
      }

      // F5 — refresh (ESC [ 1 5 ~)
      if (str === `${ESC}[15~`) {
        return "refresh";
      }

      // Space — toggle current item
      if (key[0] === 32) {
        if (visible.length > 0 && cursor < visible.length) {
          visible[cursor].checked = !visible[cursor].checked;
          render();
        }
        continue;
      }

      // A — select all visible
      if (str === "a" || str === "A") {
        for (const item of getVisible()) item.checked = true;
        render();
        continue;
      }

      // N — deselect all
      if (str === "n" || str === "N") {
        for (const item of items) item.checked = false;
        render();
        continue;
      }

      // Backspace
      if (key[0] === 127) {
        if (query.length > 0) {
          query = query.slice(0, -1);
          cursor = 0;
          render();
        }
        continue;
      }

      // Up arrow
      if (str === `${ESC}[A`) {
        if (visible.length > 0) {
          cursor = (cursor - 1 + visible.length) % visible.length;
          render();
        }
        continue;
      }

      // Down arrow
      if (str === `${ESC}[B`) {
        if (visible.length > 0) {
          cursor = (cursor + 1) % visible.length;
          render();
        }
        continue;
      }

      // Printable character — add to search query
      if (key.length === 1 && key[0] >= 33 && key[0] < 127) {
        query += str;
        cursor = 0;
        render();
      }
    }
  } finally {
    process.stdout.write(SHOW_CURSOR);
  }
}

// ─── Bulk actions with progress ────────────────────────────────────────────

const CONCURRENCY = 10;

async function bulkAction(
  client: GoogleChatClient,
  items: NotifItem[],
  action: "read" | "unread",
) {
  const selected = items.filter((i) => i.checked);
  if (selected.length === 0) return;

  const label = action === "read" ? "Marking as read" : "Marking as unread";
  clearScreen();
  console.log(bold(cyan(`\n  ${label}...\n`)));
  process.stdout.write(HIDE_CURSOR);

  let done = 0;
  let failed = 0;

  for (let i = 0; i < selected.length; i += CONCURRENCY) {
    const batch = selected.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((item) =>
        item.type === "thread" && item.threadId
          ? action === "read"
            ? client.markThreadAsRead(item.groupId, item.threadId, item.unreadTimestamp)
            : client.markThreadAsUnread(item.groupId, item.threadId, item.unreadTimestamp)
          : action === "read"
            ? client.markAsRead(item.groupId)
            : client.markAsUnread(item.groupId, item.unreadTimestamp),
      ),
    );

    for (const r of results) {
      if (r.status === "fulfilled") done++;
      else failed++;
    }

    renderProgressBar(done + failed, selected.length, 30, `${done + failed}/${selected.length}`);
  }

  renderProgressBar(selected.length, selected.length, 30, "Done!");
  process.stdout.write(SHOW_CURSOR);

  console.log("\n");
  console.log(green(`  ${action === "read" ? "Read" : "Unread"}: ${done}`));
  if (failed > 0) console.log(red(`  Failed: ${failed}`));

  console.log(dim("\n  Press any key to continue..."));
  await readKey();
}

// ─── Load notifications into NotifItem[] ───────────────────────────────────

async function loadNotifications(
  client: GoogleChatClient,
): Promise<{
  items: NotifItem[];
  badges: { totalUnread: number; badgedCount: number; litUpCount: number };
}> {
  const result = await client.getNotifications({
    showMessages: false,
  });

  const allUnread = [
    ...(result.unreadDMs ?? []),
    ...(result.badgedSpaces ?? []),
    ...(result.unreadSpaces ?? []),
  ];

  // Filter out unnamed DMs
  const named = allUnread.filter(
    (item) => item.type !== "dm" || (item.name && item.name.trim().length > 0),
  );

  const items: NotifItem[] = named.map((item) => {
    let preview = "";
    const msgs = result.messages?.[item.id];
    if (msgs && msgs.length > 0) {
      const latest = msgs[0];
      preview = buildPreview(latest.sender, latest.text);
    }

    return {
      id: item.id,
      groupId: item.id,
      name: item.name ?? item.id,
      type: item.type === "dm" ? "dm" as const : "space" as const,
      category: item.notificationCategory,
      badgeCount: item.badgeCount ?? 0,
      preview,
      unreadTimestamp: item.lastNotifWorthyEventTimestamp,
      checked: false,
    };
  });

  const threadFetches = named.flatMap((item) => {
    if (item.type !== "space" || !item.threadIds || item.threadIds.length === 0) {
      return [];
    }

    return item.threadIds.map(async (threadId) => {
      const thread = await client.getThread(item.id, threadId);
      const opener = thread.messages[0];
      const latest = thread.messages[thread.messages.length - 1];
      const title = truncate(opener?.text || latest?.text || threadId, 60);

      return {
        id: `${item.id}#${threadId}`,
        groupId: item.id,
        name: `${item.name ?? item.id} / ${title}`,
        type: "thread" as const,
        category: threadId === item.subscribedThreadId ? "thread_unread" : "thread",
        badgeCount: 0,
        preview: buildPreview(latest?.sender, latest?.text),
        threadId,
        unreadTimestamp: latest?.timestamp_usec,
        checked: false,
      } satisfies NotifItem;
    });
  });

  const threadResults = await Promise.allSettled(threadFetches);
  const threadItems = threadResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  return {
    items: [...items, ...threadItems],
    badges: {
      totalUnread: result.badges.totalUnread,
      badgedCount: result.badges.badgedCount,
      litUpCount: result.badges.litUpCount,
    },
  };
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function main() {
  clearScreen();
  console.log(bold(cyan("\n  Google Chat Notification Manager\n")));
  console.log(dim("  Connecting via extension bridge...\n"));

  let client: GoogleChatClient;
  try {
    client = await createClient();
  } catch (e) {
    console.error(
      red(
        `\n  Failed to connect: ${(e as Error).message}\n\n` +
          `  Make sure the Chrome extension is installed and Google Chat is open.\n`,
      ),
    );
    process.exit(1);
  }

  console.log(green("  Connected!"));
  console.log(dim("  Loading notifications...\n"));

  let { items, badges } = await loadNotifications(client);

  if (items.length === 0) {
    console.log(bold(green("\n  All caught up! No notifications.\n")));
    process.exit(0);
  }

  while (true) {
    const action = await notificationList(client, items, badges);

    switch (action) {
      case "mark-read":
        await bulkAction(client, items, "read");
        // Refresh after action
        clearScreen();
        console.log(dim("\n  Refreshing...\n"));
        ({ items, badges } = await loadNotifications(client));
        break;

      case "mark-unread":
        await bulkAction(client, items, "unread");
        clearScreen();
        console.log(dim("\n  Refreshing...\n"));
        ({ items, badges } = await loadNotifications(client));
        break;

      case "refresh":
        clearScreen();
        console.log(dim("\n  Refreshing...\n"));
        ({ items, badges } = await loadNotifications(client));
        if (items.length === 0) {
          clearScreen();
          console.log(bold(green("\n  All caught up! No notifications.\n")));
          console.log(dim("  Press any key to exit..."));
          await readKey();
          process.exit(0);
        }
        break;

      case "quit":
        clearScreen();
        console.log(dim("\n  Goodbye!\n"));
        process.exit(0);
    }
  }
}

main().catch((e) => {
  process.stdout.write(SHOW_CURSOR);
  console.error(red(`\nFatal error: ${e.message}\n`));
  process.exit(1);
});
