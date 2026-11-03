"""Count rdf:type classes and subject URI path prefixes in a gzipped Turtle dump."""
import collections
import gzip
import sys

from pyoxigraph import NamedNode, RdfFormat, parse

RDF_TYPE = NamedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")

types = collections.Counter()
prefixes = collections.Counter()
seen_subjects = set()
n = 0
with gzip.open(sys.argv[1], "rb") as f:
    for t in parse(f, format=RdfFormat.TURTLE):
        n += 1
        if t.predicate == RDF_TYPE:
            types[t.object.value] += 1
        s = t.subject
        if isinstance(s, NamedNode) and s.value.startswith("https://data.skkg.ch/") and s.value not in seen_subjects:
            seen_subjects.add(s.value)
            prefixes[s.value.removeprefix("https://data.skkg.ch/").split("/")[0]] += 1

print("triples", n)
print("## data.skkg.ch subject path prefixes")
for k, v in prefixes.most_common(40):
    print(f"{v:9d} {k}")
print("## rdf:type classes")
for k, v in types.most_common(60):
    print(f"{v:9d} {k}")
