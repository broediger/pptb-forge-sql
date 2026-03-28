/**
 * Escapes a single CSV field value per RFC 4180.
 * Fields containing commas, double-quotes, or newlines are wrapped in double quotes.
 * Existing double-quote characters are escaped by doubling them ("").
 */
function escapeCsvField(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }

    let str: string;
    if (typeof value === 'object') {
        str = JSON.stringify(value);
    } else {
        str = String(value);
    }

    // Wrap in quotes if the value contains a comma, double-quote, newline, or carriage return
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
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
 * Exports query result data as a CSV file and triggers a browser download.
 *
 * The CSV is formatted per RFC 4180:
 * - First row is a header row using the provided column names.
 * - Fields containing commas, double-quotes, or newlines are wrapped in double quotes.
 * - Double-quote characters within field values are escaped by doubling them.
 *
 * @param data     Array of row objects to export.
 * @param columns  Ordered list of column names used for the header and row extraction.
 * @param filename Optional filename for the downloaded file. Defaults to "query-results.csv".
 */
export function exportToCsv(
    data: Record<string, unknown>[],
    columns: string[],
    filename = 'query-results.csv'
): void {
    const rows: string[] = [];

    // Header row
    rows.push(columns.map(escapeCsvField).join(','));

    // Data rows
    for (const row of data) {
        rows.push(columns.map((col) => escapeCsvField(row[col])).join(','));
    }

    // Join with CRLF per RFC 4180
    const csvContent = rows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, filename);
}

/**
 * Exports query result data as a formatted JSON file and triggers a browser download.
 *
 * @param data     Array of row objects to export.
 * @param filename Optional filename for the downloaded file. Defaults to "query-results.json".
 */
export function exportToJson(
    data: Record<string, unknown>[],
    filename = 'query-results.json'
): void {
    const jsonContent = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    triggerDownload(blob, filename);
}
