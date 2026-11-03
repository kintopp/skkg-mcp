"""Count distinct persons with a street address in their name, and their life status.

Also count address records that have given/family name parts, and how they are used.
"""
import collections
import gzip
import re
import sys

from pyoxigraph import Literal, NamedNode, RdfFormat, parse

D = "https://data.skkg.ch/"
CRM = "http://www.cidoc-crm.org/cidoc-crm/"
STREET = re.compile(r"\b\w+(strasse|str\.|gasse|weg|platz|rue|avenue|via)\s*\d+", re.I)
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"


def top(uri):
    return D + "/".join(uri.removeprefix(D).split("/")[:2])


label = {}
street_persons = set()
born, died = {}, set()
events = {}
spans, span_year = {}, {}
addr_part_types = collections.defaultdict(set)
addr_inbound = collections.defaultdict(collections.Counter)
person_inbound = collections.defaultdict(collections.Counter)

with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        s, p, o = t.subject.value, t.predicate.value, t.object
        if p == LABEL and isinstance(o, Literal):
            label.setdefault(s, o.value)
        if s.startswith(D + "person/") and isinstance(o, Literal) and STREET.search(o.value):
            street_persons.add(top(s))
        if s.startswith(D + "address/") and p == CRM + "P2_has_type":
            addr_part_types[top(s)].add(o.value)
        if isinstance(o, NamedNode) and o.value.startswith(D) and not s.startswith(top(o.value)):
            mod = s.removeprefix(D).split("/")[0] if s.startswith(D) else "external"
            if o.value.startswith(D + "address/"):
                addr_inbound[top(o.value)][(mod, p.rsplit("/", 1)[-1])] += 1
            if o.value.startswith(D + "person/"):
                person_inbound[top(o.value)][(mod, p.rsplit("/", 1)[-1])] += 1
        if p == CRM + "P98i_was_born":
            events[o.value] = ("birth", s)
        elif p == CRM + "P100i_died_in":
            died.add(s)
        elif p == CRM + "P4_has_time-span":
            spans[s] = o.value
        elif p == CRM + "P82a_begin_of_the_begin":
            m = re.match(r"-?\d{4}", o.value)
            if m:
                span_year.setdefault(s, int(m.group()))

for ev, (_, person) in events.items():
    y = span_year.get(spans.get(ev))
    if y:
        born[person] = y

print("## persons with a street address in a name or label:", len(street_persons))
c = collections.Counter()
for pid in street_persons:
    if pid in died:
        c["died"] += 1
    elif pid in born and born[pid] >= 1926:
        c["no death, born 1926 or later"] += 1
    elif pid in born:
        c["no death, born before 1926"] += 1
    else:
        c["no life dates"] += 1
print(dict(c))
uses = collections.Counter(k for pid in street_persons for k in person_inbound.get(pid, {}))
print("used by:", dict(uses.most_common(8)))

named = [a for a, ts in addr_part_types.items()
         if {label.get(t) for t in ts} & {"Given Name", "Family Name"}]
print("## address records with given/family name parts:", len(named))
print("used by:", dict(collections.Counter(k for a in named for k in addr_inbound.get(a, {})).most_common(8)))
print("not linked from any other record:", sum(1 for a in named if not addr_inbound.get(a)))

sellers = {pid for pid, inb in person_inbound.items()
           if any(k[1] in ("P23_transferred_title_from", "P107_has_current_or_former_member") for k in inb)}
s_status = collections.Counter(
    "died" if pid in died else ("born 1926 or later, no death" if born.get(pid, 0) >= 1926
                                 else ("no life dates" if pid not in born else "born before 1926, no death"))
    for pid in sellers)
print("## persons named as former owners or provenance members:", len(sellers), dict(s_status))
