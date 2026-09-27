/** Push-burst refresh debounce and its maximum delay. */
import { assert, assertEquals } from "@std/assert";
import { RefreshDebouncer } from "./refreshcontrol.ts";

function fixture() {
  let nextTimer = 1;
  let refreshes = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const debouncer = new RefreshDebouncer({
    run: () => refreshes++,
    setTimer: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    debouncer,
    delays: () => [...timers.values()].map(({ delay }) => delay),
    fire: () => {
      const entry = timers.entries().next().value;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1].callback();
    },
    count: () => refreshes,
  };
}

Deno.test("a push burst resets quiet time but never exceeds two seconds", () => {
  const f = fixture();
  f.debouncer.schedule(10_000);
  assertEquals(f.delays(), [500]);
  f.debouncer.schedule(10_200);
  assertEquals(f.delays(), [500]);
  f.debouncer.schedule(11_900);
  assertEquals(f.delays(), [100]);
  f.fire();
  assertEquals(f.count(), 1);
  assertEquals(f.delays(), []);
});

Deno.test("clearing the debouncer cancels queued reconciliation", () => {
  const f = fixture();
  f.debouncer.schedule(10_000);
  f.debouncer.clear();
  assertEquals(f.delays(), []);
  f.fire();
  assertEquals(f.count(), 0);
});

Deno.test("a non-finite debouncer maximum is rejected", () => {
  let threw: unknown;
  try {
    new RefreshDebouncer({
      run: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
      maximumMs: Infinity,
    });
  } catch (error) {
    threw = error;
  }
  assert(threw instanceof Error);
});

Deno.test("a backward wall clock does not extend the debounce maximum", () => {
  const f = fixture();
  // Monotonic time keeps flowing even if the wall clock steps back; the
  // default clock must therefore never be Date.now.
  f.debouncer.schedule(10_000);
  f.debouncer.schedule(11_600);
  assertEquals(f.delays(), [400]);
  f.debouncer.schedule(12_400);
  assertEquals(f.delays(), [0]);
  f.fire();
  assertEquals(f.count(), 1);
});
