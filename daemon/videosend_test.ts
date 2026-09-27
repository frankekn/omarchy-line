/**
 * What a video send carries beyond the file itself: the length read out of
 * the container's header, and the JPEG frame LINE draws on the bubble.
 *
 *   deno test -A videosend_test.ts
 *
 * Nothing here spawns ffmpeg or uploads anything. The parser reads through a
 * `read` argument, so a test can hand it a 5 GB file whose payload throws;
 * the thumbnailer is a function argument, so a test can drive one that is not
 * installed, one that fails, and one that writes half a JPEG.
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock, loadBlocks } from "./slice_test.ts";

const DURATION_PRELUDE = `
export { beInt, bytesReader, ebmlInt, isoLike, videoDurationMs };
`;
const PREVIEW_PRELUDE = `
export {
  THUMB_MAX_PX,
  THUMB_SEEK_MS,
  THUMB_TOOLS,
  thumbArgs,
  thumbTime,
  videoPreviewJpeg,
};
`;
const ARGS_PRELUDE = `
export { uploadExtras };
`;

type ByteReader = (at: number, length: number) => Promise<Uint8Array>;
interface DurationModule {
  bytesReader(bytes: Uint8Array): ByteReader;
  ebmlInt(
    bytes: Uint8Array,
    at: number,
    isId: boolean,
  ): { value: number; width: number; unknown: boolean } | null;
  videoDurationMs(read: ByteReader, size: number): Promise<number | null>;
}
interface PreviewModule {
  THUMB_MAX_PX: number;
  THUMB_TOOLS: string[];
  thumbArgs(tool: string, src: string, out: string, seekMs: number): string[];
  thumbTime(ms: number): string;
  videoPreviewJpeg(
    dir: string,
    src: string,
    seekMs: number,
    run: (
      tool: string,
      args: string[],
    ) => Promise<{ code: number; stderr: string }>,
  ): Promise<{ jpeg?: Uint8Array; skipped?: string }>;
}
interface UploadModule {
  uploadExtras(
    jpeg: Uint8Array | null,
    durationMs: number | null,
    requestId?: string,
  ): {
    preview?: Blob;
    durationMs?: number;
    contentMetadata?: Record<string, string>;
  };
}
let D: DurationModule | undefined;
async function durations(): Promise<DurationModule> {
  // The parser reads box types with tagAt(), which lives in the mediakind
  // block; stubbing it here would test the stub.
  if (!D) {
    D = await loadBlocks<DurationModule>(
      ["mediakind", "videoduration"],
      DURATION_PRELUDE,
    );
  }
  return D;
}

let P: PreviewModule | undefined;
async function previews(): Promise<PreviewModule> {
  if (!P) P = await loadBlock<PreviewModule>("videopreview", PREVIEW_PRELUDE);
  return P;
}

let A: UploadModule | undefined;
async function args(): Promise<UploadModule> {
  if (!A) A = await loadBlock<UploadModule>("uploadargs", ARGS_PRELUDE);
  return A;
}

// ------------------------------------------------------------------ builders

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ascii = (s: string) => new TextEncoder().encode(s);

/** An ISO base media box: `size(4) type(4) payload`. */
function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

/** A box header whose payload is not there: `size` counts bytes that follow. */
function bigBox(type: string, size: number): Uint8Array {
  const out = new Uint8Array(16);
  const v = new DataView(out.buffer);
  v.setUint32(0, 1); // "the real size is the 64 bits below"
  out.set(ascii(type), 4);
  v.setBigUint64(8, BigInt(size));
  return out;
}

const FTYP = box("ftyp", concat(ascii("isom"), new Uint8Array(8)));

/** A version 0 mvhd: 32-bit timestamps, timescale and duration. */
function mvhd0(timescale: number, ticks: number): Uint8Array {
  const p = new Uint8Array(100);
  const v = new DataView(p.buffer);
  v.setUint32(12, timescale);
  v.setUint32(16, ticks);
  return box("mvhd", p);
}

/** A version 1 mvhd: 64-bit timestamps and duration, 32-bit timescale. */
function mvhd1(timescale: number, ticks: number): Uint8Array {
  const p = new Uint8Array(120);
  const v = new DataView(p.buffer);
  p[0] = 1;
  v.setUint32(20, timescale);
  v.setBigUint64(24, BigInt(ticks));
  return box("mvhd", p);
}

/** An EBML element size, one byte where it fits and eight where it does not. */
function ebmlSize(n: number): Uint8Array {
  if (n < 0x7f) return new Uint8Array([0x80 | n]);
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function elem(id: number[], payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array(id), ebmlSize(payload.length), payload);
}

/** An element whose size says "until the parent ends". */
function openElem(id: number[], payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array(id), new Uint8Array([0xff]), payload);
}

const EBML_HEAD = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT = [0x18, 0x53, 0x80, 0x67];
const INFO = [0x15, 0x49, 0xa9, 0x66];
const SEEKHEAD = [0x11, 0x4d, 0x9b, 0x74];
const DURATION = [0x44, 0x89];
const TIMESCALE = [0x2a, 0xd7, 0xb1];

function f64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return b;
}

function f32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n);
  return b;
}

/** A big-endian unsigned integer in as few bytes as it needs. */
function uint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  do {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return new Uint8Array(out);
}

/** A Matroska whose Segment/Info holds the elements given. */
function mkv(info: Uint8Array[], open = false): Uint8Array {
  const body = concat(
    elem(SEEKHEAD, new Uint8Array(16)),
    elem(INFO, concat(...info)),
  );
  const header = elem(EBML_HEAD, new Uint8Array(8));
  return concat(header, open ? openElem(SEGMENT, body) : elem(SEGMENT, body));
}

/** A reader over pieces at fixed offsets, and a log of what it was asked. */
function virtual(size: number, pieces: [number, Uint8Array][]) {
  const reads: [number, number][] = [];
  const read = (at: number, len: number) => {
    reads.push([at, len]);
    const n = Math.max(0, Math.min(len, size - at));
    const out = new Uint8Array(n);
    for (const [start, b] of pieces) {
      for (let i = 0; i < n; i++) {
        const abs = at + i;
        if (abs >= start && abs < start + b.length) out[i] = b[abs - start];
      }
    }
    return Promise.resolve(out);
  };
  return { read, reads };
}

// ------------------------------------------------------------------ duration

function ms(m: DurationModule, file: Uint8Array): Promise<number | null> {
  return m.videoDurationMs(m.bytesReader(file), file.length);
}

Deno.test("the length an mp4 header states", async () => {
  const m = await durations();
  // 600 ticks a second is what every QuickTime muxer writes; 90000 is what
  // an MPEG-derived one does.
  assertEquals(await ms(m, concat(FTYP, box("moov", mvhd0(600, 9000)))), 15000);
  assertEquals(
    await ms(m, concat(FTYP, box("moov", mvhd1(90000, 1_350_000)))),
    15000,
  );
  // A .mov may open straight on moov, with no ftyp box at all.
  assertEquals(await ms(m, box("moov", mvhd0(1000, 500))), 500);
});

Deno.test("a header that does not know the length answers null", async () => {
  const m = await durations();
  const table: [string, Uint8Array][] = [
    ["no moov", concat(FTYP, box("mdat", new Uint8Array(32)))],
    ["no mvhd", concat(FTYP, box("moov", box("trak", new Uint8Array(32))))],
    ["timescale 0", concat(FTYP, box("moov", mvhd0(0, 9000)))],
    ["duration 0", concat(FTYP, box("moov", mvhd0(600, 0)))],
    // 0xffffffff is ISO's own "unknown", written by anything still recording.
    ["unknown", concat(FTYP, box("moov", mvhd0(600, 0xffffffff)))],
    ["empty", new Uint8Array(0)],
    ["short", ascii("ftyp")],
    ["a JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0, 0])],
    ["zeros", new Uint8Array(64)],
  ];
  for (const [name, file] of table) {
    assertEquals(await ms(m, file), null, name);
  }
});

Deno.test("a truncated file has a length only once it holds one", async () => {
  const m = await durations();
  const whole = concat(FTYP, box("moov", mvhd0(600, 9000)));
  // ftyp, the moov and mvhd headers, and the 20 bytes of mvhd that end with
  // the duration field. Nothing past that is read, so a copy cut anywhere
  // before it has to answer null rather than take a stray byte for a
  // timescale -- and a copy cut after it is a length, truncated or not.
  const enough = FTYP.length + 8 + 8 + 20;
  assertEquals(enough, 56);
  for (let n = 0; n < enough; n++) {
    assertEquals(await ms(m, whole.subarray(0, n)), null, `cut at ${n}`);
  }
  for (const n of [enough, enough + 1, whole.length]) {
    assertEquals(await ms(m, whole.subarray(0, n)), 15000, `cut at ${n}`);
  }
});

Deno.test("moov behind 5 GB of payload costs a few header reads", async () => {
  const m = await durations();
  // What a phone writes: the movie header goes last, after the frames. The
  // point of the walk is to skip mdat by its stated size, so the reader here
  // throws if anything asks for a byte of that payload.
  const mdat = bigBox("mdat", 5_000_000_000);
  const moov = box("moov", mvhd0(600, 9000));
  const mdatAt = FTYP.length;
  const moovAt = mdatAt + 5_000_000_000;
  const size = moovAt + moov.length;
  const v = virtual(size, [[0, FTYP], [mdatAt, mdat], [moovAt, moov]]);
  const guarded = (at: number, len: number) => {
    // The 64-bit largesize is read with the header; the payload is not.
    assert(
      at >= moovAt || at + len <= mdatAt + 16,
      `read ${len} bytes at ${at}, inside the payload`,
    );
    return v.read(at, len);
  };
  assertEquals(await m.videoDurationMs(guarded, size), 15000);
  const took = v.reads.reduce((n, [, len]) => n + len, 0);
  assert(took < 200, `read ${took} bytes of a 5 GB file`);
});

Deno.test("the length a Matroska states", async () => {
  const m = await durations();
  // Duration is a float in TimestampScale ticks, and the default scale is
  // 1e6 ns -- so a bare Duration is already milliseconds.
  assertEquals(await ms(m, mkv([elem(DURATION, f64(12345))])), 12345);
  assertEquals(await ms(m, mkv([elem(DURATION, f32(2500))])), 2500);
  assertEquals(
    await ms(
      m,
      mkv([elem(TIMESCALE, uint(500_000)), elem(DURATION, f64(20_000))]),
    ),
    10_000,
  );
  // A file still being written leaves its Segment without a stated end.
  assertEquals(await ms(m, mkv([elem(DURATION, f64(7000))], true)), 7000);
});

Deno.test("a Matroska without a Duration answers null", async () => {
  const m = await durations();
  assertEquals(await ms(m, mkv([elem(TIMESCALE, uint(1_000_000))])), null);
  assertEquals(await ms(m, mkv([elem(DURATION, f64(0))])), null);
  // Longer than a day is a misparse, and a wrong length is worse than none.
  assertEquals(await ms(m, mkv([elem(DURATION, f64(90_000_000))])), null);
  const header = elem(EBML_HEAD, new Uint8Array(8));
  assertEquals(await ms(m, header), null);
});

Deno.test("an EBML integer keeps an id's marker and strips a size's", async () => {
  const m = await durations();
  const id = m.ebmlInt(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, true);
  assert(id);
  assertEquals([id.value, id.width, id.unknown], [0x1a45dfa3, 4, false]);
  const size = m.ebmlInt(new Uint8Array([0x82]), 0, false);
  assert(size);
  assertEquals([size.value, size.width, size.unknown], [2, 1, false]);
  // All value bits set is "until the parent ends", at any width.
  const openEnded = m.ebmlInt(new Uint8Array([0xff]), 0, false);
  assert(openEnded);
  assertEquals(openEnded.unknown, true);
  const wideOpenEnded = m.ebmlInt(
    new Uint8Array([0x01, 255, 255, 255, 255, 255, 255, 255]),
    0,
    false,
  );
  assert(wideOpenEnded);
  assertEquals(
    wideOpenEnded.unknown,
    true,
  );
  // A first byte of 0 would be a width past eight: not a real file.
  assertEquals(m.ebmlInt(new Uint8Array([0x00, 0x01]), 0, false), null);
  assertEquals(m.ebmlInt(new Uint8Array([0x82]), 1, false), null);
});

Deno.test("the in-memory reader stops at the end of the bytes", async () => {
  const m = await durations();
  const read = m.bytesReader(new Uint8Array([1, 2, 3]));
  assertEquals(await read(0, 2), new Uint8Array([1, 2]));
  assertEquals((await read(2, 16)).length, 1);
  assertEquals((await read(9, 4)).length, 0);
});

// ------------------------------------------------------------------- preview

const SRC = "/home/x/clip.mp4";

/** ff d8 ff … ff d9: what a whole JPEG looks like from the outside. */
function jpeg(n = 32): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], n - 2);
  return b;
}

type Answer = {
  code?: number;
  stderr?: string;
  writes?: Uint8Array;
  missing?: boolean;
};

/**
 * The file a thumbnailer was told to write: `-o <path>` for
 * ffmpegthumbnailer, the last argument for ffmpeg. Read out of argv rather
 * than assumed, because the name is the daemon's to choose -- it is a fresh
 * one per call now, so a test that spelled it out would be testing its own
 * copy of the rule.
 */
function outPath(tool: string, args: string[]): string {
  const i = args.indexOf("-o");
  return tool === "ffmpegthumbnailer" && i >= 0
    ? args[i + 1]
    : args[args.length - 1];
}

/** The thumbnailers on this machine, and a log of how they were called. */
function tools(answers: Record<string, Answer>) {
  const calls: [string, string[]][] = [];
  const run = async (tool: string, args: string[]) => {
    calls.push([tool, args]);
    const a = answers[tool] ?? { missing: true };
    // Deno throws NotFound for the executable itself.
    if (a.missing) throw new Deno.errors.NotFound(tool);
    if (a.writes) await Deno.writeFile(outPath(tool, args), a.writes);
    return { code: a.code ?? 0, stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "enil-thumb-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

Deno.test("the seek point is an absolute time, never a percentage", async () => {
  const m = await previews();
  assertEquals(m.thumbTime(1000), "00:00:01.000");
  assertEquals(m.thumbTime(0), "00:00:00.000");
  assertEquals(m.thumbTime(3_723_400), "01:02:03.400");
  assertEquals(m.thumbTime(-5), "00:00:00.000");
});

Deno.test("argv: one JPEG frame into the file we name", async () => {
  const m = await previews();
  // ffmpegthumbnailer reads a bare `-t 1` as one *percent* of the clip, and
  // takes no fraction of a second, so the time is hh:mm:ss and nothing else.
  assertEquals(m.thumbArgs("ffmpegthumbnailer", SRC, "/o.jpg", 1500), [
    "-i",
    SRC,
    "-o",
    "/o.jpg",
    "-t",
    "00:00:01",
    "-s",
    String(m.THUMB_MAX_PX),
    "-c",
    "jpeg",
  ]);
  const ff = m.thumbArgs("ffmpeg", SRC, "/o.jpg", 1500);
  assertEquals(ff, [
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    // Before -i, so it seeks instead of decoding a second and dropping it.
    "-ss",
    "00:00:01.500",
    "-i",
    SRC,
    "-frames:v",
    "1",
    "-vf",
    `scale=${m.THUMB_MAX_PX}:-2`,
    "-f",
    "mjpeg",
    "/o.jpg",
  ]);
  assert(ff.indexOf("-ss") < ff.indexOf("-i"));
});

Deno.test("the first thumbnailer on PATH is the one that runs", async () => {
  const m = await previews();
  await withDir(async (dir) => {
    const { run, calls } = tools({
      ffmpegthumbnailer: { writes: jpeg() },
      ffmpeg: { writes: jpeg() },
    });
    const got = await m.videoPreviewJpeg(dir, SRC, 1000, run);
    assertEquals(got.jpeg, jpeg());
    assertEquals(calls.map(([t]) => t), ["ffmpegthumbnailer"]);
    // A send, not a download: the frame is uploaded and forgotten.
    assertEquals(await names(dir), []);
  });
});

Deno.test("a missing ffmpegthumbnailer falls through to ffmpeg", async () => {
  const m = await previews();
  await withDir(async (dir) => {
    const { run, calls } = tools({ ffmpeg: { writes: jpeg(64) } });
    const got = await m.videoPreviewJpeg(dir, SRC, 1000, run);
    assertEquals(got.jpeg, jpeg(64));
    assertEquals(calls.map(([t]) => t), ["ffmpegthumbnailer", "ffmpeg"]);
  });
});

Deno.test("neither installed is a send without a preview", async () => {
  const m = await previews();
  await withDir(async (dir) => {
    const { run, calls } = tools({});
    const got = await m.videoPreviewJpeg(dir, SRC, 1000, run);
    // Not an error anywhere: the video still goes, exactly as it did before
    // any of this existed. The journal says which packages would help.
    assertEquals(got.jpeg, undefined);
    for (const tool of m.THUMB_TOOLS) {
      assert(String(got.skipped).includes(tool), got.skipped);
    }
    assertEquals(calls.length, 2);
    assertEquals(await names(dir), []);
  });
});

Deno.test("a thumbnailer that fails is one line in the journal", async () => {
  const m = await previews();
  await withDir(async (dir) => {
    const long = "x".repeat(200);
    const { run } = tools({
      ffmpegthumbnailer: { code: 1, stderr: long },
      ffmpeg: { writes: jpeg() },
    });
    const got = await m.videoPreviewJpeg(dir, SRC, 1000, run);
    // The tool that is installed but broken is the answer -- trying the next
    // one would cost a second timeout for the same file.
    assertEquals(got.jpeg, undefined);
    assert(String(got.skipped).startsWith("ffmpegthumbnailer exit 1:"));
    // Bounded: a tool that dumps a page of ffmpeg banner must not fill it.
    assert(String(got.skipped).length < 120, String(got.skipped).length + "");
  });
});

Deno.test("half a JPEG is never uploaded as the preview", async () => {
  const m = await previews();
  await withDir(async (dir) => {
    const table: [string, Uint8Array | undefined][] = [
      // A run killed by the timeout leaves the frame it had got to.
      ["truncated", jpeg().subarray(0, 20)],
      ["not a JPEG", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])],
      ["empty", new Uint8Array(0)],
      ["nothing at all", undefined],
    ];
    for (const [name, writes] of table) {
      const { run } = tools({ ffmpegthumbnailer: { writes } });
      const got = await m.videoPreviewJpeg(dir, SRC, 1000, run);
      assertEquals(got.jpeg, undefined, name);
      assert(String(got.skipped).includes("ffmpegthumbnailer"), name);
      assertEquals(await names(dir), [], name);
    }
  });
});

Deno.test("a thumbnailer that throws does not throw at the caller", async () => {
  const m = await previews();
  await withDir(async (dir) => {
    const run = () => Promise.reject(new Error("cgroup: permission denied"));
    const got = await m.videoPreviewJpeg(dir, SRC, 1000, run);
    assertEquals(got.jpeg, undefined);
    assert(String(got.skipped).includes("permission denied"), got.skipped);
  });
});

Deno.test("two videos in flight at once get a frame each", async () => {
  const m = await previews();
  await withDir(async (dir) => {
    // Both calls sit inside their thumbnailer before either writes, which is
    // the case `preview-${Date.now()}.jpg` could not survive: the two sends
    // shared the path, the second run wrote over the first one's frame, and
    // whichever call finished first removed the file under the other.
    const paths: string[] = [];
    let started = 0;
    let bothIn: () => void = () => {};
    const inFlight = new Promise<void>((r) => (bothIn = () => r()));
    const run = async (tool: string, args: string[]) => {
      const nth = ++started;
      const out = outPath(tool, args);
      paths.push(out);
      if (nth === 2) bothIn();
      await inFlight;
      // A different length per call, so a frame that came from the other
      // call cannot read as a pass.
      await Deno.writeFile(out, jpeg(32 * nth));
      return { code: 0, stderr: "" };
    };
    const got = await Promise.all([
      m.videoPreviewJpeg(dir, SRC, 1000, run),
      m.videoPreviewJpeg(dir, `${SRC}.2`, 2000, run),
    ]);
    assertEquals(paths.length, 2);
    assert(paths[0] !== paths[1], paths.join(" "));
    // Each call uploads its own frame, whole -- not the other's, and not the
    // half a JPEG a truncating overwrite leaves.
    assertEquals(
      got.map((g: { jpeg?: Uint8Array }) => g.jpeg?.length).sort((a, b) =>
        (a ?? 0) - (b ?? 0)
      ),
      [32, 64],
    );
    // And a name of its own is still a name that gets removed.
    assertEquals(await names(dir), []);
  });
});

// ------------------------------------------------------------ upload options

Deno.test("the length reaches the upload, and only when there is one", async () => {
  const m = await args();
  // A video whose header gave a length: the fork's obs turns durationMs into
  // the message's DURATION, so dropping it here is a 0:00 bubble again.
  const video = m.uploadExtras(new Uint8Array([0xff, 0xd8]), 15000.4);
  assertEquals(video.durationMs, 15000.4);
  assert(video.preview instanceof Blob);

  // An image: no frame to attach and no length to print. Absent, not
  // undefined -- the option has to be missing from the object entirely.
  const image = m.uploadExtras(null, null);
  assertEquals(Object.keys(image), []);

  // A container we could not read is a video without a length, not a send
  // that carries a null into linejs's Number.isFinite check.
  const unreadable = m.uploadExtras(new Uint8Array([0xff, 0xd8]), null);
  assertEquals(Object.keys(unreadable), ["preview"]);
});

Deno.test("media correlation survives beside video extras", async () => {
  const m = await args();
  const payload = m.uploadExtras(
    new Uint8Array([0xff, 0xd8]),
    15000.4,
    "panel-request-12",
  );
  assert(payload.preview instanceof Blob);
  assertEquals(payload.durationMs, 15000.4);
  assertEquals(payload.contentMetadata, {
    ENIL_REQUEST_ID: "panel-request-12",
  });
  assertEquals(m.uploadExtras(null, null, "panel-request-13"), {
    contentMetadata: { ENIL_REQUEST_ID: "panel-request-13" },
  });
});
