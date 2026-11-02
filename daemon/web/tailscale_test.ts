import { assertEquals } from "@std/assert";
import { ownsAddress, tailnetIp, TailscaleAuth } from "./tailscale.ts";
import { createWeb } from "./server.ts";

const LOGIN = "owner@example.com";
const IP = "100.64.0.2";
const ADDR = "100.64.0.1:3440";
const req = (path = "/api/session", headers: HeadersInit = {}) =>
  new Request(`http://${ADDR}${path}`, { headers });
const identity = (login = LOGIN) => ({
  Node: { Addresses: [`${IP}/32`], MachineAuthorized: true },
  UserProfile: { LoginName: login },
});

Deno.test("Tailscale identity accepts only native tailnet IPs and the named owner's node", () => {
  for (
    const ip of [
      "127.0.0.1",
      "192.168.1.1",
      "100.63.255.255",
      "100.128.0.1",
      "::1",
      "::ffff:100.64.0.2",
      "fd00::1",
      "host",
      "100.64.0.2;id",
    ]
  ) assertEquals(tailnetIp(ip), null, ip);
  assertEquals(tailnetIp(IP), IP);
  assertEquals(tailnetIp("FD7A:115C:A1E0:0:0:0:0:2"), "fd7a:115c:a1e0::2");
  assertEquals(ownsAddress(identity(), IP, LOGIN), true);
  assertEquals(ownsAddress(identity("other@example.com"), IP, LOGIN), false);
  assertEquals(ownsAddress(identity(), "100.64.0.3", LOGIN), false);
  for (
    const value of [null, {}, { Node: {}, UserProfile: { LoginName: LOGIN } }]
  ) {
    assertEquals(ownsAddress(value, IP, LOGIN), false);
  }
  for (
    const node of [
      { Tags: ["tag:server"] },
      { Tags: "tag:server" },
      { IsTagged: true },
      { MachineAuthorized: false },
      { Addresses: [`${IP}/24`] },
    ]
  ) {
    const value = identity();
    assertEquals(
      ownsAddress({ ...value, Node: { ...value.Node, ...node } }, IP, LOGIN),
      false,
    );
  }
});

Deno.test("Tailscale auth ignores claimed identities and proxy addresses", async () => {
  let calls = 0;
  const auth = new TailscaleAuth(LOGIN, () => {
    calls++;
    return Promise.resolve(identity());
  });
  assertEquals(await auth.signedIn(req()), false);
  assertEquals(await auth.signedIn(req(), "127.0.0.1"), false);
  for (const name of ["forwarded", "x-forwarded-for", "tailscale-user-login"]) {
    assertEquals(
      await auth.signedIn(req("/api/session", { [name]: LOGIN }), IP),
      false,
    );
  }
  assertEquals(calls, 0);
  assertEquals(await auth.signedIn(req(), IP), true);
  assertEquals(calls, 1);
  const disabled = new TailscaleAuth("", () => {
    throw new Error("disabled auth must not query");
  });
  assertEquals(await disabled.signedIn(req(), IP), false);
});

Deno.test("Tailscale auth coalesces lookups, expires decisions and fails closed", async () => {
  let calls = 0, now = 0;
  let answer: unknown = identity();
  const auth = new TailscaleAuth(LOGIN, () => {
    calls++;
    return Promise.resolve(answer);
  }, () => now);
  assertEquals(
    await Promise.all([auth.signedIn(req(), IP), auth.signedIn(req(), IP)]),
    [true, true],
  );
  assertEquals(calls, 1);
  answer = identity("other@example.com");
  now = 14_999;
  assertEquals(await auth.signedIn(req(), IP), true);
  now = 15_000;
  assertEquals(await auth.signedIn(req(), IP), false);
  assertEquals(calls, 2);
  const failed = new TailscaleAuth(
    LOGIN,
    () => Promise.reject(new Error("offline")),
  );
  assertEquals(await failed.signedIn(req(), IP), false);
});

Deno.test("Tailscale lookups have a concurrent request cap", async () => {
  let finish: (value: unknown) => void = () => {};
  const answer = new Promise<unknown>((resolve) => finish = resolve);
  const auth = new TailscaleAuth(LOGIN, () => answer);
  const pending = Array.from(
    { length: 8 },
    (_, i) => auth.signedIn(req(), `100.64.0.${i + 2}`),
  );
  assertEquals(await auth.signedIn(req(), "100.64.0.20"), false);
  finish(null);
  assertEquals(await Promise.all(pending), Array(8).fill(false));
});

Deno.test("web routes accept verified peers, keep key fallback and enforce Host/origin", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-tailnet-" });
  let calls = 0;
  const web = await createWeb({
    addr: ADDR,
    key: "test-key-0123456789abcdef",
    stateDir,
    tailscaleLogin: LOGIN,
    tailscaleLookup: () => {
      calls++;
      return Promise.resolve(identity());
    },
    log: () => {},
  });
  try {
    const session = await web.handle(req(), IP);
    assertEquals(await session.json(), { signedIn: true });
    assertEquals(
      session.headers.has("set-cookie"),
      false,
      "no transferable cookie minted",
    );
    assertEquals(await (await web.handle(req())).json(), { signedIn: false });
    assertEquals(
      (await web.handle(req("/api/file?path=storage.json"), IP)).status,
      404,
    );
    assertEquals(
      (await web.handle(req("/api/file?path=storage.json"), "100.64.0.3"))
        .status,
      401,
    );
    const before = calls;
    assertEquals(
      (await web.handle(req("/api/session", { host: "evil.test" }), IP)).status,
      421,
    );
    assertEquals(
      (await web.handle(
        new Request(`http://${ADDR}/api/upload`, {
          method: "POST",
          headers: { origin: "https://evil.test" },
          body: "x",
        }),
        IP,
      )).status,
      403,
    );
    assertEquals(calls, before, "bad Host/origin rejected before lookup");
    const signin = await web.handle(
      new Request(`http://${ADDR}/api/signin`, {
        method: "POST",
        body: JSON.stringify({ key: web.key }),
      }),
    );
    assertEquals(signin.status, 204);
    const cookie = signin.headers.get("set-cookie")?.split(";")[0] ?? "";
    assertEquals(
      await (await web.handle(req("/api/session", { cookie }))).json(),
      { signedIn: true },
    );
    const disabled = await createWeb({
      addr: ADDR,
      key: web.key,
      stateDir,
      log: () => {},
    });
    try {
      assertEquals(await (await disabled.handle(req(), IP)).json(), {
        signedIn: false,
      });
    } finally {
      disabled.close();
    }
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});
