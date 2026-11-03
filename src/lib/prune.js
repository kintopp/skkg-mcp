// Recursively drop empty values ('', null, undefined, [], {}) so results stay small,
// while keeping `false` and `0`. Callers re-attach keys they guarantee, e.g. `id`.
export function prune(value) {
  if (Array.isArray(value)) {
    const arr = value.map(prune).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === '' || value === null || value === undefined) return undefined;
  return value;
}
