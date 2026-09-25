export type CsvDelimiter = ',' | ';';

/**
 * Escapes a single CSV field value per RFC 4180.
 * Fields containing the delimiter, double-quotes, or newlines are wrapped in double quotes.
 * Existing double-quote characters are escaped by doubling them ("").
 * With a semicolon delimiter, numbers use a decimal comma (1.5 → 1,5), matching
 * the regional Excel convention semicolon CSVs are meant for; otherwise Excel
 * would read 1.5 as a date or text.
 */
function escapeCsvField(value: unknown, delimiter: CsvDelimiter): string {
    if (value === null || value === undefined) {
        return '';
    }

    let str: string;
    if (typeof value === 'number' && delimiter === ';') {
        str = String(value).replace('.', ',');
    } else if (typeof value === 'object') {
        str = JSON.stringify(value);
    } else {
        str = String(value);
    }

    // Wrap in quotes if the value contains the delimiter, double-quote, newline, or carriage return
    if (str.includes('"') || str.includes(delimiter) || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }

    return str;
}

/**
 * Triggers a file download in the browser by creating a temporary anchor element,
 * clicking it, and revoking the object URL afterward.
 */
function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Revoke after a short delay to allow the browser to initiate the download
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * Serializes query result data as CSV, formatted per RFC 4180:
 * - First row is a header row using the provided column names.
 * - Fields containing the delimiter, double-quotes, or newlines are wrapped in double quotes.
 * - Double-quote characters within field values are escaped by doubling them.
 * - Rows are separated by CRLF.
 *
 * @param data      Array of row objects to export.
 * @param columns   Ordered list of column names used for the header and row extraction.
 * @param delimiter Field separator. Semicolon also switches numbers to a decimal comma, for
 *                  Excel in locales that use one.
 */
export function toCsv(data: Record<string, unknown>[], columns: string[], delimiter: CsvDelimiter = ','): string {
    const rows: string[] = [];

    // Header row
    rows.push(columns.map((col) => escapeCsvField(col, delimiter)).join(delimiter));

    // Data rows
    for (const row of data) {
        rows.push(columns.map((col) => escapeCsvField(row[col], delimiter)).join(delimiter));
    }

    return rows.join('\r\n');
}

/**
 * Exports query result data as a CSV file and triggers a browser download.
 *
 * @param data      Array of row objects to export.
 * @param columns   Ordered list of column names used for the header and row extraction.
 * @param delimiter Field separator. Defaults to a comma.
 * @param filename  Optional filename for the downloaded file. Defaults to "query-results.csv".
 */
export function exportToCsv(
    data: Record<string, unknown>[],
    columns: string[],
    delimiter: CsvDelimiter = ',',
    filename = 'query-results.csv',
): void {
    // UTF-8 BOM so Excel detects the encoding instead of garbling accented characters
    const blob = new Blob(['\uFEFF' + toCsv(data, columns, delimiter)], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, filename);
}

/**
 * Exports query result data as a formatted JSON file and triggers a browser download.
 *
 * @param data     Array of row objects to export.
 * @param filename Optional filename for the downloaded file. Defaults to "query-results.json".
 */
export function exportToJson(data: Record<string, unknown>[], filename = 'query-results.json'): void {
    const jsonContent = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    triggerDownload(blob, filename);
}
