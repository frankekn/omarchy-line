/**
 * Pure LINE protocol parsing, both directions: panel request correlation
 * tokens (requestid), preview-safe message classification (previewable),
 * MENTION metadata (mention), the reaction bar (reactions), raw talk
 * Operations (talkop) and read ranges (readrange). Each enil:-marker block is
 * sliced out verbatim by its test and pasted onto a stub prelude, so the
 * blocks themselves stay byte-identical; the module wrapper only adds imports
 * and exports.
 *
 * Dependency direction: imports nothing at runtime (Json and the plugin row
 * types are type-only imports from types.ts). Modules above it (messages,
 * push, socket) import its parsers; it never reaches back.
 */
import type { Json, PluginReaction, PluginReadBy } from "./types.ts";

// enil:requestid-begin
/** A correlation token written by this panel, if LINE preserved it. */
function messageRequestId(meta: Json): string | undefined {
  const value = meta.ENIL_REQUEST_ID;
  return typeof value === "string" && value ? value : undefined;
}

/** A panel-supplied token ready to place on an outgoing LINE message. */
function panelRequestId(req: Json): string {
  return typeof req.requestId === "string" && req.requestId
    ? req.requestId
    : "";
}
// enil:requestid-end

// enil:previewable-begin
/** A thumbnail request that cannot turn into a full encrypted video download. */
function previewableMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const message = raw as {
    contentType?: unknown;
    contentMetadata?: unknown;
    chunks?: unknown;
  };
  const kind = String(message.contentType ?? "");
  if (kind === "IMAGE") return true;
  if (kind !== "VIDEO") return false;
  const meta = message.contentMetadata &&
      typeof message.contentMetadata === "object"
    ? message.contentMetadata as Record<string, unknown>
    : {};
  // Mirrors the fork's TalkMessage.getData branch exactly: its PREVIEW_URL
  // fetch only runs when DOWNLOAD_URL is set, a chunked video without it
  // falls through to downloadMediaByE2EE -- the whole clip -- and only a
  // non-chunked message honours isPreview on its own.
  return !!(meta.DOWNLOAD_URL && meta.PREVIEW_URL) ||
    !Array.isArray(message.chunks);
}
// enil:previewable-end

// The block between the enil:mention markers is sliced out verbatim by
// daemon/mention_test.ts. Pure string and JSON work: no module state and no
// name resolution -- the display names are added on top of what comes back
// from here, because resolveName needs the client.
// enil:mention-begin

/**
 * One @mention. `start`/`end` are half-open offsets into the message text in
 * UTF-16 code units, which is the unit LINE means: linejs reads MENTIONEES'
 * S/E with parseInt and hands them to String.prototype.substring
 * (client/features/message/talk.ts:255-300), and a JS string indexes in code
 * units -- one per CJK character, two per an emoji outside the BMP. The panel
 * measures the same JS string, so neither end converts anything.
 */
interface Mention {
  start: number;
  end: number;
  /** Absent when `all` is set. */
  mid?: string;
  all?: boolean;
}

// A LINE user mid is `u` plus 32 lowercase hex. Anything else would go out on
// the wire verbatim and arrive as a mention of nobody.
const MENTION_MID = /^u[0-9a-f]{32}$/;

/**
 * One offset, or NaN. `Number()` on its own is far too generous for a value
 * that decides where the text gets cut: it reads `true` as 1, `null` and `[]`
 * as 0, `"0x10"` as 16 and `" 3 "` as 3, so an entry carrying no offset at all
 * would still land a span somewhere. The two spellings that are really
 * offsets are a JS number (what the panel sends) and a decimal string (what
 * LINE puts in S/E) -- everything else is dropped, which is what stub.py's
 * `isinstance(..., int)` plus its bool guard already did on its side.
 */
function mentionOffset(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw === "string" && /^[0-9]+$/.test(raw)) return Number(raw);
  return NaN;
}

/**
 * Normalises one entry of either spelling: the panel's `{start, end, mid|all}`
 * and LINE's own `{S, E, M|A}`, whose S/E are decimal strings. Anything that
 * cannot be trusted comes back null and the caller drops it -- offsets that
 * are not integers, a range inverted or past the end of the text, a mid that
 * is not a mid. A malformed mention costs its own highlight, never the
 * message it is attached to.
 */
function normalizeMention(
  entry: unknown,
  textLength: number,
): Mention | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const start = mentionOffset(e.start ?? e.S);
  const end = mentionOffset(e.end ?? e.E);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end > textLength) return null;
  // Mirrors linejs's own test, `mention.A ? all : mid` (talk.ts:220): its
  // builder writes A: "1" and CHRLINE writes "true", so the flag is read for
  // truthiness rather than compared against either spelling.
  if (e.all === true || !!e.A) return { start, end, all: true };
  const mid = String(e.mid ?? e.M ?? "");
  return MENTION_MID.test(mid) ? { start, end, mid } : null;
}

/**
 * Sorted by start with overlaps dropped: both ends walk the list once and
 * slice the text between the spans, so two spans over one character would
 * render -- or send -- that character twice.
 */
function normalizeMentions(list: unknown, text: string): Mention[] {
  if (!Array.isArray(list)) return [];
  const found: Mention[] = [];
  for (const entry of list) {
    const m = normalizeMention(entry, text.length);
    if (m) found.push(m);
  }
  found.sort((a, b) => a.start - b.start);
  const kept: Mention[] = [];
  for (const m of found) {
    if (kept.length && m.start < kept[kept.length - 1].end) continue;
    kept.push(m);
  }
  return kept;
}

/**
 * The contentMetadata a send carries, or undefined when nothing survived --
 * an empty MENTIONEES array is a key LINE has no use for. It travels in the
 * clear even on an E2EE message: talk.sendMessage merges contentMetadata with
 * the e2ee markers and never hands it to encryptE2EEMessage
 * (base/service/talk/mod.ts:116-139), so the offsets describe the plaintext
 * the recipient's client has after it decrypts, not the chunks on the wire.
 */
function buildMentionMeta(
  list: unknown,
  text: string,
): { MENTION: string } | undefined {
  const mentions = normalizeMentions(list, text);
  if (!mentions.length) return undefined;
  // Decimal strings, because that is what the type says and what linejs's own
  // builder writes (client/features/message/utils.ts:68-88).
  const MENTIONEES = mentions.map((m) =>
    m.all
      ? { S: String(m.start), E: String(m.end), A: "true" }
      : { S: String(m.start), E: String(m.end), M: m.mid }
  );
  return { MENTION: JSON.stringify({ MENTIONEES }) };
}

/** The other direction: what an incoming message's metadata says. */
function parseMentionMeta(meta: unknown, text: string): Mention[] {
  const json = (meta ?? {}) as Record<string, unknown>;
  if (typeof json.MENTION !== "string" || !json.MENTION) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.MENTION);
  } catch {
    // contentMetadata is whatever the sender's client wrote. A broken MENTION
    // costs that message its highlights, not the whole page of history.
    return [];
  }
  const list = parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>).MENTIONEES
    : null;
  return normalizeMentions(list, text);
}
// enil:mention-end

// The block between the enil:reactions markers is sliced out verbatim by
// daemon/reaction_test.ts; it is pure, and must stay that way.
// enil:reactions-begin
/**
 * MessageReactionType by value (vendor/linejs packages/types/line_types.ts
 * :2649). The panel is told the name and never the number -- LINE has
 * renumbered enums before, and the six on screen are a fixed vocabulary.
 */
const REACTION_NAMES = [
  "ALL",
  "UNDO",
  "NICE",
  "LOVE",
  "FUN",
  "AMAZING",
  "SAD",
  "OMG",
];
/** What `react` accepts: the six a user can pick, plus taking it back. */
const REACTION_PICKABLE = REACTION_NAMES.filter((n) => n !== "ALL");

/**
 * History arrives through the thrift renamer, which has already swapped the
 * enum for its name; the reaction ops carry LINE's own JSON, where it is still
 * a number. Both shapes reach here.
 */
function reactionName(raw: unknown): string {
  if (typeof raw === "number") return REACTION_NAMES[raw] ?? "";
  const name = String(raw ?? "");
  return REACTION_NAMES.includes(name) ? name : "";
}

/** A message's `reactions` array -> reactor mid -> reaction name. */
function reactionsFromRaw(list: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const r = (entry ?? {}) as Json;
    const mid = String(r.fromUserMid ?? "");
    const type = reactionName(
      ((r.reactionType ?? {}) as Json)
        .predefinedReactionType,
    );
    // UNDO is how an op says "taken back"; it is never a row in the bar.
    if (!mid || !type || type === "UNDO" || type === "ALL") continue;
    out.set(mid, type);
  }
  return out;
}

/** Moves one person's choice. UNDO (or nothing) drops their row. */
function applyReaction(
  byUser: Map<string, string>,
  mid: string,
  type: string,
): Map<string, string> {
  if (!mid) return byUser;
  if (!type || type === "UNDO" || type === "ALL") byUser.delete(mid);
  else byUser.set(mid, type);
  return byUser;
}

function applyQueuedReactions(
  byUser: Map<string, string>,
  queued: Map<string, string> | undefined,
): Map<string, string> {
  if (!queued) return byUser;
  for (const [mid, type] of queued) applyReaction(byUser, mid, type);
  return byUser;
}

/** One row per type, in the enum's order so the bar never reshuffles. */
function summariseReactions(
  byUser: Map<string, string> | undefined,
  selfMid: string,
): PluginReaction[] {
  const out: PluginReaction[] = [];
  if (!byUser?.size) return out;
  for (const type of REACTION_NAMES) {
    if (type === "ALL" || type === "UNDO") continue;
    let count = 0;
    let mine = false;
    for (const [mid, chosen] of byUser) {
      if (chosen !== type) continue;
      count++;
      if (mid && mid === selfMid) mine = true;
    }
    if (count) out.push({ type, count, mine });
  }
  return out;
}
// enil:reactions-end

// The block between the enil:talkop markers is sliced out verbatim by
// daemon/talkop_test.ts on top of a stub reactionName.
// enil:talkop-begin
/** What one raw talk Operation means, for the three the panel can draw. */
interface TalkOp {
  kind: "read" | "reaction" | "unsend";
  chat: string;
  messageId: string;
  /** read: who read it. reaction: who reacted. Unset for an unsend. */
  by?: string;
  /** reaction: the reactor's new choice, "UNDO" when they took it back. */
  reaction?: string;
}

interface TalkMetadataChange {
  kind: "chat" | "profile";
  mid: string;
}

/**
 * The fields these helpers read off a wire talk Operation. The generated
 * LINETypes.Operation already satisfies this structurally, so callers pass
 * the raw object itself instead of asserting it into Json.
 */
export interface RawOperationFields {
  type?: unknown;
  param1?: unknown;
  param2?: unknown;
  param3?: unknown;
}

/**
 * The fields chatMidOf reads off a wire Message. The generated
 * LINETypes.Message satisfies this structurally, so callers pass raw
 * directly, with no assertion.
 */
interface RawMessageEnvelope {
  toType?: unknown;
  to?: unknown;
  from?: unknown;
}

/** Metadata operations that must invalidate a cached chat-list label. */
function talkMetadataChange(
  op: RawOperationFields,
  selfMid: string,
): TalkMetadataChange | null {
  const type = String(op.type ?? "");
  const p1 = String(op.param1 ?? "");
  if (type === "UPDATE_CHAT" || type === "NOTIFIED_UPDATE_CHAT") {
    return p1 ? { kind: "chat", mid: p1 } : null;
  }
  if (type === "UPDATE_PROFILE") {
    return selfMid ? { kind: "profile", mid: selfMid } : null;
  }
  if (
    type === "NOTIFIED_UPDATE_PROFILE" ||
    type === "NOTIFIED_UPDATE_PROFILE_CONTENT" ||
    type === "NOTIFIED_BUDDY_UPDATE_PROFILE"
  ) {
    return p1 ? { kind: "profile", mid: p1 } : null;
  }
  return null;
}

/**
 * The three params are positional and mean something different in every op,
 * and the forms that report our own action from another device do not repeat
 * our mid -- hence selfMid. Shapes taken from linejs's own decoders in
 * vendor/linejs/example/_event/talk-class.ts, where param[N] is paramN.
 */
function talkOpEvent(op: RawOperationFields, selfMid: string): TalkOp | null {
  const p1 = String(op.param1 ?? "");
  const p2 = String(op.param2 ?? "");
  const p3 = String(op.param3 ?? "");
  switch (String(op.type ?? "")) {
    // 55: chat, reader, message id.
    case "NOTIFIED_READ_MESSAGE":
      if (!p1 || !p2 || !p3) return null;
      return { kind: "read", chat: p1, messageId: p3, by: p2 };
    // 40: we read it somewhere else. Chat, message id, and no reader field.
    case "SEND_CHAT_CHECKED":
      if (!p1 || !p2) return null;
      return { kind: "read", chat: p1, messageId: p2, by: selfMid };
    // 139/140: message id, then a JSON *string* (not thrift) carrying the chat
    // and the new reaction; only the NOTIFIED_ form names the reactor.
    case "SEND_REACTION":
    case "NOTIFIED_SEND_REACTION": {
      if (!p1) return null;
      let data: Json;
      try {
        data = JSON.parse(p2) as Json;
      } catch {
        return null;
      }
      const chat = String(data.chatMid ?? "");
      if (!chat) return null;
      return {
        kind: "reaction",
        chat,
        messageId: p1,
        by: p3 || selfMid,
        reaction: reactionName(
          ((data.curr ?? {}) as Json)
            .predefinedReactionType,
        ),
      };
    }
    // 64/65: chat, message id. Ours and theirs carry the same two.
    case "DESTROY_MESSAGE":
    case "NOTIFIED_DESTROY_MESSAGE":
      if (!p1 || !p2) return null;
      return { kind: "unsend", chat: p1, messageId: p2 };
  }
  return null;
}

/**
 * Op 42: the server declares our view of the boxes inconsistent and carries
 * nothing to reconcile by -- the same authority problem as an own-device
 * read, which is why the caller answers it with the full round.
 */
function talkOpNeedsFullSync(op: RawOperationFields): boolean {
  return String(op.type ?? "") === "NOTIFIED_FORCE_SYNC";
}

/**
 * Which box the panel files a message under. `toType` is USER only in a 1:1,
 * where `to` is whoever received it -- so our own message points at the peer
 * and theirs points at us, and the box is keyed by the peer either way.
 */
function chatMidOf(raw: RawMessageEnvelope, selfMid: string): string {
  const toType = String(raw.toType ?? "");
  if (!(toType === "USER" || toType === "0")) return String(raw.to ?? "");
  const from = String(raw.from ?? "");
  return from && from === selfMid ? String(raw.to ?? "") : from;
}
// enil:talkop-end

// The block between the enil:readrange markers is sliced out verbatim by
// daemon/readrange_test.ts; it is pure.
// enil:readrange-begin
/** LINE writes i64s that reach us as a bigint, a number or a decimal string. */
function asMessageId(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) ? BigInt(raw) : null;
  }
  const s = String(raw ?? "");
  return /^\d+$/.test(s) ? BigInt(s) : null;
}

/**
 * getMessageReadRange answers with a map whose value type the thrift renamer
 * has no definition for ("th"), so TMessageReadRangeEntry's fields come back
 * either named or as bare field ids -- 2 is endMessageId, 1 is startMessageId.
 * Read both, and take the end: that is the newest message the member read.
 */
function rangeEndId(entry: unknown): bigint | null {
  if (!entry || typeof entry !== "object") return null;
  const o = entry as Json;
  return asMessageId(o.endMessageId ?? o["2"]) ??
    asMessageId(o.startMessageId ?? o["1"]);
}

/**
 * A list the renamer had no definition for does not arrive as an Array: it is
 * an object keyed by its own indices, "0" upwards. Measured against real LINE,
 * each member's ranges are exactly that -- `{"0": {"1": start, "2": end, …}}`
 * -- which the first version read as an entry with no fields it knew, so every
 * id came back null and no message ever carried 已讀.
 *
 * A thrift struct's field ids start at 1, and a decoded list always starts at
 * index 0: that gap is the entire discriminator. Nothing here looks at how big
 * a number is, so a 13-digit timestamp can never be mistaken for a message id.
 */
function indexedEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const o = value as Json;
  // Integer-like keys enumerate in ascending numeric order, so this is exactly
  // "the keys are 0..n-1"; a struct's 1,2,3,4 fails on the first one.
  const keys = Object.keys(o);
  if (!keys.length) return null;
  for (let i = 0; i < keys.length; i++) if (keys[i] !== String(i)) return null;
  return keys.map((k) => o[k]);
}

/** How many list wrappers to unpick before calling the shape unrecognisable. */
const RANGE_MAX_DEPTH = 4;

/** A member's ranges, however deeply wrapped; the newest end wins. */
function lastReadOf(value: unknown, depth: number = 0): bigint | null {
  const list = depth < RANGE_MAX_DEPTH ? indexedEntries(value) : null;
  if (!list) return rangeEndId(value);
  let best: bigint | null = null;
  for (const e of list) {
    const id = lastReadOf(e, depth + 1);
    if (id !== null && (best === null || id > best)) best = id;
  }
  return best;
}

/** One TMessageReadRange -> member mid -> newest message id they have read. */
function readRangeToMap(entry: unknown): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const ranges = ((entry ?? {}) as Json).ranges;
  if (!ranges || typeof ranges !== "object") return out;
  for (const [mid, value] of Object.entries(ranges as Json)) {
    const id = lastReadOf(value);
    if (mid && id !== null) out.set(mid, id);
  }
  return out;
}

/**
 * Everyone but us, by how far they have read, sorted. Built once per chat and
 * then binary-searched, because the alternative is a scan of the whole member
 * list for every bubble on screen -- a real group came back with 553 members,
 * and a page of 30 messages would have been 16,590 comparisons for a
 * decoration.
 */
function readIndexOf(
  lastRead: Map<string, bigint> | undefined,
  selfMid: string,
): bigint[] {
  if (!lastRead?.size) return [];
  const out: bigint[] = [];
  for (const [mid, upTo] of lastRead) if (mid !== selfMid) out.push(upTo);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * 已讀 for one of our own messages, off readIndexOf's array. The denominator
 * is everyone LINE reported a range for, minus ourselves: in a 1:1 that is the
 * one peer, so `all` is exactly 「已讀」; in a group it stays 「已讀 N」 until
 * everyone the daemon knows about has caught up. Absent rather than zero when
 * there are no ranges at all -- the panel must not print 已讀 0 for a chat we
 * know nothing about, and an absent field is the contract's way of saying so.
 */
function readByAt(
  sorted: bigint[],
  messageId: string,
): PluginReadBy | undefined {
  const id = asMessageId(messageId);
  if (!sorted.length || id === null) return undefined;
  // First index whose value is >= id; everything from there on has read it.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < id) lo = mid + 1;
    else hi = mid;
  }
  const count = sorted.length - lo;
  return { count, all: count === sorted.length };
}
// enil:readrange-end

export {
  applyQueuedReactions,
  applyReaction,
  asMessageId,
  buildMentionMeta,
  chatMidOf,
  indexedEntries,
  lastReadOf,
  MENTION_MID,
  messageRequestId,
  normalizeMentions,
  panelRequestId,
  parseMentionMeta,
  previewableMessage,
  RANGE_MAX_DEPTH,
  rangeEndId,
  REACTION_NAMES,
  REACTION_PICKABLE,
  reactionName,
  reactionsFromRaw,
  readByAt,
  readIndexOf,
  readRangeToMap,
  summariseReactions,
  talkMetadataChange,
  talkOpEvent,
  talkOpNeedsFullSync,
};
export type { Mention, TalkMetadataChange, TalkOp };
