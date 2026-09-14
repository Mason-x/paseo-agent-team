import { describe, expect, test } from "vitest";
import { SerialMutationQueue } from "../server/mutation-queue";

describe("SerialMutationQueue", () => {
  test("runs stateful operations strictly in submission order", async () => {
    const queue = new SerialMutationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("continues after a rejected operation", async () => {
    const queue = new SerialMutationQueue();
    const failed = queue.run(async () => {
      throw new Error("expected failure");
    });
    const recovered = queue.run(async () => "recovered");

    await expect(failed).rejects.toThrow("expected failure");
    await expect(recovered).resolves.toBe("recovered");
  });
});
