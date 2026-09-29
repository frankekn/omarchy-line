/**
 * The event ring and the state-write rate limiter.
 *
 *   deno test -A events_test.ts
 *
 * These two are what turn a push into a bubble the panel can draw without
 * asking for anything: pushEvent numbers the event, and scheduleStateWrite
 * decides when state.json is allowed to change. The number has to be strictly
 * increasing (the panel keeps a watermark) and the write has to coalesce (a
 * photo album is one burst of events and the panel re-parses the whole file on
 * every change).
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const WRITE_PRELUDE = `
let writes = 0;
function writeState(): void { writes++; }
export function written(): number { return writes; }
export { scheduleStateWrite, noteStateWritten, STATE_WRITE_MIN_MS };
`;

const RING_PRELUDE = `
interface PluginEvent {
  seq: number;
  at: number;
  kind: "message" | "read" | "reaction" | "unsend";
  chat: string;
  message?: Record<string, unknown>;
  by?: string;
  upTo?: string;
  messageId?: string;
  reactions?: unknown[];
}
let scheduled = 0;
function scheduleEventsWrite(): void { scheduled++; }
export function writesAsked(): number { return scheduled; }
export { pushEvent, events, EVENTS_MAX };
`;

interface WriteModule {
  STATE_WRITE_MIN_MS: number;
  scheduleStateWrite(now?: number): void;
  noteStateWritten(now?: number): void;
  written(): number;
}
interface TestEvent {
  seq: number;
  at: number;
  kind: string;
  chat: string;
  message?: Record<string, unknown>;
  messageId?: string;
  by?: string;
  upTo?: string;
  reactions?: unknown[];
}
interface RingModule {
  EVENTS_MAX: number;
  events: TestEvent[];
  pushEvent(event: Omit<TestEvent, "seq" | "at">): TestEvent;
  writesAsked(): number;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("the first write after a quiet spell goes out at once", async () => {
  const m = await loadBlock<WriteModule>("statewrite", WRITE_PRELUDE);
  m.scheduleStateWrite(1_000_000);
  assertEquals(m.written(), 1);
});

Deno.test("a burst inside one window costs exactly one more write", async () => {
  const m = await loadBlock<WriteModule>("statewrite", WRITE_PRELUDE);
  const t = 5_000_000;
  m.noteStateWritten(t);
  for (let i = 1; i <= 20; i++) m.scheduleStateWrite(t + i);
  // Every one of those is inside the window, so nothing has gone out yet --
  // and only one is owed, not twenty.
  assertEquals(m.written(), 0);
  await delay(m.STATE_WRITE_MIN_MS + 60);
  assertEquals(m.written(), 1);
});

Deno.test("a write from elsewhere cancels the queued one", async () => {
  const m = await loadBlock<WriteModule>("statewrite", WRITE_PRELUDE);
  const t = 7_000_000;
  m.noteStateWritten(t);
  m.scheduleStateWrite(t + 10);
  // The heartbeat, a login edge or refreshChats writing on its own: state.json
  // is already current, so the timer must not fire a second write behind it.
  m.noteStateWritten(t + 20);
  await delay(m.STATE_WRITE_MIN_MS + 60);
  assertEquals(m.written(), 0);
});

Deno.test("seq is strictly increasing and never reused", async () => {
  const m = await loadBlock<RingModule>("eventring", RING_PRELUDE);
  const a = m.pushEvent({ kind: "read", chat: "c1", by: "u1", upTo: "9" });
  const b = m.pushEvent({ kind: "unsend", chat: "c1", messageId: "9" });
  assertEquals(a.seq, 1);
  assertEquals(b.seq, 2);
  assert(b.at >= a.at, "at moves forward with wall clock");
  assertEquals(m.writesAsked(), 2);
});

Deno.test("the ring keeps the newest EVENTS_MAX and renumbers nothing", async () => {
  const m = await loadBlock<RingModule>("eventring", RING_PRELUDE);
  const n = m.EVENTS_MAX + 25;
  for (let i = 0; i < n; i++) {
    m.pushEvent({ kind: "unsend", chat: "c1", messageId: String(i) });
  }
  assertEquals(m.events.length, m.EVENTS_MAX);
  // The oldest 25 fell off; what is left still carries the seq it was given,
  // which is the whole point -- a panel that saw seq 30 must be able to tell
  // that everything up to it is gone.
  assertEquals(m.events[0].seq, 26);
  assertEquals(m.events[m.EVENTS_MAX - 1].seq, n);
  assertEquals(m.events[m.EVENTS_MAX - 1].messageId, String(n - 1));
});

Deno.test("kinds keep their own payload fields", async () => {
  const m = await loadBlock<RingModule>("eventring", RING_PRELUDE);
  const msg = m.pushEvent({
    kind: "message",
    chat: "c1",
    message: { id: "1", text: "hi" },
  });
  const read = m.pushEvent({ kind: "read", chat: "c1", by: "u2", upTo: "1" });
  const react = m.pushEvent({
    kind: "reaction",
    chat: "c1",
    messageId: "1",
    reactions: [{ type: "NICE", count: 1, mine: false }],
  });
  assertEquals(msg.message, { id: "1", text: "hi" });
  assertEquals(msg.messageId, undefined);
  assertEquals(read.by, "u2");
  assertEquals(read.upTo, "1");
  assertEquals(react.reactions, [{ type: "NICE", count: 1, mine: false }]);
});
