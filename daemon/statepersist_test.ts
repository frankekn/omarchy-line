/** Session invalidation prevents queued state snapshots from reaching disk. */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface StatePersistModule {
  writes: string[];
  renames: number;
  removes: number;
  timingSamples: number[];
  sizeSamples: number[];
  release(): void;
  setLoginState(status: string): void;
  renameChat(name: string): void;
  blockStateWrites(): void;
  releaseStateWrites(): void;
  writeState(): Promise<void>;
  invalidateStateWrites(): Promise<void>;
  addEvent(seq: number, kind?: string): void;
  hide(mid: string): void;
  setNow(value: number): void;
}

async function mod(): Promise<StatePersistModule> {
  const prelude = `
type Json = Record<string, unknown>;
const STATE_PATH = "/state.json";
const BOOT_ID = "boot";
let me: Json = { mid: "old" };
let login: Json = { status: "ok" };
let chats: Json[] = [{ mid: "old-chat" }];
let chatsRevision = 1;
let chatListHealth: Json | null = null;
let events: Json[] = [];
let link: Json | null = null;
let refreshHealth: Json | null = null;
function refreshHealthValue() { return refreshHealth; }
let wanted: Json | null = null;
let now = 100;
const Date = { now: () => now };
const hidden = new Set<string>();
function hiddenStamped<T extends { mid: string }>(rows: T[]): T[] {
  return rows.map((row) => hidden.has(row.mid) ? { ...row, hidden: true } : row);
}
function noteStateWritten() {}
export const timingSamples: number[] = [];
const timings = {
  snapshot: () => timingSamples.length
    ? { "state.write": { last: timingSamples.at(-1) } }
    : {},
  record(key: string, elapsed: number) {
    if (key === "state.write") timingSamples.push(elapsed);
  },
};
// Same shape as the real SizeTracker, so the published block under test is
// the block a real daemon writes.
export const sizeSamples: number[] = [];
const pct = (sorted: number[], fraction: number) =>
  sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
const stateWriteBytes = {
  snapshot: () => {
    if (!sizeSamples.length) return null;
    const sorted = [...sizeSamples].sort((a, b) => a - b);
    return {
      samples: sizeSamples.length,
      last: sizeSamples[sizeSamples.length - 1],
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      max: sorted[sorted.length - 1],
    };
  },
  record(bytes: number) {
    sizeSamples.push(bytes);
  },
};
let unblock: () => void = () => {};
const gate = new Promise<void>((resolve) => { unblock = resolve; });
let first = true;
export const writes: string[] = [];
export let renames = 0;
export let removes = 0;
const Deno = {
  open(_path: string, _opts?: unknown) {
    return Promise.resolve({
      write(bytes: Uint8Array) {
        writes.push(new TextDecoder().decode(bytes));
        return Promise.resolve();
      },
      sync() {
        return Promise.resolve();
      },
      close() {},
    });
  },
  async writeTextFile(_path: string, text: string) {
    writes.push(text);
  },
  async rename() {
    renames++;
    if (first) { first = false; await gate; }
  },
  remove() { removes++; return Promise.resolve(); },
};
export function release() { unblock(); }
export function addEvent(seq: number, kind?: string) { events.push({ seq, kind }); }
export function renameChat(name: string) { chats = [{ mid: "old-chat", name }]; }
export function hide(mid: string) { hidden.add(mid); }
export function setNow(value: number) { now = value; }
export function setLoginState(status: string) {
  login = { status };
  if (status === "idle") { me = {}; chats = []; }
}
export {
  blockStateWrites,
  releaseStateWrites,
  writeState,
  invalidateStateWrites,
};
`;
  return await loadBlock<StatePersistModule>("statepersist", prelude);
}

Deno.test("queued snapshots from an ended session are skipped", async () => {
  const m = await mod();
  const active = m.writeState();
  m.addEvent(1);
  while (m.renames === 0) await Promise.resolve();
  const staleQueued = m.writeState();
  const invalidated = m.invalidateStateWrites();
  m.release();
  await invalidated;
  m.setLoginState("idle");
  const idle = m.writeState();
  m.setNow(500);
  await Promise.all([active, staleQueued, idle, invalidated]);

  assertEquals(m.writes.length, 2);
  const first = JSON.parse(m.writes[0]);
  const last = JSON.parse(m.writes[1]);
  assertEquals(first.login.status, "ok");
  // Events live in events.json now -- the ring's own file keeps half a
  // megabyte of message payloads out of every state write.
  assertEquals(first.events, undefined);
  assertEquals(first.timings, undefined);
  assertEquals(first.stateBytes, undefined);
  assertEquals(last.login.status, "idle");
  assertEquals(last.chats, []);
  assertEquals(last.events, undefined);
  assertEquals(last.updatedAt, 500);
  assertEquals(last.timings["state.write"].last, m.timingSamples[0]);
  assertEquals(m.timingSamples.length, 2);
  assertEquals(m.sizeSamples.length, 2);
  assertEquals(m.removes, 0);
  assertEquals(m.renames, 2);
});

Deno.test("a committed write publishes its timing on the next write", async () => {
  const m = await mod();
  const first = m.writeState();
  m.release();
  await first;
  assertEquals(m.timingSamples.length, 1);

  await m.writeState();
  const published = JSON.parse(m.writes[1]);
  assertEquals(
    published.timings["state.write"].last,
    m.timingSamples[0],
  );
});

Deno.test("stateBytes samples serialized bytes and publishes them one write later", async () => {
  const m = await mod();
  // CJK chat text is where UTF-16 code units diverge from UTF-8 bytes: the
  // sample must be what the file weighs, not what .length counts.
  m.renameChat("暱稱");
  const first = m.writeState();
  m.release();
  await first;
  assertEquals(m.sizeSamples.length, 1);
  assertEquals(
    m.sizeSamples[0],
    new TextEncoder().encode(m.writes[0]).length,
  );
  assertEquals(m.sizeSamples[0] > m.writes[0].length, true);
  // The first write cannot know its own size, so it publishes no block.
  assertEquals(JSON.parse(m.writes[0]).stateBytes, undefined);

  await m.writeState();
  assertEquals(JSON.parse(m.writes[1]).stateBytes, {
    samples: 1,
    last: m.sizeSamples[0],
    p50: m.sizeSamples[0],
    p95: m.sizeSamples[0],
    max: m.sizeSamples[0],
    chats: 1,
  });
});

Deno.test("an invalidated write never reaches the size window", async () => {
  const m = await mod();
  const active = m.writeState();
  // The first rename is gated; hold invalidation until this write is
  // mid-flight, so what gets tested is a write queued behind one that commits.
  while (m.renames === 0) await Promise.resolve();
  const staleQueued = m.writeState();
  const invalidated = m.invalidateStateWrites();
  m.release();
  await Promise.all([active, staleQueued, invalidated]);
  assertEquals(m.writes.length, 1);
  assertEquals(m.renames, 1);
  assertEquals(m.sizeSamples.length, 1);
  assertEquals(m.timingSamples.length, 1);
});

Deno.test("a queued snapshot stamps hidden preferences when it serializes", async () => {
  const m = await mod();
  const active = m.writeState();
  await Promise.resolve();
  const queued = m.writeState();
  m.hide("old-chat");
  m.release();
  await Promise.all([active, queued]);

  const last = JSON.parse(m.writes[1]);
  assertEquals(last.chats, [{ mid: "old-chat", hidden: true }]);
});

Deno.test("logout barrier blocks writes until terminal state is ready", async () => {
  const m = await mod();
  m.blockStateWrites();
  await m.invalidateStateWrites();

  // Models a heartbeat firing while logoutZ and local cleanup are in flight.
  await m.writeState();
  assertEquals(m.writes, []);
  assertEquals(m.renames, 0);

  m.setLoginState("idle");
  m.releaseStateWrites();
  m.release();
  await m.writeState();
  assertEquals(m.writes.length, 1);
  assertEquals(JSON.parse(m.writes[0]).login.status, "idle");
  assertEquals(JSON.parse(m.writes[0]).chats, []);
  assertEquals(m.renames, 1);
});
