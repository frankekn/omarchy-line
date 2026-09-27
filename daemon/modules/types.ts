/**
 * Shared wire types: the JSON shapes this daemon publishes to the panel
 * (state.json fields and socket replies) plus the small aliases every module
 * passes around. The interface declarations are moved verbatim out of the
 * former daemon.ts header; `Mention` and `MediaState` stay inside their
 * enil:-marker blocks (protocol.ts / text.ts) because the slice tests compile
 * those blocks standalone, so this module type-imports them.
 *
 * Dependency direction: types.ts is a leaf. It imports types only, and every
 * other module may import from it.
 */
import type { TalkMessage } from "@evex/linejs";
import type { Mention } from "./protocol.ts";
import type { MediaState } from "./text.ts";

type Json = Record<string, unknown>;

interface PluginChat {
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

interface PluginMessage {
  id: string;
  chat: string;
  from: string;
  fromName: string;
  text: string;
  time: number;
  contentType: string;
  decryptFailed: boolean;
  hasMedia: boolean;
  unsent: boolean;
  mediaState: MediaState;
  expiresAt?: number;
  mediaPath?: string;
  /** Safe to fetch lazily without downloading an entire E2EE video. */
  previewable?: boolean;
  altText?: string;
  flexImages?: string[];
  stickerUrl?: string;
  fileName?: string;
  fileSize?: number;
  mentions?: PluginMention[];
  replyTo?: PluginReplyTo;
  reactions?: PluginReaction[];
  readBy?: PluginReadBy;
  fromAvatar?: string;
  /** Stable panel request token echoed through LINE content metadata. */
  requestId?: string;
}

/** A Mention with the display name resolved, which is what the panel gets. */
interface PluginMention extends Mention {
  name: string;
}

/**
 * The quoted message a reply points at. `fromName`/`text` are absent when the
 * target never passed through this process -- see replySources.
 */
interface PluginReplyTo {
  id: string;
  fromName?: string;
  text?: string;
}

/** One row of the reaction bar: the type, how many chose it, and did we. */
interface PluginReaction {
  type: string;
  count: number;
  mine: boolean;
}

/** How many other people have read one of our own messages. */
interface PluginReadBy {
  count: number;
  all: boolean;
}

/**
 * One entry of the `events` ring in state.json. `chat` is on every kind so the
 * panel can drop the ones for a conversation it is not showing without looking
 * at the payload.
 */
interface PluginEvent {
  seq: number;
  at: number;
  kind: "message" | "read" | "reaction" | "unsend";
  chat: string;
  /** kind=message: exactly what `history` would have returned for it. */
  message?: PluginMessage;
  /** kind=read: who read, and the newest message id they have read. */
  by?: string;
  upTo?: string;
  /** kind=reaction|unsend. */
  messageId?: string;
  /** kind=reaction: the full new list, not the delta. */
  reactions?: PluginReaction[];
}

/** One row of the `members` reply. */
interface PluginMember {
  mid: string;
  name: string;
}

type TalkMsg = TalkMessage;
/** Pagination needs (messageId, deliveredTime); the plugin only sends an id. */
interface MessageCursor {
  chat: string;
  messageId: bigint;
  deliveredTime: bigint;
  unsent?: boolean;
  expiresAt?: number;
  /** `unsend` has to refuse other people's messages without a round trip. */
  from?: string;
}

export type {
  Json,
  MediaState,
  MessageCursor,
  PluginChat,
  PluginEvent,
  PluginMember,
  PluginMention,
  PluginMessage,
  PluginReaction,
  PluginReadBy,
  PluginReplyTo,
  TalkMsg,
};
