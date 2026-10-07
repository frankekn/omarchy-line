/**
 * The account-restriction halt. When LINE answers any call with a code that
 * refuses the account (ABUSE_BLOCK, BANNED, EXCESSIVE_ACCESS; see
 * restrictionCode in text.ts), every automatic path -- the poll, the refresh
 * retry, the watchdog reconnect, the suspend-resume reconnect, the push
 * streams -- checks `restriction` and stands down. Only a user action lifts
 * it: a manual sync (syncNow) or a login (logoutClaimed on the way to it).
 *
 * The session itself is kept: the token is not revoked, the chat list stays
 * published, and the panel keeps showing it with a link notice that says why
 * nothing is updating. Tearing the session down would wipe the drafts and
 * force a QR scan over what may be a one-hour rate limit.
 *
 * Dependency direction: imports state (setLink, writeState), session
 * (abortListen, client) and text. refresh, watchdog, socket and login import
 * from here; this module imports none of them.
 */
import { setLink, writeState } from "./state.ts";
import { abortListen, client } from "./session.ts";
import { errorLine, restrictionCode } from "./text.ts";
import type { Client } from "@evex/linejs";

/** The restriction in force, or null while LINE traffic may run. */
export let restriction: { code: string; since: number } | null = null;

// The block between the enil:restriction markers is sliced out verbatim by
// restriction_test.ts and run on stub module state, so it may only reach for
// what is declared above it: restriction, client, the Client type, setLink,
// writeState, abortListen, errorLine, restrictionCode and console.
// enil:restriction-begin
/**
 * The connect step the halt took away from the live client's pusher, kept so
 * the lift can hand back the very function. Owner-tagged because a logout and
 * a new login in between make a different client that never lost it.
 */
let haltedPusher: {
  owner: Client;
  initializeConn: Client["base"]["push"]["initializeConn"];
} | null = null;

/**
 * Stops automatic LINE traffic over one refused call. Idempotent on purpose:
 * a burst that fails three ways at once (the round, the push loop, an
 * unawaited fetch) must cost one log line and one state write, not three.
 *
 * The push streams are aborted so no further event reaches the handlers.
 * That alone leaves the producer running: linejs' pusher loop
 * (`while (client.authToken)`, vendor base/polling/mod.ts:158) ignores the
 * listen signal and opens a fresh /PUSH connection every ~4s whenever LINE
 * drops the socket of a refused account. Its only exits are a cleared token
 * and a connect step that throws (mod.ts:160-164). The token stays, so a
 * user's own send still goes out and is still refused honestly; instead the
 * client's connect step is replaced by one that rethrows this refusal and the
 * open connection is dropped. The loop wakes from its sleep, fails to connect
 * without touching the network, and ends with `islisten` cleared, which is
 * exactly the state a later listen() starts from.
 *
 * The link is published "down" with the reason, which is the field the
 * panel's notice line already renders, and its tap is the manual sync that
 * lifts the halt.
 */
function haltForRestriction(e: unknown): void {
  if (restriction) return;
  const code = restrictionCode(e) ?? "RESTRICTED";
  const since = Date.now();
  restriction = { code, since };
  console.error(
    `[line] ${code}: automatic traffic stopped until login or sync ` +
      `(${errorLine(e)})`,
  );
  abortListen();
  const owner = client;
  if (owner) {
    const push = owner.base.push;
    haltedPusher = { owner, initializeConn: push.initializeConn };
    push.initializeConn = () => Promise.reject(e);
    void push.conns[0]?.close();
  }
  setLink({ push: "down", since, reason: "restricted", code });
  void writeState();
}

/**
 * A user action asked to try again; the caller does the trying. The connect
 * step goes back to the client it was taken from, so the caller's listen()
 * starts a loop that can reach LINE again.
 */
function liftRestriction(): void {
  if (!restriction) return;
  console.log(`[line] ${restriction.code}: traffic resumed on user request`);
  restriction = null;
  if (haltedPusher) {
    if (haltedPusher.owner === client) {
      haltedPusher.owner.base.push.initializeConn = haltedPusher.initializeConn;
    }
    haltedPusher = null;
  }
}
// enil:restriction-end

export { haltForRestriction, liftRestriction };
