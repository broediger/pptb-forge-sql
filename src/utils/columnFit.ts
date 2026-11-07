// Width of a result column fitted to its content, for double-clicking the
// column's resize handle (like SSMS and Excel).

/** Narrowest a fitted column gets (the grid's minimum column width). */
export const MIN_FIT_WIDTH = 60;

/**
 * Widest a fitted column gets. One very long value (JSON, a description)
 * would otherwise push every other column off screen; it can still be dragged
 * wider by hand.
 */
export const MAX_FIT_WIDTH = 1000;

/** Horizontal cell padding (`px-3`) plus the 1px right border. */
const CELL_CHROME = 2 * 12 + 1;

/** Room for the ▲/▼ sort indicator next to a header. */
const SORT_INDICATOR = 16;

export interface FitColumnInput {
    header: string;
    /** Cell texts as displayed. */
    values: string[];
    /** Text width in px in the grid's font. */
    measure: (text: string) => number;
    /** Extra px per cell, e.g. for the "open record" button next to a GUID. */
    cellExtra?: number;
}

export function fitColumnWidth({ header, values, measure, cellExtra = 0 }: FitColumnInput): number {
    let widest = measure(header) + SORT_INDICATOR;
    // Measure each distinct text once; result sets repeat values a lot.
    for (const text of new Set(values)) {
        widest = Math.max(widest, measure(text) + cellExtra);
        if (widest >= MAX_FIT_WIDTH) break;
    }
    return Math.min(MAX_FIT_WIDTH, Math.max(MIN_FIT_WIDTH, Math.ceil(widest + CELL_CHROME)));
}

/**
 * A text measurer for a CSS font (e.g. `getComputedStyle(el).font`), using a
 * shared canvas. Falls back to a rough per-character estimate where canvas
 * isn't available.
 */
export function createTextMeasurer(font: string): (text: string) => number {
    let context: CanvasRenderingContext2D | null = null;
    try {
        context = document.createElement('canvas').getContext('2d');
    } catch {
        context = null;
    }
    if (!context) return (text) => text.length * 8;
    context.font = font;
    return (text) => context.measureText(text).width;
}
