/**
 * The session lifecycle: the QR login and token resume (both gated through
 * beginLogin/endLogin so a second caller can never race a live session), the
 * post-login wiring of push listeners, the idempotent logout and its claimed
 * teardown, the network-failure resume retry (enil:resumeretry block), the
 * error classification vocabulary (enil:loginerror block, which lives in
 * text.ts so refresh can classify without a cycle), and the manual sync
 * command (enil:sync block).
 *
 * Dependency direction: imports from below -- session, state, refresh, push,
 * notify, watchdog, stickers, avatars, caches, text, env. socket.ts calls
 * startLogin/logout/syncNow from here; nothing in this module reaches up.
 */
import {
  DEVICE,
  guardedFetch,
  retireClipboardStages,
  retirePanelMediaLane,
  STATE_DIR,
  STORAGE_PATH,
} from "./env.ts";
import { type Client, loginWithAuthToken, loginWithQR } from "@evex/linejs";
import type { Json, TalkMsg } from "./types.ts";
import QRCode from "qrcode";
import { FileStorage } from "@evex/linejs/storage";
import {
  blockStateWrites,
  bumpChatsRevision,
  cancelStateWrite,
  chats,
  chatSummaryStore,
  chatSummaryVersions,
  clearEvents,
  clearRefreshHealth,
  clearWanted,
  dirtyMids,
  invalidateStateWrites,
  link,
  login,
  refreshHealthValue,
  releaseStateWrites,
  setChatListHealth,
  setChats,
  setLink,
  setLogin,
  setMe,
} from "./state.ts";
import {
  bumpSessionGeneration,
  client,
  sessionGeneration,
  sessionIsCurrent,
  setClient,
} from "./session.ts";
import {
  backoffDelay,
  clearListenAbort,
  listenAbort,
  markPushAlive,
  onPushLog,
  reconnectPush,
  setListenAbort,
} from "./watchdog.ts";
import {
  clearRefreshRetry,
  refreshChats,
  refreshDebouncer,
  refreshInFlight,
  refreshing,
  resetRefreshRound,
  scheduleRefresh,
  setForceFullRefresh,
} from "./refresh.ts";
import { lastNotified, notify } from "./notify.ts";
import { onIncomingMessage, onTalkOp, prepareIncomingMessage } from "./push.ts";
import { resetStickerCache } from "./stickers.ts";
import { avatarPending, avatars, avatarTokens, noteAvatar } from "./avatars.ts";
import {
  capMap,
  cursors,
  memberCache,
  NAME_CACHE_MAX,
  nameCache,
  nameCacheEpoch,
  paginationCursors,
  pendingIncomingMessages,
  reactionsBeforePublication,
  reactionsByMessage,
  readIndex,
  readRanges,
  replySources,
  trackIncomingMessage,
  unsentBeforePublication,
} from "./caches.ts";
import {
  classifyLoginError,
  errorLine,
  errorText,
  NET_DOWN_TEXT,
  TOKEN_EXPIRED_TEXT,
} from "./text.ts";

/** Held from the first statement of a login attempt until it settles. */
let loginInFlight = false;
type LoginOperation = "manual" | "resume" | "logout" | null;
export let loginOperation: LoginOperation = null;
let loginSettled: Promise<void> = Promise.resolve();
let resolveLoginSettled: (() => void) | null = null;
let resumeCancelGeneration = 0;
let logoutRequested = false;
let activeLogout: Promise<Json> | null = null;
/** How many automatic resume retries have been scheduled since the last boot. */
let resumeRetries = 0;

// The block between the enil:logingate markers is sliced out verbatim by
// resume_test.ts, so it must stay self-contained.
// enil:logingate-begin
/**
 * The one gate both ways into a session -- a QR login and a token resume --
 * must pass, and the reason it is a flag rather than a status check.
 *
 * `client` alone is not enough: it is only assigned at the very end of
 * onLoggedIn(), so between "a login started" and "a login succeeded" it is
 * still null and every guard written against it waves the second caller
 * through. `login.status` is not enough either, because the first thing both
 * paths do is await -- tryResume() awaits three FileStorage reads before it
 * ever reaches setLogin("starting"). That gap is small but real, and the
 * automatic resume retry made it matter: the daemon can now be retrying for
 * minutes while the user stares at 「連不上 LINE，稍後重試」 and clicks 再試一次
 * at exactly the wrong moment. Both attempts would then run to completion, both
 * would reach onLoggedIn(), and the loser's Client would be orphaned with a
 * live push socket nobody owns.
 *
 * Claiming synchronously, before any await, is the whole fix: there is no
 * suspension point between the test and the set.
 */
function beginLogin(
  operation: Exclude<LoginOperation, null> = "manual",
): boolean {
  if (client || loginInFlight || logoutRequested) return false;
  loginInFlight = true;
  loginOperation = operation;
  loginSettled = new Promise((resolve) => {
    resolveLoginSettled = resolve;
  });
  return true;
}

function endLogin(): void {
  loginInFlight = false;
  loginOperation = null;
  const resolve = resolveLoginSettled;
  resolveLoginSettled = null;
  resolve?.();
}
// enil:logingate-end

// The block between the enil:storageguard markers is sliced out verbatim by
// storageguard_test.ts, with FileStorage and STORAGE_PATH stubbed.
// enil:storageguard-begin
/**
 * Opens the session store, quarantining a file that no longer parses.
 * FileStorage persists with a plain writeFile -- a crash mid-write leaves
 * half a JSON document, and every get/set afterwards throws on the parse,
 * wedging resume and the next login on a corpse nobody can read. Rename it
 * aside once: the stored token is equally lost either way, this just keeps
 * the store usable. Any other read failure stays the caller's to report --
 * "cannot open" is not proof the file is corrupt, and tryResume already has
 * words for a store it cannot read.
 */
async function sessionStorage(): Promise<FileStorage> {
  try {
    JSON.parse(await Deno.readTextFile(STORAGE_PATH));
  } catch (e) {
    if (e instanceof SyntaxError) {
      const quarantined = `${STORAGE_PATH}.corrupt-${Date.now()}`;
      await Deno.rename(STORAGE_PATH, quarantined).catch(() => {});
      console.error(`[storage] corrupt session moved to ${quarantined}`);
    } else if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }
  return new FileStorage(STORAGE_PATH);
}
// enil:storageguard-end

/** True if this call started a login; false if the gate refused it. */
async function startLogin(): Promise<boolean> {
  // First statement, before any await: see beginLogin(). Returning is the same
  // answer the old `if (client) return` gave -- a login is already happening.
  // The boolean is what handle() needs: a refusal used to be silent, so a
  // click landing during a resume retry left the panel with nothing to show.
  if (!beginLogin("manual")) return false;
  const storage = await sessionStorage();
  let candidate: Client | null = null;
  try {
    await setLogin("starting", { attempt: "manual" });
    const c = await loginWithQR({
      async onReceiveQRUrl(url: string) {
        // A fresh filename every time: the plugin reloads the Image by path
        // change, so reusing one path shows a stale QR.
        const png = `${STATE_DIR}/qr-${Date.now()}.png`;
        await QRCode.toFile(png, url, { margin: 2, width: 320 });
        for await (const e of Deno.readDir(STATE_DIR)) {
          if (e.name.startsWith("qr-") && `${STATE_DIR}/${e.name}` !== png) {
            await Deno.remove(`${STATE_DIR}/${e.name}`).catch(() => {});
          }
        }
        await setLogin("qr", { qrPng: png, url });
      },
      onPincodeRequest(pin: string) {
        setLogin("pin", { pin });
      },
    }, { device: DEVICE, storage, fetch: guardedFetch });
    candidate = c;
    await onLoggedIn(c);
  } catch (e) {
    // Setup may fail after onLoggedIn populated the account and its caches.
    // Only a partially established replacement owns credentials to revoke.
    // A QR failure before loginWithQR returns must leave the previous stored
    // session and its drafts available for another attempt.
    const terminal = candidate !== null;
    await logoutClaimed(terminal, terminal, candidate);
    // `error` stays the raw text for backward compat; `reason` is what the
    // panel turns into advice. The teardown is transient, not settled: the
    // stored credentials this attempt never tested survive it, so the next
    // boot still resumes the previous account and its durable local state.
    await setLogin("error", {
      error: errorText(e),
      reason: classifyLoginError(e),
      attempt: "manual",
      settled: terminal,
    });
  } finally {
    endLogin();
  }
  return true;
}

async function onLoggedIn(c: Client): Promise<void> {
  bumpSessionGeneration();
  setClient(c);
  const generation = sessionGeneration;
  try {
    const profile = await c.getMyProfile();
    setMe({ mid: profile.mid, displayName: profile.displayName });
    nameCache.set(String(profile.mid), String(profile.displayName ?? "我"));
    capMap(nameCache, NAME_CACHE_MAX);
    noteAvatar(String(profile.mid), profile);
  } catch (e) {
    console.error("[profile]", (e as Error).message);
  }
  if (!sessionIsCurrent(c, generation)) return;
  // Store the token we just got BEFORE anything else can rotate it. The
  // "update:authtoken" listener below only fires on later rotations -- it
  // cannot see the one that happened during login itself, which is how the
  // first version lost the session on every restart.
  try {
    if (c.authToken) await c.base.storage.set(".auth", c.authToken);
  } catch (e) {
    console.error("[auth] could not persist token:", (e as Error).message);
  }
  if (!sessionIsCurrent(c, generation)) return;
  // A fresh session starts healthy; the watchdog below owns every edge after
  // this one. Set before setLogin so both land in the same state write.
  setLink({ push: "up", since: Date.now() });
  await setLogin("ok");
  if (!sessionIsCurrent(c, generation)) return;

  c.base.on("update:authtoken", async (token: string) => {
    // LINE hands back a rotated token in x-line-next-access; drop it and the
    // next start needs a fresh QR scan. But there is no way to unbind this
    // listener, and a request issued before a logout can land after it and
    // rotate the token of the session the user just ended -- which would
    // rewrite the .auth logout() deleted. `client !== c` is that test: logout()
    // nulls client, and a later login is a different object, so a listener from
    // an ended session is dead for good.
    if (client !== c) return;
    await c.base.storage.set(".auth", token).catch(() => {});
  });
  // Nothing else surfaces the push layer: without this listener a LegyPusher
  // failure is invisible in the journal and unrecoverable, and the watchdog has
  // no traffic clock finer than "a message arrived", which can be hours apart.
  c.base.on("log", (e: { type?: string; data?: unknown }) => {
    // initLegyPusher clears islisten in a `finally`, so it reads false exactly
    // when linejs' pusher loop has ended -- which is what tells a failure it
    // retries by itself from one only a second listen() can undo. onPushLog
    // has the rest of that argument.
    if (!sessionIsCurrent(c, generation)) return;
    onPushLog(
      String(e?.type ?? ""),
      e?.data as Json | undefined,
      c.base?.poll?.islisten !== false,
    );
  });
  // Every raw talk Operation, emitted before listen() decides what it is
  // (vendor/linejs client/client.ts:140). The read receipts, reactions and
  // unsends have no typed event of their own -- this is the only way to them.
  c.on("event", (op) => {
    if (!sessionIsCurrent(c, generation)) return;
    markPushAlive();
    onTalkOp(op);
  });
  // Start independent decryption/name resolution immediately, then serialize
  // only publication. A slow earlier conversion cannot prevent later work
  // from making progress, while ring sequence and summaries retain listener
  // arrival order.
  let incomingPublication = Promise.resolve();
  c.on("message", (msg: TalkMsg) => {
    if (!sessionIsCurrent(c, generation)) return;
    markPushAlive();
    // Notifications remain independent; only ring publication is serialized.
    void notify(msg, c, generation);
    const incomingId = String(msg.raw?.id ?? "");
    trackIncomingMessage(incomingId);
    const prepared = prepareIncomingMessage(msg, c, generation);
    incomingPublication = incomingPublication.then(() =>
      onIncomingMessage(incomingId, prepared, c, generation)
    );
    void incomingPublication;
    scheduleRefresh();
  });
  markPushAlive();
  const abort = setListenAbort(new AbortController());
  c.listen({ talk: true, square: false, signal: abort.signal });

  // The first round of a fresh session -- QR login or resume alike -- is a
  // full one: there is no list yet that pushes could have kept current.
  setForceFullRefresh(true);
  void refreshChats();
}

/**
 * "none" and "error" are not the same thing: a missing token is the normal
 * first run and belongs at "idle", while a stored token that will not resume
 * is a failure the user has to be told about -- it used to fall through to the
 * same silent "idle", so an expired session looked exactly like a fresh box.
 * "busy" is none of those: another login already holds the gate, so this call
 * did nothing at all and must not touch login state -- overwriting it would
 * report the other attempt's progress as this one's failure.
 */
async function tryResume(): Promise<"ok" | "none" | "error" | "busy"> {
  // First statement, before any await: see beginLogin().
  if (!beginLogin("resume")) return "busy";
  const cancellation = resumeCancelGeneration;
  const cancelled = () =>
    logoutRequested || cancellation !== resumeCancelGeneration;
  try {
    const storage = await sessionStorage();
    let token: unknown;
    try {
      token = await storage.get(".auth");
    } catch (e) {
      if (cancelled()) return "none";
      // An unreadable store is not proof that the account logged out. Keep
      // credentials and drafts intact so a later retry can recover them.
      const error = errorText(e);
      console.error("[resume] auth storage:", error);
      await setLogin("error", {
        error,
        reason: "unknown",
        // Same provenance as every other boot-time resume failure, so a
        // panel can tell "the store broke" from "no session was stored".
        attempt: "resume",
        settled: false,
      });
      return "error";
    }
    if (typeof token !== "string" || !token) return "none";
    // Pass the refresh token too, so an expired access token is renewed in
    // place (MUST_REFRESH_V3_TOKEN) instead of forcing another scan.
    const refreshToken = await storage.get("refreshToken").catch(() =>
      undefined
    );
    const expire = await storage.get("expire").catch(() => undefined);
    let candidate: Client | null = null;
    try {
      // Once a token has been read, a concurrent logout must still take it
      // through authentication so logoutZ can revoke the server-side session.
      // Skipping straight to local deletion would leave a copied token valid.
      if (!cancelled()) await setLogin("starting", { attempt: "resume" });
      const c = await loginWithAuthToken({
        accessToken: token,
        refreshToken: typeof refreshToken === "string"
          ? refreshToken
          : undefined,
        expire: typeof expire === "number" ? expire : undefined,
      }, { device: DEVICE, storage, fetch: guardedFetch });
      candidate = c;
      if (cancelled()) {
        // Authentication completed after the user chose logout. Revoke the
        // remote session while the candidate still owns its auth token; the
        // waiting logout will then finish the idempotent local cleanup.
        await logoutClaimed(true, false, candidate);
        return "none";
      }
      await onLoggedIn(c);
      if (cancelled()) return "none";
      return "ok";
    } catch (e) {
      if (cancelled()) {
        if (candidate) await logoutClaimed(true, false, candidate);
        return "none";
      }
      const kind = classifyLoginError(e);
      // Only a confirmed dead token ends the stored session. Network and
      // unclassified setup failures preserve credentials and drafts.
      const terminal = kind === "token_expired";
      await logoutClaimed(terminal, terminal, candidate);
      const error = errorText(e);
      console.error("[resume] failed:", error);
      await setLogin("error", {
        error,
        reason: kind,
        attempt: "resume",
        settled: terminal,
      });
      return "error";
    }
  } finally {
    endLogin();
  }
}

// The block between the enil:resumeretry markers is sliced out verbatim by
// resume_test.ts, so it must stay self-contained.
// enil:resumeretry-begin
/**
 * Retries a resume that failed for a network reason, on the push watchdog's
 * backoff (1s doubling to 60s, jittered).
 *
 * The unit is ordered After=graphical-session.target, not
 * network-online.target, so a login at boot regularly loses a race with Wi-Fi
 * association. Without this the daemon parked at "error" until someone
 * happened to open the panel and press 再試一次 -- a working token and a
 * working network, and still no LINE, because of three seconds at boot.
 *
 * The status check at fire time is the interlock with startLogin() -- anything
 * other than a network error means someone else owns the session now (the user
 * pressed 登入, or an earlier retry already succeeded), and a second
 * loginWithAuthToken against the same storage file would race whoever that is.
 * Dropping the chain there is the whole of the coordination -- there is no
 * cancellation to get wrong.
 */
function scheduleResumeRetry(): void {
  resumeRetries++;
  const attempt = resumeRetries;
  setTimeout(() => {
    if (
      String(login.status) !== "error" || String(login.reason) !== "network"
    ) return;
    console.log(`[resume] retry attempt=${attempt}`);
    void tryResume().then((result) => {
      // Only a network failure is worth another round: "ok" and "none" are
      // done, an expired token will not heal by waiting, and "busy" means a
      // QR login took the gate -- that login owns the session now.
      if (result === "error" && String(login.reason) === "network") {
        scheduleResumeRetry();
      }
    });
  }, backoffDelay(attempt));
}
// enil:resumeretry-end

/**
 * Ends the session and drops back to "idle". Idempotent: it is also the way
 * out of a half-open session, so it never reports failure -- a server that
 * refuses the logout still leaves us with no local token, which is what the
 * user asked for.
 */
async function logout(): Promise<Json> {
  // A user logout supersedes an automatic resume, including the early window
  // where it is still reading FileStorage and login.status remains unchanged.
  // Keep manual QR/PIN login non-cancellable because its UI has a distinct
  // in-progress contract.
  if (loginInFlight) {
    if (loginOperation === "logout") {
      const active = activeLogout;
      if (active) return await active;
      await loginSettled;
      return { ok: true };
    }
    if (loginOperation !== "resume") {
      return { ok: false, error: "登入中，請稍候" };
    }
    logoutRequested = true;
    resumeCancelGeneration++;
    await loginSettled;
  }
  // Another logout waiter may have claimed the gate in the same microtask
  // turn after the cancelled resume released it. Join that idempotent cleanup
  // instead of reporting a spurious login-in-progress error.
  if (loginInFlight && loginOperation === "logout") {
    const active = activeLogout;
    if (active) return await active;
    await loginSettled;
    return { ok: true };
  }
  // beginLogin() observes logoutRequested, so no manual or retry login can
  // claim the gap between the awaited resume and this cleanup operation.
  if (loginInFlight) return { ok: false, error: "登入中，請稍候" };
  loginInFlight = true;
  loginOperation = "logout";
  loginSettled = new Promise((resolve) => {
    resolveLoginSettled = resolve;
  });
  const operation: Promise<Json> = (async () => {
    try {
      return await logoutClaimed();
    } finally {
      logoutRequested = false;
      activeLogout = null;
      endLogin();
    }
  })();
  activeLogout = operation;
  return await operation;
}

async function logoutClaimed(
  revokeCredentials = true,
  publishIdle = true,
  retiringClient: Client | null = client,
): Promise<Json> {
  const c = retiringClient;
  // Nulling client first is what kills this session's "update:authtoken"
  // listener (see onLoggedIn) -- do it before anything that can trigger a
  // request. It also makes handle() refuse the rest of the commands.
  const retiredGeneration = sessionGeneration;
  bumpSessionGeneration();
  const clipboardRetired = retireClipboardStages(c, retiredGeneration).catch(
    (error) =>
      console.error(
        `[clipboard] retired stage cleanup failed: ${errorLine(error)}`,
      ),
  );
  const mediaRetired = retirePanelMediaLane();
  blockStateWrites();
  const stateInvalidated = invalidateStateWrites();
  cancelStateWrite();
  setClient(null);
  // Retire the old refresh round immediately. The login gate remains held
  // until cleanup and the idle state write finish.
  resetRefreshRound(sessionGeneration);
  listenAbort?.abort();
  clearListenAbort();
  // A retry armed by the last failed refresh would otherwise fire into a
  // session that no longer exists.
  clearRefreshRetry();
  refreshDebouncer.clear();
  // Clear the link first: markPushAlive() below would otherwise write one more
  // state file for an "up" edge on a session that no longer exists.
  setLink(null);
  // Same rule as `link`: `refresh` must be absent while there is no session,
  // and the "idle" write below is what takes it out of the file.
  clearRefreshHealth();
  // Leave no backoff behind: the next login must be able to reconnect at once.
  markPushAlive();

  if (c) {
    // logoutZ invalidates the token server-side. Best effort: an expired token
    // cannot be logged out, and that is exactly the case where the local
    // cleanup below matters most.
    if (revokeCredentials) {
      try {
        await c.base.auth.logoutZ();
      } catch (e) {
        console.error("[logout] server logout failed:", (e as Error).message);
      }
    }
    // Aborting listen() only closes the consumer streams (and those renew
    // themselves anyway); the producer is Polling.initLegyPusher, a
    // `while (client.authToken)` loop that reconnects every 4s. Clearing the
    // token is what ends it -- the library's own NOT_AUTHORIZED_DEVICE path
    // does the same -- and closing the live conn drops the socket now instead
    // of at the next ping.
    try {
      c.base.authToken = undefined;
      c.base.push?.conns?.[0]?.close();
    } catch (e) {
      console.error("[logout] push teardown:", (e as Error).message);
    }
  }

  // The client's own storage instance, when we have it: FileStorage
  // serialises writes per instance, so sharing it avoids racing a set() the
  // library still has in flight.
  // Falling back to a bare FileStorage when the guard itself cannot open the
  // file keeps this path as quiet as it was: the per-key catch below already
  // answers "delete failed", and a logout is no place to surface one more.
  const storage = c?.base?.storage ??
    await sessionStorage().catch(() => new FileStorage(STORAGE_PATH));
  // e2ee*/qrCert are kept: they are inert without a token, and a re-login as
  // the same account reuses them instead of re-negotiating.
  if (revokeCredentials) {
    for (const key of [".auth", "refreshToken", "expire"]) {
      await storage.delete(key).catch(() => {});
    }
  }

  setMe({});
  setChats([]);
  bumpChatsRevision();
  setChatListHealth(null);
  // A hand-off pointing at a chat this process can no longer open would have
  // the panel jump to an empty conversation the moment it starts.
  clearWanted();
  nameCache.clear();
  nameCacheEpoch.clear();
  // The tokens ride in on the name lookups, so they go out with them. The
  // files and the index stay: a picture is keyed by mid, and a mid means the
  // same person whichever account is looking at it.
  avatarTokens.clear();
  avatars.clear();
  avatarPending.clear();
  lastNotified.clear();
  // Box and message ids are LINE-global, so a re-login as another account
  // sharing a group would otherwise hit this account's cached summary.
  chatSummaryStore.summaryCache.clear();
  chatSummaryStore.lastRefreshSummaryEpoch = 0;
  chatSummaryVersions.clear();
  chatSummaryStore.chatSummaryMessageIds.clear();
  cursors.clear();
  // Box and message ids are LINE-global like the rest of the caches above,
  // and the next session's first round is a full one regardless.
  dirtyMids.clear();
  setForceFullRefresh(true);
  unsentBeforePublication.clear();
  pendingIncomingMessages.clear();
  reactionsBeforePublication.clear();
  paginationCursors.clear();
  // Same reason, and one more: the list is filtered against `me`, so keeping
  // it would offer the new account a picker with itself in it.
  memberCache.clear();
  // A different account owns different packages, and the picker is the one
  // place that would show the previous one's.
  resetStickerCache();
  // The ring is this session's history; replaying it into the next account
  // would hand it messages, reactions and 已讀 that are not its own. `eventSeq`
  // deliberately does not reset -- a seq that went backwards inside one bootId
  // is the one thing the panel cannot make sense of.
  clearEvents();
  replySources.clear();
  reactionsByMessage.clear();
  readRanges.clear();
  readIndex.clear();
  await clipboardRetired;
  await mediaRetired;
  await stateInvalidated;
  releaseStateWrites();
  // Only an explicit user logout publishes a completed idle attempt. Login
  // failures publish their own error state immediately after transient cleanup.
  if (publishIdle) {
    await setLogin("idle", { attempt: "logout", settled: true });
  }
  return { ok: true };
}

// ------------------------------------------------------------ manual sync

// The block between the enil:sync markers is sliced out verbatim by
// daemon/sync_test.ts, so it must stay self-contained: the only module state it
// may read is what a stub prelude can provide (client, chats, link,
// refreshHealth, refreshing, refreshInFlight) plus
// reconnectPush/refreshChats.
// enil:sync-begin
/** The advice that goes with the last refresh failure, never the raw error. */
function refreshErrorHint(): string {
  // Same wording the panel already shows for a failed login with the same
  // classification -- one vocabulary for "your token died" / "the net died".
  const reason = refreshHealthValue()?.reason;
  if (reason === "token_expired") return TOKEN_EXPIRED_TEXT;
  if (reason === "network") return NET_DOWN_TEXT;
  return "LINE 沒有回應，稍後再試";
}

/**
 * The manual override for "this list looks stale": rebuild the push link and
 * refetch now, instead of waiting out the 60s watchdog tick or the 5-minute
 * poll. A suspend, a flaky network or plain doubt all land here.
 *
 * reconnectPush is deliberately not awaited. It sleeps PUSH_REINIT_GRACE_MS
 * (8s) by design, to let linejs' own pusher loop heal before we fight it for
 * conns[0], and a button that answers after 8s reads as broken. Nothing in the
 * refetch needs the new link either: getMessageBoxes is an ordinary request,
 * not a push event. So the reply lands in the time one fetch takes and the
 * link finishes repairing behind it.
 *
 * The reported link is read *before* the reconnect: reconnectPush sets it down
 * synchronously and holds it there for the grace window, so reading afterwards
 * would answer "down" to every sync ever made and say nothing about anything.
 * Read here it answers the question the field exists for -- was the link the
 * thing that was broken?
 *
 * A round already on the wire is waited out rather than joined. refreshChats()
 * answers the coalescing `true` immediately, which is right for the callers
 * that only want the list to end up fresh -- but this one has to report on a
 * round that ran *after* the press, or 已同步 would stamp a count read before
 * the press and a failure in that round could never surface at all. Waiting
 * costs the tail of the round in flight (bounded by guardedFetch) and the panel
 * says 同步中… throughout, which is the truth.
 */
async function syncNow(): Promise<Json> {
  // Same string as handle()'s gate: to the panel it is the same situation.
  const owner = client;
  const generation = sessionGeneration;
  if (!owner) return { ok: false, error: "尚未登入" };
  // No user data: a count of manual syncs is the whole point of the line.
  console.log("[sync] requested");
  // A manual sync is a statement about the whole list, not about the chats
  // pushes happen to have touched -- it is the button the user presses when
  // they suspect the list is stale in a way pushes cannot see.
  setForceFullRefresh(true);
  const push = String(link?.push ?? "up");
  void reconnectPush("manual");
  // Never rejects today (runRefresh catches everything), but this must not be
  // the one await that can throw a sync away.
  if (refreshing && refreshInFlight) await refreshInFlight.catch(() => false);
  if (!sessionIsCurrent(owner, generation)) {
    return { ok: false, error: "登入狀態已變更，請再試一次" };
  }
  // Its own round. It may still coalesce -- but only onto a round that started
  // after the press, which is just as fresh.
  if (!await refreshChats(true)) {
    if (!sessionIsCurrent(owner, generation)) {
      return { ok: false, error: "登入狀態已變更，請再試一次" };
    }
    return { ok: false, error: `同步失敗：${refreshErrorHint()}` };
  }
  // A push that overtook that boxes snapshot can preserve its preview, but
  // unread counts still belong to the server. Reconcile through the newest
  // epoch known at this point exactly once, so continuous traffic cannot keep
  // the button pending forever.
  if (
    chatSummaryStore.lastRefreshSummaryEpoch <
      chatSummaryStore.chatSummaryEpoch
  ) {
    const requiredEpoch = chatSummaryStore.chatSummaryEpoch;
    let reconciled = true;
    while (chatSummaryStore.lastRefreshSummaryEpoch < requiredEpoch) {
      // A coalesced successor may have captured an older epoch just before
      // this press observed requiredEpoch. Keep joining/starting rounds until
      // one actually covers the fixed boundary captured above.
      if (!await refreshChats(true)) {
        reconciled = false;
        break;
      }
      if (!sessionIsCurrent(owner, generation)) break;
    }
    if (
      !reconciled ||
      chatSummaryStore.lastRefreshSummaryEpoch < requiredEpoch
    ) {
      if (!sessionIsCurrent(owner, generation)) {
        return { ok: false, error: "登入狀態已變更，請再試一次" };
      }
      return { ok: false, error: `同步失敗：${refreshErrorHint()}` };
    }
  }
  if (!sessionIsCurrent(owner, generation)) {
    return { ok: false, error: "登入狀態已變更，請再試一次" };
  }
  return {
    ok: true,
    data: { chats: chats.length, link: push, at: Date.now() },
  };
}
// enil:sync-end

export {
  beginLogin,
  endLogin,
  logout,
  logoutClaimed,
  scheduleResumeRetry,
  startLogin,
  syncNow,
  tryResume,
};
