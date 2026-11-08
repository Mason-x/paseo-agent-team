import type { RunDetailView, RunTaskView } from "../../schemas/run-engine/rpc";
import {
  DECISION_KIND_WHY_ZH,
  DISPATCH_BLOCKED_ZH,
  DISPATCH_FAMILIES_ZH,
  EVIDENCE_GATE_WAITING,
  EVIDENCE_GATE_ZH,
  REPORT_FAMILIES_ZH,
  SEAT_DENIAL_ZH,
  WAITING_EXACT_ZH,
  WAITING_MEMBER_CODE,
  WAITING_UNKNOWN,
  type WaitingText,
} from "../../zh/run-engine-waiting";
import { isDecisionPending } from "./decision-state";
import { displayText } from "./display-text";

/**
 * Why a task or a decision is waiting, who can clear it, and what happens next. Pure and table
 * driven: the words live in `shared/zh/run-engine-waiting.ts`, keyed by the codes the server writes.
 *
 * A code this build has no words for is still shown, with its code, and `known` is false; that is
 * not an error (a newer server may write codes an older page has never seen). The tests read the
 * server sources and fail for a code that is written there and not here, so a missing entry is
 * caught at development time and not by a person looking at a card.
 */

export type WaitingExplanation = WaitingText & {
  /** False when the code has no entry (the text is the generic one, plus the code). */
  known: boolean;
};

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const known = (text: WaitingText): WaitingExplanation => ({ ...text, known: true });

function unknown(code: string): WaitingExplanation {
  return {
    ...WAITING_UNKNOWN,
    why: `${WAITING_UNKNOWN.why}（${displayText(code, 80, "?")}）`,
    known: false,
  };
}

function dispatchBlocked(sub: string): WaitingExplanation {
  const exact = own(DISPATCH_BLOCKED_ZH, sub);
  if (exact) return known(exact);
  for (const prefix of Object.keys(DISPATCH_FAMILIES_ZH)) {
    if (sub.startsWith(prefix) && sub.length > prefix.length) {
      return known(DISPATCH_FAMILIES_ZH[prefix] as WaitingText);
    }
  }
  return unknown(`dispatch-blocked:${sub}`);
}

function waitingForSeat(denials: string): WaitingExplanation {
  const parts = denials === "" ? [] : denials.split(",");
  const said = parts.map((part) => own(SEAT_DENIAL_ZH, part) ?? displayText(part, 40, "?"));
  return known({
    why:
      said.length === 0
        ? "任务已就绪，但现在没有可用的席位"
        : `任务已就绪，但没有可用的席位：${said.join("、")}`,
    who: "Engine 自动",
    next: "席位恢复后自动派发；如果长期不恢复，检查 Team 的席位和 Profile",
  });
}

/** What one `waitingReason` code means. Unknown codes are returned as such, never thrown on. */
export function explainWaiting(reason: string): WaitingExplanation {
  const exact = own(WAITING_EXACT_ZH, reason);
  if (exact) return known(exact);
  if (reason.startsWith("dispatch-blocked:")) {
    return dispatchBlocked(reason.slice("dispatch-blocked:".length));
  }
  if (reason === "waiting-for-seat") return waitingForSeat("");
  if (reason.startsWith("waiting-for-seat:")) {
    return waitingForSeat(reason.slice("waiting-for-seat:".length));
  }
  for (const prefix of Object.keys(REPORT_FAMILIES_ZH)) {
    if (reason.startsWith(prefix)) {
      const text = REPORT_FAMILIES_ZH[prefix] as WaitingText;
      const detail = reason.slice(prefix.length);
      return known({
        ...text,
        why: detail === "" ? text.why : `${text.why}（${displayText(detail, 80)}）`,
      });
    }
  }
  const gate = own(EVIDENCE_GATE_ZH, reason);
  if (gate !== undefined) {
    return known({ ...EVIDENCE_GATE_WAITING, why: `${EVIDENCE_GATE_WAITING.why}：${gate}` });
  }
  return unknown(reason);
}

// --- tasks --------------------------------------------------------------------------------------

export type TaskExplanation = { why: string; who: string; next: string };

/** Alert DTOs carry a summary, not a type or owner; never infer the responsible party from its text. */
export function explainAlert(
  alert: Pick<RunDetailView["alerts"][number], "state" | "summary">,
): TaskExplanation {
  return {
    why: displayText(alert.summary, 300, "—"),
    who: alert.state === "resolved" ? "—" : "需根据告警内容判断",
    next: alert.state === "resolved" ? "告警已解除" : "查看并按告警内容处理；之后重新查看状态",
  };
}

type DecisionView = RunDetailView["decisions"][number];

/** A decision: what stopped, who answers, and whether this page can. */
export function explainDecision(
  decision: Pick<DecisionView, "category" | "state" | "actions" | "kind">,
): TaskExplanation {
  const pending = isDecisionPending(decision);
  const canRetry = pending && decision.actions?.includes("retry") === true;
  const canCancel = pending && decision.actions?.includes("cancel") === true;
  const why: Record<string, string> = {
    D1: "有成员或判官停下了，或成员的回合结束后没有可用的报告",
    D3: "S 层的质量阶梯用完了，任务失败",
    D4: "任务的实现尝试次数到了上限，任务已冻结",
  };
  const base =
    (decision.kind === undefined ? undefined : own(DECISION_KIND_WHY_ZH, decision.kind)) ??
    own(why, decision.category) ??
    `需要人回应的决策（${displayText(decision.category, 8)}）`;
  if (!pending) {
    return { why: base, who: "已有结果", next: "这个决策已经处理，不需要再做什么" };
  }
  if (canRetry) {
    return {
      why: base,
      who: "你",
      next: canCancel
        ? "在上方“控制”里确认重试（一次只会再给任务一次尝试），或取消这个任务"
        : "在上方“控制”里确认重试（一次只会再给任务一次尝试）",
    };
  }
  if (canCancel) {
    return {
      why: base,
      who: "你",
      next:
        decision.kind === "evidence-stuck"
          ? "这个任务只能取消（重试会丢掉已有的交付）；在上方“控制”里确认，依赖它的任务会一起取消"
          : "当前只能取消；在上方“控制”里确认，依赖它的任务会一起取消",
    };
  }
  return {
    why: base,
    who: "你（当前版本没有页面入口）",
    next: "人工检查任务；改派和追加预算还不能在这里做",
  };
}

const WAITING_BY_BLOCK: Record<string, (task: RunTaskView) => TaskExplanation> = {
  dependency: (task) => ({
    why: `在等依赖任务 ${displayText(task.blockedBy?.ref ?? "?", 64)} 完成`,
    who: "Engine 自动",
    next: "依赖任务通过审查后自动继续",
  }),
  lock: () => ({
    why: "任务要用的文件被占用，或任务已冻结（占用保留）",
    who: "Engine 自动（冻结的需要你）",
    next: "占用方释放后自动继续；冻结的任务在决策点里处理",
  }),
  permission: (task) => ({
    why: `成员 ${displayText(task.blockedBy?.ref ?? "?", 64)} 在等权限回应`,
    who: "你（在成员的对话里回应权限）",
    next: "Engine 永远不代答权限；回应后成员继续",
  }),
  capacity: () => ({
    why: "并发名额已满",
    who: "Engine 自动",
    next: "有任务完成后自动派发",
  }),
  channel: (task) => ({
    why: `渠道 ${displayText(task.blockedBy?.ref ?? "?", 64)} 暂时不可用`,
    who: "Engine 自动",
    next: "渠道恢复后自动继续；恢复下界见“渠道与告警”",
  }),
  seat: () => ({
    why: "没有合格的席位承担这个任务",
    who: "你",
    next: "在 Team 里补充席位或调整 Profile，然后点“立即检查并推进”",
  }),
};

/**
 * One line each of why, who and what next for a task. The structured `blockedBy` decides first, then
 * the task's own `waitingReason`, then its state; it never reads display text for logic.
 */
export function explainTask(
  task: RunTaskView,
  decisions: readonly DecisionView[],
): TaskExplanation {
  const blocked = task.blockedBy;
  if (blocked?.kind === "decision") {
    const decision = decisions.find((entry) => entry.decisionId === blocked.ref);
    if (decision) return explainDecision(decision);
    return { why: "在等一个需要人回应的决策", who: "你", next: "见“决策点”" };
  }
  if (blocked && blocked.kind !== "other") {
    const make = own(WAITING_BY_BLOCK, blocked.kind);
    if (make) return make(task);
  }
  if (task.waitingReason !== null) {
    const said = explainWaiting(task.waitingReason);
    if (said.known) return { why: said.why, who: said.who, next: said.next };
    if (task.state === "blocked" || task.state === "failed") {
      return {
        why: `${WAITING_MEMBER_CODE.why}：${displayText(task.waitingReason, 64)}`,
        who: WAITING_MEMBER_CODE.who,
        next: WAITING_MEMBER_CODE.next,
      };
    }
    return { why: said.why, who: said.who, next: said.next };
  }
  switch (task.state) {
    case "pending":
      return { why: "在等依赖完成", who: "Engine 自动", next: "依赖通过审查后自动继续" };
    case "ready":
      return { why: "已就绪，等待派发", who: "Engine 自动", next: "下一次推进会派发" };
    case "assigned":
    case "in_progress":
      return {
        why: "成员正在做，Engine 在等它的报告",
        who: "成员",
        next: "回合结束后 Engine 自动入账",
      };
    case "review":
      return { why: "在等审查或冒烟的结论", who: "判官", next: "判官回复后 Engine 自动入账" };
    case "rework":
      return { why: "审查没有通过，在等成员返工", who: "成员", next: "返工的报告回来后重新送审" };
    case "done":
      return { why: "已完成", who: "—", next: "不需要处理" };
    case "cancelled":
      return { why: "已取消", who: "—", next: "不需要处理" };
    default:
      return { why: "任务现在停在这个状态", who: "未知", next: "展开任务查看详情" };
  }
}
