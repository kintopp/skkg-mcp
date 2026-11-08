// Origin and Host checks of the HTTP endpoint, against DNS rebinding (after odeuropa-eokg-mcp).
//
// Origin: a missing Origin, "null", a scheme other than http(s), and loopback hosts pass; any
// other http(s) Origin must match the allowlist; one that does not parse is refused.
//
// Both lists are parsed at startup, and an entry that is no hostname throws: a bad entry would
// otherwise refuse every request while /health stays green.

const DEFAULT_WEB_HOSTS = ['claude.ai', '*.claude.ai', 'claude.com', '*.claude.com', 'chatgpt.com', '*.chatgpt.com'];

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** An entry as { host, wildcard }: its scheme, path, and port dropped, lowercased. */
function parseEntry(entry, variable, { glob }) {
  const host = entry.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  const wildcard = glob && host.startsWith('*.');
  const bare = wildcard ? host.slice(2) : host;
  if (!HOSTNAME.test(bare)) {
    throw new Error(`${variable}: "${entry}" is not a hostname${glob ? ' or a *.host glob' : ''}. ` +
      `Write bare hostnames, comma-separated, e.g. ${glob ? '"claude.ai,*.claude.ai"' : '"mcp.example.org"'}.`);
  }
  return { host: bare, wildcard };
}

const splitList = (raw) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Unset or blank: the defaults; "*": any; else a comma-separated list that replaces the defaults. */
export function parseAllowedOrigins(raw) {
  if (!raw || raw.trim() === '') return DEFAULT_WEB_HOSTS.map((e) => parseEntry(e, 'default origins', { glob: true }));
  if (raw.trim() === '*') return '*';
  return splitList(raw).map((e) => parseEntry(e, 'MCP_ALLOWED_ORIGINS', { glob: true }));
}

const matches = (hostname, { host, wildcard }) => (wildcard ? hostname.endsWith(`.${host}`) : hostname === host);

export function isAllowedOrigin(origin, allowlist) {
  if (origin === undefined || origin === 'null') return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (LOOPBACK_HOSTS.includes(u.hostname)) return true;
  if (allowlist === '*') return true;
  return allowlist.some((entry) => matches(u.hostname, entry));
}

/** The hosts the Host header may name; empty when none is configured, which turns the check off. */
export function allowedHosts(configured, railwayDomain) {
  const hosts = [
    ...splitList(configured).map((e) => parseEntry(e, 'MCP_ALLOWED_HOSTS', { glob: false }).host),
    ...splitList(railwayDomain).map((e) => parseEntry(e, 'RAILWAY_PUBLIC_DOMAIN', { glob: false }).host),
  ];
  return hosts.length ? [...hosts, ...LOOPBACK_HOSTS] : [];
}

export function isAllowedHost(hostHeader, hosts) {
  if (hosts.length === 0) return true;
  if (!hostHeader) return false;
  let hostname;
  try { hostname = new URL(`http://${hostHeader}`).hostname; } catch { return false; }
  return hosts.includes(hostname.toLowerCase());
}
