import type { SelectStatement } from './types';

// OData annotation suffixes → clean column name suffixes
const ANNOTATION_MAP: [RegExp, string][] = [
    [/@OData\.Community\.Display\.V1\.FormattedValue$/, '_formatted'],
    [/@Microsoft\.Dynamics\.CRM\.lookuplogicalname$/, '_type'],
    [/@Microsoft\.Dynamics\.CRM\.associatednavigationproperty$/, '_nav'],
];

const LOOKUP_VALUE_PATTERN = /^_(.+)_value$/;

/**
 * Transform Dataverse result rows:
 * 1. Rename OData annotation keys to readable suffixes
 * 2. Expose lookup GUIDs under clean names:
 *    _ownerid_value           → also as ownerid
 *    _ownerid_value_formatted → also as owneridname (display name)
 * 3. Expose optionset labels under xxxname:
 *    action_formatted → also as actionname
 * 4. Drop pure metadata keys (@odata.etag)
 */
export function cleanRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    if (rows.length === 0) return rows;
    return rows.map((row) => {
        const cleaned: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(row)) {
            if (!key.includes('@')) {
                cleaned[key] = value;
                // _xxx_value → also expose as xxx (clean GUID alias)
                const lookupMatch = key.match(LOOKUP_VALUE_PATTERN);
                if (lookupMatch && !(lookupMatch[1] in cleaned)) {
                    cleaned[lookupMatch[1]] = value;
                }
                continue;
            }
            for (const [pattern, suffix] of ANNOTATION_MAP) {
                if (pattern.test(key)) {
                    const baseCol = key.replace(pattern, '');
                    cleaned[baseCol + suffix] = value;
                    if (suffix === '_formatted') {
                        // Lookup formatted: _userid_value_formatted → useridname
                        // Optionset formatted: action_formatted → actionname
                        const lookupMatch = baseCol.match(LOOKUP_VALUE_PATTERN);
                        const nameAlias = lookupMatch ? `${lookupMatch[1]}name` : `${baseCol}name`;
                        if (!(nameAlias in cleaned)) {
                            cleaned[nameAlias] = value;
                        }
                    }
                    break;
                }
            }
        }

        return cleaned;
    });
}

/**
 * Extract columns for display. When isSelectStar is true, hide the
 * derived alias columns (_formatted, _type, _nav, xxxname from lookups)
 * to reduce noise — users can request them explicitly if needed.
 */
export function extractColumns(rows: Record<string, unknown>[], isSelectStar = false): string[] {
    if (rows.length === 0) return [];
    const allKeys = Object.keys(rows[0]);
    if (!isSelectStar) return allKeys;
    // Hide derived alias columns and raw _xxx_value lookup keys — the clean
    // xxx / xxxname aliases are exposed instead.
    return allKeys.filter(
        (k) =>
            !k.endsWith('_formatted') &&
            !k.endsWith('_type') &&
            !k.endsWith('_nav') &&
            !LOOKUP_VALUE_PATTERN.test(k),
    );
}

/**
 * Derive the display columns from the original SELECT AST.
 * For `SELECT *`, returns null (meaning: show all columns from results).
 * For explicit columns, returns the list of requested names (including
 * virtual names like owneridname) so only those are displayed.
 */
export function getRequestedColumns(stmt: SelectStatement): string[] | null {
    const hasStar = stmt.columns.some((c) => !('function' in c) && c.column === '*' && !c.table);
    if (hasStar) return null; // SELECT * → show everything

    const fromRef = stmt.from.alias ?? stmt.from.table;
    // Map any join reference (table name or its alias) → the FetchXML link
    // alias that prefixes that entity's attributes in the result rows.
    const joinLinkAlias = new Map<string, string>();
    for (const j of stmt.joins) {
        const linkAlias = j.alias ?? j.table;
        joinLinkAlias.set(j.table, linkAlias);
        if (j.alias) joinLinkAlias.set(j.alias, linkAlias);
    }

    return stmt.columns.map((c) => {
        if ('function' in c) {
            // Aggregate: use alias or auto-generated name
            return c.alias ?? `${c.function.toLowerCase()}_${c.column.column === '*' ? 'all' : c.column.column}`;
        }
        if (c.alias) return c.alias;
        // Attributes from a joined entity come back prefixed with the link
        // alias (e.g. contact's `fullname` under join alias `c` → `c.fullname`).
        if (c.table && c.table !== stmt.from.table && c.table !== fromRef) {
            const linkAlias = joinLinkAlias.get(c.table);
            if (linkAlias) return `${linkAlias}.${c.column}`;
        }
        return c.column;
    });
}

/**
 * Resolve a single user-requested column name to an actual key in the result
 * data. Virtual names like "owneridname" are mapped to their Dataverse
 * annotation equivalents (e.g. _ownerid_value_formatted). Returns null when the
 * column can't be found in the returned rows.
 */
export function resolveColumnKey(col: string, availableColumns: string[], allKeys: string[]): string | null {
    if (availableColumns.includes(col)) {
        return col;
    }
    // Try virtual name resolution:
    // xxxname → _xxx_value_formatted  (lookup display name)
    // xxxname → xxx_formatted          (option set label)
    if (col.endsWith('name') && col.length > 4) {
        const base = col.slice(0, -4);
        const lookupFmt = `_${base}_value_formatted`;
        const optionFmt = `${base}_formatted`;
        if (allKeys.includes(lookupFmt)) return lookupFmt;
        if (allKeys.includes(optionFmt)) return optionFmt;
    }
    // xxxid → _xxxid_value (lookup GUID without _value suffix)
    const lookupVal = `_${col}_value`;
    if (allKeys.includes(lookupVal)) return lookupVal;
    // Not found
    return null;
}

export function resolveRequestedColumns(
    requested: string[],
    availableColumns: string[],
    sampleRow: Record<string, unknown>,
): string[] {
    const allKeys = Object.keys(sampleRow);
    const resolved: string[] = [];
    for (const col of requested) {
        const key = resolveColumnKey(col, availableColumns, allKeys);
        if (key) resolved.push(key);
    }
    return resolved;
}

/**
 * Requested `xxxname` columns that didn't resolve against the returned rows.
 * Dataverse silently ignores an unknown virtual attribute (e.g. `owneridname`)
 * rather than throwing 0x80041103, so the literal query returns rows but the
 * name column is absent. These need a rewrite to their base lookup/optionset.
 */
export function unresolvedVirtualColumns(
    requested: string[],
    availableColumns: string[],
    sampleRow: Record<string, unknown>,
): Set<string> {
    const allKeys = Object.keys(sampleRow);
    const set = new Set<string>();
    for (const col of requested) {
        if (col.length > 4 && col.endsWith('name') && resolveColumnKey(col, availableColumns, allKeys) === null) {
            set.add(col);
        }
    }
    return set;
}

/**
 * Rewrite virtual column names in a SelectStatement before FetchXML generation.
 * Dataverse doesn't have `xxxname` attributes — they are formatted values of
 * the base lookup/optionset column. This rewrites the AST so the correct base
 * column is requested in FetchXML, and the friendly alias appears in results
 * via the cleanRows annotation mapping.
 *
 * Examples:
 *   owneridname  → ownerid  (lookup display name)
 *   statuscodename → statuscode (optionset label)
 *
 * When `onlyColumns` is provided, only those exact column names are rewritten —
 * used to rewrite just the virtual names that failed to resolve, leaving real
 * `*name` attributes (e.g. `fullname`) untouched.
 */
export function rewriteVirtualColumns(stmt: SelectStatement, onlyColumns?: Set<string>): SelectStatement {
    let changed = false;
    const newColumns = stmt.columns.map((col) => {
        if ('function' in col) return col; // aggregate — skip
        if (col.column === '*') return col;
        const name = col.column;
        // If column ends with 'name' and is more than just 'name', strip it
        if (name.length > 4 && name.endsWith('name') && (!onlyColumns || onlyColumns.has(name))) {
            const base = name.slice(0, -4); // e.g. owneridname → ownerid
            changed = true;
            return { ...col, column: base };
        }
        return col;
    });
    return changed ? { ...stmt, columns: newColumns } : stmt;
}
