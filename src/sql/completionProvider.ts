import type * as monaco from 'monaco-editor';
import { useSchemaStore } from '../stores/schemaStore';

// CompletionItemKind numeric values from monaco-editor enum
// Keyword = 17, Class = 5, Field = 3
const KIND_KEYWORD = 17 as monaco.languages.CompletionItemKind;
const KIND_CLASS = 5 as monaco.languages.CompletionItemKind;
const KIND_FIELD = 3 as monaco.languages.CompletionItemKind;

const SQL_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'JOIN',
    'ORDER BY',
    'GROUP BY',
    'HAVING',
    'DISTINCT',
    'TOP',
    'AND',
    'OR',
    'NOT',
    'IN',
    'LIKE',
    'BETWEEN',
    'IS',
    'NULL',
    'LEFT',
    'INNER',
    'RIGHT',
    'ON',
    'AS',
    'ASC',
    'DESC',
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'INSERT',
    'INTO',
    'VALUES',
    'UPDATE',
    'SET',
    'DELETE',
];

/** Extract the primary table name from a FROM clause in SQL text. */
function extractFromTableName(sqlText: string): string | null {
    const match = sqlText.match(/\bFROM\s+(\w+)/i);
    return match ? match[1] : null;
}

/** Extract all table aliases: { alias → tableName } from "FROM table alias" and "JOIN table alias" */
function extractAliases(sqlText: string): Map<string, string> {
    const map = new Map<string, string>();
    // Match FROM/JOIN table [AS] alias patterns
    const re = /\b(?:FROM|JOIN)\s+(\w+)\s+(?:AS\s+)?(\w+)/gi;
    let m;
    while ((m = re.exec(sqlText)) !== null) {
        map.set(m[2].toLowerCase(), m[1].toLowerCase());
    }
    return map;
}

/**
 * Returns true when the cursor is in a position where attribute/column names
 * are appropriate: SELECT list, after WHERE, ON, ORDER BY, GROUP BY, SET.
 */
function isColumnContext(linePrefix: string): boolean {
    if (/\b(?:ORDER\s+BY|GROUP\s+BY)[\w\s,.*]*$/i.test(linePrefix)) return true;
    if (/\b(?:WHERE|ON|SET)\b.*$/i.test(linePrefix)) return true;
    if (/\bSELECT\b[\w\s,.*]*$/i.test(linePrefix)) return true;
    return false;
}

/**
 * Returns true when the cursor directly follows FROM or JOIN, expecting a
 * table/entity name next.
 */
function isTableContext(linePrefix: string): boolean {
    return /\b(?:FROM|JOIN)\s+\w*$/i.test(linePrefix);
}

/**
 * Check if cursor is right after a dot (e.g. "account." or "a.na")
 * Returns the prefix before the dot if so, otherwise null.
 */
function getDotPrefix(linePrefix: string): string | null {
    const match = linePrefix.match(/\b(\w+)\.\w*$/);
    return match ? match[1] : null;
}

export function createSqlCompletionProvider(): monaco.languages.CompletionItemProvider {
    return {
        triggerCharacters: ['.', ' '],

        provideCompletionItems(
            model: monaco.editor.ITextModel,
            position: monaco.Position,
        ): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
            const wordInfo = model.getWordUntilPosition(position);
            const range: monaco.IRange = {
                startLineNumber: position.lineNumber,
                startColumn: wordInfo.startColumn,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
            };

            const linePrefix = model.getLineContent(position.lineNumber).substring(0, position.column - 1);

            const fullText = model.getValue();
            const fullTextBeforeCursor = model.getValueInRange({
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
            });

            const store = useSchemaStore.getState();

            // ── Dot context: "account." or "a." → suggest attributes ─────────
            const dotPrefix = getDotPrefix(linePrefix);
            if (dotPrefix) {
                // Resolve the prefix: could be a table name or an alias
                const aliases = extractAliases(fullText);
                const resolvedTable = aliases.get(dotPrefix.toLowerCase()) ?? dotPrefix.toLowerCase();

                // Load attributes if not cached
                void store.loadAttributes(resolvedTable);
                const attrs = store.attributes.get(resolvedTable);

                if (attrs && attrs.length > 0) {
                    const suggestions: monaco.languages.CompletionItem[] = attrs.map((attr) => ({
                        label: attr.logicalName,
                        kind: KIND_FIELD,
                        insertText: attr.logicalName,
                        detail: `${attr.displayName} (${attr.attributeType})`,
                        range,
                    }));
                    return { suggestions };
                }

                // Attributes loading — return empty for now, next keystroke will have them
                return { suggestions: [] };
            }

            // ── Table/entity context: right after FROM or JOIN ────────────────
            if (isTableContext(linePrefix)) {
                const suggestions: monaco.languages.CompletionItem[] = store.entities.map((entity) => ({
                    label: entity.logicalName,
                    kind: KIND_CLASS,
                    insertText: entity.logicalName,
                    detail: entity.displayName,
                    range,
                }));
                return { suggestions };
            }

            // ── Column/attribute context (no dot prefix) ──────────────────────
            if (isColumnContext(linePrefix)) {
                const tableName = extractFromTableName(fullTextBeforeCursor);

                if (tableName) {
                    void store.loadAttributes(tableName);
                    const attrs = store.attributes.get(tableName);

                    if (attrs && attrs.length > 0) {
                        const suggestions: monaco.languages.CompletionItem[] = attrs.map((attr) => ({
                            label: attr.logicalName,
                            kind: KIND_FIELD,
                            insertText: attr.logicalName,
                            detail: `${attr.displayName} (${attr.attributeType})`,
                            range,
                        }));
                        return { suggestions };
                    }
                }
            }

            // ── Default: SQL keywords ─────────────────────────────────────────
            const suggestions: monaco.languages.CompletionItem[] = SQL_KEYWORDS.map((keyword) => ({
                label: keyword,
                kind: KIND_KEYWORD,
                insertText: keyword,
                detail: 'SQL keyword',
                range,
            }));

            return { suggestions };
        },
    };
}
