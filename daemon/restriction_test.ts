/**
 * The account-restriction halt: one refused call stops every automatic LINE
 * path until the user asks again.
 *
 * Slices the real restriction block together with the watchdog block it
 * gates, on stub module state: no session, no socket, no state dir.
 *
 *   deno test -A restriction_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlocks } from "./slice_test.ts";

interface Restriction {
  code: string;
  since: number;
}
interface FakeClient {
  base: {
    push: { conns: Array<{ close(): void } | null> };
    poll: { islisten: boolean };
  };
  listen(options?: { signal?: AbortSignal }): void;
}
interface Module {
  calls: { listen: number; close: number; refresh: number; write: number };
  logs: { error: string[]; log: string[] };
  restriction: Restriction | null;
  link: { push: string; since: number; reason?: string; code?: string } | null;
  listenAbort: AbortController | null;
  haltForRestriction(error: unknown): void;
  liftRestriction(): void;
  makeClient(): FakeClient;
  markPushAlive(): void;
  reconnectPush(reason: "stale" | "resume" | "error" | "manual"): Promise<void>;
  setClient(client: FakeClient | null): void;
  setLastPushAt(at: number): void;
  startListen(): AbortController;
  watchdogTick(): void;
}

async function loadModule() {
  const prelude = `
type LoginState = { status: string; reason?: string };
type LinkState = { push: string; since: number; reason?: string; code?: string };
type FakeConn = { close(): void };
type FakeClient = {
  base: { push: { conns: Array<FakeConn | null> }; poll: { islisten: boolean } };
  listen(options?: { signal?: AbortSignal }): void;
};
export const calls = { listen: 0, close: 0, refresh: 0, write: 0 };
export const logs = { error: [] as string[], log: [] as string[] };
const console = {
  error(...a: unknown[]) { logs.error.push(a.join(" ")); },
  log(...a: unknown[]) { logs.log.push(a.join(" ")); },
};
export const PUSH_STALE_MS = 180_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
export const PUSH_REINIT_GRACE_MS = 5;
export let lastPushAt = Date.now();
let reconnecting = false;
let reconnectAttempts = 0;
let nextReconnectAt = 0;
let forceFullRefresh = true;
function setForceFullRefresh(value: boolean) { forceFullRefresh = value; }
export let login: LoginState = { status: "ok" };
export let link: LinkState | null = { push: "up", since: 1 };
export let listenAbort: AbortController | null = null;
export let client: FakeClient | null = null;
export let restriction: { code: string; since: number } | null = null;
function setLink(next: LinkState | null) { link = next; }
function setListenAbort(ctrl: AbortController) { listenAbort = ctrl; return ctrl; }
function abortListen() { listenAbort?.abort(); listenAbort = null; }
export function startListen() { return setListenAbort(new AbortController()); }
export function setClient(c: FakeClient | null) { client = c; }
export function setLastPushAt(t: number) { lastPushAt = t; }
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
function errorLine(e: unknown) { return String((e as Error).message ?? e); }
export { haltForRestriction, liftRestriction, markPushAlive, reconnectPush, watchdogTick };
`;
  return await loadBlocks<Module>(
    ["loginerror", "restriction", "watchdog"],
    prelude,
  );
}

function refused(code: string) {
  return {
    name: "RequestError",
    message: `Request internal failed, x(/S4) -> {"code":"${code}"}`,
    data: { code },
  };
}

Deno.test("a halt ends the listen, publishes the reason once, and logs once", async () => {
  const m = await loadModule();
  const abort = m.startListen();
  m.haltForRestriction(refused("ABUSE_BLOCK"));
  assertEquals(abort.signal.aborted, true);
  assertEquals(m.listenAbort, null);
  assertEquals(m.restriction?.code, "ABUSE_BLOCK");
  assertEquals(m.link?.push, "down");
  assertEquals(m.link?.reason, "restricted");
  assertEquals(m.link?.code, "ABUSE_BLOCK");
  assertEquals(m.calls.write, 1);
  assertEquals(m.logs.error.length, 1);
  assert(m.logs.error[0].includes("ABUSE_BLOCK"), m.logs.error[0]);
  // The same burst fails three ways at once; the second and third are free.
  m.haltForRestriction(refused("BANNED"));
  m.haltForRestriction(refused("EXCESSIVE_ACCESS"));
  assertEquals(m.restriction?.code, "ABUSE_BLOCK");
  assertEquals(m.calls.write, 1);
  assertEquals(m.logs.error.length, 1);
});

Deno.test("while halted the watchdog, the reconnect and the ping all stand down", async () => {
  for (const code of ["ABUSE_BLOCK", "BANNED", "EXCESSIVE_ACCESS"]) {
    const m = await loadModule();
    m.setClient(m.makeClient());
    m.haltForRestriction(refused(code));
    m.setLastPushAt(0);
    m.watchdogTick();
    await m.reconnectPush("stale");
    await m.reconnectPush("resume");
    await m.reconnectPush("manual");
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(m.calls.listen, 0, code);
    assertEquals(m.calls.close, 0, code);
    assertEquals(m.calls.refresh, 0, code);
    // A ping on the idle connection must not write "up" over the reason.
    m.markPushAlive();
    assertEquals(m.link?.push, "down", code);
    assertEquals(m.link?.reason, "restricted", code);
    assertEquals(m.calls.write, 1, code);
  }
});

Deno.test("lifting the halt hands the next stale tick back to the watchdog", async () => {
  const m = await loadModule();
  m.setClient(m.makeClient());
  m.haltForRestriction(refused("EXCESSIVE_ACCESS"));
  m.setLastPushAt(0);
  m.watchdogTick();
  assertEquals(m.calls.listen, 0);
  m.liftRestriction();
  assertEquals(m.restriction, null);
  const resumed = () =>
    m.logs.log.filter((line) => line.includes("traffic resumed")).length;
  assertEquals(resumed(), 1);
  m.watchdogTick();
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(m.calls.listen, 1);
  assertEquals(m.calls.refresh, 1);
  // Lifting twice is as free as halting twice.
  m.liftRestriction();
  assertEquals(resumed(), 1);
});

Deno.test("the halt log line carries the code and the class, never a mid", async () => {
  const m = await loadModule();
  m.haltForRestriction({
    name: "RequestError",
    message:
      'Request internal failed, sendMessage(/S4) -> {"code":"BANNED","to":"u0123456789abcdef0123456789abcdef"}',
  });
  assertEquals(m.logs.error.length, 1);
  assert(m.logs.error[0].startsWith("[line] BANNED:"), m.logs.error[0]);
  // The real errorLine redacts mids; the stub above does not, so this pins
  // only that the line goes through it rather than through the raw message.
  assert(m.logs.error[0].includes("until login or sync"), m.logs.error[0]);
});

Deno.test("the user actions that lift the halt are login and sync", async () => {
  const login = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const loggedIn = login.slice(
    login.indexOf("async function onLoggedIn("),
    login.indexOf("async function tryResume"),
  );
  assert(loggedIn.includes("liftRestriction();"));
  const teardown = login.slice(
    login.indexOf("async function logoutClaimed("),
    login.indexOf("// enil:sync-begin"),
  );
  assert(teardown.includes("liftRestriction();"));
  const sync = login.slice(
    login.indexOf("async function syncNow("),
    login.indexOf("// enil:sync-end"),
  );
  assert(
    sync.indexOf("liftRestriction();") <
      sync.indexOf("await refreshChats(true)"),
  );
  // And nothing automatic does: the poll, the watchdog and the refresh
  // module only read the flag.
  for (const file of ["refresh.ts", "watchdog.ts", "push.ts", "socket.ts"]) {
    const src = await Deno.readTextFile(
      new URL(`./modules/${file}`, import.meta.url),
    );
    assertEquals(src.includes("liftRestriction("), false, file);
  }
  const daemon = await Deno.readTextFile(
    new URL("./daemon.ts", import.meta.url),
  );
  assertEquals(daemon.includes("liftRestriction("), false);
});
