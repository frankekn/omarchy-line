/**
 * Opening a chat from the local store: the page goes out before the read
 * range lands, so the background half owns 已讀.
 *
 *   deno test -A historyopen_test.ts
 *
 * `history` used to await getMessageReadRange before it even looked at the
 * store, so every open paid a LINE round trip the store already made
 * unnecessary. Now the range is started, not awaited. These tests pin what
 * that moved into the background: a late range can never pull a cursor back,
 * the served page still gets its 已讀 when the re-fetch fails, two background
 * paths publish one event between them, and nothing reaches the event stream
 * after a logout. The blocks are the daemon's own, sliced verbatim.
 */
import { assertEquals } from "@std/assert";
import { loadBlocks } from "./slice_test.ts";

const ME = "u" + "0".repeat(31) + "1";
const PEER = "u" + "0".repeat(31) + "2";
const CHAT = "c" + "0".repeat(31) + "9";

interface Msg {
  id: string;
  text: string;
  readBy?: { count: number; all: boolean };
}
interface Module {
  revalidateHistory(
    chat: string,
    count: number,
    owner: unknown,
    generation: number,
    served: Msg[] | null,
    servedRaws?: unknown[],
    readRangeLoad?: Promise<void> | null,
  ): Promise<void>;
  loadReadRange(
    chat: string,
    owner: unknown,
    generation: number,
  ): Promise<void>;
  owner: unknown;
  events: Array<{ kind: string; chat: string; messages: Msg[] }>;
  errors: string[];
  readRanges: Map<string, Map<string, bigint>>;
  setRange(entries: Record<string, bigint>): void;
  setPage(ids: string[]): void;
  failFetch(): void;
  setCursor(): void;
  retireOnConvert(): void;
  store(rows: Array<{ id: string; text?: string }>): void;
  setEdit(id: string, text: string): void;
}

const PRELUDE = `
type Json = Record<string, unknown>;
interface PluginReadBy { count: number; all: boolean; }
interface PluginMessage { id: string; text: string; readBy?: PluginReadBy; unsent?: boolean; edited?: boolean; reactions?: unknown[] }
type Client = typeof owner;
export const events: Array<{ kind: string; chat: string; messages: PluginMessage[] }> = [];
export const readRanges = new Map<string, Map<string, bigint>>();
const readIndex = new Map<string, unknown>();
let range: Record<string, bigint> = {};
let page: string[] = [];
let edits: Record<string, string> = {};
export function setEdit(id: string, text: string) { edits[id] = text; }
let fetchFails = false;
let retire = false;
let current = 1;
const cursors = new Map<string, { chat: string; messageId: string; deliveredTime: number }>();
export function setRange(entries: Record<string, bigint>) { range = entries; }
export function setPage(ids: string[]) { page = ids; }
export function failFetch() { fetchFails = true; }
export function setCursor() {
  cursors.set("box:${CHAT}", { chat: "${CHAT}", messageId: "x", deliveredTime: 0 });
}
export function retireOnConvert() { retire = true; }
export const owner = {
  base: {
    talk: {
      getMessageReadRange: async () => [{ chatId: "${CHAT}", ranges: range }],
      getPreviousMessagesV2WithRequest: async () => {
        if (fetchFails) throw new Error("timeout");
        // Newest-first, like LINE.
        return page.map((id) => ({ id, text: edits[id] ?? id })).reverse();
      },
    },
  },
};
function sessionIsCurrent(c: unknown, generation: number) {
  return c === owner && generation === current;
}
function readRangeToMap(entry: { ranges: Record<string, bigint> }) {
  return new Map(Object.entries(entry.ranges));
}
const me: Json = { mid: "${ME}" };
const stored = new Map<string, { id: string; text?: string }>();
const messageStore = {
  // The real store's contract: the held record per row, in order.
  append(_me: string, _chat: string, rows: Array<{ id: string; text?: string }>) {
    for (const r of rows) stored.set(r.id, r);
    return rows.map((r) => stored.get(r.id)!);
  },
  async tail(_me: string, _chat: string, n: number) {
    const rows = [...stored.values()].sort((a, b) => Number(a.id) - Number(b.id));
    return rows.slice(-n);
  },
};
export function store(rows: Array<{ id: string; text?: string }>) {
  messageStore.append("", "", rows);
}
function rememberPaginationCursor() {}
// 已讀 N: how many members' cursors are at or past the message.
async function convertHistoryPage(raws: unknown[], chat: string): Promise<PluginMessage[] | null> {
  const ranges = readRanges.get(chat) ?? new Map<string, bigint>();
  const out = (raws as Array<{ id: string }>).map((r) => {
    const count = [...ranges.entries()].filter(([mid, id]) => mid !== "${ME}" && id >= BigInt(r.id)).length;
    const text = (r as { text?: string }).text ?? r.id;
    return count ? { id: r.id, text, readBy: { count, all: false } } : { id: r.id, text };
  });
  await Promise.resolve();
  if (retire) current++;
  return out;
}
function pushEvent(ev: { kind: string; chat: string; messages: PluginMessage[] }) { events.push(ev); }
// Recorded, not dropped: a success path that throws inside the outer catch
// would otherwise pass every assertion that only checks for silence.
export const errors: string[] = [];
const console = { error(...args: unknown[]) { errors.push(args.map(String).join(" ")); } };
function errorLine(e: unknown) { return String(e); }
export { loadReadRange, revalidateHistory };
`;

async function load(): Promise<Module> {
  return await loadBlocks<Module>(["rangeload", "revalidate"], PRELUDE);
}

const raws = (ids: string[]) => ids.map((id) => ({ id }));
const plain = (ids: string[]): Msg[] => ids.map((id) => ({ id, text: id }));

Deno.test("a range that lands late never pulls a cursor back", async () => {
  const m = await load();
  m.readRanges.set(CHAT, new Map([[ME, 120n], [PEER, 90n]]));
  m.setRange({ [ME]: 100n, [PEER]: 110n });
  await m.loadReadRange(CHAT, m.owner, 1);
  assertEquals(m.readRanges.get(CHAT)?.get(ME), 120n);
  assertEquals(m.readRanges.get(CHAT)?.get(PEER), 110n);
});

Deno.test("a failed re-fetch still publishes the 已讀 the range brought", async () => {
  const m = await load();
  m.setCursor();
  m.failFetch();
  m.setRange({ [PEER]: 2n });
  const load1 = m.loadReadRange(CHAT, m.owner, 1);
  await m.revalidateHistory(
    CHAT,
    60,
    m.owner,
    1,
    plain(["1", "2"]),
    raws(["1", "2"]),
    load1,
  );
  assertEquals(m.events.length, 1);
  assertEquals(m.events[0].messages.map((x) => x.readBy?.count ?? 0), [1, 1]);
});

Deno.test("an unchanged page publishes nothing", async () => {
  const m = await load();
  m.setCursor();
  m.setPage(["1", "2"]);
  const load1 = m.loadReadRange(CHAT, m.owner, 1);
  await m.revalidateHistory(
    CHAT,
    60,
    m.owner,
    1,
    plain(["1", "2"]),
    raws(["1", "2"]),
    load1,
  );
  assertEquals(m.events.length, 0);
  assertEquals(m.errors, []);
});

Deno.test("two background paths for one chat publish the same page once", async () => {
  const m = await load();
  m.setCursor();
  m.setPage(["1", "2"]);
  m.setRange({ [PEER]: 2n });
  const first = m.revalidateHistory(
    CHAT,
    60,
    m.owner,
    1,
    plain(["1", "2"]),
    raws(["1", "2"]),
    m.loadReadRange(CHAT, m.owner, 1),
  );
  const second = m.revalidateHistory(
    CHAT,
    60,
    m.owner,
    1,
    plain(["1", "2"]),
    raws(["1", "2"]),
    m.loadReadRange(CHAT, m.owner, 1),
  );
  await Promise.all([first, second]);
  assertEquals(m.events.length, 1);
  assertEquals(m.errors, []);
});

Deno.test("a conversion that straddles a logout publishes nothing", async () => {
  const m = await load();
  m.setRange({ [PEER]: 2n });
  m.retireOnConvert();
  // No box cursor: the republish path.
  const load1 = m.loadReadRange(CHAT, m.owner, 1);
  await m.revalidateHistory(
    CHAT,
    60,
    m.owner,
    1,
    plain(["1", "2"]),
    raws(["1", "2"]),
    load1,
  );
  assertEquals(m.events.length, 0);
});

Deno.test("a slower open's republish neither repeats nor rolls back a newer page", async () => {
  const m = await load();
  m.setCursor();
  m.store(raws(["1", "2"]));
  m.setPage(["1", "2"]);
  m.setEdit("2", "edited");
  m.setRange({ [PEER]: 2n });
  let release = () => {};
  const slowRange = new Promise<void>((r) => release = r)
    .then(() => m.loadReadRange(CHAT, m.owner, 1));
  // Open 1 owns the re-fetch; open 2 is served next and waits on its range.
  const first = m.revalidateHistory(
    CHAT,
    60,
    m.owner,
    1,
    plain(["1", "2"]),
    raws(["1", "2"]),
    m.loadReadRange(CHAT, m.owner, 1),
  );
  const second = m.revalidateHistory(
    CHAT,
    60,
    m.owner,
    1,
    plain(["1", "2"]),
    raws(["1", "2"]),
    slowRange,
  );
  await first;
  release();
  await second;
  assertEquals(m.events.length, 1);
  assertEquals(m.events[0].messages[1].text, "edited");
  assertEquals(m.errors, []);
});
