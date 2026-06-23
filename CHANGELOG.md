# Changelog

## [1.0.3] - 2026-06-24

### Fixed
- Virtual lookup/optionset name columns (e.g. `SELECT owneridname FROM account`) failed with "no readable columns" when selected on their own. Dataverse silently ignores the unknown attribute, so the `owneridname → ownerid` rewrite never fired. The tool now detects unresolved `*name` columns and re-runs once with just those rewritten to their base lookup/optionset, leaving real `*name` attributes (e.g. `fullname`) untouched. Also fixes the case where such a column was silently dropped alongside resolvable columns (`SELECT name, owneridname FROM account`).

## [1.0.2] - 2026-06-23

### Fixed
- Light mode: schema/table list is now legible — entity names, attribute rows, type badges, borders, and the attribute filter input adapt to the active theme instead of using dark-only styling (#1)
- Theme toggle: switching the theme in the toolbox settings now updates the tool live by re-reading the theme on the host `settings:updated` event, instead of only reading it once on load (#1)

## [0.1.1] - 2026-03-31

### Added
- Multi-statement editor: execute the statement at cursor position or selected text only
- Statements split on SQL keywords (SELECT/INSERT/UPDATE/DELETE) on consecutive lines
- String literals as column aliases (`AS 'November 2025'`)
- Open entity record links in system default browser via PPTB terminal API
- Entity type resolution from `_type` row annotations for accurate record links

### Fixed
- Suppress Vite chunk size warning for Monaco IIFE bundle

## [0.1.0] - 2026-03-30

### Added
- SQL editor powered by Monaco with context-aware autocomplete
  - Entity names after FROM/JOIN
  - Attribute names after SELECT/WHERE and after dot (`account.`)
  - Alias resolution (`FROM account a` → `a.` shows account attributes)
  - Trigger on `.` and space for immediate suggestions
- SQL lexer and recursive descent parser for SELECT, INSERT, UPDATE, DELETE
  - 237 unit tests covering parser, generator, and lexer
  - Quoted identifiers: `[column name]` and `"column name"`
  - Negative number literals
  - String literal aliases
- FetchXML generator with correct Dataverse semantics
  - Aggregate queries with auto-aliasing
  - JOIN with proper from/to attribute resolution
  - NOT pushdown to FetchXML operators (De Morgan's law)
  - NULL comparison handling
  - ORDER BY on joined entity columns via entityname attribute
- Schema explorer sidebar
  - Collapsible entity tree loaded from Dataverse metadata
  - Attribute browser with type badges
  - Entity and attribute filter inputs with clear buttons
  - Auto-load on connection ready, retry on failure
- Results grid with TanStack Table
  - Row virtualization for large result sets
  - Column sorting and drag-to-resize
  - GUID values show open-record links
  - Loading indicator during re-execution
  - CSV and JSON export
- FetchXML inspector with readonly Monaco XML viewer and copy-to-clipboard
- Query history with search, pin, and persistence via toolboxAPI.settings
- Multi-tab query editor
  - Independent SQL content per tab
  - Per-tab results, FetchXML, and error state
  - Right-click context menu for rename and tab color
  - Ctrl/Cmd+T to add new tab
  - Double-click to rename
- DML execution engine
  - INSERT with single and multi-row support
  - UPDATE and DELETE with WHERE clause resolution via FetchXML
  - Confirmation dialog for UPDATE >10 rows and all DELETEs
  - Type-to-confirm for large operations (UPDATE >100, DELETE >50)
  - Batch progress indicator with cancel capability
  - DML-specific notifications (success/error/cancellation)
  - Record ID deduplication to prevent concurrent operation errors
- Query history distinguishes SELECT vs DML with color-coded badges
- Save and Open buttons for loading/saving .sql files via PPTB FileSystem API
- Settings panel with configurable batch size and auto-show FetchXML option
- Light/dark theme support via PPTB getCurrentTheme
- Connection change handling with automatic schema reset
- Virtual column support: `owneridname` → resolves to formatted lookup value
- SELECT * hides derived annotation columns for cleaner output

### Performance
- Selective Monaco import (editor core + SQL/XML only): 4.7→4.2 MB, build 9→3.6s
- Row virtualization via TanStack Virtual
- Zustand selectors in all consumers to prevent broad re-renders
- Schema attribute loading deduplicated via promise map
- Memoized filtered entity/history lists
- GUID column detection memoized per-column

### Tooling
- ESLint 9 with typescript-eslint and react-hooks plugin
- Prettier with format and format:check scripts
- pptb-validate passes with zero errors/warnings
