# Test rules

Extends the root `CLAUDE.md`: the offline suite is the only continuous layer, so never delete or weaken a failing test. The rules follow the sibling servers (`books-as-data/test/CLAUDE.md`, `odeuropa-eokg-mcp/test/CLAUDE.md`).

## Writing a test

- **List how the unit could fail before writing it**, as a comment block at the top of the file or as `test.todo` entries. A test written by reading the finished code just restates it.
- **Prove each new assertion can fail:** break the code it guards, watch it go red, restore. Add the break to `test/mutations.mjs` and run `npm run mutate`: every mutation must be killed, and a stale pattern means the entry needs updating, not deleting.
- **Never derive an expected value from the code under test.** Don't import a config constant to build the expectation (e.g. `STALE_AFTER_DAYS`); spell out the value the spec requires, or assert the invariant the constant must satisfy. Comparing two calls is fine when equality *is* the property.
- **A test that breaks under a behaviour-preserving refactor asserts implementation.** Don't add it: internal names, call order, or an exact count where an upper bound states the real constraint.
- **Model-facing wording is behaviour** (descriptions, warnings, error suggestions, instructions). The model reads it, so assert the key phrases and don't loosen them under the refactor rule. Assert on `formatErrorText(err)`, which is what the model sees: `assert.throws(fn, /re/)` checks only `err.message` and misses the suggestion.
- **Test at the highest offline boundary that pins the behaviour.** For a tool that is the handler against a test database: input in, `structuredContent` out, checked with `assertWireValid`. Don't duplicate a stronger test one level down.
- **No test-only exports.** Test through the exported function that uses the helper.

## Harness

- **No network, no full database in `npm test`.** Unit tests build a throwaway database with `makeTestDb` (`test/helpers.js`), holding only the tables and rows the test needs. Tool tests use the fixture database built by `scripts/build_db.py` from the partial dump, so its schema cannot drift from the real one. It stays uncommitted in `data/db/` (56 MB); `FIXTURE_DB` (`test/helpers.js`) gives the path of the newest `skkg-partial-YYYYMMDD.sqlite` there (override with `SKKG_FIXTURE_DB`) and a `skip` reason when it is missing. Rebuild it (about 40 s) with:

  ```sh
  uv run --with pyoxigraph python -I scripts/load_oxigraph.py data/raw/partial/latest-partial-dump.ttl.gz data/oxigraph/partial-20261028
  uv run --with pyoxigraph python -I scripts/build_db.py data/oxigraph/partial-20261028 data/db/skkg-partial-20261028.sqlite --headers data/raw/partial/headers.txt
  ```

  Assert facts the spec or the dump fixes (an id, an anonymisation label), not counts that change with the next partial dump.
- **Gates use exact equality, never truthiness:** `process.env.SKKG_LIVE === '1'` for tests that call SKKG (`live: true`, IIIF), and a set `SKKG_FULL_DB` path for tests against the full database. A test that reaches the network or the full database without its gate is a bug.
- **Query-plan assertions belong to the full-database gate.** A query that scans a table passes on a small fixture and is slow only on the full database. Such tests check `EXPLAIN QUERY PLAN` for the index the query must use, and each names the invariant it guards.
- **Privacy is a behaviour.** The build enforces it, but tool tests still assert that results keep SKKG's anonymisation ("Privatperson", "Unbekannte:r Eigentümer:in") and that private addresses carry no coordinates.
- **Subprocess tests** use `withClient`, which spawns the real server over stdio. Pass `SKKG_DB_PATH` in its `env`.
- Live tests run sequentially and stay few: keep traffic to SKKG's servers low.
