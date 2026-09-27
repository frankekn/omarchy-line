/**
 * `history` page size. The number the socket carries used to go straight into
 * `messagesCount` -- `Number(req.count ?? 30)`, no bound at either end -- so a
 * hand-typed 100000 was a hundred-thousand-message request to LINE, and NaN,
 * 0, -5 or 60.5 were all malformed requests we sent anyway. The panel now
 * lets the reader pick the page size, which is exactly why this end needs its
 * own bound: the socket is a contract, not an assumption about who is calling.
 *
 *   deno test -A histcount_test.ts
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

async function loadModule() {
  return await loadBlock<{
    HISTORY_COUNT: number;
    HISTORY_COUNT_MAX: number;
    historyCount(raw: unknown): number;
  }>(
    "histcount",
    "export { HISTORY_COUNT, HISTORY_COUNT_MAX, historyCount };",
  );
}

Deno.test("a missing count is the default, not zero", async () => {
  const m = await loadModule();
  assertEquals(m.historyCount(undefined), m.HISTORY_COUNT);
  assertEquals(m.historyCount(null), m.HISTORY_COUNT);
});

Deno.test("something that is not a number at all is not a choice", async () => {
  const m = await loadModule();
  assertEquals(m.historyCount("abc"), m.HISTORY_COUNT);
  assertEquals(m.historyCount({}), m.HISTORY_COUNT);
  assertEquals(m.historyCount([1, 2]), m.HISTORY_COUNT);
  assertEquals(m.historyCount(NaN), m.HISTORY_COUNT);
  assertEquals(m.historyCount(Infinity), m.HISTORY_COUNT);
  assertEquals(m.historyCount(-Infinity), m.HISTORY_COUNT);
});

// The set above is only the half of it that `Number()` turns into NaN, which
// is why the rest went unnoticed: `Number("")`, `Number(" ")`, `Number([])`
// and `Number(false)` are all 0, and `Number([60])` is 60. Coerce first and a
// blank count lands on the clamp's floor -- one message, from a request that
// named no page size at all -- while stub.py answers 30 for every row here.
// Both ends and the README now say the same thing: a JSON number, or a string
// that parses as one, is a choice; nothing else is.
Deno.test("a value that coerces to a number is still not one", async () => {
  const m = await loadModule();
  for (const value of ["", " ", "   ", "\n", "\t", [], [60], true, false]) {
    assertEquals(m.historyCount(value), m.HISTORY_COUNT, JSON.stringify(value));
  }
});

Deno.test("an in-range count is carried through untouched", async () => {
  const m = await loadModule();
  for (const n of [1, 20, 30, 60, 100, 150, 200]) {
    assertEquals(m.historyCount(n), n);
  }
  // The panel's own steps and its clamp bounds all have to survive this end.
  for (const n of [20, 30, 60, 100, 150, 200]) {
    assertEquals(m.historyCount(String(n)), n);
  }
});

Deno.test("out of range is clamped, because it is still a choice", async () => {
  const m = await loadModule();
  assertEquals(m.historyCount(100000), m.HISTORY_COUNT_MAX);
  assertEquals(m.historyCount(201), m.HISTORY_COUNT_MAX);
  assertEquals(m.historyCount(0), 1);
  assertEquals(m.historyCount(-5), 1);
});

Deno.test("a count is a whole number of messages", async () => {
  const m = await loadModule();
  assertEquals(m.historyCount(60.5), 61);
  assertEquals(m.historyCount(59.4), 59);
  assertEquals(m.historyCount("60.5"), 61);
});

Deno.test("the bound the panel clamps to is the bound reachable here", async () => {
  const m = await loadModule();
  const panel = await Deno.readTextFile(
    new URL("../Panel.qml", import.meta.url),
  );
  const clamp = /return Math\.max\(20, Math\.min\((\d+), n\)\)/.exec(panel);
  assertEquals(clamp?.[1], String(m.HISTORY_COUNT_MAX));
  // Every step the panel's button can reach must survive this end unchanged,
  // or the button would name a page size the daemon quietly refuses to fetch.
  const steps = JSON.parse(
    /readonly property var historySteps: (\[[^\]]*\])/.exec(panel)![1],
  ) as number[];
  for (const n of steps) assertEquals(m.historyCount(n), n);
});

Deno.test("the history handler asks through the clamp, not Number()", async () => {
  const src = await Deno.readTextFile(
    new URL("./modules/socket.ts", import.meta.url),
  );
  assertEquals(src.includes("const count = historyCount(req.count);"), true);
  assertEquals(src.includes("Number(req.count"), false);
});
