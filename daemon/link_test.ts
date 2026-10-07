/**
 * The `link` field: state.json's push-health report, and the rule that it is
 * written on edges only. A live session logs a [LEGY/PUSH] ping every 30s, so a
 * field written per ping would rewrite state.json faster than the 30s heartbeat
 * -- which is why every assertion here counts writeState() calls rather than
 * looking at the value alone.
 *
 * Same slicing as watchdog_test.ts: the `enil:watchdog` block off disk, on stub
 * module state. No LINE session, no socket, no state dir.
 *
 *   deno test -A link_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface LinkClient {
  base: {
    push: { conns: Array<{ close(): void } | null> };
    poll: { islisten: boolean };
  };
  listen(options?: unknown): void;
}
interface LinkModule {
  calls: { listen: number; close: number; refresh: number; write: number };
  getLink(): { push: "up" | "down"; since: number };
  makeClient(): LinkClient;
  markPushAlive(): void;
  pushIsStale(now?: number): boolean;
  reconnectPush(reason: "stale" | "resume" | "error" | "manual"): Promise<void>;
  setClient(client: LinkClient | null): void;
  setLastPushAt(at: number): void;
  setLink(link: { push: "up" | "down"; since: number } | null): void;
  setLinkState(state: "up" | "down"): void;
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
export function setLink(l: LinkState | null) { link = l; }
export function getLink() { return link; }
export function setLastPushAt(t: number) { lastPushAt = t; }
export function state() {
  return { lastPushAt, reconnecting, reconnectAttempts, nextReconnectAt };
}
export function makeClient(): FakeClient {
  const conn = { close() { calls.close++; } };
  return {
    base: {
      push: { conns: [conn] },
      poll: { islisten: true },
    },
    listen() { calls.listen++; },
  };
}
function writeState(): Promise<void> { calls.write++; return Promise.resolve(); }
function errorLine(e: unknown) { return String((e as { message?: unknown } | null)?.message ?? e); }
function refreshChats(): Promise<void> { calls.refresh++; return Promise.resolve(); }
export { reconnectPush, watchdogTick, markPushAlive, pushIsStale, setLinkState };
`;
  return await loadBlock<LinkModule>("watchdog", prelude);
}

/** The logged-in starting point: onLoggedIn() sets this before setLogin("ok"). */
function loggedIn(
  m: {
    setLink: (link: { push: "up" | "down"; since: number } | null) => void;
    calls: { write: number };
  },
) {
  m.setLink({ push: "up", since: 1 });
  m.calls.write = 0;
}

Deno.test("no session: link stays absent and nothing is written", async () => {
  const m = await loadModule();
  m.setLinkState("down");
  m.setLinkState("up");
  m.markPushAlive();
  assertEquals(m.getLink(), null);
  assertEquals(m.calls.write, 0);
});

Deno.test("up -> down writes once, however many times it is asked", async () => {
  const m = await loadModule();
  loggedIn(m);
  m.setLinkState("down");
  assertEquals(m.getLink().push, "down");
  assertEquals(m.calls.write, 1);
  const since = m.getLink().since;
  m.setLinkState("down");
  m.setLinkState("down");
  assertEquals(m.calls.write, 1);
  assertEquals(m.getLink().since, since); // no touch means no new timestamp
});

Deno.test("a ping while up writes nothing; the one after a down writes once", async () => {
  const m = await loadModule();
  loggedIn(m);
  // 30s pings on a healthy link: this is the case that must stay free.
  for (let i = 0; i < 50; i++) m.markPushAlive();
  assertEquals(m.calls.write, 0);
  assertEquals(m.getLink().push, "up");

  m.setLinkState("down");
  assertEquals(m.calls.write, 1);
  m.markPushAlive();
  assertEquals(m.getLink().push, "up");
  assertEquals(m.calls.write, 2);
  for (let i = 0; i < 50; i++) m.markPushAlive();
  assertEquals(m.calls.write, 2); // still one write per edge
});

Deno.test("watchdogTick marks down on the first stale tick only", async () => {
  const m = await loadModule({ staleMs: 1_000, grace: 5 });
  m.setClient(m.makeClient());
  loggedIn(m);

  m.watchdogTick(); // not stale yet
  assertEquals(m.calls.write, 0);
  assertEquals(m.getLink().push, "up");

  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(m.getLink().push, "down");
  assertEquals(m.calls.write, 1); // reconnectPush must not re-edge
  assertEquals(m.calls.listen, 1);

  // Still stale, now inside the backoff window: no reconnect, no second write.
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(m.calls.listen, 1);
  assertEquals(m.calls.write, 1);
});

Deno.test("down is set before the backoff gate, not after it", async () => {
  // The gate is what a long outage sits inside; a link reported "up" for a
  // whole minute of backoff would be the bug this field exists to remove.
  const m = await loadModule({ staleMs: 1_000, grace: 5 });
  m.setClient(m.makeClient());
  loggedIn(m);
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(m.calls.listen, 1);
  assert(m.state().nextReconnectAt > Date.now());

  // Traffic heals it, then it goes stale again while the old gate is gone.
  m.markPushAlive();
  assertEquals(m.getLink().push, "up");
  const writes = m.calls.write;
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  assertEquals(m.getLink().push, "down");
  assertEquals(m.calls.write, writes + 1);
});

Deno.test("a resume reconnect marks down without waiting for staleness", async () => {
  // reconnectPush("resume") runs 3s after logind says the box woke up, long
  // before PUSH_STALE_MS could have elapsed.
  const m = await loadModule({ staleMs: 180_000, grace: 5 });
  m.setClient(m.makeClient());
  loggedIn(m);
  assertEquals(m.pushIsStale(), false);
  const p = m.reconnectPush("resume");
  assertEquals(m.getLink().push, "down"); // set synchronously, before the wait
  assertEquals(m.calls.write, 1);
  await p;
  assertEquals(m.calls.write, 1);
});

Deno.test("a coalesced reconnect storm is still one down edge", async () => {
  const m = await loadModule({ staleMs: 1_000, grace: 60 });
  m.setClient(m.makeClient());
  loggedIn(m);
  m.setLastPushAt(Date.now() - 5_000);
  const all = [
    m.reconnectPush("stale"),
    m.reconnectPush("resume"),
    m.reconnectPush("error"),
  ];
  m.watchdogTick();
  await Promise.all(all);
  await new Promise((r) => setTimeout(r, 120));
  assertEquals(m.calls.listen, 1);
  assertEquals(m.calls.write, 1);
});

Deno.test("a login in progress never touches the link", async () => {
  const m = await loadModule({ staleMs: 1_000 });
  m.setClient(m.makeClient());
  m.setLogin({ status: "qr" });
  m.setLink(null);
  m.setLastPushAt(Date.now() - 5_000);
  m.watchdogTick();
  await m.reconnectPush("stale");
  assertEquals(m.getLink(), null);
  assertEquals(m.calls.write, 0);
});
