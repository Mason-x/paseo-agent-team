import type { ModeIssue } from "../domain/role-execution";

function value(params: ModeIssue["params"], key: string): string {
  const found = params[key];
  return found === undefined ? "" : String(found);
}

const ROUTE_REASON_TEXT: Readonly<Record<string, string>> = {
  "list-empty": "经济名单为空",
  "route-empty": "该层没有配置候选",
  "all-disabled": "候选全部已停用",
  "profile-missing": "候选 Profile 已不存在",
  "provider-unavailable": "候选的 provider 不可用",
  "availability-unverified": "候选的 provider 可用性未核实",
  "model-unverified": "候选的 live model 未通过廉价核实",
  "no-eligible": "候选均不合格",
};

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
    case "MODE_CHEAP_PROFILE_INVALID": {
      const reason = value(entry.params, "reason");
      const reasonText = reason === "missing" ? "Profile 已删除" : reason;
      return `Profile「${profileId || "unknown"}」不符合 ${route || "all"} 路由的廉价条件（${reasonText || "invalid"}）。`;
    }
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
      const reason = value(entry.params, "reason");
      const reasonText = ROUTE_REASON_TEXT[reason] ?? reason;
      return `${route || "all"} 路由没有可用廉价 Profile${reasonText ? `：${reasonText}` : ""}（${counts}）。`;
    }
    default:
      return "";
  }
}

export const modePlanZh = { cheapIssueText };
