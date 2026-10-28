/**
 * Wall-clock budgets for tests that spawn real processes.
 *
 * Idle runs finish well under the old 30s / 90s caps. Multi-agent parallel
 * load on this machine has pushed the embedded host compile to 176s and the
 * real-git version cases past 30s (see .notes/81-r04a-tail.md, 90 backlog).
 * These are test-only ceilings; they do not change assertions.
 *
 * DEFAULT_* feed vitest.config.mjs so real-fs cases that never set a
 * per-test timeout still have more than the 5s Vitest default.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
export const VERIFY_HOST_COMPILE_TIMEOUT_MS = 300_000;
export const VERSION_PROCESS_TIMEOUT_MS = 90_000;
