# API Examples

Common queries and usage patterns for the Google Chat API.

## Authentication

All examples assume the HTTP server is running:

```bash
cd packages/gchat && npm run serve
# or from repo root:
# npm run serve
```

The server authenticates using your cached browser cookies + XSRF token (see Authentication docs).

---

## User Information

### Get Current User

```bash
curl http://localhost:3000/api/whoami
```

**Response:**
```json
{
  "userId": "123456789012345678901",
  "name": "John Doe",
  "email": "john.doe@gmail.com",
  "firstName": "John",
  "lastName": "Doe",
  "avatarUrl": "https://..."
}
```

---

## Spaces

### List All Spaces

```bash
curl http://localhost:3000/api/spaces
```

**Response:**
```json
{
  "spaces": [
    {
      "id": "AAAA_abc123xyz",
      "type": "space",
      "name": "Project Team",
      "sortTimestamp": 1705420800000000
    },
    {
      "id": "DM_abc123xyz",
      "type": "dm",
      "name": "Jane Smith"
    }
  ],
  "count": 2,
  "pagination": {
    "hasMore": false,
    "nextCursor": 1705420800000000
  }
}
```

### List Spaces with Pagination

```bash
curl "http://localhost:3000/api/spaces?pageSize=100"
curl "http://localhost:3000/api/spaces?pageSize=100&cursor=1705420800000000"
```

---

## Notifications

### Get All Notifications

```bash
curl http://localhost:3000/api/notifications
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
  "pagination": { "total": 130, "offset": 0, "limit": 130, "returned": 130, "hasMore": false }
}
```

The four sections are **mutually exclusive** — every item appears in exactly one.

| Section | Meaning |
|---------|---------|
| `badgedDMs` | DMs with a numbered badge |
| `badgedSpaces` | Spaces with a numbered badge |
| `litupDMs` | DMs shown bold (no number) |
| `litupSpaces` | Spaces shown bold (no number) |

### Filter Notifications

```bash
# Only badged items (DMs + spaces)
curl "http://localhost:3000/api/notifications?mentions=true"

# Only lit-up spaces
curl "http://localhost:3000/api/notifications?spaces=true"

# Badged items that directly @mention you (fetches recent messages)
curl "http://localhost:3000/api/notifications?me=true&messages=true"
```

### Timezone Configuration

Timestamps include a human-readable string controlled by the `GCHAT_TIMEZONE` environment variable (IANA format, default: `UTC`):

```bash
# .env
GCHAT_TIMEZONE=Europe/London    # → "March 10, 2026 at 2:52 AM GMT"
GCHAT_TIMEZONE=America/New_York # → "March 9, 2026 at 9:52 PM EST"
GCHAT_TIMEZONE=UTC              # → "March 10, 2026 at 2:52 AM UTC" (default)
```

---

## Direct Messages (DMs)

### List All DMs

```bash
curl http://localhost:3000/api/dms
```

### List DMs with Message Previews

```bash
curl "http://localhost:3000/api/dms?messages=true&messagesLimit=5"
```

### Get DM Details

```bash
curl http://localhost:3000/api/dms/DM_abc123xyz
```

---

## All Conversations

### List Spaces and DMs Together

The `/api/spaces` endpoint already returns both spaces and DMs, so you can reuse it to build a sidebar:

```bash
curl http://localhost:3000/api/spaces
```

---

## Messages

### Get Threads from a Space

```bash
curl http://localhost:3000/api/spaces/AAAA_abc123xyz/threads
```

**Response:**
```json
{
  "messages": [
    {
      "message_id": "msg_456",
      "topic_id": "topic_123",
      "space_id": "AAAA_abc123xyz",
      "text": "Hello everyone!",
      "timestamp": "2024-01-16T12:00:00.000Z",
      "timestamp_usec": 1705420800000000,
      "sender": "John Doe"
    }
  ],
  "topics": [
    {
      "topic_id": "topic_123",
      "space_id": "AAAA_abc123xyz",
      "sort_time": 1705420800000000,
      "message_count": 1,
      "has_more_replies": false,
      "replies": [
        {
          "message_id": "msg_456",
          "topic_id": "topic_123",
          "space_id": "AAAA_abc123xyz",
          "text": "Hello everyone!",
          "timestamp": "2024-01-16T12:00:00.000Z",
          "timestamp_usec": 1705420800000000,
          "sender": "John Doe"
        }
      ]
    }
  ],
  "pagination": {
    "contains_first_topic": false,
    "contains_last_topic": true,
    "has_more": true,
    "next_cursor": 1705320000000000
  },
  "total_topics": 1,
  "total_messages": 1
}
```

### Get Threads from a DM

```bash
curl http://localhost:3000/api/dms/DM_abc123xyz/threads
```

### Custom Page Size and Full Threads

```bash
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?pageSize=50&full=true"
```

```bash
curl "http://localhost:3000/api/dms/DM_abc123xyz/threads?pageSize=25&repliesPerTopic=20"
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `pageSize` | 25 | Number of threads to fetch |
| `cursor` | null | Pagination cursor (timestamp in microseconds) |
| `until` | null | Upper time boundary (epoch seconds, microseconds, or ISO 8601 timestamp) |
| `since` | null | Lower time boundary (epoch seconds, microseconds, or ISO 8601 timestamp) |
| `format` | threaded | Response format: `messages` (flat list of first messages only) or `threaded` (topics with replies) |
| `full` | false | Fetch full thread contents (spaces) |
| `repliesPerTopic` | 10 | Replies per thread (DMs) |
| `fullThreads` | false | Fetch full thread contents (DMs) |

### Fetching Messages Up to a Point in Time

Use the `until` parameter to fetch threads up to a specific timestamp. The API accepts both **epoch seconds** and **microseconds** - values less than 10^13 are automatically treated as seconds.

```bash
# Using epoch seconds (simpler)
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?until=1705276800"

# Using microseconds (also works)
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?until=1705276800000000"
```

For DMs:

```bash
curl "http://localhost:3000/api/dms/DM_abc123xyz/threads?until=1705276800"
```

You can combine `until` with `cursor` for paginated time-bounded queries:

```bash
# Fetch page 2 of threads up to January 15, 2024
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?until=1705276800&cursor=1705200000000000"
```

### Fetching Messages From a Time Range

Use the `since` parameter to fetch threads newer than a specific time:

```bash
# Fetch threads from the last 24 hours
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?since=$(( $(date +%s) - 86400 ))"

# Fetch threads from the last 48 hours
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?since=$(( $(date +%s) - 172800 ))"
```

Combine `since` and `until` for a specific time window:

```bash
# Fetch threads between Jan 10-15, 2024
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?since=1704844800&until=1705276800"
```

**Generating timestamps:**

```bash
# Current epoch time in seconds
date +%s

# 24 hours ago
echo $(( $(date +%s) - 86400 ))

# 7 days ago (macOS)
date -v-7d +%s

# 7 days ago (Linux)
date -d '7 days ago' +%s

# Specific date (2024-01-15) - macOS
date -j -f "%Y-%m-%d" "2024-01-15" +%s

# Specific date (2024-01-15) - Linux
date -d "2024-01-15" +%s
```

### Using ISO 8601 Timestamps

You can also use ISO 8601 format with timezone for more readable queries:

```bash
# UTC timezone
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?since=2026-01-16T00:00:00Z&until=2026-01-17T23:59:59Z"

# With timezone offset (PST)
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?since=2026-01-16T00:00:00-08:00"

# Date only (parsed as midnight UTC)
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?since=2026-01-16"

# For DMs
curl "http://localhost:3000/api/dms/DM_abc123xyz/threads?since=2026-01-16T00:00:00Z"
```

Supported formats:

| Format | Example | Description |
|--------|---------|-------------|
| Epoch seconds | `1768521600` | Unix timestamp (auto-detected if < 10^13) |
| Microseconds | `1768521600000000` | Microsecond precision (>= 10^13) |
| ISO 8601 UTC | `2026-01-16T00:00:00Z` | UTC timezone with Z suffix |
| ISO 8601 offset | `2026-01-16T00:00:00-08:00` | With explicit timezone offset |
| ISO date | `2026-01-16` | Date only (midnight UTC) |

### Response Format Options

Use the `format` parameter to control the response structure:

**`format=messages`** - Returns a flat list of first messages only (topic starters, no thread replies):

```bash
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?format=messages"
```

Response:
```json
{
  "messages": [
    { "message_id": "msg_1", "text": "First topic message...", ... },
    { "message_id": "msg_2", "text": "Another topic message...", ... }
  ],
  "topics": [],
  "pagination": { "has_more": true, "next_cursor": 1768564095694687 },
  "total_topics": 3,
  "total_messages": 3
}
```

**`format=threaded`** (default) - Returns topics with all replies nested inside:

```bash
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?format=threaded"
```

Response:
```json
{
  "messages": [...],  // All messages from all topics
  "topics": [
    {
      "topic_id": "topic_123",
      "replies": [
        { "message_id": "msg_1", "text": "First message...", ... },
        { "message_id": "msg_2", "text": "Reply 1...", "is_thread_reply": true, ... },
        { "message_id": "msg_3", "text": "Reply 2...", "is_thread_reply": true, ... }
      ]
    }
  ],
  "pagination": { ... }
}
```

Combine with time filters for specific queries:

```bash
# Get only first messages from Friday (no thread replies)
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?since=2026-01-16T00:00:00Z&until=2026-01-16T23:59:59Z&format=messages"
```

### Send a Message

```bash
curl -X POST http://localhost:3000/api/spaces/AAAA_abc123xyz/messages \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello from the API"
  }'
```

```bash
curl -X POST http://localhost:3000/api/dms/DM_abc123xyz/messages \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hi from a DM"
  }'
```

### Fetch All Messages (Multi-page)

```bash
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/messages?maxPages=5&pageSize=25&full=true"
```

---

## Pagination

### Understanding Pagination

Messages are returned in reverse chronological order. Use `pagination.next_cursor` to fetch older messages.

**First request:**
```bash
curl http://localhost:3000/api/spaces/AAAA_abc123xyz/threads
```

**Response includes:**
```json
{
  "pagination": {
    "containsFirstTopic": false,
    "containsLastTopic": true,
    "has_more": true,
    "next_cursor": 1705320000000000
  }
}
```

**Next page (older messages):**
```bash
curl "http://localhost:3000/api/spaces/AAAA_abc123xyz/threads?cursor=1705320000000000"
```

### Pagination Loop Example

Fetch all messages from a space:

=== "Bash"

    ```bash
    SPACE_ID="AAAA_abc123xyz"
    CURSOR=""

    while true; do
      if [ -z "$CURSOR" ]; then
        RESPONSE=$(curl -s "http://localhost:3000/api/spaces/$SPACE_ID/threads")
      else
        RESPONSE=$(curl -s "http://localhost:3000/api/spaces/$SPACE_ID/threads?cursor=$CURSOR")
      fi

      # Process messages
      echo "$RESPONSE" | jq '.messages[]'

      # Check if more pages exist
      HAS_MORE=$(echo "$RESPONSE" | jq '.pagination.has_more')
      if [ "$HAS_MORE" != "true" ]; then
        break
      fi

      # Get next cursor
      CURSOR=$(echo "$RESPONSE" | jq -r '.pagination.next_cursor')

      # Rate limit
      sleep 0.5
    done
    ```

=== "JavaScript"

    ```javascript
    async function fetchAllMessages(spaceId) {
      const messages = [];
      let cursor = null;

      while (true) {
        const url = cursor
          ? `http://localhost:3000/api/spaces/${spaceId}/threads?cursor=${cursor}`
          : `http://localhost:3000/api/spaces/${spaceId}/threads`;

        const response = await fetch(url);
        const data = await response.json();

        // Collect messages
        messages.push(...data.messages);

        // Check for more pages
        if (!data.pagination.has_more) break;

        cursor = data.pagination.next_cursor;

        // Rate limit
        await new Promise(r => setTimeout(r, 500));
      }

      return messages;
    }
    ```

=== "Python"

    ```python
    import requests
    import time

    def fetch_all_messages(space_id):
        messages = []
        cursor = None

        while True:
            url = f"http://localhost:3000/api/spaces/{space_id}/threads"
            if cursor:
                url += f"?cursor={cursor}"

            response = requests.get(url)
            data = response.json()

            # Collect messages
            messages.extend(data["messages"])

            # Check for more pages
            if not data["pagination"]["has_more"]:
                break

            cursor = data["pagination"]["next_cursor"]

            # Rate limit
            time.sleep(0.5)

        return messages
    ```

---

## Presence

### Get Presence for Specific Users

```bash
curl "http://localhost:3000/api/presence?userIds=123456789,987654321"
```

### Include Profile Information

```bash
curl "http://localhost:3000/api/presence?userIds=123456789,987654321&include=profile"
```

### Debug Raw Presence Response

```bash
curl "http://localhost:3000/api/presence?userIds=123456789&debug=true"
```

### Presence for DM Participants

```bash
curl "http://localhost:3000/api/dms/presence?dmIds=DM_abc123xyz,DM_def456"
```

---

## Read State

### Mark a Space or DM as Read

```bash
curl -X POST "http://localhost:3000/api/notifications/mark" \
  -H "Content-Type: application/json" \
  -d '{ "groupId": "AAAA_abc123xyz", "action": "read", "unreadCount": 5 }'
```

```bash
curl -X POST "http://localhost:3000/api/notifications/mark" \
  -H "Content-Type: application/json" \
  -d '{ "groupId": "DM_abc123xyz", "action": "read" }'
```

### Mark a Space or DM as Unread

```bash
curl -X POST "http://localhost:3000/api/notifications/mark" \
  -H "Content-Type: application/json" \
  -d '{ "groupId": "AAAA_abc123xyz", "action": "unread" }'
```

With a specific timestamp (microseconds) to mark as unread from that point:

```bash
curl -X POST "http://localhost:3000/api/notifications/mark" \
  -H "Content-Type: application/json" \
  -d '{ "groupId": "AAAA_abc123xyz", "action": "unread", "timestamp": 1773137691794158 }'
```

---

## Working with Message Content

### Messages with URLs

Messages containing links include URL metadata:

```json
{
  "message_id": "msg_123",
  "text": "Check out https://example.com",
  "urls": [
    {
      "url": "https://example.com",
      "title": "Example Domain",
      "image_url": "https://example.com/og-image.png"
    }
  ]
}
```

### Messages with Images

```json
{
  "message_id": "msg_456",
  "text": "",
  "images": [
    {
      "image_url": "https://chat.google.com/...",
      "width": 1920,
      "height": 1080,
      "content_type": "image/png"
    }
  ]
}
```

### Messages with Attachments

```json
{
  "message_id": "msg_789",
  "text": "Here's the document",
  "attachments": [
    {
      "attachment_id": "token_abc123",
      "content_name": "report.pdf",
      "content_type": "application/pdf",
      "download_url": "https://drive.google.com/uc?export=download&id=..."
    }
  ]
}
```

To download upload attachments, resolve the token via the proxy endpoint:

```bash
curl "http://localhost:3000/api/attachment?token=token_abc123" --output report.pdf
```

---

## TypeScript Client Examples

### Initialize Client

```typescript
import { GoogleChatClient, auth } from 'gchat-cli';

const cookies = auth.getCookies();
const client = new GoogleChatClient(cookies);
await client.authenticate();
```

### List and Filter Spaces

```typescript
const spaces = await client.listSpaces();

// Filter by type
const groupSpaces = spaces.filter(s => s.type === 'space');
const dms = spaces.filter(s => s.type === 'dm');

// Find by name
const teamChat = spaces.find(s => s.name?.includes('Team'));
```

### Search Messages

```typescript
// Search across all spaces
const results = await client.searchAllSpaces('keyword');

// Search in a specific space
const spaceResults = await client.searchInSpace('AAAA_space_id', 'keyword');
```

### Send a Message

```typescript
// Send to a space
const result = await client.sendMessage('AAAA_space_id', 'Hello, team!');

// Send to a DM (DM IDs are inferred by the client)
const dmResult = await client.sendMessage('DM_user_id', 'Hey there!');
```

---

## Error Handling

### Common HTTP Status Codes

| Status | Meaning | Solution |
|--------|---------|----------|
| 200 | Success | - |
| 401 | Unauthorized | Re-run with `--refresh` (or `gchat --refresh auth refresh`) |
| 404 | Not found | Check space/DM ID |
| 429 | Rate limited | Add delays between requests |
| 500 | Server error | Check server logs |

### Handling Errors in Code

=== "JavaScript"

    ```javascript
    try {
      const response = await fetch('http://localhost:3000/api/spaces/invalid/threads');
      if (!response.ok) {
        const error = await response.json();
        console.error('API Error:', error.error);
      }
    } catch (e) {
      console.error('Network error:', e.message);
    }
    ```

=== "Python"

    ```python
    import requests

    try:
        response = requests.get('http://localhost:3000/api/spaces/invalid/threads')
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        print(f"API Error: {e.response.json()['error']}")
    except requests.exceptions.RequestException as e:
        print(f"Network error: {e}")
    ```

---

## Health Check

Verify the server is running:

```bash
curl http://localhost:3000/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-16T12:00:00.000Z"
}
```
