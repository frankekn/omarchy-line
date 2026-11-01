/**
 * Full-text search over the persistent message store (store.ts). A scan, not
 * an index: every call reads the account's chat files, so there is nothing
 * to keep in step with appends, edits, recalls or compaction.
 *
 * What is searchable is exactly the plaintext the store holds:
 *  - plain (non-E2EE) text messages from any path;
 *  - Letter-Sealed text that arrived as a push -- push.ts appends the raw
 *    after fromRawTalk decrypted it in place, so `text` is on the line;
 *  - not Letter-Sealed text that only came in through a history page: that
 *    path appends the wire raw before conversion, so the line carries the
 *    encrypted `chunks` and no `text`.
 *
 * Merge rules follow the store: per id, the last full line wins (an edit
 * that drops the match drops the hit), and any unsend tombstone or
 * contentMetadata.UNSENT hides the message for good.
 *
 * Nothing here imports env/session/state; socket.ts passes the root, the
 * chat order and the hidden check, so tests drive it at a temp dir.
 */
import type { Json } from "./types.ts";

/** Longest query, in UTF-16 code units. */
export const SEARCH_QUERY_MAX = 100;
/** Default and largest number of hits one call returns. */
export const SEARCH_LIMIT_DEFAULT = 30;
export const SEARCH_LIMIT_MAX = 100;
/** Wall-clock budget of one scan; a slower scan answers `partial`. */
export const SEARCH_BUDGET_MS = 2_000;
/** Snippet length around the hit, in UTF-16 code units. */
export const SNIPPET_MAX = 120;
/** Characters kept in front of the hit when the text is longer. */
const SNIPPET_LEAD = 40;
/** Lines parsed between two yields to the event loop. */
const YIELD_LINES = 2_000;
/** A file is read, folded and tested in slices of this many bytes. */
const READ_BYTES = 512 * 1024;

const SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_RE = /^([A-Za-z0-9_-]{1,128})\.jsonl$/;

export interface SearchHit {
  chat: string;
  id: string;
  time: number;
  from: string;
  /** Snippet of the text, with "…" where it was cut. */
  snippet: string;
  /** [start, end) of the hit inside `snippet`, UTF-16 code units. */
  match: [number, number];
}

export interface SearchResult {
  hits: SearchHit[];
  /** The budget ran out before every chat was read. */
  partial: boolean;
  /** More hits exist older than the last one returned. */
  more: boolean;
  /** Chat files read. */
  scanned: number;
}

export interface SearchArgs {
  q: string;
  chat: string;
  limit: number;
  /** Only hits strictly older than this time (ms); 0 means no bound. */
  before: number;
}

/** The request's arguments, or the refusal it gets. */
export function searchArgs(req: Json): SearchArgs | { error: string } {
  if (typeof req.q !== "string") return { error: "沒有搜尋文字" };
  const q = req.q.trim();
  if (!q) return { error: "沒有搜尋文字" };
  if (q.length > SEARCH_QUERY_MAX) return { error: "搜尋文字太長" };
  let chat = "";
  if (req.chat !== undefined && req.chat !== null && req.chat !== "") {
    chat = String(req.chat);
    if (!SEGMENT_RE.test(chat)) return { error: "不支援的聊天室" };
  }
  let limit = SEARCH_LIMIT_DEFAULT;
  if (typeof req.limit === "number" && Number.isFinite(req.limit)) {
    limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.round(req.limit)));
  }
  let before = 0;
  if (req.before !== undefined && req.before !== null && req.before !== "") {
    const n = typeof req.before === "number"
      ? req.before
      : typeof req.before === "string" && /^\d{1,16}$/.test(req.before)
      ? Number(req.before)
      : NaN;
    if (!Number.isSafeInteger(n) || n < 0) return { error: "before 不對" };
    before = n;
  }
  return { q, chat, limit, before };
}

/**
 * Case-insensitive position of `needle` (already lower-cased) in `text`, in
 * `text`'s own code units. toLowerCase can change a string's length (İ), so
 * the index is mapped back through per-code-point folding when it does.
 */
export function foldedIndex(
  text: string,
  needle: string,
): [number, number] | null {
  const lower = text.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  if (lower.length === text.length) return [at, at + needle.length];
  let folded = 0, start = -1;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (folded === at && start < 0) start = i;
    folded += String.fromCodePoint(cp).toLowerCase().length;
    i += width;
    if (start >= 0 && folded >= at + needle.length) return [start, i];
  }
  return null;
}

/** About SNIPPET_MAX code units around [start, end), newlines flattened. */
export function snippetOf(
  text: string,
  start: number,
  end: number,
): { snippet: string; match: [number, number] } {
  let from = 0, to = text.length;
  if (text.length > SNIPPET_MAX) {
    from = Math.max(0, start - SNIPPET_LEAD);
    to = Math.min(text.length, from + SNIPPET_MAX);
    if (to < end) to = end;
    from = Math.max(0, Math.min(from, to - SNIPPET_MAX));
    // Never cut a surrogate pair in half.
    const low = (i: number) => {
      const c = text.charCodeAt(i);
      return c >= 0xdc00 && c <= 0xdfff;
    };
    if (from > 0 && low(from)) from++;
    if (to < text.length && low(to)) to++;
  }
  const head = from > 0 ? "…" : "", tail = to < text.length ? "…" : "";
  const body = text.slice(from, to).replace(/[\r\n\t]/g, " ");
  return {
    snippet: head + body + tail,
    match: [start - from + head.length, end - from + head.length],
  };
}

function idOf(line: Json): string {
  const id = line.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

function unsentMeta(line: Json): boolean {
  const meta = line.contentMetadata;
  return !!meta && typeof meta === "object" &&
    (meta as Json).UNSENT === "true";
}

function newerFirst(a: SearchHit, b: SearchHit): number {
  if (a.time !== b.time) return b.time - a.time;
  if (a.id.length !== b.id.length) return b.id.length - a.id.length;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** JSON escaping commutes with lower-casing, so a raw line can be tested. */
function escapedNeedle(needle: string): string {
  return JSON.stringify(needle).slice(1, -1);
}

export interface SearchDeps {
  /** STATE_DIR/messages: the store root. */
  root: string;
  myMid: string;
  /** Chat ids newest first; files not in it are read after these. */
  order: string[];
  isHidden: (chat: string) => boolean;
  /** Test hooks. */
  now?: () => number;
  budgetMs?: number;
}

/** Scan one chat file; null when it cannot be read. */
async function scanFile(
  path: string,
  chat: string,
  needle: string,
  escaped: string,
  before: number,
  deadline: number,
  now: () => number,
): Promise<{ hits: SearchHit[]; cut: boolean } | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null;
  }
  const hits = new Map<string, SearchHit>();
  const unsent = new Set<string>();
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(READ_BYTES);
  let carry = "", parsed = 0;
  // Read in slices that end on a line break, so no single step decodes or
  // folds a whole large file. Most slices hold no hit at all: one pass over
  // the folded slice skips them without parsing a line, except the recall
  // lines a later re-fetch must not undo. Once a hit exists every line is
  // parsed, since a later edit or recall of it can be anywhere.
  const scanSlice = async (slice: string): Promise<boolean> => {
    const full = hits.size > 0 || slice.toLowerCase().includes(escaped);
    for (const raw of slice.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (
        !full && !line.includes('"_unsent":true') &&
        !line.includes('"UNSENT":"true"')
      ) continue;
      if (++parsed % YIELD_LINES === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (now() > deadline) return false;
      }
      scanLine(line, chat, needle, before, hits, unsent);
    }
    return true;
  };
  try {
    for (;;) {
      let n: number | null;
      try {
        n = await file.read(buffer);
      } catch {
        return null;
      }
      if (n === null) break;
      if (now() > deadline) return { hits: [], cut: true };
      const text = carry + decoder.decode(buffer.subarray(0, n), {
        stream: true,
      });
      const end = text.lastIndexOf("\n");
      if (end < 0) {
        carry = text;
        continue;
      }
      carry = text.slice(end + 1);
      if (!await scanSlice(text.slice(0, end))) return { hits: [], cut: true };
    }
    carry += decoder.decode();
    if (carry && !await scanSlice(carry)) return { hits: [], cut: true };
  } finally {
    file.close();
  }
  return { hits: [...hits.values()], cut: false };
}

/** One store line folded into the file's hits and recalled ids. */
function scanLine(
  line: string,
  chat: string,
  needle: string,
  before: number,
  hits: Map<string, SearchHit>,
  unsent: Set<string>,
): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return; // a torn line is just nothing stored
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rec = value as Json;
  const id = idOf(rec);
  if (!id) return;
  if (rec._unsent === true || unsentMeta(rec)) {
    unsent.add(id);
    hits.delete(id);
    return;
  }
  if (Array.isArray(rec._reactions)) return; // overlay, not a version
  // A full line replaces the previous version, hit or not.
  hits.delete(id);
  if (unsent.has(id)) return;
  if (String(rec.contentType ?? "NONE") !== "NONE") return;
  if (typeof rec.text !== "string" || !rec.text) return;
  const at = foldedIndex(rec.text, needle);
  if (!at) return;
  const time = Number(rec.createdTime ?? 0);
  if (before && !(time < before)) return;
  const { snippet, match } = snippetOf(rec.text, at[0], at[1]);
  hits.set(id, {
    chat,
    id,
    time: Number.isFinite(time) ? time : 0,
    from: typeof rec.from === "string" ? rec.from : "",
    snippet,
    match,
  });
}

/**
 * Newest-first hits for `args.q`. Chats are read in `order` (newest chat
 * first) so a scan the budget cuts short has covered the recent ones.
 */
export async function searchMessages(
  deps: SearchDeps,
  args: SearchArgs,
): Promise<SearchResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? SEARCH_BUDGET_MS);
  const result: SearchResult = {
    hits: [],
    partial: false,
    more: false,
    scanned: 0,
  };
  if (!SEGMENT_RE.test(deps.myMid)) return result;
  const dir = `${deps.root}/${deps.myMid}`;
  let chats: string[];
  if (args.chat) {
    chats = [args.chat];
  } else {
    const onDisk = new Set<string>();
    try {
      for await (const entry of Deno.readDir(dir)) {
        // A symlink could point the scan outside the store.
        if (!entry.isFile || entry.isSymlink) continue;
        const m = FILE_RE.exec(entry.name);
        if (m) onDisk.add(m[1]);
      }
    } catch {
      return result; // nothing stored yet
    }
    chats = [];
    for (const mid of deps.order) {
      if (onDisk.delete(mid)) chats.push(mid);
    }
    chats.push(...[...onDisk].sort());
    chats = chats.filter((mid) => !deps.isHidden(mid));
  }
  const needle = args.q.toLowerCase();
  const escaped = escapedNeedle(needle);
  let all: SearchHit[] = [];
  for (const chat of chats) {
    if (now() > deadline) {
      result.partial = true;
      break;
    }
    const path = `${dir}/${chat}.jsonl`;
    if (args.chat) {
      // The one caller-named file must be a plain file, not a link out.
      const info = await Deno.lstat(path).catch(() => null);
      if (!info?.isFile) continue;
    }
    const scanned = await scanFile(
      path,
      chat,
      needle,
      escaped,
      args.before,
      deadline,
      now,
    );
    if (!scanned) continue;
    if (scanned.cut) {
      result.partial = true;
      break;
    }
    result.scanned++;
    all.push(...scanned.hits);
    // Keep memory bounded on a query that matches nearly everything.
    if (all.length > args.limit * 4) {
      all.sort(newerFirst);
      result.more = true;
      all = all.slice(0, args.limit);
    }
  }
  all.sort(newerFirst);
  if (all.length > args.limit) result.more = true;
  result.hits = all.slice(0, args.limit);
  return result;
}
