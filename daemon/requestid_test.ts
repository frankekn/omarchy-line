import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface RequestIdModule {
  messageRequestId(meta: Record<string, unknown>): string | undefined;
  panelRequestId(req: Record<string, unknown>): string;
}

const PRELUDE = `
type Json = Record<string, unknown>;
export { messageRequestId, panelRequestId };
`;

Deno.test("message correlation accepts only a non-empty string token", async () => {
  const m = await loadBlock<RequestIdModule>("requestid", PRELUDE);
  assertEquals(
    m.messageRequestId({ ENIL_REQUEST_ID: "panel-1-1700000000000-7" }),
    "panel-1-1700000000000-7",
  );
  for (const value of [undefined, "", 7, false, null, {}]) {
    assertEquals(m.messageRequestId({ ENIL_REQUEST_ID: value }), undefined);
  }
});

Deno.test("outgoing correlation accepts only a non-empty string token", async () => {
  const m = await loadBlock<RequestIdModule>("requestid", PRELUDE);
  assertEquals(
    m.panelRequestId({ requestId: "panel-request-11" }),
    "panel-request-11",
  );
  for (const value of [undefined, "", 7, false, null, {}]) {
    assertEquals(m.panelRequestId({ requestId: value }), "");
  }
});
