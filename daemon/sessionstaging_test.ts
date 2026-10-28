import { assertEquals } from "@std/assert";
import { SessionStore } from "./sessionstore.ts";
import { loadBlock, sliceBlock } from "./slice_test.ts";

interface StagingHarness {
  faults: { profile: boolean; cleanup: boolean; expiry: boolean };
  states: Record<string, unknown>[];
  published: Record<string, unknown>[];
  revocations(): number;
  gateHeld(): boolean;
  configure(store: SessionStore): void;
  startLogin(): Promise<boolean>;
  rotate(): Promise<void>;
}

const original = {
  ".auth": "synthetic-old-access",
  refreshToken: "synthetic-old-refresh",
  expire: 100,
  qrCert: "synthetic-old-cert",
  e2eeKeys: { keyId: 1, publicKey: "synthetic-old-key" },
};
const replacement = {
  ".auth": "synthetic-new-access",
  refreshToken: "synthetic-new-refresh",
  expire: 200,
  qrCert: "synthetic-new-cert",
  e2eeKeys: { keyId: 2, publicKey: "synthetic-new-key" },
};

async function load(store: SessionStore): Promise<StagingHarness> {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const start = source.slice(
    source.indexOf("async function startLogin("),
    source.indexOf("async function onLoggedIn("),
  );
  const wrapper = await Deno.readTextFile(
    new URL("./vendor/linejs/packages/linejs/client/login.ts", import.meta.url),
  );
  const loginWithQR = wrapper.slice(
    wrapper.indexOf("export const loginWithQR ="),
    wrapper.indexOf("export interface WithPasswordOptions"),
  );
  const vendor = await Deno.readTextFile(
    new URL(
      "./vendor/linejs/packages/linejs/base/login/mod.ts",
      import.meta.url,
    ),
  );
  const ready = vendor.slice(
    vendor.indexOf("\tasync ready():"),
    vendor.indexOf("\n\t/**\n\t * Logs in the user"),
  );
  const prelude = `
export const faults = { profile: false, cleanup: false, expiry: false };
export const states = [];
export const published = [];
let store;
export function configure(value) { store = value; }
async function sessionStorage() { return store; }
let client = null;
let loginInFlight = false;
let loginOperation = null;
let logoutRequested = false;
let loginSettled = Promise.resolve();
let resolveLoginSettled = null;
let revoked = 0;
export function revocations() { return revoked; }
export function gateHeld() { return loginInFlight; }
const DEVICE = "DESKTOPWIN";
const STATE_DIR = "synthetic-unused-state";
const guardedFetch = () => { throw new Error("unexpected network access"); };
const QRCode = { async toFile() {} };
async function setLogin(status, extra = {}) { states.push({ status, ...extra }); }
function releaseStateWrites() {}
function errorText(error) { return error.message; }
function errorLine(error) { return error.message; }
async function logoutClaimed(revoke, _idle, candidate) {
  if (revoke && candidate) {
    await candidate.base.auth.logoutZ();
    for (const key of [".auth", "refreshToken", "expire"]) {
      await candidate.base.storage.delete(key);
    }
  }
  client = null;
  if (faults.cleanup) throw new Error("synthetic cleanup failure");
}
async function onLoggedIn(candidate) {
  client = candidate;
  published.push(await store.getAll());
  await setLogin("ok");
}
export async function rotate() {
  await client.base.storage.set(".auth", "synthetic-rotated-access");
  await client.base.storage.set("refreshToken", "synthetic-rotated-refresh");
  await client.base.storage.set("expire", 300);
}
class Login {
  constructor(client) { this.client = client; }
  async withQrCode() {
    await this.client.storage.set("qrCert", "synthetic-new-cert");
    await this.client.storage.set("e2eeKeys", { keyId: 2, publicKey: "synthetic-new-key" });
    await this.client.storage.set("refreshToken", "synthetic-new-refresh");
    await this.client.storage.set("expire", 200);
    if (faults.expiry) throw new Error("synthetic QR expired");
    this.client.authToken = "synthetic-new-access";
  }
${ready}
}
class Client {
  constructor(base) { this.base = base; }
  get authToken() { return this.base.authToken; }
}
function createBaseClient(init) {
  const base = {
    storage: init.storage,
    on() {}, emit() {},
    auth: { async logoutZ() { revoked++; } },
    talk: { async getProfile() {
      if (faults.profile) throw new DOMException("synthetic profile timeout", "TimeoutError");
      return { mid: "synthetic-mid" };
    } },
  };
  base.loginProcess = new Login(base);
  return base;
}
${loginWithQR}
${await sliceBlock("logingate")}
${start}
export { startLogin };
`;
  const harness = await loadBlock<StagingHarness>("loginerror", prelude);
  harness.configure(store);
  return harness;
}

async function withStore(
  body: (
    harness: StagingHarness,
    store: SessionStore,
    path: string,
    before: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-sessionstaging-test-" });
  try {
    const path = `${dir}/storage.json`;
    const before = JSON.stringify(original, null, 2) + "\n";
    await Deno.writeTextFile(path, before);
    const store = new SessionStore(path);
    await body(await load(store), store, path, before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const fault of ["profile", "expiry"] as const) {
  for (const cleanup of [false, true]) {
    Deno.test(`QR ${fault} failure preserves every stored byte with cleanup=${cleanup}`, async () => {
      await withStore(async (harness, store, path, before) => {
        harness.faults[fault] = true;
        harness.faults.cleanup = cleanup;
        assertEquals(await harness.startLogin(), true);
        assertEquals(await Deno.readTextFile(path), before);
        assertEquals(await store.getAll(), original);
        assertEquals(harness.revocations(), 0);
        assertEquals(harness.states.at(-1)?.settled, false);
        assertEquals(harness.gateHeld(), false);
        harness.faults[fault] = false;
        harness.faults.cleanup = false;
        assertEquals(await harness.startLogin(), true);
        assertEquals(harness.states.at(-1)?.status, "ok");
      });
    });
  }
}

Deno.test("QR success commits all credentials before publication and keeps storage live", async () => {
  await withStore(async (harness, store) => {
    assertEquals(await harness.startLogin(), true);
    assertEquals(harness.states.at(-1)?.status, "ok");
    assertEquals(harness.published, [replacement]);
    assertEquals(await store.getAll(), replacement);
    await harness.rotate();
    assertEquals(await store.getAll(), {
      ...replacement,
      ".auth": "synthetic-rotated-access",
      refreshToken: "synthetic-rotated-refresh",
      expire: 300,
    });
  });
});

for (const failure of ["rename", "partial-write"] as const) {
  for (const cleanup of [false, true]) {
    Deno.test(`QR commit ${failure} failure preserves originals with cleanup=${cleanup}`, async () => {
      await withStore(async (harness, store, path, before) => {
        harness.faults.cleanup = cleanup;
        const rename = Deno.rename;
        const write = Deno.FsFile.prototype.write;
        if (failure === "rename") {
          Deno.rename = (from, to) => {
            if (to === path) {
              return Promise.reject(new Error("synthetic commit failure"));
            }
            return rename(from, to);
          };
        } else {
          let writes = 0;
          Deno.FsFile.prototype.write = function (bytes: Uint8Array) {
            if (writes++ === 0) return write.call(this, bytes.subarray(0, 3));
            return Promise.reject(new Error("synthetic commit failure"));
          };
        }
        try {
          assertEquals(await harness.startLogin(), true);
        } finally {
          Deno.rename = rename;
          Deno.FsFile.prototype.write = write;
        }
        assertEquals(await Deno.readTextFile(path), before);
        assertEquals(await store.getAll(), original);
        assertEquals(harness.revocations(), 1);
        assertEquals(harness.published, []);
        assertEquals(harness.states.at(-1)?.error, "synthetic commit failure");
        assertEquals(harness.states.at(-1)?.settled, false);
        assertEquals(harness.gateHeld(), false);
        const names = [];
        for await (
          const entry of Deno.readDir(new URL(".", `file://${path}`))
        ) {
          names.push(entry.name);
        }
        assertEquals(names, ["storage.json"]);
        await store.set("future", "synthetic-later-write");
        harness.faults.cleanup = false;
        assertEquals(await harness.startLogin(), true);
        assertEquals(harness.states.at(-1)?.status, "ok");
        assertEquals(await store.get("future"), "synthetic-later-write");
      });
    });
  }
}
