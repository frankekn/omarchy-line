/**
 * Outgoing media and text sends: the sendMessage payload (enil:sendargs
 * block), ObjType detection from magic bytes + extension (enil:mediakind),
 * the per-kind size caps (enil:sendcap), the sometimes-present upload fields
 * (enil:uploadargs), and sendFilePath -- the one uploadMediaByE2EE caller the
 * clipboard path also uses.
 *
 * Dependency direction: imports video (duration + thumbnail), session
 * (sessionIsCurrent), text (refusal), env, refresh (refreshChats) and types.
 * socket.ts dispatches into sendFilePath/sendArgs; nothing reaches back up.
 */
import { tagAt, videoLength, videoThumbnail } from "./video.ts";
import { refreshChats } from "./refresh.ts";
import { sessionIsCurrent } from "./session.ts";
import { refusal } from "./text.ts";
import type { Client } from "@evex/linejs";
import type { Json } from "./types.ts";

// The block between the enil:sendargs markers is sliced out verbatim by
// daemon/reply_test.ts; it is pure.
// enil:sendargs-begin
/**
 * The sendMessage payload `send` and `reply` share.
 *
 * `e2ee` is absent, and the absence is the whole point: it is the only value
 * that lets linejs decide. Asking for `e2ee: true` sent every message to a
 * contact with Letter Sealing turned off straight into a refusal --
 * encryptE2EEMessage runs *before* the request and its key lookup answers
 * `{"code":"E2EE_RETRY_PLAIN","reason":"member settings off"}`, which is
 * thrown from outside the retry, so the panel showed the raw
 * `RequestError: Request internal failed, getLastE2EEPublicKeys(/S4) -> ...`
 * for a message LINE would have accepted as plain text. Undefined sends plain
 * and lets the server's own E2EE refusal drive the encrypted retry
 * (vendor/linejs base/service/talk/mod.ts:172-183). That retry re-enters
 * sendMessage with this very object, so mentions and the quote survive it.
 *
 * A reply adds relatedMessageId and nothing else on purpose:
 * base.talk.sendMessage sets messageRelationType "REPLY" and
 * relatedMessageServiceCode "TALK" itself whenever that field is present
 * (vendor/linejs base/service/talk/mod.ts:155-161), and a second copy of that
 * rule here is a second place for it to go stale.
 */
function sendArgs(
  to: string,
  text: string,
  meta: { MENTION: string } | undefined,
  replyTo?: string,
  requestId = "",
): {
  to: string;
  text: string;
  contentMetadata?: Record<string, string>;
  relatedMessageId?: string;
} {
  return {
    to,
    text,
    // Spread rather than `contentMetadata: meta`: an explicit undefined would
    // override sendMessage's own `contentMetadata: {}` default.
    ...(meta || requestId
      ? {
        contentMetadata: {
          ...(meta ?? {}),
          ...(requestId ? { ENIL_REQUEST_ID: requestId } : {}),
        },
      }
      : {}),
    ...(replyTo ? { relatedMessageId: replyTo } : {}),
  };
}
// enil:sendargs-end

// The block between the enil:mediakind markers is sliced out verbatim by
// daemon/sendmedia_test.ts; it is pure -- a name and the first bytes in, an
// ObjType out, no filesystem and no client.
// enil:mediakind-begin
/**
 * Which of linejs's ObjTypes a file goes up as. The type picks both the OBS
 * namespace and the message's contentType (vendor/linejs base/obs/mod.ts:339):
 * emi/IMAGE(1), emv/VIDEO(2), emf/FILE(14). Sent as "file", a photo arrives as
 * an attachment row with a download button instead of a picture, and an mp4 as
 * something LINE will not play inline -- which is what everything that was not
 * .gif/.png/.jpg/.jpeg/.webp used to do here.
 *
 * "audio" (contentType 3) is deliberately never produced: LINE draws it as a
 * voice message with a waveform and a duration, and the duration would have to
 * come from a demuxer this daemon does not have. An .m4a is more use as a file
 * than as a 0:00 voice note.
 */
type MediaKind = "image" | "gif" | "video" | "file";

/** Enough head for the longest signature below: the ftyp brand ends at 12. */
const MEDIA_HEAD_BYTES = 16;

const KIND_BY_EXT: Record<string, MediaKind | undefined> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  gif: "gif",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
};

// ISO base media (`ftyp`) is one container for both a phone photo and a phone
// video, so the brand is the only thing that tells them apart. Anything else
// with an ftyp box is film: mp42, isom, avc1, qt, 3gp and the rest.
const IMAGE_BRANDS = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "avif",
  "avis",
];
// Sound in the same container. They must not fall through to "video": an .m4a
// sent as a VIDEO is a bubble with a play button and nothing to show.
const AUDIO_BRANDS = ["M4A ", "M4B ", "M4P ", "F4A ", "F4B "];

function headStarts(head: Uint8Array, bytes: number[]): boolean {
  return head.length >= bytes.length && bytes.every((b, i) => head[i] === b);
}

/**
 * The kind the first bytes claim, or null when nothing is recognised.
 *
 * Magic beats the name on purpose: a screenshot saved as `.txt` and an mp4 a
 * phone named `.jpg` both have to arrive as what they are, because LINE
 * renders from the contentType we send and never looks at the filename.
 */
function magicKind(head: Uint8Array): MediaKind | null {
  if (headStarts(head, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (headStarts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image"; // PNG
  }
  const six = tagAt(head, 0, 6);
  if (six === "GIF87a" || six === "GIF89a") return "gif";
  if (tagAt(head, 0, 4) === "RIFF") {
    const form = tagAt(head, 8, 4);
    if (form === "WEBP") return "image";
    if (form === "AVI ") return "video";
    // A .wav is a RIFF too, and it is a file.
    return null;
  }
  if (tagAt(head, 4, 4) === "ftyp") {
    const brand = tagAt(head, 8, 4);
    // A head too short to hold the brand decides nothing: falling through to
    // "video" would send any 11-byte file that happens to start `....ftyp` as
    // one. The name gets the say instead.
    if (!brand) return null;
    if (IMAGE_BRANDS.includes(brand)) return "image";
    return AUDIO_BRANDS.includes(brand) ? "file" : "video";
  }
  if (headStarts(head, [0x1a, 0x45, 0xdf, 0xa3])) return "video"; // Matroska
  return null;
}

/** The extension of a path, lowercase, without the dot. */
function extOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The ObjType `path` goes up as. `head` is its first MEDIA_HEAD_BYTES bytes;
 * the extension only gets a say where they say nothing we recognise.
 */
function mediaKindOf(path: string, head: Uint8Array): MediaKind {
  return magicKind(head) ?? KIND_BY_EXT[extOf(path)] ?? "file";
}
// enil:mediakind-end

// The block between the enil:sendcap markers is sliced out verbatim by
// daemon/sendmedia_test.ts on top of the mediakind block, which is where
// MediaKind comes from.
// enil:sendcap-begin
/**
 * What one send may weigh, by kind.
 *
 * There is no cap in linejs and none we can read off OBS either -- LINE
 * refuses an oversized upload only after the whole body has gone up, which on
 * a home connection is minutes of waiting for a sentence nobody can act on.
 * Ours is the earlier answer, and it is deliberately generous: it exists to
 * stop the daemon from destroying itself, not to second-guess LINE.
 *
 * Images stop at the clipboard's 20 MB (CLIPBOARD_MAX_BYTES, and the two are
 * one number in two places on purpose -- the clipboard module stays
 * self-contained the same way for its own tests) because that path costs
 * the most memory:
 * the file is read whole, encrypted into a second copy, and then uploaded
 * twice -- linejs re-uploads the payload as the `__ud-preview` object when it
 * is given no thumbnail (vendor/linejs base/obs/mod.ts:389). A gif is an
 * IMAGE too (`emi`, contentType 1, ibid. :339) and pays the same double
 * upload, so it shares the number. Video and file are the one-copy path and
 * get 1 GiB, which is past anything LINE itself will take.
 */
const SEND_MAX_BYTES: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  gif: 20 * 1024 * 1024,
  video: 1024 * 1024 * 1024,
  file: 1024 * 1024 * 1024,
};

/** A cap as the panel prints it. MB/GB the way the clipboard refusal says it. */
function capText(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  return bytes >= gb
    ? `${Math.round(bytes / gb)} GB`
    : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The refusal for a file too big to send as `kind`, or null.
 *
 * It names the limit because the user picked the file and is the only one who
 * can pick a smaller one; "傳送失敗" would leave them retrying the same 3 GB
 * recording. The noun follows the kind for the same reason the ObjType does --
 * being told an "圖片" is too big when a video was picked reads as a bug.
 */
function sizeRefusalText(kind: MediaKind, size: number): string | null {
  const cap = SEND_MAX_BYTES[kind];
  if (size <= cap) return null;
  const noun = kind === "video" ? "影片" : kind === "file" ? "檔案" : "圖片";
  return `${noun}太大（超過 ${capText(cap)}）`;
}

/**
 * The first `n` bytes of `path`, without reading the rest of it.
 *
 * mediaKindOf needs the head and the cap needs the kind, so the kind has to be
 * decided before the file is read -- reading a 3 GB recording into memory only
 * to refuse it is the thing the cap is for. The loop is not decoration: read()
 * is allowed to return fewer bytes than asked for, and a short first read
 * would leave magicKind() deciding on a truncated signature.
 */
async function readHead(path: string, n: number): Promise<Uint8Array> {
  const f = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const r = await f.read(buf.subarray(got));
      if (r === null) break;
      got += r;
    }
    return buf.subarray(0, got);
  } finally {
    f.close();
  }
}
// enil:sendcap-end

// The block between the enil:uploadargs markers is sliced out verbatim by
// daemon/videosend_test.ts; it is pure -- the preview and the length are both
// arguments.
// enil:uploadargs-begin
/**
 * The half of an `uploadMediaByE2EE` call that is only there sometimes: the
 * frame LINE draws on the bubble, and the length it prints on it.
 *
 * `durationMs` is a fork option (vendor/linejs base/obs/mod.ts:338); it is the
 * only way in, because the message's contentMetadata -- where LINE reads
 * `DURATION` from -- is built inside the upload (ibid. :414-424), and on the
 * E2EE path obs sees nothing but the encrypted blob, so it cannot read the
 * length out of the container itself the way a plain upload does. Both are
 * spread rather than passed as undefined so that a file, which has neither,
 * sends exactly the object linejs sent before either existed.
 */
function uploadExtras(
  jpeg: Uint8Array | null,
  durationMs: number | null,
  requestId = "",
): {
  preview?: Blob;
  durationMs?: number;
  contentMetadata?: Record<string, string>;
} {
  return {
    ...(jpeg ? { preview: new Blob([jpeg as BlobPart]) } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
    ...(requestId ? { contentMetadata: { ENIL_REQUEST_ID: requestId } } : {}),
  };
}
// enil:uploadargs-end

// The block between the enil:regularfile markers is sliced out verbatim by
// sendmedia_test.ts.
// enil:regularfile-begin
/**
 * The size of the file at `path`, or null when it is not a regular file. A
 * FIFO, a device or a directory reports a size of 0 or close to it, which
 * passes every size cap, and readFile on a FIFO or /dev/zero never comes
 * back. Follows symlinks, like the readFile after it.
 */
async function regularFileSize(path: string): Promise<number | null> {
  const info = await Deno.stat(path);
  return info.isFile ? info.size : null;
}
// enil:regularfile-end

/**
 * The refusal for a chat that cannot be uploaded to, or null.
 *
 * uploadMediaByE2EE only accepts mids starting with u or c (vendor/linejs
 * base/obs/mod.ts:364); anything else throws a bare "Invalid mid" that would
 * surface verbatim in a chat bubble. Refuse up front with something readable.
 */
function fileTargetRefusal(to: string): Json | null {
  if (/^[uc]/.test(to)) return null;
  return {
    ok: false,
    error: to.startsWith("r")
      ? "多人聊天室（room）暫不支援傳檔案"
      : "不支援的聊天室",
  };
}

/**
 * `sendFile`, and the second half of `sendClipboardImage`.
 *
 * One function rather than two callers of uploadMediaByE2EE so that a pasted
 * screenshot and a picked file cannot answer differently: same refusals, same
 * ObjType rule, same filename.
 */
async function sendFilePath(
  to: string,
  path: string,
  owner: Client,
  generation: number,
  requestId = "",
  filename = "",
): Promise<Json> {
  const bad = fileTargetRefusal(to);
  if (bad) return bad;
  // Read here as well as at the gate in handle(): a logout can land between
  // the two, and the words are the panel's either way.
  if (!sessionIsCurrent(owner, generation)) {
    return { ok: false, error: "尚未登入" };
  }
  const name = filename || path.split("/").pop() || "file";
  let bytes: Uint8Array;
  let kind: MediaKind;
  try {
    // Stat and head first, whole file after: the refusal below has to land
    // before the bytes are in memory, which is the only reason it exists. Both
    // reads share this catch because a path that cannot be opened is the same
    // answer whichever of them hits it first.
    const size = await regularFileSize(path);
    if (size === null) {
      return refusal(`不是一般檔案: ${path}`, "不是一般檔案");
    }
    kind = mediaKindOf(name, await readHead(path, MEDIA_HEAD_BYTES));
    const tooBig = sizeRefusalText(kind, size);
    if (tooBig) return { ok: false, error: tooBig };
    bytes = await Deno.readFile(path);
  } catch {
    return refusal(`找不到檔案: ${path}`, "找不到檔案");
  }
  // Held now, not read after the awaits below: thumbnailing a clip takes up to
  // ten seconds, and a logout landing inside that window would turn the upload
  // into a null dereference the panel has no words for.
  if (!sessionIsCurrent(owner, generation)) {
    return { ok: false, error: "尚未登入" };
  }
  const obs = owner.base.obs;
  // Only a video needs either. An image is its own preview (linejs re-uploads
  // the payload as `__ud-preview`) and a file has no length to show.
  const durationMs = kind === "video" ? await videoLength(bytes) : null;
  const jpeg = kind === "video" ? await videoThumbnail(path, durationMs) : null;
  if (!sessionIsCurrent(owner, generation)) {
    return { ok: false, error: "尚未登入" };
  }
  // uploadMediaByE2EE uploads *and* sends (it ends in talk.sendMessage), so
  // there is no follow-up send to do here.
  await obs.uploadMediaByE2EE({
    data: new Blob([bytes as BlobPart]),
    oType: kind,
    to,
    filename: name,
    ...uploadExtras(jpeg, durationMs, requestId),
  });
  // uploadMediaByE2EE ends by sending the message. Once it resolves, reporting
  // failure would invite a duplicate retry even if logout raced the reply.
  if (sessionIsCurrent(owner, generation)) refreshChats();
  return { ok: true };
}

export {
  fileTargetRefusal,
  MEDIA_HEAD_BYTES,
  mediaKindOf,
  sendArgs,
  sendFilePath,
  sizeRefusalText,
  uploadExtras,
};
export type { MediaKind };
