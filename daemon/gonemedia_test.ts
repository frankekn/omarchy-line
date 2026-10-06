/**
 * goneMedia: the ids OBS said are gone, remembered for the session so a
 * deleted thumbnail is fetched once, not on every chat open.
 *
 *   deno test -A gonemedia_test.ts
 *
 * The journal showed the same three message ids failing `ObsError: Object
 * download failed: HTTP 404` at 18:42 and again at 19:04 on 2026-10-05: each
 * open of the chat re-asked for thumbnails whose metadata still read "ok".
 * The block is the daemon's own, sliced verbatim behind the real mediastate
 * block; capMap is the stub's.
 */
import { assertEquals } from "@std/assert";
import { loadBlocks } from "./slice_test.ts";

type MediaState = "ok" | "unsent" | "expired";
interface GoneMediaModule {
  GONE_MEDIA_MAX: number;
  goneMedia: Map<string, true>;
  rememberGoneMedia(id: string, error: Error): boolean;
  mediaStateFor(
    id: string,
    unsent: boolean,
    expiresAt: number | undefined,
    now: number,
  ): MediaState;
}

const PRELUDE = `
type Json = Record<string, unknown>;
function capMap<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
export { GONE_MEDIA_MAX, goneMedia, mediaStateFor, rememberGoneMedia };
`;

async function load(): Promise<GoneMediaModule> {
  return await loadBlocks<GoneMediaModule>(
    ["mediastate", "gonemedia"],
    PRELUDE,
  );
}

const NOW = 1_760_000_000_000;

function obsError(status: number): Error {
  return new (class extends Error {
    override name = "ObsError";
  })(`Object download failed: HTTP ${status}`);
}

function obs404(): Error {
  return obsError(404);
}

Deno.test("a 404 on an object is remembered and the message reads expired", async () => {
  const m = await load();
  assertEquals(m.mediaStateFor("a", false, undefined, NOW), "ok");
  assertEquals(m.rememberGoneMedia("a", obs404()), true);
  assertEquals(m.mediaStateFor("a", false, undefined, NOW), "expired");
  // An expiry stamp still in the future does not bring it back.
  assertEquals(m.mediaStateFor("a", false, NOW + 1000, NOW), "expired");
  // Only the id that failed.
  assertEquals(m.mediaStateFor("b", false, undefined, NOW), "ok");
});

Deno.test("a recall still outranks a gone object", async () => {
  const m = await load();
  m.rememberGoneMedia("a", obs404());
  assertEquals(m.mediaStateFor("a", true, undefined, NOW), "unsent");
});

Deno.test("transient failures are not remembered", async () => {
  const m = await load();
  for (
    const e of [
      new Error("HTTP 500"),
      obsError(500),
      obsError(503),
      obsError(429),
      new Error("Timeout after 30000ms"),
      new TypeError("message have no contents"),
      new DOMException("Aborted", "AbortError"),
    ]
  ) {
    assertEquals(m.rememberGoneMedia("a", e), false, e.message);
  }
  assertEquals(m.goneMedia.size, 0);
  assertEquals(m.mediaStateFor("a", false, undefined, NOW), "ok");
});

Deno.test("the memory is bounded and forgets the oldest first", async () => {
  const m = await load();
  for (let i = 0; i <= m.GONE_MEDIA_MAX; i++) {
    m.rememberGoneMedia(String(i), obs404());
  }
  assertEquals(m.goneMedia.size, m.GONE_MEDIA_MAX);
  assertEquals(m.goneMedia.has("0"), false);
  assertEquals(m.goneMedia.has(String(m.GONE_MEDIA_MAX)), true);
  // A repeat moves the id to the young end instead of adding a second entry.
  m.rememberGoneMedia("1", obs404());
  assertEquals(m.goneMedia.size, m.GONE_MEDIA_MAX);
  assertEquals([...m.goneMedia.keys()].at(-1), "1");
});
