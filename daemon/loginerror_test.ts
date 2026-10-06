/**
 * classifyLoginError: turning a linejs / Deno failure into the three reasons
 * the panel can give advice for.
 *
 * The shapes below are the real ones, not invented ones -- that distinction is
 * the whole point of this file. The first version of the classifier matched
 * only `e.message`, which for every Deno fetch failure is the literal string
 * "fetch failed"; the diagnostic that actually says what went wrong lives on
 * `e.cause`. A boot-time Wi-Fi race therefore came out as "unknown" and the
 * panel showed the user the English words "fetch failed".
 *
 *   deno test -A loginerror_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

async function load() {
  return await loadBlock<{
    classifyLoginError(error: unknown): "network" | "token_expired" | "unknown";
  }>(
    "loginerror",
    "export { classifyLoginError };\n",
  );
}

Deno.test("a Deno fetch failure is network, diagnostic and all", async () => {
  const { classifyLoginError } = await load();
  // Exactly what `await fetch("http://nonexistent.invalid.domain.zzz/x")`
  // throws: a bare TypeError, with everything useful one level down.
  const e = new TypeError("fetch failed", {
    cause: new Error(
      "error sending request for url (http://gw.line.naver.jp/): client " +
        "error (Connect): dns error: failed to lookup address information: " +
        "Name or service not known",
    ),
  });
  assertEquals(classifyLoginError(e), "network");
});

Deno.test("the bare TypeError alone is still network", async () => {
  // Some Deno builds hand back no cause at all; "fetch failed" is never
  // anything but a transport failure, so it has to stand on its own.
  const { classifyLoginError } = await load();
  assertEquals(classifyLoginError(new TypeError("fetch failed")), "network");
});

Deno.test("a diagnostic buried deeper in the chain is still found", async () => {
  const { classifyLoginError } = await load();
  const deep = new TypeError("fetch failed", {
    cause: new Error("client error (Connect)", {
      cause: new Error("connection refused"),
    }),
  });
  assertEquals(classifyLoginError(deep), "network");
});

Deno.test("a request that ran past linejs' timeout is network", async () => {
  const { classifyLoginError } = await load();
  // The real shape, and the one that killed the daemon on 2026-09-07: linejs
  // puts an AbortSignal.timeout on every talk request (base/request/mod.ts:159)
  // and Deno rejects with the signal's reason, a DOMException. Not one of the
  // transport patterns written for fetch appears in it -- there is no "timed
  // out" anywhere -- so it used to classify as "unknown", which meant no panel
  // advice, no refresh retry, and an unhandled rejection nobody would claim.
  const e = new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
  assertEquals(e.name, "TimeoutError");
  assertEquals(classifyLoginError(e), "network");
});

Deno.test("an aborted request is network even with the message alone", async () => {
  const { classifyLoginError } = await load();
  // A DOMException carries its diagnostic in `name`, so both halves have to
  // stand on their own: a wrapper that keeps only one of them still has to
  // classify.
  assertEquals(
    classifyLoginError({ name: "TimeoutError", message: "" }),
    "network",
  );
  assertEquals(
    classifyLoginError({
      name: "Error",
      message: "The operation was aborted due to timeout",
    }),
    "network",
  );
});

Deno.test("a cancelled request is network, not a bug", async () => {
  const { classifyLoginError } = await load();
  // What an AbortController aborts a fetch with. It is the same answer as a
  // timeout on purpose: the request did not complete over the network, and
  // "try again" is the only advice either one supports.
  assertEquals(
    classifyLoginError(
      new DOMException("The signal has been aborted", "AbortError"),
    ),
    "network",
  );
});

Deno.test("a cyclic cause chain terminates instead of hanging the daemon", async () => {
  const { classifyLoginError } = await load();
  const a: Error & { cause?: unknown } = new Error("boom");
  a.cause = a;
  assertEquals(classifyLoginError(a), "unknown");
});

Deno.test("RefreshError is an expired token", async () => {
  const { classifyLoginError } = await load();
  // linejs: new InternalError("RefreshError", "refreshToken not found"), whose
  // constructor assigns `this.name = type`. Nothing else identifies it.
  assertEquals(
    classifyLoginError({
      name: "RefreshError",
      message: "refreshToken not found",
    }),
    "token_expired",
  );
});

Deno.test("a RequestError carrying a dead-token code is an expired token", async () => {
  const { classifyLoginError } = await load();
  for (
    const code of [
      "MUST_REFRESH_V3_TOKEN",
      "NOT_AUTHORIZED_DEVICE",
      "AUTHENTICATION_FAILED",
    ]
  ) {
    assertEquals(
      classifyLoginError({
        name: "RequestError",
        message:
          `Request internal failed, getProfile(/S4) -> {"code":"${code}"}`,
        data: { code },
      }),
      "token_expired",
      code,
    );
  }
});

Deno.test("a server-side logout is an expired token, nested or bare", async () => {
  const { classifyLoginError } = await load();
  // The real 2026-09-27 shape, recorded by the heartbeat: the death reason
  // nests inside a NOT_AUTHORIZED_DEVICE code. The code alone already
  // classifies; this pins that the pair together still does.
  assertEquals(
    classifyLoginError({
      name: "RequestError",
      message:
        'Request internal failed, getProfile(/S4) -> {"code":"NOT_AUTHORIZED_DEVICE","reason":"V3_TOKEN_CLIENT_LOGGED_OUT"}',
      data: { code: "NOT_AUTHORIZED_DEVICE" },
    }),
    "token_expired",
  );
  // Defensive: if a future wire shape surfaces the reason as the code
  // itself, it must still be terminal. Before the marker was listed this
  // came out "unknown" -- creds kept, generic advice, no revoke.
  assertEquals(
    classifyLoginError({
      name: "RequestError",
      message:
        'Request internal failed, getProfile(/S4) -> {"code":"V3_TOKEN_CLIENT_LOGGED_OUT"}',
      data: { code: "V3_TOKEN_CLIENT_LOGGED_OUT" },
    }),
    "token_expired",
  );
});

Deno.test("the code is found even when only the message carries it", async () => {
  // The `hasError` branch of linejs' requestCore stringifies `res.data`, not
  // `res.data.e`, so the code sits one level deeper than `data.code` and the
  // struct field is absent.
  const { classifyLoginError } = await load();
  assertEquals(
    classifyLoginError({
      name: "RequestError",
      message:
        'Request internal failed, x(/S4) -> {"e":{"code":"NOT_AUTHORIZED_DEVICE"}}',
      data: { e: { code: "NOT_AUTHORIZED_DEVICE" } },
    }),
    "token_expired",
  );
});

Deno.test("an expiry that arrives over a working socket is not called network", async () => {
  // Ordering matters: a dead token is actionable ("scan again"), "try later"
  // is not, so token_expired has to win when both could match.
  const { classifyLoginError } = await load();
  assertEquals(
    classifyLoginError(
      new TypeError("fetch failed", {
        cause: {
          name: "RequestError",
          data: { code: "MUST_REFRESH_V3_TOKEN" },
        },
      }),
    ),
    "token_expired",
  );
});

Deno.test("anything else is unknown, which renders the raw text", async () => {
  const { classifyLoginError } = await load();
  assertEquals(classifyLoginError(new Error("boom")), "unknown");
  assertEquals(classifyLoginError(undefined), "unknown");
  assertEquals(classifyLoginError(null), "unknown");
  assertEquals(classifyLoginError({}), "unknown");
});

Deno.test("a failed post-login setup clears the partial session but keeps stored credentials", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.indexOf("    await onLoggedIn(c);");
  const branch = source.slice(start, source.indexOf("  } finally {", start));
  assertEquals(branch.includes("const terminal = candidate !== null;"), true);
  assertEquals(
    branch.includes("await logoutClaimed(terminal, terminal, candidate);"),
    true,
  );
  assertEquals(
    branch.indexOf("await logoutClaimed(terminal, terminal, candidate);") <
      branch.indexOf('await setLogin("error"'),
    true,
  );
  assertEquals(branch.includes('attempt: "manual"'), true);
  assertEquals(branch.includes("settled: terminal"), true);
});

Deno.test("a failed QR attempt preserves the stored resumable session", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.indexOf("async function startLogin");
  const branch = source.slice(
    start,
    source.indexOf("async function onLoggedIn", start),
  );
  assertEquals(branch.includes("const terminal = candidate !== null;"), true);
  assertEquals(
    branch.includes("await logoutClaimed(terminal, terminal, candidate);"),
    true,
  );
  assertEquals(branch.includes("settled: terminal"), true);
  assertEquals(branch.includes("await logoutClaimed();"), false);
});

Deno.test("authentication releases its gate before the initial refresh", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.indexOf("async function onLoggedIn(");
  const branch = source.slice(
    start,
    source.indexOf("async function tryResume", start),
  );
  assertEquals(branch.includes("void refreshChats();"), true);
  assertEquals(branch.includes("await refreshChats();"), false);
});

Deno.test("a failed resume revokes credentials only for an expired token", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.indexOf("async function tryResume");
  const branch = source.slice(
    start,
    source.indexOf("// enil:resumeretry-begin", start),
  );
  assertEquals(branch.includes("const kind = classifyLoginError(e);"), true);
  assertEquals(
    branch.includes(
      'const terminal = kind === "token_expired";',
    ),
    true,
  );
  const logout = branch.indexOf(
    "await logoutClaimed(terminal, terminal, candidate);",
  );
  assertEquals(
    logout < branch.indexOf('await setLogin("error"', logout),
    true,
  );
  assertEquals(branch.includes('attempt: "resume"'), true);
  assertEquals(branch.includes("settled: terminal"), true);
  assertEquals(source.includes("releaseStateWrites();"), true);
  assertEquals(source.includes('attempt: "logout"'), true);
  assertEquals(
    (
      await Deno.readTextFile(
        new URL("./modules/state.ts", import.meta.url),
      )
    ).includes('let login: Json = { status: "idle", settled: false };'),
    true,
  );
});

Deno.test("logout after reading a resume token still attempts remote revocation", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.indexOf("async function tryResume");
  const branch = source.slice(
    start,
    source.indexOf("// enil:resumeretry-begin", start),
  );
  const tokenReady = branch.indexOf(
    'if (typeof token !== "string" || !token) return "none";',
  );
  const authenticate = branch.indexOf(
    "const c = await loginWithAuthToken",
    tokenReady,
  );
  assert(tokenReady >= 0 && authenticate > tokenReady);
  assertEquals(
    branch.slice(tokenReady, authenticate).includes(
      'if (cancelled()) return "none";',
    ),
    false,
  );
  assert(
    branch.indexOf(
      "await logoutClaimed(true, false, candidate);",
      authenticate,
    ) >
      authenticate,
  );
});

Deno.test("post-login cleanup revokes the candidate before clearing its token", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.indexOf("async function logoutClaimed(");
  const branch = source.slice(
    start,
    source.indexOf(
      "// ------------------------------------------------------------ manual sync",
      start,
    ),
  );
  assertEquals(branch.includes("retiringClient: Client | null = client"), true);
  assertEquals(branch.includes("const c = retiringClient;"), true);
});

Deno.test("an unreadable auth store is not treated as a completed logout", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.indexOf('token = await storage.get(".auth")');
  const branch = source.slice(start, source.indexOf("if (typeof token", start));
  assertEquals(start >= 0, true);
  assertEquals(branch.includes("} catch (e) {"), true);
  assertEquals(branch.includes('await setLogin("error", {'), true);
  assertEquals(branch.includes('reason: "unknown"'), true);
  assertEquals(branch.includes('attempt: "resume"'), true);
  assertEquals(branch.includes("settled: false"), true);
  assertEquals(branch.includes('return "error";'), true);
  assertEquals(
    source.includes('storage.get(".auth").catch(() => undefined)'),
    false,
  );
});

Deno.test("a no-token resume publishes a durable completed attempt", async () => {
  const source = await Deno.readTextFile(
    new URL("./daemon.ts", import.meta.url),
  );
  const start = source.indexOf('if (resumed === "none")');
  const branch = source.slice(start, source.indexOf("} else if", start));
  assertEquals(
    branch.includes(
      'await setLogin("idle", { attempt: "resume", settled: true });',
    ),
    true,
  );
});

Deno.test("an account LINE refused is restricted, by struct field or by text", async () => {
  const { classifyLoginError, restrictionCode } = await loadBlock<{
    classifyLoginError(error: unknown): string;
    restrictionCode(error: unknown): string | null;
  }>("loginerror", "export { classifyLoginError, restrictionCode };\n");
  for (const code of ["ABUSE_BLOCK", "BANNED", "EXCESSIVE_ACCESS"]) {
    const byField = {
      name: "RequestError",
      message:
        `Request internal failed, sendMessage(/S4) -> {"code":"${code}"}`,
      data: { code },
    };
    assertEquals(classifyLoginError(byField), "restricted", code);
    assertEquals(restrictionCode(byField), code);
    // The hasError branch of linejs' requestCore puts the code one level
    // deeper, so the text alone has to carry it.
    const byText = {
      name: "RequestError",
      message: `Request internal failed, x(/S4) -> {"e":{"code":"${code}"}}`,
    };
    assertEquals(classifyLoginError(byText), "restricted", code);
    assertEquals(restrictionCode(byText), code);
  }
  // A restriction beats a dead-token marker in the same struct: nothing may
  // be revoked or retried over an account LINE has refused.
  assertEquals(
    classifyLoginError({
      name: "RequestError",
      message:
        'Request internal failed, x(/S4) -> {"code":"BANNED","reason":"NOT_AUTHORIZED_DEVICE"}',
    }),
    "restricted",
  );
});

Deno.test("a maintenance window and a per-target refusal are not restrictions", async () => {
  const { classifyLoginError, restrictionCode } = await loadBlock<{
    classifyLoginError(error: unknown): string;
    restrictionCode(error: unknown): string | null;
  }>("loginerror", "export { classifyLoginError, restrictionCode };\n");
  for (
    const code of [
      "MAINTENANCE_ERROR",
      "NOT_AVAILABLE_USER",
      "FEATURE_RESTRICTED",
    ]
  ) {
    const e = {
      name: "RequestError",
      message: `Request internal failed, x(/S4) -> {"code":"${code}"}`,
      data: { code },
    };
    assertEquals(classifyLoginError(e), "unknown", code);
    assertEquals(restrictionCode(e), null, code);
  }
  // A substring is not a code: "UNBANNED" or "BANNED_WORD" would be a
  // different enum member, and a transport error is still network.
  assertEquals(restrictionCode(new Error("UNBANNED_X BANNEDISH")), null);
  assertEquals(classifyLoginError(new TypeError("fetch failed")), "network");
});
