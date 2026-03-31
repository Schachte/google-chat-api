# Architecture Overview

This project is a TypeScript/Node.js CLI + HTTP server that talks to Google Chat’s internal endpoints (`chat.google.com`) using browser cookies and an XSRF token.

## High-Level Components

```
┌───────────────────────────────────────────────────────────────┐
│                           gchat CLI                             │
│  packages/gchat/src/cli/program.ts                               │
│  - CLI commands (spaces/messages/search/export/etc)              │
│  - Starts HTTP server via `gchat api`                            │
└───────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────────────────────────┐
│                      HTTP API Server                            │
│  packages/gchat/src/server/api-server.ts                         │
│  - HTTP server + UI (/ui) + Scalar docs (/docs)                  │
└───────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────────────────────────┐
│                        GoogleChatClient                          │
│  packages/gchat/src/core/client.ts                                │
│  - Encodes requests (protobuf / JSON-PBLite)                      │
│  - Parses responses (XSSI stripping + PBLite decoding)            │
└───────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────────────────────────┐
│                        Authentication                             │
│  packages/gchat/src/core/auth.ts                                  │
│  - Extract cookies (browser profile, cookies.txt, fallback CLI)   │
│  - Fetch XSRF token from /mole/world (cached)                     │
└───────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────────────────────────┐
│                     WebChannel (optional)                         │
│  packages/gchat/src/core/channel.ts                               │
│  - Real-time events + keep-alive pings                             │
└───────────────────────────────────────────────────────────────┘
                      │
                      ▼
              chat.google.com internal API
```

## Request/Response Flow

All requests to Google Chat follow this pattern:

```
┌──────────┐     ┌───────────┐     ┌─────────────────┐     ┌──────────┐
│  Client  │────▶│  Encode   │────▶│  HTTP Request   │────▶│  Google  │
│          │     │  (Proto)  │     │  + Auth Headers │     │  Chat    │
└──────────┘     └───────────┘     └─────────────────┘     └────┬─────┘
                                                                │
┌──────────┐     ┌───────────┐     ┌─────────────────┐          │
│  Client  │◀────│  Parse    │◀────│  Strip XSSI     │◀─────────┘
│          │     │  PBLite   │     │  Prefix ")]}"   │
└──────────┘     └───────────┘     └─────────────────┘
```

### Request Headers

```http
POST /api/list_topics?alt=protojson&key=AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k
Content-Type: application/x-protobuf
Cookie: SID=xxx; HSID=xxx; SSID=xxx; ...
x-framework-xsrf-token: AF...
User-Agent: Mozilla/5.0 ...
```

### Response Format

```javascript
// Raw response (with XSSI prefix)
)]}'
[["dfe.t.lt",[...topics...],null,null,true,true]]

// After stripping prefix and parsing
[["dfe.t.lt", [...topics...], null, null, true, true]]
```

## Encoding Formats

Google Chat endpoints use protobuf messages, but different endpoints behave differently:

- **Binary protobuf** (`Content-Type: application/x-protobuf`) works for most endpoints.
- **JSON/PBLite** (`Content-Type: application/json`) is required for:
    - `paginated_world` — full world item list (spaces + DMs). Must use PBLite JSON, not binary protobuf.
    - `list_topics` — reliable cursor pagination (matching the web client).

For large exports, prefer `GoogleChatClient.fetchTopicsWithServerPagination()` and `utils.exportChatBatches()`.

## API Endpoints

The project interacts with these internal Google Chat endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/get_self_user_status` | POST | Get current user info |
| `/api/get_group_summaries` | POST | List spaces/DMs |
| `/api/list_topics` | POST | Get messages in a space |
| `/api/list_messages` | POST | Get messages in a thread |
| `/api/paginated_world` | POST | Full conversation list |
| `/api/get_members` | POST | Get user details |
| `/api/create_topic` | POST | Send new message |
| `/api/create_message` | POST | Reply to thread |
| `/mole/world` | GET | Get XSRF token (bootstrap) |

## Data Flow Example

Getting messages from a space:

```
1. `GoogleChatClient.listSpaces()`
   └─▶ POST /api/paginated_world (JSON/PBLite)
   └─▶ Parse → Space[]

2. `GoogleChatClient.getThreads(spaceId, …)`
   └─▶ POST /api/list_topics (protobuf, with optional time filters + cursor)
   └─▶ Parse → Topic[] + Message[]

3. Optional expansion: `GoogleChatClient.getThread(spaceId, topicId)`
   └─▶ POST /api/list_messages (protobuf)
   └─▶ Parse → Message[]
```

See [Repository Layout](repository-layout.md) for detailed file structure.
