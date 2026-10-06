/**
 * The daemon's bounded in-memory caches and the small helpers that maintain
 * them: contact/name and member-label caches, the message and pagination
 * cursors, the quotable reply-source cache, the reaction and incoming-order
 * bookkeeping, the read ranges with their per-chat sorted index, the generic
 * capMap/cursor-cap eviction, the concurrency limiter the avatar and sticker
 * fetchers share, and the media-cache sweep policy (enil:sweep block).
 *
 * Dependency direction: imports session (sessionIsCurrent), state (me),
 * protocol (readIndexOf), text (errorLine) and env (MEDIA_DIR). Nothing
 * imports caches.ts from above those layers except as plain reads, so the
 * graph stays one-way.
 */
import { MEDIA_DIR } from "./env.ts";
import { readIndexOf } from "./protocol.ts";
import { isGoneError, type MediaState, mediaStateFrom } from "./text.ts";
import { me } from "./state.ts";
import { sessionIsCurrent } from "./session.ts";
import type { Client, TalkMessage } from "@evex/linejs";
import type { MessageCursor, PluginMember } from "./types.ts";

function midKind(mid: string): "user" | "chat" {
  return mid.startsWith("u") ? "user" : "chat";
}

/** Guarded against the empty-mid case: before login `me.mid` is undefined. */
function isMe(mid: string): boolean {
  return !!me.mid && mid === String(me.mid);
}

const nameCache = new Map<string, string>();
const nameCacheEpoch = new Map<string, number>();
const NAME_CACHE_MAX = 5_000;
/**
 * Group member lists, per chat mid. The picker asks for one every time a group
 * is opened, and the list only changes when somebody joins or leaves, so a
 * short cache turns re-opening the same chat all afternoon into one round trip.
 */
const memberCache = new Map<string, { at: number; list: PluginMember[] }>();
const MEMBERS_TTL_MS = 10 * 60_000;
/** getContactsV2 takes a batch; a group can hold 500 members. */
const CONTACT_BATCH = 100;

const cursors = new Map<string, MessageCursor>();
const CURSOR_CACHE_MAX = 20_000;
/** Recently rendered boundaries; several panels may page one chat at once. */
const paginationCursors = new Map<string, string>();

const REPLY_SOURCE_MAX = 500;
const REPLY_TEXT_MAX = 200;
const replySources = new Map<string, { fromName: string; text: string }>();

const REACTION_CACHE_MAX = 1000;
const reactionsByMessage = new Map<string, Map<string, string>>();

type RawWireMessage = TalkMessage["raw"];
/**
 * Wire structs are a few KB each; the cap below bounds the total. A preview
 * or download asks LINE for the whole message again just to reconstruct a
 * TalkMessage whose getData() can run -- the id is enough to look the same
 * struct up here.
 */
const RAW_CACHE_MAX = 4_000;
const rawsById = new Map<string, RawWireMessage>();

/** Recently converted ids stay reachable; evicted ones refetch like before. */
function rememberRaw(id: string, raw: RawWireMessage): void {
  if (!id) return;
  rawsById.delete(id);
  rawsById.set(id, raw);
  capMap(rawsById, RAW_CACHE_MAX);
}
/** Recalls that arrived while an earlier message conversion held the queue. */
const unsentBeforePublication = new Map<string, true>();
const pendingIncomingMessages = new Map<string, number>();
const reactionsBeforePublication = new Map<string, Map<string, string>>();

function trackIncomingMessage(id: string): void {
  if (!id) return;
  pendingIncomingMessages.set(id, (pendingIncomingMessages.get(id) ?? 0) + 1);
}

function finishIncomingMessage(
  id: string,
  owner: Client | null,
  generation: number,
): void {
  if (!id || !owner || !sessionIsCurrent(owner, generation)) return;
  const remaining = (pendingIncomingMessages.get(id) ?? 1) - 1;
  if (remaining > 0) {
    pendingIncomingMessages.set(id, remaining);
    return;
  }
  pendingIncomingMessages.delete(id);
  reactionsBeforePublication.delete(id);
}

function capUnsentBeforePublication(): void {
  while (unsentBeforePublication.size > REACTION_CACHE_MAX) {
    const oldest = [...unsentBeforePublication.keys()].find((id) =>
      !pendingIncomingMessages.has(id)
    );
    if (oldest === undefined) return;
    unsentBeforePublication.delete(oldest);
  }
}

/** chat mid -> member mid -> the newest message id that member has read. */
const readRanges = new Map<string, Map<string, bigint>>();
/**
 * readIndexOf() over the map above, per chat, so a page of history sorts the
 * member list once instead of once per bubble. Dropped, never patched, when
 * the ranges move: rebuilding 553 entries costs less than getting the two
 * copies out of step.
 */
const readIndex = new Map<string, bigint[]>();

function readIndexFor(chatMid: string): bigint[] {
  let sorted = readIndex.get(chatMid);
  if (!sorted) {
    sorted = readIndexOf(readRanges.get(chatMid), String(me.mid ?? ""));
    readIndex.set(chatMid, sorted);
  }
  return sorted;
}

/** Insertion order is age order in a Map, so the oldest key is the first. */
function capMap<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

// The block between the enil:gonemedia markers is sliced out verbatim by
// daemon/gonemedia_test.ts on top of a stub capMap, behind the real
// mediastate block.
// enil:gonemedia-begin
/**
 * Message ids whose bytes OBS answered were gone (404/410, or the empty body
 * upstream linejs fails to decrypt). LINE's expiry stamp can outlive the
 * object, so a message that still reads "ok" from its metadata fetched the
 * same 404 on every chat open; remembering the answer for the session makes
 * the next history page carry mediaState "expired" (the panel then offers
 * neither thumbnail nor download) and refuses the next preview ask before any
 * request. A transient failure (5xx, timeout, busy) is not remembered: the
 * next ask may succeed.
 */
const GONE_MEDIA_MAX = 1000;
const goneMedia = new Map<string, true>();

/** Records a gone object; answers whether the failure was that kind. */
function rememberGoneMedia(id: string, error: Error): boolean {
  if (!isGoneError(error)) return false;
  goneMedia.delete(id);
  goneMedia.set(id, true);
  capMap(goneMedia, GONE_MEDIA_MAX);
  return true;
}

/** mediaStateFrom() with the remembered answer; a recall still wins. */
function mediaStateFor(
  id: string,
  unsent: boolean,
  expiresAt: number | undefined,
  now: number,
): MediaState {
  const state = mediaStateFrom(unsent, expiresAt, now);
  return state === "ok" && goneMedia.has(id) ? "expired" : state;
}
// enil:gonemedia-end

// enil:cursorcap-begin
const PAGINATION_CURSOR_MAX = Math.max(1, Math.floor(CURSOR_CACHE_MAX / 2));

function rememberPaginationCursor(chat: string, cursor: string): void {
  // Keyed by boundary, not by chat: several panels may page one chat at
  // once, and replacing the chat's single entry would unpin a boundary a
  // slower reader is still paging from. An entry leaves only via the cap.
  paginationCursors.delete(cursor);
  paginationCursors.set(cursor, chat);
  while (paginationCursors.size > PAGINATION_CURSOR_MAX) {
    const boundary = paginationCursors.keys().next().value;
    if (boundary === undefined) break;
    paginationCursors.delete(boundary);
    if (!boundary.startsWith("box:")) cursors.delete(boundary);
  }
  capCursors();
}

function capCursors(): void {
  const pinned = new Set(paginationCursors.keys());
  while (cursors.size > CURSOR_CACHE_MAX) {
    const oldest = [...cursors.keys()].find((key) =>
      !key.startsWith("box:") && !pinned.has(key)
    );
    if (oldest === undefined) {
      const boundary = paginationCursors.keys().next().value;
      if (boundary === undefined) return;
      paginationCursors.delete(boundary);
      cursors.delete(boundary);
      continue;
    }
    cursors.delete(oldest);
  }
}

function rememberBoxCursor(chat: string, cursor: MessageCursor): void {
  const key = `box:${chat}`;
  const current = cursors.get(key);
  if (current && current.messageId > cursor.messageId) return;
  cursors.delete(key);
  cursors.set(key, cursor);
  capCursors();
}
// enil:cursorcap-end

/**
 * At most `max` of the given work running at once; the rest wait their turn
 * in arrival order.
 *
 * A cold start asks for a picture per chat -- 122 of them in one pass, plus
 * one per distinct sender in every page of history -- and firing that at a
 * CDN in parallel is what a fetch storm looks like from the other side. The
 * slot is handed straight from the finishing call to the next waiter rather
 * than released and re-taken, because between a decrement and the waiter's
 * microtask a fresh caller would see a free slot that is already spoken for.
 */
function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// The block between the enil:sweep markers is sliced out verbatim by
// daemon/sweep_test.ts on top of a stub MEDIA_DIR; same reason as the
// watchdog markers below. Keep it free of module state.
// enil:sweep-begin
// The cache only exists to avoid re-downloading, and cacheMedia refetches on a
// miss, so entries are always safe to drop. Unbounded, video thumbnails plus
// every original the user has opened would fill ~/.local/state.
const MEDIA_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MEDIA_MAX_BYTES = 500 * 1024 * 1024;
const MEDIA_SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Deletes aged-out and then oldest-first overflow entries under `dir`.
 *
 * The policy is arguments rather than constants because the avatar cache is
 * the same eviction with a different rule -- no age limit, a much smaller
 * quota -- and a second copy of the readDir/lstat/sort/remove loop is how the
 * two would drift apart. `label` only names the log line.
 */
export async function sweepMedia(
  dir: string = MEDIA_DIR,
  now: number = Date.now(),
  maxAgeMs: number = MEDIA_MAX_AGE_MS,
  maxBytes: number = MEDIA_MAX_BYTES,
  label = "sweep",
): Promise<{ removed: number; freed: number; kept: number; bytes: number }> {
  const files: { path: string; mtime: number; size: number }[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      // Plain files in this one directory only: no recursion and no following
      // symlinks, so a sweep can never reach outside MEDIA_DIR.
      if (!e.isFile) continue;
      const path = `${dir}/${e.name}`;
      try {
        const st = await Deno.lstat(path);
        if (!st.isFile) continue;
        // A filesystem that cannot report mtime would otherwise look like epoch
        // 0 and be evicted immediately; treat it as brand new instead.
        files.push({ path, mtime: st.mtime?.getTime() ?? now, size: st.size });
      } catch { /* raced with another sweep or a download */ }
    }
  } catch (e) {
    // No cache directory yet is the normal state before the first download,
    // not an error worth logging on every sweep.
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`[media] ${label}:`, (e as Error).message);
    }
    return { removed: 0, freed: 0, kept: 0, bytes: 0 };
  }

  files.sort((a, b) => a.mtime - b.mtime); // oldest evicted first
  let total = files.reduce((n, f) => n + f.size, 0);
  let removed = 0, freed = 0;
  for (const f of files) {
    const aged = now - f.mtime > maxAgeMs;
    // Sorted oldest-first, so once an entry is neither aged out nor over quota
    // nothing after it can be either.
    if (!aged && total <= maxBytes) break;
    try {
      await Deno.remove(f.path);
      removed++;
      freed += f.size;
      total -= f.size;
    } catch { /* already gone */ }
  }
  const kept = files.length - removed;
  console.log(
    `[media] ${label}: removed ${removed} (${(freed / 1e6).toFixed(1)} MB), ` +
      `kept ${kept} (${(total / 1e6).toFixed(1)} MB)`,
  );
  return { removed, freed, kept, bytes: total };
}
// enil:sweep-end

export {
  capCursors,
  capMap,
  capUnsentBeforePublication,
  CONTACT_BATCH,
  CURSOR_CACHE_MAX,
  cursors,
  finishIncomingMessage,
  goneMedia,
  isMe,
  limiter,
  MEDIA_MAX_AGE_MS,
  MEDIA_MAX_BYTES,
  MEDIA_SWEEP_MS,
  mediaStateFor,
  memberCache,
  MEMBERS_TTL_MS,
  midKind,
  NAME_CACHE_MAX,
  nameCache,
  nameCacheEpoch,
  paginationCursors,
  pendingIncomingMessages,
  RAW_CACHE_MAX,
  rawsById,
  REACTION_CACHE_MAX,
  reactionsBeforePublication,
  reactionsByMessage,
  readIndex,
  readIndexFor,
  readRanges,
  rememberBoxCursor,
  rememberGoneMedia,
  rememberPaginationCursor,
  rememberRaw,
  REPLY_SOURCE_MAX,
  REPLY_TEXT_MAX,
  replySources,
  trackIncomingMessage,
  unsentBeforePublication,
};
