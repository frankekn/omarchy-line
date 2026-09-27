/**
 * The sendMessage payload `send` and `reply` share.
 *
 *   deno test -A reply_test.ts
 *
 * What the payload must NOT carry is the interesting half -- twice over. LINE's
 * Message struct
 * has three reply fields -- relatedMessageId (21), messageRelationType (22) and
 * relatedMessageServiceCode (24) -- but base.talk.sendMessage fills the last
 * two in itself the moment the first is present (vendor/linejs
 * base/service/talk/mod.ts:155-161). Setting them here would be a second copy
 * of that rule, and the day the fork changes it, the copy is what would send a
 * FORWARD as a REPLY.
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const PRELUDE = `
type Json = Record<string, unknown>;
export { sendArgs };
`;

const GROUP = "c" + "f".repeat(32);
const TARGET = "18000000000001";
const META = { MENTION: '{"MENTIONEES":[{"S":"0","E":"4","A":"true"}]}' };
const REQUEST_ID = "panel-1-1700000000000-7";

interface SendArgs {
  to: string;
  text: string;
  contentMetadata?: Record<string, string>;
  relatedMessageId?: string;
}
interface SendArgsModule {
  sendArgs(
    to: string,
    text: string,
    metadata?: Record<string, string>,
    replyTo?: string,
    requestId?: string,
  ): SendArgs;
}
let M: SendArgsModule | undefined;
async function mod(): Promise<SendArgsModule> {
  if (!M) M = await loadBlock<SendArgsModule>("sendargs", PRELUDE);
  return M;
}

Deno.test("a plain send is to and text, and nothing else", async () => {
  const m = await mod();
  assertEquals(m.sendArgs(GROUP, "早安", undefined), {
    to: GROUP,
    text: "早安",
  });
});

Deno.test("no e2ee key at all, so linejs may fall back to plain", async () => {
  const m = await mod();
  // The one that mattered: `e2ee: true` runs encryptE2EEMessage before the
  // send, and for a contact with Letter Sealing off the key lookup answers
  // E2EE_RETRY_PLAIN and throws from outside the retry -- the send failed for
  // a message LINE would have taken as plain text. linejs only retries plain
  // when the flag is *undefined* (base/service/talk/mod.ts:176), so the key
  // has to be absent rather than false.
  for (
    const args of [
      m.sendArgs(GROUP, "早安", undefined),
      m.sendArgs(GROUP, "@All 收到", META, TARGET),
    ]
  ) {
    assertEquals("e2ee" in args, false, JSON.stringify(args));
  }
});

Deno.test("contentMetadata is absent, not undefined, when there is none", async () => {
  const m = await mod();
  // An explicit undefined would override sendMessage's own `{}` default.
  assertEquals("contentMetadata" in m.sendArgs(GROUP, "hi", undefined), false);
  assertEquals("relatedMessageId" in m.sendArgs(GROUP, "hi", undefined), false);
});

Deno.test("a reply adds relatedMessageId and only that", async () => {
  const m = await mod();
  const args = m.sendArgs(GROUP, "收到", undefined, TARGET);
  assertEquals(args, {
    to: GROUP,
    text: "收到",
    relatedMessageId: TARGET,
  });
  // linejs derives both of these from relatedMessageId; sending our own would
  // be the second place they are decided.
  assertEquals("messageRelationType" in args, false);
  assertEquals("relatedMessageServiceCode" in args, false);
});

Deno.test("a reply carries mentions exactly like a send", async () => {
  const m = await mod();
  // Also what the plain-first send has to hand back to the E2EE retry: linejs
  // re-enters sendMessage with this very object and spreads contentMetadata
  // into the encrypted copy (base/service/talk/mod.ts:122-138), so a mention
  // survives the fallback in both directions.
  assertEquals(m.sendArgs(GROUP, "@All 收到", META, TARGET), {
    to: GROUP,
    text: "@All 收到",
    contentMetadata: META,
    relatedMessageId: TARGET,
  });
});

Deno.test("an empty replyTo is a send, not a reply to nothing", async () => {
  const m = await mod();
  // handle() refuses `reply` without one; this is the belt to that braces --
  // relatedMessageId: "" would reach LINE as a malformed reply.
  assertEquals(
    "relatedMessageId" in m.sendArgs(GROUP, "hi", undefined, ""),
    false,
  );
});

Deno.test("a stable request token shares metadata with mentions", async () => {
  const m = await mod();
  assertEquals(m.sendArgs(GROUP, "@All 收到", META, TARGET, REQUEST_ID), {
    to: GROUP,
    text: "@All 收到",
    contentMetadata: { ...META, ENIL_REQUEST_ID: REQUEST_ID },
    relatedMessageId: TARGET,
  });
});
