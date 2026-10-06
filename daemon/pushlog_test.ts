/**
 * The push log listener: which LegyPusherError is a dead pusher and which one
 * the library repairs by itself, and what a dead one costs.
 *
 *   deno test -A pushlog_test.ts
 *
 * Slices the block between the `enil:pushlog` markers out of daemon.ts on top
 * of the watchdog block and runs both on stub module state -- no LINE session,
 * no socket and no state dir. The reconnect itself is watchdog_test.ts's; what
 * is asserted here is only whether one is asked for.
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlocks } from "./slice_test.ts";

interface PushClient {
  base: {
    push: { conns: Array<{ close(): void } | null> };
    poll: { islisten: boolean };
  };
  listen(options?: unknown): void;
}
interface PushLogModule {
  calls: {
    listen: number;
    close: number;
    refresh: number;
    write: number;
    halt: number;
  };
  makeClient(): PushClient;
  onPushLog(
    type: string,
    data: Record<string, unknown> | undefined,
    alive: boolean,
  ): void;
  setClient(client: PushClient | null): void;
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
async function loadModule(opts: { grace?: number } = {}) {
  const prelude = `
type LoginState = { status: string; reason?: string };
type LinkState = { push: "up" | "down"; since: number };
type FakeConn = { close(): void };
type FakeClient = {
  base: { push: { conns: Array<FakeConn | null> }; poll: { islisten: boolean } };
  listen(options?: unknown): void;
};
type Json = Record<string, unknown>;
export const calls = { halt: 0, listen: 0, close: 0, refresh: 0, write: 0 };
export const PUSH_STALE_MS = 180_000;
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
export function state() {
  return { lastPushAt, reconnecting, reconnectAttempts, nextReconnectAt };
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
function writeState(): Promise<void> { calls.write++; return Promise.resolve(); }
function refreshChats(): Promise<void> { calls.refresh++; return Promise.resolve(); }
function classifyLoginError(e: unknown): string {
  const text = String((e as { message?: unknown } | null | undefined)?.message ?? "");
  return /ABUSE_BLOCK|BANNED|EXCESSIVE_ACCESS/.test(text) ? "restricted" : "unknown";
}
export { markPushAlive, onPushLog, pushIsStale, watchdogTick };
`;
  return await loadBlocks<PushLogModule>(["watchdog", "pushlog"], prelude);
}

/** Runs `body` with console.error collected instead of printed. */
async function capture(body: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = real;
  }
  return lines;
}

/** Long enough for the sliced reconnect's grace wait to have gone by. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 80));
}

Deno.test("a push log is the traffic clock, and never an error", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  m.watchdogTick(); // nothing stale yet
  const before = m.state().lastPushAt;
  await new Promise((r) => setTimeout(r, 5));
  const lines = await capture(() => {
    m.onPushLog("[LEGY/PUSH] ping 3", { id: 3 }, true);
  });
  assertEquals(lines, [], "a ping is not journal noise");
  assert(m.state().lastPushAt > before, "the clock moved");
  assertEquals(m.state().reconnectAttempts, 0);
  assertEquals(m.calls.listen, 0);
});

Deno.test("a LegyPusherError with the loop still running is logged, not repaired", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  const lines = await capture(async () => {
    // What linejs reports for a decrypt or listener failure on one event, and
    // for an InitAndRead round it will retry itself 4s later. Rebuilding the
    // connection under either is churn at best and a fight over conns[0] at
    // worst.
    m.onPushLog("LegyPusherError", { error: new TypeError("one event") }, true);
    m.onPushLog("LegyPusherError_cannot_init", { error: new Error("x") }, true);
    await settle();
  });
  assertEquals(lines.length, 2, "both are still in the journal");
  assertEquals(m.calls.listen, 0, "and neither touched the connection");
  assertEquals(m.calls.close, 0);
  assertEquals(m.state().reconnectAttempts, 0);
});

Deno.test("a LegyPusherError with the loop gone goes through the watchdog", async () => {
  const m = await loadModule();
  const c = m.makeClient();
  m.setClient(c);
  // initLegyPusher clears islisten in a `finally`, so the terminal report --
  // and only the terminal report -- arrives with it already false.
  c.base.poll.islisten = false;
  await capture(async () => {
    m.onPushLog("LegyPusherError", { error: new Error("connect") }, false);
    await settle();
  });
  assertEquals(m.calls.close, 1);
  assertEquals(m.calls.listen, 1, "listen() again is the documented recovery");
  assertEquals(m.calls.refresh, 1);
  assertEquals(m.state().reconnectAttempts, 1, "paced by the existing backoff");
  assert(m.state().nextReconnectAt > Date.now(), "and the gate was set");
});

Deno.test("the two logs one dead pusher writes cost one reconnect", async () => {
  const m = await loadModule({ grace: 60 });
  const c = m.makeClient();
  m.setClient(c);
  c.base.poll.islisten = false;
  await capture(async () => {
    // #startLegyPusher reports the rejection, and the shared streams it errors
    // make client.ts' `for await` reject and report it a second time. Both
    // land before the reconnect has finished waiting out PUSH_REINIT_GRACE_MS.
    const err = new Error("connect");
    m.onPushLog("LegyPusherError", { error: err }, false);
    m.onPushLog("LegyPusherError", { error: err }, false);
    await new Promise((r) => setTimeout(r, 140));
  });
  assertEquals(m.calls.listen, 1);
  assertEquals(m.calls.close, 1);
  assertEquals(m.state().reconnectAttempts, 1);
});

Deno.test("a dead pusher with no session repairs nothing", async () => {
  // Logged out, or a QR login in flight: reconnectPush owns that rule, and
  // going through it rather than around it is what keeps it in one place.
  const m = await loadModule();
  await capture(async () => {
    m.onPushLog("LegyPusherError", { error: new Error("x") }, false);
    await settle();
  });
  assertEquals(m.calls.listen, 0);

  const busy = await loadModule();
  busy.setClient(busy.makeClient());
  busy.setLogin({ status: "qr" });
  await capture(async () => {
    busy.onPushLog("LegyPusherError", { error: new Error("x") }, false);
    await settle();
  });
  assertEquals(busy.calls.listen, 0);
});

Deno.test("the journal line is the class and the message, never the frame", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  const lines = await capture(() => {
    // log data carries raw push frames (order 8): none of it may be printed.
    m.onPushLog("LegyPusherError", {
      error: new TypeError("socket hang up"),
      frame: "u0123456789abcdef0123456789abcdef 午餐吃什麼",
    }, true);
  });
  assertEquals(lines, ["[push] LegyPusherError: TypeError socket hang up"]);
});

Deno.test("an error without one is still one line, not a crash", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  const lines = await capture(() => {
    m.onPushLog("LegyPusherError", undefined, true);
    m.onPushLog("LegyPusherError", {}, true);
  });
  assertEquals(lines, [
    "[push] LegyPusherError: ? ",
    "[push] LegyPusherError: ? ",
  ]);
});

Deno.test("anything else on the log channel is left alone", async () => {
  const m = await loadModule();
  const c = m.makeClient();
  m.setClient(c);
  c.base.poll.islisten = false;
  const before = m.state().lastPushAt;
  const lines = await capture(async () => {
    // linejs logs plenty that is neither: a login step, a request trace. None
    // of it says anything about the push link in either direction.
    m.onPushLog("SquareError", { error: new Error("x") }, false);
    m.onPushLog("", undefined, false);
    await settle();
  });
  assertEquals(lines, []);
  assertEquals(m.calls.listen, 0);
  assertEquals(m.state().lastPushAt, before);
});

Deno.test("a pusher refused for the account halts instead of reconnecting", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  m.onPushLog(
    "LegyPusherError",
    { error: new Error('init failed -> {"code":"BANNED"}') },
    false,
  );
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(m.calls.halt, 1);
  assertEquals(m.calls.listen, 0);
  assertEquals(m.calls.close, 0);
});
