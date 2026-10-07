/**
 * enil-run.sh, the systemd ExecStart, driven in a throwaway plugin dir with a
 * fake git and a fake deno on PATH: the submodule gate, the deno lookup order
 * and the final exec are the contract, and none of them need a real checkout.
 *
 *   deno test -A enilrun_test.ts
 */
import { assert, assertEquals } from "@std/assert";

const DAEMON_DIR = new URL("./", import.meta.url).pathname;

interface Fixture {
  plugin: string;
  bin: string;
  home: string;
  run(env?: Record<string, string>): Promise<{
    code: number;
    out: string;
    err: string;
  }>;
}

/**
 * A plugin dir holding copies of the two scripts, a PATH dir with the fakes,
 * and a HOME. The fake git answers `submodule status` with the line in
 * `status`; the fake deno prints its argv and exits 0.
 */
async function fixture(opts: {
  status: string;
  gitRepo?: boolean;
  denoOnPath?: boolean;
  denoInHome?: boolean;
  vendorFile?: boolean;
}): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "enil-run-" });
  const plugin = `${root}/plugin`;
  const bin = `${root}/bin`;
  const home = `${root}/home`;
  await Deno.mkdir(`${plugin}/daemon`, { recursive: true });
  await Deno.mkdir(bin);
  // PATH is this dir alone, so the machine's own deno can never be found;
  // the tools the script shells out to are linked in by name.
  for (const tool of ["sh", "cat", "dirname", "pwd", "printf", "echo"]) {
    for (const from of [`/usr/bin/${tool}`, `/bin/${tool}`]) {
      try {
        await Deno.symlink(from, `${bin}/${tool}`);
        break;
      } catch { /* try the other prefix */ }
    }
  }
  await Deno.mkdir(`${home}/.deno/bin`, { recursive: true });
  for (const f of ["enil-run.sh", "enil-flags.sh"]) {
    await Deno.copyFile(`${DAEMON_DIR}${f}`, `${plugin}/daemon/${f}`);
  }
  await Deno.writeTextFile(`${plugin}/daemon/daemon.ts`, "");
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
  const deno = '#!/bin/sh\necho "fake-deno $*"\n';
  if (opts.denoOnPath) {
    await Deno.writeTextFile(`${bin}/deno`, deno, { mode: 0o755 });
  }
  if (opts.denoInHome) {
    await Deno.writeTextFile(`${home}/.deno/bin/deno`, deno, { mode: 0o755 });
  }
  return {
    plugin,
    bin,
    home,
    async run(env = {}) {
      const out = await new Deno.Command("sh", {
        args: [`${plugin}/daemon/enil-run.sh`],
        env: { PATH: bin, HOME: home, ...env },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: out.code,
        out: new TextDecoder().decode(out.stdout),
        err: new TextDecoder().decode(out.stderr),
      };
    },
  };
}

Deno.test("a never-checked-out submodule stops the start and prints the two fixes", async () => {
  const f = await fixture({
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
  const f = await fixture({
    status: "+0123abcd daemon/vendor/linejs (heads/main)",
    denoOnPath: true,
  });
  const r = await f.run();
  assertEquals(r.code, 78);
  assert(r.err.includes("submodule update --init --recursive"), r.err);
});

Deno.test("a clean submodule runs deno from PATH with the shared flag set", async () => {
  const f = await fixture({
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
  const f = await fixture({
    status: " 4d6aa18f daemon/vendor/linejs",
    denoInHome: true,
  });
  const r = await f.run();
  assertEquals(r.code, 0, r.err);
  assert(r.out.startsWith("fake-deno run"), r.out);
});

Deno.test("no deno anywhere exits non-zero with advice, after the submodule gate", async () => {
  const f = await fixture({ status: " 4d6aa18f daemon/vendor/linejs" });
  const r = await f.run();
  assertEquals(r.code, 127);
  assert(r.err.includes("deno not found"), r.err);
  assert(r.err.includes("install.sh"), r.err);
  // The submodule refusal still comes first: it is the one a reinstall of
  // deno cannot fix.
  const g = await fixture({ status: "-4d6aa18f daemon/vendor/linejs" });
  assertEquals((await g.run()).code, 78);
});

Deno.test("outside a git checkout the vendored file itself is the gate", async () => {
  const empty = await fixture({ status: "", gitRepo: false, denoOnPath: true });
  const r = await empty.run();
  assertEquals(r.code, 78);
  assert(r.err.includes("not a git checkout"), r.err);
  const copied = await fixture({
    status: "",
    gitRepo: false,
    denoOnPath: true,
    vendorFile: true,
  });
  assertEquals((await copied.run()).code, 0);
});
