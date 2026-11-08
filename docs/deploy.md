# Hosted deployment

`src/http.js` serves the same tools over stateless Streamable HTTP, so claude.ai and other web clients can use them without a local install. `src/index.js` stays the stdio entry. The server holds no credentials and only reads: its database, SKKG's public IIIF server, and SKKG's public API (`live: true`).

The endpoint is `POST /mcp`. `GET /health` returns `{ status, server, version, commit, node, database }`, with `data_as_of` and `schema_version` when the database is open. It answers 200 without a database too, and the reason is in the log. `GET` and `DELETE` on `/mcp` answer 405, because there are no sessions.

The endpoint is for SKKG's staff only. Do not publish its URL.

## Run locally

```sh
SKKG_DB_PATH=data/db/skkg-20261028.sqlite npm run serve            # listens on 0.0.0.0:3000
PORT=8080 SKKG_DB_PATH=data/db/skkg-20261028.sqlite npm run serve
```

Point the inspector at `http://localhost:3000/mcp` with `npx @modelcontextprotocol/inspector`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SKKG_DB_PATH` | unset | Path of the database. On Railway `/data/skkg-YYYYMMDD.sqlite`. |
| `PORT` | `3000` | Listen port (Railway sets it). `0` picks a free port. |
| `MCP_ALLOWED_ORIGINS` | claude.ai, claude.com, chatgpt.com and their subdomains | Comma-separated hostnames or `*.host` globs; a scheme, port, or path is dropped. **Replaces** the defaults, so list them again to add one. `*` alone turns the check off. A mismatch is 403. An entry that is no hostname (another `*`, a space) stops the server at startup with a log line naming it, so the deploy fails and the previous one keeps serving. |
| `MCP_ALLOWED_HOSTS` | unset | Comma-separated hostnames the `Host` header must match; a scheme, port, or path is dropped. `RAILWAY_PUBLIC_DOMAIN` and localhost are added. With neither set, the Host check is off. An entry that is no hostname, a glob included, stops the server at startup as above. |
| `SKKG_HTTP_RESPONSE_TIMEOUT_MS` | 30 s more than the slower of `SKKG_IIIF_TIMEOUT_MS` and `SKKG_API_TIMEOUT_MS` (`60000`) | Wall-clock limit per request to `/mcp`, then 504. If you set it, keep it above both timeouts. |
| `SKKG_HTTP_MAX_INFLIGHT` | `16` | Concurrent requests to `/mcp`. More get 503 with `Retry-After: 5`. |
| `SKKG_IIIF_TIMEOUT_MS`, `SKKG_API_TIMEOUT_MS` | `30000` | Timeouts of one request to SKKG's IIIF server and API. |
| `SKKG_RESPONSE_CACHE_TTL_MS` | `300000` | How long IIIF images are kept in memory (64 MiB at most). `0` turns the cache off. `live: true` is never cached. |
| `SKKG_RESULT_CHAR_CEILING` | `150000` | Size limit of one result, both channels together. |

Every tool call writes one JSON line to stderr, with the tool, the latency, and whether it succeeded, but not its input or error text, which are user content. The Origin check lets through a missing Origin, `null`, schemes other than http(s), and loopback. Requests over 1 MiB get 413, and compressed request bodies 415. Railpack installs the Node version in `.nvmrc`.

## Railway

The service `skkg-mcp` in the project `endearing-warmth` runs `node src/http.js` with `/health` as its health check, one replica in `europe-west4-drams3a`, a 1 GB memory limit, and the 5 GB volume `skkg-mcp-volume` at `/data`. Its configuration is `.railway/railway.ts`, which declares the partial `skkg-mcp`, so it never touches the other services of the project.

- `railway config plan` is read only. Stop on any change to another service, a volume, or a mount.
- `railway config apply --yes` applies it and starts a deployment from `main` at once. Claude's auto mode blocks it, so run it yourself (`! railway config apply --yes` in Claude Code).
- Code deploys from GitHub on every push to `main` that touches `src/`, `package.json`, or `package-lock.json`. A push of notes, tests, or scripts does not redeploy.
- Variables are set by hand and stay out of the file: `railway variable set SKKG_DB_PATH=/data/skkg-20261028.sqlite -s skkg-mcp`. Setting one redeploys the service; add `--skip-deploys` to set it without, and redeploy later with `railway redeploy -s skkg-mcp --yes`.
- The public URL comes from `railway domain -s skkg-mcp`.

## The database on the volume

The database is never in the repository. Upload the local copy by hand; the server downloads nothing. ssh needs a running container, so the first deploy starts without a database: `/health` answers 200 with `database: "unavailable"`, and tool calls fail until the upload is done and the service is redeployed.

`railway ssh config --dry-run -p <project id> -s skkg-mcp -e production` prints the host and the user for plain ssh. Then:

```sh
ssh <instance>@ssh.railway.com 'cat > /data/skkg-20261028.sqlite.part' < data/db/skkg-20261028.sqlite
ssh <instance>@ssh.railway.com 'sha256sum /data/skkg-20261028.sqlite.part'
shasum -a 256 data/db/skkg-20261028.sqlite                      # must match
ssh <instance>@ssh.railway.com 'mv /data/skkg-20261028.sqlite.part /data/skkg-20261028.sqlite'
```

The upload runs at about 5 MB/s, so 421 MB takes about 90 s. Claude's auto mode blocks ssh to production, so run these yourself.

For a new database, upload it under its own name beside the old one, check its checksum, point `SKKG_DB_PATH` at it, and redeploy. Delete the old file once `/health` reports the new `data_as_of`. Upload the whole file before pointing at it: the server checks the schema version when it opens the database, not whether the file is complete.

## Add it to claude.ai

Settings, Connectors, Add custom connector. Use the URL `https://<domain>/mcp` and no authentication.

## Limits

- claude.ai gives up on a tool call after 240 s. The server cuts a request at 60 s; the slowest call waits for one IIIF or API request of at most 30 s.
- The server is stateless: no session survives between requests.
- `skkg_view_image` opens an MCP App viewer and needs a host that shows them.
