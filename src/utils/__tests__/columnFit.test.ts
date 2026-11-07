import { describe, it, expect } from 'vitest';
import { fitColumnWidth, createTextMeasurer, MIN_FIT_WIDTH, MAX_FIT_WIDTH } from '../columnFit';

// 7px per character, so expected widths are easy to compute.
const measure = (text: string) => text.length * 7;
// Cell padding (2 x 12px) plus the 1px border.
const CHROME = 25;

describe('fitColumnWidth', () => {
    it('fits the longest value', () => {
        expect(fitColumnWidth({ header: 'name', values: ['a', 'Contoso Ltd.', 'b'], measure })).toBe(12 * 7 + CHROME);
    });

    it('fits the header, with room for the sort indicator', () => {
        expect(fitColumnWidth({ header: 'a_long_header_name', values: ['x'], measure })).toBe(18 * 7 + 16 + CHROME);
    });

    it('adds the per-cell extra, e.g. for the open-record button', () => {
        const guid = '00000000-0000-0000-0000-000000000000';
        expect(fitColumnWidth({ header: 'id', values: [guid], measure, cellExtra: 22 })).toBe(36 * 7 + 22 + CHROME);
    });

    it('never goes below the minimum or above the maximum', () => {
        expect(fitColumnWidth({ header: '', values: [''], measure: () => 0 })).toBe(MIN_FIT_WIDTH);
        expect(fitColumnWidth({ header: 'json', values: ['x'.repeat(5000)], measure })).toBe(MAX_FIT_WIDTH);
    });

    it('measures each distinct value once', () => {
        const seen: string[] = [];
        fitColumnWidth({
            header: 'h',
            values: ['Active', 'Active', 'Inactive', 'Active'],
            measure: (t) => (seen.push(t), t.length),
        });
        expect(seen).toEqual(['h', 'Active', 'Inactive']);
    });
});

describe('createTextMeasurer', () => {
    it('falls back to an estimate without a DOM', () => {
        expect(createTextMeasurer('14px sans-serif')('abcd')).toBe(32);
    });
});
