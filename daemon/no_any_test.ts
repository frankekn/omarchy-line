/**
 * Explicit `any` is guarded by two layers, and each exists for the blind
 * spot of the other.
 *
 * The first layer is `deno lint` with `no-explicit-any` enabled in
 * deno.json: it rejects a written-out `any` within seconds of writing it,
 * but its verdict can be overturned by a suppression comment. The second
 * layer is this file: it re-lints every first-party source with the
 * suppression directives renamed inert (`deno-lint-ignore` becomes
 * `deno-lint-disabled` below), so an `any` hidden behind such a comment
 * still fails the run -- a bypass the lint rule itself cannot close.
 * Both layers are load-bearing: without the lint rule, violations surface
 * only after a full test run instead of at the point of writing; without
 * this file, a one-line comment is a standing exemption from the policy.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("./", import.meta.url);

async function typescriptFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === "vendor") continue;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) files.push(...await typescriptFiles(url));
    else if (/\.[cm]?tsx?$/.test(entry.name)) files.push(url);
  }
  return files;
}

interface LintDiagnostic {
  filename: string;
  code: string;
  message: string;
  range: { start: { line: number } };
}

async function explicitAnyDiagnostics(
  files: URL[],
  tempDir?: string,
): Promise<LintDiagnostic[]> {
  const staged: string[] = [];
  // Map each temporary copy back to the file it stands for -- keyed by the
  // copy's file:// URL, the form `deno lint --json` reports -- so a failure
  // names the source the operator has to fix instead of a temp path that is
  // gone by the time the log is read.
  const origin = new Map<string, string>();
  const reportName = (filename: string): string =>
    origin.get(filename) ?? filename;
  try {
    // Lint a syntax-identical temporary copy with suppression directives made
    // inert. Replacing the token inside prose is harmless, while line/file
    // comments can no longer opt out of the repository's hard gate.
    for (const file of files) {
      const suffix = file.pathname.match(/\.[cm]?tsx?$/)?.[0] ?? ".ts";
      const copy = await Deno.makeTempFile({ dir: tempDir, suffix });
      staged.push(copy);
      const source = await Deno.readTextFile(file);
      await Deno.writeTextFile(
        copy,
        source.replaceAll("deno-lint-ignore", "deno-lint-disabled"),
      );
      // fileURLToPath, not file.pathname: on Windows the URL pathname is
      // "/C:/work/file.ts" while diagnostics must name the native path.
      origin.set(pathToFileURL(copy).href, fileURLToPath(file));
    }
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "lint",
        "--json",
        "--no-config",
        "--rules-include=no-explicit-any",
        ...staged,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const result = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      diagnostics?: LintDiagnostic[];
      errors?: unknown[];
    };
    if ((result.errors ?? []).length > 0) {
      throw new Error(
        `lint could not process ${result.errors?.length} file(s)`,
      );
    }
    const diagnostics = result.diagnostics ?? [];
    if (!output.success && diagnostics.length === 0) {
      throw new Error(new TextDecoder().decode(output.stderr) || "lint failed");
    }
    return diagnostics
      .filter((item) => item.code === "no-explicit-any")
      .map((item) => ({ ...item, filename: reportName(item.filename) }));
  } finally {
    await Promise.all(staged.map((file) => Deno.remove(file).catch(() => {})));
  }
}

Deno.test("first-party TypeScript contains no explicit any escape hatch", async () => {
  const diagnostics = await explicitAnyDiagnostics(await typescriptFiles(ROOT));
  assertEquals(
    diagnostics.map((item) =>
      `${item.filename}:${item.range.start.line}: ${item.message}`
    ),
    [],
  );
});

Deno.test("any-like prose in strings and comments is not a type violation", async () => {
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(
      file,
      [
        'export const message = "Error: any request failed";',
        "// const ignored: any = value;",
        "/* value as any; Array<any> */",
      ].join("\n"),
    );
    assertEquals(
      await explicitAnyDiagnostics([new URL(`file://${file}`)]),
      [],
    );
  } finally {
    await Deno.remove(file).catch(() => {});
  }
});

Deno.test("real explicit any syntax is rejected", async () => {
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(file, "export const value: any = 1;\n");
    const diagnostics = await explicitAnyDiagnostics([
      new URL(`file://${file}`),
    ]);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].code, "no-explicit-any");
    // The origin map keys on the lint-reported file:// URL, so the failure
    // must name the source fixture, never the deleted temporary copy.
    assertEquals(diagnostics[0].filename, file);
  } finally {
    await Deno.remove(file).catch(() => {});
  }
});

Deno.test("lint suppression cannot bypass the explicit any gate", async () => {
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(
      file,
      [
        "// deno-lint-ignore-file no-explicit-any",
        "export const first: any = 1;",
        "// deno-lint-ignore no-explicit-any -- forbidden here too",
        "export const second = 2 as any;",
      ].join("\n"),
    );
    const diagnostics = await explicitAnyDiagnostics([
      new URL(`file://${file}`),
    ]);
    assertEquals(diagnostics.length, 2);
  } finally {
    await Deno.remove(file).catch(() => {});
  }
});

Deno.test("lint processing errors fail closed", async () => {
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(file, "export const value = ;\n");
    await assertRejects(() =>
      explicitAnyDiagnostics([new URL(`file://${file}`)])
    );
  } finally {
    await Deno.remove(file).catch(() => {});
  }
});

Deno.test("a source read failure removes its staging file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() =>
      explicitAnyDiagnostics(
        [new URL(`file://${dir}/does-not-exist.ts`)],
        dir,
      )
    );
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, []);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
