"""Show acquisition, price, and provenance fields from saved RetrieveObjectByInventoryNumber responses.

Usage: api_provenance_fields.py RESPONSE.json [RESPONSE.json ...]
Each response is JSON-LD with an @graph. The script prints the object's acquisition and
provenance fields and the provenance nodes that the response includes inline.
"""
import json
import sys

FIELDS = ("skkgapi:inventory_number", "skkgapi:acquisition", "skkgapi:acquisition_actor", "skkgapi:acquisition_date",
          "skkgapi:acquisition_value", "skkgapi:acquisition_value_chf", "skkgapi:credit_line",
          "skkgapi:provenance_status", "skkgapi:provenance_status_text", "skkgapi:provenance_description",
          "skkgapi:provenance_pdf", "skkgapi:redaction_status")


def short(v, n=160):
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "..."


for path in sys.argv[1:]:
    graph = json.load(open(path))["@graph"]
    nodes = {n["@id"]: n for n in graph if "@id" in n}
    obj = next(n for n in graph if "skkgapi:inventory_number" in n)
    print("##", path, obj["@id"])
    for f in FIELDS:
        if f in obj:
            v = obj[f]
            ids = v if isinstance(v, list) else [v]
            resolved = [nodes[i["@id"]] if isinstance(i, dict) and i.get("@id") in nodes else i for i in ids]
            print(f"  {f} = {short(resolved)}")
    provs = obj.get("skkgapi:provenance", [])
    provs = provs if isinstance(provs, list) else [provs]
    print("  provenance entries:", len(provs))
    for p in provs[:3]:
        node = nodes.get(p.get("@id")) if isinstance(p, dict) else None
        if node:
            print("   ", sorted(k for k in node if not k.startswith("@")))
            print("    ", short({k: v for k, v in node.items() if not k.startswith("@")}, 600))
