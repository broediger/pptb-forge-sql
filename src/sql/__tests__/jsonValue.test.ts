import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { generateFetchXml } from '../generator';
import { SqlParseError, type SelectStatement } from '../types';
import { parseJsonPath, evaluateJsonValue, getJsonValueColumns, applyJsonValues } from '../jsonValue';
import { cleanRows, extractColumns, getRequestedColumns, resolveRequestedColumns } from '../columnResolution';

const parseSelect = (sql: string): SelectStatement => {
    const stmt = parse(tokenize(sql));
    if (stmt.type !== 'select') throw new Error('expected a SELECT statement');
    return stmt;
};

const strip = (xml: string) => xml.replace(/\s+/g, ' ').trim();

const LEAD_JSON = JSON.stringify({
    Lead: {
        businessCustomerId: '1000252999',
        priceInfoFlag: false,
        type3PowerOfAttorney: [],
        meteringPoints: [
            {
                meteringPointId: 'AT0020000000000000000000100413733',
                greenPowerData: { shortageCapacity: '5', vatTreatment: 'Privat (0%)', energyCommunityFlag: false },
            },
        ],
        products: [{ productId: 'SE0001' }],
        billingInformation: { bankDetails: { IBAN: 'AT803293700000053710' } },
    },
});

const USER_QUERY = `select JSON_VALUE(logs.orb_jsonxmlcontent, '$.Lead.meteringPoints[0].greenPowerData.vatTreatment') as vatTreatment
from orb_automatelogs logs
where orb_primaryregardingguid = '2613f52e-5eb6-f111-aaab-7c1e52280e55' and orb_automatename = 'ImportLead'`;

describe('parseJsonPath', () => {
    it('parses keys and array indexes', () => {
        expect(parseJsonPath('$.Lead.meteringPoints[0].greenPowerData')).toEqual([
            { type: 'key', key: 'Lead' },
            { type: 'key', key: 'meteringPoints' },
            { type: 'index', index: 0 },
            { type: 'key', key: 'greenPowerData' },
        ]);
    });

    it('accepts the root path, quoted keys and a lax/strict prefix', () => {
        expect(parseJsonPath('$')).toEqual([]);
        expect(parseJsonPath('$."first name"')).toEqual([{ type: 'key', key: 'first name' }]);
        expect(parseJsonPath('lax $.a')).toEqual([{ type: 'key', key: 'a' }]);
        expect(parseJsonPath('strict $.a')).toEqual([{ type: 'key', key: 'a' }]);
    });

    it('rejects malformed paths', () => {
        expect(() => parseJsonPath('Lead.x')).toThrow(/must start with '\$'/);
        expect(() => parseJsonPath('$.')).toThrow(/property name/);
        expect(() => parseJsonPath('$[x]')).toThrow(/array index/);
        expect(() => parseJsonPath('$."open')).toThrow(/Unterminated/);
    });
});

describe('evaluateJsonValue', () => {
    const at = (path: string) => evaluateJsonValue(LEAD_JSON, parseJsonPath(path));

    it('extracts nested scalars through arrays', () => {
        expect(at('$.Lead.meteringPoints[0].greenPowerData.vatTreatment')).toBe('Privat (0%)');
        expect(at('$.Lead.billingInformation.bankDetails.IBAN')).toBe('AT803293700000053710');
        expect(at('$.Lead.products[0].productId')).toBe('SE0001');
    });

    it('returns false/number scalars as-is', () => {
        expect(at('$.Lead.priceInfoFlag')).toBe(false);
        expect(evaluateJsonValue('{"n":5}', parseJsonPath('$.n'))).toBe(5);
    });

    it('returns null for objects, arrays and missing paths (lax semantics)', () => {
        expect(at('$.Lead.meteringPoints')).toBeNull();
        expect(at('$.Lead.billingInformation')).toBeNull();
        expect(at('$.Lead.nope')).toBeNull();
        expect(at('$.Lead.meteringPoints[5].greenPowerData')).toBeNull();
        expect(at('$.Lead[0]')).toBeNull();
    });

    it('returns null for invalid JSON and non-string input', () => {
        expect(evaluateJsonValue('<xml/>', parseJsonPath('$.a'))).toBeNull();
        expect(evaluateJsonValue(null, parseJsonPath('$.a'))).toBeNull();
        expect(evaluateJsonValue(undefined, parseJsonPath('$.a'))).toBeNull();
    });
});

describe('JSON_VALUE parsing', () => {
    it('parses JSON_VALUE with an alias', () => {
        const stmt = parseSelect(USER_QUERY);
        expect(stmt.columns).toEqual([
            {
                kind: 'json_value',
                column: { table: 'logs', column: 'orb_jsonxmlcontent' },
                path: '$.Lead.meteringPoints[0].greenPowerData.vatTreatment',
                alias: 'vatTreatment',
            },
        ]);
    });

    it('is case-insensitive and can be mixed with other columns', () => {
        const stmt = parseSelect("SELECT name, json_value(data, '$.a') FROM account");
        expect(stmt.columns[0]).toEqual({ column: 'name' });
        expect(stmt.columns[1]).toEqual({ kind: 'json_value', column: { column: 'data' }, path: '$.a' });
    });

    it('rejects an invalid path at parse time', () => {
        expect(() => parseSelect("SELECT JSON_VALUE(data, 'a.b') FROM account")).toThrow(SqlParseError);
    });

    it('rejects a non-string path', () => {
        expect(() => parseSelect('SELECT JSON_VALUE(data, other) FROM account')).toThrow(/JSON path string/);
    });

    it('rejects JSON_VALUE in WHERE', () => {
        expect(() => parseSelect("SELECT name FROM account WHERE JSON_VALUE(data, '$.a') = 'x'")).toThrow(
            /only supported in the SELECT list/,
        );
    });

    it('still treats json_value as a plain column name when not called', () => {
        const stmt = parseSelect('SELECT json_value FROM account');
        expect(stmt.columns[0]).toEqual({ column: 'json_value' });
    });
});

describe('JSON_VALUE FetchXML generation', () => {
    it('fetches the underlying column', () => {
        const xml = strip(generateFetchXml(parseSelect(USER_QUERY)));
        expect(xml).toContain('<entity name="orb_automatelogs"> <attribute name="orb_jsonxmlcontent" />');
        expect(xml).not.toContain('vatTreatment');
    });

    it('fetches a shared source column only once', () => {
        const xml = generateFetchXml(
            parseSelect("SELECT data, JSON_VALUE(data, '$.a'), JSON_VALUE(data, '$.b') FROM account"),
        );
        expect(xml.match(/attribute name="data"/g)).toHaveLength(1);
    });

    it('fetches a joined source column inside its link-entity', () => {
        const xml = strip(
            generateFetchXml(
                parseSelect(
                    "SELECT a.name, JSON_VALUE(c.data, '$.x') FROM account a JOIN contact c ON a.primarycontactid = c.contactid",
                ),
            ),
        );
        expect(xml).toContain('link-type="inner" alias="c"> <attribute name="data" /> </link-entity>');
    });

    it('rejects ORDER BY on a JSON_VALUE alias or generated name', () => {
        expect(() =>
            generateFetchXml(parseSelect("SELECT JSON_VALUE(data, '$.vat') AS vat FROM account ORDER BY vat")),
        ).toThrow(/ORDER BY on the JSON_VALUE column 'vat'/);
        expect(() =>
            generateFetchXml(
                parseSelect("SELECT JSON_VALUE(data, '$.a.vatTreatment') FROM account ORDER BY vattreatment DESC"),
            ),
        ).toThrow(/not supported/);
    });

    it('still allows ORDER BY on a real column alongside JSON_VALUE', () => {
        const xml = generateFetchXml(parseSelect("SELECT name, JSON_VALUE(data, '$.name') FROM account ORDER BY name"));
        expect(strip(xml)).toContain('<order attribute="name" />');
    });

    it('rejects aggregates, GROUP BY and DISTINCT', () => {
        expect(() => generateFetchXml(parseSelect("SELECT JSON_VALUE(data, '$.a'), COUNT(*) FROM account"))).toThrow(
            /aggregates/,
        );
        expect(() =>
            generateFetchXml(parseSelect("SELECT name, JSON_VALUE(data, '$.a') FROM account GROUP BY name")),
        ).toThrow(/GROUP BY/);
        expect(() => generateFetchXml(parseSelect("SELECT DISTINCT JSON_VALUE(data, '$.a') FROM account"))).toThrow(
            /DISTINCT/,
        );
    });
});

describe('JSON_VALUE column resolution', () => {
    it('names unaliased results after the last path key, de-duplicated', () => {
        const stmt = parseSelect(
            "SELECT id, JSON_VALUE(data, '$.x.id'), JSON_VALUE(data, '$.y.id'), JSON_VALUE(data, '$[0]') FROM account",
        );
        expect(getJsonValueColumns(stmt).map((c) => c.name)).toEqual(['id_2', 'id_3', 'json_value']);
        expect(getRequestedColumns(stmt)).toEqual(['id', 'id_2', 'id_3', 'json_value']);
    });

    it('prefixes unaliased names with json_ under SELECT * so real attributes are not overwritten', () => {
        const stmt = parseSelect("SELECT *, JSON_VALUE(data, '$.name'), JSON_VALUE(data, '$.x') AS name2 FROM account");
        expect(getJsonValueColumns(stmt).map((c) => c.name)).toEqual(['json_name', 'name2']);

        const rows = applyJsonValues([{ name: 'Contoso', data: '{"name":"from json"}' }], getJsonValueColumns(stmt));
        expect(rows[0].name).toBe('Contoso');
        expect(rows[0].json_name).toBe('from json');
    });

    it('reads joined source columns from their link-alias key', () => {
        const stmt = parseSelect(
            "SELECT JSON_VALUE(c.data, '$.x') FROM account a JOIN contact c ON a.primarycontactid = c.contactid",
        );
        expect(getJsonValueColumns(stmt)[0].sourceKey).toBe('c.data');
    });

    it('end to end: extracts vatTreatment and shows only the requested column', () => {
        const stmt = parseSelect(USER_QUERY);
        const jsonColumns = getJsonValueColumns(stmt);
        const rows = applyJsonValues(
            cleanRows([
                { '@odata.etag': 'W/"1"', orb_automatelogid: 'guid-1', orb_jsonxmlcontent: LEAD_JSON },
                { '@odata.etag': 'W/"2"', orb_automatelogid: 'guid-2' }, // null memo omitted by Dataverse
            ]),
            jsonColumns,
        );
        const requested = getRequestedColumns(stmt)!;
        const columns = resolveRequestedColumns(requested, extractColumns(rows), rows);

        expect(columns).toEqual(['vatTreatment']);
        expect(rows.map((r) => r.vatTreatment)).toEqual(['Privat (0%)', null]);
    });
});
