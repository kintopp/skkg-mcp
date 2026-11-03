"""Describe the shape of provenance-related data in a gzipped Turtle dump.

Subject and object URIs are turned into patterns by replacing IDs with {id}, so the
output is a schema: (subject pattern, predicate, object pattern or literal kind) counts.
It covers nodes under /provenance/ and /registrar/, and object nodes that are
acquisitions, payments, or ownership changes. It also counts the type labels used on
those nodes and prints a few short text samples from provenance records.
"""
import collections
import gzip
import re
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
ID = re.compile(r"^([0-9a-f]{8}-[0-9a-f-]{27}|\d+)$")
NS = {
    CRM: "crm:", "https://linked.art/ns/terms/": "la:", "https://ontology.skkg.ch/": "skkg:",
    "https://ontology.swissartresearch.net/aaao/": "aaao:", "http://www.w3.org/2000/01/rdf-schema#": "rdfs:",
    "http://www.w3.org/2004/02/skos/core#": "skos:", "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf:",
    "http://www.ics.forth.gr/isl/CRMdig/": "crmdig:", D: "data:", "http://schema.org/": "schema:",
}
FOCUS = ("provenance", "registrar")
OBJECT_HINTS = ("acquisition", "payment", "ownership", "provenance", "transfer", "purchase")


def cur(u):
    for k, v in NS.items():
        if u.startswith(k):
            return v + u[len(k):]
    return u


def pattern(u):
    if not u.startswith(D):
        return cur(u)
    return "data:" + "/".join("{id}" if ID.match(seg) else seg for seg in u[len(D):].split("/"))


def focus(u):
    if not u.startswith(D):
        return False
    parts = u[len(D):].split("/")
    if parts[0] in FOCUS:
        return True
    return parts[0] == "object" and any(h in seg.lower() for seg in parts[2:] for h in OBJECT_HINTS)


shape = collections.Counter()
types_of = collections.defaultdict(set)
label = {}
node_types = collections.Counter()
text_samples = collections.defaultdict(list)
prov_records = set()
prov_node_class = {}

with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if p == LABEL and isinstance(o, Literal):
            label.setdefault(s, o.value)
        if not focus(s):
            continue
        sp = pattern(s)
        if s.startswith(D + "provenance/") and s.count("/") == 4:
            prov_records.add(s)
        if p == TYPE:
            node_types[(sp, cur(o.value))] += 1
            continue
        if isinstance(o, Literal):
            dt = cur(o.datatype.value).replace("http://www.w3.org/2001/XMLSchema#", "xsd:")
            shape[(sp, cur(p), f'"literal" {dt}')] += 1
            key = (sp, cur(p))
            if len(text_samples[key]) < 3 and len(o.value) > 25:
                text_samples[key].append(o.value[:160])
        else:
            shape[(sp, cur(p), pattern(o.value))] += 1
            if p == CRM + "P2_has_type":
                types_of[sp].add(o.value)

print("provenance records:", len(prov_records))
print("\n## node classes (pattern, rdf:type) count")
for (sp, c), n in sorted(node_types.items()):
    print(f"{n:8d} {sp}  a {c}")
print("\n## edges (subject pattern, predicate, object pattern) count")
for (sp, p, op), n in sorted(shape.items()):
    if n >= 3:
        print(f"{n:8d} {sp}  {p}  {op}")
print("\n## type labels used via crm:P2_has_type, per subject pattern")
for sp, ts in types_of.items():
    c = collections.Counter(label.get(t, cur(t)) for t in ts)
    print(sp, "->", sorted(c)[:40])
print("\n## text samples (first 160 chars)")
for (sp, p), vals in text_samples.items():
    if "label" in p or "P190" in p or "P3_has_note" in p:
        print(sp, p)
        for v in vals:
            print("    ", v.replace("\n", " "))
