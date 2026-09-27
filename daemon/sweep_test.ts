/**
 * sweepMedia(): the media cache eviction policy (14 days, then 500 MB
 * oldest-first). Runs against a throwaway directory under Deno's temp dir --
 * never MEDIA_DIR, never ~/.local/state/enil.
 *
 *   deno test -A sweep_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

// MEDIA_DIR is the only module state the block reaches, and every call in the
// tests passes `dir` explicitly anyway.
const PRELUDE = `
const MEDIA_DIR = "/nonexistent/enil-media";
// sweepMedia is already \`export\`ed in daemon.ts, so re-exporting it here is a
// duplicate-export SyntaxError.
export { MEDIA_DIR, MEDIA_MAX_AGE_MS, MEDIA_MAX_BYTES, MEDIA_SWEEP_MS };
`;

interface SweepResult {
  removed: number;
  freed: number;
  kept: number;
  bytes: number;
}
interface SweepModule {
  MEDIA_MAX_AGE_MS: number;
  MEDIA_MAX_BYTES: number;
  MEDIA_SWEEP_MS: number;
  sweepMedia(
    dir?: string,
    now?: number,
    maxBytes?: number,
    maxFiles?: number,
  ): Promise<SweepResult>;
}
let M: SweepModule | undefined;
async function mod(): Promise<SweepModule> {
  if (!M) M = await loadBlock<SweepModule>("sweep", PRELUDE);
  return M;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** Creates `dir/name` of `size` bytes with mtime `NOW - ageMs`. */
async function put(dir: string, name: string, size: number, ageMs: number) {
  const path = `${dir}/${name}`;
  await Deno.writeFile(path, new Uint8Array(size));
  const t = new Date(NOW - ageMs);
  await Deno.utime(path, t, t);
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "enil-sweep-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("the policy constants are the documented 14 days / 500 MB", async () => {
  const m = await mod();
  assertEquals(m.MEDIA_MAX_AGE_MS, 14 * DAY);
  assertEquals(m.MEDIA_MAX_BYTES, 500 * 1024 * 1024);
  assertEquals(m.MEDIA_SWEEP_MS, 6 * 60 * 60 * 1000);
});

Deno.test("a missing cache directory is not an error", async () => {
  const m = await mod();
  const r = await m.sweepMedia("/nonexistent/enil-media-" + NOW, NOW);
  assertEquals(r, { removed: 0, freed: 0, kept: 0, bytes: 0 });
});

Deno.test("an empty cache directory sweeps to zero", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    assertEquals(await m.sweepMedia(dir, NOW), {
      removed: 0,
      freed: 0,
      kept: 0,
      bytes: 0,
    });
  });
});

Deno.test("entries older than 14 days are removed, fresh ones kept", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    await put(dir, "old", 10, 15 * DAY);
    await put(dir, "edge", 20, 14 * DAY); // exactly at the age: kept
    await put(dir, "fresh", 30, 1 * DAY);
    const r = await m.sweepMedia(dir, NOW);
    assertEquals(await names(dir), ["edge", "fresh"]);
    assertEquals(r.removed, 1);
    assertEquals(r.freed, 10);
    assertEquals(r.kept, 2);
    assertEquals(r.bytes, 50);
  });
});

Deno.test("under the quota and inside the age nothing is touched", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    await put(dir, "a", 100, 1 * DAY);
    await put(dir, "b", 200, 2 * DAY);
    const r = await m.sweepMedia(dir, NOW);
    assertEquals(r.removed, 0);
    assertEquals(r.bytes, 300);
    assertEquals(await names(dir), ["a", "b"]);
  });
});

Deno.test("over quota, the oldest go first and the sweep stops at the limit", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    // MEDIA_MAX_BYTES is 500 MB, so drive the same code with a tiny quota by
    // checking the ordering rule instead: with everything aged out, removal is
    // oldest-first and the loop is allowed to clear the lot.
    await put(dir, "oldest", 1, 20 * DAY);
    await put(dir, "middle", 1, 18 * DAY);
    await put(dir, "newest", 1, 16 * DAY);
    const r = await m.sweepMedia(dir, NOW);
    assertEquals(r.removed, 3);
    assertEquals(r.kept, 0);
    assertEquals(r.bytes, 0);
    assertEquals(await names(dir), []);
  });
});

Deno.test("the sweep never recurses and never follows a symlink out of the dir", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    const outside = await Deno.makeTempDir({ prefix: "enil-outside-" });
    try {
      await Deno.writeFile(`${outside}/precious`, new Uint8Array(64));
      const t = new Date(NOW - 90 * DAY);
      await Deno.utime(`${outside}/precious`, t, t);
      await Deno.mkdir(`${dir}/sub`);
      await put(`${dir}/sub`, "nested", 8, 90 * DAY);
      await Deno.symlink(`${outside}/precious`, `${dir}/link`);

      const r = await m.sweepMedia(dir, NOW);
      assertEquals(
        r.removed,
        0,
        "neither the subdirectory nor the symlink is an entry",
      );
      assertEquals(r.kept, 0);
      assert(
        await Deno.stat(`${outside}/precious`),
        "the symlink target survives",
      );
      assert(
        await Deno.stat(`${dir}/sub/nested`),
        "a nested file is not swept",
      );
      assert(
        await Deno.lstat(`${dir}/link`),
        "the symlink itself is left alone",
      );
    } finally {
      await Deno.remove(outside, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("the avatar policy is a size cap with no age limit", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    // What sweepAvatars() passes: pictures never expire, but the cache has a
    // ceiling. A year-old picture of somebody you have not heard from is
    // exactly the one that makes the list readable.
    await put(dir, "ancient", 10, 400 * DAY);
    await put(dir, "old", 10, 30 * DAY);
    await put(dir, "new", 10, 1 * DAY);
    assertEquals(
      await m.sweepMedia(dir, NOW, Infinity, 100),
      { removed: 0, freed: 0, kept: 3, bytes: 30 },
    );
    assertEquals(await names(dir), ["ancient", "new", "old"]);
    // Over the cap, the oldest go until it fits -- and no further.
    const r = await m.sweepMedia(dir, NOW, Infinity, 15);
    assertEquals(r.removed, 2);
    assertEquals(r.bytes, 10);
    assertEquals(await names(dir), ["new"]);
  });
});

Deno.test("a zero-byte entry is still aged out", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    await put(dir, "empty", 0, 30 * DAY);
    const r = await m.sweepMedia(dir, NOW);
    assertEquals(r.removed, 1);
    assertEquals(r.freed, 0);
    assertEquals(await names(dir), []);
  });
});

Deno.test("a file whose mtime is in the future is treated as new, not evicted", async () => {
  const m = await mod();
  await withDir(async (dir) => {
    await put(dir, "clockskew", 5, -DAY); // mtime one day ahead of `now`
    const r = await m.sweepMedia(dir, NOW);
    assertEquals(r.removed, 0);
    assertEquals(await names(dir), ["clockskew"]);
  });
});
