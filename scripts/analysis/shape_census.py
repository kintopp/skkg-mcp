"""Exhaustive census of the store: every (subject shape, predicate, object shape) edge.

Usage: shape_census.py STORE_DIR OUT_JSON

A shape is an IRI with its ids replaced, e.g. object/{uuid}/production/{n}, so rare
nested paths show up as their own rows instead of hiding among millions of instances.
Every quad is read; nothing is sampled. Literal values and P2_has_type / rdf:type
targets are tallied up to VALUE_CAP distinct values per edge.
"""
import json
import re
import sys
import time
from collections import Counter, defaultdict

from pyoxigraph import BlankNode, Literal, NamedNode, Store

VALUE_CAP = 60
TALLY_IRI_PREDICATES = {
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    "http://www.cidoc-crm.org/cidoc-crm/P2_has_type",
    "http://purl.org/dc/terms/conformsTo",
}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
NUM = re.compile(r"(?<=/)\d+(?=/|$)")
EXT = [
    ("http://vocab.getty.edu/aat/", "aat:"),
    ("http://vocab.getty.edu/tgn/", "tgn:"),
    ("http://vocab.getty.edu/ulan/", "ulan:"),
    ("http://www.wikidata.org/entity/", "wd:"),
    ("https://d-nb.info/gnd/", "gnd:"),
    ("https://iiif.digital.skkg.ch/", "iiif:"),
]


def shape(term):
    if isinstance(term, Literal):
        dt = term.datatype.value.rsplit("#", 1)[-1] if term.datatype else ""
        return f"LIT^^{dt}" + (f"@{term.language}" if term.language else "")
    if isinstance(term, BlankNode):
        return "BNODE"
    v = term.value
    if v.startswith("https://data.skkg.ch/"):
        v = v[len("https://data.skkg.ch/"):]
        v = UUID.sub("{uuid}", v)
        v = NUM.sub("{n}", v)
        return "skkg:" + v
    for prefix, short in EXT:
        if v.startswith(prefix):
            return short + "*"
    # other namespaces: keep scheme+host+first path segment
    m = re.match(r"(https?://[^/#]+/?[^/#]*)", v)
    return (m.group(1) if m else v) + "*"


def main(store_dir, out_path):
    store = Store.read_only(store_dir)
    edges = {}  # (sshape, p, oshape) -> [triples, subjects, samples, values Counter|None]
    sshape_counts = Counter()
    seen_subjects = set()
    unsorted_hits = 0
    cur, cur_keys = None, set()
    t0 = time.time()
    n = 0
    for q in store.quads_for_pattern(None, None, None, None):
        s, p, o = q.subject, q.predicate.value, q.object
        if s != cur:
            if cur is not None:
                for k in cur_keys:
                    edges[k][1] += 1
            h = hash(str(s))
            if h in seen_subjects:
                unsorted_hits += 1
            seen_subjects.add(h)
            cur, cur_keys = s, set()
            ss = shape(s)
            sshape_counts[ss] += 1
        os_ = shape(o)
        key = (ss, p, os_)
        e = edges.get(key)
        if e is None:
            e = edges[key] = [0, 0, [], Counter()]
        e[0] += 1
        cur_keys.add(key)
        if len(e[2]) < 2:
            e[2].append([str(s), str(o)[:200]])
        vals = e[3]
        if vals is not None and (isinstance(o, Literal) or p in TALLY_IRI_PREDICATES):
            vals[o.value[:120]] += 1
            if len(vals) > VALUE_CAP:
                e[3] = None
        n += 1
        if n % 5_000_000 == 0:
            print(f"{n:,} quads, {len(edges):,} edges, {time.time()-t0:.0f}s", file=sys.stderr)
    for k in cur_keys:
        edges[k][1] += 1
    out = {
        "quads": n,
        "subjects": len(seen_subjects),
        "subject_revisits": unsorted_hits,
        "seconds": round(time.time() - t0),
        "subject_shapes": sshape_counts.most_common(),
        "edges": [
            {"s": k[0], "p": k[1], "o": k[2], "triples": e[0], "subjects": e[1],
             "samples": e[2], "values": e[3].most_common() if e[3] else None,
             "values_capped": e[3] is None}
            for k, e in sorted(edges.items())
        ],
    }
    with open(out_path, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"done: {n:,} quads, {len(seen_subjects):,} subjects, {len(edges):,} edges, "
          f"{len(sshape_counts):,} subject shapes, revisits={unsorted_hits}, {out['seconds']}s",
          file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
