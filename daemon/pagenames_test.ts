/**
 * warmPageNames(): a page's sender names in one batch, not one round trip each.
 *
 *   deno test -A pagenames_test.ts
 *
 * A cold daemon converting a busy group's page asked LINE for each sender's
 * name in sequence -- six seconds before the page could go out. The block is
 * the daemon's own, sliced verbatim from modules/socket.ts.
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface Module {
  warmPageNames(
    page: Array<{ raw: { from?: string } }>,
    owner: object,
    generation: number,
  ): Promise<void>;
  owner: object;
  calls: { batches: string[][]; single: string[] };
  nameCache: Map<string, string>;
  v2Knows(mids: string[]): void;
  retire(): void;
  restrict(): void;
  batchGetsRefused(): void;
}

const PRELUDE = `
type Client = object;
type TalkMsg = { raw: { from?: string } };
export const calls = { batches: [] as string[][], single: [] as string[] };
export const nameCache = new Map<string, string>();
export const owner = {};
let known = new Set<string>();
let current = 1;
let restriction: unknown = null;
export function restrict() { restriction = { code: "ABUSE_BLOCK" }; }
let restrictOnBatch = false;
export function batchGetsRefused() { restrictOnBatch = true; }
export function v2Knows(mids: string[]) { known = new Set(mids); }
export function retire() { current++; }
function sessionIsCurrent(c: unknown, g: number) { return c === owner && g === current; }
const DECRYPT_WIDTH = 8;
async function warmNames(mids: string[]) {
  calls.batches.push(mids);
  // names.ts halts on a refusal; that is all this needs to see.
  if (restrictOnBatch) { restriction = { code: "ABUSE_BLOCK" }; return; }
  for (const mid of mids) if (known.has(mid)) nameCache.set(mid, "name-" + mid);
}
async function resolveName(mid: string) {
  calls.single.push(mid);
  nameCache.set(mid, "v3-" + mid);
  return "v3-" + mid;
}
async function pooledMap<T, R>(items: T[], _w: number, fn: (t: T) => Promise<R>, live: () => boolean) {
  const out: R[] = [];
  for (const item of items) { if (!live()) return null; out.push(await fn(item)); }
  return out;
}
export { warmPageNames };
`;

const load = () => loadBlock<Module>("pagenames", PRELUDE);
const page = (...from: string[]) => from.map((f) => ({ raw: { from: f } }));

Deno.test("a page's senders are asked for in one batch", async () => {
  const m = await load();
  m.v2Knows(["a", "b", "c"]);
  await m.warmPageNames(page("a", "b", "a", "c", "b"), m.owner, 1);
  assertEquals(m.calls.batches, [["a", "b", "c"]]);
  assertEquals(m.calls.single, []);
});

Deno.test("only the senders the batch could not name go one by one", async () => {
  const m = await load();
  m.v2Knows(["a"]);
  await m.warmPageNames(page("a", "b"), m.owner, 1);
  assertEquals(m.calls.single, ["b"]);
  assertEquals(m.nameCache.get("b"), "v3-b");
});

Deno.test("cached names cost nothing", async () => {
  const m = await load();
  m.nameCache.set("a", "A");
  await m.warmPageNames(page("a", "a"), m.owner, 1);
  assertEquals(m.calls.batches, []);
});

Deno.test("a retired session asks LINE for nothing", async () => {
  const m = await load();
  m.retire();
  await m.warmPageNames(page("a"), m.owner, 1);
  assertEquals(m.calls.batches, []);
});

Deno.test("a restricted account asks LINE for no names", async () => {
  const m = await load();
  m.restrict();
  await m.warmPageNames(page("a", "b"), m.owner, 1);
  assertEquals(m.calls.batches, []);
  assertEquals(m.calls.single, []);
});

Deno.test("a refusal on the batch stops the per-mid lookups", async () => {
  const m = await load();
  m.batchGetsRefused();
  await m.warmPageNames(page("a", "b", "c"), m.owner, 1);
  assertEquals(m.calls.batches.length, 1);
  assertEquals(m.calls.single, []);
});
