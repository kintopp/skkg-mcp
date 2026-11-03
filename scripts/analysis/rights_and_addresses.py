"""Map rights data on multimedia records, and find address records that carry personal names.

Multimedia: counts the edges of rights-related nodes as URI patterns, counts the type
labels on those nodes, and picks example multimedia records for each rights type, with
the object they represent. Addresses: lists address records with given or family name
parts and the records that link to them. Prints URIs and counts, not names.
"""
import collections
import gzip
import re
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
ID = re.compile(r"^([0-9a-f]{8}-[0-9a-f-]{27}|\d+)$")


def pattern(u):
    if not u.startswith(D):
        return u.replace(CRM, "crm:").replace("https://ontology.swissartresearch.net/aaao/", "aaao:")
    return "/".join("{id}" if ID.match(seg) else seg for seg in u[len(D):].split("/"))


def top(u):
    return D + "/".join(u[len(D):].split("/")[:2])


label = {}
shape = collections.Counter()
right_types = collections.defaultdict(collections.Counter)  # node pattern -> type uri counts
mm_right_type = collections.defaultdict(set)  # multimedia -> (node pattern, type uri)
obj_of_mm = {}
addr_types = collections.defaultdict(set)
addr_inbound = collections.defaultdict(set)

with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if p == LABEL and isinstance(o, Literal):
            label.setdefault(s, o.value)
        if not s.startswith(D):
            continue
        mod = s[len(D):].split("/")[0]
        if mod == "object" and p == CRM + "P138i_has_representation":
            obj_of_mm.setdefault(o.value, top(s))
        if mod == "multimedia":
            sp = pattern(s)
            if "right" in sp.lower() or "Right" in p or "right" in p:
                op = f"literal {o.datatype.value.rsplit('#', 1)[-1]}" if isinstance(o, Literal) else pattern(o.value)
                shape[(sp, pattern(p), op)] += 1
                if p == CRM + "P2_has_type" and o.value.startswith(D + "type/"):
                    right_types[sp][o.value] += 1
                    mm_right_type[top(s)].add((sp, o.value))
        if mod == "address" and p == CRM + "P2_has_type":
            addr_types[top(s)].add(o.value)
        if isinstance(o, NamedNode) and o.value.startswith(D + "address/") and mod != "address":
            addr_inbound[top(o.value)].add(top(s))

print("## rights-related edges on multimedia nodes (pattern, predicate, object) count")
for (sp, p, op), n in sorted(shape.items()):
    if n >= 5:
        print(f"{n:8d} {sp}  {p}  {op}")
print("\n## type labels on rights nodes")
for sp, c in right_types.items():
    print(sp)
    for u, n in c.most_common(15):
        print(f"   {n:8d} {label.get(u, u)}  <{u}>")

print("\n## example multimedia per rights type (multimedia, object)")
seen = collections.defaultdict(list)
for mm, pairs in mm_right_type.items():
    for sp, ty in pairs:
        key = (sp, label.get(ty, ty))
        if len(seen[key]) < 2 and mm in obj_of_mm:
            seen[key].append((mm, obj_of_mm[mm]))
for key, ex in sorted(seen.items()):
    print(key, ex)

named = [a for a, ts in addr_types.items() if {label.get(t) for t in ts} & {"Given Name", "Family Name"}]
print("\n## address records with given/family name parts:", len(named))
for a in named:
    if addr_inbound.get(a):
        print(a, "<-", sorted(addr_inbound[a]))
print("examples without inbound links:", [a for a in named if not addr_inbound.get(a)][:3])
