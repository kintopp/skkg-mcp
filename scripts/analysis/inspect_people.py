"""Profile address, person and payment data in a gzipped Turtle dump.

For subjects under /address/ and /person/ (including nested nodes), count predicates
and keep two short example literals each. Also record which predicates point at
address records, and birth/death years for persons, to estimate how many may be living.
"""
import collections
import gzip
import re
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
PAY = "https://linked.art/ns/terms/Payment"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"


def short(term):
    v = term.value
    return (v[:45] + "...") if len(v) > 48 else v


def kind(uri):
    if not uri.startswith(D):
        return None
    parts = uri.removeprefix(D).split("/")
    return parts[0], len(parts) > 2  # (module, nested node?)


preds = {k: collections.Counter() for k in ("address", "person")}
examples = {k: collections.defaultdict(list) for k in ("address", "person")}
inbound_to_address = collections.Counter()
payment_nodes = set()
payment_subject_modules = collections.Counter()
person_years = collections.defaultdict(dict)  # person id -> {'birth': y, 'death': y}
triples = []  # keep birth/death/timespan links for a second pass
events = {}  # event uri -> ('birth'|'death', person)
spans = {}  # event uri -> timespan uri
span_year = {}

with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        k = kind(s)
        if k and k[0] in preds:
            preds[k[0]][p] += 1
            if isinstance(o, Literal) and len(examples[k[0]][p]) < 2:
                examples[k[0]][p].append(short(o))
        if isinstance(o, NamedNode):
            ko = kind(o.value)
            if ko and ko[0] == "address" and not (k and k[0] == "address"):
                inbound_to_address[(k[0] if k else s.split("/")[2], p)] += 1
        if p == RDF_TYPE and o.value == PAY:
            payment_nodes.add(s)
            payment_subject_modules[k[0] if k else "other"] += 1
        if p == "http://www.cidoc-crm.org/cidoc-crm/P98i_was_born":
            events[o.value] = ("birth", s)
        elif p == "http://www.cidoc-crm.org/cidoc-crm/P100i_died_in":
            events[o.value] = ("death", s)
        elif p == "http://www.cidoc-crm.org/cidoc-crm/P4_has_time-span":
            spans[s] = o.value
        elif p in ("http://www.cidoc-crm.org/cidoc-crm/P82a_begin_of_the_begin",
                   "http://www.cidoc-crm.org/cidoc-crm/P82_at_some_time_within"):
            m = re.match(r"-?\d{4}", o.value)
            if m and o.value and s not in span_year:
                span_year[s] = int(m.group())

for ev, (which, person) in events.items():
    y = span_year.get(spans.get(ev))
    person_years[person][which] = y

for k in preds:
    print(f"## predicates on /{k}/ subjects")
    for p, c in preds[k].most_common(40):
        print(f"{c:7d} {p}  {examples[k].get(p, '')}")
print("## predicates pointing at /address/ records (from module, predicate)")
for (m, p), c in inbound_to_address.most_common(15):
    print(f"{c:7d} {m} {p}")
print("## payment nodes by module", dict(payment_subject_modules))

persons = [u for u in person_years]
born = [v.get("birth") for v in person_years.values()]
no_death = [v for v in person_years.values() if "death" not in v]
recent_no_death = [v for v in no_death if v.get("birth") and v["birth"] >= 1926]
print("## persons with birth or death event:", len(persons))
print("   with a birth year:", sum(1 for b in born if b))
print("   no death event:", len(no_death))
print("   no death event and born 1926 or later (possibly living):", len(recent_no_death))
