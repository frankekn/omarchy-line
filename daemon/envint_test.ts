/**
 * The ENIL_* number parser. The case that made it exist is "abc": the old
 * `Number(...)` gave NaN, and a NaN timeout fires at once, so one typo aborted
 * every request to LINE. Zero and negatives must be refused for the same
 * reason -- they are not a value the operator meant.
 *
 *   deno test -A envint_test.ts
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const NAME = "ENIL_ENVINT_TEST";

async function loadModule() {
  return await loadBlock<{ envInt(name: string, fallback: number): number }>(
    "envint",
    "export { envInt };",
  );
}

/** Restores whatever the surrounding environment had, including "unset". */
function withEnv(value: string | undefined, body: () => void): void {
  const before = Deno.env.get(NAME);
  if (value === undefined) Deno.env.delete(NAME);
  else Deno.env.set(NAME, value);
  try {
    body();
  } finally {
    if (before === undefined) Deno.env.delete(NAME);
    else Deno.env.set(NAME, before);
  }
}

Deno.test("an unset variable leaves the default alone", async () => {
  const m = await loadModule();
  withEnv(undefined, () => assertEquals(m.envInt(NAME, 30_000), 30_000));
});

Deno.test("a value that is not a number is ignored", async () => {
  const m = await loadModule();
  withEnv("abc", () => assertEquals(m.envInt(NAME, 30_000), 30_000));
});

Deno.test("zero, negatives and fractions are ignored, not obeyed", async () => {
  const m = await loadModule();
  // Every ENIL_* number is a count or a millisecond count; half a message is
  // as much a typo as "abc".
  for (const raw of ["0", "-5", "1.5"]) {
    withEnv(raw, () => assertEquals(m.envInt(NAME, 30_000), 30_000));
  }
});

Deno.test("a positive number is taken, in either notation", async () => {
  const m = await loadModule();
  withEnv("45000", () => assertEquals(m.envInt(NAME, 30_000), 45_000));
  withEnv("4.5e4", () => assertEquals(m.envInt(NAME, 30_000), 45_000));
});
