import { describe, expect, test } from "vitest";
import {
  compileCoordinatorSystemPrompt,
  compileKickoffMessage,
  compileMemberSystemPrompt,
} from "../client/domain/prompt-compiler";
import { architect, claudeOpus, codingTeam, techLead } from "./fixtures";

describe("prompt compiler", () => {
  test("member prompt is deterministic and includes hardcoded restrictions", () => {
    const prompt = compileMemberSystemPrompt({
      role: architect,
      teamName: codingTeam.name,
      coordinatorTitle: "[Team] Coding Team: add Stripe",
      instanceLabel: "API",
    });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain("Never call respond_to_permission");
    expect(prompt).toContain("Architect (API)");
    expect(
      compileMemberSystemPrompt({
        role: architect,
        teamName: codingTeam.name,
        coordinatorTitle: "[Team] Coding Team: add Stripe",
        instanceLabel: "API",
      }),
    ).toBe(prompt);
  });

  test("omits role restriction bullets when empty but keeps hardcoded ones", () => {
    const prompt = compileMemberSystemPrompt({
      role: { ...architect, restrictions: [], outputContract: [] },
      teamName: codingTeam.name,
      coordinatorTitle: "Lead",
    });
    expect(prompt).not.toContain("Do not rewrite unrelated modules");
    expect(prompt).toContain("Never call respond_to_permission");
    expect(prompt).not.toContain("6.");
    expect(prompt).toMatchSnapshot();
  });

  test("coordinator prompt appends operating rules", () => {
    const prompt = compileCoordinatorSystemPrompt({ role: techLead, team: codingTeam });
    expect(prompt).toContain("You are the Tech Lead, coordinator");
    expect(prompt).toContain(codingTeam.operatingRules);
    expect(prompt).toContain("Never call respond_to_permission or kill_agent");
    expect(prompt).toMatchSnapshot();
  });

  test("kickoff message lists the roster", () => {
    const message = compileKickoffMessage({
      task: "Add Stripe subscriptions.",
      runId: "run-1",
      roster: [
        { agentId: "agt-lead", role: techLead, profile: claudeOpus },
        { agentId: "agt-arch", role: architect, instanceLabel: "API", profile: claudeOpus },
      ],
    });
    expect(message).toContain("agt-arch");
    expect(message).toContain("Architect (API)");
    expect(message).toMatchSnapshot();
  });
});
