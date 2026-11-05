"""Build the SQLite database for the SKKG MCP server from the Oxigraph store.

Usage: build_db.py STORE_DIR OUT_DB [--headers HEADERS_TXT] [--census CENSUS_JSON]
                   [--previous PREVIOUS_DB]

Writes OUT_DB, OUT_DB.report.md and OUT_DB.report.json. The database is written to a
temporary file and moved into place only when the privacy checks pass, so a failed build
never replaces a good database. Run from the project root, e.g.:

  uv run --with pyoxigraph python -I scripts/build_db.py data/oxigraph/full-20261028 \
      data/db/skkg-20261028.sqlite --headers data/raw/full/headers.txt \
      --census data/derived/shape_census-20261028.json

Privacy rules (notes/06, notes/09) are enforced here, not in the server: the given names,
surnames and alternative names of address records are never written. An address that has
them gets a label built from its organisation (or "Privatperson") and place, and loses its
coordinates and website. The full names of those persons that no SKKG person record carries
are replaced by "Privatperson" in the object and term fields the website does not show.
"Unbekannte:r" owners are flagged as anonymised in either case. Stub objects and stub
multimedia records (no skkg: class) are not loaded. The privacy checks compare the result
with the store by queries of their own; scripts/tests/ injects leaks to prove they fail.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from pyoxigraph import BlankNode, Literal, NamedNode, Store

SCHEMA_VERSION = 5
D = "https://data.skkg.ch/"
AAT = "http://vocab.getty.edu/aat/"
PREFIX = """PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX skkg: <https://ontology.skkg.ch/>
PREFIX la: <https://linked.art/ns/terms/>
PREFIX aaao: <https://ontology.swissartresearch.net/aaao/>
PREFIX crmdig: <http://www.ics.forth.gr/isl/CRMdig/>
PREFIX crmsci: <http://www.cidoc-crm.org/extensions/crmsci/>
PREFIX frbroo: <http://iflastandards.info/ns/fr/frbr/frbroo/>
PREFIX gndo: <https://d-nb.info/standards/elementset/gnd#>
PREFIX schema: <http://schema.org/>
PREFIX aat: <http://vocab.getty.edu/aat/>
PREFIX d: <https://data.skkg.ch/>
"""

# Scheme ids that tools expose as facets (notes/11). Other schemes keep their SKKG name.
FACETS = {
    "21087": "object_type", "42156": "material", "22086": "material", "42157": "technique",
    "40088": "epoch", "21118": "production_role", "21117": "attribution",
    "21086": "acquisition_type", "20042": "location", "54161": "owner_type",
    "54158": "certainty", "54159": "holding_kind", "54156": "transaction_type",
    "55154": "source_type", "21098": "literature_type", "21102": "exhibition_type",
    "20033": "currency", "54167": "currency", "54154": "provenance_status",
    "42135": "object_copyright", "56153": "image_license", "45152": "redaction_status",
    "42152": "date_basis", "54165": "date_qualifier", "20007": "country",
    "20088": "gender", "43087": "author_role", "26126": "exhibition_status",
    "43086": "internal_external", "21116": "object_reference_type", "42159": "literature_place",
    "25086": "condition",
}
# The kind of record a facet's record count counts. Facets of provenance periods also count
# objects; the others describe records other than objects and get no object count (RECORD_ONLY).
RECORD_KIND = {"literature_type": "literature", "literature_place": "literature", "author_role": "literature",
               "exhibition_type": "exhibitions", "exhibition_status": "exhibitions", "internal_external": "exhibitions",
               "gender": "persons", "country": "persons (nationality)", "owner_type": "provenance periods",
               "certainty": "provenance periods", "holding_kind": "provenance periods",
               "transaction_type": "provenance periods", "source_type": "provenance periods"}
RECORD_ONLY = {f for f, kind in RECORD_KIND.items() if kind != "provenance periods"}
# Getty AAT types that SKKG uses to tell text nodes apart.
AAT_CREDIT = AAT + "300026687"
AAT_EDITION = AAT + "300435435"
AAT_MATERIAL_STATEMENT = AAT + "300435429"
AAT_GIVEN, AAT_SURNAME, AAT_ORG = AAT + "300404651", AAT + "300404652", AAT + "300445020"
ANON_ACTOR = "person/privateIndividual"
ANON_ADDRESS = "address/privateIndividual"

UMLAUT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss"})

DDL = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE schemes (id TEXT PRIMARY KEY, name TEXT, facet TEXT);
CREATE TABLE terms (
  id TEXT PRIMARY KEY, scheme_id TEXT, facet TEXT, label_de TEXT, label_en TEXT, label_fr TEXT,
  label TEXT, broader_id TEXT, year_from INTEGER, year_to INTEGER, matches TEXT,
  object_count INTEGER, object_count_with_narrower INTEGER, narrower_count INTEGER DEFAULT 0,
  record_count INTEGER, record_kind TEXT, use_rank INTEGER DEFAULT 0);
CREATE TABLE term_labels (term_id TEXT, lang TEXT, label TEXT);
CREATE TABLE term_ancestors (term_id TEXT, ancestor_id TEXT, depth INTEGER,
  PRIMARY KEY (term_id, ancestor_id)) WITHOUT ROWID;

CREATE TABLE actors (
  id TEXT PRIMARY KEY, kind TEXT, label TEXT, name TEXT, first_name TEXT, last_name TEXT,
  corporate_name TEXT, gender_id TEXT, birth_label TEXT, birth_from INTEGER, birth_to INTEGER,
  birth_place TEXT, birth_place_id TEXT, death_label TEXT, death_from INTEGER, death_to INTEGER,
  death_place TEXT, death_place_id TEXT, biography TEXT, is_anonymous INTEGER DEFAULT 0);
CREATE TABLE actor_nationalities (actor_id TEXT, country_id TEXT);
CREATE TABLE actor_names (actor_id TEXT, name TEXT, type_id TEXT, source TEXT);
CREATE TABLE actor_events (actor_id TEXT, kind TEXT, type_id TEXT, label TEXT, date_label TEXT,
  year_from INTEGER, year_to INTEGER, place TEXT, place_id TEXT, note TEXT);
CREATE TABLE actor_external (actor_id TEXT, source TEXT, external_id TEXT, url TEXT);
CREATE TABLE actor_links (actor_id TEXT, type_id TEXT, url TEXT);
CREATE TABLE actor_relations (subject_id TEXT, target_id TEXT, type_id TEXT, label TEXT);
CREATE TABLE actor_gnd (actor_id TEXT, gnd_id TEXT, preferred_name TEXT, biographical_info TEXT,
  professions TEXT);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY, label TEXT, organisation TEXT, place TEXT, region TEXT, country_id TEXT,
  type_id TEXT, latitude REAL, longitude REAL, is_private_person INTEGER DEFAULT 0, website TEXT);

CREATE TABLE objects (
  id TEXT PRIMARY KEY, inventory_number TEXT, label TEXT, title TEXT, object_type_id TEXT,
  number_of_parts TEXT, date_label TEXT, date_from INTEGER, date_to INTEGER, parent_id TEXT REFERENCES objects(id),
  credit_line TEXT, edition TEXT, material_statement TEXT, provenance_status_id TEXT,
  provenance_status_text TEXT, redaction_status_id TEXT, created TEXT, updated TEXT,
  manifest_url TEXT, primary_multimedia_id TEXT, has_image INTEGER DEFAULT 0,
  image_license_id TEXT, image_count INTEGER DEFAULT 0, has_provenance_chain INTEGER DEFAULT 0);
CREATE TABLE object_terms (object_id TEXT REFERENCES objects(id), facet TEXT, term_id TEXT, seq INTEGER, note TEXT);
CREATE TABLE object_titles (object_id TEXT REFERENCES objects(id), seq INTEGER, title TEXT, short_title TEXT,
  type_id TEXT, language_id TEXT, note TEXT);
CREATE TABLE object_dates (object_id TEXT REFERENCES objects(id), seq INTEGER, label TEXT, year_from INTEGER,
  year_to INTEGER, epoch_id TEXT, basis_id TEXT, prefix_id TEXT, suffix_id TEXT, note TEXT);
CREATE TABLE object_creators (object_id TEXT REFERENCES objects(id), seq INTEGER, actor_id TEXT, relation TEXT,
  role_id TEXT, attribution_id TEXT);
CREATE TABLE object_inscriptions (object_id TEXT REFERENCES objects(id), seq INTEGER, text TEXT, type_ids TEXT,
  note TEXT, translation TEXT);
CREATE TABLE object_texts (object_id TEXT REFERENCES objects(id), seq INTEGER, title TEXT, text TEXT, type_id TEXT,
  source TEXT);
CREATE TABLE object_parts (object_id TEXT REFERENCES objects(id), part_id TEXT, seq INTEGER, label TEXT, type_id TEXT,
  note TEXT, prefix TEXT);
CREATE TABLE object_dimensions (object_id TEXT REFERENCES objects(id), part_id TEXT, dimension TEXT, value TEXT,
  unit_id TEXT, label TEXT);
CREATE TABLE object_identifiers (object_id TEXT REFERENCES objects(id), type_id TEXT, value TEXT);
CREATE TABLE object_links (object_id TEXT REFERENCES objects(id), seq INTEGER, url TEXT, type_id TEXT, note TEXT);
CREATE TABLE object_conditions (object_id TEXT REFERENCES objects(id), condition_ids TEXT, note TEXT, date TEXT);
CREATE TABLE object_relations (object_id TEXT REFERENCES objects(id), target_id TEXT REFERENCES objects(id), type_id TEXT, label TEXT);
CREATE TABLE object_multimedia (object_id TEXT REFERENCES objects(id), multimedia_id TEXT, seq INTEGER,
  is_primary INTEGER DEFAULT 0);

CREATE TABLE acquisitions (
  object_id TEXT PRIMARY KEY REFERENCES objects(id), type_id TEXT, date TEXT, date_label TEXT, date_uncertain INTEGER,
  source_id TEXT, note TEXT, reference TEXT, price_value REAL, currency_id TEXT,
  currency_code TEXT, price_label TEXT, price_note TEXT, is_batch_price INTEGER DEFAULT 0,
  price_chf REAL, conversion_rate REAL, year INTEGER, sort_key TEXT);

CREATE TABLE multimedia (
  id TEXT PRIMARY KEY, label TEXT, name TEXT, usage_id TEXT, type_id TEXT, category_id TEXT,
  iiif_service TEXT, width INTEGER, height INTEGER, page TEXT, license_id TEXT,
  right_holder_id TEXT, rights_end_date TEXT, rights_note TEXT, credit_line TEXT,
  original_right_holder_id TEXT, photographer_id TEXT, photo_date TEXT, not_found INTEGER DEFAULT 0);

CREATE TABLE provenance (
  id TEXT PRIMARY KEY, label TEXT, statement TEXT, inventory_number TEXT, certainty_id TEXT,
  holding_kind_id TEXT, date_label TEXT, date_from TEXT, date_to TEXT, begin_qualifier_id TEXT,
  begin_from TEXT, begin_to TEXT, end_qualifier_id TEXT, end_from TEXT, end_to TEXT,
  date_note TEXT, transaction_kind TEXT, transaction_type_id TEXT, owner_id TEXT,
  owner_type_id TEXT, place TEXT, price_value REAL, currency_id TEXT, currency_code TEXT,
  price_label TEXT, price_note TEXT, is_batch_price INTEGER DEFAULT 0, status_id TEXT,
  year_first INTEGER, year_last INTEGER, sort_first TEXT, sort_last TEXT);
CREATE TABLE provenance_objects (provenance_id TEXT, object_id TEXT REFERENCES objects(id), seq INTEGER);
CREATE TABLE provenance_sources (provenance_id TEXT, seq INTEGER, type_id TEXT, note TEXT, url TEXT);
CREATE TABLE provenance_characteristics (provenance_id TEXT, seq INTEGER, type_ids TEXT, note TEXT);

CREATE TABLE literature (
  id TEXT PRIMARY KEY, label TEXT, title TEXT, type_id TEXT, signature TEXT, isbn TEXT,
  year_label TEXT, year_from INTEGER, year_to INTEGER, place_id TEXT, series TEXT,
  series_id TEXT, volume TEXT, edition TEXT, pages TEXT, citation TEXT, language_id TEXT,
  urls TEXT);
CREATE TABLE literature_actors (literature_id TEXT, actor_id TEXT, kind TEXT, role_id TEXT, seq INTEGER);
CREATE TABLE literature_refs (literature_id TEXT, ref_id TEXT, object_id TEXT REFERENCES objects(id),
  provenance_id TEXT, shows_object INTEGER DEFAULT 0, page TEXT, figure TEXT, catalogue TEXT,
  sort INTEGER, note TEXT, citation TEXT);
CREATE TABLE literature_links (literature_id TEXT, target_id TEXT, role_id TEXT);

CREATE TABLE exhibitions (
  id TEXT PRIMARY KEY, label TEXT, title TEXT, exhibition_type_id TEXT, status_id TEXT,
  internal_external_id TEXT, date_from TEXT, date_to TEXT, venue_id TEXT);
CREATE TABLE exhibition_venues (exhibition_id TEXT, address_id TEXT, kind TEXT, type_id TEXT,
  date_from TEXT, date_to TEXT, note TEXT);
CREATE TABLE exhibition_organisers (exhibition_id TEXT, address_id TEXT, role_id TEXT, seq INTEGER);
CREATE TABLE exhibition_objects (exhibition_id TEXT, object_id TEXT REFERENCES objects(id));
CREATE TABLE exhibition_multimedia (exhibition_id TEXT, multimedia_id TEXT);

CREATE TABLE object_groups (id TEXT PRIMARY KEY, label TEXT, description TEXT);
CREATE TABLE object_group_members (group_id TEXT, object_id TEXT REFERENCES objects(id));
"""

INDEXES = """
CREATE INDEX ix_terms_scheme ON terms(scheme_id);
CREATE INDEX ix_terms_facet ON terms(facet);
CREATE INDEX ix_term_labels ON term_labels(label);
CREATE INDEX ix_term_anc ON term_ancestors(ancestor_id);
CREATE INDEX ix_objects_inv ON objects(inventory_number);
CREATE INDEX ix_objects_parent ON objects(parent_id);
CREATE INDEX ix_objects_date ON objects(date_from, date_to);
CREATE INDEX ix_ot_term ON object_terms(facet, term_id);
CREATE INDEX ix_ot_obj ON object_terms(object_id);
CREATE INDEX ix_ot_termid ON object_terms(term_id);
CREATE INDEX ix_titles_obj ON object_titles(object_id);
CREATE INDEX ix_dates_obj ON object_dates(object_id);
CREATE INDEX ix_creators_obj ON object_creators(object_id);
CREATE INDEX ix_creators_actor ON object_creators(actor_id);
CREATE INDEX ix_insc_obj ON object_inscriptions(object_id);
CREATE INDEX ix_texts_obj ON object_texts(object_id);
CREATE INDEX ix_parts_obj ON object_parts(object_id);
CREATE INDEX ix_dims_obj ON object_dimensions(object_id);
CREATE INDEX ix_ident_obj ON object_identifiers(object_id);
CREATE INDEX ix_ident_val ON object_identifiers(value);
CREATE INDEX ix_links_obj ON object_links(object_id);
CREATE INDEX ix_cond_obj ON object_conditions(object_id);
CREATE INDEX ix_rel_obj ON object_relations(object_id);
CREATE INDEX ix_rel_target ON object_relations(target_id);
CREATE INDEX ix_om_obj ON object_multimedia(object_id);
CREATE INDEX ix_om_mm ON object_multimedia(multimedia_id);
CREATE INDEX ix_acq_source ON acquisitions(source_id);
CREATE INDEX ix_acq_type ON acquisitions(type_id);
CREATE INDEX ix_acq_year ON acquisitions(year, object_id, sort_key, price_value);
CREATE INDEX ix_prov_owner ON provenance(owner_id);
CREATE INDEX ix_po_obj ON provenance_objects(object_id);
CREATE INDEX ix_po_prov ON provenance_objects(provenance_id);
CREATE INDEX ix_ps_prov ON provenance_sources(provenance_id);
CREATE INDEX ix_pc_prov ON provenance_characteristics(provenance_id);
CREATE INDEX ix_names_actor ON actor_names(actor_id);
CREATE INDEX ix_nat_actor ON actor_nationalities(actor_id);
CREATE INDEX ix_events_actor ON actor_events(actor_id);
CREATE INDEX ix_ext_actor ON actor_external(actor_id);
CREATE INDEX ix_links_actor ON actor_links(actor_id);
CREATE INDEX ix_gnd_actor ON actor_gnd(actor_id);
CREATE INDEX ix_rel_subject ON actor_relations(subject_id);
CREATE INDEX ix_rel_target2 ON actor_relations(target_id);
CREATE INDEX ix_mm_holder ON multimedia(right_holder_id);
CREATE INDEX ix_mm_photographer ON multimedia(photographer_id);
CREATE INDEX ix_la_lit ON literature_actors(literature_id);
CREATE INDEX ix_la_actor ON literature_actors(actor_id);
CREATE INDEX ix_lr_lit ON literature_refs(literature_id);
CREATE INDEX ix_lr_obj ON literature_refs(object_id);
CREATE INDEX ix_lr_prov ON literature_refs(provenance_id);
CREATE INDEX ix_ll_lit ON literature_links(literature_id);
CREATE INDEX ix_ll_target ON literature_links(target_id);
CREATE INDEX ix_ev_exh ON exhibition_venues(exhibition_id);
CREATE INDEX ix_ev_addr ON exhibition_venues(address_id);
CREATE INDEX ix_eo_exh ON exhibition_objects(exhibition_id);
CREATE INDEX ix_eo_obj ON exhibition_objects(object_id);
CREATE INDEX ix_eorg_exh ON exhibition_organisers(exhibition_id);
CREATE INDEX ix_em_exh ON exhibition_multimedia(exhibition_id);
CREATE INDEX ix_gm_group ON object_group_members(group_id);
CREATE INDEX ix_gm_obj ON object_group_members(object_id);
"""

FTS = """
CREATE VIRTUAL TABLE objects_fts USING fts5(
  object_id UNINDEXED, title, label, inscription, text, inventory_number,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE actors_fts USING fts5(actor_id UNINDEXED, names,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE literature_fts USING fts5(literature_id UNINDEXED, title, authors, series,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE exhibitions_fts USING fts5(exhibition_id UNINDEXED, title, venues,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE terms_fts USING fts5(term_id UNINDEXED, labels,
  tokenize = 'unicode61 remove_diacritics 2');
"""


# ---------------------------------------------------------------- helpers

def sid(iri):
    """Short id of an SKKG IRI: 'https://data.skkg.ch/object/2432' -> 'object/2432'."""
    return iri[len(D):] if iri and iri.startswith(D) else iri


def year(value):
    """Year of an xsd:date, gYear or free text such as '1978-01-01', '-0600', '1909/1911'."""
    if not value:
        return None
    m = re.match(r"\s*(-?\d{1,4})(?!\d)", value)
    return int(m.group(1)) if m else None


# A side of a provenance period that SKKG leaves open is stored as this year or its negative,
# beyond every year the search tools accept (notes/11).
OPEN_YEAR = 9999


def sort_key(y, date):
    """The text the date sorts compare: the year, shifted so every year from -9999 to 9999 sorts
    as text, then the recorded date, which breaks ties within the year and among open sides.
    None when there is no year, so the entry sorts with the undated ones."""
    if y is None:
        return None
    assert -OPEN_YEAR <= y <= OPEN_YEAR, y
    return f"{y + OPEN_YEAR + 1:05d} {date}"


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def integer(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def fts_text(*parts):
    """Join text for FTS and append a copy with umlauts spelled out, so 'ue' finds 'ü'."""
    s = "\n".join(p for p in parts if p)
    folded = s.translate(UMLAUT)
    return s if folded == s else s + "\n" + folded


def is_anonymisation(label):
    """SKKG's placeholder for owners it does not name, in either capitalisation."""
    return (label or "").strip().casefold().startswith("unbekannte:r")


def scheme_of(term_id):
    m = re.match(r"type/([^/]+)/", term_id or "")
    return m.group(1) if m else None


class Source:
    """Runs SPARQL on the store and records which predicates each record type reads."""

    def __init__(self, store):
        self.store = store
        self.read = defaultdict(set)
        self.timings = []

    def q(self, root, query):
        for p in re.findall(r"\b(crm|rdfs|skos|la|aaao|crmdig|crmsci|frbroo|gndo|schema):([A-Za-z0-9_.\-]+)", query):
            self.read[root].add(f"{p[0]}:{p[1]}")
        t = time.time()
        out = []
        for sol in self.store.query(PREFIX + query):
            row = []
            for x in sol:
                if x is None or isinstance(x, BlankNode):
                    row.append(None)
                elif isinstance(x, NamedNode):
                    row.append(sid(x.value))
                elif isinstance(x, Literal):
                    row.append(x.value)
                else:
                    row.append(str(x))
            out.append(tuple(row))
        secs = round(time.time() - t, 2)
        self.timings.append((root, secs, len(out), " ".join(query.split())[:160]))
        if secs > 10:
            print(f"  slow query ({secs} s, {len(out)} rows): {' '.join(query.split())[:160]}", flush=True)
        return out


def first_by_seq(items):
    """items: list of (seq or None, value); returns values ordered by seq, None last."""
    return [v for _, v in sorted(items, key=lambda x: (x[0] is None, x[0] if x[0] is not None else 0))]


# ---------------------------------------------------------------- vocabulary

def load_terms(src, db, used_terms):
    schemes = {s: n for s, n in src.q("type", "SELECT ?s ?l WHERE { ?s a skos:ConceptScheme ; rdfs:label ?l }")}
    labels = defaultdict(dict)
    for t, lab, lang in src.q("type", """SELECT ?t ?l (LANG(?l) AS ?lang) WHERE {
        ?t a skkg:Type ; skos:prefLabel ?l }"""):
        labels[t].setdefault(lang or "", lab)
    # Terms used by records but not typed skkg:Type, e.g. the depot location.
    missing = sorted(t for t in used_terms if t and t.startswith("type/") and t not in labels)
    for i in range(0, len(missing), 500):
        values = " ".join(f"<{D}{t}>" for t in missing[i:i + 500])
        for t, lab, lang in src.q("type", f"""SELECT ?t ?l (LANG(?l) AS ?lang) WHERE {{
            VALUES ?t {{ {values} }} {{ ?t skos:prefLabel ?l }} UNION {{ ?t rdfs:label ?l }} }}"""):
            labels[t].setdefault(lang or "", lab)
    broader = {t: b for t, b in src.q("type", "SELECT ?t ?b WHERE { ?t a skkg:Type ; crm:P127_has_broader_term ?b }")}
    years = {}
    for t, a, b in src.q("type", """SELECT ?t ?a ?b WHERE { ?t a skkg:Type .
        OPTIONAL { ?t crm:P82a_begin_of_the_begin ?a } OPTIONAL { ?t crm:P82b_end_of_the_end ?b }
        FILTER(BOUND(?a) || BOUND(?b)) }"""):
        years[t] = (year(a), year(b))
    matches = defaultdict(list)
    for t, m in src.q("type", """SELECT ?t ?m WHERE { ?t a skkg:Type .
        { ?t skos:exactMatch ?m } UNION { ?t skos:closeMatch ?m } UNION { ?t crmdig:L54_is_same-as ?m } }"""):
        if m:
            matches[t].append(m)

    rows, label_rows = [], []
    for t, labs in labels.items():
        sch = scheme_of(t)
        de = labs.get("de")
        en, fr = labs.get("en"), labs.get("fr")
        plain = labs.get("")
        label = de or plain or en or fr or next(iter(labs.values()))
        y = years.get(t, (None, None))
        rows.append((t, sch, FACETS.get(sch), de, en, fr, label, broader.get(t), y[0], y[1],
                     json.dumps(sorted(set(matches[t]))) if matches.get(t) else None))
        for lang, lab in labs.items():
            label_rows.append((t, lang, lab))
    db.executemany("INSERT INTO terms (id, scheme_id, facet, label_de, label_en, label_fr, label, "
                   "broader_id, year_from, year_to, matches) VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.executemany("INSERT INTO term_labels VALUES (?,?,?)", label_rows)
    db.executemany("INSERT INTO schemes VALUES (?,?,?)",
                   [(sid(s).split("/")[1], n, FACETS.get(sid(s).split("/")[1])) for s, n in schemes.items()])

    anc = []
    for t in labels:
        seen, cur, depth = set(), t, 0
        # The walk stops at a broader id that is not a term, such as the scheme node.
        while cur and cur not in seen and cur in labels:
            anc.append((t, cur, depth))
            seen.add(cur)
            cur = broader.get(cur)
            depth += 1
    db.executemany("INSERT OR IGNORE INTO term_ancestors VALUES (?,?,?)", anc)
    return len(rows)


# ---------------------------------------------------------------- actors and addresses

def load_addresses(src, db, used):
    """Address records. Personal name parts are checked for presence only, never read."""
    q = src.q
    base = {a: lab for a, lab in q("address", "SELECT ?a ?l WHERE { ?a a skkg:Address ; skos:prefLabel ?l FILTER(LANG(?l) = '' || LANG(?l) = 'de') }")}
    private = {a for (a,) in q("address", f"""SELECT DISTINCT ?a WHERE {{ ?a a skkg:Address ;
        crm:P1_is_identified_by ?n . ?n crm:P106_is_composed_of ?p .
        ?p crm:P2_has_type ?t VALUES ?t {{ <{AAT_GIVEN}> <{AAT_SURNAME}> }} }}""")}
    private |= {a for (a,) in q("address", """SELECT DISTINCT ?a WHERE { ?a a skkg:Address ;
        crm:P1_is_identified_by ?n . FILTER(CONTAINS(STR(?n), '/altname/')) }""")}
    private.add(ANON_ADDRESS)
    org = {a: v for a, v in q("address", f"""SELECT ?a ?v WHERE {{ ?a a skkg:Address ;
        crm:P1_is_identified_by ?n . ?n crm:P106_is_composed_of ?p .
        ?p crm:P2_has_type <{AAT_ORG}> ; crm:P190_has_symbolic_content ?v }}""")}
    place, region, country, website = {}, {}, {}, {}
    for a, part, v in q("address", """SELECT ?a ?p ?v WHERE { ?a a skkg:Address ;
        crm:P76_has_contact_point ?c . ?c crm:P106_is_composed_of ?p .
        OPTIONAL { ?p crm:P190_has_symbolic_content ?v } }"""):
        if part.endswith("/address/place"):
            place[a] = v
        elif part.endswith("/address/region"):
            region[a] = v
        elif part.startswith("type/"):
            country[a] = part
        elif part.startswith("http"):
            # sid() has shortened SKKG's own IRIs, so only an outside URL is left here.
            website.setdefault(a, []).append(part)
    atype = {a: t for a, t in q("address", "SELECT ?a ?t WHERE { ?a a skkg:Address ; crm:P2_has_type ?t }")}
    coords = {a: (num(la), num(lo)) for a, la, lo in q("address", """SELECT ?a ?la ?lo WHERE {
        ?a a skkg:Address ; schema:latitude ?la ; schema:longitude ?lo }""")}

    rows = []
    for a, lab in base.items():
        is_private = a in private
        if is_private:
            label = ", ".join(x for x in (org.get(a) or "Privatperson", place.get(a)) if x)
            lat = lon = url = None
        else:
            label = lab
            lat, lon = coords.get(a, (None, None))
            url = min(website[a]) if a in website else None
        rows.append((a, label, org.get(a), place.get(a), region.get(a), country.get(a), atype.get(a),
                     lat, lon, 1 if is_private else 0, url))
        used.update([country.get(a), atype.get(a)])
    db.executemany("INSERT INTO addresses VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows), len(private)


def load_actors(src, db, used):
    q = src.q
    kinds = {}
    for a, c in q("person", """SELECT ?a ?c WHERE { ?a a ?c VALUES ?c { skkg:Person skkg:Group skkg:Actor } }"""):
        if c.endswith("Person"):
            kinds[a] = "person"
        elif c.endswith("Group"):
            kinds[a] = "group"
        else:
            kinds.setdefault(a, "actor")
    labels = {}
    for a, lab, lang in q("person", """SELECT ?a ?l (LANG(?l) AS ?lang) WHERE {
        ?a a ?c VALUES ?c { crm:E21_Person crm:E39_Actor crm:E74_Group skkg:Actor } ?a rdfs:label ?l }"""):
        if a.startswith(("person/", "actor/")):
            if lang in ("", "de") or a not in labels:
                labels[a] = lab
    for a, lab in q("person", "SELECT ?a ?l WHERE { ?a a skkg:Actor ; skos:prefLabel ?l }"):
        labels[a] = lab
    # Actors with only a label; skkg_get_record names them by their part in literature.
    for a in labels:
        kinds.setdefault(a, "stub")
    kinds[ANON_ACTOR] = "anonymous"

    name, parts = {}, defaultdict(dict)
    for a, v in q("person", "SELECT ?a ?v WHERE { ?a a skkg:Actor ; crm:P1_is_identified_by ?n . ?n crm:P190_has_symbolic_content ?v FILTER(STRENDS(STR(?n), '/name')) }"):
        name[a] = v
    for a, p, v in q("person", """SELECT ?a ?p ?v WHERE { ?a a skkg:Actor ; crm:P1_is_identified_by ?n .
        ?n crm:P106_is_composed_of ?p . ?p crm:P190_has_symbolic_content ?v }"""):
        parts[a][p.rsplit("/", 1)[-1]] = v
    gender = {}
    nat = []
    for a, t in q("person", "SELECT ?a ?t WHERE { ?a a skkg:Actor ; crm:P2_has_type ?t }"):
        if t.endswith("/citizenship"):
            nat.append((a, t[: -len("/citizenship")]))
        elif scheme_of(t) == "20088":
            gender[a] = t
        used.add(t)
    used.update(c for _, c in nat)

    events = defaultdict(dict)
    for a, ev, lab, d0, d1, pl, plt, note in q("person", """SELECT ?a ?e ?dl ?d0 ?d1 ?pl ?plt ?note WHERE {
        ?a a skkg:Actor . VALUES ?p { crm:P98i_was_born crm:P100i_died_in crm:P95i_was_formed_by crm:P99i_was_dissolved_by }
        ?a ?p ?e .
        OPTIONAL { ?e crm:P4_has_time-span ?ts . OPTIONAL { ?ts rdfs:label ?dl }
                   OPTIONAL { ?ts crm:P82a_begin_of_the_begin ?d0 } OPTIONAL { ?ts crm:P82b_end_of_the_end ?d1 } }
        OPTIONAL { ?e crm:P7_took_place_at ?place . OPTIONAL { ?place rdfs:label ?pl } OPTIONAL { ?place crm:P89_falls_within ?plt } }
        OPTIONAL { ?e crm:P3_has_note ?note } }"""):
        kind = ev.rsplit("/", 1)[-1]
        events[a][kind] = (lab, year(d0), year(d1), pl, plt, note)
        used.add(plt)
    other_events = []
    for a, ev, typ, lab, dl, d0, d1, d2, d3 in q("person", """SELECT ?a ?e ?t ?l ?dl ?d0 ?d1 ?d2 ?d3 WHERE {
        ?a a skkg:Actor ; crm:P14i_performed ?e . OPTIONAL { ?e crm:P2_has_type ?t FILTER(STRSTARTS(STR(?t), 'https://data.skkg.ch/')) }
        OPTIONAL { ?e rdfs:label ?l }
        OPTIONAL { ?e crm:P4_has_time-span ?ts . OPTIONAL { ?ts rdfs:label ?dl }
          OPTIONAL { ?ts crm:P82a_begin_of_the_begin ?d0 } OPTIONAL { ?ts crm:P81a_end_of_the_begin ?d1 }
          OPTIONAL { ?ts crm:P81b_begin_of_the_end ?d2 } OPTIONAL { ?ts crm:P82b_end_of_the_end ?d3 } } }"""):
        other_events.append((a, ev.rsplit("/", 1)[-1], typ, lab, dl, year(d0), year(d3) or year(d2), None, None, None))
        used.add(typ)

    for a, ev in events.items():
        for kind, (lab, y0, y1, pl, plt, note) in ev.items():
            other_events.append((a, kind, None, None, lab, y0, y1, pl, plt, note))
    db.executemany("INSERT INTO actor_events VALUES (?,?,?,?,?,?,?,?,?,?)", other_events)

    bio = {a: v for a, v in q("person", """SELECT ?a ?v WHERE { ?a a skkg:Actor ; crm:P67i_is_referred_to_by ?b .
        ?b crm:P190_has_symbolic_content ?v FILTER(STRENDS(STR(?b), '/biography')) }""")}

    rows = []
    for a, kind in kinds.items():
        if a not in labels and a != ANON_ACTOR:
            continue
        p = parts.get(a, {})
        ev = events.get(a, {})
        b = ev.get("birth") or ev.get("formation") or (None,) * 6
        dd = ev.get("death") or ev.get("dissolution") or (None,) * 6
        label = "Privatperson" if a == ANON_ACTOR else labels.get(a)
        anon = 1 if a == ANON_ACTOR or is_anonymisation(label) else 0
        rows.append((a, kind, label, name.get(a), p.get("firstname"), p.get("lastname"),
                     p.get("corporatename"), gender.get(a), b[0], b[1], b[2], b[3], b[4],
                     dd[0], dd[1], dd[2], dd[3], dd[4], bio.get(a), anon))
    db.executemany("INSERT INTO actors VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.executemany("INSERT INTO actor_nationalities VALUES (?,?)", nat)

    names = [(a, v, t, "skkg") for a, v, t in q("person", """SELECT ?a ?v ?t WHERE { ?a a skkg:Actor ;
        crm:P1_is_identified_by ?n . ?n crm:P190_has_symbolic_content ?v FILTER(CONTAINS(STR(?n), '/alternativeName/'))
        OPTIONAL { ?n crm:P2_has_type ?t } }""")]
    used.update(n[2] for n in names)

    ext, gnd_ids = [], {}
    for a, x in q("person", "SELECT ?a ?x WHERE { ?a a skkg:Actor ; crmdig:L54_is_same-as ?x }"):
        if "d-nb.info/gnd/" in x:
            src_name, ident = "gnd", x.rsplit("/", 1)[-1]
            gnd_ids[x] = a
        elif "wikidata.org" in x:
            src_name, ident = "wikidata", x.rsplit("/", 1)[-1]
        else:
            m = re.match(r"https?://([^/]+)", x)
            src_name, ident = (m.group(1) if m else "other"), None
        ext.append((a, src_name, ident, x))
    db.executemany("INSERT INTO actor_external VALUES (?,?,?,?)", ext)

    gnd = defaultdict(lambda: {"pref": None, "bio": None, "prof": set(), "variants": set()})
    for a, g, pref, bioinfo in q("person", """SELECT ?a ?g ?pref ?bio WHERE { ?a a skkg:Actor ; crmdig:L54_is_same-as ?g .
        ?g gndo:preferredName ?pref . OPTIONAL { ?g gndo:biographicalOrHistoricalInformation ?bio } }"""):
        gnd[(a, g)]["pref"] = pref
        gnd[(a, g)]["bio"] = bioinfo
    for a, g, v in q("person", "SELECT ?a ?g ?v WHERE { ?a a skkg:Actor ; crmdig:L54_is_same-as ?g . ?g gndo:variantName ?v }"):
        gnd[(a, g)]["variants"].add(v)
    for a, g, v in q("person", """SELECT ?a ?g ?v WHERE { ?a a skkg:Actor ; crmdig:L54_is_same-as ?g .
        ?g gndo:professionOrOccupation ?p . ?p gndo:preferredName ?v }"""):
        gnd[(a, g)]["prof"].add(v)
    gnd_rows = []
    for (a, g), d in gnd.items():
        gnd_rows.append((a, g.rsplit("/", 1)[-1], d["pref"], d["bio"], "; ".join(sorted(d["prof"])) or None))
        if d["pref"]:
            names.append((a, d["pref"], None, "gnd"))
        names.extend((a, v, None, "gnd") for v in sorted(d["variants"]))
    db.executemany("INSERT INTO actor_gnd VALUES (?,?,?,?,?)", gnd_rows)
    db.executemany("INSERT INTO actor_names VALUES (?,?,?,?)", names)

    links = q("person", """SELECT ?a ?t ?u WHERE { ?a a skkg:Actor ; crm:P67i_is_referred_to_by ?r .
        ?r crm:P1_is_identified_by ?ui . ?ui crm:P190_has_symbolic_content ?u FILTER(CONTAINS(STR(?r), '/reference/'))
        OPTIONAL { ?r crm:P2_has_type ?t } }""")
    db.executemany("INSERT INTO actor_links VALUES (?,?,?)", links)
    used.update(r[1] for r in links)
    rels = q("person", """SELECT ?s ?t ?ty ?l WHERE { ?r aaao:ZP105_has_social_relation_subject ?s ;
        aaao:ZP103_ascribes_social_relation_target ?t . OPTIONAL { ?r aaao:ZP104_ascribes_social_relation ?ty }
        OPTIONAL { ?r rdfs:label ?l } }""")
    db.executemany("INSERT INTO actor_relations VALUES (?,?,?,?)", rels)
    used.update(r[2] for r in rels)
    for e in other_events:
        used.add(e[8])
    return len(rows)


# ---------------------------------------------------------------- objects

def load_objects(src, db, used):
    q = src.q
    O = "?o a skkg:Object ."
    inv = dict(q("object", f"""SELECT ?o ?v WHERE {{ {O} ?o crm:P1_is_identified_by ?i .
        ?i crm:P2_has_type <https://data.skkg.ch/type/invnr> ; crm:P190_has_symbolic_content ?v }}"""))
    label = dict(q("object", f"SELECT ?o ?l WHERE {{ {O} ?o skos:prefLabel ?l }}"))
    otype = dict(q("object", f"SELECT ?o ?t WHERE {{ {O} ?o crm:P2_has_type ?t }}"))
    nparts = dict(q("object", f"SELECT ?o ?n WHERE {{ {O} ?o crm:P57_has_number_of_parts ?n }}"))
    parent = dict(q("object", f"SELECT ?o ?p WHERE {{ {O} ?o crm:P46i_forms_part_of ?p . ?p a skkg:Object }}"))
    manifest = dict(q("object", f"""SELECT ?o ?u WHERE {{ {O} ?o crm:P129i_is_subject_of ?m .
        ?m la:digitally_carried_by ?d . ?d la:access_point ?u }}"""))

    texts = defaultdict(dict)
    for o, typ, v in q("object", f"""SELECT ?o ?t ?v WHERE {{ {O} ?o crm:P67i_is_referred_to_by ?s .
        ?s crm:P2_has_type ?t ; crm:P190_has_symbolic_content ?v
        VALUES ?t {{ <{AAT_CREDIT}> <{AAT_EDITION}> <{AAT_MATERIAL_STATEMENT}> }} }}"""):
        texts[o][typ] = v

    meta = {}
    for o, red, c, u in q("object", f"""SELECT ?o ?red ?c ?u WHERE {{ {O} ?o crm:P70i_is_documented_in ?m .
        OPTIONAL {{ ?m crm:P2_has_type ?red }}
        OPTIONAL {{ ?m crm:P94i_was_created_by ?cr . ?cr crm:P4_has_time-span/crm:P82_at_some_time_within ?c .
                   OPTIONAL {{ ?cr crm:P9_consists_of/crm:P4_has_time-span/crm:P82_at_some_time_within ?u }} }} }}"""):
        meta[o] = (red, c, u)

    pstat = {}
    for o, t, desc in q("object", f"""SELECT ?o ?t ?d WHERE {{ {O} ?o crm:P140i_was_attributed_by ?ps .
        OPTIONAL {{ ?ps crm:P141_assigned ?t }}
        OPTIONAL {{ ?ps crm:P67i_is_referred_to_by ?dn . ?dn crm:P190_has_symbolic_content ?d }} }}"""):
        pstat[o] = (t, desc)

    terms = []
    for o, t in otype.items():
        terms.append((o, "object_type", t, None, None))
    for o, t in q("object", f"SELECT ?o ?t WHERE {{ {O} ?o crm:P55_has_current_location ?t }}"):
        terms.append((o, "location", t, None, None))
    for o, t in q("object", f"SELECT ?o ?t WHERE {{ {O} ?o crm:P104_is_subject_to ?r . ?r crm:P2_has_type ?t }}"):
        terms.append((o, "object_copyright", t, None, None))
    for o, t, n, note in q("object", f"""SELECT ?o ?t ?n ?note WHERE {{ ?a crm:P140_assigned_attribute_to ?o ;
        crm:P141_assigned ?t . {O} FILTER(CONTAINS(STR(?a), '/materialAssignment/'))
        OPTIONAL {{ ?a crm:P1_is_identified_by/crm:P190_has_symbolic_content ?n }}
        OPTIONAL {{ ?a crm:P3_has_note ?note }} }}"""):
        facet = "technique" if scheme_of(t) == "42157" else "material"
        terms.append((o, facet, t, integer(n), note))
    have_mat = {(r[0], r[2]) for r in terms if r[1] in ("material", "technique")}
    for o, t in q("object", f"SELECT ?o ?t WHERE {{ {O} ?o crm:P45_consists_of ?t }}"):
        if (o, t) not in have_mat:
            terms.append((o, "material", t, None, None))
            have_mat.add((o, t))
    for o, t in q("object", f"SELECT ?o ?t WHERE {{ {O} ?o crm:P108i_was_produced_by ?p . ?p crm:P32_used_general_technique ?t }}"):
        if (o, t) not in have_mat:
            terms.append((o, "technique", t, None, None))
            have_mat.add((o, t))
    for o, t in q("object", f"SELECT DISTINCT ?o ?t WHERE {{ {O} ?o crm:P108i_was_produced_by ?p . ?p crm:P10_falls_within ?t }}"):
        terms.append((o, "epoch", t, None, None))
    for o, (t, _) in pstat.items():
        if t:
            terms.append((o, "provenance_status", t, None, None))
    for o, (red, _, _) in meta.items():
        if red:
            terms.append((o, "redaction_status", red, None, None))

    # Titles.
    titles = {}
    for o, t, v in q("object", f"""SELECT ?o ?t ?v WHERE {{ {O} ?o crm:P1_is_identified_by ?t .
        ?t crm:P190_has_symbolic_content ?v FILTER(CONTAINS(STR(?t), '/title/')) }}"""):
        titles[t] = [o, None, v, None, None, None, None]
    for t, n in q("object", """SELECT ?t ?n WHERE { ?t crm:P1_is_identified_by ?s . ?s crm:P2_has_type <https://data.skkg.ch/type/sortlnu> ;
        crm:P190_has_symbolic_content ?n FILTER(CONTAINS(STR(?t), '/title/')) }"""):
        if t in titles:
            titles[t][1] = integer(n)
    for t, v in q("object", "SELECT ?t ?v WHERE { ?t crm:P139_has_alternative_form ?s . ?s crm:P190_has_symbolic_content ?v }"):
        if t in titles:
            titles[t][3] = v
    for t, ty in q("object", """SELECT ?t ?ty WHERE { ?o a skkg:Object ; crm:P1_is_identified_by ?t . ?t crm:P2_has_type ?ty
        FILTER(CONTAINS(STR(?t), '/title/')) }"""):
        if t in titles:
            titles[t][4] = ty
    for t, lang in q("object", "SELECT ?t ?l WHERE { ?o a skkg:Object ; crm:P1_is_identified_by ?t . ?t crm:P72_has_language ?l }"):
        if t in titles:
            titles[t][5] = lang
    for t, note in q("object", """SELECT ?t ?n WHERE { ?o a skkg:Object ; crm:P1_is_identified_by ?t . ?t crm:P3_has_note ?n
        FILTER(CONTAINS(STR(?t), '/title/')) }"""):
        if t in titles:
            titles[t][6] = note
    db.executemany("INSERT INTO object_titles VALUES (?,?,?,?,?,?,?)", [tuple(v) for v in titles.values()])
    used.update(v[4] for v in titles.values())
    used.update(v[5] for v in titles.values())
    by_obj_titles = defaultdict(list)
    for v in titles.values():
        by_obj_titles[v[0]].append((v[1], v[2]))

    # Production dates.
    dates = {}
    for o, ts, lab, a, b, ep, n, note in q("object", f"""SELECT ?o ?ts ?l ?a ?b ?ep ?n ?note WHERE {{ {O}
        ?o crm:P108i_was_produced_by ?p . ?p crm:P4_has_time-span ?ts .
        OPTIONAL {{ ?ts rdfs:label ?l }} OPTIONAL {{ ?ts crm:P82a_begin_of_the_begin ?a }}
        OPTIONAL {{ ?ts crm:P82b_end_of_the_end ?b }} OPTIONAL {{ ?ts crm:P86_falls_within ?ep }}
        OPTIONAL {{ ?ts crm:P1_is_identified_by ?si . ?si crm:P190_has_symbolic_content ?n }}
        OPTIONAL {{ ?ts crm:P3_has_note ?note }} }}"""):
        dates[(o, ts)] = [o, integer(n), lab, year(a), year(b) if b else year(a), ep, None, None, None, note]
    ts_index = defaultdict(list)
    for key in dates:
        ts_index[key[1]].append(key)
    for ts, basis in q("object", "SELECT ?ts ?b WHERE { ?s crm:P141_assigned ?ts ; crm:P17_was_motivated_by ?b }"):
        for key in ts_index.get(ts, []):
            dates[key][6] = basis
    for a, ts, t in q("object", """SELECT ?a ?ts ?t WHERE { ?a crm:P140_assigned_attribute_to ?ts ; crm:P141_assigned ?t .
        ?ts a crm:E52_Time-Span . FILTER(STRSTARTS(STR(?ts), 'https://data.skkg.ch/timespan/')) }"""):
        slot = 7 if a.endswith("/prefix") else 8 if a.endswith("/suffix") else None
        if slot:
            for key in ts_index.get(ts, []):
                dates[key][slot] = t
    db.executemany("INSERT INTO object_dates VALUES (?,?,?,?,?,?,?,?,?,?)", [tuple(v) for v in dates.values()])
    for v in dates.values():
        used.update(v[5:9])
    by_obj_dates = defaultdict(list)
    for v in dates.values():
        by_obj_dates[v[0]].append(v)

    # Creators.
    creators = {}
    for o, pp, rel, actor, n in q("object", f"""SELECT ?o ?pp ?rel ?a ?n WHERE {{ {O} ?o crm:P108i_was_produced_by ?p .
        ?p crm:P9_consists_of ?pp . ?pp ?rel ?a VALUES ?rel {{ crm:P14_carried_out_by crm:P15_was_influenced_by }}
        OPTIONAL {{ ?pp crm:P1_is_identified_by ?si . ?si crm:P190_has_symbolic_content ?n }} }}"""):
        creators[(pp, actor)] = [o, integer(n), actor, "carried_out_by" if rel.endswith("P14_carried_out_by") else "influenced_by", None, None]
    pp_types = defaultdict(list)
    for pp, t in q("object", """SELECT ?pp ?t WHERE { ?o a skkg:Object ; crm:P108i_was_produced_by ?p .
        ?p crm:P9_consists_of ?pp . ?pp crm:P2_has_type ?t }"""):
        pp_types[pp].append(t)
    for (pp, _), row in creators.items():
        for t in pp_types.get(pp, []):
            if scheme_of(t) == "21118":
                row[4] = t
            elif scheme_of(t) == "21117":
                row[5] = t
            used.add(t)
    db.executemany("INSERT INTO object_creators VALUES (?,?,?,?,?,?)", [tuple(v) for v in creators.values()])

    # Inscriptions.
    ins = {}
    for o, i, v in q("object", f"SELECT ?o ?i ?v WHERE {{ {O} ?o crm:P128_carries ?i . ?i crm:P190_has_symbolic_content ?v }}"):
        ins[i] = [o, None, v, [], None, None]
    for i, n in q("object", """SELECT ?i ?n WHERE { ?o a skkg:Object ; crm:P128_carries ?i . ?i crm:P1_is_identified_by ?s .
        ?s crm:P2_has_type <https://data.skkg.ch/type/sortlnu> ; crm:P190_has_symbolic_content ?n }"""):
        if i in ins:
            ins[i][1] = integer(n)
    # Two queries: a UNION inside this join took 12 minutes on Oxigraph.
    for pred in ("crm:P2_has_type", "crm:P1_is_identified_by"):
        for i, t in q("object", f"""SELECT ?i ?t WHERE {{ ?o a skkg:Object ; crm:P128_carries ?i .
            ?i {pred} ?t FILTER(STRSTARTS(STR(?t), 'https://data.skkg.ch/type/')) }}"""):
            if i in ins and t not in ins[i][3] and scheme_of(t):
                ins[i][3].append(t)
                used.add(t)
    for i, v in q("object", "SELECT ?i ?v WHERE { ?o a skkg:Object ; crm:P128_carries ?i . ?i crm:P3_has_note ?v }"):
        if i in ins:
            ins[i][4] = v
    for i, v in q("object", """SELECT ?i ?v WHERE { ?o a skkg:Object ; crm:P128_carries ?i . ?i crm:P73_has_translation ?t .
        ?t crm:P190_has_symbolic_content ?v }"""):
        if i in ins:
            ins[i][5] = v
    db.executemany("INSERT INTO object_inscriptions VALUES (?,?,?,?,?,?)",
                   [(v[0], v[1], v[2], json.dumps(v[3]) if v[3] else None, v[4], v[5]) for v in ins.values()])

    # Object texts.
    otexts = q("object", f"""SELECT ?o ?n ?ti ?v ?t ?c WHERE {{ {O} ?o crm:P67i_is_referred_to_by ?x .
        ?x crm:P190_has_symbolic_content ?v FILTER(CONTAINS(STR(?x), '/text/'))
        OPTIONAL {{ ?x crm:P2_has_type ?t FILTER(STRSTARTS(STR(?t), 'https://data.skkg.ch/')) }}
        OPTIONAL {{ ?x crm:P1_is_identified_by ?tn . ?tn crm:P190_has_symbolic_content ?ti FILTER(STRENDS(STR(?tn), '/title')) }}
        OPTIONAL {{ ?x crm:P1_is_identified_by ?sn . ?sn crm:P190_has_symbolic_content ?n FILTER(STRENDS(STR(?sn), '/sortlnu')) }}
        OPTIONAL {{ ?x crm:P67_refers_to ?src . ?src crm:P1_is_identified_by ?ci . ?ci crm:P190_has_symbolic_content ?c }} }}""")
    db.executemany("INSERT INTO object_texts VALUES (?,?,?,?,?,?)",
                   [(o, integer(n), ti, v, t, c) for o, n, ti, v, t, c in otexts])
    used.update(r[4] for r in otexts)

    # Parts and dimensions.
    parts = {}
    for o, p, lab in q("object", f"SELECT ?o ?p ?l WHERE {{ {O} ?o crm:P46_is_composed_of ?p . OPTIONAL {{ ?p rdfs:label ?l }} }}"):
        parts[p] = [o, p, None, lab, None, None, None]
    for p, n in q("object", """SELECT ?p ?n WHERE { ?o a skkg:Object ; crm:P46_is_composed_of ?p . ?p crm:P1_is_identified_by ?s .
        ?s crm:P190_has_symbolic_content ?n }"""):
        if p in parts:
            parts[p][2] = integer(n)
    for p, t in q("object", "SELECT ?p ?t WHERE { ?o a skkg:Object ; crm:P46_is_composed_of ?p . ?p crm:P2_has_type ?t }"):
        if p in parts:
            parts[p][4] = t
            used.add(t)
    for p, v in q("object", "SELECT ?p ?v WHERE { ?o a skkg:Object ; crm:P46_is_composed_of ?p . ?p crm:P3_has_note ?v }"):
        if p in parts:
            parts[p][5] = v
    for p, v in q("object", """SELECT ?p ?v WHERE { ?o a skkg:Object ; crm:P46_is_composed_of ?p .
        ?p crm:P67i_is_referred_to_by ?x . ?x crm:P190_has_symbolic_content ?v }"""):
        if p in parts:
            parts[p][6] = v
    db.executemany("INSERT INTO object_parts VALUES (?,?,?,?,?,?,?)", [tuple(v) for v in parts.values()])
    dims = q("object", f"""SELECT ?o ?p ?t ?v ?u ?l WHERE {{ {O} ?o crm:P46_is_composed_of ?p . ?p crm:P43_has_dimension ?d .
        OPTIONAL {{ ?d crm:P2_has_type ?t }} OPTIONAL {{ ?d crm:P90_has_value ?v }}
        OPTIONAL {{ ?d crm:P91_has_unit ?u }} OPTIONAL {{ ?d skos:prefLabel ?l }} }}""")
    dim_names = {AAT + "300055644": "height", AAT + "300055647": "width", AAT + "300072633": "depth"}
    db.executemany("INSERT INTO object_dimensions VALUES (?,?,?,?,?,?)",
                   [(o, p, dim_names.get(t, t), v, u, lab) for o, p, t, v, u, lab in dims])
    used.update(r[4] for r in dims)

    # Other identifiers, links, conditions, relations.
    idents = q("object", f"""SELECT ?o ?t ?v WHERE {{ {O} ?o crm:P1_is_identified_by ?i .
        ?i crm:P190_has_symbolic_content ?v FILTER(CONTAINS(STR(?i), '/otherIdentifier/')) OPTIONAL {{ ?i crm:P2_has_type ?t }} }}""")
    db.executemany("INSERT INTO object_identifiers VALUES (?,?,?)", idents)
    used.update(r[1] for r in idents)
    links = q("object", f"""SELECT ?o ?n ?u ?t ?note WHERE {{ {O} ?o crm:P67i_is_referred_to_by ?x .
        ?x crm:P1_is_identified_by ?ui . ?ui crm:P190_has_symbolic_content ?u
        FILTER(CONTAINS(STR(?x), '/url/') && STRENDS(STR(?ui), '/url'))
        OPTIONAL {{ ?x crm:P2_has_type ?t FILTER(STRSTARTS(STR(?t), 'https://data.skkg.ch/')) }}
        OPTIONAL {{ ?x crm:P3_has_note ?note }}
        OPTIONAL {{ ?x crm:P1_is_identified_by ?si . ?si crm:P190_has_symbolic_content ?n FILTER(STRENDS(STR(?si), '/sortlnu')) }} }}""")
    db.executemany("INSERT INTO object_links VALUES (?,?,?,?,?)", [(o, integer(n), u, t, note) for o, n, u, t, note in links])
    used.update(r[3] for r in links)
    conds = defaultdict(lambda: [[], None, None])
    for o, t, note, dt in q("object", f"""SELECT ?o ?t ?n ?d WHERE {{ {O} ?o crm:P34i_was_assessed_by ?c .
        OPTIONAL {{ ?c crm:P35_has_identified ?t }} OPTIONAL {{ ?c crm:P3_has_note ?n }}
        OPTIONAL {{ ?c crm:P4_has_time-span/crm:P82_at_some_time_within ?d }} }}"""):
        c = conds[o]
        if t and t not in c[0]:
            c[0].append(t)
            used.add(t)
        c[1], c[2] = note or c[1], dt or c[2]
    db.executemany("INSERT INTO object_conditions VALUES (?,?,?,?)",
                   [(o, json.dumps(c[0]) if c[0] else None, c[1], c[2]) for o, c in conds.items() if c[0] or c[1]])
    for o, c in conds.items():
        for t in c[0]:
            terms.append((o, "condition", t, None, None))
    rels = q("object", f"""SELECT ?o ?b ?t ?l WHERE {{ ?r crm:P129_is_about ?o ; crm:P67_refers_to ?b . {O}
        OPTIONAL {{ ?r crm:P2_has_type ?t }} OPTIONAL {{ ?r rdfs:label ?l }} }}""")
    db.executemany("INSERT INTO object_relations VALUES (?,?,?,?)", rels)
    used.update(r[2] for r in rels)

    db.executemany("INSERT INTO object_terms VALUES (?,?,?,?,?)", terms)
    used.update(r[2] for r in terms)

    # Multimedia order and primary image.
    om = {}
    for o, m, n in q("object", f"""SELECT ?o ?m ?n WHERE {{ ?a crm:P16_used_specific_object ?o ; crm:P140_assigned_attribute_to ?m ;
        crm:P141_assigned ?ord . ?ord crm:P190_has_symbolic_content ?n . {O} ?m a skkg:Multimedia .
        FILTER(STRENDS(STR(?a), '/assignment/order')) }}"""):
        om[(o, m)] = [o, m, integer(n), 0]
    for o, m in q("object", f"""SELECT ?o ?m WHERE {{ ?a crm:P16_used_specific_object ?o ; crm:P140_assigned_attribute_to ?m .
        {O} ?m a skkg:Multimedia . FILTER(STRENDS(STR(?a), '/assignment/primary')) }}"""):
        om.setdefault((o, m), [o, m, None, 0])[3] = 1
    for o, m in q("object", f"SELECT ?o ?m WHERE {{ {O} ?o crm:P138i_has_representation ?m . ?m a skkg:Multimedia }}"):
        om.setdefault((o, m), [o, m, None, 0])
    db.executemany("INSERT INTO object_multimedia VALUES (?,?,?,?)", [tuple(v) for v in om.values()])

    # Object rows.
    rows = []
    for o, inventory in inv.items():
        ts = sorted(by_obj_dates.get(o, []), key=lambda v: (v[1] is None, v[1] or 0))
        yrs0 = [v[3] for v in ts if v[3] is not None]
        yrs1 = [v[4] for v in ts if v[4] is not None]
        tl = first_by_seq(by_obj_titles.get(o, []))
        m = meta.get(o, (None, None, None))
        ps = pstat.get(o, (None, None))
        tx = texts.get(o, {})
        rows.append((o, inventory, label.get(o), tl[0] if tl else None, otype.get(o), nparts.get(o),
                     "; ".join(v[2] for v in ts if v[2]) or None, min(yrs0) if yrs0 else None,
                     max(yrs1) if yrs1 else None, parent.get(o), tx.get(AAT_CREDIT), tx.get(AAT_EDITION),
                     tx.get(AAT_MATERIAL_STATEMENT), ps[0], ps[1], m[0], m[1], m[2], manifest.get(o)))
    db.executemany("INSERT INTO objects (id, inventory_number, label, title, object_type_id, number_of_parts, "
                   "date_label, date_from, date_to, parent_id, credit_line, edition, material_statement, "
                   "provenance_status_id, provenance_status_text, redaction_status_id, created, updated, "
                   "manifest_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


CURRENCY_ALIASES = {"DM": "DEM", "FF": "FRF", "SFR": "CHF", "SFR.": "CHF", "FR.": "CHF", "FR": "CHF",
                    "SCHWEIZER FRANKEN": "CHF", "US-DOLLAR": "USD", "US$": "USD", "$": "USD", "£": "GBP",
                    "€": "EUR", "EURO": "EUR"}


def currency_code(label):
    """The code prices are compared by: an alias's code, else the label itself, upper-cased."""
    if not label:
        return None
    s = label.strip().upper()
    return CURRENCY_ALIASES.get(s, s)


def set_currency_codes(db):
    """Store the currency code of every price. Returns the labels that are neither an alias nor
    three letters like an ISO code, with the prices that use them: each becomes a code of its own,
    which the currency filter of skkg_search_provenance then lists."""
    terms = db.execute("SELECT id, label FROM terms WHERE facet = 'currency'").fetchall()
    for table in ("acquisitions", "provenance"):
        db.executemany(f"UPDATE {table} SET currency_code = ? WHERE currency_id = ?", [(currency_code(lab), t) for t, lab in terms])
    odd = Counter()
    for t, lab in terms:
        s = (lab or "").strip().upper()
        if s and s not in CURRENCY_ALIASES and not re.fullmatch(r"[A-Z]{3}", s):
            odd[lab] += sum(db.execute(f"SELECT COUNT(*) FROM {table} WHERE currency_id = ? AND price_value IS NOT NULL", (t,)).fetchone()[0]
                            for table in ("acquisitions", "provenance"))
    return dict(sorted(odd.items()))


def load_acquisitions(src, db, used):
    q = src.q
    acq = {}
    for o, a, t, note in q("object", """SELECT ?o ?a ?t ?n WHERE { ?o a skkg:Object ; crm:P24i_changed_ownership_through ?a .
        ?a a crm:E8_Acquisition . OPTIONAL { ?a crm:P2_has_type ?t } OPTIONAL { ?a crm:P3_has_note ?n } }"""):
        acq[a] = {"o": o, "type": t, "note": note}
        used.add(t)
    for a, d, lab, unc in q("object", """SELECT ?a ?d ?l ?u WHERE { ?o a skkg:Object ; crm:P24i_changed_ownership_through ?a .
        ?a crm:P4_has_time-span ?ts . OPTIONAL { ?ts crm:P82_at_some_time_within ?d } OPTIONAL { ?ts rdfs:label ?l }
        OPTIONAL { ?ts crm:P2_has_type ?u } }"""):
        if a in acq:
            acq[a].update(date=d, date_label=lab, uncertain=1 if unc else 0)
    for a, s in q("object", "SELECT ?a ?s WHERE { ?o a skkg:Object ; crm:P24i_changed_ownership_through ?a . ?a crm:P23_transferred_title_from ?s }"):
        if a in acq:
            acq[a]["source"] = s
    for a, v in q("object", """SELECT ?a ?v WHERE { ?o a skkg:Object ; crm:P24i_changed_ownership_through ?a .
        ?a crm:P67i_is_referred_to_by ?r . ?r crm:P190_has_symbolic_content ?v }"""):
        if a in acq:
            acq[a]["reference"] = v
    for a, pay, note, lab, val, cur in q("object", """SELECT ?a ?pay ?n ?l ?v ?c WHERE { ?o a skkg:Object ;
        crm:P24i_changed_ownership_through ?a . ?a crm:P9_consists_of ?pay . OPTIONAL { ?pay crm:P3_has_note ?n }
        OPTIONAL { ?pay la:paid_amount ?pr . OPTIONAL { ?pr rdfs:label ?l } OPTIONAL { ?pr crm:P90_has_value ?v }
                   OPTIONAL { ?pr crm:P180_has_currency ?c } } }"""):
        if a in acq:
            acq[a].update(price_note=note, price_label=lab, price=num(val), currency=cur, payment=pay)
            used.add(cur)
    conv = {}
    for price, norm, rate in q("object", """SELECT ?p ?nv ?r WHERE { ?c crmsci:O11_described ?p ;
        crmsci:O10_assigned_dimension ?n . ?n crm:P90_has_value ?nv .
        OPTIONAL { ?c crm:P15_was_influenced_by ?rn . ?rn crm:P90_has_value ?r } }"""):
        conv[price.rsplit("/price", 1)[0]] = (num(norm), num(rate))
    rows = []
    for a, d in acq.items():
        c = conv.get(d.get("payment"), (None, None))
        notes = " ".join(x for x in (d.get("price_note"), d.get("note"), d.get("price_label")) if x)
        y = year(d.get("date"))
        rows.append((d["o"], d.get("type"), d.get("date"), d.get("date_label"), d.get("uncertain"), d.get("source"),
                     d.get("note"), d.get("reference"), d.get("price"), d.get("currency"),
                     None, d.get("price_label"), d.get("price_note"),
                     1 if re.search(r"\bTotal\b", notes) else 0, c[0], c[1], y, sort_key(y, d.get("date"))))
    db.executemany("INSERT OR REPLACE INTO acquisitions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def load_multimedia(src, db, used):
    q = src.q
    M = "?m a skkg:Multimedia ."
    mm = {m: {"label": lab} for m, lab in q("multimedia", f"SELECT ?m ?l WHERE {{ {M} ?m skos:prefLabel ?l }}")}
    for m in [m for (m,) in q("multimedia", f"SELECT ?m WHERE {{ {M} }}")]:
        mm.setdefault(m, {})
    for m, v in q("multimedia", f"""SELECT ?m ?v WHERE {{ {M} ?m crm:P1_is_identified_by ?n .
        ?n crm:P190_has_symbolic_content ?v FILTER(STRENDS(STR(?n), '/name')) }}"""):
        mm[m]["name"] = v
    for m, t in q("multimedia", f"SELECT ?m ?t WHERE {{ {M} ?m crm:P2_has_type ?t FILTER(STRSTARTS(STR(?t), 'https://data.skkg.ch/')) }}"):
        slot = {"20060": "usage", "23089": "type", "43088": "category"}.get(scheme_of(t))
        if slot:
            mm[m][slot] = t
            used.add(t)
    for m, u, w, h, pg in q("multimedia", f"""SELECT ?m ?u ?w ?h ?pg WHERE {{ {M} ?m la:digitally_shown_by ?d .
        ?d la:digitally_available_via ?i . ?i la:access_point ?u .
        OPTIONAL {{ ?d crm:P43_has_dimension ?wd . ?wd crm:P2_has_type aat:300055647 ; crm:P90_has_value ?w }}
        OPTIONAL {{ ?d crm:P43_has_dimension ?hd . ?hd crm:P2_has_type aat:300055644 ; crm:P90_has_value ?h }}
        OPTIONAL {{ ?d crm:P1_is_identified_by ?pn . ?pn crm:P190_has_symbolic_content ?pg }} }}"""):
        mm[m].update(iiif=u, width=integer(w), height=integer(h), page=pg)
    for m, r, t, note, holder in q("multimedia", f"""SELECT ?m ?r ?t ?n ?h WHERE {{ {M} ?m crm:P104_is_subject_to ?r .
        ?r crm:P2_has_type ?t . OPTIONAL {{ ?r crm:P3_has_note ?n }} OPTIONAL {{ ?r crm:P75i_is_possessed_by ?h }} }}"""):
        mm[m].update(license=t, rights_note=note, holder=holder)
        used.add(t)
    for m, end in q("multimedia", f"""SELECT ?m ?e WHERE {{ ?s aaao:ZP64_has_property_right_subject ?m ;
        crm:P4_has_time-span ?p . ?p crm:P82b_end_of_the_end ?e . {M} }}"""):
        mm[m]["end"] = end
    for m, v in q("multimedia", f"""SELECT ?m ?v WHERE {{ {M} ?m crm:P104_is_subject_to ?r .
        ?r crm:P67i_is_referred_to_by ?s . ?s crm:P190_has_symbolic_content ?v }}"""):
        mm[m]["credit"] = v
    for m, h in q("multimedia", f"""SELECT ?m ?h WHERE {{ {M} ?m crm:P104_is_subject_to ?r .
        ?r crm:P75i_is_possessed_by ?h FILTER(STRENDS(STR(?r), '/original')) }}"""):
        mm[m]["original_holder"] = h
    for m, p, d0, d1 in q("multimedia", f"""SELECT ?m ?p ?d0 ?d1 WHERE {{ {M} ?m crm:P94i_was_created_by ?c .
        OPTIONAL {{ ?c crm:P14_carried_out_by ?p }}
        OPTIONAL {{ ?c crm:P9_consists_of/crm:P4_has_time-span/crm:P82_at_some_time_within ?d0 }}
        OPTIONAL {{ ?c crm:P4_has_time-span/crm:P82_at_some_time_within ?d1 }} }}"""):
        mm[m].update(photographer=p, photo_date=d0 or d1)
    for (m,) in q("multimedia", f"SELECT ?m WHERE {{ {M} ?m crm:P67i_is_referred_to_by <https://data.skkg.ch/statement/notfound> }}"):
        mm[m]["not_found"] = 1
    rows = [(m, d.get("label"), d.get("name"), d.get("usage"), d.get("type"), d.get("category"), d.get("iiif"),
             d.get("width"), d.get("height"), d.get("page"), d.get("license"),
             d.get("holder"), d.get("end"),
             d.get("rights_note"), d.get("credit"), d.get("original_holder"), d.get("photographer"),
             d.get("photo_date"), d.get("not_found", 0)) for m, d in mm.items()]
    db.executemany("INSERT INTO multimedia VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def load_provenance(src, db, used):
    q = src.q
    P = "?p a skkg:Provenance ."
    pv = {p: {"label": lab} for p, lab in q("provenance", f"SELECT ?p ?l WHERE {{ {P} ?p rdfs:label ?l }}")}
    for p, v in q("provenance", f"""SELECT ?p ?v WHERE {{ {P} ?p crm:P67i_is_referred_to_by ?s .
        ?s crm:P190_has_symbolic_content ?v }}"""):
        pv[p]["statement"] = v
    for p, v in q("provenance", f"""SELECT ?p ?v WHERE {{ {P} ?p crm:P1_is_identified_by ?i .
        ?i crm:P2_has_type <https://data.skkg.ch/type/invnrprov> ; crm:P190_has_symbolic_content ?v }}"""):
        pv[p]["inv"] = v
    for p, t in q("provenance", f"SELECT ?p ?t WHERE {{ {P} ?p crm:P2_has_type ?t FILTER(STRSTARTS(STR(?t), 'https://data.skkg.ch/')) }}"):
        slot = {"54158": "certainty", "54159": "holding"}.get(scheme_of(t))
        if slot:
            pv[p][slot] = t
            used.add(t)
    for p, lab, a, b, note in q("provenance", f"""SELECT ?p ?l ?a ?b ?n WHERE {{ {P} ?p crm:P4_has_time-span ?ts .
        OPTIONAL {{ ?ts rdfs:label ?l FILTER(LANG(?l) = 'de') }} OPTIONAL {{ ?ts crm:P82a_begin_of_the_begin ?a }}
        OPTIONAL {{ ?ts crm:P82b_end_of_the_end ?b }} OPTIONAL {{ ?ts crm:P3_has_note ?n }} }}"""):
        pv[p].update(date_label=lab, date_from=a, date_to=b, date_note=note)
    for p, sub, t, a, b in q("provenance", f"""SELECT ?p ?s ?t ?a ?b WHERE {{ {P} ?p crm:P4_has_time-span ?ts .
        ?ts crm:P86i_contains ?s . OPTIONAL {{ ?s crm:P2_has_type ?t FILTER(CONTAINS(STR(?t), '/type/54165/')) }}
        OPTIONAL {{ ?s crm:P82a_begin_of_the_begin ?a }} OPTIONAL {{ ?s crm:P82b_end_of_the_end ?b }} }}"""):
        k = "begin" if sub.endswith("/begin") else "end"
        pv[p].update({f"{k}_q": t, f"{k}_from": a, f"{k}_to": b})
        used.add(t)
    for p, tr, lab, t in q("provenance", f"""SELECT ?p ?tr ?l ?t WHERE {{ {P} ?p crm:P9_consists_of ?tr .
        FILTER(STRENDS(STR(?tr), '/transaction')) OPTIONAL {{ ?tr rdfs:label ?l FILTER(LANG(?l) = 'en') }}
        OPTIONAL {{ ?tr crm:P2_has_type ?t }} }}"""):
        kind = {"acquisition": "acquisition", "transfer of custody": "custody", "activity": "activity"}.get(lab, lab)
        pv[p].update(kind=kind, ttype=t)
        used.add(t)
    for p, owner, ot in q("provenance", f"""SELECT ?p ?o ?ot WHERE {{ {P} ?p crm:P9_consists_of ?tr .
        ?tr crm:P11_had_participant ?ac . OPTIONAL {{ ?ac crm:P107_has_current_or_former_member ?o }}
        OPTIONAL {{ ?ac crm:P2_has_type ?ot }} }}"""):
        pv[p].update(owner=owner, owner_type=ot)
        used.add(ot)
    for p, v in q("provenance", f"""SELECT ?p ?v WHERE {{ {P} ?p crm:P7_took_place_at ?pl .
        ?pl crm:P1_is_identified_by ?n . ?n crm:P190_has_symbolic_content ?v }}"""):
        pv[p]["place"] = v
    for p, note, lab, val, cur in q("provenance", f"""SELECT ?p ?n ?l ?v ?c WHERE {{ {P} ?p crm:P9_consists_of ?pay .
        FILTER(CONTAINS(STR(?pay), '/payment/')) OPTIONAL {{ ?pay crm:P3_has_note ?n }}
        OPTIONAL {{ ?pay la:paid_amount ?pr . OPTIONAL {{ ?pr rdfs:label ?l }} OPTIONAL {{ ?pr crm:P90_has_value ?v }}
                   OPTIONAL {{ ?pr crm:P180_has_currency ?c }} }} }}"""):
        pv[p].update(price_note=note, price_label=lab, price=num(val), currency=cur)
        used.add(cur)
    for p, t in q("provenance", f"""SELECT ?p ?t WHERE {{ {P} ?p crm:P70i_is_documented_in ?m . ?m crm:P2_has_type ?t
        FILTER(STRENDS(STR(?m), '/meta')) }}"""):
        pv[p]["status"] = t
        used.add(t)
    rows = []
    for p, d in pv.items():
        notes = " ".join(x for x in (d.get("price_note"), d.get("price_label")) if x)
        rows.append((p, d.get("label"), d.get("statement"), d.get("inv"), d.get("certainty"), d.get("holding"),
                     d.get("date_label"), d.get("date_from"), d.get("date_to"), d.get("begin_q"), d.get("begin_from"),
                     d.get("begin_to"), d.get("end_q"), d.get("end_from"), d.get("end_to"), d.get("date_note"),
                     d.get("kind"), d.get("ttype"), d.get("owner"), d.get("owner_type"), d.get("place"),
                     d.get("price"), d.get("currency"), None,
                     d.get("price_label"), d.get("price_note"), 1 if re.search(r"\bTotal\b", notes) else 0,
                     d.get("status")))
    db.executemany("INSERT INTO provenance VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)", rows)
    po = q("provenance", f"""SELECT ?p ?o ?n WHERE {{ ?a crm:P140_assigned_attribute_to ?p ; crm:P16_used_specific_object ?o .
        {P} OPTIONAL {{ ?a crm:P141_assigned ?ord . ?ord crm:P190_has_symbolic_content ?n }} }}""")
    db.executemany("INSERT INTO provenance_objects VALUES (?,?,?)", [(p, o, integer(n)) for p, o, n in po])
    srcs = q("provenance", f"""SELECT ?p ?n ?t ?note ?u WHERE {{ ?s crm:P67_refers_to ?p . {P} FILTER(CONTAINS(STR(?s), '/source/'))
        OPTIONAL {{ ?s crm:P2_has_type ?t }} OPTIONAL {{ ?s crm:P3_has_note ?note }}
        OPTIONAL {{ ?s crm:P1_is_identified_by ?on . ?on crm:P190_has_symbolic_content ?n FILTER(STRENDS(STR(?on), '/order')) }}
        OPTIONAL {{ ?s crm:P1_is_identified_by ?ad . ?ad crm:P190_has_symbolic_content ?u FILTER(STRENDS(STR(?ad), '/address')) }} }}""")
    db.executemany("INSERT INTO provenance_sources VALUES (?,?,?,?,?)", [(p, integer(n), t, note, u) for p, n, t, note, u in srcs])
    used.update(r[2] for r in srcs)
    chars = defaultdict(lambda: [None, [], None])
    for p, c, n, t, note in q("provenance", f"""SELECT ?p ?c ?n ?t ?note WHERE {{ ?c crm:P15i_influenced ?p . {P}
        OPTIONAL {{ ?c crm:P1_is_identified_by/crm:P190_has_symbolic_content ?n }} OPTIONAL {{ ?c crm:P2_has_type ?t }}
        OPTIONAL {{ ?c crm:P3_has_note ?note }} }}"""):
        ch = chars[(p, c)]
        ch[0] = integer(n)
        if t and t not in ch[1]:
            ch[1].append(t)
            used.add(t)
        ch[2] = note
    db.executemany("INSERT INTO provenance_characteristics VALUES (?,?,?,?)",
                   [(p, ch[0], json.dumps(ch[1]), ch[2]) for (p, _), ch in chars.items()])
    return len(rows)


def load_literature(src, db, used):
    q = src.q
    L = "?l a skkg:Literature ."
    lit = {l: {"label": lab} for l, lab in q("literature", f"SELECT ?l ?v WHERE {{ {L} ?l skos:prefLabel ?v }}")}
    for l, i, v in q("literature", f"""SELECT ?l ?i ?v WHERE {{ {L} ?l crm:P1_is_identified_by ?i .
        ?i crm:P190_has_symbolic_content ?v }}"""):
        k = i.rsplit("/", 1)[-1]
        if k in ("title", "signature", "isbn"):
            lit[l][k] = v
        elif "/url/" in i:
            lit[l].setdefault("urls", []).append(v)
    for l, x, v in q("literature", f"""SELECT ?l ?x ?v WHERE {{ {L} ?l crm:P67i_is_referred_to_by ?x .
        ?x crm:P190_has_symbolic_content ?v }}"""):
        lit[l][x.rsplit("/", 1)[-1]] = v
    for l, v in q("literature", f"SELECT ?l ?v WHERE {{ {L} ?l crm:P43_has_dimension ?d . ?d crm:P90_has_value ?v }}"):
        lit[l]["pages"] = v
    for l, t in q("literature", f"SELECT ?l ?t WHERE {{ {L} ?l crm:P2_has_type ?t }}"):
        lit[l]["type"] = t
        used.add(t)
    for l, t in q("literature", f"SELECT ?l ?t WHERE {{ {L} ?l crm:P72_has_language ?t }}"):
        lit[l]["language"] = t
        used.add(t)
    for l, s, lab in q("literature", f"""SELECT ?l ?s ?n WHERE {{ {L} {{ ?l crm:P106i_forms_part_of ?s }} UNION {{ ?l crm:P165i_is_incorporated_in ?s }}
        ?s rdfs:label ?n }}"""):
        lit[l].update(series_id=s, series=lab)
    for l, d, a, b, pl in q("literature", f"""SELECT ?l ?d ?a ?b ?pl WHERE {{ {L} ?l frbroo:R24i_was_created_through ?pub .
        OPTIONAL {{ ?pub crm:P4_has_time-span ?ts . OPTIONAL {{ ?ts crm:P82_at_some_time_within ?d }}
                   OPTIONAL {{ ?ts crm:P82a_begin_of_the_begin ?a }} OPTIONAL {{ ?ts crm:P82b_end_of_the_end ?b }} }}
        OPTIONAL {{ ?pub crm:P7_took_place_at ?pl }} }}"""):
        lit[l].update(year_label=d, year_from=year(a) or year(d), year_to=year(b) or year(a) or year(d), place=pl)
        used.add(pl)
    actors = []
    for l, part, a, role in q("literature", f"""SELECT ?l ?part ?a ?r WHERE {{ {L} ?l frbroo:R24i_was_created_through ?pub .
        ?pub crm:P9_consists_of ?part . ?part crm:P14_carried_out_by ?a .
        OPTIONAL {{ ?part crm:P2_has_type ?r FILTER(STRSTARTS(STR(?r), 'https://data.skkg.ch/')) }} }}"""):
        kind = "editor" if part.endswith("/editing") else "publisher" if part.endswith("/publishing") else "author"
        actors.append((l, a, kind, role))
        used.add(role)
    # The dump does not order the authors; the publication's label names them in citation order.
    names = dict(db.execute("SELECT id, label FROM actors"))
    by_part = defaultdict(list)
    for r in actors:
        by_part[r[0], r[2]].append(r)
    ordered, unmatched = [], 0
    for (l, _), rs in by_part.items():
        label = lit.get(l, {}).get("label") or ""
        found = [(label.find(names.get(r[1]) or "\0"), r) for r in rs]
        if len(rs) > 1:
            unmatched += sum(i < 0 for i, _ in found)
        found.sort(key=lambda x: (x[0] < 0, x[0], x[1][1]))
        ordered += [(*r, seq) for seq, (_, r) in enumerate(found)]
    db.executemany("INSERT INTO literature_actors VALUES (?,?,?,?,?)", ordered)
    rows = [(l, d.get("label"), d.get("title"), d.get("type"), d.get("signature"), d.get("isbn"), d.get("year_label"),
             d.get("year_from"), d.get("year_to"), d.get("place"), d.get("series"), d.get("series_id"), d.get("volume"),
             d.get("edition"), d.get("pages"), d.get("citation"), d.get("language"),
             json.dumps(d["urls"]) if d.get("urls") else None) for l, d in lit.items()]
    db.executemany("INSERT INTO literature VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    refs = {}
    for l, r in q("literature", f"SELECT ?l ?r WHERE {{ {L} ?l crm:P165_incorporates ?r }}"):
        refs[r] = {"l": l}
    for r, l in q("literature", f"SELECT ?r ?l WHERE {{ ?r crm:P165i_is_incorporated_in ?l . {L} }}"):
        refs.setdefault(r, {"l": l})
    for r, t in q("literature", "SELECT ?r ?t WHERE { ?l a skkg:Literature ; crm:P165_incorporates ?r . ?r crm:P67_refers_to ?t }"):
        if r in refs:
            refs[r]["provenance" if t.startswith("provenance/") else "object"] = t
    for r, t in q("literature", "SELECT ?r ?t WHERE { ?l a skkg:Literature ; crm:P165_incorporates ?r . ?r crm:P138_represents ?t }"):
        if r in refs:
            refs[r]["shows"] = 1
            refs[r].setdefault("object", t)
    for r, i, v in q("literature", """SELECT ?r ?i ?v WHERE { ?l a skkg:Literature ; crm:P165_incorporates ?r .
        ?r crm:P1_is_identified_by ?i . ?i crm:P190_has_symbolic_content ?v }"""):
        if r in refs:
            refs[r][{"image": "figure"}.get(i.rsplit("/", 1)[-1], i.rsplit("/", 1)[-1])] = v
    for r, v in q("literature", "SELECT ?r ?v WHERE { ?l a skkg:Literature ; crm:P165_incorporates ?r . ?r crm:P3_has_note ?v }"):
        if r in refs:
            refs[r]["note"] = v
    for r, v in q("literature", """SELECT ?r ?v WHERE { ?l a skkg:Literature ; crm:P165_incorporates ?r .
        ?r crm:P67i_is_referred_to_by ?c . ?c crm:P190_has_symbolic_content ?v }"""):
        if r in refs:
            refs[r]["citation"] = v
    # Provenance records cite literature references directly.
    for p, r in q("literature", "SELECT ?p ?r WHERE { ?p a skkg:Provenance ; crm:P70i_is_documented_in ?r }"):
        if r in refs:
            refs[r].setdefault("provenance", p)
    db.executemany("INSERT INTO literature_refs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                   [(d["l"], r, d.get("object"), d.get("provenance"), d.get("shows", 0), d.get("page"), d.get("figure"),
                     d.get("catalogue"), integer(d.get("sort")), d.get("note"), d.get("citation")) for r, d in refs.items()])
    links = q("literature", f"""SELECT ?l ?t ?r WHERE {{ {L} ?l crm:P01i_is_domain_of ?x . ?x crm:P02_has_range ?t .
        OPTIONAL {{ ?x crm:P67.1_has_type ?r }} }}""")
    seen = {(l, t) for l, t, _ in links}
    for l, t in q("literature", f"SELECT ?l ?t WHERE {{ {L} ?l crm:P67_refers_to ?t }}"):
        if (l, t) not in seen:
            links.append((l, t, None))
    db.executemany("INSERT INTO literature_links VALUES (?,?,?)", links)
    used.update(r[2] for r in links)
    return {"publications": len(rows), "authors_not_in_label": unmatched}


def load_exhibitions(src, db, used):
    q = src.q
    E = "?e a skkg:Exhibition ."
    ex = {e: {"label": lab} for e, lab in q("exhibition", f"SELECT ?e ?l WHERE {{ {E} ?e skos:prefLabel ?l }}")}
    for e, v in q("exhibition", f"SELECT ?e ?v WHERE {{ {E} ?e crm:P1_is_identified_by ?t . ?t crm:P190_has_symbolic_content ?v }}"):
        ex[e]["title"] = v
    for e, t in q("exhibition", f"SELECT ?e ?t WHERE {{ {E} ?e crm:P2_has_type ?t FILTER(STRSTARTS(STR(?t), 'https://data.skkg.ch/')) }}"):
        slot = {"21102": "type", "26126": "status", "43086": "ie"}.get(scheme_of(t))
        if slot:
            ex[e][slot] = t
            used.add(t)
    for e, a, b in q("exhibition", f"""SELECT ?e ?a ?b WHERE {{ {E} ?e crm:P4_has_time-span ?ts .
        OPTIONAL {{ ?ts crm:P82a_begin_of_the_begin ?a }} OPTIONAL {{ ?ts crm:P82b_end_of_the_end ?b }} }}"""):
        ex[e].update(a=a, b=b)
    venues = []
    for e, v in q("exhibition", f"SELECT ?e ?v WHERE {{ {E} ?e crm:P7_took_place_at ?v }}"):
        ex[e]["venue"] = v
        venues.append((e, v, "main", None, ex[e].get("a"), ex[e].get("b"), None))
    for e, v, t, a, b, note in q("exhibition", f"""SELECT ?e ?v ?t ?a ?b ?n WHERE {{ {E} ?e crm:P9_consists_of ?x .
        ?x crm:P7_took_place_at ?v . OPTIONAL {{ ?x crm:P2_has_type ?t }} OPTIONAL {{ ?x crm:P3_has_note ?n }}
        OPTIONAL {{ ?x crm:P4_has_time-span ?ts . OPTIONAL {{ ?ts crm:P82a_begin_of_the_begin ?a }}
                   OPTIONAL {{ ?ts crm:P82b_end_of_the_end ?b }} }} }}"""):
        venues.append((e, v, "other", t, a, b, note))
        used.add(t)
    db.executemany("INSERT INTO exhibition_venues VALUES (?,?,?,?,?,?,?)", venues)
    orgs = {}
    for e, a in q("exhibition", f"SELECT ?e ?a WHERE {{ {E} ?e crm:P14_carried_out_by ?a }}"):
        orgs[(e, a)] = [e, a, None, None]
    for e, a, r in q("exhibition", f"""SELECT ?e ?a ?r WHERE {{ {E} ?e crm:P01i_is_domain_of ?x . ?x crm:P02_has_range ?a .
        OPTIONAL {{ ?x crm:P14.1_in_the_role_of ?r }} }}"""):
        orgs.setdefault((e, a), [e, a, None, None])[2] = r
        used.add(r)
    for e, a, n in q("exhibition", f"""SELECT ?e ?a ?n WHERE {{ ?s crm:P16_used_specific_object ?e ; crm:P140_assigned_attribute_to ?a ;
        crm:P141_assigned ?o . ?o crm:P190_has_symbolic_content ?n . {E} }}"""):
        if (e, a) in orgs:
            orgs[(e, a)][3] = integer(n)
    db.executemany("INSERT INTO exhibition_organisers VALUES (?,?,?,?)", [tuple(v) for v in orgs.values()])
    db.executemany("INSERT INTO exhibition_objects VALUES (?,?)", q("exhibition", f"""SELECT DISTINCT ?e ?o WHERE {{ {E}
        ?e crm:P16_used_specific_object ?g . ?g la:has_member ?o . ?o a skkg:Object }}"""))
    db.executemany("INSERT INTO exhibition_multimedia VALUES (?,?)", q("exhibition", f"""SELECT DISTINCT ?e ?m WHERE {{ {E}
        {{ ?e crm:P138i_has_representation ?m }} UNION {{ ?e crm:P67i_is_referred_to_by ?m }} ?m a skkg:Multimedia }}"""))
    rows = [(e, d.get("label"), d.get("title"), d.get("type"), d.get("status"), d.get("ie"), d.get("a"), d.get("b"),
             d.get("venue")) for e, d in ex.items()]
    db.executemany("INSERT INTO exhibitions VALUES (?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def load_groups(src, db):
    q = src.q
    g = {x: [x, lab, None] for x, lab in q("objectgroup", "SELECT ?g ?l WHERE { ?g a skkg:ObjectGroup ; rdfs:label ?l }")}
    for x, v in q("objectgroup", """SELECT ?g ?v WHERE { ?g a skkg:ObjectGroup ; crm:P67i_is_referred_to_by ?d .
        ?d crm:P190_has_symbolic_content ?v }"""):
        g[x][2] = v
    db.executemany("INSERT INTO object_groups VALUES (?,?,?)", [tuple(v) for v in g.values()])
    db.executemany("INSERT INTO object_group_members VALUES (?,?)", q("objectgroup", """SELECT ?g ?o WHERE {
        ?g a skkg:ObjectGroup ; la:has_member ?o . ?o a skkg:Object }"""))
    return len(g)


# ---------------------------------------------------------------- derived data, FTS, checks

# Of the links to objects (the columns the DDL declares REFERENCES objects(id)), those whose rows
# are dropped when the object is not in the database, or the link is NULL: a period's chain is its
# objects. The links of the other columns to missing objects are counted and kept (notes/09).
DROPPED_LINKS = {("provenance_objects", "object_id")}


def object_links(db):
    """Every (table, column) that the DDL declares a link to objects."""
    tables = [t for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
    return [(t, fk[3]) for t in tables for fk in db.execute(f"PRAGMA foreign_key_list({t})") if fk[2] == "objects"]


# A period with one date (notes/11). The qualifier of the dated side either opens the other side
# (a begin "seit": held from that date on; an end "bis": held until then) or qualifies the date
# itself ("um", "vmtl.", "spätestens", "vor", "nach"), so the date is one event, e.g. an auction
# day. SKKG writes an unknown other side as the qualifier "o. D." with a bound of 9999-12-31 or
# 0001-01-01, which opens that side too. A qualifier in neither set, such as "frühestens ab"
# (used once, next to an "o. D." end), is left unclassified: the period is placed by its bound
# alone and counted in the build report, so a new or lone use is seen.
OPENS_OTHER_SIDE = {"from": {"seit", "mindestens seit"}, "to": {"bis", "spätestens bis"}}
DATE_QUALIFIERS = {"um", "ca.", "vmtl.", "wohl", "evtl.", "angeblich", "Anfang", "Mitte", "Ende",
                   "spätestens", "mindestens", "vor", "nach"}
UNKNOWN_SIDE = {None, "o. D."}
UNKNOWN_BOUND = {"from": "9999", "to": "0001"}


def period_span(date_from, date_to, begin_q, begin_from, end_q, end_to):
    """(year_first, year_last, kind, classified) of a period, with -9999 and 9999 for an open side.
    A date without a year, like no date, gives None and never matches a year filter. classified
    is False when the rule does not know a qualifier of the period or a date has no year; the
    build report counts those periods."""
    if date_from and date_to:
        first, last = year(date_from), year(date_to)
        if first is None or last is None:
            return None, None, "date without a year", False
        return first, last, "two dates", True
    if not date_from and not date_to:
        return None, None, "undated", True
    side, y, own, other, bound = (("from", year(date_from), begin_q, end_q, end_to) if date_from
                                  else ("to", year(date_to), end_q, begin_q, begin_from))
    if y is None:
        return None, None, "date without a year", False
    classified = (own is None or own in OPENS_OTHER_SIDE[side] | DATE_QUALIFIERS) and other in UNKNOWN_SIDE
    if own in OPENS_OTHER_SIDE[side] or (bound or "").startswith(UNKNOWN_BOUND[side]):
        return (y, OPEN_YEAR, "open end", classified) if side == "from" else (-OPEN_YEAR, y, "open start", classified)
    return y, y, "event", classified


def period_years(db):
    """Store each period's year span, which the year filter reads, and its sort keys, which the
    date sorts read: the earliest side with the date recorded for it, and the latest."""
    label = dict(db.execute("SELECT id, label FROM terms WHERE facet = 'date_qualifier'"))
    kinds, unclassified, rows = Counter(), Counter(), []
    for pid, df, dt, bq, bf, eq, et in db.execute(
            "SELECT id, date_from, date_to, begin_qualifier_id, begin_from, end_qualifier_id, end_to FROM provenance").fetchall():
        first, last, kind, classified = period_span(df, dt, label.get(bq), bf, label.get(eq), et)
        kinds[kind] += 1
        if not classified:
            unclassified[f"{label.get(bq) or '-'} / {label.get(eq) or '-'} ({kind})"] += 1
        rows.append((first, last, sort_key(first, df or dt), sort_key(last, dt or df), pid))
    db.executemany("UPDATE provenance SET year_first = ?, year_last = ?, sort_first = ?, sort_last = ? WHERE id = ?", rows)
    return {"kinds": dict(sorted(kinds.items())), "unclassified": dict(sorted(unclassified.items()))}


def derive(db):
    missing = {}
    links = object_links(db)
    assert DROPPED_LINKS <= set(links), DROPPED_LINKS - set(links)
    for table, col in links:
        where = f"{col} NOT IN (SELECT id FROM objects)"
        if (table, col) in DROPPED_LINKS:
            where = f"({col} IS NULL OR {where})"
        missing[f"{table}.{col}"] = db.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}").fetchone()[0]
        if (table, col) in DROPPED_LINKS:
            db.execute(f"DELETE FROM {table} WHERE {where}")
    spans = period_years(db)
    db.executescript("""
    UPDATE objects SET image_count = (SELECT COUNT(*) FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
        WHERE om.object_id = objects.id AND m.iiif_service IS NOT NULL);
    UPDATE objects SET primary_multimedia_id = COALESCE(
        (SELECT om.multimedia_id FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
         WHERE om.object_id = objects.id AND om.is_primary = 1 AND m.iiif_service IS NOT NULL LIMIT 1),
        (SELECT om.multimedia_id FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
         WHERE om.object_id = objects.id AND m.iiif_service IS NOT NULL ORDER BY om.seq IS NULL, om.seq LIMIT 1));
    UPDATE objects SET has_image = primary_multimedia_id IS NOT NULL,
        image_license_id = (SELECT license_id FROM multimedia WHERE id = objects.primary_multimedia_id);
    UPDATE objects SET has_provenance_chain = EXISTS (SELECT 1 FROM provenance_objects po WHERE po.object_id = objects.id);
    """)
    count_terms(db)
    return {"object_links_to_missing": missing, "period_years": spans}


# Every (term, record) link, by the kind of record, for the counts of skkg_find_terms. Object
# links include those through multimedia, and every period link also counts the period's objects
# (the INSERT below), so no provenance column can lack its object rows. A term absent here is
# unused. A photo licence counts the objects whose primary photo has it, as the image_license
# filter does.
TERM_USES = """
CREATE TEMP TABLE term_uses AS
    SELECT term_id, 'objects' AS kind, object_id AS rid FROM object_terms
    UNION ALL SELECT role_id, 'objects', object_id FROM object_creators
    UNION ALL SELECT attribution_id, 'objects', object_id FROM object_creators
    UNION ALL SELECT type_id, 'objects', object_id FROM acquisitions
    UNION ALL SELECT currency_id, 'objects', object_id FROM acquisitions
    UNION ALL SELECT basis_id, 'objects', object_id FROM object_dates
    UNION ALL SELECT prefix_id, 'objects', object_id FROM object_dates
    UNION ALL SELECT suffix_id, 'objects', object_id FROM object_dates
    UNION ALL SELECT epoch_id, 'objects', object_id FROM object_dates
    UNION ALL SELECT type_id, 'objects', object_id FROM object_relations
    UNION ALL SELECT type_id, 'objects', object_id FROM object_titles
    UNION ALL SELECT language_id, 'objects', object_id FROM object_titles
    UNION ALL SELECT type_id, 'objects', object_id FROM object_texts
    UNION ALL SELECT type_id, 'objects', object_id FROM object_identifiers
    UNION ALL SELECT type_id, 'objects', object_id FROM object_links
    UNION ALL SELECT type_id, 'objects', object_id FROM object_parts
    UNION ALL SELECT unit_id, 'objects', object_id FROM object_dimensions
    UNION ALL SELECT j.value, 'objects', i.object_id FROM object_inscriptions i, json_each(i.type_ids) j
    UNION ALL SELECT image_license_id, 'objects', id FROM objects
    UNION ALL SELECT m.usage_id, 'objects', om.object_id FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
    UNION ALL SELECT m.type_id, 'objects', om.object_id FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
    UNION ALL SELECT m.category_id, 'objects', om.object_id FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
    UNION ALL SELECT gender_id, 'persons', id FROM actors
    UNION ALL SELECT birth_place_id, 'persons', id FROM actors
    UNION ALL SELECT death_place_id, 'persons', id FROM actors
    UNION ALL SELECT country_id, 'persons (nationality)', actor_id FROM actor_nationalities
    UNION ALL SELECT type_id, 'persons', actor_id FROM actor_names
    UNION ALL SELECT type_id, 'persons', actor_id FROM actor_events
    UNION ALL SELECT place_id, 'persons', actor_id FROM actor_events
    UNION ALL SELECT type_id, 'persons', actor_id FROM actor_links
    UNION ALL SELECT type_id, 'persons', subject_id FROM actor_relations
    UNION ALL SELECT type_id, 'literature', id FROM literature
    UNION ALL SELECT place_id, 'literature', id FROM literature
    UNION ALL SELECT language_id, 'literature', id FROM literature
    UNION ALL SELECT role_id, 'literature', literature_id FROM literature_actors
    UNION ALL SELECT role_id, 'literature', literature_id FROM literature_links
    UNION ALL SELECT exhibition_type_id, 'exhibitions', id FROM exhibitions
    UNION ALL SELECT status_id, 'exhibitions', id FROM exhibitions
    UNION ALL SELECT internal_external_id, 'exhibitions', id FROM exhibitions
    UNION ALL SELECT type_id, 'exhibitions', exhibition_id FROM exhibition_venues
    UNION ALL SELECT role_id, 'exhibitions', exhibition_id FROM exhibition_organisers
    UNION ALL SELECT certainty_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT holding_kind_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT transaction_type_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT owner_type_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT currency_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT begin_qualifier_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT end_qualifier_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT status_id, 'provenance periods', id FROM provenance
    UNION ALL SELECT type_id, 'provenance periods', provenance_id FROM provenance_sources
    UNION ALL SELECT j.value, 'provenance periods', c.provenance_id FROM provenance_characteristics c, json_each(c.type_ids) j
    UNION ALL SELECT country_id, 'addresses', id FROM addresses
    UNION ALL SELECT type_id, 'addresses', id FROM addresses
    UNION ALL SELECT usage_id, 'images', id FROM multimedia
    UNION ALL SELECT type_id, 'images', id FROM multimedia
    UNION ALL SELECT category_id, 'images', id FROM multimedia
    UNION ALL SELECT license_id, 'images', id FROM multimedia;
INSERT INTO term_uses SELECT u.term_id, 'objects', po.object_id FROM term_uses u
    JOIN provenance_objects po ON po.provenance_id = u.rid WHERE u.kind = 'provenance periods';
DELETE FROM term_uses WHERE term_id IS NULL OR term_id NOT IN (SELECT id FROM terms);
CREATE INDEX temp.ix_tu ON term_uses(term_id, kind);
"""


def count_terms(db):
    """Store each term's counts and rank key, so that skkg_find_terms reads them instead of
    counting at runtime. object_count is NULL for facets of other records (RECORD_ONLY); the
    record count is that of the facet's kind (RECORD_KIND), or for SKKG's unnamed schemes the
    kind of record that uses the term most."""
    db.executescript(TERM_USES)
    objects = dict(db.execute("SELECT term_id, COUNT(DISTINCT rid) FROM term_uses WHERE kind = 'objects' GROUP BY term_id"))
    # A term's subtree counts each object once, as a filter with include_narrower matches it.
    subtree = dict(db.execute("""SELECT a.ancestor_id, COUNT(DISTINCT u.rid) FROM term_ancestors a
        JOIN term_uses u ON u.term_id = a.term_id AND u.kind = 'objects' GROUP BY a.ancestor_id"""))
    records = defaultdict(dict)
    for t, kind, n in db.execute("SELECT term_id, kind, COUNT(DISTINCT rid) FROM term_uses WHERE kind != 'objects' GROUP BY term_id, kind"):
        records[t][kind] = n
    narrower = dict(db.execute("SELECT broader_id, COUNT(*) FROM terms WHERE broader_id IS NOT NULL GROUP BY broader_id"))
    rows = []
    for t, facet in db.execute("SELECT id, facet FROM terms").fetchall():
        if facet in RECORD_KIND:
            kind = RECORD_KIND[facet]
        elif facet is None and records.get(t):
            kind = min(records[t], key=lambda k: (-records[t][k], k))
        else:
            kind = None
        rec = records.get(t, {}).get(kind, 0) if kind else None
        if facet in RECORD_ONLY:
            obj = with_narrower = None
            rank = rec
        else:
            obj, with_narrower = objects.get(t, 0), subtree.get(t, 0)
            # Object vocabularies rank by objects, never by provenance periods; an unnamed
            # scheme's term that no object uses ranks by its records.
            if with_narrower or facet is not None:
                rank = with_narrower
            else:
                rank = rec or 0
        rows.append((obj, with_narrower, narrower.get(t, 0), rec, kind, rank, t))
    db.executemany("""UPDATE terms SET object_count = ?, object_count_with_narrower = ?, narrower_count = ?,
        record_count = ?, record_kind = ?, use_rank = ? WHERE id = ?""", rows)
    db.execute("DROP TABLE term_uses")


def fts_rows(db):
    """The rows of each FTS table, projected from the base tables. The privacy checks require the
    FTS tables to hold exactly these rows, so they carry nothing the base tables do not."""
    def lists(sql):
        out = defaultdict(list)
        for k, *vs in db.execute(sql).fetchall():
            out[k].extend(vs)
        return out
    titles = lists("SELECT object_id, title FROM object_titles ORDER BY seq IS NULL, seq, rowid")
    inscriptions = lists("SELECT object_id, text, translation FROM object_inscriptions ORDER BY rowid")
    texts = lists("SELECT object_id, title, text FROM object_texts ORDER BY rowid")
    idents = lists("SELECT object_id, value FROM object_identifiers ORDER BY rowid")
    objects = [(o, fts_text(*titles.get(o, [])), fts_text(lab), fts_text(*inscriptions.get(o, [])),
                fts_text(*texts.get(o, []), mat, ed), " ".join(x for x in [inv, *idents.get(o, [])] if x is not None))
               for o, inv, lab, mat, ed in db.execute(
                   "SELECT id, inventory_number, label, material_statement, edition FROM objects ORDER BY rowid").fetchall()]
    actors = [(a, fts_text(*names)) for a, names in _group(db.execute("""
        SELECT id, label FROM actors UNION ALL SELECT id, name FROM actors WHERE name IS NOT NULL
        UNION ALL SELECT id, corporate_name FROM actors WHERE corporate_name IS NOT NULL
        UNION ALL SELECT actor_id, name FROM actor_names""")).items()]
    authors = _group(db.execute("SELECT la.literature_id, a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id"))
    literature = [(l, fts_text(t, lab), fts_text(*authors.get(l, [])), fts_text(s))
                  for l, t, lab, s in db.execute("SELECT id, title, label, series FROM literature").fetchall()]
    venues = _group(db.execute("""SELECT ev.exhibition_id, ad.label FROM exhibition_venues ev
        JOIN addresses ad ON ad.id = ev.address_id"""))
    exhibitions = [(e, fts_text(t, lab), fts_text(*venues.get(e, [])))
                   for e, t, lab in db.execute("SELECT id, title, label FROM exhibitions").fetchall()]
    terms = [(t, fts_text(*labs)) for t, labs in _group(db.execute("SELECT term_id, label FROM term_labels")).items()]
    return {"objects_fts": objects, "actors_fts": actors, "literature_fts": literature,
            "exhibitions_fts": exhibitions, "terms_fts": terms}


def build_fts(db):
    for table, rows in fts_rows(db).items():
        if rows:
            db.executemany(f"INSERT INTO {table} VALUES ({','.join('?' * len(rows[0]))})", rows)


def _group(cursor):
    out = defaultdict(list)
    for k, v in cursor.fetchall():
        if v and v not in out[k]:
            out[k].append(v)
    return out


# ---------------------------------------------------------------- private names in text

REDACTED = "Privatperson"
# Fields the website does not show, where a protected name is replaced (notes/09).
REDACT_FIELDS = (("object_identifiers", "value"), ("object_conditions", "note"), ("object_relations", "label"),
                 ("terms", "label"), ("terms", "label_de"), ("terms", "label_en"), ("terms", "label_fr"),
                 ("term_labels", "label"))
# Fields the website shows whole, names included, so they keep them (notes/09). A protected name
# anywhere else fails the build, so a field that starts to carry one gets a decision first.
NAMES_SHOWN = {("acquisitions", "note"), ("object_dates", "note"), ("exhibitions", "label"), ("exhibitions", "title")}


WORD = re.compile(r"\w+")


def _nfc(s):
    return unicodedata.normalize("NFC", s)


def _name_key(s):
    return " ".join(w for w in re.split(r"[\s,]+", _nfc(s).casefold()) if w)


def _name_pattern(form):
    """'Given Surname' or 'Surname, Given' with any spacing, "ß" also written "ss"."""
    word = lambda w: re.sub("ß|ss", "(?:ß|ss)", re.escape(w))
    return r"\s*,\s*".join(r"\s+".join(map(word, part.split())) for part in form.split(","))


class Names:
    """Full names of private persons, found in any case, Unicode form and spacing. A match inside
    the person's own organisation is allowed, as it is in the address label."""

    def __init__(self, persons):
        """persons: {address id: (name forms, organisation or None)}."""
        self.count = len(persons)
        self.owners, self.orgs = defaultdict(set), {}
        forms = set()
        for a, (fs, org) in persons.items():
            self.orgs[a] = org
            for f in fs:
                self.owners[_name_key(f)].add(a)
                forms.add(_nfc(f))
        alt = lambda fs: r"(?<!\w)(?:" + "|".join(sorted(map(_name_pattern, fs), key=len, reverse=True)) + r")(?!\w)"
        # A match contains every word of its form, so a text without any of these words has none.
        self.words = {w for f in forms for w in re.findall(r"\w+", f.casefold())}
        # The folded pattern finds what the case-insensitive one misses, e.g. "ß" written "ss".
        self.fold_rx = re.compile(alt({f.casefold() for f in forms})) if forms else None
        self.case_rx = re.compile(alt(forms), re.IGNORECASE) if forms else None

    def spans(self, text, fold):
        """The text in NFC (casefolded with fold) and the spans of protected names in it."""
        v = _nfc(text)
        v = v.casefold() if fold else v
        rx = self.fold_rx if fold else self.case_rx
        if not rx:
            return v, []
        return v, [m.span() for m in rx.finditer(v)
                   if not any(self._in_org(v, m.span(), a, fold) for a in self.owners[_name_key(m.group())])]

    def _in_org(self, v, span, a, fold):
        org = self.orgs.get(a)
        if not org:
            return False
        org = _nfc(org).casefold() if fold else _nfc(org)
        return any(m.start() <= span[0] and span[1] <= m.end()
                   for m in re.finditer(re.escape(org), v, 0 if fold else re.IGNORECASE))

    def found(self, text):
        return not self.words.isdisjoint(WORD.findall(_nfc(text).casefold())) and bool(self.spans(text, fold=True)[1])

    def redact(self, text):
        v, spans = self.spans(text, fold=False)
        if not spans:
            return text
        for s, e in reversed(spans):
            v = v[:s] + REDACTED + v[e:]
        return v


def protected_names(src):
    """Full names of private address persons that no SKKG person record carries (notes/09), with
    each person's organisation. Read only to find the names in text; they are never written."""
    q = lambda query: src.q("address", query)
    parts = defaultdict(lambda: defaultdict(list))
    for a, t, v in q(f"""SELECT ?a ?t ?v WHERE {{ ?a a skkg:Address ; crm:P1_is_identified_by ?n .
        ?n crm:P106_is_composed_of ?p . ?p crm:P2_has_type ?t ; crm:P190_has_symbolic_content ?v
        VALUES ?t {{ <{AAT_GIVEN}> <{AAT_SURNAME}> <{AAT_ORG}> }} }}"""):
        parts[a][t].append(v)
    for a, v in q("""SELECT ?a ?v WHERE { ?a a skkg:Address ; crm:P1_is_identified_by ?n .
        FILTER(CONTAINS(STR(?n), '/altname/')) ?n rdfs:label ?v }"""):
        parts[a]["alt"].append(v)
    # Names of person records: labels, names, alternative names, GND names. One query per branch,
    # as a UNION inside a join is very slow on Oxigraph.
    public = []
    actor = "?a a ?c VALUES ?c { crm:E21_Person crm:E39_Actor crm:E74_Group skkg:Actor }"
    for pattern in ("?a rdfs:label ?v", "?a skos:prefLabel ?v", "?a crm:P1_is_identified_by ?n . ?n crm:P190_has_symbolic_content ?v",
                    "?a crmdig:L54_is_same-as ?g . ?g gndo:preferredName ?v", "?a crmdig:L54_is_same-as ?g . ?g gndo:variantName ?v"):
        public += [v for a, v in src.q("person", f"SELECT ?a ?v WHERE {{ {actor} {pattern} }}")
                   if a.startswith(("person/", "actor/")) and a != ANON_ACTOR]
    public = "\n".join(_name_key(v) for v in public)
    is_public = lambda f: re.search(rf"(?<!\w){re.escape(_name_key(f))}(?!\w)", public)
    out = {}
    for a, p in parts.items():
        forms = list(p["alt"])
        for g in p[AAT_GIVEN]:
            for s in p[AAT_SURNAME]:
                forms += [f"{g} {s}", f"{s}, {g}", f"{s} {g}"]
        if forms and not any(map(is_public, forms)):
            out[a] = (forms, min(p[AAT_ORG]) if p[AAT_ORG] else None)
    return out


def redact_names(src, db):
    """Replace protected names in REDACT_FIELDS; returns the rows changed per field."""
    names = Names(protected_names(src))
    out = {}
    for table, col in REDACT_FIELDS:
        rows = [(new, rid) for rid, v in db.execute(f"SELECT rowid, {col} FROM {table} WHERE {col} IS NOT NULL").fetchall()
                if (new := names.redact(v)) != v]
        db.executemany(f"UPDATE {table} SET {col} = ? WHERE rowid = ?", rows)
        if rows:
            out[f"{table}.{col}"] = len(rows)
    return out


# ---------------------------------------------------------------- privacy checks

def privacy_expectations(src):
    """What the privacy checks compare the database with, read from the store by queries of their
    own, so that a loader bug does not blind the check that should catch it."""
    q = lambda query: src.q("check", query)
    pref, org, place, region = (defaultdict(set) for _ in range(4))
    for a, v in q("SELECT ?a ?v WHERE { ?a a skkg:Address ; skos:prefLabel ?v FILTER(LANG(?v) = '' || LANG(?v) = 'de') }"):
        pref[a].add(v)
    for a, v in q(f"""SELECT ?a ?v WHERE {{ ?a a skkg:Address ; crm:P1_is_identified_by ?n . ?n crm:P106_is_composed_of ?p .
        ?p crm:P2_has_type <{AAT_ORG}> ; crm:P190_has_symbolic_content ?v }}"""):
        org[a].add(v)
    for a, p, v in q("""SELECT ?a ?p ?v WHERE { ?a a skkg:Address ; crm:P76_has_contact_point ?c .
        ?c crm:P106_is_composed_of ?p . ?p crm:P190_has_symbolic_content ?v }"""):
        {"place": place, "region": region}.get(p.rsplit("/", 1)[-1], {}).setdefault(a, set()).add(v)
    # Private: any name part that is not an organisation, or any identifier besides the name
    # (an alternative name). Broader than the loader's test on purpose: a new kind of part fails.
    private = {a for (a,) in q(f"""SELECT DISTINCT ?a WHERE {{ ?a a skkg:Address ; crm:P1_is_identified_by ?n .
        ?n crm:P106_is_composed_of ?p . FILTER NOT EXISTS {{ ?p crm:P2_has_type <{AAT_ORG}> }} }}""")}
    private |= {a for a, n in q("SELECT ?a ?n WHERE { ?a a skkg:Address ; crm:P1_is_identified_by ?n }")
                if not n.endswith(("/name", "/order"))}
    private.add(ANON_ADDRESS)
    anon = {ANON_ACTOR}
    for pred in ("rdfs:label", "skos:prefLabel"):
        anon |= {a for a, v in q(f"""SELECT ?a ?v WHERE {{ ?a a ?c VALUES ?c {{ crm:E21_Person crm:E39_Actor crm:E74_Group skkg:Actor }}
            ?a {pred} ?v }}""") if is_anonymisation(v)}
    owners = {(p, o) for p, o in q("""SELECT ?p ?o WHERE { ?p a skkg:Provenance ; crm:P9_consists_of ?tr .
        ?tr crm:P11_had_participant ?ac . ?ac crm:P107_has_current_or_former_member ?o }""") if o in anon}
    sources = {(o, s) for o, s in q("""SELECT ?o ?s WHERE { ?o a skkg:Object ; crm:P24i_changed_ownership_through ?a .
        ?a a crm:E8_Acquisition ; crm:P23_transferred_title_from ?s }""") if s in anon}
    return {"pref": pref, "org": org, "place": place, "region": region, "private": private & pref.keys(),
            "anon": anon, "owners": owners, "sources": sources, "names": Names(protected_names(src))}


def _schema(conn):
    return {t: [r[1] for r in conn.execute(f'PRAGMA table_info("{t.replace(chr(34), chr(34) * 2)}")')]
            for (t,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")}


def privacy_checks(db, exp):
    """Return a list of (check, ok, detail). The build fails when any check is not ok."""
    out = []
    ref = sqlite3.connect(":memory:")
    ref.executescript(DDL + FTS)
    schema, want = _schema(db), _schema(ref)
    diff = sorted(t for t in schema.keys() | want.keys() if schema.get(t) != want.get(t))
    out.append(("the tables and their columns are exactly those of the schema", not diff, ", ".join(diff)))

    ids = {a for (a,) in db.execute("SELECT id FROM addresses")}
    flagged = {a for (a,) in db.execute("SELECT id FROM addresses WHERE is_private_person = 1")}
    store, private = set(exp["pref"]), exp["private"]
    out.append(("the private addresses are exactly those with personal name parts in the store",
                flagged == private and ids == store,
                f"{len(private)} private; {len(flagged - private)} flagged but not private, {len(private - flagged)} "
                f"private but not flagged, {len(ids - store)} ids not in the store, {len(store - ids)} store ids missing"))
    bad_private = bad_other = 0
    for a, label, o, pl, rg, lat, lon, url in db.execute(
            "SELECT id, label, organisation, place, region, latitude, longitude, website FROM addresses"):
        same = all(v in exp[k][a] if exp[k].get(a) else v is None for k, v in (("org", o), ("place", pl), ("region", rg)))
        if a in private:
            bad_private += not (same and lat is None and lon is None and url is None
                                and label == ", ".join(x for x in (o or "Privatperson", pl) if x))
        else:
            bad_other += not (same and label in exp["pref"].get(a, ()))
    out.append(("every private address shows only {organisation or Privatperson}, {place}, without coordinates or website",
                bad_private == 0, f"{bad_private} rows"))
    out.append(("every other address keeps SKKG's label, organisation and place", bad_other == 0, f"{bad_other} rows"))

    n = db.execute("""SELECT COUNT(*) FROM addresses WHERE id = ? AND label = 'Privatperson' AND is_private_person = 1
        AND COALESCE(organisation, place, region, latitude, longitude, website) IS NULL""", (ANON_ADDRESS,)).fetchone()[0]
    m = db.execute(f"""SELECT COUNT(*) FROM actors WHERE id = ? AND kind = 'anonymous' AND label = 'Privatperson'
        AND is_anonymous = 1 AND COALESCE(name, first_name, last_name, corporate_name, gender_id, birth_label, birth_place,
        death_label, death_place, biography) IS NULL""", (ANON_ACTOR,)).fetchone()[0]
    out.append((f"{ANON_ACTOR} and {ANON_ADDRESS} hold only \"Privatperson\"", n == 1 and m == 1, ""))

    actors = dict(db.execute("SELECT id, label FROM actors WHERE is_anonymous = 1"))
    unflagged = sum(is_anonymisation(lab) for (lab,) in db.execute("SELECT label FROM actors WHERE is_anonymous = 0"))
    relabelled = sum(a not in actors or (a != ANON_ACTOR and not is_anonymisation(actors[a])) for a in exp["anon"])
    anon = sorted(exp["anon"] | actors.keys())
    marks = ",".join("?" * len(anon))
    children = sum(db.execute(f"SELECT COUNT(*) FROM {t} WHERE {c} IN ({marks})", anon).fetchone()[0] for t, c in (
        ("actor_names", "actor_id"), ("actor_external", "actor_id"), ("actor_gnd", "actor_id"), ("actor_events", "actor_id"),
        ("actor_links", "actor_id"), ("actor_relations", "subject_id"), ("actor_relations", "target_id")))
    out.append(("every anonymised owner is flagged, keeps SKKG's placeholder label, and has no names, identifiers, events or relations",
                unflagged == relabelled == children == 0,
                f"{len(exp['anon'])} anonymised; {unflagged} unflagged, {relabelled} relabelled or missing, {children} child rows"))
    owners = {(p, o) for p, o in db.execute("SELECT id, owner_id FROM provenance") if o in exp["anon"]}
    sources = {(o, s) for o, s in db.execute("SELECT object_id, source_id FROM acquisitions") if s in exp["anon"]}
    out.append(("the anonymised owners keep their provenance periods and acquisitions",
                owners == exp["owners"] and sources == exp["sources"],
                f"{len(owners ^ exp['owners'])} period links and {len(sources ^ exp['sources'])} acquisition links differ"))

    names, hits = exp["names"], Counter()
    fts = set(re.findall(r"CREATE VIRTUAL TABLE (\w+)", FTS))
    for t, cols in schema.items():
        if t in fts or any(t.startswith(f + "_") for f in fts):
            continue
        for c in cols:
            if (t, c) in NAMES_SHOWN:
                continue
            q = f'SELECT "{c}", COUNT(*) FROM "{t}" WHERE typeof("{c}") = \'text\' GROUP BY 1'
            hits[f"{t}.{c}"] = sum(n for v, n in db.execute(q) if names.found(v))
    leaks = {k: n for k, n in hits.items() if n}
    out.append(("no protected name outside the fields the website shows", not leaks,
                f"{names.count} protected persons; " + (", ".join(f"{k} {n}" for k, n in sorted(leaks.items())) or "0 rows")))

    bad = []
    for table, rows in fts_rows(db).items():
        try:
            if Counter(rows) != Counter(db.execute(f"SELECT * FROM {table}").fetchall()):
                bad.append(table)
            db.execute(f"INSERT INTO {table}({table}) VALUES ('integrity-check')")
        except sqlite3.DatabaseError:
            bad.append(f"{table} unreadable or its index inconsistent")
    out.append(("every full-text table holds exactly its projection from the base tables", not bad, ", ".join(bad)))

    n = db.execute("""SELECT COUNT(*) FROM addresses WHERE website IS NOT NULL
        AND (website NOT LIKE 'http%' OR website LIKE 'https://data.skkg.ch/%' OR website LIKE 'http://data.skkg.ch/%')""").fetchone()[0]
    out.append(("every address website is an outside URL", n == 0, f"{n} rows"))
    n = db.execute("SELECT COUNT(*) FROM objects WHERE inventory_number IS NULL").fetchone()[0]
    out.append(("every object has an inventory number (no stubs)", n == 0, f"{n} rows"))
    return out


def unloaded_edges(src, census_path):
    """Census edges whose predicate no build query reads for that record type."""
    if not census_path:
        return []
    census = json.load(open(census_path))
    short = {"http://www.cidoc-crm.org/cidoc-crm/": "crm:", "http://www.w3.org/2000/01/rdf-schema#": "rdfs:",
             "http://www.w3.org/2004/02/skos/core#": "skos:", "https://linked.art/ns/terms/": "la:",
             "https://ontology.swissartresearch.net/aaao/": "aaao:", "http://www.ics.forth.gr/isl/CRMdig/": "crmdig:",
             "http://www.cidoc-crm.org/extensions/crmsci/": "crmsci:", "http://iflastandards.info/ns/fr/frbr/frbroo/": "frbroo:",
             "https://d-nb.info/standards/elementset/gnd#": "gndo:", "http://schema.org/": "schema:"}
    skip = {"rdf:type", "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"}
    agg = Counter()
    for e in census["edges"]:
        s = e["s"]
        if not s.startswith("skkg:"):
            continue
        root = s[5:].split("/", 1)[0]
        root = {"timespan": "object", "actor": "person", "publication": "literature"}.get(root, root)
        p = e["p"]
        for k, v in short.items():
            if p.startswith(k):
                p = v + p[len(k):]
        if p in skip or p in src.read.get(root, set()):
            continue
        if root == "person" and p in src.read.get("address", set()):
            continue
        agg[(root, s, p)] += e["subjects"]
    return [{"root": r, "shape": s, "predicate": p, "subjects": n} for (r, s, p), n in agg.most_common()]


def dump_info(headers_path, store_dir):
    info = {"store": str(store_dir)}
    if headers_path and Path(headers_path).exists():
        for line in Path(headers_path).read_text().splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                if k.lower() == "etag":
                    info["dump_etag"] = v.strip().strip('"')
                elif k.lower() == "last-modified":
                    info["dump_last_modified"] = v.strip()
                    info["data_as_of"] = parsedate_to_datetime(v.strip()).date().isoformat()
    if "data_as_of" not in info:
        m = re.search(r"(\d{4})(\d{2})(\d{2})", Path(store_dir).name)
        if m:
            info["data_as_of"] = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("store")
    ap.add_argument("out")
    ap.add_argument("--headers")
    ap.add_argument("--census")
    ap.add_argument("--previous")
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    start = time.time()
    src = Source(Store.read_only(args.store))
    db = sqlite3.connect(tmp)
    db.executescript("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;" + DDL + FTS)
    used = set()
    steps = []

    def step(name, fn, *a):
        t = time.time()
        r = fn(*a)
        steps.append((name, round(time.time() - t, 1), r))
        print(f"{name}: {r} ({time.time() - t:.1f} s)", flush=True)
        return r

    step("addresses", load_addresses, src, db, used)
    step("actors", load_actors, src, db, used)
    step("objects", load_objects, src, db, used)
    step("multimedia", load_multimedia, src, db, used)
    lit = step("literature", load_literature, src, db, used)
    step("exhibitions", load_exhibitions, src, db, used)
    step("object groups", load_groups, src, db)
    step("provenance", load_provenance, src, db, used)
    step("acquisitions", load_acquisitions, src, db, used)
    step("terms", load_terms, src, db, used)
    redacted = step("redaction", redact_names, src, db)
    odd_currencies = step("currency codes", set_currency_codes, db)
    # Indexes first: the derived columns are correlated subqueries over the link tables.
    step("indexes", lambda: db.executescript(INDEXES) and "ok")
    derived = step("derived columns", derive, db)
    step("fts", lambda: build_fts(db) or "ok")

    info = dump_info(args.headers, args.store)
    info.update(schema_version=str(SCHEMA_VERSION), built_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    db.executemany("INSERT INTO meta VALUES (?,?)", sorted(info.items()))

    checks = privacy_checks(db, privacy_expectations(src))
    # Acquisition dates after the dump are wrong, and a decade from 2100 on gets a filter that
    # the search schema refuses (acquisition_year_to has a maximum of 2100).
    future = [{"year": y, "acquisitions": n} for y, n in db.execute(
        "SELECT year, COUNT(*) FROM acquisitions WHERE date > ? GROUP BY year ORDER BY year",
        (info.get("data_as_of", "9999"),))]
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' ORDER BY name")]
    counts = {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
    drops = []
    if args.previous and Path(args.previous).exists():
        prev = sqlite3.connect(args.previous)
        for t, n in counts.items():
            try:
                p = prev.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except sqlite3.Error:
                continue
            if p and n < p * 0.95:
                drops.append({"table": t, "previous": p, "now": n})
    unknown_terms = db.execute("""SELECT COUNT(DISTINCT term_id) FROM object_terms WHERE term_id NOT IN (SELECT id FROM terms)""").fetchone()[0]
    edges = unloaded_edges(src, args.census)

    db.commit()
    db.execute("ANALYZE")
    db.commit()
    db.execute("VACUUM")
    db.close()

    ok = all(c[1] for c in checks)
    report = {"ok": ok, "meta": info, "seconds": round(time.time() - start), "steps": steps, "counts": counts,
              "privacy_checks": [{"check": c, "ok": k, "detail": d} for c, k, d in checks],
              "count_drops": drops, "object_terms_without_term": unknown_terms,
              "authors_not_in_label": lit["authors_not_in_label"], "redacted": redacted,
              "acquisitions_after_dump": future, "currency_labels_not_mapped": odd_currencies,
              "object_links_to_missing": derived["object_links_to_missing"], "period_years": derived["period_years"],
              "size_bytes": tmp.stat().st_size, "unloaded_edges": edges, "query_timings": src.timings}
    Path(str(out) + ".report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    Path(str(out) + ".report.md").write_text(render_report(report))
    if not ok:
        print("privacy checks failed; database not published:", [c for c in checks if not c[1]], file=sys.stderr)
        tmp.unlink()
        sys.exit(1)
    os.replace(tmp, out)
    print(f"wrote {out} ({tmp_size(out)}) in {time.time() - start:.0f} s; drops: {drops or 'none'}")


def tmp_size(p):
    return f"{Path(p).stat().st_size / 1e6:.0f} MB"


def render_report(r):
    lines = [f"# Build report", "", f"Built {r['meta'].get('built_at')} from `{r['meta'].get('store')}`, "
             f"data as of {r['meta'].get('data_as_of')}, schema version {r['meta'].get('schema_version')}, "
             f"{r['seconds']} s, {r['size_bytes'] / 1e6:.0f} MB.", "", "## Privacy checks", ""]
    lines += [f"- {'ok' if c['ok'] else 'FAILED'}: {c['check']} {c['detail']}".rstrip() for c in r["privacy_checks"]]
    lines += ["", "## Row counts", "", "| Table | Rows |", "|---|---:|"]
    lines += [f"| {t} | {n:,} |" for t, n in r["counts"].items()]
    lines += ["", "## Count drops over 5%", ""] + ([f"- {d['table']}: {d['previous']:,} → {d['now']:,}" for d in r["count_drops"]] or ["None, or no previous build."])
    lines += ["", f"Object terms without a term record: {r['object_terms_without_term']}.", "",
              f"Authors of publications with several authors whose name is not in the publication's label, "
              f"so their order is a guess: {r['authors_not_in_label']}.", "",
              "Rows whose protected names were replaced by \"Privatperson\": "
              + (", ".join(f"{k} {n}" for k, n in r["redacted"].items()) or "none") + ".", "",
              "Acquisition dates after the dump date (a year from 2100 on gets a filter the search schema refuses): "
              + (", ".join(f"{f['year']} ({f['acquisitions']})" for f in r["acquisitions_after_dump"]) or "none") + ".", "",
              "Currency labels that are neither an alias nor an ISO-like code, so their prices get a code of their own "
              "(label: prices): " + (", ".join(f"{k} ({n})" for k, n in r["currency_labels_not_mapped"].items()) or "none") + ".", "",
              "Links to objects not in the database, for every column the schema declares a link to objects "
              "(provenance_objects rows are dropped, with those of no object; the others are kept): "
              + ", ".join(f"{k} {n}" for k, n in r["object_links_to_missing"].items()) + ".", "",
              "Year spans of provenance periods: " + ", ".join(f"{k} {n}" for k, n in r["period_years"]["kinds"].items())
              + "; not classified by the rule, because it does not know a qualifier or a date has no year, so placed "
              "by their bounds alone (begin / end (placed as): periods): "
              + (", ".join(f"{k} ({n})" for k, n in r["period_years"]["unclassified"].items()) or "none") + ".", "",
              "## Census edges not read by the build", "",
              "Edges of the shape census whose predicate no build query reads for that record type. "
              "New fields in a later dump appear here.", "", "| Root | Shape | Predicate | Subjects |", "|---|---|---|---:|"]
    lines += [f"| {e['root']} | `{e['shape']}` | `{e['predicate']}` | {e['subjects']:,} |" for e in r["unloaded_edges"]]
    lines += ["", "## Slowest queries", "", "| Root | Seconds | Rows | Query |", "|---|---:|---:|---|"]
    lines += [f"| {a} | {s} | {n:,} | `{q}` |" for a, s, n, q in sorted(r["query_timings"], key=lambda x: -x[1])[:15]]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
