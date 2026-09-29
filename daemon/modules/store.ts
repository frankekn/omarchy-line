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
  loaded: boolean;
  /** ids in ascending message order. */
  order: string[];
  /** O(1) membership for `order`; the two never disagree. */
  seen: Set<string>;
  /** id -> merged raw with overlays applied. */
  recs: Map<string, Json>;
  /** serialized lines awaiting the next flush. */
  pending: string[];
  writing: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
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
): void {
  const id = messageIdOf(line);
  if (!id) return;
  if (line._unsent === true) {
    const base = recs.get(id) ?? { id };
    const meta = { ...((base.contentMetadata ?? {}) as Json), UNSENT: "true" };
    recs.set(id, { ...base, ...line, contentMetadata: meta });
    return;
  }
  if (Array.isArray(line._reactions)) {
    const base = recs.get(id);
    if (base) recs.set(id, { ...base, reactions: line._reactions });
    return;
  }
  // A full wire struct: edits arrive the same shape as first delivery.
  recs.set(id, line);
  if (!seen.has(id)) {
    seen.add(id);
    // Almost always the tail; insert sorted so an out-of-order page fetch
    // cannot wedge an old message behind newer ones.
    let i = order.length;
    while (i > 0 && idCompare(order[i - 1], id) > 0) i--;
    order.splice(i, 0, id);
    if (order.length > STORE_INDEX_MAX) {
      const drop = order.splice(0, order.length - STORE_INDEX_MAX);
      for (const d of drop) {
        recs.delete(d);
        seen.delete(d);
      }
    }
  }
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
    let parsed: Json;
    try {
      parsed = JSON.parse(t) as Json;
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

export function createMessageStore(rootDir: string): MessageStore {
  const files = new Map<string, ChatFile>();

  function fileFor(myMid: string, chat: string): ChatFile {
    const key = `${myMid}/${chat}`;
    let f = files.get(key);
    if (!f) {
      f = {
        path: `${rootDir}/${myMid}/${chat}.jsonl`,
        loaded: false,
        order: [],
        seen: new Set(),
        recs: new Map(),
        pending: [],
        writing: Promise.resolve(),
        timer: null,
      };
    } else {
      files.delete(key);
    }
    files.set(key, f);
    while (files.size > STORE_FILES_MAX) {
      const oldest = files.keys().next().value;
      if (oldest === undefined) break;
      const drop = files.get(oldest);
      files.delete(oldest);
      // A pending append must still reach disk even though the in-memory
      // index is gone -- flush it before forgetting the file object.
      if (drop && drop.pending.length) void flushFile(drop);
    }
    return f;
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
    if (!myMid || !chat) return;
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
      if (!myMid || !id) return null;
      const f = fileFor(myMid, chat);
      await loadFile(f);
      return f.recs.get(id) ?? null;
    },
    async tail(myMid, chat, count) {
      if (!myMid) return null;
      const f = fileFor(myMid, chat);
      await loadFile(f);
      if (!f.order.length) return null;
      const ids = f.order.slice(-Math.max(1, count));
      return ids.map((id) => f.recs.get(id)).filter((r): r is Json => !!r);
    },
    async pageBefore(myMid, chat, anchorId, count) {
      if (!myMid) return null;
      const f = fileFor(myMid, chat);
      await loadFile(f);
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
