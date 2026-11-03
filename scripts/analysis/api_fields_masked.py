"""Print the fields of saved API JSON-LD responses with masked values.

Usage: api_fields_masked.py RESPONSE.json [RESPONSE.json ...]
For each node in @graph, prints its @id, its types, and each field with letters masked
as x and digits as 9, so personal data is not copied into the output.
"""
import json
import re
import sys


def mask(v):
    s = json.dumps(v, ensure_ascii=False)
    s = re.sub(r"(skkg:[a-z]+)%?2?F?/[0-9a-f-]+", r"\1/{id}", s)
    return re.sub(r"\d", "9", re.sub(r"[A-Za-zÀ-ÿ]", "x", s))[:80] if "skkg:" not in s else s[:80]


for path in sys.argv[1:]:
    data = json.load(open(path))
    if "@graph" not in data:
        print("##", path, json.dumps(data)[:200])
        continue
    print("##", path, "nodes:", len(data["@graph"]))
    for node in data["@graph"][:4]:
        print(" ", node.get("@id"), node.get("@type"))
        for k, v in node.items():
            if not k.startswith("@"):
                print("     ", k, "=", mask(v))
