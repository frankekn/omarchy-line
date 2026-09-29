/**
 * Process environment and infrastructure: the state/media directory paths,
 * the shared ImageCache and media work-lane, the rolling timing/size trackers,
 * the clipboard stage lifecycle (one instance, lent the media dir and the
 * journal line), the ENIL_* tuning constants behind the envint block, the
 * boot id, the decrypt-pool width, and the guardedFetch network guard.
 *
 * Dependency direction: imports only first-party leaf modules (imagecache,
 * runtime, clipboard) and errorLine from text.ts. Every other module may
 * import from it; it reaches for no daemon state.
 */
import { createClipboardStages } from "../clipboard.ts";
import { ImageCache } from "../imagecache.ts";
import { LatencyTracker, SizeTracker, WorkLane } from "../runtime.ts";
import { errorLine } from "./text.ts";
import { createMessageStore } from "./store.ts";

const HOME = Deno.env.get("HOME")!;
const STATE_DIR = `${
  Deno.env.get("XDG_STATE_HOME") ?? `${HOME}/.local/state`
}/enil`;
const STATE_PATH = `${STATE_DIR}/state.json`;
const EVENTS_PATH = `${STATE_DIR}/events.json`;
const SOCK_PATH = `${STATE_DIR}/sock`;
const MEDIA_DIR = `${STATE_DIR}/media`;
const IMAGE_DIR = `${MEDIA_DIR}/public-images`;
const imageCache = new ImageCache(IMAGE_DIR);
/** Shared across panel connections, so four windows cannot each start four. */
const panelMediaLane = new WorkLane(4, 60, 1);
/** Rolling diagnostics published with the next ordinary state write. */
const timings = new LatencyTracker();
/**
 * Serialized byte length of the last 64 committed state writes, published in
 * the same block style as `timings`: before any write-reduction work (field
 * diffs, split files) the numbers come straight off the file itself.
 */
const stateWriteBytes = new SizeTracker();
// The clipboard stage/claim lifecycle behind probeClipboardImage and
// sendClipboardImage, one instance for the process: the media directory and
// the journal line are ours to lend, and the staged bindings it holds retire
// with each logout (retireClipboardStages in logoutClaimed).
const {
  CLIPBOARD_STAGE_TTL_MS,
  claimClipboardStageBinding,
  clipboardStage,
  clipboardStageSessions,
  discardBoundClipboardStage,
  discardClipboardStage,
  expireClipboardStage,
  recoverClipboardStages,
  retireClipboardStages,
  sendClipboardImageRequest,
  wlPaste,
} = createClipboardStages({ errorLine, mediaDir: MEDIA_DIR });

// A subdirectory of the media cache, which is also what keeps pictures out of
// sweepMedia(): it only looks at plain files in the one directory it is given.
const AVATAR_DIR = `${MEDIA_DIR}/avatars`;
const AVATAR_INDEX_PATH = `${STATE_DIR}/avatars.json`;
const STORAGE_PATH = `${STATE_DIR}/storage.json`;
/**
 * One JSONL file per chat under messages/<myMid>/ -- the persistent message
 * store that lets history, paging and media previews answer locally instead
 * of paying a LINE round trip for every look.
 */
const messageStore = createMessageStore(`${STATE_DIR}/messages`);
// Which conversations this machine keeps out of the list. Ours alone: LINE's
// updateChat has no attribute for it, so there is nowhere to put it server
// side and nothing to sync -- see the enil:hidden block.
const HIDDEN_PATH = `${STATE_DIR}/hidden.json`;

// The block between the enil:envint markers is sliced out verbatim by
// daemon/envint_test.ts, so it must stay self-contained.
// enil:envint-begin
/**
 * Every ENIL_* number goes through here, because the failure mode of the raw
 * `Number(Deno.env.get(...) ?? n)` was silent and total: a typo made the value
 * NaN, and `setTimeout(..., NaN)` fires immediately -- so a mistyped
 * ENIL_REQUEST_TIMEOUT_MS aborted every request to LINE instead of doing
 * nothing. Zero and negatives are the same class of answer, so one rule covers
 * all three -- anything that is not a whole positive number means "the operator
 * did not actually choose a value", and the default stands. Every one of these
 * is a count or a millisecond count, so a fraction is a mistake too -- but the
 * check is on the parsed value, not its spelling, so "4.5e4" is still 45000.
 *
 * The value is never logged -- an override is the user's business, and the
 * name alone says what to fix.
 */
function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[env] ${name} ignored`);
    return fallback;
  }
  return n;
}
// enil:envint-end

// The QR-login docs use ANDROIDSECONDARY; DESKTOPWIN is gated out of
// getContactsV3, which is how display names get resolved below.
const DEVICE = (Deno.env.get("ENIL_DEVICE") ?? "ANDROIDSECONDARY") as never;
const HEARTBEAT_MS = 30_000; // plugin calls us offline after 180s
// LINE hands back GROUP boxes before USER boxes regardless of recency, so a
// small limit silently drops every 1:1 chat (50 → 0 of 66 users). Ask for
// everything and let the sort below decide what is recent.
const CHAT_LIMIT = envInt("ENIL_CHAT_LIMIT", 500);
// Suspend leaves the LEGY socket half-open: the kernel keeps it ESTAB, the
// library's read() never returns and no message is delivered again until the
// process restarts. The server pings every 30s, so three minutes of silence
// means the link is gone, not idle.
const PUSH_STALE_MS = envInt("ENIL_PUSH_STALE_MS", 180_000);
const WATCHDOG_MS = 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
// linejs rebuilds the conn by itself 4s after a read ends; wait longer than
// that before concluding its pusher loop is gone for good.
const PUSH_REINIT_GRACE_MS = 8_000;
// logind announces the resume before the network is actually usable.
const RESUME_DELAY_MS = 3_000;
// Last resort: even a wedged push must not hide a whole day of messages.
const POLL_MS = 5 * 60_000;
// The ceiling guardedFetch puts on the time to a response's headers. linejs
// asks for 30s itself, so matching it changes nothing for a healthy link.
const REQUEST_TIMEOUT_MS = envInt("ENIL_REQUEST_TIMEOUT_MS", 30_000);
// An upload's headers only come back once the whole body has been sent, so the
// media host gets linejs's own longTimeout instead of the talk one.
const UPLOAD_TIMEOUT_MS = 180_000;
// A bounded failure would otherwise wait for the 5-minute poll before trying
// again, which after a resume is most of the freeze this whole unit removes.
const REFRESH_RETRY_MS = 15_000;
// A push names the chats it changed, so the round it triggers can re-read
// just those instead of sweeping every box. Set ENIL_INCREMENTAL=0 to make
// every round a full getMessageBoxes sweep again.
const INCREMENTAL_REFRESH = (Deno.env.get("ENIL_INCREMENTAL") ?? "") !== "0";

/**
 * Changes on every start, so the panel can tell "the daemon restarted and the
 * ring begins again at 1" from "I missed some events".
 */
const BOOT_ID = crypto.randomUUID();

/**
 * Width of the decrypt pool. E2EE crypto per message dominates history and
 * chat-list wall time; 8 keeps the rounds short without racing the talk
 * transport's own connection reuse.
 */
const DECRYPT_WIDTH = 8;

// ------------------------------------------------------------ network guard

// The block between the enil:fetchguard markers is sliced out verbatim by
// daemon/fetchguard_test.ts, so it must stay self-contained: the only module
// state it may read is the two timeout constants above, which the test stubs.
// enil:fetchguard-begin
/**
 * Which ceiling a host gets. OBS is the media host -- linejs posts uploads to
 * the `https://obs.line-apps.com/` prefix (3.3.2 base/obs/mod.ts:50) -- and an
 * upload answers only after the whole body is on the wire, so a 30s ceiling
 * would kill every large attachment. Everything else is a talk call.
 */
function headerTimeoutMs(url: URL): number {
  return url.hostname.startsWith("obs")
    ? UPLOAD_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;
}

/**
 * Every request to LINE, bounded.
 *
 * linejs does set `signal: AbortSignal.timeout(timeout)` on the Request it
 * builds (3.3.2 base/request/mod.ts:159), but the Legy-encrypted talk
 * transport throws that Request away and builds a fresh one without the signal
 * (base/request/legy.ts:87-93), so nothing bounds what is actually sent. Deno
 * then reuses a pooled keep-alive connection that a long suspend has silently
 * killed -- no RST, so the write sits in the kernel until tcp_retries2 gives
 * up 15-30 minutes later. One getMessageBoxes hung that way held `refreshing`
 * and silenced every later refresh, while linejs's own pusher loop kept the
 * watchdog happy: link "up", chats frozen.
 *
 * Only the time to the response *headers* is bounded. fetch resolves as soon
 * as they arrive, so clearing the timer in `finally` is the entire point: the
 * push stream (base/push/conn.ts:116-126) and media downloads stream their
 * body for hours through this same function and must never be cut.
 *
 * Nothing about the request is logged: URLs, headers and bodies carry access
 * tokens and mids.
 */
async function guardedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const req = new Request(input, init);
  const ctrl = new AbortController();
  // Deno rejects the fetch with the abort reason itself, so the reason is an
  // Error whose text classifyLoginError reads as "network" -- the panel's
  // advice and the refresh retry below both hang off that classification.
  const timer = setTimeout(
    () => ctrl.abort(new Error("timed out waiting for response headers")),
    headerTimeoutMs(new URL(req.url)),
  );
  // The caller's own signal still has to work: aborting the push stream is how
  // listen() is stopped.
  const signal = AbortSignal.any([req.signal, ctrl.signal]);
  try {
    return await fetch(new Request(req, { signal }));
  } finally {
    clearTimeout(timer);
  }
}
// enil:fetchguard-end

export {
  AVATAR_DIR,
  AVATAR_INDEX_PATH,
  BOOT_ID,
  CHAT_LIMIT,
  DECRYPT_WIDTH,
  DEVICE,
  EVENTS_PATH,
  HEARTBEAT_MS,
  HIDDEN_PATH,
  IMAGE_DIR,
  imageCache,
  INCREMENTAL_REFRESH,
  MEDIA_DIR,
  messageStore,
  panelMediaLane,
  POLL_MS,
  PUSH_REINIT_GRACE_MS,
  PUSH_STALE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  REFRESH_RETRY_MS,
  REQUEST_TIMEOUT_MS,
  RESUME_DELAY_MS,
  SOCK_PATH,
  STATE_DIR,
  STATE_PATH,
  stateWriteBytes,
  STORAGE_PATH,
  timings,
  UPLOAD_TIMEOUT_MS,
  WATCHDOG_MS,
};

export {
  claimClipboardStageBinding,
  CLIPBOARD_STAGE_TTL_MS,
  clipboardStage,
  clipboardStageSessions,
  discardBoundClipboardStage,
  discardClipboardStage,
  expireClipboardStage,
  recoverClipboardStages,
  retireClipboardStages,
  sendClipboardImageRequest,
  wlPaste,
};

export { guardedFetch };

// The media lane's retirement signal: one per process, re-armed per logout so
// a retired session's queued media work is aborted at the lane boundary.
let panelMediaRetirementAbort = new AbortController();

/** Moves the lane to a fresh abort controller and retires the old slots. */
export function retirePanelMediaLane(): Promise<void> {
  panelMediaRetirementAbort.abort();
  panelMediaRetirementAbort = new AbortController();
  return panelMediaLane.retire();
}

export function panelMediaRetirementSignal(): AbortSignal {
  return panelMediaRetirementAbort.signal;
}
