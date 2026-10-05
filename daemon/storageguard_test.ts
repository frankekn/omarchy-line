/**
 * sessionStorage: the session file is a JSON object linejs's FileStorage
 * used to persist with a plain writeFile, so a crash mid-write could leave
 * half a document (an upgrade can still inherit one) that
 * throws on every later get/set. The guard renames that corpse aside once:
 * resume can answer honestly, the next login can store again, and the old
 * bytes stay on disk in case they were still worth something.
 *
 *   deno test -A storageguard_test.ts
 */
import { assertEquals, assertRejects } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

// The block opens the file itself, so the stub SessionStore only has to
// stand in for the constructor: create an empty store when the path is
// absent, leave an existing file alone -- exactly what the real one does.
function prelude(path: string): string {
  return `
const STORAGE_PATH = ${JSON.stringify(path)};
class SessionStore {
  path: string;
  constructor(path: string) {
    this.path = path;
    try {
      Deno.statSync(path);
    } catch {
      Deno.writeTextFileSync(path, "{}");
    }
  }
}
export { sessionStorage };
`;
}

async function load(path: string) {
  return await loadBlock<{
    sessionStorage(): Promise<{ path: string }>;
  }>("storageguard", prelude(path));
}

async function siblings(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) names.push(e.name);
  return names;
}

Deno.test("a session file that no longer parses is quarantined, not wedged on", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/storage.json`;
  // What a crash mid-writeFile leaves: a truncated JSON document.
  await Deno.writeTextFile(path, '{"refreshToken":"abc".auth');
  const { sessionStorage } = await load(path);
  const storage = await sessionStorage();
  assertEquals(storage.path, path);
  const corpses = (await siblings(dir)).filter((n) =>
    n.startsWith("storage.json.corrupt-")
  );
  assertEquals(corpses.length, 1, "the corpse was renamed aside");
  // The corpse keeps the original bytes -- nothing about them is destroyed.
  assertEquals(
    await Deno.readTextFile(`${dir}/${corpses[0]}`),
    '{"refreshToken":"abc".auth',
  );
  // And the store is usable again: the constructor recreated an empty file.
  assertEquals(JSON.parse(await Deno.readTextFile(path)), {});
});

Deno.test("a healthy session file is opened in place, bytes untouched", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/storage.json`;
  await Deno.writeTextFile(path, '{".auth":"tok","refreshToken":"ref"}');
  const { sessionStorage } = await load(path);
  await sessionStorage();
  assertEquals((await siblings(dir)).sort(), ["storage.json"]);
  assertEquals(
    await Deno.readTextFile(path),
    '{".auth":"tok","refreshToken":"ref"}',
  );
});

Deno.test("a missing file is not a corpse: no rename, fresh store", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/storage.json`;
  const { sessionStorage } = await load(path);
  const storage = await sessionStorage();
  assertEquals(storage.path, path);
  assertEquals((await siblings(dir)).sort(), ["storage.json"]);
  assertEquals(JSON.parse(await Deno.readTextFile(path)), {});
});

Deno.test("a read failure that is not corruption stays the caller's to report", async () => {
  const dir = await Deno.makeTempDir();
  // A directory throws IsADirectory, not SyntaxError: the file exists and is
  // unreadable for a reason quarantining cannot fix.
  const path = `${dir}/storage.json`;
  await Deno.mkdir(path);
  const { sessionStorage } = await load(path);
  await assertRejects(() => sessionStorage(), Deno.errors.IsADirectory);
  assertEquals((await siblings(dir)).sort(), ["storage.json"]);
});

Deno.test("both login paths open the store through the guard", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  assertEquals(
    source.match(/await sessionStorage\(\)/g)?.length,
    3,
    "startLogin, tryResume and logoutClaimed all open via sessionStorage()",
  );
  assertEquals(
    source.match(/new SessionStore\(STORAGE_PATH\)/g)?.length,
    2,
    "only the guard and the logoutClaimed fallback construct SessionStore",
  );
});
