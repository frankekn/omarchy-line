/**
 * The push-fed path: a pushed message becomes a ring entry and a chat-list
 * summary (prepareIncomingMessage/onIncomingMessage), and the raw operation
 * stream folds read receipts, reactions and unsends into local state
 * (enil:readop block, onTalkOp). History pages call loadReadRange to seed the
 * read ranges once per open chat.
 *
 * Dependency direction: imports from below -- messages (conversion, preview),
 * refresh (rounds, dirty set), caches, names, state, session, text, protocol,
 * chatsummary. Nothing in this module is imported from above it.
 */
import { summaryMessageIsCurrent } from "../chatsummary.ts";
import {
  capCursors,
  capMap,
  capUnsentBeforePublication,
  cursors,
  finishIncomingMessage,
  isMe,
  memberCache,
  nameCache,
  pendingIncomingMessages,
  REACTION_CACHE_MAX,
  reactionsBeforePublication,
  reactionsByMessage,
  readIndex,
  readRanges,
  rememberBoxCursor,
  replySources,
  unsentBeforePublication,
} from "./caches.ts";
import {
  finalizeMessageState,
  pushedPreviewText,
  toPluginMessage,
} from "./messages.ts";
import { invalidateName } from "./names.ts";
import {
  bumpChatsRevision,
  chats,
  chatSummaryStore,
  chatSummaryVersions,
  dirtyMids,
  me,
  pushEvent,
  setChats,
} from "./state.ts";
import { scheduleRefresh, setForceFullRefresh } from "./refresh.ts";
import { client, sessionGeneration, sessionIsCurrent } from "./session.ts";
import { errorLine, UNSENT_TEXT } from "./text.ts";
import {
  applyReaction,
  asMessageId,
  chatMidOf,
  readRangeToMap,
  summariseReactions,
  talkMetadataChange,
  talkOpEvent,
  talkOpNeedsFullSync,
} from "./protocol.ts";
import type { RawOperationFields } from "./protocol.ts";
import type { Client } from "@evex/linejs";
import type {
  PluginChat,
  PluginEvent,
  PluginMessage,
  TalkMsg,
} from "./types.ts";

/**
 * A pushed message becomes a ring entry carrying exactly what `history` would
 * have returned for it, so the panel appends one bubble instead of re-fetching
 * a page. Its own errors are swallowed: the caller is the push loop, and one
 * malformed message must not stop the next one arriving.
 */
// enil:pushsummary-begin
type ChatSummary = Pick<PluginChat, "lastText" | "lastTime" | "lastFrom">;

function chatSummaryChanged(
  previous: ChatSummary,
  next: ChatSummary,
): boolean {
  if (next.lastTime < previous.lastTime) return false;
  return previous.lastText !== next.lastText ||
    previous.lastTime !== next.lastTime ||
    previous.lastFrom !== next.lastFrom;
}

// summaryMessageIsCurrent moved verbatim to daemon/chatsummary.ts and is
// imported above; the slice test that drives it imports the module directly.

function provisionalChatName(
  chat: string,
  sender: string,
  senderName: string,
  cachedName?: string,
): string {
  if (cachedName) return cachedName;
  return chat.startsWith("u") && sender === chat && senderName
    ? senderName
    : chat;
}
// enil:pushsummary-end

async function prepareIncomingMessage(
  tm: TalkMsg,
  owner: Client | null = client,
  generation: number = sessionGeneration,
): Promise<{
  prepared: {
    raw: TalkMsg["raw"];
    chat: string;
    message: PluginMessage;
  } | null;
  error?: unknown;
}> {
  try {
    if (!owner || !sessionIsCurrent(owner, generation)) {
      return { prepared: null };
    }
    const raw = tm.raw;
    const chat = chatMidOf(raw, String(me.mid ?? ""));
    if (!chat) return { prepared: null };
    const message = await toPluginMessage(
      tm,
      chat,
      false,
      owner,
      generation,
      true,
    );
    if (!sessionIsCurrent(owner, generation)) return { prepared: null };
    return { prepared: { raw, chat, message } };
  } catch (error) {
    // Settle immediately so conversion work started behind an older message
    // can never become an unhandled rejection while publication waits.
    return { prepared: null, error };
  }
}

async function onIncomingMessage(
  incomingId: string,
  preparedWork: ReturnType<typeof prepareIncomingMessage>,
  owner: Client | null = client,
  generation: number = sessionGeneration,
): Promise<void> {
  try {
    const result = await preparedWork;
    if (result.error) throw result.error;
    if (!result.prepared || !owner || !sessionIsCurrent(owner, generation)) {
      return;
    }
    const { raw, chat, message } = result.prepared;
    // Raw operations are delivered before the asynchronously converted
    // message event. A recall can therefore overtake this queued conversion;
    // retain that tombstone even when no cursor existed when the op arrived.
    if (unsentBeforePublication.has(message.id)) {
      const cursor = cursors.get(message.id);
      if (cursor) cursors.set(message.id, { ...cursor, unsent: true });
      reactionsByMessage.delete(message.id);
      replySources.delete(message.id);
      return;
    }
    finalizeMessageState(message, raw, chat);
    const pushedCursor = cursors.get(message.id);
    if (pushedCursor) rememberBoxCursor(chat, pushedCursor);
    // Push already tells us enough to update the visible summary immediately.
    // Leave unread untouched; the following full refresh remains the server
    // authority for counts and reconciles anything the operation omitted.
    const at = chats.findIndex((row) => row.mid === chat);
    const lastText = pushedPreviewText(message, raw);
    const lastTime = message.time;
    const lastFrom = isMe(message.from) ? "我" : message.fromName;
    let publishedSummary = false;
    let repaintedRow = false;
    if (at >= 0) {
      const previous = chats[at];
      const identityIsCurrent = summaryMessageIsCurrent(
        previous.lastTime,
        lastTime,
        chatSummaryStore.chatSummaryMessageIds.get(chat),
        message.id,
      );
      if (
        identityIsCurrent &&
        chatSummaryChanged(previous, { lastText, lastTime, lastFrom })
      ) {
        const rows = chats.slice();
        rows[at] = { ...previous, lastText, lastTime, lastFrom };
        setChats(rows.sort((a, b) => b.lastTime - a.lastTime));
        bumpChatsRevision();
        publishedSummary = true;
        repaintedRow = true;
      } else if (identityIsCurrent) {
        // An exact duplicate can still carry the id needed to match a later
        // recall of the summary currently shown in the chat list.
        publishedSummary = true;
      }
    } else {
      // A push can introduce a chat that was absent from the boxes snapshot
      // currently being built. Publish a complete provisional row so that
      // reconciliation can retain it even if the compensating fetch fails.
      setChats([{
        mid: chat,
        name: provisionalChatName(
          chat,
          message.from,
          message.fromName,
          nameCache.get(chat),
        ),
        unread: isMe(message.from) ? 0 : 1,
        lastText,
        lastTime,
        lastFrom,
      }, ...chats].sort((a, b) => b.lastTime - a.lastTime));
      bumpChatsRevision();
      publishedSummary = true;
    }
    if (publishedSummary) {
      chatSummaryStore.chatSummaryMessageIds.set(chat, message.id);
    }
    chatSummaryStore.summaryCache.delete(chat);
    // The unread debt ledger. A push that repaints a row the list already had
    // leaves unread untouched ("Leave unread untouched" above), so the
    // message it just showed is displayed but not counted -- and the
    // incremental round's strict-newer rule can never see it either, because
    // the push already moved the row's lastTime onto this message. Book one
    // here per pushed message; the incremental round pays the entry off when
    // it rebuilds the row. A push that creates the row counted its message
    // literally (unread 1) and owes nothing; our own messages never belong in
    // the count; a stale or duplicate push showed nothing new.
    const priorDebt = dirtyMids.get(chat)?.pending ?? 0;
    const owesOne = repaintedRow && !isMe(message.from);
    dirtyMids.set(chat, {
      reason: "message",
      pending: priorDebt + (owesOne ? 1 : 0),
    });
    chatSummaryStore.chatSummaryEpoch++;
    // Map#set does not refresh insertion order. Move an existing chat to the
    // end so the cap removes the least recently changed summary.
    chatSummaryVersions.delete(chat);
    chatSummaryVersions.set(chat, chatSummaryStore.chatSummaryEpoch);
    chatSummaryStore.capChatSummaryVersions();
    pushEvent({
      kind: "message",
      chat,
      message,
    });
  } catch (e) {
    console.error("[event] message:", errorLine(e));
  } finally {
    finishIncomingMessage(incomingId, owner, generation);
    capUnsentBeforePublication();
  }
}

// The block between the enil:readop markers is sliced out verbatim by
// daemon/reaction_test.ts on top of stub state; asMessageId comes from the
// readrange block, which the test loads next to it for the same reason talkop
// is loaded on top of reactions.
// enil:readop-begin
/**
 * One read operation folded into readRanges; the return value is the event the
 * panel should hear, null when there is nothing to say. The maps are the
 * daemon's own readRanges/readIndex -- the test supplies stand-ins -- and
 * asMessageId is the readrange block's. Typed structurally so the slice needs
 * no TalkOp: only the fields a read op carries.
 */
function applyReadOp(
  ev: { chat: string; messageId: string; by?: string },
): Omit<PluginEvent, "seq" | "at"> | null {
  const upTo = asMessageId(ev.messageId);
  const by = ev.by ?? "";
  if (upTo === null || !by) return null;
  let lastRead = readRanges.get(ev.chat);
  if (!lastRead) readRanges.set(ev.chat, lastRead = new Map());
  // A reconnect replays the backlog, so an op can be older than what we
  // already know; 已讀 only ever moves forward.
  const prev = lastRead.get(by);
  if (prev !== undefined && prev >= upTo) return null;
  lastRead.set(by, upTo);
  readIndex.delete(ev.chat);
  // op 40 (SEND_CHAT_CHECKED) is decoded with by=ourselves: its cursor says
  // "we read theirs, elsewhere" and is real state -- history rendering uses it
  // -- but it is never "someone read ours", so the panel must not hear it as
  // an event. Announced, a 1:1 would paint our own bubbles 已讀: on the
  // phone's read, on our own markRead's echo, or replayed old from the event
  // ring. readIndexFor already drops us when it builds the index, so keeping
  // the range costs nothing and a peer's op 55 is announced as before.
  if (by === String(me.mid ?? "")) return null;
  return { kind: "read", chat: ev.chat, by, upTo: ev.messageId };
}
// enil:readop-end

/** Read receipts, reactions and unsends, off the raw operation stream. */
function onTalkOp(op: RawOperationFields): void {
  try {
    // A chat rename or contact display-name change does not change the newest
    // message id, which is the summary cache key. Invalidate metadata from the
    // raw operation so the next bounded refresh resolves the new label.
    const metadata = talkMetadataChange(op, String(me.mid ?? ""));
    if (metadata?.kind === "chat") {
      invalidateName(metadata.mid);
      chatSummaryStore.summaryCache.delete(metadata.mid);
      chatSummaryStore.chatSummaryEpoch++;
      chatSummaryStore.chatMetadataEpoch++;
      // A name is row metadata the incremental round never re-resolves on a
      // branch of its own; the next round answers the whole list instead.
      setForceFullRefresh(true);
      scheduleRefresh();
    } else if (metadata?.kind === "profile") {
      invalidateName(metadata.mid);
      memberCache.clear();
      // The changed user may be the sender shown by any group summary. These
      // operations are rare, so clearing the bounded cache is both exact and
      // cheaper than adding permanent profile watchers per row.
      chatSummaryStore.summaryCache.clear();
      chatSummaryStore.chatSummaryEpoch++;
      chatSummaryStore.chatMetadataEpoch++;
      setForceFullRefresh(true);
      scheduleRefresh();
    }
    // The server says our view is inconsistent. Only the full round's
    // box.unreadCount can settle what it saw -- the same answer an
    // own-device read gets below.
    if (talkOpNeedsFullSync(op)) {
      setForceFullRefresh(true);
      scheduleRefresh();
      return;
    }
    const ev = talkOpEvent(op, String(me.mid ?? ""));
    if (!ev) return;

    if (ev.kind === "read") {
      // The ranges take every read, ours included; whether the panel hears
      // about it is applyReadOp's call, and ours is the one it withholds.
      const push = applyReadOp(ev);
      // op 40 (SEND_CHAT_CHECKED) arrives as by=ourselves: we read the chat on
      // another device, and the server's unread count moved with no per-box
      // source able to say by how much -- the full round's box.unreadCount is
      // the only authority, exactly as for our own markRead. An incremental
      // round would otherwise pay the next push's pending onto the stale count
      // (5 shown, the phone reads, server 0, +1 arrives, shows 6 instead of 1).
      // A peer's op 55 never moves our unread and keeps the incremental path.
      if (ev.by === String(me.mid ?? "")) {
        setForceFullRefresh(true);
        scheduleRefresh();
      }
      if (push) pushEvent(push);
      return;
    }

    if (ev.kind === "reaction") {
      // An op carries one person's new choice, never the bar; the panel wants
      // the bar. Starting from an empty map when the message was never
      // rendered here is the honest answer -- it is what this process knows --
      // and the next history load replaces it with LINE's own list.
      const byUser = reactionsByMessage.get(ev.messageId) ??
        new Map<string, string>();
      applyReaction(byUser, ev.by ?? "", ev.reaction ?? "");
      if (pendingIncomingMessages.has(ev.messageId) && ev.by) {
        const queued = reactionsBeforePublication.get(ev.messageId) ??
          new Map<string, string>();
        // Keep the raw operation, including UNDO, so conversion can apply it
        // after seeding the older reaction snapshot carried by the message.
        queued.set(ev.by, ev.reaction ?? "");
        reactionsBeforePublication.set(ev.messageId, queued);
      }
      if (byUser.size) {
        reactionsByMessage.set(ev.messageId, byUser);
        capMap(reactionsByMessage, REACTION_CACHE_MAX);
      } else {
        reactionsByMessage.delete(ev.messageId);
      }
      pushEvent({
        kind: "reaction",
        chat: ev.chat,
        messageId: ev.messageId,
        reactions: summariseReactions(byUser, String(me.mid ?? "")),
      });
      return;
    }

    // An unsent bubble has no reactions, no quotable text and no downloadable
    // content left, so drop what is cached about it and mark the cursor -- the
    // panel may still ask `download` for a message it has on screen.
    reactionsByMessage.delete(ev.messageId);
    reactionsBeforePublication.delete(ev.messageId);
    replySources.delete(ev.messageId);
    chatSummaryStore.summaryCache.delete(ev.chat);
    unsentBeforePublication.delete(ev.messageId);
    unsentBeforePublication.set(ev.messageId, true);
    capUnsentBeforePublication();
    if (
      chatSummaryStore.chatSummaryMessageIds.get(ev.chat) === ev.messageId
    ) {
      const at = chats.findIndex((row) => row.mid === ev.chat);
      if (at >= 0 && chats[at].lastText !== UNSENT_TEXT) {
        const rows = chats.slice();
        rows[at] = { ...rows[at], lastText: UNSENT_TEXT };
        setChats(rows);
        bumpChatsRevision();
      }
      chatSummaryStore.chatSummaryEpoch++;
      chatSummaryVersions.delete(ev.chat);
      chatSummaryVersions.set(ev.chat, chatSummaryStore.chatSummaryEpoch);
      chatSummaryStore.capChatSummaryVersions();
    }
    const cursor = cursors.get(ev.messageId);
    if (cursor) {
      cursors.set(ev.messageId, { ...cursor, unsent: true });
      capCursors();
    }
    pushEvent({ kind: "unsend", chat: ev.chat, messageId: ev.messageId });
    // The tombstone above is already on the row; marking the chat dirty is
    // what keeps the debounced round incremental (a cheap no-op for this
    // chat) instead of letting it fall back to a full sweep. A recall neither
    // books nor settles unread debt, so whatever a push booked stands.
    dirtyMids.set(ev.chat, {
      reason: "unsend",
      pending: dirtyMids.get(ev.chat)?.pending ?? 0,
    });
    scheduleRefresh();
  } catch (e) {
    console.error("[event] op:", errorLine(e));
  }
}

/**
 * Re-reads who has read what in one chat. Called when a page of history is
 * built, because that is the only moment the panel can act on it; the read ops
 * keep it current from then on. Failures are silent by design -- 已讀 is a
 * decoration, and a chat with no ranges simply has no readBy fields.
 */
async function loadReadRange(
  chatMid: string,
  owner: Client,
  generation: number,
): Promise<void> {
  if (!sessionIsCurrent(owner, generation)) return;
  try {
    const ranges = await owner.base.talk.getMessageReadRange({
      chatIds: [chatMid],
      syncReason: "INTERNAL",
    });
    if (!sessionIsCurrent(owner, generation)) return;
    if (!Array.isArray(ranges)) return;
    for (const entry of ranges) {
      const map = readRangeToMap(entry);
      // Keyed by the mid we asked about rather than the reply's chatId: one
      // chat was requested, and the panel looks this up by the box it opened.
      if (map.size) {
        readRanges.set(chatMid, map);
        readIndex.delete(chatMid);
      }
    }
  } catch (e) {
    console.error("[read] range:", errorLine(e));
  }
}

export { loadReadRange, onIncomingMessage, onTalkOp, prepareIncomingMessage };
