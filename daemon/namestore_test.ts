/**
 * names.json: display names kept across restarts, per account, for a week.
 *
 *   deno test -A namestore_test.ts
 *
 * The first open of a group after a daemon start asked LINE for every
 * sender's name before the page could go out. These pin what the file keeps,
 * whose it is, and what it refuses to hand back.
 */
import { assertEquals } from "@std/assert";
import { createNameStore, NAME_TTL_MS } from "./modules/namestore.ts";

const ME = "u" + "0".repeat(31) + "1";
const OTHER = "u" + "0".repeat(31) + "2";
const A = "u" + "a".repeat(32);
const B = "u" + "b".repeat(32);
const G = "c" + "c".repeat(32);

async function withPath(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-names-" });
  try {
    await fn(`${dir}/names.json`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("names come back for the account that saved them", async () => {
  await withPath(async (path) => {
    const t = 1_800_000_000_000;
    const store = createNameStore(path, { now: () => t });
    await store.save(
      ME,
      new Map([[A, { name: "Alice", at: t - 1000 }], [G, {
        name: "家族",
        at: t,
      }]]),
    );
    const back = await store.load(ME);
    assertEquals(back.get(A)?.name, "Alice");
    assertEquals(back.get(G)?.name, "家族");
    // Private like storage.json beside it.
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  });
});

Deno.test("another account's login reads none of them", async () => {
  await withPath(async (path) => {
    const store = createNameStore(path);
    await store.save(
      ME,
      new Map([[A, { name: "my nickname", at: Date.now() }]]),
    );
    assertEquals((await store.load(OTHER)).size, 0);
    assertEquals((await store.load("")).size, 0);
  });
});

Deno.test("a name older than the TTL is looked up again", async () => {
  await withPath(async (path) => {
    const t = 1_800_000_000_000;
    const store = createNameStore(path, { now: () => t });
    await store.save(
      ME,
      new Map([
        [A, { name: "fresh", at: t - NAME_TTL_MS + 60_000 }],
        [B, { name: "stale", at: t - NAME_TTL_MS - 1 }],
      ]),
    );
    const back = await store.load(ME);
    assertEquals([...back.keys()], [A]);
  });
});

Deno.test("a bare mid, a blank or a future stamp is never kept", async () => {
  await withPath(async (path) => {
    const t = 1_800_000_000_000;
    // Written by hand: the shapes a lookup failure or a clock jump leaves.
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        v: 1,
        owner: ME,
        names: {
          [A]: [A, t],
          [B]: ["", t],
          [G]: ["future", t + 60_000],
          "u-ok": ["ok", t],
        },
      }),
    );
    const back = await createNameStore(path, { now: () => t }).load(ME);
    assertEquals([...back.keys()], ["u-ok"]);
  });
});

Deno.test("an unreadable or foreign file costs only the lookups", async () => {
  await withPath(async (path) => {
    const store = createNameStore(path);
    assertEquals((await store.load(ME)).size, 0); // missing
    await Deno.writeTextFile(path, "{not json");
    assertEquals((await store.load(ME)).size, 0);
    await Deno.writeTextFile(
      path,
      JSON.stringify({ v: 2, owner: ME, names: {} }),
    );
    assertEquals((await store.load(ME)).size, 0);
  });
});

Deno.test("the newest answers win the cap", async () => {
  await withPath(async (path) => {
    const t = 1_800_000_000_000;
    const store = createNameStore(path, { now: () => t, max: 2 });
    await store.save(
      ME,
      new Map([
        [A, { name: "old", at: t - 3000 }],
        [B, { name: "mid", at: t - 2000 }],
        [G, { name: "new", at: t - 1000 }],
      ]),
    );
    assertEquals([...(await store.load(ME)).keys()].sort(), [B, G].sort());
  });
});

Deno.test("the picture token is kept with its name", async () => {
  await withPath(async (path) => {
    const t = 1_800_000_000_000;
    const store = createNameStore(path, { now: () => t });
    await store.save(
      ME,
      new Map([
        [A, { name: "Alice", at: t, token: "0h1a2b" }],
        [B, { name: "Bob", at: t }],
      ]),
    );
    const back = await store.load(ME);
    assertEquals(back.get(A), { name: "Alice", at: t, token: "0h1a2b" });
    assertEquals(back.get(B), { name: "Bob", at: t });
  });
});
