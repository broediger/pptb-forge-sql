# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Forge SQL is a Power Platform ToolBox (PPTB) tool that lets users write and execute SQL against Dataverse. SELECT is translated to FetchXML; INSERT/UPDATE/DELETE go through Web API calls. Built with React 18 + TypeScript + Vite + Tailwind 4 + Zustand, packaged as a single IIFE bundle.

## Commands

- `npm run dev` — Vite dev server in a plain browser. The host APIs don't exist there (see below), so it's only useful for UI work.
- `npm run build` — typecheck then bundle (`tsc && vite build`)
- `npm run watch` — rebuild on file changes (use with Load Local Tool, see Debugging)
- `npm test` / `npm run test:watch` — vitest (`src/**/__tests__/*.test.ts`, node environment, no DOM/jsdom)
- `npm run lint` — ESLint; `npm run type-check` — `tsc --noEmit`
- `npm run format` / `format:check` — Prettier
- `npm run validate` — `pptb-validate`; use `npx pptb-validate --skip-url-checks` for a fast local run
- `npm run finalize-package` — regenerate `npm-shrinkwrap.json` before publishing

Run a single test file with `npx vitest run src/sql/__tests__/parser.test.ts`.

**Formatting:** several existing files (e.g. `App.tsx`, `useQueryExecution.ts`, `columnResolution.ts`) are not Prettier-clean on `main`. Don't run Prettier over a whole existing file in a feature/fix change — it buries the real diff. Format new files fully; keep edits to existing files in the surrounding style.

## PPTB Runtime

- The tool runs inside PPTB (an Electron desktop app) in an isolated view, loaded from `file://`. The Vite build therefore emits a **single IIFE bundle**, not ES modules. The custom `fixHtmlForPPTB` plugin in `vite.config.ts` strips `type="module"`/`crossorigin` and moves scripts to the end of `<body>`.
- PPTB's CSP blocks `blob:` URLs and external worker scripts, so Monaco's web workers are stripped from the bundle (`strip-monaco-workers` in `vite.config.ts`). The tool only talks to Dataverse through the host, so there are no `cspExceptions` in `package.json`; any new external domain needs one (least-privilege, never `*`).
- Host APIs are injected by PPTB and typed via `@pptb/types` (declared in `src/vite-env.d.ts`):
  - **`window.toolboxAPI`** — connections, events, notifications, settings, terminal, inter-tool invocation
  - **`window.dataverseAPI`** — Dataverse operations (`fetchXmlQuery`, CRUD, metadata)
  - They exist **only inside PPTB**. Code must tolerate their absence (`npm run dev`, tests): guard with `window.toolboxAPI?.…` or try/catch.
- Never build Dataverse requests with tokens yourself; always go through `dataverseAPI`.
- Report errors and completions to the user with `window.toolboxAPI.utils.showNotification(...)` (wrapped in try/catch), not `alert()` or console-only logging.
- Tool settings persist via `toolboxAPI.settings.get/set`; see `src/stores/`.

## Architecture

### SQL pipeline (`src/sql/`)

`lexer.ts` → `parser.ts` (AST in `types.ts`) → `generator.ts` (AST → FetchXML). `index.ts` re-exports the entry points. Supporting modules:

- `columnResolution.ts` — post-processes Dataverse rows: renames OData annotations (`…@OData.Community.Display.V1.FormattedValue` → `_formatted`, plus `xxxname` aliases), exposes lookup GUIDs under clean names, and maps requested columns to result keys, including recovery of virtual `xxxname` columns.
- `jsonValue.ts` — `JSON_VALUE(col, '$.path')`, evaluated client-side on the fetched rows.
- `completionProvider.ts` — Monaco autocomplete.

Anything FetchXML can't express is done client-side after the query runs (JSON_VALUE, virtual name columns, count fallbacks). Keep such logic in pure functions under `src/sql/` so it can be unit-tested; the hooks only orchestrate.

### Execution (`src/hooks/`)

- `useQueryExecution.ts` — runs SELECTs: generate FetchXML, call `dataverseAPI.fetchXmlQuery`, clean rows, resolve columns, paging ("load more" via paging cookie), and fallbacks (virtual-name retry, paged COUNT when Dataverse's 50,000-record aggregate limit `0x8004e023` is hit).
- `useDmlExecution.ts` — INSERT/UPDATE/DELETE: resolves target records with a FetchXML query, then runs the Web API calls in batches (`batchSize` setting). Above a threshold derived from `batchSize` it asks for confirmation first (`DmlConfirmDialog`).
- `useToolboxAPI.ts` — `useConnection`, `useToolboxEvents` (host events via `toolboxAPI.events.on()`). Use these rather than subscribing to host events directly in components.
- `useTheme.ts` — follows the PPTB theme, including live `settings:updated` changes.

### State and UI

- Zustand stores in `src/stores/`: `historyStore` (query history), `settingsStore` (tool settings), `schemaStore` (entity/attribute metadata for the schema explorer and completions).
- `App.tsx` wires editor tabs, results/FetchXML/History tabs, export (`src/utils/export.ts`) and the stores. Main components: `SqlEditor`, `ResultsGrid` (virtualized TanStack table), `SchemaExplorer`, `FetchXmlInspector`, `QueryHistory`, `SettingsPanel`.
- `ToolboxAPIDemo.tsx`, `DataverseAPIDemo.tsx` and `EventLog.tsx` are unused scaffold leftovers.

### Dataverse behaviour worth knowing

These caused real bugs; check new result-handling code against them:

- A row **omits an attribute whose value is null**. Never derive the column list from a single row.
- Link-entity attributes come back prefixed with the link alias (`l.fullname`). The generator always emits a link alias (defaulting to the table name) so keys are predictable.
- An **unknown attribute on a link-entity is silently ignored** (no error). An unknown attribute in a `<condition>` does error (`0x80041103`), which is a quick way to check whether a name exists.
- Formatted values (option set labels, lookup names) only come back when the base column is requested; `xxxname` isn't a real attribute.
- Multi-page scans need an explicit `<order>`, or page 2 fails with `0x80041129`. Pass the paging cookie unwrapped (see `injectPagingIntoFetchXml`).
- FetchXML has no column-to-column comparisons, no subqueries, and no RIGHT JOIN.

## Debugging inside PPTB

`npm run watch` → in PPTB, enable **Settings → Show Debug Menu** → Debug sidebar → **Load Local Tool** and select the project **root** (not `dist/`) → Help → **Toggle Tool DevTools** for the console. There is no hot reload: close and reopen the tool tab after each rebuild.

## Manifest, validation and publishing

- `package.json` is the PPTB manifest. `pptb-validate` requires `displayName`, `description`, `main` (`index.html`, relative to `dist/`), `icon`, an allowed `license`, non-empty `contributors`, and `configurations.repository` + `configurations.readmeUrl` (a `raw.githubusercontent.com` URL). The npm-style top-level `repository` object is separate.
- `icon` (`icon.svg`) must exist in `dist/` after a build. Vite copies it from `public/icon.svg`.
- Only `dist/` and `npm-shrinkwrap.json` are published (`files`). If a `pptb.config.json` is added (inter-tool invocation or agent/MCP integration), it must be added to `files` too.
- `features.minAPI` isn't set; set it to the highest PPTB API version the tool actually requires if newer host APIs are used.
- Release: bump `version` in `package.json`, `npm run finalize-package`, add a `CHANGELOG.md` entry (`## [x.y.z] - YYYY-MM-DD` with `### Added/Fixed` sections), commit as `Release x.y.z`. Then `npm run build` → `npx pptb-validate` → `npm publish`. **Publishing is irreversible — confirm with the maintainer before running `npm publish`.**

## Git workflow

- Work on a branch and open a PR against `main`; commit messages use conventional prefixes (`feat:`, `fix:`). Reference issues with `Fixes #n`.
- No emoji in commit messages, PR descriptions or issue comments.
