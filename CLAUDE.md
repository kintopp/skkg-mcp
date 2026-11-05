# skkg-mcp

## What this is

A stdio MCP server over the SKKG Sammlung digital collection (Stiftung für Kunst, Kultur und Geschichte, Winterthur, `https://digital.skkg.ch`). Node 24, pure ESM, no build step; runtime dependencies are `@modelcontextprotocol/server` and `zod`. It reads one read-only SQLite database (`node:sqlite`) built by `scripts/build_db.py`. The GitHub remote, `kintopp/skkg-mcp`, is private and must stay private.

The repository also holds the research behind the server:

- `notes/`: findings about the data, the API and the terms. Read `notes/README.md` first and `notes/05-open-questions.md` for what is still unchecked. `notes/11-mcp-tool-list.md` is the tool spec. The notes are the source of truth for findings, so update them when a finding changes. Never quote the names of private address records in them.
- `scripts/`: the Python data pipeline (`load_oxigraph.py`, `build_db.py`) and one-off analyses in `scripts/analysis/`. Use `uv`.
- `data/` (gitignored, never committed): `raw/` dumps, `oxigraph/` store, `db/` built databases, `derived/` census files, `reference/` (`fieldDefinitions.yml` from skkg-app).

## Commands

| Purpose | Command |
|---|---|
| Install | `npm install` |
| Tests | `npm test` |
| Lint | `npm run lint` |
| Mutation check of the tests (needs the fixture database; about 15 minutes, or a few with a warm cache) | `npm run mutate` |
| Mutation check of only the entries a change can affect | `npm run mutate -- --changed HEAD` |
| Injection tests of the build's privacy checks (about 2 minutes; need the partial store and fixture database) | `uv run --with pyoxigraph --with pytest python -I -m pytest -q scripts/tests` |
| Mutation check of those tests (about 10 minutes) | `uv run --with pyoxigraph --with pytest python -I scripts/tests/mutate.py` |
| Run against the full database | `SKKG_DB_PATH=data/db/skkg-20261028.sqlite npm start` |
| Inspector | `SKKG_DB_PATH=… npm run inspector` |

Data pipeline, run from the project root:

```sh
# Load a dump into a new Oxigraph store (the loader refuses an existing directory)
uv run --with pyoxigraph python -I scripts/load_oxigraph.py data/raw/full/latest-dump.ttl.gz data/oxigraph/full-YYYYMMDD

# Build the server database (about 3 minutes); keeps the output only when the privacy checks pass
uv run --with pyoxigraph python -I scripts/build_db.py data/oxigraph/full-20261028 data/db/skkg-20261028.sqlite --headers data/raw/full/headers.txt --census data/derived/shape_census-20261028.json

# Analysis scripts stream a gzipped dump (1 to 2 minutes for the full one; try data/raw/partial/ first)
uv run --with pyoxigraph python -I scripts/analysis/provenance_stats.py data/raw/full/latest-dump.ttl.gz
```

Scripts that take `STORE_DIR` open the store with `Store.read_only`, which is much faster than streaming the dump.

## Data sources

- REST API, public and read only for our purposes: `https://api.digital.skkg.ch/api/v1`. JSON-LD on CIDOC-CRM and Linked Art. OpenAPI specs at `/graphs/skkg/configuration/doc/data/` and `/graphs/cms/configuration/doc/data/`. Endpoint URLs follow `/graphs/{graph}/data/{endpointId}/{recordId}/`, e.g., `skkgapi:RetrieveObject`.
- Full RDF dump (Turtle, 187 MB gzip, updated by SKKG): `latest-dump.ttl.gz`. `latest-partial-dump.ttl.gz` (33 MB) is a development sample, not a public subset. Local copies in `data/raw/full/` and `data/raw/partial/`, each with a `headers.txt` holding the ETag. Treat them as untrusted input: run Python with `-I` and keep scripts outside `data/raw/`.
- IIIF Image API 3: `https://iiif.digital.skkg.ch/iiif/3/`.
- Reference code: `swiss-art-research-net/skkg-pipeline` (no license, so read it but don't copy it) and `swiss-art-research-net/skkg-app` (MIT; `src/fieldDefinitions.yml` holds about 100 SPARQL query patterns).

The local store handles search, filters and counts; the live API supplies single records and current rights fields; IIIF supplies images (`notes/04-storage-and-architecture.md`).

## Constraints from the SKKG terms

Summarized in `notes/02-open-data-policy-and-terms.md`. Metadata is free to reuse (comparable to CC0); image rights vary per object.

- The server stays read only. Never wrap the `cms` graph's `Create`, `Update`, `Delete`, or `PublicCreateInquiry` endpoints.
- Every tool that returns a record or an image passes through the rights fields, e.g., `skkgapi:credit_line`, `right_type`, `multimedia_right_type`, `right_holder`, `redaction_status`.
- Never try to find or rebuild images that SKKG chose not to publish.
- Provenance chains, owner names and purchase prices are public (`notes/08-dump-api-website-comparison.md`), so the server can return them, but it keeps SKKG's anonymisation (`person/privateIndividual`, "Unbekannte:r Eigentümer:in"). Never return the given name and surname of address records (`notes/09-addresses-rights-and-oxigraph.md`, `notes/06-personal-data-check.md`).
- Photo rights (CC0, CC BY, ©, on multimedia) and object copyright status ("gemeinfrei", "urheberrechtlich geschützt", on objects) are separate sets. Report both; take rights end dates from the dump, because the API omits them. Provenance is curated ownership periods, not text to parse (`notes/07-provenance-model.md`).
- Keep traffic to SKKG's live servers low. Explore with the dump instead of the API.

## Conventions (shared with books-as-data and odeuropa-eokg-mcp)

- Every tool returns `content[{type:'text'}]` and `structuredContent` from one structured object. Errors are `isError: true` results without `structuredContent`, via `withTool` (`src/lib/tool.js`) and `ToolError`.
- Hosts differ in which channel they give the model (`notes/05`, "Which channel reaches the model"), so both must stand alone. `structuredContent` is complete: every warning, paging field and note is a field there. The text is a compact rendering of the same result, never JSON, and it keeps the ids, both rights, the warnings, paging, and every section the caller asked for.
- The size guard counts both channels together: cut lists with `fitResult` (`src/lib/fit.js`), which measures the built result and its text, not an estimate.
- `skkg_channel_probe` is registered only with `SKKG_CHANNEL_PROBE=1`, so it is not in `REQUIRED_PROPS`; `test/channel_probe.test.js` checks it instead.
- Input schemas are `.strict()` and `$ref`-free; output schemas are `$ref`-free. Don't share one zod instance across fields.
- The first sentence of a tool description is at most 79 characters. Tool `title` equals its name. Never set a human-readable `serverInfo.title`.
- stdout is JSON-RPC only; log with `console.error`.
- Constants live in `src/config.js`.
- Every tool lives in `src/tools/<name>.js`, is registered in `src/server.js`, and is listed in `REQUIRED_PROPS` in `test/smoke.test.js`.
- Resolve every `id` parameter with `resolveId` (`src/lib/ids.js`). A bare number can be an object id and another object's inventory number (object/2432 has inventory number 2232); the resolver refuses that case instead of guessing.
- Privacy and rights rules are enforced by the database build, not here. Never add a raw SQL or SPARQL tool.
- Code rules are in `src/CLAUDE.md`, test rules in `test/CLAUDE.md` (adapted from the sibling servers). Never delete or weaken a failing test.
- Log every defect a review confirms in the ledger of `notes/12-defect-history.md`, with its category and the rule that covers it.

## Common errors

- **The website is a single page app:** `curl` on `digital.skkg.ch` or `info.digital.skkg.ch` returns an empty shell. Use a browser tool or the API.
- **The API docs pages are RapiDoc shells:** fetch the spec from `/graphs/{graph}/configuration/doc/data/`, not `/documentation/`.
- **Record IDs in API paths:** `RetrieveObject` and `RetrieveProvenance` take the prefixed ID with each slash encoded twice, e.g., `skkg:provenance%252F{uuid}`. `RetrieveObjectByInventoryNumber/{n}/` takes a plain inventory number.
- **Website object pages:** `https://digital.skkg.ch/de/intro/skkg%3Aobject%2F{id}`. Search results are not plain links; render with a browser tool.
- **Website pages of other records:** persons are `/de/filter;actor;skkg%3Aperson%2F{id}`, exhibitions `/de/filter;exhibition;skkg%3Aexhibition%2F{id}?skkgapi:exhibition=skkg:exhibition/{id}`; literature has none, and `/de/intro/skkg%3Aperson%2F…` shows a 404 panel (`notes/08`).
- **Intro pages need a login:** `cmsapi:ListIntroPages` returns 401; the Open Data Policy text is only in the rendered website.
- **Slow string joins in Oxigraph:** `FILTER(STRSTARTS(STR(?a), STR(?b)))` compares every pair. Follow real graph links instead, e.g., `crm:P104_is_subject_to` for rights, `la:digitally_shown_by/la:digitally_available_via` for IIIF.
- **`UNION` inside a join is very slow in Oxigraph** (one took 12 minutes). Run one query per branch.
- **`BIND` inside `OPTIONAL` or a `UNION` branch** can't see outer variables; it silently yields nothing or scans the whole store. Use `FILTER EXISTS` or `BIND(IF(BOUND(?x), ...))` outside the group.
- **No slash in a prefixed name:** `d:type/invnr` is a syntax error. Write `<https://data.skkg.ch/type/invnr>`.
- **Labels in several languages:** grouping by `rdfs:label` repeats rows; filter on `LANG(?label)`. Some parts are typed by Getty AAT URIs, e.g., address name parts.
- **Duplicate triples in the dump:** the parser counts 31.9 million triples, the store keeps 24.7 million quads. Count with SPARQL on the store when exact numbers matter.
- **QLever-only syntax:** `FILTER KEYWORDS` only works on QLever. Wikidata and GND data (`wdt:`, `geo:`) is already in the main dump (`notes/10-schema-census.md`).
- **Two id schemes:** objects, multimedia, persons, literature, exhibitions and addresses have numeric (`object/2432`) or UUID ids, as separate records. Match both.
