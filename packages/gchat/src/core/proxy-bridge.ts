/**
 * ProxyBridge — routes Google Chat API requests through the CF Services Auth
 * Proxy (localhost:7892/googlechat) instead of the dedicated Chrome extension
 * bridge.
 *
 * The proxy server handles:
 *   - Session cookies (via the browser extension's credentialed fetch)
 *   - XSRF token injection (auto-captured from chat.google.com)
 *
 * This bridge implements the same interface surface that GoogleChatClient
 * expects from ExtensionBridge, so it can be used as a drop-in replacement.
 */

import { log } from './logger.js';

export const DEFAULT_PROXY_URL = 'http://localhost:7892/googlechat';

export interface ProxyBridgeResponse {
  ok:      boolean;
  status:  number;
  body:    string;
  headers: Record<string, string>;
}

export class ProxyBridge {
  readonly isProxy = true as const;
  private readonly proxyUrl: string;
  private readonly baseUrl: string;  // e.g. http://localhost:7892

  constructor(proxyUrl: string = DEFAULT_PROXY_URL) {
    this.proxyUrl = proxyUrl;
    // Derive the base URL for health checks
    const u = new URL(proxyUrl);
    this.baseUrl = `${u.protocol}//${u.host}`;
  }

  // ─── Lifecycle (no-ops — the proxy server runs independently) ────────────

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  // ─── Status ──────────────────────────────────────────────────────────────

  async isReady(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return false;
      const health = await resp.json() as { extensionConnected?: boolean; googleChatXsrfToken?: boolean };
      return !!(health.extensionConnected && health.googleChatXsrfToken);
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    // Synchronous — can't check the proxy. Return true optimistically;
    // proxyRequest will fail with a clear error if the proxy is down.
    return true;
  }

  getXsrfToken(): string | null {
    // The proxy manages the XSRF token — we never see the real one.
    return 'proxy-managed';
  }

  /**
   * Wait until the proxy is healthy and the XSRF token is captured.
   * Polls the /health endpoint every 2s.
   */
  async waitForToken(timeoutMs = 30_000): Promise<string> {
    const start = Date.now();
    const pollMs = 2000;

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const health = await resp.json() as { extensionConnected?: boolean; googleChatXsrfToken?: boolean };
          if (!health.extensionConnected) {
            log.auth.info('[ProxyBridge] Waiting for browser extension to connect to proxy...');
          } else if (!health.googleChatXsrfToken) {
            log.auth.info('[ProxyBridge] Waiting for XSRF token (open chat.google.com in Brave)...');
          } else {
            log.auth.info('[ProxyBridge] Proxy ready — extension connected, XSRF token captured');
            return 'proxy-managed';
          }
        }
      } catch {
        log.auth.info('[ProxyBridge] Waiting for proxy server at ' + this.baseUrl + '...');
      }
      await new Promise(r => setTimeout(r, pollMs));
    }

    throw new Error(
      `[ProxyBridge] Timed out after ${timeoutMs / 1000}s waiting for proxy. ` +
      `Ensure the CF Services Auth Proxy is running (${this.baseUrl}/health) ` +
      `and chat.google.com is open in Brave.`
    );
  }

  // ─── Commands (no-op — commands are an extension popup feature) ──────────

  registerCommandHandler(_name: string, _handler: (args?: unknown) => Promise<unknown>): void {
    // Commands are not supported via the proxy
  }

  // ─── Proxy ───────────────────────────────────────────────────────────────

  /**
   * Route an HTTP request through the CF Services Auth Proxy.
   *
   * The proxy server auto-injects the XSRF token and the browser extension
   * attaches session cookies via credentialed fetch.
   */
  async proxyRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string | Uint8Array,
    timeoutMs = 30_000,
  ): Promise<ProxyBridgeResponse> {
    // Strip XSRF token from headers — the proxy injects the real one
    const cleanHeaders = { ...headers };
    delete cleanHeaders['x-framework-xsrf-token'];

    // Encode binary bodies as base64
    let bodyStr: string | undefined;
    let bodyEncoding: string | undefined;

    if (body instanceof Uint8Array) {
      // Convert Uint8Array to base64 string
      bodyStr = btoa(String.fromCharCode(...body));
      bodyEncoding = 'base64';
    } else if (typeof body === 'string' && body.length > 0) {
      bodyStr = body;
    }

    const proxyPayload: Record<string, unknown> = {
      url,
      method,
      headers: cleanHeaders,
    };
    if (bodyStr !== undefined) proxyPayload.body = bodyStr;
    if (bodyEncoding) proxyPayload.bodyEncoding = bodyEncoding;

    const resp = await fetch(this.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyPayload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const respBody = await resp.text();

    // The proxy returns the upstream response directly (status + body).
    // A non-2xx from the proxy itself (503 extension disconnected, 504 timeout)
    // should be surfaced as errors.
    if (!resp.ok && resp.status >= 500) {
      let errorMsg = `Proxy error ${resp.status}`;
      try {
        const errData = JSON.parse(respBody) as { error?: string };
        if (errData.error) errorMsg = errData.error;
      } catch {}
      throw new Error(`[ProxyBridge] ${errorMsg}`);
    }

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((value, key) => { respHeaders[key] = value; });

    return {
      ok: resp.ok,
      status: resp.status,
      body: respBody,
      headers: respHeaders,
    };
  }
}
