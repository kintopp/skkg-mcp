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
