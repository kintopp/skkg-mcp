// Origin and Host checks of the HTTP endpoint, against DNS rebinding (after odeuropa-eokg-mcp).
//
// Origin: a missing Origin, "null", a scheme other than http(s), and loopback hosts pass; any
// other http(s) Origin must match the allowlist; one that does not parse is refused.

const DEFAULT_WEB_HOSTS = [
  /^claude\.ai$/i, /^.+\.claude\.ai$/i,
  /^claude\.com$/i, /^.+\.claude\.com$/i,
  /^chatgpt\.com$/i, /^.+\.chatgpt\.com$/i,
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function entryToHostPattern(entry) {
  let host = entry;
  try { host = new URL(entry).hostname; } catch { /* a bare hostname or glob */ }
  const wildcard = host.startsWith('*.');
  const escaped = (wildcard ? host.slice(2) : host).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(wildcard ? `^.+\\.${escaped}$` : `^${escaped}$`, 'i');
}

/** Unset or blank: the defaults; "*": any; else a comma-separated list that replaces the defaults. */
export function parseAllowedOrigins(raw) {
  if (!raw || raw.trim() === '') return [...DEFAULT_WEB_HOSTS];
  if (raw.trim() === '*') return '*';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map(entryToHostPattern);
}

export function isAllowedOrigin(origin, allowlist) {
  if (origin === undefined || origin === 'null') return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (LOOPBACK_HOSTS.has(u.hostname)) return true;
  if (allowlist === '*') return true;
  return allowlist.some((re) => re.test(u.hostname));
}

/** The hosts the Host header may name; empty when none is configured, which turns the check off. */
export function allowedHosts(configured, railwayDomain) {
  const hosts = [...(configured ?? '').split(','), railwayDomain ?? ''].map((s) => s.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? [...hosts, ...LOOPBACK_HOSTS] : [];
}

export function isAllowedHost(hostHeader, hosts) {
  if (hosts.length === 0) return true;
  if (!hostHeader) return false;
  let hostname;
  try { hostname = new URL(`http://${hostHeader}`).hostname; } catch { return false; }
  return hosts.includes(hostname.toLowerCase());
}
