// Incremental event catch-up: a first page gets only the ring's watermark,
// and a reconnecting page gets only the events after its position.
import { assert, tapSocket, until } from "./harness.js";

export async function eventsCatchup(h) {
  const { bootId } = await h.state();
  const path = `${h.stateDir}/events.json`;
  // Seqs well above the stub's own pushes, on a chat the page never opens.
  const read = (seq) => ({
    seq,
    at: Date.now(),
    kind: "read",
    chat: "cstub-catchup",
    upTo: String(seq),
    by: "u-other",
  });
  const ring = (seqs) =>
    JSON.stringify({ bootId, updatedAt: Date.now(), events: seqs.map(read) });
  const first = ring([101, 102, 103]);
  await Deno.writeTextFile(path, first);

  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  const tap = await tapSocket(page);
  const events = () => tap.received.filter((frame) => frame.web === "events");
  const seqs = (frame) => frame.events.events.map((event) => event.seq);
  await h.signIn(page);
  await until(() => events().length === 1, "first events frame");
  const initial = events()[0];
  assert.deepEqual(seqs(initial), [], "a first page gets no old events");
  assert.equal(initial.events.seq, 103);
  assert.equal(initial.events.bootId, bootId);
  const initialBytes = JSON.stringify(initial).length;
  const legacyBytes = `{"web":"events","events":${first}}`.length;
  assert(initialBytes < legacyBytes, `${initialBytes} < ${legacyBytes}`);
  h.step("events-first-connection-watermark-only");

  // Two events land while the page is away; the server side closes.
  await Deno.writeTextFile(path, ring([101, 102, 103, 104, 105]));
  const attempts = tap.received.length;
  await tap.socket.close({ code: 4001, reason: "daemon offline" });
  await page.locator("#connection.connected").waitFor();
  await until(() => events().length === 2, "reconnect events frame");
  const resumed = events()[1];
  assert.deepEqual(seqs(resumed), [104, 105], "only the new events");
  assert.equal(resumed.events.seq, 105);
  assert(tap.received.length > attempts);
  h.step("events-reconnect-only-new");

  // The daemon restarted: a new boot, seqs from 1 again. The page's old
  // position is meaningless, so it gets the whole new ring.
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      bootId: "stub-restarted",
      updatedAt: Date.now(),
      events: [1, 2].map(read),
    }),
  );
  await tap.socket.close({ code: 4001, reason: "daemon offline" });
  await until(() => events().length === 3, "restart events frame");
  assert.deepEqual(seqs(events()[2]), [1, 2]);
  assert.equal(events()[2].events.bootId, "stub-restarted");
  h.step("events-restart-whole-ring");
  await context.close();
}
