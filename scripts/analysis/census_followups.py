"""Targeted checks of puzzles raised by shape_census.py. Usage: census_followups.py STORE_DIR"""
import sys
import time

from pyoxigraph import Store

store = Store.read_only(sys.argv[1])
P = """PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX skkg: <https://ontology.skkg.ch/>
PREFIX schema: <http://schema.org/>
PREFIX aat: <http://vocab.getty.edu/aat/>
"""
CHECKS = {
    "object IRIs with triples but no skkg:Object type: predicates": """
      SELECT ?p (COUNT(DISTINCT ?s) AS ?n) WHERE {
        ?s ?p ?o . FILTER(REGEX(STR(?s), "^https://data.skkg.ch/object/[^/]+$"))
        FILTER NOT EXISTS { ?s a skkg:Object } } GROUP BY ?p ORDER BY DESC(?n)""",
    "untyped objects: who points at them": """
      SELECT ?p (COUNT(DISTINCT ?s) AS ?n) (SAMPLE(?x) AS ?ex) WHERE {
        ?s crm:P46i_forms_part_of|crm:P2_has_type ?y . FILTER(REGEX(STR(?s), "^https://data.skkg.ch/object/[^/]+$"))
        FILTER NOT EXISTS { ?s a skkg:Object } ?x ?p ?s } GROUP BY ?p ORDER BY DESC(?n)""",
    "multimedia IRIs without skkg:Multimedia type: predicates": """
      SELECT ?p (COUNT(DISTINCT ?s) AS ?n) WHERE {
        ?s ?p ?o . FILTER(REGEX(STR(?s), "^https://data.skkg.ch/multimedia/[^/]+$"))
        FILTER NOT EXISTS { ?s a skkg:Multimedia } } GROUP BY ?p ORDER BY DESC(?n)""",
    "inventory numbers shared by a numeric-id and a uuid-id object": """
      SELECT (COUNT(DISTINCT ?inv) AS ?n) (SAMPLE(?a) AS ?exA) (SAMPLE(?b) AS ?exB) WHERE {
        ?a a skkg:Object ; crm:P1_is_identified_by ?ia . ?ia crm:P2_has_type <https://data.skkg.ch/type/invnr> ; crm:P190_has_symbolic_content ?inv .
        ?b a skkg:Object ; crm:P1_is_identified_by ?ib . ?ib crm:P2_has_type <https://data.skkg.ch/type/invnr> ; crm:P190_has_symbolic_content ?inv .
        FILTER(?a != ?b) }""",
    "addresses with coordinates, by name parts present": """
      SELECT ?kind (COUNT(DISTINCT ?a) AS ?n) WHERE {
        ?a a skkg:Address ; schema:latitude ?lat .
        BIND(IF(EXISTS { ?a crm:P1_is_identified_by/crm:P106_is_composed_of/crm:P2_has_type aat:300404652 }, "has surname",
             IF(EXISTS { ?a crm:P1_is_identified_by/crm:P106_is_composed_of/crm:P2_has_type aat:300445020 }, "organisation only", "other")) AS ?kind)
      } GROUP BY ?kind""",
    "addresses with coordinates: what they are linked from": """
      SELECT ?p (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a skkg:Address ; schema:latitude ?lat . ?x ?p ?a } GROUP BY ?p""",
    "actor/{uuid} nodes: incoming predicates": """
      SELECT ?p (COUNT(DISTINCT ?a) AS ?n) (SAMPLE(?x) AS ?ex) (SAMPLE(?l) AS ?label) WHERE {
        ?a a skkg:Actor . FILTER(STRSTARTS(STR(?a), "https://data.skkg.ch/actor/")) ?x ?p ?a . OPTIONAL { ?a rdfs:label ?l } }
      GROUP BY ?p ORDER BY DESC(?n)""",
    "publication/{uuid} nodes: incoming predicates": """
      SELECT ?p (COUNT(DISTINCT ?a) AS ?n) (SAMPLE(?x) AS ?ex) (SAMPLE(?l) AS ?label) WHERE {
        ?x ?p ?a . FILTER(STRSTARTS(STR(?a), "https://data.skkg.ch/publication/")) OPTIONAL { ?a rdfs:label ?l } }
      GROUP BY ?p ORDER BY DESC(?n)""",
    "production P10_falls_within: top targets": """
      SELECT ?t (SAMPLE(?l) AS ?label) (SAMPLE(?sch) AS ?scheme) (COUNT(*) AS ?n) (SAMPLE(?b) AS ?begin) (SAMPLE(?e) AS ?end) WHERE {
        ?prod a crm:E12_Production ; crm:P10_falls_within ?t .
        OPTIONAL { ?t rdfs:label ?l FILTER(LANG(?l) = "de") } OPTIONAL { ?t skos:inScheme ?sch }
        OPTIONAL { ?t crm:P82a_begin_of_the_begin ?b } OPTIONAL { ?t crm:P82b_end_of_the_end ?e }
      } GROUP BY ?t ORDER BY DESC(?n) LIMIT 15""",
    "timespan P86_falls_within: top targets": """
      SELECT ?t (SAMPLE(?l) AS ?label) (COUNT(*) AS ?n) WHERE {
        ?ts crm:P86_falls_within ?t . OPTIONAL { ?t rdfs:label ?l FILTER(LANG(?l) = "de") }
      } GROUP BY ?t ORDER BY DESC(?n) LIMIT 8""",
    "timespan source P17_was_motivated_by: values": """
      SELECT ?t (SAMPLE(?l) AS ?label) (COUNT(*) AS ?n) WHERE {
        ?x crm:P17_was_motivated_by ?t . OPTIONAL { ?t rdfs:label ?l FILTER(LANG(?l) = "de") }
      } GROUP BY ?t ORDER BY DESC(?n) LIMIT 12""",
    "object credit lines": """
      SELECT ?o ?v WHERE { ?o crm:P67i_is_referred_to_by|crm:P1_is_identified_by ?c . ?o a skkg:Object .
        FILTER(STRENDS(STR(?c), "/credit")) ?c crm:P190_has_symbolic_content ?v } LIMIT 30""",
    "provenance source address texts": """
      SELECT ?s ?v WHERE { ?s crm:P190_has_symbolic_content ?v .
        FILTER(REGEX(STR(?s), "^https://data.skkg.ch/provenance/.*/source/.*/address$")) }""",
    "person relation types": """
      SELECT ?t (SAMPLE(?l) AS ?label) (COUNT(*) AS ?n) WHERE {
        ?r <https://ontology.swissartresearch.net/aaao/ZP105_has_social_relation_type> ?t . OPTIONAL { ?t rdfs:label ?l FILTER(LANG(?l) = "de") }
      } GROUP BY ?t ORDER BY DESC(?n)""",
    "object copyright status values (object/*/right)": """
      SELECT ?t (SAMPLE(?l) AS ?label) (COUNT(*) AS ?n) WHERE {
        ?r crm:P2_has_type ?t . FILTER(REGEX(STR(?r), "^https://data.skkg.ch/object/[^/]+/right/"))
        OPTIONAL { ?t rdfs:label ?l FILTER(LANG(?l) = "de") } } GROUP BY ?t ORDER BY DESC(?n)""",
}
for title, q in CHECKS.items():
    t = time.time()
    print(f"\n## {title}")
    try:
        for r in store.query(P + q):
            print("  " + " | ".join(str(r[v].value)[:110] if r[v] is not None else "-" for v in r.variables if True)
                  if False else "  " + " | ".join("-" if r[i] is None else str(r[i].value)[:110] for i in range(len(r))))
    except Exception as e:
        print("  ERROR", e)
    print(f"  ({time.time()-t:.1f}s)")
