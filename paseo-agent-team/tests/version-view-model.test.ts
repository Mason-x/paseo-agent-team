import { describe, expect, test } from "vitest";
import {
  AUTO_CHECK_INTERVAL_MS,
  adoptJobSnapshot,
  blockerViews,
  checkedAtLabel,
  currentVersionText,
  headerVersionView,
  isCheckFresh,
  jobStateText,
  phaseText,
  relationText,
  remedyText,
  remoteLatestLabel,
  resolveRecoveryStep,
  resolveUpdatePoll,
  shortCommit,
  shouldAdoptLatestUpdateJob,
  shouldAutoCheck,
  shouldCheckAfterUpdate,
  sourceLabel,
  statusView,
  targetLabel,
  updateButtonView,
  updateConfirmation,
  updateConfirmationLines,
  versionQueryKey,
} from "../client/version/view-model";
import {
  type Blocker,
  BlockerCodeSchema,
  blocker,
  CHECK_TTL_MS,
  type Current,
  type Job,
  JobSchema,
  JobStateSchema,
  PhaseSchema,
  RelationSchema,
  RemedyCodeSchema,
  type RemoteTarget,
  type VersionInfo,
  VersionInfoSchema,
} from "../shared/version";
import { zh } from "../shared/zh";

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const NOW = "2026-10-26T12:00:00.000Z";
const CHECK_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_JOB_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_REQUEST_ID = "66666666-6666-4666-8666-666666666666";

const target: RemoteTarget = {
  kind: "release-tag",
  version: "0.2.4",
  commit: NEXT,
  ref: "refs/tags/paseo-agent-team-v0.2.4",
  sourceUrl: "https://github.com/example/repo",
};

const current: Current = {
  packageVersion: "0.2.3",
  commit: SHA,
  branch: "main",
  dirty: false,
  pluginPath: "/work/paseo-agent-team",
  repositoryPath: "/work",
  observedAt: NOW,
};

function info(patch: Partial<VersionInfo> = {}): VersionInfo {
  return VersionInfoSchema.parse({
    schemaVersion: 1,
    current,
    installSource: {
      kind: "directory",
      path: "/work/paseo-agent-team",
      isGit: true,
    },
    remote: {
      state: "ready",
      repositoryLatest: target,
      installTarget: target,
      checkedAt: NOW,
      stale: false,
      error: null,
    },
    relation: "behind",
    updateAvailable: true,
    canUpdate: true,
    cliAvailable: true,
    checkId: CHECK_ID,
    blockers: [],
    ...patch,
  });
}

function job(state: Job["state"], phase: Job["phase"], overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    schemaVersion: 1,
    id: JOB_ID,
    requestId: REQUEST_ID,
    kind: "update",
    state,
    phase,
    seq: 1,
    startedAt: NOW,
    updatedAt: NOW,
    finishedAt: state === "running" || state === "queued" ? null : NOW,
    from: current,
    target,
    result: null,
    error: null,
    rollback: "not-needed",
    ...overrides,
  });
}

describe("header entry", () => {
  test("an available update is marked, and up to date is distinct from unknown", () => {
    expect(headerVersionView(info()).status).toBe("update");
    expect(headerVersionView(info({ updateAvailable: false, relation: "equal" })).status).toBe(
      "latest",
    );
    const failed = info({
      updateAvailable: null,
      relation: "unknown",
      remote: {
        state: "error",
        repositoryLatest: null,
        installTarget: null,
        checkedAt: NOW,
        stale: true,
        error: blocker("network_error", "retry_check"),
      },
      blockers: [blocker("network_error", "retry_check")],
    });
    const header = headerVersionView(failed);
    expect(header.status).toBe("unknown");
    expect(header.statusText).not.toBe(zh.versionLatest);
    expect(headerVersionView(null).status).toBe("unknown");
    expect(header.versionLabel).toContain("0.2.3");
    const failedCheck = job("failed", "done", {
      kind: "check",
      error: blocker("network_error", "retry_check"),
    });
    expect(
      headerVersionView(info({ updateAvailable: false, relation: "equal" }), failedCheck).status,
    ).toBe("unknown");
  });
});

describe("labels", () => {
  test("formats source, target, version, and short commits", () => {
    expect(shortCommit(SHA)).toBe("aaaaaaa");
    expect(shortCommit(null)).toBe(zh.versionNotAvailable);
    expect(currentVersionText(info())).toBe(`0.2.3 · aaaaaaa`);
    expect(targetLabel(target)).toBe("paseo-agent-team-v0.2.4");
    expect(
      targetLabel({
        kind: "default-branch",
        version: "0.2.4",
        commit: NEXT,
        ref: "refs/heads/main",
        sourceUrl: null,
      }),
    ).toBe("main @ bbbbbbb（版本 0.2.4）");
    expect(sourceLabel({ kind: "directory", path: "/x", isGit: false })).toBe(
      zh.versionSourceDirectory,
    );
    expect(
      sourceLabel({
        kind: "git",
        remote: "https://example/repo",
        pluginPath: "/x",
        installedCommit: SHA,
        ref: "main",
        registry: null,
      }),
    ).toBe(zh.versionSourceManagedGit);
    expect(
      sourceLabel({
        kind: "git",
        remote: "https://example/repo",
        pluginPath: "/x",
        installedCommit: SHA,
        ref: "main",
        registry: { url: "https://registry", id: "pkg" },
      }),
    ).toBe(zh.versionSourceRegistry);
    expect(
      sourceLabel({
        kind: "npm",
        packageName: "@mason-x/paseo-agent-team",
        pluginPath: "/x",
        installedVersion: "0.2.3",
        registry: null,
      }),
    ).toBe(zh.versionSourceNpm);
    expect(sourceLabel({ kind: "unknown" })).toBe(zh.versionSourceUnknown);
  });

  test("shows the remote state when no target exists", () => {
    expect(remoteLatestLabel(info())).toBe("paseo-agent-team-v0.2.4");
    const errorRemote = {
      state: "error" as const,
      repositoryLatest: null,
      installTarget: null,
      checkedAt: NOW,
      stale: true,
      error: blocker("network_error", "retry_check"),
    };
    expect(remoteLatestLabel(info({ remote: errorRemote }))).toBe(zh.versionCheckFailed);
    const staleRemote = {
      ...errorRemote,
      repositoryLatest: target,
      installTarget: target,
    };
    const staleInfo = info({ remote: staleRemote });
    expect(remoteLatestLabel(staleInfo)).toContain(zh.versionStale);
    expect(checkedAtLabel(staleInfo)).toContain(zh.versionStale);
    expect(checkedAtLabel(info())).toContain("2026");
  });

  test("every enum member has Chinese copy", () => {
    for (const code of BlockerCodeSchema.options) {
      const views = blockerViews([{ code, remedy: "retry_check", detail: null }]);
      expect(views[0]?.reason.length).toBeGreaterThan(0);
      expect(views[0]?.next.length).toBeGreaterThan(0);
    }
    for (const remedy of RemedyCodeSchema.options) {
      expect(remedyText(remedy).length).toBeGreaterThan(0);
    }
    for (const phase of PhaseSchema.options) {
      expect(phaseText(phase).length).toBeGreaterThan(0);
    }
    for (const state of JobStateSchema.options) {
      expect(jobStateText(state).length).toBeGreaterThan(0);
    }
    for (const relation of RelationSchema.options) {
      expect(relationText(relation).length).toBeGreaterThan(0);
    }
  });
});

describe("status", () => {
  test("a reconnect is a temporary state, not a failure", () => {
    const view = statusView(info(), null, true);
    expect(view.title).toBe(zh.versionReconnecting);
    expect(view.tone).toBe("warning");
  });

  test("blockers and relations pick the primary status", () => {
    const dirty: Blocker[] = [blocker("dirty", "inspect_local_changes")];
    expect(statusView(info({ blockers: dirty }), null, false).title).toBe(
      zh.versionBlockers.dirty.reason,
    );
    expect(statusView(info({ relation: "ahead", updateAvailable: false }), null, false).title).toBe(
      relationText("ahead"),
    );
    expect(
      statusView(info({ relation: "diverged", updateAvailable: false }), null, false).title,
    ).toBe(relationText("diverged"));
    expect(
      statusView(
        info({
          installSource: { kind: "directory", path: "/x", isGit: false },
          updateAvailable: null,
        }),
        null,
        false,
      ).title,
    ).toBe(zh.versionBlockers.not_git.reason);
  });

  test("a same-version fast-forward is still an update", () => {
    const sameVersion = info({
      remote: {
        ...info().remote,
        installTarget: { ...target, version: "0.2.3" },
        repositoryLatest: { ...target, version: "0.2.3" },
      },
    });
    expect(statusView(sameVersion, null, false).title).toBe(zh.versionSameVersionUpdate);
  });

  test("update jobs report progress and every terminal state", () => {
    const running = statusView(info(), job("running", "installing"), false);
    expect(running.title).toContain(phaseText("installing"));
    expect(statusView(info(), job("succeeded", "done"), false).tone).toBe("success");
    expect(statusView(info(), job("rolled_back", "done"), false).title).toBe(
      jobStateText("rolled_back"),
    );
    expect(statusView(info(), job("recovery_required", "reconciling"), false).title).toBe(
      jobStateText("recovery_required"),
    );
    expect(
      statusView(
        info(),
        job("failed", "done", { error: blocker("command_failed", "retry_check") }),
        false,
      ).title,
    ).toBe(jobStateText("failed"));
  });

  test("every terminal update state has a status title", () => {
    for (const state of [
      "succeeded",
      "blocked",
      "failed",
      "rolled_back",
      "recovery_required",
    ] as const) {
      const phase =
        state === "rolled_back" ? "done" : state === "recovery_required" ? "reconciling" : "done";
      expect(statusView(info(), job(state, phase), false).title).toBe(jobStateText(state));
    }
  });

  test("a failed check keeps the check-failure status", () => {
    const failedCheck = job("failed", "done", {
      kind: "check",
      error: blocker("network_error", "retry_check"),
    });
    expect(statusView(info(), failedCheck, false).title).toBe(zh.versionCheckFailed);
  });
});

describe("update availability", () => {
  test("enables the button only for an actionable git update", () => {
    expect(updateButtonView(info(), null, Date.parse(NOW))).toEqual({
      visible: true,
      enabled: true,
      requiresCheck: false,
      reason: null,
    });
    expect(
      updateButtonView(
        info({
          updateAvailable: true,
          canUpdate: false,
          blockers: [blocker("dirty", "inspect_local_changes")],
        }),
        null,
      ),
    ).toMatchObject({ visible: true, enabled: false });
    expect(updateButtonView(info(), job("running", "preflight"))).toMatchObject({
      visible: true,
      enabled: false,
    });
  });

  test("requires a fresh check before using a persisted checkId", () => {
    const checkedAt = Date.parse(NOW);
    expect(isCheckFresh(info(), checkedAt)).toBe(true);
    expect(isCheckFresh(info(), checkedAt + CHECK_TTL_MS + 1)).toBe(false);
    const stale = updateButtonView(info(), null, checkedAt + CHECK_TTL_MS + 1);
    expect(stale).toMatchObject({
      visible: true,
      enabled: false,
      requiresCheck: true,
      reason: zh.versionCheckExpired,
    });
  });

  test("hides one-click updates for npm, registry, and unknown sources", () => {
    const npm = info({
      installSource: {
        kind: "npm",
        packageName: "@mason-x/paseo-agent-team",
        pluginPath: "/x",
        installedVersion: "0.2.3",
        registry: null,
      },
      updateAvailable: null,
      canUpdate: false,
    });
    expect(updateButtonView(npm, null).visible).toBe(false);
    const registry = info({
      installSource: {
        kind: "git",
        remote: "https://example/repo",
        pluginPath: "/x",
        installedCommit: SHA,
        ref: "main",
        registry: { url: "https://registry", id: "pkg" },
      },
    });
    expect(updateButtonView(registry, null).visible).toBe(false);
    expect(updateButtonView(info({ installSource: { kind: "unknown" } }), null).visible).toBe(
      false,
    );
  });

  test("keeps a disabled button for a non-git directory", () => {
    const nonGit = info({
      installSource: { kind: "directory", path: "/x", isGit: false },
      updateAvailable: null,
      canUpdate: false,
    });
    expect(updateButtonView(nonGit, null)).toMatchObject({ visible: true, enabled: false });
  });
});

describe("six-hour auto check", () => {
  const now = Date.parse(NOW);
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();

  test("checks when never checked or older than six hours", () => {
    expect(
      shouldAutoCheck(info({ remote: { ...info().remote, checkedAt: null } }), null, now),
    ).toBe(true);
    expect(
      shouldAutoCheck(info({ remote: { ...info().remote, checkedAt: at(7) } }), null, now),
    ).toBe(true);
    expect(
      shouldAutoCheck(info({ remote: { ...info().remote, checkedAt: at(5) } }), null, now),
    ).toBe(false);
  });

  test("a recent failed check also throttles the next automatic attempt", () => {
    const failedCheck = job("failed", "done", {
      kind: "check",
      startedAt: at(1),
      updatedAt: at(1),
      finishedAt: at(1),
    });
    expect(
      shouldAutoCheck(info({ remote: { ...info().remote, checkedAt: null } }), failedCheck, now),
    ).toBe(false);
  });

  test("never auto-checks while an update is running", () => {
    expect(
      shouldAutoCheck(
        info({ remote: { ...info().remote, checkedAt: null } }),
        job("running", "fetching"),
        now,
      ),
    ).toBe(false);
  });

  test("the interval is six hours", () => {
    expect(AUTO_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe("confirmation", () => {
  test("lists source, current, target, and the restart warning", () => {
    const lines = updateConfirmationLines(info());
    expect(lines[0]).toBe(zh.versionConfirmSource(zh.versionSourceDirectoryGit));
    expect(lines[1]).toContain("0.2.3");
    expect(lines[2]).toContain("paseo-agent-team-v0.2.4");
    expect(lines[2]).toContain("bbbbbbb");
    expect(lines).toContain(zh.versionConfirmNpmCi);
    expect(lines.at(-1)).toBe(zh.versionConfirmRestart);
    const confirmation = updateConfirmation(info());
    expect(confirmation?.commits).toHaveLength(1);
    expect(confirmation?.npmCi).toBe(zh.versionConfirmNpmCi);
  });
});

describe("reconnect and recovery", () => {
  const started = Date.parse(NOW);
  const recentJob = job("running", "fetching");
  const foreignActive = job("running", "installing", {
    id: OTHER_JOB_ID,
    requestId: OTHER_REQUEST_ID,
  });
  const oldJob = job("succeeded", "done", {
    updatedAt: new Date(started - 60_000).toISOString(),
    finishedAt: new Date(started - 60_000).toISOString(),
  });

  test("a transport failure only reconnects and never retries start", () => {
    expect(
      resolveRecoveryStep({
        job: null,
        failed: true,
        startedAtMs: started,
        nowMs: started + 120_000,
        requestId: REQUEST_ID,
      }),
    ).toBe("reconnecting");
  });

  test("only a matching request id is claimed, regardless of clock skew", () => {
    expect(
      resolveRecoveryStep({
        job: oldJob,
        failed: false,
        startedAtMs: started + 60_000,
        nowMs: started + 60_000,
        requestId: REQUEST_ID,
      }),
    ).toBe("found");
    expect(
      resolveRecoveryStep({
        job: foreignActive,
        failed: false,
        startedAtMs: started,
        nowMs: started + 1_000,
        requestId: REQUEST_ID,
      }),
    ).toBe("keep-waiting");
    expect(
      resolveRecoveryStep({
        job: recentJob,
        failed: false,
        startedAtMs: started,
        nowMs: started + 1_000,
        requestId: null,
      }),
    ).toBe("keep-waiting");
    expect(
      resolveRecoveryStep({
        job: oldJob,
        failed: false,
        startedAtMs: started,
        nowMs: started + 1_000,
        requestId: OTHER_REQUEST_ID,
      }),
    ).toBe("keep-waiting");
  });

  test("an unmatched request eventually times out", () => {
    expect(
      resolveRecoveryStep({
        job: foreignActive,
        failed: false,
        startedAtMs: started,
        nowMs: started + 1_000,
        requestId: REQUEST_ID,
      }),
    ).toBe("keep-waiting");
    expect(
      resolveRecoveryStep({
        job: null,
        failed: false,
        startedAtMs: started,
        nowMs: started + 31_000,
        requestId: REQUEST_ID,
      }),
    ).toBe("timed-out");
  });

  test("a status poll failure keeps waiting; a terminal job finishes", () => {
    expect(resolveUpdatePoll(null, true)).toBe("reconnecting");
    expect(resolveUpdatePoll(recentJob, false)).toBe("waiting");
    expect(resolveUpdatePoll(job("succeeded", "done"), false)).toBe("finished");
  });

  test("job adoption is monotonic by job id and seq", () => {
    const terminal = job("succeeded", "done", { seq: 10 });
    expect(adoptJobSnapshot(terminal, job("running", "fetching", { seq: 3 }))).toBe(terminal);
    expect(adoptJobSnapshot(terminal, job("running", "fetching", { seq: 11 }))).toBe(terminal);
    const nextTerminal = job("succeeded", "done", { seq: 11 });
    expect(adoptJobSnapshot(terminal, nextTerminal)).toBe(nextTerminal);
    const running = job("running", "fetching", { seq: 10 });
    expect(adoptJobSnapshot(running, job("succeeded", "done", { seq: 10 }))).toBe(running);
  });

  test("an old active job cannot replace a newer terminal job", () => {
    const olderActive = job("running", "fetching", {
      id: OTHER_JOB_ID,
      startedAt: new Date(started - 5_000).toISOString(),
    });
    const newerTerminal = job("succeeded", "done", { seq: 10 });
    expect(shouldAdoptLatestUpdateJob(olderActive, newerTerminal)).toBe(false);
    expect(shouldAdoptLatestUpdateJob(newerTerminal, olderActive)).toBe(true);
    expect(adoptJobSnapshot(newerTerminal, olderActive)).toBe(newerTerminal);
  });

  test("version query keys stay isolated by host", () => {
    expect(versionQueryKey("host-a")).not.toEqual(versionQueryKey("host-b"));
    expect(versionQueryKey("host-a")).toEqual(["agent-team", "version", "host-a"]);
  });

  test("a successful or rolled-back update triggers one post-update check", () => {
    const checked = new Set<string>();
    const succeeded = job("succeeded", "done");
    expect(shouldCheckAfterUpdate(succeeded, checked)).toBe(true);
    checked.add(succeeded.id);
    expect(shouldCheckAfterUpdate(succeeded, checked)).toBe(false);
    expect(
      shouldCheckAfterUpdate(
        job("rolled_back", "done", { id: "44444444-4444-4444-8444-444444444444" }),
        checked,
      ),
    ).toBe(true);
    expect(shouldCheckAfterUpdate(job("failed", "done"), checked)).toBe(false);
    expect(shouldCheckAfterUpdate(recentJob, checked)).toBe(false);
  });
});
