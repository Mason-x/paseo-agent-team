// Planning issue vocabulary shared by seat planning, team.plan, the launch preview, and the
// designer. The Role tier / task-kind resolution that used to live here is retired (.notes/274):
// a Role's own preferred -> fallback Profiles decide the model, so nothing here reads a tier.
// No IO, React, Node, or SDK imports.

// Stable identifiers for planning, following the design's error table. Rendered text belongs in
// shared/zh.ts; callers assert on code/params and localize at the boundary. A code that an earlier
// version emitted and this one no longer does is simply absent: the DTO carries the code as an open
// string, and an unknown code renders as the generic fallback on a page that was not refreshed.
export const MODE_ISSUE_CODES = [
  // A retired request override (params.reason = "retired"), or an unreadable memberCreation.
  "MODE_UNKNOWN",
  "MODE_CONTEXT_UNAVAILABLE",
  "MODE_PROFILE_UNRESOLVED",
  "MODE_ROLE_DISABLED",
  "MODE_SEAT_DUPLICATE",
  "MODE_MEMBER_LIMIT",
  "MODE_LIMIT_CLAMPED",
  "MODE_ONDEMAND_UNAVAILABLE",
  "MODE_PLAN_CHANGED",
  // Warning: the two review seats resolve to the same model family, so they are not independent.
  "MODE_REVIEW_FAMILY_SAME",
] as const;

export type ModeIssueCode = (typeof MODE_ISSUE_CODES)[number];

export type ModeIssue = {
  code: ModeIssueCode;
  severity: "warning" | "blocker";
  roleId?: string;
  seatId?: string;
  profileId?: string;
  params: Readonly<Record<string, string | number | boolean>>;
};

// Success carries only warnings; a failure lists every blocker that prevented resolution.
export type Result<T, E> = { ok: true; value: T; issues?: E } | { ok: false; issues: E };

export function issueValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
