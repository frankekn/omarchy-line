/**
 * The clipboard stage/claim lifecycle behind probeClipboardImage and
 * sendClipboardImage: read the Wayland clipboard into one staged file, bind
 * it to the session and chat that probed it, and let one send claim it.
 *
 * Moved verbatim out of daemon.ts. The process to run and the upload to do
 * are both arguments, so tests can drive a clipboard that holds text, an
 * image nobody can encode, or 21 MB of it -- and import this file without
 * pulling in the LINE session or the state dir. The two names the moved
 * bodies still reach for, MEDIA_DIR and the redacting journal line
 * (errorLine), are injected once through createClipboardStages().
 */
import type { Client } from "@evex/linejs";

type Json = Record<string, unknown>;

/** The daemon-owned context the moved bodies name directly. */
export interface ClipboardStageOptions {
  /** Where staged files live; MEDIA_DIR in the daemon. */
  mediaDir: string;
  /**
   * The journal line a failed sweep logs: redacted and bounded, the daemon's
   * errorLine. Injected rather than duplicated so the wording cannot drift.
   */
  errorLine(error: unknown): string;
}

export function createClipboardStages(options: ClipboardStageOptions) {
  // The exact names the moved bodies already use, bound once per process.
  const { errorLine, mediaDir: MEDIA_DIR } = options;
  /**
   * The cap on a pasted image, ours rather than LINE's: the bytes are read into
   * memory, encrypted into a second copy, and then uploaded twice -- linejs
   * re-uploads the payload as the `__ud-preview` object when it is given no
   * thumbnail (vendor/linejs base/obs/mod.ts:389). A clipboard holding a 500 MB
   * frame grab has to fail as a sentence, not as an OOM kill.
   */
  const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;

  /**
   * The types we will ask the clipboard for, best first. Everything that copies
   * an image on Wayland offers image/png (grim, hyprshot, Firefox, Chromium,
   * GIMP); the rest are here for a source that offers only one of them.
   */
  const CLIPBOARD_TYPES = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ];
  const CLIPBOARD_STAGE_TTL_MS = 10 * 60 * 1000;
  /**
   * Recovery runs before this boot unlinks the shared socket, so a second
   * daemon starting beside a live one would see the first one's mid-send
   * claim. Nothing legitimate outlives a clipboard upload, so only claims
   * older than this grace are treated as crash-left and swept.
   */
  const CLIPBOARD_CLAIM_GRACE_MS = 10 * 60 * 1000;

  const CLIPBOARD_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  /** What one `wl-paste` run answered; `stderr` is already text and trimmed. */
  type PasteRun = { code: number; stdout: Uint8Array; stderr: string };

  /** argv for `wl-paste`: the offered types, or one type's bytes. */
  function clipboardArgs(mime?: string): string[] {
    // --no-newline: wl-paste appends one to whatever it prints unless told not
    // to, and a byte glued onto the end of a PNG is a corrupt PNG.
    return mime ? ["--no-newline", "--type", mime] : ["--list-types"];
  }

  /**
   * The mime types `wl-paste --list-types` printed. It prints one per line,
   * repeats them, keeps X11 atoms (TEXT, STRING, UTF8_STRING) in the list and
   * lets parameters through (`text/plain;charset=utf-8`) -- so anything without
   * a slash is not a mime type, and the parameter is cut off.
   */
  function clipboardTypes(stdout: string): string[] {
    const out: string[] = [];
    for (const line of stdout.split("\n")) {
      const type = line.split(";")[0].trim().toLowerCase();
      if (type.includes("/") && !out.includes(type)) out.push(type);
    }
    return out;
  }

  /** The best type we can send out of what is offered, or null. */
  function pickClipboardType(types: string[]): string | null {
    return CLIPBOARD_TYPES.find((t) => types.includes(t)) ?? null;
  }

  /**
   * `probeClipboardImage`: read the Wayland clipboard into one staged file.
   *
   * A file rather than returning the bytes because the second command hands it
   * to the `sendFile` path -- one place that decides the ObjType, filename and
   * every refusal, so a pasted screenshot and a picked file cannot drift. It lives under
   * MEDIA_DIR rather than /tmp so that a copy left behind by a crash is swept
   * with the rest of the media cache. The send phase removes it after either a
   * success or refusal. The panel starts the separately correlated send only
   * after this probe succeeds, so a failed probe can never become an ambiguous
   * message after a socket disconnect.
   */
  async function clipboardStage(
    dir: string,
    nonce: string | number,
    run: (args: string[]) => Promise<PasteRun>,
    write: (path: string, data: Uint8Array) => Promise<void> = Deno.writeFile,
    remove: (path: string) => Promise<void> = Deno.remove,
  ): Promise<Json> {
    let listed: PasteRun;
    try {
      listed = await run(clipboardArgs());
    } catch (e) {
      // Deno throws NotFound for the executable itself. wl-clipboard is not part
      // of a stock Omarchy install, and "找不到 wl-paste" on its own leaves the
      // user to guess which package that is -- same wording as the zenity miss.
      if (e instanceof Deno.errors.NotFound) {
        return {
          ok: false,
          error: "找不到 wl-paste，請 sudo pacman -S wl-clipboard",
        };
      }
      throw e;
    }
    if (listed.code !== 0) {
      // An empty clipboard is exit 1 with "No selection" -- and so is every
      // other failure, so the reason has to come out of stderr. A daemon started
      // before the compositor put WAYLAND_DISPLAY into the systemd user
      // environment cannot reach a display at all ("Failed to connect to a
      // Wayland server"), and that is a broken install rather than an empty
      // clipboard: it must not read as one.
      if (/wayland/i.test(listed.stderr)) {
        return {
          ok: false,
          error: "連不上 Wayland，請 systemctl --user restart enil",
        };
      }
      if (listed.stderr && !/no selection/i.test(listed.stderr)) {
        return {
          ok: false,
          error: "讀不到剪貼簿",
          logText: `wl-paste: ${listed.stderr.slice(0, 80)}`,
        };
      }
      return { ok: false, error: "剪貼簿裡沒有圖片" };
    }
    const types = clipboardTypes(new TextDecoder().decode(listed.stdout));
    const mime = pickClipboardType(types);
    if (!mime) {
      // An image in a format we cannot name would otherwise be reported as no
      // image at all, and the user would keep re-copying it.
      const other = types.find((t) => t.startsWith("image/"));
      return {
        ok: false,
        error: other ? `剪貼簿的圖片格式不支援: ${other}` : "剪貼簿裡沒有圖片",
      };
    }
    const got = await run(clipboardArgs(mime));
    if (got.code !== 0 || got.stdout.length === 0) {
      return { ok: false, error: "剪貼簿的圖片讀不到" };
    }
    if (got.stdout.length > CLIPBOARD_MAX_BYTES) {
      const mb = Math.round(CLIPBOARD_MAX_BYTES / (1024 * 1024));
      return { ok: false, error: `剪貼簿的圖片太大（超過 ${mb} MB）` };
    }
    const path = `${dir}/clipboard-${nonce}.${CLIPBOARD_EXT[mime]}`;
    try {
      await write(path, got.stdout);
    } catch (error) {
      await remove(path).catch(() => {});
      throw error;
    }
    return { ok: true, data: { stage: path.split("/").pop() ?? "" } };
  }

  /** Resolve only a clipboard file created by clipboardStage, never a path. */
  function clipboardStagePath(dir: string, stage: string): string | null {
    return /^clipboard-[0-9A-Za-z-]+\.(?:png|jpg|webp|gif)$/.test(stage)
      ? `${dir}/${stage}`
      : null;
  }

  /** Delete an unused staged clipboard image, idempotently and nowhere else. */
  async function discardClipboardStage(
    dir: string,
    stage: string,
    remove: (path: string) => Promise<void> = Deno.remove,
  ): Promise<void> {
    const path = clipboardStagePath(dir, stage);
    if (!path) return;
    try {
      await remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  /** Ensure a probe abandoned by a disconnect cannot occupy the cache quota. */
  function expireClipboardStage(
    dir: string,
    stage: string,
    delayMs: number,
    schedule: (cleanup: () => void, delay: number) => unknown = setTimeout,
    discard: (dir: string, stage: string) => Promise<void> =
      discardClipboardStage,
    report: (error: unknown) => void = (error) =>
      console.error(`[clipboard] stage expiry failed: ${errorLine(error)}`),
  ): void {
    schedule(() => void discard(dir, stage).catch(report), delayMs);
  }

  /**
   * Retry a claim's removal once the named delay has certainly outlived any
   * in-flight claim stamp. rename publishes the claim before its mtime stamp
   * lands, so a claim can carry the staged file's old mtime for a moment; the
   * re-stat inside the callback spares anything whose stamp arrived since.
   */
  function expireCrashLeftClaim(
    dir: string,
    name: string,
    delayMs: number,
    schedule: (cleanup: () => void, delay: number) => unknown = setTimeout,
    report: (error: unknown) => void = (error) =>
      console.error(`[clipboard] claim expiry failed: ${errorLine(error)}`),
  ): void {
    schedule(() => {
      void (async () => {
        try {
          const info = await Deno.stat(`${dir}/${name}`);
          if (
            info.mtime &&
            Date.now() - info.mtime.getTime() < CLIPBOARD_CLAIM_GRACE_MS
          ) return;
          await Deno.remove(`${dir}/${name}`);
        } catch (error) {
          // Already gone is the sweep's goal; anything else deserves a log.
          if (!(error instanceof Deno.errors.NotFound)) report(error);
        }
      })();
    }, delayMs);
  }

  /** Remaining persisted lease, or null when the stage no longer exists. */
  async function clipboardStageRemaining(
    path: string,
    now: number = Date.now(),
    stat: (path: string) => Promise<Deno.FileInfo> = Deno.stat,
  ): Promise<number | null> {
    try {
      const info = await stat(path);
      if (!info.isFile || !info.mtime) return 0;
      return Math.min(
        CLIPBOARD_STAGE_TTL_MS,
        Math.max(0, CLIPBOARD_STAGE_TTL_MS - (now - info.mtime.getTime())),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  /** Restore clipboard leases whose in-process timers were lost on restart. */
  async function recoverClipboardStages(
    dir: string = MEDIA_DIR,
    now: number = Date.now(),
    schedule: (cleanup: () => void, delay: number) => unknown = setTimeout,
    stat: (path: string) => Promise<Deno.FileInfo> = Deno.stat,
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile) continue;
        // A claim file is the staged paste mid-send, renamed under a leading
        // dot so the stage regex cannot double-book it. Its only lifecycle is
        // one live send -- a crash leaves it ownerless and undownloadable --
        // so unlike stages it has no lease: sweep everything past the grace
        // window (see CLIPBOARD_CLAIM_GRACE_MS).
        if (
          /^\.clipboard-claim-[0-9A-Za-z-]+\.(?:png|jpg|webp|gif)$/.test(
            entry.name,
          )
        ) {
          let claimed: Deno.FileInfo | null = null;
          try {
            claimed = await stat(`${dir}/${entry.name}`);
          } catch (error) {
            // Absence only means the sweep's goal is already met. Any other
            // stat failure must reach the recovery-error log: reading it as
            // "no fresh claim" would unlink a possibly-live send's file.
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          // An unavailable mtime is not proof of age: like the media sweeper,
          // read it as live and leave the file alone.
          const claimedAtMs = claimed?.mtime?.getTime();
          if (claimedAtMs === undefined) continue;
          // Removal is always deferred by a full grace period, then re-stat:
          // a claim renamed a moment ago still wears the staged file's mtime
          // until its stamp lands, so the observed mtime -- fresh or stale --
          // says nothing trustworthy about the claim's own age yet. One full
          // grace later the stamp has certainly landed (or never will), and
          // the re-stat decides; recovery runs only at boot and the media
          // sweeper waits 14 days, so each claim gets exactly one retry.
          expireCrashLeftClaim(
            dir,
            entry.name,
            CLIPBOARD_CLAIM_GRACE_MS,
            schedule,
          );
          continue;
        }
        if (!clipboardStagePath(dir, entry.name)) continue;
        const remaining = await clipboardStageRemaining(
          `${dir}/${entry.name}`,
          now,
        );
        if (remaining === null) continue;
        if (remaining <= 0) await discardClipboardStage(dir, entry.name);
        else expireClipboardStage(dir, entry.name, remaining, schedule);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  /** Use a staged image once and remove it after either success or refusal. */
  async function consumeClipboardStage(
    dir: string,
    stage: string,
    send: (path: string, filename: string) => Promise<Json>,
    rename: (from: string, to: string) => Promise<void> = Deno.rename,
    stampMtime: (path: string, at: Date) => Promise<void> = (path, at) =>
      Deno.utime(path, at, at),
  ): Promise<Json> {
    const path = clipboardStagePath(dir, stage);
    if (!path) return { ok: false, error: "剪貼簿暫存已失效" };
    const remaining = await clipboardStageRemaining(path);
    if (remaining === null || remaining <= 0) {
      await discardClipboardStage(dir, stage);
      return { ok: false, error: "剪貼簿暫存已失效" };
    }
    const extension = stage.slice(stage.lastIndexOf("."));
    const claimed =
      `${dir}/.clipboard-claim-${crypto.randomUUID()}${extension}`;
    try {
      try {
        // rename(2) is the claim: among concurrent consumers only one can move
        // this pathname, and the expiry timer can no longer remove its upload.
        const claimedAt = new Date();
        await rename(path, claimed);
        // rename preserves the staged file's mtime, but the recovery grace
        // measures the claim's own life: stamp the claim moment, or a stage
        // claimed at the end of its lease reads as crash-left to a second
        // daemon. A failed stamp must fail the claim -- sending on with the
        // inherited mtime would put a live upload inside the sweep window.
        await stampMtime(claimed, claimedAt);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return { ok: false, error: "剪貼簿暫存已失效" };
        }
        throw error;
      }
      const result = await send(claimed, stage);
      if (
        result.ok === false &&
        String(result.error ?? "").startsWith("找不到檔案:")
      ) return { ok: false, error: "剪貼簿暫存已失效" };
      return result;
    } finally {
      await Deno.remove(claimed).catch(() => {});
    }
  }

  /** Keep the original one-command socket contract while staged clients avoid
   * treating a failed clipboard probe as an ambiguous outgoing message. */
  async function sendClipboardImageRequest(
    dir: string,
    stage: string,
    nonce: string | number,
    run: (args: string[]) => Promise<PasteRun>,
    send: (path: string, filename: string) => Promise<Json>,
    rename: (from: string, to: string) => Promise<void> = Deno.rename,
  ): Promise<Json> {
    let selected = stage;
    let created = false;
    if (!selected) {
      const probed = await clipboardStage(dir, nonce, run);
      if (probed.ok !== true) return probed;
      const data = probed.data;
      selected = data && typeof data === "object"
        ? String((data as Json).stage ?? "")
        : "";
      if (!selected) return { ok: false, error: "剪貼簿暫存已失效" };
      created = true;
    }
    try {
      return await consumeClipboardStage(dir, selected, send, rename);
    } finally {
      if (created) await discardClipboardStage(dir, selected).catch(() => {});
    }
  }

  function claimClipboardStageBinding<T>(
    bindings: Map<string, {
      owner: T;
      generation: number;
      chat: string;
      claimed?: boolean;
    }>,
    stage: string,
    owner: T,
    generation: number,
    chat: string,
  ): "claimed" | "busy" | "mismatch" | "missing" {
    const binding = bindings.get(stage);
    if (!binding) return "missing";
    if (binding.claimed) return "busy";
    if (
      binding.owner !== owner || binding.generation !== generation ||
      binding.chat !== chat
    ) {
      bindings.delete(stage);
      return "mismatch";
    }
    binding.claimed = true;
    return "claimed";
  }

  type ClipboardStageSession = {
    owner: Client;
    generation: number;
    chat: string;
    claimed?: boolean;
  };
  const clipboardStageSessions = new Map<string, ClipboardStageSession>();

  async function discardBoundClipboardStage(stage: string): Promise<void> {
    clipboardStageSessions.delete(stage);
    await discardClipboardStage(MEDIA_DIR, stage);
  }

  function retireClipboardStages(
    owner: Client | null,
    generation: number,
  ): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const [stage, binding] of clipboardStageSessions) {
      if (binding.owner !== owner || binding.generation !== generation) {
        continue;
      }
      clipboardStageSessions.delete(stage);
      removals.push(discardClipboardStage(MEDIA_DIR, stage));
    }
    return Promise.all(removals).then(() => {});
  }

  // wl-paste's side of clipboardStage(), which is the impure half: a child
  // process, and a bound on how long it may take.
  const WL_PASTE_TIMEOUT_MS = 5_000;

  async function wlPaste(args: string[]): Promise<PasteRun> {
    const out = await new Deno.Command("wl-paste", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      // A compositor that never answers would otherwise hold this socket
      // connection -- and with it the panel -- open for good. An aborted child
      // resolves as a SIGTERM exit rather than throwing, so it needs a stderr of
      // its own to be told apart from an empty clipboard.
      signal: AbortSignal.timeout(WL_PASTE_TIMEOUT_MS),
    }).output();
    return {
      code: out.code,
      stdout: out.stdout,
      stderr: out.signal
        ? `killed by ${out.signal} after ${WL_PASTE_TIMEOUT_MS}ms`
        : new TextDecoder().decode(out.stderr).trim(),
    };
  }

  return {
    CLIPBOARD_MAX_BYTES,
    CLIPBOARD_STAGE_TTL_MS,
    clipboardArgs,
    clipboardTypes,
    pickClipboardType,
    clipboardStage,
    clipboardStagePath,
    discardClipboardStage,
    expireClipboardStage,
    clipboardStageRemaining,
    recoverClipboardStages,
    consumeClipboardStage,
    sendClipboardImageRequest,
    claimClipboardStageBinding,
    clipboardStageSessions,
    discardBoundClipboardStage,
    retireClipboardStages,
    wlPaste,
  };
}
