/**
 * getMessageReadRange -> the `readBy` field, i.e. 已讀 / 已讀 N.
 *
 *   deno test -A readrange_test.ts
 *
 * The wire shape is the whole difficulty, and the first version got it wrong:
 * `readBy` was absent on every message of a live account. TMessageReadRange is
 * {chatId, ranges}, `ranges` maps a member mid onto TMessageReadRangeEntry --
 * but the thrift renamer has no definition for that map's value type ("th" in
 * vendor/linejs packages/types/thrift.ts:24469), so two things happen at once:
 *
 *   - the entry's fields stay bare field ids (1 startMessageId, 2 endMessageId,
 *     3 startTime, 4 endTime) instead of names, and
 *   - the *list* wrapping them is not an Array either. It is an object keyed by
 *     its own indices, so a member's value is `{"0": {"1":…, "2":…}}`.
 *
 * MEASURED_ONE_TO_ONE and MEASURED_GROUP below are the two shapes taken off a
 * real account (structure only, ids and mids replaced): the end id came back a
 * bigint in a 1:1 and a plain number in a group. A struct's field ids start at
 * 1 and a decoded list always starts at 0, which is the only thing telling the
 * two apart -- nothing here may look at how big a number is, because a 13-digit
 * endTime is indistinguishable from a message id by magnitude.
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const PRELUDE = `
type Json = Record<string, unknown>;
interface PluginReadBy { count: number; all: boolean; }
export {
  asMessageId,
  indexedEntries,
  rangeEndId,
  lastReadOf,
  readRangeToMap,
  readIndexOf,
  readByAt,
};
`;

const ME = "u" + "0".repeat(31) + "1";
const A = "u" + "0".repeat(31) + "2";
const B = "u" + "0".repeat(31) + "3";
const MINE = "18000000000010";
const OLDER = "18000000000005";
const NEWER = "18000000000020";

interface PluginReadBy {
  count: number;
  all: boolean;
}
interface ReadRangeModule {
  asMessageId(raw: unknown): bigint | null;
  indexedEntries(raw: unknown): unknown[] | null;
  rangeEndId(raw: unknown): bigint | null;
  lastReadOf(raw: unknown): bigint | null;
  readRangeToMap(raw: unknown): Map<string, bigint>;
  readIndexOf(
    lastRead: Map<string, bigint> | undefined,
    self: string,
  ): bigint[];
  readByAt(sorted: bigint[], messageId: string): PluginReadBy | undefined;
}
let M: ReadRangeModule | undefined;
async function mod(): Promise<ReadRangeModule> {
  if (!M) M = await loadBlock<ReadRangeModule>("readrange", PRELUDE);
  return M;
}

/**
 * The two production steps in the order toPluginMessage takes them: sort the
 * chat's readers once, then ask about one message. There is no one-shot
 * convenience in daemon.ts on purpose -- a helper only the tests call is a
 * path nothing in production exercises.
 */
function readBy(
  m: ReadRangeModule,
  lastRead: Map<string, bigint> | undefined,
  messageId: string,
  self: string,
) {
  return m.readByAt(m.readIndexOf(lastRead, self), messageId);
}

/**
 * One member's ranges exactly as a 1:1 chat produced them: the list decoded as
 * an index-keyed object, and endMessageId as a bigint.
 */
function measuredOneToOne(end: string) {
  return {
    "0": {
      "1": 18000000000001,
      "2": BigInt(end),
      "3": 1735000000000,
      "4": 1899999999999,
    },
  };
}
/** The same from a group, where the end id arrived as a plain number. */
function measuredGroup(end: string) {
  return {
    "0": {
      "1": 18000000000001,
      "2": Number(end),
      "3": 1735000000000,
      "4": 1899999999999,
    },
  };
}
/** A hypothetical future linejs that has a definition and renames the fields. */
function named(end: string) {
  return {
    startMessageId: "1",
    endMessageId: end,
    startTime: 1735000000000,
    endTime: 1899999999999,
  };
}

Deno.test("an i64 is read as bigint, number or decimal string", async () => {
  const m = await mod();
  assertEquals(m.asMessageId(123n), 123n);
  assertEquals(m.asMessageId(123), 123n);
  assertEquals(m.asMessageId("18000000000001"), 18000000000001n);
  assertEquals(m.asMessageId("nope"), null);
  assertEquals(m.asMessageId(""), null);
  assertEquals(m.asMessageId(undefined), null);
  // Past 2^53 a JSON number has already lost digits; refuse rather than
  // compare a message id against a rounded one.
  assertEquals(m.asMessageId(1e300), null);
});

Deno.test("a decoded list starts at 0; a thrift struct starts at 1", async () => {
  const m = await mod();
  // The measured wrapper: one element, so its only key is "0".
  assertEquals(m.indexedEntries({ "0": "a" }), ["a"]);
  assertEquals(m.indexedEntries({ "0": "a", "1": "b" }), ["a", "b"]);
  assertEquals(m.indexedEntries(["a", "b"]), ["a", "b"]);
  // The entry itself. Field ids 1..4 look index-like and must not be unwrapped,
  // or its "1" would be read as a nested element and the id would be lost.
  assertEquals(m.indexedEntries({ "1": 1, "2": 2, "3": 3, "4": 4 }), null);
  // Holes mean it is not a list either.
  assertEquals(m.indexedEntries({ "0": "a", "2": "b" }), null);
  assertEquals(m.indexedEntries({ endMessageId: "1" }), null);
  assertEquals(m.indexedEntries({}), null);
  assertEquals(m.indexedEntries(null), null);
  assertEquals(m.indexedEntries("0"), null);
});

Deno.test("the measured 1:1 shape yields its bigint end id", async () => {
  const m = await mod();
  assertEquals(m.lastReadOf(measuredOneToOne(NEWER)), BigInt(NEWER));
});

Deno.test("the measured group shape yields its number end id", async () => {
  const m = await mod();
  assertEquals(m.lastReadOf(measuredGroup(NEWER)), BigInt(NEWER));
});

Deno.test("named fields still win, for a linejs that grows a definition", async () => {
  const m = await mod();
  assertEquals(m.rangeEndId(named(NEWER)), BigInt(NEWER));
  assertEquals(m.lastReadOf(named(NEWER)), BigInt(NEWER));
  assertEquals(m.lastReadOf({ "0": named(NEWER) }), BigInt(NEWER));
});

Deno.test("the end of the range is the newest message read", async () => {
  const m = await mod();
  // endMessageId missing: startMessageId is the only thing left that is an id.
  assertEquals(m.rangeEndId({ startMessageId: OLDER }), BigInt(OLDER));
  assertEquals(m.rangeEndId({ "1": OLDER }), BigInt(OLDER));
  // A 13-digit timestamp looks exactly like a message id, so the fields are
  // read by name/id and never by "which number looks big enough".
  assertEquals(m.rangeEndId({ "3": 1735000000000 }), null);
  assertEquals(m.rangeEndId(null), null);
});

Deno.test("several ranges for one member: the newest end wins", async () => {
  const m = await mod();
  const three = {
    "0": { "2": BigInt(OLDER) },
    "1": { "2": BigInt(NEWER) },
    "2": { "2": BigInt(MINE) },
  };
  assertEquals(m.lastReadOf(three), BigInt(NEWER));
  assertEquals(m.lastReadOf([named(OLDER), named(NEWER)]), BigInt(NEWER));
  assertEquals(m.lastReadOf([]), null);
  assertEquals(m.lastReadOf({ "0": {} }), null);
});

Deno.test("wrappers are unpicked to a bounded depth, then given up on", async () => {
  const m = await mod();
  // LINE sends one. Four is already three more than that; a shape that nests
  // deeper is one nobody has measured, and answering for it anyway is exactly
  // how the first version shipped a field that was silently always absent.
  const wrap = (n: number) => {
    let v: unknown = { "2": 7 };
    for (let i = 0; i < n; i++) v = { "0": v };
    return v;
  };
  assertEquals(m.lastReadOf(wrap(1)), 7n);
  assertEquals(m.lastReadOf(wrap(4)), 7n);
  assertEquals(m.lastReadOf(wrap(5)), null);
});

Deno.test("the measured 1:1 range map becomes one entry", async () => {
  const m = await mod();
  const map = m.readRangeToMap({
    chatId: A,
    ranges: { [A]: measuredOneToOne(NEWER) },
  });
  assertEquals(map.size, 1);
  assertEquals(map.get(A), BigInt(NEWER));
});

Deno.test("the measured group range map keeps every member", async () => {
  const m = await mod();
  const map = m.readRangeToMap({
    chatId: "c" + "f".repeat(32),
    ranges: {
      [ME]: measuredGroup(NEWER),
      [A]: measuredGroup(NEWER),
      [B]: measuredGroup(OLDER),
    },
  });
  assertEquals(map.size, 3);
  assertEquals(map.get(B), BigInt(OLDER));
  assertEquals(m.readRangeToMap({}).size, 0);
  assertEquals(m.readRangeToMap(undefined).size, 0);
});

Deno.test("1:1: the peer past the message is 已讀, before it is not", async () => {
  const m = await mod();
  const read = new Map([[A, BigInt(NEWER)]]);
  assertEquals(readBy(m, read, MINE, ME), { count: 1, all: true });
  const unread = new Map([[A, BigInt(OLDER)]]);
  assertEquals(readBy(m, unread, MINE, ME), { count: 0, all: false });
});

Deno.test("a member sitting exactly on the message has read it", async () => {
  const m = await mod();
  // The range is inclusive of its end: that id is the last one they saw.
  assertEquals(
    readBy(m, new Map([[A, BigInt(MINE)]]), MINE, ME),
    { count: 1, all: true },
  );
});

Deno.test("group: 已讀 N until everyone we know of has caught up", async () => {
  const m = await mod();
  const read = new Map([
    [ME, BigInt(NEWER)],
    [A, BigInt(NEWER)],
    [B, BigInt(OLDER)],
  ]);
  // Our own range is not a reader of our own message, so the denominator is 2.
  assertEquals(readBy(m, read, MINE, ME), { count: 1, all: false });
  read.set(B, BigInt(NEWER));
  assertEquals(readBy(m, read, MINE, ME), { count: 2, all: true });
});

Deno.test("nothing known means no field, never 已讀 0", async () => {
  const m = await mod();
  assertEquals(readBy(m, undefined, MINE, ME), undefined);
  assertEquals(readBy(m, new Map(), MINE, ME), undefined);
  // A chat where the only range is our own: there is no one to have read it.
  assertEquals(
    readBy(m, new Map([[ME, BigInt(NEWER)]]), MINE, ME),
    undefined,
  );
  // An id we cannot compare against is the same situation.
  assertEquals(readBy(m, new Map([[A, BigInt(NEWER)]]), "", ME), undefined);
  assertEquals(m.readByAt([], MINE), undefined);
});

Deno.test("the index is sorted and drops us, whatever order the map is in", async () => {
  const m = await mod();
  const read = new Map([
    [A, BigInt(NEWER)],
    [ME, BigInt(NEWER)],
    [B, BigInt(OLDER)],
  ]);
  assertEquals(m.readIndexOf(read, ME), [BigInt(OLDER), BigInt(NEWER)]);
  assertEquals(m.readIndexOf(undefined, ME), []);
  assertEquals(m.readIndexOf(new Map(), ME), []);
});

/** A real group answered with 553 members, which is what makes this matter. */
function bigGroup(members: number, readers: number) {
  const read = new Map<string, bigint>();
  read.set(ME, BigInt(NEWER));
  for (let i = 0; i < members; i++) {
    // "ua…" so a generated member can never land on ME ("u0…31 zeros…1"),
    // which is a real hazard: the first draft of this helper collided on i=1
    // and quietly tested 552 members.
    read.set(
      "ua" + String(i).padStart(31, "0"),
      BigInt(i < readers ? NEWER : OLDER),
    );
  }
  return read;
}

Deno.test("553 members: counted correctly, and we are not one of them", async () => {
  const m = await mod();
  const sorted = m.readIndexOf(bigGroup(553, 400), ME);
  assertEquals(sorted.length, 553);
  assertEquals(m.readByAt(sorted, MINE), { count: 400, all: false });
  assertEquals(
    m.readByAt(m.readIndexOf(bigGroup(553, 553), ME), MINE),
    { count: 553, all: true },
  );
  assertEquals(
    m.readByAt(m.readIndexOf(bigGroup(553, 0), ME), MINE),
    { count: 0, all: false },
  );
});

Deno.test("a page of history does not rescan the member list per message", async () => {
  const m = await mod();
  // The index is built once per chat; each bubble then binary-searches it. A
  // scan would be 553 reads a message -- 16,590 for one page of 30, for a
  // decoration -- so this counts the reads rather than trusting the shape.
  const sorted: bigint[] = m.readIndexOf(bigGroup(553, 400), ME);
  let reads = 0;
  const counted = new Proxy(sorted, {
    get(target, key, recv) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, recv);
    },
  });
  for (let i = 0; i < 30; i++) m.readByAt(counted, MINE);
  // ceil(log2(553)) = 10 probes a message, 300 for the page. The bound is
  // loose enough not to be brittle and far below even one linear scan.
  assert(reads <= 30 * 16, `binary search took ${reads} reads for 30 messages`);
});
