/**
 * wrap(): decrypt each stored message once per session, not once per open.
 *
 *   deno test -A wrapcache_test.ts
 *
 * Opening a sealed chat ran the whole page through decryptE2EEMessage on
 * every open. The cache is keyed by the raw object and the client, keeps
 * only successes, and is sliced out verbatim from modules/socket.ts.
 */
import { assertEquals, assertStrictEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface Module {
  wrap(
    raw: Record<string, unknown>,
    owner: object,
  ): Promise<{ raw: Record<string, unknown>; plain: boolean }>;
  calls: { decrypt: number };
  failNext(): void;
}

const PRELUDE = `
type Client = object;
type TalkMsg = { raw: Record<string, unknown>; plain: boolean };
export const calls = { decrypt: 0 };
let fail = false;
export function failNext() { fail = true; }
class TalkMessage {
  raw: object; plain: boolean;
  constructor(opts: { client: object; raw: object }) { this.raw = opts.raw; this.plain = true; }
  static async fromRawTalk(raw: Record<string, unknown>, _client: object): Promise<TalkMsg> {
    calls.decrypt++;
    if (fail) { fail = false; throw new Error("no key yet"); }
    // What linejs' decryptE2EEMessage does to the object it is handed.
    raw.text = "plaintext";
    (raw.contentMetadata as Record<string, string>).decrypted = "1";
    return { raw, plain: false };
  }
}
declare namespace TalkMessage { type raw = Record<string, unknown> & { contentMetadata?: Record<string, string> }; }
export { wrap };
`;

const load = () => loadBlock<Module>("wrap", PRELUDE);

Deno.test("a stored message is decrypted once, then served from memory", async () => {
  const m = await load();
  const owner = {};
  const raw = { id: "1", contentMetadata: {} };
  const a = await m.wrap(raw, owner);
  const b = await m.wrap(raw, owner);
  assertStrictEquals(a, b);
  assertEquals(m.calls.decrypt, 1);
});

Deno.test("an edit is a new raw and decrypts again", async () => {
  const m = await load();
  const owner = {};
  await m.wrap({ id: "1", contentMetadata: {} }, owner);
  await m.wrap({ id: "1", text: "edited", contentMetadata: {} }, owner);
  assertEquals(m.calls.decrypt, 2);
});

Deno.test("a new login never reuses the previous session's plaintext", async () => {
  const m = await load();
  const raw = { id: "1", contentMetadata: {} };
  await m.wrap(raw, {});
  await m.wrap(raw, {});
  assertEquals(m.calls.decrypt, 2);
});

Deno.test("a failed decrypt is retried on the next open", async () => {
  const m = await load();
  const owner = {};
  const raw = { id: "1", contentMetadata: {} };
  m.failNext();
  const first = await m.wrap(raw, owner);
  assertEquals(first.plain, true);
  const second = await m.wrap(raw, owner);
  assertEquals(second.plain, false);
  assertEquals(m.calls.decrypt, 2);
});

Deno.test("decrypting never writes plaintext into the stored record", async () => {
  const m = await load();
  const stored = { id: "1", text: "", contentMetadata: { e2eeVersion: "2" } };
  const tm = await m.wrap(stored, {});
  assertEquals(tm.raw.text, "plaintext");
  assertEquals(stored.text, "");
  assertEquals(stored.contentMetadata, { e2eeVersion: "2" });
});
