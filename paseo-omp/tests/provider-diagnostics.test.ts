import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildStatefulCommandEnv,
  computeOmpProviderHealth,
  computeProcessDiagnostics,
  killWindowsProcessTree,
  type ProbeChildProcess,
  type ProbeReadable,
  type ProviderDiagnosticsDeps,
  probeOmpAvailability,
  resolveExecutablePath,
  resolveGetOmpProviderHealth,
  runBounded,
  type SpawnFn,
  terminatePosixProcessTree,
} from "../server/provider-diagnostics";
import { OmpProviderHealthSchema } from "../shared/provider-diagnostics";

const testOnPosix = process.platform === "win32" ? test.skip : test;

test("stateful OMP commands preserve config selectors without provider credentials", () => {
  const env = buildStatefulCommandEnv({
    PATH: "/bin",
    HOME: "/home/test",
    OMP_PROFILE: "work",
    PI_CODING_AGENT_DIR: "/tmp/agent",
    XDG_CONFIG_HOME: "/tmp/config",
    OPENAI_API_KEY: "must-not-pass",
  });

  expect(env).toMatchObject({
    PATH: "/bin",
    HOME: "/home/test",
    OMP_PROFILE: "work",
    PI_CODING_AGENT_DIR: "/tmp/agent",
    XDG_CONFIG_HOME: "/tmp/config",
  });
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

const temporaryDirectories: string[] = [];
const HOME_DIR = await realpath(tmpdir());

function homeRelative(path: string): string {
  const prefix = HOME_DIR.endsWith(sep) ? HOME_DIR : `${HOME_DIR}${sep}`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length).split(sep).join("/")}` : path;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(dir);
  return dir;
}

async function createFakeBinary(
  dir?: string,
  name = process.platform === "win32" ? "omp.EXE" : "omp",
): Promise<string> {
  const targetDirectory = dir ?? (await tempDir("paseo-omp-bin-"));
  const path = join(targetDirectory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

class FakeReadable implements ProbeReadable {
  private listeners: Array<(chunk: Buffer) => void> = [];
  destroyed = false;

  on(_event: "data", listener: (chunk: Buffer) => void): void {
    this.listeners.push(listener);
  }

  removeAllListeners(): void {
    this.listeners = [];
  }

  destroy(): void {
    this.destroyed = true;
  }

  emit(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const listener of this.listeners) listener(buffer);
  }
}

class FakeChild implements ProbeChildProcess {
  readonly pid = 12345;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly directKillSignals: NodeJS.Signals[] = [];
  terminateCalls = 0;
  closeEvents = 0;
  onTerminate?: (graceMs: number) => Promise<boolean>;
  private errorListeners: Array<(error: NodeJS.ErrnoException) => void> = [];
  private closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  onError(listener: (error: NodeJS.ErrnoException) => void): void {
    this.errorListeners.push(listener);
  }

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListeners.push(listener);
  }

  removeAllListeners(): void {
    this.errorListeners = [];
    this.closeListeners = [];
  }

  terminateDirect(signal: NodeJS.Signals): boolean {
    this.directKillSignals.push(signal);
    return true;
  }

  terminateTree(graceMs: number): Promise<boolean> {
    this.terminateCalls += 1;
    return this.onTerminate?.(graceMs) ?? Promise.resolve(true);
  }

  emitError(code: string): void {
    const error = Object.assign(new Error(code), { code });
    for (const listener of this.errorListeners) listener(error);
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.closeEvents += 1;
    for (const listener of this.closeListeners) listener(code, signal);
  }
}

interface RespondingSpawnOptions {
  versionStdout?: string;
  helpStdout?: string;
  stderr?: string;
  exitCode?: number;
  versionSignal?: NodeJS.Signals;
  helpExitCode?: number;
  captureEnv?: NodeJS.ProcessEnv[];
  captureCwds?: Array<string | undefined>;
}

function respondingSpawn(options: RespondingSpawnOptions = {}): SpawnFn {
  return (_command, args, env, cwd) => {
    options.captureEnv?.push({ ...env });
    options.captureCwds?.push(cwd);
    const child = new FakeChild();
    const isVersion = args.includes("--version");
    queueMicrotask(() => {
      child.stdout.emit(
        isVersion
          ? (options.versionStdout ?? "omp/18.1.15\n")
          : (options.helpStdout ??
              "--mode=<value>  Output mode: text (default), json, rpc, or rpc-ui\n" +
                "lsp  - Language server protocol (code intelligence)\n"),
      );
      if (options.stderr) child.stderr.emit(options.stderr);
      child.emitClose(
        isVersion ? (options.exitCode ?? 0) : (options.helpExitCode ?? 0),
        isVersion ? (options.versionSignal ?? null) : null,
      );
    });
    return child;
  };
}

function baseDeps(
  agentDir: string,
  binaryDir: string,
  overrides: Partial<ProviderDiagnosticsDeps> = {},
): ProviderDiagnosticsDeps {
  return {
    agentDir,
    command: "omp",
    pathDirs: [binaryDir],
    cwd: agentDir,
    platform: process.platform,
    pathExt: ".EXE;.CMD",
    env: { PATH: binaryDir, HOME: agentDir },
    spawnFn: respondingSpawn(),
    hubRunRoot: join(agentDir, "hub-run"),
    homeDir: HOME_DIR,
    ...overrides,
  };
}

async function writeDaemonEntry(hubRunRoot: string, project: string, name: string): Promise<void> {
  const dir = join(hubRunRoot, project, "daemons", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), "{}");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveExecutablePath", () => {
  testOnPosix("finds the first executable and returns its realpath", async () => {
    const dir = await tempDir("paseo-omp-bin-");
    const target = await createFakeBinary(dir, "omp-real");
    const link = join(dir, "omp");
    await symlink(target, link);

    expect(
      await resolveExecutablePath("omp", [dir], {
        cwd: dir,
        platform: "linux",
        pathExt: ".EXE",
      }),
    ).toBe(await realpath(target));
  });

  test("skips empty PATH entries and resolves relative entries against explicit cwd", async () => {
    const cwd = await tempDir("paseo-omp-cwd-");
    const binDir = join(cwd, "bin");
    await mkdir(binDir);
    const target = await createFakeBinary(binDir, "omp");

    expect(
      await resolveExecutablePath("omp", ["", "bin"], {
        cwd,
        platform: "linux",
        pathExt: ".EXE",
      }),
    ).toBe(await realpath(target));
  });

  test("uses PATHEXT when resolving a Windows command", async () => {
    const dir = await tempDir("paseo-omp-win-bin-");
    const target = await createFakeBinary(dir, "omp.EXE");

    expect(
      await resolveExecutablePath("omp", [dir], {
        cwd: dir,
        platform: "win32",
        pathExt: ".EXE;.CMD",
      }),
    ).toBe(await realpath(target));
  });

  test("checks a literal relative path against explicit cwd", async () => {
    const cwd = await tempDir("paseo-omp-cwd-");
    const binDir = join(cwd, "bin");
    await mkdir(binDir);
    const target = await createFakeBinary(binDir, "omp");

    expect(
      await resolveExecutablePath(relative(cwd, target).split(sep).join("/"), ["/ignored"], {
        cwd,
        platform: "linux",
        pathExt: ".EXE",
      }),
    ).toBe(await realpath(target));
  });
});

describe("runBounded", () => {
  test("preserves exit code and signal from close", async () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emitClose(7, "SIGTERM"));

    const result = await runBounded(() => child, "omp", ["--version"], {}, 100, 20, 64);

    expect(result).toMatchObject({
      outcome: "exited",
      exitCode: 7,
      signal: "SIGTERM",
      truncated: false,
      cleanupFailed: false,
    });
  });

  test("waits for tree cleanup after the timed-out leader closes", async () => {
    const child = new FakeChild();
    const cleanup = Promise.withResolvers<boolean>();
    const terminationStarted = Promise.withResolvers<void>();
    child.onTerminate = () => {
      terminationStarted.resolve();
      queueMicrotask(() => child.emitClose(null, "SIGTERM"));
      return cleanup.promise;
    };

    const resultPromise = runBounded(() => child, "omp", ["--help"], {}, 0, 0, 64);
    await terminationStarted.promise;
    await Promise.resolve();
    expect(child.closeEvents).toBe(1);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolve(true);
    const result = await resultPromise;
    expect(child.terminateCalls).toBe(1);
    expect(result).toMatchObject({ outcome: "timeout", signal: "SIGTERM", cleanupFailed: false });
  });

  test("reports cleanup failure after cleanup and leader-close deadlines", async () => {
    const child = new FakeChild();
    child.onTerminate = async () => false;

    const result = await runBounded(() => child, "omp", ["--help"], {}, 0, 0, 64);

    expect(child.terminateCalls).toBe(1);
    expect(child.closeEvents).toBe(0);
    expect(result).toMatchObject({ outcome: "timeout", cleanupFailed: true });
  });

  test("caps output in bytes and marks an oversized single chunk truncated", async () => {
    const child = new FakeChild();
    queueMicrotask(() => {
      child.stdout.emit(Buffer.from("0123456789SECRET"));
      child.emitClose(0, null);
    });

    const result = await runBounded(() => child, "omp", ["--help"], {}, 100, 20, 10);

    expect(result.stdout).toBe("0123456789");
    expect(Buffer.byteLength(result.stdout)).toBe(10);
    expect(result.truncated).toBe(true);
  });
});

describe("terminatePosixProcessTree", () => {
  test("continues TERM-to-KILL escalation after the leader may have closed", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    const signalProcess = (_pid: number, signal: NodeJS.Signals | 0) => {
      signals.push(signal);
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };

    const terminated = await terminatePosixProcessTree(42, 1, signalProcess, async () => {});

    expect(terminated).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL", 0]);
  });
});

describe("killWindowsProcessTree", () => {
  const SYSTEM_ROOT = "C:\\Windows";
  const EXPECTED_TASKKILL_PATH = join(SYSTEM_ROOT, "System32", "taskkill.exe");

  test("resolves the absolute System32 taskkill.exe path rather than PATH search", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const child = new FakeChild();
    queueMicrotask(() => child.emitClose(0, null));
    const spawnFn: SpawnFn = (command, args) => {
      calls.push({ command, args });
      return child;
    };

    expect(await killWindowsProcessTree(4321, spawnFn, SYSTEM_ROOT, 200)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(EXPECTED_TASKKILL_PATH);
    expect(calls[0]?.args).toEqual(["/pid", "4321", "/t", "/f"]);
  });

  test("resolves true when taskkill closes successfully", async () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emitClose(0, null));

    expect(await killWindowsProcessTree(1, () => child, SYSTEM_ROOT, 5_000)).toBe(true);
  });

  test("awaits a taskkill error and returns false without an unhandled error", async () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emitError("ENOENT"));

    expect(await killWindowsProcessTree(1, () => child, SYSTEM_ROOT, 5_000)).toBe(false);
  });

  test("awaits taskkill close and propagates a nonzero exit as cleanup failure", async () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emitClose(1, null));

    expect(await killWindowsProcessTree(1, () => child, SYSTEM_ROOT, 5_000)).toBe(false);
  });

  test("returns false when the spawn itself fails synchronously", async () => {
    const spawnFn: SpawnFn = () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    };

    await expect(killWindowsProcessTree(1, spawnFn, SYSTEM_ROOT, 200)).resolves.toBe(false);
  });

  test("directly terminates a timed-out taskkill helper before final failure", async () => {
    const child = new FakeChild();
    const scheduled: Array<() => void> = [];
    const schedule = (callback: () => void) => {
      scheduled.push(callback);
      return () => {};
    };
    const resultPromise = killWindowsProcessTree(1, () => child, SYSTEM_ROOT, 100, schedule);

    scheduled.shift()?.();
    expect(child.directKillSignals).toEqual(["SIGKILL"]);
    scheduled.shift()?.();

    expect(await resultPromise).toBe(false);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});

describe("probeOmpAvailability", () => {
  test("classifies available, missing, and incompatible OMP runtimes", async () => {
    const binaryDir = await tempDir("paseo-omp-availability-");
    const binary = await createFakeBinary(
      binaryDir,
      process.platform === "win32" ? "omp.EXE" : "omp",
    );
    const base = {
      command: [binary] as const,
      cwd: binaryDir,
      environment: { PATH: binaryDir, HOME: binaryDir },
      platform: process.platform,
      timeoutMs: 1_000,
    };
    await expect(probeOmpAvailability({ ...base, spawnFn: respondingSpawn() })).resolves.toEqual({
      status: "available",
    });
    await expect(
      probeOmpAvailability({
        ...base,
        spawnFn: respondingSpawn({ helpStdout: "--mode=<value> Output mode: text\n" }),
      }),
    ).resolves.toEqual({
      status: "incompatible",
      diagnostic: "OMP does not advertise rpc-ui support",
    });
    await expect(
      probeOmpAvailability({ ...base, command: [join(binaryDir, "missing")] }),
    ).resolves.toEqual({ status: "missing", diagnostic: "OMP executable was not found" });
  });
  test("spawns relative wrapper commands from the requested workspace", async () => {
    const workspace = await tempDir("paseo-omp-workspace-");
    await createFakeBinary(
      workspace,
      process.platform === "win32" ? "omp-wrapper.EXE" : "omp-wrapper",
    );
    const capturedCwds: Array<string | undefined> = [];
    await expect(
      probeOmpAvailability({
        command: [process.platform === "win32" ? ".\\omp-wrapper.EXE" : "./omp-wrapper"],
        cwd: workspace,
        environment: { PATH: "/missing", HOME: workspace },
        platform: process.platform,
        timeoutMs: 1_000,
        spawnFn: respondingSpawn({ captureCwds: capturedCwds }),
      }),
    ).resolves.toEqual({ status: "available" });
    expect(capturedCwds).toEqual([workspace, workspace]);
  });
});

describe("computeOmpProviderHealth", () => {
  test("reports safe provider, storage, process, and compatibility facts", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    const binary = await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");
    const hubRunRoot = join(agentDir, "hub-run");
    await mkdir(join(agentDir, "sessions"));
    await writeFile(join(agentDir, "agent.db"), "");
    await writeFile(join(agentDir, "history.db"), "");
    await writeFile(join(agentDir, "config.yml"), "memory:\n  backend: mnemopi\n");
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }),
    );
    await writeDaemonEntry(hubRunRoot, "project-a", "one");
    await writeDaemonEntry(hubRunRoot, "project-a", "two");
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const capturedCwds: Array<string | undefined> = [];

    const health = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        hubRunRoot,
        env: {
          PATH: binaryDir,
          HOME: agentDir,
          LANG: "C.UTF-8",
          API_KEY: "must-not-reach-child",
          MCP_HEADERS: "must-not-reach-child",
        },
        spawnFn: respondingSpawn({ captureEnv: capturedEnvs, captureCwds: capturedCwds }),
      }),
    );

    expect(health.binary).toEqual({
      installed: true,
      resolvedPath: homeRelative(binary),
      version: { major: 18, minor: 1, patch: 15, prerelease: null },
      versionStatus: "ok",
      processCleanupFailed: false,
    });
    expect(health.mcp).toEqual({
      status: "configured",
      serverCount: 2,
      reason: null,
    });
    expect(health.process).toEqual({ status: "ok", trackedCount: 2 });
    expect(health.roots).toEqual({
      agentRoot: homeRelative(agentDir),
      agentRootState: "available",
      configPath: homeRelative(join(agentDir, "config.yml")),
      configState: "available",
      sessionRoot: homeRelative(join(agentDir, "sessions")),
      sessionRootState: "available",
    });
    expect(health.databases).toEqual({
      agentDbState: "available",
      historyDbState: "available",
    });
    expect(health.memoryBackend).toBe("mnemopi");
    expect(capturedEnvs).toHaveLength(2);
    expect(capturedCwds).toEqual([agentDir, agentDir]);
    for (const env of capturedEnvs) {
      expect(env.API_KEY).toBeUndefined();
      expect(env.MCP_HEADERS).toBeUndefined();
      expect(env.PATH).toBe(binaryDir);
      expect(env.HOME).toBe(agentDir);
    }
    expect(OmpProviderHealthSchema.safeParse(health).success).toBe(true);
  });

  test("reports not-found and never spawns when the binary cannot be resolved", async () => {
    const agentDir = await tempDir("paseo-omp-agent-");
    let spawnCalls = 0;
    const spawnFn: SpawnFn = () => {
      spawnCalls += 1;
      throw new Error("spawn should not run for an unresolved binary");
    };

    const health = await computeOmpProviderHealth(
      baseDeps(agentDir, "/does/not/exist", { spawnFn }),
    );

    expect(health.binary).toMatchObject({
      installed: false,
      resolvedPath: null,
      version: null,
      versionStatus: "not-found",
    });
    expect(health.rpcUi).toEqual({ checked: false, supported: null });
    expect(spawnCalls).toBe(0);
  });

  test("distinguishes a resolved but unrunnable executable from not-found", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");
    const spawnFn: SpawnFn = () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };

    const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir, { spawnFn }));

    expect(health.binary.versionStatus).toBe("unrunnable");
  });

  describe("strict single-line canonical version acceptance", () => {
    test("rejects a canonical-looking line when the process exits nonzero", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15\n", exitCode: 1 }),
        }),
      );

      expect(health.binary.versionStatus).toBe("probe-failed");
      expect(health.binary.version).toBeNull();
    });

    test("rejects a canonical-looking line when the process was signaled", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15\n", versionSignal: "SIGKILL" }),
        }),
      );

      expect(health.binary.versionStatus).toBe("probe-failed");
      expect(health.binary.version).toBeNull();
    });

    test("rejects a canonical line accompanied by extra output lines", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15\nSECRET_TOKEN=abc123\n" }),
        }),
      );

      expect(health.binary.versionStatus).toBe("malformed");
      expect(health.binary.version).toBeNull();
      expect(JSON.stringify(health)).not.toContain("SECRET_TOKEN");
    });

    test("rejects a canonical line when the probe output was truncated", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          maxVersionBytes: Buffer.byteLength("omp/18.1.15"),
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15EXTRA" }),
        }),
      );

      expect(health.binary.versionStatus).toBe("malformed");
      expect(health.binary.version).toBeNull();
    });
  });

  test("treats failed, empty, and truncated help as unknown instead of unsupported", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");

    const empty = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        spawnFn: respondingSpawn({ helpStdout: "" }),
      }),
    );
    const failed = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        spawnFn: respondingSpawn({ helpStdout: "--mode=<value> rpc-ui\n", helpExitCode: 2 }),
      }),
    );
    const truncated = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        maxHelpBytes: 8,
        spawnFn: respondingSpawn({ helpStdout: "--mode=<value> rpc-ui\n" }),
      }),
    );

    expect(empty.rpcUi.supported).toBeNull();
    expect(failed.rpcUi.supported).toBeNull();
    expect(truncated.rpcUi.supported).toBeNull();
    expect(truncated.lsp.status).toBe("unknown");
  });

  describe("config diagnostics", () => {
    test("classifies missing, invalid, wrong-type, and available filesystem states", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);

      const missingDir = await tempDir("paseo-omp-missing-");
      const missing = await computeOmpProviderHealth(baseDeps(missingDir, binaryDir));
      expect(missing.roots.configState).toBe("missing");
      const invalidDir = await tempDir("paseo-omp-invalid-");
      await writeFile(join(invalidDir, "config.yml"), "memory: [\n");
      const invalid = await computeOmpProviderHealth(baseDeps(invalidDir, binaryDir));
      expect(invalid.roots.configState).toBe("invalid");

      const wrongTypeDir = await tempDir("paseo-omp-wrong-type-");
      await mkdir(join(wrongTypeDir, "config.yml"));
      const wrongType = await computeOmpProviderHealth(baseDeps(wrongTypeDir, binaryDir));
      expect(wrongType.roots.configState).toBe("wrong-type");

      const availableDir = await tempDir("paseo-omp-available-");
      await writeFile(join(availableDir, "config.yml"), "memory:\n  backend: local\n");
      const available = await computeOmpProviderHealth(baseDeps(availableDir, binaryDir));
      expect(available.roots.configState).toBe("available");
      expect(available.memoryBackend).toBe("local");
    });

    test("treats a non-mapping YAML root as invalid rather than available", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "config.yml"), "- one\n- two\n");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.roots.configState).toBe("invalid");
      expect(health.memoryBackend).toBeNull();
    });

    test("treats an invalid memory.backend value as invalid, not merely unset", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "config.yml"), "memory:\n  backend: not-a-real-backend\n");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.roots.configState).toBe("invalid");
      expect(health.memoryBackend).toBeNull();
    });
  });

  describe("MCP manifest diagnostics", () => {
    test("reports a specific unavailable reason backed by the checked filename", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp.status).toBe("unavailable");
      expect(health.mcp.reason).toContain("mcp.json");
      expect(health.mcp.serverCount).toBeNull();
    });

    test("reports invalid for malformed JSON without leaking file content", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "mcp.json"), "{ not json SECRET_SAUCE");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp.status).toBe("invalid");
      expect(JSON.stringify(health)).not.toContain("SECRET_SAUCE");
    });

    test("reports invalid when mcpServers is not the expected shape", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: "nope" }));

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp.status).toBe("invalid");
    });

    test("never forwards server names or nested credentials", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(
        join(agentDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "private-descope-name": { command: "npx", env: { API_KEY: "top-secret-value" } },
          },
        }),
      );

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp).toEqual({ status: "configured", serverCount: 1, reason: null });
      const serialized = JSON.stringify(health);
      expect(serialized).not.toContain("private-descope-name");
      expect(serialized).not.toContain("top-secret-value");
      expect(serialized).not.toContain("npx");
    });
  });

  describe("process filtering", () => {
    test("counts regular meta.json files and reports unexpected access failures", async () => {
      const root = "/virtual/hub";
      const projectADaemons = join(root, "project-a", "daemons");
      const projectBDaemons = join(root, "project-b", "daemons");
      const fixture = await tempDir("paseo-omp-meta-");
      const metaPath = join(fixture, "meta.json");
      await writeFile(metaPath, "{}");
      const directoryStats = await lstat(fixture);
      const metaStats = await lstat(metaPath);
      const fs = {
        async readdir(path: string): Promise<string[]> {
          if (path === root) return ["project-a", "project-b"];
          if (path === projectADaemons) return ["real", "missing"];
          if (path === projectBDaemons) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          return [];
        },
        async lstat(path: string) {
          if (
            path === root ||
            path === join(root, "project-a") ||
            path === join(root, "project-b") ||
            path === projectADaemons ||
            path === projectBDaemons
          ) {
            return directoryStats;
          }
          if (path === join(projectADaemons, "real", "meta.json")) return metaStats;
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      };

      expect(await computeProcessDiagnostics(root, fs)).toEqual({
        status: "partial",
        trackedCount: 1,
      });
    });

    test("unexpected meta.json stat failures also make the result partial", async () => {
      const root = "/virtual/hub";
      const projectDir = join(root, "project");
      const daemonsDir = join(projectDir, "daemons");
      const fixture = await tempDir("paseo-omp-dir-");
      const directoryStats = await lstat(fixture);
      const fs = {
        async readdir(path: string): Promise<string[]> {
          return path === root ? ["project"] : ["blocked"];
        },
        async lstat(path: string) {
          if (path === root || path === projectDir || path === daemonsDir) return directoryStats;
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      };

      expect(await computeProcessDiagnostics(root, fs)).toEqual({
        status: "partial",
        trackedCount: 0,
      });
    });

    test("reports unavailable when the hub run root does not exist", async () => {
      const fs = {
        async readdir(): Promise<string[]> {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        async lstat() {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      };
      expect(await computeProcessDiagnostics("/missing", fs)).toEqual({
        status: "unavailable",
        trackedCount: null,
      });
    });
  });

  describe("path sanitization", () => {
    test("renders a constant custom-path label without leaking its basename", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, { homeDir: "/nonexistent-home-for-tests" }),
      );

      expect(health.roots.agentRoot).toBe("<custom path>");
      expect(health.binary.resolvedPath).toBe("<custom path>");
      expect(health.roots.configPath).toBe("<custom path>/config.yml");
      expect(JSON.stringify(health)).not.toContain("paseo-omp-agent-");
      expect(JSON.stringify(health)).not.toContain("paseo-omp-bin-");
    });

    test("renders home-relative paths for roots under the configured home", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.roots.agentRoot).toBe(homeRelative(agentDir));
      expect(health.roots.agentRoot.startsWith("~")).toBe(true);
      expect(health.roots.agentRoot).not.toBe(agentDir);
    });

    test("normalizes trailing separators before deriving child labels", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(`${agentDir}${sep}`, binaryDir, { homeDir: "/outside" }),
      );

      expect(health.roots.agentRoot).toBe("<custom path>");
      expect(health.roots.configPath).toBe("<custom path>/config.yml");
      expect(health.roots.sessionRoot).toBe("<custom path>/sessions");
    });

    test("never forwards a raw env-overridden command path unsanitized", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      const binaryPath = await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          command: binaryPath,
          pathDirs: [],
          homeDir: "/nonexistent-home-for-tests",
        }),
      );

      expect(health.binary.resolvedPath).not.toBe(binaryPath);
      expect(health.binary.resolvedPath).toBe("<custom path>");
    });
  });

  testOnPosix("resolves, single-flights, and caches real provider health probes", async () => {
    const root = await tempDir("paseo-omp-health-resolver-");
    const binary = join(root, "omp");
    await writeFile(
      binary,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "omp/18.1.15\\n"; else printf "%s\\n" "--mode=<value>  Output mode: text (default), json, rpc, or rpc-ui" "lsp  - Language server protocol (code intelligence)"; fi\n',
    );
    await chmod(binary, 0o755);
    const previous = {
      agentDir: process.env.PASEO_OMP_AGENT_DIR,
      command: process.env.OMP_COMMAND,
      runDir: process.env.PASEO_OMP_RUN_DIR,
    };
    process.env.PASEO_OMP_AGENT_DIR = root;
    process.env.PASEO_OMP_RUN_DIR = join(root, "run");
    process.env.OMP_COMMAND = binary;
    try {
      const [first, concurrent] = await Promise.all([
        resolveGetOmpProviderHealth({ force: true }),
        resolveGetOmpProviderHealth({ force: true }),
      ]);
      expect(first).toEqual(concurrent);
      expect(first.binary).toMatchObject({
        installed: true,
        version: { major: 18, minor: 1, patch: 15, prerelease: null },
      });
      expect(first.rpcUi.supported).toBe(true);
      await expect(resolveGetOmpProviderHealth({ force: false })).resolves.toEqual(first);
    } finally {
      if (previous.agentDir === undefined) delete process.env.PASEO_OMP_AGENT_DIR;
      else process.env.PASEO_OMP_AGENT_DIR = previous.agentDir;
      if (previous.command === undefined) delete process.env.OMP_COMMAND;
      else process.env.OMP_COMMAND = previous.command;
      if (previous.runDir === undefined) delete process.env.PASEO_OMP_RUN_DIR;
      else process.env.PASEO_OMP_RUN_DIR = previous.runDir;
    }
  });
});
