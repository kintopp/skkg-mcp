# Code rules

Extends the root `CLAUDE.md`. Each rule answers a kind of defect that reached review before (the letters are the categories of `notes/12-defect-history.md`). Log every review finding in the ledger there, so we can see which rules work.

## Before writing

- **Query before you assume (A, I).** Check every claim the code relies on, about the dump, the API, the website, or SQLite and FTS5, with a query on the full database (`data/db/skkg-20261028.sqlite`), the Oxigraph store, or one page load. Claims to check include "only X has Y", "always present", "is ordered", what a kind or id prefix means, that an example value is a real label, and how `NOCASE`, `LIKE`, FTS5 operators, or row order without `ORDER BY` behave. Record the result in `notes/`, not in a comment.
- **Give every heuristic a counter (A).** When the code relies on a rule that holds in today's dump only, such as a name found in a label, the build report counts the cases it misses, e.g. `authors_not_in_label`.
- **Write the failure list first (E).** Before coding a list, pager, filter, or formatter, list its cases in the test file (test/CLAUDE.md): none, one, duplicates, several rows per key (several creators, copyrights, or vocabularies per item), an open or equal range, a null sort key, an offset past the end, and an input the call ignores. An ignored input gets a warning.

## While writing

- **One owner per fact (B).** A section's count comes from the query that lists the section. A rule lives in the build or in the tool, never in both. A list or enum that mirrors another, or mirrors the build, is derived from it, not copied.
- **Follow a change of meaning to every reader (B, C).** When a value, count, sort, or kind changes meaning, grep for every place that reads it in the same commit, including tool descriptions, warnings, the text renderers, `notes/11`, and the mutation entries.
- **A build check reads the store itself (B, E).** A privacy or data check derives what it expects from the store with queries of its own, never from the flags or columns the loader wrote, and covers every place a value can reach: every column, table, and FTS copy. Prove each check with an injection test in `scripts/tests/`.
- **Fix data in the build (D).** When the data is wrong, fix `scripts/build_db.py` and add a build check. Never filter, patch, or re-check data in a tool, and never add a special case to a shared helper in `src/lib/` for one tool.
- **What the model is handed must do what it says (C, E).** Every filter a result offers reproduces the count it stands next to. Every hint, if followed, does what the caller meant, and names an input parameter, not an internal name. Every example value in a description is a real label. Each of these gets a property test.
- **Use the shared size and paging helpers (H).** Cut with `fitLists` or `fitResult` (`src/lib/fit.js`), page with `paging` (`src/lib/results.js`), and compute every field that depends on a list's length after the cut. Never estimate a size; measure the built result and its text.

## Before committing

- **Measure cost on the full database (F).** Run `EXPLAIN QUERY PLAN` on every new query against the full database. A new `WHERE` or join column gets an index in the same commit, and a build step that slows down by more than a few seconds is explained. Never add a correlated subquery on an unindexed table.
- **A fix commit is held to the standard of a feature commit.** It gets its failure list, its mutation entries, and the review, because about a quarter of the defects so far came from fix commits.
