// Tiny in-memory TTL cache. Concurrent callers share one in-flight call.
const store = new Map();

export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && hit.pending) return hit.pending;
  if (hit && hit.expires > Date.now()) return hit.value;
  const pending = Promise.resolve()
    .then(fn)
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .catch((err) => {
      store.delete(key);
      throw err;
    });
  store.set(key, { pending, expires: 0 });
  return pending;
}

export function invalidate(key) {
  store.delete(key);
}
