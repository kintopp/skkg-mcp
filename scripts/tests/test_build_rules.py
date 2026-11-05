"""The data rules of the build that the tools read instead of deriving them: the year span and
sort keys of a provenance period, the year of an acquisition, the links to objects the database
does not hold, and the currency codes.

Ways the rules could fail, which the tests below pin:
- a lone date qualified by something other than "seit" or "bis" ("vor", "um", "spätestens",
  "mindestens", "nach") is opened to every later or earlier year, or "vor" is opened the wrong way;
- "seit", "bis", or SKKG's "o. D." bound (0001-01-01, 9999-12-31) no longer opens its side;
- a period with two dates or none is changed by its qualifiers;
- a qualifier the rule does not know is placed without being counted, also when a bound or a
  "seit" decides the placement, or one without data to decide it ("frühestens ab") is classed;
- a date without a year becomes a NULL year without a count;
- the sort key of a side disagrees with its year (an open side not beyond every date, a year
  before 1000 or below 0 out of order as text), or ties within a year or among open sides are not
  broken by the date recorded for that side;
- an acquisition's year is derived otherwise than a period's, or a dated acquisition lacks it;
- a link to an object the database does not hold is not counted because its column is missing
  from a hand list, or a period link that is NULL or not shaped "object/…" survives the drop;
- a column that holds object ids does not declare its link, so the count misses it;
- a currency label that is neither an alias nor an ISO-like code passes without a count.

Run: uv run --with pyoxigraph --with pytest python -I -m pytest -q scripts/tests
"""
import importlib.util
import os
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("build_db", ROOT / "scripts" / "build_db.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

# (date_from, date_to, begin qualifier, begin_from, end qualifier, end_to) -> (first, last, kind,
# classified), with the date labels of the full dump they stand for.
SPANS = [
    (("1983-06-01", None, "seit", "1983-06-01", None, None), (1983, 9999, "open end", True)),                 # seit 01.06.1983
    (("2015-07-29", None, "mindestens seit", "2015-07-29", None, None), (2015, 9999, "open end", True)),      # mindestens seit 29.07.2015
    (("1852-01-01", None, None, None, "o. D.", "9999-12-31"), (1852, 9999, "open end", True)),                 # 1852–o. D.
    (("1928-01-01", None, "seit", "1928-01-01", "o. D.", "9999-12-31"), (1928, 9999, "open end", True)),       # seit 1928–o. D.
    (("1976-01-01", None, "mindestens", "1976-01-01", "o. D.", "9999-12-31"), (1976, 9999, "open end", True)),  # mindestens 1976–o. D.
    ((None, "1903-12-31", "o. D.", "0001-01-01", "spätestens", "1903-12-31"), (-9999, 1903, "open start", True)),  # o. D.–spätestens 1903
    ((None, "1934-12-31", None, None, "bis", "1934-12-31"), (-9999, 1934, "open start", True)),                 # bis 03.1934
    ((None, "1864-12-31", None, None, "spätestens bis", "1864-12-31"), (-9999, 1864, "open start", True)),      # spätestens bis 1864
    (("1997-04-14", None, "vor", "1997-04-14", None, None), (1997, 1997, "event", True)),                      # vor 14.04.1997
    (("1900-01-01", None, "um", "1900-01-01", None, None), (1900, 1900, "event", True)),                       # um 1900
    (("1907-11-10", None, "spätestens", "1907-11-10", None, None), (1907, 1907, "event", True)),               # spätestens 10.11.1907
    (("1927-07-12", None, "mindestens", "1927-07-12", None, None), (1927, 1927, "event", True)),               # mindestens 12.07.1927
    (("1949-03-01", None, "nach", "1949-03-01", None, None), (1949, 1949, "event", True)),                     # nach 03.1949
    (("1983-06-01", None, None, None, None, None), (1983, 1983, "event", True)),                               # 01.06.1983, an auction day
    ((None, "1994-12-08", None, None, None, None), (1994, 1994, "event", True)),                               # 08.12.1994
    (("1990-01-01", "1995-12-31", "seit", "1990-01-01", "bis", "1995-12-31"), (1990, 1995, "two dates", True)),
    ((None, None, "o. D.", "0001-01-01", None, None), (None, None, "undated", True)),                           # o. D.
    # Not classified: placed by the bound or the known qualifier alone, and counted.
    (("1990-01-01", None, "neu", "1990-01-01", None, None), (1990, 1990, "event", False)),
    ((None, "1990-12-31", None, None, "neu", "1990-12-31"), (1990, 1990, "event", False)),
    (("1990-01-01", None, None, None, "bis", "1990-12-31"), (1990, 1990, "event", False)),                     # an end qualifier on the start date
    (("1990-01-01", None, "neu", "1990-01-01", "o. D.", "9999-12-31"), (1990, 9999, "open end", False)),      # unknown next to an o. D. end
    ((None, "1990-12-31", "o. D.", "0001-01-01", "neu", "1990-12-31"), (-9999, 1990, "open start", False)),   # unknown next to an o. D. start
    (("1990-01-01", None, "seit", "1990-01-01", "neu", None), (1990, 9999, "open end", False)),               # seit with an unknown end
    ((None, "1990-12-31", "neu", None, "bis", "1990-12-31"), (-9999, 1990, "open start", False)),             # bis with an unknown begin
    (("1892-01-01", None, "frühestens ab", "1892-01-01", "o. D.", "9999-12-31"), (1892, 9999, "open end", False)),  # frühestens ab 1892–o. D.
    (("1892-01-01", None, "frühestens ab", "1892-01-01", None, None), (1892, 1892, "event", False)),          # a lone frühestens ab, not in the dump
    # A date without a year never matches a year filter, and is counted.
    (("undatiert", None, "seit", "undatiert", None, None), (None, None, "date without a year", False)),
    ((None, "undatiert", None, None, None, None), (None, None, "date without a year", False)),
    (("1990-01-01", "undatiert", None, None, None, None), (None, None, "date without a year", False)),
    (("undatiert", "1990-12-31", None, None, None, None), (None, None, "date without a year", False)),
]


@pytest.mark.parametrize("args,want", SPANS, ids=[f"{a[2] or '-'}/{a[4] or '-'}/{w[2]}/{w[3]}" for a, w in SPANS])
def test_period_span(args, want):
    assert b.period_span(*args) == want


def test_sort_keys_order_by_year_then_the_recorded_date():
    # Ascending: an open start (newest recorded date last among them), negative and early years, a
    # year's dates in order, then an open end. The years are shifted, so text order is year order.
    ordered = [(-9999, "1903-12-31"), (-9999, "1934-12-31"), (-600, "-0600"), (-5, "-0005"), (189, "0189-05-14"),
               (1983, "1983-01-01"), (1983, "1983-06-01"), (2020, "2020-01-01"), (9999, "1852-01-01"), (9999, "1990-01-01")]
    keys = [b.sort_key(y, d) for y, d in ordered]
    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)
    assert b.sort_key(None, "undatiert") is None


def empty_db():
    db = sqlite3.connect(":memory:")
    db.executescript(b.DDL + b.FTS)
    return db


def test_derive_counts_links_of_every_column_that_declares_one_and_drops_bad_period_links():
    db = empty_db()
    db.execute("INSERT INTO objects (id) VALUES ('object/1')")
    db.executemany("INSERT INTO provenance (id) VALUES (?)", [("provenance/a",), ("provenance/b",), ("provenance/c",)])
    db.executemany("INSERT INTO provenance_objects VALUES (?,?,?)",
                   [("provenance/a", "object/1", 1), ("provenance/a", "object/2", 1), ("provenance/b", "object/3", 1),
                    ("provenance/b", None, 2), ("provenance/c", "2", 1)])
    db.execute("INSERT INTO literature_refs (literature_id, object_id) VALUES ('literature/1', 'object/4')")
    db.execute("INSERT INTO literature_refs (literature_id, provenance_id) VALUES ('literature/2', 'provenance/a')")
    db.execute("INSERT INTO object_relations (object_id, target_id) VALUES ('object/1', 'object/5')")
    db.execute("INSERT INTO acquisitions (object_id) VALUES ('object/6')")
    db.execute("INSERT INTO exhibition_objects VALUES ('exhibition/1', 'object/7')")
    db.execute("INSERT INTO object_group_members VALUES ('objectgroup/1', 'object/8')")
    db.execute("INSERT INTO object_multimedia (object_id, multimedia_id) VALUES ('object/9', 'multimedia/1')")
    db.execute("INSERT INTO objects (id, parent_id) VALUES ('object/10', 'object/11')")
    out = b.derive(db)["object_links_to_missing"]
    assert {k: n for k, n in out.items() if n} == {
        "provenance_objects.object_id": 4, "literature_refs.object_id": 1, "object_relations.target_id": 1,
        "acquisitions.object_id": 1, "exhibition_objects.object_id": 1, "object_group_members.object_id": 1,
        "object_multimedia.object_id": 1, "objects.parent_id": 1}
    assert db.execute("SELECT provenance_id, object_id FROM provenance_objects").fetchall() == [("provenance/a", "object/1")]
    assert db.execute("SELECT COUNT(*) FROM literature_refs").fetchone()[0] == 2, "only period links are dropped"
    assert db.execute("SELECT has_provenance_chain FROM objects WHERE id = 'object/1'").fetchone()[0] == 1


def test_derive_stores_the_year_spans_and_sort_keys_and_counts_what_it_cannot_classify():
    db = empty_db()
    db.executemany("INSERT INTO terms (id, facet, label) VALUES (?, 'date_qualifier', ?)",
                   [("type/54165/1", "seit"), ("type/54165/2", "vor"), ("type/54165/3", "neu"), ("type/54165/4", "o. D.")])
    db.executemany("INSERT INTO provenance (id, date_from, begin_qualifier_id, begin_from, end_qualifier_id, end_to) VALUES (?,?,?,?,?,?)",
                   [("provenance/a", "1990-01-01", "type/54165/1", "1990-01-01", None, None),
                    ("provenance/b", "1997-04-14", "type/54165/2", "1997-04-14", None, None),
                    ("provenance/c", "1980-01-01", "type/54165/3", "1980-01-01", None, None),
                    ("provenance/d", "1985-01-01", "type/54165/3", "1985-01-01", "type/54165/4", "9999-12-31"),
                    ("provenance/e", "undatiert", None, None, None, None)])
    db.execute("INSERT INTO provenance (id, date_from, date_to) VALUES ('provenance/f', '1970-03-01', '1975-06-30')")
    out = b.derive(db)
    assert dict(db.execute("SELECT id, year_first || '/' || year_last FROM provenance WHERE year_first IS NOT NULL")) == {
        "provenance/a": "1990/9999", "provenance/b": "1997/1997", "provenance/c": "1980/1980", "provenance/d": "1985/9999",
        "provenance/f": "1970/1975"}
    # Earliest side: by start date. Latest side: the events by date, then the open ends by the date they record.
    order = lambda col: [i for (i,) in db.execute(f"SELECT id FROM provenance WHERE {col} IS NOT NULL ORDER BY {col}")]
    assert order("sort_first") == ["provenance/f", "provenance/c", "provenance/d", "provenance/a", "provenance/b"]
    assert order("sort_last") == ["provenance/f", "provenance/c", "provenance/b", "provenance/d", "provenance/a"]
    assert db.execute("SELECT sort_first, sort_last FROM provenance WHERE id = 'provenance/e'").fetchone() == (None, None)
    assert out["period_years"]["unclassified"] == {"neu / - (event)": 1, "neu / o. D. (open end)": 1,
                                                   "- / - (date without a year)": 1}


def test_currency_labels_that_are_no_alias_and_no_iso_code_are_counted():
    db = empty_db()
    db.executemany("INSERT INTO terms (id, facet, label) VALUES (?, 'currency', ?)",
                   [("type/c/1", "DM"), ("type/c/2", "CHF"), ("type/c/3", "RM"), ("type/c/4", "MK")])
    db.executemany("INSERT INTO acquisitions (object_id, currency_id, price_value) VALUES (?,?,?)",
                   [("object/1", "type/c/1", 10), ("object/2", "type/c/3", 20), ("object/3", "type/c/3", None)])
    db.execute("INSERT INTO provenance (id, currency_id, price_value) VALUES ('provenance/a', 'type/c/3', 5)")
    assert b.set_currency_codes(db) == {"MK": 0, "RM": 2}
    assert dict(db.execute("SELECT object_id, currency_code FROM acquisitions")) == {"object/1": "DEM", "object/2": "RM", "object/3": "RM"}


def newest(pattern):
    found = sorted(ROOT.glob(pattern))
    return found[-1] if found else None


DB = Path(os.environ["SKKG_FIXTURE_DB"]) if os.environ.get("SKKG_FIXTURE_DB") else newest("data/db/skkg-partial-*.sqlite")


@pytest.mark.skipif(not (DB and DB.exists()), reason="needs the fixture database (test/CLAUDE.md)")
def test_the_fixture_links_no_period_to_a_missing_object():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    n = db.execute("SELECT COUNT(*) FROM provenance_objects WHERE object_id IS NULL OR object_id NOT IN (SELECT id FROM objects)").fetchone()[0]
    assert n == 0


@pytest.mark.skipif(not (DB and DB.exists()), reason="needs the fixture database (test/CLAUDE.md)")
def test_every_column_that_holds_object_ids_declares_its_link():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    declared = set(b.object_links(db))
    holding = {(t, c) for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'")
               for _, c, *_ in db.execute(f"PRAGMA table_info({t})")
               if (t, c) != ("objects", "id") and db.execute(f"SELECT 1 FROM {t} WHERE {c} IN (SELECT id FROM objects) LIMIT 1").fetchone()}
    assert holding - declared == set()
    assert len(declared) >= 18


STORE = Path(os.environ["SKKG_TEST_STORE"]) if os.environ.get("SKKG_TEST_STORE") else newest("data/oxigraph/partial-*")


@pytest.mark.skipif(not (STORE and STORE.exists()), reason="needs the partial Oxigraph store (test/CLAUDE.md)")
def test_every_dated_acquisition_gets_the_year_of_its_date_and_a_sort_key():
    from pyoxigraph import Store
    db = empty_db()
    b.load_acquisitions(b.Source(Store.read_only(str(STORE))), db, set())
    rows = db.execute("SELECT date, year, sort_key FROM acquisitions WHERE date IS NOT NULL").fetchall()
    assert rows
    for date, y, key in rows:
        assert y == int(date[:4]) and key is not None, date  # every acquisition date of the dump is YYYY-MM-DD (notes/11)
    assert [d for d, _, _ in sorted(rows, key=lambda r: r[2])] == sorted(d for d, _, _ in rows)
