
import type { GoogleChatClient } from './client.js';
import type {
  UnreadNotifications,
  UnreadSpace,
  UnreadBadgeCounts,
  GetUnreadsOptions,
  WorldItemSummary,
} from './types.js';
import { log } from './logger.js';

export class UnreadNotificationService {
  private client: GoogleChatClient;

  constructor(client: GoogleChatClient) {
    this.client = client;
  }

  async getUnreadNotifications(
    options: GetUnreadsOptions = {}
  ): Promise<UnreadNotifications> {
    const {
      unreadOnly = true,
    } = options;

    const now = Date.now();
    log.client.debug('UnreadNotificationService: Fetching unread notifications');

    const selfUser = await this.client.getSelfUser();
    const selfUserId = selfUser.userId;

    const { items } = await this.client.fetchWorldItems();

    const spaces: UnreadSpace[] = [];
    const directMessages: UnreadSpace[] = [];

    const itemsToProcess = unreadOnly
      ? items.filter((item) => this.isUnreadItem(item))
      : items;

    for (const item of itemsToProcess) {
      const unreadSpace = this.worldItemToUnreadSpace(item);

      if (item.type === 'dm') {
        directMessages.push(unreadSpace);
      } else {
        spaces.push(unreadSpace);
      }
    }

    const badges = this.calculateBadgeCounts(itemsToProcess);

    const result: UnreadNotifications = {
      badges,
      spaces,
      directMessages,
      allUnreads: itemsToProcess,
      lastFetched: now,
      selfUserId,
    };

    log.client.debug(
      'UnreadNotificationService: Fetched',
      badges.totalUnread,
      'unreads (badged:',
      badges.badgedCount,
      ', lit_up:',
      badges.litUpCount,
      ')',
    );

    return result;
  }

  async getBadgeCounts(): Promise<UnreadBadgeCounts> {
    const notifications = await this.getUnreadNotifications({
      fetchMessages: false, 
    });
    return notifications.badges;
  }

  async getUnreadSpaces(): Promise<UnreadSpace[]> {
    const notifications = await this.getUnreadNotifications({
      fetchMessages: false,
    });
    return notifications.spaces;
  }

  async getUnreadDMs(): Promise<UnreadSpace[]> {
    const notifications = await this.getUnreadNotifications({
      fetchMessages: false,
    });
    return notifications.directMessages;
  }

  private worldItemToUnreadSpace(item: WorldItemSummary): UnreadSpace {
    return {
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
  }

  private isThreadUnreadSpace(item: WorldItemSummary): boolean {
    return item.type === 'space'
      && item.notificationCategory === 'none'
      && (item.unreadSubscribedTopicCount > 0 || item.unreadReplyCount > 0);
  }

  private isUnreadItem(item: WorldItemSummary): boolean {
    return item.notificationCategory !== 'none' || this.isThreadUnreadSpace(item);
  }

  private calculateBadgeCounts(
    items: WorldItemSummary[],
  ): UnreadBadgeCounts {
    const badgedItems = items.filter(i => i.notificationCategory === 'badged');
    const litUpItems = items.filter(i => i.notificationCategory === 'lit_up');

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
      totalUnread: items.filter((item) => this.isUnreadItem(item)).length,
      badgedCount: badgedItems.length,
      litUpCount: litUpItems.length,
      directMessages: items.filter(i => i.type === 'dm').length,
      badgedSpaces: badgedItems.filter(i => i.type === 'space').length,
      threadUnreadCount: items.filter((item) => this.isThreadUnreadSpace(item)).length,
      serverBadgeTotal,
      latestNotifWorthyEvent,
    };
  }
}

export function createUnreadService(
  client: GoogleChatClient
): UnreadNotificationService {
  return new UnreadNotificationService(client);
}
