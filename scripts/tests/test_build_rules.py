"""The data rules of the build that the tools read instead of deriving them: the year span of a
provenance period, the links to objects the database does not hold, and the currency codes.

Ways the rules could fail, which the tests below pin:
- a lone date qualified by something other than "seit" or "bis" ("vor", "um", "spätestens",
  "mindestens", "nach") is opened to every later or earlier year, or "vor" is opened the wrong way;
- "seit", "bis", or SKKG's "o. D." bound (0001-01-01, 9999-12-31) no longer opens its side;
- a period with two dates or none is changed by its qualifiers;
- a qualifier the rule does not know is placed without being counted;
- a link from a period to an object the database does not hold is kept, so the tools see a
  period of no object as linked, or the build report does not count it;
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

# (date_from, date_to, begin qualifier, begin_from, end qualifier, end_to) -> (first, last, kind),
# with the date labels of the full dump they stand for.
SPANS = [
    (("1983-06-01", None, "seit", "1983-06-01", None, None), (1983, 9999, "open end")),                # seit 01.06.1983
    (("2015-07-29", None, "mindestens seit", "2015-07-29", None, None), (2015, 9999, "open end")),     # mindestens seit 29.07.2015
    (("1852-01-01", None, None, None, "o. D.", "9999-12-31"), (1852, 9999, "open end")),                # 1852–o. D.
    (("1976-01-01", None, "mindestens", "1976-01-01", "o. D.", "9999-12-31"), (1976, 9999, "open end")),  # mindestens 1976–o. D.
    ((None, "1903-12-31", "o. D.", "0001-01-01", "spätestens", "1903-12-31"), (-9999, 1903, "open start")),  # o. D.–spätestens 1903
    ((None, "1934-12-31", None, None, "bis", "1934-12-31"), (-9999, 1934, "open start")),                # bis 03.1934
    ((None, "1864-12-31", None, None, "spätestens bis", "1864-12-31"), (-9999, 1864, "open start")),     # spätestens bis 1864
    (("1997-04-14", None, "vor", "1997-04-14", None, None), (1997, 1997, "event")),                     # vor 14.04.1997
    (("1900-01-01", None, "um", "1900-01-01", None, None), (1900, 1900, "event")),                      # um 1900
    (("1907-11-10", None, "spätestens", "1907-11-10", None, None), (1907, 1907, "event")),              # spätestens 10.11.1907
    (("1927-07-12", None, "mindestens", "1927-07-12", None, None), (1927, 1927, "event")),              # mindestens 12.07.1927
    (("1949-03-01", None, "nach", "1949-03-01", None, None), (1949, 1949, "event")),                    # nach 03.1949
    (("1983-06-01", None, None, None, None, None), (1983, 1983, "event")),                              # 01.06.1983, an auction day
    ((None, "1994-12-08", None, None, None, None), (1994, 1994, "event")),                              # 08.12.1994
    (("1990-01-01", "1995-12-31", "seit", "1990-01-01", "bis", "1995-12-31"), (1990, 1995, "two dates")),
    ((None, None, "o. D.", "0001-01-01", None, None), (None, None, "undated")),                          # o. D.
    (("1990-01-01", None, "neu", "1990-01-01", None, None), (1990, 1990, "unclassified")),
    ((None, "1990-12-31", None, None, "neu", "1990-12-31"), (1990, 1990, "unclassified")),
    (("1990-01-01", None, None, None, "bis", "1990-12-31"), (1990, 1990, "unclassified")),               # an end qualifier on the start date
]


@pytest.mark.parametrize("args,want", SPANS, ids=[f"{a[2] or '-'}/{a[4] or '-'}/{w[2]}" for a, w in SPANS])
def test_period_span(args, want):
    assert b.period_span(*args) == want


def empty_db():
    db = sqlite3.connect(":memory:")
    db.executescript(b.DDL + b.FTS)
    return db


def test_derive_drops_period_links_to_missing_objects_and_counts_every_kind():
    db = empty_db()
    db.execute("INSERT INTO objects (id) VALUES ('object/1')")
    db.executemany("INSERT INTO provenance (id) VALUES (?)", [("provenance/a",), ("provenance/b",)])
    db.executemany("INSERT INTO provenance_objects VALUES (?,?,?)",
                   [("provenance/a", "object/1", 1), ("provenance/a", "object/2", 1), ("provenance/b", "object/3", 1)])
    db.execute("INSERT INTO literature_refs (literature_id, object_id) VALUES ('literature/1', 'object/4')")
    db.execute("INSERT INTO object_relations (object_id, target_id) VALUES ('object/1', 'object/5')")
    out = b.derive(db)
    assert out["object_links_to_missing"] == {"provenance_objects.object_id": 2, "literature_refs.object_id": 1,
                                              "object_relations.target_id": 1}
    assert db.execute("SELECT provenance_id, object_id FROM provenance_objects").fetchall() == [("provenance/a", "object/1")]
    assert db.execute("SELECT COUNT(*) FROM literature_refs").fetchone()[0] == 1, "only period links are dropped"
    assert db.execute("SELECT has_provenance_chain FROM objects").fetchone()[0] == 1


def test_derive_stores_the_year_spans_and_counts_unknown_qualifiers():
    db = empty_db()
    db.executemany("INSERT INTO terms (id, facet, label) VALUES (?, 'date_qualifier', ?)",
                   [("type/54165/1", "seit"), ("type/54165/2", "vor"), ("type/54165/3", "neu")])
    db.executemany("INSERT INTO provenance (id, date_from, begin_qualifier_id, begin_from) VALUES (?,?,?,?)",
                   [("provenance/a", "1990-01-01", "type/54165/1", "1990-01-01"), ("provenance/b", "1997-04-14", "type/54165/2", "1997-04-14"),
                    ("provenance/c", "1980-01-01", "type/54165/3", "1980-01-01")])
    db.execute("INSERT INTO acquisitions (object_id, date) VALUES ('object/1', '1979-11-14')")
    out = b.derive(db)
    assert dict(db.execute("SELECT id, year_first || '/' || year_last FROM provenance")) == {
        "provenance/a": "1990/9999", "provenance/b": "1997/1997", "provenance/c": "1980/1980"}
    assert out["period_years"]["unclassified"] == {"neu / -": 1}
    assert db.execute("SELECT year FROM acquisitions").fetchone()[0] == 1979


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
    n = db.execute("SELECT COUNT(*) FROM provenance_objects WHERE object_id NOT IN (SELECT id FROM objects)").fetchone()[0]
    assert n == 0
