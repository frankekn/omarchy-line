/**
 * Getting a reply onto the socket whole -- the bug `stickers` found.
 *
 *   deno test -A replywrite_test.ts
 *
 * `stickers` was the first command whose answer did not fit in a socket
 * buffer: 54 owned packages come to roughly 175 KB. Deno.Conn.write is one
 * write(2), so it wrote what the kernel would take (219264 bytes, measured
 * here) and returned that count, which nobody read. The closing newline never
 * arrived, the panel waited out its timeout, and because nothing threw and the
 * connection stayed open there was no `[cmd]` line to find -- every other
 * command kept answering on the same socket throughout.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import { loadBlock } from "./slice_test.ts";
import { encodeJsonReply, writeAll } from "./panelserver.ts";

const ENCODE_ERROR = "回覆無法編碼";

const mod = () =>
  Promise.resolve({
    writeAll,
    encodeReply: (cmd: string, res: Record<string, unknown>) =>
      encodeJsonReply(cmd, res, ENCODE_ERROR, () => {}),
  });

/** A writer that accepts at most `chunk` bytes a call, like a real socket. */
function partialWriter(chunk: number) {
  const got: number[] = [];
  const parts: Uint8Array[] = [];
  return {
    calls: got,
    write(p: Uint8Array): Promise<number> {
      const n = Math.min(chunk, p.byteLength);
      got.push(n);
      parts.push(p.slice(0, n));
      return Promise.resolve(n);
    },
    text(): string {
      const total = parts.reduce((a, b) => a + b.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
      }
      return new TextDecoder().decode(out);
    },
  };
}

Deno.test("a short write is resumed until every byte is out", async () => {
  const m = await mod();
  const body = "x".repeat(300_000) + "\n";
  const w = partialWriter(219_264);
  await m.writeAll(w, new TextEncoder().encode(body));
  assertEquals(w.text(), body);
  // Two calls, not one: the first is exactly the bug, and a test that only
  // checked the text would pass on a writer that never short-wrote.
  assertEquals(w.calls, [219_264, 80_737]);
});

Deno.test("one byte at a time still arrives whole", async () => {
  const m = await mod();
  const w = partialWriter(1);
  await m.writeAll(w, new TextEncoder().encode("héllo\n"));
  assertEquals(w.text(), "héllo\n");
  // Bytes, not characters: é is two of them.
  assertEquals(w.calls.length, 7);
});

Deno.test("a writer that takes everything is written once", async () => {
  const m = await mod();
  const w = partialWriter(1 << 20);
  await m.writeAll(w, new TextEncoder().encode("{}\n"));
  assertEquals(w.calls, [3]);
});

Deno.test("nothing to write is no write at all", async () => {
  const m = await mod();
  const w = partialWriter(16);
  await m.writeAll(w, new Uint8Array(0));
  assertEquals(w.calls, []);
});

Deno.test("a writer that accepts nothing throws instead of spinning", async () => {
  const m = await mod();
  // The loop would otherwise never end, and a daemon stuck in it answers no
  // command on any connection -- a worse failure than the one being fixed.
  await assertRejects(
    () => m.writeAll({ write: () => Promise.resolve(0) }, new Uint8Array(4)),
    Error,
    "socket accepted no bytes",
  );
});

Deno.test("a writer that throws is not swallowed", async () => {
  const m = await mod();
  await assertRejects(
    () =>
      m.writeAll({
        write: () => Promise.reject(new Error("Broken pipe")),
      }, new Uint8Array(4)),
    Error,
    "Broken pipe",
  );
});

// ------------------------------------------------------- encoding a reply

Deno.test("an ordinary reply is one line of JSON", async () => {
  const m = await mod();
  const bytes = m.encodeReply("stickers", { ok: true, data: { a: 1 }, id: 7 });
  const text = new TextDecoder().decode(bytes);
  assertEquals(text.endsWith("\n"), true);
  assertEquals(text.indexOf("\n"), text.length - 1);
  assertEquals(JSON.parse(text), { ok: true, data: { a: 1 }, id: 7 });
});

Deno.test("a reply that cannot be encoded becomes a refusal, not a hang", async () => {
  const m = await mod();
  // A BigInt is what JSON.stringify refuses; a cycle is the other way in.
  const cyclic: Record<string, unknown> = { ok: true, id: 9 };
  cyclic.self = cyclic;
  for (
    const res of [
      { ok: true, data: { version: 5n }, id: 9 },
      cyclic,
    ]
  ) {
    const text = new TextDecoder().decode(m.encodeReply("stickers", res));
    assertEquals(JSON.parse(text), {
      ok: false,
      error: ENCODE_ERROR,
      // The id survives, because it is how the panel matches the reply to the
      // request it is still waiting on.
      id: 9,
    });
  }
});

Deno.test("the encoding refusal drops an unserializable id safely", async () => {
  const m = await mod();
  const cyclicId: Record<string, unknown> = {};
  cyclicId.self = cyclicId;
  for (const id of [5n, cyclicId]) {
    const text = new TextDecoder().decode(
      m.encodeReply("stickers", { ok: true, id }),
    );
    assertEquals(JSON.parse(text), {
      ok: false,
      error: ENCODE_ERROR,
    });
  }
});

Deno.test("the refusal string is the one daemon.ts declares", async () => {
  // The prelude has to supply the constant, so pin it against the source
  // rather than let the two drift into different sentences.
  const src = await Deno.readTextFile(
    new URL("./modules/text.ts", import.meta.url),
  );
  assert(
    src.includes(`const ENCODE_ERROR = "${ENCODE_ERROR}";`),
    "ENCODE_ERROR in the daemon source no longer matches this test",
  );
});

// --------------------------------------------- the payload has no BigInt

Deno.test("a shop reply full of bigints parses into something encodable", async () => {
  // The thrift reader hands i64 fields back as objects, and a fork that
  // switched to native BigInt would hand back BigInt -- either way the picker
  // must not put one in the reply, because JSON.stringify refuses it.
  interface StickerSummary {
    id: string;
    name: string;
    version: number;
  }
  interface StickerDetail extends StickerSummary {
    stickers: Array<{ id: string; url: string; animated: boolean }>;
  }
  const s = await loadBlock<{
    parseOwnedSummaries(value: unknown): StickerSummary[];
    parseProductInfo(id: string, value: unknown): StickerDetail;
  }>(
    "sticker",
    `
type Json = Record<string, unknown>;
export { parseOwnedSummaries, parseProductInfo };
`,
  );
  const summaries = s.parseOwnedSummaries({
    "1": [
      { "1": "1", "11": "Moon & James", "21": 3n },
      { "1": "11537", "11": "動的", "21": { toString: () => "7" } },
    ],
  });
  const detail = s.parseProductInfo("1", {
    version: 9n,
    title: { zh_TW: "饅頭人" },
    stickers: [{ id: 4n }, { id: 13 }, { id: "401" }],
  });
  const reply = {
    ok: true,
    data: {
      packages: [
        { ...detail, version: summaries[0].version },
        {
          id: summaries[1].id,
          name: summaries[1].name,
          version: summaries[1].version,
          stickers: [],
        },
      ],
    },
    id: 1,
  };
  // The whole point: this must not throw.
  const round = JSON.parse(JSON.stringify(reply));
  assertEquals(round, reply);
  for (const pkg of round.data.packages) {
    assertEquals(typeof pkg.id, "string");
    assertEquals(typeof pkg.name, "string");
    assertEquals(typeof pkg.version, "number");
    for (const t of pkg.stickers) {
      assertEquals(typeof t.id, "string");
      assertEquals(typeof t.url, "string");
      assertEquals(typeof t.animated, "boolean");
    }
  }
  assertEquals(round.data.packages[0].version, 3);
  assertEquals(round.data.packages[1].version, 7);
  // A bigint sticker id is still a usable id, not a dropped sticker.
  assertEquals(
    round.data.packages[0].stickers.map((t: { id: string }) => t.id),
    [
      "4",
      "13",
      "401",
    ],
  );
});

// ------------------------------------------------- over a real unix socket

/**
 * The end-to-end shape of the bug, on the same kind of socket the panel uses.
 * The fake writer above pins the loop; this pins the thing the loop is for --
 * and the first half of it re-runs the original failure, so the test says why
 * writeAll exists rather than only that it works.
 */
Deno.test("a reply larger than the socket buffer arrives whole", async () => {
  const m = await mod();
  const dir = await Deno.makeTempDir({ prefix: "enil-sock-" });
  const path = `${dir}/sock`;
  const listener = Deno.listen({ transport: "unix", path });
  // ~300 KB: bigger than any buffer measured here, and the same order as the
  // 54-package `stickers` answer that found this.
  const reply = JSON.stringify({
    ok: true,
    data: { packages: "x".repeat(300_000) },
    id: 1,
  }) + "\n";
  const bytes = new TextEncoder().encode(reply);

  const readLine = async (conn: Deno.Conn): Promise<string | undefined> => {
    for await (
      const line of conn.readable
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream())
    ) {
      return line;
    }
    return undefined;
  };

  try {
    // 1. What the daemon used to do: one bare write, return value dropped.
    const served = listener.accept().then(async (conn) => {
      const n = await conn.write(bytes);
      conn.close();
      return n;
    });
    let client = await Deno.connect({ transport: "unix", path });
    const [wrote, truncated] = await Promise.all([served, readLine(client)]);
    assert(
      wrote < bytes.byteLength,
      "the socket took the whole reply, so this machine cannot show the bug",
    );
    // The line the panel was waiting for never had its newline, so what came
    // back is not the reply -- and nothing threw to say so.
    assert(truncated !== undefined && truncated.length < reply.length - 1);

    // 2. What it does now.
    const servedAll = listener.accept().then(async (conn) => {
      await m.writeAll(conn, bytes);
      conn.close();
    });
    client = await Deno.connect({ transport: "unix", path });
    const [, whole] = await Promise.all([servedAll, readLine(client)]);
    assertEquals(whole, reply.slice(0, -1));
    assertEquals(JSON.parse(whole!).data.packages.length, 300_000);
  } finally {
    listener.close();
    await Deno.remove(dir, { recursive: true });
  }
});
