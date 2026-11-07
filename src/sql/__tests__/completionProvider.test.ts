import { describe, it, expect } from 'vitest';
import { extractAliases, extractFromTableName, isTableContext } from '../completionProvider';

describe('completion helpers with schema-qualified tables', () => {
    it('finds the FROM table behind a schema prefix', () => {
        expect(extractFromTableName('SELECT a. FROM dbo.account a')).toBe('account');
        expect(extractFromTableName('SELECT * FROM [dbo].[account]')).toBe('account');
        expect(extractFromTableName('SELECT * FROM account')).toBe('account');
    });

    it('maps aliases of schema-qualified tables', () => {
        const aliases = extractAliases(
            'SELECT a. FROM dbo.account a JOIN [dbo].[contact] AS c ON c.parentcustomerid = a.accountid',
        );
        expect(aliases.get('a')).toBe('account');
        expect(aliases.get('c')).toBe('contact');
    });

    it('suggests tables after a schema prefix', () => {
        expect(isTableContext('SELECT * FROM dbo.')).toBe(true);
        expect(isTableContext('SELECT * FROM [dbo].acc')).toBe(true);
        expect(isTableContext('SELECT * FROM acc')).toBe(true);
        expect(isTableContext('SELECT a.')).toBe(false);
    });
});
