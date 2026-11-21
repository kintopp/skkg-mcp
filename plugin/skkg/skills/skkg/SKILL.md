---
name: skkg
description: Sends the model to the research guidance of the skkg server (skkg_guide) for the SKKG Sammlung, the collection of the Stiftung für Kunst, Kultur und Geschichte in Winterthur (founded by Bruno Stefanini; about 64,000 objects with German metadata, provenance chains, SKKG's acquisitions with prices, literature, and exhibitions). Use whenever the user asks about SKKG, the Stefanini collection, its Swiss art of the 19th and 20th centuries (Hodler, Anker, Amiet, Giacometti, Segantini), furniture, arms, military or everyday objects, its provenance research and auction purchases, or the rights to its images, including German queries (Sammlung, Provenienz, Erwerbung, Stillleben, Gemälde), and any time an skkg_ tool is about to be called.
license: MIT
compatibility: Requires the skkg-mcp MCP server, either the hosted connector or a local install with its SKKG database file (SKKG_DB_PATH). Image and live rights calls need network access.
metadata:
  version: "0.5.0"
  last_updated: "2026-11-13"
---

# SKKG Sammlung

Before the first `skkg_*` search, read the guide with `skkg_guide`: start with its default topic, then read the topics the question needs; each result names the others. The guide comes from the skkg server, so it always matches the server's tools.
