import { describe, expect, test } from "vitest";
import {
  compileCoordinatorSystemPrompt,
  compileKickoffMessage,
  compileMemberSystemPrompt,
} from "../shared/domain/prompt-compiler";
import { architect, claudeOpus, codexXhigh, codingTeam, techLead } from "./fixtures";

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

  test("coordinator prompt lists planned seats only when a roster is supplied", () => {
    const prompt = compileCoordinatorSystemPrompt({
      role: techLead,
      team: codingTeam,
      roster: [
        {
          seatId: "seat-api",
          role: architect,
          instanceLabel: "API",
          profile: claudeOpus,
          activation: "on-demand",
        },
        {
          seatId: "seat-fallback",
          role: architect,
          instanceLabel: "Fallback",
          profile: codexXhigh,
          activation: "escalation-only",
        },
      ],
    });
    expect(prompt).toContain("## Planned seats");
    expect(prompt).toContain(
      "| seat-api | Architect (API) | Claude Opus High (claude/opus) | on first task |",
    );
    expect(prompt).toContain(
      "| seat-fallback | Architect (Fallback) | Codex xhigh (codex/gpt-5.5) | standby (not created in this version) |",
    );
    expect(prompt).toContain("standby seats are not created by this version");
    expect(prompt).not.toContain("already running as your subagents");

    const escalationReady = compileCoordinatorSystemPrompt({
      role: techLead,
      team: codingTeam,
      escalationAvailable: true,
      roster: [
        {
          seatId: "seat-standby",
          role: architect,
          profile: claudeOpus,
          activation: "escalation-only",
        },
      ],
    });
    expect(escalationReady).toContain("| seat-standby | Architect |");
    expect(escalationReady).toContain("| standby |");
    expect(escalationReady).toContain("until the run explicitly escalates");

    expect(compileCoordinatorSystemPrompt({ role: techLead, team: codingTeam })).toContain(
      "already running as your subagents",
    );
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
