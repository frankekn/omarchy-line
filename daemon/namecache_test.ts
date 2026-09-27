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
