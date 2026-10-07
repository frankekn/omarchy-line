/**
 * Every journal line the daemon writes goes through errorLine(): class plus a
 * redacted, bounded message. A raw `.message` reaches the journal unredacted,
 * and a linejs error text quotes the mid of whoever the request was about.
 * This scan is the rule, so the next raw site fails here instead of in
 * someone's `journalctl`.
 *
 *   deno test -A logmask_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const MODULES = new URL("./modules/", import.meta.url);

async function sources(): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for await (const entry of Deno.readDir(MODULES)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    out.push([
      entry.name,
      await Deno.readTextFile(new URL(entry.name, MODULES)),
    ]);
  }
  out.push([
    "daemon.ts",
    await Deno.readTextFile(new URL("./daemon.ts", import.meta.url)),
  ]);
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** The console.* statements of one source, each as a single line of text. */
function consoleCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /console\.(?:error|log|warn)\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(m.index, i + 1).replace(/\s+/g, " "));
  }
  return calls;
}

Deno.test("no journal line prints a raw error message", async () => {
  const raw: string[] = [];
  for (const [name, src] of await sources()) {
    for (const call of consoleCalls(src)) {
      if (
        /\(\w+ as Error\)\.message|\b(?:e|err|error)\??\.message\b/.test(call)
      ) raw.push(`${name}: ${call}`);
    }
  }
  assertEquals(raw, [], "route these through errorLine()");
});

Deno.test("no journal line interpolates a mid", async () => {
  const leaks: string[] = [];
  for (const [name, src] of await sources()) {
    for (const call of consoleCalls(src)) {
      if (/\$\{(?:mid|chatMid|chat|from|to|target)\}/.test(call)) {
        leaks.push(`${name}: ${call}`);
      }
    }
  }
  assertEquals(leaks, [], "a mid is user data; log the class, not the row");
});

Deno.test("errorLine redacts the mid a linejs error text quotes", async () => {
  const { errorLine } = await loadBlock<{ errorLine(e: unknown): string }>(
    "mediastate",
    "type Json = Record<string, unknown>;\nexport { errorLine };",
  );
  const e = new Error(
    'Request internal failed, sendChatChecked(/S4) -> {"chatMid":"c0123456789abcdef0123456789abcdef","code":"INTERNAL_ERROR"}',
  );
  e.name = "RequestError";
  const line = errorLine(e);
  assert(line.startsWith("RequestError: "), line);
  assert(!line.includes("c0123456789abcdef0123456789abcdef"), line);
  assert(line.includes("<mid>"), line);
  // The read-receipt path used to pass `e.message` straight through.
  assertEquals(
    errorLine("u0123456789abcdef0123456789abcdef"),
    "Refused: <mid>",
  );
});
