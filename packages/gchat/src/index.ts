
export { GoogleChatClient } from './core/client.js';
export { ProxyBridge } from './core/proxy-bridge.js';
export * from './core/types.js';
export * as auth from './core/auth.js';
export {
  loadCachedAuth,
  saveCachedAuth,
  loadCachedCookies,
  saveCachedCookies,
  invalidateCache,
  extractSAPISID,
  generateSAPISIDHash,
  generatePeopleApiAuthHeader,
  formatCookieHeader,
} from './core/auth.js';
export * as logger from './core/logger.js';
export {
  createLogger,
  setLogLevel,
  getLogLevel,
  setLogColors,
  isLevelEnabled,
  log,
  type LogLevel,
} from './core/logger.js';
export * as unreads from './core/unreads.js';
export {
  UnreadNotificationService,
  createUnreadService,
} from './core/unreads.js';

export * as utils from './utils/index.js';

// Extension bridge — enables browser-based auth for SDK consumers
export {
  ExtensionBridge,
  startExtensionBridge,
  getExtensionBridge,
  DEFAULT_EXTENSION_PORT,
  type ExtensionProxyResponse,
} from './core/extension-bridge.js';

// Local state management (favorites, hidden spaces, last-viewed)
export * as favorites from './core/favorites.js';
export {
  getFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavoriteIds,
  getHidden,
  addHidden,
  removeHidden,
  isHidden,
  getHiddenIds,
  getLastViewed,
  setLastViewed,
  closeDb,
  type Favorite,
  type HiddenSpace,
  type LastViewed,
} from './core/favorites.js';

// High-level client factory (handles extension bridge + auth orchestration)
export {
  createClient,
  resolveCacheDir,
  DEFAULT_CACHE_DIR,
  type CreateClientOptions,
} from './app/client.js';
