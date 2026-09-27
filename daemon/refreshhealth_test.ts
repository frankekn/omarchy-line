/** Refresh-health state published in state.json. */
import { assert, assertEquals } from "@std/assert";
import { RefreshHealthState } from "./refreshcontrol.ts";

function fixture() {
  const calls = { writes: 0, log: [] as string[] };
  const health = new RefreshHealthState({
    writeState: () => calls.writes++,
    log: (message) => calls.log.push(message),
    error: (message) => calls.log.push(message),
  });
  return { calls, health };
}

Deno.test("before any round the refresh field stays absent", () => {
  assertEquals(fixture().health.value, null);
});

Deno.test("a success stamps at without an extra state write", () => {
  const { calls, health } = fixture();
  health.succeed(1000);
  assertEquals(health.value, { at: 1000, failures: 0 });
  assertEquals(calls, { writes: 0, log: [] });
});

Deno.test("a failure preserves the last success and carries its reason", () => {
  const { health } = fixture();
  health.succeed(1000);
  health.fail("network", 2000);
  assertEquals(health.value, { at: 1000, failures: 1, reason: "network" });
});

Deno.test("a failure streak emits only its first write and journal edge", () => {
  const { calls, health } = fixture();
  health.succeed(1000);
  health.fail("network", 2000);
  health.fail("network", 3000);
  health.fail("network", 4000);
  assertEquals(health.value, { at: 1000, failures: 3, reason: "network" });
  assertEquals(calls.writes, 1);
  assertEquals(calls.log, [
    `[chats] refresh failing since ${new Date(2000).toISOString()} (network)`,
  ]);
});

Deno.test("the latest failure reason replaces the earlier diagnosis", () => {
  const { calls, health } = fixture();
  health.fail("network", 1000);
  health.fail("token_expired", 2000);
  assertEquals(health.value, { at: 0, failures: 2, reason: "token_expired" });
  assertEquals(calls.writes, 1);
});

Deno.test("recovery logs the completed streak", () => {
  const { calls, health } = fixture();
  health.succeed(1000);
  for (const time of [2000, 3000, 4000]) health.fail("network", time);
  calls.log.length = 0;
  health.succeed(5000);
  assertEquals(health.value, { at: 5000, failures: 0 });
  assertEquals(calls.log, ["[chats] refresh recovered after 3 failures"]);
  assertEquals(calls.writes, 1);
});

Deno.test("a quiet success never logs a recovery", () => {
  const { calls, health } = fixture();
  health.succeed(1000);
  health.succeed(2000);
  assertEquals(calls.log, []);
});

Deno.test("clear starts the next session with independent health", () => {
  const { calls, health } = fixture();
  health.succeed(1000);
  health.fail("network", 2000);
  health.clear();
  assertEquals(health.value, null);
  health.fail("network", 9000);
  assertEquals(health.value, { at: 0, failures: 1, reason: "network" });
  assertEquals(calls.writes, 2);
});

Deno.test("a streak without an earlier success has at zero", () => {
  const { health } = fixture();
  health.fail("unknown", 1000);
  const value = health.value;
  assert(value);
  assertEquals(value.at, 0);
  assert(value.failures === 1 && value.reason === "unknown");
});
