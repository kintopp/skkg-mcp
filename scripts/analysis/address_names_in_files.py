# Counts occurrences of address-record name parts (given names, surnames) in files; prints counts only.
# Usage: uv run --with pyoxigraph python -I scripts/analysis/address_names_in_files.py STORE_DIR FILE...
import re, sys, unicodedata
from pyoxigraph import Store
store = Store.read_only(sys.argv[1])
Q = """PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
SELECT ?v WHERE { ?a a <https://ontology.skkg.ch/Address> ; crm:P1_is_identified_by ?n . ?n crm:P106_is_composed_of ?p .
  ?p crm:P2_has_type ?t ; crm:P190_has_symbolic_content ?v .
  FILTER(?t IN (<http://vocab.getty.edu/aat/300404651>, <http://vocab.getty.edu/aat/300404652>)) }"""
norm = lambda s: unicodedata.normalize("NFC", s).casefold()
parts = {norm(s["v"].value) for s in store.query(Q)}
parts = {p for p in parts if len(p) >= 3}
for f in sys.argv[2:]:
    text = norm(open(f, encoding="utf-8").read())
    hits = sum(1 for p in parts if re.search(rf"(?<!\w){re.escape(p)}(?!\w)", text))
    print(f"{hits:3d} name parts found in {f.rsplit('/', 1)[-1]}")
