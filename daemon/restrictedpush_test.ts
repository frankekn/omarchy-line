/**
 * The restriction halt against linejs' real pusher loop.
 *
 * Aborting listen() only closes the consumer streams; the producer is
 * Polling.initLegyPusher (vendor base/polling/mod.ts:158), a
 * `while (client.authToken)` loop that opens a new /PUSH connection every
 * ~4s, refused or not. The halt must leave that loop making zero requests,
 * and a lift must let the next listen() open one again.
 *
 * The vendored BaseClient runs with a counting fetch in place of the network;
 * the restriction and watchdog blocks are the daemon's own, sliced as in
 * restriction_test.ts, with the real client behind the stub session.
 *
 *   deno test -A restrictedpush_test.ts
 */
import { assertEquals } from "@std/assert";
import { BaseClient } from "@evex/linejs/base";
import { Client } from "@evex/linejs";
import { loadBlocks } from "./slice_test.ts";

interface Module {
  calls: { listen: number };
  restriction: { code: string; since: number } | null;
  haltForRestriction(error: unknown): void;
  liftRestriction(): void;
  reconnectPush(reason: "manual"): Promise<void>;
  setClient(client: Client | null): void;
  startListen(): AbortController;
}

/** One vendor pusher turn: connect (~0.3s), fail, sleep 4s, connect again. */
const PUSHER_TURN_MS = 4_500;

async function loadModule() {
  const prelude = `
type LoginState = { status: string; reason?: string };
type LinkState = { push: string; since: number; reason?: string; code?: string };
type Client = import("@evex/linejs").Client;
export const calls = { listen: 0, refresh: 0, write: 0 };
const console = { error(..._a: unknown[]) {}, log(..._a: unknown[]) {} };
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
export let client: Client | null = null;
export let restriction: { code: string; since: number } | null = null;
function setLink(next: LinkState | null) { link = next; }
function setListenAbort(ctrl: AbortController) { listenAbort = ctrl; return ctrl; }
function abortListen() { listenAbort?.abort(); listenAbort = null; }
export function startListen() {
  const ctrl = setListenAbort(new AbortController());
  calls.listen++;
  client!.listen({ talk: true, square: false, signal: ctrl.signal });
  return ctrl;
}
export function setClient(c: Client | null) { client = c; }
function writeState(): Promise<void> { calls.write++; return Promise.resolve(); }
function refreshChats(): Promise<void> { calls.refresh++; return Promise.resolve(); }
function errorLine(e: unknown) { return String((e as Error).message ?? e); }
export { haltForRestriction, liftRestriction, reconnectPush };
`;
  return await loadBlocks<Module>(
    ["loginerror", "restriction", "watchdog"],
    prelude,
  );
}

/**
 * A LINE that drops the push socket of a refused account: every /PUSH
 * connect is counted and answered with a body that ends at once, which is
 * what sends the vendor loop around again after its 4s sleep.
 */
function countingTransport() {
  const counts = { push: 0, other: 0 };
  const fetch = (req: Request): Response => {
    if (!req.url.includes("/PUSH/")) {
      counts.other++;
      throw new Error(`unexpected request ${req.url}`);
    }
    counts.push++;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  return { counts, fetch };
}

function refused(code: string) {
  return {
    name: "RequestError",
    message: `Request internal failed, x(/S4) -> {"code":"${code}"}`,
    data: { code },
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await delay(50);
}

Deno.test({
  name: "the pusher loop opens no /PUSH connection while restricted",
  // The vendor loop sleeps between turns and nothing can await it; the token
  // is cleared at the end so it winds down on its own after the test.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { counts, fetch } = countingTransport();
    const base = new BaseClient({ device: "ANDROIDSECONDARY", fetch });
    base.authToken = "token-under-test";
    const c = new Client(base);
    const m = await loadModule();
    m.setClient(c);
    m.startListen();
    await until(() => counts.push >= 1, 2_000);
    assertEquals(counts.push, 1, "listen() opened the push connection");

    m.haltForRestriction(refused("ABUSE_BLOCK"));
    const atHalt = counts.push;
    // Two full turns: a loop still running would have reconnected twice.
    await delay(2 * PUSHER_TURN_MS + 500);
    assertEquals(
      counts.push - atHalt,
      0,
      "no /PUSH connect while restricted",
    );
    assertEquals(base.poll.islisten, false, "the vendor loop has ended");

    m.liftRestriction();
    const atLift = counts.push;
    await m.reconnectPush("manual");
    await until(() => counts.push > atLift, PUSHER_TURN_MS);
    assertEquals(counts.push - atLift, 1, "the lift let listen() reconnect");
    assertEquals(counts.other, 0, "only the push path ever went out");

    base.authToken = undefined;
    base.push.conns[0]?.close();
    await delay(PUSHER_TURN_MS);
    assertEquals(base.poll.islisten, false, "the loop wound down for exit");
  },
});
