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
 * (abortListen) and text. refresh, watchdog, socket and login import from
 * here; this module imports none of them.
 */
import { setLink, writeState } from "./state.ts";
import { abortListen } from "./session.ts";
import { errorLine, restrictionCode } from "./text.ts";

/** The restriction in force, or null while LINE traffic may run. */
export let restriction: { code: string; since: number } | null = null;

// The block between the enil:restriction markers is sliced out verbatim by
// restriction_test.ts and run on stub module state, so it may only reach for
// what is declared above it: restriction, setLink, writeState, abortListen,
// errorLine, restrictionCode and console.
// enil:restriction-begin
/**
 * Stops automatic LINE traffic over one refused call. Idempotent on purpose:
 * a burst that fails three ways at once (the round, the push loop, an
 * unawaited fetch) must cost one log line and one state write, not three.
 *
 * The push streams are aborted so no further event reaches the handlers.
 * linejs' own pusher loop (`while (client.authToken)`) cannot be ended
 * without clearing the token, which this halt deliberately does not do: the
 * idle connection and its 30s pings are the cost of keeping the session.
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
  setLink({ push: "down", since, reason: "restricted", code });
  void writeState();
}

/** A user action asked to try again; the caller does the trying. */
function liftRestriction(): void {
  if (!restriction) return;
  console.log(`[line] ${restriction.code}: traffic resumed on user request`);
  restriction = null;
}
// enil:restriction-end

export { haltForRestriction, liftRestriction };
