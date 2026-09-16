import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { resolveListOmpMemory } from "../server/memory";
import { resolveListOmpConfig } from "../server/omp-config";
import {
  ompAgentDir,
  ompCacheDir,
  ompDataDir,
  ompSessionDir,
  ompStateDir,
  withOmpStore,
} from "../server/paths";
import {
  createProfileOmpProvider,
  discoverOmpProfiles,
} from "../server/provider/profile-providers";
import { resolveListOmpQuotas } from "../server/quota";
import { resolveListOmpSessions } from "../server/sessions";
import { OmpProfileNameSchema, OmpStoreSchema, storeForProvider } from "../shared/omp-store";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-profile-review-"));
  directories.push(home);
  return home;
}

test("OMP 18.1.15 names agree across discovery, store selectors and provider identities", async () => {
  const home = await fixture();
  const invalid = [
    "default",
    "Team",
    "trailing.",
    "con",
    "nul",
    "prn",
    "aux",
    "con.txt",
    ...Array.from({ length: 10 }, (_, i) => `com${i}`),
    ...Array.from({ length: 10 }, (_, i) => `lpt${i}.txt`),
  ];
  for (const name of ["team.prod", "work_2", ...invalid]) {
    // These names cannot be materialized on Windows, but all are validated below.
    if (
      process.platform === "win32" &&
      (name.endsWith(".") || /^(?:con|nul|aux|prn|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
    )
      continue;
    await mkdir(join(home, ".omp", "profiles", name), { recursive: true });
  }
  expect(await discoverOmpProfiles({ HOME: home })).toEqual(["team.prod", "work_2"]);
  expect(OmpStoreSchema.parse({ profile: " team.prod " })).toEqual({ profile: "team.prod" });
  expect(createProfileOmpProvider("team.prod", { environment: { HOME: home } }).id).toBe(
    "omp-plugin-team.prod",
  );
  expect(storeForProvider("omp-plugin-team.prod")).toEqual({ profile: "team.prod" });
  for (const name of [...invalid, "", "..", ".hidden", "../other", "x".repeat(65)]) {
    expect(OmpProfileNameSchema.safeParse(name).success, name).toBe(false);
    expect(storeForProvider(`omp-plugin-${name}`), name).toBeUndefined();
  }
  expect(storeForProvider("omp-plugin- team.prod ")).toBeUndefined();
});

test("fixed-profile catalog keys distinguish effective commands, role models, env and settings", async () => {
  const home = await fixture();
  const provider = createProfileOmpProvider("work", { environment: { HOME: home } });
  const key = (providerOptions: Record<string, unknown> = {}, settings = {}) =>
    provider.getCatalogCacheKey({ scope: "workspace", cwd: "/repo", providerOptions, settings });
  const baseline = await key();
  for (const options of [
    { command: ["/opt/other-omp"] },
    { command: ["doppler", "run", "--project", "test", "--", "omp"] },
    { params: { smolModel: "fixture/small" } },
    { params: { slowModel: "fixture/large" } },
    { params: { planModel: "fixture/plan" } },
    { env: { MODEL_FILTER: "fixture/*" } },
    { inheritEnv: ["CUSTOM_PROVIDER_KEY"] },
  ])
    expect(await key(options), JSON.stringify(options)).not.toBe(baseline);
  expect(await key({}, { catalog: "alternate" })).not.toBe(baseline);
  expect(await key({ env: { FIXTURE_API_KEY: "first" } })).toBeUndefined();
  expect(await key({ env: { MODEL_FILTER: "fixture/*" } })).toBeUndefined();
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "migrated profile readers use XDG data/state while config stays in the profile config root",
  async () => {
    const home = await fixture();
    const agent = join(home, ".omp", "profiles", "work", "agent");
    const dataHome = join(home, "data");
    const stateHome = join(home, "state");
    const data = join(dataHome, "omp", "profiles", "work");
    const state = join(stateHome, "omp", "profiles", "work");
    const bank = join(state, "memories", "mnemopi", "banks", "workspace-fixture");
    await Promise.all([agent, data, bank].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(join(agent, "config.yml"), "theme:\n  dark: migrated\n");
    const quota = new DatabaseSync(join(data, "agent.db"));
    quota.exec(
      "CREATE TABLE usage_history (id INTEGER, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER); INSERT INTO usage_history VALUES (1, 'migrated', 'fixture', 'limit', 'Fixture', NULL, 0.25, NULL, NULL, 1000)",
    );
    quota.close();
    const history = new DatabaseSync(join(data, "history.db"));
    history.exec(
      "CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT, created_at INTEGER, cwd TEXT, session_id TEXT); CREATE TABLE session_titles (session_id TEXT, title TEXT, updated_at INTEGER); INSERT INTO history VALUES (1, 'migrated', 1000, '/workspace', NULL)",
    );
    history.close();
    const memory = new DatabaseSync(join(bank, "mnemopi.db"));
    memory.exec(
      "CREATE TABLE facts (fact_id TEXT, subject TEXT, predicate TEXT, object TEXT, confidence REAL, timestamp TEXT, created_at TEXT); INSERT INTO facts VALUES ('1', 'fixture', 'profile', 'migrated', 1, '2026-01-01', '2026-01-01')",
    );
    memory.close();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CONFIG_DIR", ".omp");
    vi.stubEnv("XDG_DATA_HOME", dataHome);
    vi.stubEnv("XDG_STATE_HOME", stateHome);
    vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
    await withOmpStore({ profile: "work" }, async () => {
      expect((await resolveListOmpConfig({})).config?.theme?.dark).toBe("migrated");
      expect(resolveListOmpQuotas({}).quotas[0]?.provider).toBe("migrated");
      expect(resolveListOmpSessions({ cwd: "/workspace" }).sessions[0]?.prompt).toBe("migrated");
      expect((await resolveListOmpMemory({ cwd: "/workspace" })).facts[0]?.object).toBe("migrated");
      expect(ompSessionDir()).toBe(join(data, "sessions"));
    });
  },
);

test.each(["linux", "darwin", "win32"] as const)(
  "%s resolves each XDG category independently and preserves unmigrated/custom stores",
  async (platform) => {
    const home = await fixture();
    for (let mask = 0; mask < 8; mask += 1) {
      const root = join(home, String(mask));
      const environment = {
        HOME: root,
        OMP_PROFILE: "work",
        PI_CODING_AGENT_DIR: join(root, "wrong"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
      };
      const agent = join(root, ".omp", "profiles", "work", "agent");
      const expected = [agent, agent, agent];
      for (const [index, category] of ["data", "state", "cache"].entries()) {
        // An app root and a different named profile never migrate this profile.
        await mkdir(join(root, category, "omp", "profiles", "other"), { recursive: true });
        if (mask & (1 << index)) {
          const selected = join(root, category, "omp", "profiles", "work");
          await mkdir(selected, { recursive: true });
          if (platform !== "win32") expected[index] = selected;
        }
      }
      expect(ompAgentDir(environment)).toBe(agent);
      expect(ompDataDir(environment, platform)).toBe(expected[0]);
      expect(ompStateDir(environment, platform)).toBe(expected[1]);
      expect(ompCacheDir(environment, platform)).toBe(expected[2]);
      expect(ompSessionDir(environment, platform)).toBe(join(expected[0], "sessions"));
      const custom = join(root, "custom");
      const customEnv = { ...environment, OMP_PROFILE: "", PI_CODING_AGENT_DIR: custom };
      expect([
        ompDataDir(customEnv, platform),
        ompStateDir(customEnv, platform),
        ompCacheDir(customEnv, platform),
      ]).toEqual([custom, custom, custom]);
      const defaults = { ...environment, OMP_PROFILE: "default", PI_CODING_AGENT_DIR: undefined };
      const expectedDefaultData =
        platform === "win32" ? join(root, ".omp", "agent") : join(root, "data", "omp");
      expect(ompDataDir(defaults, platform)).toBe(expectedDefaultData);
      expect(
        ompDataDir({ ...defaults, PI_CODING_AGENT_DIR: join(root, ".omp", "agent") }, platform),
      ).toBe(expectedDefaultData);
    }
  },
);

test("explicit default, inherited profiles and settings keep OMP's precedence", async () => {
  const home = await fixture();
  const agent = join(home, ".omp", "profiles", "work", "agent");
  const environment = {
    HOME: home,
    OMP_PROFILE: "",
    PI_PROFILE: "work",
    PI_CODING_AGENT_DIR: agent,
  };
  expect(ompAgentDir(environment)).toBe(join(home, ".omp", "agent"));
  expect(ompAgentDir({ ...environment, PI_CONFIG_DIR: "" })).toBe(join(home, ".omp", "agent"));
  expect(ompAgentDir({ ...environment, OMP_PROFILE: undefined })).toBe(agent);
  const data = join(home, "data", "omp", "profiles", "work");
  await Promise.all([agent, data].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: "configured" }));
  const selected = { ...environment, OMP_PROFILE: "work", XDG_DATA_HOME: join(home, "data") };
  expect(ompSessionDir(selected, "linux")).toBe(join(agent, "configured"));
  expect(ompSessionDir({ ...selected, OMP_SESSION_DIR: join(home, "explicit") }, "linux")).toBe(
    join(home, "explicit"),
  );
  expect(OmpStoreSchema.safeParse({ agentDir: "relative" }).success).toBe(false);
});

test("absolute directory selectors fail validation before entering the RPC store scope", () => {
  for (const agentDir of ["relative", "../other", "C:relative"]) {
    expect(OmpStoreSchema.safeParse({ agentDir }).success).toBe(false);
    const operation = vi.fn();
    expect(() => withOmpStore({ agentDir }, operation)).toThrow("absolute");
    expect(operation).not.toHaveBeenCalled();
  }
  expect(OmpStoreSchema.safeParse({ agentDir: "C:\\profiles\\agent" }).success).toBe(true);
  if (process.platform !== "win32") {
    expect(() => withOmpStore({ agentDir: "C:\\profiles\\agent" }, () => {})).toThrow(
      "server platform",
    );
  }
});
