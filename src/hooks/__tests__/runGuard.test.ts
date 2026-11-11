import { describe, it, expect } from 'vitest';
import { runGuard } from '../runGuard';

describe('runGuard', () => {
    it("drops an older run's callbacks once a newer run starts", () => {
        let generation = 1;
        const seen: string[] = [];
        const first = runGuard(() => generation);
        const firstProgress = first.guard((n: number) => seen.push(`first ${n}`));
        firstProgress(5000);

        generation += 1; // a new execute() starts
        const second = runGuard(() => generation);
        const secondProgress = second.guard((n: number) => seen.push(`second ${n}`));

        firstProgress(10_000); // the old scan's in-flight page comes back
        secondProgress(1);
        expect(seen).toEqual(['first 5000', 'second 1']);
        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);
    });
});
