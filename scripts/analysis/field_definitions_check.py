"""Run every query in skkg-app's fieldDefinitions.yml against the Oxigraph store.

Usage: field_definitions_check.py STORE_DIR FIELD_DEFINITIONS_YML OUT_JSON [FIELD_ID ...]

Two modes per field:
- coverage: $subject left free, counted per skkg: class of the subject, plus the top
  values. Queries are rewritten to project ?subject; subqueries that GROUP BY without
  ?subject get it added (PATCHES), otherwise all subjects would be merged.
- single: $subject bound to sample IRIs, as ResearchSpace runs them, with timings.
Each field runs in a child process with a timeout, because pyoxigraph has none.
"""
import json
import multiprocessing as mp
import os
import re
import sys
import tempfile
import time

import yaml

TIMEOUT_S = 120
LANG = '"de"'
EXTRA_PREFIXES = {
    "wdt": "http://www.wikidata.org/prop/direct/",
    "geo": "http://www.opengis.net/ont/geosparql#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
}
PATCHES = {
    "mp_masse": [
        ("SELECT ?dimension_type", "SELECT ?subject ?dimension_type"),
        ("GROUP BY ?dimension_type", "GROUP BY ?subject ?dimension_type"),
    ],
}
SELECT_HEAD = re.compile(r"^\s*SELECT\s+(DISTINCT\s+)?\?value\s+WHERE", re.I)


def prefixes(ns):
    allns = {**EXTRA_PREFIXES, **ns}
    return "".join(f"PREFIX {k}: <{v}>\n" for k, v in allns.items())


def coverage_query(fid, q):
    q = q.replace("?__userPreferredLanguage__", LANG)
    for old, new in PATCHES.get(fid, []):
        assert old in q, (fid, old)
        q = q.replace(old, new)
    q = q.replace("$subject", "?subject")
    m = SELECT_HEAD.match(q)
    if not m:
        raise ValueError("unexpected projection")
    return SELECT_HEAD.sub(lambda m: f"SELECT {m.group(1) or ''}?subject ?value WHERE", q, count=1)


def single_query(q, iri):
    # ?subject and $subject are the same SPARQL variable, so bind both spellings.
    q = q.replace("?__userPreferredLanguage__", LANG)
    return q.replace("$subject", f"<{iri}>").replace("?subject", f"<{iri}>")


def term(t):
    return None if t is None else t.value


def dump(path, res):
    with open(path, "w") as fh:
        json.dump(res, fh, ensure_ascii=False)


def sample_subjects(store, pre, fid, q, dom_cls):
    typed = f"?subject a {dom_cls} ." if dom_cls else ""
    inner = coverage_query(fid, q)
    rows = list(store.query(pre + f"SELECT DISTINCT ?subject WHERE {{ {{ {inner} }} {typed} }} LIMIT 300"))
    picks = rows[:: max(1, len(rows) // 3)][:3]
    return [r["subject"].value for r in picks]


def child(store_dir, pre, field, dom_cls, part_path):
    from pyoxigraph import Store
    store = Store.read_only(store_dir)
    fid, q = field["id"], field["queries"][0]["select"]
    res = {"single": []}
    for iri in sample_subjects(store, pre, fid, q, dom_cls):
        t = time.time()
        rows = [term(r["value"]) for r in store.query(pre + single_query(q, iri))]
        res["single"].append({"subject": iri, "ms": round((time.time() - t) * 1000, 1),
                              "n": len(rows), "values": [str(v)[:200] for v in rows[:4]]})
    dump(part_path, res)
    t = time.time()
    inner = coverage_query(fid, q)
    agg = pre + f"""SELECT ?cls (COUNT(*) AS ?rows) (COUNT(DISTINCT ?subject) AS ?subjects)
      (COUNT(DISTINCT ?value) AS ?values) (SAMPLE(?subject) AS ?ex) WHERE {{
      {{ {inner} }}
      OPTIONAL {{ ?subject a ?cls FILTER(STRSTARTS(STR(?cls), "https://ontology.skkg.ch/")) }}
    }} GROUP BY ?cls ORDER BY DESC(?subjects)"""
    res["by_class"] = [
        {"cls": term(r["cls"]), "rows": int(r["rows"].value), "subjects": int(r["subjects"].value),
         "values": int(r["values"].value), "example": term(r["ex"])}
        for r in store.query(agg)
    ]
    res["coverage_s"] = round(time.time() - t, 2)
    dump(part_path, res)
    t = time.time()
    top = pre + f"""SELECT ?value (COUNT(DISTINCT ?subject) AS ?n) (SAMPLE(?l) AS ?label) WHERE {{
      {{ {inner} }}
      OPTIONAL {{ ?value rdfs:label ?l FILTER(LANG(?l) = "de" || LANG(?l) = "") }}
    }} GROUP BY ?value ORDER BY DESC(?n) LIMIT 12"""
    res["top_values"] = [[term(r["value"])[:160] if r["value"] else None, int(r["n"].value),
                          term(r["label"])] for r in store.query(top)]
    res["top_s"] = round(time.time() - t, 2)
    res["complete"] = True
    dump(part_path, res)


def domain_totals(store_dir, pre, classes):
    from pyoxigraph import Store
    store = Store.read_only(store_dir)
    totals = {}
    for c in classes:
        q = pre + f"SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE {{ ?s a {c} }}"
        totals[c] = int(next(iter(store.query(q)))["n"].value)
    return totals


def main(store_dir, yml, out_path, only):
    d = yaml.safe_load(open(yml))
    pre = prefixes(d["namespaces"])
    fields = [f for f in d["fields"] if not only or f["id"] in only]
    totals = domain_totals(store_dir, pre, sorted({f["domain"] for f in fields if "domain" in f}))
    print("domain totals:", totals, file=sys.stderr)
    results = []
    ctx = mp.get_context("spawn")
    tmpdir = tempfile.mkdtemp()
    for f in fields:
        dom = f.get("domain")
        dom_cls = dom if dom and totals.get(dom) else None
        part = os.path.join(tmpdir, f["id"] + ".json")
        p = ctx.Process(target=child, args=(store_dir, pre, f, dom_cls, part))
        t = time.time()
        p.start()
        p.join(TIMEOUT_S)
        rec = {"id": f["id"], "label": f["label"], "domain": dom,
               "range": f.get("range"), "datatype": f["datatype"],
               "query": f["queries"][0]["select"]}
        timed_out = p.is_alive()
        if timed_out:
            p.kill()
            p.join()
        if os.path.exists(part):
            rec.update(json.load(open(part)))
        if rec.get("complete"):
            rec["status"] = "ok"
        elif timed_out:
            rec["status"] = f"timeout>{TIMEOUT_S}s"
        else:
            rec["status"] = f"error (exit {p.exitcode})"
        rec["wall_s"] = round(time.time() - t, 1)
        dom = f.get("domain")
        if "by_class" in rec:
            rec["subjects"] = sum(c["subjects"] for c in rec["by_class"])
            if dom and dom.startswith("skkg:"):
                full = "https://ontology.skkg.ch/" + dom.split(":", 1)[1]
                hit = sum(c["subjects"] for c in rec["by_class"] if c["cls"] == full)
                rec["domain_total"] = totals.get(dom)
                rec["domain_hits"] = hit
        print(f"{f['id']:<32} {rec['status']:<14} {rec['wall_s']:>6}s "
              f"subj={rec.get('subjects', '-')} dom={rec.get('domain_hits', '-')}/{rec.get('domain_total', '-')}",
              file=sys.stderr)
        results.append(rec)
    with open(out_path, "w") as fh:
        json.dump({"domain_totals": totals, "fields": results}, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], set(sys.argv[4:]))
