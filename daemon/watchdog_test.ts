/**
 * The push watchdog: staleness detection, coalescing, and the 1s..60s backoff.
 *
 * Imports nothing from the live daemon -- it slices the block between the
 * `enil:watchdog` markers out of daemon.ts and runs it on stub module state, so
 * no LINE session, no socket and no state dir are touched.
 *
 *   deno test -A watchdog_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface WatchClient {
  base: {
    push: { conns: Array<{ close(): void } | null> };
    poll: { islisten: boolean };
  };
  listen(options?: unknown): void;
}
interface WatchdogModule {
  calls: { listen: number; close: number; refresh: number; write: number };
  backoffDelay(attempt: number): number;
  makeClient(): WatchClient;
  markPushAlive(): void;
  pushIsStale(now?: number): boolean;
  reconnectPush(reason: "stale" | "resume" | "error" | "manual"): Promise<void>;
  setClient(client: WatchClient | null): void;
  setLastPushAt(at: number): void;
  setLogin(login: { status: string; reason?: string }): void;
  state(): {
    lastPushAt: number;
    reconnecting: boolean;
    reconnectAttempts: number;
    nextReconnectAt: number;
  };
  watchdogTick(): void;
}

/** Stub module state + the real sliced code + a test handle. */
async function loadModule(opts: { staleMs?: number; grace?: number } = {}) {
  const prelude = `
type LoginState = { status: string; reason?: string };
type LinkState = { push: "up" | "down"; since: number };
type FakeConn = { close(): void };
type FakeClient = {
  base: { push: { conns: Array<FakeConn | null> }; poll: { islisten: boolean } };
  listen(options?: unknown): void;
};
export const calls = { halt: 0, listen: 0, close: 0, refresh: 0, write: 0 };
export const PUSH_STALE_MS = ${opts.staleMs ?? 180_000};
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
export const PUSH_REINIT_GRACE_MS = ${opts.grace ?? 20};
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
// The sliced block moves \`link\` across its edges. Left null here on purpose:
// these tests are about the reconnect logic, so the link helper has to be a
// no-op for them -- link_test.ts is where the edges themselves are asserted.
export let link: LinkState | null = null;
export let listenAbort: AbortController | null = null;
// The restriction halt (restriction.ts) gates the watchdog; the halt itself
// is a stub here, restriction_test.ts drives the real one.
export let restriction: { code: string; since: number } | null = null;
export function setRestriction(r: { code: string; since: number } | null) {
  restriction = r;
}
function setListenAbort(ctrl: AbortController) { listenAbort = ctrl; return ctrl; }
function abortListen() { listenAbort?.abort(); listenAbort = null; }
function haltForRestriction() { calls.halt++; }
export let client: FakeClient | null = null;
export function setClient(c: FakeClient | null) { client = c; }
export function setLogin(l: LoginState) { login = l; }
export function setLastPushAt(t: number) { lastPushAt = t; }
export function state() {
  return { lastPushAt, reconnecting, reconnectAttempts, nextReconnectAt };
}
export function makeClient(): FakeClient {
  const conn = { close() { calls.close++; } };
  return {
    base: {
      push: { conns: [conn] },
      poll: { islisten: true },   // linejs leaves this true when its loop dies
    },
    listen() { calls.listen++; },
  };
}
function writeState(): Promise<void> { calls.write++; return Promise.resolve(); }
function refreshChats(): Promise<void> { calls.refresh++; return Promise.resolve(); }
export { reconnectPush, watchdogTick, backoffDelay, markPushAlive, pushIsStale };
`;
  return await loadBlock<WatchdogModule>("watchdog", prelude);
}

Deno.test("backoff is 1,2,4,...,60s with jitter inside bounds", async () => {
  const m = await loadModule();
  const bases = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    for (let k = 0; k < 200; k++) {
      const d = m.backoffDelay(i + 1);
      assert(d >= base, `attempt ${i + 1}: ${d} < ${base}`);
      assert(d < base * 1.25, `attempt ${i + 1}: ${d} >= ${base * 1.25}`);
    }
  }
  // The cap holds however far the counter runs.
  assert(m.backoffDelay(99) < 60_000 * 1.25);
});

Deno.test("client === null is a no-op", async () => {
  const m = await loadModule();
  await m.reconnectPush("stale");
  assertEquals(m.calls.listen, 0);
  assertEquals(m.calls.close, 0);
  assertEquals(m.state().reconnectAttempts, 0);
});

Deno.test("a login in progress is a no-op", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  m.setLogin({ status: "qr" });
  await m.reconnectPush("stale");
  assertEquals(m.calls.listen, 0);
  assertEquals(m.state().reconnectAttempts, 0);
});

Deno.test("stale push triggers exactly one reconnect", async () => {
  const m = await loadModule({ staleMs: 1_000 });
  const c = m.makeClient();
  m.setClient(c);
  m.setLastPushAt(Date.now() - 5_000);
  assert(m.pushIsStale());
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(m.calls.close, 1);
  assertEquals(m.calls.listen, 1);
  assertEquals(m.calls.refresh, 1);
  assertEquals(m.state().reconnectAttempts, 1);
});

Deno.test("concurrent triggers coalesce into one reconnect", async () => {
  const m = await loadModule({ staleMs: 1_000, grace: 60 });
  m.setClient(m.makeClient());
  m.setLastPushAt(Date.now() - 5_000);
  const all = [
    m.reconnectPush("stale"),
    m.reconnectPush("resume"),
    m.reconnectPush("error"),
  ];
  m.watchdogTick();
  await Promise.all(all);
  await new Promise((r) => setTimeout(r, 120));
  assertEquals(m.calls.close, 1);
  assertEquals(m.calls.listen, 1);
  assertEquals(m.state().reconnectAttempts, 1);
});

Deno.test("watchdog respects the backoff window, then retries", async () => {
  const m = await loadModule({ staleMs: 1_000, grace: 5 });
  m.setClient(m.makeClient());
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(m.calls.listen, 1);
  const gate = m.state().nextReconnectAt;
  assert(gate > Date.now(), "backoff gate must be in the future");
  // Still stale, still inside the window: no second attempt.
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(m.calls.listen, 1);
});

Deno.test("a manual reconnect rebuilds the link without spending the backoff", async () => {
  // From a clean slate: the gate has to stay at 0 so the watchdog is still free
  // to act the moment it sees a gap. A manual sync that pushed the gate out
  // would delay the automatic safety net -- the opposite of what it is for.
  const fresh = await loadModule({ staleMs: 1_000, grace: 5 });
  fresh.setClient(fresh.makeClient());
  await fresh.reconnectPush("manual");
  assertEquals(fresh.state().reconnectAttempts, 0);
  assertEquals(fresh.state().nextReconnectAt, 0);
  assertEquals(fresh.calls.listen, 1, "it did reconnect, it is not a no-op");
  assertEquals(fresh.calls.close, 1);

  // And with an automatic attempt already paced: the counter and the gate the
  // watchdog set are left exactly as they were.
  const m = await loadModule({ staleMs: 1_000, grace: 5 });
  m.setClient(m.makeClient());
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  const paced = m.state();
  assertEquals(paced.reconnectAttempts, 1);
  assert(paced.nextReconnectAt > Date.now(), "the watchdog set a gate");

  await m.reconnectPush("manual");
  assertEquals(m.state().reconnectAttempts, 1, "the counter is untouched");
  assertEquals(
    m.state().nextReconnectAt,
    paced.nextReconnectAt,
    "and so is the gate",
  );
  assertEquals(m.calls.listen, 2, "the manual one still rebuilt the link");

  // The automatic reasons keep pacing themselves.
  m.setLastPushAt(Date.now() - 5_000);
  await m.reconnectPush("stale");
  assertEquals(m.state().reconnectAttempts, 2);
  assert(m.state().nextReconnectAt > paced.nextReconnectAt);
});

Deno.test("push traffic resets the attempt counter and the gate", async () => {
  const m = await loadModule({ staleMs: 1_000, grace: 5 });
  m.setClient(m.makeClient());
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(m.state().reconnectAttempts, 1);
  m.markPushAlive();
  assertEquals(m.state().reconnectAttempts, 0);
  assertEquals(m.state().nextReconnectAt, 0);
  assertEquals(m.pushIsStale(), false);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(m.calls.listen, 1); // not stale any more
});

Deno.test("islisten is cleared only when linejs did not rebuild the conn", async () => {
  // conns[0] unchanged after the grace wait => the library's pusher loop is
  // gone and listen() would be a silent no-op without the reset.
  const dead = await loadModule({ staleMs: 1_000, grace: 10 });
  const dc = dead.makeClient();
  dead.setClient(dc);
  dead.setLastPushAt(Date.now() - 5_000);
  await dead.reconnectPush("stale");
  assertEquals(dc.base.poll.islisten, false);

  // A fresh conn appeared => the loop healed itself; touching islisten would
  // start a second one.
  const alive = await loadModule({ staleMs: 1_000, grace: 40 });
  const c = alive.makeClient();
  alive.setClient(c);
  alive.setLastPushAt(Date.now() - 5_000);
  const t = setTimeout(() => c.base.push.conns[0] = { close() {} }, 10);
  await alive.reconnectPush("stale");
  clearTimeout(t);
  assertEquals(c.base.poll.islisten, true);
  assertEquals(alive.calls.listen, 1);
});
