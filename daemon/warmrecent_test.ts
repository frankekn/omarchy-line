/**
 * warmRecentChats(): the newest chats are converted before anyone taps them.
 *
 *   deno test -A warmrecent_test.ts
 *
 * The first open of each chat after a daemon start paid a decrypt and a name
 * lookup per sender. The first full round of a session now warms the most
 * recent chats from the store. The block is sliced verbatim from socket.ts.
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface Module {
  warmRecentChats(owner: object, generation: number): Promise<void>;
  owner: object;
  converted: string[];
  setChats(rows: Array<{ mid: string; lastTime: number }>): void;
  store(mid: string): void;
  restrict(): void;
  retireAfter(n: number): void;
}

const PRELUDE = `
type Client = object;
export const owner = {};
export const converted: string[] = [];
let chats: Array<{ mid: string; lastTime: number }> = [];
export function setChats(rows: typeof chats) { chats = rows; }
const stored = new Set<string>();
export function store(mid: string) { stored.add(mid); }
let restriction: unknown = null;
export function restrict() { restriction = { code: "ABUSE_BLOCK" }; }
let current = 1;
let retireAt = Infinity;
export function retireAfter(n: number) { retireAt = n; }
function sessionIsCurrent(c: unknown, g: number) { return c === owner && g === current; }
const me = { mid: "ME" };
const messageStore = {
  async tail(_me: string, mid: string, n: number) {
    return stored.has(mid) ? Array.from({ length: Math.min(n, 3) }, (_, i) => ({ id: mid + i })) : null;
  },
};
async function convertHistoryPage(_raws: unknown[], mid: string) {
  converted.push(mid);
  if (converted.length >= retireAt) current++;
  return [];
}
export { warmRecentChats };
`;

const load = () => loadBlock<Module>("warmrecent", PRELUDE);
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ mid: "c" + i, lastTime: i }));

Deno.test("the most recent stored chats are warmed, newest first", async () => {
  const m = await load();
  m.setChats(rows(20));
  for (let i = 0; i < 20; i++) if (i !== 18) m.store("c" + i);
  await m.warmRecentChats(m.owner, 1);
  // Twelve newest by lastTime; c18 has nothing stored, so it costs nothing.
  assertEquals(m.converted, [
    "c19",
    "c17",
    "c16",
    "c15",
    "c14",
    "c13",
    "c12",
    "c11",
    "c10",
    "c9",
    "c8",
  ]);
});

Deno.test("once per session", async () => {
  const m = await load();
  m.setChats(rows(2));
  m.store("c0");
  m.store("c1");
  await m.warmRecentChats(m.owner, 1);
  await m.warmRecentChats(m.owner, 1);
  assertEquals(m.converted.length, 2);
});

Deno.test("a restricted account warms nothing", async () => {
  const m = await load();
  m.setChats(rows(3));
  m.store("c0");
  m.restrict();
  await m.warmRecentChats(m.owner, 1);
  assertEquals(m.converted, []);
});

Deno.test("a logout mid-warm stops it", async () => {
  const m = await load();
  m.setChats(rows(5));
  for (let i = 0; i < 5; i++) m.store("c" + i);
  m.retireAfter(2);
  await m.warmRecentChats(m.owner, 1);
  assertEquals(m.converted.length, 2);
});
