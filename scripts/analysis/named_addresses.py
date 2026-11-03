"""Classify address records with personal name parts, using the Oxigraph store.

Usage: named_addresses.py STORE_DIR
An address record has a name (`P1_is_identified_by .../name`) whose parts are typed with
Getty AAT terms: given name (300404651), surname (300404652), organisation (300445020).
The script counts records with a given name or surname, how many also have an
organisation part, their record types, and how other records use them. Prints counts
and type labels only, not names.
"""
import sys

from pyoxigraph import Store

store = Store.read_only(sys.argv[1])
PREFIX = """
PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX aat: <http://vocab.getty.edu/aat/>
"""
NAMED = """
?addr a <https://ontology.skkg.ch/Address> ; crm:P1_is_identified_by ?name .
?name crm:P106_is_composed_of ?part . ?part crm:P2_has_type ?pt .
VALUES ?pt { aat:300404651 aat:300404652 }
"""


def run(title, q):
    print(title)
    for row in store.query(PREFIX + q):
        print("  ", *[row[i].value if row[i] is not None else "-" for i in range(len(row))])


run("named records:", f"SELECT (COUNT(DISTINCT ?addr) AS ?n) WHERE {{ {NAMED} }}")
# FILTER EXISTS, because a BIND inside OPTIONAL cannot see ?addr from the outer group.
run("named records that also have an organisation part:", f"""
SELECT (COUNT(DISTINCT ?addr) AS ?n) WHERE {{
  {NAMED}
  FILTER EXISTS {{ ?name crm:P106_is_composed_of ?o . ?o crm:P2_has_type aat:300445020 }}
}}""")
run("record types (label, count):", f"""
SELECT ?tl (COUNT(DISTINCT ?addr) AS ?n) WHERE {{
  {NAMED}
  OPTIONAL {{ ?addr crm:P2_has_type ?t . OPTIONAL {{ ?t rdfs:label ?tl0 }} }}
  BIND(COALESCE(STR(?tl0), "no type") AS ?tl)
}} GROUP BY ?tl ORDER BY DESC(?n)""")
run("records linking to them (module, predicate, count):", f"""
SELECT ?mod ?p (COUNT(DISTINCT ?addr) AS ?n) WHERE {{
  {NAMED}
  ?x ?p ?addr . FILTER(!STRSTARTS(STR(?x), STR(?addr)))
  BIND(STRBEFORE(STRAFTER(STR(?x), "https://data.skkg.ch/"), "/") AS ?mod)
}} GROUP BY ?mod ?p ORDER BY DESC(?n)""")
run("persons with the same label as a named address:", f"""
SELECT (COUNT(DISTINCT ?addr) AS ?n) WHERE {{
  {NAMED}
  ?addr crm:P1_is_identified_by/crm:P190_has_symbolic_content ?full .
  ?person a <https://ontology.skkg.ch/Person> ; rdfs:label ?pl . FILTER(CONTAINS(STR(?full), STR(?pl)))
}}""")
