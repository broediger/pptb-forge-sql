import { describe, it, expect } from 'vitest';
import { fetchXmlPrefill, sqlFromLaunchContext, toToolChoices } from '../toolInvocation';

describe('fetchXmlPrefill', () => {
    it('sends the FetchXML under both keys plus the root entity', () => {
        const xml = '<fetch top="10"><entity name="account"><attribute name="name" /></entity></fetch>';
        expect(fetchXmlPrefill(xml)).toEqual({ fetchXml: xml, fetchxml: xml, entityLogicalName: 'account' });
    });

    it('takes the root entity, not a link-entity', () => {
        const xml =
            "<fetch><entity name='opportunity'><link-entity name='account' from='accountid' to='parentaccountid' /></entity></fetch>";
        expect(fetchXmlPrefill(xml).entityLogicalName).toBe('opportunity');
    });

    it('leaves out the entity when there is none', () => {
        expect(fetchXmlPrefill('<fetch />')).toEqual({ fetchXml: '<fetch />', fetchxml: '<fetch />' });
    });
});

describe('toToolChoices', () => {
    it('keeps tools with an id, prefers the display name, sorts by name', () => {
        expect(
            toToolChoices([
                { id: '@b/tool', name: 'Zeta Tool' },
                { id: '@a/tool', name: 'pptb-a', displayName: 'Alpha Tool' },
                { name: 'no id' },
                null,
                'junk',
            ]),
        ).toEqual([
            { id: '@a/tool', name: 'Alpha Tool' },
            { id: '@b/tool', name: 'Zeta Tool' },
        ]);
    });

    it('falls back to the id and drops duplicates', () => {
        expect(toToolChoices([{ id: 'x' }, { id: 'x', name: 'Other' }])).toEqual([{ id: 'x', name: 'x' }]);
    });

    it('returns no tools for a non-array', () => {
        expect(toToolChoices(undefined)).toEqual([]);
        expect(toToolChoices({ id: 'x' })).toEqual([]);
    });
});

describe('sqlFromLaunchContext', () => {
    it('reads a non-empty sql string', () => {
        expect(sqlFromLaunchContext({ sql: '  SELECT name FROM account  ', maxRows: 10 })).toBe(
            'SELECT name FROM account',
        );
    });

    it('returns null without usable SQL', () => {
        expect(sqlFromLaunchContext(null)).toBeNull();
        expect(sqlFromLaunchContext({})).toBeNull();
        expect(sqlFromLaunchContext({ sql: '   ' })).toBeNull();
        expect(sqlFromLaunchContext({ sql: 42 })).toBeNull();
    });
});
