import type { JsonValueExpr, SelectStatement } from './types';
import { isColumnRef, isJsonValueExpr } from './types';

// ── JSON path parsing (T-SQL JSON_VALUE subset) ──
//
// Supported: optional `lax` / `strict` mode prefix, `$`, `.key`, `."quoted key"`,
// and `[n]` array indexes. Evaluation is always lax: a missing property, an
// out-of-range index, invalid JSON or a non-scalar result yields NULL.

export type JsonPathStep = { type: 'key'; key: string } | { type: 'index'; index: number };

export class JsonPathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JsonPathError';
    }
}

export function parseJsonPath(path: string): JsonPathStep[] {
    let rest = path.trim();
    const modeMatch = rest.match(/^(lax|strict)\s+/i);
    if (modeMatch) rest = rest.slice(modeMatch[0].length);

    if (!rest.startsWith('$')) {
        throw new JsonPathError(`JSON path must start with '$' (got '${path}')`);
    }

    const steps: JsonPathStep[] = [];
    let pos = 1;
    while (pos < rest.length) {
        const ch = rest[pos];
        if (ch === '.') {
            pos++;
            if (rest[pos] === '"') {
                // Quoted key: ."key with spaces" — backslash escapes the next char
                pos++;
                let key = '';
                while (pos < rest.length && rest[pos] !== '"') {
                    if (rest[pos] === '\\' && pos + 1 < rest.length) pos++;
                    key += rest[pos++];
                }
                if (rest[pos] !== '"') throw new JsonPathError(`Unterminated quoted key in JSON path '${path}'`);
                pos++;
                steps.push({ type: 'key', key });
            } else {
                const m = rest.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
                if (!m) throw new JsonPathError(`Expected property name at position ${pos} in JSON path '${path}'`);
                pos += m[0].length;
                steps.push({ type: 'key', key: m[0] });
            }
        } else if (ch === '[') {
            const m = rest.slice(pos).match(/^\[\s*(\d+)\s*\]/);
            if (!m) throw new JsonPathError(`Expected array index at position ${pos} in JSON path '${path}'`);
            pos += m[0].length;
            steps.push({ type: 'index', index: Number(m[1]) });
        } else {
            throw new JsonPathError(`Unexpected '${ch}' at position ${pos} in JSON path '${path}'`);
        }
    }
    return steps;
}

/**
 * Evaluate a JSON path against a raw column value (JSON text). Returns the
 * scalar at the path, or null when the text isn't valid JSON, the path doesn't
 * exist, or it points at an object/array (matching T-SQL lax JSON_VALUE).
 */
export function evaluateJsonValue(raw: unknown, steps: JsonPathStep[]): string | number | boolean | null {
    if (typeof raw !== 'string') return null;
    let current: unknown;
    try {
        current = JSON.parse(raw);
    } catch {
        return null;
    }
    for (const step of steps) {
        if (step.type === 'key') {
            if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
            current = (current as Record<string, unknown>)[step.key];
        } else {
            if (!Array.isArray(current)) return null;
            current = current[step.index];
        }
        if (current === undefined) return null;
    }
    if (current === null || typeof current === 'object') return null;
    return current as string | number | boolean;
}

// ── Mapping JSON_VALUE select expressions onto result rows ──

export interface JsonValueColumn {
    /** Result column name the extracted value is written to. */
    name: string;
    /** Row key holding the raw JSON text (e.g. `col` or `<link alias>.col`). */
    sourceKey: string;
    steps: JsonPathStep[];
}

/**
 * Row key under which Dataverse returns the underlying column: plain for the
 * FROM entity, `<link alias>.<column>` for a joined entity.
 */
function sourceKeyFor(expr: JsonValueExpr, stmt: SelectStatement): string {
    const { table, column } = expr.column;
    const fromRef = stmt.from.alias ?? stmt.from.table;
    if (table && table !== stmt.from.table && table !== fromRef) {
        const join = stmt.joins.find((j) => j.alias === table || j.table === table);
        if (join) return `${join.alias ?? join.table}.${column}`;
    }
    return column;
}

/**
 * Resolve every JSON_VALUE in the SELECT list to an output column name and the
 * row key of its source column. Without an alias, the name is the last
 * property in the path (e.g. `$.a.vatTreatment` → `vatTreatment`), suffixed
 * with `_2`, `_3`, … if it would collide with another selected column.
 *
 * With a `*` in the SELECT list the returned attribute names aren't known
 * up front, so unaliased names get a `json_` prefix (`json_vatTreatment`)
 * to avoid silently overwriting a real attribute such as `name`.
 */
export function getJsonValueColumns(stmt: SelectStatement): JsonValueColumn[] {
    const hasWildcard = stmt.columns.some((c) => isColumnRef(c) && c.column === '*');
    const taken = new Set<string>();
    for (const c of stmt.columns) {
        if (isJsonValueExpr(c)) {
            if (c.alias) taken.add(c.alias);
        } else if (isColumnRef(c)) {
            taken.add(c.alias ?? c.column);
        } else if (c.alias) {
            taken.add(c.alias);
        }
    }

    const result: JsonValueColumn[] = [];
    for (const c of stmt.columns) {
        if (!isJsonValueExpr(c)) continue;
        const steps = parseJsonPath(c.path);
        let name = c.alias;
        if (!name) {
            const lastKey = [...steps].reverse().find((s) => s.type === 'key');
            const key = lastKey && lastKey.type === 'key' ? lastKey.key : 'value';
            const base = hasWildcard || !lastKey ? `json_${key}` : key;
            name = base;
            for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
            taken.add(name);
        }
        result.push({ name, sourceKey: sourceKeyFor(c, stmt), steps });
    }
    return result;
}

export function applyJsonValues(
    rows: Record<string, unknown>[],
    jsonColumns: JsonValueColumn[],
): Record<string, unknown>[] {
    if (jsonColumns.length === 0) return rows;
    return rows.map((row) => {
        const out = { ...row };
        for (const jc of jsonColumns) {
            out[jc.name] = evaluateJsonValue(row[jc.sourceKey], jc.steps);
        }
        return out;
    });
}
