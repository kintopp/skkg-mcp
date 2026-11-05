"""Each test injects one leak into a copy of the fixture database and expects the privacy check
that covers it to fail; the clean copy passes them all. The cases follow the injections of
notes/reviews/2026-11-05-privacy-checks-claude.md and …-fix-commits-and-privacy-gpt.md.

Ways the checks could fail, which the tests below pin:
- a check trusts the loader's own output (the private flag, the organisation column) instead of
  the store, so a loader bug blinds it;
- a denylist misses a new spelling (a column `lastname`, a new table);
- a name is matched only in one case, Unicode form or spacing, or only in its own record;
- a name is found only where the loader writes it, not in another column, table, or FTS copy;
- the anonymisation is checked for presence, not for content and links;
- the allowed fields (acquisition notes) or a person's own organisation are refused.

Values from the store are injected but never printed: assertions compare check names only.

Run: uv run --with pyoxigraph --with pytest python -I -m pytest -q scripts/tests
"""
import importlib.util
import os
import shutil
import sqlite3
import unicodedata
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("build_db", ROOT / "scripts" / "build_db.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def newest(pattern):
    found = sorted(ROOT.glob(pattern))
    return found[-1] if found else None


STORE = Path(os.environ["SKKG_TEST_STORE"]) if os.environ.get("SKKG_TEST_STORE") else newest("data/oxigraph/partial-*")
DB = Path(os.environ["SKKG_FIXTURE_DB"]) if os.environ.get("SKKG_FIXTURE_DB") else newest("data/db/skkg-partial-*.sqlite")
pytestmark = pytest.mark.skipif(not (STORE and DB and STORE.exists() and DB.exists()),
                                reason="needs the partial Oxigraph store and fixture database (test/CLAUDE.md)")

SCHEMA = "tables and their columns are exactly"
PRIVATE_SET = "private addresses are exactly"
PRIVATE_ROW = "every private address shows only"
OTHER_ROW = "every other address keeps"
ANON_NODES = "hold only \"Privatperson\""
ANON_OWNERS = "every anonymised owner is flagged"
ANON_LINKS = "anonymised owners keep their"
NAMES = "no protected name outside"
FTS = "full-text table holds exactly"
WEBSITE = "outside URL"
STUBS = "no stubs"


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    from pyoxigraph import Store
    src = b.Source(Store.read_only(str(STORE)))
    exp = b.privacy_expectations(src)
    copy = tmp_path_factory.mktemp("db") / "copy.sqlite"
    shutil.copy(DB, copy)
    conn = sqlite3.connect(copy, isolation_level=None)
    persons = b.protected_names(src)
    # A protected person with a given name and surname ("Surname, Given" is one of the forms).
    surname, given = next(f for _, (forms, _) in sorted(persons.items()) for f in forms if ", " in f).split(", ", 1)
    private = sorted(exp["private"] - {b.ANON_ADDRESS})
    other = sorted(set(exp["pref"]) - exp["private"])
    anon = sorted(exp["anon"] - {b.ANON_ACTOR})
    yield {"conn": conn, "exp": exp, "full": f"{given} {surname}", "given": given, "surname": surname,
           "private": private, "other": other, "anon": anon,
           "pref": lambda x: min(exp["pref"][x])}
    conn.close()


def failed(env, *statements):
    """Names of the checks that fail after the statements, run inside a rolled-back transaction."""
    conn = env["conn"]
    conn.execute("BEGIN")
    try:
        for sql, *params in statements:
            conn.execute(sql, params)
        return [c for c, ok, _ in b.privacy_checks(conn, env["exp"]) if not ok]
    finally:
        conn.execute("ROLLBACK")


def fails(env, check, *statements):
    return any(check in c for c in failed(env, *statements))


def test_clean_copy_passes_every_check(env):
    assert failed(env) == []


# ------------------------------------------------------------ schema (B4)

def test_a_name_column_under_any_spelling_fails(env):
    for col in ("lastname", "FIRST_NAME", "person_name"):
        assert fails(env, SCHEMA, (f"ALTER TABLE addresses ADD COLUMN {col} TEXT",)), col


def test_a_new_table_fails(env):
    assert fails(env, SCHEMA, ("CREATE TABLE address_names (given_name TEXT, surname TEXT)",))


# ------------------------------------------------------------ private set and address rows (B1-B3)

def test_a_private_address_unflagged_fails_even_with_its_label_kept(env):
    a = env["private"][0]
    assert fails(env, PRIVATE_SET, ("UPDATE addresses SET is_private_person = 0 WHERE id = ?", a))


def test_every_private_address_unflagged_fails(env):
    assert fails(env, PRIVATE_SET, ("UPDATE addresses SET is_private_person = 0 WHERE id != ?", b.ANON_ADDRESS))


def test_a_loader_that_misses_a_private_address_fails(env):
    a = env["private"][0]
    sql = "UPDATE addresses SET label = ?, is_private_person = 0, latitude = 47.5, longitude = 8.7, website = 'https://example.org' WHERE id = ?"
    bad = failed(env, (sql, env["pref"](a), a))
    assert any(PRIVATE_SET in c for c in bad) and any(PRIVATE_ROW in c for c in bad)


def test_a_flagged_private_address_with_coordinates_or_a_website_fails(env):
    a = env["private"][0]
    assert fails(env, PRIVATE_ROW, ("UPDATE addresses SET latitude = 47.5, longitude = 8.7 WHERE id = ?", a))
    assert fails(env, PRIVATE_ROW, ("UPDATE addresses SET website = 'https://example.org' WHERE id = ?", a))


def test_a_name_in_a_private_label_fails_in_any_case_form_or_part(env):
    a = env["private"][0]
    s, g = env["surname"], env["given"]
    for variant in (s, s.lower(), s.upper(), unicodedata.normalize("NFD", s), g, f"{g} {s[0]}.", env["full"]):
        assert fails(env, PRIVATE_ROW, ("UPDATE addresses SET label = ? || ', ' || label WHERE id = ?", variant, a))


def test_a_name_next_to_the_organisation_in_the_label_fails(env):
    a = next(x for x in env["private"] if env["exp"]["org"].get(x))
    assert fails(env, PRIVATE_ROW, ("UPDATE addresses SET label = ? || ', ' || label WHERE id = ?", env["full"], a))


def test_an_organisation_column_rewritten_with_a_name_fails(env):
    # The label is rebuilt from the rewritten organisation, so only the comparison with the store catches it.
    a = env["private"][0]
    assert fails(env, PRIVATE_ROW, ("UPDATE addresses SET organisation = ?, label = ? || COALESCE(', ' || place, '') WHERE id = ?",
                                    env["surname"], env["surname"], a))


def test_another_records_label_on_a_private_address_fails(env):
    a, c = env["private"][0], env["private"][1]
    assert fails(env, PRIVATE_ROW, ("UPDATE addresses SET label = ? WHERE id = ?", env["pref"](c), a))


def test_a_private_row_rekeyed_to_an_unknown_id_fails(env):
    a = env["private"][0]
    assert fails(env, PRIVATE_SET, ("UPDATE addresses SET id = 'address/not-in-store', label = ?, is_private_person = 0 WHERE id = ?",
                                    env["pref"](a), a))


def test_an_address_missing_from_or_added_to_the_store_fails(env):
    o = env["other"][0]
    assert fails(env, PRIVATE_SET, ("DELETE FROM addresses WHERE id = ?", o))
    assert fails(env, PRIVATE_SET, ("INSERT INTO addresses (id, label) VALUES ('address/not-in-store', 'x')",))


def test_a_name_in_another_address_fails(env):
    o = env["other"][0]
    for col in ("label", "place", "region"):
        bad = failed(env, (f"UPDATE addresses SET {col} = ? WHERE id = ?", env["full"], o))
        assert any(OTHER_ROW in c for c in bad), col
        assert any(NAMES in c for c in bad), col


# ------------------------------------------------------------ anonymisation (B6)

def test_the_anonymous_person_node_changed_fails(env):
    for sql, *p in (("UPDATE actors SET kind = 'person', is_anonymous = 0 WHERE id = ?", b.ANON_ACTOR),
                    ("UPDATE actors SET label = ? WHERE id = ?", env["full"], b.ANON_ACTOR),
                    ("DELETE FROM actors WHERE id = ?", b.ANON_ACTOR)):
        assert fails(env, ANON_NODES, (sql, *p)), sql


def test_the_anonymous_address_node_changed_fails(env):
    for sql, *p in (("UPDATE addresses SET label = ? WHERE id = ?", env["full"], b.ANON_ADDRESS),
                    ("UPDATE addresses SET place = 'Winterthur' WHERE id = ?", b.ANON_ADDRESS),
                    ("DELETE FROM addresses WHERE id = ?", b.ANON_ADDRESS)):
        assert fails(env, ANON_NODES, (sql, *p)), sql


def test_an_anonymised_owner_unflagged_or_relabelled_fails(env):
    x = env["anon"][0]
    assert fails(env, ANON_OWNERS, ("UPDATE actors SET is_anonymous = 0 WHERE id = ?", x))
    assert fails(env, ANON_OWNERS, ("UPDATE actors SET label = ?, is_anonymous = 0 WHERE id = ?", env["full"], x))
    assert fails(env, ANON_OWNERS, ("UPDATE actors SET label = ? WHERE id = ?", env["full"], x))


def test_an_unflagged_placeholder_with_leading_space_or_other_case_fails(env):
    for label in (" Unbekannte:r Eigentümer:in", "UNBEKANNTE:R EIGENTÜMER:IN"):
        assert fails(env, ANON_OWNERS, ("INSERT INTO actors (id, kind, label, is_anonymous) VALUES ('person/injected', 'person', ?, 0)", label))


def test_names_or_identifiers_attached_to_an_anonymised_owner_fail(env):
    for x in (b.ANON_ACTOR, env["anon"][0]):
        assert fails(env, ANON_OWNERS, ("INSERT INTO actor_names VALUES (?, ?, NULL, 'skkg')", x, env["full"]))
        assert fails(env, ANON_OWNERS, ("INSERT INTO actor_gnd VALUES (?, '123', ?, NULL, NULL)", x, env["full"]))
        assert fails(env, ANON_OWNERS, ("INSERT INTO actor_external VALUES (?, 'gnd', '123', 'https://d-nb.info/gnd/123')", x))


def test_an_anonymised_owner_replaced_in_a_period_or_acquisition_fails(env):
    owners, sources = env["exp"]["owners"], env["exp"]["sources"]
    assert owners and sources, "the fixture needs anonymised periods and acquisitions"
    p, _ = min(owners)
    o, _ = min(sources)
    real = env["conn"].execute("SELECT id FROM actors WHERE is_anonymous = 0 AND kind = 'person' LIMIT 1").fetchone()[0]
    assert fails(env, ANON_LINKS, ("UPDATE provenance SET owner_id = ? WHERE id = ?", real, p))
    assert fails(env, ANON_LINKS, ("UPDATE acquisitions SET source_id = ? WHERE object_id = ?", real, o))


# ------------------------------------------------------------ names anywhere (B5)

@pytest.mark.parametrize("table, col", [
    ("object_identifiers", "value"), ("object_conditions", "note"), ("object_relations", "label"),
    ("object_inscriptions", "text"), ("provenance", "label"), ("provenance", "statement"),
    ("exhibition_venues", "note"), ("object_texts", "text"), ("terms", "label"), ("term_labels", "label"),
    ("meta", "value")])
def test_a_protected_name_in_a_field_the_website_does_not_show_fails(env, table, col):
    assert fails(env, NAMES, (f"UPDATE {table} SET {col} = 'x ' || ? || ' y' WHERE rowid = (SELECT MIN(rowid) FROM {table})", env["full"]))


def test_a_protected_name_in_other_spellings_fails(env):
    full = env["full"]
    for variant in (full.upper(), full.lower(), unicodedata.normalize("NFD", full), full.replace(" ", "\n  "),
                    f"{env['surname']}, {env['given']}"):
        assert fails(env, NAMES, ("UPDATE object_conditions SET note = ? WHERE rowid = (SELECT MIN(rowid) FROM object_conditions)",
                                  f"restauriert ({variant}, 2017)"))


def test_a_protected_name_as_an_actor_fails(env):
    assert fails(env, NAMES, ("INSERT INTO actors (id, kind, label) VALUES (?, 'person', ?)", env["private"][0], env["full"]))


def test_a_protected_name_in_a_field_the_website_shows_passes(env):
    for table, col in (("acquisitions", "note"), ("object_dates", "note")):
        assert failed(env, (f"UPDATE {table} SET {col} = 'x ' || ? WHERE rowid = (SELECT MIN(rowid) FROM {table})", env["full"])) == []
    # Exhibition labels are allowed too; this one also leaves its FTS copy stale, which fails FTS.
    assert not fails(env, NAMES, ("UPDATE exhibitions SET label = 'x ' || ? WHERE rowid = (SELECT MIN(rowid) FROM exhibitions)", env["full"]))


# ------------------------------------------------------------ FTS copies

def test_a_name_added_to_an_fts_table_fails(env):
    assert fails(env, FTS, ("UPDATE exhibitions_fts SET venues = venues || ? WHERE rowid = (SELECT MIN(rowid) FROM exhibitions_fts)", env["full"]))
    assert fails(env, FTS, ("INSERT INTO actors_fts VALUES ('person/injected', ?)", env["full"]))


def test_a_base_change_without_its_fts_copy_fails(env):
    assert fails(env, FTS, ("UPDATE objects SET label = label || ' x' WHERE rowid = (SELECT MIN(rowid) FROM objects)",))


def test_an_fts_shadow_table_changed_fails(env):
    assert fails(env, FTS, ("DELETE FROM objects_fts_content WHERE id = (SELECT MIN(id) FROM objects_fts_content)",))


# ------------------------------------------------------------ the other checks

def test_an_internal_or_non_url_website_fails(env):
    o = env["other"][0]
    for url in ("https://data.skkg.ch/address/1", "urn:uuid:1"):
        assert fails(env, WEBSITE, ("UPDATE addresses SET website = ? WHERE id = ?", url, o))


def test_a_stub_object_fails(env):
    assert fails(env, STUBS, ("UPDATE objects SET inventory_number = NULL WHERE rowid = (SELECT MIN(rowid) FROM objects)",))


# ------------------------------------------------------------ matching and redaction, on made-up names

def names():
    return b.Names({"address/1": (["Erika Beispiel", "Beispiel, Erika", "Beispiel Erika"], "Atelier Erika Beispiel"),
                    "address/2": (["Jörg Strauß", "Strauß, Jörg", "Strauß Jörg"], None),
                    "address/3": (["Zoë Mützenmacher", "Mützenmacher, Zoë", "Mützenmacher Zoë"], None)})


def test_names_match_whole_names_only_in_any_case_form_and_spacing():
    n = names()
    for text in ("inv. Erika Beispiel nr. 4", "ERIKA BEISPIEL", "beispiel,erika", "Erika\n Beispiel.", "(Beispiel Erika)",
                 unicodedata.normalize("NFD", "Jörg Strauß"), unicodedata.normalize("NFD", "ZOË MÜTZENMACHER"), "JÖRG STRAUSS"):
        assert n.found(text), text
    for text in ("Frederika Beispiel", "Erika Beispielhaft", "Erika", "Beispiel", "Erikas Beispiel"):
        assert not n.found(text), text


def test_a_name_inside_the_persons_own_organisation_is_allowed():
    n = names()
    assert not n.found("Atelier Erika Beispiel, Zürich")
    assert n.found("Atelier Erika Beispiel (Erika Beispiel)")
    assert n.found("Atelier Jörg Strauß")


def test_redaction_replaces_each_name_and_keeps_the_rest():
    n = names()
    assert n.redact("Inv. Erika Beispiel Nr. 401") == "Inv. Privatperson Nr. 401"
    assert n.redact("restauriert (Herrn JÖRG STRAUSS, Feb. 2017) und Erika Beispiel") == \
        "restauriert (Herrn Privatperson, Feb. 2017) und Privatperson"
    assert n.redact("Atelier Erika Beispiel, Zürich") == "Atelier Erika Beispiel, Zürich"
    assert n.redact("nothing here") == "nothing here"


def test_no_persons_match_nothing():
    assert not b.Names({}).found("Erika Beispiel")
