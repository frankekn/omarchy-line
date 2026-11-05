import { assert, assertEquals } from "@std/assert";
import { loadBlocks } from "../slice_test.ts";
import type { PluginMessage } from "./types.ts";

const ACTOR = "u" + "a".repeat(32);
const SENDER = "u" + "b".repeat(32);

type Metadata = Record<string, unknown>;
interface Fixture {
  raw: {
    id: string;
    from: string;
    contentType: string;
    contentMetadata: Metadata;
  };
  readonly text: string | null;
}
interface ConversionModule {
  convert(message: Fixture): Promise<PluginMessage>;
  lookups: string[];
  setName(name: string): void;
  switchAccount(): void;
  clearAccount(): void;
  changeDuringLookup(): void;
}

function event(
  meta: Metadata = { LOC_KEY: "C_MA", LOC_ARGS: ACTOR },
  text: string | null = null,
  contentType = "CHATEVENT",
): Fixture {
  return {
    raw: { id: "1", from: SENDER, contentType, contentMetadata: meta },
    text,
  };
}

async function converter(): Promise<ConversionModule> {
  const prelude = `
let client = {};
let sessionGeneration = 1;
let name = "小葵";
let switchDuringLookup = false;
export const lookups = [];
export function setName(value) { name = value; }
export function switchAccount() { client = {}; sessionGeneration++; }
export function clearAccount() { client = null; }
export function changeDuringLookup() { switchDuringLookup = true; }
function sessionIsCurrent(owner, generation) {
  return owner === client && generation === sessionGeneration;
}
async function resolveName(mid, owner, generation) {
  lookups.push(mid);
  if (!owner || !sessionIsCurrent(owner, generation)) return mid;
  if (mid === ${JSON.stringify(SENDER)}) return "Sender";
  if (switchDuringLookup) switchAccount();
  return sessionIsCurrent(owner, generation) ? name : mid;
}
const goneMedia = new Set();
function rememberRaw() {}
function messageRequestId() {}
function applyPostNotification() {}
function parseMentionMeta() { return []; }
function fileNameOf() { return ""; }
async function e2eeFilePayload() { return null; }
function previewableMessage() { return false; }
function avatarNow() {}
function finalizeMessageState() {}
export function convert(message) {
  return toPluginMessage(message, "c-test", false);
}
`;
  return await loadBlocks<ConversionModule>(
    ["mediastate", "messageconvert"],
    prelude,
  );
}

Deno.test("C_MA resolves its argument actor instead of the sender", async () => {
  const m = await converter();
  const out = await m.convert(event());
  assertEquals(out.chatEvent, { kind: "announcement", actor: "小葵" });
  assertEquals(out.text, "小葵設定了公告");
  assertEquals(out.fromName, "Sender");
  assertEquals(m.lookups, [SENDER, ACTOR]);
});

Deno.test("announcement preserves supplied text and replaces only placeholders", async () => {
  const m = await converter();
  for (const text of ["", "CHATEVENT", "chatevent", "自訂事件內容"]) {
    const out = await m.convert(event(undefined, text));
    assertEquals(
      out.chatEvent?.kind,
      text === "自訂事件內容" ? undefined : "announcement",
    );
    assertEquals(out.text, text === "自訂事件內容" ? text : "小葵設定了公告");
  }
});

Deno.test("unrecognized or malformed events do not invent meaning or look up arguments", async () => {
  const m = await converter();
  const bad: Metadata[] = [
    {},
    { LOC_KEY: "C_MI", LOC_ARGS: ACTOR },
    { LOC_KEY: "C_UNKNOWN", LOC_ARGS: ACTOR },
    { LOC_KEY: ["C_MA"], LOC_ARGS: ACTOR },
    { LOC_KEY: "C_MA" },
    ...[
      null,
      42,
      {},
      [ACTOR],
      "",
      "小葵",
      "u-nope",
      "a".repeat(10000),
      ACTOR + "\x1e",
      ACTOR + "\x1f",
      ACTOR + "\x1e" + SENDER,
      ACTOR + "\x1f" + SENDER,
      " " + ACTOR,
      ACTOR + "\n",
      "c" + "a".repeat(32),
    ].map((LOC_ARGS) => ({ LOC_KEY: "C_MA", LOC_ARGS })),
  ];
  for (const meta of bad) {
    const out = await m.convert(event(meta));
    assertEquals(out.chatEvent, undefined);
    assertEquals(out.text, "");
  }
  const otherType = await m.convert(event(undefined, null, "NONE"));
  assertEquals(otherType.chatEvent, undefined);
  assert(m.lookups.every((mid) => mid === SENDER));
});

Deno.test("recalls and decrypt failures take precedence over event metadata", async () => {
  const m = await converter();
  for (const key of ["UNSENT", "SILENTLY_UNSENT"]) {
    const out = await m.convert(event({
      LOC_KEY: "C_MA",
      LOC_ARGS: ACTOR,
      [key]: "true",
      e2eeVersion: "2",
    }));
    assertEquals(out.chatEvent, undefined);
    assertEquals(out.text, "已收回訊息");
    assertEquals(out.unsent, true);
    assertEquals(out.decryptFailed, false);
  }
  const encrypted = await m.convert(event({
    LOC_KEY: "C_MA",
    LOC_ARGS: ACTOR,
    e2eeVersion: "2",
  }));
  assertEquals(encrypted.chatEvent, undefined);
  assertEquals(encrypted.text, "");
  assertEquals(encrypted.decryptFailed, true);
  const broken = event();
  Object.defineProperty(broken, "text", {
    get() {
      throw new Error("synthetic decrypt failure");
    },
  });
  const failed = await m.convert(broken);
  assertEquals(failed.chatEvent, undefined);
  assertEquals(failed.text, "");
  assertEquals(failed.decryptFailed, true);
  assert(m.lookups.every((mid) => mid === SENDER));
});

Deno.test("unresolved or unsafe names never expose member IDs", async () => {
  const m = await converter();
  for (
    const name of [
      ACTOR,
      SENDER,
      "",
      "  ",
      "x".repeat(201),
      "name\nspoof",
      "member " + ACTOR,
    ]
  ) {
    m.setName(name);
    const out = await m.convert(event());
    assertEquals(out.chatEvent, { kind: "announcement", actor: "" });
    assertEquals(out.text, "成員設定了公告");
  }
  m.setName("  小葵  ");
  assertEquals((await m.convert(event())).chatEvent?.actor, "小葵");
});

Deno.test("event conversion does not publish names across account changes", async () => {
  const m = await converter();
  m.changeDuringLookup();
  const stale = await m.convert(event());
  assertEquals(stale.chatEvent, undefined);
  assertEquals(stale.text, "");
  m.clearAccount();
  const offline = await m.convert(event());
  assertEquals(offline.chatEvent, undefined);
  assertEquals(offline.text, "");
  assertEquals(m.lookups, [SENDER, ACTOR, SENDER]);
});
