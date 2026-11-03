"""Second pass: address parts, contact data patterns, person types, payment contents.

Prints counts and value shapes, and only a few short examples, to limit how much
personal data is copied into the output.
"""
import collections
import gzip
import re
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
LA = "https://linked.art/ns/terms/"
LABELS = {"http://www.w3.org/2000/01/rdf-schema#label", "http://www.w3.org/2004/02/skos/core#prefLabel"}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE = re.compile(r"(\+|00)\d[\d ()/.-]{7,}\d")
STREET = re.compile(r"\b\w+(strasse|str\.|gasse|weg|platz|rue|avenue|via)\s*\d+", re.I)

label = {}
node_type = collections.defaultdict(set)  # node -> type URIs (P2_has_type)
node_text = collections.defaultdict(list)  # node -> P190 / label literals
top_person_types = collections.Counter()
person_subjects = set()
person_with_life = set()
pattern_hits = collections.Counter()
pay_preds = collections.Counter()
pay_nodes, amount_nodes = set(), set()
pay_links = collections.defaultdict(list)
amount_values = []
payee_payer_modules = collections.Counter()

with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if p in LABELS and isinstance(o, Literal) and s not in label:
            label[s] = o.value
        mod = s.removeprefix(D).split("/") if s.startswith(D) else None
        if mod and mod[0] in ("address", "person"):
            if p == CRM + "P2_has_type":
                node_type[s].add(o.value)
            if isinstance(o, Literal):
                node_text[s].append(o.value)
                for name, rx in (("email", EMAIL), ("phone", PHONE), ("street+number", STREET)):
                    if rx.search(o.value):
                        pattern_hits[(mod[0], name)] += 1
            if mod[0] == "person" and len(mod) == 2:
                person_subjects.add(s)
                if p in (CRM + "P98i_was_born", CRM + "P100i_died_in", CRM + "P95i_was_formed_by"):
                    person_with_life.add(s)
        if p == "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" and o.value == LA + "Payment":
            pay_nodes.add(s)
        if p == CRM + "P90_has_value" and isinstance(o, Literal):
            amount_values.append(o.value)
        pay_links[s].append((p, o.value))

for s in pay_nodes:
    for p, o in pay_links[s]:
        pay_preds[p] += 1
        if p in (LA + "paid_to", LA + "paid_from"):
            payee_payer_modules[(p.rsplit("/", 1)[1], o.removeprefix(D).split("/")[0] if o.startswith(D) else "external")] += 1

print("## address part types (nested nodes) -> count, value shape example")
part_types = collections.Counter()
part_example = {}
for node, ts in node_type.items():
    if node.startswith(D + "address/") and node.count("/") > 4:
        for ty in ts:
            lab = label.get(ty, ty)
            part_types[lab] += 1
            if lab not in part_example and node_text.get(node):
                v = node_text[node][0]
                part_example[lab] = re.sub(r"[A-Za-zÀ-ÿ]", "x", v)[:30]  # shape only
for lab, c in part_types.most_common(25):
    print(f"{c:6d} {lab}  shape={part_example.get(lab, '')!r}")

print("## contact data patterns found in literals (module, pattern) -> count")
print(dict(pattern_hits))

print("## types on top-level person records")
for s in person_subjects:
    for ty in node_type.get(s, ()):
        top_person_types[label.get(ty, ty)] += 1
for lab, c in top_person_types.most_common(20):
    print(f"{c:6d} {lab}")
print("top-level person records:", len(person_subjects), "| with birth/death/formation:", len(person_with_life))

print("## predicates on Payment nodes")
for p, c in pay_preds.most_common(15):
    print(f"{c:6d} {p}")
print("payer/payee targets:", dict(payee_payer_modules))
print("P90_has_value literals in dump:", len(amount_values))
