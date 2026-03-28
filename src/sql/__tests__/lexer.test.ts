import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { TokenType, SqlParseError } from '../types';

describe('tokenize', () => {

    // ── Basic SELECT ──────────────────────────────────────────────────────────

    describe('basic SELECT tokenization', () => {
        it('produces correct token types for SELECT name FROM account', () => {
            const tokens = tokenize('SELECT name FROM account');
            const types = tokens.map(t => t.type);
            expect(types).toEqual([
                TokenType.SELECT,
                TokenType.IDENTIFIER,
                TokenType.FROM,
                TokenType.IDENTIFIER,
                TokenType.EOF,
            ]);
        });

        it('produces correct token values for SELECT name FROM account', () => {
            const tokens = tokenize('SELECT name FROM account');
            expect(tokens[0].value).toBe('SELECT');
            expect(tokens[1].value).toBe('name');
            expect(tokens[2].value).toBe('FROM');
            expect(tokens[3].value).toBe('account');
        });
    });

    // ── Numbers ───────────────────────────────────────────────────────────────

    describe('number literals', () => {
        it('tokenizes an integer', () => {
            const tokens = tokenize('42');
            expect(tokens[0].type).toBe(TokenType.NUMBER);
            expect(tokens[0].value).toBe('42');
        });

        it('tokenizes a decimal number', () => {
            const tokens = tokenize('3.14');
            expect(tokens[0].type).toBe(TokenType.NUMBER);
            expect(tokens[0].value).toBe('3.14');
        });

        it('tokenizes a negative integer', () => {
            const tokens = tokenize('-1');
            expect(tokens[0].type).toBe(TokenType.NUMBER);
            expect(tokens[0].value).toBe('-1');
        });

        it('tokenizes a negative decimal number', () => {
            const tokens = tokenize('-3.14');
            expect(tokens[0].type).toBe(TokenType.NUMBER);
            expect(tokens[0].value).toBe('-3.14');
        });

        it('does not crash when tokenizing WHERE age > -1', () => {
            expect(() => tokenize('SELECT age FROM account WHERE age > -1')).not.toThrow();
        });

        it('produces NUMBER token with value "-1" in WHERE age > -1', () => {
            const tokens = tokenize('SELECT age FROM account WHERE age > -1');
            const numTok = tokens.find(t => t.type === TokenType.NUMBER);
            expect(numTok).toBeDefined();
            expect(numTok!.value).toBe('-1');
        });
    });

    // ── Strings ───────────────────────────────────────────────────────────────

    describe('string literals', () => {
        it('tokenizes a single-quoted string', () => {
            const tokens = tokenize("'hello'");
            expect(tokens[0].type).toBe(TokenType.STRING);
            expect(tokens[0].value).toBe('hello');
        });

        it('handles escaped single quotes (\'\')', () => {
            const tokens = tokenize("'it''s'");
            expect(tokens[0].type).toBe(TokenType.STRING);
            expect(tokens[0].value).toBe("it's");
        });
    });

    // ── Operators ─────────────────────────────────────────────────────────────

    describe('operators', () => {
        it('tokenizes =', () => {
            const [tok] = tokenize('=');
            expect(tok.type).toBe(TokenType.EQUALS);
            expect(tok.value).toBe('=');
        });

        it('tokenizes !=', () => {
            const [tok] = tokenize('!=');
            expect(tok.type).toBe(TokenType.NOT_EQUALS);
            expect(tok.value).toBe('!=');
        });

        it('tokenizes <>', () => {
            const [tok] = tokenize('<>');
            expect(tok.type).toBe(TokenType.NOT_EQUALS);
            expect(tok.value).toBe('<>');
        });

        it('tokenizes <', () => {
            const [tok] = tokenize('<');
            expect(tok.type).toBe(TokenType.LESS_THAN);
            expect(tok.value).toBe('<');
        });

        it('tokenizes >', () => {
            const [tok] = tokenize('>');
            expect(tok.type).toBe(TokenType.GREATER_THAN);
            expect(tok.value).toBe('>');
        });

        it('tokenizes <=', () => {
            const [tok] = tokenize('<=');
            expect(tok.type).toBe(TokenType.LESS_EQUAL);
            expect(tok.value).toBe('<=');
        });

        it('tokenizes >=', () => {
            const [tok] = tokenize('>=');
            expect(tok.type).toBe(TokenType.GREATER_EQUAL);
            expect(tok.value).toBe('>=');
        });
    });

    // ── Punctuation ───────────────────────────────────────────────────────────

    describe('punctuation', () => {
        it('tokenizes comma', () => {
            const [tok] = tokenize(',');
            expect(tok.type).toBe(TokenType.COMMA);
        });

        it('tokenizes dot', () => {
            const [tok] = tokenize('.');
            expect(tok.type).toBe(TokenType.DOT);
        });

        it('tokenizes star', () => {
            const [tok] = tokenize('*');
            expect(tok.type).toBe(TokenType.STAR);
        });

        it('tokenizes left paren', () => {
            const [tok] = tokenize('(');
            expect(tok.type).toBe(TokenType.LPAREN);
        });

        it('tokenizes right paren', () => {
            const [tok] = tokenize(')');
            expect(tok.type).toBe(TokenType.RPAREN);
        });
    });

    // ── Case-insensitive keywords ─────────────────────────────────────────────

    describe('keyword case-insensitivity', () => {
        it('lowercase select produces SELECT token', () => {
            const [tok] = tokenize('select');
            expect(tok.type).toBe(TokenType.SELECT);
        });

        it('uppercase SELECT produces SELECT token', () => {
            const [tok] = tokenize('SELECT');
            expect(tok.type).toBe(TokenType.SELECT);
        });

        it('mixed-case SeLeCt produces SELECT token', () => {
            const [tok] = tokenize('SeLeCt');
            expect(tok.type).toBe(TokenType.SELECT);
        });

        it('preserves original value casing for keywords', () => {
            const [tok] = tokenize('SeLeCt');
            expect(tok.value).toBe('SeLeCt');
        });
    });

    // ── Whitespace & line/column tracking ────────────────────────────────────

    describe('whitespace and position tracking', () => {
        it('skips spaces between tokens', () => {
            const tokens = tokenize('a   b');
            expect(tokens[0].value).toBe('a');
            expect(tokens[1].value).toBe('b');
        });

        it('skips newlines between tokens', () => {
            const tokens = tokenize('a\nb');
            expect(tokens[0].value).toBe('a');
            expect(tokens[1].value).toBe('b');
        });

        it('tracks column correctly on first line', () => {
            const tokens = tokenize('SELECT name');
            expect(tokens[0].line).toBe(1);
            expect(tokens[0].column).toBe(1);
            expect(tokens[1].column).toBe(8);
        });

        it('increments line number after newline', () => {
            const tokens = tokenize('a\nb');
            expect(tokens[0].line).toBe(1);
            expect(tokens[1].line).toBe(2);
        });

        it('resets column to 1 after newline', () => {
            const tokens = tokenize('a\nb');
            expect(tokens[1].column).toBe(1);
        });
    });

    // ── Comments ──────────────────────────────────────────────────────────────

    describe('comments', () => {
        it('skips single-line comments', () => {
            const tokens = tokenize('SELECT -- this is a comment\nname FROM account');
            const types = tokens.map(t => t.type);
            expect(types).toEqual([
                TokenType.SELECT,
                TokenType.IDENTIFIER,
                TokenType.FROM,
                TokenType.IDENTIFIER,
                TokenType.EOF,
            ]);
        });

        it('skips multi-line comments', () => {
            const tokens = tokenize('SELECT /* pick name */ name FROM account');
            const types = tokens.map(t => t.type);
            expect(types).toEqual([
                TokenType.SELECT,
                TokenType.IDENTIFIER,
                TokenType.FROM,
                TokenType.IDENTIFIER,
                TokenType.EOF,
            ]);
        });

        it('skips multi-line comments spanning multiple lines', () => {
            const tokens = tokenize('SELECT\n/* line1\nline2 */\nname FROM account');
            const types = tokens.map(t => t.type);
            expect(types).toEqual([
                TokenType.SELECT,
                TokenType.IDENTIFIER,
                TokenType.FROM,
                TokenType.IDENTIFIER,
                TokenType.EOF,
            ]);
        });
    });

    // ── EOF ───────────────────────────────────────────────────────────────────

    describe('empty input', () => {
        it('produces only an EOF token for empty string', () => {
            const tokens = tokenize('');
            expect(tokens).toHaveLength(1);
            expect(tokens[0].type).toBe(TokenType.EOF);
        });

        it('EOF token has correct position for empty input', () => {
            const tokens = tokenize('');
            expect(tokens[0].line).toBe(1);
            expect(tokens[0].column).toBe(1);
        });
    });

    // ── Error handling ────────────────────────────────────────────────────────

    describe('error handling', () => {
        it('throws SqlParseError for an invalid character', () => {
            expect(() => tokenize('SELECT @ FROM account')).toThrow(SqlParseError);
        });

        it('includes correct line in the error', () => {
            expect.assertions(2);
            try {
                tokenize('SELECT\n@ name');
            } catch (e) {
                expect(e).toBeInstanceOf(SqlParseError);
                expect((e as SqlParseError).line).toBe(2);
            }
        });

        it('includes correct column in the error', () => {
            expect.assertions(2);
            try {
                tokenize('SELECT @');
            } catch (e) {
                expect(e).toBeInstanceOf(SqlParseError);
                expect((e as SqlParseError).column).toBe(8);
            }
        });

        it('throws on unterminated string literal', () => {
            expect(() => tokenize("SELECT 'oops")).toThrow(SqlParseError);
            expect(() => tokenize("SELECT 'oops")).toThrow(/Unterminated string/);
        });

        it('throws on unterminated multi-line comment', () => {
            expect(() => tokenize('SELECT /* never closed')).toThrow(SqlParseError);
            expect(() => tokenize('SELECT /* never closed')).toThrow(/Unterminated multi-line comment/);
        });
    });

    // ── Quoted identifiers ────────────────────────────────────────────────────

    describe('quoted identifiers', () => {
        it('[name] produces IDENTIFIER token with value "name"', () => {
            const tokens = tokenize('[name]');
            expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
            expect(tokens[0].value).toBe('name');
        });

        it('[order] produces IDENTIFIER (not ORDER keyword)', () => {
            const tokens = tokenize('[order]');
            expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
            expect(tokens[0].value).toBe('order');
        });

        it('[column with spaces] produces IDENTIFIER with value "column with spaces"', () => {
            const tokens = tokenize('[column with spaces]');
            expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
            expect(tokens[0].value).toBe('column with spaces');
        });

        it('unterminated [name throws SqlParseError', () => {
            expect(() => tokenize('[name')).toThrow(SqlParseError);
            expect(() => tokenize('[name')).toThrow(/Unterminated bracket identifier/);
        });

        it('"name" produces IDENTIFIER token with value "name"', () => {
            const tokens = tokenize('"name"');
            expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
            expect(tokens[0].value).toBe('name');
        });

        it('"col""umn" produces IDENTIFIER with value col"umn (escaped double-quote)', () => {
            const tokens = tokenize('"col""umn"');
            expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
            expect(tokens[0].value).toBe('col"umn');
        });

        it('unterminated "name throws SqlParseError', () => {
            expect(() => tokenize('"name')).toThrow(SqlParseError);
            expect(() => tokenize('"name')).toThrow(/Unterminated quoted identifier/);
        });

        it('SELECT [name] FROM [account] parses correctly', () => {
            const tokens = tokenize('SELECT [name] FROM [account]');
            const types = tokens.map(t => t.type);
            expect(types).toEqual([
                TokenType.SELECT,
                TokenType.IDENTIFIER,
                TokenType.FROM,
                TokenType.IDENTIFIER,
                TokenType.EOF,
            ]);
            expect(tokens[1].value).toBe('name');
            expect(tokens[3].value).toBe('account');
        });
    });

    // ── Complex query ─────────────────────────────────────────────────────────

    describe('complex query tokenization', () => {
        it('tokenizes a full query without throwing', () => {
            const sql =
                "SELECT a.name, COUNT(DISTINCT b.id) FROM account a INNER JOIN contact b " +
                "ON a.id = b.accountid WHERE a.status = 'active' ORDER BY a.name ASC";
            expect(() => tokenize(sql)).not.toThrow();
        });

        it('produces correct high-level token sequence for complex query', () => {
            const sql =
                "SELECT a.name, COUNT(DISTINCT b.id) FROM account a INNER JOIN contact b " +
                "ON a.id = b.accountid WHERE a.status = 'active' ORDER BY a.name ASC";
            const tokens = tokenize(sql);
            const types = tokens.map(t => t.type);

            // High-level shape check
            expect(types[0]).toBe(TokenType.SELECT);
            expect(types).toContain(TokenType.FROM);
            expect(types).toContain(TokenType.INNER);
            expect(types).toContain(TokenType.JOIN);
            expect(types).toContain(TokenType.ON);
            expect(types).toContain(TokenType.WHERE);
            expect(types).toContain(TokenType.ORDER);
            expect(types).toContain(TokenType.BY);
            expect(types).toContain(TokenType.ASC);
            expect(types).toContain(TokenType.COUNT);
            expect(types).toContain(TokenType.DISTINCT);
            expect(types[types.length - 1]).toBe(TokenType.EOF);
        });
    });

});
