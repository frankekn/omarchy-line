/** Cold loads must replay updates without racing writes, compaction or LRU. */
import { assert, assertEquals } from "@std/assert";
import { createMessageStore } from "./store.ts";

const ME = "u-cold", CHAT = "c-cold";

function message(id: string, text: string): Record<string, unknown> {
  return { id, from: "u-peer", text, createdTime: Number(id) };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => release = resolve);
  return { promise, release };
}

async function seed(root: string) {
  const store = createMessageStore(root, {
    compactMinLines: Number.MAX_SAFE_INTEGER,
  });
  store.append(ME, CHAT, [
    message("1", "original edit"),
    message("2", "original unsend"),
    message("3", "anchor"),
  ]);
  await store.flush();
}

async function withDir(run: (root: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "enil-store-cold-" });
  try {
    await run(`${dir}/messages`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function assertUpdated(rows: Record<string, unknown>[] | null) {
  assertEquals(rows?.[0]?.text, "edited");
  assertEquals(
    (rows?.[1]?.contentMetadata as Record<string, unknown>)?.UNSENT,
    "true",
  );
}

Deno.test("cold tail includes unflushed edits and tombstones", async () => {
  await withDir(async (root) => {
    await seed(root);
    const store = createMessageStore(root);
    try {
      store.append(ME, CHAT, [{
        ...message("1", "edited"),
        chunks: [new Uint8Array([3, 7, 9])],
      }]);
      store.tombstone(ME, CHAT, "2");
      store.reactions(ME, CHAT, "1", new Map([["u-peer", "LOVE"]]));
      const rows = await store.tail(ME, CHAT, 10);
      assertUpdated(rows);
      assert(rows?.[0]?.chunks instanceof Array);
      assert(rows[0].chunks[0] instanceof Uint8Array);
      assertEquals([...rows[0].chunks[0]], [3, 7, 9]);
      assertEquals(
        (rows[0].reactions as Record<string, unknown>[])?.[0]?.fromUserMid,
        "u-peer",
      );
      await store.flush();
      assertUpdated(await store.tail(ME, CHAT, 10));
      assertUpdated(await createMessageStore(root).tail(ME, CHAT, 10));
    } finally {
      await store.flush();
    }
  });
});

Deno.test("missing cold file still exposes pending messages", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    try {
      store.append(ME, CHAT, [message("1", "edited")]);
      assertEquals((await store.tail(ME, CHAT, 10))?.[0]?.text, "edited");
      await store.flush();
      assertEquals(
        (await createMessageStore(root).tail(ME, CHAT, 10))?.[0]?.text,
        "edited",
      );
    } finally {
      await store.flush();
    }
  });
});

Deno.test("invalid JSONL values do not wedge the cold-load write chain", async () => {
  await withDir(async (root) => {
    await seed(root);
    const path = `${root}/${ME}/${CHAT}.jsonl`;
    await Deno.writeTextFile(path, 'null\n[]\n{"id":{"toString":"bad"}}\n', {
      append: true,
    });
    const store = createMessageStore(root, { compactMinLines: 2 });
    try {
      store.append(ME, CHAT, [message("1", "edited")]);
      store.tombstone(ME, CHAT, "2");
      assertUpdated(await store.tail(ME, CHAT, 10));
      await store.flush();
      assertUpdated(await createMessageStore(root).tail(ME, CHAT, 10));
    } finally {
      await store.flush().catch(() => {});
    }
  });
});

Deno.test("concurrent cold readers share load and include updates during flush", async () => {
  await withDir(async (root) => {
    await seed(root);
    const store = createMessageStore(root), read = Deno.readTextFile;
    const entered = barrier(), resume = barrier();
    const path = `${root}/${ME}/${CHAT}.jsonl`;
    let reads = 0;
    Deno.readTextFile = async (name, options) => {
      const text = await read(name, options);
      if (String(name) === path) {
        reads++;
        entered.release();
        await resume.promise;
      }
      return text;
    };
    try {
      const tail = store.tail(ME, CHAT, 10);
      await entered.promise;
      const row = store.get(ME, CHAT, "1");
      const page = store.pageBefore(ME, CHAT, "3", 10);
      store.append(ME, CHAT, [message("1", "edited")]);
      store.tombstone(ME, CHAT, "2");
      const flushing = store.flush();
      resume.release();
      const [all, one, older] = await Promise.all([tail, row, page, flushing]);
      assertEquals(reads, 1);
      assertUpdated(all);
      assertEquals(one?.text, "edited");
      assertUpdated(older);
      assertUpdated(await store.tail(ME, CHAT, 10));
    } finally {
      resume.release();
      Deno.readTextFile = read;
      await store.flush();
    }
  });
});

Deno.test("cold load orders a preceding flush and updates made during read", async () => {
  await withDir(async (root) => {
    await seed(root);
    const store = createMessageStore(root), read = Deno.readTextFile;
    const entered = barrier(), resume = barrier();
    const path = `${root}/${ME}/${CHAT}.jsonl`;
    Deno.readTextFile = async (name, options) => {
      const text = await read(name, options);
      if (String(name) === path) {
        entered.release();
        await resume.promise;
      }
      return text;
    };
    try {
      store.append(ME, CHAT, [message("1", "first edit")]);
      const before = store.flush();
      const tail = store.tail(ME, CHAT, 10);
      await entered.promise;
      store.append(ME, CHAT, [message("1", "edited")]);
      store.tombstone(ME, CHAT, "2");
      const after = store.flush();
      resume.release();
      const [rows] = await Promise.all([tail, before, after]);
      assertUpdated(rows);
      assertUpdated(await store.tail(ME, CHAT, 10));
      Deno.readTextFile = read;
      assertUpdated(await createMessageStore(root).tail(ME, CHAT, 10));
    } finally {
      resume.release();
      Deno.readTextFile = read;
      await store.flush();
    }
  });
});

Deno.test("updates during compaction survive its rename and cold reopen", async () => {
  await withDir(async (root) => {
    await seed(root);
    const seedStore = createMessageStore(root, {
      compactMinLines: Number.MAX_SAFE_INTEGER,
    });
    for (let i = 0; i < 10; i++) {
      seedStore.append(ME, CHAT, [message("1", `old ${i}`)]);
    }
    await seedStore.flush();
    const store = createMessageStore(root, { compactMinLines: 2 });
    const read = Deno.readTextFile, entered = barrier(), resume = barrier();
    const path = `${root}/${ME}/${CHAT}.jsonl`;
    let reads = 0;
    Deno.readTextFile = async (name, options) => {
      const text = await read(name, options);
      if (String(name) === path && ++reads === 2) {
        entered.release();
        await resume.promise;
      }
      return text;
    };
    try {
      assertEquals((await store.tail(ME, CHAT, 10))?.[0]?.text, "old 9");
      await entered.promise;
      for (let i = 0; i < 70; i++) await store.tail(ME, `c-${i}`, 10);
      store.append(ME, CHAT, [message("1", "edited")]);
      store.tombstone(ME, CHAT, "2");
      const flushing = store.flush();
      resume.release();
      await flushing;
      assertUpdated(await store.tail(ME, CHAT, 10));
      Deno.readTextFile = read;
      assertUpdated(await createMessageStore(root).tail(ME, CHAT, 10));
    } finally {
      resume.release();
      Deno.readTextFile = read;
      await store.flush();
    }
  });
});

Deno.test("LRU drains more than 64 dirty chats before evicting them", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    for (let i = 0; i < 70; i++) {
      store.append(ME, `c-${i}`, [message("1", `chat ${i}`)]);
    }
    await store.flush();
    for (let i = 0; i < 70; i++) {
      const rows = await store.tail(ME, `c-${i}`, 10);
      assertEquals(rows?.[0]?.text, `chat ${i}`);
    }
  });
});

Deno.test("LRU keeps a loading chat coherent and can reload it after eviction", async () => {
  await withDir(async (root) => {
    await seed(root);
    const store = createMessageStore(root), read = Deno.readTextFile;
    const entered = barrier(), resume = barrier();
    const path = `${root}/${ME}/${CHAT}.jsonl`;
    let reads = 0;
    Deno.readTextFile = async (name, options) => {
      const text = await read(name, options);
      if (String(name) === path && ++reads === 1) {
        entered.release();
        await resume.promise;
      }
      return text;
    };
    try {
      const first = store.tail(ME, CHAT, 10);
      await entered.promise;
      store.append(ME, CHAT, [message("1", "edited")]);
      store.tombstone(ME, CHAT, "2");
      for (let i = 0; i < 70; i++) await store.tail(ME, `c-${i}`, 10);
      const second = store.tail(ME, CHAT, 10);
      resume.release();
      const [a, b] = await Promise.all([first, second]);
      assertEquals(reads, 1, "the in-flight load remains shared");
      assertUpdated(a);
      assertUpdated(b);
      await store.flush();
      for (let i = 0; i < 70; i++) await store.tail(ME, `c-${i}`, 10);
      assertUpdated(await store.tail(ME, CHAT, 10));
      assertEquals(reads, 2, "the quiescent chat is eventually evicted");
    } finally {
      resume.release();
      Deno.readTextFile = read;
      await store.flush();
    }
  });
});
