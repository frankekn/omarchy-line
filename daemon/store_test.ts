/**
 * The persistent message store: JSONL lines per chat under the account's own
 * directory, last-write-wins merge, overlay tombstones, page-back anchoring.
 *
 *   deno test -A store_test.ts
 *
 * Everything runs against real temp directories -- the disk format is the
 * contract, so faking it would test nothing.
 */
import { assert, assertEquals } from "@std/assert";
import { createMessageStore } from "./modules/store.ts";

const ME = "u" + "0".repeat(31) + "1";
const CHAT = "c" + "1".repeat(31);

function msg(id: number | string, text: string): Record<string, unknown> {
  return {
    id: String(id),
    from: "u" + "f".repeat(31),
    to: CHAT,
    createdTime: 1700000000000 + Number(id),
    deliveredTime: 1700000000000 + Number(id),
    contentType: "NONE",
    text,
  };
}

async function withStore(
  fn: (store: ReturnType<typeof createMessageStore>, dir: string) => Promise<
    void
  >,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-store-" });
  try {
    await fn(createMessageStore(`${dir}/messages`), dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("append then tail reads back oldest-first", async () => {
  await withStore(async (store) => {
    store.append(ME, CHAT, [msg(3, "c"), msg(1, "a"), msg(2, "b")]);
    await store.flush();
    const tail = await store.tail(ME, CHAT, 10);
    assertEquals(tail?.map((m) => m.text), ["a", "b", "c"]);
  });
});

Deno.test("tail survives a cold reload from disk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "enil-store-" });
  try {
    const first = createMessageStore(`${dir}/messages`);
    first.append(ME, CHAT, [msg(1, "a"), msg(2, "b")]);
    await first.flush();
    // A second instance at the same root is a daemon restart.
    const second = createMessageStore(`${dir}/messages`);
    const tail = await second.tail(ME, CHAT, 10);
    assertEquals(tail?.map((m) => m.text), ["a", "b"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an edit line replaces the message in place", async () => {
  await withStore(async (store) => {
    store.append(ME, CHAT, [msg(1, "a"), msg(2, "b"), msg(3, "c")]);
    store.append(ME, CHAT, [{ ...msg(2, "b-edited"), updatedTime: 9 }]);
    await store.flush();
    const tail = await store.tail(ME, CHAT, 10);
    assertEquals(tail?.map((m) => m.text), ["a", "b-edited", "c"]);
    assertEquals(tail?.length, 3);
  });
});

Deno.test("a tombstone keeps the row but marks it unsent", async () => {
  await withStore(async (store) => {
    store.append(ME, CHAT, [msg(1, "a"), msg(2, "b")]);
    store.tombstone(ME, CHAT, "2");
    await store.flush();
    const tail = await store.tail(ME, CHAT, 10);
    assertEquals(tail?.length, 2);
    const gone = tail?.[1] ?? {};
    assertEquals(
      (gone.contentMetadata as Record<string, unknown>).UNSENT,
      "true",
    );
    // Position and sender survive -- the bubble becomes 已收回訊息 in place.
    assertEquals(gone.from, "u" + "f".repeat(31));
  });
});

Deno.test("a reaction overlay lands on the stored message", async () => {
  await withStore(async (store) => {
    store.append(ME, CHAT, [msg(1, "a")]);
    store.reactions(ME, CHAT, "1", new Map([["u-peer", "NICE"]]));
    await store.flush();
    const tail = await store.tail(ME, CHAT, 10);
    const reactions = tail?.[0]?.reactions as Record<string, unknown>[];
    assertEquals(reactions[0].fromUserMid, "u-peer");
    assertEquals(
      (reactions[0].reactionType as Record<string, unknown>)
        .predefinedReactionType,
      "NICE",
    );
  });
});

Deno.test("pageBefore anchors and never crosses the anchor", async () => {
  await withStore(async (store) => {
    store.append(ME, CHAT, [1, 2, 3, 4, 5].map((i) => msg(i, `m${i}`)));
    await store.flush();
    const page = await store.pageBefore(ME, CHAT, "4", 2);
    assertEquals(page?.map((m) => m.text), ["m2", "m3"]);
    // The anchor edge: fewer than requested is honest, the next call falls
    // off the store and goes to the network.
    assertEquals(
      (await store.pageBefore(ME, CHAT, "2", 5))?.map((m) => m.text),
      ["m1"],
    );
    // An anchor the store does not hold means "not my page" -- caller fetches.
    assertEquals(await store.pageBefore(ME, CHAT, "999", 5), null);
  });
});

Deno.test("a torn tail line loses only itself", async () => {
  const dir = await Deno.makeTempDir({ prefix: "enil-store-" });
  try {
    const root = `${dir}/messages`;
    await Deno.mkdir(`${root}/${ME}`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/${ME}/${CHAT}.jsonl`,
      JSON.stringify({ chatMid: CHAT, ...msg(1, "a") }) + "\n" +
        '{"chatMid":"' + CHAT + '","id":"2","text":"trun' + "\n" +
        JSON.stringify({ chatMid: CHAT, ...msg(3, "c") }) + "\n",
    );
    const store = createMessageStore(root);
    const tail = await store.tail(ME, CHAT, 10);
    assertEquals(tail?.map((m) => m.text), ["a", "c"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stores for different accounts never share a file", async () => {
  await withStore(async (store, dir) => {
    const other = "u" + "9".repeat(31) + "9";
    store.append(ME, CHAT, [msg(1, "mine")]);
    store.append(other, CHAT, [msg(9, "theirs")]);
    await store.flush();
    assertEquals(
      (await store.tail(ME, CHAT, 10))?.map((m) => m.text),
      ["mine"],
    );
    assertEquals(
      (await store.tail(other, CHAT, 10))?.map((m) => m.text),
      ["theirs"],
    );
    const dirs = [];
    for await (const e of Deno.readDir(`${dir}/messages`)) dirs.push(e.name);
    assertEquals(dirs.sort(), [ME, other].sort());
  });
});

Deno.test("empty and absent chats answer null, never throw", async () => {
  await withStore(async (store) => {
    assertEquals(await store.tail(ME, "c-never", 5), null);
    assertEquals(await store.pageBefore(ME, "c-never", "1", 5), null);
    assertEquals(await store.tail("", CHAT, 5), null);
  });
});

Deno.test("bigint wire fields survive the round trip", async () => {
  await withStore(async (store) => {
    store.append(ME, CHAT, [
      { ...msg(1, "big"), id: 123n, deliveredTime: 456n },
    ]);
    await store.flush();
    const tail = await store.tail(ME, CHAT, 5);
    assertEquals(String(tail?.[0]?.id), "123");
    assertEquals(String(tail?.[0]?.deliveredTime), "456");
  });
});

async function diskLines(dir: string): Promise<number> {
  const text = await Deno.readTextFile(`${dir}/messages/${ME}/${CHAT}.jsonl`);
  return text.split("\n").filter((l) => l.trim()).length;
}

Deno.test("dead overlay lines get folded back into the file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "enil-store-" });
  try {
    const store = createMessageStore(`${dir}/messages`, {
      compactMinLines: 4,
      compactRatio: 2,
    });
    store.append(ME, CHAT, [msg(1, "a"), msg(2, "b"), msg(3, "c")]);
    await store.flush();
    // Compaction only rewrites files someone reads -- load the index first.
    assertEquals((await store.tail(ME, CHAT, 10))?.length, 3);
    // Ten reaction overlays on one message: 10 dead lines over 3 live rows.
    for (let i = 0; i < 10; i++) {
      store.reactions(ME, CHAT, "1", new Map([[`u-p${i}`, "NICE"]]));
    }
    await store.flush();
    // The rewrite runs on the writing chain, so flush() has already seen it.
    assertEquals(await diskLines(dir), 3);
    const tail = await store.tail(ME, CHAT, 10);
    assertEquals(tail?.map((m) => m.text), ["a", "b", "c"]);
    // The latest overlay is the one that survived the fold.
    const reactions = tail?.[0]?.reactions as Record<string, unknown>[];
    assertEquals(reactions[0].fromUserMid, "u-p9");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a compacted file reloads to the same index", async () => {
  const dir = await Deno.makeTempDir({ prefix: "enil-store-" });
  try {
    const first = createMessageStore(`${dir}/messages`, {
      compactMinLines: 2,
      compactRatio: 2,
    });
    first.append(ME, CHAT, [msg(1, "a"), msg(2, "b")]);
    first.tombstone(ME, CHAT, "2"); // row stays, marked unsent
    first.tombstone(ME, CHAT, "999"); // a stub for a message never seen
    for (let i = 0; i < 6; i++) {
      first.reactions(ME, CHAT, "1", new Map([[`u-p${i}`, "LOVE"]]));
    }
    await first.flush();
    // Reading the chat loads the index and queues the rewrite; flush()
    // settles the chain it was queued on.
    assertEquals((await first.tail(ME, CHAT, 10))?.length, 2);
    await first.flush();
    // 2 live rows (incl. the tombstoned one) + the unseen stub.
    assertEquals(await diskLines(dir), 3);

    // A cold reopen is a daemon restart; it must see the identical view.
    const second = createMessageStore(`${dir}/messages`, {
      compactMinLines: 2,
      compactRatio: 2,
    });
    const tail = await second.tail(ME, CHAT, 10);
    assertEquals(tail?.map((m) => m.text), ["a", "b"]);
    const gone = tail?.[1] ?? {};
    assertEquals(
      (gone.contentMetadata as Record<string, unknown>).UNSENT,
      "true",
    );
    const reactions = tail?.[0]?.reactions as Record<string, unknown>[];
    assertEquals(reactions[0].fromUserMid, "u-p5");
    // The stub answers get() but never joins the message order.
    const stub = await second.get(ME, CHAT, "999");
    assertEquals(
      (stub?.contentMetadata as Record<string, unknown>).UNSENT,
      "true",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a bloated file compacts on cold open, and later appends land", async () => {
  const dir = await Deno.makeTempDir({ prefix: "enil-store-" });
  try {
    // First store: compaction off, so the file accumulates dead lines.
    const off = createMessageStore(`${dir}/messages`, {
      compactMinLines: Number.MAX_SAFE_INTEGER,
    });
    off.append(ME, CHAT, [msg(1, "a"), msg(2, "b")]);
    await off.flush();
    for (let i = 0; i < 8; i++) {
      off.reactions(ME, CHAT, "1", new Map([[`u-p${i}`, "NICE"]]));
    }
    await off.flush();
    assertEquals(await diskLines(dir), 10);

    // Second store: opening the chat queues the rewrite; flush() settles it.
    const on = createMessageStore(`${dir}/messages`, {
      compactMinLines: 2,
      compactRatio: 2,
    });
    assertEquals((await on.tail(ME, CHAT, 10))?.length, 2);
    await on.flush();
    assertEquals(await diskLines(dir), 2);

    // Appends after the rewrite land on the new file, nothing is lost.
    on.append(ME, CHAT, [msg(3, "c")]);
    await on.flush();
    const third = createMessageStore(`${dir}/messages`);
    assertEquals(
      (await third.tail(ME, CHAT, 10))?.map((m) => m.text),
      ["a", "b", "c"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("binary wire fields revive as Uint8Array, not tagged objects", async () => {
  await withStore(async (store, dir) => {
    // Write the exact shape Buffer.toJSON leaves on disk, because the wire
    // path hands chunks: Buffer[] and the decryptor needs .subarray back.
    await Deno.mkdir(`${dir}/messages/${ME}`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/messages/${ME}/${CHAT}.jsonl`,
      JSON.stringify({
        ...msg(9, "enc"),
        contentType: "IMAGE",
        chunks: [{ type: "Buffer", data: [217, 177, 9] }],
      }) + "\n",
    );
    const got = await store.get(ME, CHAT, "9");
    const chunk = (got?.chunks as unknown[])?.[0];
    assert(chunk instanceof Uint8Array);
    assertEquals([...(chunk as Uint8Array)], [217, 177, 9]);
  });
});
