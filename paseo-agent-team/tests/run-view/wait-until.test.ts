import { describe, expect, test } from "vitest";
import { type Act, waitUntil } from "./support/wait-until";

/** An `act` that only runs the callback: enough to test the wait itself. */
const act: Act = async (callback) => {
  await callback();
};

describe("waitUntil", () => {
  test("returns as soon as the condition holds, without waiting for the timeout", async () => {
    let checks = 0;
    const started = Date.now();
    await waitUntil(act, () => {
      checks += 1;
      return checks >= 4;
    });
    expect(checks).toBe(4);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("a condition that already holds is not waited for at all", async () => {
    let waited = 0;
    await waitUntil(
      async (callback) => {
        waited += 1;
        await callback();
      },
      () => true,
    );
    expect(waited).toBe(0);
  });

  test("a condition that never holds fails after the timeout, naming what was waited for", async () => {
    const started = Date.now();
    await expect(
      waitUntil(act, () => false, { timeoutMs: 60, intervalMs: 5, label: "the list to land" }),
    ).rejects.toThrow("timed out after 60 ms waiting for the list to land");
    // It failed, it did not hang: well inside the default limit of a test.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
