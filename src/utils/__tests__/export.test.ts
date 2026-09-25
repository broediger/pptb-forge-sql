import { describe, it, expect } from 'vitest';
import { toCsv } from '../export';

const rows = [
    { name: 'Contoso, Ltd', revenue: 1.5, city: 'Wien' },
    { name: 'Say "hi"', revenue: null, city: 'Linz; Urfahr' },
];

describe('toCsv', () => {
    it('uses a comma by default', () => {
        expect(toCsv(rows, ['name', 'revenue', 'city'])).toBe(
            'name,revenue,city\r\n"Contoso, Ltd",1.5,Wien\r\n"Say ""hi""",,Linz; Urfahr',
        );
    });

    it('uses a semicolon and quotes fields containing it', () => {
        expect(toCsv(rows, ['name', 'revenue', 'city'], ';')).toBe(
            'name;revenue;city\r\nContoso, Ltd;1,5;Wien\r\n"Say ""hi""";;"Linz; Urfahr"',
        );
    });

    it('writes numbers with a decimal comma only in semicolon mode', () => {
        const data = [{ n: 1234.56, i: 7562, neg: -0.25, text: '7.562', bool: true }];
        const cols = ['n', 'i', 'neg', 'text', 'bool'];
        expect(toCsv(data, cols, ';')).toBe('n;i;neg;text;bool\r\n1234,56;7562;-0,25;7.562;true');
        expect(toCsv(data, cols, ',')).toBe('n,i,neg,text,bool\r\n1234.56,7562,-0.25,7.562,true');
    });

    it('quotes header names containing the delimiter', () => {
        expect(toCsv([], ['a;b', 'c'], ';')).toBe('"a;b";c');
    });

    it('quotes fields with newlines and serializes objects as JSON', () => {
        expect(toCsv([{ a: 'line1\nline2', b: { x: 1 } }], ['a', 'b'], ';')).toBe('a;b\r\n"line1\nline2";"{""x"":1}"');
    });
});
