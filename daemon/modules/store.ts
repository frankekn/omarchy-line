/**
 * The persistent message store -- the "already seen it, never ask LINE for it
 * again" layer underneath history, paging and media lookups.
 *
 *   STATE_DIR/messages/<myMid>/<chatMid>.jsonl
 *
 * Namespaced by account mid on purpose: box and message ids are LINE-global,
 * so a re-login under another account must land in a different directory
 * rather than read the previous account's mail.
 *
 * Line shapes deliberately share the CLI backup archiveLine layout
 * ({chatMid, ...wire fields}), plus private overlay keys no wire struct
 * carries:
 *
 *   {chatMid, id, ...wire fields}                 a message (also how edits
 *                                                 store -- the op hands us
 *                                                 the whole new raw)
 *   {chatMid, id, _unsent: true}                  unsend tombstone
 *   {chatMid, id, _reactions: [wire Reaction]}    reaction overlay
 *
 * Reads merge per id, last line wins, then order numerically by id (LINE ids
 * are monotonic, so that is chronological order). The store is a cache in the
 * strong sense: LINE stays authoritative, and every failure mode -- missing
 * file, torn line, evicted entry -- just makes the caller take the network
 * path it would have taken anyway.
 *
 * Nothing here imports env/session/state so tests drive a real instance at a
 * temp dir; the process singleton is constructed in env.ts.
 */
import type { Json } from "./types.ts";

/** In-memory index cap per chat; disk keeps everything regardless. */
const STORE_INDEX_MAX = 8_000;
/** Chats kept indexed at once; a cold one just reparses its file on demand. */
const STORE_FILES_MAX = 64;
/** Writes coalesce for this long -- a burst of pushes is one append. */
const FLUSH_MS = 150;
/** Below this many lines a chat file is never worth rewriting. */
const COMPACT_MIN_LINES = 1_000;
/** Rewrite once disk lines exceed live records by this factor. */
const COMPACT_RATIO = 2;

/**
 * JSON.stringify drops bigint; the wire uses i64 for ids and times. Same
 * convention as the CLI backup: stringify once bare, retry with the replacer
 * only when a bigint actually made it throw -- the replacer forces V8's slow
 * path for every value.
 */
function safeLine(fields: Json): string {
  try {
    return JSON.stringify(fields);
  } catch {
    return JSON.stringify(
      fields,
      (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v,
    );
  }
}

function messageIdOf(line: Json): string {
  const id = line.id;
  return id === undefined || id === null ? "" : String(id);
}

/** Numeric id comparison; LINE ids are decimal strings or i64 numbers. */
function idCompare(a: string, b: string): number {
  let an = 0n, bn = 0n;
  try {
    an = BigInt(a);
    bn = BigInt(b);
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return an < bn ? -1 : an > bn ? 1 : 0;
}

interface ChatFile {
  path: string;
  /** `${myMid}/${chat}` -- the live-entry check for a deferred rewrite. */
  key: string;
  loaded: boolean;
  /** Non-empty lines currently on disk; the compaction trigger's dividend. */
  diskLines: number;
  /** ids in ascending message order. */
  order: string[];
  /** O(1) membership for `order`; the two never disagree. */
  seen: Set<string>;
  /** id -> merged raw with overlays applied. */
  recs: Map<string, Json>;
  /** serialized lines awaiting the next flush. */
  pending: string[];
  /** A rewrite is in flight -- eviction must skip this file (see compact). */
  compacting: boolean;
  writing: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The persisted reviver: wire binary fields arrive as Buffer and JSON keeps
 * them in the tagged {type:"Buffer",data:[...]} form Buffer.toJSON emits.
 * They have to come back as Uint8Array or the E2EE decryptor's
 * chunk[1].subarray fails -- and the whole message renders as a decrypt
 * error. The second shape covers a re-serialized Uint8Array, which JSON sees
 * as a plain {0:..,1:..} object (integer keys enumerate in numeric order).
 */
function reviveJson(_k: string, v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if (o.type === "Buffer" && Array.isArray(o.data)) {
    return Uint8Array.from(o.data as number[]);
  }
  const keys = Object.keys(o);
  if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
    return Uint8Array.from(Object.values(o) as number[]);
  }
  return v;
}

/**
 * One line folded into the merged-records map. `full` reports whether the
 * line was a whole wire struct -- only those belong in the message order;
 * tombstones and reaction overlays mutate an existing record (or leave a
 * bare tombstone behind) without adding a row.
 */
function mergeInto(recs: Map<string, Json>, line: Json): {
  id: string;
  full: boolean;
} {
  const id = messageIdOf(line);
  if (!id) return { id, full: false };
  if (line._unsent === true) {
    const base = recs.get(id) ?? { id };
    const meta = { ...((base.contentMetadata ?? {}) as Json), UNSENT: "true" };
    recs.set(id, { ...base, ...line, contentMetadata: meta });
    return { id, full: false };
  }
  if (Array.isArray(line._reactions)) {
    const base = recs.get(id);
    if (base) recs.set(id, { ...base, reactions: line._reactions });
    return { id, full: false };
  }
  // A full wire struct: edits arrive the same shape as first delivery.
  recs.set(id, line);
  return { id, full: true };
}

/**
 * One mutation line folded into the in-memory index. `recs` may be absent
 * while the file is unloaded; the pending line alone keeps the disk copy
 * right, and a later load replays it.
 */
function applyLine(
  recs: Map<string, Json>,
  order: string[],
  seen: Set<string>,
  line: Json,
  indexMax: number = STORE_INDEX_MAX,
): void {
  const { id, full } = mergeInto(recs, line);
  if (!id || !full || seen.has(id)) return;
  seen.add(id);
  // Almost always the tail; insert sorted so an out-of-order page fetch
  // cannot wedge an old message behind newer ones.
  let i = order.length;
  while (i > 0 && idCompare(order[i - 1], id) > 0) i--;
  order.splice(i, 0, id);
  if (order.length > indexMax) {
    const drop = order.splice(0, order.length - indexMax);
    for (const d of drop) {
      recs.delete(d);
      seen.delete(d);
    }
  }
}

/** A record as it should persist: merge artifacts (`_unsent`) never store. */
function stripped(rec: Json): Json {
  const out: Json = {};
  for (const k of Object.keys(rec)) if (!k.startsWith("_")) out[k] = rec[k];
  return out;
}

async function loadFile(f: ChatFile): Promise<void> {
  if (f.loaded) return;
  f.loaded = true;
  let text = "";
  try {
    text = await Deno.readTextFile(f.path);
  } catch {
    return; // missing or unreadable == empty cache
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    f.diskLines++;
    let parsed: Json;
    try {
      parsed = JSON.parse(t, reviveJson) as Json;
    } catch {
      continue; // a torn tail line loses only itself
    }
    applyLine(f.recs, f.order, f.seen, parsed);
  }
}

export interface MessageStore {
  /** Append freshly seen wire messages (also how edits are recorded). */
  append(myMid: string, chat: string, raws: unknown[]): void;
  /** Record an unsend; keeps position/from/time, strips the content. */
  tombstone(myMid: string, chat: string, id: string): void;
  /** Record the newest reaction bar for a message. */
  reactions(
    myMid: string,
    chat: string,
    id: string,
    byUser: Map<string, string>,
  ): void;
  /** One message by id; null when the store has never seen it. */
  get(myMid: string, chat: string, id: string): Promise<Json | null>;
  /** Newest `count` stored messages, oldest first; null when nothing stored. */
  tail(myMid: string, chat: string, count: number): Promise<Json[] | null>;
  /**
   * Up to `count` stored messages older than `anchorId`, oldest first. null
   * when the anchor is not in the store -- the caller then falls back to the
   * network exactly as it would have without the store.
   */
  pageBefore(
    myMid: string,
    chat: string,
    anchorId: string,
    count: number,
  ): Promise<Json[] | null>;
  /** Force every pending append to disk (tests and shutdown). */
  flush(): Promise<void>;
}

export interface MessageStoreOptions {
  /** Test hook: lower the rewrite floor. Defaults to COMPACT_MIN_LINES. */
  compactMinLines?: number;
  /** Test hook: lower the rewrite ratio. Defaults to COMPACT_RATIO. */
  compactRatio?: number;
}

/** One plain path segment: no separator, no dot-dot, nothing empty. */
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function createMessageStore(
  rootDir: string,
  opts: MessageStoreOptions = {},
): MessageStore {
  const files = new Map<string, ChatFile>();
  const compactMinLines = opts.compactMinLines ?? COMPACT_MIN_LINES;
  const compactRatio = opts.compactRatio ?? COMPACT_RATIO;

  /**
   * Both ids become path segments: `${rootDir}/${myMid}/${chat}.jsonl`. A mid
   * is [ucr] plus hex, but the chat id arrives from the socket as whatever the
   * peer sent, and "../x" would read or append a .jsonl outside the store.
   * Anything that is not one plain segment is treated as nothing stored.
   */
  function storable(myMid: string, chat: string): boolean {
    return SEGMENT_RE.test(myMid) && SEGMENT_RE.test(chat);
  }

  function fileFor(myMid: string, chat: string): ChatFile {
    const key = `${myMid}/${chat}`;
    let f = files.get(key);
    if (!f) {
      f = {
        path: `${rootDir}/${myMid}/${chat}.jsonl`,
        key,
        loaded: false,
        diskLines: 0,
        order: [],
        seen: new Set(),
        recs: new Map(),
        pending: [],
        compacting: false,
        writing: Promise.resolve(),
        timer: null,
      };
    } else {
      files.delete(key);
    }
    files.set(key, f);
    while (files.size > STORE_FILES_MAX) {
      // Skip a file mid-rewrite: dropping it would let a re-created ChatFile
      // append to the old inode while compact's rename is still in flight.
      let oldest: string | undefined;
      for (const k of files.keys()) {
        if (!files.get(k)?.compacting) {
          oldest = k;
          break;
        }
      }
      if (oldest === undefined) break;
      const drop = files.get(oldest);
      files.delete(oldest);
      // A pending append must still reach disk even though the in-memory
      // index is gone -- flush it before forgetting the file object.
      if (drop && drop.pending.length) void flushFile(drop);
    }
    return f;
  }

  /**
   * Rewrite the chat file as the merged view of itself: one full line per
   * live message (overlays already folded in), tombstone-only stubs last.
   * The private `_unsent`/`_reactions` keys are dropped -- their effects are
   * baked into `contentMetadata.UNSENT` / `reactions`, and readers never see
   * the underscore keys. Tombstone stubs without a base keep `_unsent` so a
   * reload still leaves them out of the message order.
   *
   * Runs on `f.writing`, so pending appends can only land before the read
   * (already part of the merged file) or after the rename (appended to the
   * new file). The `compacting` flag keeps LRU eviction from swapping the
   * file object out from under the rename.
   */
  async function compactFile(f: ChatFile): Promise<void> {
    if (files.get(f.key) !== f) return;
    f.compacting = true;
    try {
      let text = "";
      try {
        text = await Deno.readTextFile(f.path);
      } catch {
        return; // gone mid-flight; nothing to rewrite
      }
      const recs = new Map<string, Json>();
      const order: string[] = [];
      const seen = new Set<string>();
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let parsed: Json;
        try {
          parsed = JSON.parse(t, reviveJson) as Json;
        } catch {
          continue;
        }
        // Uncapped replay: compaction answers to the disk file, not the
        // in-memory index -- a capped index would silently drop old rows.
        applyLine(recs, order, seen, parsed, Number.POSITIVE_INFINITY);
      }
      const body = order.map((id) => safeLine(stripped(recs.get(id)!)) + "\n");
      for (const id of recs.keys()) {
        if (seen.has(id)) continue;
        const rec = recs.get(id)!;
        body.push(safeLine({ chatMid: rec.chatMid, id, _unsent: true }) + "\n");
      }
      const tmp = `${f.path}.tmp`;
      await Deno.writeTextFile(tmp, body.join(""), { mode: 0o600 });
      if (files.get(f.key) !== f) {
        // Evicted mid-read; a new ChatFile owns the path now.
        await Deno.remove(tmp).catch(() => {});
        return;
      }
      await Deno.rename(tmp, f.path);
      f.diskLines = body.length;
    } catch {
      // A failed rewrite leaves the append-only file exactly as it was.
    } finally {
      f.compacting = false;
    }
  }

  /**
   * The file is worth rewriting once dead lines dominate live records. Only
   * loaded files qualify: an unread one has recs.size of 0 (a degenerate
   * ratio) and nobody pays its reparse cost anyway.
   */
  function maybeCompact(f: ChatFile): boolean {
    return f.loaded && files.get(f.key) === f && !f.compacting &&
      f.diskLines > compactMinLines && f.diskLines > f.recs.size * compactRatio;
  }

  async function flushFile(f: ChatFile): Promise<void> {
    if (!f.pending.length) return;
    const lines = f.pending;
    f.pending = [];
    const dirEnd = f.path.lastIndexOf("/");
    await Deno.mkdir(f.path.slice(0, dirEnd), {
      recursive: true,
      // Same stance as storage.json beside it: the 0700 state dir already
      // blocks traversal, but the files themselves shouldn't be world-readable
      // if that boundary is ever loosened.
      mode: 0o700,
    }).catch(() => {});
    await Deno.writeTextFile(f.path, lines.join(""), {
      append: true,
      mode: 0o600,
    }).catch(() => {});
    f.diskLines += lines.length;
    if (maybeCompact(f)) await compactFile(f);
  }

  /**
   * The read path's open: load the index, then queue a rewrite when the file
   * turned out to be mostly dead lines -- the parse cost that just ran is the
   * one compaction exists to shrink.
   */
  async function openFile(f: ChatFile): Promise<void> {
    await loadFile(f);
    if (maybeCompact(f)) {
      f.writing = f.writing.then(() => compactFile(f));
      void f.writing;
    }
  }

  function enqueue(f: ChatFile, line: Json): void {
    f.pending.push(safeLine(line) + "\n");
    if (f.timer !== null) return;
    f.timer = setTimeout(() => {
      f.timer = null;
      f.writing = f.writing.then(() => flushFile(f));
      void f.writing;
    }, FLUSH_MS);
  }

  function appendLine(myMid: string, chat: string, line: Json): void {
    if (!storable(myMid, chat)) return;
    const f = fileFor(myMid, chat);
    if (f.loaded) applyLine(f.recs, f.order, f.seen, line);
    enqueue(f, line);
  }

  return {
    append(myMid, chat, raws) {
      for (const raw of raws) {
        appendLine(myMid, chat, { chatMid: chat, ...(raw as Json) });
      }
    },
    tombstone(myMid, chat, id) {
      appendLine(myMid, chat, { chatMid: chat, id, _unsent: true });
    },
    reactions(myMid, chat, id, byUser) {
      const list = [...byUser].map(([mid, type]) => ({
        fromUserMid: mid,
        reactionType: { predefinedReactionType: type },
      }));
      appendLine(myMid, chat, { chatMid: chat, id, _reactions: list });
    },
    async get(myMid, chat, id) {
      if (!storable(myMid, chat) || !id) return null;
      const f = fileFor(myMid, chat);
      await openFile(f);
      return f.recs.get(id) ?? null;
    },
    async tail(myMid, chat, count) {
      if (!storable(myMid, chat)) return null;
      const f = fileFor(myMid, chat);
      await openFile(f);
      if (!f.order.length) return null;
      const ids = f.order.slice(-Math.max(1, count));
      return ids.map((id) => f.recs.get(id)).filter((r): r is Json => !!r);
    },
    async pageBefore(myMid, chat, anchorId, count) {
      if (!storable(myMid, chat)) return null;
      const f = fileFor(myMid, chat);
      await openFile(f);
      const at = f.order.indexOf(anchorId);
      if (at < 0) return null;
      const ids = f.order.slice(Math.max(0, at - Math.max(1, count)), at);
      return ids.map((id) => f.recs.get(id)).filter((r): r is Json => !!r);
    },
    async flush() {
      for (const f of files.values()) {
        if (f.timer !== null) {
          clearTimeout(f.timer);
          f.timer = null;
          f.writing = f.writing.then(() => flushFile(f));
        }
        await f.writing;
      }
    },
  };
}
