"""Turn shape_census.py output into a markdown report, marked against fieldDefinitions.yml.

Usage: census_report.py CENSUS_JSON FIELD_DEFINITIONS_YML OUT_MD

Shapes are normalised further than in the census (uppercase UUIDs, {n}-{n} ids, external
IRIs collapsed to their host); subject counts stay exact because each subject has one shape.
An edge is "FD" if its predicate occurs in any fieldDefinitions query.
"""
import json
import re
import sys
from collections import Counter, defaultdict

import yaml

UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
SHORT = {
    "http://www.cidoc-crm.org/cidoc-crm/": "crm:",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf:",
    "http://www.w3.org/2000/01/rdf-schema#": "rdfs:",
    "https://linked.art/ns/terms/": "la:",
    "http://www.ics.forth.gr/isl/CRMdig/": "crmdig:",
    "http://www.cidoc-crm.org/extensions/crmsci/": "crmsci:",
    "http://purl.org/dc/terms/": "dcterms:",
    "http://iflastandards.info/ns/fr/frbr/frbroo/": "frbroo:",
    "https://ontology.swissartresearch.net/aaao/": "aaao:",
    "http://www.w3.org/2004/02/skos/core#": "skos:",
    "https://ontology.skkg.ch/": "skkg:",
    "http://www.w3.org/ns/prov#": "prov:",
    "https://d-nb.info/standards/elementset/gnd#": "gndo:",
    "http://www.w3.org/2002/07/owl#": "owl:",
    "http://www.opengis.net/ont/geosparql#": "geo:",
    "http://www.w3.org/2008/05/skos-xl#": "skosxl:",
    "http://vocab.getty.edu/ontology#": "gvp:",
    "http://www.w3.org/2003/01/geo/wgs84_pos#": "wgs84:",
    "http://xmlns.com/foaf/0.1/": "foaf:",
}


def short(iri):
    for k, v in SHORT.items():
        if iri.startswith(k):
            return v + iri[len(k):]
    return iri


def norm(shape):
    if shape.startswith("skkg:"):
        s = UUID.sub("{uuid}", shape)
        s = re.sub(r"(?<=/)\d+(?=[-/]|$)", "{n}", s)
        s = re.sub(r"-\d+(?=/|$)", "-{n}", s)
        return s
    if shape.endswith("*") and "://" in shape:
        m = re.match(r"(https?://[^/#]+)", shape)
        return m.group(1) + "/*"
    return shape


def fd_predicates(yml):
    d = yaml.safe_load(open(yml))
    ns = d["namespaces"] | {"rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
                            "wdt": "http://www.wikidata.org/prop/direct/",
                            "geo": "http://www.opengis.net/ont/geosparql#"}
    used = Counter()
    for f in d["fields"]:
        q = f["queries"][0]["select"]
        found = set()
        for pre, local in re.findall(r"\b([a-zA-Z]+):([A-Za-z][\w\-]*)", q):
            if pre in ns:
                found.add(ns[pre] + local)
        if re.search(r"\s(a)\s", q):
            found.add("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
        for iri in found:
            used[iri] += 1
    return used


def root_of(shape):
    if shape.startswith("skkg:"):
        return "skkg:" + shape[5:].split("/", 1)[0]
    return "external"


def main(census_path, yml, out_path):
    c = json.load(open(census_path))
    used = fd_predicates(yml)
    shapes = Counter()
    for s, n in c["subject_shapes"]:
        shapes[norm(s)] += n
    edges = {}
    for e in c["edges"]:
        k = (norm(e["s"]), e["p"], norm(e["o"]))
        m = edges.get(k)
        if m is None:
            m = edges[k] = {"triples": 0, "subjects": 0, "samples": [], "values": Counter(), "capped": False}
        m["triples"] += e["triples"]
        m["subjects"] += e["subjects"]
        m["samples"] = (m["samples"] + e["samples"])[:2]
        if e["values_capped"]:
            m["capped"] = True
        for v, n in e["values"] or []:
            m["values"][v] += n
    by_shape = defaultdict(list)
    for (s, p, o), m in edges.items():
        by_shape[s].append((p, o, m))
    roots = Counter()
    for s, n in shapes.items():
        if re.fullmatch(r"skkg:[a-zA-Z]+/(\{uuid\}|\{n\})", s):
            roots[s] = n

    out = []
    w = out.append
    w(f"# Shape census of the SKKG store\n")
    w(f"Generated from `{census_path}` by `scripts/analysis/census_report.py`. "
      f"{c['quads']:,} quads, {c['subjects']:,} subjects, read in {c['seconds']} s, nothing sampled. "
      f"After normalisation: {len(shapes):,} subject shapes and {len(edges):,} edges "
      f"(subject shape, predicate, object shape). **FD** marks predicates used by at least one "
      f"`fieldDefinitions.yml` query.\n")
    w("## Record roots\n")
    w("| Root shape | Subjects |\n|---|---:|")
    for s, n in sorted(roots.items(), key=lambda x: -x[1]):
        w(f"| `{s}` | {n:,} |")
    w("")
    preds = Counter()
    pred_subj = Counter()
    for (s, p, o), m in edges.items():
        preds[p] += m["triples"]
        pred_subj[p] += m["subjects"]
    w("## Predicates not used by any fieldDefinitions query\n")
    w("| Predicate | Triples | Subjects | Example subject shapes |\n|---|---:|---:|---|")
    for p, n in preds.most_common():
        if p in used:
            continue
        ex = sorted({s for (s, pp, o) in edges if pp == p}, key=lambda s: -shapes[s])[:3]
        w(f"| `{short(p)}` | {n:,} | {pred_subj[p]:,} | {', '.join(f'`{x}`' for x in ex)} |")
    w("")
    w("## Edges by subject shape\n")
    w("Coverage is subjects with the edge divided by subjects of that shape. Values are shown "
      "when an edge has at most 15 distinct literal or type values.\n")
    groups = defaultdict(list)
    for s in shapes:
        groups[root_of(s)].append(s)
    for root in sorted(groups, key=lambda r: -sum(shapes[s] for s in groups[r])):
        total = sum(shapes[s] for s in groups[root])
        w(f"### {root} ({total:,} subjects in {len(groups[root])} shapes)\n")
        if root == "external":
            hosts = sorted(groups[root], key=lambda s: -shapes[s])
            w("Subjects by host: " + ", ".join(f"`{h}` {shapes[h]:,}" for h in hosts[:40]) + "\n")
        for s in sorted(groups[root], key=lambda s: (s.count("/"), -shapes[s], s)):
            if root == "external" and shapes[s] < 50:
                continue
            w(f"#### `{s}` ({shapes[s]:,})\n")
            w("| Predicate | Object | Subjects | Cov. | Triples | FD | Values / sample |\n|---|---|---:|---:|---:|---|---|")
            for p, o, m in sorted(by_shape[s], key=lambda x: -x[2]["subjects"]):
                cov = m["subjects"] / shapes[s] * 100 if shapes[s] else 0
                vals = ""
                if m["values"] and not m["capped"] and len(m["values"]) <= 15:
                    vals = "; ".join(f"{short(v)[:50]} ({n:,})" for v, n in m["values"].most_common(8))
                elif m["samples"]:
                    vals = "e.g. " + m["samples"][0][1][:70]
                vals = vals.replace("|", "\\|").replace("\n", " ")
                w(f"| `{short(p)}` | `{o}` | {m['subjects']:,} | {cov:.1f}% | {m['triples']:,} | "
                  f"{'FD' if p in used else ''} | {vals} |")
            w("")
    open(out_path, "w").write("\n".join(out))
    print(f"{len(shapes)} shapes, {len(edges)} edges, {sum(1 for p in preds if p not in used)} "
          f"of {len(preds)} predicates unused by FD", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
