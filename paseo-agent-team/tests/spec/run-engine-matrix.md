# Run Engine 验收夹具矩阵（RE-V01）

范围：`tests/fixtures/run-engine/**` 是**离线输入数据**。本文件把每个样本映射到 `02-spec-run-engine.md` 的 Y1–Y17 与 I1–I8、以及 RE1/RE2/RE3 的 AC 条款。
本任务**不写依赖 reducer 行为的断言**。夹具类型由已实现的 R01 schema 推导（`types.ts`），`fixtures.selfcheck.test.ts` 用真实 `RunRecordSchema`/`RunTaskReportBlockSchema`/`RunTeamEngineConfigSchema`/`RunGetInputSchema` 做静态契约自检（不 mock）：**合法台账 40/40（27 具名 + 13 不变式）、非法台账 8/8（每条断言唯一 issue path）、合法协议报告 5/5、非法协议报告 1/1（空 evidence）、损坏字节 5/5、schema 合法/后层拒绝边界 2/2（见 §12）**。reducer、锁与名额、RPC 投影等行为断言归 R01/R02/R03/R05 的实现用例与 V02。

记号：`输入` = 本任务交付的样本；`断言` = 后续实现用例负责。所有夹具目录版本为 `fixtureVersion=1`（与台账 `schemaVersion` 无关）。

## 1. 台账样本（`ledgers.ts` / `base.ts`）

| id | 内容 | Y | I | AC | 输入 / 断言 |
|---|---|---|---|---|---|
| `normal-ledger` | T1 done（带 review）、T2 in_progress（锁+intent+turnId）、T3 pending 依赖 T2；预算/渠道/告警正常 | — | I1–I8 合法基线 | RE1.1/1.8 | 输入：干净台账。断言：schema+不变式+状态机 |
| `outcome-unknown-ledger` | intent `outcome-unknown`（recoverySendCount=1）、T2 blocked、锁 frozen、D1 open | Y21 | I3/I8 | RE1.11 | 输入：终态 intent。断言：不循环重试、frozen、D1 唯一 |
| `cancelling-ledger` | 取消请求：`assignment.cancellation.receipt.kind=none`（回执未确认）、outbox `wake` 取消消息 sending | Y18 | I3 | RE1.10/RE4.3 | 输入：未静止。断言：拒绝释放、保 frozen |
| `quiescent-cancelled-ledger` | `cancellation.receipt` archive 已确认、assignment `cancelled`、claim 已收回 | Y18 | I3 | RE1.10 | 输入：可释放。断言：由显式决策释放 |
| `blocked-ledger` | `blocked+frozen` 持锁，D1 open | Y7 | I3（合法） | RE1.8/RE4.3 | 输入：合法 frozen。断言：不自动解锁、重启后一致 |
| `unknown-schema-version-ledger` | `schemaVersion=2` + `futureTopLevel` + task 未知字段 | Y15 | — | RE1.3 | 输入：未知版本原字节。断言：只读错误投影、禁迁移/改写 |
| `oversized-ledger`（`buildOversizedLedger()`） | >`RUN_HARD_BYTES`（8MiB）单 Run；schema 接受，store 必须拒写 | Y25 | — | RE1.12 | 输入：超限。断言：停写、D7、导出，不截断 nonce |
| `overlong-fields-ledger` | title>120、goal>2000、acceptance>500、scope path>512 → **非法样本** | — | — | RE1.7/RE2.8 | 输入：schema 拒收。断言：store 不可写入并报路径 |

## 2. 损坏与诊断（`corrupt.ts`）

| id | 内容 | Y | I | AC |
|---|---|---|---|---|
| `truncated-mid-object` / `empty-file` / `two-writes-concatenated` / `non-utf8-bytes` / `trailing-comma` | 5 份不可解析字节 | Y15 | I1 | RE1.2/RE1.3/RE7.1 |
| `no-schema-version` / `no-run-id` / `no-tasks` / `task-without-id` / `task-with-unknown-status` | 合法基线上只改一处：删 `schemaVersion` / `runId` / `tasks` / `tasks[0].spec.id`，或把 `tasks[0].state` 设为未知值（单因） | Y15 | I1 | RE1.3/RE7.1 |
| `unknown-task-status-record` | 任务状态 `awaiting-human` | Y15 | — | RE3.1/RE7.1 |
| `corrupt-record-with-digest` | 原字节 + digest + `issues/<digest>.json` 旁路、`autoRepair=false` | Y15 | — | RE1.3 |

输入：坏记录/旁路形态。断言：原文件不被覆盖、错误投影、诊断不可写时的内存告警。

## 3. 跨 Run 锁与探针（`locks.ts`）

| id | 内容 | Y | AC | 输入 / 断言 |
|---|---|---|---|---|
| `lock-conflict-run-a` / `lock-conflict-run-b` | 两个 Run 对同一 canonical 文件分别 held/requested | Y7 | RE4.3/RE1.14 | 输入：相交声明。断言：仅一个获授、另一个 waiting |
| `lock-conflict-aliased-claim` | `SRC\Shared\UTIL.ts` 别名 | Y7 | RE4.3 | 输入：大小写/分隔符别名。断言：归一化后相交 |
| `root-lock` / `stale-root-lock` | 单写者根锁；死 pid + startTime 守卫 | — | RE1.2/RE1.14 | 输入：锁记录。断言：仅一个实例持有、死锁可回收 |
| `probe-conflict-run-a` / `probe-conflict-run-b` | 同渠道恢复窗口；A 已 sending，B prepared | Y19 | RE5.5 | 输入：并发探测。断言：跨 Run 仅一个 probe |
| `probe-same-channel-seats` | 同渠道多席位一律停派，仅一条 incident | Y19 | RE5.5/RE5.6 | 输入：渠道锁。断言：全席位停新派发 |
| `corrupt-resource-holder` | 损坏 Run 仍持已知 claim，冻结该 repo 新授予 | Y15 | RE1.14 | 输入：坏 Run+claim。断言：新派发拒绝并给原因 |

## 4. reopen 与 closed（`reopen.ts`）

| id | 内容 | Y | AC | 输入 / 断言 |
|---|---|---|---|---|
| `closed-after-report` | 已有 report（turn_ended completed），agent 转 closed，任务在 review | Y20 | RE4.10 | 输入：正常静息。断言：不得改 blocked |
| `closed-while-assigned` | 未收 report、agent closed、attempts=1、issued reopen grant + `assignment.reopenGrantId`、reopen intent prepared、D1 | Y20 | RE4.10 | 输入：异常 closed。断言：blocked+D1，attempt 不变 |
| `reopen-started` | consumed reopen grant、reopen intent confirmed 且关联 `turn_started` | Y20 | RE4.10 | 输入：成功证据。断言：只有 turn_started 判定成功 |

## 5. 计数上限与渠道探测（`control.ts`）

| id | 内容 | Y | AC |
|---|---|---|---|
| `control-attempts` | protocolFailures=2、evidenceReturns=3、reworkCount=2、`attempts=6`、席位预算 10/12 与 6/6、80%+100% 合并一条 D4 | Y8/Y9/Y10 | RE4.5/RE5.1/5.2/5.3 |
| `probe-eligible` | 渠道 paused、until 已到、无在途 probe、**全员 idle 且无在途 turn**（任务仅 T1 done） | Y19 | RE5.5 |
| `probe-blocked-inflight-turn` | 同上但 T2 在途、seat-b1 running：五条件之一不成立 | Y19 | RE5.5 |
| `probe-in-flight` | 同渠道 probe sending | Y19 | RE5.5 |
| `probe-completed` | 关联 `turn_ended.completed` | Y19 | RE5.5 |
| `probe-failed` | `turn_ended.failed`，`unavailableUntil=null`，不按文案续期 | Y19 | RE5.5 |
| `probe-unknown` | 无关联 turn_ended、intent outcome-unknown、保持 paused | Y19 | RE5.5 |

## 6. 三道门（`gates.ts`）

| id | 内容 | Y | AC | 输入 / 断言 |
|---|---|---|---|---|
| `evidence-incomplete` | report 声称 done，但 check exitCode=1、coverage summary 为空 | Y1 | RE3.2 | 输入：证据不足。断言：留 in_progress、evidenceReturns+1 |
| `stale-review` | review 的 `reviewedRef` 早于任务当前 ref | Y2 | RE3.3/3.6 | 输入：旧 ref。断言：不 done、旧审查失效 |
| `dev-smoke-missing` | devSmoke 任务无通过冒烟；冒烟目标 `127.0.0.1:6767` 别名 + 清单缺项 | Y4 | RE3.4 | 输入：错目标/缺项。断言：不 done |
| `dev-smoke-ready` | 预登记 DEV 目标 + 完整清单的冒烟报告 | Y4 | RE3.4 | 输入：合法冒烟。断言：冒烟门通过（其余门照跑） |

## 7. 协议、身份、时间线与扫描预算（`protocol.ts`）

| id | 内容 | Y | AC |
|---|---|---|---|
| `missing-block` / `two-task-reports` / `mixed-kinds` / `non-json-body` / `unknown-version` / `oversized-block` | 单块/多块/混种/非 JSON/未知版本/>32KiB | Y5 | RE2.3/RE2.8 |
| `escaped-fence-inside-string` | 字符串内转义 fence 仅数据 | Y5 | RE2.8 |
| `missing-evidence` | done 报告 evidence=[]：**schema 非法**（AC-RE2.3 要求 ≥1）；由协议失败路径处理 | Y1/Y5 | RE2.3/RE3.2 |
| `wrong-task` / `wrong-attempt` / `unknown-nonce` / `reused-nonce` | schema 合法；身份/所有权不符，由 R05/R06 拒绝 | Y6 | RE2.2/RE2.5 |
| `non-assignee` | schema 合法（R01 无 reporter 字段）；`assignmentId`+`nonce` 不属于派发记录，由 R05/R06 所有权校验拒绝；见 §12 | Y6 | RE2.2/RE2.5 |
| `deprecated-timeline` | `turn_ended.timeline=[]` + messageId refetch 窗口 | Y16 | RE2.4 |
| `scan-budget` | 整回复 256KiB+1、21 页、缺页 | Y5 | RE2.9 |
| `protocol-replay` | 同 report 多次投递（同/异 messageId） | Y6/Y11 | RE1.4 |

## 8. 观察、权限与旧 Run（`observation.ts`）

| id | 内容 | Y | AC |
|---|---|---|---|
| `event-storm-50` | 50 个 turn_ended（40 个落在 4 个 turn，10 个 null turnId） | Y12 | RE6.5 |
| `permission-pending` | in-flight 期间 `permission_requested`，只告警不代答 | Y14 | RE6.6 |
| `irreversible-unapproved` | `irreversible.approvalId=null`、任务 ready、无 assignment | Y14 | RE6.6 |
| `external-activity` | 无对应 assignment 的消息 | Y17 | RE4.8 |
| `legacy-run-without-ledger` | 仅 labels、无台账、不补账 | Y17 | RE1.9/RE7.6 |
| `finished-decision` | DAG 全 done，仅 D6 open + 已答 D4 | Y13 | RE6.1/6.2 |

## 9. 不变式输入（`invariants.ts`）

| id | 不变式 | 类型 | 对应 |
|---|---|---|---|
| `i1-half-write-bytes` | I1 | 违规 | RE1.2 / Y15 |
| `i2-ready-with-unfinished-dep` | I2 | 违规 | RE4.1 |
| `i2-pending-with-unfinished-dep` | I2 | 合法 | RE4.1 |
| `i3-blocked-frozen-claim` | I3 | 合法 | RE1.8/RE4.3（10-27 修订） |
| `i3-pending-holds-claim` | I3 | 违规 | RE4.3 / Y7 |
| `i4-review-awaiting-does-not-count` | I4 | 合法 | RE3.6/RE4.5 |
| `i4-capacity-over-effective` | I4 | 边界（max() 语义下合法） | RE4.5 / Y8 |
| `i5-nonce-replayed` | I5 | 违规 | RE1.4/RE2.2 / Y6 |
| `i5-turn-ended-redelivered` | I5 | 合法 | RE1.4 / Y11 |
| `i6-rework-count-below-events` | I6 | 违规 | RE5.1 / Y9 |
| `i7-done-without-review` | I7 | 违规 | RE3.3/RE3.5 / Y2 |
| `i7-self-review` | I7 | 违规 | RE3.3 / Y3 |
| `i8-assignment-without-intent` | I8 | 违规 | RE1.2/RE4.6 / Y11 |

## 10. 覆盖核对

- Y1–Y17：全部有输入（Y1 §6/§7；Y2 §4/§9；Y3 §9；Y4 §6；Y5 §2/§7；Y6 §7/§9；Y7 §3/§9；Y8 §5/§9；Y9 §5/§9；Y10 §5；Y11 §1/§7/§9；Y12 §8；Y13 §8；Y14 §8；Y15 §1–§3/§9；Y16 §7；Y17 §8）。
- I1–I8：每个至少一条违规输入；I2–I5 另有合法边界，I4 以边界样本验证 `max(configured, 既有占用)`（见 §9）。
- 附带覆盖（非本任务硬性）：Y18 §1、Y19 §3/§5、Y20 §4、Y21 §1、Y22 由 `normal-ledger.team` 的 `modeContract/plannerVersion` 样本提供。

## 11. 已知空缺（留给后续用例）

- Y23（B 批 `run.reconcile` 零推进）：需要真实 store + RPC，夹具仅提供 `normal-ledger` 作为"推进前快照"。
- Y24（无事件不轮询）：静态数据无法证明调用次数，归 R06 fake-clock/[REV]。
- Y25 的 `run.get` 零 nonce 泄漏：需要 DTO 快照用例；夹具的超大记录由 schema 接受、由 store 层拒写，超长字段为 schema 非法样本。
- `non-assignee` 的"非受派者"判定归 **R05/R06**：R01 `ReportIdentityShape` 不携带 reporter 身份，schema 层无法表达（见 §12）；不得为强制拒收而添加 `agentId` 等多余键。
- 期望值不在夹具中：任何 `expect` 都由 R01/R02/R03/R05 的实现用例撰写；本目录只锁定输入形状与计数。

## 12. schema 合法、后层拒绝的边界组

这些样本**不在**非法组：schema 必须接受，拒绝由后续层完成。自检 `BOUNDARIES` 断言 2/2 被接受。

| id | schema | 拒绝层 | 验证任务 |
|---|---|---|---|
| `oversized-ledger`（`buildOversizedLedger()`） | `RunRecordSchema` 接受 | store 字节上限（`RUN_SOFT_BYTES`/`RUN_HARD_BYTES`，停写 + D7） | R05（AC-RE1.12） |
| `non-assignee`（`NON_ASSIGNEE_REPORT`） | `RunTaskReportBlockSchema` 接受（无 reporter 字段） | 协议/store 所有权：`assignmentId` + `nonce` 不属于派发记录 | R05/R06（RE2.2/RE2.5 / Y6） |
