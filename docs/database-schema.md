# Schema of `skkg-20261028-public.sqlite`

This SQLite database holds the collection data of the Stiftung für Kunst, Kultur und Geschichte (SKKG), Winterthur, as SKKG published it in its RDF dump of 28 October 2026. It was built by `scripts/build_db.py` of [skkg-mcp](https://github.com/kintopp/skkg-mcp) (schema version 11). The MCP server reads it read-only.

- **File:** `skkg-20261028-public.sqlite`, 387 MB
- **SHA-256:** `c596dbfa0956e446215b467e7626eb25d9b4924abda158e077ae24283a8ec1e2`
- **Data as of:** 2026-10-28 (`meta.data_as_of`)

## What the database contains

The database holds the data that the skkg-mcp tools search and return. It keeps SKKG's anonymisation: private persons appear as "Privatperson" or "Unbekannte:r Eigentümer:in", with no name, gender or life data (`actors.is_anonymous = 1`), and the addresses of private persons have no coordinates or website (`addresses.is_private_person = 1`). Provenance chains, owner names and purchase prices are included, because SKKG publishes them.

## Conventions

- **Ids** are SKKG's record ids without the base `https://data.skkg.ch/`. For example, `object/2432` stands for `https://data.skkg.ch/object/2432`. The part after the slash is a number or a UUID, and both forms are separate records. An inventory number (`objects.inventory_number`, e.g. `GB-0171.1`) is not an id.
- **Id prefixes:**

  | Prefix | Record |
  |---|---|
  | `object/` | object |
  | `person/` | person or institution with an SKKG record |
  | `actor/` | actor known only by a label |
  | `address/` | address |
  | `multimedia/` | image or document file |
  | `literature/` | publication or citation |
  | `exhibition/` | exhibition |
  | `provenance/` | provenance period |
  | `objectgroup/` | object group |
  | `type/{scheme}/{n}` | vocabulary term |

- **Columns ending in `_id`** hold a vocabulary term id (`terms.id`) unless their name says otherwise, e.g. `owner_id` and `source_id` hold actors.
- **Columns ending in `_ids`, plus `terms.matches` and `literature.urls`,** hold JSON arrays. Read them with `json_each`.
- **`seq`** is the order SKKG gives within a list, starting at 1.
- **Years** are integers. Negative years are BC. `*_from` and `*_to` bound a range.
- **Dates** are text, usually `YYYY-MM-DD`. `*_label` is SKKG's own wording of a date, e.g. `17.05.1991`.
- **Sort keys** (`sort_key`, `sort_first`, `sort_last`) are text that sorts in date order. Each is a year shifted by 10000 to five digits, then the recorded date, e.g. `11991 11991-05-17`.
- **Links to missing records:** `object_relations` (90 rows) and `literature_refs` (71 rows) point to objects that are not in the database. The build keeps these links on purpose, so `PRAGMA foreign_key_check` reports them.
- **Labels are mostly German.** `terms.label` is the display label (German when there is one), and `term_labels` holds every language.

## Tables

Row counts are those of this copy.

### Build information

**`meta`** (7 rows): key–value pairs.

| Key | Meaning |
|---|---|
| `built_at` | When the build ran |
| `data_as_of` | Date of the dump |
| `dump_etag`, `dump_last_modified` | HTTP headers of the dump |
| `schema_version` | Version of this schema |
| `store` | Path of the build's local Oxigraph store |
| `variant` | `public` for this copy |

### Vocabularies

**`schemes`** (66): SKKG's vocabularies.
- `id`: scheme number.
- `name`: SKKG's name of the scheme.
- `facet`: the name the server uses, or NULL for a scheme without one.

**`terms`** (4,343): vocabulary terms.

| Column | Meaning |
|---|---|
| `id` | `type/{scheme}/{n}` |
| `scheme_id` | The term's scheme |
| `facet` | The facet name (list below) |
| `label` | Display label |
| `label_de`, `label_en`, `label_fr` | Label in that language |
| `broader_id` | Parent term |
| `year_from`, `year_to` | Years, for epochs |
| `matches` | JSON array of the same concept elsewhere: GND, GeoNames, Getty AAT, Wikidata |
| `object_count` | Objects that use the term |
| `object_count_with_narrower` | The same, including narrower terms, each object once |
| `narrower_count` | Number of direct children |
| `record_count`, `record_kind` | For terms that describe other records: their count and kind (`literature`, `persons`, `provenance periods`, `images`, `exhibitions`, `addresses`) |
| `use_rank` | Popularity, for ordering |
| `life_place_count` | Countries only: actors born, died, formed or dissolved there |

Facets: `object_type`, `material`, `technique`, `epoch`, `condition`, `production_role`, `attribution`, `date_basis`, `date_qualifier`, `object_copyright`, `image_license`, `redaction_status`, `provenance_status`, `acquisition_type`, `owner_type`, `certainty`, `holding_kind`, `transaction_type`, `source_type`, `currency`, `country`, `gender`, `literature_type`, `literature_place`, `author_role`, `exhibition_type`, `exhibition_status`, `internal_external`, `object_reference_type`.

**`term_labels`** (5,586): `term_id`, `lang` (`de`, `en`, `fr`, …; `und` when not stated), `label`. Every label of a term.

**`term_ancestors`** (13,316): `term_id`, `ancestor_id`, `depth`. The transitive closure of `broader_id`, for queries that include narrower terms. Each term is also its own ancestor, at depth 0.

### Objects

**`objects`** (64,190): one row per object.

| Column | Meaning |
|---|---|
| `id` | Object id |
| `inventory_number` | SKKG's inventory number |
| `label` | SKKG's display label |
| `title` | Main title |
| `object_type_id` | Type of object |
| `number_of_parts` | Number of parts |
| `date_label`, `date_from`, `date_to` | Date of production, as text and as a year range |
| `parent_id` | The object this one is part of |
| `credit_line` | SKKG's credit line |
| `edition` | Edition statement |
| `material_statement` | SKKG's text on materials |
| `provenance_status_id`, `provenance_status_text` | State of provenance research |
| `redaction_status_id` | Editorial status |
| `created`, `updated` | When SKKG created and last changed the record |
| `manifest_url` | IIIF Presentation manifest |
| `primary_multimedia_id` | The main image |
| `has_image`, `image_count` | Published images |
| `image_license_id` | Licence of the main image |
| `has_provenance_chain` | 1 when there are provenance periods before SKKG |

**`object_terms`** (337,847): the object's vocabulary terms.
- `object_id`, `facet`, `term_id`, `seq`, `note`.
- Facets used here: `material`, `condition`, `object_type`, `redaction_status`, `epoch`, `object_copyright`, `technique`, `provenance_status`.

**`object_titles`** (66,337): all titles.
- `seq`, `title`, `short_title`, `type_id`, `language_id`, `note`.

**`object_dates`** (60,885): all dates.
- `seq`, `label`, `year_from`, `year_to`.
- `epoch_id`, `basis_id` (what the date rests on), `prefix_id` and `suffix_id` (qualifiers such as "um"), `note`.

**`object_creators`** (13,404): makers.
- `seq`, `actor_id`, `role_id`, `attribution_id` (e.g. workshop or circle).
- `relation`: `carried_out_by` (made it) or `influenced_by` (after a model by).

**`object_inscriptions`** (13,795): inscriptions.
- `seq`, `text`, `type_ids` (JSON), `note`, `translation`.

**`object_texts`** (86): published texts about the object.
- `seq`, `title`, `text`, `type_id`.
- `source`: citation of the text.

**`object_parts`** (75,728): the parts of 60,681 objects.
- `part_id`: `object/{n}/part/{uuid}`. A part is not a record of its own.
- `seq`, `label`, `type_id`, `note`, `prefix`.

**`object_dimensions`** (209,526): measurements.
- `part_id`: the part measured (`object_parts.part_id`). Every measurement belongs to a part.
- `dimension`: `height`, `width` or `depth`.
- `value`, `unit_id`, `label`.

**`object_identifiers`** (3,387): other numbers: `type_id`, `value`.

**`object_links`** (196): web links: `seq`, `url`, `type_id`, `note`.

**`object_conditions`** (63,765): condition reports.
- `condition_ids` (JSON), `note`, `date`.

**`object_relations`** (18,845): links to other objects: `target_id`, `type_id`, `label`.

**`object_multimedia`** (153,661): the object's files.
- `multimedia_id`, `seq`.
- `is_primary`: 1 for the main image.

**`object_groups`** (7) and **`object_group_members`** (1,352): SKKG's named groups of objects.

### Acquisitions by SKKG

**`acquisitions`** (55,462): one row per object.

| Column | Meaning |
|---|---|
| `type_id` | Kind of acquisition: purchase, gift, … |
| `date`, `date_label`, `date_uncertain` | When SKKG acquired the object |
| `source_id` | The actor SKKG acquired it from |
| `note`, `reference` | SKKG's note and reference |
| `price_value`, `currency_id`, `currency_code`, `price_label`, `price_note` | The price as recorded |
| `is_batch_price` | 1 when the price is a total for several objects |
| `price_chf`, `conversion_rate` | SKKG's own conversion to Swiss francs, when given |
| `year`, `sort_key` | For filtering and sorting |

### Provenance before SKKG

**`provenance`** (1,112): curated ownership periods, not parsed text.

| Column | Meaning |
|---|---|
| `label`, `statement` | SKKG's label and text of the period |
| `inventory_number` | Inventory number of the object |
| `owner_id`, `owner_type_id` | The owner and the kind of owner |
| `certainty_id`, `holding_kind_id` | How certain the period is, and the kind of holding |
| `transaction_kind` | `acquisition`, `activity` or `custody` |
| `transaction_type_id` | How the owner obtained the object |
| `place` | Place of the period |
| `date_label`, `date_from`, `date_to`, `date_note` | Dates of the period |
| `begin_qualifier_id`, `begin_from`, `begin_to` | The begin of the period, with its qualifier ("seit", "um", …) |
| `end_qualifier_id`, `end_from`, `end_to` | The end of the period, with its qualifier ("bis", "o. D.", …) |
| `price_value`, `currency_id`, `currency_code`, `price_label`, `price_note`, `is_batch_price` | The price |
| `status_id` | Research status |
| `year_first`, `year_last`, `sort_first`, `sort_last` | For filtering and sorting. An open side is stored as year −9999 or 9999. |

**`provenance_objects`** (1,166): the objects of a period, with `seq`.

**`provenance_sources`** (783): evidence for a period: `seq`, `type_id`, `note`, `url`.

**`provenance_characteristics`** (9): `seq`, `type_ids` (JSON), `note`.

### Actors and addresses

**`actors`** (16,740): persons and institutions.

| Column | Meaning |
|---|---|
| `kind` | `person`, `group` (institution), `stub` (known only by a label) or `anonymous` |
| `label`, `name` | Display label and name |
| `first_name`, `last_name`, `corporate_name` | Name parts |
| `gender_id` | Gender |
| `birth_label`, `birth_from`, `birth_to`, `birth_place`, `birth_place_id` | Birth |
| `death_label`, `death_from`, `death_to`, `death_place`, `death_place_id` | Death |
| `biography` | Biography |
| `is_anonymous` | 1 for SKKG's anonymised owners |

**`actor_names`** (9,793): other names: `name`, `type_id`, and `source` (`gnd` or `skkg`).

**`actor_events`** (5,630): life events.
- `kind`: `birth`, `death`, `formation`, `dissolution`, `active`, `nameChange`, `locationChange`, `other`.
- `type_id`, `label`, `date_label`, `year_from`, `year_to`, `place`, `place_id`, `note`.

**`actor_nationalities`** (1,173): `country_id`.

**`actor_external`** (5,825): ids elsewhere.
- `source`: `gnd`, `wikidata`, `recherche.sik-isea.ch`, …
- `external_id`, `url`.

**`actor_links`** (1,116): web links: `type_id`, `url`.

**`actor_relations`** (390): `subject_id`, `target_id`, `type_id`, `label`.

**`actor_gnd`** (2,265): data from the GND authority file, as included in SKKG's dump.
- `gnd_id`, `preferred_name`, `biographical_info`, `professions`.

**`addresses`** (644): institutions and places, mostly exhibition venues and organisers.
- `label`, `organisation`, `place`, `region`, `country_id`, `type_id`.
- `latitude`, `longitude`, `website`: empty for private persons.
- `is_private_person`: 1 for a private person, whose name is not in the database.

### Images and documents

**`multimedia`** (137,518): one row per file.

| Column | Meaning |
|---|---|
| `kind` | `image`, `document` (a scan of a document) or `sound` |
| `label`, `name` | Label and file name |
| `usage_id`, `type_id`, `category_id` | SKKG's classification of the file |
| `iiif_service` | Base URL on SKKG's IIIF Image API 3 server. Append `/full/max/0/default.jpg` for the image. NULL when SKKG publishes no image. |
| `width`, `height` | Size in pixels |
| `page` | Page number, for documents |
| `license_id` | Licence of the photo: CC0, CC BY or © |
| `right_holder_id`, `original_right_holder_id` | Right holders |
| `rights_end_date`, `rights_note` | When the rights end, and SKKG's note on them |
| `credit_line` | Credit line |
| `photographer_id`, `photo_date` | Who took the photo, and when |
| `not_found` | 1 when SKKG marks the file as not found |

Image rights (`multimedia.license_id`) and an object's copyright status (`object_terms` with facet `object_copyright`: "gemeinfrei" or "urheberrechtlich geschützt") are separate. Report both when you reuse an image.

### Literature

**`literature`** (11,387): publications.

| Column | Meaning |
|---|---|
| `label`, `title`, `type_id` | Label, title and kind of publication |
| `signature` | Shelf mark in SKKG's library |
| `isbn` | ISBN as recorded |
| `isbn_key` | Normalised: ISBN-13 or ISSN |
| `year_label`, `year_from`, `year_to` | Year of publication |
| `place_id` | Place of publication |
| `series`, `series_id`, `volume` | Series and volume |
| `edition`, `pages` | Edition and pages |
| `citation` | SKKG's citation |
| `language_id` | Language |
| `urls` | JSON array of links |

**`literature_actors`** (16,583): `actor_id`, `kind` (`author`, `editor` or `publisher`), `role_id`, `seq`.

**`literature_refs`** (3,002): where a publication cites an object or a provenance period.
- `ref_id`: the citation record.
- `object_id` or `provenance_id`: what is cited.
- `shows_object`: 1 when the object is illustrated.
- `page`, `figure`, `catalogue`, `sort`, `note`, `citation`.

**`literature_links`** (802): publications about a person or an exhibition: `target_id`, `role_id`.

### Exhibitions

**`exhibitions`** (429): `label`, `title`, `exhibition_type_id`, `status_id`, `internal_external_id`, `date_from`, `date_to`, `venue_id`.

**`exhibition_venues`** (511): `address_id`, `kind` (`main` or `other`), `type_id`, `date_from`, `date_to`, `note`.

**`exhibition_organisers`** (4): `address_id`, `role_id`, `seq`.

**`exhibition_objects`** (1,686) and **`exhibition_multimedia`** (399): the objects shown and the exhibition's images.

### Full-text indexes

The FTS5 tables use the tokenizer `unicode61 remove_diacritics 2`, so a search ignores case and accents. The first column of each is the record id and is not indexed.

| Table | Indexed columns |
|---|---|
| `objects_fts` | `title`, `label`, `inscription`, `text`, `inventory_number` |
| `actors_fts` | `names` |
| `literature_fts` | `title`, `authors`, `series` |
| `exhibitions_fts` | `title`, `venues` |
| `terms_fts` | `labels` |

## Example queries

```sql
-- Objects of a type, with their main image
SELECT o.id, o.inventory_number, o.title, m.iiif_service
FROM objects o
JOIN terms t ON t.id = o.object_type_id
LEFT JOIN multimedia m ON m.id = o.primary_multimedia_id
WHERE t.facet = 'object_type' AND t.label = 'Zeichnung';

-- Full-text search in titles and inscriptions
SELECT object_id FROM objects_fts WHERE objects_fts MATCH 'Napoleon';

-- Objects of a material, including narrower materials ("Holz" is in two schemes, hence IN)
SELECT DISTINCT ot.object_id
FROM object_terms ot
JOIN term_ancestors a ON a.term_id = ot.term_id
WHERE ot.facet = 'material'
  AND a.ancestor_id IN (SELECT id FROM terms WHERE facet = 'material' AND label = 'Holz');

-- The provenance chain of an object, in date order
SELECT p.date_label, p.label, act.label AS owner
FROM provenance_objects po
JOIN provenance p ON p.id = po.provenance_id
LEFT JOIN actors act ON act.id = p.owner_id
WHERE po.object_id = 'object/10209'
ORDER BY p.sort_first;
```

## Links

- **An object's page on SKKG's website:** `https://digital.skkg.ch/de/intro/skkg%3Aobject%2F{n}`, where `{n}` is the part of the id after `object/`.
- **Terms of use:** SKKG's metadata is free to reuse. Image rights vary per object: see the `multimedia` rights columns.
