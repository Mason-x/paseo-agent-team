import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildOmpSpawnRequest,
  type OmpRuntime,
  type OmpRuntimeSession,
  type OmpStartOptions,
} from "../server/provider/omp-rpc";
import {
  createProfileOmpProvider,
  discoverOmpProfiles,
  profileProviderId,
} from "../server/provider/profile-providers";
import { createOmpProvider } from "../server/provider/registration";
import type { OmpSessionListOptions } from "../server/provider/session-descriptors";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-profile-provider-"));
  temporary.push(home);
  return { home, environment: { HOME: home, PATH: "/usr/bin" } };
}

function runtimeFixture() {
  const starts: OmpStartOptions[] = [];
  const listings: OmpSessionListOptions[] = [];
  const runtime: OmpRuntime = {
    supportsPersistence: true,
    async startSession(options) {
      starts.push(options);
      if (!options.noSession) throw new Error("fixture stopped before persistent process launch");
      const model = {
        provider: "fixture",
        id: options.environment?.OMP_PROFILE ?? "default",
        reasoning: false,
      };
      return {
        getAvailableModels: async () => [model],
        getState: async () => ({ model, thinkingLevel: "off" }),
        close: async () => {},
      } as unknown as OmpRuntimeSession;
    },
    async listSessions(options) {
      listings.push(options);
      return [{ id: "fixture-session-123", cwd: "/repo" }];
    },
    async readPersistedSubagentTranscript() {
      throw new Error("not used by this fixture");
    },
  };
  return { runtime, starts, listings };
}

async function request(
  connection: ProviderConnection,
  input: ProviderInput,
): Promise<ProviderEvent> {
  const result = new Promise<ProviderEvent>((resolve) => {
    const remove = connection.onEvent((event) => {
      if ("requestId" in input && "requestId" in event && event.requestId === input.requestId) {
        remove();
        resolve(event);
      }
    });
  });
  await connection.send(input);
  return result;
}

async function connect(provider: ReturnType<typeof createProfileOmpProvider>) {
  return provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence"] });
}

describe("profile discovery and provider identity", () => {
  test("enumerates only valid real directories, sorted, without opening profile files", async () => {
    const { home, environment } = await fixture();
    const root = join(home, ".omp", "profiles");
    for (const name of [
      "team-beta",
      "default",
      "team-alpha",
      "team.prod",
      "bad.name",
      "Work_2",
      "con",
      "trail.",
      ".hidden",
    ]) {
      if (process.platform === "win32" && (name === "con" || name.endsWith("."))) continue;
      await mkdir(join(root, name), { recursive: true });
    }
    await writeFile(join(root, "plain-file"), "not a directory");
    await symlink(join(root, "team-beta"), join(root, "linked-profile"));
    expect(await discoverOmpProfiles(environment)).toEqual([
      "bad.name",
      "team-alpha",
      "team-beta",
      "team.prod",
    ]);
  });

  test("uses the selected config root and distinguishes an absent directory from an invalid root", async () => {
    const { home, environment } = await fixture();
    expect(await discoverOmpProfiles(environment)).toEqual([]);
    await mkdir(join(home, "config", "profiles", "work"), { recursive: true });
    expect(await discoverOmpProfiles({ ...environment, PI_CONFIG_DIR: "config" })).toEqual([
      "work",
    ]);
    await mkdir(join(home, ".omp"));
    await writeFile(join(home, ".omp", "profiles"), "not a directory");
    await expect(discoverOmpProfiles(environment)).rejects.toThrow("could not be read");
  });

  test("bounds the number of advertised profiles deterministically", async () => {
    const { home, environment } = await fixture();
    const names = Array.from(
      { length: 130 },
      (_, index) => `profile-${String(index).padStart(3, "0")}`,
    );
    await Promise.all(
      names.map((name) => mkdir(join(home, ".omp", "profiles", name), { recursive: true })),
    );
    expect(await discoverOmpProfiles(environment)).toEqual(names.slice(0, 128));
  });

  test("uses OMP's lowercase profile grammar without case-folding identities", () => {
    expect(profileProviderId("team-beta")).toBe("omp-plugin-team-beta");
    expect(profileProviderId("team.prod")).toBe("omp-plugin-team.prod");
    expect(profileProviderId("work")).toMatch(/^[a-z][a-z0-9._-]*$/u);
    for (const name of [
      "default",
      "",
      "../escape",
      ".hidden",
      "Work",
      "trail.",
      "con",
      "nul.txt",
      "com9",
      "x".repeat(65),
    ]) {
      expect(() => createProfileOmpProvider(name)).toThrow("Invalid named OMP profile");
    }
    expect(createOmpProvider().id).toBe("omp-plugin");
  });
});

describe("fixed profile catalog and runtime", () => {
  test("discovers each profile catalog before session creation, independent of daemon defaults", async () => {
    const { environment } = await fixture();
    const source = {
      ...environment,
      OMP_PROFILE: "wrong",
      PI_PROFILE: "wrong",
      PI_CODING_AGENT_DIR: "/wrong/agent",
      OMP_SESSION_DIR: "/wrong/sessions",
      PI_CONFIG_FILES: "/wrong/settings.yml",
    };
    const original = { ...source };
    for (const profile of ["alpha", "team-beta"]) {
      const fake = runtimeFixture();
      const provider = createProfileOmpProvider(profile, {
        environment: source,
        runtime: fake.runtime,
      });
      const connection = await connect(provider);
      const event = await request(connection, {
        type: "catalog",
        requestId: `catalog-${profile}`,
        cwd: "/repo",
      });
      expect(provider.label).toBe(`OMP · ${profile}`);
      expect(event.type).toBe("catalog");
      if (event.type !== "catalog") throw new Error("expected catalog");
      expect(event.catalog.models[0].metadata).toEqual({ provider: "fixture", modelId: profile });
      expect(fake.starts[0].environment).toMatchObject({
        OMP_PROFILE: profile,
        PI_CODING_AGENT_DIR: join(environment.HOME, ".omp", "profiles", profile, "agent"),
      });
      expect(fake.starts[0].environment?.PI_PROFILE).toBeUndefined();
      expect(fake.starts[0].environment?.PI_CONFIG_FILES).toBeUndefined();
      expect(fake.starts[0].sessionDir).toBe(
        join(environment.HOME, ".omp", "profiles", profile, "agent", "sessions"),
      );
      expect(fake.starts[0].command).toEqual(["omp", "--profile", profile]);
      await connection.close();
    }
    expect(source).toEqual(original);
  });

  test("keys discovery by effective profile options without hashing credentials", async () => {
    const { environment } = await fixture();
    const work = createProfileOmpProvider("work", { environment });
    const catalogKey = (providerOptions: Readonly<Record<string, unknown>> = {}, cwd = "/repo") =>
      work.getCatalogCacheKey?.({ scope: "workspace", cwd, providerOptions });
    const first = await catalogKey({ command: ["omp"] });
    expect(first).toHaveLength(43);
    expect(await catalogKey({ command: ["doppler", "--", "omp"] })).not.toBe(first);
    expect(await catalogKey({ params: { smolModel: "fixture/small" } })).not.toBe(first);
    expect(
      await createProfileOmpProvider("other", { environment }).getCatalogCacheKey?.({
        scope: "workspace",
        cwd: "/repo",
      }),
    ).not.toBe(first);
    expect(
      await createProfileOmpProvider("work", {
        environment: { ...environment, PI_CONFIG_DIR: "different" },
      }).getCatalogCacheKey?.({ scope: "workspace", cwd: "/repo" }),
    ).not.toBe(first);
    expect(await catalogKey({}, "/other")).not.toBe(first);
    expect(
      await catalogKey({ env: { FIXTURE_API_KEY: "must-not-enter-cache-identity" } }),
    ).toBeUndefined();
  });

  test("preserves the selected profile's configured session root", async () => {
    const { home, environment } = await fixture();
    const agentRoot = join(home, ".omp", "profiles", "work", "agent");
    await mkdir(agentRoot, { recursive: true });
    await writeFile(
      join(agentRoot, "settings.json"),
      JSON.stringify({ sessionDir: "recorded-sessions" }),
    );
    const fake = runtimeFixture();
    const connection = await connect(
      createProfileOmpProvider("work", { environment, runtime: fake.runtime }),
    );
    await request(connection, { type: "catalog", requestId: "configured" });
    expect(fake.starts[0].sessionDir).toBe(join(agentRoot, "recorded-sessions"));
    await connection.close();
  });

  test.skipIf(process.platform === "win32")(
    "uses an existing profile XDG data root for catalog and session persistence",
    async () => {
      const { home, environment } = await fixture();
      const dataHome = join(home, "xdg-data");
      const dataRoot = join(dataHome, "omp", "profiles", "work");
      await mkdir(dataRoot, { recursive: true });
      const fake = runtimeFixture();
      const connection = await connect(
        createProfileOmpProvider("work", {
          environment: { ...environment, XDG_DATA_HOME: dataHome },
          runtime: fake.runtime,
        }),
      );
      await request(connection, { type: "catalog", requestId: "xdg-profile" });
      expect(fake.starts[0].sessionDir).toBe(join(dataRoot, "sessions"));
      await connection.close();
    },
  );

  test("preserves trusted wrappers, profile role models and account fallback environment", async () => {
    const { environment } = await fixture();
    const fake = runtimeFixture();
    const connection = await connect(
      createProfileOmpProvider("work", {
        environment: { ...environment, ANTHROPIC_API_KEY: "fixture-account-value" },
        runtime: fake.runtime,
      }),
    );
    const command = [
      "doppler",
      "run",
      "--project",
      "fixture",
      "--",
      "omp",
      "--profile",
      "work",
      "--config",
      "/fixture/overlay.yml",
    ];
    await request(connection, {
      type: "catalog",
      requestId: "wrapper",
      providerOptions: {
        command,
        params: { smolModel: "fixture/small", slowModel: "fixture/large" },
      },
    } as never);
    expect(fake.starts[0].command).toEqual(command);
    expect(fake.starts[0].roleModels).toEqual({ smol: "fixture/small", slow: "fixture/large" });
    expect(buildOmpSpawnRequest(fake.starts[0]).env.ANTHROPIC_API_KEY).toBe(
      "fixture-account-value",
    );
    await connection.close();
  });

  test.each([
    ["env", "FIXTURE=1", "omp"],
    ["/usr/bin/env", "--", "omp"],
  ])("preserves a plain env wrapper: %j", async (...command) => {
    const { environment } = await fixture();
    const fake = runtimeFixture();
    const connection = await connect(
      createProfileOmpProvider("work", { environment, runtime: fake.runtime }),
    );
    const event = await request(connection, {
      type: "catalog",
      requestId: "plain-env",
      providerOptions: { command },
    } as never);
    expect(event.type).toBe("catalog");
    expect(fake.starts[0].command).toEqual([...command, "--profile", "work"]);
    expect(fake.starts[0].environment?.OMP_PROFILE).toBe("work");
    await connection.close();
  });

  test.each([
    { command: ["omp", "--profile", "other"] },
    { command: ["omp", "--profile=other"] },
    { command: ["omp", "--profile"] },
    { command: ["env", "OMP_PROFILE=other", "omp"] },
    { command: ["/usr/bin/env", "-i", "omp"] },
    { command: ["env", "-", "omp"] },
    { command: ["env", "-u", "PI_CONFIG_DIR", "omp"] },
    { command: ["env", "--unset=XDG_DATA_HOME", "omp"] },
    { command: ["env", "--ignore-environment", "omp"] },
    { command: ["ENV.EXE", "-i", "omp"] },
    { command: ["env", "FIXTURE=1", "-i", "omp"] },
    { command: ["doppler", "run", "--", "env", "-i", "omp"] },
    { command: ["env", "XDG_DATA_HOME=/different", "omp"] },
    { env: { XDG_DATA_HOME: "/different" } },
    { env: { XDG_STATE_HOME: "/different" } },
    { env: { XDG_CACHE_HOME: "/different" } },
    { command: ["omp", "--session-dir", "/different"] },
    { params: { sessionDir: "/different" } },
    { env: { OMP_PROFILE: "other" } },
    { env: { PI_CODING_AGENT_DIR: "/different" } },
  ])(
    "rejects profile/store overrides before starting a catalog subprocess: %j",
    async (providerOptions) => {
      const { environment } = await fixture();
      const fake = runtimeFixture();
      const provider = createProfileOmpProvider("work", { environment, runtime: fake.runtime });
      await expect(
        provider.getCatalogCacheKey({ scope: "global", providerOptions }),
      ).rejects.toThrow();
      await expect(
        provider.checkAvailability({ scope: "global", providerOptions }),
      ).rejects.toThrow();
      const connection = await connect(provider);
      const event = await request(connection, {
        type: "catalog",
        requestId: "conflict",
        providerOptions,
      } as never);
      expect(event.type).toBe("request.failed");
      expect(fake.starts).toHaveLength(0);
      await connection.close();
    },
  );

  test("uses the same profile for session listing and persisted-session authorization", async () => {
    const { environment } = await fixture();
    const fake = runtimeFixture();
    const connection = await connect(
      createProfileOmpProvider("work", { environment, runtime: fake.runtime }),
    );
    const sessionDir = join(environment.HOME, ".omp", "profiles", "work", "agent", "sessions");
    expect(
      (await request(connection, { type: "sessions", requestId: "list", cwd: "/repo" })).type,
    ).toBe("sessions");
    await request(connection, {
      type: "session.open",
      requestId: "resume",
      sessionId: "public-session",
      history: "replay",
      persistence: { version: 1, data: { sessionId: "fixture-session-123" } },
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    });
    expect(fake.listings).toHaveLength(2);
    expect(fake.listings.every((listing) => listing.sessionDir === sessionDir)).toBe(true);
    expect(fake.starts[0]).toMatchObject({
      sessionDir,
      resumeSessionId: "fixture-session-123",
      environment: { OMP_PROFILE: "work" },
    });
    await connection.close();
  });

  test("refuses session launch environment overrides as well as catalog overrides", async () => {
    const { environment } = await fixture();
    const fake = runtimeFixture();
    const connection = await connect(
      createProfileOmpProvider("work", { environment, runtime: fake.runtime }),
    );
    const event = await request(connection, {
      type: "session.open",
      requestId: "wrong-profile",
      sessionId: "wrong-profile-session",
      history: "skip",
      config: {
        cwd: "/repo",
        env: { OMP_PROFILE: "other" },
        mcpServers: {},
        settings: {},
        persist: true,
      },
    });
    expect(event.type).toBe("request.failed");
    expect(fake.starts).toHaveLength(0);
    await connection.close();
  });
});
