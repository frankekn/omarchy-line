import { assertEquals, assertRejects } from "@std/assert";
import { loadBlock, sliceBlock } from "./slice_test.ts";

interface LoginHarness {
  faults: {
    store?: unknown;
    cleanup?: unknown;
    publish?: unknown;
    profile?: unknown;
    beforePoll?: unknown;
    setup?: unknown;
    qr: unknown[];
    pin: unknown[];
  };
  calls: {
    store: number;
    qr: number;
    pin: number;
    profile: number;
    cleanup: number;
    revoke: number;
  };
  credentials: Record<string, string>;
  states: Record<string, unknown>[];
  logs: string[];
  pollLimits: { qr: number; pin: number };
  QrPollingExpiredError: new (phase: "qr" | "pin", cause?: unknown) => Error & {
    code: string;
  };
  startLogin(): Promise<boolean>;
  gateHeld(): boolean;
}

async function load(): Promise<LoginHarness> {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.slice(
    source.indexOf("async function startLogin("),
    source.indexOf("async function onLoggedIn("),
  );
  const vendor = await Deno.readTextFile(
    new URL(
      "./vendor/linejs/packages/linejs/base/login/mod.ts",
      import.meta.url,
    ),
  );
  const wrapper = await Deno.readTextFile(
    new URL("./vendor/linejs/packages/linejs/client/login.ts", import.meta.url),
  );
  const provenanceStart = vendor.indexOf("export class QrPollingExpiredError");
  assertEquals(provenanceStart >= 0, true, "vendor polling provenance exists");
  const provenance = vendor.slice(
    provenanceStart,
    vendor.indexOf("export type LoginOption"),
  );
  const qr = vendor.slice(
    vendor.indexOf("\tpublic async checkQrCodeVerified("),
    vendor.indexOf("\tpublic async verifyCertificate("),
  );
  const pin = vendor.slice(
    vendor.indexOf("\tpublic async checkPinCodeVerified("),
    vendor.indexOf("\tpublic async qrCodeLogin("),
  );
  const ready = vendor.slice(
    vendor.indexOf("\tasync ready():"),
    vendor.indexOf("\n\t/**\n\t * Logs in the user"),
  );
  const loginWithQR = wrapper.slice(
    wrapper.indexOf("export const loginWithQR ="),
    wrapper.indexOf("export interface WithPasswordOptions"),
  );
  const prelude = `
${provenance}
export const faults = { qr: [], pin: [] };
export const pollLimits = { qr: 2, pin: 2 };
export const calls = { store: 0, qr: 0, pin: 0, profile: 0, cleanup: 0, revoke: 0 };
export const credentials = { ".auth": "offline-token", refreshToken: "offline-refresh" };
export const states = [];
export const logs = [];
const console = { error(...args) { logs.push(args.join(" ")); } };
const Deno = {
  errors: globalThis.Deno.errors,
  async readTextFile() {
    calls.store++;
    if (faults.store) throw faults.store;
    return JSON.stringify(credentials);
  },
  async *readDir() {},
  async remove() {},
};
const STORAGE_PATH = "offline-storage";
const STATE_DIR = "offline-state";
const DEVICE = "DESKTOPWIN";
const guardedFetch = () => { throw new Error("unexpected network access"); };
const QRCode = { async toFile() {} };
class SessionStore {
  constructor(_path) {}
  async stageLogin() { return this; }
  async commit(_accessToken) {}
}
let client = null;
let loginInFlight = false;
let loginOperation = null;
let logoutRequested = false;
let loginSettled = Promise.resolve();
let resolveLoginSettled = null;
export function gateHeld() { return loginInFlight; }
let stateWritesBlocked = false;
async function setLogin(status, extra = {}) {
  if (!stateWritesBlocked) states.push({ status, ...extra });
  if (status === "error" && faults.publish) throw faults.publish;
}
function errorText(error) { return error.message; }
function errorLine(error) { return error.message; }
function releaseStateWrites() { stateWritesBlocked = false; }
async function logoutClaimed(revoke, _idle, _candidate) {
  calls.cleanup++;
  stateWritesBlocked = true;
  if (revoke) {
    calls.revoke++;
    for (const key of Object.keys(credentials)) delete credentials[key];
  }
  client = null;
  if (faults.cleanup) throw faults.cleanup;
  releaseStateWrites();
}
async function onLoggedIn(c) {
  if (faults.setup) throw faults.setup;
  client = c;
}
class Login {
  constructor(client) { this.client = client; }
  async withQrCode() {
    await this.client.emit("qrcall", "offline-code");
    if (faults.beforePoll) throw faults.beforePoll;
    await this.checkQrCodeVerified("offline-session", pollLimits.qr, 0);
    if (faults.pin.length) {
      await this.client.emit("pincall", "offline-pin");
      await this.checkPinCodeVerified("offline-session", pollLimits.pin, 0);
    }
    this.client.authToken = "offline-candidate";
  }
${qr}
${pin}
${ready}
}
class Client { constructor(base) { this.base = base; } }
function createBaseClient() {
  const listeners = new Map();
  const base = {
    on(name, callback) { listeners.set(name, callback); },
    emit(name, value) { return listeners.get(name)?.(value); },
    request: { async request(_args, method) {
      const phase = method === "checkQrCodeVerified" ? "qr" : "pin";
      calls[phase]++;
      if (faults[phase].length) throw faults[phase].shift();
    } },
    talk: { async getProfile() {
      calls.profile++;
      if (faults.profile) throw faults.profile;
      return {};
    } },
  };
  base.loginProcess = new Login(base);
  return base;
}
${loginWithQR}
${await sliceBlock("logingate")}
${await sliceBlock("storageguard")}
${start}
export { startLogin };
`;
  return await loadBlock<LoginHarness>("loginerror", prelude);
}

Deno.test("manual login releases its real gate after a session-store read failure", async () => {
  const m = await load();
  m.faults.store = new Deno.errors.PermissionDenied("offline store denied");
  const saved = { ...m.credentials };
  assertEquals(await m.startLogin(), true);
  assertEquals(m.gateHeld(), false);
  assertEquals(m.states.at(-1), {
    status: "error",
    error: "offline store denied",
    reason: "unknown",
    attempt: "manual",
    settled: false,
  });
  assertEquals(await m.startLogin(), true);
  assertEquals(m.calls.store >= 2, true);
  assertEquals(m.calls.qr, 0);
  assertEquals(m.calls.revoke, 0);
  assertEquals(m.credentials, saved);
});

Deno.test("manual login reports storage failure even when its cleanup also fails", async () => {
  const m = await load();
  m.faults.store = new Error("offline store failure");
  m.faults.cleanup = new Error("offline cleanup failure");
  const saved = { ...m.credentials };
  assertEquals(await m.startLogin(), true);
  assertEquals(m.states.at(-1)?.error, "offline store failure");
  assertEquals(m.gateHeld(), false);
  assertEquals(await m.startLogin(), true);
  assertEquals(m.calls.store, 2);
  assertEquals(m.calls.qr, 0);
  assertEquals(m.credentials, saved);
});

Deno.test("polling expiry preserves its cause without publishing session data", async () => {
  const m = await load();
  const cause = new Error("status=410 offline-session");
  const error = new m.QrPollingExpiredError("qr", cause);
  assertEquals(error.cause, cause);
  assertEquals(error.code, "QR_POLLING_EXPIRED");
  assertEquals(error.message.includes("offline-session"), false);
});

Deno.test("manual login publishes the original error even when cleanup fails", async () => {
  const m = await load();
  m.faults.profile = new DOMException("profile timed out", "TimeoutError");
  m.faults.cleanup = new Error("offline cleanup failed");
  assertEquals(await m.startLogin(), true);
  assertEquals(m.states.at(-1)?.reason, "network");
  assertEquals(m.states.at(-1)?.error, "profile timed out");
  assertEquals(m.gateHeld(), false);
  assertEquals(await m.startLogin(), true);
  assertEquals(m.calls.profile, 2);
  assertEquals(m.calls.revoke, 0);
});

Deno.test("manual login releases its gate even if error publication fails", async () => {
  const m = await load();
  m.faults.store = new Error("offline store failure");
  m.faults.publish = new Error("offline publication failure");
  await assertRejects(
    () => m.startLogin(),
    Error,
    "offline publication failure",
  );
  assertEquals(m.gateHeld(), false);
  delete m.faults.publish;
  assertEquals(await m.startLogin(), true);
});

Deno.test("loginWithQR ready profile timeout remains network after showing a code", async () => {
  const m = await load();
  m.faults.profile = new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
  assertEquals(await m.startLogin(), true);
  assertEquals(m.calls.profile, 1);
  assertEquals(m.states.some((state) => state.status === "qr"), true);
  assertEquals(m.states.at(-1)?.reason, "network");
  assertEquals(m.states.at(-1)?.settled, false);
});

for (const phase of ["qr", "pin"] as const) {
  Deno.test(`${phase} exhausted polling budget expires without another request`, async () => {
    const m = await load();
    m.pollLimits[phase] = 0;
    if (phase === "pin") m.faults.pin = [new Error("not requested")];
    assertEquals(await m.startLogin(), true);
    assertEquals(m.calls[phase], 0);
    assertEquals(m.calls.profile, 0);
    assertEquals(m.states.at(-1)?.reason, "qr_expired");
  });

  Deno.test(`${phase} polling can succeed after an intermediate timeout`, async () => {
    const m = await load();
    m.faults[phase] = [new DOMException("Signal timed out.", "TimeoutError")];
    assertEquals(await m.startLogin(), true);
    assertEquals(m.calls[phase], 2);
    assertEquals(m.calls.profile, 1);
    assertEquals(m.states.some((state) => state.status === "error"), false);
  });

  Deno.test(`${phase} polling connection failure stays network without retry`, async () => {
    const m = await load();
    m.faults[phase] = [new TypeError("fetch failed")];
    assertEquals(await m.startLogin(), true);
    assertEquals(m.calls[phase], 1);
    assertEquals(m.states.at(-1)?.reason, "network");
  });

  for (const kind of ["timeout", "408", "410"] as const) {
    Deno.test(`${phase} polling ${kind} exhaustion has explicit expiry provenance`, async () => {
      const m = await load();
      const error = kind === "timeout"
        ? new DOMException("Signal timed out.", "TimeoutError")
        : new Error(`Request internal failed: status=${kind}`);
      m.faults[phase] = [error, error];
      assertEquals(await m.startLogin(), true);
      assertEquals(m.calls[phase], 2);
      assertEquals(m.calls.profile, 0);
      assertEquals(m.states.at(-1)?.reason, "qr_expired");
      assertEquals(m.states.at(-1)?.settled, false);
      assertEquals(m.calls.revoke, 0);
      assertEquals(m.gateHeld(), false);
      assertEquals(m.logs.join(" ").includes("offline-session"), false);
      assertEquals(
        String(m.states.at(-1)?.error).includes("offline-session"),
        false,
      );
    });
  }
  for (
    const code of [
      "BANNED",
      "ABUSE_BLOCK",
      "EXCESSIVE_ACCESS",
      "NOT_AUTHORIZED_DEVICE",
    ]
  ) {
    Deno.test(`${phase} polling never retries ${code} hidden in a timeout cause`, async () => {
      const m = await load();
      const error = new Error("poll timed out", {
        cause: { name: "RequestError", data: { code } },
      });
      m.faults[phase] = [error, error];
      assertEquals(await m.startLogin(), true);
      assertEquals(m.calls[phase], 1);
      assertEquals(
        m.states.at(-1)?.reason,
        code === "NOT_AUTHORIZED_DEVICE" ? "token_expired" : "restricted",
      );
      assertEquals(m.calls.revoke, 0);
    });
  }
}

Deno.test("a non-poll timeout after showing a code stays network", async () => {
  const m = await load();
  m.faults.beforePoll = new DOMException("request timed out", "TimeoutError");
  assertEquals(await m.startLogin(), true);
  assertEquals(m.calls.qr, 0);
  assertEquals(m.states.at(-1)?.reason, "network");
});

Deno.test("a partial candidate is still revoked after post-login setup failure", async () => {
  const m = await load();
  m.faults.setup = new Error("offline setup failed");
  assertEquals(await m.startLogin(), true);
  assertEquals(m.calls.revoke, 1);
  assertEquals(m.credentials, {});
  assertEquals(m.states.at(-1)?.settled, true);
  assertEquals(m.gateHeld(), false);
});
