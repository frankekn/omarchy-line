/**
 * enil-run.sh, the systemd ExecStart, driven in a throwaway plugin dir with a
 * fake git and a fake deno on PATH: the submodule gate, the deno lookup order
 * and the final exec are the contract, and none of them need a real checkout.
 *
 *   deno test -A enilrun_test.ts
 */
import { assert, assertEquals } from "@std/assert";

const DAEMON_DIR = new URL("./", import.meta.url).pathname;

interface Result {
  code: number;
  out: string;
  err: string;
}

interface Fixture extends AsyncDisposable {
  plugin: string;
  bin: string;
  home: string;
  run(env?: Record<string, string>): Promise<Result>;
  build(env?: Record<string, string>): Promise<Result>;
}

/**
 * The fake compiler writes a shell executable, so build and launcher tests
 * share the real stamp protocol without compiling or downloading anything.
 */
async function fixture(opts: {
  status: string;
  gitRepo?: boolean;
  denoOnPath?: boolean;
  denoInHome?: boolean;
  vendorFile?: boolean;
}): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "enil-run-" });
  const plugin = `${root}/plugin with 'quotes'`;
  const bin = `${root}/bin`;
  const home = `${root}/home`;
  await Deno.mkdir(`${plugin}/daemon`, { recursive: true });
  await Deno.mkdir(bin);
  // PATH is this dir alone, so the machine's own deno can never be found;
  // the tools the script shells out to are linked in by name.
  for (
    const tool of [
      "sh",
      "cat",
      "dirname",
      "pwd",
      "printf",
      "echo",
      "find",
      "sort",
      "xargs",
      "sha256sum",
      "mktemp",
      "rm",
      "mv",
      "chmod",
    ]
  ) {
    for (const from of [`/usr/bin/${tool}`, `/bin/${tool}`]) {
      try {
        await Deno.symlink(from, `${bin}/${tool}`);
        break;
      } catch { /* try the other prefix */ }
    }
  }
  await Deno.mkdir(`${home}/.deno/bin`, { recursive: true });
  for (
    const f of [
      "enil-run.sh",
      "enil-flags.sh",
      "enil-fingerprint.sh",
      "enil-build.sh",
      "deno.json",
      "deno.lock",
    ]
  ) {
    await Deno.copyFile(`${DAEMON_DIR}${f}`, `${plugin}/daemon/${f}`);
  }
  await Deno.writeTextFile(`${plugin}/daemon/daemon.ts`, "");
  await Deno.mkdir(`${plugin}/daemon/modules`);
  await Deno.writeTextFile(`${plugin}/daemon/modules/login.ts`, "old login");
  if (opts.vendorFile) {
    const dir = `${plugin}/daemon/vendor/linejs/packages/linejs/client`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/mod.ts`, "");
  }
  const git = opts.gitRepo === false ? "#!/bin/sh\nexit 128\n" : `#!/bin/sh
case "$*" in
  *"rev-parse --git-dir"*) echo .git ;;
  *"submodule status"*) printf '%s\\n' '${opts.status}' ;;
  *"rev-parse HEAD"*) echo deadbeef ;;
  *) exit 1 ;;
esac
`;
  await Deno.writeTextFile(`${bin}/git`, git, { mode: 0o755 });
  const deno = `#!/bin/sh
set -eu
echo "fake-deno $*"
if [ "$1" = compile ]; then
  output=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then shift; output=$1; fi
    shift
  done
  if [ "\${COMPILE_NO_OUTPUT:-}" != 1 ]; then
    printf '#!/bin/sh\\necho fake-compiled\\n' > "$output"
    chmod +x "$output"
  fi
  if [ -n "\${COMPILE_HOOK:-}" ]; then sh "$COMPILE_HOOK"; fi
  exit "\${COMPILE_EXIT_CODE:-0}"
fi
`;
  if (opts.denoOnPath) {
    await Deno.writeTextFile(`${bin}/deno`, deno, { mode: 0o755 });
  }
  if (opts.denoInHome) {
    await Deno.writeTextFile(`${home}/.deno/bin/deno`, deno, { mode: 0o755 });
  }
  async function command(args: string[], env: Record<string, string> = {}) {
    const out = await new Deno.Command("sh", {
      args,
      cwd: `${plugin}/daemon`,
      env: { PATH: bin, HOME: home, TMPDIR: home, ...env },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      out: new TextDecoder().decode(out.stdout),
      err: new TextDecoder().decode(out.stderr),
    };
  }
  return {
    plugin,
    bin,
    home,
    run: (env) => command([`${plugin}/daemon/enil-run.sh`], env),
    async build(env) {
      const config = JSON.parse(
        await Deno.readTextFile(`${plugin}/daemon/deno.json`),
      );
      return await command(["-c", String(config.tasks.build)], env);
    },
    async [Symbol.asyncDispose]() {
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("a never-checked-out submodule stops the start and prints the two fixes", async () => {
  await using f = await fixture({
    status: "-4d6aa18f daemon/vendor/linejs",
    denoOnPath: true,
  });
  const r = await f.run();
  assertEquals(r.code, 78);
  assertEquals(r.out, "", "deno never ran");
  assert(r.err.includes("missing or out of date"), r.err);
  assert(
    r.err.includes(`git -C '${f.plugin}' submodule sync --recursive`),
    r.err,
  );
  assert(
    r.err.includes(`git -C '${f.plugin}' submodule update --init --recursive`),
    r.err,
  );
});

Deno.test("a submodule at the wrong commit is the same refusal", async () => {
  await using f = await fixture({
    status: "+0123abcd daemon/vendor/linejs (heads/main)",
    denoOnPath: true,
  });
  const r = await f.run();
  assertEquals(r.code, 78);
  assert(r.err.includes("submodule update --init --recursive"), r.err);
});

Deno.test("a clean submodule runs deno from PATH with the shared flag set", async () => {
  await using f = await fixture({
    status: " 4d6aa18f daemon/vendor/linejs (v3.3.2)",
    denoOnPath: true,
  });
  const r = await f.run({ XDG_STATE_HOME: "/x/state" });
  assertEquals(r.code, 0, r.err);
  assert(r.out.startsWith("fake-deno run --allow-net"), r.out);
  assert(r.out.includes("--allow-write=/x/state/enil"), r.out);
  assert(r.out.trimEnd().endsWith(`${f.plugin}/daemon/daemon.ts`), r.out);
  assert(!r.out.includes(" -A"), r.out);
});

Deno.test("without deno on PATH the installer's ~/.deno/bin/deno is used", async () => {
  await using f = await fixture({
    status: " 4d6aa18f daemon/vendor/linejs",
    denoInHome: true,
  });
  const r = await f.run();
  assertEquals(r.code, 0, r.err);
  assert(r.out.startsWith("fake-deno run"), r.out);
});

Deno.test("no deno anywhere exits non-zero with advice, after the submodule gate", async () => {
  await using f = await fixture({ status: " 4d6aa18f daemon/vendor/linejs" });
  const r = await f.run();
  assertEquals(r.code, 127);
  assert(r.err.includes("deno not found"), r.err);
  assert(r.err.includes("install.sh"), r.err);
  // The submodule refusal still comes first: it is the one a reinstall of
  // deno cannot fix.
  await using g = await fixture({ status: "-4d6aa18f daemon/vendor/linejs" });
  assertEquals((await g.run()).code, 78);
});

Deno.test("editing only modules/login.ts must not run an old compiled daemon", async () => {
  await using f = await fixture({
    status: " 4d6aa18f daemon/vendor/linejs",
    denoOnPath: true,
  });
  const build = await f.build();
  assertEquals(build.code, 0, build.err);
  assertEquals((await f.run()).out.trim(), "fake-compiled");
  const path = `${f.plugin}/daemon/modules/login.ts`;
  const stat = await Deno.stat(path);
  await Deno.writeTextFile(path, "new login");
  assert(stat.atime && stat.mtime);
  await Deno.utime(path, stat.atime, stat.mtime);
  const r = await f.run();
  assertEquals(r.code, 0, r.err);
  assert(r.out.startsWith("fake-deno run"), r.out);
});

Deno.test("outside a git checkout the vendored file itself is the gate", async () => {
  await using empty = await fixture({
    status: "",
    gitRepo: false,
    denoOnPath: true,
  });
  const r = await empty.run();
  assertEquals(r.code, 78);
  assert(r.err.includes("not a git checkout"), r.err);
  await using copied = await fixture({
    status: "",
    gitRepo: false,
    denoOnPath: true,
    vendorFile: true,
  });
  assertEquals((await copied.run()).code, 0);
});

Deno.test("unchanged sources run the compiled daemon without deno or git HEAD", async () => {
  await using f = await fixture({
    status: "",
    gitRepo: false,
    vendorFile: true,
    denoOnPath: true,
  });
  const build = await f.build({ XDG_STATE_HOME: "/x/state" });
  assertEquals(build.code, 0, build.err);
  assert(build.out.includes("--allow-write=/x/state/enil"), build.out);
  await Deno.remove(`${f.bin}/deno`);
  await Deno.utime(`${f.plugin}/daemon/daemon.ts`, new Date(), new Date());
  for (let i = 0; i < 2; i++) {
    const r = await f.run();
    assertEquals(r.code, 0, r.err);
    assertEquals(r.out.trim(), "fake-compiled");
  }
});

for (
  const path of [
    "daemon.ts",
    "runtime.ts",
    "deno.json",
    "deno.lock",
    "enil-flags.sh",
    "vendor/linejs/packages/linejs/client/mod.ts",
    "vendor/linejs/deno.json",
    "vendor/linejs/packages/linejs/package.json",
  ]
) {
  Deno.test(`changing ${path} invalidates the compiled daemon`, async () => {
    await using f = await fixture({
      status: " 4d6aa18f daemon/vendor/linejs",
      denoOnPath: true,
      vendorFile: true,
    });
    const target = `${f.plugin}/daemon/${path}`;
    if (!(await exists(target))) await Deno.writeTextFile(target, "{}");
    const build = await f.build();
    assertEquals(build.code, 0, build.err);
    assertEquals((await f.run()).out.trim(), "fake-compiled");
    await Deno.writeTextFile(target, "\n", { append: true });
    const r = await f.run();
    assertEquals(r.code, 0, r.err);
    assert(r.out.startsWith("fake-deno run"), r.out);
  });
}

for (const change of ["add", "delete", "rename"] as const) {
  Deno.test(`${change} a runtime file invalidates the compiled daemon`, async () => {
    await using f = await fixture({
      status: " 4d6aa18f daemon/vendor/linejs",
      denoOnPath: true,
    });
    const path = `${f.plugin}/daemon/modules/extra module\nfile.ts`;
    if (change !== "add") await Deno.writeTextFile(path, "export {};");
    const build = await f.build();
    assertEquals(build.code, 0, build.err);
    assertEquals((await f.run()).out.trim(), "fake-compiled");
    if (change === "add") await Deno.writeTextFile(path, "export {};");
    else if (change === "delete") await Deno.remove(path);
    else await Deno.rename(path, `${path}.ts`);
    const r = await f.run();
    assertEquals(r.code, 0, r.err);
    assert(r.out.startsWith("fake-deno run"), r.out);
  });
}

for (const stamp of ["missing", "legacy", "mismatch"] as const) {
  Deno.test(`${stamp} stamp falls back to source`, async () => {
    await using f = await fixture({
      status: " 4d6aa18f daemon/vendor/linejs",
      denoOnPath: true,
    });
    const build = await f.build();
    assertEquals(build.code, 0, build.err);
    const path = `${f.plugin}/daemon/enil.rev`;
    if (stamp === "missing") await Deno.remove(path);
    else {
      await Deno.writeTextFile(
        path,
        stamp === "legacy" ? "deadbeef\n" : "enil-source-v1:wrong\n",
      );
    }
    const r = await f.run();
    assertEquals(r.code, 0, r.err);
    assert(r.out.startsWith("fake-deno run"), r.out);
  });
}

Deno.test("replacing only the binary invalidates its stamp", async () => {
  await using f = await fixture({
    status: " 4d6aa18f daemon/vendor/linejs",
    denoOnPath: true,
  });
  assertEquals((await f.build()).code, 0);
  await Deno.writeTextFile(
    `${f.plugin}/daemon/enil`,
    "#!/bin/sh\necho replaced-binary\n",
  );
  const r = await f.run();
  assertEquals(r.code, 0, r.err);
  assert(r.out.startsWith("fake-deno run"), r.out);
});

Deno.test("generated artifacts and caches do not invalidate the binary", async () => {
  await using f = await fixture({
    status: " 4d6aa18f daemon/vendor/linejs",
    denoOnPath: true,
  });
  assertEquals((await f.build()).code, 0);
  for (
    const name of [
      ".git",
      "node_modules",
      "cache",
      ".cache",
      ".deno",
      ".enil-build.fixture",
      ".enil-fingerprint.fixture",
    ]
  ) {
    const dir = `${f.plugin}/daemon/${name}`;
    await Deno.mkdir(dir);
    await Deno.writeTextFile(`${dir}/output.ts`, "generated");
  }
  const r = await f.run();
  assertEquals(r.code, 0, r.err);
  assertEquals(r.out.trim(), "fake-compiled");
});

for (const tool of ["find", "sort", "xargs", "sha256sum", "mktemp"]) {
  Deno.test(`${tool} fingerprint failure never runs a stale binary`, async () => {
    await using f = await fixture({
      status: " 4d6aa18f daemon/vendor/linejs",
      denoOnPath: true,
    });
    assertEquals((await f.build()).code, 0);
    await Deno.remove(`${f.bin}/${tool}`);
    await Deno.writeTextFile(`${f.bin}/${tool}`, "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const r = await f.run();
    assertEquals(r.code, 0, r.err);
    assert(r.out.startsWith("fake-deno run"), r.out);
  });
}

Deno.test("symlinked runtime sources fail closed without reading their targets", async () => {
  await using f = await fixture({
    status: " 4d6aa18f daemon/vendor/linejs",
    denoOnPath: true,
  });
  assertEquals((await f.build()).code, 0);
  await Deno.symlink(
    `${f.home}/nonexistent.ts`,
    `${f.plugin}/daemon/modules/external.ts`,
  );
  const r = await f.run();
  assertEquals(r.code, 0, r.err);
  assert(r.out.startsWith("fake-deno run"), r.out);
});

for (
  const failure of [
    "compile",
    "no-output",
    "source-change",
    "fingerprint-before",
    "fingerprint-after",
  ] as const
) {
  Deno.test(`${failure} build failure revokes an existing stamp`, async () => {
    await using f = await fixture({
      status: " 4d6aa18f daemon/vendor/linejs",
      denoOnPath: true,
    });
    assertEquals((await f.build()).code, 0);
    assertEquals((await f.run()).out.trim(), "fake-compiled");
    const env: Record<string, string> = {};
    if (failure === "compile") env.COMPILE_EXIT_CODE = "1";
    if (failure === "no-output") env.COMPILE_NO_OUTPUT = "1";
    if (failure === "source-change" || failure === "fingerprint-after") {
      const hook = `${f.bin}/hook`;
      const script = failure === "source-change"
        ? "printf changed > modules/login.ts\n"
        : 'rm -- "$PATH/sha256sum"\nprintf "#!/bin/sh\\nexit 1\\n" > "$PATH/sha256sum"\nchmod +x "$PATH/sha256sum"\n';
      await Deno.writeTextFile(hook, script);
      env.COMPILE_HOOK = hook;
    }
    if (failure === "fingerprint-before") {
      await Deno.remove(`${f.bin}/sha256sum`);
      await Deno.writeTextFile(`${f.bin}/sha256sum`, "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
    }
    const build = await f.build(env);
    assert(build.code !== 0, `${failure} unexpectedly succeeded`);
    assertEquals(await exists(`${f.plugin}/daemon/enil.rev`), false);
    const r = await f.run();
    assertEquals(r.code, 0, r.err);
    assert(r.out.startsWith("fake-deno run"), r.out);
    const artifacts = [
      ...Deno.readDirSync(`${f.plugin}/daemon`),
      ...Deno.readDirSync(f.home),
    ].filter((entry) => entry.name.startsWith(".enil-"));
    assertEquals(
      artifacts,
      [],
      "temporary build and fingerprint output removed",
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
