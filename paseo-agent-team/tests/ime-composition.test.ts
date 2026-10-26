import { describe, expect, test } from "vitest";
import { finishComposition } from "../client/shared/ime-composition";

describe("IME composition end", () => {
  test("publishes the final text before notifying composition end", () => {
    const order: string[] = [];
    finishComposition(
      () => order.push("publish"),
      (composing) => order.push(`composition:${composing}`),
    );
    expect(order).toEqual(["publish", "composition:false"]);
  });

  test("allows callers without a composition listener", () => {
    const order: string[] = [];
    finishComposition(() => order.push("publish"));
    expect(order).toEqual(["publish"]);
  });
});
