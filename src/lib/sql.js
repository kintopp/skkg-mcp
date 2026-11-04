// Per-database caches: prepared statements and values built once from the read-only data.

const caches = new WeakMap();

/** The value `build()` returns, built once per database handle and `key`. */
export function perDb(db, key, build) {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

export const stmt = (db, sql) => perDb(db, `stmt:${sql}`, () => db.prepare(sql));

export const placeholders = (n) => Array(n).fill('?').join(', ');
