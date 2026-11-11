/**
 * Ties a query run to its generation. A newer run bumps the counter; from then
 * on the older run's callbacks do nothing and `isCurrent()` is false, so its
 * late progress, results or errors can't land in the newer run's state.
 */
export interface RunGuard {
    isCurrent: () => boolean;
    /** `fn`, called only while this run is current. */
    guard: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
}

export function runGuard(currentGeneration: () => number): RunGuard {
    const generation = currentGeneration();
    const isCurrent = () => currentGeneration() === generation;
    return {
        isCurrent,
        guard:
            (fn) =>
            (...args) => {
                if (isCurrent()) fn(...args);
            },
    };
}
