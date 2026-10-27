import type { ModeIssue } from "../domain/role-execution";

function value(params: ModeIssue["params"], key: string): string {
  const found = params[key];
  return found === undefined ? "" : String(found);
}

/** User-facing text for the cheap-routing codes; every code has a real sentence, not a fallback. */
export function cheapIssueText(entry: ModeIssue): string {
  const route = value(entry.params, "route");
  const profileId = value(entry.params, "profileId");
  switch (entry.code) {
    case "MODE_CHEAP_POLICY_REQUIRED": {
      const reason = value(entry.params, "reason");
      const version = value(entry.params, "version");
      return `全席位经济策略不可用（${route || "all"}：${reason || "absent"}${version ? `，version ${version}` : ""}）。`;
    }
    case "MODE_CHEAP_PROFILE_INVALID":
      return `Profile「${profileId || "unknown"}」不符合 ${route || "all"} 路由的廉价条件（${value(entry.params, "reason") || "invalid"}）。`;
    case "MODE_CHEAP_ROUTE_UNAVAILABLE": {
      const counts = [
        "candidates",
        "disabled",
        "missing",
        "unavailable",
        "unverified",
        "invalid",
        "excluded",
      ]
        .map((key) => `${key} ${value(entry.params, key) || "0"}`)
        .join("、");
      return `${route || "all"} 路由没有可用廉价 Profile（${counts}）。`;
    }
    default:
      return "";
  }
}

export const modePlanZh = { cheapIssueText };
