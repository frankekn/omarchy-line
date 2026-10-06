/**
 * The chat-list rounds: coalescing refreshChats(), the full sweep (runRefresh)
 * and the incremental dirty-chat round. Imports only from below.
 */
import { pooledMap } from "../pool.ts";
import { RefreshDebouncer, systemTimers } from "../refreshcontrol.ts";
import { summaryMessageIsCurrent } from "../chatsummary.ts";
import {
  CHAT_LIMIT,
  DECRYPT_WIDTH,
  INCREMENTAL_REFRESH,
  REFRESH_RETRY_MS,
  timings,
} from "./env.ts";
import { capCursors, cursors, isMe, rememberBoxCursor } from "./caches.ts";
import { avatarNow, avatarTokens } from "./avatars.ts";
import { resolveName } from "./names.ts";
import { e2eeFilePayload, previewText } from "./messages.ts";
import {
  bumpChatsRevision,
  chatListHealth,
  chats,
  chatSummaryStore,
  chatSummaryVersions,
  dirtyMids,
  noteRefreshFailed,
  noteRefreshOk,
  setChatListHealth,
  setChats,
  stateWriteOwed,
  writeState,
} from "./state.ts";
import { client, sessionGeneration, sessionIsCurrent } from "./session.ts";
import { classifyLoginError } from "./text.ts";
import { haltForRestriction, restriction } from "./restriction.ts";
import type { Client } from "@evex/linejs";
import type { PluginChat } from "./types.ts";

// Set by every situation the incremental round must not answer: the first
// round of a session, a rename, a push reconnect, a manual sync, the round
// after a read receipt, a burst wider than the cap, any incremental failure.
// The next full round that publishes clears it. True from boot.
let forceFullRefresh = true;
export let refreshing = false;
export let refreshAgain = false;
export let refreshGeneration = 0;

/**
 * The talk side's health, published in state.json as `refresh` (README 契約).
 * It remains independent of push-link health because those connections can
 * recover separately. The tracker writes promptly only on a failure edge.
 */
/**
 * The round currently on the wire, so a caller that needs a *fresh* answer can
 * wait it out instead of taking the coalescing `true`. Only syncNow() does:
 * every other caller wants the coalescing, which is what keeps a burst of push
 * events from firing one getMessageBoxes each.
 */
export let refreshInFlight: Promise<boolean> | null = null;
/** The single pending post-failure retry, so retries can never stack. */
let refreshRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearRefreshRetry(): void {
  if (refreshRetryTimer === null) return;
  clearTimeout(refreshRetryTimer);
  refreshRetryTimer = null;
}

const refreshDebouncer = new RefreshDebouncer({
  run: () => void refreshChats(),
  ...systemTimers,
});

function scheduleRefresh(now: number = performance.now()): void {
  refreshDebouncer.schedule(now);
}

// The summary cache and its epoch bookkeeping moved verbatim into
// daemon/chatsummary.ts: one store for the process, with the chat-list cap
// (CHAT_LIMIT) ours to lend. The rounds below read and write the state
// through the store's accessors -- the rebindable maps included, because a
// finished round swaps the whole cache for the one it built.

// capChatSummaryVersions moved verbatim into daemon/chatsummary.ts, beside the
// state it caps; the push paths call it through the store above.

/**
 * The coalescing entry point. True when the list is fresh (or a round that will
 * make it fresh is already on the wire). Only syncNow() reads the value; every
 * other caller is fire-and-forget, which is why the failure path stays silent.
 */
async function refreshChats(waitForCurrent = false): Promise<boolean> {
  const c = client;
  if (!c) return false;
  const generation = sessionGeneration;
  if (refreshing && refreshGeneration === generation) { // coalesce bursts
    refreshAgain = true;
    // Not a failure: a refresh is already on the wire and refreshAgain queues
    // one more behind it, so the list does get fresh within the same seconds.
    // Answering `false` here would make a caller that landed on top of an
    // incoming message treat work that is about to succeed as a failure.
    // Callers that need the *result* of a round wait on refreshInFlight first.
    if (waitForCurrent && refreshInFlight) return await refreshInFlight;
    return true;
  }
  // A stale round from a session that just logged out must not hold the new
  // session behind its socket timeout.
  if (refreshing && refreshGeneration !== generation) refreshing = false;
  const round = startRound(c, generation);
  refreshInFlight = round;
  try {
    return await round;
  } finally {
    // A queued re-run inside runRefresh()'s own finally has already published
    // itself here by now, and it is the one still on the wire -- so only clear
    // the handle if it is still pointing at this round.
    if (refreshInFlight === round) refreshInFlight = null;
  }
}

/**
 * One actual round: one getMessageBoxes, and one state.json write when the
 * round changed something the panel shows.
 */
async function runRefresh(c: Client, generation: number): Promise<boolean> {
  if (!sessionIsCurrent(c, generation)) return false;
  const started = performance.now();
  const summaryEpoch = chatSummaryStore.chatSummaryEpoch;
  const summaryWindow = { epoch: summaryEpoch, generation };
  chatSummaryStore.activeSummaryWindow = summaryWindow;
  const metadataEpoch = chatSummaryStore.chatMetadataEpoch;
  refreshing = true;
  refreshGeneration = generation;
  try {
    const boxes = await c.base.talk.getMessageBoxes({
      messageBoxListRequest: {
        withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 1,
        messageBoxCountLimit: CHAT_LIMIT,
        activeOnly: true,
      },
    });
    const nextBoxCursors = new Set<string>();
    {
      // One line per refresh so "are 1:1 chats missing?" is answerable from
      // the journal without a second client holding the session.
      const kinds: Record<string, number> = {};
      for (const b of boxes.messageBoxes ?? []) {
        const k = String(b.midType ?? String(b.id)[0]);
        kinds[k] = (kinds[k] ?? 0) + 1;
      }
      console.log(
        `[chats] boxes=${
          (boxes.messageBoxes ?? []).length
        } hasNext=${boxes.hasNext} kinds=${JSON.stringify(kinds)}`,
      );
    }
    const nextCache = new Map<
      string,
      { lastMessageId: string; chat: PluginChat }
    >();
    const nextSummaryMessageIds = new Map<string, string>();
    // Pass 1 (cheap, sequential): cursor and summary bookkeeping, cache
    // hits in place, and a work list of cache misses. The misses each do an
    // E2EE decrypt plus name lookups, which used to run one box at a time
    // -- on the first refresh after login every box is a miss, so that
    // serial chain was the whole wait for the list.
    const rows: Array<PluginChat | undefined> = [];
    let hits = 0;
    const misses: Array<{
      at: number;
      boxId: string;
      lastMessageId: string;
      last:
        | NonNullable<
          NonNullable<typeof boxes.messageBoxes>[number]["lastMessages"]
        >[number]
        | null;
      unread: number;
      cacheable: boolean;
    }> = [];
    for (const box of boxes.messageBoxes ?? []) {
      if (!sessionIsCurrent(c, generation)) return false;
      const last = box.lastMessages?.[0];
      const boxId = String(box.id);
      const lastMessageId = String(last?.id ?? "");
      if (lastMessageId) nextSummaryMessageIds.set(boxId, lastMessageId);
      const unread = Number(box.unreadCount ?? 0);
      if (box.lastDeliveredMessageId) {
        const boxCursor = `box:${box.id}`;
        nextBoxCursors.add(boxCursor);
        rememberBoxCursor(boxId, {
          chat: boxId,
          messageId: BigInt(box.lastDeliveredMessageId.messageId),
          deliveredTime: BigInt(box.lastDeliveredMessageId.deliveredTime),
        });
      }
      // A message without an id cannot be compared, so it never enters the
      // cache -- otherwise its preview would freeze forever.
      const cacheable = !last || lastMessageId !== "";
      const hit = cacheable
        ? chatSummaryStore.summaryCache.get(boxId)
        : undefined;
      if (hit && hit.lastMessageId === lastMessageId) {
        // Never mutate the currently published row. Apart from making a
        // heartbeat look like a data change to QML, it made change detection
        // compare the new list against objects it had already modified.
        const chat = { ...hit.chat, unread };
        // Only ever set, never cleared: a picture that has just changed is
        // still being fetched, and blanking the row until it lands would show
        // the user a gap where their own chat list used to be.
        const avatar = avatarNow(boxId, c, generation);
        if (avatar) chat.avatarPath = avatar;
        else if (!avatarTokens.has(boxId)) delete chat.avatarPath;
        rows.push(chat);
        nextCache.set(boxId, { lastMessageId, chat });
        hits++;
        continue;
      }
      misses.push({
        at: rows.length,
        boxId,
        lastMessageId,
        last: last ?? null,
        unread,
        cacheable,
      });
      rows.push(undefined);
    }
    const poolStarted = performance.now();
    const built = await pooledMap(
      misses,
      DECRYPT_WIDTH,
      async (miss) => {
        const { boxId, last, unread } = miss;
        let lastText = "";
        let lastFrom = "";
        let lastTime = 0;
        let decryptFailed = false;
        if (last) {
          lastTime = Number(last.createdTime ?? 0);
          // The preview line says who spoke last, and for ourselves the panel
          // expects the literal 我 -- resolveName deliberately keeps returning
          // our display name, which the conversation view needs.
          lastFrom = isMe(String(last.from ?? ""))
            ? "我"
            : await resolveName(String(last.from ?? ""), c, generation);
          try {
            const tm = await c.base.e2ee.decryptE2EEMessage(last)
              .catch(() => {
                decryptFailed = true;
                return last;
              });
            lastText = previewText(
              tm.text ?? "",
              last,
              await e2eeFilePayload(last, c, generation),
            );
          } catch {
            decryptFailed = true;
            lastText = "[E2EE 解密失敗]";
          }
        }
        const chat: PluginChat = {
          mid: boxId,
          name: await resolveName(boxId, c, generation),
          unread,
          lastText,
          lastTime,
          lastFrom,
        };
        // resolveName() above is what fills the token, so this reads it
        // after.
        const avatar = avatarNow(boxId, c, generation);
        if (avatar) chat.avatarPath = avatar;
        return { chat, decryptFailed };
      },
      () => sessionIsCurrent(c, generation),
    );
    if (built === null) {
      // The session retired mid-pool. The callers' generation checks make
      // this round a quiet no-answer, not a failure the health state would
      // count and the panel would banner.
      return false;
    }
    // One line per round so the pool's contribution is answerable from the
    // journal, and the same numbers land in state.json's rolling stats.
    timings.record("chats.decrypt", performance.now() - poolStarted);
    console.log(
      `[chats] decrypt hits=${hits} miss=${misses.length} width=${DECRYPT_WIDTH}`,
    );
    for (let i = 0; i < built.length; i++) {
      const { chat, decryptFailed } = built[i];
      const miss = misses[i];
      rows[miss.at] = chat;
      // A decrypt that failed used to be retried on every refresh; caching
      // it would freeze the fallback text until the box gets a newer
      // message.
      if (miss.cacheable && !decryptFailed) {
        nextCache.set(miss.boxId, { lastMessageId: miss.lastMessageId, chat });
      }
    }
    const next = rows.filter((row): row is PluginChat => row !== undefined);
    // Logout/new login may have happened while names and previews were being
    // resolved. None of this round belongs to the current state in that case.
    if (!sessionIsCurrent(c, generation)) return false;
    // A push can overtake this boxes snapshot while names and previews are
    // resolving. Merge only its summary fields into the fetched row: the
    // snapshot remains authoritative for unread counts and membership, while
    // a continuous push stream cannot starve this refresh forever.
    if (summaryEpoch !== chatSummaryStore.chatSummaryEpoch) {
      const pushedByMid = new Map(chats.map((row) => [row.mid, row]));
      const included = new Set<string>();
      for (let i = 0; i < next.length; i++) {
        const mid = next[i].mid;
        included.add(mid);
        if ((chatSummaryVersions.get(mid) ?? 0) <= summaryEpoch) continue;
        const pushed = pushedByMid.get(mid);
        if (!pushed) continue;
        const pushedMessageId = chatSummaryStore.chatSummaryMessageIds.get(mid);
        if (
          summaryMessageIsCurrent(
            Number(next[i].lastTime || 0),
            Number(pushed.lastTime || 0),
            nextSummaryMessageIds.get(mid),
            pushedMessageId ?? "",
          )
        ) {
          next[i] = {
            ...next[i],
            lastText: pushed.lastText,
            lastTime: pushed.lastTime,
            lastFrom: pushed.lastFrom,
          };
          if (pushedMessageId) {
            nextSummaryMessageIds.set(mid, pushedMessageId);
          }
          nextCache.delete(mid);
        }
      }
      for (const pushed of chats) {
        if (
          included.has(pushed.mid) ||
          (chatSummaryVersions.get(pushed.mid) ?? 0) <= summaryEpoch
        ) continue;
        next.push({ ...pushed });
        const pushedMessageId = chatSummaryStore.chatSummaryMessageIds.get(
          pushed.mid,
        );
        if (pushedMessageId) {
          nextSummaryMessageIds.set(pushed.mid, pushedMessageId);
        }
        nextCache.delete(pushed.mid);
      }
    }
    // A rename/profile operation can invalidate a row after this round has
    // already resolved its name. Do not reinstall those stale cache entries;
    // the coalesced refresh will resolve metadata again.
    if (metadataEpoch !== chatSummaryStore.chatMetadataEpoch) nextCache.clear();
    // Only a complete response proves that an omitted box disappeared. A
    // partial first page must retain cursors for chats the panel can still
    // have open or cached.
    if (boxes.hasNext !== true) {
      for (const key of cursors.keys()) {
        if (!key.startsWith("box:") || nextBoxCursors.has(key)) continue;
        const mid = key.slice("box:".length);
        const retainedPush =
          (chatSummaryVersions.get(mid) ?? 0) > summaryEpoch &&
          next.some((row) => row.mid === mid);
        if (!retainedPush) cursors.delete(key);
      }
    }
    capCursors();
    // Replace rather than merge: boxes that dropped out of the list must not
    // keep an entry forever.
    const sorted = next.sort((a, b) => b.lastTime - a.lastTime);
    const nextListHealth = {
      complete: boxes.hasNext !== true,
      loaded: sorted.length,
    };
    if (
      JSON.stringify(chats) !== JSON.stringify(sorted) ||
      JSON.stringify(chatListHealth) !== JSON.stringify(nextListHealth)
    ) {
      bumpChatsRevision();
    }
    chatSummaryStore.summaryCache = nextCache;
    chatSummaryStore.chatSummaryMessageIds = nextSummaryMessageIds;
    setChats(sorted);
    setChatListHealth(nextListHealth);
    // Before the write, so the fresh `at` and the fresh chats land together.
    noteRefreshOk();
    // Most full rounds answer exactly what the list already shows -- a read
    // receipt or an own-device read forces one just to settle unread -- and
    // rewriting ~64 KB with an fsync made every open panel re-parse the whole
    // file for nothing. stateWriteOwed() says whether the file is behind on
    // anything the panel displays; when it is not, the heartbeat carries the
    // fresh `refresh.at` and timings within 30s, and `online` never noticed
    // the difference.
    if (stateWriteOwed()) await writeState();
    // Logout/new login can land while the atomic state write is pending. The
    // new session owns its retry timer; an old round must not clear it.
    if (!sessionIsCurrent(c, generation)) return false;
    chatSummaryStore.lastRefreshSummaryEpoch = summaryEpoch;
    // This round just answered for the whole list from the server, so
    // nothing is pending behind it and the next one may be incremental
    // again.
    forceFullRefresh = false;
    dirtyMids.clear();
    clearRefreshRetry();
    return true;
  } catch (e) {
    if (!sessionIsCurrent(c, generation)) return false;
    console.error("[chats] refresh failed:", (e as Error).message);
    const kind = classifyLoginError(e);
    noteRefreshFailed(kind);
    if (kind === "restricted") haltForRestriction(e);
    // guardedFetch now makes a dead post-suspend connection fail within 30s
    // instead of hanging, but the next scheduled refresh would still be the
    // 5-minute poll -- so take one shot sooner. Not "one only" in practice:
    // any external trigger (a push event, the panel) that lands inside
    // another round's 30s window queues a refreshAgain, whose failure arms
    // this timer again -- so while the network stays down, rounds chain every
    // 30-45s, and the moment the kernel reaps the dead socket the next one
    // heals the list (09-11 that cadence is exactly what picked it back up).
    // Wanted: this timer guarantees the *first* retry, it does not cap the
    // chain; the cap is REQUEST_TIMEOUT_MS per round plus this delay.
    if (kind === "network") {
      clearRefreshRetry();
      refreshRetryTimer = setTimeout(() => {
        refreshRetryTimer = null;
        if (sessionIsCurrent(c, generation)) void refreshChats();
      }, REFRESH_RETRY_MS);
    }
    return false;
  } finally {
    if (chatSummaryStore.activeSummaryWindow === summaryWindow) {
      chatSummaryStore.activeSummaryWindow = null;
      chatSummaryStore.capChatSummaryVersions();
    }
    timings.record("chats.refresh", performance.now() - started);
    // An old round must not clear or consume the new session's coalescing
    // state after logout/login raced its completion.
    if (refreshGeneration === generation) {
      refreshing = false;
      if (refreshAgain && sessionIsCurrent(c, generation)) {
        refreshAgain = false;
        // Start the coalesced round immediately, but let this round's caller
        // observe its completed snapshot even if pushes never stop arriving.
        void refreshChats();
      } else {
        refreshAgain = false;
      }
    }
  }
}

// The block between the enil:incremental markers is sliced out verbatim by
// daemon/refreshsession_test.ts on top of the runRefresh block, so it may only
// reach for what that test's stub prelude provides, exactly like the full
// round does.
// enil:incremental-begin
// Above this many dirty chats, one full sweep is cheaper than one request per
// chat -- and the same number as the decrypt pool's width, whose shape the
// per-chat work copies.
const INCREMENTAL_MAX_CHATS = 8;

/**
 * Whether the next round may answer only the dirty chats. The kill switch and
 * the cap live here; every other exit condition lands in forceFullRefresh
 * instead, so it survives coalescing and is consumed by the round that
 * actually starts.
 */
function incrementalRefreshDue(): boolean {
  if (!INCREMENTAL_REFRESH) return false;
  if (dirtyMids.size === 0) return false;
  return dirtyMids.size <= INCREMENTAL_MAX_CHATS;
}

/**
 * Picks the round kind for one refresh. Kept next to runRefresh so the tests
 * that drive the full round drive this decision with it.
 */
async function startRound(c: Client, generation: number): Promise<boolean> {
  // Every automatic caller (the poll, the debouncer, the retry timer, the
  // refreshAgain chain) funnels through here; a halted account answers them
  // all with "not fresh" and no request. syncNow lifts the halt before it
  // asks, so the one round a user wanted still runs.
  if (restriction) return false;
  if (forceFullRefresh || !incrementalRefreshDue()) {
    return await runRefresh(c, generation);
  }
  return await runIncrementalRefresh(c, generation);
}

/**
 * The push-fed alternative to a full getMessageBoxes sweep. A push already
 * said which chats changed and published their summaries; re-reading all
 * ~122 boxes to touch up a handful of rows is the expensive part of every
 * burst. This round re-reads at most INCREMENTAL_MAX_CHATS dirty chats -- one
 * getRecentMessagesV2 each, decrypted through the same pool the full round
 * uses -- and replaces exactly those rows.
 *
 * What it deliberately does not own: chatListHealth.complete and the box:
 * cursor GC are claims about the whole list, and only a full round may make
 * or retract them. Unread counts have no per-box source, so the round touches
 * them only when it is provable: a fetched message strictly newer than the
 * row's summary, plus the debt the push path booked for messages it displayed
 * without counting. Everything else is left alone -- the next full round
 * remains the authority that corrects anything this round got wrong. Any
 * surprise -- a chat the box API refuses, a decrypt that fails, a whole-round
 * error -- sets forceFullRefresh so the next round answers the whole list,
 * and a refused chat also arms the retry timer a whole-round failure arms.
 */
async function runIncrementalRefresh(
  c: Client,
  generation: number,
): Promise<boolean> {
  if (!sessionIsCurrent(c, generation)) return false;
  const started = performance.now();
  refreshing = true;
  refreshGeneration = generation;
  // Take the set and drop it in one step: a push landing mid-round re-adds
  // its mid and the coalescing queues the next round for it, so iterating a
  // snapshot costs nothing. The snapshot carries each entry's booked debt --
  // paying it is this round's job, and an install that does not happen puts
  // it back.
  const pending = [...dirtyMids];
  dirtyMids.clear();
  let fetched = 0;
  let perMidFailed = false;
  try {
    const built = await pooledMap(
      pending,
      DECRYPT_WIDTH,
      async ([mid, entry]): Promise<{
        mid: string;
        chat: PluginChat | null;
        messageId: string;
        /** Unread debt still owed if this chat's row is not installed. */
        pending: number;
        /** Count-only touch-up; the row's content is already local. */
        unreadOnly?: boolean;
      }> => {
        // The tombstone is already on the row, drawn locally when the
        // operation arrived. Re-reading the box now could still answer with
        // the pre-recall content and paint the message back, so an unsend
        // costs exactly nothing here; the row stands until the next full
        // round confirms it against the server. Debt a push booked before
        // the recall is still owed, though, and this branch is the round's
        // only look at the chat: pay it onto the standing row without an
        // API call. No standing row, nothing to pay onto.
        if (entry.reason === "unsend") {
          if (entry.pending === 0) {
            return { mid, chat: null, messageId: "", pending: 0 };
          }
          const standing = chats.find((row) => row.mid === mid);
          if (!standing) {
            return { mid, chat: null, messageId: "", pending: 0 };
          }
          return {
            mid,
            unreadOnly: true,
            messageId: "",
            pending: entry.pending,
            chat: {
              ...standing,
              unread: Number(standing.unread ?? 0) + entry.pending,
            },
          };
        }
        let messages;
        try {
          messages = await c.base.talk.getRecentMessagesV2({
            messageBoxId: mid,
            messagesCount: 1,
          });
        } catch (e) {
          // One chat the API will not answer: leave its row as the push
          // rendered it, and answer the whole list next time. The booked
          // debt rides on the re-added entry -- it was not paid.
          console.error(
            "[chats] incremental fetch failed:",
            (e as Error).message,
          );
          forceFullRefresh = true;
          perMidFailed = true;
          const live = dirtyMids.get(mid);
          dirtyMids.set(mid, {
            reason: entry.reason,
            pending: entry.pending + (live?.pending ?? 0),
          });
          return { mid, chat: null, messageId: "", pending: 0 };
        }
        fetched++;
        const last = (Array.isArray(messages) ? messages : [])[0] ?? null;
        // The full round's miss path, on one message.
        let lastText = "";
        let lastFrom = "";
        let lastTime = 0;
        let decryptFailed = false;
        if (last) {
          lastTime = Number(last.createdTime ?? 0);
          // Same rule as the miss path: for ourselves the panel expects the
          // literal 我.
          lastFrom = isMe(String(last.from ?? ""))
            ? "我"
            : await resolveName(String(last.from ?? ""), c, generation);
          try {
            const tm = await c.base.e2ee.decryptE2EEMessage(last)
              .catch(() => {
                decryptFailed = true;
                return last;
              });
            lastText = previewText(
              tm.text ?? "",
              last,
              await e2eeFilePayload(last, c, generation),
            );
          } catch {
            decryptFailed = true;
            lastText = "[E2EE 解密失敗]";
          }
          if (decryptFailed) {
            // Caching the fallback text would freeze it until a newer
            // message, exactly the rule the full round's miss path follows;
            // keep the row that is shown and let a full round rebuild this
            // one. The booked debt rides on the re-added entry.
            forceFullRefresh = true;
            perMidFailed = true;
            const live = dirtyMids.get(mid);
            dirtyMids.set(mid, {
              reason: entry.reason,
              pending: entry.pending + (live?.pending ?? 0),
            });
            return { mid, chat: null, messageId: "", pending: 0 };
          }
        }
        const existing = chats.find((row) => row.mid === mid);
        // Two provable sources, nothing else. entry.pending is the debt the
        // push path booked: messages it displayed on a row it already had,
        // which it deliberately left uncounted and which the strict-newer
        // rule below can never see, because the push already moved the row's
        // lastTime onto them. A fetched message strictly newer than the
        // row's summary is provably not in its unread count: the push path
        // leaves a row it already had untouched ("Leave unread untouched")
        // and its only increment is the literal 1 on a row it creates for a
        // message that then is the row's summary. Equal-or-older fetched
        // mail is inside the server count the last full round installed, and
        // our own messages never belong in it. When unsure, add nothing --
        // the next full round is the authority on counts.
        let unread = Number(existing?.unread ?? 0) + entry.pending;
        if (
          last && !isMe(String(last.from ?? "")) &&
          lastTime > Number(existing?.lastTime ?? 0)
        ) {
          unread += 1;
        }
        const chat: PluginChat = {
          mid,
          name: await resolveName(mid, c, generation),
          unread,
          lastText,
          lastTime,
          lastFrom,
        };
        // resolveName() above is what fills the token, so this reads it
        // after -- same order as the miss path.
        const avatar = avatarNow(mid, c, generation);
        if (avatar) chat.avatarPath = avatar;
        else if (existing?.avatarPath) chat.avatarPath = existing.avatarPath;
        return {
          mid,
          chat,
          messageId: String(last?.id ?? ""),
          pending: entry.pending,
        };
      },
      () => sessionIsCurrent(c, generation),
    );
    if (built === null) return false;
    if (!sessionIsCurrent(c, generation)) return false;
    const rows = chats.slice();
    let changed = 0;
    for (const item of built) {
      if (!item.chat) continue;
      const at = rows.findIndex((row) => row.mid === item.mid);
      const existing = at >= 0 ? rows[at] : undefined;
      // A push landing while this fetch was in flight may already show a
      // newer message than the box answered with; keep the newer one. Its
      // mid is dirty again either way, so the next round re-reads it -- and
      // the unread debt this item carried was not paid, so it goes back on
      // the book on top of whatever the racing push booked. An unread-only
      // touch-up copies the standing row's own summary, so there is no
      // fetched identity to lose and no guard to pass.
      if (
        existing && !item.unreadOnly &&
        !summaryMessageIsCurrent(
          existing.lastTime,
          item.chat.lastTime,
          chatSummaryStore.chatSummaryMessageIds.get(item.mid),
          item.messageId,
        )
      ) {
        if (item.pending > 0) {
          const live = dirtyMids.get(item.mid);
          dirtyMids.set(item.mid, {
            reason: "message",
            pending: item.pending + (live?.pending ?? 0),
          });
        }
        continue;
      }
      if (existing && JSON.stringify(existing) === JSON.stringify(item.chat)) {
        if (item.messageId) {
          // Same pixels -- but the next full round only hits its summary
          // cache when the basis moves to the message just fetched.
          chatSummaryStore.summaryCache.set(item.mid, {
            lastMessageId: item.messageId,
            chat: item.chat,
          });
          chatSummaryStore.chatSummaryMessageIds.set(item.mid, item.messageId);
        }
        continue;
      }
      if (at >= 0) rows[at] = item.chat;
      else rows.push(item.chat);
      changed++;
      if (item.messageId) {
        chatSummaryStore.summaryCache.set(item.mid, {
          lastMessageId: item.messageId,
          chat: item.chat,
        });
        chatSummaryStore.chatSummaryMessageIds.set(item.mid, item.messageId);
      }
    }
    // One line per round, same as the full round's, so the journal can tell
    // the two kinds apart without another client holding the session.
    console.log(
      `[chats] incremental dirty=${pending.length} fetched=${fetched} changed=${changed}`,
    );
    if (changed > 0) {
      // The sort is the same lastTime order the full round publishes, and a
      // row that dropped out of the list is the full round's call to make --
      // an incremental round only replaces or appends.
      setChats(rows.sort((a, b) => b.lastTime - a.lastTime));
      bumpChatsRevision();
    }
    // Before the write, so the fresh `at` and the fresh chats land together.
    // A round with a refused chat is not a clean round: it must not report
    // recovery to the health tracker on behalf of the chat that did not
    // make it.
    if (fetched > 0 && !perMidFailed) noteRefreshOk();
    if (changed > 0) await writeState();
    if (!sessionIsCurrent(c, generation)) return false;
    if (perMidFailed) {
      // Every chat that failed kept its row and its re-added dirty entry,
      // and forceFullRefresh already names the next round full -- but
      // nothing would act on them: the outer retry chain only reacts to a
      // `false` round, and this one answers true so the panel is not
      // alarmed over a row it cannot see. Arm the same timer a whole-round
      // network failure arms, so the repairing sweep runs in
      // REFRESH_RETRY_MS instead of waiting for the five-minute backstop
      // or the next push.
      clearRefreshRetry();
      refreshRetryTimer = setTimeout(() => {
        refreshRetryTimer = null;
        if (sessionIsCurrent(c, generation)) void refreshChats();
      }, REFRESH_RETRY_MS);
    }
    return true;
  } catch (e) {
    if (!sessionIsCurrent(c, generation)) return false;
    const kind = classifyLoginError(e);
    console.error("[chats] incremental refresh failed:", (e as Error).message);
    noteRefreshFailed(kind);
    if (kind === "restricted") haltForRestriction(e);
    // The retry that follows must answer the whole list, not re-read the
    // same handful of chats that just failed.
    forceFullRefresh = true;
    if (kind === "network") {
      clearRefreshRetry();
      refreshRetryTimer = setTimeout(() => {
        refreshRetryTimer = null;
        if (sessionIsCurrent(c, generation)) void refreshChats();
      }, REFRESH_RETRY_MS);
    }
    return false;
  } finally {
    timings.record("chats.refresh", performance.now() - started);
    // Same coalescing contract as the full round: an old generation leaves
    // the new session's state alone.
    if (refreshGeneration === generation) {
      refreshing = false;
      if (refreshAgain && sessionIsCurrent(c, generation)) {
        refreshAgain = false;
        void refreshChats();
      } else {
        refreshAgain = false;
      }
    }
  }
}
// enil:incremental-end

/** Login resets the round bookkeeping it retires; see logoutClaimed. */
export function resetRefreshRound(generation: number): void {
  refreshing = false;
  refreshAgain = false;
  refreshGeneration = generation;
  refreshInFlight = null;
}

/** Push paths, login edges, the socket, the watchdog and manual sync flip
 * this through the accessor; the round that publishes clears it verbatim. */
export function setForceFullRefresh(value: boolean): void {
  forceFullRefresh = value;
}

export { clearRefreshRetry, refreshChats, refreshDebouncer, scheduleRefresh };
