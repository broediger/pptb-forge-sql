# Forge SQL

Write and execute SQL against Dataverse — SELECT, INSERT, UPDATE, and DELETE. Translates to FetchXML and Web API calls, with a Monaco-powered editor, schema autocomplete, and built-in safeguards for destructive operations.

Forge SQL is inspired by [Mark Carrington's SQL4CDS](https://markcarrington.dev/) and serves as a lightweight alternative within Power Platform ToolBox until SQL4CDS is fully ported.

---

## Features

- SQL editor powered by Monaco with context-aware autocomplete (entities, attributes)
- Schema browser sidebar — collapsible entity tree loaded from Dataverse metadata
- FetchXML inspector — view, copy, and inspect the generated FetchXML for every query
- Results grid with sorting, column resizing, pagination, and CSV/JSON export
- Query history with search, re-run, and pin — persisted via ToolBox settings
- Full DML support: INSERT, UPDATE, DELETE with execution safeguards
- Execution timing and row count in the status bar
- Light/dark theme support via Power Platform Toolbox

---

## Supported SQL

### SELECT

```sql
SELECT [DISTINCT] [TOP n] <columns | aggregates | *>
FROM <entity> [AS alias]
[INNER | LEFT JOIN <entity> AS alias ON <condition>]
[WHERE <conditions>]
[GROUP BY <columns>]
[HAVING <conditions>]
[ORDER BY <columns> [ASC | DESC]]
```

Supported aggregates: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`

FetchXML has no HAVING, so Forge SQL evaluates it client-side: it reads every group of the aggregate query, keeps the ones that match, then applies `TOP`. Limits:

- An aggregate in HAVING can only be compared with a value (`COUNT(*) > 1`), not with another aggregate. `BETWEEN`, `IN` and `IS NULL` work on grouping columns only.
- At most 50,000 groups are read before HAVING is applied.
- HAVING can't be combined with an `IN (SELECT …)` subquery that returns more than 250 values.

### INSERT

```sql
-- Single row
INSERT INTO <entity> (col1, col2) VALUES (val1, val2)

-- Multi-row
INSERT INTO <entity> (col1, col2) VALUES (val1, val2), (val3, val4)
```

### UPDATE

```sql
-- WHERE clause is required
UPDATE <entity> SET col1 = val1, col2 = val2 WHERE <conditions>
```

### DELETE

```sql
-- WHERE clause is required
DELETE FROM <entity> WHERE <conditions>
```

---

## DML Safeguards

UPDATE and DELETE without a WHERE clause are rejected at parse time. For operations that do have a WHERE clause, additional safeguards apply based on the number of affected rows:

| Safeguard              | INSERT         | UPDATE          | DELETE        |
|------------------------|----------------|-----------------|---------------|
| WHERE clause required  | N/A            | Yes             | Yes           |
| Row count preview      | N/A            | Yes             | Yes           |
| Sample data preview    | No             | Optional        | Yes           |
| Confirmation dialog    | No (low risk)  | >10 records     | Always        |
| Type-to-confirm        | No             | >100 records    | >50 records   |
| Batch progress         | >10 rows       | Always          | Always        |
| Cancel mid-batch       | >10 rows       | Yes             | Yes           |

### Batches and transactions

INSERT, UPDATE and DELETE are sent as Web API `$batch` requests of **Batch Size** records (Settings, up to 1,000). Each batch is one transaction: it is committed completely or not at all. If a batch fails, the run stops and the error names the batch and the failing record; earlier batches stay committed. For up to 1,000 records the confirmation dialog offers **All or nothing**, which runs every record in one transaction. Older Power Platform ToolBox versions without batch support write one record per request.

UPDATE and DELETE first look up every matching record, page by page, and show how many they have found; you can cancel the lookup. One statement can change at most **Max records per statement** records (Settings, default 100,000, up to 1,000,000). A statement that matches more is rejected before anything is changed: narrow the WHERE clause and run it in parts, or raise the setting.

### Query hints

INSERT, UPDATE and DELETE accept SQL 4 CDS-style hints in a trailing `OPTION` clause:

```sql
UPDATE account SET description = 'migrated' WHERE statecode = 0
OPTION (USE HINT('BYPASS_CUSTOM_PLUGIN_EXECUTION', 'BATCH_SIZE_200'))
```

| Hint | Effect |
|------|--------|
| `BYPASS_CUSTOM_PLUGIN_EXECUTION` | Skips custom synchronous plugins and workflows (`MSCRM.BypassCustomPluginExecution` header). Needs the `prvBypassCustomPlugins` privilege, which only System Administrators have by default. Power Platform ToolBox asks you once to allow the header. A statement that bypasses plugins always asks for confirmation, INSERT included. |
| `BATCH_SIZE_<n>` | Records per batch for this statement (1–1,000), instead of the Batch Size setting. |

To bypass plugins on every statement, turn on **Bypass custom plugins on Insert/Update/Delete** in the settings; each statement still asks for confirmation.

Other hints are rejected with an error. `CONTINUE_ON_ERROR` isn't supported, because every batch runs as a transaction.

---

## Examples

```sql
-- Query active accounts, most valuable first
SELECT TOP 10 name, revenue FROM account WHERE statecode = 0 ORDER BY revenue DESC

-- Join contacts to their parent account
SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid

-- Count accounts by status
SELECT statecode, COUNT(accountid) FROM account GROUP BY statecode

-- Account names used more than once
SELECT name, COUNT(*) AS cnt FROM account GROUP BY name HAVING COUNT(*) > 1 ORDER BY cnt DESC

-- Insert a record
INSERT INTO account (name, revenue) VALUES ('Contoso Ltd', 50000)

-- Insert multiple records
INSERT INTO account (name, revenue) VALUES ('Contoso Ltd', 50000), ('Fabrikam', 75000)

-- Update inactive accounts
UPDATE account SET revenue = 0 WHERE statecode = 1

-- Delete inactive contacts
DELETE FROM contact WHERE statecode = 1
```

---

## Working with other tools

**Send FetchXML to another tool.** When an installed tool accepts FetchXML (it declares the `fetchxml` capability, e.g. FetchXML Studio, Data Migrator or Bulk Data Studio), the FetchXML tab shows **Open in &lt;tool&gt;**, or **Send to** with a list when there are several. The tool opens with the generated FetchXML and the same connection. Forge SQL sends it as `fetchXml` and `fetchxml` (tools use either key) plus `entityLogicalName`.

**Open Forge SQL from another tool.** Launch `pptb-forge-sql` with a `sql` prefill; the query replaces the sample query in the first tab. It isn't run automatically. Forge SQL doesn't return data to the caller, so launch it with `noReturn: true`:

```ts
await toolboxAPI.invocation.launchTool('pptb-forge-sql', { sql: 'SELECT TOP 10 name FROM account' }, { noReturn: true });
```

---

## Use from AI agents (MCP)

Forge SQL can be called by MCP clients such as Claude Code, Claude Desktop or VS Code through the Power Platform ToolBox MCP server. Agents can run **SELECT only**: INSERT, UPDATE and DELETE are rejected, because they need the preview and confirmation of the tool window. Queries run headless (no window opens) against a saved ToolBox connection that you pick.

1. In Power Platform ToolBox, open the **MCP Server** page and start the server. Note the address and the `X-MCP-Auth-Token` value.
2. Connect your client. Claude Desktop and VS Code can be set up from that page; for Claude Code:

    ```bash
    claude mcp add --transport http pptb http://127.0.0.1:7339/mcp --header "X-MCP-Auth-Token: <token>"
    ```

3. Ask the agent to query Dataverse. It lists your connections (`pptb_list_connections`), asks which one to use, signs in if needed, and calls the `forge-sql` tool.

Tool input:

| Parameter | Required | Description                                                     |
| --------- | -------- | --------------------------------------------------------------- |
| `sql`     | yes      | A single SELECT statement                                       |
| `maxRows` | no       | Maximum rows to return (default 500, at most 5000)              |

The result contains `status`, `rows` (only the result columns, with nulls filled in), `columns`, `rowCount`, `moreRecords`, the generated `fetchXml`, a `summary` and `executionTimeMs`, or `error` when the query fails. Only the first page from Dataverse (up to 5,000 rows) is read; `moreRecords` tells the agent to narrow the query or use `TOP`.

---

## Installation

```bash
npm install
npm run build
```

Once built, install the tool in Power Platform Toolbox and load it from the ToolBox interface.

---

## Development

```bash
# Start dev server with hot module replacement
npm run dev

# Production build
npm run build

# Preview production build
npm run preview

# Run tests
npm run test
```

The test suite covers the SQL parser and FetchXML generator (203 tests across SELECT and DML).

---

## AI Assistance

Parts of this tool were generated with Claude Code and reviewed, tested, and maintained by the contributors listed in package.json.

---

## License

MIT
