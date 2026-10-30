// Bounded preview paths; visible entries stay available until they leave view.
export const PREVIEW_CACHE_MAX = 2000;

/**
 * @param {Map<string, string>} cache
 * @param {string} id
 * @param {string} path
 * @param {Set<string>} visible
 * @returns {boolean} Whether the path was stored.
 */
export function putPreview(cache, id, path, visible) {
  if (cache.has(id)) {
    cache.delete(id);
    cache.set(id, path);
    return true;
  }
  const needed = Math.max(0, cache.size + 1 - PREVIEW_CACHE_MAX);
  const victims = [];
  if (needed) {
    for (const key of cache.keys()) {
      if (!visible.has(key)) victims.push(key);
      if (victims.length === needed) break;
    }
  }
  if (victims.length < needed) return false;
  for (const key of victims) cache.delete(key);
  cache.set(id, path);
  return true;
}
