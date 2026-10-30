/**
 * The run and build permission flags must keep the state path in one argument,
 * including when a home or XDG state directory contains shell metacharacters.
 */
import { assert, assertEquals } from "@std/assert";

const daemonDir = new URL("../", import.meta.url);

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "enil-flags-" });
  const bin = `${root}/bin`;
  const daemon = `${root}/checkout/daemon`;
  await Deno.mkdir(bin, { recursive: true });
  await Deno.mkdir(daemon, { recursive: true });
  for (const name of ["enil-run.sh", "enil-flags.sh"]) {
    await Deno.copyFile(new URL(name, daemonDir), `${daemon}/${name}`);
  }
  await Deno.writeTextFile(`${daemon}/daemon.ts`, "");
  await Deno.writeTextFile(
    `${bin}/git`,
    `#!/bin/sh
case "$*" in
  *"rev-parse --git-dir"*) echo .git ;;
  *"submodule status"*) echo ' 1234567 daemon/vendor/linejs' ;;
  *"rev-parse HEAD"*) echo 1234567 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  await Deno.writeTextFile(
    `${bin}/deno`,
    "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n",
    { mode: 0o755 },
  );
  return { root, bin, daemon };
}

Deno.test("run and build keep a state path with spaces in one argument", async () => {
  const f = await fixture();
  try {
    const stateHome = `${f.root}/state [*]`;
    const env = {
      HOME: `${f.root}/home`,
      PATH: `${f.bin}:/usr/bin:/bin`,
      XDG_STATE_HOME: stateHome,
    };
    for (
      const args of [
        [`${f.daemon}/enil-run.sh`],
        [
          "-c",
          '. "$1/enil-flags.sh" && deno compile $ENIL_DENO_FLAGS',
          "sh",
          f.daemon,
        ],
      ]
    ) {
      const out = await new Deno.Command("/bin/sh", {
        args,
        clearEnv: true,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, stderr);
      const flags = new TextDecoder().decode(out.stdout).trim().split("\n");
      assert(
        flags.includes(`<--allow-write=${stateHome}/enil>`),
        flags.join("\n"),
      );
      assertEquals(
        flags.filter((arg) => arg.startsWith("<--allow-write")).length,
        1,
      );
      assert(!flags.some((arg) => arg === "<--allow-write>"));
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("Deno grants writes only inside the state path with spaces", async () => {
  const f = await fixture();
  try {
    const stateHome = `${f.root}/state [*]`;
    const stateDir = `${stateHome}/enil`;
    const probe = `${f.root}/probe.ts`;
    await Deno.writeTextFile(
      probe,
      `await Deno.mkdir(${JSON.stringify(stateDir)}, { recursive: true });
await Deno.writeTextFile(${JSON.stringify(`${stateDir}/test`)}, "ok");
try {
  await Deno.writeTextFile(${JSON.stringify(`${f.root}/outside`)}, "no");
  throw new Error("outside write was allowed");
} catch (e) {
  if (!(e instanceof Deno.errors.NotCapable)) throw e;
}
`,
    );
    const out = await new Deno.Command("/bin/sh", {
      args: [
        "-c",
        '. "$1/enil-flags.sh" && "$2" run --frozen --no-prompt $ENIL_DENO_FLAGS "$3"',
        "sh",
        f.daemon,
        Deno.execPath(),
        probe,
      ],
      clearEnv: true,
      env: {
        HOME: `${f.root}/home`,
        PATH: `${f.bin}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateHome,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    assertEquals(await Deno.readTextFile(`${stateDir}/test`), "ok");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("state paths cannot split shell flags or Deno's permission list", async () => {
  const f = await fixture();
  try {
    for (
      const [suffix, reason] of [
        ["\n--allow-write", "newline"],
        [",/", "comma"],
      ]
    ) {
      const out = await new Deno.Command("/bin/sh", {
        args: [`${f.daemon}/enil-run.sh`],
        clearEnv: true,
        env: {
          HOME: `${f.root}/home`,
          PATH: `${f.bin}:/usr/bin:/bin`,
          XDG_STATE_HOME: `${f.root}/state${suffix}`,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.code !== 0);
      assertEquals(new TextDecoder().decode(out.stdout), "");
      assert(new TextDecoder().decode(out.stderr).includes(reason));
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
