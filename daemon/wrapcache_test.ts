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
  rememberPlaintext(
    records: unknown[],
    wrapped: unknown[],
    chat: string,
    owner: object,
  ): void;
  kept: Array<{ chat: string; id: string; fields: Record<string, unknown> }>;
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
type Json = Record<string, unknown>;
const me = { mid: "ME" };
export const kept: Array<{ chat: string; id: string; fields: Json }> = [];
const messageStore = {
  plain(_me: string, chat: string, record: Json, fields: Json) {
    kept.push({ chat, id: String(record.id), fields });
  },
};
export { rememberPlaintext, wrap };
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

const sealedRaw = (id: string) => ({
  id,
  text: "",
  contentMetadata: { e2eeVersion: "2" } as Record<string, string>,
  chunks: [new Uint8Array([1])],
});

Deno.test("a record with kept plaintext is never decrypted again", async () => {
  const m = await load();
  const stored = {
    ...sealedRaw("1"),
    _plain: { text: "kept", contentMetadata: { e2eeVersion: "2", k: "v" } },
  };
  const tm = await m.wrap(stored, {});
  assertEquals(m.calls.decrypt, 0);
  assertEquals(tm.raw.text, "kept");
  assertEquals(tm.raw.contentMetadata, { e2eeVersion: "2", k: "v" });
  // The overlay key stays the store's; the message never carries it.
  assertEquals("_plain" in tm.raw, false);
});

Deno.test("a successful decrypt of a sealed record is kept, once", async () => {
  const m = await load();
  const owner = {};
  const raw = sealedRaw("1");
  const tm = await m.wrap(raw, owner);
  m.rememberPlaintext([raw], [tm], "C1", owner);
  assertEquals(m.kept, [{
    chat: "C1",
    id: "1",
    // Only what decrypting added: the wire's own keys are not snapshotted.
    fields: { text: "plaintext", contentMetadata: { decrypted: "1" } },
  }]);
  // Already kept on the record: nothing to write.
  const keptRaw = { ...raw, _plain: m.kept[0].fields };
  m.rememberPlaintext([keptRaw], [await m.wrap(keptRaw, owner)], "C1", owner);
  assertEquals(m.kept.length, 1);
});

Deno.test("a failed decrypt or an unsealed message keeps nothing", async () => {
  const m = await load();
  const owner = {};
  const raw = sealedRaw("1");
  m.failNext();
  const failed = await m.wrap(raw, owner);
  const plainRaw = { id: "2", text: "hi", contentMetadata: {} };
  const plain = await m.wrap(plainRaw, owner);
  m.rememberPlaintext([raw, plainRaw], [failed, plain], "C1", owner);
  assertEquals(m.kept, []);
});

Deno.test("a recall after the plaintext was kept still reads as unsent", async () => {
  const m = await load();
  const stored = {
    ...sealedRaw("1"),
    contentMetadata: { e2eeVersion: "2", UNSENT: "true" },
    _plain: { text: "kept", contentMetadata: { decrypted: "1" } },
  };
  const tm = await m.wrap(stored, {});
  assertEquals(tm.raw.contentMetadata, {
    e2eeVersion: "2",
    UNSENT: "true",
    decrypted: "1",
  });
});

Deno.test("decrypts that run side by side on a fresh session are all kept", async () => {
  const m = await load();
  const owner = {};
  const raws = ["1", "2", "3"].map(sealedRaw);
  // The decrypt pool runs them concurrently; none has finished when the
  // next starts.
  const tms = await Promise.all(raws.map((r) => m.wrap(r, owner)));
  m.rememberPlaintext(raws, tms, "C1", owner);
  assertEquals(m.kept.map((k) => k.id), ["1", "2", "3"]);
  await Promise.all(raws.map((r) => m.wrap(r, owner)));
  assertEquals(m.calls.decrypt, 3);
});
