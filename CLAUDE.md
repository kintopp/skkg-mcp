# skkg-mcp

## What this is

A stdio MCP server over the SKKG Sammlung digital collection (Winterthur). Node 24, pure ESM, no build step; runtime dependencies are `@modelcontextprotocol/server` and `zod`. It reads one read-only SQLite database (`node:sqlite`) built by `scripts/build_db.py` in the sibling `glamhack` repository, which holds the research notes (`notes/11-mcp-tool-list.md` is the tool spec). This repository stays local; any future GitHub remote must be private.

## Commands

| Purpose | Command |
|---|---|
| Install | `npm install` |
| Tests | `npm test` |
| Lint | `npm run lint` |
| Run against the full database | `SKKG_DB_PATH=../glamhack/data/db/skkg-20261028.sqlite npm start` |
| Inspector | `SKKG_DB_PATH=… npm run inspector` |

## Conventions (shared with books-as-data and odeuropa-eokg-mcp)

- Every tool returns `content[{type:'text'}]` and `structuredContent` from one structured object. Errors are `isError: true` results without `structuredContent`, via `withTool` (`src/lib/tool.js`) and `ToolError`.
- Input schemas are `.strict()` and `$ref`-free; output schemas are `$ref`-free. Don't share one zod instance across fields.
- The first sentence of a tool description is at most 79 characters. Tool `title` equals its name. Never set a human-readable `serverInfo.title`.
- stdout is JSON-RPC only; log with `console.error`.
- Constants live in `src/config.js`.
- Every tool lives in `src/tools/<name>.js`, is registered in `src/server.js`, and is listed in `REQUIRED_PROPS` in `test/smoke.test.js`.
- Resolve every `id` parameter with `resolveId` (`src/lib/ids.js`). A bare number can be an object id and another object's inventory number (object/2432 has inventory number 2232); the resolver refuses that case instead of guessing.
- Privacy and rights rules are enforced by the database build, not here. Never add a raw SQL or SPARQL tool. Every tool that returns an object or image passes through both rights sets (photo rights and object copyright).
- Test rules are in `test/CLAUDE.md` (adapted from the sibling servers). Never delete or weaken a failing test.
