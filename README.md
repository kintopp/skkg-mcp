# skkg-mcp

[![MCP Protocol](https://img.shields.io/badge/MCP_Protocol-2026--07--28-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzIi8+PC9zdmc+)](https://modelcontextprotocol.io/specification/2026-07-28) [![MCP SDK](https://img.shields.io/badge/MCP_SDK-v2.4.0-blue?logo=npm&logoColor=white)](https://www.npmjs.com/package/@modelcontextprotocol/server) [![MCP Apps](https://img.shields.io/badge/MCP_Apps-v2.0.4-teal)](https://github.com/modelcontextprotocol/ext-apps)

skkg-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [*SKKG Sammlung digital*](https://digital.skkg.ch), the collection of the Stiftung für Kunst, Kultur und Geschichte (SKKG) in Winterthur. Bruno Stefanini founded the collection, which holds about 64,000 objects, including Swiss paintings of the 19th and 20th centuries, works on paper, furniture, arms, coins, and everyday objects. Its records include images, provenance chains, literature, exhibitions, and SKKG's own acquisitions with their prices.

With the server, a researcher can search the collection in natural language, count and cross-tabulate its objects, follow an object's provenance, and look at its images. The metadata is in German, so the model translates the user's search terms where needed and searches with German words and SKKG's vocabulary labels. Every result that contains an object or an image reports both kinds of rights, the licence of the photograph and the copyright status of the object.

The [Research and Infrastructure Support](https://rise.unibas.ch/en/) (RISE) group at the University of Basel developed this server. We want to explore the research opportunities, the methodological risks, and the technical problems of retrieving and analysing data with large language models. If you would like to collaborate with us on this, please [get in touch](mailto:rise@unibas.ch).

## Install

### Hosted (Streamable HTTP)

We have set up a hosted instance for testing, but its URL is not public yet. To host your own instance, see [docs/deploy.md](docs/deploy.md).

### Local (stdio)

Requirements: Node.js ≥ 24.22.1 < 25 (no native dependencies), and the server's SQLite database (see [Building the database](#building-the-database)).

```bash
git clone https://github.com/kintopp/skkg-mcp.git
cd skkg-mcp
npm install
```

Once you register the server, the MCP client starts it. In the client's configuration, point to the entry file, and use absolute paths for `command`, the script, and the database:

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

- **Claude Desktop:** the file is `claude_desktop_config.json` in `~/Library/Application Support/Claude/` (macOS) or `%APPDATA%\Claude\` (Windows). On Windows, double every backslash in the paths. Quit Claude Desktop fully and restart it after you edit the file.
- **Claude Code:** `claude mcp add skkg -e SKKG_DB_PATH=/absolute/path/to/skkg-YYYYMMDD.sqlite -- node /absolute/path/to/skkg-mcp/src/index.js`
- **ChatGPT desktop app and Codex:** add a `[mcp_servers.skkg]` table, with `command = "…"`, `args = […]`, and `env = { SKKG_DB_PATH = "…" }`, to `~/.codex/config.toml`. The file is TOML, not JSON.

To check the install without a client, run `npm test`, which uses a small test database.

### Skill

The model's guidance is part of the server, which serves it with `skkg_guide` one topic at a time, so the guidance always matches the tools. The skill in [skill/skkg/](skill/skkg/) is a short file that sends the model to `skkg_guide` and leaves room for your own notes. Installing it is optional. To install it in Claude, zip the `skkg` folder and follow [these instructions](https://claude.com/resources/tutorials/teach-claude-your-way-of-working-using-skills). For other clients, see their documentation.

## Tools

All tools are read only. Each tool returns a summary for people to read (`content[].text`) and the same result as structured data (`structuredContent`). A typical sequence of calls is:

1. `skkg_guide` before the first search;
2. `skkg_search_objects`, with `skkg_find_terms` for the labels its filters take;
3. `skkg_get_object` for one object;
4. `skkg_inspect_image` for the model to analyse an image, or `skkg_view_image` to show the image to the user.

| Tool | What it does |
|---|---|
| `skkg_guide` | How to search SKKG well, by topic: searching in German, ids, rights and privacy, provenance, data caveats, citing, and other sources. |
| `skkg_search_objects` | Searches objects by German keywords and by filters, e.g., creator, technique, material, object type, dates, exhibition, literature, and rights. |
| `skkg_get_object` | Returns one object by id or inventory number, with the sections you ask for: production, physical description, texts, acquisition, provenance, exhibitions, literature, related objects, and images. |
| `skkg_collection_stats` | Counts objects by one field, with the same filters as the search, and can cross-tabulate the counts by a second field. Each count comes with the search arguments that list its objects. |
| `skkg_find_terms` | Finds terms in SKKG's vocabularies by label, with their place in the hierarchy, their matches in GND, AAT, or Wikidata, and the filters that take them. |
| `skkg_search_provenance` | Searches provenance chains from before SKKG, and SKKG's own acquisitions by type, seller, date, and price. |
| `skkg_search_actors` | Searches persons and groups by name, dates, places, gender, nationality, and their role in the collection. |
| `skkg_search_literature` | Searches publications by title, author, publisher, year, type, series, ISBN, or the object they refer to. |
| `skkg_search_exhibitions` | Searches exhibitions by title, venue, year, type, status, or an object they showed. |
| `skkg_get_record` | Returns one record that is not an object, i.e., an actor, a publication, an exhibition, a provenance period, an object group, or an institution's address. |
| `skkg_inspect_image` | Returns an image, or a region of it, for the model to analyse. |
| `skkg_view_image` | Shows an object's images and their rights to the user in a zoomable viewer, in clients that support MCP Apps. |

A twelfth tool, `skkg_channel_probe`, is registered only when `SKKG_CHANNEL_PROBE=1` is set. It shows which part of a result a host passes to the model.

## How it works

The server reads one read-only SQLite database, which is built from the RDF dump that SKKG publishes. Searches, filters, and counts run on the database, so a question puts no load on SKKG's servers. Images come from SKKG's IIIF server (IIIF is a standard way of serving images from libraries, archives, and museums). `skkg_get_object` with `live: true` makes one request to SKKG's public API to check an object's rights, and it reports what differs from the dump.

The rules on personal data are enforced when the database is built. The build leaves out what SKKG does not show on its website, and it keeps SKKG's anonymisation of private owners ("Privatperson", "Unbekannte:r Eigentümer:in"). The build keeps its output only when its privacy checks pass, and the server has no tool for raw SQL or SPARQL queries.

SKKG also publishes its data as a knowledge graph through its own public SPARQL endpoint, `https://sparql.digital.skkg.ch/` (SPARQL is the query language for RDF data). A query editor is at [qlever.digital.skkg.ch](https://qlever.digital.skkg.ch/), and the documentation is in the [skkg-pipeline wiki](https://github.com/swiss-art-research-net/skkg-pipeline/wiki/6.-How-to-use-the-SKKG-Linked-Data). SKKG runs the endpoint, and it is separate from this server. Researchers who know SPARQL can use it for queries that this server's tools don't cover, e.g., sums of purchase prices, or queries that join SKKG's data with other knowledge graphs such as GND.

## Building the database

The database is not part of the repository, so you build it with the Python pipeline in `scripts/`, which needs [uv](https://docs.astral.sh/uv/). First, the pipeline loads SKKG's full RDF dump into an [Oxigraph](https://github.com/oxigraph/oxigraph) store. The dump is a Turtle file of about 190 MB compressed, and its source is configured in SARI's [skkg-pipeline](https://github.com/swiss-art-research-net/skkg-pipeline). Second, the pipeline builds the database from the store, which takes about three minutes.

```sh
uv run --with pyoxigraph python -I scripts/load_oxigraph.py latest-dump.ttl.gz data/oxigraph/full-YYYYMMDD
uv run --with pyoxigraph python -I scripts/build_db.py data/oxigraph/full-YYYYMMDD data/db/skkg-YYYYMMDD.sqlite
```

The loader refuses to write into a directory that already exists. The database takes the date of its data from the date in the store's name, or from the dump's HTTP headers if you save them to a file and pass the file with `--headers`. Treat the dump as untrusted input, and run Python with `-I`, as in the commands above.

## Configuration

The server reads these environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SKKG_DB_PATH` | unset | Path of the SQLite database. Every tool call needs it. |
| `SKKG_RESULT_CHAR_CEILING` | `150000` | The largest size of a tool result, in characters, counting the text and the structured data together. |
| `SKKG_IIIF_TIMEOUT_MS` | `30000` | Timeout of one request to SKKG's IIIF server. |
| `SKKG_API_TIMEOUT_MS` | `30000` | Timeout of one request to SKKG's API (`live: true`). |
| `SKKG_RESPONSE_CACHE_TTL_MS` | `300000` | How long images stay in the memory cache, which holds 64 MiB at most. `0` turns the cache off. Results of `live: true` are never cached. |
| `SKKG_STATS_SQL_RESTRICT_MAX` | `10000` | When at most this many objects match, `skkg_collection_stats` narrows its reads in SQL. You shouldn't need to change it. |
| `SKKG_LOG` | off | `1` writes one JSON line per tool call to stderr. |
| `SKKG_CHANNEL_PROBE` | off | `1` registers `skkg_channel_probe`. |

To host your own instance, run `npm run serve`, which serves stateless Streamable HTTP from `src/http.js`. [docs/deploy.md](docs/deploy.md) describes the setup, the HTTP variables, and the limits.

## Data caveats

- The data is a snapshot of SKKG's dump, and the database records its date. `live: true` checks one object's rights against the current API. A future version of the server will provide a way to update the data.
- Only a few hundred objects have a provenance chain from before SKKG acquired them, so SKKG's acquisition records answer most provenance questions.
- Most authors, editors, and publishers are recorded by name only, often with a separate record for each publication, so you search literature by name and not by id.
- In counts, an object is counted once for each of its values, so the counts can add up to more than the total.
- A few values that SKKG publishes are wrong, e.g., acquisition dates before the year 1000. The server returns them as published.
- Not every client shows the image viewer. When no viewer appears, the model links to the object's page on SKKG's website.

The guide's `data_caveats` topic gives details and examples.

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

`SKKG_FULL_DB=/path/to/skkg-YYYYMMDD.sqlite npm test` also runs the tests against the full database, and you should run it after every rebuild. `SKKG_LIVE=1 npm test` adds the few tests that call SKKG's live API and IIIF server. `npm test` fails when the committed viewer page is out of date, and in that case you run `npm run build:viewer` and commit the result.

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

[MIT](./LICENSE) © 2026 University of Basel. The licence covers the code and not SKKG's data.

SKKG publishes its metadata for free reuse under its Open Data Policy, on terms comparable to CC0. Image rights vary from image to image (CC0, CC BY 4.0, or ©), and the object's own copyright status is a separate matter. The server reports both with each result. Under SKKG's terms of use, users are responsible for respecting personality rights.
