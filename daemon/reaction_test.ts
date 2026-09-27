/**
 * Reactions, and the raw talk Operations the panel can draw.
 *
 *   deno test -A reaction_test.ts
 *
 * Two shapes have to meet here. History comes through linejs's thrift renamer,
 * which has already swapped MessageReactionType for its name, so a reaction
 * there reads {fromUserMid, reactionType:{predefinedReactionType:"NICE"}}. The
 * ops do not: NOTIFIED_SEND_REACTION's param2 is a JSON *string* straight off
 * LINE, where the same field is still the number 2. Both end up as one bar.
 *
 * The op parameters are positional and mean something different per type; the
 * layouts asserted below are linejs's own, from
 * vendor/linejs/example/_event/talk-class.ts (param[N] there is paramN here).
 * Every operation in this file is synthetic.
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock, loadBlocks } from "./slice_test.ts";

const PRELUDE = `
type Json = Record<string, unknown>;
interface PluginReaction { type: string; count: number; mine: boolean; }
export {
  REACTION_NAMES,
  REACTION_PICKABLE,
  reactionName,
  reactionsFromRaw,
  applyReaction,
  applyQueuedReactions,
  summariseReactions,
};
`;

const OP_PRELUDE = PRELUDE + `
export { talkOpEvent, talkMetadataChange, talkOpNeedsFullSync, chatMidOf };
`;

const ME = "u" + "0".repeat(31) + "1";
const PEER = "u" + "0".repeat(31) + "2";
const OTHER = "u" + "0".repeat(31) + "3";
const GROUP = "c" + "f".repeat(32);

interface PluginReaction {
  type: string;
  count: number;
  mine: boolean;
}
interface ReactionModule {
  REACTION_PICKABLE: string[];
  reactionName(raw: unknown): string;
  reactionsFromRaw(raw: unknown): Map<string, string>;
  applyReaction(byUser: Map<string, string>, mid: string, type: string): void;
  applyQueuedReactions(
    byUser: Map<string, string>,
    queued: Map<string, string> | undefined,
  ): Map<string, string>;
  summariseReactions(
    byUser: Map<string, string>,
    self: string,
  ): PluginReaction[];
}
interface OperationModule extends ReactionModule {
  talkMetadataChange(
    op: Record<string, unknown>,
    self: string,
  ): Record<string, unknown> | null;
  talkOpEvent(
    op: Record<string, unknown>,
    self: string,
  ): Record<string, unknown> | null;
  talkOpNeedsFullSync(op: Record<string, unknown>): boolean;
  chatMidOf(raw: Record<string, unknown>, self: string): string;
}
let R: ReactionModule | undefined;
async function reactions(): Promise<ReactionModule> {
  if (!R) R = await loadBlock<ReactionModule>("reactions", PRELUDE);
  return R;
}
let O: OperationModule | undefined;
async function ops(): Promise<OperationModule> {
  // talkop calls reactionName, so it is loaded on top of the real reactions
  // block rather than a stub of it -- the number-to-name mapping is exactly
  // the part of the op decoding that can be wrong.
  if (!O) {
    O = await loadBlocks<OperationModule>(["reactions", "talkop"], OP_PRELUDE);
  }
  return O;
}

/** One entry of `raw.reactions`, as the renamer hands it over. */
function raw(mid: string, type: string | number) {
  return {
    fromUserMid: mid,
    atMillis: 1_735_000_000_000,
    reactionType: { predefinedReactionType: type },
  };
}

Deno.test("the enum is read by name and by number", async () => {
  const m = await reactions();
  assertEquals(m.reactionName(2), "NICE");
  assertEquals(m.reactionName("NICE"), "NICE");
  assertEquals(m.reactionName(7), "OMG");
  // Anything outside the enum is not a reaction; the caller drops the row.
  assertEquals(m.reactionName(99), "");
  assertEquals(m.reactionName("THUMBSUP"), "");
  assertEquals(m.reactionName(undefined), "");
});

Deno.test("`react` accepts the six plus UNDO, never ALL", async () => {
  const m = await reactions();
  assertEquals(m.REACTION_PICKABLE, [
    "UNDO",
    "NICE",
    "LOVE",
    "FUN",
    "AMAZING",
    "SAD",
    "OMG",
  ]);
});

Deno.test("a raw list becomes one row per type, counted", async () => {
  const m = await reactions();
  const byUser = m.reactionsFromRaw([
    raw(PEER, "NICE"),
    raw(OTHER, "NICE"),
    raw(ME, "LOVE"),
  ]);
  assertEquals(m.summariseReactions(byUser, ME), [
    { type: "NICE", count: 2, mine: false },
    { type: "LOVE", count: 1, mine: true },
  ]);
});

Deno.test("rows come back in the enum's order, not arrival order", async () => {
  const m = await reactions();
  const byUser = m.reactionsFromRaw([raw(PEER, "OMG"), raw(OTHER, "NICE")]);
  // Otherwise the bar reshuffles under the user every time someone reacts.
  assertEquals(
    m.summariseReactions(byUser, ME).map((r: { type: string }) => r.type),
    ["NICE", "OMG"],
  );
});

Deno.test("one person counts once: a change moves their row", async () => {
  const m = await reactions();
  const byUser = m.reactionsFromRaw([raw(PEER, "NICE")]);
  m.applyReaction(byUser, PEER, "LOVE");
  assertEquals(m.summariseReactions(byUser, ME), [
    { type: "LOVE", count: 1, mine: false },
  ]);
});

Deno.test("UNDO removes the row and can empty the bar", async () => {
  const m = await reactions();
  const byUser = m.reactionsFromRaw([raw(PEER, "NICE"), raw(ME, "SAD")]);
  m.applyReaction(byUser, ME, "UNDO");
  assertEquals(m.summariseReactions(byUser, ME), [
    { type: "NICE", count: 1, mine: false },
  ]);
  m.applyReaction(byUser, PEER, "UNDO");
  assertEquals(byUser.size, 0);
  assertEquals(m.summariseReactions(byUser, ME), []);
});

Deno.test("queued reaction operations override an older message snapshot", async () => {
  const m = await reactions();
  const byUser = m.reactionsFromRaw([raw(PEER, "NICE"), raw(ME, "SAD")]);
  m.applyQueuedReactions(
    byUser,
    new Map([
      [PEER, "LOVE"],
      [ME, "UNDO"],
    ]),
  );
  assertEquals(m.summariseReactions(byUser, ME), [
    { type: "LOVE", count: 1, mine: false },
  ]);
});

Deno.test("junk in the raw list costs only its own row", async () => {
  const m = await reactions();
  const byUser = m.reactionsFromRaw([
    raw("", "NICE"),
    { fromUserMid: PEER },
    raw(OTHER, 99),
    raw(ME, "NICE"),
  ]);
  assertEquals(m.summariseReactions(byUser, ME), [
    { type: "NICE", count: 1, mine: true },
  ]);
  assertEquals(m.reactionsFromRaw(undefined).size, 0);
});

Deno.test("NOTIFIED_READ_MESSAGE is chat, reader, message id", async () => {
  const m = await ops();
  assertEquals(
    m.talkOpEvent({
      type: "NOTIFIED_READ_MESSAGE",
      param1: GROUP,
      param2: PEER,
      param3: "18000000000001",
    }, ME),
    { kind: "read", chat: GROUP, messageId: "18000000000001", by: PEER },
  );
});

Deno.test("SEND_CHAT_CHECKED is us reading from another device", async () => {
  const m = await ops();
  // It carries no reader at all -- param2 is the message id -- so the only
  // way to file it under the right person is to know it is always us.
  assertEquals(
    m.talkOpEvent({
      type: "SEND_CHAT_CHECKED",
      param1: PEER,
      param2: "18000000000002",
    }, ME),
    { kind: "read", chat: PEER, messageId: "18000000000002", by: ME },
  );
});

/** What the readop block needs around it: the state it mutates, and our mid. */
const READOP_PRELUDE = `
type Json = Record<string, unknown>;
interface PluginEvent {
  kind: "read";
  chat: string;
  by?: string;
  upTo?: string;
}
const me: Json = { mid: "${ME}" };
const readRanges = new Map<string, Map<string, bigint>>();
const readIndex = new Map<string, bigint[]>();
export { applyReadOp, readRanges, readIndex };
`;

interface ReadEvent {
  kind: "read";
  chat: string;
  by?: string;
  upTo?: string;
}
interface ReadOpModule {
  readRanges: Map<string, Map<string, bigint>>;
  readIndex: Map<string, bigint[]>;
  applyReadOp(
    ev: { chat: string; messageId: string; by?: string },
  ): ReadEvent | null;
}
let RO: ReadOpModule | undefined;
async function readOps(): Promise<ReadOpModule> {
  if (!RO) {
    // applyReadOp folds ops into the daemon's real range state, so it is
    // loaded on top of the real readrange block for asMessageId rather than a
    // stub of it; the state it mutates comes from the prelude.
    RO = await loadBlocks<ReadOpModule>(
      ["readrange", "readop"],
      READOP_PRELUDE,
    );
  }
  return RO;
}

Deno.test("our own read cursor advances the range but is not announced", async () => {
  const m = await readOps();
  m.readIndex.set(PEER, [1n]);
  // op 40, by=us: the cursor is real state -- history rendering reads it --
  // so it lands in readRanges and knocks the stale index out...
  const self = m.applyReadOp({
    chat: PEER,
    messageId: "18000000000006",
    by: ME,
  });
  assertEquals(m.readRanges.get(PEER), new Map([[ME, 18000000000006n]]));
  assertEquals(m.readIndex.has(PEER), false);
  // ...but it says "we read theirs, elsewhere", never "someone read ours":
  // announced as a read event, a 1:1 would paint our own bubbles 已讀.
  assertEquals(self, null);
  // A peer's op 55 through the same path is announced exactly as before.
  assertEquals(
    m.applyReadOp({ chat: PEER, messageId: "18000000000007", by: PEER }),
    { kind: "read", chat: PEER, by: PEER, upTo: "18000000000007" },
  );
  // An old self op replayed off a reconnect moves nothing and says nothing.
  assertEquals(
    m.applyReadOp({ chat: PEER, messageId: "18000000000001", by: ME }),
    null,
  );
  assertEquals(m.readRanges.get(PEER)?.get(ME), 18000000000006n);
});

Deno.test("a reaction op hides the chat and the type inside param2", async () => {
  const m = await ops();
  assertEquals(
    m.talkOpEvent({
      type: "NOTIFIED_SEND_REACTION",
      param1: "18000000000003",
      param2: JSON.stringify({
        chatMid: GROUP,
        curr: { predefinedReactionType: 3 },
        prev: { predefinedReactionType: 0 },
      }),
      param3: PEER,
    }, ME),
    {
      kind: "reaction",
      chat: GROUP,
      messageId: "18000000000003",
      by: PEER,
      reaction: "LOVE",
    },
  );
});

Deno.test("our own reaction op names nobody, so it is ours", async () => {
  const m = await ops();
  const ev = m.talkOpEvent({
    type: "SEND_REACTION",
    param1: "18000000000004",
    param2: JSON.stringify({
      chatMid: GROUP,
      curr: { predefinedReactionType: 1 },
    }),
    param3: "",
  }, ME);
  assert(ev);
  assertEquals(ev.by, ME);
  // UNDO survives the decode; applyReaction is what turns it into a removal.
  assertEquals(ev.reaction, "UNDO");
});

Deno.test("both destroy ops are chat then message id", async () => {
  const m = await ops();
  for (const type of ["DESTROY_MESSAGE", "NOTIFIED_DESTROY_MESSAGE"]) {
    assertEquals(
      m.talkOpEvent({ type, param1: GROUP, param2: "18000000000005" }, ME),
      { kind: "unsend", chat: GROUP, messageId: "18000000000005" },
    );
  }
});

Deno.test("chat and profile metadata changes name the cache entry to invalidate", async () => {
  const m = await ops();
  assertEquals(
    m.talkMetadataChange({ type: "NOTIFIED_UPDATE_CHAT", param1: GROUP }, ME),
    { kind: "chat", mid: GROUP },
  );
  assertEquals(
    m.talkMetadataChange({ type: "NOTIFIED_UPDATE_PROFILE", param1: PEER }, ME),
    { kind: "profile", mid: PEER },
  );
  assertEquals(
    m.talkMetadataChange({ type: "UPDATE_PROFILE" }, ME),
    { kind: "profile", mid: ME },
  );
  assertEquals(
    m.talkMetadataChange({ type: "NOTIFIED_UPDATE_CHAT" }, ME),
    null,
  );
  assertEquals(m.talkMetadataChange({ type: "RECEIVE_MESSAGE" }, ME), null);
});

Deno.test("ops we do not draw, and broken ones, map to nothing", async () => {
  const m = await ops();
  for (
    const op of [
      { type: "NOTIFIED_UPDATE_PROFILE", param1: PEER, param2: "1" },
      { type: "RECEIVE_MESSAGE", param1: GROUP, param2: "1", param3: "2" },
      // A read op missing any of its three params says nothing usable.
      { type: "NOTIFIED_READ_MESSAGE", param1: GROUP, param2: PEER },
      // param2 has to parse, and has to name a chat.
      { type: "NOTIFIED_SEND_REACTION", param1: "1", param2: "not json" },
      { type: "NOTIFIED_SEND_REACTION", param1: "1", param2: "{}" },
      { type: "NOTIFIED_DESTROY_MESSAGE", param1: GROUP },
      {},
    ]
  ) {
    assertEquals(m.talkOpEvent(op, ME), null, JSON.stringify(op));
  }
});

Deno.test("a force-sync op asks for the full round and nothing else does", async () => {
  const m = await ops();
  assertEquals(m.talkOpNeedsFullSync({ type: "NOTIFIED_FORCE_SYNC" }), true);
  for (
    const type of [
      "RECEIVE_MESSAGE",
      "NOTIFIED_READ_MESSAGE",
      "NOTIFIED_DESTROY_MESSAGE",
      "EDIT_MESSAGE",
      "NOTIFIED_TYPING",
      "FAILED_SEND_MESSAGE",
    ]
  ) {
    assertEquals(m.talkOpNeedsFullSync({ type }), false, type);
  }
  assertEquals(m.talkOpNeedsFullSync({}), false);
});

Deno.test("a 1:1 box is keyed by the peer, whoever spoke", async () => {
  const m = await ops();
  // toType USER means `to` is whoever received it, so our own message points
  // at the peer and theirs points at us; the panel's box is the peer both ways.
  assertEquals(chatOf(m, { toType: "USER", from: PEER, to: ME }), PEER);
  assertEquals(chatOf(m, { toType: "USER", from: ME, to: PEER }), PEER);
  // The thrift enum can arrive unrenamed; USER is 0.
  assertEquals(chatOf(m, { toType: "0", from: PEER, to: ME }), PEER);
  // A group names itself in `to`.
  assertEquals(chatOf(m, { toType: "GROUP", from: PEER, to: GROUP }), GROUP);
});

function chatOf(m: OperationModule, raw: Record<string, string>): string {
  return m.chatMidOf(raw, ME);
}
