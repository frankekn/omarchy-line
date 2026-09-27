/** Baseline benchmark: daemon mock-mode startup, measured to the banner.
 *
 * "Mock mode" is the boot the startup smoke test exercises: a throwaway
 * XDG_STATE_HOME whose empty store resumes as "none", so the daemon boots,
 * publishes its first state.json and prints the `enil:` banner without any
 * LINE login or network traffic. The measured quantity is the wall time
 * from process spawn until the banner line appears — the latency the panel
 * experiences as DAEMON OFFLINE on every daemon restart.
 *
 * Run:
 *
 *   cd daemon && deno task bench:startup
 *
 * Output: one line per boot plus a median line.
 */
import { TextLineStream } from "@std/streams";

/** Boots must match startup_smoke_test.ts: every ENIL_* knob pinned to its
 * default so operator shell overrides cannot leak into the measurement.
 * HOME is deliberately left untouched — a cleared HOME would point Deno's
 * own module cache at the temp dir and re-download the dependency graph. */
const BENCH_ENV = {
  XDG_STATE_HOME: "", // replaced per boot with the temp dir
  ENIL_DEVICE: "ANDROIDSECONDARY",
  ENIL_INCREMENTAL: "1",
  ENIL_CHAT_LIMIT: "500",
  ENIL_PUSH_STALE_MS: "180000",
  ENIL_REQUEST_TIMEOUT_MS: "30000",
};

const BOOTS = 7;

interface Boot {
  wallMs: number;
}

async function bootOnce(): Promise<Boot> {
  const stateHome = await Deno.makeTempDir({ prefix: "enil-bench-" });
  const started = performance.now();
  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("../daemon.ts", import.meta.url).pathname],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      env: { ...BENCH_ENV, XDG_STATE_HOME: stateHome },
    });
    const child = command.spawn();
    const lines = child.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
      .getReader();
    const deadline = Date.now() + 60_000;
    let banner: string | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("daemon never printed its startup banner");
      }
      const timer = setTimeout(() => lines.cancel().catch(() => {}), 5_000);
      try {
        const { value, done } = await lines.read();
        if (done) {
          child.kill("SIGKILL");
          throw new Error("daemon stdout closed before the banner");
        }
        if (value.startsWith("enil: ")) {
          banner = value;
          break;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    const wallMs = performance.now() - started;
    if (banner === null) throw new Error("unreachable");
    // The SIGTERM handler is installed after the resume attempt settles
    // and the first state write finishes (daemon.ts registers it once
    // login is idle/error); wait for the login edge plus a short grace
    // so the stop below is a clean exit, not a default-disposition 143.
    const settleDeadline = Date.now() + 10_000;
    for (;;) {
      if (Date.now() > settleDeadline) break;
      const timer = setTimeout(() => lines.cancel().catch(() => {}), 2_000);
      try {
        const { value, done } = await lines.read();
        if (done) break;
        if (value.startsWith("[login] ")) break;
      } finally {
        clearTimeout(timer);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGTERM");
    const status = await child.status;
    if (status.code !== 0) {
      throw new Error(`daemon exited ${status.code} after SIGTERM`);
    }
    return { wallMs };
  } finally {
    await Deno.remove(stateHome, { recursive: true }).catch(() => {});
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

console.log(`workload: ${BOOTS} mock boots (empty state dir, no login)`);
const walls: number[] = [];
for (let run = 1; run <= BOOTS; run++) {
  const { wallMs } = await bootOnce();
  walls.push(wallMs);
  console.log(`boot ${run}: banner after ${wallMs.toFixed(0)} ms`);
}
console.log(
  `median: ${median(walls).toFixed(0)} ms to banner over ${BOOTS} boots`,
);
