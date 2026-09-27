/**
 * What a send puts on the wire for a file: the ObjType its bytes earn it, and
 * the clipboard read behind `probeClipboardImage`.
 *
 *   deno test -A sendmedia_test.ts
 *
 * Nothing here spawns wl-paste or uploads anything -- the process runner is
 * an argument to the module, so tests can drive a clipboard
 * that holds text, an image nobody can encode, or 21 MB of it. The temp file
 * goes to a throwaway directory, never MEDIA_DIR.
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock, loadBlocks } from "./slice_test.ts";
import { createClipboardStages } from "./clipboard.ts";

// tagAt moved beside the container parsers (modules/video.ts); the sliced
// mediakind block imports the real one rather than stubbing a copy.
const VIDEO = new URL("./modules/video.ts", import.meta.url).href;

const KIND_PRELUDE = `
import { tagAt } from "${VIDEO}";
export { MEDIA_HEAD_BYTES, mediaKindOf };
`;

type MediaKind = "image" | "gif" | "video" | "file";
interface KindModule {
  MEDIA_HEAD_BYTES: number;
  mediaKindOf(path: string, head: Uint8Array): MediaKind;
}
interface CapModule extends KindModule {
  SEND_MAX_BYTES: Record<MediaKind, number>;
  capText(bytes: number): string;
  readHead(path: string, length: number): Promise<Uint8Array>;
  sizeRefusalText(kind: MediaKind, size: number): string | null;
}
let K: KindModule | undefined;
async function kinds(): Promise<KindModule> {
  if (!K) K = await loadBlock<KindModule>("mediakind", KIND_PRELUDE);
  return K;
}

/** The extracted lifecycle, wired the way the daemon wires it. */
type ClipboardModule = ReturnType<typeof createClipboardStages>;
let C: ClipboardModule | undefined;
function clip(): ClipboardModule {
  if (!C) {
    C = createClipboardStages({
      mediaDir: "/cache/media",
      // Never fired by these tests (every failing sweep passes its own
      // report); the daemon passes its redacting errorLine here.
      errorLine: (error: unknown) => String(error),
    });
  }
  return C;
}

/** A head: numbers are bytes, strings are their ASCII. */
function bytes(...parts: (number | string)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "number") out.push(p);
    else for (const ch of p) out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
}

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, "JFIF");
const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const GIF = bytes("GIF89a", 0x10, 0, 0x10, 0);
const WEBP = bytes("RIFF", 0x20, 0, 0, 0, "WEBPVP8 ");
const WAV = bytes("RIFF", 0x20, 0, 0, 0, "WAVEfmt ");
const AVI = bytes("RIFF", 0x20, 0, 0, 0, "AVI LIST");
const MKV = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0);
const PDF = bytes("%PDF-1.7\n");
const NOTHING = new Uint8Array(16);

/** An ISO base-media head with `brand` in the ftyp box. */
function ftyp(brand: string): Uint8Array {
  return bytes(0, 0, 0, 0x18, "ftyp", brand, 0, 0, 0x02, 0);
}

Deno.test("the kind a picked file arrives as", async () => {
  const m = await kinds();
  const table: [string, Uint8Array, string][] = [
    ["photo.jpg", JPEG, "image"],
    ["photo.jpeg", JPEG, "image"],
    ["shot.png", PNG, "image"],
    ["party.gif", GIF, "gif"],
    ["sticker.webp", WEBP, "image"],
    ["clip.mp4", ftyp("isom"), "video"],
    ["clip.mov", ftyp("qt  "), "video"],
    ["clip.mkv", MKV, "video"],
    ["invoice.pdf", PDF, "file"],
    ["notes.txt", bytes("hello\n"), "file"],
    ["README", new Uint8Array(0), "file"],
  ];
  for (const [name, head, want] of table) {
    assertEquals(m.mediaKindOf(name, head), want, name);
  }
});

Deno.test("the bytes beat a wrong extension", async () => {
  const m = await kinds();
  // The one that matters: a phone that names an mp4 `.jpg` would otherwise
  // send a video as an IMAGE, and LINE renders from the contentType alone.
  assertEquals(m.mediaKindOf("IMG_0001.jpg", ftyp("mp42")), "video");
  assertEquals(m.mediaKindOf("clip.mp4", PNG), "image");
  // A still sent as "gif" is flagged animated in MEDIA_CONTENT_INFO, and an
  // animation sent as "image" arrives as one frame; both are the same slip.
  assertEquals(m.mediaKindOf("still.gif", PNG), "image");
  assertEquals(m.mediaKindOf("anim.png", GIF), "gif");
  assertEquals(m.mediaKindOf("scan.pdf", JPEG), "image");
});

Deno.test("a head nothing recognises falls back to the name", async () => {
  const m = await kinds();
  assertEquals(m.mediaKindOf("shot.png", NOTHING), "image");
  assertEquals(m.mediaKindOf("clip.mp4", NOTHING), "video");
  assertEquals(m.mediaKindOf("live.heic", NOTHING), "image");
  assertEquals(m.mediaKindOf("invoice.pdf", NOTHING), "file");
  // Only the last dot, and never a directory's.
  assertEquals(m.mediaKindOf("/home/x.mp4/notes", NOTHING), "file");
  assertEquals(m.mediaKindOf("/tmp/a.b/shot.PNG", NOTHING), "image");
  assertEquals(m.mediaKindOf(".gitignore", NOTHING), "file");
});

Deno.test("an ftyp brand tells a phone photo from a phone video", async () => {
  const m = await kinds();
  for (const brand of ["heic", "heix", "mif1", "avif"]) {
    assertEquals(m.mediaKindOf("IMG.bin", ftyp(brand)), "image", brand);
  }
  for (const brand of ["isom", "mp42", "avc1", "qt  ", "3gp4"]) {
    assertEquals(m.mediaKindOf("VID.bin", ftyp(brand)), "video", brand);
  }
});

Deno.test("sound is a file, never a 0:00 voice note", async () => {
  const m = await kinds();
  // Same container as an mp4, so without the brand check an .m4a would go up
  // as a VIDEO: a bubble with a play button and nothing to show.
  assertEquals(m.mediaKindOf("voice.m4a", ftyp("M4A ")), "file");
  assertEquals(m.mediaKindOf("song.mp3", bytes("ID3", 3, 0)), "file");
  assertEquals(m.mediaKindOf("song.ogg", bytes("OggS", 0)), "file");
  assertEquals(m.mediaKindOf("clip.wav", WAV), "file");
});

Deno.test("a RIFF is only media when it says which kind", async () => {
  const m = await kinds();
  assertEquals(m.mediaKindOf("a.bin", WEBP), "image");
  assertEquals(m.mediaKindOf("a.bin", AVI), "video");
  assertEquals(m.mediaKindOf("a.bin", WAV), "file");
});

Deno.test("a head shorter than a signature cannot throw", async () => {
  const m = await kinds();
  for (const n of [0, 1, 3, 7, 11]) {
    assertEquals(
      m.mediaKindOf("x.bin", JPEG.slice(0, n)),
      n >= 3 ? "image" : "file",
    );
    assertEquals(m.mediaKindOf("x.bin", ftyp("isom").slice(0, n)), "file");
  }
  const m2 = await kinds();
  // The longest signature reads up to byte 12 (the ftyp brand).
  assert(m2.MEDIA_HEAD_BYTES >= 12, String(m2.MEDIA_HEAD_BYTES));
});

// ----------------------------------------------------------------- size cap

let S: CapModule | undefined;
async function caps(): Promise<CapModule> {
  // On top of mediakind: the cap table is keyed by the ObjType that block
  // decides, and stubbing MediaKind here would only test the stub.
  if (!S) {
    S = await loadBlocks<CapModule>(
      ["mediakind", "sendcap"],
      `
import { tagAt } from "${VIDEO}";
export {
  MEDIA_HEAD_BYTES,
  SEND_MAX_BYTES,
  capText,
  mediaKindOf,
  readHead,
  sizeRefusalText,
};
`,
    );
  }
  return S;
}

Deno.test("what fits is not refused, up to and including the cap", async () => {
  const m = await caps();
  for (const kind of ["image", "gif", "video", "file"] as MediaKind[]) {
    const cap = m.SEND_MAX_BYTES[kind];
    assertEquals(m.sizeRefusalText(kind, 0), null);
    assertEquals(m.sizeRefusalText(kind, cap), null, `${kind} at the cap`);
    assert(m.sizeRefusalText(kind, cap + 1), `${kind} one byte over`);
  }
});

Deno.test("a picture and a recording are not the same limit", async () => {
  const m = await caps();
  // An IMAGE is read whole, encrypted into a second copy and then uploaded
  // twice (obs/mod.ts:389); a gif is an IMAGE too, and pays the same. Video
  // and file are the one-copy path.
  assertEquals(m.SEND_MAX_BYTES.image, 20 * 1024 * 1024);
  assertEquals(m.SEND_MAX_BYTES.gif, m.SEND_MAX_BYTES.image);
  assertEquals(m.SEND_MAX_BYTES.video, 1024 * 1024 * 1024);
  assertEquals(m.SEND_MAX_BYTES.file, m.SEND_MAX_BYTES.video);
});

Deno.test("the refusal names the limit and the thing that hit it", async () => {
  const m = await caps();
  const big = 2 * 1024 * 1024 * 1024;
  // The user picked the file and is the only one who can pick a smaller one,
  // so "傳送失敗" would leave them retrying the same recording.
  assertEquals(m.sizeRefusalText("image", big), "圖片太大（超過 20 MB）");
  assertEquals(m.sizeRefusalText("gif", big), "圖片太大（超過 20 MB）");
  assertEquals(m.sizeRefusalText("video", big), "影片太大（超過 1 GB）");
  assertEquals(m.sizeRefusalText("file", big), "檔案太大（超過 1 GB）");
  // Same units as the clipboard's own refusal, which the panel already shows.
  assertEquals(m.capText(20 * 1024 * 1024), "20 MB");
  assertEquals(m.capText(1024 * 1024 * 1024), "1 GB");
});

Deno.test("the head is read without reading the file", async () => {
  const m = await caps();
  await withDir(async (dir) => {
    const path = `${dir}/clip.mp4`;
    // Sparse: 1 GiB that costs nothing to write, and would cost the daemon a
    // gigabyte of memory to read. That is the whole point of the head read.
    const f = await Deno.open(path, { create: true, write: true });
    await f.write(ftyp("isom"));
    await f.truncate(1024 * 1024 * 1024);
    f.close();
    const head = await m.readHead(path, m.MEDIA_HEAD_BYTES);
    assertEquals(head.length, m.MEDIA_HEAD_BYTES);
    assertEquals(m.mediaKindOf("clip.mp4", head), "video");
    assertEquals((await Deno.stat(path)).size, 1024 * 1024 * 1024);
  });
});

Deno.test("a file shorter than the head is what there is of it", async () => {
  const m = await caps();
  await withDir(async (dir) => {
    // Not padded to 16: a short read must not leave magicKind() deciding on
    // bytes that were never in the file.
    await Deno.writeFile(`${dir}/tiny.bin`, GIF.slice(0, 6));
    assertEquals(await m.readHead(`${dir}/tiny.bin`, 16), GIF.slice(0, 6));
    await Deno.writeFile(`${dir}/empty.bin`, new Uint8Array(0));
    assertEquals(
      await m.readHead(`${dir}/empty.bin`, 16),
      new Uint8Array(0),
    );
  });
});

// ------------------------------------------------------------------ clipboard

/** wl-paste's two answers, and a log of the argv it was called with. */
function runner(
  answers: Record<
    string,
    { code?: number; stdout?: Uint8Array; stderr?: string }
  >,
) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const key = args[0] === "--list-types" ? "list" : args[2];
    const a = answers[key] ?? { code: 1, stderr: "No selection" };
    return Promise.resolve({
      code: a.code ?? 0,
      stdout: a.stdout ?? new Uint8Array(0),
      stderr: a.stderr ?? "",
    });
  };
  return { run, calls };
}

const text = (s: string) => new TextEncoder().encode(s);
const OFFERS_PNG = text("image/png\nimage/png\ntext/plain\nSTRING\n");

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "enil-clip-" });
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

Deno.test("argv: the offered types, then one type's bytes", async () => {
  const m = await clip();
  assertEquals(m.clipboardArgs(), ["--list-types"]);
  // --no-newline: without it wl-paste glues a \n onto the PNG it hands back.
  assertEquals(m.clipboardArgs("image/png"), [
    "--no-newline",
    "--type",
    "image/png",
  ]);
});

Deno.test("what wl-paste prints is not yet a list of mime types", async () => {
  const m = await clip();
  // Real output: repeats, X11 atoms, and a charset parameter.
  assertEquals(
    m.clipboardTypes("text/plain\ntext/plain;charset=utf-8\nTEXT\nSTRING\n\n"),
    ["text/plain"],
  );
  assertEquals(m.clipboardTypes(" Image/PNG \nimage/png\n"), ["image/png"]);
});

Deno.test("png wins when a source offers more than one", async () => {
  const m = await clip();
  assertEquals(m.pickClipboardType(["image/jpeg", "image/png"]), "image/png");
  assertEquals(m.pickClipboardType(["image/webp", "image/jpeg"]), "image/jpeg");
  assertEquals(m.pickClipboardType(["text/plain", "image/tiff"]), null);
});

Deno.test("text on the clipboard is refused, and never read", async () => {
  const m = await clip();
  const { run, calls } = runner({
    list: { stdout: text("text/plain\nSTRING\n") },
  });
  await withDir(async (dir) => {
    const res = await m.clipboardStage(dir, 1, run);
    assertEquals(res, { ok: false, error: "剪貼簿裡沒有圖片" });
    // Only the type list: a clipboard with no image is answered without ever
    // reading its contents.
    assertEquals(calls, [["--list-types"]]);
    assertEquals(await names(dir), []);
  });
});

Deno.test("an image we cannot send names its format", async () => {
  const m = await clip();
  const { run } = runner({ list: { stdout: text("image/tiff\nTEXT\n") } });
  await withDir(async (dir) => {
    const res = await m.clipboardStage(dir, 1, run);
    // "no image" here would have the user copying it again and again.
    assertEquals(res, {
      ok: false,
      error: "剪貼簿的圖片格式不支援: image/tiff",
    });
  });
});

Deno.test("a missing wl-paste says which package to install", async () => {
  const m = await clip();
  const run = () => Promise.reject(new Deno.errors.NotFound("wl-paste"));
  await withDir(async (dir) => {
    const res = await m.clipboardStage(dir, 1, run);
    assertEquals(res.ok, false);
    assert(String(res.error).includes("wl-clipboard"), String(res.error));
  });
});

Deno.test("no display does not read as an empty clipboard", async () => {
  const m = await clip();
  // The daemon is a systemd user unit: started before the compositor put
  // WAYLAND_DISPLAY into the user environment, it can never reach a display,
  // and telling the user to copy something again would not fix it.
  const { run } = runner({
    list: { code: 1, stderr: "failed to connect to a Wayland server" },
  });
  await withDir(async (dir) => {
    const res = await m.clipboardStage(dir, 1, run);
    assertEquals(res.ok, false);
    assert(String(res.error).includes("Wayland"), String(res.error));
    assert(String(res.error).includes("restart enil"), String(res.error));
  });
});

Deno.test("another wl-paste failure keeps its stderr out of the panel", async () => {
  const m = await clip();
  const { run } = runner({
    list: { code: 143, stderr: "killed by SIGTERM after 5000ms" },
  });
  await withDir(async (dir) => {
    const res = await m.clipboardStage(dir, 1, run);
    assertEquals(res.error, "讀不到剪貼簿");
    // The journal gets the reason; the bubble gets the sentence.
    assert(String(res.logText).includes("SIGTERM"), String(res.logText));
  });
});

Deno.test("an image that reads back empty is refused", async () => {
  const m = await clip();
  const { run } = runner({
    list: { stdout: OFFERS_PNG },
    "image/png": { stdout: new Uint8Array(0) },
  });
  await withDir(async (dir) => {
    const res = await m.clipboardStage(dir, 1, run);
    assertEquals(res, { ok: false, error: "剪貼簿的圖片讀不到" });
    assertEquals(await names(dir), []);
  });
});

Deno.test("over the cap is refused before anything is written", async () => {
  const m = await clip();
  const big = new Uint8Array(m.CLIPBOARD_MAX_BYTES + 1);
  const { run } = runner({
    list: { stdout: OFFERS_PNG },
    "image/png": { stdout: big },
  });
  await withDir(async (dir) => {
    const res = await m.clipboardStage(dir, 1, run);
    assertEquals(res.ok, false);
    assert(String(res.error).includes("20 MB"), String(res.error));
    assertEquals(await names(dir), []);
  });
});

Deno.test("the image is staged once under an opaque, type-correct name", async () => {
  const m = await clip();
  const png = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
  const { run, calls } = runner({
    list: { stdout: text("image/jpeg\nimage/png\ntext/plain\n") },
    "image/png": { stdout: png },
  });
  await withDir(async (dir) => {
    const res = await m.clipboardStage(
      dir,
      1_700_000_000_000,
      run,
    );
    assertEquals(res, {
      ok: true,
      data: { stage: "clipboard-1700000000000.png" },
    });
    assertEquals(calls[1], ["--no-newline", "--type", "image/png"]);
    // Under the directory it was given -- MEDIA_DIR in the daemon, so a copy
    // left behind by a crash is swept with the rest of the cache.
    assertEquals(
      await Deno.readFile(`${dir}/clipboard-1700000000000.png`),
      png,
    );
    assertEquals(await names(dir), ["clipboard-1700000000000.png"]);
  });
});

Deno.test("a partial clipboard stage is removed when writing fails", async () => {
  const m = await clip();
  const png = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
  const { run } = runner({
    list: { stdout: OFFERS_PNG },
    "image/png": { stdout: png },
  });
  await withDir(async (dir) => {
    const failure = new Error("disk full");
    const write = async (path: string, data: Uint8Array) => {
      await Deno.writeFile(path, data.subarray(0, 4));
      throw failure;
    };
    let thrown: unknown;
    try {
      await m.clipboardStage(dir, 7, run, write);
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown, failure);
    assertEquals(await names(dir), []);
  });
});

Deno.test("a stage token can resolve only a daemon-created clipboard basename", async () => {
  const m = await clip();
  assertEquals(
    m.clipboardStagePath("/cache/media", "clipboard-a1-b2.webp"),
    "/cache/media/clipboard-a1-b2.webp",
  );
  for (
    const stage of [
      "../clipboard-a.png",
      "/tmp/clipboard-a.png",
      "clipboard-a.svg",
      "picked-file.png",
      "clipboard-a.png/other",
    ]
  ) assertEquals(m.clipboardStagePath("/cache/media", stage), null, stage);
});

Deno.test("discard removes only a daemon-created clipboard stage", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/clipboard-safe.png`, "stage");
    await Deno.writeTextFile(`${dir}/keep.txt`, "keep");
    await m.discardClipboardStage(dir, "../keep.txt");
    await m.discardClipboardStage(dir, "clipboard-safe.png");
    await m.discardClipboardStage(dir, "clipboard-safe.png");
    assertEquals(await names(dir), ["keep.txt"]);
  });
});

Deno.test("discard ignores absence but propagates other removal failures", async () => {
  const m = await clip();
  await m.discardClipboardStage(
    "/cache/media",
    "clipboard-gone.png",
    () => Promise.reject(new Deno.errors.NotFound("gone")),
  );
  const failure = new Error("read-only filesystem");
  let thrown: unknown;
  try {
    await m.discardClipboardStage(
      "/cache/media",
      "clipboard-stuck.png",
      () => Promise.reject(failure),
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown, failure);
});

Deno.test("an unclaimed clipboard stage expires after its short lease", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/clipboard-lease.png`, "stage");
    let cleanup: (() => void) | undefined;
    let delay = 0;
    m.expireClipboardStage(dir, "clipboard-lease.png", 600_000, (fn, ms) => {
      cleanup = fn;
      delay = ms;
    });
    assertEquals(delay, 600_000);
    assertEquals(await names(dir), ["clipboard-lease.png"]);
    cleanup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(await names(dir), []);
  });
});

Deno.test("clipboard expiry reports a failed cleanup", async () => {
  const m = await clip();
  let cleanup: (() => void) | undefined;
  const failure = new Error("cleanup failed");
  const reported: unknown[] = [];
  m.expireClipboardStage(
    "/cache/media",
    "clipboard-stuck.png",
    1,
    (fn) => cleanup = fn,
    () => Promise.reject(failure),
    (error) => reported.push(error),
  );
  cleanup?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(reported, [failure]);
});

Deno.test("restart restores remaining clipboard leases and removes expired stages", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    const now = 1_800_000_000_000;
    const fresh = "clipboard-fresh.png";
    const expired = "clipboard-expired.png";
    await Deno.writeTextFile(`${dir}/${fresh}`, "fresh");
    await Deno.writeTextFile(`${dir}/${expired}`, "expired");
    await Deno.utime(
      `${dir}/${fresh}`,
      new Date(now - 125_000),
      new Date(now - 125_000),
    );
    await Deno.utime(
      `${dir}/${expired}`,
      new Date(now - 601_000),
      new Date(now - 601_000),
    );
    let cleanup: (() => void) | undefined;
    let delay = 0;
    await m.recoverClipboardStages(dir, now, (fn, ms) => {
      cleanup = fn;
      delay = ms;
    });
    assertEquals(delay, 475_000);
    assertEquals(await names(dir), [fresh]);
    cleanup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(await names(dir), []);
  });
});

Deno.test("an expired persisted stage is refused before upload", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    const stage = "clipboard-expired.png";
    const path = `${dir}/${stage}`;
    await Deno.writeTextFile(path, "expired");
    const old = new Date(Date.now() - 601_000);
    await Deno.utime(path, old, old);
    let uploads = 0;
    assertEquals(
      await m.consumeClipboardStage(dir, stage, () => {
        uploads++;
        return Promise.resolve({ ok: true });
      }),
      { ok: false, error: "剪貼簿暫存已失效" },
    );
    assertEquals(uploads, 0);
    assertEquals(await names(dir), []);
  });
});

Deno.test("clipboard stages are bound to one session and destination", async () => {
  const m = await clip();
  const ownerA = { id: "A" };
  const ownerB = { id: "B" };
  for (
    const [owner, generation, chat] of [
      [ownerB, 7, "C1"],
      [ownerA, 8, "C1"],
      [ownerA, 7, "C2"],
    ] as const
  ) {
    const bindings = new Map([
      ["clipboard-bound.png", { owner: ownerA, generation: 7, chat: "C1" }],
    ]);
    assertEquals(
      m.claimClipboardStageBinding(
        bindings,
        "clipboard-bound.png",
        owner,
        generation,
        chat,
      ),
      "mismatch",
    );
    assertEquals(bindings.size, 0);
  }
  const bindings = new Map([
    ["clipboard-bound.png", { owner: ownerA, generation: 7, chat: "C1" }],
  ]);
  assertEquals(
    m.claimClipboardStageBinding(
      bindings,
      "clipboard-bound.png",
      ownerA,
      7,
      "C1",
    ),
    "claimed",
  );
  assertEquals(bindings.size, 1);
  assertEquals(
    m.claimClipboardStageBinding(
      bindings,
      "clipboard-bound.png",
      ownerA,
      7,
      "C1",
    ),
    "busy",
  );
  assertEquals(bindings.size, 1);
  bindings.delete("clipboard-bound.png");
  assertEquals(
    m.claimClipboardStageBinding(
      bindings,
      "clipboard-bound.png",
      ownerA,
      7,
      "C1",
    ),
    "missing",
  );
});

Deno.test("recovery spares a live send's claim and sweeps crash-left ones", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    const now = Date.now();
    const fresh = `${dir}/.clipboard-claim-live-send.png`;
    const stale = `${dir}/.clipboard-claim-crash-left.png`;
    await Deno.writeTextFile(fresh, "claimed");
    await Deno.writeTextFile(stale, "orphan");
    await Deno.utime(stale, new Date(now - 601_000), new Date(now - 601_000));
    const cleanups: Array<[number, () => void]> = [];
    await m.recoverClipboardStages(dir, now, (fn, ms) => {
      cleanups.push([ms, fn]);
    });
    // Both claims defer by one full grace: the observed mtime is
    // indeterminate until any in-flight claim stamp has certainly landed,
    // even when it already reads past the grace. The re-stat inside each
    // callback then sweeps the crash-left claim and spares the live one,
    // whose stamp says it was claimed moments ago.
    assertEquals(cleanups.length, 2);
    for (const [delay] of cleanups) assertEquals(delay, 600_000);
    for (const [, cleanup] of cleanups) cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(await names(dir), [".clipboard-claim-live-send.png"]);
  });
});

Deno.test("a claim with an unknown mtime is left alone", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/.clipboard-claim-mtimeless.png`, "?");
    const cleanups: Array<() => void> = [];
    await m.recoverClipboardStages(
      dir,
      Date.now(),
      (fn) => cleanups.push(fn),
      () => Promise.resolve({ isFile: true, mtime: null } as Deno.FileInfo),
    );
    assertEquals(await names(dir), [".clipboard-claim-mtimeless.png"]);
    assertEquals(cleanups.length, 0);
  });
});

Deno.test("a claim-stat failure is reported without deleting the claim", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/.clipboard-claim-live.png`, "live");
    let caught: unknown;
    try {
      await m.recoverClipboardStages(
        dir,
        Date.now(),
        () => {},
        () => Promise.reject(new Deno.errors.PermissionDenied("stat denied")),
      );
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof Deno.errors.PermissionDenied);
    assertEquals(await names(dir), [".clipboard-claim-live.png"]);
  });
});

Deno.test("a claim staged from an expiring stage survives concurrent recovery", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    const stage = "clipboard-late.png";
    await Deno.writeTextFile(`${dir}/${stage}`, "late");
    // 9.5 minutes old: claimable for another 30s of lease, but a minute
    // into the send the stage's own mtime reads past the grace window.
    const stale = new Date(Date.now() - 570_000);
    await Deno.utime(`${dir}/${stage}`, stale, stale);
    let survived = false;
    assertEquals(
      await m.consumeClipboardStage(dir, stage, async (path) => {
        // A second daemon's recovery runs a minute into this send: without
        // the claim-time stamp the file's mtime is the stage's, 10.5
        // minutes old, and the sweep would unlink the live send's claim.
        await m.recoverClipboardStages(dir, Date.now() + 60_000, () => {});
        survived = await Deno.stat(path).then(
          () => true,
          () => false,
        );
        return { ok: true };
      }),
      { ok: true },
    );
    assert(survived, "concurrent recovery deleted the live claim");
    assertEquals(await names(dir), []);
  });
});

Deno.test("clipboard stages are one-shot after success and refusal", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    for (
      const [stage, result] of [
        ["clipboard-success.png", { ok: true }],
        ["clipboard-refusal.png", { ok: false, error: "refused" }],
      ] as const
    ) {
      await Deno.writeTextFile(`${dir}/${stage}`, "stage");
      assertEquals(
        await m.consumeClipboardStage(dir, stage, (path, filename) => {
          assert(path.startsWith(`${dir}/.clipboard-claim-`));
          assert(path.endsWith(stage.slice(stage.lastIndexOf("."))));
          assertEquals(filename, stage);
          return Promise.resolve(result);
        }),
        result,
      );
      assertEquals(await names(dir), []);
    }
    assertEquals(
      await m.consumeClipboardStage(
        dir,
        "clipboard-missing.png",
        () => Promise.resolve({ ok: true }),
      ),
      { ok: false, error: "剪貼簿暫存已失效" },
    );
  });
});

Deno.test("a failed claim stamp fails the send and removes the claim", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    const stage = "clipboard-unstamped.png";
    await Deno.writeTextFile(`${dir}/${stage}`, "stage");
    let sends = 0;
    let thrown: unknown;
    try {
      await m.consumeClipboardStage(
        dir,
        stage,
        () => {
          sends++;
          return Promise.resolve({ ok: true });
        },
        undefined,
        () => Promise.reject(new Deno.errors.PermissionDenied("read-only")),
      );
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Deno.errors.PermissionDenied);
    assertEquals(sends, 0);
    assertEquals(await names(dir), []);
  });
});

Deno.test("clipboard stage claims hide only a concurrent NotFound", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    const stage = "clipboard-claim-error.png";
    await Deno.writeTextFile(`${dir}/${stage}`, "stage");
    const failure = new Deno.errors.PermissionDenied("read-only filesystem");
    let thrown: unknown;
    try {
      await m.consumeClipboardStage(
        dir,
        stage,
        () => Promise.resolve({ ok: true }),
        () => Promise.reject(failure),
      );
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown, failure);
    assertEquals(await names(dir), [stage]);
    assertEquals(
      await m.consumeClipboardStage(
        dir,
        stage,
        () => Promise.resolve({ ok: true }),
        () => Promise.reject(new Deno.errors.NotFound("lost race")),
      ),
      { ok: false, error: "剪貼簿暫存已失效" },
    );
  });
});

Deno.test("the legacy clipboard command probes and consumes in one request", async () => {
  const m = await clip();
  const png = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
  const { run, calls } = runner({
    list: { stdout: OFFERS_PNG },
    "image/png": { stdout: png },
  });
  await withDir(async (dir) => {
    let uploaded = "";
    const result = await m.sendClipboardImageRequest(
      dir,
      "",
      "legacy",
      run,
      async (path, filename) => {
        uploaded = filename;
        assertEquals(await Deno.readFile(path), png);
        return { ok: true };
      },
    );
    assertEquals(result, { ok: true });
    assertEquals(uploaded, "clipboard-legacy.png");
    assertEquals(calls.length, 2);
    assertEquals(await names(dir), []);
  });
});

Deno.test("a legacy clipboard claim failure removes its self-created stage", async () => {
  const m = await clip();
  const png = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
  const { run } = runner({
    list: { stdout: OFFERS_PNG },
    "image/png": { stdout: png },
  });
  await withDir(async (dir) => {
    const failure = new Deno.errors.PermissionDenied("claim denied");
    let uploads = 0;
    let thrown: unknown;
    try {
      await m.sendClipboardImageRequest(
        dir,
        "",
        "legacy-failure",
        run,
        () => {
          uploads++;
          return Promise.resolve({ ok: true });
        },
        () => Promise.reject(failure),
      );
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown, failure);
    assertEquals(uploads, 0);
    assertEquals(await names(dir), []);
  });
});

Deno.test("concurrent clipboard consumers admit exactly one upload", async () => {
  const m = await clip();
  await withDir(async (dir) => {
    const stage = "clipboard-race.png";
    await Deno.writeTextFile(`${dir}/${stage}`, "stage");
    let uploads = 0;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => markStarted = resolve);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => release = resolve);
    const first = m.consumeClipboardStage(dir, stage, async (path) => {
      uploads++;
      assert(path.endsWith(".png"));
      markStarted();
      await held;
      return { ok: true };
    });
    await started;
    const second = await m.consumeClipboardStage(
      dir,
      stage,
      () => {
        uploads++;
        return Promise.resolve({ ok: true });
      },
    );
    assertEquals(second, { ok: false, error: "剪貼簿暫存已失效" });
    assertEquals(uploads, 1);
    release?.();
    assertEquals(await first, { ok: true });
    assertEquals(await names(dir), []);
  });
});
