/**
 * names.ts's half of names.json: what reaches the file, under whose account,
 * and what a login reads back.
 *
 *   deno test -A keptnames_test.ts
 *
 * The block is sliced verbatim from modules/names.ts; the file and the timer
 * are stand-ins, so each test decides when the debounced save runs and when
 * a write finishes.
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface Kept {
  name: string;
  at: number;
  token?: string;
}
interface Module {
  rememberName(mid: string, name: string): void;
  loadKeptNames(owner: string): Promise<void>;
  forgetNames(): void;
  namesSaved(): Promise<void>;
  nameCache: Map<string, string>;
  avatarTokens: Map<string, string>;
  saves: Array<{ owner: string; rows: Map<string, Kept> }>;
  onDisk: Map<string, Kept>;
  runTimers(): void;
  timers(): number;
  me: { mid?: string };
  switchDuringLoad(mid: string): void;
  holdWrites(): () => void;
  writing: number;
}

const PRELUDE = `
type KeptName = { name: string; at: number; token?: string };
export const me: { mid?: string } = { mid: "ME" };
export const nameCache = new Map<string, string>();
export const avatarTokens = new Map<string, string>();
const NAME_CACHE_MAX = 5000;
function capMap<V>(_m: Map<string, V>, _n: number) {}
const NAMES_PATH = "/dev/null";
export const saves: Array<{ owner: string; rows: Map<string, KeptName> }> = [];
export const onDisk = new Map<string, KeptName>();
export let writing = 0;
let gate: Promise<void> | null = null;
export function holdWrites() {
  let release = () => {};
  gate = new Promise<void>((r) => release = r);
  return () => { gate = null; release(); };
}
let switchTo: string | null = null;
export function switchDuringLoad(mid: string) { switchTo = mid; }
function createNameStore(_path: string) {
  return {
    async load(owner: string) {
      if (switchTo !== null) me.mid = switchTo;
      return owner === "ME" ? new Map(onDisk) : new Map();
    },
    async save(owner: string, rows: Map<string, KeptName>) {
      // Two saves on the disk at once would share writeAtomic's temp file.
      if (writing) throw new Error("overlapping save");
      writing++;
      saves.push({ owner, rows });
      if (gate) await gate;
      // What the next load reads: the file as this save left it.
      if (owner === "ME") { onDisk.clear(); for (const [k, v] of rows) onDisk.set(k, v); }
      writing--;
    },
  };
}
let queued: Array<() => void> = [];
function setTimeout(fn: () => void, _ms: number) { queued.push(fn); return queued.length; }
function clearTimeout(_id: number) { queued = []; }
export function runTimers() { const q = queued; queued = []; for (const f of q) f(); }
export function timers() { return queued.length; }
`;

const load = async () => {
  const m = await loadBlock<Module>("keptnames", PRELUDE);
  await m.loadKeptNames("ME"); // logged in as ME, nothing kept yet
  return m;
};

Deno.test("answered names reach the file once, bare mids never", async () => {
  const m = await load();
  m.rememberName("uA", "Alice");
  m.rememberName("uB", "uB"); // the lookup failed: only the mid came back
  m.rememberName("uC", "Carol");
  assertEquals(m.timers(), 1); // coalesced into one save
  m.runTimers();
  await m.namesSaved();
  assertEquals(m.saves.length, 1);
  assertEquals(m.saves[0].owner, "ME");
  assertEquals([...m.saves[0].rows.keys()], ["uA", "uC"]);
  assertEquals(m.saves[0].rows.get("uA")?.name, "Alice");
});

Deno.test("a failed lookup later drops a kept name instead of keeping a stale one", async () => {
  const m = await load();
  m.rememberName("uA", "Alice");
  m.rememberName("uA", "uA");
  m.runTimers();
  await m.namesSaved();
  assertEquals([...m.saves[0].rows.keys()], []);
});

Deno.test("the picture token travels with the name, both ways", async () => {
  const m = await load();
  m.avatarTokens.set("uA", "tok-a");
  m.rememberName("uA", "Alice");
  m.runTimers();
  await m.namesSaved();
  assertEquals(m.saves[0].rows.get("uA")?.token, "tok-a");
  // A restart: the name makes no lookup, so only the file can bring the
  // token back -- without it the avatar on disk could not be shown.
  const n = await loadBlock<Module>("keptnames", PRELUDE);
  n.onDisk.set("uB", { name: "Bob", at: 1, token: "tok-b" });
  await n.loadKeptNames("ME");
  assertEquals(n.avatarTokens.get("uB"), "tok-b");
});

Deno.test("login reads this account's names without overriding fresh ones", async () => {
  const m = await loadBlock<Module>("keptnames", PRELUDE);
  m.onDisk.set("uA", { name: "Alice (kept)", at: 1 });
  m.onDisk.set("uB", { name: "Bob (kept)", at: 1 });
  m.nameCache.set("uB", "Bob (this session)");
  await m.loadKeptNames("ME");
  assertEquals(m.nameCache.get("uA"), "Alice (kept)");
  assertEquals(m.nameCache.get("uB"), "Bob (this session)");
});

Deno.test("a logout or account switch during the read applies nothing", async () => {
  const m = await loadBlock<Module>("keptnames", PRELUDE);
  m.onDisk.set("uA", { name: "Alice", at: 1 });
  m.switchDuringLoad("OTHER");
  await m.loadKeptNames("ME");
  assertEquals(m.nameCache.has("uA"), false);
});

Deno.test("logout writes what the session has not saved yet, under its account", async () => {
  const m = await load();
  m.rememberName("uA", "Alice");
  m.me.mid = ""; // logout clears me before it forgets the names
  m.forgetNames();
  await m.namesSaved();
  assertEquals(m.saves.length, 1);
  assertEquals(m.saves[0].owner, "ME");
  assertEquals(m.nameCache.size, 0);
  assertEquals(m.timers(), 0);
  // Nothing after it is written: there is no account to write it under.
  m.rememberName("uB", "Bob");
  m.runTimers();
  await m.namesSaved();
  assertEquals(m.saves.length, 1);
});

Deno.test("saves never overlap, and the newest snapshot lands last", async () => {
  const m = await load();
  const release = m.holdWrites();
  m.rememberName("uA", "Alice");
  m.runTimers(); // first save starts and stalls on the disk
  m.rememberName("uB", "Bob");
  m.runTimers(); // second save waits its turn
  release();
  await m.namesSaved();
  assertEquals(m.saves.length, 2);
  assertEquals([...m.saves[1].rows.keys()], ["uA", "uB"]);
});

Deno.test("a login waits for the logout's save before reading the file", async () => {
  const m = await loadBlock<Module>("keptnames", PRELUDE);
  m.onDisk.set("uA", { name: "Alice (old)", at: 1 });
  await m.loadKeptNames("ME");
  // The session learns the kept name is gone (the lookup failed / a rename).
  m.rememberName("uA", "uA");
  const release = m.holdWrites();
  m.forgetNames(); // logout: the save without uA is queued and stalls
  const relogin = m.loadKeptNames("ME"); // same account, right away
  release();
  await relogin;
  assertEquals(m.nameCache.has("uA"), false);
});
