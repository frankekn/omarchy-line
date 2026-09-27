import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface CursorCapModule {
  capCursors(): void;
  rememberPaginationCursor(chat: string, cursor: string): void;
  rememberBoxCursor(
    chat: string,
    cursor: { chat: string; messageId: bigint; deliveredTime: bigint },
  ): void;
  cursors: Map<
    string,
    { chat: string; messageId: bigint; deliveredTime: bigint }
  >;
  paginationCursors: Map<string, string>;
}

async function mod(max: number): Promise<CursorCapModule> {
  return await loadBlock<CursorCapModule>(
    "cursorcap",
    `
const CURSOR_CACHE_MAX = ${max};
interface MessageCursor { chat: string; messageId: bigint; deliveredTime: bigint; }
const cursors = new Map<string, MessageCursor>();
const paginationCursors = new Map<string, string>();
export {
  capCursors,
  rememberBoxCursor,
  rememberPaginationCursor,
  cursors,
  paginationCursors,
};
`,
  );
}

Deno.test("cursor eviction preserves box and active pagination boundaries", async () => {
  const m = await mod(3);
  const cursor = (id: number) => ({
    chat: "C1",
    messageId: BigInt(id),
    deliveredTime: BigInt(id),
  });
  m.cursors.set("box:C1", cursor(1));
  m.cursors.set("old", cursor(2));
  m.cursors.set("page", cursor(3));
  m.cursors.set("new", cursor(4));
  m.paginationCursors.set("page", "C1");
  m.capCursors();
  assertEquals([...m.cursors.keys()], ["box:C1", "page", "new"]);
});

Deno.test("old pagination boundaries are evicted with their cursors", async () => {
  const m = await mod(4);
  for (let i = 1; i <= 3; i++) {
    const cursor = `page-${i}`;
    m.cursors.set(cursor, {
      chat: `C${i}`,
      messageId: BigInt(i),
      deliveredTime: BigInt(i),
    });
    m.rememberPaginationCursor(`C${i}`, cursor);
  }
  assertEquals([...m.paginationCursors.entries()], [
    ["page-2", "C2"],
    ["page-3", "C3"],
  ]);
  assertEquals([...m.cursors.keys()], ["page-2", "page-3"]);
});

Deno.test("two readers keep distinct boundaries for the same chat", async () => {
  // Cap 5 with 6 cursors: the eviction must actually run, and its fallback
  // drops an unpinned boundary -- not either reader's still-live one. Under
  // the old per-chat keying both boundaries lose their pin and page-a dies.
  const m = await mod(5);
  m.cursors.set("page-a", { chat: "C1", messageId: 1n, deliveredTime: 1n });
  m.cursors.set("page-b", { chat: "C1", messageId: 2n, deliveredTime: 2n });
  m.rememberPaginationCursor("C1", "page-a");
  m.rememberPaginationCursor("C1", "page-b");
  for (let i = 0; i < 4; i++) {
    m.cursors.set(`other-${i}`, {
      chat: `C${i}`,
      messageId: BigInt(i),
      deliveredTime: BigInt(i),
    });
  }
  m.capCursors();
  assertEquals(m.cursors.has("page-a"), true);
  assertEquals(m.cursors.has("page-b"), true);
  assertEquals(m.cursors.size, 5);
});

Deno.test("a refresh cursor cannot replace a newer pushed box cursor", async () => {
  const m = await mod(10);
  m.rememberBoxCursor("C1", {
    chat: "C1",
    messageId: 200n,
    deliveredTime: 200n,
  });
  m.rememberBoxCursor("C1", {
    chat: "C1",
    messageId: 100n,
    deliveredTime: 100n,
  });
  assertEquals(m.cursors.get("box:C1")?.messageId, 200n);
});

Deno.test("history pins its returned oldest message and media uses its captured cursor", async () => {
  const source = [
    await Deno.readTextFile(
      new URL("./modules/messages.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/push.ts", import.meta.url)),
    await Deno.readTextFile(
      new URL("./modules/refresh.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/socket.ts", import.meta.url)),
  ].join("\n");
  assert(
    source.includes(
      'rememberPaginationCursor(chatMid, String(raws[0].id ?? ""))',
    ),
  );
  assert(source.includes("const current = cursors.get(id) ?? cursor;"));
  assert(source.includes("chat: boxId,"));
  assert(source.includes("chat: chatMid,\n    messageId: BigInt("));
  assert(
    source.includes(
      "if (!deferOrderedState) {\n    finalizeMessageState(out, raw, chatMid);",
    ),
  );
  assert(
    source.includes("finalizeMessageState(message, raw, chat);"),
  );
  const finalizer = source.slice(
    source.indexOf("function finalizeMessageState("),
    source.indexOf(
      "/** The plugin renders these URLs directly",
      source.indexOf("function finalizeMessageState("),
    ),
  );
  assert(finalizer.length > 0, "the finalizer source slice exists");
  assert(finalizer.indexOf("cursors.delete(out.id);") >= 0);
  assert(finalizer.indexOf("cursors.set(out.id, {") >= 0);
  assert(
    finalizer.indexOf("cursors.delete(out.id);") <
      finalizer.indexOf("cursors.set(out.id, {"),
    "reloading a message refreshes its Map insertion order before eviction",
  );
  assert(
    source.includes("!end || end.chat !== chatMid"),
  );
  assertEquals(
    source.match(/cursor\.chat !== String\(req\.chat \?\? ""\)/g)?.length,
    2,
  );
});

Deno.test("a successful refresh removes cursors for boxes no longer listed", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/refresh.ts", import.meta.url),
  );
  const refresh = source.slice(
    source.indexOf("async function runRefresh"),
    // A real marker: the section that actually follows runRefresh. An
    // indexOf that misses returns -1 and silently widens the slice to EOF.
    source.indexOf("// enil:incremental-begin"),
  );
  assert(refresh.includes("const nextBoxCursors = new Set<string>();"));
  assert(
    refresh.includes('!key.startsWith("box:") || nextBoxCursors.has(key)'),
  );
  // indexOf would answer -1 for a deleted guard and -1 < n is true, so the
  // completeness gate itself must be proven present before ordering matters.
  const gate = refresh.indexOf("if (boxes.hasNext !== true)");
  const prune = refresh.indexOf('!key.startsWith("box:")');
  assert(gate >= 0, "the partial-listing completeness gate is gone");
  assert(prune >= 0, "the box-cursor prune is gone");
  assert(gate < prune);
  assert(refresh.includes("if (!retainedPush) cursors.delete(key)"));
});
