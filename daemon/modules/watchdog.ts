/**
 * Push-link health and repair: the staleness watchdog and its exponential
 * backoff (enil:watchdog block), the base-client log listener that reads the
 * push layer's only window (enil:pushlog block), the transport-failure
 * rejection guard (enil:unhandled block), and the logind suspend monitor.
 * Owns the listen() abort controller both login and reconnect use.
 *
 * Dependency direction: imports state (login, link via setLink, writeState),
 * session (client), refresh (refreshChats, setForceFullRefresh) and text
 * (classifyLoginError is re-exported from text.ts). login.ts calls
 * markPushAlive/reconnectPush/backoffDelay and the abort accessors here;
 * this module never imports login.
 */
import { link, login, setLink, writeState } from "./state.ts";
import { refreshChats, setForceFullRefresh } from "./refresh.ts";
import { client } from "./session.ts";
import { classifyLoginError } from "./text.ts";
import {
  PUSH_REINIT_GRACE_MS,
  PUSH_STALE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  RESUME_DELAY_MS,
} from "./env.ts";
import { TextLineStream } from "@std/streams/text-line-stream";
import type { Json } from "./types.ts";

/** Last moment any push traffic was seen; the watchdog below reads it. */

/** Last moment any push traffic was seen; the watchdog below reads it. */
let lastPushAt = Date.now();
let reconnecting = false;
let reconnectAttempts = 0;
let nextReconnectAt = 0;
let sleepMonitor: Deno.ChildProcess | null = null;

/** listen() has no stop API; aborting this signal closes the event streams. */
let listenAbort: AbortController | null = null;

/** Login starts the listen; the accessor returns the controller for it. */
export function setListenAbort(ctrl: AbortController): AbortController {
  listenAbort = ctrl;
  return ctrl;
}

/** Reconnect drops the stale controller's handle. */
export function clearListenAbort(): void {
  listenAbort = null;
}

// The block between the enil:watchdog markers is sliced out verbatim by the
// unit test harness and evaluated against stubs, so it must not reach for
// anything but the module state declared above.
// enil:watchdog-begin
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff, 1s doubling to a 60s ceiling, plus up to 25% jitter so
 * a daemon restarted by systemd does not retry in lockstep with this one.
 */
function backoffDelay(attempt: number): number {
  const base = Math.min(
    RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1),
    RECONNECT_CAP_MS,
  );
  return base + Math.random() * base * 0.25;
}

/**
 * Moves the reported push link across an edge, and only across an edge: a live
 * session logs a [LEGY/PUSH] ping every 30s, so writing state on every call
 * would rewrite state.json faster than the heartbeat does. A no-op while
 * `link` is null (no session) -- the field must stay absent then.
 */
function setLinkState(next: "up" | "down"): void {
  if (!link || link.push === next) return;
  setLink({ push: next, since: Date.now() });
  void writeState();
}

/** Traffic is the only proof a reconnect worked, so it is what clears the backoff. */
function markPushAlive(): void {
  lastPushAt = Date.now();
  reconnectAttempts = 0;
  nextReconnectAt = 0;
  setLinkState("up");
}

function pushIsStale(now: number = Date.now()): boolean {
  return now - lastPushAt > PUSH_STALE_MS;
}

/**
 * Rebuilds the push connection. Closing conns[0] is the load-bearing part: it
 * aborts the request stream, which is the only thing that can end the read()
 * hanging on a half-open socket.
 *
 * A reconnect already in flight swallows further calls instead of queueing
 * one: rebuilding a connection we just rebuilt is pure churn, and the watchdog
 * fires again a minute later if it did not take.
 */
async function reconnectPush(
  reason: "stale" | "resume" | "error" | "manual",
): Promise<void> {
  const c = client;
  if (!c || login.status !== "ok") return; // no session to repair
  if (reconnecting) return;
  // A reconnect that is about to happen is already a broken link, whatever the
  // reason -- the resume path gets here before the watchdog ever sees a gap.
  setLinkState("down");
  reconnecting = true;
  // The counter and the gate are the *watchdog's* pacing: they exist so an
  // automatic retry that keeps failing backs off instead of hammering LINE.
  // A manual sync is a person deciding to try right now, so it must not spend
  // that budget -- pressing 同步 three times used to walk the automatic retry
  // window out toward 60s, which is the exact opposite of what pressing it was
  // for. It still reconnects; it just leaves the safety net where it was.
  if (reason !== "manual") {
    reconnectAttempts++;
    nextReconnectAt = Date.now() + backoffDelay(reconnectAttempts);
  }
  // No attempt number for a manual one: it did not take one, and printing the
  // counter untouched reads as "attempt 3 failed" in the journal.
  console.log(
    `[push] reconnect reason=${reason}` +
      (reason === "manual" ? "" : ` attempt=${reconnectAttempts}`),
  );
  try {
    listenAbort?.abort();
    listenAbort = null;
    const before = c.base?.push?.conns?.[0] ?? null;
    try {
      before?.close();
    } catch (e) {
      console.error("[push] close failed:", (e as Error).message);
    }
    // Give linejs' own pusher loop the chance to reconnect first: two loops
    // would fight over conns[0] and deliver every event twice.
    await delay(PUSH_REINIT_GRACE_MS);
    if (client !== c) return; // logged out while we waited
    // Accepted race: initializeConn assigns conns[0] before the handshake
    // completes, so a reassign-then-fail inside this same cycle reads as
    // "healed". It costs one cycle, not a stuck daemon -- the next tick (~60s)
    // finds conns[0] unchanged and clears islisten then.
    const now = c.base?.push?.conns?.[0] ?? null;
    if (now === null || now === before) {
      // The loop is gone: initLegyPusher rethrows when initializeConn fails
      // and never clears islisten (linejs 3.3.2 base/polling/mod.ts:160-164),
      // so listen() would return without starting anything at all.
      try {
        c.base.poll.islisten = false;
      } catch (e) {
        console.error("[push] islisten reset:", (e as Error).message);
      }
    }
    listenAbort = new AbortController();
    c.listen({ talk: true, square: false, signal: listenAbort.signal });
    // The link just came back from the dead -- anything could have happened on
    // the server while it was down, so the first round answers for the whole
    // list instead of only the chats pushes happened to name.
    setForceFullRefresh(true);
    void refreshChats();
  } catch (e) {
    console.error("[push] reconnect failed:", (e as Error).message);
  } finally {
    reconnecting = false;
  }
}

function watchdogTick(): void {
  if (!client || login.status !== "ok") return;
  if (!pushIsStale()) return;
  // Before the backoff gate: staleness is what the panel has to show, and a
  // long backoff must not leave it claiming the link is fine for a minute.
  setLinkState("down");
  if (Date.now() < nextReconnectAt) return; // still inside the backoff window
  void reconnectPush("stale");
}
// enil:watchdog-end

// The block between the enil:pushlog markers is sliced out verbatim by
// pushlog_test.ts on top of the watchdog block, so it may only reach for what
// that block declares.
// enil:pushlog-begin
/**
 * One `log` event off the base client. It is the only window onto the push
 * layer we have: linejs owns the `for await` behind listen(), so nothing here
 * ever sees the op stream itself end.
 *
 * `[LEGY/PUSH]` is the byte-level liveness signal -- ConnManager prefixes every
 * push log with it, the 30s pings included. Errors are excluded on purpose: a
 * loop failing every 4s would otherwise look alive for ever.
 *
 * `LegyPusherError` is one type for three different failures, and `loopAlive`
 * is what tells them apart (vendor/linejs base/polling/mod.ts:163-204 and
 * client/client.ts:144):
 *
 *   - a decrypt or a listener throwing on one event. The pusher loop is
 *     untouched and the next event still arrives, so rebuilding the connection
 *     over one message that would not decrypt is the worse bug -- and a sender
 *     whose messages keep failing would ask for it over and over.
 *   - `InitAndRead` failing inside initLegyPusher. That loop sleeps 4s and
 *     reconnects itself; a reconnect from here would fight it over conns[0],
 *     which is the very race PUSH_REINIT_GRACE_MS exists to avoid.
 *   - initializeConn failing, which rethrows out of initLegyPusher. That one is
 *     terminal: #startLegyPusher errors both shared streams, so every listen
 *     loop over them ends and nothing is ever delivered again -- upstream
 *     v3.4.1 documents the host as the one who must call listen() a second
 *     time. Before it, a laptop that lost Wi-Fi at the wrong moment stayed
 *     silently deaf until the 3-minute staleness check happened to notice.
 *
 * Only the terminal one leaves `poll.islisten` false: initLegyPusher clears it
 * in a `finally`, which has already run by the time that rejection is reported,
 * while the other two are reported with the loop still running and it still
 * true.
 *
 * The repair is the watchdog's rather than a second loop of our own: zeroing
 * the traffic clock and ticking goes through the same backoff gate, so the two
 * logs one terminal failure produces -- the pusher's own, and the one client.ts
 * writes when the errored stream rejects its `for await` -- cost one reconnect
 * between them instead of one each. That rejection is caught inside linejs, so
 * it never reaches onUnhandledRejection either.
 */
function onPushLog(
  type: string,
  data: Json | undefined,
  loopAlive: boolean,
): void {
  if (type.startsWith("[LEGY/PUSH]")) {
    markPushAlive();
    return;
  }
  if (!type.startsWith("LegyPusherError")) return;
  // Type and message only -- log data carries raw frames (order 8).
  const err = data?.error as Error | undefined;
  console.error(
    `[push] ${type}: ${err?.constructor?.name ?? "?"}`,
    err?.message ?? "",
  );
  if (loopAlive) return;
  lastPushAt = 0;
  watchdogTick();
}
// enil:pushlog-end

// The block between the enil:unhandled markers is sliced out verbatim by
// unhandled_test.ts on top of the watchdog and loginerror blocks, so it may
// only reach for what those declare.
// enil:unhandled-begin
/**
 * linejs' push loop fires a fetch nobody awaits (3.3.2 base/push/conn.ts:122
 * calling base/core/mod.ts:251), so a reset socket surfaces as an unhandled
 * rejection and Deno kills the process: the daemon exited and systemd
 * restarted it 5s later, flickering the panel through idle/QR while a perfectly
 * good session was still stored. Swallowing that one keeps the session; the
 * repair stays with the watchdog rather than a second reconnect loop of our
 * own.
 *
 * Returns whether the rejection was handled, i.e. whether the caller may
 * cancel it. Only a transport failure is one -- our own bug may
 * have left module state half-written, and a daemon that keeps serving a stale
 * state.json after one is harder to diagnose than one that dies and comes back
 * -- so it is logged and then left to Deno's fatal exit and the systemd
 * restart.
 *
 * Only the error's name and message are logged -- the linejs text is a
 * transport diagnostic, never message content.
 */
function onUnhandledRejection(reason: unknown): boolean {
  const err = (reason ?? {}) as { name?: unknown; message?: unknown };
  const name = String(err.name ?? typeof reason);
  console.error(`[unhandled] ${name}: ${String(err.message ?? reason)}`);
  // Anything but a transport failure says nothing about the push link, and
  // tearing a working connection down over it would be the worse bug.
  if (classifyLoginError(reason) !== "network") return false;
  // Report it as the gap it is and let the existing path take over: going
  // through watchdogTick keeps the backoff gate, so a burst of resets still
  // costs one reconnect instead of one each.
  lastPushAt = 0;
  watchdogTick();
  return true;
}
// enil:unhandled-end

/**
 * Installed before anything can reject, i.e. first thing in main(). Only the
 * rejections onUnhandledRejection claims -- transport failures it has already
 * handed to the watchdog -- are cancelled; every other one falls through to
 * Deno's exit 1 and the systemd restart on purpose, because an unknown bug must
 * not leave the daemon serving stale state. An uncaught synchronous throw is
 * not intercepted at all, for the same reason.
 */
function installRejectionGuard(): void {
  globalThis.addEventListener("unhandledrejection", (e) => {
    // preventDefault is what stops Deno exiting 1 on the spot, so it is spent
    // only on the failures we know how to repair.
    if (onUnhandledRejection(e.reason)) e.preventDefault();
  });
}

/**
 * A user unit cannot hook suspend.target, so the resume is taken from logind's
 * PrepareForSleep signal -- the same source omarchy-system-sleep-monitor uses.
 */
function startSleepMonitor(): void {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("dbus-monitor", {
      args: [
        "--system",
        "type='signal',sender='org.freedesktop.login1'," +
        "interface='org.freedesktop.login1.Manager',member='PrepareForSleep'",
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch (e) {
    console.error(
      "[push] no dbus-monitor, watchdog only:",
      (e as Error).message,
    );
    return;
  }
  sleepMonitor = child;
  (async () => {
    const lines = child.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      // dbus-monitor still prints its own NameAcquired handshake ahead of the
      // filtered signals; matching on the substring is safe only because no
      // line but the PrepareForSleep payload ever contains "boolean".
      if (line.includes("boolean true")) {
        console.log("[push] suspending");
      } else if (line.includes("boolean false")) {
        console.log("[push] resumed");
        setTimeout(() => void reconnectPush("resume"), RESUME_DELAY_MS);
      }
    }
    console.error("[push] dbus-monitor exited, watchdog only");
    sleepMonitor = null;
    respawnSleepMonitor();
  })().catch((e) => {
    console.error("[push] dbus-monitor:", (e as Error).message);
    sleepMonitor = null;
    respawnSleepMonitor();
  });
}

/**
 * A monitor that was running and died is a host event (dbus restart), not a
 * negotiation problem, so retry on a delay -- the staleness watchdog covers
 * push health across the gap either way. A spawn failure gets no retry: a
 * missing binary does not come back, and logging it once is enough.
 */
function respawnSleepMonitor(): void {
  setTimeout(() => {
    if (!sleepMonitor) startSleepMonitor();
  }, 30_000);
}

export {
  backoffDelay,
  installRejectionGuard,
  listenAbort,
  markPushAlive,
  onPushLog,
  reconnectPush,
  sleepMonitor,
  startSleepMonitor,
  watchdogTick,
};
