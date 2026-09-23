import { describe, expect, test } from "vitest";
import { filterByQuery } from "../client/shared/search";

describe("filterByQuery", () => {
  const items = [
    { id: "a", name: "DP D20", projectName: "DollarPrinter" },
    { id: "b", name: "Initialize coding session", projectName: "ExplainerStudio" },
  ];

  test("returns every item when the query is blank", () => {
    expect(filterByQuery(items, "  ", (item) => item.name)).toEqual(items);
  });

  test("matches name or project", () => {
    const haystack = (item: (typeof items)[number]) => `${item.name} ${item.projectName}`;
    expect(filterByQuery(items, "dollar", haystack).map((item) => item.id)).toEqual(["a"]);
    expect(filterByQuery(items, "coding", haystack).map((item) => item.id)).toEqual(["b"]);
  });
});
