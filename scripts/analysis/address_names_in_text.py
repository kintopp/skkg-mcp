# Counts where full names (given + surname) of named address records appear in the built database.
# Prints counts only, never a name.
# Usage: uv run --with pyoxigraph python -I scripts/analysis/address_names_in_text.py STORE_DIR DB_PATH
import sqlite3, sys
from collections import defaultdict
from pyoxigraph import Store
store = Store.read_only(sys.argv[1])
db = sqlite3.connect(f"file:{sys.argv[2]}?mode=ro", uri=True)
Q = """PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
SELECT ?a ?t ?v WHERE { ?a a <https://ontology.skkg.ch/Address> ; crm:P1_is_identified_by ?n . ?n crm:P106_is_composed_of ?p .
  ?p crm:P2_has_type ?t ; crm:P190_has_symbolic_content ?v .
  FILTER(?t IN (<http://vocab.getty.edu/aat/300404651>, <http://vocab.getty.edu/aat/300404652>)) }"""
parts = defaultdict(dict)
for s in store.query(Q):
    parts[s["a"].value]["g" if s["t"].value.endswith("651") else "s"] = s["v"].value
full = {a: f"{p['g']} {p['s']}".lower() for a, p in parts.items() if "g" in p and "s" in p}
print("address records with name parts:", len(parts), "with both parts:", len(full))
cols = [("object_identifiers", "value"), ("object_relations", "label"), ("object_conditions", "note"),
        ("acquisitions", "note"), ("object_texts", "text"), ("object_inscriptions", "text"), ("provenance", "statement"),
        ("provenance", "label"), ("actors", "label"), ("terms", "label"), ("exhibitions", "label"), ("object_dates", "note")]
have = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
hits_by_rec = defaultdict(set)
for t, c in cols:
    if t not in have or c not in {r[1] for r in db.execute(f"PRAGMA table_info({t})")}:
        print(f"{t}.{c}: (no such column)"); continue
    rows = [str(v).lower() for (v,) in db.execute(f"SELECT {c} FROM {t} WHERE {c} IS NOT NULL")]
    n_rows = 0; recs = set()
    for a, name in full.items():
        k = sum(1 for v in rows if name in v)
        if k: n_rows += k; recs.add(a); hits_by_rec[a].add(f"{t}.{c}")
    print(f"{t}.{c}: {n_rows} rows, {len(recs)} records")
in_actor = {a for a, s in hits_by_rec.items() if "actors.label" in s}
print("records whose full name is in some text:", len(hits_by_rec), "of which also an actor label:", len(in_actor),
      "-> text only:", len(hits_by_rec.keys() - in_actor))
