import { describe, it, expect } from 'vitest';
import {
    dragEditorHeight,
    storedEditorHeight,
    DEFAULT_EDITOR_HEIGHT,
    MIN_EDITOR_HEIGHT,
    MIN_RESULTS_HEIGHT,
} from '../editorSplit';

describe('dragEditorHeight', () => {
    it('follows the drag', () => {
        expect(dragEditorHeight(200, 50, 500)).toBe(250);
        expect(dragEditorHeight(200, -50, 500)).toBe(150);
    });

    it('keeps the editor at its minimum height', () => {
        expect(dragEditorHeight(200, -500, 500)).toBe(MIN_EDITOR_HEIGHT);
    });

    it('lets the editor grow only as far as the results can shrink', () => {
        // 500px of results, of which MIN_RESULTS_HEIGHT stays.
        expect(dragEditorHeight(200, 1000, 500)).toBe(200 + 500 - MIN_RESULTS_HEIGHT);
    });

    it('never forces the editor below its minimum when the results area is already small', () => {
        expect(dragEditorHeight(MIN_EDITOR_HEIGHT, 100, 50)).toBe(MIN_EDITOR_HEIGHT);
    });

    it('rounds to whole pixels', () => {
        expect(dragEditorHeight(200, 10.6, 500)).toBe(211);
    });
});

describe('storedEditorHeight', () => {
    it('uses a valid stored height', () => {
        expect(storedEditorHeight(320)).toBe(320);
    });

    it('falls back to the default for missing or invalid values', () => {
        for (const value of [undefined, null, '300', NaN, Infinity, 10]) {
            expect(storedEditorHeight(value)).toBe(DEFAULT_EDITOR_HEIGHT);
        }
    });
});
