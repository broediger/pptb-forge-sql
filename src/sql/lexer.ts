import { Token, TokenType, SqlParseError } from './types';

const KEYWORDS: Record<string, TokenType> = {
    SELECT:   TokenType.SELECT,
    FROM:     TokenType.FROM,
    WHERE:    TokenType.WHERE,
    AND:      TokenType.AND,
    OR:       TokenType.OR,
    NOT:      TokenType.NOT,
    IN:       TokenType.IN,
    LIKE:     TokenType.LIKE,
    BETWEEN:  TokenType.BETWEEN,
    IS:       TokenType.IS,
    NULL:     TokenType.NULL,
    JOIN:     TokenType.JOIN,
    INNER:    TokenType.INNER,
    LEFT:     TokenType.LEFT,
    RIGHT:    TokenType.RIGHT,
    OUTER:    TokenType.OUTER,
    ON:       TokenType.ON,
    ORDER:    TokenType.ORDER,
    BY:       TokenType.BY,
    ASC:      TokenType.ASC,
    DESC:     TokenType.DESC,
    GROUP:    TokenType.GROUP,
    HAVING:   TokenType.HAVING,
    TOP:      TokenType.TOP,
    DISTINCT: TokenType.DISTINCT,
    AS:       TokenType.AS,
    COUNT:    TokenType.COUNT,
    SUM:      TokenType.SUM,
    AVG:      TokenType.AVG,
    MIN:      TokenType.MIN,
    MAX:      TokenType.MAX,
    TRUE:     TokenType.TRUE,
    FALSE:    TokenType.FALSE,
    INSERT:   TokenType.INSERT,
    INTO:     TokenType.INTO,
    VALUES:   TokenType.VALUES,
    UPDATE:   TokenType.UPDATE,
    SET:      TokenType.SET,
    DELETE:   TokenType.DELETE,
};

export function tokenize(sql: string): Token[] {
    const tokens: Token[] = [];
    let pos = 0;
    let line = 1;
    let column = 1;

    function peek(offset = 0): string {
        return sql[pos + offset] ?? '';
    }

    function advance(): string {
        const ch = sql[pos++];
        if (ch === '\n') {
            line++;
            column = 1;
        } else {
            column++;
        }
        return ch;
    }

    function makeToken(type: TokenType, value: string, tokenLine: number, tokenCol: number): Token {
        return { type, value, line: tokenLine, column: tokenCol };
    }

    while (pos < sql.length) {
        const startLine = line;
        const startCol = column;
        const ch = peek();

        // Whitespace
        if (/\s/.test(ch)) {
            advance();
            continue;
        }

        // Single-line comment --
        if (ch === '-' && peek(1) === '-') {
            while (pos < sql.length && peek() !== '\n') advance();
            continue;
        }

        // Negative number literal: - followed by a digit
        if (ch === '-' && /[0-9]/.test(peek(1))) {
            advance(); // consume '-'
            let value = '-';
            while (pos < sql.length && /[0-9]/.test(peek())) {
                value += advance();
            }
            if (peek() === '.' && /[0-9]/.test(peek(1))) {
                value += advance(); // consume dot
                while (pos < sql.length && /[0-9]/.test(peek())) {
                    value += advance();
                }
            }
            tokens.push(makeToken(TokenType.NUMBER, value, startLine, startCol));
            continue;
        }

        // Multi-line comment /* */
        if (ch === '/' && peek(1) === '*') {
            advance(); advance(); // consume /*
            let terminated = false;
            while (pos < sql.length) {
                if (peek() === '*' && peek(1) === '/') {
                    advance(); advance(); // consume */
                    terminated = true;
                    break;
                }
                advance();
            }
            if (!terminated) {
                throw new SqlParseError('Unterminated multi-line comment', startLine, startCol);
            }
            continue;
        }

        // Single-quoted string
        if (ch === "'") {
            advance(); // consume opening quote
            let value = '';
            let terminated = false;
            while (pos < sql.length) {
                const c = peek();
                if (c === "'") {
                    advance(); // consume quote
                    if (peek() === "'") {
                        // escaped single quote ''
                        advance();
                        value += "'";
                    } else {
                        terminated = true;
                        break;
                    }
                } else {
                    value += advance();
                }
            }
            if (!terminated) {
                throw new SqlParseError('Unterminated string literal', startLine, startCol);
            }
            tokens.push(makeToken(TokenType.STRING, value, startLine, startCol));
            continue;
        }

        // Numbers
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(peek(1)))) {
            let value = '';
            while (pos < sql.length && /[0-9]/.test(peek())) {
                value += advance();
            }
            if (peek() === '.' && /[0-9]/.test(peek(1))) {
                value += advance(); // consume dot
                while (pos < sql.length && /[0-9]/.test(peek())) {
                    value += advance();
                }
            }
            tokens.push(makeToken(TokenType.NUMBER, value, startLine, startCol));
            continue;
        }

        // Identifiers and keywords
        if (/[a-zA-Z_]/.test(ch)) {
            let value = '';
            while (pos < sql.length && /[a-zA-Z0-9_]/.test(peek())) {
                value += advance();
            }
            const upper = value.toUpperCase();
            const kwType = KEYWORDS[upper];
            tokens.push(makeToken(kwType ?? TokenType.IDENTIFIER, value, startLine, startCol));
            continue;
        }

        // Operators
        if (ch === '=') {
            advance();
            tokens.push(makeToken(TokenType.EQUALS, '=', startLine, startCol));
            continue;
        }

        if (ch === '!' && peek(1) === '=') {
            advance(); advance();
            tokens.push(makeToken(TokenType.NOT_EQUALS, '!=', startLine, startCol));
            continue;
        }

        if (ch === '<') {
            advance();
            if (peek() === '=') {
                advance();
                tokens.push(makeToken(TokenType.LESS_EQUAL, '<=', startLine, startCol));
            } else if (peek() === '>') {
                advance();
                tokens.push(makeToken(TokenType.NOT_EQUALS, '<>', startLine, startCol));
            } else {
                tokens.push(makeToken(TokenType.LESS_THAN, '<', startLine, startCol));
            }
            continue;
        }

        if (ch === '>') {
            advance();
            if (peek() === '=') {
                advance();
                tokens.push(makeToken(TokenType.GREATER_EQUAL, '>=', startLine, startCol));
            } else {
                tokens.push(makeToken(TokenType.GREATER_THAN, '>', startLine, startCol));
            }
            continue;
        }

        // Punctuation
        if (ch === ',') { advance(); tokens.push(makeToken(TokenType.COMMA, ',', startLine, startCol)); continue; }
        if (ch === '.') { advance(); tokens.push(makeToken(TokenType.DOT, '.', startLine, startCol)); continue; }
        if (ch === '*') { advance(); tokens.push(makeToken(TokenType.STAR, '*', startLine, startCol)); continue; }
        if (ch === '(') { advance(); tokens.push(makeToken(TokenType.LPAREN, '(', startLine, startCol)); continue; }
        if (ch === ')') { advance(); tokens.push(makeToken(TokenType.RPAREN, ')', startLine, startCol)); continue; }

        throw new SqlParseError(`Unexpected character '${ch}'`, startLine, startCol);
    }

    tokens.push(makeToken(TokenType.EOF, '', line, column));
    return tokens;
}
