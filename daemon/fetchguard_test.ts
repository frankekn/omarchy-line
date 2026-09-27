/**
 * The per-request ceiling: what it bounds (time to the response headers), what
 * it must never bound (a body that streams for hours), and that a timeout is
 * reported as the kind of failure the rest of the daemon acts on.
 *
 * The real `enil:loginerror` block is loaded underneath rather than a copy of
 * its regex, because "the abort reason classifies as network" is the whole
 * contract between this block and the reconnect/retry paths.
 *
 * globalThis.fetch is stubbed in every test: this suite must never touch the
 * network.
 *
 *   deno test -A fetchguard_test.ts
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadBlock, sliceBlock } from "./slice_test.ts";

async function loadModule(timeoutMs = 30) {
  const prelude = `
export const REQUEST_TIMEOUT_MS = ${timeoutMs};
export const UPLOAD_TIMEOUT_MS = ${timeoutMs * 100};
export { guardedFetch, headerTimeoutMs, classifyLoginError };
` + (await sliceBlock("loginerror"));
  return await loadBlock<{
    REQUEST_TIMEOUT_MS: number;
    UPLOAD_TIMEOUT_MS: number;
    guardedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response>;
    headerTimeoutMs(url: URL): number;
    classifyLoginError(error: unknown): "network" | "token_expired" | "unknown";
  }>("fetchguard", prelude);
}

/** Restores the real fetch even when the assertion in between throws. */
async function withFetch(
  stub: typeof globalThis.fetch,
  body: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("a request that never answers fails as a network error", async () => {
  const m = await loadModule();
  await withFetch(
    // A hung request as Deno reports one: nothing ever comes back, and the
    // rejection is the abort reason itself.
    (input) =>
      new Promise<Response>((_resolve, reject) => {
        const s = (input as Request).signal;
        s.addEventListener("abort", () => reject(s.reason));
      }),
    async () => {
      const e = await assertRejects(() =>
        m.guardedFetch("https://gw.line.naver.jp/enc")
      );
      // Deno rejects with the abort reason itself, which is why the reason is
      // an Error and not a string: the panel's advice hangs off this.
      assertEquals(
        m.classifyLoginError(e),
        "network",
        `classified as ${m.classifyLoginError(e)}`,
      );
    },
  );
});

Deno.test("headers arriving in time leave the body streaming past the timeout", async () => {
  const m = await loadModule(20);
  let push!: (chunk: Uint8Array) => void;
  let done!: () => void;
  await withFetch(
    (input) => {
      // A real Deno response body errors when the request's signal aborts, so
      // the stub must too -- otherwise a guard that forgot to clear its timer
      // would still pass this test.
      const s = (input as Request).signal;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          push = (chunk) => c.enqueue(chunk);
          done = () => c.close();
          s.addEventListener("abort", () => c.error(s.reason));
        },
      });
      return Promise.resolve(new Response(stream));
    },
    async () => {
      const res = await m.guardedFetch("https://gw.line.naver.jp/enc");
      // The push stream holds its body open for hours; cutting it at the
      // header ceiling would kill the very link this guard exists to protect.
      await new Promise((r) => setTimeout(r, 80));
      push(new Uint8Array([1, 2, 3]));
      done();
      const bytes = new Uint8Array(await res.arrayBuffer());
      assertEquals(bytes.length, 3, "body was cut by the header timeout");
    },
  );
});

Deno.test("the caller's own abort still propagates", async () => {
  const m = await loadModule(10_000);
  const caller = new AbortController();
  await withFetch(
    (input) =>
      new Promise<Response>((_resolve, reject) => {
        const s = (input as Request).signal;
        s.addEventListener("abort", () => reject(s.reason));
      }),
    async () => {
      const p = m.guardedFetch("https://gw.line.naver.jp/enc", {
        signal: caller.signal,
      });
      caller.abort(new Error("listen() stopped"));
      const e = await assertRejects(() => p) as Error;
      assertEquals(e.message, "listen() stopped");
    },
  );
});

Deno.test("only the media host gets the upload ceiling", async () => {
  const m = await loadModule();
  assertEquals(
    m.headerTimeoutMs(new URL("https://obs.line-apps.com/talk/m/upload.nhn")),
    m.UPLOAD_TIMEOUT_MS,
  );
  assertEquals(
    m.headerTimeoutMs(new URL("https://gw.line.naver.jp/enc")),
    m.REQUEST_TIMEOUT_MS,
  );
  assertEquals(
    m.headerTimeoutMs(new URL("https://legy-jp-long.line.naver.jp/S4")),
    m.REQUEST_TIMEOUT_MS,
  );
});

Deno.test("the timer is cleared on resolve and on reject", async () => {
  const m = await loadModule(10_000);
  // A 10s timer still pending when the test ends is exactly what deno test's
  // timer sanitizer fails on, so reaching the end of this test is the
  // assertion. Both exits are taken.
  await withFetch(
    () => Promise.resolve(new Response("ok")),
    async () => {
      const res = await m.guardedFetch("https://gw.line.naver.jp/enc");
      await res.text();
    },
  );
  await withFetch(
    () => Promise.reject(new TypeError("fetch failed")),
    async () => {
      const e = await assertRejects(() =>
        m.guardedFetch("https://gw.line.naver.jp/enc")
      );
      assert(m.classifyLoginError(e) === "network");
    },
  );
});
