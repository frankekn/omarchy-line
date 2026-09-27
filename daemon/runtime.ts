/** Small runtime primitives shared by the daemon's long-lived work. */

interface WorkWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  priority: boolean;
}

export class WorkLane {
  readonly limit: number;
  readonly maxPending: number;
  readonly reservedForPriority: number;
  #active = 0;
  #ordinaryActive = 0;
  #waiters: WorkWaiter[] = [];

  constructor(limit: number, maxPending = 256, reservedForPriority = 0) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("work lane limit must be a positive integer");
    }
    if (!Number.isInteger(maxPending) || maxPending < 0) {
      throw new RangeError(
        "work lane pending limit must be a non-negative integer",
      );
    }
    if (
      !Number.isInteger(reservedForPriority) || reservedForPriority < 0 ||
      reservedForPriority >= limit
    ) {
      throw new RangeError(
        "reserved priority slots must be below the lane limit",
      );
    }
    this.limit = limit;
    this.maxPending = maxPending;
    this.reservedForPriority = reservedForPriority;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#waiters.length;
  }

  tryRun<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
    priority = false,
  ): Promise<T> | null {
    if (!this.#canStart(priority) && this.#waiters.length >= this.maxPending) {
      return null;
    }
    return this.run(work, signal, priority);
  }

  async run<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
    priority = false,
  ): Promise<T> {
    if (signal?.aborted) throw signal.reason ?? abortError();
    if (!this.#canStart(priority) && this.#waiters.length >= this.maxPending) {
      throw new RangeError("work lane pending limit reached");
    }
    if (this.#canStart(priority)) {
      this.#active++;
      if (!priority) this.#ordinaryActive++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: WorkWaiter = {
          resolve,
          reject,
          signal,
          priority,
        };
        if (signal) {
          waiter.onAbort = () => {
            const at = this.#waiters.indexOf(waiter);
            if (at >= 0) this.#waiters.splice(at, 1);
            reject(signal.reason ?? abortError());
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        this.#waiters.push(waiter);
      });
    }
    try {
      if (signal?.aborted) throw signal.reason ?? abortError();
      return await work();
    } finally {
      this.#release(priority);
    }
  }

  /** Rejects queued work while active operations remain globally accounted. */
  retire(): Promise<void> {
    while (this.#waiters.length) {
      const waiter = this.#waiters.shift();
      if (!waiter) continue;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(abortError());
    }
    // Admission reopens immediately so logout cannot hang on an uncooperative
    // transfer. New work queues behind active operations, whose slots are not
    // released until their underlying promises settle.
    return Promise.resolve();
  }

  #canStart(priority: boolean): boolean {
    return this.#active < this.limit &&
      (priority ||
        this.#ordinaryActive < this.limit - this.reservedForPriority);
  }

  #release(priority: boolean): void {
    // Return this job's slot before handing one to a waiter. The transfer is
    // fully reflected in #active before resolve() schedules the continuation,
    // even when several jobs finish in the same event-loop turn.
    this.#active--;
    if (!priority) this.#ordinaryActive--;
    for (;;) {
      let nextAt = this.#waiters.findIndex((waiter) =>
        waiter.priority && !waiter.signal?.aborted && this.#canStart(true)
      );
      if (nextAt < 0) {
        nextAt = this.#waiters.findIndex((waiter) =>
          !waiter.signal?.aborted && this.#canStart(waiter.priority)
        );
      }
      if (nextAt < 0) return;
      const next = this.#waiters.splice(nextAt, 1)[0];
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(next.signal.reason ?? abortError());
        continue;
      }
      this.#active++;
      if (!next.priority) this.#ordinaryActive++;
      next.resolve();
      return;
    }
  }
}

function abortError(): DOMException {
  return new DOMException("Work cancelled", "AbortError");
}

export interface LatencyMetric {
  samples: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

const FIXED_LATENCY_KEYS = new Set(["chats.refresh", "state.write"]);

/** A bounded rolling window; it never causes a state write by itself. */
export class LatencyTracker {
  readonly sampleLimit: number;
  readonly keyLimit: number;
  #values = new Map<string, number[]>();

  constructor(sampleLimit = 64, keyLimit = 32) {
    if (!Number.isInteger(sampleLimit) || sampleLimit < 1) {
      throw new RangeError("latency sample limit must be a positive integer");
    }
    if (!Number.isInteger(keyLimit) || keyLimit < FIXED_LATENCY_KEYS.size) {
      throw new RangeError("latency key limit must reserve the fixed metrics");
    }
    this.sampleLimit = sampleLimit;
    this.keyLimit = keyLimit;
  }

  record(key: string, elapsedMs: number): void {
    if (
      !key || key.length > 64 || !Number.isFinite(elapsedMs) || elapsedMs < 0
    ) return;
    let values = this.#values.get(key);
    if (!values) {
      if (this.#values.size >= this.keyLimit) {
        const evictable = [...this.#values.keys()].find((existing) =>
          !FIXED_LATENCY_KEYS.has(existing)
        );
        if (evictable !== undefined) this.#values.delete(evictable);
        else return;
      }
      values = [];
      this.#values.set(key, values);
    }
    values.push(elapsedMs);
    if (values.length > this.sampleLimit) values.shift();
  }

  snapshot(): Record<string, LatencyMetric> {
    const out = Object.create(null) as Record<string, LatencyMetric>;
    for (const [key, values] of this.#values) {
      if (!values.length) continue;
      const sorted = values.slice().sort((a, b) => a - b);
      out[key] = {
        samples: values.length,
        lastMs: rounded(values[values.length - 1]),
        p50Ms: rounded(percentile(sorted, 0.50)),
        p95Ms: rounded(percentile(sorted, 0.95)),
        maxMs: rounded(sorted[sorted.length - 1]),
      };
    }
    return out;
  }
}

export interface SizeMetric {
  samples: number;
  last: number;
  p50: number;
  p95: number;
  max: number;
}

/**
 * The same bounded rolling window as LatencyTracker, for byte counts. Deliberately
 * a separate class rather than a LatencyTracker key: bytes are not milliseconds,
 * so publishing them through it would stamp a `Ms` suffix on them, and one
 * published subject needs no key map. Shares the percentile/rounding helpers so
 * the two windows cannot drift apart statistically.
 */
export class SizeTracker {
  readonly sampleLimit: number;
  #values: number[] = [];

  constructor(sampleLimit = 64) {
    if (!Number.isInteger(sampleLimit) || sampleLimit < 1) {
      throw new RangeError("size sample limit must be a positive integer");
    }
    this.sampleLimit = sampleLimit;
  }

  record(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.#values.push(bytes);
    if (this.#values.length > this.sampleLimit) this.#values.shift();
  }

  /** Null until the first sample; a half-formed block must not reach the file. */
  snapshot(): SizeMetric | null {
    if (!this.#values.length) return null;
    const sorted = this.#values.slice().sort((a, b) => a - b);
    return {
      samples: this.#values.length,
      last: rounded(this.#values[this.#values.length - 1]),
      p50: rounded(percentile(sorted, 0.50)),
      p95: rounded(percentile(sorted, 0.95)),
      max: rounded(sorted[sorted.length - 1]),
    };
  }
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}
