/**
 * Pure text derivation shared by every layer: why an attachment cannot be
 * opened (mediastate), the sentence a caught value shows the user (errortext),
 * and the log line every module prints failures with (errorLine). Both
 * enil:-marker blocks are sliced out verbatim by mediastate_test.ts and
 * errortext_test.ts and pasted onto stub preludes, so the blocks themselves
 * stay exactly as they were; the module wrapper only adds imports and exports.
 *
 * Dependency direction: imports nothing at runtime (types are type-only).
 * Every other module may import from it.
 */
import type { Json } from "./types.ts";

// The block between the enil:mediastate markers is sliced out verbatim by
// daemon/mediastate_test.ts, and pasted in front of the preview block by
// daemon/preview_test.ts (previewText calls unsentOf). Pure derivation and
// pure string work: keep it free of module state.
// enil:mediastate-begin

/**
 * Why an attachment cannot be opened, decided before anything is fetched.
 * "unsent" is a message the sender recalled, "expired" a file past the 7 days
 * LINE keeps chat files for. Both used to reach the user as 「下載失敗」.
 */
type MediaState = "ok" | "unsent" | "expired";

// A recall sets one of these on the message that stays behind; which one
// depends on whether the sender chose the silent variant.
const UNSENT_KEYS = ["UNSENT", "SILENTLY_UNSENT"];

/** What LINE itself shows in place of a recalled message. */
const UNSENT_TEXT = "已收回訊息";
const UNSENT_ERROR = "訊息已收回";
const EXPIRED_ERROR = "檔案已過期（LINE 只保留 7 天）";
const ENCODE_ERROR = "回覆無法編碼";
const GONE_ERROR = "檔案已過期或已被刪除";
const DOWNLOAD_ERROR = "下載失敗";

function unsentOf(meta: Json): boolean {
  if (!meta) return false;
  for (const key of UNSENT_KEYS) {
    if (!(key in meta)) continue;
    // The value is LINE's string "true" today. Presence is the signal and
    // only a literal "false" denies it: a value we do not recognise still
    // means the key was set, and calling such a message recalled is better
    // than offering a download that cannot work.
    if (String(meta[key]).toLowerCase() !== "false") return true;
  }
  return false;
}

/**
 * FILE_EXPIRE_TIMESTAMP in ms. linejs reads the same key as
 * `parseInt(x) * 1000` (client/features/message/square.ts:368); this is
 * stricter -- a half-numeric string is corrupt metadata, not a date, and a
 * bogus early value would mark a live file expired and refuse it offline.
 */
function expiresAtOf(meta: Json): number | undefined {
  const raw = meta?.FILE_EXPIRE_TIMESTAMP;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) return undefined;
  return Math.trunc(secs) * 1000;
}

/** The same decision from the two fields a cached message kept. */
function mediaStateFrom(
  unsent: boolean,
  expiresAt: number | undefined,
  now: number,
): MediaState {
  if (unsent) return "unsent";
  if (expiresAt !== undefined && expiresAt < now) return "expired";
  return "ok";
}

function mediaStateOf(
  meta: Json,
  hasMedia: boolean,
  now: number,
): MediaState {
  // An expiry stamp on a message with nothing to download says nothing the
  // user can act on, so only media carries the "expired" state.
  return mediaStateFrom(
    unsentOf(meta),
    hasMedia ? expiresAtOf(meta) : undefined,
    now,
  );
}

// An OBS object that is gone answers 404/410; the fork patch turns that into
// InternalError "ObsError" with `<what>: HTTP <status>`. Upstream linejs
// instead gets as far as decrypting an empty body and fails in the E2EE layer
// with one of the other two texts (base/e2ee/mod.ts:1374 and :1385). All of
// them mean the same thing to the user: the bytes are not there any more.
const GONE_PATTERNS = [
  /HTTP (?:404|410)/,
  /ObsError/,
  /encrypted data too short/,
  /HMAC verification failed/,
];

/** The sentence the panel shows when a download that was tried came back. */
function downloadErrorText(e: Error): string {
  const text = `${e.name}: ${e.message}`;
  return GONE_PATTERNS.some((re) => re.test(text))
    ? GONE_ERROR
    : DOWNLOAD_ERROR;
}

// A linejs error text quotes the message it choked on, mid included.
const MID_RE = /[ucr][0-9a-f]{32}/g;

function redactMids(text: string): string {
  return text.replace(MID_RE, "<mid>");
}

/**
 * A refusal whose sentence to the panel is not its sentence for the journal.
 * `找不到檔案: <path>` has to reach the user -- they typed that path -- but a
 * path must never be logged, and widening the mid regex to catch one would
 * mangle every URL an error text quotes. (Frank, 2026-09-05)
 */
function refusal(error: string, logText: string): Json {
  return { ok: false, error, logText };
}

/**
 * `<class>: <message>` for a log line: redacted, and bounded so a library
 * that dumps a whole response body cannot fill the journal. Never a request
 * payload -- the class and the cause are what could not be traced before.
 */
function errorLine(err: unknown): string {
  const e = err instanceof Error ? err : null;
  // A refusal the daemon writes itself has no class, and labelling our own
  // Chinese sentence "Error" would suggest something threw.
  const name = e ? e.name : "Refused";
  return `${name}: ${redactMids(String(e ? e.message : err)).slice(0, 120)}`;
}
// enil:mediastate-end

// The block between the enil:errortext markers is sliced out verbatim by
// errortext_test.ts, and pasted in front of any other block whose code calls
// it. Nothing but the value it was handed: no module state, no I/O.
// enil:errortext-begin
const UNKNOWN_ERROR = "不明錯誤";
// The two refusals the panel has advice for, shared by refreshErrorHint()
// and refusalText(): one vocabulary for "the net died" / "your token died",
// wherever the failure happens to surface. Declared in this block because it
// is the one every error-path slice already pastes in front.
const NET_DOWN_TEXT = "連不上 LINE，稍後重試";
const TOKEN_EXPIRED_TEXT = "登入已過期，請重新掃描";

/**
 * What a caught value says to the user.
 *
 * `(e as Error).message` was the pattern at every one of these sites, and a
 * cast is not a check: a `throw "boom"`, a rejected promise carrying a bare
 * `{ message }` bag, or a thrown `undefined` all came out of it as the word
 * "undefined" -- 「貼圖清單讀不到：undefined」 on the panel, which sends the
 * user looking for a fault that is not theirs. An empty sentence is no better
 * than that one: a colon with nothing after it reads as a broken panel rather
 * than a request that failed, so there is always a word.
 */
function errorText(e: unknown): string {
  // An Error's `message` and a plain bag's are the same read, and a primitive
  // answers undefined here instead of throwing.
  const message = (e as { message?: unknown } | null | undefined)?.message;
  const text = typeof e === "string"
    ? e
    : typeof message === "string"
    ? message
    : e === null || e === undefined
    ? ""
    : String(e);
  return text.trim() ? text : UNKNOWN_ERROR;
}
// enil:errortext-end

export {
  DOWNLOAD_ERROR,
  downloadErrorText,
  ENCODE_ERROR,
  errorLine,
  errorText,
  EXPIRED_ERROR,
  expiresAtOf,
  GONE_ERROR,
  mediaStateFrom,
  mediaStateOf,
  NET_DOWN_TEXT,
  redactMids,
  refusal,
  TOKEN_EXPIRED_TEXT,
  UNSENT_ERROR,
  UNSENT_TEXT,
  unsentOf,
};
// The block between the enil:loginerror markers is sliced out verbatim by
// loginerror_test.ts, so it stays byte-identical here.
// The block between the enil:loginerror markers is sliced out verbatim by
// loginerror_test.ts, so it must stay self-contained: nothing in here may reach
// for module state other than what a stub prelude can provide.
// enil:loginerror-begin
/**
 * Why a login or resume failed, in the three shapes the panel can give useful
 * advice for.
 *
 * Everything worth matching on is spread across a cause chain, so the whole
 * chain is flattened before any pattern is applied. That is not tidiness:
 * Deno's fetch throws a bare `TypeError("fetch failed")` for every transport
 * failure and hangs the real diagnostic ("dns error: ...", "connection
 * refused") off `.cause`. Reading only the top-level message classified a
 * boot-time Wi-Fi race -- the exact case this field exists for -- as "unknown",
 * and the panel then showed the user the English words "fetch failed".
 *
 * Deno.errors subclasses are deliberately not tested: fetch never throws them,
 * only the raw socket APIs do, so `e instanceof Deno.errors.ConnectionRefused`
 * is false even for a refused connection made through fetch.
 *
 * linejs wraps a server refusal in an InternalError whose `name` is the error
 * type and whose message ends with JSON.stringify of the thrift error struct
 * (linejs 3.3.2 base/request/mod.ts:245-262). The `hasError` branch there
 * stringifies `res.data` rather than `res.data.e`, which puts the code one
 * level deeper, so the code is matched on both the struct field and the text.
 *
 * An aborted request is a network failure too, and it took the daemon down to
 * find out: a talk call that runs past linejs' `AbortSignal.timeout` (base/
 * request/mod.ts:159) rejects with a DOMException whose name is TimeoutError
 * and whose message is "The operation was aborted due to timeout" -- not one
 * word of which the transport patterns above matched. It came out "unknown",
 * so the panel offered no advice, runRefresh() skipped its one-shot retry, and
 * onUnhandledRejection() refused to claim it and let Deno exit 1. Both abort
 * names are matched as well as the text, because a DOMException carries the
 * diagnostic in `name` and nothing else.
 *
 * Only the classification escapes; the struct itself is never logged.
 */
function classifyLoginError(
  e: unknown,
): "token_expired" | "network" | "unknown" {
  const parts: string[] = [];
  let cur: unknown = e;
  // Bounded on purpose: a real chain is two or three deep, and a cyclic
  // `cause` would otherwise hang the daemon on its way to an error message.
  for (let depth = 0; cur && depth < 5; depth++) {
    const err = cur as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      data?: { code?: unknown };
    };
    parts.push(
      String(err.name ?? ""),
      String(err.message ?? ""),
      String(err.data?.code ?? ""),
    );
    cur = err.cause;
  }
  const text = parts.join(" ");
  // RefreshError means the access token asked to be refreshed and no refresh
  // token was stored -- there is nothing left to renew with, only a new scan.
  if (
    /RefreshError|MUST_REFRESH_V3_TOKEN|NOT_AUTHORIZED_DEVICE|AUTHENTICATION_FAILED/
      .test(text)
  ) return "token_expired";
  // Checked second so a server refusal that happens to mention a socket still
  // reads as an expiry: a dead token is actionable, "try again later" is not.
  if (
    /fetch failed|error sending request|dns error|network|timed out|aborted|TimeoutError|AbortError|connection (closed|reset|refused)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i
      .test(text)
  ) return "network";
  return "unknown";
}
// enil:loginerror-end

export { classifyLoginError };

export type { MediaState };
