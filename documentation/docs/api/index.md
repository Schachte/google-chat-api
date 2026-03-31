# API Overview

This project provides multiple ways to access Google Chat: an HTTP server, CLI commands, and programmatic libraries.

## Quick Reference

| Method | Command | Use Case |
|--------|---------|----------|
| HTTP Server | `npm run serve` | REST API integration + Web UI |
| CLI | `cd packages/gchat && npm start -- <command>` | Quick command-line access |
| TypeScript Library | `import { GoogleChatClient }` | Programmatic Node.js integration |

## HTTP Server

The HTTP server provides a RESTful JSON API with Scalar API documentation.

### Starting the Server

```bash
cd packages/gchat && npm run serve

# Custom port and host
npm start -- api --port 8080 --host 0.0.0.0
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API information |
| GET | `/docs` | Scalar API documentation |
| GET | `/openapi.json` | OpenAPI spec (JSON) |
| GET | `/openapi.yaml` | OpenAPI spec (YAML) |
| GET | `/health` | Health check |
| GET | `/api/whoami` | Current user info |
| GET | `/api/spaces` | List all spaces/DMs |
| GET | `/api/spaces/:spaceId/threads` | List threads (supports `since`/`until` time filters) |
| GET | `/api/spaces/:spaceId/threads/:topicId` | Get a single thread |
| POST | `/api/spaces/:spaceId/threads/:topicId/replies` | Reply to a thread |
| GET | `/api/spaces/:spaceId/messages` | Fetch all messages (multi-page) |
| POST | `/api/spaces/:spaceId/messages` | Send a new message |
| GET | `/api/notifications` | Notification feed (badgedDMs, badgedSpaces, litupDMs, litupSpaces) |
| GET | `/api/unreads` | Categorized unreads for UI |
| GET | `/api/unreads/refresh` | Force refresh unread counts |
| POST | `/api/notifications/mark` | Mark a space or DM as read or unread |
| GET | `/api/search` | Search messages |
| GET | `/api/find-spaces` | Find spaces by name |
| GET | `/api/dms` | List direct messages |
| GET | `/api/dms/presence` | Presence for DM participants |
| GET | `/api/dms/:dmId` | DM summary |
| GET | `/api/dms/:dmId/threads` | DM threads (supports `since`/`until` time filters) |
| GET | `/api/dms/:dmId/threads/:topicId` | DM thread messages |
| POST | `/api/dms/:dmId/messages` | Send a DM message |
| GET | `/api/presence` | Presence lookup |
| GET | `/api/presence/:userId` | Single-user presence |
| GET | `/api/attachment` | Resolve attachment token |
| GET | `/api/proxy` | Authenticated proxy fetch |

### Example Requests

```bash
# List all spaces
curl http://localhost:3000/api/spaces

# List spaces with pagination
curl "http://localhost:3000/api/spaces?pageSize=100"

# Get messages from a space
curl http://localhost:3000/api/spaces/AAAA_space_id/threads

# Get messages with pagination
curl "http://localhost:3000/api/spaces/AAAA_space_id/threads?pageSize=50&cursor=1705420800000000"

# Get messages from last 24 hours (using epoch seconds)
curl "http://localhost:3000/api/spaces/AAAA_space_id/threads?since=$(( $(date +%s) - 86400 ))"

# Get messages from a specific date range
curl "http://localhost:3000/api/spaces/AAAA_space_id/threads?since=1705276800&until=1705363200"

# Mark a space as read
curl -X POST "http://localhost:3000/api/mark-read/AAAA_space_id"

# Presence lookup with profile info
curl "http://localhost:3000/api/presence?userIds=123456789&include=profile"
```

### Notifications

```bash
# Get all notifications (4 mutually exclusive sections)
curl http://localhost:3000/api/notifications

# Filter by badged items that @mention you
curl "http://localhost:3000/api/notifications?me=true&messages=true"
```

**Response:**
```json
{
  "badgedDMs": [
    {
      "id": "DM_abc123xyz",
      "name": "Jane Smith, You",
      "type": "dm",
      "lastMessageText": "Hey, can you review my PR?",
      "isSubscribedToSpace": true,
      "notificationCategory": "badged",
      "badgeCount": 1,
      "lastNotifWorthyEventTimestamp": 1773111159996751,
      "readWatermarkTimestamp": 1773111159996751,
      "lastNotifWorthyEvent": "March 10, 2026 at 2:52 AM GMT",
      "readWatermark": "March 10, 2026 at 2:52 AM GMT"
    }
  ],
  "badgedSpaces": [ ... ],
  "litupDMs": [ ... ],
  "litupSpaces": [ ... ],
  "badges": {
    "totalUnread": 130,
    "badgedCount": 10,
    "litUpCount": 120,
    "serverBadgeTotal": 13
  },
  "pagination": {
    "total": 130,
    "offset": 0,
    "limit": 130,
    "returned": 130,
    "hasMore": false
  }
}
```

Each item appears in exactly one section. The notification model has three states matching the Google Chat UI:

| State | Section | Visual in Google Chat |
|-------|---------|-----------------------|
| **Badged** | `badgedDMs` / `badgedSpaces` | Numbered notification badge |
| **Lit up** | `litupDMs` / `litupSpaces` | Bold text, no number |
| **None** | *(not returned)* | Clean, no indicator |

Timestamps include both the raw microsecond value and a human-readable string. Set `GCHAT_TIMEZONE` in `.env` to control the timezone (default: `UTC`).

See [OpenAPI Docs](openapi.md) for detailed API documentation.

## CLI Commands

The `gchat` CLI provides full command-line access to Google Chat. See [CLI Overview](../cli/index.md) for complete documentation.

### Quick Examples

```bash
cd packages/gchat

# Check auth/cache status
npm start -- auth status

# List all spaces
npm start -- spaces

# Get messages from a space
npm start -- messages AAAA_space_id

# Get threaded messages with pagination
npm start -- threads AAAA_space_id --pages 3 --full

# Export the last 7 days
npm start -- export AAAA_space_id --since 7d --full-threads

# Check notifications and mentions
npm start -- notifications --me

# Search across all spaces
npm start -- search "search query"

# Send a message
npm start -- send AAAA_space_id "Hello world"

# Reply to a thread
npm start -- reply AAAA_space_id TOPIC_ID "Thanks!"

# Start the API server
npm run serve
```

### Global Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON for scripting |
| `--debug` | Enable debug logging |
| `--profile <name>` | Browser profile for auth |
| `--browser <type>` | Browser to use for cookie extraction |
| `--cookie-path <path>` | Custom cookie DB path |
| `--cache-dir <path>` | Cache directory for auth state |
| `--refresh` | Force re-authentication |

See [Commands Reference](../cli/commands.md) for all commands and options.

## Programmatic Usage

### TypeScript/Node.js

```typescript
import { GoogleChatClient, utils } from 'gchat-cli';

// Initialize
const cookies = {
  SID: '...',
  HSID: '...',
  SSID: '...',
  OSID: '...',
  SAPISID: '...',
};
const client = new GoogleChatClient(cookies);
await client.authenticate();

// List spaces
const spaces = await client.listSpaces();
console.log(spaces);

// Get messages
const threads = await client.getThreads('AAAA_space_id', {
  pageSize: 25,
  fetchFullThreads: true
});
console.log(threads.messages);

// Send a message
const result = await client.sendMessage('AAAA_space_id', 'Hello!');
console.log(result);

// Export topics/messages in batches (utils API)
for await (const batch of utils.exportChatBatches(client, 'AAAA_space_id', { since: '7d', pageSize: 100 })) {
  console.log('page', batch.page, 'topics', batch.topics.length, 'messages', batch.messages.length);
}
```

## Response Formats

### Space Object

```json
{
  "id": "AAAA_abc123",
  "name": "Team Chat",
  "type": "space",
  "sortTimestamp": 1705420800000000
}
```

### Message Object

```json
{
  "message_id": "msg_123",
  "topic_id": "topic_456",
  "space_id": "AAAA_abc123",
  "text": "Hello, world!",
  "timestamp": "2024-01-16T12:00:00.000Z",
  "timestamp_usec": 1705406400000000,
  "sender": "John Doe",
  "has_mention": false
}
```

### Notification Item

```json
{
  "id": "AAAAxxx",
  "name": "Team Chat",
  "type": "space",
  "lastMessageText": "Hey everyone...",
  "isSubscribedToSpace": true,
  "notificationCategory": "badged",
  "badgeCount": 3,
  "lastNotifWorthyEventTimestamp": 1773091222522527,
  "readWatermarkTimestamp": 1772643133819567,
  "lastNotifWorthyEvent": "March 9, 2026 at 9:20 PM GMT",
  "readWatermark": "March 4, 2026 at 4:52 PM GMT"
}
```

### Pagination

```json
{
  "topics": [...],
  "pagination": {
    "contains_first_topic": false,
    "contains_last_topic": true,
    "has_more": true,
    "next_cursor": 1705320000000000
  }
}
```

Use `next_cursor` as the `cursor` parameter for the next page.

## Error Handling

### HTTP Server Errors

```json
{
  "error": "Space not found"
}
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 401 | Authentication required |
| 404 | Resource not found |
| 500 | Server error |

### Client Errors

```typescript
try {
  const messages = await client.getThreads('invalid_id');
} catch (error) {
  console.error('API Error:', error.message);
  // Handle token refresh, re-auth, etc.
}
```

## Rate Limiting

Google Chat has undocumented rate limits. Best practices:

- Add delays between bulk operations
- Cache results when possible
- Use pagination instead of fetching all at once
- Handle 429 (Too Many Requests) responses

```typescript
// Example: Fetch with delay
for (const space of spaces) {
  const messages = await client.getThreads(space.id);
  await new Promise(r => setTimeout(r, 500)); // 500ms delay
}
```
