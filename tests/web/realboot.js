// Smoke the real daemon and its web server without a LINE session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "npm:playwright@1.64.1";

const root = fileURLToPath(new URL("../../", import.meta.url));
const daemonDir = join(root, "daemon");
const key = "realboot-web-key-0123456789";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeCleanup;

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  Deno.addSignalListener(signal, () => {
    void (async () => {
      await activeCleanup?.();
      Deno.exit(code);
    })();
  });
}

function start(command, args, cwd, env, log) {
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const state = { child, ended: false, error: null, code: null };
  state.done = new Promise((resolve) => {
    child.once("error", (error) => {
      state.error = error;
      state.ended = true;
      resolve();
    });
    child.once("close", (code) => {
      state.code = code;
      state.ended = true;
      resolve();
    });
  });
  return state;
}

async function stop(state) {
  if (!state?.child.pid) return;
  const signal = (name) => {
    try {
      Deno.kill(-state.child.pid, name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  signal("SIGTERM");
  if (!state.ended) {
    let timer;
    await Promise.race([
      state.done,
      new Promise((resolve) => timer = setTimeout(resolve, 2000)),
    ]);
    clearTimeout(timer);
  }
  signal("SIGKILL");
  await state.done;
}

async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function portForTest() {
  const configured = Deno.env.get("ENIL_WEB_TEST_PORT");
  const port = configured === undefined ? 0 : Number(configured);
  if (
    !Number.isInteger(port) || port < 0 || port > 65535 || configured === ""
  ) {
    throw new Error("ENIL_WEB_TEST_PORT must be a valid port");
  }
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  const selected = listener.addr.port;
  listener.close();
  return selected;
}

async function git(...args) {
  const result = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function copyTree(source, destination) {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    // Build artifacts, Git metadata and local dependencies are not source.
    if ([".git", "enil", "enil.rev", "node_modules"].includes(entry.name)) {
      continue;
    }
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
    else throw new Error(`Unexpected source entry: ${from}`);
  }
}

async function build(temp, env, children) {
  const buildDir = join(temp, "build", "daemon");
  await copyTree(daemonDir, buildDir);
  const head = await git("rev-parse", "HEAD");
  const gitDir = await git("rev-parse", "--absolute-git-dir");
  const log = join(temp, "build.log");
  const started = performance.now();
  const job = start(Deno.execPath(), ["task", "build"], buildDir, {
    ...env,
    GIT_DIR: gitDir,
  }, log);
  children.push(job);
  await job.done;
  if (job.error || job.code !== 0) {
    throw new Error(`Build failed: ${job.error || job.code}; see ${log}`);
  }
  assert.equal(
    (await Deno.readTextFile(join(buildDir, "enil.rev"))).trim(),
    head,
  );
  assert.equal(
    await git("rev-parse", "HEAD"),
    head,
    "checkout moved during build",
  );
  // The binary must serve its embedded assets, not files in the build copy.
  await Deno.remove(join(buildDir, "web", "public"), { recursive: true });
  console.log(`  build: ${((performance.now() - started) / 1000).toFixed(2)}s`);
  return join(buildDir, "enil");
}

async function ensureSourceLauncher() {
  try {
    const [binary, revision, source, head] = await Promise.all([
      Deno.stat(join(daemonDir, "enil")),
      Deno.readTextFile(join(daemonDir, "enil.rev")),
      Deno.stat(join(daemonDir, "daemon.ts")),
      git("rev-parse", "HEAD"),
    ]);
    if (
      revision.trim() === head && binary.isFile && (binary.mode & 0o111) &&
      binary.mtime >= source.mtime
    ) {
      throw new Error("enil-run.sh would select an existing compiled binary");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

// Chromium follows the module graph from index.html, including re-exports.
async function checkAssets(page, base, modules) {
  const roots = await page.locator('script[type="module"][src]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("src")),
  );
  assert.ok(roots.length, "index.html has no module entrypoint");
  for (const path of roots) {
    const url = new URL(path, base);
    const entry = modules.find(([address]) => address === url.href);
    assert.equal(entry?.[1], 200, `${url.pathname} status`);
  }
  for (const [address, status] of modules) {
    const url = new URL(address);
    assert.equal(url.origin, base, `external module: ${url}`);
    assert.match(url.pathname, /^\/js\/[a-z][a-z0-9-]*\.js$/);
    assert.equal(status, 200, `${url.pathname} status`);
  }
}

async function checkSocket(page) {
  const result = await page.evaluate(() =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${location.host}/api/ws`);
      let state, reply;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket state/reply timeout"));
      }, 10000);
      ws.onopen = () =>
        ws.send(JSON.stringify({ id: "realboot", cmd: "sync" }));
      ws.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.web === "state" && frame.state?.login?.status === "idle") {
          state = frame.state;
        }
        if (frame.id === "realboot") reply = frame;
        if (state && reply) {
          clearTimeout(timer);
          ws.close();
          resolve({ state, reply });
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket failed"));
      };
    })
  );
  assert.equal(result.state.login.status, "idle");
  assert.equal(result.reply.ok, false);
  assert.equal(result.reply.error, "尚未登入");
}

async function run(mode) {
  const port = portForTest(), base = `http://127.0.0.1:${port}`;
  const temp = await Deno.makeTempDir({
    dir: Deno.env.get("ENIL_WEB_TEST_TMPDIR"),
    prefix: `web-realboot-${mode}-`,
  });
  const stateRoot = join(temp, "state"), stateDir = join(stateRoot, "enil");
  const children = [], errors = [], modules = [];
  let browser, browserLaunch, failed = true, cleaning;
  const cleanup = () =>
    cleaning ??= (async () => {
      const launched = browser ?? await browserLaunch?.catch(() => null);
      await launched?.close().catch(() => {});
      for (const child of children.reverse()) await stop(child);
    })();
  activeCleanup = cleanup;
  const env = {
    ...Deno.env.toObject(),
    XDG_STATE_HOME: stateRoot,
    ENIL_WEB_ADDR: `127.0.0.1:${port}`,
    ENIL_WEB_KEY: key,
    DENO_NO_PROMPT: "1",
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(temp, "no-system-bus")}`,
  };
  try {
    await assert.rejects(
      Deno.stat(join(stateDir, "storage.json")),
      Deno.errors.NotFound,
      "state must begin without stored credentials",
    );
    if (mode === "source") await ensureSourceLauncher();
    const executable = mode === "source"
      ? join(daemonDir, "enil-run.sh")
      : await build(temp, env, children);
    const cwd = mode === "source" ? daemonDir : join(temp, "build", "daemon");
    const daemonLog = join(temp, "daemon.log");
    const daemon = start(executable, [], cwd, env, daemonLog);
    children.push(daemon);
    await until(async () => {
      if (daemon.ended) {
        throw new Error(`daemon exited: ${daemon.error || daemon.code}`);
      }
      const log = await Deno.readTextFile(daemonLog);
      if (
        /NotCapable|PermissionDenied|Requires .* access|Deno requests/i.test(
          log,
        )
      ) {
        throw new Error(`daemon permission failure: ${log}`);
      }
      return log.includes(`[web] sign in: ${base}/`);
    }, "real daemon web server");
    browserLaunch = chromium.launch({
      executablePath: Deno.env.get("CHROMIUM") || undefined,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    browser = await browserLaunch;
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.request().resourceType() === "script") {
        modules.push([response.url(), response.status()]);
      }
    });
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === base) {
        return route.continue();
      }
      return route.abort();
    });
    const response = await page.goto(base, { waitUntil: "load" });
    assert.equal(response?.status(), 200, "/ status");
    await checkAssets(page, base, modules);
    await page.getByLabel("Web key").fill(key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("#connection.connected").waitFor();
    await page.locator("#line-login").waitFor();
    await page.getByRole("button", { name: "Sign in to LINE" }).waitFor();
    assert.match(
      await page.locator("#line-login-message").textContent(),
      /Sign in to see/,
    );
    assert.deepEqual(
      await page.evaluate(async () =>
        await (await fetch("/api/session")).json()
      ),
      { signedIn: true },
    );
    await checkSocket(page);
    const upload = await page.evaluate(async () => {
      const response = await fetch("/api/upload?name=realboot.txt", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: "real daemon upload\n",
      });
      return { status: response.status, data: await response.json() };
    });
    assert.equal(upload.status, 200);
    const uploadRoot = await Deno.realPath(
      join(stateDir, "media", "web-uploads"),
    );
    const uploaded = await Deno.realPath(upload.data.path);
    assert.ok(
      uploaded.startsWith(`${uploadRoot}/`),
      "upload outside state directory",
    );
    assert.equal(await Deno.readTextFile(uploaded), "real daemon upload\n");
    await checkAssets(page, base, modules);
    const moduleCount = new Set(modules.map(([url]) => url)).size;
    console.log(`  module graph: ${moduleCount} files returned 200`);
    await context.close();
    await cleanup();
    assert.deepEqual(errors, [], "browser console and page errors");
    const log = await Deno.readTextFile(daemonLog);
    assert.doesNotMatch(
      log,
      /NotCapable|PermissionDenied|Requires .* access|Deno requests/i,
    );
    console.log(
      `PASS realboot ${mode}: idle, assets, session, socket and upload`,
    );
    failed = false;
  } catch (error) {
    console.error(`FAIL realboot ${mode}: ${error.stack ?? error}`);
    console.error(`Artifacts: ${temp}`);
    throw error;
  } finally {
    await cleanup();
    activeCleanup = undefined;
    if (!failed) await Deno.remove(temp, { recursive: true });
  }
}

if (Deno.args.some((arg) => arg !== "--source-only")) {
  throw new Error("Usage: deno run -A tests/web/realboot.js [--source-only]");
}
await run("source");
if (!Deno.args.includes("--source-only")) await run("compiled");
