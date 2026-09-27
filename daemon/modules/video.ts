/**
 * Video container parsing and thumbnailing: the ISO base media and EBML
 * duration walkers (enil:videoduration block), the external thumbnailer
 * invocation (enil:videopreview block), and the impure child-process runner
 * the preview block takes as a parameter. Pure with respect to LINE: no
 * session, no daemon state beyond MEDIA_DIR.
 *
 * Dependency direction: imports env (MEDIA_DIR) only. media-send.ts calls
 * videoLength/videoThumbnail; nothing reaches here from below.
 */
import { MEDIA_DIR } from "./env.ts";

// The block between the enil:videoduration markers is sliced out verbatim by
// daemon/videosend_test.ts, together with the mediakind block above -- it
// reads tagAt from there. It is pure: every byte comes from `read`.
// enil:videoduration-begin
/**
 * Reads `len` bytes at `at`. Short at the end of the file, never a throw.
 *
 * A function rather than the bytes so that the walk below can only touch what
 * it names: a phone writes `moov` *after* a 4 GB `mdat`, and the whole point
 * of parsing the header is not to walk the payload to reach it. The test
 * hands it a file whose mdat throws.
 */
type ByteReader = (at: number, len: number) => Promise<Uint8Array>;

/** A ByteReader over bytes already in hand -- `sendFile` has the whole file. */
function bytesReader(bytes: Uint8Array): ByteReader {
  return (at, len) =>
    Promise.resolve(bytes.subarray(at, Math.min(at + len, bytes.length)));
}

/** A big-endian unsigned integer. Eight bytes lose precision past 2^53. */
function beInt(b: Uint8Array, at: number, len: number): number {
  let n = 0;
  for (let i = 0; i < len; i++) n = n * 256 + b[at + i];
  return n;
}

/** A container's payload, `end` exclusive. */
type Span = { at: number; end: number };

/** Nothing we would send is a day long; a parse that says so misparsed. */
const DURATION_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How many siblings the walk looks at before giving up. Both headers sit at
 * the front of their parent in every writer's output, so this is the "when
 * cheap" bound: a Matroska whose Info is behind 64 clusters gets no length
 * rather than a scan of the file.
 */
const CONTAINER_SCAN_LIMIT = 64;

/** `len` bytes of `head` from `from` as ASCII, or "" when they are not there. */
export function tagAt(head: Uint8Array, from: number, len: number): string {
  if (head.length < from + len) return "";
  let s = "";
  for (let i = from; i < from + len; i++) s += String.fromCharCode(head[i]);
  return s;
}

/**
 * The `want` box among the children that start at `at`, or null.
 *
 * Every box is `size(4) type(4) payload`, so skipping one costs the eight
 * bytes of its header no matter how big it is.
 */
async function isoBox(
  read: ByteReader,
  at: number,
  end: number,
  want: string,
): Promise<Span | null> {
  for (let i = 0; i < CONTAINER_SCAN_LIMIT && at + 8 <= end; i++) {
    const head = await read(at, 16);
    if (head.length < 8) return null;
    let size = beInt(head, 0, 4);
    let body = at + 8;
    if (size === 1) {
      // 1 means the real size is the 64-bit `largesize` that follows -- how
      // anything over 4 GB writes its mdat.
      if (head.length < 16) return null;
      size = beInt(head, 8, 8);
      body = at + 16;
    } else if (size === 0) {
      size = end - at; // "to the end of the file"
    }
    // A size that cannot hold its own header would walk backwards forever.
    if (size < body - at) return null;
    if (tagAt(head, 4, 4) === want) {
      return { at: body, end: Math.min(at + size, end) };
    }
    at += size;
  }
  return null;
}

/**
 * `moov/mvhd`'s duration, in milliseconds.
 *
 * mvhd is `version(1) flags(3)` and then two timestamps we have no use for,
 * the timescale (ticks per second) and the duration in those ticks. Version 0
 * writes the timestamps and the duration as 32-bit, version 1 as 64-bit --
 * which is the only difference between them that matters here.
 */
async function isoDurationMs(
  read: ByteReader,
  size: number,
): Promise<number | null> {
  const moov = await isoBox(read, 0, size, "moov");
  if (!moov) return null;
  const mvhd = await isoBox(read, moov.at, moov.end, "mvhd");
  if (!mvhd) return null;
  const b = await read(mvhd.at, 32);
  if (b.length < 1) return null;
  const wide = b[0] === 1;
  const at = wide ? 20 : 12;
  const len = wide ? 8 : 4;
  if (b.length < at + 4 + len) return null;
  const timescale = beInt(b, at, 4);
  const ticks = beInt(b, at + 4, len);
  // All-ones is ISO's "unknown", and a 64-bit one is past what a double
  // holds exactly -- both mean the header does not know the length.
  if (!timescale || !Number.isSafeInteger(ticks)) return null;
  if (len === 4 && ticks === 0xffffffff) return null;
  return Math.round((ticks / timescale) * 1000);
}

const EBML_MAGIC = 0x1a45dfa3;
const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
/** TimestampScale: nanoseconds per Duration tick. Defaults to 1e6, i.e. ms. */
const EBML_TIMESCALE = 0x2ad7b1;
/** Duration: a float, in TimestampScale ticks. */
const EBML_DURATION = 0x4489;

/**
 * The EBML variable-length integer at `at`, and how wide it was.
 *
 * The leading zeros of the first byte give the width. An id keeps its marker
 * bit -- that is how ids are written and compared -- while a size has it
 * stripped; a size whose value bits are all ones means "until the parent
 * ends", which is how a still-recording file writes its Segment.
 */
function ebmlInt(
  b: Uint8Array,
  at: number,
  isId: boolean,
): { value: number; width: number; unknown: boolean } | null {
  if (at >= b.length) return null;
  let width = 1;
  while (width <= 8 && !(b[at] & (0x80 >> (width - 1)))) width++;
  if (width > 8 || at + width > b.length) return null;
  const mask = 0xff >> width;
  let value = isId ? b[at] : b[at] & mask;
  let unknown = (b[at] & mask) === mask;
  for (let i = 1; i < width; i++) {
    value = value * 256 + b[at + i];
    unknown = unknown && b[at + i] === 0xff;
  }
  return { value, width, unknown };
}

/** The `want` element among the children that start at `at`, or null. */
async function ebmlChild(
  read: ByteReader,
  at: number,
  end: number,
  want: number,
): Promise<Span | null> {
  for (let i = 0; i < CONTAINER_SCAN_LIMIT && at < end; i++) {
    const head = await read(at, 16);
    const id = ebmlInt(head, 0, true);
    if (!id) return null;
    const size = ebmlInt(head, id.width, false);
    if (!size) return null;
    const body = at + id.width + size.width;
    const stop = size.unknown ? end : Math.min(body + size.value, end);
    if (id.value === want) return { at: body, end: stop };
    // Nothing can follow an element that has no stated end.
    if (size.unknown) return null;
    at = body + size.value;
  }
  return null;
}

/** `Segment/Info`'s Duration, scaled by TimestampScale, in milliseconds. */
async function mkvDurationMs(
  read: ByteReader,
  size: number,
): Promise<number | null> {
  const seg = await ebmlChild(read, 0, size, EBML_SEGMENT);
  if (!seg) return null;
  const info = await ebmlChild(read, seg.at, seg.end, EBML_INFO);
  if (!info) return null;
  const el = await ebmlChild(read, info.at, info.end, EBML_DURATION);
  if (!el) return null;
  const raw = await read(el.at, el.end - el.at);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const ticks = raw.length === 4
    ? view.getFloat32(0)
    : raw.length === 8
    ? view.getFloat64(0)
    : null;
  if (ticks === null || !Number.isFinite(ticks)) return null;
  let scale = 1_000_000;
  const scaleEl = await ebmlChild(read, info.at, info.end, EBML_TIMESCALE);
  if (scaleEl) {
    const b = await read(scaleEl.at, scaleEl.end - scaleEl.at);
    if (b.length > 0 && b.length <= 8) scale = beInt(b, 0, b.length);
  }
  if (!scale) return null;
  return Math.round((ticks * scale) / 1e6);
}

/**
 * Whether the first bytes are an ISO base media box header. Not just `ftyp`:
 * a QuickTime .mov may open straight on `moov`, and every box type is four
 * printable characters.
 */
function isoLike(head: Uint8Array): boolean {
  const size = beInt(head, 0, 4);
  // 0 is "to the end of the file" and 1 is "the size is the 64 bits below".
  if (size !== 0 && size !== 1 && size < 8) return false;
  return /^[\x20-\x7e]{4}$/.test(tagAt(head, 4, 4));
}

/**
 * How long the clip is in milliseconds, or null when its header does not say.
 *
 * Null is a normal answer, not a failure: an AVI keeps its length somewhere
 * this does not look, and a file still being written has none yet. The caller
 * sends the video without a length rather than not sending it.
 */
async function videoDurationMs(
  read: ByteReader,
  size: number,
): Promise<number | null> {
  const head = await read(0, 16);
  if (head.length < 8) return null;
  const ms = beInt(head, 0, 4) === EBML_MAGIC
    ? await mkvDurationMs(read, size)
    : isoLike(head)
    ? await isoDurationMs(read, size)
    : null;
  // A misparse is worth nothing and a wrong length on the bubble is worse
  // than none, so anything outside what a clip can be is dropped.
  if (ms === null || ms <= 0 || ms > DURATION_MAX_MS) return null;
  return ms;
}
// enil:videoduration-end

// The block between the enil:videopreview markers is sliced out verbatim by
// daemon/videosend_test.ts, so the process to run is an argument: the tests
// drive a thumbnailer that is missing, that fails, and that writes rubbish.
// enil:videopreview-begin
/**
 * Why a video needs a thumbnail of its own: given no `preview`, linejs
 * uploads the encrypted video *again* as the `__ud-preview` object
 * (vendor/linejs base/obs/mod.ts:389). That is why an image comes out right
 * -- its own bytes are a picture -- and why a video used to arrive as a blank
 * tile: the receiver draws an mp4 as a JPEG.
 *
 * Neither tool is a dependency. A machine without both sends what it sent
 * before, minus nothing.
 */
const THUMB_TOOLS = ["ffmpegthumbnailer", "ffmpeg"];

/** A frame this far in, so the thumbnail is not the fade-in from black. */
const THUMB_SEEK_MS = 1_000;

/** The width of the JPEG we upload. A preview, not a second copy. */
const THUMB_MAX_PX = 640;

/** What one thumbnailer run answered; `stderr` is already text and trimmed. */
type ToolRun = { code: number; stderr: string };

/** `ms` as `hh:mm:ss.mmm`. */
function thumbTime(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const hh = pad(Math.floor(t / 3_600_000));
  const mm = pad(Math.floor(t / 60_000) % 60);
  const ss = pad(Math.floor(t / 1_000) % 60);
  return `${hh}:${mm}:${ss}.${pad(t % 1_000, 3)}`;
}

/** argv for one thumbnailer: one JPEG frame of `src` at `seekMs` into `out`. */
function thumbArgs(
  tool: string,
  src: string,
  out: string,
  seekMs: number,
): string[] {
  const at = thumbTime(seekMs);
  if (tool === "ffmpegthumbnailer") {
    // The fraction is cut off on purpose: ffmpegthumbnailer reads `-t` as
    // `hh:mm:ss` or as a *percentage*, so a bare `1` would be one percent of
    // the clip and `00:00:01.500` is not a time it parses.
    return [
      "-i",
      src,
      "-o",
      out,
      "-t",
      at.slice(0, 8),
      "-s",
      String(THUMB_MAX_PX),
      "-c",
      "jpeg",
    ];
  }
  return [
    // ffmpeg reads the daemon's stdin unless told not to, and a systemd unit
    // has none to give.
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    // Before -i: seek by keyframe and decode one frame, rather than decode
    // everything up to the second and throw it away.
    "-ss",
    at,
    "-i",
    src,
    "-frames:v",
    "1",
    // No `min(640,iw)`: a comma inside a filter argument has to be escaped,
    // and upscaling a small clip costs a few KB where getting the escaping
    // wrong costs the preview.
    "-vf",
    `scale=${THUMB_MAX_PX}:-2`,
    "-f",
    "mjpeg",
    out,
  ];
}

/**
 * A JPEG frame of `src`, or the reason there is none.
 *
 * The reason is a sentence for the journal, never for the panel: a send whose
 * preview could not be made is still a send, so every path out of here that
 * is not a JPEG is `skipped`, and the caller uploads without one.
 */
async function videoPreviewJpeg(
  dir: string,
  src: string,
  seekMs: number,
  run: (tool: string, args: string[]) => Promise<ToolRun>,
): Promise<{ jpeg: Uint8Array } | { skipped: string }> {
  // A name per call, not `Date.now()`: two videos sent inside the same
  // millisecond used to get the same path, so the second thumbnailer
  // overwrote the first one's frame and whichever call finished first
  // deleted the file under the other -- one of the two bubbles arrived
  // blank. Under MEDIA_DIR rather than /tmp, so a copy left behind by a
  // crash is swept with the rest of the media cache. Removed either way.
  const out = `${dir}/preview-${crypto.randomUUID()}.jpg`;
  try {
    for (const tool of THUMB_TOOLS) {
      let r: ToolRun;
      try {
        r = await run(tool, thumbArgs(tool, src, out, seekMs));
      } catch (e) {
        // Deno throws NotFound for the executable itself. Neither tool is
        // installed by Omarchy, so this is the ordinary case, not an error.
        if (e instanceof Deno.errors.NotFound) continue;
        return { skipped: `${tool}: ${(e as Error).message}` };
      }
      if (r.code !== 0) {
        return { skipped: `${tool} exit ${r.code}: ${r.stderr.slice(0, 80)}` };
      }
      let jpeg: Uint8Array;
      try {
        jpeg = await Deno.readFile(out);
      } catch {
        return { skipped: `${tool} wrote no file` };
      }
      // SOI at the front and EOI at the back: a run killed by the timeout
      // leaves half a frame on disk, and half a JPEG uploaded as the preview
      // is the blank tile again.
      const whole = jpeg.length > 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 &&
        jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
      if (!whole) {
        return { skipped: `${tool} wrote ${jpeg.length} bytes, not a JPEG` };
      }
      return { jpeg };
    }
    return { skipped: `no ${THUMB_TOOLS.join(" or ")} on PATH` };
  } finally {
    await Deno.remove(out).catch(() => {});
  }
}
// enil:videopreview-end

// The impure half of videoPreviewJpeg(): a child process, and a bound on how
// long it may take.
const THUMB_TIMEOUT_MS = 10_000;

async function runThumbnailer(
  tool: string,
  args: string[],
): Promise<ToolRun> {
  const out = await new Deno.Command(tool, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    // A thumbnailer that never returns would otherwise hold the send -- and
    // with it the panel's socket -- open for good. An aborted child resolves
    // as a signal exit rather than throwing, so say which.
    signal: AbortSignal.timeout(THUMB_TIMEOUT_MS),
  }).output();
  return {
    code: out.code,
    stderr: out.signal
      ? `killed by ${out.signal} after ${THUMB_TIMEOUT_MS}ms`
      : new TextDecoder().decode(out.stderr).trim(),
  };
}

/**
 * The clip's length, or null. Never throws: a container we cannot read is a
 * video without a length on its bubble, not a send that failed.
 */
async function videoLength(bytes: Uint8Array): Promise<number | null> {
  try {
    return await videoDurationMs(bytesReader(bytes), bytes.length);
  } catch (e) {
    console.error(`[cmd] sendFile duration skipped: ${(e as Error).message}`);
    return null;
  }
}

/** The JPEG to send as the video's preview, or null with a line in the log. */
async function videoThumbnail(
  path: string,
  durationMs: number | null,
): Promise<Uint8Array | null> {
  // Half way into a clip shorter than two seconds: past the end both tools
  // write no frame at all, and the bubble would be blank for the one case
  // where the length *is* known.
  const seek = durationMs !== null && durationMs < THUMB_SEEK_MS * 2
    ? Math.floor(durationMs / 2)
    : THUMB_SEEK_MS;
  let got: { jpeg: Uint8Array } | { skipped: string };
  try {
    got = await videoPreviewJpeg(MEDIA_DIR, path, seek, runThumbnailer);
  } catch (e) {
    // Nothing about making a thumbnail may end a send: a full disk under
    // MEDIA_DIR is a video without a preview, same as a missing ffmpeg.
    got = { skipped: (e as Error).message };
  }
  if ("jpeg" in got) return got.jpeg;
  console.error(`[cmd] sendFile preview skipped: ${got.skipped}`);
  return null;
}

export { thumbArgs, videoLength, videoPreviewJpeg, videoThumbnail };
export type { ToolRun };
