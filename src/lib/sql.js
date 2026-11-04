// Prepared statements, cached per database handle.

const caches = new WeakMap();

export function stmt(db, sql) {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
}

export const placeholders = (n) => Array(n).fill('?').join(', ');
