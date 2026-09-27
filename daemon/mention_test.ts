/**
 * buildMentionMeta() / parseMentionMeta(): LINE's MENTION contentMetadata,
 * both directions.
 *
 *   deno test -A mention_test.ts
 *
 * The unit the offsets are in is the whole point of this file. LINE's S/E are
 * decimal strings that linejs parseInts and feeds to String.prototype
 * .substring (client/features/message/talk.ts:255-300), so they index the JS
 * string in UTF-16 code units -- one per CJK character, two per emoji outside
 * the BMP. The panel measures the same JS string, so the round trip below is
 * the contract between the two ends, not a formatting detail.
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const PRELUDE = `
export { buildMentionMeta, normalizeMentions, parseMentionMeta };
`;

interface Mention {
  start: number;
  end: number;
  mid?: string;
  all?: boolean;
}
interface MentionEntry {
  S: string;
  E: string;
  M?: string;
  A?: string;
}
interface MentionModule {
  buildMentionMeta(
    mentions: unknown,
    text: string,
  ): { MENTION: string } | undefined;
  normalizeMentions(mentions: unknown, text: string): Mention[];
  parseMentionMeta(meta: unknown, text: string): Mention[];
}
let M: MentionModule | undefined;
async function mod(): Promise<MentionModule> {
  if (!M) M = await loadBlock<MentionModule>("mention", PRELUDE);
  return M;
}

// Two real-shaped mids: 'u' plus 32 lowercase hex.
const MID_A = "u" + "0".repeat(31) + "a";
const MID_B = "u" + "b".repeat(32);

/** What the MENTION string decodes to, so a test can read it. */
function mentionees(meta: { MENTION: string } | undefined): MentionEntry[] {
  assert(meta, "expected metadata, got undefined");
  const decoded: unknown = JSON.parse(meta.MENTION);
  assert(decoded !== null && typeof decoded === "object");
  const entries = (decoded as { MENTIONEES?: unknown }).MENTIONEES;
  assert(Array.isArray(entries));
  return entries as MentionEntry[];
}

Deno.test("a picked mention becomes MENTIONEES with string offsets", async () => {
  const m = await mod();
  const text = "@Alice hi";
  const meta = m.buildMentionMeta([{ start: 0, end: 6, mid: MID_A }], text);
  assertEquals(meta, {
    MENTION: `{"MENTIONEES":[{"S":"0","E":"6","M":"${MID_A}"}]}`,
  });
  // The offsets are what the recipient slices with, so they have to cut the
  // token out of the plaintext exactly.
  const [e] = mentionees(meta);
  assertEquals(text.substring(parseInt(e.S), parseInt(e.E)), "@Alice");
});

Deno.test("build -> parse round trips, @All included", async () => {
  const m = await mod();
  const text = "@All @Bob 開會";
  const mentions = [
    { start: 0, end: 4, all: true },
    { start: 5, end: 9, mid: MID_B },
  ];
  const meta = m.buildMentionMeta(mentions, text);
  assertEquals(mentionees(meta)[0], { S: "0", E: "4", A: "true" });
  assertEquals(m.parseMentionMeta(meta, text), mentions);
  assertEquals(text.substring(0, 4), "@All");
  assertEquals(text.substring(5, 9), "@Bob");
});

Deno.test("offsets are UTF-16 code units: CJK is 1, an emoji is 2", async () => {
  const m = await mod();
  // 早安 is two code units, 🐈 is a surrogate pair and counts two, so the
  // mention starts at 4 and the whole string is 8 units for 7 characters.
  const text = "早安🐈@小明好";
  assertEquals(text.length, 8, "the fixture itself is the unit assertion");
  assertEquals([...text].length, 7, "and it is not code points");
  const start = text.indexOf("@");
  assertEquals(start, 4);
  const meta = m.buildMentionMeta(
    [{ start, end: start + 3, mid: MID_A }],
    text,
  );
  const [e] = mentionees(meta);
  assertEquals([e.S, e.E], ["4", "7"]);
  assertEquals(text.substring(4, 7), "@小明");
  // Byte offsets would have been 8/14 and code points 3/6; both would cut the
  // cat in half. Pin that they are not what we send.
  assertEquals(new TextEncoder().encode(text.slice(0, start)).length, 10);
});

Deno.test("LINE's own spelling parses: S/E strings, A truthy, M mid", async () => {
  const m = await mod();
  const text = "@All @Bob";
  // A: "1" is what linejs's builder writes, "true" is what CHRLINE writes,
  // and the reader only tests truthiness (talk.ts:220).
  const meta = {
    MENTION: JSON.stringify({
      MENTIONEES: [
        { S: "0", E: "4", A: "1" },
        { S: "5", E: "9", M: MID_B },
      ],
    }),
  };
  assertEquals(m.parseMentionMeta(meta, text), [
    { start: 0, end: 4, all: true },
    { start: 5, end: 9, mid: MID_B },
  ]);
});

Deno.test("out-of-range, inverted and non-integer offsets are dropped", async () => {
  const m = await mod();
  const text = "@Alice"; // 6 code units
  const bad = [
    { start: 0, end: 7, mid: MID_A }, // past the end
    { start: -1, end: 3, mid: MID_A }, // before the start
    { start: 4, end: 4, mid: MID_A }, // empty
    { start: 5, end: 2, mid: MID_A }, // inverted
    { start: 1.5, end: 3, mid: MID_A }, // not an integer
    { start: "x", end: "y", mid: MID_A }, // not a number
  ];
  for (const entry of bad) {
    assertEquals(
      m.buildMentionMeta([entry], text),
      undefined,
      `${JSON.stringify(entry)} should not have survived`,
    );
  }
  // The good one in the same list still goes out.
  const meta = m.buildMentionMeta(
    [...bad, { start: 0, end: 6, mid: MID_A }],
    text,
  );
  assertEquals(mentionees(meta).length, 1);
});

Deno.test("an offset must be a number, or the decimal string LINE sends", async () => {
  const m = await mod();
  const text = "hi @Bob"; // 7 code units
  // Number() would make a usable integer out of every one of these -- true is
  // 1, null and [] are 0, "0x10" is 16, " 3 " is 3 -- and none of them is an
  // offset anybody meant to send.
  const notOffsets = [
    { start: true, end: 6, mid: MID_A },
    { start: 3, end: false, mid: MID_A },
    { start: null, end: null, mid: MID_A },
    { start: [], end: 6, mid: MID_A },
    { start: [3], end: 7, mid: MID_A },
    { start: {}, end: 7, mid: MID_A },
    { start: "", end: "7", mid: MID_A },
    { start: " 3 ", end: "7", mid: MID_A },
    { start: "0x10", end: "20", mid: MID_A },
    { start: "3.0", end: "7", mid: MID_A },
    { start: "-1", end: "7", mid: MID_A },
    { start: Infinity, end: 7, mid: MID_A },
  ];
  for (const bad of notOffsets) {
    assertEquals(
      m.buildMentionMeta([bad], text),
      undefined,
      `${JSON.stringify(bad)} should not have survived`,
    );
  }
  // The one non-number spelling that does count: LINE puts S/E on the wire as
  // decimal strings, and parseMentionMeta feeds them through this same path.
  assertEquals(
    m.normalizeMentions([{ start: "3", end: "7", mid: MID_A }], text),
    [{ start: 3, end: 7, mid: MID_A }],
  );
  assertEquals(text.substring(3, 7), "@Bob");
  // And the same guard covers @All, which reaches the offset check first.
  assertEquals(
    m.buildMentionMeta([{ start: true, end: 7, all: true }], text),
    undefined,
  );
});

Deno.test("a mid that is not a mid is dropped, and @All never needs one", async () => {
  const m = await mod();
  const text = "@Alice";
  for (const mid of ["", "c" + "0".repeat(32), "u123", MID_A.toUpperCase()]) {
    assertEquals(
      m.buildMentionMeta([{ start: 0, end: 6, mid }], text),
      undefined,
      `${mid} should not have survived`,
    );
  }
  // all wins over a missing mid rather than being dropped with it.
  assertEquals(
    mentionees(m.buildMentionMeta([{ start: 0, end: 6, all: true }], text)),
    [{ S: "0", E: "6", A: "true" }],
  );
});

Deno.test("overlapping spans are dropped, and the rest come back sorted", async () => {
  const m = await mod();
  const text = "@Alice @Bob";
  const out = m.normalizeMentions([
    { start: 7, end: 11, mid: MID_B },
    { start: 3, end: 8, mid: MID_A }, // straddles both, and loses to [0,6)
    { start: 0, end: 6, mid: MID_A },
  ], text);
  assertEquals(out, [
    { start: 0, end: 6, mid: MID_A },
    { start: 7, end: 11, mid: MID_B },
  ]);
});

Deno.test("nothing to send is undefined, not an empty MENTIONEES", async () => {
  const m = await mod();
  for (const list of [undefined, null, [], "nope", {}, [1, "x", null]]) {
    assertEquals(m.buildMentionMeta(list, "@Alice"), undefined);
  }
});

Deno.test("a message with no mentions, or broken ones, parses to []", async () => {
  const m = await mod();
  const text = "@Alice";
  assertEquals(m.parseMentionMeta({}, text), []);
  assertEquals(m.parseMentionMeta(undefined, text), []);
  assertEquals(m.parseMentionMeta({ MENTION: "" }, text), []);
  // Truncated JSON is what a sender's client can really produce; it must cost
  // this message its highlights and nothing else.
  assertEquals(m.parseMentionMeta({ MENTION: '{"MENTIONEES":[' }, text), []);
  assertEquals(m.parseMentionMeta({ MENTION: "null" }, text), []);
  assertEquals(m.parseMentionMeta({ MENTION: '{"MENTIONEES":{}}' }, text), []);
  // A mention whose offsets belong to a longer text than we decrypted: the
  // e2ee payload and the metadata come down separate paths.
  assertEquals(
    m.parseMentionMeta(
      { MENTION: `{"MENTIONEES":[{"S":"0","E":"99","M":"${MID_A}"}]}` },
      text,
    ),
    [],
  );
});

Deno.test("an empty text can carry no mention at all", async () => {
  const m = await mod();
  assertEquals(
    m.buildMentionMeta([{ start: 0, end: 1, mid: MID_A }], ""),
    undefined,
  );
  assertEquals(
    m.parseMentionMeta({
      MENTION: `{"MENTIONEES":[{"S":"0","E":"1","A":"true"}]}`,
    }, ""),
    [],
  );
});
