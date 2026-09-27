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
  isMe,
  REACTION_CACHE_MAX,
  reactionsBeforePublication,
  reactionsByMessage,
  readIndexFor,
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
import type { Json, PluginMention, PluginMessage, TalkMsg } from "./types.ts";

// Exactly TalkMessage's `hasContents` (client/features/message/talk.ts:24);
// getData() throws "message have no contents" for anything else. There is no
// "GIF" ContentType either -- animated images arrive as IMAGE.
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
  const mediaState = mediaStateOf(meta, hasContents, Date.now());
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
  };
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
  VIDEO: "[影片]",
  AUDIO: "[語音]",
};

// LINE often delivers CHATEVENT / POSTNOTIFICATION with text set to the event
// name itself (text === "POSTNOTIFICATION"), which would leak the English code
// into the chat list.
const SYSTEM_EVENT_TYPES = ["CHATEVENT", "POSTNOTIFICATION"];

function isSystemEventName(text: string, contentType: string): boolean {
  if (!SYSTEM_EVENT_TYPES.includes(contentType)) return false;
  return !text || text.toUpperCase() === contentType;
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

function previewText(
  text: string,
  raw: RawPreviewFields,
  decrypted?: Json | null,
): string {
  const contentType = String(raw.contentType ?? "");
  // A recall leaves the contentType and the file name in place, so every
  // branch below would go on printing an attachment that is no longer there.
  if (unsentOf(raw.contentMetadata ?? {})) return UNSENT_TEXT;
  // System events take the label first; only real prose from LINE is printed.
  if (isSystemEventName(text, contentType)) return PREVIEW_LABEL[contentType];
  if (text) return text;
  const meta: Json = raw.contentMetadata ?? {};
  if (contentType === "FILE") {
    return fileNameOf(meta, decrypted) || "[檔案]";
  }
  // Layout messages carry LINE's own plain-text fallback; the panel's bodyText
  // already prefers it, so the chat list must not print "[FLEX]" instead.
  if (contentType === "FLEX" || contentType === "RICH") {
    const alt = String(meta.ALT_TEXT ?? "");
    if (alt) return alt;
  }
  return PREVIEW_LABEL[contentType] ?? `[${contentType || "非文字"}]`;
}

function pushedPreviewText(
  message: {
    unsent: boolean;
    fileName?: string;
    altText?: string;
    text: string;
  },
  raw: RawPreviewFields,
): string {
  if (message.unsent) return UNSENT_TEXT;
  return message.fileName || message.altText || previewText(message.text, raw);
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
    console.error("[file] name:", (e as Error).message);
    return null;
  }
}
// enil:filepayload-end

export {
  cacheMedia,
  collectFlexImages,
  downloadErrorText,
  downloadMedia,
  e2eeFilePayload,
  fileNameOf,
  finalizeMessageState,
  isSystemEventName,
  mediaPending,
  mediaStateFrom,
  previewableMessage,
  previewText,
  pushedPreviewText,
  toPluginMessage,
};
