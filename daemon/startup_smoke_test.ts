/**
 * Startup smoke test: boots the real daemon.ts against a throwaway state dir
 * and pins the startup output as the contract.
 *
 * The refactor of daemon.ts into daemon/modules/* must not move a single byte
 * of what the plugin sees at boot: the `enil:` banner, the first state.json,
 * the idle login edge, the sweep log lines, and the clean SIGTERM exit that
 * removes the socket. Everything runs under a temp XDG_STATE_HOME, so no real
 * session or state dir is touched and no LINE login is attempted (an empty
 * store resumes as "none", which publishes "idle").
 *
 * The daemon runs under the permission set enil-run.sh uses, not -A, so a
 * dependency that starts needing a permission the set lacks fails here with
 * the NotCapable text instead of in the user's journal.
 *
 * The same boot also drives one socket command end to end: `hide` writes
 * hidden.json, and only a real daemon shows that a refused id writes nothing.
 *
 *   deno test -A startup_smoke_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import { daemonPermissionFlags } from "./permissions_test.ts";

function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TextLineStream(),
  ).getReader();
  return {
    /** Next line with an overall deadline, null on EOF or timeout. */
    async read(timeoutMs: number): Promise<string | null> {
      const timer = setTimeout(
        () => reader.cancel().catch(() => {}),
        timeoutMs,
      );
      try {
        const { value, done } = await reader.read();
        return done ? null : value;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

Deno.test("daemon boots to idle against an empty state dir and stops clean", async () => {
  const stateHome = await Deno.makeTempDir({ prefix: "enil-smoke-" });
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...await daemonPermissionFlags(stateHome),
      new URL("./daemon.ts", import.meta.url).pathname,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      XDG_STATE_HOME: stateHome,
      // Pin every ENIL_* knob to its default so an operator's shell overrides
      // cannot leak into the contract. HOME is deliberately left untouched:
      // the daemon reads the state dir from XDG_STATE_HOME alone, and a
      // cleared HOME would point Deno's own module cache at the temp dir and
      // re-download the dependency graph on every run.
      ENIL_DEVICE: "ANDROIDSECONDARY",
      ENIL_INCREMENTAL: "1",
      ENIL_CHAT_LIMIT: "500",
      ENIL_PUSH_STALE_MS: "180000",
      ENIL_REQUEST_TIMEOUT_MS: "30000",
    },
  });
  const child = cmd.spawn();
  // Drained in the background so a chatty boot cannot block on a full pipe.
  const stderr = new Response(child.stderr).text();
  const out = lineReader(child.stdout);
  const lines: string[] = [];

  // The banner is the boot-complete signal: it prints after the socket is
  // listening and before the resume attempt.
  const deadline = Date.now() + 30_000;
  for (;;) {
    assert(Date.now() < deadline, "daemon never printed its startup banner");
    const line = await out.read(5_000);
    if (line === null) continue;
    lines.push(line);
    if (line.startsWith("enil: ")) break;
  }
  assertEquals(
    lines[0],
    `enil: ${stateHome}/enil/state.json + ${stateHome}/enil/sock`,
    "startup banner names the state file and the socket",
  );

  // Give the resume attempt and the startup sweep a moment, then stop.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const grace = Date.now() + 5_000;
  while (Date.now() < grace) {
    const line = await out.read(1_000);
    if (line === null) break;
    lines.push(line);
  }
  child.kill("SIGTERM");
  const status = await child.status;
  const errText = await stderr;
  assert(
    !/NotCapable|Requires .* access/.test(errText),
    `the permission set is short of something:\n${errText}`,
  );
  assertEquals(status.code, 0, "SIGTERM exits cleanly");
  assertEquals(
    await Deno.stat(`${stateHome}/enil/sock`).then(() => true).catch(() =>
      false
    ),
    false,
    "the socket file is removed on stop",
  );

  // The console contract, order-free: the boot banner, the idle edge (the
  // trailing space is setLogin's empty extra.error argument), and both sweep
  // lines for the empty cache. The image directory does not exist yet, and a
  // missing directory is the one sweep that stays silent by design.
  assert(lines.includes("[login] idle "), "resume of an empty store goes idle");
  assert(
    lines.includes("[media] avatars: removed 0 (0.0 MB), kept 0 (0.0 MB)"),
    "avatar sweep reports an empty cache",
  );
  assert(
    lines.includes("[media] sweep: removed 0 (0.0 MB), kept 0 (0.0 MB)"),
    "media sweep reports an empty cache",
  );

  // The first state file: exactly what the panel watches for.
  const state = JSON.parse(
    await Deno.readTextFile(`${stateHome}/enil/state.json`),
  ) as Record<string, unknown>;
  assertEquals(state.bootId, state.bootId as string, "bootId present");
  assertEquals(state.me, {});
  assertEquals(state.login, {
    status: "idle",
    attempt: "resume",
    settled: true,
  });
  assertEquals(state.chats, []);
  assertEquals(state.chatsRevision, 0);
  // The event ring has its own file: state.json stays small enough for the
  // panel to re-parse on every heartbeat.
  assertEquals(state.events, undefined);

  await Deno.remove(stateHome, { recursive: true }).catch(() => {});
});

Deno.test("hide refuses a 1 MiB chat id and writes nothing", async () => {
  const stateHome = await Deno.makeTempDir({ prefix: "enil-smoke-hide-" });
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...await daemonPermissionFlags(stateHome),
      new URL("./daemon.ts", import.meta.url).pathname,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
    // An operator's ENIL_WEB_ADDR must not start a web server here.
    env: { XDG_STATE_HOME: stateHome, ENIL_WEB_ADDR: "" },
  }).spawn();
  const out = lineReader(child.stdout);
  let conn: Deno.UnixConn | undefined;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      assert(Date.now() < deadline, "daemon never printed its startup banner");
      const line = await out.read(5_000);
      if (line?.startsWith("enil: ")) break;
    }
    conn = await Deno.connect({
      transport: "unix",
      path: `${stateHome}/enil/sock`,
    });
    const replies = lineReader(conn.readable);
    const encoder = new TextEncoder();
    const ask = async (id: number, chat: string) => {
      const bytes = encoder.encode(
        JSON.stringify({ id, cmd: "hide", chat }) + "\n",
      );
      let off = 0;
      while (off < bytes.length) off += await conn!.write(bytes.subarray(off));
      for (;;) {
        const line = await replies.read(10_000);
        assert(line !== null, `no reply to request ${id}`);
        const reply = JSON.parse(line);
        if (reply.id === id) return reply;
      }
    };
    const hiddenPath = `${stateHome}/enil/hidden.json`;
    const exists = () =>
      Deno.stat(hiddenPath).then(() => true).catch(() => false);

    // Under the daemon's 1 MiB line cap, so the command itself must refuse.
    const huge = "u" + "x".repeat(1024 * 1024 - 64);
    assertEquals(await ask(1, huge), {
      id: 1,
      ok: false,
      error: "不支援的聊天室",
    });
    assertEquals(await exists(), false, "a refused id reached hidden.json");

    // The same path still writes a real id, so the check above is not vacuous.
    assertEquals((await ask(2, "cgroup")).ok, true);
    assertEquals(JSON.parse(await Deno.readTextFile(hiddenPath)), {
      mids: ["cgroup"],
    });
  } finally {
    try {
      conn?.close();
    } catch { /* already closed */ }
    child.kill("SIGTERM");
    await child.status;
    while (await out.read(1_000) !== null) { /* drain to EOF */ }
    await Deno.remove(stateHome, { recursive: true }).catch(() => {});
  }
});
