/**
 * install.sh in a temp HOME with a fake git, deno and systemctl on an
 * isolated PATH. Every call the fakes receive is logged, so the contract is
 * the call list: a rerun is a no-op beyond the restart, the state dir is
 * never created, and a Deno 1 stops the install.
 *
 *   deno test -A installsh_test.ts
 */
import { assert, assertEquals } from "@std/assert";

const DAEMON_DIR = new URL("./", import.meta.url).pathname;

async function fixture(opts: { denoVersion?: string; git?: boolean } = {}) {
  const root = await Deno.makeTempDir({ prefix: "enil-install-" });
  const plugin = `${root}/plugin`;
  const bin = `${root}/bin`;
  const home = `${root}/home`;
  const log = `${root}/calls.log`;
  await Deno.mkdir(`${plugin}/daemon`, { recursive: true });
  await Deno.mkdir(bin);
  await Deno.mkdir(home);
  for (
    const tool of [
      "sh",
      "cat",
      "dirname",
      "sed",
      "head",
      "cut",
      "cmp",
      "cp",
      "mkdir",
      "printf",
    ]
  ) {
    for (const from of [`/usr/bin/${tool}`, `/bin/${tool}`]) {
      try {
        await Deno.symlink(from, `${bin}/${tool}`);
        break;
      } catch { /* try the other prefix */ }
    }
  }
  for (const f of ["install.sh", "enil.service"]) {
    await Deno.copyFile(`${DAEMON_DIR}${f}`, `${plugin}/daemon/${f}`);
  }
  const logging = (name: string, body: string) =>
    Deno.writeTextFile(
      `${bin}/${name}`,
      `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}`,
      { mode: 0o755 },
    );
  await logging(
    "git",
    opts.git === false ? "exit 128" : `case "$*" in
  *"rev-parse --git-dir"*) echo .git ;;
  *"submodule status"*) echo " 4d6aa18f9d125cae7deb8a1358553f545e607441 daemon/vendor/linejs (v3.3.2)" ;;
esac
exit 0`,
  );
  await logging(
    "deno",
    `echo "deno ${
      opts.denoVersion ?? "2.9.7"
    } (stable, release, x86_64-unknown-linux-gnu)"\necho "v8 14.0"\necho "typescript 5.9"`,
  );
  await logging("systemctl", "exit 0");
  return {
    plugin,
    home,
    async run() {
      await Deno.writeTextFile(log, "");
      const out = await new Deno.Command("sh", {
        args: [`${plugin}/daemon/install.sh`],
        env: { PATH: bin, HOME: home },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: out.code,
        out: new TextDecoder().decode(out.stdout),
        err: new TextDecoder().decode(out.stderr),
        calls: (await Deno.readTextFile(log)).trim().split("\n").filter(
          Boolean,
        ),
      };
    },
  };
}

Deno.test("first run installs the unit, reloads, enables and restarts; a rerun only restarts", async () => {
  const f = await fixture();
  const first = await f.run();
  assertEquals(first.code, 0, first.err);
  assertEquals(first.calls, [
    `git -C ${f.plugin} rev-parse --git-dir`,
    `git -C ${f.plugin} submodule sync --quiet --recursive`,
    `git -C ${f.plugin} submodule update --init --recursive --quiet`,
    `git -C ${f.plugin} submodule status -- daemon/vendor/linejs`,
    "deno --version",
    "systemctl --user daemon-reload",
    "systemctl --user enable --quiet enil.service",
    "systemctl --user restart enil.service",
  ]);
  const unit = `${f.home}/.config/systemd/user/enil.service`;
  assertEquals(
    await Deno.readTextFile(unit),
    await Deno.readTextFile(`${DAEMON_DIR}enil.service`),
  );
  assert(first.out.includes("unit installed"), first.out);
  assert(first.out.includes("deno 2.9.7"), first.out);

  const second = await f.run();
  assertEquals(second.code, 0, second.err);
  // Same git and deno checks (they are what converge), no daemon-reload
  // because the unit did not change, enable is idempotent, restart is the
  // one effect a refresh is for.
  assertEquals(
    second.calls.filter((c) => c.startsWith("systemctl")),
    [
      "systemctl --user enable --quiet enil.service",
      "systemctl --user restart enil.service",
    ],
  );
  assert(second.out.includes("unit unchanged"), second.out);

  // The state dir is the daemon's: neither run may create it.
  for (const dir of [`${f.home}/.local/state`, `${f.home}/.local`]) {
    assertEquals(
      await Deno.stat(dir).then(() => true).catch(() => false),
      false,
      `${dir} must not exist`,
    );
  }
});

Deno.test("an edited unit file is replaced and reloaded on the next run", async () => {
  const f = await fixture();
  await f.run();
  const unit = `${f.home}/.config/systemd/user/enil.service`;
  await Deno.writeTextFile(unit, "[Unit]\nDescription=stale\n");
  const r = await f.run();
  assertEquals(r.code, 0, r.err);
  assert(r.calls.includes("systemctl --user daemon-reload"));
  assertEquals(
    await Deno.readTextFile(unit),
    await Deno.readTextFile(`${DAEMON_DIR}enil.service`),
  );
});

Deno.test("a Deno 1 stops the install before anything is written", async () => {
  const f = await fixture({ denoVersion: "1.46.3" });
  const r = await f.run();
  assertEquals(r.code, 1);
  assert(r.err.includes("needs Deno 2"), r.err);
  assertEquals(r.calls.filter((c) => c.startsWith("systemctl")), []);
  assertEquals(
    await Deno.stat(`${f.home}/.config`).then(() => true).catch(() => false),
    false,
  );
});

Deno.test("outside a git checkout an empty vendor dir is a clear refusal", async () => {
  const f = await fixture({ git: false });
  const r = await f.run();
  assertEquals(r.code, 1);
  assert(r.err.includes("recurse-submodules"), r.err);
  assertEquals(r.calls.filter((c) => c.startsWith("systemctl")), []);
});
