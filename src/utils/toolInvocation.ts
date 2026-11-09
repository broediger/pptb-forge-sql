// Inter-tool invocation (#38): send the generated FetchXML to other PPTB tools,
// and open SQL that another tool passed to Forge SQL.

/** An installed tool that accepts FetchXML. */
export interface ToolChoice {
    id: string;
    name: string;
}

/**
 * Prefill for tools with the `fetchxml` capability. The tools don't agree on
 * the key: FetchXML Studio reads `fetchXml`, Data Migrator and Bulk Data
 * Studio read `fetchxml`, so both are sent. `entityLogicalName` is the root
 * entity, which FetchXML Studio also accepts.
 */
export function fetchXmlPrefill(fetchXml: string): Record<string, unknown> {
    const entity = /<entity\b[^>]*\bname\s*=\s*["']([^"']+)["']/i.exec(fetchXml)?.[1];
    return { fetchXml, fetchxml: fetchXml, ...(entity ? { entityLogicalName: entity } : {}) };
}

/**
 * Tools from `findToolsByCapability`, which returns untyped manifests. Keeps
 * entries with an id, drops duplicates and sorts by name.
 */
export function toToolChoices(tools: unknown): ToolChoice[] {
    if (!Array.isArray(tools)) return [];
    const byId = new Map<string, ToolChoice>();
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        const { id, name, displayName } = tool as { id?: unknown; name?: unknown; displayName?: unknown };
        if (typeof id !== 'string' || !id) continue;
        const label = [displayName, name].find((v): v is string => typeof v === 'string' && v.trim() !== '');
        if (!byId.has(id)) byId.set(id, { id, name: label?.trim() ?? id });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** SQL from the launch context another tool opened Forge SQL with, if any. */
export function sqlFromLaunchContext(context: unknown): string | null {
    if (!context || typeof context !== 'object') return null;
    const sql = (context as { sql?: unknown }).sql;
    return typeof sql === 'string' && sql.trim() ? sql.trim() : null;
}
