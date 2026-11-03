"""Third pass: context of pattern hits, named addresses, undated persons, payment labels.

Example values are masked: letters become x and digits become 9.
"""
import collections
import gzip
import re
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
LA = "https://linked.art/ns/terms/"
PHONE = re.compile(r"(\+|00)\d[\d ()/.-]{7,}\d")
STREET = re.compile(r"\b\w+(strasse|str\.|gasse|weg|platz|rue|avenue|via)\s*\d+", re.I)
LIFE = {CRM + "P98i_was_born", CRM + "P100i_died_in", CRM + "P95i_was_formed_by"}


def mask(v):
    return re.sub(r"\d", "9", re.sub(r"[A-Za-zÀ-ÿ]", "x", v))[:60]


def top(uri):
    """Top-level record URI for a nested node, e.g. .../person/123/name/1 -> .../person/123."""
    parts = uri.removeprefix(D).split("/")
    return D + "/".join(parts[:2])


hits = collections.Counter()
hit_examples = collections.defaultdict(list)
address_with_names = set()
address_inbound = collections.Counter()
person_life = set()
person_all = set()
person_inbound = collections.defaultdict(collections.Counter)
pay_amount_nodes = {}
amount_value = {}
amount_currency = {}
pay_labels = []
given_family = {"Given Name", "Family Name"}
type_label = {}
name_part_nodes = collections.defaultdict(set)

with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if p == "http://www.w3.org/2000/01/rdf-schema#label" and s.startswith(D + "type/"):
            type_label.setdefault(s, o.value)
        sm = s.removeprefix(D).split("/") if s.startswith(D) else [""]
        if sm[0] in ("person", "address") and isinstance(o, Literal):
            for name, rx in (("phone", PHONE), ("street+number", STREET)):
                if rx.search(o.value):
                    key = (sm[0], name, p.rsplit("/", 1)[-1].rsplit("#", 1)[-1])
                    hits[key] += 1
                    if len(hit_examples[key]) < 3:
                        hit_examples[key].append(mask(o.value))
        if sm[0] == "address" and p == CRM + "P2_has_type":
            name_part_nodes[o.value].add(top(s))
        if sm[0] == "person" and len(sm) == 2:
            person_all.add(s)
            if p in LIFE:
                person_life.add(s)
        if isinstance(o, NamedNode) and o.value.startswith(D):
            om = o.value.removeprefix(D).split("/")
            if om[0] == "person" and len(om) == 2 and sm[0] != "person":
                person_inbound[o.value][(sm[0], p.rsplit("/", 1)[-1])] += 1
            if om[0] == "address" and sm[0] != "address":
                address_inbound[top(o.value)] += 1
        if p == LA + "paid_amount":
            pay_amount_nodes[s] = o.value
        if p == CRM + "P90_has_value":
            amount_value[s] = o.value
        if p == CRM + "P180_has_currency":
            amount_currency[s] = o.value
        if p == "http://www.w3.org/2000/01/rdf-schema#label" and "/payment" in s:
            if len(pay_labels) < 3:
                pay_labels.append(mask(o.value))

print("## pattern hits by (module, pattern, predicate), masked examples")
for k, c in hits.most_common():
    print(c, k, hit_examples[k])

for ty, recs in name_part_nodes.items():
    if type_label.get(ty) in given_family:
        address_with_names |= recs
linked = sum(1 for a in address_with_names if address_inbound.get(a))
print(f"## address records with given/family name parts: {len(address_with_names)}, linked from other records: {linked}")

undated = person_all - person_life
usage = collections.Counter()
unused = 0
for pid in undated:
    inbound = person_inbound.get(pid)
    if not inbound:
        unused += 1
    for k in (inbound or {}):
        usage[k] += 1
print(f"## persons without life dates: {len(undated)}, with no inbound link in this sample: {unused}")
for k, c in usage.most_common(15):
    print(f"{c:6d} {k}")

print("## payments")
with_value = [n for n in pay_amount_nodes.values() if n in amount_value]
print("payments with a value:", len(with_value), "of", len(pay_amount_nodes))
cur = collections.Counter(amount_currency.get(n, "none").rsplit("/", 1)[-1] for n in with_value)
print("currencies:", dict(cur.most_common(6)))
print("payment label shapes:", pay_labels)
