/**
 * Message conversion: a raw LINE talk message becomes the PluginMessage the
 * panel renders, with media-state classification, mention naming, reply
 * quoting, reaction seeding and the attachment cache (enil:mediacache block);
 * plus the chat-list preview derivation (enil:preview block) and the E2EE
 * file-name payload reader (enil:filepayload block). The blocks are sliced
 * verbatim by preview_test.ts / sendmedia_test.ts and pasted onto stub
 * preludes, so the module wrapper only adds imports and exports.
 *
 * Dependency direction: imports session, caches, state (me), names, avatars
 * (avatarNow), text, protocol and env (MEDIA_DIR). refresh.ts, push.ts and
 * socket.ts call into this module; nothing here reaches back up.
 */
import { MEDIA_DIR } from "./env.ts";
import {
  capCursors,
  capMap,
  cursors,
  goneMedia,
  isMe,
  REACTION_CACHE_MAX,
  reactionsBeforePublication,
  reactionsByMessage,
  readIndexFor,
  rememberRaw,
  REPLY_SOURCE_MAX,
  REPLY_TEXT_MAX,
  replySources,
} from "./caches.ts";
import { me } from "./state.ts";
import { resolveName } from "./names.ts";
import { avatarNow } from "./avatars.ts";
import {
  downloadErrorText,
  errorLine,
  errorText,
  expiresAtOf,
  mediaStateFrom,
  mediaStateOf,
  UNSENT_TEXT,
  unsentOf,
} from "./text.ts";
import {
  applyQueuedReactions,
  messageRequestId,
  parseMentionMeta,
  previewableMessage,
  reactionsFromRaw,
  readByAt,
  summariseReactions,
} from "./protocol.ts";
import { client, sessionGeneration, sessionIsCurrent } from "./session.ts";
import type { Client } from "@evex/linejs";
import type {
  Json,
  PluginLocation,
  PluginMention,
  PluginMessage,
  PluginPostEvent,
  TalkMsg,
} from "./types.ts";

// Exactly TalkMessage's `hasContents` (client/features/message/talk.ts:24);
// getData() throws "message have no contents" for anything else. There is no
// "GIF" ContentType either -- animated images arrive as IMAGE.
// enil:messageconvert-begin
const MEDIA_TYPES = ["IMAGE", "VIDEO", "AUDIO", "FILE"];

/** What an @All mention is called; the per-person ones use resolveName. */
const MENTION_ALL_NAME = "全部";

async function toPluginMessage(
  tm: TalkMsg,
  chatMid: string,
  fetchPreview = true,
  owner: Client | null = client,
  generation: number = sessionGeneration,
  deferOrderedState = false,
): Promise<PluginMessage> {
  const raw = tm.raw;
  const meta = (raw.contentMetadata ?? {}) as Json;
  const contentType = String(raw.contentType ?? "NONE");
  const hasContents = MEDIA_TYPES.includes(contentType);
  // A gone object outranks a metadata "ok": the panel then draws the
  // attachment as expired and never asks for its thumbnail again.
  const metaState = mediaStateOf(meta, hasContents, Date.now());
  const mediaState = metaState === "ok" && goneMedia.has(String(raw.id))
    ? "expired"
    : metaState;
  const out: PluginMessage = {
    id: String(raw.id),
    chat: chatMid,
    from: String(raw.from ?? ""),
    fromName: await resolveName(String(raw.from ?? ""), owner, generation),
    text: "",
    time: Number(raw.createdTime ?? 0),
    contentType,
    decryptFailed: false,
    // A recall leaves the message behind with its old contentType and its
    // metadata, but without the chunks the bytes live in, so every download
    // attempt fails deep inside linejs. Claiming media here would offer the
    // user an attachment that cannot open, which is the whole complaint.
    hasMedia: hasContents && mediaState !== "unsent",
    unsent: mediaState === "unsent",
    mediaState,
    // UPDATED_TIME / updatedTime both count -- the getter already checks both.
    edited: tm.isEdited === true || undefined,
  };
  // Every converted message deposits its wire struct so preview/download can
  // wrap() it back instead of re-fetching it from LINE.
  rememberRaw(out.id, raw);
  const requestId = messageRequestId(meta);
  if (requestId) out.requestId = requestId;

  try {
    out.text = tm.text ?? "";
  } catch {
    out.decryptFailed = true;
  }
  if (out.unsent) {
    // Before the E2EE check below, and clearing decryptFailed with it: a
    // recalled message has no plaintext to recover, and 「解密失敗」 would
    // blame the crypto for something the sender did on purpose.
    out.text = UNSENT_TEXT;
    out.decryptFailed = false;
  }
  // E2EE payloads that never decrypted come back as an empty text on a
  // message that plainly had one; the plugin renders that case explicitly.
  if (!out.text && raw.contentMetadata?.e2eeVersion && !out.hasMedia) {
    out.decryptFailed = true;
  }

  applyPostNotification(out, meta);
  if (
    contentType === "CHATEVENT" && !out.unsent && !out.decryptFailed &&
    (!out.text || out.text.toUpperCase() === "CHATEVENT") &&
    meta.LOC_KEY === "C_MA" && typeof meta.LOC_ARGS === "string" &&
    /^u[0-9a-f]{32}$/.test(meta.LOC_ARGS) &&
    owner && sessionIsCurrent(owner, generation)
  ) {
    const name = await resolveName(meta.LOC_ARGS, owner, generation);
    if (sessionIsCurrent(owner, generation)) {
      const actor = name.length <= 200 && name.trim() &&
          !/[ucr][0-9a-f]{32}/i.test(name) && !/\p{Cc}/u.test(name)
        ? name.trim()
        : "";
      out.chatEvent = { kind: "announcement", actor };
      out.text = `${actor || "成員"}設定了公告`;
    }
  }

  // After the recall and decrypt-failure branches above, not before: the
  // offsets index the text the panel is going to render, and those two
  // branches are what decide what that text is.
  const mentions = parseMentionMeta(meta, out.text);
  if (mentions.length) {
    // Name lookups are independent and each already has the LINE request
    // deadline. Resolve them together so one message costs at most one lookup
    // window instead of one window per mention.
    const named: PluginMention[] = await Promise.all(mentions.map(async (m) => {
      return {
        ...m,
        name: m.all
          ? MENTION_ALL_NAME
          : await resolveName(String(m.mid), owner, generation),
      };
    }));
    out.mentions = named;
  }

  if (out.contentType === "FLEX") {
    try {
      const flex = tm.getFlex();
      out.altText = flex.altText ?? "";
      out.flexImages = collectFlexImages(flex.flexJson);
    } catch { /* not every FLEX carries a usable payload */ }
  }

  // getStickerURL() interpolates STKID without checking it (talk.ts:169), so a
  // sticker whose metadata never arrived would yield a .../undefined/... URL
  // that the plugin then tries to load; leave the field absent instead.
  if (out.contentType === "STICKER" && meta.STKID) {
    try {
      out.stickerUrl = String(tm.getStickerURL());
    } catch { /* older linejs, or metadata the library refuses */ }
  }

  const fileName = meta.FILE_NAME
    ? String(meta.FILE_NAME)
    : fileNameOf(meta, await e2eeFilePayload(raw, owner, generation));
  if (fileName) out.fileName = fileName;
  if (meta.FILE_SIZE) out.fileSize = Number(meta.FILE_SIZE);
  if (contentType === "AUDIO") {
    const audioMs = audioLengthOf(meta);
    if (audioMs !== undefined) out.audioMs = audioMs;
  }
  // decryptE2EEMessage has already moved a sealed position into raw.location.
  if (contentType === "LOCATION") {
    const location = locationOf(raw.location);
    if (location) out.location = location;
  }
  // Reported even once it is in the past: the panel needs the moment to say
  // when the file went away, not just that it is gone.
  const expiresAt = expiresAtOf(meta);
  if (expiresAt !== undefined) out.expiresAt = expiresAt;

  // getData(preview) only honours `preview` on two of its three paths
  // (client/features/message/talk.ts:367): PREVIEW_URL, or downloadMessageData
  // with isPreview. When raw.chunks is set — Letter-Sealing, the default for
  // 1:1 — it falls through to downloadMediaByE2EE(raw), which takes no preview
  // flag and hands back the whole file. Fetching a video that way would write
  // the entire mp4 to <id>-preview and set mediaPath, and the panel would then
  // show an empty bubble: the Image never reaches Ready and the 📎 fallback is
  // suppressed by mediaPath being set. So only ask for a video preview where a
  // real thumbnail exists; E2EE videos keep the 📎 fallback. An IMAGE is safe
  // either way — the full-size original still renders, just larger.
  const previewable = previewableMessage(raw);
  if (mediaState === "ok" && previewable) out.previewable = true;
  // Neither a recalled nor an expired object is still on OBS, so a thumbnail
  // fetch here buys a guaranteed failure -- one per page of history, with the
  // request timeout to wait out -- for a bubble that will say why anyway.
  if (
    fetchPreview && owner && sessionIsCurrent(owner, generation) &&
    mediaState === "ok" &&
    previewable
  ) {
    const cached = await cacheMedia(tm, out.id, true);
    if ("path" in cached) out.mediaPath = cached.path;
  }

  // Everything below mutates shared, session-owned indexes. A logout or a
  // replacement login may have completed while names, decryption or media
  // were awaited above; an old conversion must stop before publishing into
  // the new account's caches.
  if (!owner || !sessionIsCurrent(owner, generation)) return out;

  // After resolveName() above, which is what the picture token rides in on.
  // Absent rather than empty when there is none yet: the panel draws the
  // initial instead, and the next page of history carries the path.
  const fromAvatar = avatarNow(out.from, owner, generation);
  if (fromAvatar) out.fromAvatar = fromAvatar;

  if (!deferOrderedState) {
    finalizeMessageState(out, raw, chatMid);
  }
  return out;
}

// enil:messageconvert-end

/**
 * The fields finalizeMessageState reads off a wire Message. The generated
 * LINETypes.Message satisfies this structurally, so callers pass raw directly
 * instead of asserting it into Json.
 */
interface FinalizeRawFields {
  id?: string | number | bigint;
  deliveredTime?: string | number | bigint;
  createdTime?: string | number | bigint;
  messageRelationType?: unknown;
  relatedMessageId?: unknown;
  reactions?: unknown;
}

function finalizeMessageState(
  out: PluginMessage,
  raw: FinalizeRawFields,
  chatMid: string,
): void {
  // These fields depend on operations and earlier messages. Incoming
  // conversions run concurrently, so refresh them only in ordered publication.
  delete out.replyTo;
  delete out.reactions;
  delete out.readBy;

  // messageRelationType is FORWARD/AUTO_REPLY/SUBORDINATE/REPLY; only REPLY
  // draws a quote header. LINE does not include the quoted text in the reply.
  const relation = raw.messageRelationType;
  if (raw.relatedMessageId && (relation === "REPLY" || relation === 3)) {
    const id = String(raw.relatedMessageId);
    out.replyTo = { id, ...(replySources.get(id) ?? {}) };
  }

  const reacted = reactionsFromRaw(raw.reactions);
  applyQueuedReactions(reacted, reactionsBeforePublication.get(out.id));
  if (reacted.size) {
    reactionsByMessage.set(out.id, reacted);
    capMap(reactionsByMessage, REACTION_CACHE_MAX);
  } else {
    reactionsByMessage.delete(out.id);
  }
  const bar = summariseReactions(reacted, String(me.mid ?? ""));
  if (bar.length) out.reactions = bar;

  // Only our own messages can truthfully show who has read them.
  if (isMe(out.from)) {
    const readBy = readByAt(readIndexFor(chatMid), out.id);
    if (readBy) out.readBy = readBy;
  }

  replySources.delete(out.id);
  replySources.set(out.id, {
    fromName: out.fromName,
    text: out.text.slice(0, REPLY_TEXT_MAX),
  });
  capMap(replySources, REPLY_SOURCE_MAX);

  // Map#set does not refresh insertion order. A message returned again by
  // history is recent and must survive the next bounded-cache eviction.
  cursors.delete(out.id);
  cursors.set(out.id, {
    chat: chatMid,
    messageId: BigInt(raw.id as string | number | bigint),
    deliveredTime: BigInt(
      (raw.deliveredTime ?? raw.createdTime ?? 0) as string | number | bigint,
    ),
    unsent: out.unsent,
    expiresAt: out.hasMedia ? out.expiresAt : undefined,
    from: out.from,
  });
  capCursors();
}

/** The plugin renders these URLs directly, so only absolute https ones. */
function collectFlexImages(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) collectFlexImages(n, acc);
  } else if (node && typeof node === "object") {
    const o = node as Json;
    if (
      o.type === "image" && typeof o.url === "string" &&
      o.url.startsWith("https://")
    ) {
      acc.push(o.url);
    }
    for (const v of Object.values(o)) collectFlexImages(v, acc);
  }
  return acc;
}

/**
 * The error travels with the miss rather than being swallowed: `download`
 * has to tell an expired file apart from a broken link, and only the thing
 * linejs threw knows which it was.
 */
// enil:mediacache-begin
function downloadMedia(
  tm: TalkMsg,
  id: string,
  preview: boolean,
  path: string,
  signal?: AbortSignal,
  removeOnFailure = false,
): Promise<{ path: string } | { error: Error }> {
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  return (async () => {
    try {
      // getData's AbortSignal is a fork addition (media-cancel propagation);
      // upstream takes preview only. bind keeps both signatures assignable —
      // upstream simply never sees the second argument at runtime.
      const getData = tm.getData.bind(tm) as (
        p: boolean,
        s?: AbortSignal,
      ) => Promise<Blob>;
      const blob: Blob = await getData(preview, signal);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.byteLength) throw new Error("empty media response");
      await Deno.writeFile(temp, bytes);
      await Deno.rename(temp, path);
      return { path };
    } catch (e) {
      await Deno.remove(temp).catch(() => {});
      if (removeOnFailure) await removeInvalidMedia(path);
      console.error(`[media] ${id}: ${errorLine(e)}`);
      return { error: e instanceof Error ? e : new Error(errorText(e)) };
    }
  })();
}

async function removeInvalidMedia(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

async function cacheMedia(
  tm: TalkMsg,
  id: string,
  preview: boolean,
  invalidate = false,
  signal?: AbortSignal,
): Promise<{ path: string } | { error: Error }> {
  const path = `${MEDIA_DIR}/${id}${preview ? "-preview" : ""}`;
  const active = mediaPending.get(path);
  if (active) {
    if (active.controller.signal.aborted) {
      const successor = {
        job: Promise.resolve<MediaResult>({ path }),
        invalidating: invalidate,
        controller: new AbortController(),
        subscribers: 0,
        settled: false,
      };
      successor.job = active.job.catch(() => ({ path })).then(async () => {
        if (successor.controller.signal.aborted) {
          throw successor.controller.signal.reason ??
            new DOMException("Aborted", "AbortError");
        }
        if (!invalidate) {
          try {
            const stat = await Deno.stat(path);
            if (stat.isFile && stat.size > 0) return { path };
          } catch { /* the predecessor produced no reusable file */ }
        }
        return await downloadMedia(
          tm,
          id,
          preview,
          path,
          successor.controller.signal,
          invalidate,
        );
      }).finally(() => {
        successor.settled = true;
        if (mediaPending.get(path) === successor) mediaPending.delete(path);
      });
      mediaPending.set(path, successor);
      return await subscribeMedia(successor, signal);
    }
    if (!invalidate || active.invalidating) {
      return await subscribeMedia(active, signal);
    }
    const replacement = {
      job: Promise.resolve<{ path: string } | { error: Error }>({ path }),
      invalidating: true,
      controller: new AbortController(),
      subscribers: 0,
      settled: false,
    };
    replacement.job = active.job.catch(() => ({ path })).then(async () => {
      if (replacement.controller.signal.aborted) {
        throw replacement.controller.signal.reason ??
          new DOMException("Aborted", "AbortError");
      }
      return await downloadMedia(
        tm,
        id,
        preview,
        path,
        replacement.controller.signal,
        true,
      );
    }).finally(() => {
      replacement.settled = true;
      if (mediaPending.get(path) === replacement) mediaPending.delete(path);
    });
    // Publish the replacement before yielding so every concurrent retry joins
    // the same invalidating download, even when it completes immediately.
    mediaPending.set(path, replacement);
    return await subscribeMedia(replacement, signal);
  }
  const entry = {
    job: Promise.resolve<{ path: string } | { error: Error }>({ path }),
    invalidating: invalidate,
    controller: new AbortController(),
    subscribers: 0,
    settled: false,
  };
  entry.job = (async () => {
    if (!invalidate) {
      try {
        const stat = await Deno.stat(path);
        if (stat.isFile && stat.size > 0) return { path };
      } catch { /* not cached yet */ }
    }
    if (entry.controller.signal.aborted) {
      throw entry.controller.signal.reason ??
        new DOMException("Aborted", "AbortError");
    }
    return await downloadMedia(
      tm,
      id,
      preview,
      path,
      entry.controller.signal,
      invalidate,
    );
  })().finally(() => {
    entry.settled = true;
    if (mediaPending.get(path) === entry) mediaPending.delete(path);
  });
  // Reserve the key before the first filesystem await. This closes the small
  // window where two cold or invalidating callers could both start downloads.
  mediaPending.set(path, entry);
  return await subscribeMedia(entry, signal);
}

type MediaResult = { path: string } | { error: Error };
interface MediaPendingEntry {
  job: Promise<MediaResult>;
  invalidating: boolean;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

function subscribeMedia(
  entry: MediaPendingEntry,
  signal?: AbortSignal,
): Promise<MediaResult> {
  entry.subscribers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.subscribers--;
    if (!entry.settled && entry.subscribers === 0) entry.controller.abort();
  };
  if (!signal) return entry.job.finally(release);
  return new Promise<MediaResult>((resolve, reject) => {
    let cancelled = signal.aborted;
    let cancelReason = signal.reason ??
      new DOMException("Aborted", "AbortError");
    const abort = () => {
      cancelled = true;
      cancelReason = signal.reason ??
        new DOMException("Aborted", "AbortError");
      // Stop the underlying transfer as soon as its last subscriber leaves,
      // but retain the caller's worker slot until non-abortable file work has
      // also settled.
      release();
    };
    if (!cancelled) signal.addEventListener("abort", abort, { once: true });
    else release();
    entry.job.then(
      (result) => cancelled ? reject(cancelReason) : resolve(result),
      (error) => cancelled ? reject(cancelReason) : reject(error),
    ).finally(() => signal.removeEventListener("abort", abort));
  }).finally(release);
}

const mediaPending = new Map<
  string,
  MediaPendingEntry
>();
// enil:mediacache-end

// The block between the enil:preview markers is sliced out verbatim by
// daemon/preview_test.ts, which cannot import daemon.ts (that would pull in
// linejs and the state dir). Keep it free of module state.
// enil:preview-begin

// The plugin prints lastText verbatim, so the fallback must never leak an
// internal ContentType code ("[STICKER]") into the chat list.
const PREVIEW_LABEL: Record<string, string> = {
  STICKER: "[貼圖]",
  CHATEVENT: "[系統事件]",
  POSTNOTIFICATION: "[貼文通知]",
  IMAGE: "[圖片]",
  EXIMAGE: "[圖片]",
  VIDEO: "[影片]",
  AUDIO: "[語音]",
  LOCATION: "[位置]",
  CONTACT: "[聯絡資訊]",
  CALL: "[通話]",
  LINK: "[連結]",
  APPLINK: "[連結]",
  GIFT: "[禮物]",
  MUSIC: "[音樂]",
  PAYMENT: "[付款]",
  PDF: "[檔案]",
};

// LINE often delivers CHATEVENT / POSTNOTIFICATION with text set to the event
// name itself (text === "POSTNOTIFICATION"), which would leak the English code
// into the chat list.
const SYSTEM_EVENT_TYPES = ["CHATEVENT", "POSTNOTIFICATION"];

function isSystemEventName(text: string, contentType: string): boolean {
  if (!SYSTEM_EVENT_TYPES.includes(contentType)) return false;
  return !text || text.toUpperCase() === contentType;
}

/** One line of sender-supplied text: no control or bidi override characters. */
function postField(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]+/gu, " ")
    .replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : line;
}

/**
 * What a POSTNOTIFICATION is about, from the metadata LINE sends with it: an
 * album update (serviceType AB: albumName, mediaCount -- photos and videos
 * alike) or a note / group-home post (GB, NT: sometimes the opening `text`).
 * null when there is nothing to say beyond the generic label.
 */
function postNotificationEvent(meta: Json): PluginPostEvent | null {
  const service = String(meta.serviceType ?? "");
  if (service === "AB") {
    const album = postField(meta.albumName, 60);
    if (!album) return null;
    const count = Number(meta.mediaCount);
    return {
      kind: "album",
      album,
      count: Number.isSafeInteger(count) && count > 0 ? count : 0,
    };
  }
  if (service === "GB" || service === "NT") {
    return { kind: "note", text: postField(meta.text, 200) };
  }
  return null;
}

/** The Chinese fallback line for a post event; clients translate the event. */
function postEventText(event: PluginPostEvent): string {
  if (event.kind === "album") {
    return event.count > 0
      ? `新增了 ${event.count} 個項目到相簿「${event.album}」`
      : `更新了相簿「${event.album}」`;
  }
  return event.text ? `記事本：${event.text}` : "發佈了記事本貼文";
}

function postNotificationText(meta: Json): string {
  const event = postNotificationEvent(meta);
  return event ? postEventText(event) : "";
}

/**
 * Decodes a POSTNOTIFICATION onto a converted message, but only one that
 * still reads as the bare event name: a recall, a failed decrypt or real
 * prose from LINE is left as it is.
 */
function applyPostNotification(
  out: {
    contentType: string;
    text: string;
    unsent?: boolean;
    decryptFailed?: boolean;
    postEvent?: PluginPostEvent;
  },
  meta: Json,
): void {
  if (
    out.contentType !== "POSTNOTIFICATION" || out.unsent || out.decryptFailed
  ) return;
  if (!isSystemEventName(out.text, out.contentType)) return;
  const event = postNotificationEvent(meta);
  if (!event) return;
  out.postEvent = event;
  out.text = postEventText(event);
}

/**
 * Where a FILE message keeps its name. Plain files carry it in
 * contentMetadata.FILE_NAME, but a Letter-Sealed one does not: the sender puts
 * it inside the encrypted payload as `fileName` next to keyMaterial (linejs
 * 3.3.2 base/obs/mod.ts:388, read back at :425), and the metadata that survives
 * is only SID/OID/FILE_SIZE/e2eeVersion -- which is exactly the shape that
 * reached us as "[檔案]" with a fileSize and no name. decryptE2EEMessage never
 * fills it in either: it only handles NONE and LOCATION (base/e2ee/mod.ts:722).
 */
function fileNameOf(meta: Json, decrypted?: Json | null): string {
  const keys = ["FILE_NAME", "fileName", "FILENAME"];
  for (const src of [meta, decrypted ?? {}]) {
    for (const k of keys) {
      const v = (src ?? {})[k];
      if (typeof v === "string" && v) return v;
    }
  }
  return "";
}

/**
 * The fields the preview helpers read off a wire Message. The generated
 * LINETypes.Message satisfies this structurally, so callers pass raw directly
 * instead of asserting it into Json.
 */
interface RawPreviewFields {
  contentType?: unknown;
  contentMetadata?: Json;
}

/**
 * The list shows one line of the preview, and the panel elides it, so a
 * long message is cut here instead of riding in every state write whole.
 * The whole text stays in history. Code points, so no surrogate is split.
 */
const PREVIEW_MAX_CHARS = 200;

function clipPreview(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  const chars = Array.from(text);
  if (chars.length <= PREVIEW_MAX_CHARS) return text;
  return chars.slice(0, PREVIEW_MAX_CHARS).join("") + "…";
}

function previewText(
  text: string,
  raw: RawPreviewFields,
  decrypted?: Json | null,
): string {
  return clipPreview(previewLine(text, raw, decrypted));
}

function previewLine(
  text: string,
  raw: RawPreviewFields,
  decrypted?: Json | null,
): string {
  const contentType = String(raw.contentType ?? "");
  // A recall leaves the contentType and the file name in place, so every
  // branch below would go on printing an attachment that is no longer there.
  if (unsentOf(raw.contentMetadata ?? {})) return UNSENT_TEXT;
  // System events take the label first; only real prose from LINE is printed.
  if (isSystemEventName(text, contentType)) {
    if (contentType === "POSTNOTIFICATION") {
      const post = postNotificationText(raw.contentMetadata ?? {});
      if (post) return post;
    }
    return PREVIEW_LABEL[contentType];
  }
  if (text) return text;
  const meta: Json = raw.contentMetadata ?? {};
  if (contentType === "FILE" || contentType === "PDF") {
    return fileNameOf(meta, decrypted) || "[檔案]";
  }
  // Layout messages carry LINE's own plain-text fallback; the panel's bodyText
  // already prefers it, so the chat list must not print "[FLEX]" instead.
  if (contentType === "FLEX" || contentType === "RICH") {
    const alt = String(meta.ALT_TEXT ?? "");
    if (alt) return alt;
  }
  return (Object.hasOwn(PREVIEW_LABEL, contentType)
    ? PREVIEW_LABEL[contentType]
    : undefined) ?? `[${contentType || "非文字"}]`;
}

function pushedPreviewText(
  message: {
    unsent: boolean;
    fileName?: string;
    altText?: string;
    text: string;
    chatEvent?: { kind: string };
  },
  raw: RawPreviewFields,
): string {
  if (message.unsent) return UNSENT_TEXT;
  // Refresh derives previews from the wire text, before actor resolution.
  // Keep push previews identical rather than flipping labels on refresh.
  if (message.chatEvent) return previewText("", raw);
  return clipPreview(message.fileName || message.altText || "") ||
    previewText(message.text, raw);
}
// enil:preview-end

// enil:filepayload-begin
/**
 * The name a FILE message carries inside its E2EE payload, and nothing else:
 * the payload also holds keyMaterial, so it is read here and dropped here
 * rather than handed back to a caller that has no use for the key. Null for
 * every other content type, so callers can pass the result straight to
 * fileNameOf() without a second guard.
 */
async function e2eeFilePayload(
  raw: unknown,
  owner: Client | null = client,
  generation: number = sessionGeneration,
): Promise<{ fileName: string } | null> {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as { contentType?: unknown; chunks?: unknown };
  if (String(message.contentType ?? "") !== "FILE") return null;
  const chunks = Array.isArray(message.chunks) ? message.chunks : undefined;
  if (!owner || !chunks?.length || !sessionIsCurrent(owner, generation)) {
    return null;
  }
  try {
    type EncryptedData = Parameters<
      typeof owner.base.e2ee.decryptE2EEDataMessage
    >[0];
    // Record<string, LooseType> is already a Json without an assertion:
    // every property type flows into unknown.
    const payload = await owner.base.e2ee.decryptE2EEDataMessage(
      raw as EncryptedData,
    );
    if (!sessionIsCurrent(owner, generation)) return null;
    const fileName = fileNameOf({}, payload);
    return fileName ? { fileName } : null;
  } catch (e) {
    // A file we cannot name still renders as [檔案]; never fatal.
    console.error("[file] name:", errorLine(e));
    return null;
  }
}
// enil:filepayload-end

/** A voice clip's length in ms; LINE writes AUDLEN, our uploads DURATION. */
function audioLengthOf(meta: Json): number | undefined {
  for (const key of ["AUDLEN", "DURATION"]) {
    const value = Number(meta[key]);
    if (meta[key] !== undefined && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return undefined;
}

/**
 * The place a LOCATION message shares, or null without a usable position.
 * Coordinates outside the globe are dropped: the page builds a map link
 * from them.
 */
function locationOf(value: unknown): PluginLocation | null {
  if (!value || typeof value !== "object") return null;
  const place = value as Json;
  const latitude = Number(place.latitude), longitude = Number(place.longitude);
  if (
    place.latitude === undefined || place.latitude === null ||
    place.longitude === undefined || place.longitude === null ||
    !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 || Math.abs(longitude) > 180
  ) return null;
  const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
  return {
    title: text(place.title),
    address: text(place.address),
    latitude,
    longitude,
  };
}

export {
  audioLengthOf,
  cacheMedia,
  collectFlexImages,
  downloadErrorText,
  downloadMedia,
  e2eeFilePayload,
  fileNameOf,
  finalizeMessageState,
  isSystemEventName,
  locationOf,
  mediaPending,
  mediaStateFrom,
  previewableMessage,
  previewText,
  pushedPreviewText,
  toPluginMessage,
};
