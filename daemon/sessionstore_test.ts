/**
 * SessionStore: the token file is created 0600, a write that cannot land
 * rejects instead of resolving as if it had, a failed write leaves the old
 * file intact, and concurrent sets on one instance all survive.
 *
 *   deno test -A sessionstore_test.ts
 */
import { assertEquals, assertRejects } from "@std/assert";
import { SessionStore } from "./sessionstore.ts";

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-sessionstore-test-" });
  try {
    await body(dir);
  } finally {
    await Deno.chmod(dir, 0o700).catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a fresh store is created private, not world-readable", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/storage.json`;
    new SessionStore(path);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(await Deno.readTextFile(path), "{}");
  });
});

Deno.test("an existing store is left alone by the constructor", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/storage.json`;
    await Deno.writeTextFile(path, '{".auth":"kept"}');
    assertEquals(await new SessionStore(path).get(".auth"), "kept");
  });
});

Deno.test("set, get and delete round-trip and stay 0600", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/storage.json`;
    const store = new SessionStore(path);
    await store.set(".auth", "t1");
    await store.set("expire", 42);
    assertEquals(await store.get(".auth"), "t1");
    await store.delete(".auth");
    assertEquals(await store.getAll(), { expire: 42 });
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    // No temp file is left behind next to the store.
    const names: string[] = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assertEquals(names, ["storage.json"]);
  });
});

Deno.test("concurrent sets on one instance all land", async () => {
  await withDir(async (dir) => {
    const store = new SessionStore(`${dir}/storage.json`);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, i)),
    );
    assertEquals(Object.keys(await store.getAll()).length, 20);
  });
});

Deno.test("a write that cannot land rejects and keeps the old token", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/storage.json`;
    const store = new SessionStore(path);
    await store.set(".auth", "old");
    // The temp file cannot be created in a read-only dir: the rotation
    // fails, and the caller has to hear about it.
    await Deno.chmod(dir, 0o500);
    await assertRejects(() => store.set(".auth", "new"));
    await Deno.chmod(dir, 0o700);
    assertEquals(await store.get(".auth"), "old");
    // The chain is not wedged by the failure.
    await store.set(".auth", "after");
    assertEquals(await store.get(".auth"), "after");
  });
});
