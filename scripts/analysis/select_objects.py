"""Pick test objects for comparing the dump with the website and the API.

Lists objects that have a provenance chain, with chain length, the number of prices in
the chain, whether SKKG's own acquisition has a price, whether the seller is anonymised
as person/privateIndividual, and the object's identifiers and label.
"""
import collections
import gzip
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"

chain = collections.defaultdict(set)
prov_price = collections.Counter()  # provenance record -> prices
acq_price = set()
private_seller = set()
obj_label = {}
obj_ids = collections.defaultdict(list)
id_value = {}
obj_id_nodes = collections.defaultdict(list)
status = {}


def top(u, n=2):
    return D + "/".join(u[len(D):].split("/")[:n])


with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if not s.startswith(D):
            continue
        rest = s[len(D):].split("/")
        if rest[0] == "provenance":
            if p == CRM + "P16_used_specific_object" and s.endswith("/assignment/order"):
                chain[o.value].add(top(s))
            elif p == CRM + "P90_has_value" and "/payment/" in s:
                prov_price[top(s)] += 1
        elif rest[0] == "object" and len(rest) >= 2:
            obj = top(s)
            if len(rest) == 2 and p == LABEL and isinstance(o, Literal):
                obj_label.setdefault(obj, o.value)
            elif len(rest) == 2 and p == CRM + "P1_is_identified_by":
                obj_id_nodes[obj].append(o.value)
            elif p == CRM + "P190_has_symbolic_content" and "/identifier" in s:
                id_value[s] = o.value
            elif p == CRM + "P90_has_value" and "/acquisition/payment/" in s:
                acq_price.add(obj)
            elif p == CRM + "P23_transferred_title_from" and o.value.endswith("/privateIndividual"):
                private_seller.add(obj)
            elif p == CRM + "P141_assigned" and "/provenanceStatus/" in s:
                status[obj] = o.value.rsplit("/", 1)[-1]

rows = []
for obj, recs in chain.items():
    ids = [id_value[n] for n in obj_id_nodes.get(obj, []) if n in id_value]
    rows.append((len(recs), sum(prov_price[r] for r in recs), obj in acq_price, obj in private_seller,
                 status.get(obj, "-"), obj, ids[:3], obj_label.get(obj, "")[:70]))

rows.sort(key=lambda r: (-r[1], -r[0]))
print("chain  chainPrices  acqPrice  privSeller  status  object  identifiers  label")
for r in rows[:25]:
    print(*r, sep=" | ")
print("\nobjects with chain:", len(rows), "| with chain prices:", sum(1 for r in rows if r[1]),
      "| with acquisition price:", sum(1 for r in rows if r[2]), "| with private seller:", sum(1 for r in rows if r[3]))
print("\nsome objects with a private seller but no chain:")
for obj in list(private_seller - set(chain))[:3]:
    ids = [id_value[n] for n in obj_id_nodes.get(obj, []) if n in id_value]
    print(obj, ids[:3], obj in acq_price, obj_label.get(obj, "")[:60])
