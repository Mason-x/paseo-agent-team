import {
  type PluginWorkspacePanelProps,
  usePaseo,
  useSettings,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type ListRenderItemInfo, Pressable, StyleSheet, Text, View } from "react-native";
import { preferencesSettings, rolesSettings, teamsSettings } from "../shared/settings";
import { zh } from "../shared/zh";
import {
  type AgentEntry,
  agentAgeTimestamp,
  agentTitle,
  buildCrewForest,
  CREW_STATE_LABELS,
  CREW_STATES,
  type CrewNode,
  type CrewState,
  collapseCrewNodes,
  crewCounts,
  crewState,
  formatAge,
  isWorking,
  type PaseoApi,
  type PaseoWorkspace,
  parentAgentId,
} from "./crew";
import { RunHeader } from "./crew/RunHeader";
import { type CrewListItem, crewListItems, roleLine, runIdOf } from "./crew/run-rows";
import { subscribeLaunchRequests } from "./launch/events";
import { LaunchDialog } from "./launch/LaunchDialog";
import { createPaseoAdapter, type ProviderAvailability } from "./paseo/adapter";
import { useHostProfiles } from "./paseo/profiles";
import { ImeTextInput } from "./shared/ImeTextInput";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const REFRESH_DEBOUNCE_MS = 500;
const BACKSTOP_REFRESH_MS = 30_000;
const CLOCK_INTERVAL_MS = 15_000;

type CrewData = {
  entries: AgentEntry[];
  workspaceNames: ReadonlyMap<string, string>;
  truncated: boolean;
};

type CrewAction =
  | { kind: "send"; agentId: string; text: string; interrupted: boolean }
  | { kind: "detach"; agentId: string }
  | { kind: "archive"; agentId: string };

type PermissionRequest = AgentEntry["agent"]["pendingPermissions"][number];

type PermissionActionInput = {
  agentId: string;
  request: PermissionRequest;
  behavior: "allow" | "deny";
};

type PermissionDialogState = { node: CrewNode; request: PermissionRequest } | null;
type DialogState = { kind: "message" | "detach" | "archive"; node: CrewNode } | null;

async function loadAgents(paseo: PaseoApi): Promise<{ entries: AgentEntry[]; truncated: boolean }> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}

async function loadWorkspaces(paseo: PaseoApi): Promise<PaseoWorkspace[]> {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    workspaces.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return workspaces;
}

async function loadCrewData(paseo: PaseoApi): Promise<CrewData> {
  const [agents, workspaces] = await Promise.all([loadAgents(paseo), loadWorkspaces(paseo)]);
  return {
    entries: agents.entries,
    truncated: agents.truncated,
    workspaceNames: new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
  };
}

function ActionButton({
  accessibilityLabel,
  color,
  disabled,
  icon,
  onPress,
}: {
  accessibilityLabel: string;
  color: string;
  disabled?: boolean;
  icon: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon name={icon} size={15} color={color} />
    </Pressable>
  );
}

function stateColor(
  state: CrewState,
  colors: PluginWorkspacePanelProps["theme"]["colors"],
): string {
  if (state === "failed") return colors.statusDanger;
  if (state === "needs-input") return colors.statusWarning;
  if (state === "ready") return colors.statusSuccess;
  if (state === "working") return colors.accent;
  return colors.foregroundMuted;
}

function permissionRequestText(request: PermissionRequest): string {
  return request.title ?? request.name;
}

function permissionRequestDetails(request: PermissionRequest): string {
  return [
    `类型: ${request.kind}`,
    request.description ? `描述: ${request.description}` : null,
    request.input ? `输入: ${JSON.stringify(request.input, null, 2)}` : null,
    request.detail ? `详情: ${JSON.stringify(request.detail, null, 2)}` : null,
    request.actions?.length
      ? `操作: ${request.actions.map((action) => action.label).join(" · ")}`
      : null,
    request.suggestions?.length ? `建议: ${JSON.stringify(request.suggestions, null, 2)}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function permissionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : zh.permissionDecisionFailed;
  const lower = message.toLowerCase();
  if (
    lower.includes("already resolved") ||
    lower.includes("not pending") ||
    lower.includes("no longer pending") ||
    lower.includes("request not found")
  ) {
    return zh.permissionAlreadyResolved;
  }
  if (lower.includes("network") || lower.includes("transport") || lower.includes("ipc")) {
    return zh.permissionUnreachable;
  }
  return message;
}

export function AgentCrew({
  theme,
  layout,
  host,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const adapter = useMemo(() => createPaseoAdapter(paseo), [paseo]);
  const roles = useSettings(rolesSettings);
  const teams = useSettings(teamsSettings);
  const preferences = useSettings(preferencesSettings);
  const hostProfiles = useHostProfiles(adapter);
  const workspaceTitle = useWorkspace(workspaceId, ({ name, title }) => title?.trim() || name);
  const queryKey = useMemo(() => ["agent-crew", "directory", host.id], [host.id]);
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => loadCrewData(paseo),
    refetchInterval: BACKSTOP_REFRESH_MS,
  });

  const [selectedState, setSelectedState] = useState<CrewState | null>(null);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [permissionDialog, setPermissionDialog] = useState<PermissionDialogState>(null);
  const [message, setMessage] = useState("");
  const [messageSeed, setMessageSeed] = useState(0);
  const [collapsedAgentIds, setCollapsedAgentIds] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedRunIds, setCollapsedRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [launchOpen, setLaunchOpen] = useState(false);
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null);
  const [availability, setAvailability] = useState<ProviderAvailability[]>([]);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(clock);
  }, []);

  useEffect(
    () =>
      subscribeLaunchRequests((request) => {
        if (request.workspaceId && request.workspaceId !== workspaceId) return;
        setLaunchOpen(true);
      }),
    [workspaceId],
  );

  useEffect(() => {
    if (!launchOpen) return;
    let cancelled = false;
    void adapter.listProviderAvailability().then((nextAvailability) => {
      if (!cancelled) setAvailability(nextAvailability);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter, launchOpen]);

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void queryClient.invalidateQueries({ queryKey });
      }, REFRESH_DEBOUNCE_MS);
    };
    const unsubscribeAgents = paseo.agents.subscribe(invalidate);
    const unsubscribeWorkspaces = paseo.workspaces.subscribe(invalidate);
    return () => {
      clearTimeout(debounce);
      unsubscribeAgents();
      unsubscribeWorkspaces();
    };
  }, [paseo, queryClient, queryKey]);

  const allNodes = useMemo(
    () =>
      buildCrewForest(data?.entries ?? [], workspaceId, {
        state: null,
        query: "",
        workspaceNames: data?.workspaceNames,
      }),
    [data, workspaceId],
  );
  const nodes = useMemo(
    () =>
      buildCrewForest(data?.entries ?? [], workspaceId, {
        state: selectedState,
        query,
        workspaceNames: data?.workspaceNames,
      }),
    [data, query, selectedState, workspaceId],
  );
  const visibleNodes = useMemo(
    () => collapseCrewNodes(nodes, collapsedAgentIds),
    [collapsedAgentIds, nodes],
  );
  const recentRuns = preferences.status === "ready" ? preferences.values.recentRuns : [];
  const listItems = useMemo(
    () => crewListItems(visibleNodes, collapsedRunIds, recentRuns),
    [collapsedRunIds, recentRuns, visibleNodes],
  );
  const counts = useMemo(() => crewCounts(allNodes), [allNodes]);
  const memberNodes = useMemo(() => allNodes.filter(({ member }) => member), [allNodes]);
  const crewCount = useMemo(
    () =>
      allNodes.filter(({ depth, descendantCount }) => depth === 0 && descendantCount > 0).length,
    [allNodes],
  );
  const externalCount = useMemo(
    () =>
      memberNodes.filter(
        ({ entry }) => entry.agent.workspaceId && entry.agent.workspaceId !== workspaceId,
      ).length,
    [memberNodes, workspaceId],
  );

  const action = useMutation({
    mutationFn: async (input: CrewAction) => {
      const handle = paseo.agents.ref(input.agentId);
      if (input.kind === "send") {
        await handle.send(input.text);
      } else if (input.kind === "detach") {
        await handle.detach();
      } else {
        await handle.archive();
      }
    },
    onSuccess: (_result, input) => {
      if (input.kind === "send") {
        toast.show(input.interrupted ? zh.agentRedirected : zh.nudgeSent, { variant: "success" });
      } else if (input.kind === "detach") {
        toast.show(zh.subagentDetached, { variant: "success" });
      } else {
        toast.show(zh.subagentArchived, { variant: "success" });
      }
      setDialog(null);
      setMessage("");
      setMessageSeed((seed) => seed + 1);
    },
    onError: (mutationError) => {
      toast.error(mutationError instanceof Error ? mutationError.message : zh.agentActionFailed);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const permissionAction = useMutation({
    mutationFn: async (input: PermissionActionInput) => {
      await paseo.agents.ref(input.agentId).respondToPermission({
        requestId: input.request.id,
        response:
          input.behavior === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: zh.deniedFromCrew },
      });
    },
    onSuccess: (_result, input) => {
      toast.show(input.behavior === "allow" ? zh.permissionAllowed : zh.permissionDenied, {
        variant: "success",
      });
      setPermissionDialog(null);
    },
    onError: (mutationError) => {
      const message = permissionErrorMessage(mutationError);
      toast.error(message);
      if (message === zh.permissionAlreadyResolved) {
        setPermissionDialog(null);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const panelStyles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.surface0,
        },
        header: {
          paddingHorizontal: layout.compact ? 14 : 20,
          paddingTop: layout.compact ? 14 : 18,
          paddingBottom: 12,
          gap: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        titleRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        },
        titleBlock: { flex: 1, minWidth: 0 },
        eyebrow: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "600",
          letterSpacing: 0.8,
          textTransform: "uppercase",
        },
        title: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 19 : 22,
          fontWeight: "700",
        },
        summary: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
        },
        toolbar: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        search: {
          flex: 1,
          minWidth: 120,
          height: 36,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          fontSize: 13,
        },
        refreshButton: {
          minHeight: 36,
          paddingHorizontal: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface1,
        },
        chipRail: { gap: 6 },
        chip: {
          minHeight: 30,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 9,
          borderRadius: 15,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        chipSelected: {
          borderColor: theme.colors.accent,
          backgroundColor: theme.colors.surface2,
        },
        chipText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        chipTextSelected: { color: theme.colors.foreground, fontWeight: "600" },
        dot: { width: 7, height: 7, borderRadius: 4 },
        row: {
          minHeight: layout.compact ? 78 : 68,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 10,
          paddingRight: layout.compact ? 10 : 16,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        contextRow: { opacity: 0.58 },
        treeRail: {
          alignSelf: "stretch",
          width: 10,
          borderLeftWidth: 2,
          borderLeftColor: theme.colors.border,
        },
        rowBody: { flex: 1, minWidth: 0, gap: 3 },
        rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 7 },
        rowTitle: {
          flexShrink: 1,
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
        },
        rootRow: { backgroundColor: theme.colors.surface1 },
        highlightedRow: { backgroundColor: theme.colors.surface2 },
        childCount: { flexShrink: 0, color: theme.colors.foregroundMuted, fontSize: 11 },
        collapseSpacer: { width: 30, height: 30 },
        metadata: { color: theme.colors.foregroundMuted, fontSize: 11 },
        lastError: { color: theme.colors.statusDanger, fontSize: 11 },
        permissionCount: { color: theme.colors.statusWarning, fontSize: 11, fontWeight: "600" },
        statusColumn: { alignItems: "flex-end", gap: 5 },
        status: { fontSize: 11, fontWeight: "600" },
        age: { color: theme.colors.foregroundMuted, fontSize: 10 },
        rowActions: { flexDirection: "row", alignItems: "center", gap: 2 },
        empty: { padding: 24, gap: 6, alignItems: "center" },
        emptyTitle: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" },
        emptyBody: { color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" },
        error: {
          margin: 12,
          padding: 10,
          color: theme.colors.statusDanger,
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
        },
        contextBadge: {
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          fontWeight: "600",
          textTransform: "uppercase",
        },
        truncated: { paddingHorizontal: 16, paddingVertical: 8, color: theme.colors.statusWarning },
        modalBody: { gap: 14, padding: 18 },
        modalCopy: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
        messageInput: {
          minHeight: 112,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 8,
          padding: 10,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          textAlignVertical: "top",
        },
        modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
        secondaryButton: {
          minHeight: 36,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        primaryButton: {
          minHeight: 36,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 8,
          backgroundColor: theme.colors.accent,
        },
        dangerButton: { backgroundColor: theme.colors.statusDanger },
        buttonText: { color: theme.colors.foreground, fontWeight: "600", fontSize: 13 },
        primaryButtonText: {
          color: theme.colors.accentForeground,
          fontWeight: "600",
          fontSize: 13,
        },
        permissionBody: { gap: 12 },
        permissionSection: { gap: 4 },
        permissionLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
        permissionValue: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        permissionJson: {
          color: theme.colors.foreground,
          fontSize: 12,
          lineHeight: 17,
          fontFamily: "monospace",
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
          padding: 10,
        },
        permissionActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
        permissionButton: {
          minHeight: 36,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        permissionPrimary: { backgroundColor: theme.colors.accent },
        permissionDeny: { backgroundColor: theme.colors.statusDanger },
        permissionButtonText: { color: theme.colors.foreground, fontWeight: "600", fontSize: 13 },
        permissionDenyText: { color: theme.colors.surface0, fontWeight: "600", fontSize: 13 },
        permissionPrimaryText: {
          color: theme.colors.accentForeground,
          fontWeight: "600",
          fontSize: 13,
        },
      }),
    [layout.compact, theme],
  );
  function openDialog(kind: NonNullable<DialogState>["kind"], node: CrewNode) {
    setMessage("");
    setMessageSeed((seed) => seed + 1);
    setDialog({ kind, node });
  }

  function submitDialog() {
    if (!dialog || action.isPending) return;
    const agent = dialog.node.entry.agent;
    if (dialog.kind === "message") {
      const text = message.trim();
      if (!text) return;
      action.mutate({ kind: "send", agentId: agent.id, text, interrupted: isWorking(agent) });
      return;
    }
    action.mutate({ kind: dialog.kind, agentId: agent.id });
  }

  function toggleCollapsed(agentId: string) {
    setCollapsedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  function openPermissionDialog(node: CrewNode, request: PermissionRequest) {
    setPermissionDialog({ node, request });
  }

  function submitPermissionAction(behavior: "allow" | "deny") {
    if (!permissionDialog || permissionAction.isPending) return;
    permissionAction.mutate({
      agentId: permissionDialog.node.entry.agent.id,
      request: permissionDialog.request,
      behavior,
    });
  }

  function renderAgentRow(item: CrewNode) {
    const agent = item.entry.agent;
    const state = crewState(agent);
    const color = stateColor(state, theme.colors);
    const workspaceName = agent.workspaceId
      ? data?.workspaceNames.get(agent.workspaceId)
      : undefined;
    const external = Boolean(agent.workspaceId && agent.workspaceId !== workspaceId);
    const workspaceDetail = workspaceName
      ? `${external ? zh.elsewherePrefix : ""}${workspaceName}`
      : external
        ? zh.elsewhere
        : undefined;
    const providerModel = agent.model ? `${agent.provider}/${agent.model}` : agent.provider;
    const metadata = workspaceDetail ? `${providerModel} · ${workspaceDetail}` : providerModel;
    const roleMeta = roleLine(item);
    const highlighted = Boolean(highlightRunId && runIdOf(item) === highlightRunId);
    const age = formatAge(agentAgeTimestamp(agent), now);
    const expandable = item.descendantCount > 0;
    const collapsed = collapsedAgentIds.has(agent.id);
    const pendingPermissions = agent.pendingPermissions ?? [];
    const pendingPermission = pendingPermissions[0];
    const pendingPermissionCount = pendingPermissions.length;
    const rowBody = (
      <>
        <View style={panelStyles.rowTitleLine}>
          <View style={[panelStyles.dot, { backgroundColor: color }]} />
          <Text style={panelStyles.rowTitle} numberOfLines={1}>
            {agentTitle(item.entry)}
          </Text>
          {!item.member ? <Text style={panelStyles.contextBadge}>Context</Text> : null}
          {expandable ? (
            <Text style={panelStyles.childCount} numberOfLines={1}>
              {item.descendantCount} {zh.descendant}
            </Text>
          ) : null}
        </View>
        <Text style={panelStyles.metadata} numberOfLines={1}>
          {metadata}
        </Text>
        {roleMeta ? (
          <Text style={panelStyles.metadata} numberOfLines={1}>
            {roleMeta}
          </Text>
        ) : null}
        {agent.lastError ? (
          <Text style={panelStyles.lastError} numberOfLines={1}>
            {agent.lastError}
          </Text>
        ) : null}
      </>
    );

    return (
      <View
        style={[
          panelStyles.row,
          item.depth === 0 && panelStyles.rootRow,
          item.contextOnly && panelStyles.contextRow,
          highlighted && panelStyles.highlightedRow,
          { paddingLeft: 12 + Math.min(item.depth, 6) * 16 },
        ]}
      >
        {item.depth > 0 ? <View style={panelStyles.treeRail} /> : null}
        {expandable ? (
          <ActionButton
            accessibilityLabel={`${collapsed ? zh.expand : zh.collapse} ${agentTitle(item.entry)}`}
            color={theme.colors.foregroundMuted}
            icon={collapsed ? "ChevronRight" : "ChevronDown"}
            onPress={() => toggleCollapsed(agent.id)}
          />
        ) : (
          <View style={panelStyles.collapseSpacer} />
        )}
        {navigation ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${agentTitle(item.entry)}`}
            onPress={() => navigation.openAgent({ agentId: agent.id })}
            style={({ pressed }) => [panelStyles.rowBody, pressed && styles.pressed]}
          >
            {rowBody}
          </Pressable>
        ) : (
          <View style={panelStyles.rowBody}>{rowBody}</View>
        )}
        <View style={panelStyles.statusColumn}>
          <Text
            style={[
              panelStyles.status,
              { color: item.member ? color : theme.colors.foregroundMuted },
            ]}
          >
            {item.member ? CREW_STATE_LABELS[state] : zh.context}
          </Text>
          {pendingPermissionCount > 0 ? (
            <Text style={panelStyles.permissionCount} numberOfLines={1}>
              {pendingPermissionCount} pending
            </Text>
          ) : null}
          {age ? <Text style={panelStyles.age}>{age}</Text> : null}
          {item.member ? (
            <View style={panelStyles.rowActions}>
              {pendingPermission ? (
                <ActionButton
                  accessibilityLabel={`Review ${pendingPermissionCount} pending permission ${pendingPermissionCount === 1 ? "request" : "requests"} for ${agentTitle(item.entry)}`}
                  color={theme.colors.statusWarning}
                  disabled={permissionAction.isPending}
                  icon="Lock"
                  onPress={() => openPermissionDialog(item, pendingPermission)}
                />
              ) : null}
              {agent.status !== "closed" ? (
                <ActionButton
                  accessibilityLabel={`${isWorking(agent) ? zh.interruptRedirect : zh.nudge} ${agentTitle(item.entry)}`}
                  color={
                    isWorking(agent) ? theme.colors.statusWarning : theme.colors.foregroundMuted
                  }
                  disabled={action.isPending}
                  icon={isWorking(agent) ? "CornerDownRight" : "MessageSquareMore"}
                  onPress={() => openDialog("message", item)}
                />
              ) : null}
              {parentAgentId(agent) ? (
                <ActionButton
                  accessibilityLabel={`Detach ${agentTitle(item.entry)}`}
                  color={theme.colors.foregroundMuted}
                  disabled={action.isPending}
                  icon="Unlink"
                  onPress={() => openDialog("detach", item)}
                />
              ) : null}
              <ActionButton
                accessibilityLabel={`Archive ${agentTitle(item.entry)}`}
                color={theme.colors.foregroundMuted}
                disabled={action.isPending}
                icon="Archive"
                onPress={() => openDialog("archive", item)}
              />
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  function renderRow({ item }: ListRenderItemInfo<CrewListItem>) {
    if (item.kind === "run") {
      return (
        <RunHeader
          theme={theme}
          title={item.title}
          collapsed={collapsedRunIds.has(item.runId)}
          highlighted={highlightRunId === item.runId}
          onToggle={() =>
            setCollapsedRunIds((current) => {
              const next = new Set(current);
              if (next.has(item.runId)) next.delete(item.runId);
              else next.add(item.runId);
              return next;
            })
          }
        />
      );
    }
    return renderAgentRow(item.node);
  }
  const currentWorkspaceTitle = workspaceTitle?.trim() || zh.currentWorkspace;
  let dialogTitle = "";
  let dialogCopy = "";
  let confirmLabel = "";
  if (dialog) {
    const target = agentTitle(dialog.node.entry);
    if (dialog.kind === "message") {
      const state = crewState(dialog.node.entry.agent);
      const running = isWorking(dialog.node.entry.agent);
      dialogTitle = running ? `${zh.interruptRedirect} ${target}` : `${zh.nudge} ${target}`;
      dialogCopy = running
        ? "该智能体正在工作。发送消息会停止当前回合并开始新方向。"
        : state === "needs-input"
          ? "该智能体正在等待权限决定。发送消息会关闭该请求并开始新方向。"
          : "发送一条简短跟进，补上缺失上下文或下一步。";
      confirmLabel = running
        ? zh.interruptRedirect
        : state === "needs-input"
          ? "关闭请求并轻推"
          : zh.nudge;
    } else if (dialog.kind === "detach") {
      dialogTitle = `${zh.detach} ${target}？`;
      dialogCopy =
        dialog.node.descendantCount > 0
          ? `该智能体及其 ${dialog.node.descendantCount} 个下级将离开此班组视图，继续作为独立智能体运行。`
          : "该智能体将离开此班组视图，继续作为独立智能体运行。";
      confirmLabel = zh.detach;
    } else {
      dialogTitle = `${zh.archive} ${target}？`;
      dialogCopy =
        dialog.node.descendantCount > 0
          ? `该智能体有 ${dialog.node.descendantCount} 个受管下级。同工作区下级会一并归档；跨工作区下级会分离并继续运行。`
          : isWorking(dialog.node.entry.agent)
            ? "该智能体仍在工作。归档会停止它并将其从班组中移除。"
            : "该智能体将停止并从班组中移除。";
      confirmLabel = zh.archive;
    }
  }
  const permissionDialogTitle = permissionDialog
    ? `来自 ${agentTitle(permissionDialog.node.entry)} 的权限请求`
    : zh.permissionRequest;

  return (
    <View style={panelStyles.screen}>
      <View style={panelStyles.header}>
        <View style={panelStyles.titleRow}>
          <View style={panelStyles.titleBlock}>
            <Text style={panelStyles.eyebrow}>{zh.sidebarAgentCrew}</Text>
            <Text style={panelStyles.title} numberOfLines={1}>
              {currentWorkspaceTitle}
            </Text>
            <Text style={panelStyles.summary}>
              {memberNodes.length} {zh.agentWord} · {crewCount} {zh.crewWord}
              {externalCount > 0 ? ` · ${externalCount} ${zh.elsewhere}` : ""}
            </Text>
          </View>
          <View style={panelStyles.toolbar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={zh.launchTeam}
              onPress={() => setLaunchOpen(true)}
              style={({ pressed }) => [panelStyles.refreshButton, pressed && styles.pressed]}
            >
              <Text style={panelStyles.summary}>{zh.launchTeam}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={zh.refreshCrew}
              onPress={() => void refetch()}
              style={({ pressed }) => [panelStyles.refreshButton, pressed && styles.pressed]}
            >
              <Icon
                name="RefreshCw"
                size={16}
                color={isFetching ? theme.colors.accent : theme.colors.foregroundMuted}
              />
            </Pressable>
          </View>
        </View>
        <View style={panelStyles.toolbar}>
          <ImeTextInput
            accessibilityLabel={zh.filterAgents}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder={zh.filterPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={panelStyles.search}
          />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={panelStyles.chipRail}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: selectedState === null }}
            onPress={() => setSelectedState(null)}
            style={[panelStyles.chip, selectedState === null && panelStyles.chipSelected]}
          >
            <Text
              style={[panelStyles.chipText, selectedState === null && panelStyles.chipTextSelected]}
            >
              All {memberNodes.length}
            </Text>
          </Pressable>
          {CREW_STATES.map((state) => (
            <Pressable
              key={state}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedState === state }}
              onPress={() => setSelectedState(state)}
              style={[panelStyles.chip, selectedState === state && panelStyles.chipSelected]}
            >
              <View
                style={[panelStyles.dot, { backgroundColor: stateColor(state, theme.colors) }]}
              />
              <Text
                style={[
                  panelStyles.chipText,
                  selectedState === state && panelStyles.chipTextSelected,
                ]}
              >
                {CREW_STATE_LABELS[state]} {counts[state]}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {data?.truncated ? (
        <Text style={panelStyles.truncated}>
          Showing the first {PAGE_LIMIT * MAX_PAGES} daemon agents. Some agents in this workspace or
          their crew may be missing.
        </Text>
      ) : null}
      {error ? (
        <Text style={panelStyles.error}>
          {error instanceof Error ? error.message : zh.loadAgentsFail}
        </Text>
      ) : null}
      <FlatList
        data={listItems}
        keyExtractor={(item) =>
          item.kind === "run" ? `run-${item.runId}` : item.node.entry.agent.id
        }
        renderItem={renderRow}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={panelStyles.empty}>
            <Icon name="Network" size={24} color={theme.colors.foregroundMuted} />
            <Text style={panelStyles.emptyTitle}>
              {isPending ? zh.loadingCrew : memberNodes.length === 0 ? zh.noAgents : zh.noMatches}
            </Text>
            <Text style={panelStyles.emptyBody}>
              {isPending
                ? zh.loadingCrewBody
                : memberNodes.length === 0
                  ? zh.noAgentsBody
                  : zh.noMatchesBody}
            </Text>
          </View>
        }
      />

      <Modal
        title={dialogTitle}
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !action.isPending) {
            setDialog(null);
            setMessage("");
            setMessageSeed((seed) => seed + 1);
          }
        }}
        icon={
          dialog ? (
            <Icon
              name={
                dialog.kind === "message"
                  ? "MessageSquareMore"
                  : dialog.kind === "detach"
                    ? "Unlink"
                    : "Archive"
              }
              size={18}
              color={
                dialog.kind === "archive" ? theme.colors.statusDanger : theme.colors.foreground
              }
            />
          ) : undefined
        }
      >
        <Modal.Content>
          <View style={panelStyles.modalBody}>
            <Text style={panelStyles.modalCopy}>{dialogCopy}</Text>
            {dialog?.kind === "message" ? (
              <ImeTextInput
                accessibilityLabel={zh.messageToSubagent}
                autoFocus
                multiline
                initialValue=""
                revision={messageSeed}
                onChangeText={setMessage}
                placeholder={zh.nextStepPlaceholder}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={panelStyles.messageInput}
              />
            ) : null}
            <View style={panelStyles.modalActions}>
              <Pressable
                accessibilityRole="button"
                disabled={action.isPending}
                onPress={() => {
                  setDialog(null);
                  setMessage("");
                  setMessageSeed((seed) => seed + 1);
                }}
                style={({ pressed }) => [panelStyles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={panelStyles.buttonText}>{zh.cancel}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={action.isPending || (dialog?.kind === "message" && !message.trim())}
                onPress={submitDialog}
                style={({ pressed }) => [
                  panelStyles.primaryButton,
                  dialog?.kind === "archive" && panelStyles.dangerButton,
                  pressed && styles.pressed,
                  (action.isPending || (dialog?.kind === "message" && !message.trim())) &&
                    styles.disabled,
                ]}
              >
                <Text style={panelStyles.primaryButtonText}>
                  {action.isPending ? zh.workingEllipsis : confirmLabel}
                </Text>
              </Pressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title={permissionDialogTitle}
        open={permissionDialog !== null}
        onOpenChange={(open) => {
          if (!open && !permissionAction.isPending) {
            setPermissionDialog(null);
          }
        }}
        icon={
          permissionDialog ? (
            <Icon name="Lock" size={18} color={theme.colors.foreground} />
          ) : undefined
        }
      >
        <Modal.Content contentContainerStyle={panelStyles.permissionBody}>
          {permissionDialog ? (
            <>
              <Text style={panelStyles.modalCopy}>{zh.permissionReview}</Text>
              <View style={panelStyles.permissionSection}>
                <Text style={panelStyles.permissionLabel}>{zh.request}</Text>
                <Text style={panelStyles.permissionValue}>
                  {permissionRequestText(permissionDialog.request)}
                </Text>
              </View>
              <View style={panelStyles.permissionSection}>
                <Text style={panelStyles.permissionLabel}>{zh.permissionKind}</Text>
                <Text style={panelStyles.permissionValue}>{permissionDialog.request.kind}</Text>
              </View>
              {permissionDialog.request.description ? (
                <View style={panelStyles.permissionSection}>
                  <Text style={panelStyles.permissionLabel}>{zh.description}</Text>
                  <Text style={panelStyles.permissionValue}>
                    {permissionDialog.request.description}
                  </Text>
                </View>
              ) : null}
              <View style={panelStyles.permissionSection}>
                <Text style={panelStyles.permissionLabel}>{zh.permissionPayload}</Text>
                <Text selectable style={panelStyles.permissionJson}>
                  {permissionRequestDetails(permissionDialog.request)}
                </Text>
              </View>
              <View style={panelStyles.permissionActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={permissionAction.isPending}
                  onPress={() => setPermissionDialog(null)}
                  style={({ pressed }) => [panelStyles.permissionButton, pressed && styles.pressed]}
                >
                  <Text style={panelStyles.permissionButtonText}>{zh.cancel}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={permissionAction.isPending}
                  onPress={() => submitPermissionAction("deny")}
                  style={({ pressed }) => [
                    panelStyles.permissionButton,
                    panelStyles.permissionDeny,
                    pressed && styles.pressed,
                    permissionAction.isPending && styles.disabled,
                  ]}
                >
                  <Text style={panelStyles.permissionDenyText}>
                    {permissionAction.isPending ? zh.workingEllipsis : zh.deny}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={permissionAction.isPending}
                  onPress={() => submitPermissionAction("allow")}
                  style={({ pressed }) => [
                    panelStyles.permissionButton,
                    panelStyles.permissionPrimary,
                    pressed && styles.pressed,
                    permissionAction.isPending && styles.disabled,
                  ]}
                >
                  <Text style={panelStyles.permissionPrimaryText}>
                    {permissionAction.isPending ? zh.workingEllipsis : zh.allow}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </Modal.Content>
      </Modal>
      {launchOpen &&
      roles.status === "ready" &&
      teams.status === "ready" &&
      preferences.status === "ready" ? (
        <LaunchDialog
          theme={theme}
          layout={layout}
          open={launchOpen}
          adapter={adapter}
          teams={teams.values.teams}
          roles={roles.values.roles}
          profiles={hostProfiles.status === "ready" ? hostProfiles.profiles : []}
          availability={availability}
          projects={[]}
          preferences={preferences.values}
          initialWorkspaceId={workspaceId}
          onClose={() => setLaunchOpen(false)}
          onLaunched={(runId) => {
            setHighlightRunId(runId);
            setLaunchOpen(false);
          }}
          onSavePreferences={async (next) => {
            await preferences.save(next, preferences.revision);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
  },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.38 },
});
