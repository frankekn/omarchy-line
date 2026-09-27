/**
 * Ordered map with bounded concurrency.
 *
 * The decrypt-heavy loops (chat-list refresh, history conversion) used to
 * await each item in turn; the crypto per item dominates the wall time and
 * the items are independent, so a bounded pool turns N sequential awaits
 * into ceil(N/limit) rounds without reordering anything: results land at
 * their input index, never in completion order.
 *
 * Rejections propagate: the first failing call rejects the whole pool and
 * in-flight siblings still settle (their results are discarded). Callers
 * that must not pay for work a dead session no longer needs pass a guard --
 * it runs before each item is scheduled and before each is started, so an
 * aborted run stops admitting new work early. A guard-cancelled run
 * resolves to null rather than a holey array: the caller owes the
 * cancellation an explicit answer, never a silent partial result.
 */
export function pooledMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  guard?: () => boolean,
): Promise<R[] | null> {
  const width = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;
  let cancelled = false;
  const worker = async (): Promise<void> => {
    while (true) {
      if (guard && !guard()) {
        cancelled = true;
        return;
      }
      const at = next++;
      if (at >= items.length) return;
      if (guard && !guard()) {
        cancelled = true;
        return;
      }
      results[at] = await fn(items[at], at);
    }
  };
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(width, items.length); i++) {
    workers.push(worker());
  }
  return Promise.all(workers).then(() => (cancelled ? null : results));
}
