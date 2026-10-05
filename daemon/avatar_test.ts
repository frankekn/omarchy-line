/**
 * The avatar block: which URLs a picture token could be at, where the file
 * lands, which field of a contact the token comes from, and the gate that
 * keeps a cold start from firing 122 requests at the CDN at once.
 *
 * Nothing here reaches the real network: the one test that needs a response
 * swaps `globalThis.fetch` for a stub. The URL order is a probe the daemon
 * settles at runtime, so what is pinned is the shape of the candidates and
 * that the remembered one is tried first -- not that any given host answers.
 *
 *   deno test -A avatar_test.ts
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { loadBlock, loadBlocks } from "./slice_test.ts";

// AVATAR_DIR is the only module state the block reaches, and it is a default
// parameter -- every call below passes a directory explicitly anyway.
// limiter moved beside the other shared cache helpers (modules/caches.ts);
// the sliced module imports it from there rather than stubbing a copy.
const CACHES = new URL("./modules/caches.ts", import.meta.url).href;

const PRELUDE = `
import { limiter } from "${CACHES}";
const AVATAR_DIR = "/nonexistent/enil-avatars";
export {
  AVATAR_DIR,
  AVATAR_OBS_HOST,
  AVATAR_PROFILE_HOST,
  AVATAR_SUFFIXES,
  avatarFileFor,
  avatarUrlCandidates,
  pictureTokenOf,
};
export { limiter };
`;

interface AvatarModule {
  AVATAR_DIR: string;
  AVATAR_OBS_HOST: string;
  AVATAR_PROFILE_HOST: string;
  AVATAR_SUFFIXES: string[];
  avatarFileFor(mid: string, token: string, dir?: string): string;
  avatarUrlCandidates(kind: string, token: string, shape?: string): {
    shape: string;
    url: string;
  }[];
  limiter(max: number): <T>(work: () => Promise<T>) => Promise<T>;
  pictureTokenOf(raw: unknown): string;
}
let M: AvatarModule | undefined;
async function mod() {
  if (!M) M = await loadBlock<AvatarModule>("avatar", PRELUDE);
  return M;
}

function urls(cands: { url: string }[]): string[] {
  return cands.map((c) => c.url);
}

Deno.test("a contact with no picture yields nothing to fetch", async () => {
  const m = await mod();
  assertEquals(m.avatarUrlCandidates("user", ""), []);
  assertEquals(m.avatarUrlCandidates("user", "   "), []);
  // A path that is nothing but slashes is not an object id either.
  assertEquals(m.avatarUrlCandidates("chat", "//"), []);
});

Deno.test("a token that is already a URL is used as it stands", async () => {
  const m = await mod();
  const url = "https://profile.line-scdn.net/0hAbc/preview";
  assertEquals(m.avatarUrlCandidates("user", url), [{ shape: "", url }]);
  // No shape: what answered says nothing about the next contact, because the
  // next one may not carry a thumbnailUrl at all.
  assertEquals(m.avatarUrlCandidates("user", url)[0].shape, "");
});

Deno.test("picturePath and pictureStatus reach the same objects", async () => {
  const m = await mod();
  assertEquals(
    urls(m.avatarUrlCandidates("user", "/0hAbc")),
    urls(m.avatarUrlCandidates("user", "0hAbc")),
  );
  // Both trimmed and both stripped of every leading slash.
  assertEquals(
    urls(m.avatarUrlCandidates("user", "  ///0hAbc  ")),
    urls(m.avatarUrlCandidates("user", "0hAbc")),
  );
});

Deno.test("each kind leads with its own host and still covers both", async () => {
  const m = await mod();
  const user = urls(m.avatarUrlCandidates("user", "0hAbc"));
  const chat = urls(m.avatarUrlCandidates("chat", "0hAbc"));
  assert(user[0].startsWith(m.AVATAR_PROFILE_HOST), user[0]);
  assert(chat[0].startsWith(m.AVATAR_OBS_HOST), chat[0]);
  // Leading with a guess is only safe because the other host is still tried.
  assertEquals([...user].sort(), [...chat].sort());
  assertEquals(user.length, 2 * m.AVATAR_SUFFIXES.length);
  assertEquals(new Set(user).size, user.length);
});

Deno.test("every candidate is https and names the object once", async () => {
  const m = await mod();
  for (const kind of ["user", "chat"]) {
    for (const c of m.avatarUrlCandidates(kind, "/0hAbc")) {
      assert(c.url.startsWith("https://"), c.url);
      assertEquals(c.url.split("0hAbc").length - 1, 1, c.url);
      // The shape has to rebuild the URL, or remembering it buys nothing.
      const [host, suffix] = c.shape.split("|");
      assertEquals(c.url, `${host}/0hAbc${suffix}`);
    }
  }
});

Deno.test("the shape that answered last time is tried first", async () => {
  const m = await mod();
  const plain = m.avatarUrlCandidates("user", "0hAbc");
  const last = plain[plain.length - 1].shape;
  const preferred = m.avatarUrlCandidates("user", "0hAbc", last);
  assertEquals(preferred[0].shape, last);
  // Reordered, never shortened: the probe is still the fallback.
  assertEquals(
    urls(preferred).sort(),
    urls(plain).sort(),
  );
  // A shape from an older build, or from the other kind, is not a URL to try.
  assertEquals(
    urls(m.avatarUrlCandidates("user", "0hAbc", "https://nope|/x")),
    urls(plain),
  );
});

Deno.test("the cache file is derived from the mid and the token", async () => {
  const m = await mod();
  const dir = "/tmp/enil-avatars-test";
  const a = await m.avatarFileFor("uabc", "/0hSomeObject", dir);
  // Pinned: the join is what makes the name stable across restarts, so a
  // change to it silently refetches every picture the daemon has.
  assertEquals(a, `${dir}/211e4c838bcab6f0d4a26909cc2f4951977510ca.jpg`);
  assertEquals(
    await m.avatarFileFor("cgroup", "0hOther", dir),
    `${dir}/a5823d2d99cd10ecc02eefe77b9e1c35eb9f4905.jpg`,
  );
  assertEquals(await m.avatarFileFor("uabc", "/0hSomeObject", dir), a);
  // A new photo is a new file: without that, the old one stays on screen.
  assertNotEquals(await m.avatarFileFor("uabc", "/0hNewPhoto", dir), a);
  assertNotEquals(await m.avatarFileFor("uxyz", "/0hSomeObject", dir), a);
});

Deno.test("the cache file name can never escape the cache directory", async () => {
  const m = await mod();
  const dir = "/tmp/enil-avatars-test";
  for (const mid of ["../../etc/passwd", "u/../..", "u\u0000x"]) {
    const p = await m.avatarFileFor(mid, "../../x", dir);
    assertEquals(p.slice(0, dir.length + 1), `${dir}/`);
    assert(/^[0-9a-f]{40}\.jpg$/.test(p.slice(dir.length + 1)), p);
  }
});

Deno.test("avatarFileFor defaults to the cache directory", async () => {
  const m = await mod();
  const p = await m.avatarFileFor("uabc", "0hAbc");
  assertEquals(p.slice(0, m.AVATAR_DIR.length + 1), `${m.AVATAR_DIR}/`);
});

Deno.test("the picture token is taken from the most useful field", async () => {
  const m = await mod();
  assertEquals(
    m.pictureTokenOf({
      thumbnailUrl: "https://x/y",
      picturePath: "/0hA",
      pictureStatus: "0hB",
    }),
    "https://x/y",
  );
  assertEquals(
    m.pictureTokenOf({ picturePath: "/0hA", pictureStatus: "0hB" }),
    "/0hA",
  );
  assertEquals(m.pictureTokenOf({ pictureStatus: "0hB" }), "0hB");
  // LINE sends "" for "no picture", and a blank field must not win over the
  // one after it.
  assertEquals(
    m.pictureTokenOf({ thumbnailUrl: "", picturePath: "/0hA" }),
    "/0hA",
  );
  assertEquals(m.pictureTokenOf({ picturePath: "  /0hA  " }), "/0hA");
  assertEquals(m.pictureTokenOf({}), "");
  assertEquals(m.pictureTokenOf(undefined), "");
  assertEquals(m.pictureTokenOf(null), "");
  // A number is not a token, and String()-ing it would build a URL to a 404.
  assertEquals(m.pictureTokenOf({ pictureStatus: 42 }), "");
});

/** A fetch that never finishes on its own: the test decides when each one does. */
function pendingFetch() {
  const done: (() => void)[] = [];
  let live = 0;
  let peak = 0;
  const started: number[] = [];
  const fetch = (n: number) => {
    live++;
    peak = Math.max(peak, live);
    started.push(n);
    return new Promise<number>((resolve) => {
      done.push(() => {
        live--;
        resolve(n);
      });
    });
  };
  return {
    fetch,
    started,
    peak: () => peak,
    /** Lets the oldest in-flight call finish and drains the microtask queue. */
    async finishOne() {
      done.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

Deno.test("no more than `max` requests are ever in flight", async () => {
  const m = await mod();
  const gate = m.limiter(4);
  const net = pendingFetch();
  const all = [];
  for (let i = 0; i < 12; i++) all.push(gate(() => net.fetch(i)));
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(net.started, [0, 1, 2, 3]);
  for (let i = 0; i < 12; i++) await net.finishOne();
  assertEquals(await Promise.all(all), [...Array(12).keys()]);
  assertEquals(net.peak(), 4);
  // The queue is served in arrival order, so a picture asked for first is not
  // starved by one asked for later.
  assertEquals(net.started, [...Array(12).keys()]);
});

Deno.test("a failed request hands its slot on instead of losing it", async () => {
  const m = await mod();
  const gate = m.limiter(2);
  const boom = gate(() => Promise.reject(new Error("404")));
  // The rejection is the caller's; the gate must not swallow it either.
  await boom.then(
    () => {
      throw new Error("the rejection should have propagated");
    },
    () => {},
  );
  const net = pendingFetch();
  const queued = [gate(() => net.fetch(0)), gate(() => net.fetch(1))];
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(net.started, [0, 1], "both slots are free again");
  for (let i = 0; i < 2; i++) await net.finishOne();
  assertEquals(await Promise.all(queued), [0, 1]);
});

Deno.test("a gate of one is a queue, and the work still runs in order", async () => {
  const m = await mod();
  const gate = m.limiter(1);
  const net = pendingFetch();
  const all = [gate(() => net.fetch(0)), gate(() => net.fetch(1))];
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(net.started, [0]);
  await net.finishOne();
  assertEquals(net.started, [0, 1]);
  await net.finishOne();
  assertEquals(await Promise.all(all), [0, 1]);
  assertEquals(net.peak(), 1);
});

// downloadAvatar reaches for the two constants, the remembered-shape map and
// the index flag; everything else it uses is in the avatar block with it.
const FETCH_PRELUDE = `
import { writeAtomic } from ${
  JSON.stringify(new URL("./atomicfile.ts", import.meta.url).href)
};
const AVATAR_DIR = "/nonexistent/enil-avatars";
const AVATAR_TIMEOUT_MS = 5_000;
const AVATAR_MAX_FILE_BYTES = 4_096;
const avatarShape = new Map();
let avatarIndexDirty = false;
function scheduleAvatarIndexSave() {}
export {
  AVATAR_MAX_FILE_BYTES,
  avatarShape,
  downloadAvatar,
  readCapped,
};
export function indexDirty() {
  return avatarIndexDirty;
}
`;

interface AvatarFetchModule {
  AVATAR_MAX_FILE_BYTES: number;
  avatarShape: Map<string, string>;
  downloadAvatar(mid: string, token: string, dir: string): Promise<boolean>;
  readCapped(response: Response, max: number): Promise<Uint8Array | null>;
  indexDirty(): boolean;
}
let F: AvatarFetchModule | undefined;
async function fetchMod() {
  // The fetch half calls into the pure half, so both blocks are loaded; only
  // one module, or downloadAvatar would be testing a stubbed candidate list.
  if (!F) {
    F = await loadBlocks<AvatarFetchModule>(
      ["avatar", "avatarfetch"],
      FETCH_PRELUDE,
    );
  }
  return F;
}

/** A body that reports how much of it was actually asked for. */
function chunkedBody(chunkBytes: number, chunks: number) {
  const seen = { pulled: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= chunks) {
        c.close();
        return;
      }
      sent++;
      seen.pulled++;
      c.enqueue(new Uint8Array(chunkBytes).fill(7));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

/** Swaps globalThis.fetch for the duration of `fn`, then puts it back. */
async function withFetch(
  stub: typeof globalThis.fetch,
  fn: () => Promise<void>,
) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "enil-avatar-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("an oversized body is cut off mid-stream and never written", async () => {
  const m = await fetchMod();
  const cap = m.AVATAR_MAX_FILE_BYTES;
  const chunkBytes = 1_024;
  const chunks = 200; // 200 KB against a 4 KB cap
  const { stream, seen } = chunkedBody(chunkBytes, chunks);
  await withTempDir(async (dir) => {
    const path = `${dir}/avatar.jpg`;
    await withFetch(
      () =>
        Promise.resolve(
          // No content-length at all: the header the old gate trusted is
          // exactly what a chunked response does not have.
          new Response(stream, { headers: { "content-type": "image/jpeg" } }),
        ),
      async () => {
        // An absolute token is one candidate, so this is one request.
        const got = await m.downloadAvatar(
          "user",
          "https://line-scdn.invalid/0hAbc",
          path,
        );
        assertEquals(got, false);
      },
    );
    await assertRejects(
      () => Deno.stat(path),
      Deno.errors.NotFound,
      undefined,
      "an oversized picture must leave nothing behind",
    );
  });
  assert(seen.cancelled, "the body was read to the end instead of cancelled");
  // Cut off once the running total crossed the cap, nowhere near the 200 KB
  // the body was willing to send. Bounded by the cap and a little rather than
  // an exact chunk count: the stream queues a chunk ahead of the reader, and
  // how far ahead is the runtime's business, not this cap's.
  assert(
    seen.pulled * chunkBytes < 2 * cap,
    `pulled ${seen.pulled * chunkBytes} bytes for a ${cap}-byte cap`,
  );
  assert(seen.pulled < chunks, "the whole body was pulled");
});

Deno.test("a picture inside the cap is written and its shape remembered", async () => {
  const m = await fetchMod();
  const { stream, seen } = chunkedBody(512, 4); // 2 KB, under the 4 KB cap
  await withTempDir(async (dir) => {
    const path = `${dir}/avatar.jpg`;
    await withFetch(
      () =>
        Promise.resolve(
          new Response(stream, { headers: { "content-type": "image/png" } }),
        ),
      async () => {
        assertEquals(await m.downloadAvatar("chat", "0hAbc", path), true);
      },
    );
    const st = await Deno.stat(path);
    assertEquals(st.size, 2048);
    assertEquals((await Deno.readFile(path))[0], 7);
  });
  assert(!seen.cancelled, "a body inside the cap is read, not cancelled");
  assertEquals(seen.pulled, 4);
  // The shape that answered is what the next contact is tried with first.
  assertEquals(m.avatarShape.get("chat"), "https://obs.line-scdn.net|/preview");
  assert(m.indexDirty(), "a new shape has to reach avatars.json");
});

Deno.test("a miss served as a 200 HTML page is not a picture", async () => {
  const m = await fetchMod();
  await withTempDir(async (dir) => {
    const path = `${dir}/avatar.jpg`;
    let asked = 0;
    await withFetch(
      () => {
        asked++;
        return Promise.resolve(
          new Response("<html>not found</html>", {
            headers: { "content-type": "text/html" },
          }),
        );
      },
      async () => {
        assertEquals(await m.downloadAvatar("user", "0hAbc", path), false);
      },
    );
    // Every candidate was tried before giving up, and none wrote anything.
    assertEquals(asked, 4);
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  });
});

Deno.test("readCapped keeps a body exactly at the cap and refuses one over", async () => {
  const m = await fetchMod();
  const body = (n: number) =>
    new Response(new Uint8Array(n), {
      headers: { "content-type": "image/jpeg" },
    });
  assertEquals((await m.readCapped(body(100), 100))?.length, 100);
  assertEquals(await m.readCapped(body(101), 100), null);
  // An empty body is a miss, not a zero-byte picture: cacheMedia treats a
  // zero-length file as uncached, and this must not create one.
  assertEquals(await m.readCapped(body(0), 100), null);
});
