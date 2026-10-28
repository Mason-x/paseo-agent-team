import { describe, expect, test, vi } from "vitest";
import {
  applyDesignPrefill,
  buildDesignStartInput,
  createDesignClientRequestId,
  createDesignSubmissionController,
  createDesignSubmissionState,
  editDesignDraft,
  fingerprintDesignStartInput,
  planDesignSubmission,
  replaceDesignDraft,
  settleDesignSubmission,
} from "../client/designer/submission-state";
import type { DesignIssue, DesignStartInput, DesignStartOutput } from "../shared/schemas/design";
import { DESIGN_CLIENT_REQUEST_ID, designJob } from "./design-fixtures";

const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const issue: DesignIssue = {
  code: "DESIGN_BUSY",
  severity: "error",
  path: [],
  params: {},
  action: "none",
};

function accepted(): DesignStartOutput {
  return { ok: true, job: designJob() };
}

function rejected(): DesignStartOutput {
  return { ok: false, issues: [issue], issuesTruncated: 0, job: null };
}

describe("submission nonce and double click", () => {
  test("a same-cycle double click calls start once and returns the same promise", async () => {
    const gate = Promise.withResolvers<DesignStartOutput>();
    const start = vi.fn((_input: DesignStartInput) => gate.promise);
    const controller = createDesignSubmissionController({
      start,
      nextId: () => DESIGN_CLIENT_REQUEST_ID,
    });
    controller.edit({ request: "设计一个改版团队" });

    const first = controller.submit();
    const second = controller.submit();
    expect(first).toBe(second);
    expect(start).toHaveBeenCalledTimes(1);

    const sent = start.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      clientRequestId: DESIGN_CLIENT_REQUEST_ID,
      request: "设计一个改版团队",
      mode: "sota",
    });
    expect(sent?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);

    gate.resolve(accepted());
    await expect(first).resolves.toMatchObject({ kind: "accepted" });
    expect(controller.getState().draftState.draft.request).toBe("");
  });

  test("an accepted reply clears only the draft version it captured", async () => {
    const gate = Promise.withResolvers<DesignStartOutput>();
    const controller = createDesignSubmissionController({
      start: () => gate.promise,
      nextId: () => DESIGN_CLIENT_REQUEST_ID,
    });
    controller.edit({ request: "旧需求" });
    const submitting = controller.submit();
    controller.edit({ request: "等待时输入的新需求" });

    gate.resolve(accepted());
    await expect(submitting).resolves.toMatchObject({
      kind: "accepted",
      clearedDraft: false,
    });
    const state = controller.getState();
    expect(state.draftState.draft.request).toBe("等待时输入的新需求");
    expect(state.draftState.inputRevision).toBe(0);
  });

  test("a new prefill nonce is not cleared by the old accepted reply", async () => {
    const gate = Promise.withResolvers<DesignStartOutput>();
    const controller = createDesignSubmissionController({
      start: () => gate.promise,
      nextId: () => DESIGN_CLIENT_REQUEST_ID,
    });
    controller.edit({ request: "旧需求" });
    const submitting = controller.submit();
    controller.prefill({ request: "新命令需求", workspaceId: "ws-new" });

    gate.resolve(accepted());
    await expect(submitting).resolves.toMatchObject({
      kind: "accepted",
      clearedDraft: false,
    });
    const state = controller.getState();
    expect(state.draftState.draft.request).toBe("新命令需求");
    expect(state.draftState.draft.workspaceId).toBe("ws-new");
    expect(state.draftState.inputRevision).toBe(1);
  });

  test("typing bumps the draft version but never the IME input revision", () => {
    let state = createDesignSubmissionState();
    state = editDesignDraft(state, { request: "你" });
    state = editDesignDraft(state, { request: "你好" });
    state = editDesignDraft(state, { request: "你好，设计师" });
    expect(state.draftState.draftVersion).toBe(3);
    expect(state.draftState.inputRevision).toBe(0);
  });

  test("a prefill re-seeds identical text and bumps the input revision", () => {
    let state = createDesignSubmissionState({ request: "相同需求" });
    state = replaceDesignDraft(state, { request: "相同需求" });
    expect(state.draftState.draft.request).toBe("相同需求");
    expect(state.draftState.draftVersion).toBe(1);
    expect(state.draftState.inputRevision).toBe(1);
  });

  test("a command prefill keeps the mode and designer Profile, and clears a null workspace", () => {
    let state = createDesignSubmissionState({
      request: "旧",
      mode: "economy",
      workspaceId: "ws-old",
      profileChoice: "codex-xhigh",
    });
    state = applyDesignPrefill(state, { request: "新需求", workspaceId: null });
    expect(state.draftState.draft).toEqual({
      request: "新需求",
      mode: "economy",
      workspaceId: "",
      profileChoice: "codex-xhigh",
      existingRolesOnly: true,
    });
    expect(state.draftState.inputRevision).toBe(1);
  });

  test("generated request ids are UUIDs", () => {
    expect(createDesignClientRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("unknown transport outcomes", () => {
  test("a retry after an unknown reply reuses the same clientRequestId", async () => {
    let calls = 0;
    const start = vi.fn(async (_input: DesignStartInput) => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return accepted();
    });
    const ids = [DESIGN_CLIENT_REQUEST_ID, OTHER_ID];
    let next = 0;
    const controller = createDesignSubmissionController({
      start,
      nextId: () => ids[next++] ?? OTHER_ID,
    });
    controller.edit({ request: "重试需求" });

    await expect(controller.submit()).resolves.toEqual({ kind: "unknown" });
    const firstId = start.mock.calls[0]?.[0].clientRequestId;
    expect(controller.getState().retry?.clientRequestId).toBe(firstId);

    await expect(controller.submit()).resolves.toMatchObject({ kind: "accepted" });
    expect(start.mock.calls[1]?.[0].clientRequestId).toBe(firstId);
    expect(start).toHaveBeenCalledTimes(2);
  });

  test("changing the payload after an unknown reply allocates a new id", async () => {
    const start = vi.fn(async (_input: DesignStartInput) => {
      if (start.mock.calls.length === 1) throw new Error("offline");
      return accepted();
    });
    const ids = [DESIGN_CLIENT_REQUEST_ID, OTHER_ID];
    let next = 0;
    const controller = createDesignSubmissionController({
      start,
      nextId: () => ids[next++] ?? OTHER_ID,
    });
    controller.edit({ request: "第一版" });
    await controller.submit();
    controller.edit({ request: "第二版" });
    await controller.submit();
    expect(start.mock.calls[0]?.[0].clientRequestId).toBe(DESIGN_CLIENT_REQUEST_ID);
    expect(start.mock.calls[1]?.[0].clientRequestId).toBe(OTHER_ID);
  });

  test("a rejection keeps the draft and a later attempt gets a new id", async () => {
    const start = vi.fn(async (_input: DesignStartInput) => rejected());
    const ids = [DESIGN_CLIENT_REQUEST_ID, OTHER_ID];
    let next = 0;
    const controller = createDesignSubmissionController({
      start,
      nextId: () => ids[next++] ?? OTHER_ID,
    });
    controller.edit({ request: "被拒绝的需求" });
    await expect(controller.submit()).resolves.toEqual({
      kind: "rejected",
      issues: [issue],
    });
    expect(controller.getState().draftState.draft.request).toBe("被拒绝的需求");
    await controller.submit();
    expect(start.mock.calls[1]?.[0].clientRequestId).toBe(OTHER_ID);
  });

  test("a void reply never pretends acceptance and keeps the draft", () => {
    const initial = createDesignSubmissionState({ request: "空回调需求" });
    const planned = planDesignSubmission(initial, () => DESIGN_CLIENT_REQUEST_ID);
    expect(planned.kind).toBe("send");
    if (planned.kind !== "send") return;
    const settled = settleDesignSubmission(planned.state, {
      clientRequestId: DESIGN_CLIENT_REQUEST_ID,
      seq: planned.command.seq,
      outcome: "void",
    });
    expect(settled.cleared).toBe(false);
    expect(settled.state.phase).toBe("unknown");
    expect(settled.state.draftState.draft.request).toBe("空回调需求");
    expect(settled.state.retry?.clientRequestId).toBe(DESIGN_CLIENT_REQUEST_ID);
  });

  test("a late settlement for another submission is ignored", () => {
    const initial = createDesignSubmissionState({ request: "旧任务" });
    const planned = planDesignSubmission(initial, () => DESIGN_CLIENT_REQUEST_ID);
    if (planned.kind !== "send") throw new Error("expected a send plan");
    const settled = settleDesignSubmission(planned.state, {
      clientRequestId: OTHER_ID,
      seq: planned.command.seq,
      outcome: "accepted",
    });
    expect(settled.ignored).toBe(true);
    expect(settled.state).toBe(planned.state);
  });
});

describe("request payload normalization", () => {
  test("default Profile choice sends neither profileId nor the default-hints flag", () => {
    const built = buildDesignStartInput(
      {
        request: "需求",
        mode: "economy",
        workspaceId: "ws-1",
        profileChoice: null,
        existingRolesOnly: true,
      },
      DESIGN_CLIENT_REQUEST_ID,
    );
    expect(built).toEqual({
      ok: true,
      input: {
        clientRequestId: DESIGN_CLIENT_REQUEST_ID,
        request: "需求",
        mode: "economy",
        workspaceId: "ws-1",
        existingRolesOnly: true,
      },
    });
  });

  test("an explicit auto choice sends useDefaultProfileHints and an id sends profileId", () => {
    const auto = buildDesignStartInput(
      {
        request: "需求",
        mode: "sota",
        workspaceId: "",
        profileChoice: "",
        existingRolesOnly: true,
      },
      DESIGN_CLIENT_REQUEST_ID,
    );
    expect(auto.ok && auto.input.useDefaultProfileHints).toBe(true);
    const explicit = buildDesignStartInput(
      {
        request: "需求",
        mode: "sota",
        workspaceId: "",
        profileChoice: "codex-xhigh",
        existingRolesOnly: true,
      },
      DESIGN_CLIENT_REQUEST_ID,
    );
    expect(explicit.ok && explicit.input.profileId).toBe("codex-xhigh");
    expect(explicit.ok && explicit.input.useDefaultProfileHints).toBeUndefined();
  });

  test("empty and oversized requests are blocked before any RPC call", async () => {
    const start = vi.fn(async (_input: DesignStartInput) => accepted());
    const controller = createDesignSubmissionController({
      start,
      nextId: () => DESIGN_CLIENT_REQUEST_ID,
    });
    await expect(controller.submit()).resolves.toEqual({ kind: "blocked", reason: "empty" });
    controller.edit({ request: "x".repeat(4001) });
    await expect(controller.submit()).resolves.toEqual({ kind: "blocked", reason: "too-long" });
    expect(start).not.toHaveBeenCalled();
  });

  test("the fingerprint ignores whitespace around the request", () => {
    expect(fingerprintDesignStartInput({ request: "  需求  ", mode: "sota" })).toBe(
      fingerprintDesignStartInput({ request: "需求" }),
    );
  });
});
