# SKKG Sammlung digital

## Overview

- **What the tools read.** The `skkg_*` tools read a local database built from SKKG's
  public RDF dump, and only `skkg_inspect_image` and `live: true` of `skkg_get_object`
  call SKKG's servers. The tool descriptions document the parameters. This guide covers
  what the data holds, which assumptions quietly fail, and the calls that work. Figures
  here are rough orders of magnitude; take exact counts from the tools, and the date of
  the data from `data_as_of`, which every result but this guide's carries.
- **What it is.** SKKG is the foundation Bruno Stefanini set up in 1980. The collection
  has about 64,000 objects: paintings, sculpture, and works on paper (much of it Swiss
  art of the 19th and 20th centuries), furniture, arms and other military objects
  (uniforms, crossbows, tin soldiers), and many everyday objects (kitchen moulds, locks
  and keys, doll's house furniture, badges, coins). Nearly all objects have a
  published image.
- **Records around the objects.** A few thousand persons and groups with a record of
  their own, over 10,000 publications, a few hundred exhibitions, about a thousand
  provenance periods, and SKKG's acquisition records for most objects.
- **The workflow.** Find objects with `skkg_search_objects`, then read one with
  `skkg_get_object`. Without `include` it returns only the summary and the rights, so
  ask for the sections the question needs: `production` for makers and dating,
  `provenance` and `acquisition` for its history, `images` before
  `skkg_inspect_image`; `all` is long. Use the other searches for the records around
  them: `skkg_search_provenance`, `skkg_search_actors`, `skkg_search_literature`,
  `skkg_search_exhibitions`. Read any record that is not an object with
  `skkg_get_record`. Count with `skkg_collection_stats` instead of paging through a
  search. Look up filter values with `skkg_find_terms`. Look at an image yourself with
  `skkg_inspect_image`; show images to the user with `skkg_view_image`.
- **Every result says what to call next.** Ids, `website_url`, a bucket's `filter`, an
  actor's `literature_filters`, and the hints in `warnings` are ready to pass on. Read the
  warnings: they name the parameter that would work when a call matches nothing.
- **What is not there.** SKKG records no subjects or iconography, no places of
  production, and the server withholds current locations. Do not promise searches by
  what a picture shows, or by where an object was made or is kept.

## Search in German

The metadata is German. English words find nothing: `{query: "still life"}` returns no
objects and a warning, while `{query: "Stillleben"}` returns about a hundred.

- **Translate keywords before the first call.** Search the German word, and try its
  variants: compounds (`Taschenuhr`), a prefix with `*` (`Uhr*`), and older spellings.
  Words are AND-ed, `"a phrase"` matches in order, `OR` between two words matches
  either, and `NOT` before a word excludes it. Operators are written in capitals and work
  in `query` and the name filters (`creator`, `author`, `owner`, …); `venue`, `place`, and
  `series` take plain words. Umlauts can be written `ä` or `ae`.
- **Term filters take a German label or a term id, matched exactly except for case.** An
  unknown label is refused, with similar labels if there are any. When unsure, call
  `skkg_find_terms` first: each term lists every filter that takes it, with the count
  that filter returns.
- **The vocabulary is not the everyday word.** "Gemälde" is no object type; the type is
  "Malerei", with several thousand objects under its narrower terms.
  `{query: "Gemälde"}` searches titles and texts and finds only a few dozen.
  "Radierung" and most print techniques are in the `material` vocabulary, not
  `technique`: `{material: "Radierung"}`.
- **Narrower terms are included by default.** "Malerei" also matches "Gemälderahmen", so
  a painting count with `object_type: "Malerei"` includes picture frames. For
  paintings, use "Malerei auf textilem Bildträger" or "Malerei auf festem Bildträger",
  or check the type of each result.
- **For a period, filter by date, not by epoch.** Epochs do not nest: "1. Hälfte 19.
  Jh.", "Ende 19. Jh.", and "18./19. Jh." are terms of their own, not narrower terms of
  "19. Jh.", and many dated objects have no epoch or only "ohne Datierung". So
  `epoch: "19. Jh."` finds only a fraction of the 19th-century paintings that
  `date_from: 1801, date_to: 1900` finds. The date filters match by overlap, so they
  include objects dated across the boundary ("19./20. Jh."); check the dating of each
  result when that matters. Use `epoch` only to ask for SKKG's own label.
- **`skkg_find_terms` matches the start of a word.** "Radier" finds "Radierung", but
  "malerei" does not find "Ölmalerei". English and French labels match where SKKG has
  them, which is rare.
- **`lang` changes only vocabulary labels.** Titles and texts stay as SKKG wrote them.

**Creators and attributions.**

- `creator` also matches SKKG's "influenced by" rows, which carry an attribution:
  "zugeschrieben", "nach", "Kopie nach", "Umkreis", schools such as "«Schweizer
  Schule»", but also "Fälschung nach" (forgery after), "dargestellte Person" (the
  person depicted), and "Vorbesitz" (former owner). So the objects of
  `creator: "person/36"` (Ferdinand Hodler) include forgeries and portraits of him.
- Before you list or count an artist's works, count their attributions:
  `skkg_collection_stats({dimension: "attribution", creator: "person/36"})`. Then
  exclude what does not belong with `exclude_attributions`, e.g.
  `["nach", "Kopie nach", "Fälschung nach", "dargestellte Person"]`, and say what you
  excluded.

Calls that work:

- `skkg_search_objects({query: "Stillleben"})`
- `skkg_find_terms({query: "Malerei", vocabulary: "object_type"})`
- 19th-century paintings on canvas: `skkg_search_objects({object_type: "Malerei auf textilem Bildträger", date_from: 1801, date_to: 1900})`
- `skkg_collection_stats({dimension: "epoch", query: "Stillleben"})`
- An artist's own works: `skkg_search_actors({query: "Hodler"})`, then
  `skkg_collection_stats({dimension: "attribution", creator: "person/36"})`, then
  `skkg_search_objects({creator: "person/36", exclude_attributions: ["nach", "Kopie nach", "Fälschung nach", "dargestellte Person"]})`
- An artist's work by type: `skkg_collection_stats({dimension: "object_type", creator: "person/36"})`

## Ids

- **Two id schemes.** Records have numeric ids (`object/1014`, `person/36`) or UUIDs
  (`person/9fd0bc02-…`). Both are valid and are separate records, never two names for
  one record.
- **A bare number can be ambiguous.** An object id can be another object's inventory
  number: `"2432"` is `object/2432` and the inventory number of `object/2642`, so the
  tool refuses it. Pass the prefixed id (`object/2432`) or say which you mean.
- **Inventory numbers work as object ids** (`"884"`, `"GB-0171.1"`), and so do
  `data.skkg.ch` IRIs and links to the SKKG website.
- **Pass the id a result gave you.** Each record carries its `id`, its type, and usually
  its `website_url`, so the next call needs no lookup.
- **Name filters match every actor whose name has all the words.** `creator: "Anker"`
  matches about a dozen persons, among them relatives and the Nachlass;
  `applied_filters` lists them and a warning says so. Once you know the person, pass the
  actor id (`creator: "person/41"`).

## Rights and privacy

**Two kinds of rights, always both.** SKKG's terms treat the photo and the object
separately, and so does every result.

- `image_license` is the licence of SKKG's image, mostly a photo: "CC0 1.0" (most photos),
  "CC BY 4.0", or "©" with a `right_holder`. The full image block also gives the
  photographer, the photo date, and the rights end date.
- An image's `kind` (`image_kind` in a result row) is SKKG's media type: "image" is a
  photograph, mostly of the object, some of a paper such as an auction slip;
  "document" is a scan of a paper about the object, such as an auction slip, a packing
  slip, or a label. About 2,000 objects have documents only, so their primary image is
  one; never describe a document as a view of the object. Nearly all documents have no
  licence recorded.
- `object_copyright` is the status of the object itself: "gemeinfrei" (public domain)
  or "Copyright". Most objects have neither, shown as "not recorded". That means
  unknown, never free.
- A CC0 photo of a work under copyright is not free to reuse: the work's own rights
  still apply. Quote both values whenever you show, describe, or recommend an image,
  and add the `credit_line` of `skkg_get_object` when the user will reuse it.
- `redaction_status` ("Bearbeitungstiefe 1: Registrierung" and so on) says how fully
  SKKG has catalogued the record. A record at level 1 is a bare registration, so a
  missing field there says little.
- The database is a snapshot. `skkg_get_object({id: "object/1014", live: true})` checks the credit
  line, the images, and the image rights against SKKG's API with one request, and lists
  what changed. The API has no object copyright, so that value always comes from the
  dump. Use `live` for the objects the user will actually reuse, not for every result.

**Personal data.** The build removed the names of private persons, and the server keeps
SKKG's anonymisation as it is.

- "Unbekannte:r Eigentümer:in" (unknown owner) is one record that stands for many
  persons SKKG does not name. It owns over a hundred provenance periods; they are not one
  person.
- Private addresses appear as "Privatperson, {place}".
- Never try to identify these persons, whether from the place, the dates, the price,
  an auction lot, or another source. Say that SKKG does not name them.
- Living persons named in the data, and some descendants, have personality rights
  (section D of SKKG's terms). The user is responsible for respecting them.

**Images.**

- `skkg_inspect_image` returns the image for your own analysis. To show images to the
  user, call `skkg_view_image`, a viewer with each image's rights; if no viewer appears,
  link the object's `website_url`, which shows them with their rights. Never embed an
  image URL as Markdown: it would appear without its rights.
- Some clients drop image results. If no picture arrives, say so, and describe the
  object from its metadata only.
- SKKG does not publish every image, sometimes for ethical reasons. Never look for an
  image SKKG did not publish, and never build an IIIF link yourself.
- For detail, pass `region_pct` (a part of the image) rather than a larger size; the
  result's `note` says what would add detail.

## Provenance

SKKG's provenance data has two layers, and most questions need both.

- **The chain** (`layer: "chain"`) is the curated ownership periods before and up to
  SKKG. Only a few hundred objects have one (`has_provenance_chain: true`), almost all
  of them paintings. Each period has an owner, an owner type, a certainty ("gesichert",
  "wahrscheinlich", "vermutlich", "möglicherweise"), a kind of holding, a transaction,
  dates with qualifiers, a place, sometimes a price, and its sources.
- **The acquisitions** (`layer: "acquisition"`) are how SKKG itself acquired most
  of its objects: type ("Auktion", "Freihandkauf", "Schenkung"), seller, date, price,
  and the auction lot.
- **`skkg_search_provenance` searches both by default.** Filters of one layer restrict
  the search to it; filters of both layers in one call are refused, so make two calls.
- **SKKG's own purchase is often in both layers.** In most chains the last period
  is SKKG as owner, often with the price of the acquisition. Count either the
  chain periods or the acquisitions, not their sum.
- **The two prices of one auction purchase can differ.** Most match, but where they
  differ the acquisition price is often exactly 10% or 15% above the chain's, which
  fits a buyer's premium on the hammer price. SKKG does not say which price is which,
  and only a few carry "Zuschlagspreis" (hammer price) in `price_note`. Report both,
  and call the premium a likely reading, not a fact.
- **Open periods reach every year on their open side.** "o. D.–12.01.2005" (no start
  date) or "seit 1995" matches any year range on that side. So
  `{layer: "chain", year_from: 1933, year_to: 1945}` matches more than half of the
  objects with a chain, most of them through such periods. Read each period's dates before you say that
  someone owned an object in those years.
- **Prices are in the recorded currency and never converted.** `price_min`, `price_max`,
  and `sort: "price_desc"` need `currency` ("CHF", "DEM", "FRF", "GBP", "USD", "EUR";
  SKKG's "DM" and "FF" also work). A price with `is_batch_price` is the price of the
  whole batch, not of one object. Do not add prices across currencies or decades as if
  they were comparable.
- **`provenance_status` is the state of SKKG's research into losses caused by Nazi
  persecution**, not a general quality mark. "klar": no indication of such a loss.
  "ungeklärt": open questions; SKKG also puts paintings bought for under 5,000 CHF
  here. "geklärt": an agreement between the parties or a decision of SKKG's independent
  commission. A few hundred objects have a status, with SKKG's text in `status_text`.
- **Some fields are computed.** In a chain, `computed_previous_owner` and the gaps
  between periods are derived by the server from the order of the periods, not stated
  by SKKG. Say so when you use them.
- **Provenance is curated periods, not text.** Use the period fields and the sources.
  Do not parse an owner or a date out of a period's `statement`.

Calls that work:

- One object's history: `skkg_get_object({id: "object/1014", include: ["provenance", "acquisition"]})`
- An owner across objects: `skkg_search_provenance({owner: "Kornfeld"})` (several actors match; pass one id to narrow)
- Private owners in a city: `skkg_search_provenance({layer: "chain", owner_type: "Privatbesitzer:in", place: "Zürich"})`
- SKKG's auction purchases in a decade: `skkg_search_provenance({acquisition_type: "Auktion", year_from: 1990, year_to: 1999})`
- The highest prices: `skkg_search_provenance({currency: "CHF", sort: "price_desc"})`
- Acquisitions by decade: `skkg_collection_stats({dimension: "acquisition_decade"})`

## Data caveats

**Counts.**

- In `skkg_collection_stats` an object counts once per value, so buckets can add up to
  more than `total_objects`. An object dated "ohne Datierung; 20. Jh." counts in both
  epochs.
- `production_decade` counts only objects dated within one decade; broad datings such
  as "19. Jh." are under `epoch`. Year filters match by overlap, and undated objects
  never match.
- Lists longer than 50 are cut, and the result says so with the total.

**Actors and literature.**

- Most authors, editors, and publishers are recorded by name only, often with one record
  per publication: Jeremias Gotthelf has a different id in each of his publications.
  Search literature by name (`author`, `publisher`), not by id. `skkg_search_actors`
  lists only persons and groups with a record of their own and counts the name-only
  matches in `name_only`.
- Only a small share of the publications (a few percent) refer to objects in the
  collection; most are SKKG's library. Use `refers_to_object` or `skkg_get_record` to
  find the literature about an object. A reference's `citation` is sometimes that of
  another publication, so give the title and year of the publication itself.
- A dual nationality is a term of its own ("CH/DE"), which `nationality: "CH"` does not
  match. `place_country` matches places of birth, death, formation, or dissolution.

**Exhibitions.**

- A touring exhibition is often one record whose other venues are its stations, each
  with its own dates and status. `venue` never matches a cancelled station
  ("abgesagt"). Stations "geplant" with past dates were not updated by SKKG.
- `internal_external: "intern"` does not mean that SKKG organised the exhibition.
- An exhibition with only a start date matches only its start year, also a current one.
  For what is on now, filter by `status: "aktuell"`, not by a year.

**Wrong values SKKG publishes.** The server reproduces them. Flag them when you quote
them.

- A few acquisition dates are impossible, with years before 1000 or in the future.
  SKKG's credit lines repeat them.
- A few photo dates are malformed, such as "20219-12-31".

**Images without an object.** A few dozen published images belong to an exhibition, not
to an object. Their `objects` list is empty; do not guess an object from the file name.

Calls that work:

- Women artists from Switzerland: `skkg_search_actors({kind: "person", gender: "weiblich", nationality: "CH", role_in_collection: "creator"})`
- Literature and exhibitions of one object: `skkg_search_literature({refers_to_object: "object/1014"})`, `skkg_search_exhibitions({includes_object: "object/756"})`
- Exhibitions in a city: `skkg_search_exhibitions({venue: "Winterthur"})`

## Citing

- Link each record's `website_url`. Object pages are
  `https://digital.skkg.ch/de/intro/skkg%3Aobject%2F{id}`. Literature has no page on the
  website; cite its title, authors, year, and id.
- Give the inventory number with the title, and both rights for any image.
- Quote titles, inscriptions, and provenance statements as SKKG wrote them, in German.
  Translate in brackets if the user needs it.
- Say which values are SKKG's and which you or the server derived: computed provenance
  fields, sums, and your own reading of an image.
- The metadata is free to reuse, comparable to CC0. Credit to SKKG is welcome but not
  required. SKKG asks to hear about publications that use the collection
  (sammlung.digital@skkg.ch).

## Other sources

- Actors often carry GND and Wikidata ids (`skkg_get_record` with
  `include: ["external"]`). Use them to link to other collections and to biographical
  data.
- SKKG has no subject data, so an Iconclass server has nothing to match here.
