# skkg-mcp

[![MCP Protocol](https://img.shields.io/badge/MCP_Protocol-2026--07--28-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzIi8+PC9zdmc+)](https://modelcontextprotocol.io/specification/2026-07-28) [![MCP SDK](https://img.shields.io/badge/MCP_SDK-v2.4.0-blue?logo=npm&logoColor=white)](https://www.npmjs.com/package/@modelcontextprotocol/server) [![MCP Apps](https://img.shields.io/badge/MCP_Apps-v2.0.4-teal)](https://github.com/modelcontextprotocol/ext-apps)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [*SKKG Sammlung digital*](https://digital.skkg.ch), the collection of the Stiftung für Kunst, Kultur und Geschichte (SKKG) in Winterthur. The collection was founded by Bruno Stefanini and holds about 64,000 objects: Swiss painting of the 19th and 20th centuries, works on paper, furniture, arms, coins, and everyday objects. Its records include images, SKKG's own acquisitions with their prices, provenance chains, literature, and exhibitions.

The server lets a researcher search the collection in natural language, count and cross-tabulate it, follow an object's provenance, and look at its images. The metadata is German, and the model searches with German words and SKKG's vocabulary labels translating the user's search terms into German where needed. Every result that contains an object or an image reports both of its rights: the licence of the photograph and the copyright status of the object.

This MCP server was developed by the [Research and Infrastructure Support](https://rise.unibas.ch/en/) (RISE) group at the University of Basel. We are particularly interested in exploring the research opportunities, methodological risks, and technical challenges posed by retrieving and analysing data with LLMs. If you are interested in collaborating with us in this area, please [get in touch](mailto:rise@unibas.ch).

## Install

### Remotely hosted (HTTP streaming)

A hosted instance serves has been created for testing. Its URL is not public yet. To host your own, see [docs/deploy.md](docs/deploy.md).

### Local (stdio)

Requirements: Node.js ≥ 24.22.1 < 25 (no native dependencies), and the server's SQLite database (see [Building the database](#building-the-database)).

```bash
git clone https://github.com/kintopp/skkg-mcp.git
cd skkg-mcp
npm install
```

The MCP client starts the server itself once it is registered. Point the client at the entry file, using **absolute paths** for `command`, the script, and the database:

```jsonc
{
  "mcpServers": {
    "skkg": {
      "command": "/absolute/path/to/bin/node",
      "args": ["/absolute/path/to/skkg-mcp/src/index.js"],
      "env": { "SKKG_DB_PATH": "/absolute/path/to/skkg-YYYYMMDD.sqlite" }
    }
  }
}
```

- **Claude Desktop:** the file is `claude_desktop_config.json` in `~/Library/Application Support/Claude/` (macOS) or `%APPDATA%\Claude\` (Windows). On Windows, double every backslash in the paths. Fully quit and restart Claude Desktop after editing it.
- **Claude Code:** `claude mcp add skkg -e SKKG_DB_PATH=/absolute/path/to/skkg-YYYYMMDD.sqlite -- node /absolute/path/to/skkg-mcp/src/index.js`
- **ChatGPT desktop app and Codex:** add a `[mcp_servers.skkg]` table with `command = "…"`, `args = […]`, and `env = { SKKG_DB_PATH = "…" }` to `~/.codex/config.toml`. The format is TOML, not JSON.

To check the install without a client, run `npm test`, which uses a small fixture database.

### Skill

The model's guidance lives in the server, which serves it with `skkg_guide`, one topic at a time, so it always matches the tools. The skill in [skill/skkg/](skill/skkg/) is a stub that sends the model to `skkg_guide` and holds a place for your own notes. Installing it is optional. To install it in Claude, zip the `skkg` folder and follow [these instructions](https://claude.com/resources/tutorials/teach-claude-your-way-of-working-using-skills); for other clients, consult their documentation.

## Tools

All tools are read-only. Each returns a human-readable summary (`content[].text`) and structured data (`structuredContent`). A typical flow:

1. `skkg_guide` before the first search;
2. `skkg_search_objects`, with `skkg_find_terms` for the labels its filters take;
3. `skkg_get_object` for one object;
4. `skkg_inspect_image` to look at its image yourself, or `skkg_view_image` to show it to the user.

| Tool | What it does |
|---|---|
| `skkg_guide` | How to search SKKG well, by topic: search in German, ids, rights and privacy, provenance, data caveats, citing, other sources. |
| `skkg_search_objects` | Search objects by German keywords and filters: creator, technique, material, object type, dates, exhibition, literature, rights, and more. |
| `skkg_get_object` | One object by id or inventory number, with the sections you ask for: production, physical description, texts, acquisition, provenance, exhibitions, literature, related objects, images. |
| `skkg_collection_stats` | Count objects by one dimension, with the filters of the search, and cross-tabulate by a second. Each bucket carries the search arguments that list its objects. |
| `skkg_find_terms` | Find terms of SKKG's vocabularies by label, with their hierarchy, their matches in GND, AAT, or Wikidata, and the filters that take them. |
| `skkg_search_provenance` | Search provenance chains before SKKG and SKKG's own acquisitions (type, seller, date, price). |
| `skkg_search_actors` | Search persons and groups by name, dates, places, gender, nationality, and their role in the collection. |
| `skkg_search_literature` | Search publications by title, author, publisher, year, type, series, ISBN, or the object they refer to. |
| `skkg_search_exhibitions` | Search exhibitions by title, venue, year, type, status, or an object they showed. |
| `skkg_get_record` | One record other than an object: an actor, publication, exhibition, provenance period, object group, or institution's address. |
| `skkg_inspect_image` | An image, or a region of it, for the model's own analysis. |
| `skkg_view_image` | Shows an object's images to the user in a zoomable viewer with their rights, in clients that support MCP Apps. |

A twelfth tool, `skkg_channel_probe`, is registered only with `SKKG_CHANNEL_PROBE=1`. It shows which result channel a host passes to the model.

## How it works

The server reads one read-only SQLite database, built from SKKG's published RDF dump. The database handles search, filters, and counts, so a question puts no load on SKKG's servers. Images come from SKKG's IIIF server. `skkg_get_object` with `live: true` checks an object's rights against SKKG's public API, with one request, and reports what differs from the dump.

The build of the database enforces the rules on personal data: it leaves out what SKKG does not show on its website, and it keeps SKKG's anonymisation of private owners ("Privatperson", "Unbekannte:r Eigentümer:in"). The build keeps its output only when its privacy checks pass. The server has no raw SQL or SPARQL tool.

SKKG also publishes its knowledge graph through its own public SPARQL endpoint, `https://sparql.digital.skkg.ch/`, with a query editor at [qlever.digital.skkg.ch](https://qlever.digital.skkg.ch/) and documentation in the [skkg-pipeline wiki](https://github.com/swiss-art-research-net/skkg-pipeline/wiki/6.-How-to-use-the-SKKG-Linked-Data). The endpoint is SKKG's and is unrelated to this server. Researchers who know SPARQL can use it for queries outside this server's fixed tools, such as sums of purchase prices or queries that join other knowledge graphs, for example GND.

## Building the database

The database is not part of the repository. The Python pipeline in `scripts/` loads SKKG's full RDF dump (Turtle, about 190 MB compressed; its source is configured in SARI's [skkg-pipeline](https://github.com/swiss-art-research-net/skkg-pipeline)) into an [Oxigraph](https://github.com/oxigraph/oxigraph) store, then builds the database from the store in about three minutes. It needs [uv](https://docs.astral.sh/uv/).

```sh
uv run --with pyoxigraph python -I scripts/load_oxigraph.py latest-dump.ttl.gz data/oxigraph/full-YYYYMMDD
uv run --with pyoxigraph python -I scripts/build_db.py data/oxigraph/full-YYYYMMDD data/db/skkg-YYYYMMDD.sqlite
```

The loader refuses an existing directory. The database takes its data date from the date in the store's name, or from the dump's HTTP headers saved to a file and passed with `--headers`. Treat the dump as untrusted input: run Python with `-I`, as above.

## Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `SKKG_DB_PATH` | unset | Path of the SQLite database. Required for any tool call. |
| `SKKG_RESULT_CHAR_CEILING` | `150000` | Upper bound on a tool result's size in characters, both channels together. |
| `SKKG_IIIF_TIMEOUT_MS` | `30000` | Timeout of one request to SKKG's IIIF server. |
| `SKKG_API_TIMEOUT_MS` | `30000` | Timeout of one request to SKKG's API (`live: true`). |
| `SKKG_RESPONSE_CACHE_TTL_MS` | `300000` | How long images are kept in memory (64 MiB at most). `0` turns the cache off. `live: true` is never cached. |
| `SKKG_STATS_SQL_RESTRICT_MAX` | `10000` | Up to this many matching objects, `skkg_collection_stats` restricts its reads in SQL. A tuning knob; leave it alone. |
| `SKKG_LOG` | off | `1` writes one JSON line per tool call to stderr. |
| `SKKG_CHANNEL_PROBE` | off | `1` registers `skkg_channel_probe`. |

To host your own instance, run `npm run serve`, which serves stateless Streamable HTTP from `src/http.js`. Setup, HTTP variables, and limits are in [docs/deploy.md](docs/deploy.md).

## Data caveats

- The data is a snapshot of SKKG's dump, dated in the database; `live: true` checks one object's rights against the current API. A future version of the server will provide a way to update the dataset.
- Only a few hundred objects have a provenance chain before SKKG. Most provenance questions are answered by SKKG's acquisitions.
- Most authors, editors, and publishers are recorded by name only, often with one record per publication, so literature is searched by name, not by id.
- In counts, an object counts once per value, so buckets can add up to more than the total.
- A few values SKKG publishes are wrong, such as acquisition dates before the year 1000. The server reproduces them as published.
- Not every client shows the image viewer. Where none appears, the model links the object's page on SKKG's website.

The guide's `data_caveats` topic has details and examples.

## Development

```bash
npm start                # serve over stdio manually (waits for an MCP client; Ctrl-C to stop)
npm run serve            # serve over stateless Streamable HTTP
npm run lint             # ESLint (flat config, Node 24)
npm test                 # offline suite, on the fixture database
npm run mutate           # mutation check of the tests
npm run build:viewer     # rebuild the committed viewer page after editing apps/image-viewer/
npm run dev:viewer       # preview the image viewer in a browser
npm run inspector        # open the MCP Inspector against the server
```

`SKKG_FULL_DB=/path/to/skkg-YYYYMMDD.sqlite npm test` also runs the tests against the full database; run them after every rebuild. `SKKG_LIVE=1 npm test` adds the few tests that call SKKG's live API and IIIF server. `npm test` fails if the viewer page is stale; rerun `npm run build:viewer` and commit the result.

```
src/
  index.js, http.js   entry points (stdio, Streamable HTTP); both call createServer
  server.js           createServer and tool registration
  config.js           constants and environment variables
  guide.md            the model's guidance, served by skkg_guide
  tools/              one file per tool, with shared schemas and text renderers
  lib/                helpers: ids, paging, size limits, filters, images, rights
  apps/               the built viewer page (source in apps/image-viewer/)
scripts/              the Python data pipeline and its tests
test/                 offline tests, with a fixture database
```

## Citation

If you use skkg-mcp in your research, please cite it as follows:

**APA (7th ed.)**

> Bosse, A. (2026). *skkg-mcp* (Version 0.1.0) [Software]. Research and Infrastructure Support (RISE), University of Basel. https://github.com/kintopp/skkg-mcp

**BibTeX**
```bibtex
@software{bosse_2026_skkg_mcp,
  author    = {Bosse, Arno},
  title     = {{skkg-mcp}},
  year      = {2026},
  version   = {0.1.0},
  publisher = {Research and Infrastructure Support (RISE), University of Basel},
  url       = {https://github.com/kintopp/skkg-mcp},
  orcid     = {0000-0003-3681-1289},
  note      = {Developed with Claude Code (Anthropic, \url{https://www.anthropic.com})}
}
```

Cite the data you report separately, as SKKG Sammlung digital, with the record's link on `digital.skkg.ch`.

## License

[MIT](./LICENSE) © 2026 University of Basel. The licence covers the code, not SKKG's data.

SKKG publishes its metadata for free reuse, comparable to CC0, under its Open Data Policy. Image rights vary per image (CC0, CC BY 4.0, or ©), and the object's own copyright status is separate; the server reports both with each result. Users are responsible for respecting personality rights, as SKKG's terms of use require.
