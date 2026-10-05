/**
 * stateWriteOwed(): whether a full refresh round has anything to put in
 * state.json. A round that changed nothing the panel shows used to rewrite
 * (and fsync) the whole file anyway, and every open panel re-parsed it.
 *
 *   deno test -A statepublished_test.ts
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface PublishedModule {
  stateWriteOwed(): boolean;
  noteStatePublished(
    revision: number,
    refresh: { failures: number } | null | undefined,
  ): void;
  setRevision(value: number): void;
  setRefresh(value: { at: number; failures: number } | null): void;
}

const PRELUDE = `
let chatsRevision = 0;
let refresh: { at: number; failures: number } | null = null;
function refreshHealthValue() { return refresh; }
export function setRevision(value: number) { chatsRevision = value; }
export function setRefresh(value: { at: number; failures: number } | null) {
  refresh = value;
}
export { noteStatePublished, stateWriteOwed };
`;

async function load(): Promise<PublishedModule> {
  return await loadBlock<PublishedModule>("statepublished", PRELUDE);
}

Deno.test("nothing committed yet means a write is owed", async () => {
  const m = await load();
  assertEquals(m.stateWriteOwed(), true);
});

Deno.test("a round that moved nothing owes no write", async () => {
  const m = await load();
  m.setRevision(4);
  m.setRefresh({ at: 1, failures: 0 });
  m.noteStatePublished(4, { failures: 0 });
  // A later success only moves `at`, which the panel does not show.
  m.setRefresh({ at: 2, failures: 0 });
  assertEquals(m.stateWriteOwed(), false);
});

Deno.test("a revision the file has not carried is owed", async () => {
  const m = await load();
  m.setRevision(4);
  m.noteStatePublished(4, null);
  m.setRevision(5);
  assertEquals(m.stateWriteOwed(), true);
  m.noteStatePublished(5, null);
  assertEquals(m.stateWriteOwed(), false);
});

Deno.test("a failure count the panel may be showing is owed when it clears", async () => {
  const m = await load();
  m.setRevision(4);
  m.setRefresh({ at: 1, failures: 3 });
  m.noteStatePublished(4, { failures: 3 });
  assertEquals(m.stateWriteOwed(), false);
  // The success that ends the streak: the stale-list notice has to go.
  m.setRefresh({ at: 9, failures: 0 });
  assertEquals(m.stateWriteOwed(), true);
});

Deno.test("the first success after a file without refresh health is owed", async () => {
  const m = await load();
  m.setRevision(4);
  m.noteStatePublished(4, undefined);
  m.setRefresh({ at: 1, failures: 0 });
  assertEquals(m.stateWriteOwed(), true);
});

Deno.test("the ledger is fed at the commit and read by the full round", async () => {
  const state = await Deno.readTextFile(
    new URL("./modules/state.ts", import.meta.url),
  );
  const write = state.indexOf("function writeState(");
  const rename = state.indexOf("await Deno.rename(tmp, STATE_PATH)", write);
  const note = state.indexOf("noteStatePublished(", rename);
  const end = state.indexOf("// enil:statepersist-end", write);
  assertEquals(
    write >= 0 && rename > write && note > rename && note < end,
    true,
  );
  const refresh = await Deno.readTextFile(
    new URL("./modules/refresh.ts", import.meta.url),
  );
  const round = refresh.slice(
    refresh.indexOf("async function runRefresh("),
    refresh.indexOf("// The block between the enil:incremental markers"),
  );
  assertEquals(
    round.includes("if (stateWriteOwed()) await writeState();"),
    true,
  );
});
