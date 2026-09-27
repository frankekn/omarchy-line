/**
 * The unhandled-rejection guard: what it logs, and when it claims a rejection
 * -- handing the push link to the watchdog instead of letting the process die.
 * A rejection it does not claim keeps Deno's fatal exit, so the boolean is the
 * contract installRejectionGuard() spends preventDefault on.
 *
 * The block is loaded on top of the real `enil:loginerror` and `enil:watchdog`
 * blocks rather than stubs of them, because the whole point of the unit is that
 * it reuses that classifier and that one reconnect path.
 *
 *   deno test -A unhandled_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock, sliceBlock } from "./slice_test.ts";

interface RejectClient {
  base: {
    push: { conns: Array<{ close(): void } | null> };
    poll: { islisten: boolean };
  };
  listen(options?: unknown): void;
}
interface RejectionModule {
  calls: { listen: number; close: number; refresh: number; write: number };
  logs: string[];
  makeClient(): RejectClient;
  onUnhandledRejection(reason: unknown): boolean;
  setClient(client: RejectClient | null): void;
  setNextReconnectAt(at: number): void;
  state(): {
    lastPushAt: number;
    reconnectAttempts: number;
    nextReconnectAt: number;
  };
}

async function loadModule() {
  const prelude = `
type LoginState = { status: string; reason?: string };
type LinkState = { push: "up" | "down"; since: number };
type FakeConn = { close(): void };
type FakeClient = {
  base: { push: { conns: Array<FakeConn | null> }; poll: { islisten: boolean } };
  listen(options?: unknown): void;
};
export const calls = { listen: 0, close: 0, refresh: 0, write: 0 };
export const logs: string[] = [];
export const PUSH_STALE_MS = 180_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
export const PUSH_REINIT_GRACE_MS = 5;
export let lastPushAt = Date.now();
export let reconnecting = false;
export let reconnectAttempts = 0;
export let nextReconnectAt = 0;
// reconnectPush forces the next round full; nothing here reads the flag.
let forceFullRefresh = true;
function setForceFullRefresh(value: boolean) {
  forceFullRefresh = value;
}
export let login: LoginState = { status: "ok" };
export let link: LinkState | null = null;
export let listenAbort: AbortController | null = null;
export let client: FakeClient | null = null;
export function setClient(c: FakeClient | null) { client = c; }
export function setNextReconnectAt(t: number) { nextReconnectAt = t; }
export function state() {
  return { lastPushAt, reconnectAttempts, nextReconnectAt };
}
export function makeClient(): FakeClient {
  return {
    base: {
      push: { conns: [{ close() { calls.close++; } }] },
      poll: { islisten: true },
    },
    listen() { calls.listen++; },
  };
}
const realError = console.error;
console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
addEventListener("unload", () => { console.error = realError; });
function writeState(): Promise<void> { calls.write++; return Promise.resolve(); }
function refreshChats(): Promise<void> { calls.refresh++; return Promise.resolve(); }
export { onUnhandledRejection };
` + (await sliceBlock("loginerror")) + "\n" + (await sliceBlock("watchdog"));
  return await loadBlock<RejectionModule>("unhandled", prelude);
}

/** The whole guard is fire-and-forget, so give reconnectPush a turn to run. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 60));
}

Deno.test("a reset socket reaches the watchdog's reconnect, not a new loop", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  // The real shape: Deno hangs the diagnostic off .cause.
  const handled = m.onUnhandledRejection(
    Object.assign(new TypeError("fetch failed"), {
      cause: new Error("connection reset"),
    }),
  );
  assertEquals(handled, true, "a reset is ours to swallow");
  assertEquals(m.state().lastPushAt, 0, "push must be reported as stale");
  await settle();
  assertEquals(m.calls.close, 1);
  assertEquals(m.calls.listen, 1);
  assertEquals(m.state().reconnectAttempts, 1);
});

Deno.test("a timed-out request is claimed, and the daemon lives", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  // 2026-09-07: two `[chats] refresh failed: The operation was aborted due to
  // timeout` lines, then this rejection from linejs' own AbortSignal.timeout
  // arrived through an unawaited promise, was not claimed, and Deno exited 1.
  const handled = m.onUnhandledRejection(
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ),
  );
  assertEquals(handled, true, "a timeout is a transport failure, so ours");
  assertEquals(
    m.logs[0],
    "[unhandled] TimeoutError: The operation was aborted due to timeout",
  );
  assertEquals(m.state().lastPushAt, 0, "push must be reported as stale");
  await settle();
  assertEquals(m.calls.close, 1);
  assertEquals(m.calls.listen, 1);
  assertEquals(m.state().reconnectAttempts, 1);
});

Deno.test("an aborted request is claimed the same way", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  const handled = m.onUnhandledRejection(
    new DOMException("The signal has been aborted", "AbortError"),
  );
  assertEquals(handled, true);
  await settle();
  assertEquals(m.calls.listen, 1);
});

Deno.test("a non-network rejection is logged and left fatal", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  const before = m.state().lastPushAt;
  // Unclaimed: the guard must not preventDefault, so Deno still exits 1 and
  // systemd restarts, rather than the daemon serving stale state past a bug.
  const handled = m.onUnhandledRejection(new RangeError("index out of range"));
  assertEquals(handled, false, "a bug is not ours to swallow");
  await settle();
  assertEquals(m.state().lastPushAt, before, "a bug is not a stale link");
  assertEquals(m.calls.listen, 0);
  assertEquals(m.calls.close, 0);
  assertEquals(m.state().reconnectAttempts, 0);
});

Deno.test("the log line carries the error name and message, nothing more", async () => {
  const m = await loadModule();
  m.onUnhandledRejection(new RangeError("index out of range"));
  assertEquals(m.logs.length, 1);
  assertEquals(m.logs[0], "[unhandled] RangeError: index out of range");
});

Deno.test("a rejection that is not an Error at all does not throw", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  for (const r of [undefined, null, "boom", 42]) {
    m.onUnhandledRejection(r);
  }
  await settle();
  assertEquals(m.calls.listen, 0);
  assert(m.logs.length === 4, `logged ${m.logs.length} lines`);
});

Deno.test("a burst of resets costs one reconnect, not one each", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  const reset = () => m.onUnhandledRejection(new TypeError("connection reset"));
  reset();
  await settle();
  assertEquals(m.calls.listen, 1);
  // The backoff gate set by the first attempt is what holds the rest off;
  // without going through watchdogTick each reset would rebuild the conn.
  assert(m.state().nextReconnectAt > Date.now());
  reset();
  reset();
  await settle();
  assertEquals(m.calls.listen, 1);
  assertEquals(m.state().reconnectAttempts, 1);
});

Deno.test("no session means no reconnect", async () => {
  const m = await loadModule();
  m.onUnhandledRejection(new TypeError("fetch failed"));
  await settle();
  assertEquals(m.calls.listen, 0);
  assertEquals(m.state().reconnectAttempts, 0);
});

Deno.test("a reset inside the backoff window is recorded but not acted on", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  // The gate the first reconnect attempt would have left behind: a reset that
  // lands inside it must not rebuild the conn, or a flapping link would be
  // reconnected as fast as linejs can reject.
  m.setNextReconnectAt(Date.now() + 30_000);
  const handled = m.onUnhandledRejection(new TypeError("fetch failed"));
  assertEquals(handled, true, "still a network failure, still claimed");
  assertEquals(m.state().lastPushAt, 0, "the gap is still recorded");
  assertEquals(m.logs[0], "[unhandled] TypeError: fetch failed");
  await settle();
  assertEquals(m.calls.listen, 0, "the backoff gate held");
  assertEquals(m.calls.close, 0);
  assertEquals(m.state().reconnectAttempts, 0);
});
