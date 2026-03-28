# Forge SQL

Write and execute SQL against Dataverse — SELECT, INSERT, UPDATE, and DELETE. Translates to FetchXML and Web API calls, with a Monaco-powered editor, schema autocomplete, and built-in safeguards for destructive operations.

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

---

## Examples

```sql
-- Query active accounts, most valuable first
SELECT TOP 10 name, revenue FROM account WHERE statecode = 0 ORDER BY revenue DESC

-- Join contacts to their parent account
SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid

-- Count accounts by status
SELECT statecode, COUNT(accountid) FROM account GROUP BY statecode

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

## License

MIT
