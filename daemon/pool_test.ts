/**
 * pooledMap: order preservation, concurrency bound, early guard stop.
 *
 *   deno test -A pool_test.ts
 */
import { assertEquals } from "@std/assert";
import { pooledMap } from "./pool.ts";

Deno.test("results keep input order regardless of completion order", async () => {
  const out = await pooledMap(
    [30, 10, 20, 5, 1],
    3,
    (delay) =>
      new Promise<number>((resolve) => setTimeout(() => resolve(delay), delay)),
  );
  assertEquals(out, [30, 10, 20, 5, 1]);
});

Deno.test("concurrency never exceeds the limit", async () => {
  let live = 0;
  let peak = 0;
  await pooledMap(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 1 + (i % 3)));
    live--;
  });
  assertEquals(peak <= 4, true);
  assertEquals(peak > 1, true);
});

Deno.test("a zero or negative limit still maps everything once", async () => {
  for (const limit of [0, -3]) {
    let calls = 0;
    const out = await pooledMap([1, 2, 3], limit, (n) => {
      calls++;
      return Promise.resolve(n * 2);
    });
    assertEquals(out, [2, 4, 6]);
    assertEquals(calls, 3);
  }
});

Deno.test("a cancelled guard resolves to null, never a holey array", async () => {
  let stop = false;
  let started = 0;
  const out = await pooledMap(
    Array.from({ length: 50 }, (_, i) => i),
    2,
    async (i) => {
      started++;
      if (started >= 3) stop = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return i;
    },
    () => !stop,
  );
  assertEquals(out, null);
  assertEquals(started < 50, true);
});

Deno.test("a guard that never trips returns the full ordered array", async () => {
  const out = await pooledMap(
    [1, 2, 3, 4],
    2,
    (n) => Promise.resolve(n + 1),
    () => true,
  );
  assertEquals(out, [2, 3, 4, 5]);
});

Deno.test("a rejecting item rejects the pool", async () => {
  let threw: unknown;
  try {
    await pooledMap(
      [1, 2, 3],
      2,
      (n) => n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(n),
    );
  } catch (error) {
    threw = error;
  }
  assertEquals((threw as Error).message, "boom");
});

Deno.test("an empty list maps without starting workers", async () => {
  const out = await pooledMap([], 4, () => {
    throw new Error("must not run");
  });
  assertEquals(out, []);
});
