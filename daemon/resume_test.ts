/**
 * The automatic resume retry: does it fire, does it back off, and — the part
 * that matters — does it get out of the way when someone else takes the
 * session.
 *
 * The sliced block calls setTimeout for real, so the stub prelude makes
 * backoffDelay() return a millisecond or two; what is asserted is the decision
 * (fire / don't fire / chain again), not the wall-clock delay, plus the
 * attempt number handed to backoffDelay, which is what actually produces the
 * 1s→60s curve in the daemon.
 *
 *   deno test -A resume_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock, sliceBlock } from "./slice_test.ts";

Deno.test("failed session setup retires its candidate through logout", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  assertEquals(
    source.match(/logoutClaimed\(terminal, terminal, candidate\);/g)?.length,
    2,
  );
  assert(!source.includes("function abandonFailedClient("));
  assertEquals(
    source.match(/logoutClaimed\(true, false, candidate\);/g)?.length,
    2,
    "both cancelled-resume paths revoke before clearing the candidate token",
  );
});

type Canned = "ok" | "none" | "error" | "expired";
interface ResumeModule {
  calls: { resume: number; refused: number; started: number; cleanup: number };
  logs: string[];
  backoffArgs: number[];
  attemptLogin(): void;
  beginLogin(): boolean;
  endLogin(): void;
  gateHeld(): boolean;
  getLogin(): { status: string; reason?: string };
  holdInFlight(): void;
  holdLogout(): void;
  loginCmd(): Promise<Record<string, unknown>>;
  logoutCmd(): Promise<Record<string, unknown>>;
  releaseInFlight(): void;
  releaseLogout(): void;
  scheduleResumeRetry(): void;
  setClient(client: object | null): void;
  setLogin(login: { status: string; reason?: string }): void;
}

/**
 * Stub module state + the real sliced code + a test handle. `results` is what
 * the stubbed tryResume() hands back, one entry per attempt.
 */
async function loadModule(results: Canned[]) {
  const prelude = `
export const calls = { resume: 0, refused: 0, started: 0, cleanup: 0 };
type LoginState = { status: string; reason?: string };
export let client: object | null = null;
export let loginInFlight = false;
type LoginOperation = "manual" | "resume" | "logout" | null;
let loginOperation: LoginOperation = null;
let loginSettled: Promise<void> = Promise.resolve();
let resolveLoginSettled: (() => void) | null = null;
let resumeCancelGeneration = 0;
let logoutRequested = false;
let activeLogout: Promise<Record<string, unknown>> | null = null;
export function setClient(c: object | null) { client = c; }
export function gateHeld() { return loginInFlight; }
// When armed, the stubbed tryResume() claims the gate and then parks, which is
// the async window the real tryResume() spends inside its FileStorage reads
// and loginWithAuthToken -- the window the race lives in.
let parked: Promise<void> | null = null;
let unpark: (() => void) | null = null;
export function holdInFlight() { parked = new Promise((r) => { unpark = r; }); }
export function releaseInFlight() { unpark?.(); unpark = null; parked = null; }
let logoutParked: Promise<void> | null = null;
let releaseLogoutPark: (() => void) | null = null;
export function holdLogout() {
  logoutParked = new Promise((r) => { releaseLogoutPark = r; });
}
export function releaseLogout() {
  releaseLogoutPark?.(); releaseLogoutPark = null; logoutParked = null;
}
// startLogin()-shaped: the same first statement and nothing else, so what is
// exercised is the real gate rather than a paraphrase of it.
export function attemptLogin() {
  if (!beginLogin()) { calls.refused++; return; }
  calls.started++;
  endLogin();
}
// The same shape one level up: an async startLogin() whose gate is claimed
// before its first await, with handle()'s "login" branch on top. handle()
// carries no slice markers, so the branch is transcribed here -- what the test
// is really pinning is that the real gate below decides the answer in time for
// a reply, and that a login that did start is not awaited.
export async function startLoginShaped(): Promise<boolean> {
  if (!beginLogin()) { calls.refused++; return false; }
  calls.started++;
  try { if (parked) await parked; } finally { endLogin(); }
  return true;
}
export async function loginCmd(): Promise<Record<string, unknown>> {
  if (client) return { ok: true };
  const outcome = await Promise.race([startLoginShaped(), "running"]);
  if (outcome === false) return { ok: false, error: "登入中，請稍候" };
  return { ok: true };
}
export async function logoutCmd(): Promise<Record<string, unknown>> {
  if (loginInFlight) {
    if (loginOperation === "logout") {
      if (activeLogout) return await activeLogout;
      await loginSettled;
      return { ok: true };
    }
    if (loginOperation !== "resume") return { ok: false, error: "busy" };
    logoutRequested = true;
    resumeCancelGeneration++;
    await loginSettled;
  }
  if (loginInFlight && loginOperation === "logout") {
    if (activeLogout) return await activeLogout;
    await loginSettled;
    return { ok: true };
  }
  loginInFlight = true;
  loginOperation = "logout";
  loginSettled = new Promise((resolve) => { resolveLoginSettled = resolve; });
  const operation: Promise<Record<string, unknown>> = (async () => {
    try {
      calls.cleanup++;
      if (logoutParked) await logoutParked;
      login = { status: "idle" };
      return { ok: true };
    } finally {
      logoutRequested = false;
      activeLogout = null;
      endLogin();
    }
  })();
  activeLogout = operation;
  return await operation;
}
export const logs: string[] = [];
export const backoffArgs: number[] = [];
export const results: string[] = ${JSON.stringify(results)};
export let resumeRetries = 0;
export let login: LoginState = { status: "error", reason: "network" };
export function setLogin(l: LoginState) { login = l; }
export function getLogin() { return login; }
// Shadows the global inside this throwaway module, so the block's own
// console.log lands in an array instead of the test output.
const console = { log(line: string) { logs.push(line); } };
function backoffDelay(attempt: number): number {
  backoffArgs.push(attempt);
  return 2;
}
// Each canned result also moves \`login\` the way the real tryResume() would,
// because the chain's decision to go again reads login.reason, not the result.
// "expired" is an "error" whose reason is token_expired.
async function tryResume(): Promise<string> {
  calls.resume++;
  // Same gate, same position -- first statement, before any await.
  if (!beginLogin("resume")) return "busy";
  const cancellation = resumeCancelGeneration;
  try {
    if (parked) await parked;
    if (logoutRequested || cancellation !== resumeCancelGeneration) return "none";
    const r = results.shift() ?? "error";
    if (r === "ok") login = { status: "ok" };
    else if (r === "none") login = { status: "idle" };
    else if (r === "expired") login = { status: "error", reason: "token_expired" };
    else login = { status: "error", reason: "network" };
    return r === "expired" ? "error" : r;
  } finally {
    endLogin();
  }
}
export { scheduleResumeRetry, beginLogin, endLogin };
`;
  // Both real blocks in one throwaway module: the retry calls tryResume(), and
  // the gate is what tryResume() and startLogin() share.
  return await loadBlock<ResumeModule>(
    "resumeretry",
    prelude + await sliceBlock("logingate"),
  );
}

/** The retry runs on a real timer; 2ms of backoff needs a moment to land. */
function settle(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("a network error schedules a retry that actually runs", async () => {
  const m = await loadModule(["ok"]);
  m.scheduleResumeRetry();
  assertEquals(m.calls.resume, 0, "scheduled, not run inline");
  await settle();
  assertEquals(m.calls.resume, 1);
  assertEquals(m.logs, ["[resume] retry attempt=1"]);
  assertEquals(m.getLogin().status, "ok");
});

Deno.test("a success ends the chain", async () => {
  const m = await loadModule(["ok"]);
  m.scheduleResumeRetry();
  await settle();
  assertEquals(m.calls.resume, 1);
  await settle();
  assertEquals(m.calls.resume, 1, "nothing rescheduled after ok");
});

Deno.test("it keeps going while the failure stays a network one", async () => {
  const m = await loadModule(["error", "error", "ok"]);
  m.scheduleResumeRetry();
  await settle(200);
  assertEquals(m.calls.resume, 3);
  assertEquals(m.logs, [
    "[resume] retry attempt=1",
    "[resume] retry attempt=2",
    "[resume] retry attempt=3",
  ]);
  // The attempt counter is what feeds the 1s→60s curve, so it has to climb.
  assertEquals(m.backoffArgs, [1, 2, 3]);
  await settle();
  assertEquals(m.calls.resume, 3, "stopped once it succeeded");
});

Deno.test("an expired token is not retried: waiting cannot heal it", async () => {
  const m = await loadModule(["expired"]);
  m.scheduleResumeRetry();
  await settle();
  assertEquals(m.calls.resume, 1);
  assertEquals(m.getLogin().reason, "token_expired");
  await settle();
  assertEquals(m.calls.resume, 1, "no second attempt for a dead token");
});

Deno.test("no stored token ends the chain too", async () => {
  const m = await loadModule(["none"]);
  m.scheduleResumeRetry();
  await settle();
  assertEquals(m.calls.resume, 1);
  await settle();
  assertEquals(m.calls.resume, 1);
});

Deno.test("a login already in progress is never raced", async () => {
  // This is the startLogin() interlock: a second loginWithAuthToken against
  // the same storage file while a QR login is running would fight it for the
  // token. The pending timer has to notice and drop the chain.
  for (const status of ["starting", "qr", "pin"]) {
    const m = await loadModule(["ok"]);
    m.scheduleResumeRetry();
    m.setLogin({ status }); // the user pressed 登入
    await settle();
    assertEquals(m.calls.resume, 0, `fired during ${status}`);
    assertEquals(m.logs, [], `logged during ${status}`);
  }
});

Deno.test("a session that came up by another path stops the retry", async () => {
  const m = await loadModule(["ok"]);
  m.scheduleResumeRetry();
  m.setLogin({ status: "ok" });
  await settle();
  assertEquals(m.calls.resume, 0);
});

Deno.test("a logout while a retry is pending stops it", async () => {
  const m = await loadModule(["ok"]);
  m.scheduleResumeRetry();
  m.setLogin({ status: "idle" });
  await settle();
  assertEquals(m.calls.resume, 0);
});

Deno.test("an error of another kind stops it as well", async () => {
  const m = await loadModule(["ok"]);
  m.scheduleResumeRetry();
  m.setLogin({ status: "error", reason: "token_expired" });
  await settle();
  assertEquals(m.calls.resume, 0);
  m.setLogin({ status: "error" }); // an older daemon: no reason field
  await settle();
  assertEquals(m.calls.resume, 0);
});

Deno.test("the attempt number in the log is the one it was scheduled with", async () => {
  // Not cosmetic: the log line is the only way to tell a stuck retry loop from
  // a healthy one in the journal, so it has to match the backoff step.
  const m = await loadModule(["error", "error", "error", "ok"]);
  m.scheduleResumeRetry();
  await settle(250);
  assert(m.logs.length >= 3, `only ${m.logs.length} attempts logged`);
  m.logs.forEach((line: string, i: number) =>
    assertEquals(line, `[resume] retry attempt=${i + 1}`)
  );
});

Deno.test("the gate is a claim, not a check: the second caller is refused", async () => {
  const m = await loadModule([]);
  assertEquals(m.gateHeld(), false);
  assert(m.beginLogin(), "the first caller takes it");
  assertEquals(m.gateHeld(), true);
  m.attemptLogin();
  assertEquals(m.calls.started, 0, "the second caller never got past line one");
  assertEquals(m.calls.refused, 1);
  m.endLogin();
  m.attemptLogin();
  assertEquals(m.calls.started, 1, "and can proceed once it is free");
});

Deno.test("a live session refuses a login without needing the flag", async () => {
  const m = await loadModule([]);
  m.setClient({});
  m.attemptLogin();
  assertEquals(m.calls.started, 0);
  assertEquals(m.calls.refused, 1);
});

Deno.test("a click while a retry is in flight is refused, not run alongside it", async () => {
  // The race the gate exists for: the retry's fire-time status check has
  // already passed and tryResume() is inside its awaits, but login.status has
  // not flipped yet, so nothing keyed on status or on `client` would stop a
  // second login here.
  const m = await loadModule(["ok"]);
  m.holdInFlight();
  m.scheduleResumeRetry();
  await settle();
  assertEquals(m.calls.resume, 1, "the retry is running");
  assertEquals(m.gateHeld(), true, "and holds the gate while it awaits");

  m.attemptLogin(); // the user presses 再試一次
  assertEquals(m.calls.started, 0, "no concurrent login was started");
  assertEquals(m.calls.refused, 1);

  m.releaseInFlight();
  await settle();
  assertEquals(m.gateHeld(), false, "the gate is released when it settles");
  m.attemptLogin(); // and a login is possible again
  assertEquals(m.calls.started, 1);
});

Deno.test("logout supersedes a resume parked before login status changes", async () => {
  const m = await loadModule(["ok"]);
  m.holdInFlight();
  m.scheduleResumeRetry();
  await settle();
  assertEquals(m.gateHeld(), true);
  assertEquals(m.getLogin(), { status: "error", reason: "network" });

  let settled = false;
  const loggingOut = m.logoutCmd().then((result) => {
    settled = true;
    return result;
  });
  await settle(10);
  assertEquals(
    settled,
    false,
    "logout waits for the cancelled resume to retire",
  );
  m.releaseInFlight();
  assertEquals(await loggingOut, { ok: true });
  assertEquals(m.getLogin().status, "idle");
  assertEquals(m.gateHeld(), false);
  assertEquals(m.calls.resume, 1, "the cancelled attempt is not retried");
});

Deno.test("concurrent logouts join one cleanup after cancelling resume", async () => {
  const m = await loadModule(["ok"]);
  m.holdInFlight();
  m.holdLogout();
  m.scheduleResumeRetry();
  await settle();

  let firstDone = false;
  let secondDone = false;
  const first = m.logoutCmd().then((result) => {
    firstDone = true;
    return result;
  });
  const second = m.logoutCmd().then((result) => {
    secondDone = true;
    return result;
  });
  m.releaseInFlight();
  await settle(10);
  assertEquals(m.calls.cleanup, 1, "one waiter owns cleanup");
  assertEquals([firstDone, secondDone], [false, false]);

  m.releaseLogout();
  assertEquals(await Promise.all([first, second]), [{ ok: true }, {
    ok: true,
  }]);
  assertEquals(m.calls.cleanup, 1);
  assertEquals(m.gateHeld(), false);
});

Deno.test("the command router lets logout reach an authenticating resume", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/socket.ts", import.meta.url),
  );
  const branch = source.slice(
    source.indexOf('if (cmd === "logout")'),
    source.indexOf(
      "// Before the guard, so there is exactly one gate for sync",
    ),
  );
  assert(branch.includes('loginOperation !== "resume"'));
  assert(branch.includes('loginOperation !== "logout"'));
  assert(branch.includes("return await logout();"));
  assert(
    branch.indexOf('loginOperation !== "resume"') <
      branch.indexOf('["starting", "qr", "pin"]'),
    "only manual QR/PIN startup is refused before logout coordination",
  );
});

Deno.test("a retry that fires while a login holds the gate reports busy and stops", async () => {
  // The mirror image: startLogin() got there first. The retry must not
  // overwrite that login's state with a failure of its own, and must not queue
  // another attempt behind it -- that login owns the session now.
  const m = await loadModule(["ok"]);
  m.scheduleResumeRetry();
  m.beginLogin(); // a QR login claims the gate
  await settle();
  assertEquals(m.calls.resume, 1, "the retry did fire");
  assertEquals(m.getLogin().status, "error", "but left login state untouched");
  assertEquals(m.getLogin().reason, "network");
  await settle();
  assertEquals(m.calls.resume, 1, "and did not schedule another round");
});

Deno.test("a click refused by the gate is answered, not swallowed", async () => {
  // The whole point of the boolean: the panel renders res.error, so a refusal
  // has to come back as one. {ok:true} plus nothing happening was the bug.
  const m = await loadModule(["ok"]);
  m.holdInFlight();
  m.scheduleResumeRetry();
  await settle();
  assertEquals(m.gateHeld(), true, "the retry holds the gate");
  assertEquals(await m.loginCmd(), { ok: false, error: "登入中，請稍候" });
  assertEquals(m.calls.started, 0, "and no login ran alongside it");
  m.releaseInFlight();
  await settle();

  // Once the gate is free the same command starts a login and answers ok
  // without waiting for it -- a QR login only ends when the user scans.
  m.holdInFlight();
  assertEquals(await m.loginCmd(), { ok: true });
  assertEquals(m.calls.started, 1);
  assertEquals(m.gateHeld(), true, "answered while the login is still running");
  m.releaseInFlight();
  await settle();
});
