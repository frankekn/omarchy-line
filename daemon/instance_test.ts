/**
 * The single-instance gate: a second claim on the same lock file is refused
 * while the first is held, and the lock comes back once the holder lets go --
 * including when the holder is a process that died without cleaning up.
 *
 *   deno test -A instance_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { claimInstance } from "./modules/instance.ts";

Deno.test("a second claim is refused while the first is held", async () => {
  const dir = await Deno.makeTempDir({ prefix: "enil-instance-test-" });
  const path = `${dir}/lock`;
  try {
    const first = await claimInstance(path);
    assert(first);
    try {
      assertEquals(await claimInstance(path), null);
    } finally {
      first.close();
    }
    const again = await claimInstance(path);
    assert(again, "a released lock must be claimable again");
    again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a lock held by a killed process does not outlive it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "enil-instance-test-" });
  const path = `${dir}/lock`;
  try {
    // flock(1) holds the lock in a separate process, the way a running
    // daemon would; SIGKILL gives it no chance to unlock. --close keeps the
    // lock out of the sleep child, so killing flock is enough to drop it.
    const holder = new Deno.Command("flock", {
      args: ["--exclusive", "--close", path, "sleep", "30"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    let held = false;
    for (let i = 0; i < 100 && !held; i++) {
      const probe = await claimInstance(path);
      if (probe) {
        probe.close();
        await new Promise((r) => setTimeout(r, 20));
      } else held = true;
    }
    assert(held, "flock(1) never took the lock");
    holder.kill("SIGKILL");
    await holder.status;
    const after = await claimInstance(path);
    assert(after, "the lock must come back once its holder is gone");
    after.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
