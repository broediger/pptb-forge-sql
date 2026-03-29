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
];

/** Extract the primary table name from a FROM clause in SQL text. */
function extractFromTableName(sqlText: string): string | null {
    const match = sqlText.match(/\bFROM\s+(\w+)/i);
    return match ? match[1] : null;
}

/**
 * Returns true when the cursor is in a position where attribute/column names
 * are appropriate: SELECT list, after WHERE, ON, ORDER BY, GROUP BY.
 */
function isColumnContext(linePrefix: string): boolean {
    // After ORDER BY or GROUP BY (with optional trailing words/commas)
    if (/\b(?:ORDER\s+BY|GROUP\s+BY)[\w\s,.*]*$/i.test(linePrefix)) {
        return true;
    }
    // After WHERE or ON with any trailing expression text
    if (/\b(?:WHERE|ON)\b.*$/i.test(linePrefix)) {
        return true;
    }
    // After SELECT (including trailing words, commas, spaces, * and .)
    if (/\bSELECT\b[\w\s,.*]*$/i.test(linePrefix)) {
        return true;
    }
    return false;
}

/**
 * Returns true when the cursor directly follows FROM or JOIN, expecting a
 * table/entity name next.
 */
function isTableContext(linePrefix: string): boolean {
    return /\b(?:FROM|JOIN)\s+\w*$/i.test(linePrefix);
}

export function createSqlCompletionProvider(): monaco.languages.CompletionItemProvider {
    return {
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

            // Text before the cursor on the current line
            const linePrefix = model.getLineContent(position.lineNumber).substring(0, position.column - 1);

            // Full SQL text before the cursor for FROM clause detection
            const fullTextBeforeCursor = model.getValueInRange({
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
            });

            const store = useSchemaStore.getState();

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

            // ── Column/attribute context ──────────────────────────────────────
            if (isColumnContext(linePrefix)) {
                const tableName = extractFromTableName(fullTextBeforeCursor);

                if (tableName) {
                    // Fire-and-forget: load attributes if not yet cached.
                    // The provider will surface results once available on the
                    // next trigger (e.g. the next keystroke).
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

                // Attributes not yet loaded — fall through to keyword suggestions
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
