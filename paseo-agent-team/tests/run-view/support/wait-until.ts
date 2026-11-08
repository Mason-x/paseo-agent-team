/** The `act` of react-test-renderer, as far as the tests here use it. */
export type Act = (callback: () => Promise<void> | void) => Promise<void>;

/**
 * Waits until `condition` holds, checking it every `intervalMs` (5 by default) inside `act` so that
 * what React was handed in the meantime is flushed, and fails with a message naming `label` once
 * `timeoutMs` (2000 by default) has passed. A wait for a fixed number of milliseconds or of event-loop
 * turns is a guess about how fast the machine is; this one ends as soon as the thing has happened, and
 * a thing that never happens is a failure after a bounded time, never a hang.
 */
export async function waitUntil(
  act: Act,
  condition: () => boolean,
  options: { label?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${options.label ?? "the condition"}`,
      );
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
  }
}
