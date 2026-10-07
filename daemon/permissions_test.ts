/**
 * The daemon's permission set has one source, enil-flags.sh, and two
 * consumers: enil-run.sh (the systemd ExecStart) and the `deno task build`
 * compile. This file pins that both read the same file, and lends the set to
 * startup_smoke_test.ts so the daemon boots under it rather than under -A.
 *
 *   deno test -A permissions_test.ts
 */
import { assert, assertEquals } from "@std/assert";

const DAEMON_DIR = new URL("./", import.meta.url).pathname;

/**
 * The flags enil-run.sh would pass for the given XDG_STATE_HOME, read by
 * sourcing the real file: a test that re-typed the list would pass after the
 * list it is meant to pin had changed.
 */
export async function daemonPermissionFlags(
  stateHome: string,
): Promise<string[]> {
  const out = await new Deno.Command("sh", {
    args: [
      "-c",
      '. "$1/enil-flags.sh" && printf "%s" "$ENIL_DENO_FLAGS"',
      "sh",
      DAEMON_DIR,
    ],
    env: { XDG_STATE_HOME: stateHome, HOME: Deno.env.get("HOME") ?? "/" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    new TextDecoder().decode(out.stderr),
    "",
    "enil-flags.sh sources silently",
  );
  const flags = new TextDecoder().decode(out.stdout).split(/\s+/).filter(
    Boolean,
  );
  assert(flags.length > 0, "enil-flags.sh sets ENIL_DENO_FLAGS");
  return flags;
}

Deno.test("the permission set is explicit: no -A, writes confined to the state dir", async () => {
  const flags = await daemonPermissionFlags("/tmp/enil-flags-probe");
  assert(!flags.includes("-A") && !flags.includes("--allow-all"));
  const byName = new Map(
    flags.map((f) => {
      const eq = f.indexOf("=");
      return eq < 0 ? [f, ""] : [f.slice(0, eq), f.slice(eq + 1)];
    }),
  );
  assertEquals(byName.get("--allow-net"), "");
  assertEquals(byName.get("--allow-read"), "");
  assertEquals(byName.get("--allow-write"), "/tmp/enil-flags-probe/enil");
  assertEquals(
    byName.get("--allow-run")?.split(",").sort(),
    [
      "dbus-monitor",
      "ffmpeg",
      "ffmpegthumbnailer",
      "notify-send",
      "omarchy-shell",
      "wl-paste",
    ],
  );
  // Every variable modules/env.ts reads is allowed, and nothing is allowed
  // that neither env.ts nor a dependency reads.
  const env = await Deno.readTextFile(`${DAEMON_DIR}modules/env.ts`);
  const read = new Set(
    [...env.matchAll(/(?:Deno\.env\.get|envInt)\("([A-Z_]+)"/g)].map((m) =>
      m[1]
    ),
  );
  const allowed = new Set(byName.get("--allow-env")?.split(","));
  for (const name of read) {
    assert(allowed.has(name), `${name} is read but not allowed`);
  }
  for (const name of allowed) {
    assert(
      read.has(name) || name === "Q_DEBUG" || name === "NODE_DEBUG",
      `${name} is allowed but nothing reads it`,
    );
  }
  assertEquals(byName.has("--allow-sys"), false);
  assertEquals(byName.has("--allow-ffi"), false);
});

Deno.test("the launcher and the build task both source enil-flags.sh", async () => {
  const run = await Deno.readTextFile(`${DAEMON_DIR}enil-run.sh`);
  assert(run.includes('. "$dir/enil-flags.sh"'));
  assert(run.includes("deno run $ENIL_DENO_FLAGS"));
  assert(!/deno run -A/.test(run));
  const config = JSON.parse(await Deno.readTextFile(`${DAEMON_DIR}deno.json`));
  const build = String(config.tasks.build);
  assert(build.includes(". ./enil-flags.sh"));
  assert(build.includes("deno compile $ENIL_DENO_FLAGS"));
  assert(!build.includes("-A"));
});

Deno.test("the state dir follows XDG_STATE_HOME and falls back to ~/.local/state", async () => {
  const flags = await daemonPermissionFlags("/x/state");
  assert(flags.includes("--allow-write=/x/state/enil"));
  const out = await new Deno.Command("sh", {
    args: [
      "-c",
      '. "$1/enil-flags.sh" && printf "%s" "$ENIL_STATE_DIR"',
      "sh",
      DAEMON_DIR,
    ],
    env: { HOME: "/home/probe" },
    clearEnv: true,
    stdout: "piped",
  }).output();
  assertEquals(
    new TextDecoder().decode(out.stdout),
    "/home/probe/.local/state/enil",
  );
});
