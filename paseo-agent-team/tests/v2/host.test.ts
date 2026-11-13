import { describe, expect, it } from "vitest";
import { fromPaseo, type PaseoPort } from "../../v2/server/host";

const portWith = (refresh: () => Promise<unknown>) =>
  ({
    agents: { ref: () => ({ refresh }) },
  }) as unknown as PaseoPort;

describe("host.agent", () => {
  it("reads status, archive flag and pending permissions", async () => {
    const host = fromPaseo(
      portWith(async () => ({
        agent: { status: "closed", archivedAt: null, pendingPermissions: [1] },
      })),
    );
    expect(await host.agent("a")).toEqual({
      exists: true,
      archived: false,
      status: "closed",
      pendingPermissions: 1,
    });
  });

  it("an unknown agent does not exist; any other failure is thrown, not read as a death", async () => {
    const gone = fromPaseo(portWith(async () => Promise.reject(new Error("Unknown agent 'x'"))));
    expect((await gone.agent("x")).exists).toBe(false);
    const flaky = fromPaseo(portWith(async () => Promise.reject(new Error("request timed out"))));
    await expect(flaky.agent("x")).rejects.toThrow("timed out");
  });
});
