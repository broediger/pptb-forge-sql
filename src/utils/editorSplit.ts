// Height of the SQL editor when the split between the editor and the
// results is dragged (#28). The results area takes the rest of the window.

/** Editor height before the split is moved, and after a double-click reset. */
export const DEFAULT_EDITOR_HEIGHT = 200;

/** The editor never gets smaller than a few lines. */
export const MIN_EDITOR_HEIGHT = 80;

/** Room the results area keeps when the editor grows. */
export const MIN_RESULTS_HEIGHT = 120;

/** How far one arrow-key press moves the split. */
export const KEYBOARD_STEP = 20;

/**
 * Editor height after dragging the split by `deltaY` px from where the drag
 * started. The editor can grow only by as much as the results area can
 * shrink, so the results keep `MIN_RESULTS_HEIGHT`.
 */
export function dragEditorHeight(startHeight: number, deltaY: number, resultsHeightAtStart: number): number {
    const max = Math.max(MIN_EDITOR_HEIGHT, startHeight + resultsHeightAtStart - MIN_RESULTS_HEIGHT);
    return Math.round(Math.min(max, Math.max(MIN_EDITOR_HEIGHT, startHeight + deltaY)));
}

/** A stored height, or the default when it's missing or invalid. */
export function storedEditorHeight(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= MIN_EDITOR_HEIGHT
        ? Math.round(value)
        : DEFAULT_EDITOR_HEIGHT;
}
