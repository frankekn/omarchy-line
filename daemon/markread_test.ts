/**
 * markChatRead(): the one place `history markRead` and the `markRead` command
 * tell LINE a chat was read.
 *
 *   deno test -A markread_test.ts
 *
 * The panel asks on every message that lands in an open chat. Each check that
 * goes out forces a full getMessageBoxes round, and the first version also
 * fired that round on the spot (outside the debouncer) for chats that had
 * nothing left to read -- so one incoming message cost a full round for the
 * check plus another for its op 40 echo. These tests pin what may skip the
 * network, what a send records, and that the round goes through the debouncer.
 * The block is the daemon's own, sliced verbatim; asMessageId is the real
 * readrange block's.
 */
import { assertEquals } from "@std/assert";
import { loadBlocks } from "./slice_test.ts";

const ME = "u" + "0".repeat(31) + "1";
const PEER = "u" + "0".repeat(31) + "2";

interface MarkReadModule {
  markChatRead(
    owner: unknown,
    generation: number,
    chat: string,
    upTo: string,
  ): Promise<boolean | null>;
  markReadArgs(
    req: Record<string, unknown>,
  ): { chat: string; upTo: string } | { error: string };
  owner: unknown;
  calls: {
    reqseq: number;
    sent: Array<{ chatMid: string; lastMessageId: string; seq: number }>;
    scheduled: number;
    immediate: number;
    errors: string[];
  };
  forceFull(): boolean;
  ownCursor(chat: string): bigint | undefined;
  seedOwnCursor(chat: string, upTo: bigint): void;
  seedRow(chat: string, unread: number): void;
  seedPending(chat: string, pending: number): void;
  failSend(): void;
  retireDuringSend(): void;
}

const PRELUDE = `
type Json = Record<string, unknown>;
interface PluginReadBy { count: number; all: boolean; }
type Client = typeof owner;
export const calls = {
  reqseq: 0,
  sent: [] as Array<{ chatMid: string; lastMessageId: string; seq: number }>,
  scheduled: 0,
  immediate: 0,
  errors: [] as string[],
};
let sendFails = false;
let retire = false;
let current = 1;
export const owner = {
  base: {
    getReqseq: async () => ++calls.reqseq,
    talk: {
      sendChatChecked: async (
        args: { chatMid: string; lastMessageId: string; seq: number },
      ) => {
        calls.sent.push(args);
        if (retire) current++;
        if (sendFails) throw new Error("boom");
      },
    },
  },
};
function sessionIsCurrent(c: unknown, generation: number) {
  return c === owner && generation === current;
}
const me: Json = { mid: "${ME}" };
const readRanges = new Map<string, Map<string, bigint>>();
let chats: Array<{ mid: string; unread: number }> = [];
const dirtyMids = new Map<string, { reason: string; pending: number }>();
let forceFullRefresh = false;
function setForceFullRefresh(value: boolean) { forceFullRefresh = value; }
function scheduleRefresh() { calls.scheduled++; }
// Not called by the block: the immediate round it used to fire.
export function refreshChats() { calls.immediate++; }
const console = { error: (...args: unknown[]) => calls.errors.push(args.join(" ")) };
export function forceFull() { return forceFullRefresh; }
export function ownCursor(chat: string) {
  return readRanges.get(chat)?.get("${ME}");
}
export function seedOwnCursor(chat: string, upTo: bigint) {
  let ranges = readRanges.get(chat);
  if (!ranges) readRanges.set(chat, ranges = new Map());
  ranges.set("${ME}", upTo);
}
export function seedRow(chat: string, unread: number) {
  chats = [...chats.filter((c) => c.mid !== chat), { mid: chat, unread }];
}
export function seedPending(chat: string, pending: number) {
  dirtyMids.set(chat, { reason: "message", pending });
}
export function failSend() { sendFails = true; }
export function retireDuringSend() { retire = true; }
export { markChatRead, markReadArgs };
`;

async function load(): Promise<MarkReadModule> {
  return await loadBlocks<MarkReadModule>(["readrange", "markread"], PRELUDE);
}

Deno.test("an own cursor already at or past upTo skips the network", async () => {
  const m = await load();
  m.seedRow(PEER, 3);
  m.seedOwnCursor(PEER, 18000000000010n);
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), false);
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000009"), false);
  assertEquals(m.calls.reqseq, 0);
  assertEquals(m.calls.sent, []);
  assertEquals(m.calls.scheduled, 0);
  assertEquals(m.forceFull(), false);
});

Deno.test("a row with no unread and no booked debt skips the network", async () => {
  const m = await load();
  m.seedRow(PEER, 0);
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), false);
  assertEquals(m.calls.reqseq, 0);
  assertEquals(m.calls.sent, []);
  assertEquals(m.calls.scheduled, 0);
});

Deno.test("unread 0 with pending push debt still sends", async () => {
  const m = await load();
  // A push repainted the row without touching `unread`; the message it shows
  // is uncounted, not read.
  m.seedRow(PEER, 0);
  m.seedPending(PEER, 1);
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), true);
  assertEquals(m.calls.sent.length, 1);
});

Deno.test("a chat with no row is not taken as read", async () => {
  const m = await load();
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), true);
  assertEquals(m.calls.sent.length, 1);
});

Deno.test("a send records the cursor and books exactly one debounced full round", async () => {
  const m = await load();
  m.seedRow(PEER, 2);
  m.seedOwnCursor(PEER, 18000000000005n);
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), true);
  assertEquals(m.calls.sent, [{
    chatMid: PEER,
    lastMessageId: "18000000000010",
    seq: 1,
  }]);
  assertEquals(m.ownCursor(PEER), 18000000000010n);
  assertEquals(m.forceFull(), true);
  assertEquals(m.calls.scheduled, 1);
  assertEquals(m.calls.immediate, 0);
  // The row still says 2 until that round lands; the recorded cursor is what
  // stops the next ask for the same message.
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), false);
  assertEquals(m.calls.sent.length, 1);
  assertEquals(m.calls.scheduled, 1);
});

Deno.test("a send never moves the own cursor backwards", async () => {
  const m = await load();
  m.seedRow(PEER, 2);
  // The op 40 echo of a later read can land while this send is in flight.
  const pending = m.markChatRead(m.owner, 1, PEER, "18000000000010");
  m.seedOwnCursor(PEER, 18000000000012n);
  assertEquals(await pending, true);
  assertEquals(m.ownCursor(PEER), 18000000000012n);
});

Deno.test("a refused send is logged and records nothing", async () => {
  const m = await load();
  m.seedRow(PEER, 2);
  m.failSend();
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), false);
  assertEquals(m.calls.sent.length, 1);
  assertEquals(m.calls.errors, ["[read] boom"]);
  assertEquals(m.ownCursor(PEER), undefined);
  assertEquals(m.forceFull(), false);
  assertEquals(m.calls.scheduled, 0);
});

Deno.test("a retired session answers null and records nothing", async () => {
  const m = await load();
  m.seedRow(PEER, 2);
  assertEquals(await m.markChatRead(m.owner, 0, PEER, "18000000000010"), null);
  assertEquals(m.calls.reqseq, 0);
  m.retireDuringSend();
  assertEquals(await m.markChatRead(m.owner, 1, PEER, "18000000000010"), null);
  assertEquals(m.ownCursor(PEER), undefined);
  assertEquals(m.calls.scheduled, 0);
});

Deno.test("markRead arguments: a chat id and a decimal message id string", async () => {
  const m = await load();
  assertEquals(
    m.markReadArgs({ cmd: "markRead", chat: PEER, upTo: "18000000000010" }),
    { chat: PEER, upTo: "18000000000010" },
  );
  for (const chat of [undefined, "", "../x", "a b", "x".repeat(129)]) {
    assertEquals(
      m.markReadArgs({ chat, upTo: "1" }),
      { error: "不支援的聊天室" },
      String(chat),
    );
  }
  // A JSON number is refused: a 64-bit id past 2^53 has already been rounded.
  for (
    const upTo of [undefined, "", "abc", "-1", "1.5", " 1", 18000000000010]
  ) {
    assertEquals(
      m.markReadArgs({ chat: PEER, upTo }),
      { error: "訊息 id 不對" },
      String(upTo),
    );
  }
});
