// Baseline-shaped RPC inputs. None carries a P1 field (`contractVersion`, `existingRolesOnly`);
// these are exactly what an unrefreshed baseline App or script sends at 75ec305.
//
// Launch inputs intentionally omit `mode` where the baseline App omitted it, and include the
// advanced `mode:"economy"` override used by scripts/tests. Unknown-mode objects are negative
// fixtures: strict enums must reject them before any planning.
//
// Treat these objects as read-only; structuredClone before mutating a test copy.

const TASK = "按既有计划推进后台改版，并报告验证结果。";
const HASH = "a".repeat(64);
const CLIENT_REQUEST_ID = "eeeeeeee-0001-4000-8000-000000000001";
const OTHER_CLIENT_REQUEST_ID = "eeeeeeee-0002-4000-8000-000000000002";
const REQUEST = "为现有的后台改版需求设计一个复用现有 Role 的 Team。";

const WORKSPACE_TARGET = { kind: "workspace", workspaceId: "ws-dev-compat" };

export const LEGACY_LAUNCH_PREVIEW_INPUT_SAVED_MODE = {
  teamId: "compat-mode-economy",
  task: TASK,
  target: WORKSPACE_TARGET,
};

export const LEGACY_LAUNCH_PREVIEW_INPUT_ECONOMY_OVERRIDE = {
  teamId: "compat-mode-economy",
  task: TASK,
  target: WORKSPACE_TARGET,
  mode: "economy",
};

export const LEGACY_LAUNCH_PREVIEW_INPUT_NEW_WORKSPACE = {
  teamId: "compat-mode-sota",
  task: TASK,
  target: { kind: "new-workspace", projectId: "project-compat", title: "P1 兼容验证" },
};

/** Negative fixture: `turbo` is outside every baseline strict enum. */
export const LEGACY_LAUNCH_PREVIEW_INPUT_UNKNOWN_MODE = {
  teamId: "compat-mode-economy",
  task: TASK,
  target: WORKSPACE_TARGET,
  mode: "turbo",
};

/** Legacy start without a plan token; AC-0d.7 still has to block it when planning blocks. */
export const LEGACY_LAUNCH_START_INPUT_NO_HASH = {
  teamId: "compat-mode-economy",
  task: TASK,
  target: WORKSPACE_TARGET,
};

export const LEGACY_LAUNCH_START_INPUT_ECONOMY_OVERRIDE_NO_HASH = {
  teamId: "compat-mode-economy",
  task: TASK,
  target: WORKSPACE_TARGET,
  mode: "economy",
};

export const LEGACY_LAUNCH_START_INPUT_WITH_HASH = {
  teamId: "compat-mode-economy",
  task: TASK,
  target: WORKSPACE_TARGET,
  expectedPlanHash: HASH,
};

/** Negative fixture: strict enum rejection, not a fallback to the saved mode. */
export const LEGACY_LAUNCH_START_INPUT_UNKNOWN_MODE = {
  teamId: "compat-mode-economy",
  task: TASK,
  target: WORKSPACE_TARGET,
  mode: "turbo",
};

/** Old design request with the legacy economy literal. */
export const LEGACY_DESIGN_START_INPUT_ECONOMY = {
  clientRequestId: CLIENT_REQUEST_ID,
  request: REQUEST,
  mode: "economy",
};

/** Same clientRequestId and request with no mode: baseline defaults to sota. */
export const LEGACY_DESIGN_START_INPUT_OMITTED_MODE = {
  clientRequestId: CLIENT_REQUEST_ID,
  request: REQUEST,
};

export const LEGACY_DESIGN_START_INPUT_SOTA_WORKSPACE = {
  clientRequestId: OTHER_CLIENT_REQUEST_ID,
  request: REQUEST,
  mode: "sota",
  workspaceId: "ws-dev-compat",
  profileId: "profile-designer-opus",
};

export const LEGACY_DESIGN_START_INPUT_DEFAULT_PROFILE_HINTS = {
  clientRequestId: OTHER_CLIENT_REQUEST_ID,
  request: REQUEST,
  mode: "sota",
  useDefaultProfileHints: true,
};

/** Negative fixture: unknown design modes stay rejected by the strict input enum. */
export const LEGACY_DESIGN_START_INPUT_UNKNOWN_MODE = {
  clientRequestId: OTHER_CLIENT_REQUEST_ID,
  request: REQUEST,
  mode: "turbo",
};
