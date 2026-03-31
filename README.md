# GChat

Unofficial Google Chat CLI. Talks to the same internal endpoints the web app uses.

## Setup

```bash
npm install && cd packages/gchat && npm install && npm run build

# Put gchat on your PATH:
npm link          # from packages/gchat, or `npm run link` from root
```

## Bridge

Routes requests through a Chrome extension -- cookies never leave the browser.

1. Load `extension/` as unpacked in `chrome://extensions`
2. Open [chat.google.com](https://chat.google.com)
3. `gchat bridge` (background, prints PID) or `gchat bridge --foreground`

## Commands

```
gchat spaces                           list spaces
gchat messages <id> [--last 50]        messages from a space
gchat threads <id> [--full]            threaded messages
gchat dms [--unread]                   DM conversations
gchat search "query"                   search all spaces
gchat send <id> "msg" [-t <thread>]    send / reply
gchat notifications [--me]             unread counts
gchat export <id> [--since 7d]         export to JSON
gchat api [--port 3000]                HTTP server (docs at /docs)
gchat bridge [--foreground]            extension bridge
```

`--json` for JSON output. `--debug` for verbose logs.

## Env

| Variable | Default | |
|---|---|---|
| `GCHAT_CACHE_DIR` | `~/.gchat` | Auth/cache dir |
| `GCHAT_EXTENSION_PORT` | `7891` | Bridge WS port |
| `GCHAT_TIMEZONE` | `UTC` | Timestamp TZ |
| `LOG_LEVEL` | `info` | error/warn/info/debug/silent |
