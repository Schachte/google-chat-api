import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { GoogleChatClient } from '../core/client.js';

export interface CreateClientOptions {
  cacheDir?: string;
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

