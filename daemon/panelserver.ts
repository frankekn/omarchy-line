import { TextLineStream } from "@std/streams/text-line-stream";

export type JsonReply = Record<string, unknown>;

export const PANEL_BACKGROUND_COMMANDS: ReadonlySet<string> = new Set([
  "image",
  "preview",
  "download",
]);
export const PANEL_SESSION_INDEPENDENT_COMMANDS: ReadonlySet<string> = new Set([
  "login",
  "sync",
  "hide",
  "unhide",
  "discardClipboardImage",
]);
export const PANEL_MESSAGE_COMMANDS: ReadonlySet<string> = new Set([
  "send",
  "reply",
  "sendSticker",
  "sendFile",
  "sendClipboardImage",
]);
export const PANEL_MUTATION_COMMANDS: ReadonlySet<string> = new Set([
  "login",
  "logout",
  "hide",
  "unhide",
  "discardClipboardImage",
  "react",
  "unsend",
  "probeClipboardImage",
]);
export const PANEL_ORDINARY_QUEUE_MAX = 64;
export const PANEL_MEDIA_QUEUE_MAX = 16;
export const PANEL_MEDIA_BUSY_TEXT = "媒體請求過多，請稍後再試";
export const PANEL_COMMAND_BUSY_TEXT = "請求過多，請稍後再試";
export const PANEL_WRITE_TIMEOUT_MS = 5_000;
export const PANEL_OVERLOAD_WAIT_TIMEOUT_MS = 5_000;

export interface PanelConnection {
  readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): Promise<number>;
  close(): void;
}

export interface WorkLaneLike {
  tryRun<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
    priority?: boolean,
  ): Promise<T> | null;
}

export interface PanelServerOptions {
  handle(req: JsonReply, signal?: AbortSignal): Promise<JsonReply>;
  lane: WorkLaneLike;
  backgroundCommands: ReadonlySet<string>;
  backgroundPriority?: (cmd: string) => boolean;
  encodeError: string;
  refusalText(error: unknown): string;
  /** Captures whether the session that accepted work is still live. */
  captureValidity?: () => () => boolean;
  allowStaleCommand?: (cmd: string) => boolean;
  backgroundSignal?: () => AbortSignal;
  onClosed?: () => void;
  sessionIndependentCommands?: ReadonlySet<string>;
  messageCommands?: ReadonlySet<string>;
  mustAdmitRequest?: (req: JsonReply) => boolean;
  staleRequestError?: string;
  reportFailure(
    cmd: string,
    error: unknown,
    background: boolean,
  ): void;
  reportEncodingFailure(cmd: string, error: unknown): void;
  recordTiming(key: string, elapsedMs: number): void;
  now?: () => number;
  writeTimeoutMs?: number;
  overloadWaitTimeoutMs?: number;
}

const REPLY_ENCODER = new TextEncoder();

/** One JSON reply line, with a usable refusal if the payload cannot encode. */
export function encodeJsonReply(
  cmd: string,
  res: JsonReply,
  encodeError: string,
  reportFailure: (cmd: string, error: unknown) => void,
): Uint8Array {
  try {
    return REPLY_ENCODER.encode(JSON.stringify(res) + "\n");
  } catch (error) {
    reportFailure(cmd, error);
    let safeId: unknown;
    try {
      const encodedId = JSON.stringify(res.id);
      if (encodedId !== undefined) safeId = JSON.parse(encodedId);
    } catch {
      // The refusal itself must remain serializable.
    }
    const refusal: JsonReply = { ok: false, error: encodeError };
    if (safeId !== undefined) refusal.id = safeId;
    return REPLY_ENCODER.encode(
      JSON.stringify(refusal) + "\n",
    );
  }
}

/** Every byte of a reply; Deno.Conn.write may accept only a prefix. */
export async function writeAll(
  writer: { write(bytes: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let at = 0;
  while (at < bytes.byteLength) {
    const written = await writer.write(bytes.subarray(at));
    if (written <= 0) throw new Error("socket accepted no bytes");
    at += written;
  }
}

/**
 * Serves one panel connection.
 *
 * Ordinary commands remain ordered. Selected read-only commands run through
 * the shared lane and may reply out of order by request id. Writes are always
 * serialized. EOF or a reset cancels background reads and returns without
 * waiting, while ordinary commands already read from the socket keep draining
 * in order. That admission boundary matters for side effects: the panel can
 * reconcile an accepted send by its request token, but cannot recover a frame
 * the server silently discarded after reading it.
 */
export async function servePanelConnection(
  conn: PanelConnection,
  options: PanelServerOptions,
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const writeTimeoutMs = options.writeTimeoutMs ?? PANEL_WRITE_TIMEOUT_MS;
  const overloadWaitTimeoutMs = options.overloadWaitTimeoutMs ??
    PANEL_OVERLOAD_WAIT_TIMEOUT_MS;
  const lines = conn.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  const reader = lines.getReader();
  let writing = Promise.resolve();
  let ordinary = Promise.resolve();
  let ordinaryDepth = 0;
  let closed = false;
  let closeReported = false;
  const background = new Set<Promise<void>>();
  const connection = new AbortController();
  type BufferedRead = {
    result: ReadableStreamReadResult<string>;
    queuedAt: number;
    stillValid: () => boolean;
  };
  function readNext(): Promise<BufferedRead> {
    const pending = reader.read().then((result) => ({
      result,
      queuedAt: now(),
      stillValid: options.captureValidity?.() ?? (() => true),
    }));
    // Reads intentionally stay pending while a refusal is written. Observe a
    // reset immediately so the runtime never treats that detached rejection
    // as unhandled; takeNextRead still receives the original rejection.
    void pending.catch(() => {});
    return pending;
  }
  let nextRead = readNext();
  let nextReadAvailable = true;
  const heldReads: BufferedRead[] = [];

  async function takeNextRead(): Promise<BufferedRead> {
    const pending = nextRead;
    nextReadAvailable = false;
    return await pending;
  }

  function scheduleNextRead(): void {
    nextRead = readNext();
    nextReadAvailable = true;
  }

  function reportClosed(): void {
    if (closeReported) return;
    closeReported = true;
    options.onClosed?.();
  }

  function trackBackground(job: Promise<void>, cmd: string): Promise<void> {
    background.add(job);
    return job.then(
      () => {
        background.delete(job);
      },
      (error) => {
        background.delete(job);
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          options.reportFailure(cmd, error, true);
        }
      },
    );
  }

  function queueOrdinary(
    req: JsonReply,
    queuedAt: number,
    stillValid: () => boolean,
  ): Promise<void> {
    const cmd = String(req.cmd ?? "");
    const sessionIndependent = options.sessionIndependentCommands?.has(cmd) ??
      false;
    ordinaryDepth++;
    const job = ordinary.then(() =>
      sessionIndependent || stillValid() || options.allowStaleCommand?.(cmd)
        ? dispatch(req, queuedAt)
        : dispatch(req, queuedAt, undefined, {
          ok: false,
          error: options.staleRequestError ?? "request is stale",
        })
    );
    ordinary = job.catch((error) => {
      options.reportFailure(cmd, error, false);
    }).finally(() => {
      ordinaryDepth--;
    });
    return job;
  }

  // A complete ordinary frame has crossed the socket boundary once read. Even
  // when overload forces the connection closed, enqueue its mutation with the
  // session identity captured on arrival.
  function admitBufferedOrdinary(
    input: BufferedRead,
  ): void {
    if (input.result.done || !input.result.value.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.result.value);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const req = parsed as JsonReply;
    const cmd = String(req.cmd ?? "");
    if (options.backgroundCommands.has(cmd)) return;
    queueOrdinary(
      req,
      input.queuedAt,
      input.stillValid,
    );
  }

  /**
   * Apply input backpressure while a refusal waits for its socket write, but
   * keep one read pending so EOF/reset can still cancel the connection.
   */
  async function waitForReplyOrInputEnd(
    job: Promise<void>,
  ): Promise<{ open: boolean; input?: BufferedRead[] }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), overloadWaitTimeoutMs);
    });
    const retained: BufferedRead[] = [];

    function admitRetainedOrdinary(): void {
      while (heldReads.length > 0) admitBufferedOrdinary(heldReads.shift()!);
      while (retained.length > 0) admitBufferedOrdinary(retained.shift()!);
    }

    async function endConnection(
      forceClose: boolean,
      accountOutstandingRead = false,
    ): Promise<{ open: false }> {
      if (forceClose) {
        try {
          conn.close();
        } catch {
          // The peer may have closed at the same instant.
        }
      }
      if (accountOutstandingRead && nextReadAvailable) {
        try {
          const outstanding = await takeNextRead();
          if (!outstanding.result.done) retained.push(outstanding);
        } catch {
          // A reset has no frame to preserve.
        }
      }
      admitRetainedOrdinary();
      connection.abort();
      closed = true;
      reportClosed();
      return { open: false };
    }

    try {
      while (true) {
        if (heldReads.length + retained.length >= PANEL_ORDINARY_QUEUE_MAX) {
          return await endConnection(true, true);
        }
        const outcome = await Promise.race([
          job.then(() => "reply" as const),
          nextRead.then(
            (next) => next.result.done ? "end" as const : "input" as const,
            () => "end" as const,
          ),
          timeout,
        ]);
        if (outcome === "reply") {
          if (closed) return await endConnection(false, true);
          return retained.length > 0
            ? { open: true, input: retained }
            : { open: true };
        }
        if (outcome === "end") return await endConnection(false);
        if (outcome === "timeout") {
          return await endConnection(true, true);
        }

        const input = await takeNextRead();
        if (input.result.done) return await endConnection(false);
        retained.push(input);
        if (
          heldReads.length + retained.length >= PANEL_ORDINARY_QUEUE_MAX
        ) {
          return await endConnection(true);
        }
        scheduleNextRead();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function writeReply(
    bytes: Uint8Array,
    retireSignal?: AbortSignal,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          conn.close();
        } catch {
          // The peer may have closed at the same instant.
        }
        reject(new Error("panel reply write timed out"));
      }, writeTimeoutMs);
    });
    // A success the retirement race already admitted can still be mid-write
    // when the abort lands (blocked or partial socket write). Close the
    // socket so those bytes can never complete into the old session's
    // panel; the refusal path passes no signal and keeps delivering.
    let onRetired: (() => void) | undefined;
    const retired = retireSignal === undefined
      ? null
      : new Promise<never>((_, reject) => {
        onRetired = () => {
          try {
            conn.close();
          } catch {
            // The peer may have closed at the same instant.
          }
          reject(new Error("retired session reply aborted mid-write"));
        };
        if (retireSignal.aborted) onRetired();
        else retireSignal.addEventListener("abort", onRetired, { once: true });
      });
    try {
      await Promise.race(
        retired === null
          ? [writeAll(conn, bytes), timeout]
          : [writeAll(conn, bytes), timeout, retired],
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onRetired !== undefined && retireSignal !== undefined) {
        retireSignal.removeEventListener("abort", onRetired);
      }
    }
  }

  async function dispatch(
    req: JsonReply,
    started: number,
    signal?: AbortSignal,
    preset?: JsonReply,
    onCompleted?: () => void,
  ): Promise<void> {
    const cmd = String(req.cmd ?? "");
    let completed = false;
    try {
      // Cancelled work skips the run entirely: a queued media job whose
      // connection or session died before starting has nobody to answer.
      // A job that already started is different -- its reply is gated below
      // on the peer, not on this signal, so a retirement with a live socket
      // still delivers an answer and the panel's in-flight dedup clears.
      if (signal?.aborted) return;
      let res: JsonReply;
      try {
        // Background media work gets the dispatch signal so a disconnect or
        // retirement aborts the in-flight download; ordinary commands pass
        // undefined and keep their ordered, unabortable path.
        res = preset ?? await options.handle(req, signal);
        if (res.ok === false) {
          options.reportFailure(
            cmd,
            res.logText ?? res.error ?? "",
            false,
          );
          delete res.logText;
        }
      } catch (error) {
        options.reportFailure(cmd, error, false);
        res = { ok: false, error: options.refusalText(error) };
      }
      res.id = req.id;
      const bytes = encodeJsonReply(
        cmd,
        res,
        options.encodeError,
        options.reportEncodingFailure,
      );
      writing = writing.then(async () => {
        // The peer, not the retirement, decides whether a *refusal* can
        // land: aborted work still owes its request an answer on a live
        // socket, so the panel's in-flight dedup entry clears. A successful
        // result that outlived its session is dropped instead -- the next
        // session has no use for it, and the panel's download path delivers
        // any late success that still finds an openWanted entry.
        if (
          !closed && !connection.signal.aborted &&
          !(signal?.aborted && res.ok === true)
        ) {
          await writeReply(
            bytes,
            signal !== undefined && res.ok === true ? signal : undefined,
          );
          completed = true;
        }
      }).catch(() => {
        connection.abort();
        closed = true;
        reportClosed();
        void reader.cancel().catch(() => {});
      });
      await writing;
    } finally {
      if (completed) {
        options.recordTiming(`cmd.${cmd || "unknown"}`, now() - started);
        onCompleted?.();
      }
    }
  }

  try {
    while (true) {
      const fromLookAhead = heldReads.length > 0;
      const buffered = fromLookAhead
        ? heldReads.shift()!
        : await takeNextRead();
      if (buffered.result.done) break;
      if (closed) {
        admitBufferedOrdinary(buffered);
        break;
      }
      if (!fromLookAhead) scheduleNextRead();
      const line = buffered.result.value;
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const req = parsed as JsonReply;
      const cmd = String(req.cmd ?? "");
      const queuedAt = buffered.queuedAt;
      const stillValid = buffered.stillValid;
      if (options.backgroundCommands.has(cmd)) {
        const retirementSignal = options.backgroundSignal?.();
        const backgroundSignal = retirementSignal
          ? AbortSignal.any([connection.signal, retirementSignal])
          : connection.signal;
        // Bound each connection's contribution to the shared lane. An
        // explicit refusal keeps the request/reply contract intact. One
        // look-ahead read keeps EOF observable while its write is pending.
        if (background.size >= PANEL_MEDIA_QUEUE_MAX) {
          const refusal = trackBackground(
            dispatch(req, queuedAt, undefined, {
              ok: false,
              error: PANEL_MEDIA_BUSY_TEXT,
            }),
            cmd,
          );
          const waited = await waitForReplyOrInputEnd(refusal);
          if (!waited.open) break;
          if (waited.input) heldReads.push(...waited.input);
          continue;
        }
        const job = options.lane.tryRun(
          () =>
            stillValid()
              ? dispatch(req, queuedAt, backgroundSignal)
              : dispatch(req, queuedAt, backgroundSignal, {
                ok: false,
                error: options.staleRequestError ?? "request is stale",
              }),
          backgroundSignal,
          options.backgroundPriority?.(cmd) === true,
        );
        if (!job) {
          const refusal = trackBackground(
            dispatch(req, queuedAt, undefined, {
              ok: false,
              error: PANEL_MEDIA_BUSY_TEXT,
            }),
            cmd,
          );
          const waited = await waitForReplyOrInputEnd(refusal);
          if (!waited.open) break;
          if (waited.input) heldReads.push(...waited.input);
          continue;
        }
        // WorkLane retirement rejects jobs that have not started yet. The
        // socket itself can still be open (logout retires the process-wide
        // media lane), so turn that cancellation into the request's refusal.
        // Connection shutdown also rejects queued jobs with AbortError, but
        // there is deliberately no peer left to answer in that case.
        const answering = job.catch((error) => {
          if (
            error instanceof DOMException && error.name === "AbortError" &&
            !connection.signal.aborted && !closed
          ) {
            return dispatch(req, queuedAt, undefined, {
              ok: false,
              error: options.staleRequestError ?? "request is stale",
            });
          }
          throw error;
        });
        trackBackground(answering, cmd);
      } else {
        if (ordinaryDepth >= PANEL_ORDINARY_QUEUE_MAX) {
          if (
            options.messageCommands?.has(cmd) ||
            options.mustAdmitRequest?.(req)
          ) {
            // A side effect that has not entered the ordered lane is safe to
            // refuse immediately. The correlated reply lets the panel restore
            // its local state instead of turning a server-side queue limit
            // into an ambiguous operation. Waiting for this small reply also
            // applies socket backpressure before another frame is read.
            let refusalDelivered = false;
            const refusal = dispatch(
              req,
              queuedAt,
              undefined,
              { ok: false, error: PANEL_COMMAND_BUSY_TEXT },
              () => refusalDelivered = true,
            );
            // Do not read ahead while the refusal is written. Its own write
            // deadline closes a peer that is no longer consuming replies;
            // an open peer receives one outcome before the next frame enters
            // memory.
            await refusal;
            if (!refusalDelivered) {
              // A refusal only becomes the request's outcome after the whole
              // reply reaches the peer. If delivery fails, admit this one
              // request so reconnect reconciliation can find its token in
              // history. The queue grows by at most this single fallback.
              queueOrdinary(req, queuedAt, stillValid);
              break;
            }
            continue;
          }
          // The refusal is still the reply for the next ordinary request, so
          // place it behind every ordinary reply already accepted. Keep one
          // read pending for EOF, but apply backpressure before retaining any
          // more requests behind a stalled handler or socket write.
          ordinary = ordinary.then(() =>
            dispatch(req, queuedAt, undefined, {
              ok: false,
              error: PANEL_COMMAND_BUSY_TEXT,
            })
          ).catch((error) => {
            options.reportFailure(cmd, error, false);
          });
          const waited = await waitForReplyOrInputEnd(ordinary);
          if (!waited.open) break;
          if (waited.input) heldReads.push(...waited.input);
          continue;
        }
        // Reading an ordinary frame admits it. Do not bind it to the socket's
        // lifetime: after EOF the reply has nowhere to go, but a queued send
        // must still reach LINE so its request token can settle ambiguity.
        // It does remain bound to the session that admitted it: otherwise a
        // send queued behind a slow command could run after another panel
        // replaced the global client and publish under the wrong account.
        queueOrdinary(req, queuedAt, stillValid);
      }
    }
  } finally {
    connection.abort();
    closed = true;
    reportClosed();
    try {
      conn.close();
    } catch {
      // A write failure or overload path may already have closed it.
    }
    while (heldReads.length > 0) admitBufferedOrdinary(heldReads.shift()!);
    if (nextReadAvailable) {
      try {
        const outstanding = await takeNextRead();
        if (!outstanding.result.done) admitBufferedOrdinary(outstanding);
      } catch {
        // A reset has no completed frame to preserve.
      }
    }
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
