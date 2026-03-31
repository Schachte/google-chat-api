import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { GoogleChatClient } from '../core/client.js';
import { ProxyBridge, DEFAULT_PROXY_URL } from '../core/proxy-bridge.js';
import { log } from '../core/logger.js';

export interface CreateClientOptions {
  cacheDir?: string;
  /** Auth mode: 'extension' (default) uses the dedicated Chrome extension bridge, 'proxy' uses CF Services Auth Proxy */
  authMode?: 'proxy' | 'extension';
}

export const DEFAULT_CACHE_DIR = process.env.GCHAT_CACHE_DIR || path.join(homedir(), '.gchat');

export function resolveCacheDir(options: { cacheDir?: string } = {}): string {
  const resolved = path.resolve(options.cacheDir || DEFAULT_CACHE_DIR);
  process.env.GCHAT_CACHE_DIR = resolved;
  return resolved;
}

export async function createClient(options: CreateClientOptions = {}): Promise<GoogleChatClient> {
  const cacheDir = resolveCacheDir(options);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
  }

  const authMode = options.authMode ?? (process.env.GCHAT_AUTH_MODE as 'proxy' | 'extension' | undefined) ?? 'extension';

  // ── Extension bridge mode (default) — dedicated Chrome extension on port 7891 ──
  if (authMode === 'extension') {
    try {
      const { startExtensionBridge } = await import('../core/extension-bridge.js');
      const bridge = await startExtensionBridge();

      const client = new GoogleChatClient({}, cacheDir, bridge);
      await client.authenticateWithExtension();

      bridge.registerCommandHandler('mark_all_read', async () => {
        const items = await client.listWorldItems();
        const unread = items.filter(i => i.unreadCount > 0 || i.unreadReplyCount > 0);
        let marked = 0;
        for (const item of unread) {
          try {
            await client.markAsRead(item.id);
            marked++;
          } catch {
            // skip individual failures — continue marking the rest
          }
        }
        return { marked, total: unread.length };
      });

      return client;
    } catch (err) {
      // Extension bridge failed (timeout, port conflict, no extension connected, etc.)
      // — fall through to proxy
      log.auth.info(`[createClient] Extension bridge failed (${(err as Error).message}), falling back to proxy...`);
    }
  }

  // ── Proxy fallback (or explicit proxy mode) — CF Services Auth Proxy ──────
  const proxyUrl = process.env.GCHAT_PROXY_URL ?? DEFAULT_PROXY_URL;
  const proxyBridge = new ProxyBridge(proxyUrl);

  const ready = await proxyBridge.isReady();
  if (ready) {
    log.auth.info(`[createClient] Using CF Services Auth Proxy at ${proxyUrl}`);
    const client = new GoogleChatClient({}, cacheDir, proxyBridge);
    await client.authenticateWithProxy();
    return client;
  }

  // ── Final fallback: if authMode was 'proxy' and proxy isn't ready, try extension bridge ──
  if (authMode === 'proxy') {
    log.auth.info('[createClient] Proxy not ready, falling back to extension bridge...');
  } else {
    // authMode was 'extension' but it failed, and proxy also isn't ready — last resort
    log.auth.info('[createClient] Proxy also not ready, retrying extension bridge as last resort...');
  }

  const { startExtensionBridge } = await import('../core/extension-bridge.js');
  const bridge = await startExtensionBridge();

  const client = new GoogleChatClient({}, cacheDir, bridge);
  await client.authenticateWithExtension();

  bridge.registerCommandHandler('mark_all_read', async () => {
    const items = await client.listWorldItems();
    const unread = items.filter(i => i.unreadCount > 0 || i.unreadReplyCount > 0);
    let marked = 0;
    for (const item of unread) {
      try {
        await client.markAsRead(item.id);
        marked++;
      } catch {
        // skip individual failures — continue marking the rest
      }
    }
    return { marked, total: unread.length };
  });

  return client;
}

