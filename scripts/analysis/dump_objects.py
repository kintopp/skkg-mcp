"""Print the provenance chain, SKKG acquisition, and provenance status of given objects.

Usage: dump_objects.py DUMP OBJECT_URI [OBJECT_URI ...]
Writes one JSON document per object to stdout, so the output can be compared with the
REST API and the website.
"""
import collections
import gzip
import json
import sys

from pyoxigraph import Literal, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
LA = "https://linked.art/ns/terms/"
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"

targets = set(sys.argv[2:])
triples = collections.defaultdict(list)  # subject -> [(p, o)]
label = {}
prov_for = collections.defaultdict(dict)  # object -> provenance record -> order node


def top(u, n=2):
    return D + "/".join(u[len(D):].split("/")[:n])


with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if p == LABEL and isinstance(o, Literal) and (s.startswith(D + "type/") or s.startswith(D + "person/")):
            label.setdefault(s, o.value)
        if s.startswith(D + "provenance/") or (s.startswith(D + "object/") and top(s) in targets):
            triples[s].append((p, o.value))
        if (p == CRM + "P16_used_specific_object" and o.value in targets and s.startswith(D + "provenance/")
                and s.endswith("/assignment/order")):
            prov_for[o.value][top(s)] = None


def get(s, p):
    return [o for pp, o in triples.get(s, []) if pp == p]


def one(s, p):
    v = get(s, p)
    return v[0] if v else None


def lab(u):
    return label.get(u, u.rsplit("/", 1)[-1]) if u else None


def price(node):
    if not node:
        return None
    amount = one(node, LA + "paid_amount")
    return {"value": one(amount, CRM + "P90_has_value"), "currency": lab(one(amount, CRM + "P180_has_currency")),
            "note": one(node, CRM + "P3_has_note")} if amount else None


for obj in sys.argv[2:]:
    chain = []
    for rec in prov_for[obj]:
        order = None
        for s in triples:
            if s.startswith(rec + "/object/") and s.endswith("/order") and "assignment" not in s:
                order = one(s, CRM + "P190_has_symbolic_content")
        tx = rec + "/transaction"
        actors = one(tx, CRM + "P11_had_participant")
        chain.append({
            "order": int(order) if order else None,
            "statement": one(rec + "/statement", CRM + "P190_has_symbolic_content"),
            "types": sorted(lab(t) for t in get(rec, CRM + "P2_has_type") if t.startswith(D)),
            "dates": one(one(rec, CRM + "P4_has_time-span"), LABEL),
            "transaction": [lab(t) for t in get(tx, CRM + "P2_has_type")],
            "owner_type": [lab(t) for t in get(actors, CRM + "P2_has_type")] if actors else [],
            "owner": [lab(m) for m in get(actors, CRM + "P107_has_current_or_former_member")] if actors else [],
            "prices": [price(n) for n in get(rec, CRM + "P9_consists_of") if "/payment/" in n],
            "sources": len([s for s in triples if s.startswith(rec + "/source/") and s.count("/") == 6]),
        })
    chain.sort(key=lambda c: c["order"] or 0)
    acq = obj + "/acquisition"
    status_nodes = [s for s in triples if s.startswith(obj + "/provenanceStatus/") and s.count("/") == 6]
    out = {
        "object": obj,
        "acquisition": {
            "type": [lab(t) for t in get(acq, CRM + "P2_has_type")],
            "date": one(one(acq, CRM + "P4_has_time-span"), LABEL),
            "from": [lab(x) for x in get(acq, CRM + "P23_transferred_title_from")],
            "note": one(acq, CRM + "P3_has_note"),
            "prices": [price(n) for n in get(acq, CRM + "P9_consists_of") if "/payment/" in n],
        },
        "provenance_status": [{"value": lab(one(s, CRM + "P141_assigned")),
                               "text": one(s + "/description", CRM + "P190_has_symbolic_content")}
                              for s in status_nodes],
        "chain": chain,
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))
