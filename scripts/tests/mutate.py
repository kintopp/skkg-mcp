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
    ("placeholder label stripped", "return (label or \"\").strip().casefold()", "return (label or \"\").casefold()", "leading_space"),
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
    # The data rules of test_build_rules.py.
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
    ("sort key shifts the year", 'return f"{y + OPEN_YEAR + 1:05d} {date}"', 'return f"{y} {date}"', "sort_keys"),
    ("sort key breaks ties by the date", 'return f"{y + OPEN_YEAR + 1:05d} {date}"', 'return f"{y + OPEN_YEAR + 1:05d}"', "sort_keys or sort_key"),
    ("latest side keyed by its year", "sort_key(last, dt or df), pid", "sort_key(first, dt or df), pid", "sort_keys"),
    ("period links to missing objects dropped", '            db.execute(f"DELETE FROM {table} WHERE {where}")', "            pass", "every_column"),
    ("NULL period links dropped", 'where = f"({col} IS NULL OR {where})"', "where = where", "every_column"),
    ("links to missing objects counted", "missing[f\"{table}.{col}\"] = db.execute(", "missing[f\"{table}.{col}\"] = 0 and db.execute(", "every_column"),
    ("links read from the schema", 'if fk[2] == "objects"]', 'if fk[2] == "objects" and t in ("provenance_objects", "literature_refs", "object_relations")]', "every_column"),
    ("acquisition year stored", '        y = year(d.get("date"))', "        y = None", "dated_acquisition"),
    ("acquisition sort key stored", '1 if re.search(r"\\bTotal\\b", notes) else 0, c[0], c[1], y, sort_key(y, d.get("date"))))',
     '1 if re.search(r"\\bTotal\\b", notes) else 0, c[0], c[1], y, None))', "dated_acquisition"),
    ("odd currency labels counted", "if s and s not in CURRENCY_ALIASES and not re.fullmatch(r\"[A-Z]{3}\", s):", "if False:", "currency_labels"),
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
