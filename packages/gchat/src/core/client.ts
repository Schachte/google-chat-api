import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  authenticateWithCookies,
  buildCookieString,
  loadAuthCache,
  saveAuthCache,
  fetchXsrfToken,
  type Cookies,
  type AuthResult,
} from './auth.js';
import { type ExtensionBridge } from './extension-bridge.js';
import { type ProxyBridge } from './proxy-bridge.js';
import {
  AnnotationType,
  PresenceStatus,
  DndStateStatus,
  type Space,
  type SpacesResult,
  type Message,
  type Topic,
  type ThreadsResult,
  type ThreadResult,
  type AllMessagesResult,
  type ServerTopicsResult,
  type SearchMatch,
  type WorldItemSummary,
  type Annotation,
  type UserMention,
  type SendMessageResult,
  type SelfUser,
  type UserPresence,
  type UserPresenceResult,
  type UserPresenceWithProfile,
  type UserPresenceWithProfileResult,
  type CustomStatus,
  type ImageMetadata,
  type AttachmentMetadata,
  type UrlMetadata,
  type MarkGroupReadstateResult,
  type SearchSpaceResult,
  type SearchMember,
  type SearchUserInfo,
  type SearchPagination,
  type SearchResponse,
  type SearchOptions,
  type Card,
  type CardSection,
  type CardWidget,
  type CardButton,
  type NotificationOptions,
  type NotificationResult,
  type RefreshUnreadsResult,
  type MarkAllAsReadResult,
  type AttachmentBinaryResult,
  type DMPresenceEntry,
  type DMPresenceResult,
} from './types.js';
import { log } from './logger.js';
import {
  encodePaginatedWorldRequest,
  encodeListTopicsRequest,
  encodeListMessagesRequest,
  encodeGetMembersRequest,
  encodeGetSelfUserStatusRequest,
  encodeCreateTopicRequest,
  encodeCreateMessageRequest,
  type UploadAnnotationOptions,
  encodeGetUserPresenceRequest,
  encodeMarkGroupReadstateRequest,
  encodeGetGroupRequest,
  encodeCatchUpUserRequest,
  encodeCatchUpGroupRequest,
  encodeSetFocusRequest,
  encodeSetActiveClientRequest,
  encodeSetPresenceSharedRequest,
  isDmId,
  Presence,
  DndState,
} from './proto.js';

const API_BASE = 'https://chat.google.com/u/0';
const API_KEY = 'AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k';
const XSSI_PREFIX = ")]}'\n";
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

export class GoogleChatClient {
  private cookies: Cookies;
  private auth: AuthResult | null = null;
  private cacheDir: string;
  private selfUserId?: string;
  private _debugLoggedCreator = false;
  /** When set, all HTTP requests are proxied through the Chrome extension or CF Services Auth Proxy. */
  private bridge: ExtensionBridge | ProxyBridge | null = null;

  /**
   * Cache of recently-marked thread IDs.  After mark_topic_readstate succeeds
   * the thread IS read on Google's servers, but paginated_world's readState[20]
   * boolean can lag behind.  We suppress the stale indicator here for up to
   * MARK_CACHE_TTL_MS after a successful mark.
   */
  private markedThreads = new Map<string, number>(); // key: "spaceId/topicId", value: Date.now()
  private static readonly MARK_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  constructor(cookies: Cookies, cacheDir = '.', bridge: ExtensionBridge | ProxyBridge | null = null) {
    this.cookies = cookies;
    this.cacheDir = cacheDir;
    this.bridge   = bridge;
  }

  async authenticate(forceRefresh = false): Promise<void> {
    this.auth = await authenticateWithCookies({
      cookies: this.cookies,
      forceRefresh,
      cacheDir: this.cacheDir,
    });
  }

  /**
   * Authenticate using the Chrome extension bridge.
   * Waits for the extension to send its captured XSRF token.
   */
  async authenticateWithExtension(tokenTimeoutMs = 30_000): Promise<void> {
    if (!this.bridge) {
      throw new Error(
        'authenticateWithExtension() called but no ExtensionBridge was provided to GoogleChatClient.'
      );
    }
    const { authenticateWithExtension } = await import('./auth.js');
    this.auth = await authenticateWithExtension({ tokenTimeoutMs });
  }

  /**
   * Authenticate via the CF Services Auth Proxy.
   * The proxy handles cookies and XSRF token injection — we just verify
   * the proxy is healthy and the XSRF token has been captured.
   */
  async authenticateWithProxy(tokenTimeoutMs = 30_000): Promise<void> {
    if (!this.bridge || !('isProxy' in this.bridge)) {
      throw new Error(
        'authenticateWithProxy() called but no ProxyBridge was provided to GoogleChatClient.'
      );
    }
    const proxyBridge = this.bridge as import('./proxy-bridge.js').ProxyBridge;
    await proxyBridge.waitForToken(tokenTimeoutMs);
    // Set a minimal auth result — the proxy handles the real XSRF token
    this.auth = {
      cookies: {},
      xsrfToken: 'proxy-managed',
      cookieString: '',
    };
  }

  /**
   * Ensure the client is authenticated, using the correct strategy
   * depending on whether a browser extension bridge is present.
   */
  private async ensureAuth(forceRefresh = false): Promise<void> {
    if (this.auth && !forceRefresh) return;
    if (this.bridge && 'isProxy' in this.bridge) {
      await this.authenticateWithProxy();
    } else if (this.bridge) {
      await this.authenticateWithExtension();
    } else {
      await this.authenticate(forceRefresh);
    }
  }

  getCookieString(): string {
    if (!this.auth) {
      throw new Error('Client not authenticated. Call authenticate() first.');
    }
    return this.auth.cookieString;
  }

  private parseXssiJson<T>(rawText: string): T {
    let text = rawText;
    if (text.startsWith(XSSI_PREFIX)) {
      text = text.slice(XSSI_PREFIX.length);
    } else if (text.startsWith(")]}'")) {
      text = text.slice(4);
    }
    return JSON.parse(text.trim()) as T;
  }

  private async fetchWithAuthRetry(doFetch: () => Promise<Response>): Promise<Response> {
    let response = await doFetch();

    if (!response.ok && (response.status === 401 || response.status === 403)) {
      try {
        await this.ensureAuth(true);
      } catch {
      }
      response = await doFetch();
    }

    return response;
  }

  private async rawRequest(
    endpoint: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
    await this.ensureAuth();

    if (this.bridge) {
      const headers: Record<string, string> = {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json+protobuf',
        'X-Goog-Encode-Response-If-Executable': 'base64',
        'x-framework-xsrf-token': this.auth!.xsrfToken,
        ...extraHeaders,
      };
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const result  = await this.bridge.proxyRequest(url, method, headers, bodyStr);
      return new Response(result.body, { status: result.status });
    }

    return this.fetchWithAuthRetry(() => {
      const headers: Record<string, string> = {
        'Cookie': this.auth!.cookieString,
        'Origin': API_BASE,
        'Referer': `${API_BASE}/`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json+protobuf',
        'X-Goog-Encode-Response-If-Executable': 'base64',
        ...extraHeaders,
      };

      return fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    });
  }

  async proxyFetch(url: string): Promise<Response> {
    await this.ensureAuth();

    if (this.bridge) {
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
      const result = await this.bridge.proxyRequest(url, 'GET', headers);
      return new Response(result.body, { status: result.status });
    }

    const headers: Record<string, string> = {
      'Cookie': this.auth!.cookieString,
      'User-Agent': USER_AGENT,
    };

    return fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
  }

  async getAttachmentUrl(attachmentToken: string): Promise<string | null> {
    await this.ensureAuth();

    log.client.debug('getAttachmentUrl: Attempting to resolve token:', attachmentToken.slice(0, 50) + '...');

    if (attachmentToken.startsWith('http')) {
      log.client.debug('getAttachmentUrl: Token is already a URL');
      return attachmentToken;
    }

    try {
      const directDownloadUrl = `${API_BASE}/api/get_attachment_url?url_type=FIFE_URL&attachment_token=${encodeURIComponent(attachmentToken)}&sz=w512`;
      log.client.debug('getAttachmentUrl: Trying direct download URL:', directDownloadUrl);

      const directResponse = this.bridge
        ? await this.bridge.proxyRequest(directDownloadUrl, 'GET', {
            'User-Agent': USER_AGENT,
            'Accept': '*/*',
          }).then(r => new Response(r.body, { status: r.status }))
        : await fetch(directDownloadUrl, {
            method: 'GET',
            headers: {
              'Cookie': this.auth!.cookieString,
              'User-Agent': USER_AGENT,
              'Accept': '*/*',
            },
            redirect: 'manual',
          });

      log.client.debug('getAttachmentUrl: Direct response status:', directResponse.status);

      if (directResponse.status === 302 || directResponse.status === 301) {
        const location = directResponse.headers.get('Location');
        if (location) {
          log.client.debug('getAttachmentUrl: Got redirect to:', location.slice(0, 80) + '...');
          return location;
        }
      }

      if (directResponse.ok) {
        const text = await directResponse.text();
        log.client.debug('getAttachmentUrl: Direct response (first 500 chars):', text.slice(0, 500));

        const jsonStr = text.startsWith(")]}'") ? text.slice(4).trim() : text;
        try {
          const data = JSON.parse(jsonStr);
          if (typeof data === 'string' && data.startsWith('http')) return data;
          if (Array.isArray(data) && typeof data[0] === 'string' && data[0].startsWith('http')) return data[0];
          if (data && typeof data['1'] === 'string' && data['1'].startsWith('http')) return data['1'];
          const urlMatch = JSON.stringify(data).match(/"(https?:\/\/[^"]+)"/);
          if (urlMatch) {
            log.client.debug('getAttachmentUrl: Found URL in JSON response');
            return urlMatch[1];
          }
        } catch {
          if (text.startsWith('http')) return text.trim();
        }
      }

      log.client.debug('getAttachmentUrl: Trying POST approach...');
      const postUrl = `${API_BASE}/api/get_attachment_url?alt=json&key=${API_KEY}`;
      const postResponse = this.bridge
        ? await this.bridge.proxyRequest(postUrl, 'POST', {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json+protobuf',
            'Accept': 'application/json',
          }, JSON.stringify([attachmentToken])).then(r => new Response(r.body, { status: r.status }))
        : await fetch(postUrl, {
            method: 'POST',
            headers: {
              'Cookie': this.auth!.cookieString,
              'User-Agent': USER_AGENT,
              'Content-Type': 'application/json+protobuf',
              'Accept': 'application/json',
            },
            body: JSON.stringify([attachmentToken]),
          });

      log.client.debug('getAttachmentUrl: POST response status:', postResponse.status);

      if (postResponse.ok) {
        const text = await postResponse.text();
        log.client.debug('getAttachmentUrl: POST response (first 500 chars):', text.slice(0, 500));

        const jsonStr = text.startsWith(")]}'") ? text.slice(4).trim() : text;
        try {
          const data = JSON.parse(jsonStr);
          const urlMatch = JSON.stringify(data).match(/"(https?:\/\/[^"]+)"/);
          if (urlMatch) return urlMatch[1];
        } catch {
          if (text.startsWith('http')) return text.trim();
        }
      }

      log.client.debug('getAttachmentUrl: Could not resolve token:', attachmentToken.slice(0, 50) + '...');
      return null;
    } catch (err) {
      log.client.error('getAttachmentUrl: Error:', (err as Error).message);
      return null;
    }
  }

  private async apiRequest<T = unknown>(endpoint: string, protoData: Uint8Array): Promise<T> {
    return this.apiRequestWithChannel<T>(endpoint, protoData);
  }

  /**
   * Make an API request with an optional `?c=` channel parameter.
   * Google Chat's paginated_world uses different channel IDs to return
   * different sections of the world data.
   */
  private async apiRequestWithChannel<T = unknown>(
    endpoint: string,
    protoData: Uint8Array,
    channelId?: number,
  ): Promise<T> {
    await this.ensureAuth();

    const url = new URL(`${API_BASE}/api/${endpoint}`);
    url.searchParams.set('alt', 'protojson');
    url.searchParams.set('key', API_KEY);
    if (channelId !== undefined) {
      url.searchParams.set('c', String(channelId));
    }

    let response: Response;

    if (this.bridge) {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-protobuf',
        'Connection': 'Keep-Alive',
        'x-framework-xsrf-token': this.auth!.xsrfToken,
      };
      // ProxyBridge: send protobuf as base64-encoded body with bodyEncoding hint.
      // ExtensionBridge: sends Uint8Array directly (it handles base64 internally).
      const result = await this.bridge.proxyRequest(url.toString(), 'POST', headers, protoData);
      response = new Response(result.body, { status: result.status });
    } else {
      response = await this.fetchWithAuthRetry(() => fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Cookie': this.auth!.cookieString,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-protobuf',
          'Connection': 'Keep-Alive',
          'x-framework-xsrf-token': this.auth!.xsrfToken,
        },
        body: protoData,
      }));
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text.slice(0, 200)}`);
    }

    const responseText = await response.text();
    if (endpoint === 'paginated_world') {
      log.client.debug(`apiRequest(${endpoint}${channelId !== undefined ? `?c=${channelId}` : ''}): status=${response.status}, bodyLen=${responseText.length}`);
    }
    return this.parseXssiJson<T>(responseText);
  }

  private requestCounter = 1;

  private async apiRequestJson<T = unknown>(
    endpoint: string, 
    payload: unknown[], 
    spaceId?: string
  ): Promise<T> {
    await this.ensureAuth();

    const url = new URL(`${API_BASE}/api/${endpoint}`);
    url.searchParams.set('c', String(this.requestCounter++));

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'x-framework-xsrf-token': this.auth!.xsrfToken,
      'Origin': 'https://chat.google.com',
      'Referer': 'https://chat.google.com/',
      ...(spaceId ? { 'x-goog-chat-space-id': spaceId } : {}),
    };

    let response: Response;

    if (this.bridge) {
      const result = await this.bridge.proxyRequest(
        url.toString(), 'POST', headers, JSON.stringify(payload)
      );
      response = new Response(result.body, { status: result.status });
    } else {
      response = await this.fetchWithAuthRetry(() => fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Cookie': this.auth!.cookieString,
          ...headers,
        },
        body: JSON.stringify(payload),
      }));
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text.slice(0, 200)}`);
    }

    return this.parseXssiJson<T>(await response.text());
  }

  private buildPbliteRequestHeader(): unknown[] {
    return ["0", 7, 1, "en", [
      null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null,
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null,
      null, 2, 2, null, null, null, null, 2, 2, 2, 2, null, 2, null, null, 2,
      null, 2, 2, 2, 2, null, 2
    ]];
  }

  private buildMutationRequestHeader(): unknown[] {
    return [0, 3, 1, 'en', [
      null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null,
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null,
      null, 2, 2, null, null, null, null, 2, 2, 2, 2, null, 2, null, null, 2,
      null, 2, 2, 2, 2, null, 2, null, null, null, null, null, null, 2, 2,
    ]];
  }

  /**
   * Build a PBLite JSON payload for the paginated_world API.
   * Matches the exact format Google Chat uses (Content-Type: application/json).
   * Derived from captured browser requests.
   */
  private buildPaginatedWorldPayload(pageSize = 200): unknown[] {
    const caps = [
      null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null,
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null,
      null, 2, 2, null, null, null, null, 2, 2, 2, 2, null, 2, null, null, 2,
      null, 2, 2, 2, 2, null, 2, null, null, null, null, null, null, 2, 2,
    ];
    const header = [0, 3, 1, "en", caps];

    // Section request templates — each requests a different "view" of the world.
    // Structure: [pageSize, null, null, [filter...], ...flags...]
    // These patterns are extracted from Google Chat's actual requests.
    const s = (ps: number, filter: unknown[], ...rest: unknown[]) =>
      [ps, null, null, filter, ...rest];

    const sectionRequests: unknown[] = [
      // Starred rooms (with snippet fetch)
      s(pageSize, [null,null,null,null,null,null,null,null,null,null,null,1,null,null,null,[[3]]],
        null,null,null,null, [null,[[1]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
      // Non-starred rooms (with snippet fetch)
      s(pageSize, [null,null,null,null,null,null,4,null,null,null,null,1,null,null,[[5]],[[3]]],
        null,null,null,null, [1,[[1],[2]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
      // Starred DM people
      s(pageSize, [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1],
        null,null,null,null, [null,[[1]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
      // Non-starred DM people
      s(pageSize, [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1],
        null,null,null,null, [1,[[1],[2]],null,1], [[1,1],[1]], [1], null,null,null, [1]),
      // Starred DM bots
      s(pageSize, [1], null,null,null,null, null,null, [3], null, 1),
      // All DMs (various notification filter combos — covers unread/read/mentioned)
      s(pageSize, [2,null,null,null,null,null,null,null,null,null,null,1], null,null,null,null, null,null, [5], null, 1),
      s(pageSize, [2,null,null,null,null,null,null,null,null,null,null,2], null,null,null,null, null,null, [5], null, 1),
      s(pageSize, [2,null,null,null,null,null,2,null,null,null,null,2], null,null,null,null, null,null, [5], null, 1),
      s(pageSize, [2,null,null,null,null,null,2,null,null,null,null,1], null,null,null,null, null,null, [5], null, 1),
      // Rooms with notification combos (follows+mentions, @mentions only, etc.)
      s(pageSize, [1,1,2,null,null,2,null,null,1,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
      s(pageSize, [1,1,2,null,null,2,2,null,1,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
      s(pageSize, [1,1,2,null,2,1,null,null,null,null,null,null,null,null,[[8]],[[4]]], null,null,null,null, null,null, [3]),
      s(pageSize, [1,1,2,null,2,1,2,null,null,null,null,null,null,null,[[8]],[[4]]], null,null,null,null, null,null, [3]),
      s(pageSize, [1,1,2,null,1,null,null,2,2,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
      s(pageSize, [1,1,2,null,1,null,2,2,2,null,null,null,null,null,null,[[4],[8]]], null,null,null,null, null,null, [3]),
      // Non-starred spaces with notification combos
      s(pageSize, [2,1,2,null,null,2,null,null,1,null,null,2,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,null,2,null,null,1,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,null,2,2,null,1,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,1,null,null,2,2,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,1,null,null,2,2,null,null,2,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,1,null,2,2,2,null,null,1,null,null,null,[[4],[8]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,2,1,null,null,null,null,null,2,null,null,[[8]],[[4]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,2,1,null,null,null,null,null,1,null,null,[[8]],[[4]]], null,null,null,null, null,null, [5]),
      s(pageSize, [2,1,2,null,2,1,2,null,null,null,null,1,null,null,[[8]],[[4]]], null,null,null,null, null,null, [5]),
      // Invite/presence sections
      s(1, [null,null,null,null,null,2,null,null,null,null,[1]], null,null, 2),
      s(1, [null,null,null,null,null,2,null,null,null,null,[2]], null,null, 2),
    ];

    return [
      header,
      sectionRequests,
      null,                  // world_consistency_token
      [4, 2, 5, 6, 7, 3],  // fetch_options
      null, null, null, null,
      1,                     // fetchFromUserSpaces
      null,
      1,                     // fetchSnippetsForUnnamedRooms
    ];
  }

  private buildListTopicsPayload(
    groupId: string,
    options: {
      pageSize?: number;
      topicsPerPage?: number;
      sortTimeCursor?: string;      
      timestampCursor?: string;     
      anchorTimestamp?: string;     
      isDm?: boolean;               
    } = {}
  ): unknown[] {
    const {
      pageSize = 1000,
      topicsPerPage = 30,
      sortTimeCursor,
      timestampCursor,
      anchorTimestamp,
      isDm,
    } = options;

    const isDirectMessage = isDm ?? isDmId(groupId);

    const payload: unknown[] = new Array(91).fill(null);
    payload[1] = 30; 
    payload[3] = sortTimeCursor ? [sortTimeCursor] : null;
    payload[4] = isDirectMessage ? [3, 4] : [3, 1, 4];
    payload[5] = pageSize;
    payload[6] = topicsPerPage;
    payload[7] = isDirectMessage ? [null, null, [groupId]] : [[groupId]];
    payload[8] = timestampCursor ? [timestampCursor] : null;
    payload[9] = anchorTimestamp ? [anchorTimestamp] : null;
    payload[10] = 2;
    payload[90] = this.buildPbliteRequestHeader();

    return payload;
  }

  private parseListTopicsResponse(data: unknown[]): {
    topics: unknown[];
    nextTimestampCursor: string | null;
    anchorTimestamp: string | null;
    containsFirstTopic: boolean;
    containsLastTopic: boolean;
  } {
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      return { 
        topics: [], 
        nextTimestampCursor: null, 
        anchorTimestamp: null, 
        containsFirstTopic: false,
        containsLastTopic: false
      };
    }

    const topics = Array.isArray(data[0][1]) ? data[0][1] : [];
    const nextTimestampCursor = data[0][2]?.[0] || null;
    const anchorTimestamp = data[0][3]?.[0] || null;
    const containsFirstTopic = data[0][4] === true;
    const containsLastTopic = data[0][5] === true;

    return { 
      topics, 
      nextTimestampCursor, 
      anchorTimestamp, 
      containsFirstTopic,
      containsLastTopic
    };
  }

  private getTopicSortTime(topic: unknown[]): string | null {
    const sortTime = topic?.[1];
    return typeof sortTime === 'string' ? sortTime : null;
  }

  private getPbliteField<T>(payload: unknown, fieldNumber: number): T | undefined {
    if (!Array.isArray(payload)) {
      return undefined;
    }

    const offset = typeof payload[0] === 'string' && payload.length > 1 ? 1 : 0;
    return payload[fieldNumber - 1 + offset] as T | undefined;
  }

  private getNestedPbliteString(
    payload: unknown,
    fieldNumber: number,
    innerFieldNumber: number
  ): string | undefined {
    const nested = this.getPbliteField<unknown[]>(payload, fieldNumber);
    return this.getPbliteField<string>(nested, innerFieldNumber);
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Like `toNumber` but returns `undefined` when the input is absent
   * (null, undefined, or empty string) instead of collapsing to 0.
   * This preserves the distinction between "server said 0" and
   * "field was missing from the response", which matters for badge
   * counts and read-watermark timestamps.
   */
  private toOptionalNumber(value: unknown): number | undefined {
    if (value == null) return undefined;
    if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
    if (typeof value === 'string') {
      if (value.length === 0) return undefined;
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  private parseAnnotations(arr: unknown[]): Annotation[] {
    if (!Array.isArray(arr)) return [];

    return arr
      .map((ann): Annotation | null => {
        if (!Array.isArray(ann)) return null;

        const type = (ann[0] as number) || 0;
        const annotation: Annotation = {
          type,
          start_index: (ann[1] as number) || 0,
          length: (ann[2] as number) || 0,
        };

        if (type === AnnotationType.USER_MENTION && Array.isArray(ann[4])) {
          const mentionData = ann[4];
          let userId = '';
          if (Array.isArray(mentionData[0]) && Array.isArray(mentionData[0][0])) {
            userId = (mentionData[0][0][0] as string) || '';
          } else if (Array.isArray(mentionData[0])) {
            userId = (mentionData[0][0] as string) || '';
          }

          const mentionTypeNum = (mentionData[2] as number) || 0;
          const mentionTypes: Array<'user' | 'bot' | 'all'> = ['user', 'bot', 'all'];

          annotation.user_mention = {
            user_id: userId,
            display_name: (mentionData[3] as string) || undefined,
            mention_type: mentionTypes[mentionTypeNum] || 'user',
          };
        }

        if (type === AnnotationType.USER_MENTION_V2 && Array.isArray(ann[4])) {
          const mentionData = ann[4];
          let userId = '';
          let displayName: string | undefined;

          if (Array.isArray(mentionData[0]) && typeof mentionData[0][0] === 'string') {
            userId = mentionData[0][0];
          }

          if (Array.isArray(mentionData[2]) && typeof mentionData[2][1] === 'string') {
            displayName = mentionData[2][1];
          }

          const mentionTypeNum = (mentionData[1] as number) || 0;
          const mentionType: 'user' | 'bot' | 'all' = mentionTypeNum === 3 ? 'user' : 'user';

          annotation.user_mention = {
            user_id: userId,
            display_name: displayName,
            mention_type: mentionType,
          };
        }

        if (type === AnnotationType.DRIVE && Array.isArray(ann[8])) {
          const driveData = ann[8];
          const driveId = typeof driveData[0] === 'string' ? driveData[0] : undefined;
          const title = typeof driveData[1] === 'string' ? driveData[1] : undefined;
          const thumbnailUrl = typeof driveData[2] === 'string' ? driveData[2] : undefined;
          const mimeType = typeof driveData[5] === 'string' ? driveData[5] : undefined;
          const embedUrl = typeof driveData[10] === 'string' ? driveData[10] : undefined;

          const downloadUrl = driveId ? `https://drive.google.com/uc?export=download&id=${driveId}` : embedUrl;

          annotation.attachment_metadata = {
            attachment_id: driveId,
            content_name: title,
            content_type: mimeType,
            download_url: downloadUrl,
            thumbnail_url: thumbnailUrl,
          };
        }

        if (type === AnnotationType.URL && Array.isArray(ann[6])) {
          const urlData = ann[6];
          let actualUrl = '';
          if (typeof urlData[0] === 'string') {
            actualUrl = urlData[0];
          } else if (Array.isArray(urlData[5]) && typeof urlData[5][0] === 'string') {
            actualUrl = urlData[5][0];
          }

          let imageUrl: string | undefined;
          if (typeof urlData[2] === 'string' && urlData[2].startsWith('http')) {
            imageUrl = urlData[2];
          }

          let mimeType: string | undefined;
          if (typeof urlData[13] === 'string') {
            mimeType = urlData[13];
          }

          annotation.url_metadata = {
            url: actualUrl,
            title: typeof urlData[0] === 'string' ? urlData[0] : (typeof urlData[1] === 'string' ? urlData[1] : undefined),
            image_url: imageUrl,
            mime_type: mimeType,
          };
        }

        if (type === AnnotationType.FORMAT && Array.isArray(ann[7])) {
          const formatData = ann[7];
          const formatTypes: Array<'bold' | 'italic' | 'strikethrough' | 'monospace'> = [
            'bold',
            'italic',
            'strikethrough',
            'monospace',
          ];
          const formatTypeNum = (formatData[0] as number) || 0;
          annotation.format_metadata = {
            format_type: formatTypes[formatTypeNum] || 'bold',
          };
        }

        if (type === AnnotationType.IMAGE && Array.isArray(ann[8])) {
          const imageData = ann[8];
          annotation.image_metadata = {
            image_url: (imageData[0] as string) || '',
            width: typeof imageData[1] === 'number' ? imageData[1] : undefined,
            height: typeof imageData[2] === 'number' ? imageData[2] : undefined,
            alt_text: typeof imageData[3] === 'string' ? imageData[3] : undefined,
            content_type: typeof imageData[4] === 'string' ? imageData[4] : undefined,
          };
        }

        const uploadData = ann[10] || ann[9];
        if ((type === AnnotationType.UPLOAD || type === AnnotationType.UPLOAD_METADATA) && Array.isArray(uploadData)) {
          log.client.debug('parseAnnotations: UPLOAD annotation raw data:', JSON.stringify(uploadData, null, 2));

          const attachmentToken = typeof uploadData[0] === 'string' ? uploadData[0] : undefined;
          const contentName = typeof uploadData[2] === 'string' ? uploadData[2] :
                              typeof uploadData[1] === 'string' ? uploadData[1] : undefined;
          const contentType = typeof uploadData[3] === 'string' ? uploadData[3] :
                              typeof uploadData[2] === 'string' ? uploadData[2] : undefined;

          let downloadUrl: string | undefined;
          let thumbnailUrl: string | undefined;

          const findUrls = (data: unknown, depth = 0): void => {
            if (depth > 5) return;
            if (Array.isArray(data)) {
              for (const item of data) {
                findUrls(item, depth + 1);
              }
            } else if (typeof data === 'string' && data.startsWith('http')) {
              if (!downloadUrl) downloadUrl = data;
              else if (!thumbnailUrl) thumbnailUrl = data;
            }
          };
          findUrls(uploadData);

          annotation.attachment_metadata = {
            attachment_id: attachmentToken,
            content_name: contentName,
            content_type: contentType,
            download_url: downloadUrl,
            thumbnail_url: thumbnailUrl,
          };

          log.client.debug('parseAnnotations: UPLOAD parsed:', {
            token: attachmentToken?.slice(0, 30) + '...',
            name: contentName,
            type: contentType,
            hasDownloadUrl: !!downloadUrl,
            hasThumbnailUrl: !!thumbnailUrl,
          });
        }

        return annotation;
      })
      .filter((a): a is Annotation => a !== null);
  }

  private extractMentions(annotations: Annotation[]): UserMention[] {
    return annotations
      .filter((a) => (a.type === AnnotationType.USER_MENTION || a.type === AnnotationType.USER_MENTION_V2) && a.user_mention)
      .map((a) => a.user_mention!);
  }

  private extractImages(annotations: Annotation[]): ImageMetadata[] {
    return annotations
      .filter((a) => a.type === AnnotationType.IMAGE && a.image_metadata)
      .map((a) => a.image_metadata!);
  }

  private extractAttachments(annotations: Annotation[]): AttachmentMetadata[] {
    return annotations
      .filter((a) => (a.type === AnnotationType.UPLOAD || a.type === AnnotationType.UPLOAD_METADATA || a.type === AnnotationType.DRIVE) && a.attachment_metadata)
      .map((a) => a.attachment_metadata!);
  }

  private extractUrls(annotations: Annotation[]): UrlMetadata[] {
    return annotations
      .filter((a) => a.type === AnnotationType.URL && a.url_metadata)
      .map((a) => a.url_metadata!);
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').trim();
  }

  private parseCardButton(btn: unknown[]): CardButton | null {
    if (!Array.isArray(btn) || !Array.isArray(btn[0])) return null;
    const inner = btn[0] as unknown[];

    let text = '';
    if (Array.isArray(inner[0])) {
      const textArr = inner[0] as unknown[];
      if (Array.isArray(textArr[0]) && typeof textArr[0][0] === 'string') {
        text = textArr[0][0];
      } else if (typeof textArr[0] === 'string') {
        text = textArr[0];
      }
    }

    let url: string | undefined;
    if (Array.isArray(inner[1]) && Array.isArray(inner[1][4])) {
      const urlArr = inner[1][4] as unknown[];
      if (typeof urlArr[4] === 'string') {
        url = urlArr[4];
      } else if (typeof urlArr[0] === 'string') {
        url = urlArr[0];
      }
    }

    const tooltip = typeof inner[7] === 'string' ? inner[7] : undefined;

    const icon_url = typeof inner[8] === 'string' ? inner[8] : undefined;

    let icon_name: string | undefined;
    if (Array.isArray(inner[9]) && typeof inner[9][0] === 'string') {
      icon_name = inner[9][0];
    }

    if (!text && !url) return null;
    return { text, url, tooltip, icon_name, icon_url };
  }

  private parseCardWidget(widget: unknown[]): CardWidget | null {
    if (!Array.isArray(widget)) return null;

    if (widget[12] != null && Array.isArray(widget[12])) {
      const dt = widget[12] as unknown[];
      const icon_url = typeof dt[0] === 'string' ? dt[0] : undefined;

      let html: string | undefined;
      let text: string | undefined;
      if (Array.isArray(dt[2])) {
        const textField = dt[2] as unknown[];
        if (typeof textField[0] === 'string') {
          html = textField[0];
          text = this.stripHtml(html);
        }
      }

      let icon_name: string | undefined;
      if (Array.isArray(dt[10]) && Array.isArray(dt[10][3]) && typeof dt[10][3][0] === 'string') {
        icon_name = dt[10][3][0];
      }

      return {
        type: 'decorated_text',
        icon_name,
        icon_url,
        html,
        text,
      };
    }

    if (widget[2] != null && Array.isArray(widget[2])) {
      const tp = widget[2] as unknown[];
      if (tp.length === 0) return null;
      let html: string | undefined;
      let text: string | undefined;
      if (Array.isArray(tp[0])) {
        const inner = tp[0] as unknown[];
        if (typeof inner[0] === 'string') {
          html = inner[0];
          text = this.stripHtml(html);
        }
      } else if (typeof tp[0] === 'string') {
        html = tp[0];
        text = this.stripHtml(html);
      }
      if (!html && !text) return null;
      return { type: 'text_paragraph', html, text };
    }

    if (widget[7] != null && Array.isArray(widget[7])) {
      const buttonListArr = widget[7] as unknown[];
      const buttons: CardButton[] = [];
      for (const btnEntry of buttonListArr) {
        if (!Array.isArray(btnEntry)) continue;
        const btn = this.parseCardButton(btnEntry as unknown[]);
        if (btn) buttons.push(btn);
      }
      if (buttons.length === 0) return null;
      return { type: 'button_list', buttons };
    }

    return null;
  }

  parseCards(raw: unknown): Card[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const cards: Card[] = [];

    for (const cardWrapper of raw) {
      if (!Array.isArray(cardWrapper)) continue;

      const cardContent = cardWrapper[6] as unknown[] | undefined;
      const cardId = typeof cardWrapper[7] === 'string' ? cardWrapper[7] : undefined;

      if (!Array.isArray(cardContent)) continue;

      let header: Card['header'] | undefined;
      if (Array.isArray(cardContent[0])) {
        const h = cardContent[0] as unknown[];
        let title = '';
        if (Array.isArray(h[0]) && typeof h[0][0] === 'string') {
          title = h[0][0];
        } else if (typeof h[0] === 'string') {
          title = h[0];
        }
        const image_url = typeof h[3] === 'string' ? h[3] : undefined;
        const subtitle = typeof h[4] === 'string' ? h[4] : undefined;
        if (title) {
          header = { title, subtitle, image_url };
        }
      }

      const sections: CardSection[] = [];
      if (Array.isArray(cardContent[1])) {
        const sectionList = cardContent[1] as unknown[];

        const isSingleSection = sectionList.length >= 2 && Array.isArray(sectionList[1]) &&
          sectionList[1].length > 0 && Array.isArray(sectionList[1][0]);

        const sectionsToProcess = isSingleSection ? [sectionList] : sectionList;

        for (const section of sectionsToProcess) {
          if (!Array.isArray(section)) continue;
          const widgetsArr = Array.isArray(section[1]) ? section[1] as unknown[] : [];
          const widgets: CardWidget[] = [];

          for (const w of widgetsArr) {
            const widget = this.parseCardWidget(w as unknown[]);
            if (widget) widgets.push(widget);
          }

          if (widgets.length > 0) {
            sections.push({ widgets });
          }
        }
      }

      if (header || sections.length > 0) {
        cards.push({
          card_id: cardId,
          header,
          sections,
        });
      }
    }

    return cards;
  }

  private parseWorldItems(data: unknown, traceLog?: (msg: string) => void): WorldItemSummary[] {
    const t = traceLog ?? (() => {});

    const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
      ? data[0]
      : data;

    const items = this.getPbliteField<unknown[]>(payload, 4);
    if (!Array.isArray(items)) {
      // Debug: log structure of first few elements to understand the response format
      if (Array.isArray(payload)) {
        for (let i = 0; i < Math.min(payload.length, 6); i++) {
          const el = payload[i];
          const elType = el === null ? 'null' : Array.isArray(el) ? `array[${el.length}]` : typeof el;
          const preview = typeof el === 'string' ? el.slice(0, 50) : '';
          t(`parseWorldItems: payload[${i}] = ${elType}${preview ? ` "${preview}"` : ''}`);
        }
      }
      t(`parseWorldItems: no items array found (payload isArray=${Array.isArray(payload)}, length=${Array.isArray(payload) ? payload.length : 'N/A'})`);
      return [];
    }

    t(`parseWorldItems: raw items array has ${items.length} entries`);

    // Build userId→displayName map from payload field 8 (index 7 with tag offset).
    // Structure: payload[7][n][1] = [[[ [userId], "Display Name", avatarUrl, email, ... ]]]
    const userNameMap = this.extractUserNameMap(payload);
    if (userNameMap.size > 0) {
      t(`parseWorldItems: built user name map with ${userNameMap.size} users`);
    }

    const threadIdsBySpace = this.extractThreadIdsBySpace(payload);
    if (threadIdsBySpace.size > 0) {
      t(`parseWorldItems: built thread map for ${threadIdsBySpace.size} spaces`);
    }

    const results: WorldItemSummary[] = [];

    for (const item of items) {
      if (!Array.isArray(item)) {
        continue;
      }

      const groupId = this.getPbliteField<unknown[]>(item, 1);
      const spaceId = this.getNestedPbliteString(groupId, 1, 1);
      const dmId = this.getNestedPbliteString(groupId, 3, 1);
      const id = spaceId ?? dmId;

      if (!id) {
        continue;
      }

      // Extract sortTimestamp (last activity time) from the item's group-ID sub-array.
      // Same approach as parseSpacesWithTimestamp: scan positions 8-19 of the raw
      // second element for a microsecond timestamp string, then fall back to field 3.
      let sortTimestamp: number | undefined;
      const spaceEntry = item[1];
      if (Array.isArray(spaceEntry)) {
        for (let si = 8; si < Math.min(spaceEntry.length, 20); si++) {
          const val = spaceEntry[si];
          if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
            sortTimestamp = parseInt(val, 10);
            break;
          }
        }
      }
      if (!sortTimestamp) {
        sortTimestamp = this.toOptionalNumber(this.getPbliteField(item, 3));
      }

      // readState = item[3] (getPbliteField 4) — the member/read state sub-array
      // Contains badge count, read watermark, notification timestamps, notification level
      const readState = this.getPbliteField<unknown[]>(item, 4);
      const message = this.getPbliteField<unknown[]>(item, 13);

      const unreadCount = this.toNumber(this.getPbliteField(readState, 4));
      let unreadSubscribedTopicCount = 0;
      let subscribedThreadId: string | undefined;
      const lastMentionTime = this.toOptionalNumber(this.getPbliteField(message, 7));
      const unreadReplyCount = this.toNumber(this.getPbliteField(message, 9));
      const lastMessageText = this.getPbliteField<string>(message, 10);

      // Extract notification fields from readState (item[3]):
      //   readState[1]  = read watermark timestamp (usec string)   → getPbliteField(readState, 2)
      //   readState[6]  = badge count (string "0", "1", "4" etc.)  → getPbliteField(readState, 7)
      //   readState[17] = pending notification timestamp (usec)    → getPbliteField(readState, 18)
      //                    Non-zero when the item has unread content; 0 when fully read.
      //                    For DMs this is the most reliable unread indicator because
      //                    readState[1] gets updated aggressively by sidebar syncs.
      //   readState[21] = notification level (3=follows, 4=@only)  → getPbliteField(readState, 22)
      //   readState[27] = last notif-worthy event timestamp (usec) → getPbliteField(readState, 28)
      let badgeCount: number | undefined;
      let lastNotifWorthyEventTimestamp: number | undefined;
      let readWatermarkTimestamp: number | undefined;
      let notificationLevel: number | undefined;
      let pendingNotificationTimestamp: number | undefined;

      if (Array.isArray(readState)) {
        const rawThreadUnreadState = this.getPbliteField<unknown[]>(readState, 21);
        const rawBadge = this.getPbliteField(readState, 7);
        const rawNotifEvent = this.getPbliteField(readState, 28);
        const rawWatermark = this.getPbliteField(readState, 2);
        const rawNotifLevel = this.getPbliteField(readState, 22);
        const rawPendingNotif = this.getPbliteField(readState, 18);
        // NOTE: readState[5] (getPbliteField 6) = last activity timestamp
        // for the space.  The Google Chat UI compares this against the read
        // watermark (readState[1]) to show the blue unread dot.  We handle
        // this via markAsReadJson() in markThreadAsRead() rather than in
        // categorizeNotification().  Kept as documentation of the field map.

        badgeCount = this.toOptionalNumber(rawBadge);
        lastNotifWorthyEventTimestamp = this.toOptionalNumber(rawNotifEvent);
        readWatermarkTimestamp = this.toOptionalNumber(rawWatermark);
        notificationLevel = this.toOptionalNumber(rawNotifLevel);
        pendingNotificationTimestamp = this.toOptionalNumber(rawPendingNotif);

        if (Array.isArray(rawThreadUnreadState)) {
          let hasThreadUnread = this.getPbliteField<boolean>(rawThreadUnreadState, 2) === true;

          const rawSubscribedThread = this.getPbliteField<unknown[]>(rawThreadUnreadState, 3);
          if (Array.isArray(rawSubscribedThread)) {
            subscribedThreadId = this.getPbliteField<string>(rawSubscribedThread, 2);
          }

          // Suppress stale readState[20] indicator for threads recently
          // marked as read.  paginated_world can lag; mark_topic_readstate
          // confirmed the thread is already read server-side.
          if (hasThreadUnread && subscribedThreadId && this.isThreadRecentlyMarked(id, subscribedThreadId)) {
            log.client.debug(`parseWorldItems: suppressing stale readState[20] for ${id}/${subscribedThreadId} (recently marked)`);
            hasThreadUnread = false;
          }

          // readState[20] is a persistent flag that never naturally clears.
          // If the space's read watermark has already been advanced past all
          // activity (sortTimestamp <= readWatermarkTimestamp), any thread
          // unread indicator is stale — the user has read past everything.
          if (
            hasThreadUnread &&
            sortTimestamp != null &&
            readWatermarkTimestamp != null &&
            sortTimestamp <= readWatermarkTimestamp
          ) {
            log.client.debug(
              `parseWorldItems: suppressing stale readState[20] for ${id} ` +
              `(sortTimestamp ${sortTimestamp} <= readWatermark ${readWatermarkTimestamp})`
            );
            hasThreadUnread = false;
          }

          unreadSubscribedTopicCount = hasThreadUnread ? 1 : 0;
        }
      }

      const type = dmId ? 'dm' : 'space';
      const notificationCategory = this.categorizeNotification(
        badgeCount ?? 0,
        lastNotifWorthyEventTimestamp,
        readWatermarkTimestamp,
        sortTimestamp,
        pendingNotificationTimestamp,
      );

      let name = this.getPbliteField<string>(item, 5);

      // Extract DM member user IDs for name resolution
      let memberUserIds: string[] | undefined;
      if (type === 'dm') {
        memberUserIds = this.extractDmMemberIds(item);
      }

      // For DMs, resolve name from member data
      if (type === 'dm' && !name) {
        // First try: item[2] (getPbliteField 3) may be a string name
        const field3 = this.getPbliteField<unknown>(item, 3);
        if (typeof field3 === 'string') {
          name = field3;
        }
        // Second try: resolve from embedded member name map
        if (!name && userNameMap.size > 0) {
          name = this.resolveDmName(item, userNameMap);
        }
      }

      results.push({
        id,
        name,
        type,
        unreadCount,
        unreadSubscribedTopicCount,
        lastMentionTime,
        unreadReplyCount,
        lastMessageText,
        subscribedThreadId,
        threadIds: type === 'space'
          ? this.mergeThreadIds(threadIdsBySpace.get(id), subscribedThreadId)
          : undefined,
        isSubscribedToSpace: unreadSubscribedTopicCount > 0,
        notificationCategory,
        badgeCount,
        lastNotifWorthyEventTimestamp,
        readWatermarkTimestamp,
        notificationLevel,
        sortTimestamp,
        _memberUserIds: memberUserIds,
      });
    }

    if (results.length > 0) {
      const badged = results.filter(r => r.notificationCategory === 'badged').length;
      const litUp = results.filter(r => r.notificationCategory === 'lit_up').length;
      const dmsNamed = results.filter(r => r.type === 'dm' && r.name).length;
      const dmsTotal = results.filter(r => r.type === 'dm').length;
      log.client.debug(
        `parseWorldItems: ${results.length} items — badged=${badged}, lit_up=${litUp}, clean=${results.length - badged - litUp}, dms=${dmsNamed}/${dmsTotal} named`
      );
    }

    return results;
  }

  private extractThreadIdsBySpace(payload: unknown): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const threadSections = [
      this.getPbliteField<unknown[]>(payload, 7),
      this.getPbliteField<unknown[]>(payload, 8),
    ];

    for (const threadSection of threadSections) {
      if (!Array.isArray(threadSection)) {
        continue;
      }

      for (const entry of threadSection) {
        if (!Array.isArray(entry)) {
          continue;
        }

        const meta = this.getPbliteField<unknown[]>(entry, 1);
        const threadRef = this.getPbliteField<unknown[]>(meta, 1);
        const threadId = this.getPbliteField<string>(threadRef, 2);
        const spaceWrapper = this.getPbliteField<unknown[]>(threadRef, 3);
        const spaceId = this.getNestedPbliteString(spaceWrapper, 1, 1);

        if (!threadId || !spaceId) {
          continue;
        }

        const existing = map.get(spaceId);
        if (existing) {
          if (!existing.includes(threadId)) {
            existing.push(threadId);
          }
        } else {
          map.set(spaceId, [threadId]);
        }
      }
    }

    return map;
  }

  /**
   * Merge threadIds from extractThreadIdsBySpace (pw[7]/pw[8]) with the
   * subscribedThreadId from readState[20].  The subscribed thread is the
   * actual unread thread and is often NOT present in pw[7]/pw[8].
   */
  private mergeThreadIds(
    existing: string[] | undefined,
    subscribedThreadId: string | undefined,
  ): string[] | undefined {
    if (!subscribedThreadId) {
      return existing;
    }

    if (!existing || existing.length === 0) {
      return [subscribedThreadId];
    }

    if (existing.includes(subscribedThreadId)) {
      return existing;
    }

    // Put the subscribed (unread) thread first so it gets cleared first
    return [subscribedThreadId, ...existing];
  }

  /** Check if a thread was recently marked as read (suppresses stale readState[20]). */
  private isThreadRecentlyMarked(spaceId: string, topicId: string): boolean {
    const key = `${spaceId}/${topicId}`;
    const ts = this.markedThreads.get(key);
    if (ts == null) return false;
    if (Date.now() - ts > GoogleChatClient.MARK_CACHE_TTL_MS) {
      this.markedThreads.delete(key);
      return false;
    }
    return true;
  }

  /** Evict expired entries from the marked-threads cache. */
  private pruneMarkedThreadsCache(): void {
    const now = Date.now();
    for (const [key, ts] of this.markedThreads) {
      if (now - ts > GoogleChatClient.MARK_CACHE_TTL_MS) {
        this.markedThreads.delete(key);
      }
    }
  }

  /**
   * Extract a userId→displayName map from the PBLite payload's member section.
   * payload field 8 (index varies by tag offset) contains thread-level member
   * data: payload[7][n][1] = [[[ [userId], "Name", avatarUrl, email, ... ]]]
   */
  private extractUserNameMap(payload: unknown): Map<string, string> {
    const map = new Map<string, string>();
    const memberSection = this.getPbliteField<unknown[]>(payload, 8);
    if (!Array.isArray(memberSection)) return map;

    for (const entry of memberSection) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const userInfoWrapper = entry[1]; // [[[userData]]]
      if (!Array.isArray(userInfoWrapper)) continue;

      for (const level1 of userInfoWrapper) {
        if (!Array.isArray(level1)) continue;
        for (const userData of level1) {
          if (!Array.isArray(userData) || userData.length < 2) continue;
          const uidArr = userData[0];
          const displayName = userData[1];
          if (
            Array.isArray(uidArr) &&
            uidArr.length > 0 &&
            typeof uidArr[0] === 'string' &&
            typeof displayName === 'string'
          ) {
            if (!map.has(uidArr[0])) {
              map.set(uidArr[0], displayName);
            }
          }
        }
      }
    }

    return map;
  }

  /**
   * Resolve a DM's display name by looking up the "other" participant(s)
   * in the user name map.  item[5][0] contains member ID arrays:
   *   [[userId1], [userId2], ...]
   * We exclude selfUserId and join the remaining names.
   */
  private resolveDmName(item: unknown[], userNameMap: Map<string, string>): string | undefined {
    const membersField = this.getPbliteField<unknown[]>(item, 6); // item[5]
    if (!Array.isArray(membersField) || membersField.length === 0) return undefined;

    const memberIdArrays = membersField[0];
    if (!Array.isArray(memberIdArrays)) return undefined;

    // Detect self user ID from item[6] (getPbliteField 7) if not already known.
    // For DMs, item[6][0] = [currentUserId] consistently.
    let selfId = this.selfUserId;
    if (!selfId) {
      const actorField = this.getPbliteField<unknown[]>(item, 7); // item[6]
      if (Array.isArray(actorField) && actorField.length > 0) {
        const actorIdArr = actorField[0];
        if (Array.isArray(actorIdArr) && actorIdArr.length > 0 && typeof actorIdArr[0] === 'string') {
          selfId = actorIdArr[0];
        } else if (typeof actorIdArr === 'string') {
          selfId = actorIdArr;
        }
      }
    }

    const otherNames: string[] = [];
    for (const m of memberIdArrays) {
      if (!Array.isArray(m) || m.length === 0 || typeof m[0] !== 'string') continue;
      const uid = m[0];
      // Skip self
      if (selfId && uid === selfId) continue;
      const name = userNameMap.get(uid);
      if (name) otherNames.push(name);
    }

    if (otherNames.length > 0) {
      return otherNames.join(', ');
    }
    return undefined;
  }

  /**
   * Extract participant user IDs from a DM PBLite item.
   * item[5] (getPbliteField 6) = [[userId1], [userId2], ...] at sub-index 0.
   */
  private extractDmMemberIds(item: unknown[]): string[] | undefined {
    const membersField = this.getPbliteField<unknown[]>(item, 6);
    if (!Array.isArray(membersField) || membersField.length === 0) return undefined;

    const memberIdArrays = membersField[0];
    if (!Array.isArray(memberIdArrays)) return undefined;

    const ids: string[] = [];
    for (const m of memberIdArrays) {
      if (Array.isArray(m) && m.length > 0 && typeof m[0] === 'string') {
        ids.push(m[0]);
      }
    }
    return ids.length > 0 ? ids : undefined;
  }

  private parseMemberNames(data: unknown): Record<string, string> {
    const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
      ? data[0]
      : data;

    const members = this.getPbliteField<unknown[]>(payload, 1);
    const names: Record<string, string> = {};

    if (!Array.isArray(members)) {
      if (Array.isArray(payload)) {
        for (const entry of payload) {
          if (Array.isArray(entry)) {
            const user = this.getPbliteField<unknown[]>(entry, 1);
            if (user) {
              const userId = this.getNestedPbliteString(user, 1, 1);
              const name = this.getPbliteField<string>(user, 2);
              if (userId && name) {
                names[userId] = name;
              }
            }
          }
        }
      }
      return names;
    }

    for (const member of members) {
      const user = this.getPbliteField<unknown[]>(member, 1);
      if (!user) {
        continue;
      }

      const userId = this.getNestedPbliteString(user, 1, 1);
      const name = this.getPbliteField<string>(user, 2);

      if (userId && name) {
        names[userId] = name;
      }
    }

    return names;
  }

  private async populateSenderNames(messages: Message[]): Promise<void> {
    const ids = new Set<string>();

    for (const msg of messages) {
      if (!msg.sender) {
        continue;
      }
      if (!/^\d+$/.test(msg.sender)) {
        continue;
      }
      ids.add(msg.sender);
    }

    log.client.debug('populateSenderNames: Found', ids.size, 'unique user IDs to resolve:', Array.from(ids).slice(0, 5));

    if (ids.size === 0) {
      return;
    }

    const resolvedNames = new Map<string, string>();
    const idList = Array.from(ids);
    const chunkSize = 50;
    for (let i = 0; i < idList.length; i += chunkSize) {
      const chunk = idList.slice(i, i + chunkSize);
      try {
        const protoData = encodeGetMembersRequest(chunk);
        const data = await this.apiRequest<unknown[]>('get_members', protoData);
        const names = this.parseMemberNames(data);
        log.client.debug('populateSenderNames: Resolved', Object.keys(names).length, 'names:', names);
        if (Object.keys(names).length === 0 && chunk.length > 0) {
          log.client.debug('populateSenderNames: No names returned for user IDs:', chunk.slice(0, 3), '...');
        }
        for (const [id, name] of Object.entries(names)) {
          resolvedNames.set(id, name);
        }
      } catch (err) {
        log.client.warn('populateSenderNames: Failed to fetch member names:', (err as Error).message);
      }
    }

    let resolved = 0;
    for (const msg of messages) {
      if (msg.sender && resolvedNames.has(msg.sender)) {
        const originalId = msg.sender;
        msg.sender = resolvedNames.get(msg.sender) ?? msg.sender;
        if (msg.sender !== originalId) resolved++;
      }
    }
    log.client.debug('populateSenderNames: Resolved', resolved, 'sender names in messages');
  }

  private makeRequestHeader() {
    return {
      '2': 3,   
      '4': 'en' 
    };
  }

  private makeGroupId(spaceId: string) {
    return { '1': { '1': spaceId } };
  }

  async listSpaces(options: { maxPages?: number; pageSize?: number } = {}): Promise<Space[]> {
    const { maxPages = 10, pageSize = 200 } = options;
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    try {
      const fs = await import('fs');
      const path = await import('path');
      const configPath = path.join(this.cacheDir, 'spaces.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (Array.isArray(config.extraSpaces)) {
          for (const extra of config.extraSpaces) {
            if (extra.id && !seenIds.has(extra.id)) {
              seenIds.add(extra.id);
              spaces.push({
                id: extra.id,
                name: extra.name,
                type: (extra.type as 'space' | 'dm') || 'space',
              });
            }
          }
          log.client.debug('listSpaces: Loaded', config.extraSpaces.length, 'extra spaces from config');
        }
      }
    } catch (e) {
      log.client.debug('listSpaces: Failed to load spaces.json:', (e as Error).message);
    }

    const authCache = loadAuthCache(this.cacheDir);
    if (authCache?.mole_world_body) {
      const moleSpaces = this.extractSpacesFromMoleWorld(authCache.mole_world_body);
      for (const space of moleSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
        }
      }
      log.client.debug('listSpaces: Extracted', moleSpaces.length, 'spaces from mole_world_body');
    }

    let cursor: number | undefined;
    let pagesLoaded = 0;

    while (maxPages === 0 || pagesLoaded < maxPages) {
      try {
        const protoData = encodePaginatedWorldRequest(pageSize, cursor);
        const data = await this.apiRequest<unknown[]>('paginated_world', protoData);

        let parsedSpaces = this.parseSpacesWithTimestamp(data);
        if (parsedSpaces.length === 0) {
          const fallbackSpaces = this.parseSpaces(data);
          parsedSpaces = fallbackSpaces.map(s => ({ ...s, sortTimestamp: undefined }));
        }

        let newCount = 0;
        for (const space of parsedSpaces) {
          if (!seenIds.has(space.id)) {
            seenIds.add(space.id);
            spaces.push(space);
            newCount++;
          }
        }

        pagesLoaded++;
        log.client.debug(`listSpaces: Page ${pagesLoaded} returned ${parsedSpaces.length} spaces (${newCount} new)`);

        if (parsedSpaces.length < pageSize) {
          break;
        }

        const timestamps = parsedSpaces
          .map(s => s.sortTimestamp)
          .filter((t): t is number => t !== undefined);

        if (timestamps.length === 0) {
          break;
        }

        const nextCursor = Math.min(...timestamps);
        if (nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;

      } catch (e) {
        log.client.debug('listSpaces: API call failed, stopping pagination:', (e as Error).message);
        break;
      }
    }

    try {
      const catchUpSpaces = await this.catchUpUser();
      let catchUpNewCount = 0;
      for (const space of catchUpSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
          catchUpNewCount++;
        }
      }
      if (catchUpNewCount > 0) {
        log.client.debug('listSpaces: catch_up_user added', catchUpNewCount, 'new spaces');
      }
    } catch (e) {
      log.client.debug('listSpaces: catch_up_user failed:', (e as Error).message);
    }

    // If protobuf + catchUpUser returned nothing (common in extension auth mode),
    // fall back to JSON API which works reliably through the extension bridge.
    if (spaces.length === 0) {
      log.client.debug('listSpaces: protobuf returned no spaces, falling back to JSON API...');
      try {
        const payload = this.buildPaginatedWorldPayload(pageSize);
        const jsonData = await this.apiRequestJson<unknown[]>('paginated_world', payload);
        const worldItems = this.parseWorldItems(jsonData);
        for (const item of worldItems) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            spaces.push({
              id: item.id,
              name: item.name,
              type: item.type,
            });
          }
        }
        log.client.debug(`listSpaces: JSON API fallback returned ${spaces.length} spaces`);
      } catch (jsonErr) {
        log.client.debug('listSpaces: JSON API fallback failed:', (jsonErr as Error).message);
      }
    }

    log.client.debug('listSpaces: Total spaces found:', spaces.length);
    return spaces;
  }

  async getSpace(spaceId: string): Promise<Space | null> {
    const spaces = await this.listSpaces();
    const existing = spaces.find(s => s.id === spaceId);
    if (existing) {
      return existing;
    }

    try {
      const result = await this.getThreads(spaceId, { pageSize: 1 });
      if (result.messages.length > 0 || result.total_topics >= 0) {
        const type: 'space' | 'dm' = isDmId(spaceId) ? 'dm' : 'space';
        log.client.debug('getSpace: Space exists (verified via messages)', { id: spaceId, type });
        return {
          id: spaceId,
          name: undefined, 
          type,
        };
      }
    } catch (e) {
      log.client.debug('getSpace: Failed to verify space:', (e as Error).message);
    }

    return null;
  }

  async catchUpUser(): Promise<Space[]> {
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    try {
      const protoData = encodeCatchUpUserRequest();
      const data = await this.apiRequest<unknown>('catch_up_user', protoData);

      log.client.debug('catchUpUser: Raw response type:', typeof data, Array.isArray(data) ? `array[${(data as unknown[]).length}]` : '');
      log.client.debug('catchUpUser: Raw response preview:', JSON.stringify(data).slice(0, 2000));

      const extractIds = (obj: unknown, depth = 0): void => {
        if (depth > 20 || !obj) return;

        if (Array.isArray(obj)) {
          for (const item of obj) {
            extractIds(item, depth + 1);
          }
        } else if (typeof obj === 'object') {
          for (const value of Object.values(obj as Record<string, unknown>)) {
            extractIds(value, depth + 1);
          }
        } else if (typeof obj === 'string') {
          if (obj.length === 11 && obj.startsWith('AAAA') && !seenIds.has(obj)) {
            seenIds.add(obj);
            spaces.push({ id: obj, type: 'space' });
          }
          else if (obj.length > 15 && obj.length < 50 && /^[A-Za-z0-9_-]+$/.test(obj) && !obj.includes('.') && !seenIds.has(obj)) {
            seenIds.add(obj);
            spaces.push({ id: obj, type: 'dm' });
          }
        }
      };

      extractIds(data);
      log.client.debug('catchUpUser: Found', spaces.length, 'spaces/DMs');

    } catch (e) {
      log.client.debug('catchUpUser: API call failed:', (e as Error).message);
    }

    return spaces;
  }

  async listSpacesPaginated(options: {
    pageSize?: number;
    cursor?: number;
    enrich?: boolean;
  } = {}): Promise<SpacesResult> {
    const { pageSize = 100, cursor, enrich = false } = options;
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    if (cursor === undefined) {
      const authCache = loadAuthCache(this.cacheDir);
      if (authCache?.mole_world_body) {
        const moleSpaces = enrich
          ? this.extractSpacesFromMoleWorldEnriched(authCache.mole_world_body)
          : this.extractSpacesFromMoleWorld(authCache.mole_world_body);
        for (const space of moleSpaces) {
          if (!seenIds.has(space.id)) {
            seenIds.add(space.id);
            spaces.push(space);
          }
        }
        log.client.debug('listSpacesPaginated: Extracted', moleSpaces.length, 'spaces from mole_world_body');
      }
    }

    try {
      const protoData = encodePaginatedWorldRequest(pageSize, cursor);
      const data = await this.apiRequest<unknown[]>('paginated_world', protoData);

      let parsedSpaces = this.parseSpacesWithTimestamp(data, enrich);
      if (parsedSpaces.length === 0) {
        parsedSpaces = this.parseSpaces(data);
      }

      for (const space of parsedSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
        }
      }

      const hasMore = parsedSpaces.length >= pageSize;

      let nextCursor: number | undefined;
      if (hasMore && parsedSpaces.length > 0) {
        const timestamps = parsedSpaces
          .map(s => s.sortTimestamp)
          .filter((t): t is number => t !== undefined);
        if (timestamps.length > 0) {
          nextCursor = Math.min(...timestamps);
        }
      }

      // If protobuf returned nothing, fall back to JSON API
      if (spaces.length === 0) {
        log.client.debug('listSpacesPaginated: protobuf returned no spaces, falling back to JSON API...');
        try {
          const payload = this.buildPaginatedWorldPayload(pageSize);
          const jsonData = await this.apiRequestJson<unknown[]>('paginated_world', payload);
          const worldItems = this.parseWorldItems(jsonData);
          for (const item of worldItems) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              spaces.push({
                id: item.id,
                name: item.name,
                type: item.type,
              });
            }
          }
          log.client.debug(`listSpacesPaginated: JSON API fallback returned ${spaces.length} spaces`);
        } catch (jsonErr) {
          log.client.debug('listSpacesPaginated: JSON API fallback failed:', (jsonErr as Error).message);
        }
      }

      return {
        spaces,
        pagination: {
          hasMore: spaces.length >= pageSize,
          nextCursor,
        },
      };
    } catch (e) {
      log.client.error('listSpacesPaginated: API call failed:', e);

      // Last resort: try JSON API even if protobuf threw
      try {
        log.client.debug('listSpacesPaginated: trying JSON API after protobuf error...');
        const payload = this.buildPaginatedWorldPayload(pageSize);
        const jsonData = await this.apiRequestJson<unknown[]>('paginated_world', payload);
        const worldItems = this.parseWorldItems(jsonData);
        for (const item of worldItems) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            spaces.push({
              id: item.id,
              name: item.name,
              type: item.type,
            });
          }
        }
      } catch (jsonErr) {
        log.client.debug('listSpacesPaginated: JSON API fallback also failed:', (jsonErr as Error).message);
      }

      return {
        spaces,
        pagination: { hasMore: false },
      };
    }
  }

  private parseSpacesWithTimestamp(data: unknown, enrich = false): Space[] {
    const spaces: Space[] = [];

    const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
      ? data[0]
      : data;

    const items = this.getPbliteField<unknown[]>(payload, 4);
    if (!Array.isArray(items)) {
      return spaces;
    }

    for (const item of items) {
      if (!Array.isArray(item)) {
        continue;
      }

      const groupId = this.getPbliteField<unknown[]>(item, 1);
      const spaceId = this.getNestedPbliteString(groupId, 1, 1);
      const dmId = this.getNestedPbliteString(groupId, 3, 1);
      const id = spaceId ?? dmId;

      if (!id) {
        continue;
      }

      let sortTimestamp: number | undefined;
      const spaceEntry = item[1];
      if (Array.isArray(spaceEntry)) {
        for (let i = 8; i < Math.min(spaceEntry.length, 20); i++) {
          const val = spaceEntry[i];
          if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
            sortTimestamp = parseInt(val, 10);
            break;
          }
        }
      }
      if (!sortTimestamp) {
        sortTimestamp = this.toOptionalNumber(this.getPbliteField(item, 3));
      }

      let name = this.getPbliteField<string>(item, 5);

      const type: 'space' | 'dm' = dmId ? 'dm' : 'space';
      if (type === 'dm' && !name) {
        const field3 = this.getPbliteField<string>(item, 3);
        if (typeof field3 === 'string' && field3.length > 0 && field3.length < 100) {
          name = field3;
        }
      }

      const space: Space = {
        id,
        name,
        type,
        sortTimestamp,
      };

      if (enrich) {
        const enrichment = this.extractEnrichmentFromItem(item);
        if (enrichment.emoji) space.emoji = enrichment.emoji;
        if (enrichment.rosterId) space.rosterId = enrichment.rosterId;
      }

      spaces.push(space);
    }

    return spaces;
  }

  private extractEnrichmentFromItem(item: unknown[]): { emoji?: { unicode?: string }; rosterId?: string } {
    const result: { emoji?: { unicode?: string }; rosterId?: string } = {};

    const searchItem = (arr: unknown[], depth = 0): void => {
      if (depth > 5 || !Array.isArray(arr)) return;

      for (let i = 0; i < arr.length; i++) {
        const val = arr[i];

        if (typeof val === 'string' && val.includes('hangouts-chat-') && val.includes('@')) {
          result.rosterId = val;
        }

        if (Array.isArray(val) && val.length === 1 && Array.isArray(val[0]) && val[0].length === 1) {
          const potentialEmoji = val[0][0];
          if (typeof potentialEmoji === 'string' && potentialEmoji.length >= 1 && potentialEmoji.length <= 8) {
            const codePoint = potentialEmoji.codePointAt(0) || 0;
            if (codePoint > 0x1F00 || /[\u200d\u2600-\u26FF\u2700-\u27BF]/.test(potentialEmoji)) {
              result.emoji = { unicode: potentialEmoji };
            }
          }
        }

        if (Array.isArray(val)) {
          searchItem(val, depth + 1);
        }
      }
    };

    searchItem(item);
    return result;
  }

  async listSpacesEnriched(options: {
    maxPages?: number;
    pageSize?: number;
    enrich?: boolean;
  } = {}): Promise<Space[]> {
    const { enrich = false, maxPages = 10, pageSize = 200 } = options;

    if (!enrich) {
      return this.listSpaces({ maxPages, pageSize });
    }

    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    const authCache = loadAuthCache(this.cacheDir);
    if (authCache?.mole_world_body) {
      const moleSpaces = this.extractSpacesFromMoleWorldEnriched(authCache.mole_world_body);
      for (const space of moleSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
        }
      }
      log.client.debug('listSpacesEnriched: Extracted', moleSpaces.length, 'enriched spaces from mole_world_body');
    }

    let cursor: number | undefined;
    let pagesLoaded = 0;

    while (maxPages === 0 || pagesLoaded < maxPages) {
      try {
        const protoData = encodePaginatedWorldRequest(pageSize, cursor);
        const data = await this.apiRequest<unknown[]>('paginated_world', protoData);

        let parsedSpaces = this.parseSpacesWithTimestamp(data, true);
        if (parsedSpaces.length === 0) {
          // Fallback: try the non-enriched parser (different PBLite layout)
          const fallbackSpaces = this.parseSpaces(data);
          parsedSpaces = fallbackSpaces.map(s => ({ ...s, sortTimestamp: undefined }));
        }

        let newCount = 0;
        for (const space of parsedSpaces) {
          if (!seenIds.has(space.id)) {
            seenIds.add(space.id);
            spaces.push(space);
            newCount++;
          }
        }

        pagesLoaded++;
        log.client.debug(`listSpacesEnriched: Page ${pagesLoaded} returned ${parsedSpaces.length} spaces (${newCount} new)`);

        if (parsedSpaces.length < pageSize) {
          break;
        }

        const timestamps = parsedSpaces
          .map(s => s.sortTimestamp)
          .filter((t): t is number => t !== undefined);

        if (timestamps.length === 0) {
          break;
        }

        const nextCursor = Math.min(...timestamps);
        if (nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;

      } catch (e) {
        log.client.error('listSpacesEnriched: API call failed:', e);
        break;
      }
    }

    // Fallback: if protobuf path returned nothing, try the JSON API path
    // which fetchWorldItems uses (known to work in extension mode)
    if (spaces.length === 0) {
      log.client.debug('listSpacesEnriched: protobuf returned no spaces, falling back to JSON API...');
      try {
        const payload = this.buildPaginatedWorldPayload(pageSize);
        const jsonData = await this.apiRequestJson<unknown[]>('paginated_world', payload);
        const worldItems = this.parseWorldItems(jsonData);
        for (const item of worldItems) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            spaces.push({
              id: item.id,
              name: item.name,
              type: item.type,
            });
          }
        }
        log.client.debug(`listSpacesEnriched: JSON API fallback returned ${spaces.length} spaces`);
      } catch (e) {
        log.client.debug('listSpacesEnriched: JSON API fallback failed:', (e as Error).message);
      }
    }

    // Fallback: catch_up_user for any remaining spaces
    if (spaces.length === 0) {
      try {
        const catchUpSpaces = await this.catchUpUser();
        for (const space of catchUpSpaces) {
          if (!seenIds.has(space.id)) {
            seenIds.add(space.id);
            spaces.push(space);
          }
        }
        if (catchUpSpaces.length > 0) {
          log.client.debug('listSpacesEnriched: catch_up_user returned', catchUpSpaces.length, 'spaces');
        }
      } catch (e) {
        log.client.debug('listSpacesEnriched: catch_up_user failed:', (e as Error).message);
      }
    }

    return spaces;
  }

  private extractSpacesFromMoleWorldEnriched(body: string): Space[] {
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    const ds1Regex = /AF_initDataCallback\(\{key:\s*'ds:1',\s*hash:\s*'[^']+',\s*data:(\[[\s\S]*?\])\s*,\s*sideChannel/;
    const match = ds1Regex.exec(body);

    if (match) {
      try {
        const data = JSON.parse(match[1]);
        this.findSpacesWithEnrichment(data, spaces, seenIds);
      } catch {
        log.client.debug('extractSpacesFromMoleWorldEnriched: JSON parse failed, using fallback');
      }
    }

    return spaces;
  }

  private findSpacesWithEnrichment(data: unknown, spaces: Space[], seenIds: Set<string>): void {
    if (!Array.isArray(data)) return;

    if (data.length > 2 && Array.isArray(data[0]) && data[0].length >= 3) {
      const firstElem = data[0];
      if (typeof firstElem[0] === 'string' && firstElem[0].startsWith('space/')) {
        const spaceId = firstElem[1] as string;
        if (typeof spaceId === 'string' && spaceId.startsWith('AAAA') && !seenIds.has(spaceId)) {
          seenIds.add(spaceId);
          const name = typeof data[2] === 'string' ? data[2] : undefined;

          let sortTimestamp: number | undefined;
          for (let i = 8; i < Math.min(data.length, 16); i++) {
            const val = data[i];
            if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
              sortTimestamp = parseInt(val, 10);
              break;
            }
          }

          const space: Space = {
            id: spaceId,
            name,
            type: 'space',
            sortTimestamp,
          };

          const enrichment = this.extractEnrichmentFromItem(data);
          if (enrichment.emoji) space.emoji = enrichment.emoji;
          if (enrichment.rosterId) space.rosterId = enrichment.rosterId;

          spaces.push(space);
        }
      }
    }

    if (data.length > 2 && Array.isArray(data[0]) && data[0].length >= 3) {
      const firstElem = data[0];
      if (typeof firstElem[0] === 'string' && firstElem[0].startsWith('dm/')) {
        const dmId = firstElem[1] as string;
        if (typeof dmId === 'string' && !seenIds.has(dmId)) {
          seenIds.add(dmId);
          const name = typeof data[2] === 'string' ? data[2] : undefined;

          let sortTimestamp: number | undefined;
          for (let i = 8; i < Math.min(data.length, 16); i++) {
            const val = data[i];
            if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
              sortTimestamp = parseInt(val, 10);
              break;
            }
          }

          const space: Space = {
            id: dmId,
            name,
            type: 'dm',
            sortTimestamp,
          };

          spaces.push(space);
        }
      }
    }

    for (const item of data) {
      if (Array.isArray(item)) {
        this.findSpacesWithEnrichment(item, spaces, seenIds);
      }
    }
  }

  async fetchWorldItems(options: { forceRefresh?: boolean } = {}): Promise<{ items: WorldItemSummary[]; raw: unknown[] }> {
    const { forceRefresh = false } = options;

    if (forceRefresh) {
      try {
        log.client.debug('fetchWorldItems: Force refreshing from /mole/world');
        const { xsrfToken, body } = await fetchXsrfToken(this.cookies);
        saveAuthCache(xsrfToken, body, this.cacheDir);
      } catch (err) {
        log.client.debug('fetchWorldItems: Failed to refresh /mole/world auth cache (expected in extension mode):', err);
      }
    }

    // Strategy: paginated_world API is the PRIMARY source (supports pagination
    // for complete results with verified notification fields). Falls back to
    // /mole/world HTML extraction only if the API fails.
    const traceLog = (msg: string) => { log.client.debug(msg); };

    let items: WorldItemSummary[] = [];
    let raw: unknown[] = [];
    let source = 'none';

    // Primary: paginated_world JSON API — Google Chat sends PBLite JSON (not protobuf)
    // with Content-Type: application/json and a ?c= channel parameter.
    // A single request with all section types returns the full world.
    {
      traceLog('fetchWorldItems: trying paginated_world JSON API (primary)...');
      const PAGE_SIZE = 200;
      const seenIds = new Set<string>();

      try {
        const payload = this.buildPaginatedWorldPayload(PAGE_SIZE);
        traceLog(`paginated_world: sending JSON request (${JSON.stringify(payload).length} bytes)...`);
        const pageRaw = await this.apiRequestJson<unknown[]>('paginated_world', payload);

        raw = pageRaw;
        const pageItems = this.parseWorldItems(pageRaw, traceLog);

        for (const item of pageItems) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            items.push(item);
          }
        }
        traceLog(`paginated_world JSON: ${pageItems.length} items (${items.length} unique)`);

        if (items.length > 0) {
          source = 'paginated_world';
        }
      } catch (err) {
        traceLog(`paginated_world JSON FAILED: ${err}`);
      }
    }

    // Fallback: /mole/world HTML extraction (only if paginated_world returned nothing)
    if (items.length === 0) {
      traceLog('fetchWorldItems: paginated_world returned nothing, falling back to /mole/world HTML...');
      let moleBody: string | null = null;

      if (this.bridge) {
        traceLog('fetchWorldItems: fetching /mole/world via bridge...');
        try {
          const moleUrl = 'https://chat.google.com/u/0/mole/world?origin=https://mail.google.com&shell=9&hl=en&wfi=gtn-roster-iframe-id&hs=' + encodeURIComponent('["h_hs",null,null,[1,0],null,null,"gmail.pinto-server_20230730.06_p0",1,null,[15,38,36,35,26,30,41,18,24,11,21,14,6],null,null,"3Mu86PSulM4.en..es5",0,null,null,[0]]');
          const result = await this.bridge.proxyRequest(moleUrl, 'GET', {
            'User-Agent': USER_AGENT,
          });
          if (result.status === 200 && result.body) {
            moleBody = result.body;
            // Debug: count dfe.w.pw occurrences and dump body for analysis
            const dfePwCount = (moleBody.match(/dfe\.w\.pw/g) || []).length;
            const afCallbackCount = (moleBody.match(/AF_initDataCallback/g) || []).length;
            traceLog(`/mole/world fetched OK, body length: ${moleBody.length}, dfe.w.pw count: ${dfePwCount}, AF_initDataCallback count: ${afCallbackCount}`);
            try {
              const { writeFileSync } = await import('node:fs');
              writeFileSync('/tmp/gchat-moleworld.html', moleBody);
              traceLog('Wrote /mole/world body to /tmp/gchat-moleworld.html');
            } catch {}
          } else {
            traceLog(`/mole/world fetch failed: status=${result.status}`);
          }
        } catch (err) {
          traceLog(`/mole/world bridge fetch error: ${err}`);
        }
      } else if (forceRefresh) {
        try {
          traceLog('fetchWorldItems: fetching /mole/world via cookies...');
          const { xsrfToken, body } = await fetchXsrfToken(this.cookies);
          saveAuthCache(xsrfToken, body, this.cacheDir);
          moleBody = body;
          traceLog(`/mole/world fetched OK, body length: ${moleBody.length}`);
        } catch (err) {
          traceLog(`/mole/world cookie fetch error: ${err}`);
        }
      }

      if (!moleBody) {
        const authCache = loadAuthCache(this.cacheDir);
        if (authCache?.mole_world_body) {
          moleBody = authCache.mole_world_body;
          traceLog(`Using cached mole_world body, length: ${moleBody.length}`);
        }
      }

      if (moleBody) {
        const pbliteItems = this.extractPbliteWorldItems(moleBody, traceLog);
        if (pbliteItems.length > 0) {
          traceLog(`PBLite extraction from HTML: ${pbliteItems.length} items`);
          items = pbliteItems;
          source = 'mole_world_pblite';
        }

        if (items.length === 0) {
          traceLog('PBLite extraction failed, falling back to DS:1...');
          const ds1Items = this.extractWorldItemsFromMoleWorld(moleBody);
          if (ds1Items.length > 0) {
            traceLog(`DS:1 extraction: ${ds1Items.length} items`);
            items = ds1Items;
            source = 'mole_world_ds1';
          }
        }
      }
    }

    if (items.length === 0) {
      traceLog('No items from any source, returning empty');
      return { items: [], raw: [] };
    }

    const dmCount = items.filter(i => i.type === 'dm').length;
    const spaceCount = items.filter(i => i.type === 'space').length;
    log.client.info(`fetchWorldItems: ${items.length} items (${spaceCount} spaces, ${dmCount} DMs) from ${source}`);

    // Enrich unnamed DMs by resolving member user IDs to display names
    await this.enrichDmNames(items, traceLog);

    // Strip internal fields before returning
    for (const item of items) {
      delete item._memberUserIds;
    }

    return { items, raw };
  }

  /**
   * Resolve display names for unnamed DMs by calling the get_members API.
   * Collects all unique "other" user IDs from DMs that have _memberUserIds
   * but no name, batch-fetches their profiles, and fills in names.
   */
  private async enrichDmNames(
    items: WorldItemSummary[],
    traceLog: (msg: string) => void,
  ): Promise<void> {
    const unnamedDms = items.filter(i => i.type === 'dm' && !i.name && i._memberUserIds?.length);
    if (unnamedDms.length === 0) return;

    // Collect all user IDs that need resolving (exclude self)
    const selfId = this.selfUserId;
    const userIdsToResolve = new Set<string>();
    for (const dm of unnamedDms) {
      for (const uid of dm._memberUserIds!) {
        if (selfId && uid === selfId) continue;
        userIdsToResolve.add(uid);
      }
    }

    if (userIdsToResolve.size === 0) return;

    traceLog(`enrichDmNames: resolving ${userIdsToResolve.size} user IDs for ${unnamedDms.length} unnamed DMs`);

    // Batch-fetch member profiles
    const nameMap = new Map<string, string>();
    const uidArray = Array.from(userIdsToResolve);
    const BATCH_SIZE = 50;

    for (let i = 0; i < uidArray.length; i += BATCH_SIZE) {
      const batch = uidArray.slice(i, i + BATCH_SIZE);
      try {
        const data = await this.apiRequest<unknown[]>(
          'get_members', encodeGetMembersRequest(batch)
        );
        const names = this.parseMemberNames(data);
        for (const [uid, displayName] of Object.entries(names)) {
          nameMap.set(uid, displayName);
        }
      } catch (err) {
        traceLog(`enrichDmNames: get_members batch failed: ${err}`);
      }
    }

    if (nameMap.size === 0) {
      traceLog('enrichDmNames: no names resolved');
      return;
    }

    traceLog(`enrichDmNames: resolved ${nameMap.size} user names`);

    // Apply names to unnamed DMs
    for (const dm of unnamedDms) {
      if (dm.name) continue;

      // Detect self from member list if selfUserId not set
      let detectedSelf = selfId;
      if (!detectedSelf && dm._memberUserIds && dm._memberUserIds.length > 1) {
        // The user ID that appears most across all DMs is likely self.
        // Simpler heuristic: if only 2 members and we resolved one, the
        // other is probably self.
        for (const uid of dm._memberUserIds) {
          if (!nameMap.has(uid) && !detectedSelf) {
            // Couldn't resolve this one — might be self (self often not
            // in get_members response). Only assume if we know nothing.
          }
        }
      }

      const otherNames: string[] = [];
      for (const uid of dm._memberUserIds!) {
        if (detectedSelf && uid === detectedSelf) continue;
        const name = nameMap.get(uid);
        if (name) otherNames.push(name);
      }

      if (otherNames.length > 0) {
        dm.name = otherNames.join(', ');
      }
    }
  }

  async listWorldItems(options: { forceRefresh?: boolean } = {}): Promise<WorldItemSummary[]> {
    const { items } = await this.fetchWorldItems(options);
    return items;
  }

  /**
   * Search /mole/world HTML for PBLite-tagged data (dfe.w.pw arrays).
   *
   * The paginated_world API returns PBLite with a dfe.w.pw tag containing
   * verified notification fields.  The /mole/world HTML embeds data in
   * AF_initDataCallback blocks — most are DS:1 format, but some Google
   * builds inline PBLite-style arrays.  This method looks for any such
   * array and, if found, feeds it to parseWorldItems() which already
   * handles the verified field layout.
   */
  private extractPbliteWorldItems(
    body: string,
    traceLog: (msg: string) => void,
  ): WorldItemSummary[] {
    // Strategy 1: Scan every AF_initDataCallback block for an array whose
    //             first element is the "dfe.w.pw" string tag.
    const cbRegex =
      /AF_initDataCallback\s*\(\s*\{[^}]*?data:\s*(\[[\s\S]*?\])\s*,\s*sideChannel/g;
    let match: RegExpExecArray | null;

    while ((match = cbRegex.exec(body)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        const items = this.findAndParsePbliteWorld(data, traceLog);
        if (items && items.length > 0) {
          return items;
        }
      } catch {
        // JSON parse failures are expected for non-matching blocks
      }
    }

    // Strategy 2: Look for a raw [["dfe.w.pw", ...]] literal anywhere in
    //             the HTML (e.g. in a <script> tag or global assignment).
    const rawIdx = body.indexOf('"dfe.w.pw"');
    if (rawIdx !== -1) {
      // Walk backwards to find the opening '[['
      let start = rawIdx;
      for (let i = rawIdx - 1; i >= Math.max(0, rawIdx - 5); i--) {
        if (body[i] === '[') {
          start = i;
        } else if (body[i] !== '[') {
          break;
        }
      }

      // Find the matching close — use a bracket counter
      if (body[start] === '[') {
        let depth = 0;
        let end = start;
        for (let i = start; i < body.length && i < start + 2_000_000; i++) {
          if (body[i] === '[') depth++;
          else if (body[i] === ']') {
            depth--;
            if (depth === 0) {
              end = i + 1;
              break;
            }
          }
        }

        if (end > start) {
          try {
            const data = JSON.parse(body.slice(start, end));
            const items = this.findAndParsePbliteWorld(data, traceLog);
            if (items && items.length > 0) {
              return items;
            }
          } catch {
            traceLog('extractPbliteWorldItems: raw dfe.w.pw JSON parse failed');
          }
        }
      }
    }

    traceLog('extractPbliteWorldItems: no dfe.w.pw data found in HTML');
    return [];
  }

  /**
   * Recursively search a parsed JSON structure for a dfe.w.pw-tagged
   * PBLite array and feed it to parseWorldItems().  Returns the parsed
   * items or null if the tag isn't found.
   */
  private findAndParsePbliteWorld(
    data: unknown,
    traceLog: (msg: string) => void,
    depth = 0,
  ): WorldItemSummary[] | null {
    if (depth > 10 || !Array.isArray(data)) return null;

    // Direct match: data is [["dfe.w.pw", ...], ...]
    if (
      data.length > 0 &&
      Array.isArray(data[0]) &&
      data[0][0] === 'dfe.w.pw'
    ) {
      traceLog(`findAndParsePbliteWorld: found dfe.w.pw tag at depth ${depth}`);
      // data is the top-level wrapper — parseWorldItems expects this shape
      const items = this.parseWorldItems(data, traceLog);
      if (items.length > 0) return items;
    }

    // data itself is ["dfe.w.pw", ...]
    if (data[0] === 'dfe.w.pw') {
      traceLog(`findAndParsePbliteWorld: data IS dfe.w.pw payload at depth ${depth}`);
      const items = this.parseWorldItems([data], traceLog);
      if (items.length > 0) return items;
    }

    // Recurse into sub-arrays
    for (const child of data) {
      if (Array.isArray(child)) {
        const result = this.findAndParsePbliteWorld(child, traceLog, depth + 1);
        if (result && result.length > 0) return result;
      }
    }

    return null;
  }

  private extractWorldItemsFromMoleWorld(body: string): WorldItemSummary[] {
    const items: WorldItemSummary[] = [];
    const seenIds = new Set<string>();

    const ds1Regex = /AF_initDataCallback\(\{key:\s*'ds:1',\s*hash:\s*'[^']+',\s*data:(\[[\s\S]*?\])\s*,\s*sideChannel/;
    const match = ds1Regex.exec(body);

    if (match) {
      try {
        const data = JSON.parse(match[1]);
        this.findSpaceItemsInDs1(data, items, seenIds);
      } catch {
      }
    }

    if (items.length === 0) {
      const spacePatternRegex = /\[\["space\/(AAAA[A-Za-z0-9_-]{7})","(AAAA[A-Za-z0-9_-]{7})",2\],null,"([^"]{1,200})"/g;
      let spaceMatch;
      while ((spaceMatch = spacePatternRegex.exec(body)) !== null) {
        const [_, spaceIdPath, spaceId, name] = spaceMatch;
        if (spaceIdPath === spaceId && !seenIds.has(spaceId)) {
          seenIds.add(spaceId);
          items.push({
            id: spaceId,
            name: this.decodeEscapedString(name),
            type: 'space',
            unreadCount: 0,
            unreadSubscribedTopicCount: 0,
            unreadReplyCount: 0,
            isSubscribedToSpace: false,
            notificationCategory: 'none',
          });
        }
      }
    }

    return items;
  }

  private findSpaceItemsInDs1(
    data: unknown,
    items: WorldItemSummary[],
    seenIds: Set<string>,
    depth = 0
  ): void {
    if (depth > 15 || !Array.isArray(data)) return;

    if (
      data.length >= 14 &&
      Array.isArray(data[0]) &&
      data[0].length >= 3 &&
      typeof data[0][0] === 'string' &&
      data[0][0].startsWith('space/AAAA')
    ) {
      const spaceId = data[0][1] as string;
      if (!seenIds.has(spaceId)) {
        seenIds.add(spaceId);

        const name = typeof data[2] === 'string' ? data[2] : undefined;
        const hasUnreadFlag = typeof data[6] === 'number' ? data[6] : 0;
        const unreadCount1 = typeof data[11] === 'number' ? data[11] : 0;
        const isSubscribedToSpace = typeof data[12] === 'number' ? data[12] === 1 : false;
        const mentionTimestamp = typeof data[13] === 'number' ? data[13] : undefined;
        let subscribedThreadId: string | undefined;
        if (Array.isArray(data[19]) && typeof data[19][0] === 'string') {
          subscribedThreadId = data[19][0];
        }

        // DS:1 format: extract badge/notification fields at known positions
        // NOTE: These DS:1 field mappings are speculative and not yet verified
        // against the confirmed PBLite model. data[11] is used as badge count,
        // data[7] as read watermark. Last notif-worthy event position is unknown.
        const ds1BadgeCount = unreadCount1 > 0 ? unreadCount1 : undefined;
        const ds1ReadWatermark = this.toOptionalNumber(data[7]);

        const notificationCategory = this.categorizeNotification(
          ds1BadgeCount ?? 0,
          undefined, // last notif-worthy event unknown in DS:1 format
          ds1ReadWatermark,
        );

        items.push({
          id: spaceId,
          name: name ? this.decodeEscapedString(name) : undefined,
          type: 'space',
          unreadCount: hasUnreadFlag,
          unreadSubscribedTopicCount: isSubscribedToSpace ? 1 : 0,
          lastMentionTime: mentionTimestamp,
          unreadReplyCount: unreadCount1,
          subscribedThreadId,
          isSubscribedToSpace,
          notificationCategory,
          badgeCount: ds1BadgeCount,
          readWatermarkTimestamp: ds1ReadWatermark,
        });
      }
      return; 
    }

    if (
      data.length >= 7 &&
      Array.isArray(data[0]) &&
      data[0].length >= 2 &&
      typeof data[0][0] === 'string' &&
      data[0][0].startsWith('dm/')
    ) {
      const dmId = data[0][1] as string; 
      if (!seenIds.has(dmId)) {
        seenIds.add(dmId);

        const name = typeof data[2] === 'string' ? data[2] : undefined;
        const hasUnreadFlag = typeof data[6] === 'number' ? data[6] : 0;
        const actualUnreadCount = typeof data[11] === 'number' ? data[11] : 0;
        const mentionTimestamp = typeof data[13] === 'number' ? data[13] : undefined;

        const unreadCount = actualUnreadCount > 0 ? actualUnreadCount : (hasUnreadFlag ? 1 : 0);

        // DS:1 DM format — badge/watermark mappings are speculative
        const dmBadgeCount = unreadCount > 0 ? unreadCount : undefined;
        const dmReadWatermark = this.toOptionalNumber(data[7]);

        items.push({
          id: dmId,
          name: name ? this.decodeEscapedString(name) : undefined,
          type: 'dm',
          unreadCount: unreadCount,
          unreadSubscribedTopicCount: 0,
          lastMentionTime: mentionTimestamp,
          unreadReplyCount: 0, 
          isSubscribedToSpace: false,
          notificationCategory: this.categorizeNotification(
            dmBadgeCount ?? 0,
            undefined,
            dmReadWatermark,
          ),
          badgeCount: dmBadgeCount,
          readWatermarkTimestamp: dmReadWatermark,
        });
      }
      return; 
    }

    if (
      data.length >= 14 &&
      Array.isArray(data[0]) &&
      data[0].length >= 3 &&
      Array.isArray(data[0][2]) &&
      typeof data[0][2][0] === 'string' &&
      data[0][2][0].startsWith('dm/')
    ) {
      const dmId = data[0][2][0].replace('dm/', '');
      if (!seenIds.has(dmId)) {
        seenIds.add(dmId);

        const hasUnreadFlag = typeof data[6] === 'number' ? data[6] : 0;
        const actualUnreadCount = typeof data[11] === 'number' ? data[11] : 0;
        const mentionTimestamp = typeof data[13] === 'number' ? data[13] : undefined;

        const unreadCount = actualUnreadCount > 0 ? actualUnreadCount : (hasUnreadFlag ? 1 : 0);

        // DS:1 alternate DM format — badge/watermark mappings are speculative
        const dm2BadgeCount = unreadCount > 0 ? unreadCount : undefined;
        const dm2ReadWatermark = this.toOptionalNumber(data[7]);

        items.push({
          id: dmId,
          name: undefined,
          type: 'dm',
          unreadCount: unreadCount,
          unreadSubscribedTopicCount: 0,
          lastMentionTime: mentionTimestamp,
          unreadReplyCount: 0, 
          isSubscribedToSpace: false,
          notificationCategory: this.categorizeNotification(
            dm2BadgeCount ?? 0,
            undefined,
            dm2ReadWatermark,
          ),
          badgeCount: dm2BadgeCount,
          readWatermarkTimestamp: dm2ReadWatermark,
        });
      }
      return;
    }

    for (const item of data) {
      if (Array.isArray(item)) {
        this.findSpaceItemsInDs1(item, items, seenIds, depth + 1);
      }
    }
  }

  /**
   * Categorize notification state based on verified PBLite fields.
   *
   * Visual states in Google Chat UI:
   * - 'badged': numbered badge indicator (readState[6] > "0")
   * - 'lit_up': bold text, no number
   * - 'none':   clean, no indicator
   *
   * Detection priority:
   * 1. badgeCount > 0 → 'badged' (numbered badge)
   * 2. pendingNotificationTimestamp > readWatermark → 'lit_up'
   *    Some DMs keep a stale non-zero pending notification timestamp even after
   *    they have been marked read. Treat it as unread only when it is newer than
   *    the read watermark, or when no watermark is available.
   * 3. lastNotifWorthyEvent > readWatermark → 'lit_up' (timestamp comparison)
   * 4. sortTimestamp > readWatermark → 'lit_up' only when notif-worthy timestamp is absent
   * 5. 'none' (fully read)
   */
  private categorizeNotification(
    badgeCount: number,
    lastNotifWorthyEventTimestamp?: number,
    readWatermarkTimestamp?: number,
    sortTimestamp?: number,
    pendingNotificationTimestamp?: number,
  ): import('./types.js').NotificationCategory {
    if (badgeCount > 0) {
      return 'badged';
    }
    if (pendingNotificationTimestamp != null && pendingNotificationTimestamp > 0) {
      if (readWatermarkTimestamp == null || pendingNotificationTimestamp > readWatermarkTimestamp) {
        return 'lit_up';
      }
    }
    if (
      lastNotifWorthyEventTimestamp != null &&
      readWatermarkTimestamp != null &&
      lastNotifWorthyEventTimestamp > readWatermarkTimestamp
    ) {
      return 'lit_up';
    }
    // Fallback: use sortTimestamp only when we do not have a notif-worthy timestamp.
    if (
      lastNotifWorthyEventTimestamp == null &&
      sortTimestamp != null &&
      readWatermarkTimestamp != null &&
      sortTimestamp > readWatermarkTimestamp
    ) {
      return 'lit_up';
    }
    return 'none';
  }

  private isThreadUnreadSpace(item: WorldItemSummary): boolean {
    return item.type === 'space'
      && item.notificationCategory === 'none'
      && (item.unreadSubscribedTopicCount > 0 || item.unreadReplyCount > 0);
  }

  private isUnreadItem(item: WorldItemSummary): boolean {
    return item.notificationCategory !== 'none' || this.isThreadUnreadSpace(item);
  }

  private partitionNotificationItems(items: WorldItemSummary[]): {
    badgedDMs: WorldItemSummary[];
    badgedSpaces: WorldItemSummary[];
    litupDMs: WorldItemSummary[];
    litupSpaces: WorldItemSummary[];
    threadUnreadSpaces: WorldItemSummary[];
    readItems: WorldItemSummary[];
  } {
    const badgedDMs: WorldItemSummary[] = [];
    const badgedSpaces: WorldItemSummary[] = [];
    const litupDMs: WorldItemSummary[] = [];
    const litupSpaces: WorldItemSummary[] = [];
    const threadUnreadSpaces: WorldItemSummary[] = [];
    const readItems: WorldItemSummary[] = [];

    for (const item of items) {
      if (item.type === 'dm') {
        if (item.notificationCategory === 'badged') {
          badgedDMs.push(item);
        } else if (item.notificationCategory === 'lit_up') {
          litupDMs.push(item);
        } else {
          readItems.push(item);
        }
        continue;
      }

      if (item.notificationCategory === 'badged') {
        badgedSpaces.push(item);
      } else if (item.notificationCategory === 'lit_up') {
        litupSpaces.push(item);
      } else if (this.isThreadUnreadSpace(item)) {
        threadUnreadSpaces.push(item);
      } else {
        readItems.push(item);
      }
    }

    return {
      badgedDMs,
      badgedSpaces,
      litupDMs,
      litupSpaces,
      threadUnreadSpaces,
      readItems,
    };
  }

  private decodeEscapedString(value: string): string {
    return value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  private extractSpacesFromMoleWorld(body: string): Space[] {
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    const decodeName = (value: string): string => {
      return value
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    };

    const addOrUpdateSpace = (spaceId: string, name?: string): void => {
      const existing = spaces.find(space => space.id === spaceId);
      if (existing) {
        if (!existing.name && name) {
          existing.name = name;
        }
        return;
      }

      if (!seenIds.has(spaceId)) {
        seenIds.add(spaceId);
        spaces.push({
          id: spaceId,
          name,
          type: 'space',
        });
      }
    };

    const namedSpaceRegex = /"space\/(AAAA[A-Za-z0-9_-]{7})",\s*"(AAAA[A-Za-z0-9_-]{7})",2\],null,"([^"]{1,200})"/g;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = namedSpaceRegex.exec(body)) !== null) {
      const [_, firstId, secondId, rawName] = nameMatch;
      if (firstId !== secondId) {
        continue;
      }

      const name = decodeName(rawName);
      addOrUpdateSpace(firstId, name || undefined);
    }

    const callbackRegex = /AF_initDataCallback\s*\(\s*\{[^}]*data:\s*(\[[\s\S]*?\])\s*\}\s*\)\s*;/g;
    let match;

    while ((match = callbackRegex.exec(body)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        this.findSpacesInData(data, spaces, seenIds);
      } catch {
      }
    }

    const spaceIdRegex = /"(AAAA[A-Za-z0-9_-]{7})"/g;
    while ((match = spaceIdRegex.exec(body)) !== null) {
      const spaceId = match[1];
      addOrUpdateSpace(spaceId);
    }

    return spaces;
  }

  private findSpacesInData(data: unknown, spaces: Space[], seenIds: Set<string>, depth = 0): void {
    if (depth > 30 || data === null || data === undefined) return;

    if (Array.isArray(data)) {
      let spaceId: string | undefined;
      let spaceName: string | undefined;

      for (const item of data) {
        if (typeof item === 'string') {
          if (item.length === 11 && item.startsWith('AAAA')) {
            spaceId = item;
          }
          else if (
            item.length > 3 &&
            item.length < 80 &&
            !/^\d+$/.test(item) &&
            !item.startsWith('http') &&
            !item.startsWith('AAAA') &&
            (item.includes(' ') || /^[A-Z]/.test(item))
          ) {
            if (spaceName === undefined) {
              spaceName = item;
            }
          }
        } else if (Array.isArray(item)) {
          this.findSpacesInData(item, spaces, seenIds, depth + 1);
        }
      }

      if (spaceId) {
        const existing = spaces.find(space => space.id === spaceId);
        if (existing) {
          if (!existing.name && spaceName) {
            existing.name = spaceName;
          }
        } else if (!seenIds.has(spaceId)) {
          seenIds.add(spaceId);
          spaces.push({
            id: spaceId,
            name: spaceName,
            type: 'space',
          });
        }
      }
    } else if (typeof data === 'object') {
      for (const value of Object.values(data)) {
        this.findSpacesInData(value, spaces, seenIds, depth + 1);
      }
    }
  }

  private parseSpaces(data: unknown): Space[] {
    const spaces: Space[] = [];

    const extract = (arr: unknown[], depth = 0): void => {
      if (depth > 20 || !Array.isArray(arr)) return;

      for (const item of arr) {
        if (!Array.isArray(item)) continue;

        if (item.length > 0 && Array.isArray(item[0])) {
          const inner = item[0];
          if (Array.isArray(inner) && inner.length > 0) {
            const possibleId = inner[0];
            if (typeof possibleId === 'string' && possibleId.length > 8 && possibleId.length < 20) {
              let name: string | undefined;
              let type: 'space' | 'dm' = 'dm';
              let sortTimestamp: number | undefined;

              for (let i = 1; i < Math.min(item.length, 20); i++) {
                const val = item[i];
                if (!name && typeof val === 'string' && val.length > 0 && val.length < 100 && !/^\d+$/.test(val)) {
                  name = val;
                  type = 'space';
                }
                if (!sortTimestamp && typeof val === 'string' && /^\d{13,}$/.test(val)) {
                  sortTimestamp = parseInt(val, 10);
                }
              }

              if (!spaces.find(s => s.id === possibleId)) {
                spaces.push({ id: possibleId, name, type, sortTimestamp });
              }
            }
          }
        }

        extract(item, depth + 1);
      }
    };

    if (Array.isArray(data)) {
      extract(data);
    }

    return spaces;
  }

  private parseTimestampToUsec(value: number | string | undefined): number | undefined {
    if (value === undefined) return undefined;

    if (typeof value === 'string') {
      if (/^\d+$/.test(value)) {
        const numericValue = Number(value);
        return this.parseTimestampToUsec(numericValue);
      }
      const ms = Date.parse(value);
      if (isNaN(ms)) return undefined; 
      return ms * 1000; 
    }

    if (value < 1e13) {
      return value * 1_000_000;
    }

    return value;
  }

	  async getThreads(
	    groupId: string,
	    options: {
      pageSize?: number;
      cursor?: number;
      repliesPerTopic?: number;
      fetchFullThreads?: boolean;
      isDm?: boolean;
      until?: number | string; 
      since?: number | string; 
      format?: 'messages' | 'threaded'; 
      maxThreads?: number;  
      maxMessages?: number; 
      useServerFiltering?: boolean; 
      includeHistory?: boolean; 
    } = {}
  ): Promise<ThreadsResult> {
    const {
      pageSize = 25,
      cursor,
      repliesPerTopic = 50,
      fetchFullThreads = false,
      isDm,
      until,
      since,
      format = 'messages',
      maxThreads,
      maxMessages,
      useServerFiltering,
      includeHistory = false,
    } = options;

    const isDirectMessage = isDm ?? isDmId(groupId);

	    const untilUsec = this.parseTimestampToUsec(until);
	    const sinceUsec = this.parseTimestampToUsec(since);

	    const shouldTryServerFilter =
	      useServerFiltering !== false && (sinceUsec !== undefined || untilUsec !== undefined);
	    
	    let result: ThreadsResult;

	    if (shouldTryServerFilter) {
	      try {
	        log.client.debug('getThreads: Attempting server-side filtering via catch_up_group');
	        const catchUpData = encodeCatchUpGroupRequest(groupId, {
	          sinceUsec,
	          untilUsec,
          pageSize: maxMessages ?? (maxThreads ? maxThreads * repliesPerTopic : 500),
          cutoffSize: maxMessages ?? 2000,
          isDm: isDirectMessage,
        });
        const data = await this.apiRequest<unknown[]>('catch_up_group', catchUpData);
        result = this.parseCatchUpGroupResponse(data, groupId);
        log.client.debug('getThreads: Server-side filtering returned', result.total_topics, 'topics');
        
        if (result.total_topics === 0) {
          log.client.debug('getThreads: Server-side returned 0 topics, falling back to client-side filtering');
          result = await this.fetchTopicsWithClientSideFiltering(groupId, {
            pageSize,
            cursor,
            repliesPerTopic,
            untilUsec,
            sinceUsec,
            isDirectMessage,
            includeHistory,
          });
        }
      } catch (err) {
        log.client.debug('getThreads: Server-side filtering failed, falling back to client-side:', (err as Error).message);
        result = await this.fetchTopicsWithClientSideFiltering(groupId, {
          pageSize,
          cursor,
          repliesPerTopic,
          untilUsec,
          sinceUsec,
          isDirectMessage,
          includeHistory,
        });
      }
    } else {
      result = await this.fetchTopicsWithClientSideFiltering(groupId, {
        pageSize,
        cursor,
        repliesPerTopic,
        untilUsec,
        sinceUsec,
        isDirectMessage,
        includeHistory,
      });
    }

    if (maxThreads !== undefined && result.topics.length > maxThreads) {
      result.topics = result.topics.slice(0, maxThreads);
      const limitedMessages: Message[] = [];
      for (const topic of result.topics) {
        limitedMessages.push(...topic.replies);
      }
      result.messages = limitedMessages;
      result.total_topics = result.topics.length;
      result.total_messages = result.messages.length;
      result.pagination.has_more = true;
    }

    if (maxMessages !== undefined && result.total_messages > maxMessages) {
      let messageCount = 0;
      const limitedTopics: Topic[] = [];
      
      for (const topic of result.topics) {
        const remainingSpace = maxMessages - messageCount;
        if (remainingSpace <= 0) break;
        
        if (topic.replies.length <= remainingSpace) {
          limitedTopics.push(topic);
          messageCount += topic.replies.length;
        } else {
          limitedTopics.push({
            ...topic,
            replies: topic.replies.slice(0, remainingSpace),
            message_count: remainingSpace,
            has_more_replies: true,
          });
          messageCount += remainingSpace;
          break;
        }
      }

      const limitedMessages: Message[] = [];
      for (const topic of limitedTopics) {
        limitedMessages.push(...topic.replies);
      }

      result.topics = limitedTopics;
      result.messages = limitedMessages;
      result.total_topics = limitedTopics.length;
      result.total_messages = limitedMessages.length;
      result.pagination.has_more = true;
    }

    if (fetchFullThreads && result.topics.length > 0) {
      await this.expandThreadMessages(result, groupId, isDirectMessage);
    }

    await this.populateSenderNames(result.messages);

    if (format === 'messages') {
      const firstMessages: Message[] = result.topics.map(topic => {
        return topic.replies[0];
      }).filter((msg): msg is Message => msg !== undefined);

      return {
        messages: firstMessages,
        topics: [], 
        pagination: result.pagination,
        total_topics: result.total_topics,
        total_messages: firstMessages.length,
      };
    }

    return {
      messages: [], 
      topics: result.topics,
      pagination: result.pagination,
      total_topics: result.total_topics,
      total_messages: result.total_messages,
    };
  }

  private parseTopicsResponse(data: unknown[], spaceId: string): ThreadsResult {
    const topics: Topic[] = [];
    const messages: Message[] = [];
    let oldestSortTime: number | undefined;

    const parseTimestamp = (ts: unknown): { formatted?: string; usec?: number } => {
      if (!ts) return {};
      let usec: number | undefined;
      if (typeof ts === 'string' && /^\d+$/.test(ts)) {
        usec = parseInt(ts, 10);
      } else if (typeof ts === 'number') {
        usec = ts;
      }
      if (usec && usec > 1000000000000) {
        const date = new Date(usec / 1000);
        return { formatted: date.toISOString(), usec };
      }
      return { usec };
    };

    const parseMessage = (arr: unknown[], topicId?: string): Message | null => {
      if (!Array.isArray(arr) || arr.length < 10) return null;

      const text = typeof arr[9] === 'string' ? arr[9] : null;
      if (!text) return null;

      const { formatted, usec } = parseTimestamp(arr[2]);

      let messageId: string | undefined;
      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        messageId = arr[0][1];
      }

      let sender: string | undefined;
      let senderId: string | undefined;
      let senderEmail: string | undefined;
      let senderAvatarUrl: string | undefined;
      if (Array.isArray(arr[1])) {
        const creator = arr[1];
        if (!this._debugLoggedCreator) {
          log.client.debug('parseMessage: Creator field structure:', JSON.stringify(creator, null, 2).slice(0, 800));
          this._debugLoggedCreator = true;
        }
        if (Array.isArray(creator[0]) && creator[0].length > 0) {
          senderId = creator[0][0] as string;
        }
        if (typeof creator[1] === 'string' && creator[1].length > 0) {
          sender = creator[1];
        } else {
          sender = senderId;
        }

        if (typeof creator[2] === 'string' && creator[2].length > 0) {
          senderAvatarUrl = creator[2].startsWith('//') ? `https:${creator[2]}` : creator[2];
        }
        if (typeof creator[3] === 'string' && creator[3].length > 0) {
          senderEmail = creator[3];
        }
      }

      const annotations = this.parseAnnotations(arr[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);
      const cards = this.parseCards(arr[14]);

      return {
        message_id: messageId,
        topic_id: topicId,
        space_id: spaceId,
        text,
        timestamp: formatted,
        timestamp_usec: usec,
        sender,
        sender_id: senderId,
        sender_email: senderEmail,
        sender_avatar_url: senderAvatarUrl,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    };

    const extractTopic = (arr: unknown[]): void => {
      if (!Array.isArray(arr)) return;

      let topicId: string | undefined;
      let sortTime: number | undefined;
      const topicMessages: Message[] = [];

      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        topicId = arr[0][1];
      }

      if (arr[1]) {
        const ts = parseTimestamp(arr[1]);
        sortTime = ts.usec;
      }

      if (Array.isArray(arr[6])) {
        for (const msgArr of arr[6]) {
          const msg = parseMessage(msgArr as unknown[], topicId);
          if (msg) topicMessages.push(msg);
        }
      }

      if (topicId && topicMessages.length > 0) {
        if (sortTime && (!oldestSortTime || sortTime < oldestSortTime)) {
          oldestSortTime = sortTime;
        }

        topicMessages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));
        topicMessages.forEach((msg, i) => {
          msg.is_thread_reply = i > 0;
          msg.reply_index = i;
        });

        const hasMoreReplies = topicMessages.length > 1;

        topics.push({
          topic_id: topicId,
          space_id: spaceId,
          sort_time: sortTime,
          message_count: topicMessages.length,
          has_more_replies: hasMoreReplies,
          replies: topicMessages,
        });

        messages.push(...topicMessages);
      }
    };

    if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][1])) {
      for (const topicData of data[0][1]) {
        extractTopic(topicData as unknown[]);
      }
    }

    let containsFirstTopic = false;
    let containsLastTopic = false;

    if (Array.isArray(data) && Array.isArray(data[0])) {
      if (data[0].length > 4) containsFirstTopic = data[0][4] === true;
      if (data[0].length > 5) containsLastTopic = data[0][5] === true;
      
      log.client.debug('parseTopicsResponse: Response structure fields 0-10:', 
        JSON.stringify(data[0].slice(0, 11).map((v: unknown, i: number) => 
          `[${i}]: ${typeof v === 'object' ? JSON.stringify(v)?.slice(0, 100) : v}`
        ))
      );
    }

    const pagination = {
      contains_first_topic: containsFirstTopic,
      contains_last_topic: containsLastTopic,
      has_more: !containsFirstTopic && oldestSortTime !== undefined,
      next_cursor: !containsFirstTopic ? oldestSortTime : undefined,
    };

    return {
      messages,
      topics,
      pagination,
      total_topics: topics.length,
      total_messages: messages.length,
    };
  }

  private async fetchTopicsWithClientSideFiltering(
    groupId: string,
    options: {
      pageSize: number;
      cursor?: number;
      repliesPerTopic: number;
      untilUsec?: number;
      sinceUsec?: number;
      isDirectMessage: boolean;
      includeHistory?: boolean;
    }
  ): Promise<ThreadsResult> {
    const { pageSize, cursor, repliesPerTopic, untilUsec, sinceUsec, isDirectMessage, includeHistory = false } = options;

    if ((sinceUsec || untilUsec) && !cursor) {
      return this.fetchTopicsWithDateRange(groupId, {
        pageSize,
        repliesPerTopic,
        untilUsec,
        sinceUsec,
        isDirectMessage,
        includeHistory,
      });
    }

    const getSortTime = (t: Topic): number | undefined => {
      const st = typeof t.sort_time === 'string' ? parseInt(t.sort_time, 10) : t.sort_time;
      return st || undefined;
    };

    const needsFiltering = cursor || untilUsec || sinceUsec;
    const fetchSize = needsFiltering ? Math.max(pageSize * 2, 50) : pageSize;

    const protoData = encodeListTopicsRequest(groupId, {
      pageSize: fetchSize,
      repliesPerTopic,
      cursor,  
      isDm: isDirectMessage,
      includeHistory,
    });

    const data = await this.apiRequest<unknown[]>('list_topics', protoData);
    let result = this.parseTopicsResponse(data, groupId);

    log.client.debug('fetchTopicsWithClientSideFiltering: Raw API response:', {
      topicsCount: result.topics.length,
      cursor,
      containsFirstTopic: result.pagination.contains_first_topic,
      containsLastTopic: result.pagination.contains_last_topic,
      firstTopicSortTime: result.topics[0]?.sort_time,
      lastTopicSortTime: result.topics[result.topics.length - 1]?.sort_time,
    });

    if (needsFiltering && result.topics.length > 0) {
      let filteredTopics = result.topics;
      if (untilUsec) {
        filteredTopics = filteredTopics.filter(t => {
          const sortTime = getSortTime(t);
          return sortTime !== undefined && sortTime <= untilUsec;
        });
      }

      if (sinceUsec) {
        filteredTopics = filteredTopics.filter(t => {
          const sortTime = getSortTime(t);
          return sortTime !== undefined && sortTime >= sinceUsec;
        });
      }

      if (cursor) {
        filteredTopics = filteredTopics.filter(t => {
          const sortTime = getSortTime(t);
          return sortTime !== undefined && sortTime < cursor;
        });
      }

      const paginatedTopics = filteredTopics.slice(0, pageSize);

      const paginatedMessages: Message[] = [];
      for (const topic of paginatedTopics) {
        paginatedMessages.push(...topic.replies);
      }

      const oldestSortTime = paginatedTopics.length > 0
        ? Math.min(...paginatedTopics.map(t => getSortTime(t) || Infinity))
        : undefined;

      const hasMore = filteredTopics.length > pageSize ||
        (!result.pagination.contains_first_topic && oldestSortTime !== undefined);

      result = {
        messages: paginatedMessages,
        topics: paginatedTopics,
        pagination: {
          contains_first_topic: filteredTopics.length <= pageSize && result.pagination.contains_first_topic,
          contains_last_topic: result.pagination.contains_last_topic,
          has_more: hasMore,
          next_cursor: hasMore ? oldestSortTime : undefined,
        },
        total_topics: paginatedTopics.length,
        total_messages: paginatedMessages.length,
      };
    }

    return result;
  }

  async fetchTopicsWithServerPagination(
    groupId: string,
    options: {
      pageSize?: number;
      sortTimeCursor?: string;
      timestampCursor?: string;
      anchorTimestamp?: string;
      since?: number | string;  
      until?: number | string;  
      isDm?: boolean;           
    } = {}
  ): Promise<ServerTopicsResult> {
    const { pageSize = 30, sortTimeCursor, timestampCursor, anchorTimestamp, since, until, isDm } = options;

    const isDirectMessage = isDm ?? isDmId(groupId);

    const sinceUsec = since ? this.parseTimeToUsec(since) : undefined;
    const untilUsec = until ? this.parseTimeToUsec(until) : undefined;

    const effectiveSortTimeCursor = sortTimeCursor || (untilUsec ? String(untilUsec) : undefined);

    const payload = this.buildListTopicsPayload(groupId, {
      pageSize: 1000,  
      topicsPerPage: pageSize,
      sortTimeCursor: effectiveSortTimeCursor,
      timestampCursor,
      anchorTimestamp,
      isDm: isDirectMessage,
    });

    const data = await this.apiRequestJson<unknown[]>('list_topics', payload, groupId);
    const parsed = this.parseListTopicsResponse(data);

    const topics: Topic[] = [];
    const messages: Message[] = [];

    for (const rawTopic of parsed.topics) {
      if (!Array.isArray(rawTopic)) continue;

      const topicIdObj = rawTopic[0];
      const topicId = Array.isArray(topicIdObj) ? topicIdObj[1] : null;
      const sortTime = rawTopic[1];
      const messageArray = rawTopic[6];

      if (!topicId) continue;

      const sortTimeNum = typeof sortTime === 'string' ? parseInt(sortTime, 10) : sortTime;

      if (untilUsec && sortTimeNum && sortTimeNum > untilUsec) {
        continue;
      }
      if (sinceUsec && sortTimeNum && sortTimeNum < sinceUsec) {
        break;
      }

      const topicMessages: Message[] = [];
      if (Array.isArray(messageArray)) {
        for (const rawMsg of messageArray) {
          if (!Array.isArray(rawMsg)) continue;
          const msg = this.parsePbliteMessage(rawMsg, groupId, topicId);
          if (msg) {
            topicMessages.push(msg);
            messages.push(msg);
          }
        }
      }

      const topic: Topic = {
        topic_id: topicId,
        space_id: groupId,
        sort_time: sortTimeNum,
        message_count: topicMessages.length,
        replies: topicMessages,
      };
      topics.push(topic);
    }

    const lastProcessedTopic = parsed.topics[parsed.topics.length - 1];
    const lastSortTimeStr = lastProcessedTopic ? this.getTopicSortTime(lastProcessedTopic as unknown[]) : null;
    const lastSortTimeNum = lastSortTimeStr ? parseInt(lastSortTimeStr, 10) : null;
    const reachedSinceBoundary = !!(sinceUsec && lastSortTimeNum && lastSortTimeNum < sinceUsec);

    const lastSortTime = lastSortTimeStr;

    const nextSortTimeCursor = lastSortTime 
      ? String(BigInt(lastSortTime) - 1n) 
      : undefined;

    const hasMore = !parsed.containsFirstTopic && 
                    !reachedSinceBoundary && 
                    parsed.topics.length > 0;

    return {
      topics,
      messages,
      pagination: {
        has_more: hasMore,
        next_sort_time_cursor: hasMore ? nextSortTimeCursor : undefined,
        next_timestamp_cursor: parsed.nextTimestampCursor || undefined,
        anchor_timestamp: parsed.anchorTimestamp || anchorTimestamp || undefined,
        contains_first_topic: parsed.containsFirstTopic,
        contains_last_topic: parsed.containsLastTopic,
        reached_since_boundary: reachedSinceBoundary,
      },
      total_topics: topics.length,
      total_messages: messages.length,
    };
  }

  async getAllTopicsWithServerPagination(
    groupId: string,
    options: {
      pageSize?: number;
      maxPages?: number;
      since?: number | string;
      until?: number | string;
      maxTopics?: number;
      maxMessages?: number;
      isDm?: boolean;
    } = {}
  ): Promise<{
    topics: Topic[];
    messages: Message[];
    pagination: {
      pages_loaded: number;
      has_more: boolean;
      reached_since_boundary: boolean;
    };
    total_topics: number;
    total_messages: number;
  }> {
    const {
      pageSize = 30,
      maxPages = 100,
      since,
      until,
      maxTopics,
      maxMessages,
      isDm,
    } = options;

    const sinceUsec = since ? this.parseTimeToUsec(since) : undefined;
    const untilUsec = until ? this.parseTimeToUsec(until) : undefined;

    const allTopics: Topic[] = [];
    const allMessages: Message[] = [];
    let pagesLoaded = 0;
    let hasMore = false;
    let reachedSinceBoundary = false;

    let sortTimeCursor: string | undefined;
    let timestampCursor: string | undefined;
    let anchorTimestamp: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      if (maxTopics !== undefined && allTopics.length >= maxTopics) {
        hasMore = true;
        break;
      }
      if (maxMessages !== undefined && allMessages.length >= maxMessages) {
        hasMore = true;
        break;
      }

      const result = await this.fetchTopicsWithServerPagination(groupId, {
        pageSize,
        sortTimeCursor,
        timestampCursor,
        anchorTimestamp,
        since: sinceUsec,
        until: untilUsec,
        isDm,
      });

      pagesLoaded++;
      allTopics.push(...result.topics);
      allMessages.push(...result.messages);

      if (page === 0 && result.pagination.anchor_timestamp) {
        anchorTimestamp = result.pagination.anchor_timestamp;
      }

      if (result.pagination.reached_since_boundary) {
        reachedSinceBoundary = true;
        break;
      }
      if (!result.pagination.has_more) {
        break;
      }

      sortTimeCursor = result.pagination.next_sort_time_cursor;
      timestampCursor = result.pagination.next_timestamp_cursor;
      hasMore = result.pagination.has_more;
    }

    let finalTopics = allTopics;
    let finalMessages = allMessages;

    if (maxTopics !== undefined && finalTopics.length > maxTopics) {
      finalTopics = finalTopics.slice(0, maxTopics);
      hasMore = true;
    }

    if (maxMessages !== undefined && finalMessages.length > maxMessages) {
      finalMessages = finalMessages.slice(0, maxMessages);
      hasMore = true;
    }

    return {
      topics: finalTopics,
      messages: finalMessages,
      pagination: {
        pages_loaded: pagesLoaded,
        has_more: hasMore,
        reached_since_boundary: reachedSinceBoundary,
      },
      total_topics: finalTopics.length,
      total_messages: finalMessages.length,
    };
  }

  private parseTimeToUsec(value: number | string): number | undefined {
    if (typeof value === 'number') {
      if (value < 1e10) return value * 1_000_000;
      if (value < 1e13) return value * 1_000;
      return value;
    }
    if (typeof value === 'string') {
      if (/^\d+$/.test(value)) {
        return this.parseTimeToUsec(parseInt(value, 10));
      }

      const relativeMatch = value.match(/^(\d+)(m|h|d|w)$/i);
      if (relativeMatch) {
        const amount = parseInt(relativeMatch[1], 10);
        const unit = relativeMatch[2].toLowerCase();
        const now = Date.now();
        let msAgo = 0;
        switch (unit) {
          case 'm': msAgo = amount * 60 * 1000; break;           
          case 'h': msAgo = amount * 60 * 60 * 1000; break;       
          case 'd': msAgo = amount * 24 * 60 * 60 * 1000; break;  
          case 'w': msAgo = amount * 7 * 24 * 60 * 60 * 1000; break; 
        }
        return (now - msAgo) * 1000; 
      }

      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date.getTime() * 1000; 
      }
    }
    return undefined;
  }

  private parsePbliteMessage(rawMsg: unknown[], groupId: string, topicId: string): Message | null {
    try {
      const msgIdObj = rawMsg[0];
      let messageId = '';
      if (Array.isArray(msgIdObj)) {
        messageId = typeof msgIdObj[1] === 'string' ? msgIdObj[1] : '';
      }
      if (!messageId && typeof rawMsg[11] === 'string') {
        messageId = rawMsg[11];
      }
      
      const senderInfo = rawMsg[1];
      let senderId = '';
      let senderName = '';
      let senderEmail = '';
      if (Array.isArray(senderInfo)) {
        senderId = Array.isArray(senderInfo[0]) ? senderInfo[0][0] || '' : '';
        senderName = typeof senderInfo[1] === 'string' ? senderInfo[1] : '';
        senderEmail = typeof senderInfo[3] === 'string' ? senderInfo[3] : '';
      }
      
      const createTime = rawMsg[2];
      const createTimeUsec = typeof createTime === 'string' ? parseInt(createTime, 10) : 
                             typeof createTime === 'number' ? createTime : 0;
      
      let text = '';
      const textContent = rawMsg[9];
      if (typeof textContent === 'string') {
        text = textContent;
      }

      const annotations = this.parseAnnotations(rawMsg[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);

      const cards = this.parseCards(rawMsg[14]);

      return {
        message_id: messageId || `${topicId}-${createTimeUsec}`,
        topic_id: topicId,
        space_id: groupId,
        text,
        sender: senderName || senderEmail || senderId,
        sender_id: senderId,
        timestamp_usec: createTimeUsec,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    } catch (e) {
      log.client.debug('parsePbliteMessage: Failed to parse message', e);
      return null;
    }
  }

  private async fetchTopicsWithDateRange(
    groupId: string,
    options: {
      pageSize: number;
      repliesPerTopic: number;
      untilUsec?: number;
      sinceUsec?: number;
      isDirectMessage: boolean;
      includeHistory?: boolean;
    }
  ): Promise<ThreadsResult> {
    const { pageSize, repliesPerTopic, untilUsec, sinceUsec, isDirectMessage, includeHistory = false } = options;

    const getSortTime = (t: Topic): number | undefined => {
      const st = typeof t.sort_time === 'string' ? parseInt(t.sort_time, 10) : t.sort_time;
      return st || undefined;
    };

    log.client.debug('fetchTopicsWithDateRange: Fetching with date filter', { 
      sinceUsec, 
      untilUsec, 
      pageSize,
      sinceDate: sinceUsec ? new Date(sinceUsec / 1000).toISOString() : undefined,
      untilDate: untilUsec ? new Date(untilUsec / 1000).toISOString() : undefined,
    });

    const fetchSize = 2000;

    const protoData = encodeListTopicsRequest(groupId, {
      pageSize: fetchSize,
      repliesPerTopic,
      isDm: isDirectMessage,
      includeHistory,
    });

    const data = await this.apiRequest<unknown[]>('list_topics', protoData);
    const result = this.parseTopicsResponse(data, groupId);

    log.client.debug(`fetchTopicsWithDateRange: Fetched ${result.topics.length} topics, filtering...`);

    let filteredTopics = result.topics;

    if (untilUsec) {
      filteredTopics = filteredTopics.filter(t => {
        const sortTime = getSortTime(t);
        return sortTime !== undefined && sortTime <= untilUsec;
      });
    }

    if (sinceUsec) {
      filteredTopics = filteredTopics.filter(t => {
        const sortTime = getSortTime(t);
        return sortTime !== undefined && sortTime >= sinceUsec;
      });
    }

    log.client.debug(`fetchTopicsWithDateRange: ${filteredTopics.length} topics match date range`);

    const paginatedTopics = filteredTopics.slice(0, pageSize);

    const paginatedMessages: Message[] = [];
    for (const topic of paginatedTopics) {
      paginatedMessages.push(...topic.replies);
    }

    const oldestSortTime = paginatedTopics.length > 0
      ? Math.min(...paginatedTopics.map(t => getSortTime(t) || Infinity))
      : undefined;

    const hasMore = filteredTopics.length > pageSize;

    return {
      messages: paginatedMessages,
      topics: paginatedTopics,
      pagination: {
        contains_first_topic: result.pagination.contains_first_topic,
        contains_last_topic: result.pagination.contains_last_topic,
        has_more: hasMore,
        next_cursor: hasMore ? oldestSortTime : undefined,
      },
      total_topics: paginatedTopics.length,
      total_messages: paginatedMessages.length,
    };
  }

  private parseCatchUpGroupResponse(data: unknown[], spaceId: string): ThreadsResult {
    const topics: Topic[] = [];
    const messages: Message[] = [];
    const topicMap = new Map<string, Message[]>();
    let oldestSortTime: number | undefined;

    const parseTimestamp = (ts: unknown): { formatted?: string; usec?: number } => {
      if (!ts) return {};
      let usec: number | undefined;
      if (typeof ts === 'string' && /^\d+$/.test(ts)) {
        usec = parseInt(ts, 10);
      } else if (typeof ts === 'number') {
        usec = ts;
      }
      if (usec && usec > 1000000000000) {
        const date = new Date(usec / 1000);
        return { formatted: date.toISOString(), usec };
      }
      return { usec };
    };

    const parseMessage = (arr: unknown[], topicId?: string): Message | null => {
      if (!Array.isArray(arr) || arr.length < 10) return null;

      const text = typeof arr[9] === 'string' ? arr[9] : null;
      if (!text) return null;

      const { formatted, usec } = parseTimestamp(arr[2]);

      let messageId: string | undefined;
      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        messageId = arr[0][1];
      }

      let sender: string | undefined;
      let senderId: string | undefined;
      if (Array.isArray(arr[1])) {
        const creator = arr[1];
        if (Array.isArray(creator[0]) && creator[0].length > 0) {
          senderId = creator[0][0] as string;
        }
        if (typeof creator[1] === 'string' && creator[1].length > 0) {
          sender = creator[1];
        } else {
          sender = senderId;
        }
      }

      const annotations = this.parseAnnotations(arr[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);
      const cards = this.parseCards(arr[14]);

      return {
        message_id: messageId,
        topic_id: topicId,
        space_id: spaceId,
        text,
        timestamp: formatted,
        timestamp_usec: usec,
        sender,
        sender_id: senderId,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    };

    const extractEvents = (arr: unknown[], depth = 0): void => {
      if (depth > 15 || !Array.isArray(arr)) return;

      for (const item of arr) {
        if (!Array.isArray(item)) continue;

        if (item.length > 6 && Array.isArray(item[0]) && typeof item[0][1] === 'string') {
          const topicId = item[0][1];
          
          const sortTimeData = parseTimestamp(item[1]);
          const sortTime = sortTimeData.usec;
          
          if (sortTime && (!oldestSortTime || sortTime < oldestSortTime)) {
            oldestSortTime = sortTime;
          }

          if (Array.isArray(item[6])) {
            const topicMessages: Message[] = [];
            for (const msgArr of item[6]) {
              const msg = parseMessage(msgArr as unknown[], topicId);
              if (msg) topicMessages.push(msg);
            }

            if (topicMessages.length > 0) {
              topicMessages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));
              topicMessages.forEach((msg, i) => {
                msg.is_thread_reply = i > 0;
                msg.reply_index = i;
              });

              topics.push({
                topic_id: topicId,
                space_id: spaceId,
                sort_time: sortTime,
                message_count: topicMessages.length,
                has_more_replies: topicMessages.length > 1,
                replies: topicMessages,
              });

              messages.push(...topicMessages);
            }
          }
          continue;
        }

        if (item.length >= 10 && typeof item[9] === 'string') {
          let topicId: string | undefined;
          if (Array.isArray(item[0])) {
            if (typeof item[0][1] === 'string') {
            }
          }

          const msg = parseMessage(item as unknown[], topicId);
          if (msg) {
            const tid = msg.topic_id || 'unknown';
            if (!topicMap.has(tid)) {
              topicMap.set(tid, []);
            }
            topicMap.get(tid)!.push(msg);
            
            if (msg.timestamp_usec && (!oldestSortTime || msg.timestamp_usec < oldestSortTime)) {
              oldestSortTime = msg.timestamp_usec;
            }
          }
          continue;
        }

        extractEvents(item, depth + 1);
      }
    };

    if (Array.isArray(data)) {
      extractEvents(data);
    }

    if (topicMap.size > 0 && topics.length === 0) {
      for (const [topicId, topicMessages] of topicMap.entries()) {
        topicMessages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));
        topicMessages.forEach((msg, i) => {
          msg.is_thread_reply = i > 0;
          msg.reply_index = i;
        });

        const sortTime = topicMessages[0]?.timestamp_usec;
        topics.push({
          topic_id: topicId,
          space_id: spaceId,
          sort_time: sortTime,
          message_count: topicMessages.length,
          has_more_replies: false,
          replies: topicMessages,
        });

        messages.push(...topicMessages);
      }
    }

    topics.sort((a, b) => (b.sort_time || 0) - (a.sort_time || 0));

    const pagination = {
      contains_first_topic: false, 
      contains_last_topic: topics.length === 0,
      has_more: topics.length > 0 && oldestSortTime !== undefined,
      next_cursor: oldestSortTime,
    };

    return {
      messages,
      topics,
      pagination,
      total_topics: topics.length,
      total_messages: messages.length,
    };
  }

  async getThread(groupId: string, topicId: string, pageSize = 100, isDm?: boolean): Promise<ThreadResult> {
    const isDirectMessage = isDm ?? isDmId(groupId);

    const protoData = encodeListMessagesRequest(groupId, topicId, pageSize, isDirectMessage);
    const data = await this.apiRequest<unknown[]>('list_messages', protoData);
    const thread = this.parseThreadResponse(data, groupId, topicId);
    await this.populateSenderNames(thread.messages);
    return thread;
  }

  private parseThreadResponse(data: unknown[], spaceId: string, topicId: string): ThreadResult {
    const messages: Message[] = [];

    const parseMessage = (arr: unknown[]): Message | null => {
      if (!Array.isArray(arr) || arr.length < 10) return null;

      const text = typeof arr[9] === 'string' ? arr[9] : null;
      if (!text) return null;

      let timestamp: string | undefined;
      let timestampUsec: number | undefined;

      if (arr[2]) {
        const ts = arr[2];
        if (typeof ts === 'string' && /^\d+$/.test(ts)) {
          timestampUsec = parseInt(ts, 10);
        } else if (typeof ts === 'number') {
          timestampUsec = ts;
        }
        if (timestampUsec && timestampUsec > 1000000000000) {
          timestamp = new Date(timestampUsec / 1000).toISOString();
        }
      }

      let messageId: string | undefined;
      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        messageId = arr[0][1];
      }

      let sender: string | undefined;
      let senderId: string | undefined;
      let senderEmail: string | undefined;
      let senderAvatarUrl: string | undefined;
      if (Array.isArray(arr[1])) {
        const creator = arr[1];
        if (Array.isArray(creator[0]) && creator[0].length > 0) {
          senderId = creator[0][0] as string;
        }
        if (typeof creator[1] === 'string' && creator[1].length > 0) {
          sender = creator[1];
        } else {
          sender = senderId;
        }

        if (typeof creator[2] === 'string' && creator[2].length > 0) {
          senderAvatarUrl = creator[2].startsWith('//') ? `https:${creator[2]}` : creator[2];
        }
        if (typeof creator[3] === 'string' && creator[3].length > 0) {
          senderEmail = creator[3];
        }
      }

      const annotations = this.parseAnnotations(arr[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);
      const cards = this.parseCards(arr[14]);

      return {
        message_id: messageId,
        topic_id: topicId,
        space_id: spaceId,
        text,
        timestamp,
        timestamp_usec: timestampUsec,
        sender,
        sender_id: senderId,
        sender_email: senderEmail,
        sender_avatar_url: senderAvatarUrl,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    };

    if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][1])) {
      for (const msgArr of data[0][1]) {
        const msg = parseMessage(msgArr as unknown[]);
        if (msg) messages.push(msg);
      }
    }

    messages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));

    messages.forEach((msg, i) => {
      msg.is_thread_reply = i > 0;
      msg.reply_index = i;
    });

    return {
      messages,
      topic_id: topicId,
      space_id: spaceId,
      total_messages: messages.length,
    };
  }

  private async expandThreadMessages(result: ThreadsResult, groupId: string, isDm?: boolean): Promise<void> {
    const expandedTopics: Topic[] = [];
    const allMessages: Message[] = [];

    for (const topic of result.topics) {
      try {
        const threadResult = await this.getThread(groupId, topic.topic_id, 100, isDm);
        expandedTopics.push({
          ...topic,
          message_count: threadResult.total_messages,
          replies: threadResult.messages,
        });
        allMessages.push(...threadResult.messages);
      } catch {
        expandedTopics.push(topic);
        allMessages.push(...topic.replies);
      }
    }

    result.topics = expandedTopics;
    result.messages = allMessages;
    result.total_messages = allMessages.length;
  }

	  async getAllMessages(
	    spaceId: string,
	    options: {
      maxPages?: number;
      pageSize?: number;
      fetchFullThreads?: boolean;
      since?: number | string;
      until?: number | string;
      maxMessages?: number;
      maxThreads?: number;
      useServerFiltering?: boolean;
    } = {}
  ): Promise<AllMessagesResult> {
    const { 
      maxPages = 10, 
      pageSize = 25, 
      fetchFullThreads = false, 
      since, 
      until,
      maxMessages,
      maxThreads,
      useServerFiltering,
    } = options;

    const allMessages: Message[] = [];
    const allTopics: Topic[] = [];
    let cursor: number | undefined;
    let pagesLoaded = 0;
    let hasMore = false;

    for (let i = 0; i < maxPages; i++) {
      const remainingMessages = maxMessages !== undefined ? maxMessages - allMessages.length : undefined;
      const remainingThreads = maxThreads !== undefined ? maxThreads - allTopics.length : undefined;

      if ((remainingMessages !== undefined && remainingMessages <= 0) ||
          (remainingThreads !== undefined && remainingThreads <= 0)) {
        hasMore = true;
        break;
      }

	      const result = await this.getThreads(spaceId, {
	        pageSize,
	        cursor,
	        fetchFullThreads,
	        since,
	        until,
	        format: 'threaded',
	        maxMessages: remainingMessages,
	        maxThreads: remainingThreads,
	        useServerFiltering,
	      });

	      pagesLoaded++;
	      allTopics.push(...result.topics);
	      for (const topic of result.topics) {
	        allMessages.push(...topic.replies);
	      }
	      hasMore = result.pagination.has_more;

	      if (!result.pagination.has_more || !result.pagination.next_cursor) {
	        break;
	      }

      if ((maxMessages !== undefined && allMessages.length >= maxMessages) ||
          (maxThreads !== undefined && allTopics.length >= maxThreads)) {
        hasMore = true;
        break;
      }

      cursor = result.pagination.next_cursor;
    }

    const seen = new Set<string>();
    const unique = allMessages.filter(msg => {
      const key = msg.message_id || msg.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let finalMessages = unique;
    let finalTopics = allTopics;

    if (maxMessages !== undefined && finalMessages.length > maxMessages) {
      finalMessages = finalMessages.slice(0, maxMessages);
      hasMore = true;
    }

    if (maxThreads !== undefined && finalTopics.length > maxThreads) {
      finalTopics = finalTopics.slice(0, maxThreads);
      hasMore = true;
    }

    return {
      messages: finalMessages,
      topics: finalTopics,
      pages_loaded: pagesLoaded,
      has_more: hasMore,
    };
  }

  async searchInSpace(spaceId: string, query: string, limit = 50): Promise<SearchMatch[]> {
    const result = await this.getThreads(spaceId, { pageSize: limit });
    const queryLower = query.toLowerCase();

    const matches: SearchMatch[] = [];
    for (const msg of result.messages) {
      if (msg.text.toLowerCase().includes(queryLower)) {
        const idx = msg.text.toLowerCase().indexOf(queryLower);
        const start = Math.max(0, idx - 40);
        const end = Math.min(msg.text.length, idx + query.length + 40);

        matches.push({
          ...msg,
          snippet: msg.text.slice(start, end),
        });
      }
    }

    return matches;
  }

  async searchAllSpaces(query: string, maxSpaces = 20, messagesPerSpace = 50): Promise<SearchMatch[]> {
    const spaces = await this.listSpaces();
    const queryLower = query.toLowerCase();
    const allMatches: SearchMatch[] = [];

    for (const space of spaces.slice(0, maxSpaces)) {
      try {
        const result = await this.getThreads(space.id, { pageSize: messagesPerSpace });

        for (const msg of result.messages) {
          if (msg.text.toLowerCase().includes(queryLower)) {
            const idx = msg.text.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - 40);
            const end = Math.min(msg.text.length, idx + query.length + 40);

            allMatches.push({
              ...msg,
              space_name: space.name,
              snippet: msg.text.slice(start, end),
            });
          }
        }
      } catch {
      }
    }

    allMatches.sort((a, b) => (b.timestamp_usec || 0) - (a.timestamp_usec || 0));

    return allMatches;
  }

  async findSpaces(query: string): Promise<Space[]> {
    const spaces = await this.listSpaces();
    const queryLower = query.toLowerCase();

    return spaces.filter(s =>
      s.name?.toLowerCase().includes(queryLower) ||
      s.id.toLowerCase().includes(queryLower)
    );
  }

  async getSelfUser(): Promise<SelfUser> {
    const statusData = await this.apiRequest<unknown[]>(
      'get_self_user_status',
      encodeGetSelfUserStatusRequest()
    );

    let userId = '';

    if (Array.isArray(statusData) && Array.isArray(statusData[0])) {
      const wrapper = statusData[0];
      if (Array.isArray(wrapper[1]) && Array.isArray(wrapper[1][0])) {
        userId = (wrapper[1][0][0] as string) || '';
      }
    }

    this.selfUserId = userId;

    if (!userId) {
      return { userId };
    }

    try {
      const membersData = await this.apiRequest<unknown[]>(
        'get_members',
        encodeGetMembersRequest([userId])
      );
      const userInfo = this.parseFullUserInfo(membersData, userId);
      return {
        userId,
        ...userInfo,
      };
    } catch {
      return { userId };
    }
  }

  private parseFullUserInfo(
    data: unknown,
    targetUserId: string
  ): Omit<SelfUser, 'userId'> {
    const payload =
      Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
        ? data[0]
        : data;

    const members = this.getPbliteField<unknown[]>(payload, 1);

    if (!Array.isArray(members)) {
      return {};
    }

    for (const member of members) {
      const user = this.getPbliteField<unknown[]>(member, 1);
      if (!user) {
        continue;
      }

      const userId = this.getNestedPbliteString(user, 1, 1);
      if (userId !== targetUserId) {
        continue;
      }

      return {
        name: this.getPbliteField<string>(user, 2),
        avatarUrl: this.getPbliteField<string>(user, 3),
        email: this.getPbliteField<string>(user, 4),
        firstName: this.getPbliteField<string>(user, 5),
        lastName: this.getPbliteField<string>(user, 6),
      };
    }

    return {};
  }

  isMentioned(message: Message): boolean {
    if (!this.selfUserId || !message.mentions) return false;
    return message.mentions.some(
      (m) => m.user_id === this.selfUserId || m.mention_type === 'all'
    );
  }

  isDirectlyMentioned(message: Message): boolean {
    if (!this.selfUserId || !message.mentions) return false;
    return message.mentions.some(
      (m) => m.user_id === this.selfUserId && m.mention_type === 'user'
    );
  }

  hasAllMention(message: Message): boolean {
    if (!message.mentions) return false;
    return message.mentions.some((m) => m.mention_type === 'all');
  }

  getSelfUserId(): string | undefined {
    return this.selfUserId;
  }

  async listDMs(options: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
    forceRefresh?: boolean;
  } = {}): Promise<{
    dms: Array<{
      id: string;
      name?: string;
      unreadCount: number;
      lastMentionTime?: number;
      unreadReplyCount?: number;
      notificationCategory?: string;
    }>;
    total: number;
    pagination: {
      offset: number;
      limit: number;
      hasMore: boolean;
    };
  }> {
    const { limit = 50, offset = 0, unreadOnly = false, forceRefresh = false } = options;

    const { items } = await this.fetchWorldItems({ forceRefresh });
    let dmItems = items.filter(i => i.type === 'dm');

    if (unreadOnly) {
      dmItems = dmItems.filter(i => i.unreadCount > 0 || i.notificationCategory !== 'none');
    }

    const total = dmItems.length;

    const paginatedItems = dmItems.slice(offset, limit > 0 ? offset + limit : undefined);

    const dms = paginatedItems.map(dm => ({
      id: dm.id,
      name: dm.name,
      unreadCount: dm.unreadCount,
      lastMentionTime: dm.lastMentionTime,
      unreadReplyCount: dm.unreadReplyCount,
      notificationCategory: dm.notificationCategory,
    }));

    return {
      dms,
      total,
      pagination: {
        offset,
        limit,
        hasMore: offset + paginatedItems.length < total,
      },
    };
  }

  async getDMThreads(
    dmId: string,
    options: {
      pageSize?: number;
      repliesPerTopic?: number;
      cursor?: number;
      fetchFullThreads?: boolean;
      until?: number | string;
      since?: number | string;
      format?: 'messages' | 'threaded';
      maxThreads?: number;
      maxMessages?: number;
      useServerFiltering?: boolean;
    } = {}
  ): Promise<ThreadsResult> {
    return this.getThreads(dmId, { ...options, isDm: true });
  }

  async getDMs(options: {
    limit?: number;
    offset?: number;
    messagesPerDM?: number;
    parallel?: number;
    unreadOnly?: boolean;
    includeMessages?: boolean;
    forceRefresh?: boolean;
  } = {}): Promise<{
    dms: Array<{
      id: string;
      name?: string;
      unreadCount: number;
      lastMentionTime?: number;
      unreadReplyCount?: number;
      notificationCategory?: string;
      messages?: Message[];
    }>;
    total: number;
    pagination: {
      offset: number;
      limit: number;
      hasMore: boolean;
    };
  }> {
    const {
      limit = 0,
      offset = 0,
      messagesPerDM = 10,
      parallel = 5,
      unreadOnly = false,
      includeMessages = true,
      forceRefresh = false,
    } = options;

    const { items } = await this.fetchWorldItems({ forceRefresh });
    let dmItems = items.filter(i => i.type === 'dm');

    if (unreadOnly) {
      dmItems = dmItems.filter(i => i.unreadCount > 0 || i.notificationCategory !== 'none');
    }

    const total = dmItems.length;

    const paginatedItems = dmItems.slice(offset, limit > 0 ? offset + limit : undefined);

    if (!includeMessages) {
      const dms = paginatedItems.map(dm => ({
        id: dm.id,
        name: dm.name,
        unreadCount: dm.unreadCount,
        lastMentionTime: dm.lastMentionTime,
        unreadReplyCount: dm.unreadReplyCount,
        notificationCategory: dm.notificationCategory,
      }));

      return {
        dms,
        total,
        pagination: {
          offset,
          limit,
          hasMore: offset + paginatedItems.length < total,
        },
      };
    }

    const results: Array<{
      id: string;
      name?: string;
      unreadCount: number;
      lastMentionTime?: number;
      unreadReplyCount?: number;
      notificationCategory?: string;
      messages: Message[];
    }> = [];

    for (let i = 0; i < paginatedItems.length; i += parallel) {
      const batch = paginatedItems.slice(i, i + parallel);
      const batchResults = await Promise.allSettled(
        batch.map(async (dm) => {
          const threadResult = await this.getThreads(dm.id, { pageSize: messagesPerDM, isDm: true });
          return {
            id: dm.id,
            name: dm.name,
            unreadCount: dm.unreadCount,
            lastMentionTime: dm.lastMentionTime,
            unreadReplyCount: dm.unreadReplyCount,
            notificationCategory: dm.notificationCategory,
            messages: threadResult.messages,
          };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }
    }

    return {
      dms: results,
      total,
      pagination: {
        offset,
        limit,
        hasMore: offset + results.length < total,
      },
    };
  }

  async sendMessage(spaceId: string, text: string): Promise<SendMessageResult> {
    try {
      const protoData = encodeCreateTopicRequest(spaceId, text);
      const data = await this.apiRequest<unknown[]>('create_topic', protoData);
      return this.parseSendResponse(data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async replyToThread(
    spaceId: string,
    topicId: string,
    text: string
  ): Promise<SendMessageResult> {
    try {
      const protoData = encodeCreateMessageRequest(spaceId, topicId, text);
      const data = await this.apiRequest<unknown[]>('create_message', protoData);
      return this.parseSendResponse(data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ─── Image Upload ────────────────────────────────────────────────────────────

  /**
   * Upload an image to Google Chat using the raw upload protocol.
   * Returns the attachment token needed for the UPLOAD_METADATA annotation.
   *
   * Uses a single-request upload via `upload_protocol=raw`, which sends
   * the file data directly and returns a protobuf response containing the
   * attachment token.
   */
  async uploadImage(
    spaceId: string,
    filePath: string,
    localId: string,
    topicId?: string,
  ): Promise<{ attachmentToken: string }> {
    await this.ensureAuth();

    const fileData = readFileSync(filePath);
    const fileName = basename(filePath);
    const ext = extname(filePath).toLowerCase().replace('.', '');
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      svg: 'image/svg+xml',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    if (!this.bridge) {
      throw new Error('Image upload requires a bridge (proxy or extension)');
    }

    const tid = topicId || localId;
    const mid = localId;

    // Single-request upload via raw protocol — no resumable session needed.
    const uploadUrl = `${API_BASE}/uploads?group_id=${spaceId}&topic_id=${tid}` +
      `&message_id=${mid}&otr=false&transcoded_video=false` +
      `&upload_type=ATTACHMENT&original_content_type=undefined` +
      `&upload_protocol=raw`;

    const uploadHeaders: Record<string, string> = {
      'chat-filename': encodeURIComponent(fileName),
      'Content-Type': mimeType,
      'x-goog-upload-header-content-type': mimeType,
      'x-goog-upload-content-length': String(fileData.length),
    };

    const result = await this.bridge.proxyRequest(
      uploadUrl, 'POST', uploadHeaders, fileData, 60_000,
    );

    if (!result.ok) {
      throw new Error(`Image upload failed: ${result.status} - ${result.body.slice(0, 300)}`);
    }

    // Response is base64-encoded protobuf. Decode and extract the attachment token.
    // The token starts with "AOo0EE" and is the first long string in the protobuf.
    let attachmentToken = '';
    try {
      const decoded = Buffer.from(result.body, 'base64').toString('utf8');
      const m = decoded.match(/AOo0EE[A-Za-z0-9+/=]{50,}/);
      if (m) attachmentToken = m[0];
    } catch {
      // Fallback: try reading the raw body
      const m = result.body.match(/AOo0EE[A-Za-z0-9+/=]{50,}/);
      if (m) attachmentToken = m[0];
    }

    if (!attachmentToken) {
      throw new Error('Failed to extract attachment_token from upload response. Body: ' + result.body.slice(0, 500));
    }

    log.client.info(`uploadImage: token length=${attachmentToken.length}, file=${fileName}`);
    return { attachmentToken };
  }

  /**
   * Send a message with an image to a space.
   * Uploads the image first, then sends the message with an UPLOAD_METADATA
   * annotation via the protobuf path (which works reliably through the proxy).
   */
  async sendMessageWithImage(
    spaceId: string,
    text: string,
    imagePath: string,
  ): Promise<SendMessageResult> {
    try {
      const localId = `node-${Date.now()}-${randomUUID().slice(0, 8)}`;

      // Step 1: Upload the image
      const { attachmentToken } = await this.uploadImage(spaceId, imagePath, localId);

      // Step 2: Send the message with upload annotation via protobuf
      const fileData = readFileSync(imagePath);
      const fileName = basename(imagePath);
      const ext = extname(imagePath).toLowerCase().replace('.', '');
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp',
      };
      const mimeType = mimeMap[ext] || 'image/png';
      const sha256hex = createHash('sha256').update(fileData).digest('hex');

      const uploadAnnotation: UploadAnnotationOptions = {
        attachmentToken,
        filename: fileName,
        contentType: mimeType,
        fileSize: fileData.length,
        sha256hex,
      };

      const protoData = encodeCreateTopicRequest(spaceId, text, localId, undefined, uploadAnnotation);
      const data = await this.apiRequest<unknown[]>('create_topic', protoData);
      return this.parseSendResponse(data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Reply with an image to an existing thread.
   * Uploads the image first, then sends the reply with an UPLOAD_METADATA
   * annotation via the protobuf path.
   */
  async replyWithImage(
    spaceId: string,
    topicId: string,
    text: string,
    imagePath: string,
  ): Promise<SendMessageResult> {
    try {
      const localId = `node-${Date.now()}-${randomUUID().slice(0, 8)}`;

      const { attachmentToken } = await this.uploadImage(spaceId, imagePath, localId, topicId);

      const fileData = readFileSync(imagePath);
      const fileName = basename(imagePath);
      const ext = extname(imagePath).toLowerCase().replace('.', '');
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp',
      };
      const mimeType = mimeMap[ext] || 'image/png';
      const sha256hex = createHash('sha256').update(fileData).digest('hex');

      const uploadAnnotation: UploadAnnotationOptions = {
        attachmentToken,
        filename: fileName,
        contentType: mimeType,
        fileSize: fileData.length,
        sha256hex,
      };

      const protoData = encodeCreateMessageRequest(spaceId, topicId, text, localId, undefined, uploadAnnotation);
      const data = await this.apiRequest<unknown[]>('create_message', protoData);
      return this.parseSendResponse(data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ─── Mark As Read ───────────────────────────────────────────────────────────

  async markAsRead(
    groupId: string,
    unreadCount?: number
  ): Promise<MarkGroupReadstateResult> {
    if (this.bridge) {
      log.client.info(`markAsRead: extension mode – trying batchexecute for ${groupId}`);
      const batchResult = await this.markAsReadBatchExecute(groupId, unreadCount);
      if (batchResult.success) {
        return this.clearUnreadTimestamp(groupId, batchResult);
      }

      log.client.info(`markAsRead: batchexecute failed (${batchResult.error}), trying proto path`);
      const protoResult = await this.markGroupReadstateProto(groupId);
      if (protoResult.success) {
        return this.clearUnreadTimestamp(groupId, protoResult);
      }

      log.client.info(`markAsRead: proto path failed (${protoResult.error}), trying JSON`);
      const jsonResult = await this.markAsReadJson(groupId);
      if (jsonResult.success) {
        return this.clearUnreadTimestamp(groupId, jsonResult);
      }

      log.client.info(`markAsRead: JSON path failed (${jsonResult.error}), trying unread-timestamp clear only`);
      return this.setMarkAsUnreadTimestamp(groupId, 0);
    }

    log.client.info(`markAsRead: trying batchexecute for ${groupId}`);
    const batchResult = await this.markAsReadBatchExecute(groupId, unreadCount);
    if (batchResult.success) {
      log.client.info(`markAsRead: batchexecute succeeded`);
      return this.clearUnreadTimestamp(groupId, batchResult);
    }

    log.client.info(`markAsRead: batchexecute failed (${batchResult.error}), trying JSON`);
    const jsonResult = await this.markAsReadJson(groupId);
    if (jsonResult.success) {
      return this.clearUnreadTimestamp(groupId, jsonResult);
    }

    log.client.info(`markAsRead: JSON path failed (${jsonResult.error}), trying unread-timestamp clear only`);
    return this.setMarkAsUnreadTimestamp(groupId, 0);
  }

  private async clearUnreadTimestamp(
    groupId: string,
    result: MarkGroupReadstateResult,
  ): Promise<MarkGroupReadstateResult> {
    if (!result.success) {
      return result;
    }

    const clearResult = await this.setMarkAsUnreadTimestamp(groupId, 0);
    if (!clearResult.success) {
      return {
        success: false,
        groupId,
        error: clearResult.error,
        lastReadTime: result.lastReadTime,
        unreadMessageCount: result.unreadMessageCount,
      };
    }

    return {
      ...result,
      lastReadTime: clearResult.lastReadTime ?? result.lastReadTime,
      unreadMessageCount: clearResult.unreadMessageCount ?? result.unreadMessageCount,
    };
  }

  private async setMarkAsUnreadTimestamp(
    groupId: string,
    timestampMicros: number,
  ): Promise<MarkGroupReadstateResult> {
    try {
      const isDirectMessage = isDmId(groupId);
      const payload: unknown[] = new Array(99).fill(null);
      payload[0] = isDirectMessage ? [null, null, [groupId]] : [[groupId]];
      payload[1] = timestampMicros;
      payload[98] = this.buildMutationRequestHeader();

      const data = await this.apiRequestJson<unknown[]>('set_mark_as_unread_timestamp', payload, groupId);
      return this.parseMarkReadstateResponse(data, groupId);
    } catch (error) {
      return {
        success: false,
        groupId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async setThreadMarkAsUnreadTimestamp(
    spaceId: string,
    topicId: string,
    timestampMicros: number,
  ): Promise<MarkGroupReadstateResult> {
    const candidates: unknown[][] = [];
    const groupRef = isDmId(spaceId) ? [null, null, [spaceId]] : [[spaceId]];

    const threadRefPayload = new Array(99).fill(null);
    threadRefPayload[0] = [null, topicId, groupRef];
    threadRefPayload[1] = timestampMicros;
    threadRefPayload[98] = this.buildMutationRequestHeader();
    candidates.push(threadRefPayload);

    const topicIdPayload = new Array(99).fill(null);
    topicIdPayload[0] = [[[spaceId]], topicId];
    topicIdPayload[1] = timestampMicros;
    topicIdPayload[98] = this.buildMutationRequestHeader();
    candidates.push(topicIdPayload);

    let lastError = 'Unknown error';
    for (const payload of candidates) {
      try {
        const data = await this.apiRequestJson<unknown[]>('set_mark_as_unread_timestamp', payload, spaceId);
        return this.parseMarkReadstateResponse(data, spaceId);
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    return {
      success: false,
      groupId: spaceId,
      error: lastError,
    };
  }

  private async markTopicReadstate(
    spaceId: string,
    topicId: string,
    timestampMicros: number,
  ): Promise<MarkGroupReadstateResult> {
    const requestHeaders = [
      this.buildMutationRequestHeader(),
      this.buildPbliteRequestHeader(),
    ];

    let lastFailure: MarkGroupReadstateResult | undefined;
    for (const requestHeader of requestHeaders) {
      try {
        const payload: unknown[] = new Array(99).fill(null);
        payload[0] = [null, topicId, isDmId(spaceId) ? [null, null, [spaceId]] : [[spaceId]]];
        payload[1] = timestampMicros;
        payload[98] = requestHeader;

        const data = await this.apiRequestJson<unknown[]>('mark_topic_readstate', payload, spaceId);
        log.client.debug(`mark_topic_readstate raw response: ${JSON.stringify(data).slice(0, 500)}`);

        // Parse the topic readstate response.  The dfe.rs.mtrs wrapper
        // contains a readState array with this layout:
        //   [0] = identity (user + topic ref)
        //   [1] = last_read_time (string usec)
        //   [3] = unread_count (string)
        //   [6] = subscription_state (-1 is normal, NOT an error)
        //   [7] = server_timestamp
        // A genuine failure is an HTTP error or a missing/malformed response;
        // the value at field 6 is NOT a status code.
        return this.parseTopicReadstateResponse(data, spaceId);
      } catch (error) {
        lastFailure = {
          success: false,
          groupId: spaceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    return lastFailure ?? {
      success: false,
      groupId: spaceId,
      error: 'Unknown error',
    };
  }

  private async getLatestThreadTimestamp(spaceId: string, topicId: string): Promise<number> {
    try {
      const thread = await this.getThread(spaceId, topicId, 100);
      const latest = thread.messages[thread.messages.length - 1]?.timestamp_usec;
      log.client.info('getLatestThreadTimestamp', JSON.stringify({
        spaceId,
        topicId,
        totalMessages: thread.messages.length,
        latestTimestamp: latest,
      }));
      return latest ?? Date.now() * 1000;
    } catch {
      return Date.now() * 1000;
    }
  }

  private async markGroupReadstateProto(
    groupId: string,
    timestampMicros?: number,
  ): Promise<MarkGroupReadstateResult> {
    try {
      const protoData = encodeMarkGroupReadstateRequest(groupId, timestampMicros);
      const data = await this.apiRequest<unknown[]>('mark_group_readstate', protoData);
      return this.parseMarkReadstateResponse(data, groupId);
    } catch (error) {
      return {
        success: false,
        groupId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async markAsReadBatchExecute(
    groupId: string,
    unreadCount?: number
  ): Promise<MarkGroupReadstateResult> {
    try {
      await this.ensureAuth();

      const isDirectMessage = isDmId(groupId);
      const groupPrefix = isDirectMessage ? 'dm' : 'space';
      const fullGroupId = `${groupPrefix}/${groupId}`;
      const count = unreadCount ?? 1;

      log.client.debug(`markAsReadBatch: groupId=${groupId}, fullGroupId=${fullGroupId}, isDm=${isDirectMessage}, count=${count}`);

      const innerParams = JSON.stringify([null, [fullGroupId, groupId, count]]);
      const rpcCall = [[['G23hcc', innerParams, null, 'generic']]];
      const atToken = `${this.auth!.xsrfToken}:${Date.now()}`;
      const requestBody = `f.req=${encodeURIComponent(JSON.stringify(rpcCall))}&at=${encodeURIComponent(atToken)}`;

      log.client.debug(`markAsReadBatch: requestBody=${requestBody.slice(0, 500)}`);

      const url = `${API_BASE}/_/DynamiteWebUi/data/batchexecute?rpcids=G23hcc&source-path=/u/0/mole/world&bl=boq_dynamiteuiserver_20260113.02_p1&hl=en&soc-app=1&soc-platform=1&soc-device=1&rt=c`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Origin': 'https://chat.google.com',
        'Referer': 'https://chat.google.com/',
        'User-Agent': USER_AGENT,
        'x-same-domain': '1',
      };

      const response = this.bridge
        ? await this.bridge.proxyRequest(url, 'POST', headers, requestBody).then((result) => new Response(result.body, { status: result.status }))
        : await fetch(url, {
            method: 'POST',
            headers: {
              'Cookie': this.auth!.cookieString,
              ...headers,
            },
            body: requestBody,
          });

      const text = await response.text();
      log.client.debug(`markAsReadBatch: status=${response.status}, response=${text.slice(0, 500)}`);

      if (!response.ok) {
        return {
          success: false,
          groupId,
          error: `Batchexecute failed: ${response.status} - ${text.slice(0, 200)}`,
        };
      }

      if (text.includes('"error"') || text.includes('Error')) {
        return {
          success: false,
          groupId,
          error: `Batchexecute response error: ${text.slice(0, 200)}`,
        };
      }

      return {
        success: true,
        groupId,
        unreadMessageCount: 0,
      };
    } catch (error) {
      log.client.error(`markAsReadBatch: error=${error instanceof Error ? error.message : error}`);
      return {
        success: false,
        groupId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async markAsReadJson(
    groupId: string,
    lastReadTimeMicros?: number
  ): Promise<MarkGroupReadstateResult> {
    try {
      const timestamp = lastReadTimeMicros ?? Date.now() * 1000;
      const isDirectMessage = isDmId(groupId);
      log.client.debug(`markAsReadJson: groupId=${groupId}, timestamp=${timestamp}, isDm=${isDirectMessage}`);

      // 99-element pblite payload matching the mark_group_readstate JSON API.
      // Field 1 = spaceId wrapper → [[groupId]] for spaces
      // Field 3 = dmId wrapper   → [null, null, [groupId]] for DMs (pblite field 3)
      const payload: unknown[] = new Array(99).fill(null);
      payload[0]  = isDirectMessage ? [null, null, [groupId]] : [[groupId]];
      payload[1]  = timestamp;
      payload[98] = this.buildMutationRequestHeader();

      log.client.debug(`markAsReadJson: payload[0]=${JSON.stringify(payload[0])}`);

      await this.apiRequestJson<unknown[]>('mark_group_readstate', payload, groupId);
      log.client.info(`markAsReadJson: success for ${groupId}`);

      return { success: true, groupId };
    } catch (error) {
      log.client.error(`markAsReadJson: error=${error instanceof Error ? error.message : error}`);
      return {
        success: false,
        groupId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Mark a space or DM as unread.
   *
   * Uses `mark_group_readstate` with timestamp=0 to reset the read watermark
   * so Google Chat displays the bold/badge indicator again. A specific
   * microsecond timestamp can be provided to mark as unread from that point.
   */
  async markAsUnread(
    groupId: string,
    timestampMicros?: number
  ): Promise<MarkGroupReadstateResult> {
    const ts = timestampMicros ?? 0;
    const isDirectMessage = isDmId(groupId);

    if (isDirectMessage) {
      log.client.info(`markAsUnread: trying set_mark_as_unread_timestamp for ${groupId}`);
      const unreadTimestampResult = await this.setMarkAsUnreadTimestamp(groupId, ts);
      if (unreadTimestampResult.success) {
        return unreadTimestampResult;
      }

      log.client.info(`markAsUnread: set_mark_as_unread_timestamp failed (${unreadTimestampResult.error}), falling back`);
    }

    if (this.bridge) {
      log.client.info(`markAsUnread: extension mode – trying proto path for ${groupId}`);
      const protoResult = await this.markGroupReadstateProto(groupId, ts);
      if (protoResult.success) {
        return protoResult;
      }

      log.client.info(`markAsUnread: proto path failed (${protoResult.error}), trying JSON`);
    }

    try {
      log.client.debug(`markAsUnread: groupId=${groupId}, timestamp=${ts}, isDm=${isDirectMessage}`);

      const payload: unknown[] = new Array(99).fill(null);
      payload[0]  = isDirectMessage ? [null, null, [groupId]] : [[groupId]];
      payload[1]  = ts;
      payload[98] = this.buildMutationRequestHeader();

      await this.apiRequestJson<unknown[]>('mark_group_readstate', payload, groupId);
      log.client.debug(`markAsUnread: success for ${groupId}`);

      return { success: true, groupId };
    } catch (error) {
      log.client.error(`markAsUnread: error=${error instanceof Error ? error.message : error}`);
      return {
        success: false,
        groupId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async markThreadAsRead(
    spaceId: string,
    topicId: string,
    timestampMicros?: number,
  ): Promise<MarkGroupReadstateResult> {
    const timestamp = timestampMicros ?? await this.getLatestThreadTimestamp(spaceId, topicId);
    const markResult = await this.markTopicReadstate(spaceId, topicId, timestamp);

    if (!markResult.success) {
      return markResult;
    }

    // After mark_topic_readstate succeeds, clear the unread timestamp to
    // remove the promoted-thread indicator from paginated_world.
    // Try thread-level first, then fall back to space-level clear (which is
    // how clearUnreadTimestamp works for regular markAsRead).
    let clearResult = await this.setThreadMarkAsUnreadTimestamp(spaceId, topicId, 0);
    if (!clearResult.success) {
      log.client.debug(
        `markThreadAsRead: thread-level unread clear failed (${clearResult.error}), trying space-level`
      );
      clearResult = await this.setMarkAsUnreadTimestamp(spaceId, 0);
    }
    if (!clearResult.success) {
      log.client.warn(
        `markThreadAsRead: mark_topic_readstate OK but clearing unread timestamp failed: ${clearResult.error}`
      );
      // Still return success — the readstate itself was marked correctly.
      // Record this thread as recently marked so parseWorldItems suppresses
      // the stale readState[20] indicator.
      this.markedThreads.set(`${spaceId}/${topicId}`, Date.now());
      this.pruneMarkedThreadsCache();
      return markResult;
    }

    // Record this thread as recently marked so parseWorldItems can suppress
    // the stale readState[20] indicator from paginated_world.
    this.markedThreads.set(`${spaceId}/${topicId}`, Date.now());
    this.pruneMarkedThreadsCache();

    // Also advance the space-level read watermark.  paginated_world has a
    // "last activity" timestamp (readState[5]) that the UI compares against
    // the read watermark (readState[1]).  mark_topic_readstate only touches
    // the thread readstate, not the space watermark, so without this the
    // space can still show a blue dot even though the thread is read.
    const spaceMarkResult = await this.markAsReadJson(spaceId);
    if (!spaceMarkResult.success) {
      log.client.debug(`markThreadAsRead: space-level markAsRead failed (${spaceMarkResult.error}), thread still marked OK`);
    }

    log.client.info(`markThreadAsRead: fully cleared thread ${topicId} in space ${spaceId}`);
    return {
      ...markResult,
      lastReadTime: clearResult.lastReadTime ?? markResult.lastReadTime,
      unreadMessageCount: clearResult.unreadMessageCount ?? markResult.unreadMessageCount,
    };
  }

  async markThreadAsUnread(
    spaceId: string,
    topicId: string,
    timestampMicros?: number,
  ): Promise<MarkGroupReadstateResult> {
    return this.setThreadMarkAsUnreadTimestamp(spaceId, topicId, timestampMicros ?? Date.now() * 1000);
  }

  /**
   * Parse a mark_topic_readstate (dfe.rs.mtrs) response.
   *
   * Response layout: [["dfe.rs.mtrs", readState, []]]
   * readState: [identity, lastReadTime, null, unreadCount, readCount, null,
   *             subscriptionState, serverTimestamp, null, totalCount]
   *
   * Field 6 (subscriptionState) is commonly -1 and is NOT an error code.
   * Success is determined by whether lastReadTime was set.
   */
  private parseTopicReadstateResponse(
    data: unknown[],
    groupId: string,
  ): MarkGroupReadstateResult {
    if (!Array.isArray(data)) {
      return { success: false, groupId, error: 'Invalid response format' };
    }

    // Unwrap: data[0] = ["dfe.rs.mtrs", readState, []]
    let wrapper = data[0];
    if (Array.isArray(wrapper) && wrapper[0] === 'dfe.rs.mtrs') {
      const readState = wrapper[1];
      if (Array.isArray(readState)) {
        const lastReadTime = this.toOptionalNumber(readState[1]);
        const unreadMessageCount = this.toOptionalNumber(readState[3]) ?? 0;
        const serverTimestamp = typeof readState[7] === 'number' ? readState[7] : undefined;

        if (lastReadTime != null || serverTimestamp != null) {
          log.client.info(`mark_topic_readstate OK: lastRead=${lastReadTime}, unread=${unreadMessageCount}, serverTs=${serverTimestamp}`);
          return {
            success: true,
            groupId,
            lastReadTime,
            unreadMessageCount,
          };
        }
      }
    }

    // Fallback: could not parse expected structure
    log.client.warn(`mark_topic_readstate: unexpected response shape: ${JSON.stringify(data).slice(0, 300)}`);
    return { success: false, groupId, error: 'Unexpected response format' };
  }

  private parseMarkReadstateResponse(
    data: unknown[],
    groupId: string
  ): MarkGroupReadstateResult {
    if (!Array.isArray(data)) {
      return { success: false, groupId, error: 'Invalid response format' };
    }

    let lastReadTime: number | undefined;
    let unreadMessageCount: number | undefined;
    let statusCode: number | undefined;
    let responseType: string | undefined;

    const findReadState = (value: unknown, depth = 0): unknown[] | undefined => {
      if (depth > 4 || !Array.isArray(value)) {
        return undefined;
      }

      if (
        value.length >= 2 &&
        Array.isArray(value[1]) &&
        (typeof value[2] === 'string' || typeof value[7] === 'number' || typeof value[8] === 'number')
      ) {
        return value;
      }

      for (const child of value) {
        const found = findReadState(child, depth + 1);
        if (found) {
          return found;
        }
      }

      return undefined;
    };

    let readState: unknown = data[0];
    if (Array.isArray(readState) && typeof readState[0] === 'string') {
      responseType = readState[0];
      readState = findReadState(readState[1]) ?? readState;
    }

    if (Array.isArray(readState)) {
      lastReadTime = typeof readState[8] === 'number'
        ? readState[8]
        : typeof readState[1] === 'number'
          ? readState[1]
          : undefined;
      unreadMessageCount = typeof readState[10] === 'number'
        ? readState[10]
        : typeof readState[3] === 'number'
          ? readState[3]
          : 0;
      statusCode = typeof readState[7] === 'number' ? readState[7] : undefined;
    }

    if (statusCode != null && statusCode < 0) {
      return {
        success: false,
        groupId,
        lastReadTime,
        unreadMessageCount,
        error: `${responseType ?? 'mark_readstate'} returned status ${statusCode}`,
      };
    }

    return {
      success: true,
      groupId,
      lastReadTime,
      unreadMessageCount,
    };
  }

  private extractMarkReadstateStatusCode(value: unknown, depth = 0): number | undefined {
    if (depth > 5 || !Array.isArray(value)) {
      return undefined;
    }

    if (typeof value[7] === 'number') {
      return value[7] as number;
    }

    for (const child of value) {
      const found = this.extractMarkReadstateStatusCode(child, depth + 1);
      if (found != null) {
        return found;
      }
    }

    return undefined;
  }

  private parseSendResponse(data: unknown[]): SendMessageResult {
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      return { success: false, error: 'Invalid response format' };
    }

    const wrapper = data[0];
    let topicId: string | undefined;
    let messageId: string | undefined;

    if (Array.isArray(wrapper[1]) && Array.isArray(wrapper[1][0])) {
      const topicInfo = wrapper[1][0];
      if (typeof topicInfo[1] === 'string') {
        topicId = topicInfo[1];
        messageId = topicInfo[1]; 
      }
    }

    return {
      success: true,
      message_id: messageId,
      topic_id: topicId,
    };
  }

  async getUserPresence(userIds: string[]): Promise<UserPresenceResult> {
    if (userIds.length === 0) {
      return { presences: [], total: 0 };
    }

    const protoData = encodeGetUserPresenceRequest(userIds, {
      includeActiveUntil: true,
      includeUserStatus: true,
    });

    const data = await this.apiRequest<unknown[]>('get_user_presence', protoData);
    return this.parsePresenceResponse(data, userIds);
  }

  async getUserPresenceRaw(userIds: string[]): Promise<{ raw: unknown; parsed: UserPresenceResult }> {
    if (userIds.length === 0) {
      return { raw: null, parsed: { presences: [], total: 0 } };
    }

    const protoData = encodeGetUserPresenceRequest(userIds, {
      includeActiveUntil: true,
      includeUserStatus: true,
    });

    const data = await this.apiRequest<unknown[]>('get_user_presence', protoData);
    const parsed = this.parsePresenceResponse(data, userIds);
    return { raw: data, parsed };
  }

  async getSingleUserPresence(userId: string): Promise<UserPresence | null> {
    const result = await this.getUserPresence([userId]);
    return result.presences.length > 0 ? result.presences[0] : null;
  }

  async getDMPresences(): Promise<Map<string, UserPresence>> {
    const presenceMap = new Map<string, UserPresence>();

    const { dms } = await this.listDMs({ limit: 100 });

    const userIds: string[] = [];

    for (const dm of dms) {
      if (dm.id && /^\d+$/.test(dm.id)) {
        userIds.push(dm.id);
      }
    }

    if (userIds.length === 0) {
      return presenceMap;
    }

    const batchSize = 50;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      try {
        const result = await this.getUserPresence(batch);
        for (const presence of result.presences) {
          presenceMap.set(presence.userId, presence);
        }
      } catch {
      }
    }

    return presenceMap;
  }

  async getUserPresenceWithProfile(userIds: string[]): Promise<UserPresenceWithProfileResult> {
    if (userIds.length === 0) {
      return { presences: [], total: 0 };
    }

    const [presenceResult, membersData] = await Promise.all([
      this.getUserPresence(userIds),
      this.apiRequest<unknown[]>('get_members', encodeGetMembersRequest(userIds)).catch(() => null),
    ]);

    const profileMap = this.buildProfileMapFromMembers(membersData, userIds);

    const combinedPresences: UserPresenceWithProfile[] = presenceResult.presences.map(presence => ({
      ...presence,
      ...(profileMap.get(presence.userId) || {}),
    }));

    return { presences: combinedPresences, total: combinedPresences.length };
  }

  async setFocus(focusState: number = 1, timeoutSeconds: number = 120): Promise<boolean> {
    try {
      const protoData = encodeSetFocusRequest(focusState, timeoutSeconds);
      await this.apiRequest<unknown[]>('set_focus', protoData);
      log.client.debug(`setFocus: Set focus state to ${focusState} for ${timeoutSeconds}s`);
      return true;
    } catch (error) {
      log.client.warn(`setFocus: Failed - ${(error as Error).message}`);
      return false;
    }
  }

  async setActiveClient(isActive: boolean = true, timeoutSeconds: number = 120): Promise<boolean> {
    try {
      const protoData = encodeSetActiveClientRequest(isActive, timeoutSeconds);
      await this.apiRequest<unknown[]>('set_active_client', protoData);
      log.client.debug(`setActiveClient: Set active=${isActive} for ${timeoutSeconds}s`);
      return true;
    } catch (error) {
      log.client.warn(`setActiveClient: Failed - ${(error as Error).message}`);
      return false;
    }
  }

  async setPresenceShared(presenceShared: boolean = true, timeoutSeconds: number = 300): Promise<boolean> {
    try {
      const protoData = encodeSetPresenceSharedRequest(presenceShared, timeoutSeconds);
      await this.apiRequest<unknown[]>('set_presence_shared', protoData);
      log.client.debug(`setPresenceShared: Set presenceShared=${presenceShared} for ${timeoutSeconds}s`);
      return true;
    } catch (error) {
      log.client.warn(`setPresenceShared: Failed - ${(error as Error).message}`);
      return false;
    }
  }

  private buildProfileMapFromMembers(
    data: unknown,
    targetUserIds: string[]
  ): Map<string, { name?: string; email?: string; avatarUrl?: string; firstName?: string; lastName?: string }> {
    const profileMap = new Map<string, { name?: string; email?: string; avatarUrl?: string; firstName?: string; lastName?: string }>();

    if (!data) {
      return profileMap;
    }

    const payload =
      Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
        ? data[0]
        : data;

    const members = this.getPbliteField<unknown[]>(payload, 1);

    if (!Array.isArray(members)) {
      return profileMap;
    }

    for (const member of members) {
      const user = this.getPbliteField<unknown[]>(member, 1);
      if (!user) {
        continue;
      }

      const userId = this.getNestedPbliteString(user, 1, 1);
      if (!userId) {
        continue;
      }

      profileMap.set(userId, {
        name: this.getPbliteField<string>(user, 2),
        avatarUrl: this.getPbliteField<string>(user, 3),
        email: this.getPbliteField<string>(user, 4),
        firstName: this.getPbliteField<string>(user, 5),
        lastName: this.getPbliteField<string>(user, 6),
      });
    }

    return profileMap;
  }

  private parsePresenceResponse(data: unknown[], requestedUserIds: string[]): UserPresenceResult {
    const presences: UserPresence[] = [];

    if (!Array.isArray(data) || data.length === 0) {
      return { presences, total: 0 };
    }

    let presenceList: unknown[] | undefined;

    const wrapper = Array.isArray(data[0]) ? data[0] : data;
    presenceList = this.getPbliteField<unknown[]>(wrapper, 2);

    if (!Array.isArray(presenceList) && Array.isArray(data[1])) {
      presenceList = data[1] as unknown[];
    }

    if (!Array.isArray(presenceList) && Array.isArray(wrapper[1])) {
      presenceList = wrapper[1] as unknown[];
    }

    if (!Array.isArray(presenceList)) {
      if (data.length > 0 && Array.isArray(data[0]) && Array.isArray((data[0] as unknown[])[0])) {
        presenceList = data;
      }
    }

    if (!Array.isArray(presenceList)) {
      return { presences, total: 0 };
    }

    for (const item of presenceList) {
      if (!Array.isArray(item)) continue;

      const presence = this.parseUserPresence(item);
      if (presence) {
        presences.push(presence);
      }
    }

    return { presences, total: presences.length };
  }

  private parseUserPresence(item: unknown[]): UserPresence | null {
    const unwrapFirstString = (value: unknown, maxDepth: number = 6): string => {
      let current: unknown = value;
      for (let depth = 0; depth < maxDepth; depth++) {
        if (typeof current === 'string') {
          return current;
        }
        if (Array.isArray(current) && current.length > 0) {
          current = current[0];
          continue;
        }
        break;
      }
      return '';
    };

    const userId = unwrapFirstString(item[0]);

    if (!userId) {
      return null;
    }

    const presenceValue =
      typeof item[1] === 'number'
        ? item[1]
        : (typeof item[1] === 'string' && /^\d+$/.test(item[1]) ? parseInt(item[1], 10) : 0);
    const presence = presenceValue as PresenceStatus;

    const presenceLabels: Record<number, UserPresence['presenceLabel']> = {
      0: 'undefined',
      1: 'active',
      2: 'inactive',
      3: 'unknown',
      4: 'sharing_disabled',
    };
    const presenceLabel = presenceLabels[presenceValue] || 'undefined';

    let activeUntilUsec: number | undefined;
    if (typeof item[2] === 'number' || (typeof item[2] === 'string' && /^\d+$/.test(item[2]))) {
      activeUntilUsec = typeof item[2] === 'number' ? item[2] : parseInt(item[2], 10);
    }

    let dndValue = 0;
    if (typeof item[3] === 'number') {
      dndValue = item[3];
    } else if (typeof item[3] === 'string' && /^\d+$/.test(item[3])) {
      dndValue = parseInt(item[3], 10);
    }
    const dndState = dndValue as DndStateStatus;

    const dndLabels: Record<number, UserPresence['dndLabel']> = {
      0: 'unknown',
      1: 'available',
      2: 'dnd',
    };
    const dndLabel = dndLabels[dndValue] || 'unknown';

    let customStatus: CustomStatus | undefined;
    if (Array.isArray(item[4])) {
      const statusData = item[4];
      if (Array.isArray(statusData[1])) {
        const cs = statusData[1];
        customStatus = {
          statusText: typeof cs[0] === 'string' ? cs[0] : undefined,
          statusEmoji: typeof cs[1] === 'string' ? cs[1] : undefined,
        };
        if (typeof cs[2] === 'number' || (typeof cs[2] === 'string' && /^\d+$/.test(cs[2]))) {
          customStatus.expiryTimestampUsec = typeof cs[2] === 'number' ? cs[2] : parseInt(cs[2], 10);
        }
      }
    }

    return {
      userId,
      presence,
      presenceLabel,
      dndState,
      dndLabel,
      activeUntilUsec,
      customStatus,
    };
  }

  async getUnreadNotifications(options: {
    fetchMessages?: boolean;
    messagesPerSpace?: number;
    unreadOnly?: boolean;
    checkParticipation?: boolean;
    parallel?: number;
    forceRefresh?: boolean;
  } = {}): Promise<{
    badges: import('./types.js').UnreadBadgeCounts;
    /** Non-badged unread spaces, including lit_up and promoted thread-unread spaces */
    spaces: import('./types.js').UnreadSpace[];
    /** DMs with badged or lit_up state */
    directMessages: import('./types.js').UnreadSpace[];
    allUnreads: WorldItemSummary[];
    selfUserId?: string;
  }> {
    const {
      unreadOnly = true,
      forceRefresh = false,
    } = options;

    const selfUser = await this.getSelfUser();
    const selfUserId = selfUser.userId;

    const { items } = await this.fetchWorldItems({ forceRefresh });

    const {
      badgedDMs,
      badgedSpaces,
      litupDMs,
      litupSpaces,
      threadUnreadSpaces: promotedThreadUnreadSpaces,
    } = this.partitionNotificationItems(items);

    const spaces: import('./types.js').UnreadSpace[] = [];
    const directMessages: import('./types.js').UnreadSpace[] = [];

    const itemsToProcess = unreadOnly
      ? items.filter((item) => this.isUnreadItem(item))
      : items;

    for (const item of itemsToProcess) {
      const unreadSpace: import('./types.js').UnreadSpace = {
        spaceId: item.id,
        spaceName: item.name,
        type: item.type,
        unreadCount: item.unreadCount,
        unreadSubscribedTopicCount: item.unreadSubscribedTopicCount,
        lastMentionTime: item.lastMentionTime,
        unreadReplyCount: item.unreadReplyCount,
        lastMessageText: item.lastMessageText,
        subscribedThreadId: item.subscribedThreadId,
        threadIds: item.threadIds,
        isSubscribed: item.isSubscribedToSpace ?? false,
        hasMention: false,
        hasDirect: item.type === 'dm',
        badgeCount: item.badgeCount,
        notificationCategory: item.notificationCategory,
        promotedThreadUnread: this.isThreadUnreadSpace(item),
      };

      if (item.type === 'dm') {
        directMessages.push(unreadSpace);
      } else {
        spaces.push(unreadSpace);
      }
    }

    // Aggregate server-provided badge counts
    const serverBadgeTotal = itemsToProcess.reduce(
      (sum, item) => sum + (item.badgeCount ?? 0), 0
    );

    const badgedItems = itemsToProcess.filter(i => i.notificationCategory === 'badged');
    const litUpItems = itemsToProcess.filter(i => i.notificationCategory === 'lit_up');

    // Find the most recent notif-worthy event across all items
    const latestNotifWorthyEvent = itemsToProcess.reduce<number | undefined>(
      (latest, item) => {
        const ts = item.lastNotifWorthyEventTimestamp;
        if (ts && (!latest || ts > latest)) return ts;
        return latest;
      },
      undefined
    );

    return {
      badges: {
        totalUnread: badgedDMs.length + badgedSpaces.length + litupDMs.length + litupSpaces.length + promotedThreadUnreadSpaces.length,
        badgedCount: badgedItems.length,
        litUpCount: litUpItems.length,
        directMessages: badgedItems.filter(i => i.type === 'dm').length,
        badgedSpaces: badgedItems.filter(i => i.type === 'space').length,
        threadUnreadCount: promotedThreadUnreadSpaces.length,
        serverBadgeTotal,
        latestNotifWorthyEvent,
      },
      spaces,
      directMessages,
      allUnreads: itemsToProcess,
      selfUserId,
    };
  }

  private checkMentionType(
    message: Message,
    selfUserId: string
  ): 'direct' | 'all' | 'none' {
    if (!message.mentions || message.mentions.length === 0) {
      return 'none';
    }

    const hasDirect = message.mentions.some(
      (m) => m.user_id === selfUserId && m.mention_type === 'user'
    );
    if (hasDirect) {
      return 'direct';
    }

    const hasAll = message.mentions.some((m) => m.mention_type === 'all');
    if (hasAll) {
      return 'all';
    }

    return 'none';
  }

  async getUnreadBadgeCounts(): Promise<import('./types.js').UnreadBadgeCounts> {
    const { items } = await this.fetchWorldItems();

    const {
      badgedDMs,
      badgedSpaces,
      litupDMs,
      litupSpaces,
      threadUnreadSpaces,
    } = this.partitionNotificationItems(items);

    const badged = items.filter((item) => item.notificationCategory === 'badged');
    const litUp = items.filter((item) => item.notificationCategory === 'lit_up');

    const serverBadgeTotal = items.reduce(
      (sum, item) => sum + (item.badgeCount ?? 0), 0
    );

    const latestNotifWorthyEvent = items.reduce<number | undefined>(
      (latest, item) => {
        const ts = item.lastNotifWorthyEventTimestamp;
        if (ts && (!latest || ts > latest)) return ts;
        return latest;
      },
      undefined
    );

    return {
      totalUnread: badgedDMs.length + badgedSpaces.length + litupDMs.length + litupSpaces.length + threadUnreadSpaces.length,
      badgedCount: badged.length,
      litUpCount: litUp.length,
      directMessages: badged.filter(i => i.type === 'dm').length,
      badgedSpaces: badged.filter(i => i.type === 'space').length,
      threadUnreadCount: threadUnreadSpaces.length,
      serverBadgeTotal,
      latestNotifWorthyEvent,
    };
  }

  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const maxPages = options.maxPages ?? 1;
    const pageSize = options.pageSize ?? 55;
    const sessionId = options.sessionId ?? randomUUID().toUpperCase();

    let allResults: SearchSpaceResult[] = [];
    let cursor: string | null = options.cursor ?? null;
    let page = 0;
    let lastPagination: SearchPagination = {
      cursor: null,
      hasMore: false,
      resultCount: 0,
      sessionId,
    };

    while (page < maxPages) {
      const result = await this.searchPage(query, {
        sessionId,
        cursor,
        pageSize,
        isFirstPage: cursor === null && page === 0,
      });

      allResults = allResults.concat(result.results);
      lastPagination = result.pagination;

      if (!result.pagination.hasMore || !result.pagination.cursor) {
        break;
      }

      cursor = result.pagination.cursor;
      page++;
    }

    return {
      results: allResults,
      pagination: lastPagination,
    };
  }

  private async searchPage(
    query: string,
    options: {
      sessionId: string;
      cursor: string | null;
      pageSize: number;
      isFirstPage: boolean;
    }
  ): Promise<SearchResponse> {
    await this.ensureAuth();

    const { sessionId, cursor, pageSize, isFirstPage } = options;

    const innerPayload = [
      null,
      cursor,
      null,
      query,
      null,
      sessionId,
      [
        [],
        null,
        null,
        null,
        isFirstPage ? sessionId : null, 
        null,
        0,
        [[[[[[1]]]]], [[[1]]]], 
      ],
      isFirstPage ? null : Date.now(), 
      [3],
      [pageSize],
    ];

    const rpcCall = [
      [['SBNmJb', JSON.stringify(innerPayload), null, 'generic']],
    ];

    const atToken = `${this.auth!.xsrfToken}:${Date.now()}`;
    const requestBody = `f.req=${encodeURIComponent(JSON.stringify(rpcCall))}&at=${encodeURIComponent(atToken)}`;

    const url = `${API_BASE}/_/DynamiteWebUi/data/batchexecute?rpcids=SBNmJb&source-path=/u/0/mole/world&bl=boq_dynamiteuiserver_20260113.02_p1&hl=en&soc-app=1&soc-platform=1&soc-device=1&rt=c`;

    log.client.info(`search: query="${query}", cursor=${cursor ? 'yes' : 'no'}, isFirstPage=${isFirstPage}`);
    log.client.info(`search: payloadSessionId=${sessionId}, f.sid=${this.auth!.sessionId || 'none'}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: this.auth!.cookieString,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Origin: 'https://chat.google.com',
        Referer: 'https://chat.google.com/',
        'User-Agent': USER_AGENT,
        'x-same-domain': '1',
      },
      body: requestBody,
    });

    const text = await response.text();
    log.client.debug(`search: status=${response.status}, responseLength=${text.length}`);

    if (!response.ok) {
      log.client.error(`search: failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      throw new Error(`Search request failed: ${response.status} - ${text.substring(0, 200)}`);
    }

    return this.parseSearchResponse(text, sessionId);
  }

  private parseSearchResponse(text: string, sessionId: string): SearchResponse {
    try {
      const jsonMatch = text.match(/\n(\d+)\n(\[\[.+)/s);
      if (!jsonMatch) {
        log.client.warn('search: Could not find JSON in response');
        return {
          results: [],
          pagination: { cursor: null, hasMore: false, resultCount: 0, sessionId },
        };
      }

      const jsonContent = jsonMatch[2];
      let depth = 0;
      let endIdx = 0;
      for (let i = 0; i < jsonContent.length; i++) {
        const c = jsonContent[i];
        if (c === '[') depth++;
        else if (c === ']') {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }

      const outer = JSON.parse(jsonContent.substring(0, endIdx));
      const innerStr = outer[0][2];
      const inner = JSON.parse(innerStr);

      const nextCursor = inner[0] || null;
      const resultCount = inner[1] || 0;
      const resultsArray = inner[4] || [];

      log.client.debug(`search: parsed ${resultsArray.length} results, hasMore=${!!nextCursor}`);

      const results: SearchSpaceResult[] = resultsArray.map((item: unknown[]) =>
        this.parseSearchResultItem(item)
      );

      return {
        results,
        pagination: {
          cursor: nextCursor,
          hasMore: !!nextCursor && results.length >= 20,
          resultCount,
          sessionId,
        },
      };
    } catch (error) {
      log.client.error(`search: parse error - ${error instanceof Error ? error.message : error}`);
      return {
        results: [],
        pagination: { cursor: null, hasMore: false, resultCount: 0, sessionId },
      };
    }
  }

  private parseSearchResultItem(item: unknown[]): SearchSpaceResult {

    const idTuple = item[0] as unknown[] | undefined;
    const fullId = (idTuple?.[0] as string) || '';
    const shortId = (idTuple?.[1] as string) || '';

    let type: 'space' | 'dm' | 'group_dm' = 'space';
    if (fullId.startsWith('dm/')) {
      type = 'dm';
    } else {
      const roomTypeTuple = item[82] as unknown[] | undefined;
      if (roomTypeTuple && Array.isArray(roomTypeTuple[0])) {
        const roomTypeStr = (roomTypeTuple[0] as unknown[])[1] as string;
        if (roomTypeStr === 'GROUP_DM') {
          type = 'group_dm';
        }
      }
    }

    let emoji: string | undefined;
    const emojiArr = item[52] as unknown[][] | undefined;
    if (emojiArr && emojiArr[0] && emojiArr[0][0]) {
      emoji = emojiArr[0][0] as string;
    }

    let description: string | undefined;
    const descTuple = item[61] as unknown[] | undefined;
    if (descTuple && descTuple[1]) {
      description = descTuple[1] as string;
    }

    let creatorInfo: SearchUserInfo | undefined;
    const creatorArr = item[20] as unknown[] | undefined;
    if (creatorArr && creatorArr[0]) {
      creatorInfo = {
        userId: (creatorArr[0] as string) || '',
        name: (creatorArr[1] as string) || undefined,
        email: (creatorArr[3] as string) || undefined,
      };
    }

    let lastSenderInfo: SearchUserInfo | undefined;
    const senderArr = item[21] as unknown[] | undefined;
    if (senderArr && senderArr[0]) {
      lastSenderInfo = {
        userId: (senderArr[0] as string) || '',
        name: (senderArr[1] as string) || undefined,
        email: (senderArr[3] as string) || undefined,
      };
    }

    let members: SearchMember[] | undefined;
    const membersArr = item[53] as unknown[][] | undefined;
    if (membersArr && Array.isArray(membersArr)) {
      members = membersArr.map((m: unknown[]) => ({
        userId: (m[0] as string) || '',
        name: (m[1] as string) || '',
        avatarUrl: (m[2] as string) || undefined,
        email: (m[3] as string) || undefined,
        firstName: (m[6] as string) || undefined,
        membershipType: m[7] as number | undefined,
      }));
    }

    let roomType: string | undefined;
    const roomTypeTuple = item[82] as unknown[] | undefined;
    if (roomTypeTuple && Array.isArray(roomTypeTuple[0])) {
      roomType = (roomTypeTuple[0] as unknown[])[1] as string;
    }

    return {
      spaceId: fullId,
      shortId,
      type,
      roomType,
      name: (item[2] as string) || (type === 'dm' ? 'Direct Message' : 'Unknown Space'),
      avatarUrl: (item[46] as string) || undefined,
      emoji,
      description,
      lastActivityMs: (item[13] as number) || undefined,
      lastMessageTimestampUsec: (item[8] as string) || undefined,
      lastReadTimestampUsec: (item[9] as string) || undefined,
      createdTimestampMs: (item[22] as number) || undefined,
      createdTimestampUsec: (item[62] as string) || undefined,
      sortTimestampMs: (item[37] as number) || undefined,
      memberCount: (item[51] as number) || undefined,
      totalMemberCount: (item[56] as number) || undefined,
      members,
      creatorInfo,
      lastSenderInfo,
      isHidden: (item[6] as boolean) || undefined,
      isMuted: (item[12] as boolean) || undefined,
      isFollowing: (item[26] as boolean) || undefined,
      isDiscoverable: (item[59] as boolean) || undefined,
      hasMessages: (item[35] as boolean) || undefined,
      unreadCount: (item[11] as number) || undefined,
      rosterId: (item[47] as string) || undefined,
    };
  }

  // ─── SDK parity methods ──────────────────────────────────────────────────
  // These bring the SDK to feature-parity with the API server's orchestration
  // endpoints so external consumers get the same capabilities programmatically.

  /**
   * Aggregated notification view with filtering, parallel message fetching,
   * and @mention scanning.  Mirrors the API server's `GET /api/notifications`.
   */
  async getNotifications(options: NotificationOptions = {}): Promise<NotificationResult> {
    const {
      mentions = false,
      threads = false,
      spaces: filterSpaces = false,
      dms: filterDms = false,
      read = false,
      me = false,
      atAll = false,
      space: filterSpace,
      showMessages: showMessagesOpt = false,
      limit = 0,
      offset = 0,
      parallel = 5,
      messagesLimit = 3,
    } = options;

    const showMessages = showMessagesOpt || me || atAll;

    let { items } = await this.fetchWorldItems();

    // @me shortcut: restrict to the mentions-shortcut space
    let mentionsShortcutId: string | undefined;
    if (me && !filterSpace) {
      const mentionsSpaces = await this.findSpaces('mentions');
      const mentionsShortcut = mentionsSpaces.find(
        (s) =>
          s.name?.toLowerCase().includes('mentions') ||
          s.name?.toLowerCase() === 'mentions-shortcut',
      );
      if (mentionsShortcut) {
        mentionsShortcutId = mentionsShortcut.id;
        items = items.filter((i) => i.id === mentionsShortcutId);
      }
    }

    if (filterSpace) {
      items = items.filter((i) => i.id === filterSpace);
    }

    if (me || atAll) {
      await this.getSelfUser();
    }

    // Strip internal fields from output
    const sanitize = ({
      unreadCount: _a,
      unreadSubscribedTopicCount: _b,
      unreadReplyCount: _c,
      notificationLevel: _d,
      _memberUserIds: _e,
      ...rest
    }: WorldItemSummary): WorldItemSummary => rest as WorldItemSummary;

    const {
      badgedDMs,
      badgedSpaces,
      litupDMs,
      litupSpaces,
      threadUnreadSpaces,
      readItems,
    } = this.partitionNotificationItems(items);
    const unreadDMs = [...badgedDMs, ...litupDMs];
    const badgedItems = [...badgedDMs, ...badgedSpaces];
    const unreadSpaces = [...litupSpaces, ...threadUnreadSpaces];

    const hasFilter = mentions || threads || filterSpaces || filterDms || read || me || atAll;
    let itemsToProcess: WorldItemSummary[] = [];

    if (hasFilter && !me && !atAll) {
      if (mentions) itemsToProcess = itemsToProcess.concat(badgedItems);
      if (threads) itemsToProcess = itemsToProcess.concat(threadUnreadSpaces);
      if (filterSpaces) itemsToProcess = itemsToProcess.concat(unreadSpaces);
      if (filterDms) itemsToProcess = itemsToProcess.concat(unreadDMs);
      if (read) itemsToProcess = itemsToProcess.concat(readItems);
    } else if (me || atAll) {
      itemsToProcess = [...badgedItems];
    } else {
      itemsToProcess = [...unreadDMs, ...badgedSpaces, ...unreadSpaces];
    }

    // De-duplicate across overlapping filters
    const seen = new Set<string>();
    itemsToProcess = itemsToProcess.filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });

    const totalItems = itemsToProcess.length;
    if (offset > 0) {
      itemsToProcess = itemsToProcess.slice(offset);
    }
    if (limit > 0) {
      itemsToProcess = itemsToProcess.slice(0, limit);
    }

    const directMeMentions: WorldItemSummary[] = [];
    const atAllMentions: WorldItemSummary[] = [];
    const messages: Record<string, Message[]> = {};

    if (showMessages && itemsToProcess.length > 0) {
      for (let i = 0; i < itemsToProcess.length; i += parallel) {
        const batch = itemsToProcess.slice(i, i + parallel);
        const results = await Promise.allSettled(
          batch.map(async (item) => {
            const result = await this.getThreads(item.id, { pageSize: messagesLimit });
            return { item, result };
          }),
        );

        for (const settledResult of results) {
          if (settledResult.status === 'fulfilled') {
            const { item, result } = settledResult.value;
            if (result.messages.length > 0) {
              messages[item.id] = result.messages;

              if (me || atAll) {
                let hasDirectMe = false;
                let hasAtAll = false;
                for (const msg of result.messages) {
                  if (this.isDirectlyMentioned(msg)) hasDirectMe = true;
                  if (this.hasAllMention(msg)) hasAtAll = true;
                }
                if (hasDirectMe) directMeMentions.push(item);
                if (hasAtAll && !hasDirectMe) atAllMentions.push(item);
              }
            }
          }
        }
      }
    }

    const serverBadgeTotal = items.reduce((sum, i) => sum + (i.badgeCount ?? 0), 0);

    return {
      unreadDMs: unreadDMs.map(sanitize),
      badgedSpaces: badgedSpaces.map(sanitize),
      unreadSpaces: unreadSpaces.map(sanitize),
      directMeMentions: me ? directMeMentions.map(sanitize) : [],
      atAllMentions: atAll ? atAllMentions.map(sanitize) : [],
      badges: {
        totalUnread: unreadDMs.length + badgedSpaces.length + unreadSpaces.length,
        badgedCount: badgedItems.length,
        litUpCount: litupSpaces.length,
        unreadDMCount: unreadDMs.length,
        threadUnreadCount: threadUnreadSpaces.length,
        serverBadgeTotal,
      },
      messages: showMessages ? messages : undefined,
      mentionsShortcutId: mentionsShortcutId || undefined,
      pagination: {
        total: totalItems,
        offset,
        limit: limit || totalItems,
        returned: itemsToProcess.length,
        hasMore: offset + itemsToProcess.length < totalItems,
      },
    };
  }

  /**
   * Force-refresh world items and return a computed unread summary.
   * Mirrors the API server's `GET /api/unreads/refresh`.
   */
  async refreshUnreads(): Promise<RefreshUnreadsResult> {
    const { items } = await this.fetchWorldItems({ forceRefresh: true });
    const { threadUnreadSpaces } = this.partitionNotificationItems(items);
    const badged = items.filter((i) => i.notificationCategory === 'badged');
    const litUp = items.filter((i) => i.notificationCategory === 'lit_up');
    const unreads = items.filter((i) => this.isUnreadItem(i));

    const serverBadgeTotal = items.reduce((sum, i) => sum + (i.badgeCount ?? 0), 0);

    return {
      unreads,
      total: unreads.length,
      summary: {
        totalUnread: unreads.length,
        badgedCount: badged.length,
        litUpCount: litUp.length,
        threadUnreadCount: threadUnreadSpaces.length,
        serverBadgeTotal,
        directMessages: unreads.filter((i) => i.type === 'dm').length,
        badgedSpaces: badged.filter((i) => i.type === 'space').length,
      },
    };
  }

  /**
   * Resolve DM IDs to the "other" user in each conversation, then
   * batch-fetch their presence with profile info.
   * Mirrors the API server's `GET /api/dms/presence`.
   */
  async getDMPresenceByDmIds(
    dmIds: string[],
    options: { parallel?: number } = {},
  ): Promise<DMPresenceResult> {
    const parallel = options.parallel ?? 5;

    if (dmIds.length === 0) {
      return { presences: [], total: 0 };
    }

    const dmToUser = new Map<string, string>();
    const selfUser = await this.getSelfUser();
    const selfUserId = selfUser?.userId;

    const uniqueDmIds = Array.from(new Set(dmIds));
    for (let i = 0; i < uniqueDmIds.length; i += parallel) {
      const batch = uniqueDmIds.slice(i, i + parallel);
      await Promise.all(
        batch.map(async (dmId) => {
          try {
            const result = await this.getThreads(dmId, { pageSize: 3, isDm: true });
            for (const msg of result.messages) {
              const senderId = msg.sender_id || msg.sender;
              if (senderId && senderId !== selfUserId && /^\d+$/.test(senderId)) {
                dmToUser.set(dmId, senderId);
                break;
              }
            }
          } catch {
            // skip DMs we can't resolve
          }
        }),
      );
    }

    const userIds = Array.from(new Set(dmToUser.values()));
    const presences: DMPresenceEntry[] = [];

    if (userIds.length > 0) {
      try {
        const result = await this.getUserPresenceWithProfile(userIds);
        for (const [dmId, userId] of dmToUser.entries()) {
          const presence = result.presences.find((p) => p.userId === userId);
          if (presence) {
            presences.push({ ...presence, dmId });
          }
        }
      } catch {
        // presence fetch failed — return empty
      }
    }

    return { presences, total: presences.length };
  }

  /**
   * Look up a single DM by its space ID.
   * Mirrors the API server's `GET /api/dms/:dmId`.
   */
  async getDM(dmId: string): Promise<{
    id: string;
    name?: string;
    unreadCount: number;
    lastMentionTime?: number;
    unreadReplyCount?: number;
    notificationCategory?: string;
  } | null> {
    const { dms } = await this.listDMs({ limit: 0 });
    return dms.find((d) => d.id === dmId) ?? null;
  }

  /**
   * Mark every unread space / DM as read.
   * Mirrors the extension bridge's `mark_all_read` command.
   */
  async markAllAsRead(): Promise<MarkAllAsReadResult> {
    const items = await this.listWorldItems();
    const unread = items.filter((i) => i.unreadCount > 0 || i.unreadReplyCount > 0);
    let marked = 0;
    for (const item of unread) {
      try {
        await this.markAsRead(item.id);
        marked++;
      } catch {
        // skip individual failures — continue marking the rest
      }
    }
    return { marked, total: unread.length };
  }

  /**
   * Resolve an attachment token and download the binary content in one call.
   * Composes `getAttachmentUrl()` + `proxyFetch()`.
   * Mirrors the API server's `GET /api/attachment?token=`.
   */
  async getAttachmentBinary(attachmentToken: string): Promise<AttachmentBinaryResult> {
    const signedUrl = await this.getAttachmentUrl(attachmentToken);
    if (!signedUrl) {
      throw new Error('Could not resolve attachment URL for the given token');
    }

    const response = await this.proxyFetch(signedUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch attachment: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = await response.arrayBuffer();

    return { buffer, contentType };
  }
}
