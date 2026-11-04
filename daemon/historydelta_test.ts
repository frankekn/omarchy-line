/** Which rows a revalidated history page puts in the event ring. */
import { assertEquals } from "@std/assert";
import { historyDelta } from "./modules/protocol.ts";
import type { PluginMessage } from "./modules/types.ts";

function row(id: string, extra: Partial<PluginMessage> = {}): PluginMessage {
  return { id, text: `t${id}`, ...extra } as PluginMessage;
}

Deno.test("an unchanged page carries nothing", () => {
  const page = [row("1"), row("2"), row("3")];
  assertEquals(historyDelta(page, page.map((m) => ({ ...m }))), []);
});

Deno.test("only rows that are new or changed are carried", () => {
  const served = [
    row("1"),
    row("2", { readBy: { count: 1, all: false } }),
    row("3"),
  ];
  const fresh = [
    row("1"),
    row("2", { readBy: { count: 2, all: false } }), // read count moved
    row("3", { unsent: true }), // recalled
    row("4"), // arrived while away
  ];
  assertEquals(historyDelta(served, fresh).map((m) => m.id), ["2", "3", "4"]);
});

Deno.test("a different page length with the same rows carries nothing", () => {
  const served = [row("0"), row("1"), row("2")];
  assertEquals(historyDelta(served, [row("1"), row("2")]), []);
});
