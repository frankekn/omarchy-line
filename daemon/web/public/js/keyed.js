// Plan keyed list changes without touching the DOM. Keys must be unique.
export function planKeyChanges(before, after) {
  const positions = new Map(before.map((key, index) => [key, index]));
  const wanted = new Set(after);
  const removed = before.filter((key) => !wanted.has(key));
  const added = after.filter((key) => !positions.has(key));
  const retained = after.filter((key) => positions.has(key));

  // The common case is an append or removal: existing nodes stay in order.
  let ordered = true;
  for (let i = 1; i < retained.length; i++) {
    if (positions.get(retained[i - 1]) > positions.get(retained[i])) {
      ordered = false;
      break;
    }
  }
  if (ordered) return { removed, added, moved: [] };

  // Leave a longest increasing subsequence in place. All other retained keys
  // need to move, so a reorder disturbs as few existing nodes as possible.
  const tails = [], tailIndexes = [], previous = [];
  for (let i = 0; i < retained.length; i++) {
    const position = positions.get(retained[i]);
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < position) low = middle + 1;
      else high = middle;
    }
    tails[low] = position;
    previous[i] = low ? tailIndexes[low - 1] : -1;
    tailIndexes[low] = i;
  }
  const stationary = new Set();
  for (let i = tailIndexes[tails.length - 1]; i >= 0; i = previous[i]) {
    stationary.add(retained[i]);
  }
  return {
    removed,
    added,
    moved: retained.filter((key) => !stationary.has(key)),
  };
}
