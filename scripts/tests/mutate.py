"""Breaks each guard of the privacy checks in turn and expects the tests that cover it to fail.

Run: uv run --with pyoxigraph --with pytest python -I scripts/tests/mutate.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "scripts" / "build_db.py"
# (what it breaks, original text, mutated text, pytest -k expression of the tests that must fail)
MUTATIONS = [
    ("schema compared", "diff = sorted(t for t in schema.keys() | want.keys() if schema.get(t) != want.get(t))", "diff = []", "name_column or new_table"),
    ("private set from the store", "flagged == private and ids == store", "ids == store", "unflagged or misses"),
    ("ids from the store", "flagged == private and ids == store", "flagged == private", "missing_from"),
    ("private label is the projection", "and label == \", \".join(x for x in (o or \"Privatperson\", pl) if x))", ")", "name_in_a_private_label or next_to_the_organisation or another_records_label"),
    ("organisation from the store", "same = all(", "same = True or all(", "organisation_column"),
    ("other labels from the store", "bad_other += not (same and label in exp[\"pref\"].get(a, ()))", "bad_other += 0", "another_address"),
    ("anonymous nodes by content", "n == 1 and m == 1", "True", "anonymous_person_node or anonymous_address_node"),
    ("placeholder label stripped", "return (label or \"\").strip().casefold().startswith(", "return (label or \"\").casefold().startswith(", "leading_space"),
    ("anonymised owners keep their label", "relabelled = sum(", "relabelled = 0 * sum(", "unflagged_or_relabelled"),
    ("anonymised owners have no child rows", "children = sum(", "children = 0 * sum(", "attached"),
    ("anonymised links from the store", "owners == exp[\"owners\"] and", "", "replaced_in_a_period"),
    ("names found after NFC", "WORD.findall(_nfc(text).casefold())", "WORD.findall(text.casefold())", "other_spellings or whole_names"),
    ("names found in every column", "if (t, c) in NAMES_SHOWN:", "if (t, c) in NAMES_SHOWN or t != 'addresses':", "field_the_website_does_not or as_an_actor"),
    ("shown fields allowed", "NAMES_SHOWN = {(\"acquisitions\", \"note\"), (\"object_dates\", \"note\"),", "NAMES_SHOWN = {", "website_shows"),
    ("own organisation allowed", "        org = self.orgs.get(a)\n        if not org:\n            return False", "        return False", "own_organisation or redaction_replaces"),
    ("ß also ss", "re.sub(\"ß|ss\", \"(?:ß|ss)\", re.escape(w))", "re.escape(w)", "redaction_replaces"),
    ("FTS content compared", "if Counter(rows) != Counter(db.execute(f\"SELECT * FROM {table}\").fetchall()):", "if False:", "fts_table or base_change"),
    ("website outside", "AND (website NOT LIKE 'http%' OR", "AND (0 AND", "website_fails"),
    ("anonymised owner's own row checked", "named = db.execute(", "named = 0 * db.execute(", "own_row"),
    ("anonymised owner's gender checked", "OR COALESCE(gender_id, birth_label,", "OR COALESCE(birth_label,", "own_row"),
    ("anonymised owners from the store", "anon = sorted(exp[\"anon\"] | actors.keys())", "anon = sorted(actors.keys() or exp[\"anon\"])", "unflagged_owners_own_row"),
    ("anonymised owner's nationality checked", '("actor_nationalities", "actor_id"), ', "", "attached"),
    ("loader drops an anonymised owner's gender", "None if anon else gender.get(a)", "gender.get(a)", "anonymised_owner_is_loaded"),
    ("loader drops an anonymised owner's nationality", "[r for r in nat if r[0] not in anonymised]", "nat", "anonymised_owner_is_loaded"),
    ("anonymised owner's life data checked", "death_to, death_place, death_place_id, biography) IS NOT NULL)", "death_to, death_place, death_place_id, biography) IS NOT NULL AND 0)", "own_row"),
    # The data rules of test_build_rules.py.
    ("kind only from the media type vocabulary", "(SELECT id FROM terms WHERE scheme_id = ? AND label_de = ?)", "(SELECT id FROM terms WHERE ? IS NOT NULL AND label_de = ?)", "primary_image"),
    ("report counts photos only as photos", "AND y.iiif_service IS NOT NULL AND y.kind = 'image')", "AND y.iiif_service IS NOT NULL AND y.kind IS NOT 'document')", "primary_image"),
    ("unlinked multimedia dropped", "    unlinked = drop_unlinked_multimedia(db)\n", "    unlinked = {}\n", "no_object_or_exhibition"),
    ("exhibition images kept", "\"AND NOT EXISTS (SELECT 1 FROM exhibition_multimedia x WHERE x.multimedia_id = multimedia.id)\")", "\"\")", "no_object_or_exhibition"),
    ("unlinked published counted", "COUNT(iiif_service) FROM multimedia WHERE {UNLINKED_MULTIMEDIA}", "COUNT(*) FROM multimedia WHERE {UNLINKED_MULTIMEDIA}", "no_object_or_exhibition"),
    ("primary fallback skips documents", "ORDER BY m.kind IS 'document', om.seq IS NULL, om.seq LIMIT 1", "ORDER BY om.seq IS NULL, om.seq LIMIT 1", "primary_image"),
    ("documents last, untyped kept", "ORDER BY m.kind IS 'document', om.seq IS NULL, om.seq LIMIT 1", "ORDER BY m.kind IS NOT 'image', om.seq IS NULL, om.seq LIMIT 1", "primary_image"),
    ("kind from the media type", 'MEDIA_KINDS = {"Bild": "image", "Dokument": "document", "Ton": "sound"}', 'MEDIA_KINDS = {"Bild": "image", "Ton": "sound"}', "primary_image"),
    ("report counts documents beside a photo", "SUM(m.kind = 'document' AND {published_image})", "SUM(m.kind = 'document')", "primary_image"),
    ("report counts fallback documents", "SUM(sk.multimedia_id IS NULL AND m.kind = 'document')", "SUM(m.kind = 'document')", "primary_image"),
    ('citizenship node not loaded', '            t = t[: -len("/citizenship")]\n            nat.append((a, t))', '            nat.append((a, t[: -len("/citizenship")]))', 'citizenship_node'),
    ('life date year from the label', '    if y0 is None and y1 is None and lab:\n', '    if False:\n', 'life_dates_without'),
    ('label never overrides a time-span', '    if y0 is None and y1 is None and lab:\n', '    if lab:\n', 'life_dates_without'),
    ('life date label must be a plain date', 'LIFE_DATE_LABEL = re.compile(r"(?:[\\d./ ]*\\.\\s*)?(\\d{3,4})")', 'LIFE_DATE_LABEL = re.compile(r"(?:.*\\s*)?(\\d{3,4})")', 'plain_date'),
    ('life date labels without a year counted', '"years from the label" if y0 is not None else "labels without a year"', '"years from the label"', 'life_dates_without'),
    ('country-only place dropped', '    if pl and UNSPECIFIED_PLACE.fullmatch(pl):\n', '    if False:\n', 'life_dates_without'),
    ("seit opens the end", '"from": {"seit", "mindestens seit"}', '"from": set()', "test_period_span"),
    ("bis opens the start", '"to": {"bis", "spätestens bis"}}', '"to": set()}', "test_period_span"),
    ("o. D. bound opens the end", 'UNKNOWN_BOUND = {"from": "9999",', 'UNKNOWN_BOUND = {"from": "x",', "test_period_span"),
    ("o. D. bound opens the start", '"to": "0001"}', '"to": "x"}', "test_period_span"),
    ("a qualified lone date is one event", '"from": {"seit", "mindestens seit"}',
     '"from": {"seit", "mindestens seit", "vor", "um", "spätestens", "mindestens", "nach"}', "test_period_span"),
    ("unknown qualifier of the dated side counted", "classified = (own is None or", "classified = True or (own is None or", "test_period_span or classify"),
    ("unknown qualifier of the other side counted", "| DATE_QUALIFIERS) and other in UNKNOWN_SIDE", "| DATE_QUALIFIERS)", "test_period_span"),
    ("an opened period still counted", '(y, OPEN_YEAR, "open end", classified)', '(y, OPEN_YEAR, "open end", True)', "test_period_span or classify"),
    ("an opened start still counted", '(-OPEN_YEAR, y, "open start", classified)', '(-OPEN_YEAR, y, "open start", True)', "test_period_span"),
    ("frühestens ab left unclassified", '"vor", "nach"}', '"vor", "nach", "frühestens ab"}', "test_period_span"),
    ("a lone date without a year counted", '    if y is None:\n        return None, None, "date without a year", False\n', "", "test_period_span or classify"),
    ("two dates without a year counted", "if first is None or last is None:", "if False:", "test_period_span"),
    ("sort key shifts the year", 'return f"{_shifted(y)} {recorded}"', 'return f"{y} {recorded}"', "sort_keys"),
    ("sort key breaks ties by the date", 'return f"{_shifted(y)} {recorded}"', 'return f"{_shifted(y)}"', "sort_keys or sort_key"),
    ("recorded date in chronological order", 'recorded = f"{_shifted(int(m.group(1)))}{date[m.end():]}" if m else (date or "")',
     'recorded = date or ""', "chronological_order"),
    ("unresolved qualifier counted", 'return None if q is None else labels.get(q) or f"unresolved {q}"', "return labels.get(q)", "classify"),
    ("after the dump by date", 'WHERE sort_key > ? GROUP BY year ORDER BY year", (sort_key(year(as_of), as_of),))',
     'WHERE date > ? GROUP BY year ORDER BY year", (as_of,))', "after_the_dump"),
    ("dates not ISO counted", "sum(not ISO_DATE.fullmatch(v) for", "sum(0 and not ISO_DATE.fullmatch(v) for", "iso_form"),
    ("latest side keyed by its year", "sort_key(last, dt or df), pid", "sort_key(first, dt or df), pid", "sort_keys"),
    ("period links to missing objects dropped", '            db.execute(f"DELETE FROM {table} WHERE {where}")', "            pass", "every_column"),
    ("NULL period links dropped", 'where = f"({col} IS NULL OR {where})"', "where = where", "every_column"),
    ("links to missing objects counted", "missing[f\"{table}.{col}\"] = db.execute(", "missing[f\"{table}.{col}\"] = 0 and db.execute(", "every_column"),
    ("links read from the schema", 'if fk[2] == "objects"]', 'if fk[2] == "objects" and t in ("provenance_objects", "literature_refs", "object_relations")]', "every_column"),
    ("acquisition year stored", '        y = year(d.get("date"))', "        y = None", "dated_acquisition"),
    ("acquisition sort key stored", '1 if re.search(r"\\bTotal\\b", notes) else 0, c[0], c[1], y, sort_key(y, d.get("date"))))',
     '1 if re.search(r"\\bTotal\\b", notes) else 0, c[0], c[1], y, None))', "dated_acquisition"),
    ("odd currency labels counted", "if s and s not in CURRENCY_ALIASES and not re.fullmatch(r\"[A-Z]{3}\", s):", "if False:", "currency_labels"),
    ('not stated read from the store', '            if is_not_stated(v):\n                not_stated.add(a)', '            if False:\n                not_stated.add(a)', 'not_stated'),
    ('not stated checked in every table', 'if "fts" not in t for c in cols', 'if t == "literature_actors" for c in cols', 'actor_row or any_other_table'),
    ('not stated in any capitalisation', 'return (label or "").strip().casefold() in NOT_STATED', 'return (label or "").strip() in NOT_STATED', 'not_stated_is or label_only_actors'),
    ('not stated parts dropped', '    actors = [r for r in actors if r[1] not in not_stated]\n', '', 'label_only_actors'),
    ('not stated actors dropped', 'db.executemany("DELETE FROM actors WHERE id = ?", [(a,) for a in not_stated])', 'None', 'label_only_actors'),
    ('names near not stated counted', 'and re.search(r"\\b(angabe|genannt|unbekannt|anonym)", lab.casefold())})', 'and False})', 'label_only_actors'),
    ('credit lines composed', '    credit = credit_lines(db)\n', '    credit = {}\n', 'credit_line_joins'),
    ('blank credit text dropped', "COALESCE(', ' || NULLIF(TRIM(credit_line), ''), '')", "COALESCE(', ' || credit_line, '')", 'credit_line_joins'),
    ("credit year of the object's own acquisition", "FROM acquisitions a WHERE a.object_id = objects.id AND year IS NOT NULL)", "FROM acquisitions a WHERE year IS NOT NULL)", 'credit_line_joins'),
    ('credit year in four digits', "SELECT printf('%04d', year) FROM acquisitions a", "SELECT year FROM acquisitions a", 'credit_line_joins'),
    ('credit year only when known', "WHERE a.object_id = objects.id AND year IS NOT NULL)", "WHERE a.object_id = objects.id)", 'credit_line_joins'),
    ('credit texts counted when not blank', "COUNT(NULLIF(TRIM(o.credit_line), ''))", 'COUNT(o.credit_line)', 'credit_line_joins'),
    ('names near not stated only of stubs', 'near = sorted({lab for a, lab in stubs.items()', 'near = sorted({lab for a, lab in names.items()', 'label_only_actors'),
    ('not stated stripped', 'return (label or "").strip().casefold() in NOT_STATED', 'return (label or "").casefold() in NOT_STATED', 'not_stated_is'),
]


def main():
    source = BUILD.read_text()
    survived = []
    try:
        for what, old, new, k in MUTATIONS:
            if source.count(old) != 1:
                print(f"STALE  {what}: pattern found {source.count(old)} times")
                survived.append(what)
                continue
            BUILD.write_text(source.replace(old, new))
            r = subprocess.run([sys.executable, "-I", "-m", "pytest", "-q", "-x", "-k", k, str(ROOT / "scripts" / "tests")],
                               capture_output=True, text=True)
            # pytest exits with 5 when -k selects no test.
            killed = r.returncode == 1
            print(f"{'killed' if killed else 'NO TESTS' if r.returncode == 5 else 'SURVIVED'}  {what}", flush=True)
            if not killed:
                survived.append(what)
    finally:
        BUILD.write_text(source)
    sys.exit(1 if survived else 0)


if __name__ == "__main__":
    main()
