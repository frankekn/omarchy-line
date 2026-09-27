/**
 * The chat-list summary cache and the epoch bookkeeping that reconciles a
 * full refresh overtaken by a push.
 *
 * Moved verbatim out of daemon.ts. The one outside name the moved state and
 * its cap function reach for -- the chat-list size cap, CHAT_LIMIT -- is
 * injected once through createChatSummaryStore(); importing this file pulls
 * in no linejs code and touches no state dir. The state rebinds (a finished
 * round swaps the whole cache for the one it built), so it lives in the
 * factory's closure under the exact names the moved bodies already use, and
 * the rounds in daemon.ts read and write it through the store's accessors.
 * The one pure function here, summaryMessageIsCurrent, is exported directly.
 */

/**
 * The row a cached summary carries: structurally daemon.ts's PluginChat,
 * declared here because importing that would pull in the session.
 */
export interface SummaryChat {
  mid: string;
  name: string;
  unread: number;
  lastText: string;
  lastTime: number;
  lastFrom: string;
  avatarPath?: string;
  /** Stamped by hiddenStamped() alone, and only when it is true. */
  hidden?: true;
}

/** One summary cache entry: the message id the row was built from, and the row. */
export interface SummaryCacheEntry {
  lastMessageId: string;
  chat: SummaryChat;
}

export function summaryMessageIsCurrent(
  previousTime: number,
  nextTime: number,
  previousId: string | undefined,
  nextId: string,
): boolean {
  if (nextTime < previousTime) return false;
  if (nextTime > previousTime || !previousId || previousId === nextId) {
    return true;
  }
  try {
    return BigInt(nextId) >= BigInt(previousId);
  } catch {
    // With equal timestamps and opaque unequal ids, retaining the published
    // identity is safer than letting a replay redirect a later recall.
    return false;
  }
}

export interface ChatSummaryStoreOptions {
  /**
   * The daemon's chat-list size cap (CHAT_LIMIT): the versions map is capped
   * at twice it, so even a burst that touched every chat in the list stays
   * bounded by the list the cap exists to hold.
   */
  chatLimit: number;
}

export function createChatSummaryStore(options: ChatSummaryStoreOptions) {
  // The exact name the moved body already uses, bound once per store.
  const { chatLimit: CHAT_LIMIT } = options;
  // Every incoming event refreshes all ~122 boxes, and the per-box decrypt is
  // the expensive part. A box whose newest message id is unchanged cannot have
  // a different preview line, so keep the built summary and only take the fresh
  // unread count (reading a chat elsewhere moves unread without a new message).
  let summaryCache = new Map<
    string,
    { lastMessageId: string; chat: SummaryChat }
  >();
  // Advances whenever a push publishes a summary newer than an in-flight full
  // refresh may have fetched. Such a refresh is discarded and retried.
  let chatSummaryEpoch = 0;
  let lastRefreshSummaryEpoch = 0;
  const chatSummaryVersions = new Map<string, number>();
  let chatSummaryMessageIds = new Map<string, string>();
  let activeSummaryWindow: { epoch: number; generation: number } | null = null;
  let chatMetadataEpoch = 0;

  function capChatSummaryVersions(): void {
    const max = CHAT_LIMIT * 2;
    while (chatSummaryVersions.size > max) {
      let removed = false;
      for (const [mid, version] of chatSummaryVersions) {
        // A running refresh needs every push newer than its captured epoch for
        // reconciliation. The map is capped again as soon as that round ends.
        if (activeSummaryWindow && version > activeSummaryWindow.epoch) {
          continue;
        }
        chatSummaryVersions.delete(mid);
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }

  // The rounds read and rebind these, so every `let` binding is an accessor
  // pair: assigning the store property rebinds the closure variable the moved
  // bodies read. chatSummaryVersions was a `const` map and stays read-only --
  // its mutators (get/set/delete/clear) go through the getter.
  return {
    get summaryCache(): Map<string, SummaryCacheEntry> {
      return summaryCache;
    },
    set summaryCache(next: Map<string, SummaryCacheEntry>) {
      summaryCache = next;
    },
    get chatSummaryEpoch(): number {
      return chatSummaryEpoch;
    },
    set chatSummaryEpoch(next: number) {
      chatSummaryEpoch = next;
    },
    get lastRefreshSummaryEpoch(): number {
      return lastRefreshSummaryEpoch;
    },
    set lastRefreshSummaryEpoch(next: number) {
      lastRefreshSummaryEpoch = next;
    },
    get chatSummaryVersions(): Map<string, number> {
      return chatSummaryVersions;
    },
    get chatSummaryMessageIds(): Map<string, string> {
      return chatSummaryMessageIds;
    },
    set chatSummaryMessageIds(next: Map<string, string>) {
      chatSummaryMessageIds = next;
    },
    get activeSummaryWindow(): { epoch: number; generation: number } | null {
      return activeSummaryWindow;
    },
    set activeSummaryWindow(
      next: { epoch: number; generation: number } | null,
    ) {
      activeSummaryWindow = next;
    },
    get chatMetadataEpoch(): number {
      return chatMetadataEpoch;
    },
    set chatMetadataEpoch(next: number) {
      chatMetadataEpoch = next;
    },
    capChatSummaryVersions,
  };
}
