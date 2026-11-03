# skkg-mcp

An MCP server for the [SKKG Sammlung digital](https://digital.skkg.ch) collection of the Stiftung für Kunst, Kultur und Geschichte, Winterthur. It searches about 64,000 objects with their images, SKKG acquisitions, provenance chains, literature, and exhibitions.

Status: in development. The server starts and resolves record ids, but has no tools yet.

## How it works

The server reads one read-only SQLite database, built from SKKG's published RDF dump. The build removes personal data that SKKG does not show on its website, and it keeps SKKG's anonymisation. Images come from SKKG's IIIF server. Every result that contains an object or an image reports both sets of rights: the rights to the photograph and the copyright status of the object.

## Running it

Requires Node 24.

```sh
npm install
SKKG_DB_PATH=/path/to/skkg-YYYYMMDD.sqlite npm start
```

| Variable | Purpose |
|---|---|
| `SKKG_DB_PATH` | Path of the SQLite database (required for any tool call) |
| `SKKG_LOG` | `1` writes one JSON line per tool call to stderr |
| `SKKG_RESULT_CHAR_CEILING` | Maximum result size in characters (default 150,000) |

## Building the database

The Python pipeline in `scripts/` loads SKKG's RDF dump into an Oxigraph store and builds the SQLite database from it; see `CLAUDE.md` for the commands. Research notes on the data model and the terms are in `notes/`.

## Data and terms

The metadata is published by SKKG for free reuse. Image rights vary per image and are reported with each result. Users are responsible for respecting personality rights, as SKKG's terms of use require.

## License

MIT, see [LICENSE](LICENSE). The license covers the code, not SKKG's data.
