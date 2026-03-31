# OpenAPI Documentation

The HTTP server includes an OpenAPI 3.1 specification and a Scalar API reference for interactive API exploration.

## Accessing the Documentation

### Scalar API Reference

Start the server and navigate to `/docs`:

```bash
cd packages/gchat && npm run serve
# Open http://localhost:3000/docs
```

The Scalar docs provide:

- Interactive API testing
- Request/response schemas
- Parameter documentation
- Try-it-out functionality

### OpenAPI Specification

The raw specification is available at:

- **YAML**: `http://localhost:3000/openapi.yaml`
- **JSON**: `http://localhost:3000/openapi.json`

## API Endpoints

### Health Check

```yaml
GET /health
```

Returns server health status.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-16T12:00:00.000Z"
}
```

### Get Current User

```yaml
GET /api/whoami
```

Returns the authenticated user's information.

**Response:**

```json
{
  "userId": "123456789",
  "name": "John Doe",
  "email": "john@example.com",
  "firstName": "John",
  "lastName": "Doe",
  "avatarUrl": "https://..."
}
```

### List Spaces

```yaml
GET /api/spaces
```

Returns all spaces and DMs the user is a member of.

**Parameters:**

| Name | In | Type | Default | Description |
|------|-----|------|---------|-------------|
| pageSize | query | integer | 100 | Spaces per page |
| cursor | query | integer | - | Pagination cursor (sortTimestamp in microseconds) |

**Response:**

```json
{
  "spaces": [
    {
      "id": "AAAA_abc123",
      "type": "space",
      "name": "Team Chat",
      "sortTimestamp": 1705410000000000
    },
    {
      "id": "dm_xyz789",
      "type": "dm",
      "name": "Jane Doe"
    }
  ],
  "count": 2,
  "pagination": {
    "hasMore": false,
    "nextCursor": 1705410000000000
  }
}
```

### List Threads (GET)

```yaml
GET /api/spaces/{spaceId}/threads
```

Returns threaded topics for a space with optional time-based filtering.

**Parameters:**

| Name | In | Type | Default | Description |
|------|-----|------|---------|-------------|
| spaceId | path | string | - | Space identifier |
| pageSize | query | integer | 25 | Threads per page |
| cursor | query | integer | - | Pagination cursor (microseconds) |
| full | query | boolean | false | Fetch full thread contents |
| since | query | integer or string | - | Lower time boundary (epoch seconds, microseconds, or ISO 8601) |
| until | query | integer or string | - | Upper time boundary (epoch seconds, microseconds, or ISO 8601) |
| format | query | string | threaded | Response format: `messages` or `threaded` |

**Time Filtering:**

The `since` and `until` parameters accept multiple formats:

- **Epoch seconds**: Values < 10^13 (e.g., `1768521600`)
- **Microseconds**: Values >= 10^13 (e.g., `1768521600000000`)
- **ISO 8601 timestamps**: With timezone (e.g., `2026-01-16T00:00:00Z` or `2026-01-16T00:00:00-08:00`)

```bash
# Messages from last 24 hours (epoch seconds)
curl "http://localhost:3000/api/spaces/SPACE_ID/threads?since=$(( $(date +%s) - 86400 ))"

# Messages from a specific day using epoch (Jan 16, 2026)
curl "http://localhost:3000/api/spaces/SPACE_ID/threads?since=1768521600&until=1768608000"

# Messages using ISO 8601 timestamps (more readable)
curl "http://localhost:3000/api/spaces/SPACE_ID/threads?since=2026-01-16T00:00:00Z&until=2026-01-17T00:00:00Z"

# With timezone offset
curl "http://localhost:3000/api/spaces/SPACE_ID/threads?since=2026-01-16T00:00:00-08:00"
```

**Response Format:**

Use the `format` parameter to control response structure:

- **`format=messages`** - Flat list of first messages only (topic starters, no thread replies)
- **`format=threaded`** (default) - Topics with all replies nested inside

```bash
# Get only first messages (no thread replies)
curl "http://localhost:3000/api/spaces/SPACE_ID/threads?format=messages"

# Get full threaded view (default)
curl "http://localhost:3000/api/spaces/SPACE_ID/threads?format=threaded"

# Combine with time filters
curl "http://localhost:3000/api/spaces/SPACE_ID/threads?since=2026-01-16T00:00:00Z&format=messages"
```

**Response:**

```json
{
  "messages": [
    {
      "message_id": "msg_456",
      "topic_id": "topic_123",
      "space_id": "AAAA_abc123",
      "text": "Hello everyone!",
      "timestamp": "2024-01-16T12:00:00.000Z",
      "timestamp_usec": 1705406400000000,
      "sender": "John Doe"
    }
  ],
  "topics": [
    {
      "topic_id": "topic_123",
      "space_id": "AAAA_abc123",
      "sort_time": 1705410000000000,
      "message_count": 1,
      "has_more_replies": false,
      "replies": [
        {
          "message_id": "msg_456",
          "topic_id": "topic_123",
          "space_id": "AAAA_abc123",
          "text": "Hello everyone!",
          "timestamp": "2024-01-16T12:00:00.000Z",
          "timestamp_usec": 1705406400000000,
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

### Get a Single Thread

```yaml
GET /api/spaces/{spaceId}/threads/{topicId}
```

Returns all messages for a specific thread.

**Parameters:**

| Name | In | Type | Default | Description |
|------|-----|------|---------|-------------|
| spaceId | path | string | - | Space identifier |
| topicId | path | string | - | Topic identifier |
| pageSize | query | integer | 100 | Messages per thread |

### Send a New Message

```yaml
POST /api/spaces/{spaceId}/messages
```

**Request Body:**

```json
{
  "text": "Hello from the API!"
}
```

**Response:**

```json
{
  "success": true,
  "message_id": "msg_456",
  "topic_id": "topic_123"
}
```

### Reply to a Thread

```yaml
POST /api/spaces/{spaceId}/threads/{topicId}/replies
```

**Request Body:**

```json
{
  "text": "Thanks for the update!"
}
```

### Fetch All Messages (Multi-page)

```yaml
GET /api/spaces/{spaceId}/messages
```

Returns aggregated messages across multiple pages.

### Presence Lookup

```yaml
GET /api/presence
```

Returns presence status for a list of user IDs.

**Parameters:**

| Name | In | Type | Default | Description |
|------|-----|------|---------|-------------|
| userIds | query | string | - | Comma-separated list of user IDs (max 100) |
| include | query | string | - | Set to `profile` to include profile info |
| debug | query | boolean | false | Return raw presence response for debugging |

```bash
curl "http://localhost:3000/api/presence?userIds=123456789,987654321"
curl "http://localhost:3000/api/presence?userIds=123456789&include=profile"
curl "http://localhost:3000/api/presence?userIds=123456789&debug=true"
```

### DM Presence

```yaml
GET /api/dms/presence
```

Returns presence for DM participants and includes profile fields when available.

```bash
curl "http://localhost:3000/api/dms/presence?dmIds=DM_abc123xyz,DM_def456"
```

### Mark as Read or Unread

```yaml
POST /api/notifications/mark
```

Marks a space or DM as read or unread. Requires `groupId` and `action` (`"read"` or `"unread"`) in the JSON body.

```bash
# Mark as read
curl -X POST "http://localhost:3000/api/notifications/mark" \
  -H "Content-Type: application/json" \
  -d '{"groupId": "AAAA_abc123xyz", "action": "read", "unreadCount": 5}'

# Mark as unread
curl -X POST "http://localhost:3000/api/notifications/mark" \
  -H "Content-Type: application/json" \
  -d '{"groupId": "AAAA_abc123xyz", "action": "unread"}'
```

## Pagination

The API uses cursor-based pagination with microsecond timestamps.

### How It Works

1. First request returns topics and `pagination.next_cursor`
2. Use `next_cursor` as the `cursor` query parameter
3. Continue until `pagination.has_more` is `false`

### Example

```bash
# First page
curl http://localhost:3000/api/spaces/AAAA_abc/threads?pageSize=20

# Response includes: "next_cursor": 1705320000000000

# Next page
curl "http://localhost:3000/api/spaces/AAAA_abc/threads?pageSize=20&cursor=1705320000000000"
```

### JavaScript Example

```javascript
async function getAllMessages(spaceId) {
  const allTopics = [];
  let cursor = null;

  do {
    const url = new URL(`http://localhost:3000/api/spaces/${spaceId}/threads`);
    url.searchParams.set('pageSize', '50');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url);
    const data = await response.json();

    allTopics.push(...data.topics);
    cursor = data.pagination.next_cursor;

  } while (cursor);

  return allTopics;
}
```

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message here"
}
```

### Common Errors

| Status | Error | Cause |
|--------|-------|-------|
| 401 | Authentication required | Invalid or expired tokens |
| 404 | Space not found | Invalid space ID |
| 500 | API request failed | Google API error |

## OpenAPI Spec File

The specification is defined in `packages/gchat/openapi/openapi.yaml`:

```yaml
openapi: 3.1.0
info:
  title: Google Chat API
  description: |
    Unofficial JSON API for Google Chat using reverse-engineered endpoints.
  version: 1.0.0

servers:
  - url: http://localhost:3000
    description: Local development server

paths:
  /api/spaces/{spaceId}/threads:
    get:
      summary: List Threads in a Space
      operationId: listSpaceThreads
      tags:
        - Threads
      parameters:
        - name: spaceId
          in: path
          required: true
          schema:
            type: string
        - name: pageSize
          in: query
          schema:
            type: integer
            default: 25
        - name: cursor
          in: query
          schema:
            type: integer
            format: int64
        - name: since
          in: query
          description: Lower time boundary (epoch seconds, microseconds, or ISO 8601)
          schema:
            oneOf:
              - type: integer
                format: int64
              - type: string
                format: date-time
        - name: until
          in: query
          description: Upper time boundary (epoch seconds, microseconds, or ISO 8601)
          schema:
            oneOf:
              - type: integer
                format: int64
              - type: string
                format: date-time
        - name: format
          in: query
          description: Response format (messages or threaded)
          schema:
            type: string
            enum: [messages, threaded]
            default: threaded
      responses:
        '200':
          description: Threads and messages
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ThreadsResult'
```

## Using with API Clients

### Generate Client SDK

Use the OpenAPI spec to generate client SDKs:

```bash
# Using openapi-generator
npx openapi-generator-cli generate \
  -i http://localhost:3000/openapi.json \
  -g typescript-fetch \
  -o ./generated-client
```

### Import into Postman

1. Open Postman
2. Import → Link: `http://localhost:3000/openapi.json`
3. Collection is created with all endpoints

### Import into Insomnia

1. Open Insomnia
2. Import from URL: `http://localhost:3000/openapi.yaml`
3. Workspace is created with all endpoints

## Customizing the Server

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| HOST | localhost | Server host |

### CLI Options

```bash
node cli.js http-server --port 8080 --host 0.0.0.0
```

### CORS

The server includes CORS headers for browser access:

```javascript
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
'Access-Control-Allow-Headers': 'Content-Type'
```

Modify `http-server.js` to restrict origins in production.
