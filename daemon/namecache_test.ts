import { assertEquals } from "@std/assert";

Deno.test("an invalidated in-flight name lookup retries the current epoch", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/names.ts", import.meta.url),
  );
  const start = source.indexOf("async function resolveName(");
  const end = source.indexOf("/**\n * Fills nameCache", start);
  const functionSource = source.slice(start, end);
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  const prelude = `
type Client = { getChat(mid: string): Promise<{ raw: object; name: string }> };
const owner = { getChat: (_mid: string) => Promise.resolve({ raw: {}, name: "" }) };
let client: Client | null = owner;
let sessionGeneration = 1;
const me: { mid?: string; displayName?: string } = {};
const nameCache = new Map<string, string>();
const nameCacheEpoch = new Map<string, number>();
const NAME_CACHE_MAX = 5000;
let releaseFirst: ((value: string) => void) | null = null;
let calls = 0;
function sessionIsCurrent(value: Client, generation: number) {
  return value === client && generation === sessionGeneration;
}
function midKind(_mid: string): "user" | "chat" { return "user"; }
function noteAvatar() {}
function noteNameFailure() {}
function rememberName(mid: string, name: string) { nameCache.set(mid, name); }
function noteKeptNameUsed(_mid: string) {}
let restriction: unknown = null;
function capMap<V>(_map: Map<string, V>, _max: number) {}
function resolveUserName(_mid: string, _owner: Client, _generation: number) {
  calls++;
  if (calls === 1) return new Promise<string>((resolve) => releaseFirst = resolve);
  return Promise.resolve("new name");
}
`;
  await Deno.writeTextFile(
    file,
    prelude + functionSource + `
export function resolve() { return resolveName("u1", owner, 1); }
export function invalidate() {
  nameCache.delete("u1");
  nameCacheEpoch.set("u1", (nameCacheEpoch.get("u1") ?? 0) + 1);
}
export function release() { releaseFirst?.("old name"); }
export function callCount() { return calls; }
export function cached() { return nameCache.get("u1"); }
`,
  );
  try {
    const module = await import("file://" + file + `?v=${crypto.randomUUID()}`);
    const pending = module.resolve();
    await Promise.resolve();
    module.invalidate();
    module.release();
    assertEquals(await pending, "new name");
    assertEquals(module.callCount(), 2);
    assertEquals(module.cached(), "new name");
  } finally {
    await Deno.remove(file).catch(() => {});
  }
});

Deno.test("every name lookup that fails hands a refusal to the restriction halt", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/names.ts", import.meta.url),
  );
  // v3, v2, the chat lookup, the bulk batch and the two background
  // confirmations: six catches, six calls.
  const catches = source.match(/\} catch \(e\) \{/g) ?? [];
  const noted = source.match(/noteNameFailure\(e, owner, generation\);/g) ??
    [];
  assertEquals(catches.length, 6);
  assertEquals(noted.length, catches.length);
  const helper = source.slice(
    source.indexOf("function noteNameFailure("),
    source.indexOf("\n}\n", source.indexOf("function noteNameFailure(")),
  );
  assertEquals(
    /classifyLoginError\(e\) === "restricted"\) haltForRestriction\(e\)/.test(
      helper,
    ),
    true,
  );
  // Only the current session's refusal halts anything.
  assertEquals(
    helper.indexOf("sessionIsCurrent(owner, generation)") <
      helper.indexOf("haltForRestriction(e)"),
    true,
  );
  assertEquals(helper.includes("sessionIsCurrent(owner, generation)"), true);
  // While halted, resolveName answers from the cache or with the bare mid,
  // before any lookup, and does not cache the mid as a name.
  const resolve = source.slice(
    source.indexOf("export async function resolveName("),
    source.indexOf("export async function warmNames("),
  );
  const halted = resolve.indexOf("if (restriction) return mid;");
  assertEquals(
    halted > 0 && halted < resolve.indexOf("resolveUserName("),
    true,
  );
  assertEquals(halted < resolve.indexOf("rememberName("), true);
  const warm = source.slice(source.indexOf("export async function warmNames("));
  assertEquals(warm.includes("if (!owner || restriction) return;"), true);
});

Deno.test("a rename seen live is dropped from names.json too", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/names.ts", import.meta.url),
  );
  const fn = source.slice(source.indexOf("export function invalidateName("));
  assertEquals(
    /nameSavedAt\.delete\(mid\)\) scheduleNamesSave\(\)/.test(
      fn.slice(0, fn.indexOf("\n}\n")),
    ),
    true,
  );
  // Every answer goes through rememberName, so every answer can be kept.
  assertEquals(
    /nameCache\.set\(/.test(
      source.slice(source.indexOf("export async function resolveUserName(")),
    ),
    false,
  );
});
