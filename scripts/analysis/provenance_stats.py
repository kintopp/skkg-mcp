"""Collection-wide provenance statistics for a gzipped SKKG Turtle dump.

Counts vocabulary values per role (certainty, ownership kind, transaction type, actor
role, date qualifiers, source types, acquisition types, provenance status, currencies),
chain lengths per object, date coverage, and a few structural features.
"""
import collections
import gzip
import re
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
LA = "https://linked.art/ns/terms/"
TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
ID = re.compile(r"^([0-9a-f]{8}-[0-9a-f-]{27}|\d+)$")


def pattern(u):
    return "/".join("{id}" if ID.match(seg) else seg for seg in u[len(D):].split("/"))


label = {}
typed = collections.defaultdict(collections.Counter)  # role pattern -> type uri counts
status_assigned = collections.Counter()
currency = collections.Counter()
objects = set()
chain = collections.defaultdict(set)  # object -> provenance records
prov_objects = collections.defaultdict(set)
prov_begin_year = {}
date_of = {}
private_individual = 0
acq_with_seller = 0
acq_total = 0
actors_members = collections.Counter()
prov_payment_values = 0
prov_has_statement = 0
conversions = 0
notes_total = 0
transfer_custody = 0

with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if p == LABEL and isinstance(o, Literal):
            label.setdefault(s, o.value)
        if not s.startswith(D):
            continue
        sp = pattern(s)
        if p == TYPE:
            if o.value == "https://ontology.skkg.ch/Object":
                objects.add(s)
            elif o.value == CRM + "E8_Acquisition" and sp == "object/{id}/acquisition":
                acq_total += 1
            elif o.value == CRM + "E10_Transfer_of_Custody":
                transfer_custody += 1
            elif "conversion" in sp and sp.endswith("conversion"):
                conversions += 1
            continue
        if p == CRM + "P2_has_type" and o.value.startswith(D + "type/") and (
                sp.startswith("provenance/") or sp.startswith("object/{id}/acquisition")):
            typed[sp][o.value] += 1
        elif p == CRM + "P141_assigned" and sp == "object/{id}/provenanceStatus/{id}":
            status_assigned[o.value] += 1
        elif p == CRM + "P180_has_currency":
            currency[o.value] += 1
        elif p == CRM + "P16_used_specific_object" and sp == "provenance/{id}/object/{id}/assignment/order":
            rec = D + "/".join(s[len(D):].split("/")[:2])
            chain[o.value].add(rec)
            prov_objects[rec].add(o.value)
        elif p == CRM + "P23_transferred_title_from" and sp == "object/{id}/acquisition":
            acq_with_seller += 1
            if o.value.endswith("/privateIndividual"):
                private_individual += 1
        elif p == CRM + "P107_has_current_or_former_member" and sp == "provenance/{id}/transaction/actors":
            actors_members[s] += 1
        elif p == CRM + "P4_has_time-span" and sp == "provenance/{id}":
            date_of[s] = o.value
        elif p == CRM + "P82a_begin_of_the_begin" and sp == "provenance/{id}/date/{id}":
            m = re.match(r"-?\d{4}", o.value)
            if m:
                prov_begin_year[s] = int(m.group())
        elif p == CRM + "P90_has_value" and sp == "provenance/{id}/payment/{id}/price":
            prov_payment_values += 1
        elif p == CRM + "P190_has_symbolic_content" and sp == "provenance/{id}/statement":
            prov_has_statement += 1


def show(title, counter, n=30):
    print(f"\n## {title}")
    for u, c in counter.most_common(n):
        print(f"{c:8d} {label.get(u, u)}")


print("objects (skkg:Object):", len(objects))
print("provenance records:", len(prov_objects), "| with statement text:", prov_has_statement)
print("objects with at least one provenance record:", len(chain))
lens = collections.Counter(min(len(v), 10) for v in chain.values())
print("chain length distribution (10 = 10 or more):", dict(sorted(lens.items())))
multi = sum(1 for v in prov_objects.values() if len(v) > 1)
print("provenance records shared by several objects:", multi,
      "| max objects on one record:", max((len(v) for v in prov_objects.values()), default=0))
members = collections.Counter(min(v, 5) for v in actors_members.values())
print("members per transaction actor group (5 = 5 or more):", dict(sorted(members.items())))
print("custody transfers (E10):", transfer_custody, "| provenance prices with value:", prov_payment_values)
print("SKKG acquisitions:", acq_total, "| with seller/donor:", acq_with_seller,
      "| seller anonymised as person/privateIndividual:", private_individual, "| price conversions:", conversions)
years = [prov_begin_year[d] for d in date_of.values() if d in prov_begin_year]
dec = collections.Counter((y // 50) * 50 for y in years)
print("provenance begin years: n =", len(years), "min", min(years, default=None), "max", max(years, default=None))
print("by half century:", dict(sorted(dec.items())))

for sp in sorted(typed):
    show(f"types on {sp}", typed[sp])
show("provenance status of objects (P141_assigned)", status_assigned)
show("currencies", currency, 12)
