import path from "node:path";
import type { AgentInfo, Host, SetupStatus } from "../../v2/server/host";
import { sh } from "./repo";

type FakeAgent = {
  id: string;
  cwd: string;
  labels: Record<string, string>;
  prompt: string;
  provider: string;
  status: NonNullable<AgentInfo["status"]>;
  archived: boolean;
  sent: string[];
  pending: number;
};

/**
 * In-memory Paseo with real git worktrees, so the engine's HEAD / dirty / branch checks run for real.
 * Archiving a workspace removes its worktree directory and keeps the branch, like the real host.
 */
export class FakeHost implements Host {
  workspaces = new Map<
    string,
    { id: string; name: string; branch: string; path: string; archived: boolean }
  >();
  agents = new Map<string, FakeAgent>();
  /** setup result per branch-name prefix; default completed */
  setup = new Map<string, SetupStatus>();
  failCreateAgent: ((o: { labels: Record<string, string> }) => boolean) | null = null;
  failArchiveWorkspaceOnce = false;
  daemonConfig: unknown = {};
  private n = 0;

  constructor(private root: string) {}

  async createWorkspace(o: { sourceCheckout: string; baseBranch: string; branchName: string }) {
    const id = `ws-${++this.n}`;
    const dir = path.join(this.root, `wt-${this.n}`);
    sh(o.sourceCheckout, "worktree", "add", "-q", "-b", o.branchName, dir, o.baseBranch);
    // like the real host, the display name is a title, not the branch
    this.workspaces.set(id, {
      id,
      name: `Workspace ${this.n}`,
      branch: o.branchName,
      path: dir,
      archived: false,
    });
    return { id, path: dir };
  }

  async setupStatus(id: string): Promise<SetupStatus> {
    const w = this.workspaces.get(id);
    if (!w) return null;
    for (const [prefix, status] of this.setup) if (w.branch.startsWith(prefix)) return status;
    return "completed";
  }

  async archiveWorkspace(id: string) {
    if (this.failArchiveWorkspaceOnce) {
      this.failArchiveWorkspaceOnce = false;
      throw new Error("archive failed (injected)");
    }
    const w = this.workspaces.get(id);
    if (!w || w.archived) return;
    w.archived = true;
    try {
      sh(this.mainRepo(w.path), "worktree", "remove", "--force", w.path);
    } catch {
      /* already gone */
    }
  }

  private mainRepo(worktree: string) {
    return path.resolve(worktree, sh(worktree, "rev-parse", "--git-common-dir"), "..");
  }

  async listWorkspaces() {
    return [...this.workspaces.values()]
      .filter((w) => !w.archived)
      .map((w) => ({ id: w.id, name: w.name, path: w.path }));
  }

  async createAgent(o: {
    agentId: string;
    workspaceId: string;
    spec: { provider: string };
    prompt: string;
    labels: Record<string, string>;
  }) {
    if (this.failCreateAgent?.(o)) throw new Error("create agent failed (injected)");
    this.agents.set(o.agentId, {
      id: o.agentId,
      cwd: this.workspaces.get(o.workspaceId)?.path ?? "",
      labels: o.labels,
      prompt: o.prompt,
      provider: o.spec.provider,
      status: "idle", // by the time the engine messages an agent its turn has ended
      archived: false,
      sent: [],
      pending: 0,
    });
  }

  async send(agentId: string, text: string) {
    this.agents.get(agentId)?.sent.push(text);
  }

  async archiveAgent(agentId: string) {
    const a = this.agents.get(agentId);
    if (a) a.archived = true;
  }

  async agent(agentId: string): Promise<AgentInfo> {
    const a = this.agents.get(agentId);
    if (!a) return { exists: false, archived: false, status: null, pendingPermissions: 0 };
    return { exists: true, archived: a.archived, status: a.status, pendingPermissions: a.pending };
  }

  async config() {
    return this.daemonConfig;
  }

  async respondToPermission(agentId: string) {
    const a = this.agents.get(agentId);
    if (a) a.pending = Math.max(0, a.pending - 1);
  }

  // ---- test helpers ----
  agentWhere(pred: (a: FakeAgent) => boolean) {
    return [...this.agents.values()].filter((a) => !a.archived).find(pred);
  }
  writerAgent() {
    return this.agentWhere((a) => a.labels["agent-team.role"] === "writer");
  }
  reviewerAgents() {
    return [...this.agents.values()].filter((a) => a.labels["agent-team.role"] === "reviewer");
  }
  liveWorkspaceNames() {
    return [...this.workspaces.values()].filter((w) => !w.archived).map((w) => w.branch);
  }
}
