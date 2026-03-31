/**
 * ExtensionBridge — local WebSocket server that the Chrome extension connects to.
 *
 * Protocol (all messages are JSON):
 *
 * Server → Extension:
 *   { type: "hello" }
 *   { type: "ping" }
 *
 * Extension → Server:
 *   { type: "hello:ack", clientName?: string, hasXsrf: boolean }
 *   { type: "pong" }
 *   { type: "xsrf:update", token: string }
 *   { type: "api:response", id: string, ok: boolean, status: number, body: string, error?: string }
 *
 * Server → Extension:
 *   { type: "api:request", id: string, url: string, method: string,
 *                          headers: Record<string, string>, body?: string, bodyType: string }
 */

import { createServer, IncomingMessage } from 'node:http';
import { randomUUID }                    from 'node:crypto';
import { WebSocketServer, WebSocket }    from 'ws';
import { log }                           from './logger.js';

export const DEFAULT_EXTENSION_HOST = '0.0.0.0';
export const DEFAULT_EXTENSION_PORT = 7891;

/** How often to ping the extension WebSocket (ms). */
const PING_INTERVAL_MS = 25_000;

interface PendingRequest {
  resolve: (result: ExtensionProxyResponse) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

export interface ExtensionProxyResponse {
  ok:     boolean;
  status: number;
  body:   string;
}

// Outbound message shapes
interface HelloMsg        { type: 'hello' }
interface PingMsg         { type: 'ping' }
interface ApiRequestMsg   { type: 'api:request'; id: string; url: string; method: string; headers: Record<string, string>; body?: string; bodyType: string; bodyBytes?: number[] }
interface CmdResponseMsg  { type: 'cmd:response'; id: string; success: boolean; data?: unknown; error?: string }

// Inbound message shapes
interface HelloAckMsg     { type: 'hello:ack'; clientName?: string; hasXsrf?: boolean }
interface PingMsg2         { type: 'ping' }   // extension keepalive alarm can also send pings
interface PongMsg          { type: 'pong' }
interface XsrfUpdateMsg   { type: 'xsrf:update'; token: string }
interface ApiResponseMsg  { type: 'api:response'; id: string; ok: boolean; status: number; body: string; error?: string }
interface CmdMsg          { type: 'cmd'; id: string; name: string; args?: unknown }

type InboundMsg = HelloAckMsg | PingMsg2 | PongMsg | XsrfUpdateMsg | ApiResponseMsg | CmdMsg;

export class ExtensionBridge {
  private readonly host: string;
  private readonly port: number;
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private socket: WebSocket | null = null;
  private xsrfToken: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private xsrfWaiters: Array<(token: string) => void> = [];
  private readonly commandHandlers = new Map<string, (args?: unknown) => Promise<unknown>>();
  private isAlive = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(port: number = DEFAULT_EXTENSION_PORT, host: string = DEFAULT_EXTENSION_HOST) {
    this.host = host;
    this.port = port;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer();
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        log.auth.info(`[ExtensionBridge] Extension connected from ${req.socket.remoteAddress}`);
        this.socket = ws;

        // Greet the extension
        this.send({ type: 'hello' } satisfies HelloMsg);

        // ── Application-level keepalive ────────────────────────────────
        // Chrome MV3 service workers are suspended after ~30 s of idle.
        // Protocol-level WebSocket pings are handled by the browser's C++
        // layer and do NOT wake the service worker's JS context.  By
        // sending a JSON { type: "ping" } the extension's onmessage fires,
        // which counts as JS activity and prevents suspension.
        this.isAlive = true;
        if (this.pingInterval) clearInterval(this.pingInterval);

        this.pingInterval = setInterval(() => {
          if (!this.isAlive) {
            log.auth.warn('[ExtensionBridge] Extension not responding to keepalive, terminating');
            clearInterval(this.pingInterval!);
            this.pingInterval = null;
            ws.terminate();
            return;
          }
          this.isAlive = false;
          this.send({ type: 'ping' } satisfies PingMsg);
        }, PING_INTERVAL_MS);

        ws.on('message', (raw) => {
          try {
            const msg: InboundMsg = JSON.parse(raw.toString());
            this.handleMessage(msg);
          } catch (e) {
            log.auth.warn('[ExtensionBridge] Bad message from extension:', (e as Error).message);
          }
        });

        ws.on('close', () => {
          log.auth.info('[ExtensionBridge] Extension disconnected');
          if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
          if (this.socket === ws) {
            this.socket = null;
          }
        });

        ws.on('error', (err) => {
          log.auth.warn('[ExtensionBridge] WebSocket error:', err.message);
          if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        });
      });

      this.httpServer.on('error', (err) => {
        log.auth.error('[ExtensionBridge] HTTP server error:', err.message);
        reject(err);
      });

      // Bind to the configured host.  Default is 0.0.0.0 (all interfaces)
      // so both 127.0.0.1 and ::1 (IPv6 localhost, used by Brave and some OS
      // configurations) reach the server.
      this.httpServer.listen(this.port, this.host, () => {
        const display = this.host === '0.0.0.0' ? 'localhost' : this.host;
        log.auth.info(`[ExtensionBridge] Listening on ws://${display}:${this.port}/`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }

      // Reject all in-flight requests
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('ExtensionBridge closed'));
      }
      this.pending.clear();

      // Force-terminate all connected WebSocket clients so wss.close() doesn't hang
      if (this.wss) {
        for (const client of this.wss.clients) {
          try { client.terminate(); } catch { /* ignore */ }
        }
      }
      if (this.socket) {
        try { this.socket.terminate(); } catch { /* ignore */ }
        this.socket = null;
      }

      if (this.wss) {
        this.wss.close(() => {
          this.httpServer?.close(() => resolve());
        });
      } else {
        this.httpServer?.close(() => resolve());
      }

      // Safety net: if graceful close hangs, resolve anyway after 1s
      setTimeout(resolve, 1000);
    });
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  getXsrfToken(): string | null {
    return this.xsrfToken;
  }

  /**
   * Resolves once the XSRF token has been captured by the extension.
   * Rejects after `timeoutMs` (default 30 s).
   */
  waitForToken(timeoutMs = 30_000): Promise<string> {
    if (this.xsrfToken) {
      return Promise.resolve(this.xsrfToken);
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.xsrfWaiters.indexOf(resolve);
        if (idx !== -1) this.xsrfWaiters.splice(idx, 1);
        reject(new Error(
          '[ExtensionBridge] Timed out waiting for XSRF token. ' +
          'Ensure the Chrome extension is installed and Google Chat is open.'
        ));
      }, timeoutMs);

      this.xsrfWaiters.push((token) => {
        clearTimeout(timer);
        resolve(token);
      });
    });
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  /**
   * Register a named command that the extension popup can trigger.
   * The handler receives optional args and should return a serialisable result.
   *
   * Example:
   *   bridge.registerCommandHandler('mark_all_read', async () => ({ marked: 5 }));
   */
  registerCommandHandler(name: string, handler: (args?: unknown) => Promise<unknown>): void {
    this.commandHandlers.set(name, handler);
  }

  // ─── Proxy ────────────────────────────────────────────────────────────────

  /**
   * Route an HTTP request through the extension's page context so that the
   * browser attaches session cookies automatically.
   *
   * `body` should be undefined, a string, or (for protobuf requests) a
   * base64-encoded string — the extension's interceptor.js decodes it.
   */
  async proxyRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string | Uint8Array,
    timeoutMs = 30_000
  ): Promise<ExtensionProxyResponse> {
    if (!this.isConnected()) {
      throw new Error(
        '[ExtensionBridge] Extension not connected. ' +
        'Install the Chrome extension and open Google Chat before using GCHAT_EXTENSION_AUTH=true.'
      );
    }

    // Encode binary bodies for JSON transport.
    // We send BOTH formats so the extension can use the faster bodyBytes path
    // (plain number array — no browser-side base64 decode) with bodyType+body
    // as a legacy fallback.
    let bodyStr: string | undefined;
    let bodyType = 'none';
    let bodyBytes: number[] | undefined;

    if (body instanceof Uint8Array) {
      bodyStr   = Buffer.from(body).toString('base64');
      bodyType  = 'base64';
      bodyBytes = Array.from(body);
    } else if (typeof body === 'string' && body.length > 0) {
      bodyStr  = body;
      bodyType = 'text';
    }

    const id = randomUUID();

    return new Promise<ExtensionProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[ExtensionBridge] Request timed out after ${timeoutMs} ms: ${method} ${url}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const msg: ApiRequestMsg = {
        type:     'api:request',
        id,
        url,
        method,
        headers,
        bodyType,
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        ...(bodyBytes !== undefined ? { bodyBytes } : {}),
      };

      this.send(msg);
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private send(msg: object): void {
    if (!this.isConnected()) {
      log.auth.warn('[ExtensionBridge] Cannot send — no extension connected');
      return;
    }
    this.socket!.send(JSON.stringify(msg));
  }

  private handleMessage(msg: InboundMsg): void {
    switch (msg.type) {
      case 'hello:ack': {
        const ack = msg as HelloAckMsg;
        log.auth.info(`[ExtensionBridge] hello:ack from "${ack.clientName ?? 'extension'}" (hasXsrf=${ack.hasXsrf})`);
        break;
      }

      case 'ping':
        // Extension keepalive alarm sends pings too — respond with pong
        this.isAlive = true;
        this.send({ type: 'pong' });
        break;

      case 'pong':
        this.isAlive = true;
        break;

      case 'xsrf:update': {
        const upd = msg as XsrfUpdateMsg;
        this.xsrfToken = upd.token;
        log.auth.info('[ExtensionBridge] XSRF token received');
        // Notify any waiters
        const waiters = this.xsrfWaiters.splice(0);
        for (const w of waiters) w(upd.token);
        break;
      }

      case 'api:response': {
        const resp = msg as ApiResponseMsg;
        const pending = this.pending.get(resp.id);
        if (!pending) {
          log.auth.warn('[ExtensionBridge] No pending request for id:', resp.id);
          break;
        }
        clearTimeout(pending.timer);
        this.pending.delete(resp.id);

        if (resp.error) {
          pending.reject(new Error(`[ExtensionBridge] Extension error: ${resp.error}`));
        } else {
          pending.resolve({ ok: resp.ok, status: resp.status, body: resp.body });
        }
        break;
      }

      case 'cmd': {
        const cmd = msg as CmdMsg;
        const handler = this.commandHandlers.get(cmd.name);
        if (!handler) {
          this.send({ type: 'cmd:response', id: cmd.id, success: false, error: `Unknown command: ${cmd.name}` } satisfies CmdResponseMsg);
          break;
        }
        handler(cmd.args)
          .then(data  => this.send({ type: 'cmd:response', id: cmd.id, success: true,  data  } satisfies CmdResponseMsg))
          .catch(err  => this.send({ type: 'cmd:response', id: cmd.id, success: false, error: (err as Error).message } satisfies CmdResponseMsg));
        break;
      }

      default:
        log.auth.warn('[ExtensionBridge] Unknown message type:', (msg as { type: string }).type);
    }
  }
}

// Singleton instance used by the client
let _bridge: ExtensionBridge | null = null;

export function getExtensionBridge(): ExtensionBridge {
  if (!_bridge) {
    const port = parseInt(process.env.GCHAT_EXTENSION_PORT ?? String(DEFAULT_EXTENSION_PORT), 10);
    const host = process.env.GCHAT_EXTENSION_HOST ?? DEFAULT_EXTENSION_HOST;
    _bridge = new ExtensionBridge(port, host);
  }
  return _bridge;
}

export async function startExtensionBridge(): Promise<ExtensionBridge> {
  const bridge = getExtensionBridge();
  await bridge.start();
  return bridge;
}
