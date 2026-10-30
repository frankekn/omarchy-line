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
  noteKeptNameUsed(mid: string): void;
  onNameChanged(listener: (mids: string[]) => void): void;
  asked: { contacts: string[][]; chats: string[][] };
  lineSays: Map<string, { name: string; token?: string }>;
  restrict(): void;
  renameWhileAsking(mid: string): void;
  settle(): Promise<void>;
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
// What the confirmation reaches for.
export const asked = { contacts: [] as string[][], chats: [] as string[][] };
export const lineSays = new Map<string, { name: string; token?: string }>();
export let restriction: unknown = null;
export function restrict() { restriction = { code: "ABUSE_BLOCK" }; }
let renameDuringAsk: string | null = null;
export function renameWhileAsking(mid: string) { renameDuringAsk = mid; }
export const nameCacheEpoch = new Map<string, number>();
const CONTACT_BATCH = 100;
function midKind(mid: string) { return mid.startsWith("c") ? "group" : "user"; }
function isMe(mid: string) { return mid === "ME"; }
function noteNameFailure() {}
function errorLine(e: unknown) { return String(e); }
function noteAvatar(mid: string, src: unknown) {
  const t = (src as { picturePath?: string } | undefined)?.picturePath;
  if (t) avatarTokens.set(mid, t); else avatarTokens.delete(mid);
}
const answer = (mid: string) => {
  if (renameDuringAsk === mid) nameCacheEpoch.set(mid, 1);
  return lineSays.get(mid);
};
export const owner = {
  base: { talk: {
    async getContactsV2({ mids }: { mids: string[] }) {
      asked.contacts.push(mids);
      const contacts: Record<string, unknown> = {};
      for (const mid of mids) {
        const a = answer(mid);
        if (a) contacts[mid] = { contact: { displayName: a.name, picturePath: a.token } };
      }
      return { contacts };
    },
    async getChats({ chatMids }: { chatMids: string[] }) {
      asked.chats.push(chatMids);
      return { chats: chatMids.flatMap((mid) => {
        const a = answer(mid);
        return a ? [{ chatMid: mid, chatName: a.name, picturePath: a.token }] : [];
      }) };
    },
  } },
};
const client = owner;
const sessionGeneration = 1;
function sessionIsCurrent(c: unknown, g: number) { return c === owner && g === 1; }
export const changes: string[][] = [];
let queued: Array<() => void> = [];
function setTimeout(fn: () => void, _ms: number) { queued.push(fn); return queued.length; }
function clearTimeout(_id: number) { queued = []; }
export function runTimers() { const q = queued; queued = []; for (const f of q) f(); }
export async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
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

async function keptSession(rows: Record<string, Kept>) {
  const m = await loadBlock<Module>("keptnames", PRELUDE);
  for (const [mid, k] of Object.entries(rows)) m.onDisk.set(mid, k);
  await m.loadKeptNames("ME");
  const changed: string[][] = [];
  m.onNameChanged((mids) => changed.push(mids));
  return { m, changed };
}

Deno.test("a kept name is served at once and confirmed once, in one batch", async () => {
  const { m, changed } = await keptSession({
    uA: { name: "Alice", at: 1 },
    cG: { name: "Family", at: 1 },
  });
  m.lineSays.set("uA", { name: "Alice" });
  m.lineSays.set("cG", { name: "Family" });
  m.noteKeptNameUsed("uA");
  m.noteKeptNameUsed("uA"); // shown twice, asked once
  m.noteKeptNameUsed("cG");
  m.runTimers();
  await m.settle();
  assertEquals(m.asked.contacts, [["uA"]]);
  assertEquals(m.asked.chats, [["cG"]]);
  assertEquals(changed, []); // nothing moved: no refresh
  m.noteKeptNameUsed("uA"); // later in the same session: never again
  m.runTimers();
  await m.settle();
  assertEquals(m.asked.contacts.length, 1);
});

Deno.test("a rename or new picture made while the daemon was off is caught", async () => {
  const { m, changed } = await keptSession({
    uA: { name: "Alice", at: 1, token: "old" },
    uB: { name: "Bob", at: 1, token: "same" },
  });
  m.avatarTokens.set("uA", "old");
  m.avatarTokens.set("uB", "same");
  m.lineSays.set("uA", { name: "Alice", token: "new" }); // new picture only
  m.lineSays.set("uB", { name: "Robert", token: "same" }); // renamed
  m.noteKeptNameUsed("uA");
  m.noteKeptNameUsed("uB");
  m.runTimers();
  await m.settle();
  assertEquals(m.nameCache.get("uB"), "Robert");
  assertEquals(m.avatarTokens.get("uA"), "new");
  assertEquals(changed, [["uA", "uB"]]);
});

Deno.test("a name nobody shows is never asked about", async () => {
  const { m } = await keptSession({ uA: { name: "Alice", at: 1 } });
  m.runTimers();
  await m.settle();
  assertEquals(m.asked.contacts, []);
});

Deno.test("names LINE already answered this session are not confirmed again", async () => {
  const { m } = await keptSession({ uA: { name: "Alice", at: 1 } });
  m.rememberName("uA", "Alice"); // e.g. a member list lookup
  m.noteKeptNameUsed("uA");
  m.runTimers();
  await m.settle();
  assertEquals(m.asked.contacts, []);
});

Deno.test("a restricted account confirms nothing", async () => {
  const { m } = await keptSession({ uA: { name: "Alice", at: 1 } });
  m.restrict();
  m.noteKeptNameUsed("uA");
  m.runTimers();
  await m.settle();
  assertEquals(m.asked.contacts, []);
});

Deno.test("a rename operation during the ask wins over the answer", async () => {
  const { m, changed } = await keptSession({ uA: { name: "Alice", at: 1 } });
  m.lineSays.set("uA", { name: "Old answer" });
  m.renameWhileAsking("uA");
  m.noteKeptNameUsed("uA");
  m.runTimers();
  await m.settle();
  assertEquals(m.nameCache.get("uA"), "Alice");
  assertEquals(changed, []);
});
