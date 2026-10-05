/**
 * enil — a LINE daemon for the omarchy-line bar plugin.
 *
 * Owns the LINE session (the refresh token rotates on every login, so exactly
 * one process may hold it) and exposes the two interfaces the plugin reads:
 *
 *   ~/.local/state/enil/state.json   atomic writes, watched by the plugin
 *   ~/.local/state/enil/sock         line-delimited JSON request/response
 *
 * Protocol shapes are dictated by Panel.qml in the plugin repo, not by us.
 *
 * This file is only the entry point and assembly: every capability lives in
 * daemon/modules/* and is imported one-way from here. See each module's
 * header for its responsibility and dependency direction.
 */
import {
  AVATAR_DIR,
  HEARTBEAT_MS,
  IMAGE_DIR,
  LOCK_PATH,
  messageStore,
  POLL_MS,
  recoverClipboardStages,
  SOCK_PATH,
  STATE_DIR,
  STATE_PATH,
  STORAGE_PATH,
  WATCHDOG_MS,
} from "./modules/env.ts";
import { loadAvatarIndex, sweepAvatars } from "./modules/avatars.ts";
import { errorLine } from "./modules/text.ts";
import {
  loadHidden,
  login,
  setLogin,
  setLoginState,
  writeState,
} from "./modules/state.ts";
import { MEDIA_SWEEP_MS, sweepMedia } from "./modules/caches.ts";
import { refreshChats } from "./modules/refresh.ts";
import { serve } from "./modules/socket.ts";
import {
  installRejectionGuard,
  sleepMonitor,
  startSleepMonitor,
  watchdogTick,
} from "./modules/watchdog.ts";
import { scheduleResumeRetry, tryResume } from "./modules/login.ts";
import { claimInstance } from "./modules/instance.ts";

/** Held for the life of the process: closing it would release the gate. */
let instanceLock: Deno.FsFile | null = null;

async function main() {
  installRejectionGuard();
  // The first state write happens before token storage can be inspected. Mark
  // it as transient so a panel holding unresolved sends does not mistake a
  // daemon restart for an explicit logout.
  setLoginState({ status: "starting", attempt: "resume" });
  // The state dir holds the session token: create it private rather than
  // leaving it 0755 until the chmod below catches up.
  await Deno.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await Deno.mkdir(AVATAR_DIR, { recursive: true }); // and MEDIA_DIR with it
  // Before anything else touches the state dir: a second daemon must not
  // resume the stored session, rewrite state.json or take over the socket.
  instanceLock = await claimInstance(LOCK_PATH);
  if (!instanceLock) {
    console.error(
      `enil: another daemon already holds ${LOCK_PATH}; refusing to start ` +
        `a second one on the same session`,
    );
    Deno.exit(1);
  }
  await recoverClipboardStages().catch((error) =>
    console.error(`[clipboard] stage recovery failed: ${errorLine(error)}`)
  );
  await loadAvatarIndex();
  // Before the first writeState(): a boot that published the list unstamped
  // would put every hidden row back on screen for one refresh.
  await loadHidden();
  await Deno.chmod(STATE_DIR, 0o700).catch(() => {});
  await Deno.chmod(STORAGE_PATH, 0o600).catch(() => {});
  await writeState();

  await Deno.remove(SOCK_PATH).catch(() => {});
  const listener = Deno.listen({ transport: "unix", path: SOCK_PATH });
  (async () => {
    for await (const conn of listener) serve(conn).catch(() => {});
  })();
  console.log(`enil: ${STATE_PATH} + ${SOCK_PATH}`);

  const resumed = await tryResume();
  if (resumed === "none") {
    // Nothing stored: sit at "idle" so the panel shows its login button.
    // A QR is only worth minting when someone is holding a phone.
    await setLogin("idle", { attempt: "resume", settled: true });
  } else if (resumed === "error" && String(login.reason) === "network") {
    scheduleResumeRetry();
  }

  const stop = () => {
    // The dbus-monitor child does not share our process group under systemd,
    // so it has to be killed explicitly or it outlives the daemon.
    try {
      sleepMonitor?.kill("SIGTERM");
    } catch { /* already gone */ }
    // A socket someone already removed must not throw here: that would skip
    // the store flush below and die with an uncaught error instead.
    try {
      Deno.removeSync(SOCK_PATH);
    } catch { /* already gone */ }
    // Store appends coalesce for 150ms; a signal inside that window would
    // drop records the daemon already confirmed it had seen. The timer caps
    // the wait so a stalled write cannot hold the process past it.
    void messageStore.flush().finally(() => Deno.exit(0));
    setTimeout(() => Deno.exit(0), 2_000);
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);

  setInterval(writeState, HEARTBEAT_MS); // keeps the panel "online"
  // Sweep once at startup to catch what expired while we were down, then on an
  // interval. A failed sweep must never take the daemon with it.
  const sweep = () => {
    sweepMedia().catch(() => {});
    sweepMedia(IMAGE_DIR).catch(() => {});
    sweepAvatars().catch(() => {});
  };
  sweep();
  setInterval(sweep, MEDIA_SWEEP_MS);

  setInterval(watchdogTick, WATCHDOG_MS);
  // refreshChats() returns immediately when there is no session, so this is
  // free while logged out.
  setInterval(() => void refreshChats(), POLL_MS);
  startSleepMonitor();
}

if (import.meta.main) await main();
