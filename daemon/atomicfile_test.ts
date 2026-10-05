/**
 * writeAtomic: every byte lands even when write() takes only a prefix, a
 * failed write leaves the old file and no temp behind, and the result is
 * private.
 *
 *   deno test -A atomicfile_test.ts
 */
import { assertEquals, assertRejects } from "@std/assert";
import { writeAtomic } from "./atomicfile.ts";

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-atomicfile-test-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

Deno.test("a string lands whole, 0600, with no temp left", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/events.json`;
    await writeAtomic(path, '{"seq":1}');
    assertEquals(await Deno.readTextFile(path), '{"seq":1}');
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(await names(dir), ["events.json"]);
  });
});

Deno.test("short writes still put every byte on disk", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/avatar`;
    const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
    const write = Deno.FsFile.prototype.write;
    Deno.FsFile.prototype.write = function (chunk: Uint8Array) {
      return write.call(this, chunk.subarray(0, 7));
    };
    try {
      await writeAtomic(path, bytes);
    } finally {
      Deno.FsFile.prototype.write = write;
    }
    assertEquals(await Deno.readFile(path), bytes);
  });
});

Deno.test("a failed write keeps the old file and removes the temp", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/avatars.json`;
    await writeAtomic(path, "old");
    const write = Deno.FsFile.prototype.write;
    let calls = 0;
    Deno.FsFile.prototype.write = function (chunk: Uint8Array) {
      if (calls++ === 0) return write.call(this, chunk.subarray(0, 1));
      return Promise.resolve(0);
    };
    try {
      await assertRejects(() => writeAtomic(path, "new contents"));
    } finally {
      Deno.FsFile.prototype.write = write;
    }
    assertEquals(await Deno.readTextFile(path), "old");
    assertEquals(await names(dir), ["avatars.json"]);
  });
});
