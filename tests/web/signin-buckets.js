// Reproduce cross-site image requests to a non-loopback HTTP web address.
// Run inside a network namespace with 100.64.0.1 on loopback:
// deno run --frozen -A tests/web/signin-buckets.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "npm:playwright@1.64.1";

const root = fileURLToPath(new URL("../../", import.meta.url));
const daemonDir = `${root}daemon`;
const port = Number(Deno.env.get("ENIL_WEB_TEST_PORT") ?? "18460");
const target = `http://100.64.0.1:${port}`;
const attacker = `http://127.0.0.2:${port + 1}`;
const key = "signin-buckets-test-key-0123456789";
const temp = await Deno.makeTempDir({
  dir: Deno.env.get("ENIL_WEB_TEST_TMPDIR"),
  prefix: "web-signin-buckets-",
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [], contexts = [];
let browser, attackerServer, cleaning;

function start(command, args, env, log) {
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd: daemonDir,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const groupFile = Deno.env.get("ENIL_SIGNIN_GROUP_FILE");
  if (groupFile) {
    Deno.writeTextFileSync(
      groupFile,
      `${child.pid}\n`,
      { append: true },
    );
  }
  const state = { child, ended: false, error: null };
  state.done = new Promise((resolve) => {
    child.once("error", (error) => {
      state.error = error;
      state.ended = true;
      resolve();
    });
    child.once("close", () => {
      state.ended = true;
      resolve();
    });
  });
  children.push(state);
  return state;
}

async function stop(state) {
  if (!state?.child.pid || state.ended) return;
  const signal = (name) => {
    try {
      Deno.kill(-state.child.pid, name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  signal("SIGTERM");
  let timer;
  await Promise.race([
    state.done,
    new Promise((resolve) => timer = setTimeout(resolve, 2000)),
  ]);
  clearTimeout(timer);
  if (!state.ended) signal("SIGKILL");
  await state.done;
}

const cleanup = () =>
  cleaning ??= (async () => {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    await attackerServer?.shutdown().catch(() => {});
    for (const child of children.reverse()) await stop(child);
  })();
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  Deno.addSignalListener(signal, () => {
    void cleanup().finally(() => Deno.exit(code));
  });
}

async function until(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function observe(page, allowed) {
  const errors = [], expected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text(), url = message.location().url;
    if (
      allowed.some((rule) => text === rule.text && url.startsWith(rule.url))
    ) {
      expected.push({ text, url });
    } else errors.push({ text, url });
  });
  return { errors, expected };
}

const resourceError = (code, description, url) => ({
  text:
    `Failed to load resource: the server responded with a status of ${code} (${description})`,
  url,
});

try {
  const env = {
    ...Deno.env.toObject(),
    XDG_STATE_HOME: temp,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const stub = start("python3", ["stub.py"], env, `${temp}/stub.log`);
  await until(async () => {
    if (stub.ended) throw stub.error ?? new Error("stub exited");
    return await Deno.stat(`${temp}/enil/sock`).then(() => true, () => false);
  }, "stub socket");
  const server = start(Deno.execPath(), [
    "run",
    "--frozen",
    "-A",
    "web/server.ts",
  ], {
    ...env,
    ENIL_WEB_ADDR: `100.64.0.1:${port}`,
    ENIL_WEB_KEY: key,
  }, `${temp}/server.log`);
  await until(async () => {
    if (server.ended) throw server.error ?? new Error("web server exited");
    return (await Deno.readTextFile(`${temp}/server.log`)).includes(
      `[web] sign in: ${target}/`,
    );
  }, "web server");

  const images = Array.from(
    { length: 12 },
    (_, i) => `<img src="${target}/?key=wrong-${i}" alt="">`,
  ).join("");
  attackerServer = Deno.serve({
    hostname: "127.0.0.2",
    port: port + 1,
    onListen() {},
  }, (request) =>
    new Response(
      new URL(request.url).pathname === "/post"
        ? `<!doctype html><title>Other site</title><form method="post" ` +
          `action="${target}/api/signin"><input name="key" value="wrong">` +
          `<button type="submit">Submit</button></form>`
        : `<!doctype html><title>Other site</title>${images}`,
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    ));
  browser = await chromium.launch({
    executablePath: Deno.env.get("CHROMIUM") || "/usr/bin/chromium",
    args: ["--no-sandbox", "--no-proxy-server"],
  });
  const attackContext = await browser.newContext({ locale: "en-US" });
  contexts.push(attackContext);
  const attackPage = await attackContext.newPage();
  const attackErrors = observe(attackPage, [
    resourceError(401, "Unauthorized", `${target}/?key=wrong-`),
    resourceError(429, "Too Many Requests", `${target}/?key=wrong-`),
  ]);
  const requests = [], failedRequests = [];
  attackPage.on("request", (request) => {
    if (request.url().startsWith(`${target}/?key=wrong-`)) {
      requests.push(request);
    }
  });
  attackPage.on("requestfailed", (request) => {
    failedRequests.push({ url: request.url(), failure: request.failure() });
  });
  await attackPage.goto(attacker);
  await attackPage.waitForFunction(() =>
    [...document.images].length === 12 &&
    [...document.images].every((image) => image.complete)
  );
  assert.equal(
    requests.length,
    12,
    JSON.stringify({ failedRequests, errors: attackErrors.errors }),
  );
  const sites = await Promise.all(
    requests.map(async (request) =>
      (await request.allHeaders())["sec-fetch-site"] ?? "absent"
    ),
  );
  assert.deepEqual(sites, Array(12).fill("absent"));
  assert.ok(
    failedRequests.every((request) =>
      request.failure?.errorText === "net::ERR_BLOCKED_BY_ORB"
    ),
  );
  assert.deepEqual(attackErrors.errors, []);
  const linkCheck = await fetch(`${target}/?key=${key}`, {
    redirect: "manual",
  });
  assert.equal(
    linkCheck.status,
    429,
    "the cross-site images reached the server",
  );
  await linkCheck.body?.cancel();
  console.log(
    "PASS 12 cross-site HTTP images omit Sec-Fetch-Site and lock links",
  );

  let expectedPostErrors = 0;
  for (let i = 0; i < 12; i++) {
    const postPage = await attackContext.newPage();
    const postErrors = observe(postPage, [
      resourceError(403, "Forbidden", `${target}/api/signin`),
    ]);
    await postPage.goto(`${attacker}/post`);
    const reply = postPage.waitForResponse((response) =>
      response.url() === `${target}/api/signin`
    );
    await postPage.getByRole("button", { name: "Submit" }).click({
      noWaitAfter: true,
    });
    const response = await reply;
    assert.equal(response.status(), 403);
    const headers = await response.request().allHeaders();
    assert.equal(headers.origin, attacker);
    assert.equal(headers["sec-fetch-site"] ?? "absent", "absent");
    await postPage.close();
    assert.deepEqual(postErrors.errors, []);
    expectedPostErrors += postErrors.expected.length;
  }
  console.log(
    "PASS 12 cross-site form posts carry Origin and are refused " +
      `(expected 403 console errors: ${expectedPostErrors})`,
  );

  const victim = await browser.newContext({ locale: "en-US" });
  contexts.push(victim);
  const page = await victim.newPage();
  const pageErrors = observe(page, []);
  await page.goto(target);
  await page.getByLabel("Web key").fill(key);
  const reply = page.waitForResponse((response) =>
    response.url() === `${target}/api/signin`
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const signin = await reply;
  assert.equal(signin.status(), 204, "link lockout must not block the form");
  await page.locator("#connection.connected").waitFor();
  assert.deepEqual(pageErrors.errors, []);
  console.log("PASS manual form signs in after the cross-site link lockout");

  for (
    const [locale, message] of [
      [
        "en-US",
        "Link sign-in is temporarily locked. Enter your web key below.",
      ],
      ["zh-TW", "連結登入暫時被鎖定，請在下方輸入 web key。"],
    ]
  ) {
    const context = await browser.newContext({ locale });
    contexts.push(context);
    const linkPage = await context.newPage();
    const linkErrors = observe(linkPage, [
      resourceError(429, "Too Many Requests", `${target}/?key=`),
    ]);
    const response = await linkPage.goto(`${target}/?key=${key}`);
    assert.equal(response.status(), 429);
    await linkPage.locator("#signin-screen").waitFor({ state: "visible" });
    assert.equal(
      await linkPage.locator("#signin-error").textContent(),
      message,
    );
    assert.equal(await linkPage.locator("#signin-error").isVisible(), true);
    assert.equal(new URL(linkPage.url()).searchParams.has("key"), false);
    await linkPage.getByLabel("Web key").fill(key);
    await linkPage.locator('#signin-form button[type="submit"]').click();
    await linkPage.locator("#connection.connected").waitFor();
    await linkPage.waitForLoadState("networkidle");
    assert.deepEqual(linkErrors.errors, []);
    console.log(
      `PASS blocked link shows the ${locale} form and permits sign-in ` +
        `(expected 429 console errors: ${linkErrors.expected.length})`,
    );
  }
  console.log(
    `Expected HTTP console errors from attack: ${attackErrors.expected.length}`,
  );
  console.log("PASS signin-buckets");
} finally {
  await cleanup();
  await Deno.remove(temp, { recursive: true });
}
