"""Compare rights data for given multimedia records, and count IIIF services per rights type.

Usage: rights_check.py STORE_DIR MULTIMEDIA_UUID [MULTIMEDIA_UUID ...]
Paths: a multimedia record links to its rights with crm:P104_is_subject_to, and to its
IIIF service with la:digitally_shown_by / la:digitally_available_via. The rights status
node (aaao:ZE30) holds the end date of time-limited rights.
"""
import sys

from pyoxigraph import Store

store = Store.read_only(sys.argv[1])
P = """
PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX la: <https://linked.art/ns/terms/>
"""


def val(row, v):
    return row[v].value if row[v] is not None else "-"


for uuid in sys.argv[2:]:
    q = P + f"""SELECT ?rtl ?holder ?note ?end ?svc WHERE {{
      VALUES ?mm {{ <https://data.skkg.ch/multimedia/{uuid}> }}
      ?mm crm:P104_is_subject_to ?r . ?r crm:P2_has_type/rdfs:label ?rtl .
      OPTIONAL {{ ?r crm:P75i_is_possessed_by/rdfs:label ?holder }}
      OPTIONAL {{ ?r crm:P3_has_note ?note }}
      OPTIONAL {{ ?st crm:P67_refers_to ?r ; crm:P4_has_time-span/crm:P82b_end_of_the_end ?end }}
      OPTIONAL {{ ?mm la:digitally_shown_by/la:digitally_available_via ?svc }}
    }}"""
    for row in store.query(q):
        print(uuid, "|", " | ".join(val(row, v) for v in ("rtl", "holder", "note", "end", "svc")))

print("\n## multimedia records per rights type: all, with IIIF service, with holder, with end date")
q = P + """SELECT ?rtl (COUNT(DISTINCT ?mm) AS ?all) (COUNT(DISTINCT ?mmSvc) AS ?svc)
       (COUNT(DISTINCT ?mmHolder) AS ?holder) (COUNT(DISTINCT ?mmEnd) AS ?ends) WHERE {
  ?mm crm:P104_is_subject_to ?r . ?r crm:P2_has_type/rdfs:label ?rtl .
  OPTIONAL { ?mm la:digitally_shown_by/la:digitally_available_via ?s . BIND(?mm AS ?mmSvc0) }
  OPTIONAL { ?r crm:P75i_is_possessed_by ?h }
  OPTIONAL { ?st crm:P67_refers_to ?r ; crm:P4_has_time-span/crm:P82b_end_of_the_end ?e }
  BIND(IF(BOUND(?s), ?mm, ?nothing) AS ?mmSvc)
  BIND(IF(BOUND(?h), ?mm, ?nothing) AS ?mmHolder)
  BIND(IF(BOUND(?e), ?mm, ?nothing) AS ?mmEnd)
} GROUP BY ?rtl ORDER BY DESC(?all)"""
for row in store.query(q):
    print("  ", " | ".join(val(row, v) for v in ("rtl", "all", "svc", "holder", "ends")))
