export type RefreshFailureReason =
  | "token_expired"
  | "network"
  | "restricted"
  | "unknown";

export interface RefreshHealth {
  at: number;
  failures: number;
  reason?: RefreshFailureReason;
}

export interface RefreshHealthOptions {
  writeState: () => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

/** Owns refresh health and writes state only on the first failed round. */
export class RefreshHealthState {
  #value: RefreshHealth | null = null;
  readonly #writeState: () => void;
  readonly #log: (message: string) => void;
  readonly #error: (message: string) => void;

  constructor(options: RefreshHealthOptions) {
    this.#writeState = options.writeState;
    this.#log = options.log ?? console.log;
    this.#error = options.error ?? console.error;
  }

  get value(): RefreshHealth | null {
    return this.#value;
  }

  succeed(now: number = Date.now()): void {
    const failed = this.#value?.failures ?? 0;
    this.#value = { at: now, failures: 0 };
    if (failed > 0) {
      this.#log(`[chats] refresh recovered after ${failed} failures`);
    }
  }

  fail(reason: RefreshFailureReason, now: number = Date.now()): void {
    const previous = this.#value ?? { at: 0, failures: 0 };
    this.#value = {
      at: previous.at,
      failures: previous.failures + 1,
      reason,
    };
    if (previous.failures === 0) {
      this.#error(
        `[chats] refresh failing since ${
          new Date(now).toISOString()
        } (${reason})`,
      );
      this.#writeState();
    }
  }

  clear(): void {
    this.#value = null;
  }
}

type SystemTimerHandle = ReturnType<typeof setTimeout>;
type SetTimer<Handle> = (callback: () => void, delay: number) => Handle;
type ClearTimer<Handle> = (handle: Handle) => void;

/** The real event-loop timers, for callers that do not bring their own. */
export const systemTimers: {
  setTimer: SetTimer<SystemTimerHandle>;
  clearTimer: ClearTimer<SystemTimerHandle>;
} = {
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (handle) => clearTimeout(handle),
};

interface RefreshDebouncerBaseOptions {
  run: () => void;
  quietMs?: number;
  maximumMs?: number;
}

export type RefreshDebouncerOptions<Handle = SystemTimerHandle> =
  & RefreshDebouncerBaseOptions
  & { setTimer: SetTimer<Handle>; clearTimer: ClearTimer<Handle> };

/** Coalesces push bursts while guaranteeing a bounded reconciliation delay. */
export class RefreshDebouncer<Handle = SystemTimerHandle> {
  #timer: Handle | null = null;
  #startedAt = 0;
  readonly #run: () => void;
  readonly #quietMs: number;
  readonly #maximumMs: number;
  readonly #setTimer: SetTimer<Handle>;
  readonly #clearTimer: ClearTimer<Handle>;

  constructor(options: RefreshDebouncerOptions<Handle>) {
    this.#run = options.run;
    this.#quietMs = options.quietMs ?? 500;
    this.#maximumMs = options.maximumMs ?? 2_000;
    // A non-finite maximum breaks the bounded-delay promise: remaining never
    // runs out, so pushes arriving faster than quietMs re-arm the quiet
    // timer forever and the debounced run never happens.
    if (!Number.isFinite(this.#maximumMs)) {
      throw new Error("RefreshDebouncer maximumMs must be finite");
    }
    // Timers are always injected. With no overrides to bind Handle to, a
    // generic default implementation could only bridge its concrete return
    // type to Handle through a double assertion -- the escape hatch this
    // file no longer contains.
    this.#setTimer = options.setTimer;
    this.#clearTimer = options.clearTimer;
  }

  // The default clock is monotonic: a wall clock that steps back (NTP
  // correction, resume) would grow `remaining` without bound and re-arm
  // the quiet timer forever -- the same never-runs failure a non-finite
  // maximum causes. Callers may still pass explicit values for tests.
  schedule(now: number = performance.now()): void {
    if (this.#timer === null) this.#startedAt = now;
    else this.#clearTimer(this.#timer);
    const remaining = Math.max(0, this.#maximumMs - (now - this.#startedAt));
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.#startedAt = 0;
      this.#run();
    }, Math.min(this.#quietMs, remaining));
  }

  clear(): void {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#startedAt = 0;
  }
}
