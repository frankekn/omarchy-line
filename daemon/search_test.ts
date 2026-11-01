/**
 * Full-text search over the message store: matching, order, limits, query
 * validation, hidden chats, torn lines, edits and unsend tombstones.
 *
 *   deno test -A search_test.ts
 *
 * Runs against real temp directories written by the real store, like
 * store_test.ts: the JSONL layout is the contract.
 */
import { assert, assertEquals } from "@std/assert";
import { createMessageStore } from "./modules/store.ts";
import {
  foldedIndex,
  SEARCH_LIMIT_MAX,
  SEARCH_QUERY_MAX,
  type SearchArgs,
  searchArgs,
  searchMessages,
  snippetOf,
} from "./modules/search.ts";

const ME = "u" + "0".repeat(31) + "1";
const A = "c" + "a".repeat(31);
const B = "c" + "b".repeat(31);
const PEER = "u" + "f".repeat(31);

function msg(id: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    id: String(id),
    from: PEER,
    to: A,
    createdTime: 1700000000000 + id,
    contentType: "NONE",
    text,
    ...extra,
  };
}

function args(q: string, more: Partial<SearchArgs> = {}): SearchArgs {
  return { q, chat: "", limit: 30, before: 0, ...more };
}

async function withDir(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-search-" });
  try {
    await fn(`${dir}/messages`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function deps(root: string, hidden: string[] = [], order: string[] = []) {
  return {
    root,
    myMid: ME,
    order,
    isHidden: (m: string) => hidden.includes(m),
  };
}

Deno.test("matches case-insensitively, CJK too, newest first", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    store.append(ME, A, [msg(1, "Hello World"), msg(3, "晚上吃飯嗎")]);
    store.append(ME, B, [msg(2, "say HELLO again"), msg(4, "nothing")]);
    await store.flush();
    const en = await searchMessages(deps(root), args("hello"));
    assertEquals(en.hits.map((h) => [h.chat, h.id]), [[B, "2"], [A, "1"]]);
    assertEquals(en.hits[0].from, PEER);
    assertEquals(en.hits[0].time, 1700000000002);
    const s = en.hits[0];
    assertEquals(s.snippet.slice(s.match[0], s.match[1]), "HELLO");
    const zh = await searchMessages(deps(root), args("吃飯"));
    assertEquals(zh.hits.map((h) => h.id), ["3"]);
    assertEquals(zh.partial, false);
    assertEquals(zh.scanned, 2);
  });
});

Deno.test("limit caps the hits and reports more; before pages", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    store.append(ME, A, Array.from({ length: 50 }, (_, i) => msg(i + 1, "x")));
    await store.flush();
    const first = await searchMessages(deps(root), args("x", { limit: 10 }));
    assertEquals(first.hits.length, 10);
    assertEquals(first.hits[0].id, "50");
    assertEquals(first.more, true);
    const next = await searchMessages(
      deps(root),
      args("x", { limit: 10, before: first.hits[9].time }),
    );
    assertEquals(next.hits[0].id, "40");
    const tail = await searchMessages(
      deps(root),
      args("x", { limit: 10, before: 1700000000005 }),
    );
    assertEquals(tail.hits.map((h) => h.id), ["4", "3", "2", "1"]);
    assertEquals(tail.more, false);
  });
});

Deno.test("hidden chats are skipped unless named", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    store.append(ME, A, [msg(1, "secret plan")]);
    store.append(ME, B, [msg(2, "secret too")]);
    await store.flush();
    const all = await searchMessages(deps(root, [A]), args("secret"));
    assertEquals(all.hits.map((h) => h.chat), [B]);
    const named = await searchMessages(
      deps(root, [A]),
      args("secret", { chat: A }),
    );
    assertEquals(named.hits.map((h) => h.chat), [A]);
  });
});

Deno.test("tombstones, UNSENT metadata and edits drop hits", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    store.append(ME, A, [
      msg(1, "keep needle"),
      msg(2, "recalled needle"),
      msg(3, "edited needle"),
      msg(4, "meta needle", { contentMetadata: { UNSENT: "true" } }),
    ]);
    store.tombstone(ME, A, "2");
    // An edit is a whole new line for the same id; this one lost the word.
    store.append(ME, A, [msg(3, "edited away")]);
    // A late re-fetch of a recalled message must not bring it back.
    store.append(ME, A, [msg(2, "recalled needle")]);
    await store.flush();
    const r = await searchMessages(deps(root), args("needle"));
    assertEquals(r.hits.map((h) => h.id), ["1"]);
  });
});

Deno.test("torn lines, non-text and encrypted lines are skipped", async () => {
  await withDir(async (root) => {
    await Deno.mkdir(`${root}/${ME}`, { recursive: true });
    const lines = [
      JSON.stringify({ chatMid: A, ...msg(1, "good needle") }),
      '{"chatMid":"' + A + '","id":"2","text":"torn needle',
      "not json needle",
      JSON.stringify({
        chatMid: A,
        ...msg(3, "", { contentType: "IMAGE", text: "needle" }),
      }),
      // A Letter-Sealed line from a history page: chunks, no text.
      JSON.stringify({
        chatMid: A,
        ...msg(4, "", {
          text: undefined,
          chunks: [{ type: "Buffer", data: [110, 101, 101] }],
          contentMetadata: { e2eeVersion: "2" },
        }),
      }),
      "[1,2,3]",
      "",
    ];
    await Deno.writeTextFile(`${root}/${ME}/${A}.jsonl`, lines.join("\n"));
    // Not a chat file name; never read.
    await Deno.writeTextFile(`${root}/${ME}/x.jsonl.tmp`, "needle");
    const r = await searchMessages(deps(root), args("needle"));
    assertEquals(r.hits.map((h) => h.id), ["1"]);
  });
});

Deno.test("query characters that JSON escapes still match", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    store.append(ME, A, [msg(1, 'say "hi"\nC:\\path')]);
    await store.flush();
    for (const q of ['"hi"', "C:\\PATH", 'hi"\nc']) {
      const r = await searchMessages(deps(root), args(q));
      assertEquals(r.hits.length, 1, q);
    }
    const r = await searchMessages(deps(root), args('"hi"'));
    assertEquals(r.hits[0].snippet, 'say "hi" C:\\path');
  });
});

Deno.test("chat order decides scan order; budget cut reports partial", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    store.append(ME, A, [msg(1, "needle a")]);
    store.append(ME, B, [msg(2, "needle b")]);
    await store.flush();
    let clock = 0;
    const r = await searchMessages({
      ...deps(root, [], [B, A]),
      // Each clock read is one second: the deadline, the check before B and
      // the one after B's only read fit in 2.5 s; the check before A does
      // not.
      now: () => clock++ * 1000,
      budgetMs: 2500,
    }, args("needle"));
    assertEquals(r.partial, true);
    assertEquals(r.hits.map((h) => h.chat), [B]);
  });
});

Deno.test("a missing account dir or a bad mid finds nothing", async () => {
  await withDir(async (root) => {
    const none = await searchMessages(deps(root), args("x"));
    assertEquals(none.hits, []);
    const bad = await searchMessages(
      { ...deps(root), myMid: "../x" },
      args("x"),
    );
    assertEquals(bad.hits, []);
  });
});

Deno.test("searchArgs validates query, chat, limit and before", () => {
  assertEquals(searchArgs({}), { error: "沒有搜尋文字" });
  assertEquals(searchArgs({ q: "   " }), { error: "沒有搜尋文字" });
  assertEquals(searchArgs({ q: 5 }), { error: "沒有搜尋文字" });
  assertEquals(
    searchArgs({ q: "x".repeat(SEARCH_QUERY_MAX + 1) }),
    { error: "搜尋文字太長" },
  );
  assert(!("error" in searchArgs({ q: "x".repeat(SEARCH_QUERY_MAX) })));
  for (const chat of ["../a", "a/b", "a.jsonl", "x".repeat(129)]) {
    assertEquals(searchArgs({ q: "x", chat }), { error: "不支援的聊天室" });
  }
  assertEquals(searchArgs({ q: " hi ", chat: A, limit: 500, before: "12" }), {
    q: "hi",
    chat: A,
    limit: SEARCH_LIMIT_MAX,
    before: 12,
  });
  assertEquals(searchArgs({ q: "hi", limit: "5" }), {
    q: "hi",
    chat: "",
    limit: 30,
    before: 0,
  });
  assertEquals(searchArgs({ q: "hi", before: "-1" }), { error: "before 不對" });
  assertEquals(searchArgs({ q: "hi", before: 1.5 }), { error: "before 不對" });
});

Deno.test("foldedIndex maps back through length-changing case folds", () => {
  assertEquals(foldedIndex("ABC", "b"), [1, 2]);
  // İ lower-cases to two code units; the hit after it still lines up.
  const text = "İstanbul NEEDLE";
  const at = foldedIndex(text, "needle")!;
  assertEquals(text.slice(at[0], at[1]), "NEEDLE");
  assertEquals(foldedIndex("abc", "x"), null);
});

Deno.test("snippetOf keeps about 120 code units around the hit", () => {
  const text = "a".repeat(300) + "NEEDLE" + "b".repeat(300);
  const { snippet, match } = snippetOf(text, 300, 306);
  assert(snippet.length <= 122);
  assert(snippet.startsWith("…") && snippet.endsWith("…"));
  assertEquals(snippet.slice(match[0], match[1]), "NEEDLE");
  const short = snippetOf("line one\nline two", 9, 13);
  assertEquals(short.snippet, "line one line two");
  assertEquals(short.match, [9, 13]);
  // A cut never lands inside a surrogate pair.
  const emoji = "😀".repeat(100) + "x";
  const cut = snippetOf(emoji, 200, 201);
  assert(!/^…?[\udc00-\udfff]/.test(cut.snippet));
  assertEquals(cut.snippet.slice(cut.match[0], cut.match[1]), "x");
});

Deno.test("a recall in an earlier, skipped slice still holds", async () => {
  await withDir(async (root) => {
    const store = createMessageStore(root);
    store.tombstone(ME, A, "1");
    // Well past one 512 KiB slice of lines that never match.
    const filler = "y".repeat(1000);
    store.append(
      ME,
      A,
      Array.from({ length: 800 }, (_, i) => msg(i + 10, filler)),
    );
    store.append(ME, A, [msg(1, "late needle"), msg(2, "fresh needle")]);
    await store.flush();
    const r = await searchMessages(deps(root), args("needle"));
    assertEquals(r.hits.map((h) => h.id), ["2"]);
  });
});
