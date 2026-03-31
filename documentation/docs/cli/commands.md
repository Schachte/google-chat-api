# Commands Reference

Complete reference for all `gchat` CLI commands.

## auth

Authentication and cookie helpers.

```bash
# Show cached XSRF token status (age/expiry)
gchat auth status

# Force refresh auth (re-extract cookies + refresh XSRF)
gchat --refresh auth refresh

# Clear cached auth state
gchat auth clear-cache

# List browsers / profiles used for cookie extraction
gchat auth browsers
gchat auth profiles
```

Subcommands:

| Subcommand | Description |
|-----------|-------------|
| `status` | Show cache age/expiry |
| `refresh` | Force refresh authentication |
| `clear-cache` | Clear cached cookies/XSRF token |
| `watch` | Periodically refresh auth |
| `browsers` | List supported browsers + profiles |
| `profiles` | List profiles for a browser |
| `export-cookies` | Print cookie header (or write to file) |
| `inject` | Inject cookies into local Chrome profile |
| `inject-remote` | Inject cookies into remote Chromium profile |

## profiles

List available Chrome profiles for cookie extraction.

```bash
gchat auth profiles

# legacy alias (still supported)
gchat profiles
```

**Output:**
```
Available Chrome profiles:
  Default
  Profile 1
  Profile 2
```

Use with `--profile` to select a specific profile for authentication.

---

## browsers

List supported browsers and their profiles.

```bash
gchat auth browsers

# legacy alias (still supported)
gchat browsers
```

---

## spaces

List all spaces (rooms) and DMs.

```bash
gchat spaces [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

**Example:**
```bash
gchat spaces
```

**Output:**
```
============================================================
 Found 15 spaces
============================================================

SPACES / ROOMS
----------------------------------------
  AAAA_abc123  Team Chat  [space]
  AAAA_def456  Project X  [space]

DIRECT MESSAGES
----------------------------------------
  AAAA_dm001  John Doe  [dm]
  AAAA_dm002  Jane Smith  [dm]
  ... and 8 more DMs
```

---

## notifications

List unread notifications, mentions, and DM activity.

```bash
gchat notifications [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--all` | Show all items including read |
| `--mentions` | Show only direct @mentions |
| `--threads` | Show only subscribed thread updates |
| `--spaces` | Show only subscribed space updates |
| `--dms` | Show only direct message notifications |
| `--read` | Show read (no activity) items |
| `--unread` | Show only unread items (default) |
| `--me` | Show only direct @me mentions (not @all) |
| `--at-all` | Show only @all mentions |
| `--space <id>` | Filter to a specific space |
| `--show-messages` | Fetch and display actual messages |
| `--messages-limit <n>` | Messages to fetch per space (default: 3) |
| `--limit <n>` | Max items to return |
| `--offset <n>` | Skip first n items |
| `--parallel <n>` | Concurrent requests (default: 5) |
| `--dump-auth` | Save raw API response to temp dir |
| `--json` | Output as JSON |

**Examples:**

```bash
# See all unread notifications
gchat notifications

# Only direct @mentions to you (not @all)
gchat notifications --me

# DMs with message preview
gchat notifications --dms --show-messages

# Paginate through mentions
gchat notifications --mentions --limit 10 --offset 20
```

---

## messages

Get messages from a space (flat list, not grouped by thread).

```bash
gchat messages <space_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `space_id` | The space ID (e.g., `AAAA_abc123`) |

**Options:**

| Option | Description |
|--------|-------------|
| `-n, --limit <n>` | Number of messages to fetch (default: 20) |
| `--last <n>` | Fetch the most recent N messages (handles pagination automatically) |
| `--json` | Output as JSON |

**Examples:**

```bash
# Get messages (default page)
gchat messages AAAA_abc123 --limit 50

# Get the 10 most recent messages (auto-paginates)
gchat messages AAAA_abc123 --last 10
```

---

## threads

Get threaded messages from a space with pagination support.

```bash
gchat threads <space_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `space_id` | The space ID |

**Options:**

| Option | Description |
|--------|-------------|
| `--pages <n>` | Number of pages to fetch (default: 1) |
| `--page-size <n>` | Topics per page (default: 25) |
| `--full` | Fetch full thread replies |
| `--cursor <timestamp>` | Pagination cursor (microseconds) |
| `--json` | Output as JSON |

**Examples:**

```bash
# Get first page of threads
gchat threads AAAA_abc123

# Get 3 pages with full thread replies
gchat threads AAAA_abc123 --pages 3 --full

# Continue from a cursor
gchat threads AAAA_abc123 --cursor 1705420800000000
```

---

## thread

Get a specific thread by topic ID.

```bash
gchat thread <space_id> <topic_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `space_id` | The space ID |
| `topic_id` | The topic/thread ID |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

**Example:**
```bash
gchat thread AAAA_abc123 topic_xyz789
```

---

## dms

Get DM conversations with messages.

```bash
gchat dms [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--limit <n>` | Max DM conversations to fetch (0 = all) |
| `--messages-limit <n>` | Messages per DM (default: 10) |
| `--parallel <n>` | Concurrent requests (default: 5) |
| `--unread` | Only show DMs with unread messages |
| `--json` | Output as JSON |

**Examples:**

```bash
# Get all DMs with recent messages
gchat dms

# Only unread DMs
gchat dms --unread

# Limit to 5 DMs with 3 messages each
gchat dms --limit 5 --messages-limit 3
```

---

## search

Search messages across spaces.

```bash
gchat search <query> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `query` | Search query string |

**Options:**

| Option | Description |
|--------|-------------|
| `--space <id>` | Search within a specific space |
| `--json` | Output as JSON |

**Examples:**

```bash
# Search all spaces
gchat search "quarterly report"

# Search specific space
gchat search "budget" --space AAAA_abc123
```

---

## find-space

Find spaces by name.

```bash
gchat find-space <query> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `query` | Space name search query |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

**Example:**
```bash
gchat find-space "project"
```

**Output:**
```
============================================================
 Found 2 matching spaces
============================================================
  AAAA_abc123  Project Alpha  [space]
  AAAA_def456  Project Beta   [space]
```

---

## send

Send a message to a space. Creates a new thread by default, or replies to an existing thread with `--thread`.

```bash
gchat send <space_id> <message> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `space_id` | The space ID to send to |
| `message` | The message text |

**Options:**

| Option | Description |
|--------|-------------|
| `-t, --thread <topic_id>` | Reply to an existing thread instead of creating a new one |
| `-y, --yes` | Skip confirmation prompt |

**Examples:**

```bash
# Send a new message (creates a new thread)
gchat send AAAA_abc123 "Hello team! Here's the update."

# Reply to an existing thread
gchat send AAAA_abc123 "Thanks for the info!" --thread topic_xyz789

# Skip confirmation
gchat send AAAA_abc123 "Quick note" -y
```

---

## whoami

Display current user information.

```bash
gchat whoami [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

**Example:**
```bash
gchat whoami
```

**Output:**
```
============================================================
 Current User
============================================================
  Name: John Doe
  Email: john.doe@gmail.com
  User ID: 123456789
```

---

## api

Start the HTTP JSON API server with web UI.

```bash
gchat api [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--port <n>` | Server port (default: 3000) |
| `--host <addr>` | Server host (default: localhost) |

**Example:**
```bash
# Start on default port
gchat api

# Start on custom port
gchat api --port 8080 --host 0.0.0.0
```

**Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /` | API info |
| `GET /docs` | Scalar API documentation |
| `GET /openapi.json` | OpenAPI specification (JSON) |
| `GET /openapi.yaml` | OpenAPI specification (YAML) |
| `GET /health` | Health check |
| `GET /api/whoami` | Current user info |
| `GET /api/spaces` | List spaces/DMs |
| `GET /api/spaces/:spaceId/threads` | List threads |
| `GET /api/spaces/:spaceId/threads/:topicId` | Get thread messages |
| `POST /api/spaces/:spaceId/threads/:topicId/replies` | Reply to a thread |
| `GET /api/spaces/:spaceId/messages` | Fetch all messages |
| `POST /api/spaces/:spaceId/messages` | Send a message |
| `GET /api/notifications` | Notification feed |
| `GET /api/unreads` | Categorized unreads |
| `GET /api/unreads/refresh` | Refresh unread counts |
| `POST /api/notifications/mark` | Mark space/DM as read or unread |
| `GET /api/dms` | List DMs |
| `GET /api/dms/presence` | DM presence lookup |
| `GET /api/dms/:dmId/threads` | DM threads (alias `/topics`) |
| `POST /api/dms/:dmId/messages` | Send DM message |
| `GET /api/presence` | Presence lookup |
| `GET /api/presence/:userId` | Single-user presence |
| `GET /api/attachment` | Resolve attachment tokens |
| `GET /api/proxy` | Authenticated proxy |

See [API Reference](../api/index.md) for full HTTP API documentation.

---

## export

Export a space/DM to a JSON file in batches (resumable).

```bash
gchat export <space_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-o, --output <file>` | Output JSON file (default: `export-{spaceId}-{date}.json`) |
| `--batch-size <n>` | Topics per page (default: 100) |
| `--since <time>` | Oldest boundary (ISO, seconds/usec, or relative like `7d`) |
| `--until <time>` | Newest boundary (ISO, seconds/usec, or relative like `24h`) |
| `--full-threads` | Fetch ALL replies for each thread (slower, complete) |
| `--max-pages <n>` | Safety limit (default: 1000) |
| `--dry-run` | Do not write files |
| `-y, --yes` | Skip confirmation prompt |
| `-v, --verbose` | Detailed progress |

**Examples:**

```bash
# Export last 7 days
gchat export AAAA_abc123 --since 7d --full-threads

# Export a date range
gchat export AAAA_abc123 --since 2024-01-01 --until 2024-06-30

# Resume (reuses cursors stored in output file)
gchat export AAAA_abc123 -o export-AAAA_abc123-2024-01-01.json
```

---

## stay-online

Keep your Google Chat presence as "online" by maintaining a WebChannel connection.

```bash
gchat stay-online [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--ping-interval <seconds>` | Seconds between pings (default: 60) |
| `--presence-timeout <seconds>` | Presence shared timeout (default: 120) |
| `--subscribe` | Subscribe to all spaces for real-time events |
| `--quiet` | Only log errors and connection status |

---

## presence

Maintain online presence using browser automation with Playwright. Uses `storageState` for authentication — on first run a visible browser opens for manual Google login, then the session is saved to `~/.gchat/presence-state.json` for future headless runs.

```bash
gchat presence [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-r, --refresh-interval <seconds>` | Seconds between activity refreshes (default: 300) |
| `--headless` / `--no-headless` | Run headless (default) or with a visible browser |
| `--debug-port <port>` | Chrome DevTools remote debugging port |
| `--force-login` | Clear saved state and re-authenticate |
| `--profile <name>` | Browser profile to use (e.g. "Default", "Profile 1") |
| `--debug` | Enable verbose debug logging |
| `-q, --quiet` | Suppress periodic refresh messages |

**Examples:**

```bash
# First run — opens visible browser, prompts for login
gchat presence --no-headless

# Subsequent runs — loads saved state, runs headless
gchat presence

# Force re-login (clears saved session)
gchat presence --force-login --no-headless

# Debug mode (verbose logging, screenshots, page console output)
gchat presence --no-headless --debug

# Specify browser and profile directly
gchat presence --browser chrome --profile "Profile 1" --no-headless
```

**How it works:**

1. If no saved state exists, the browser opens visibly for manual Google login
2. After login, a blue banner appears — click "Save Session & Start" to confirm
3. Session state is saved to `~/.gchat/presence-state.json`
4. The browser periodically simulates user activity (mouse moves, clicks, page reloads) to maintain online status
5. On subsequent runs with saved state, headless mode works automatically

---

## keepalive

Periodically refreshes auth and pings Google Chat to keep session cookies alive.

```bash
gchat keepalive [options]
```
