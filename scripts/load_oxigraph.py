"""Load a gzipped SKKG Turtle dump into a persistent Oxigraph store.

Usage: load_oxigraph.py DUMP STORE_DIR
The store directory must not exist yet, so a reload never mixes two dumps. The script
prints the triple count and a few test query results when the load is done.
"""
import gzip
import sys
import time
from pathlib import Path

from pyoxigraph import RdfFormat, Store

dump, store_dir = sys.argv[1], Path(sys.argv[2])
if store_dir.exists():
    sys.exit(f"{store_dir} exists; delete it or pick a new directory")

start = time.time()
store = Store(str(store_dir))
with gzip.open(dump, "rb") as f:
    store.bulk_load(f, RdfFormat.TURTLE)
store.optimize()
print(f"loaded in {time.time() - start:.0f} s, {len(store)} quads")

queries = {
    "objects": "SELECT (COUNT(*) AS ?n) WHERE { ?o a <https://ontology.skkg.ch/Object> }",
    "provenance records": "SELECT (COUNT(*) AS ?n) WHERE { ?p a <https://ontology.skkg.ch/Provenance> }",
    "named graphs": "SELECT (COUNT(DISTINCT ?g) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }",
}
for name, q in queries.items():
    t = time.time()
    n = next(iter(store.query(q)))["n"].value
    print(f"{name}: {n} ({time.time() - t:.2f} s)")
