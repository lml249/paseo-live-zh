import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginSubscriptionHandle,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { type AgentSummary, type WorkspaceSummariesPayload, watchWorkspaceSummariesSub } from "../shared/contracts";

export const PANEL_ID = "live-zh";

let focusedAgentId: string | null = null;
const focusListeners = new Set<() => void>();

export function focusPanelAgent(agentId: string): void {
  focusedAgentId = agentId;
  for (const listener of focusListeners) listener();
}

export function subscribeFocusedAgent(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

export function getFocusedAgent(): string | null {
  return focusedAgentId;
}

interface TrackedAgent {
  id: string;
  workspaceId: string | null;
  background?: boolean;
}

interface PillState {
  workspaceId: string;
  label: string;
  title: string;
  pill: PluginButtonRegistration;
}

export function contributePills(client: PluginClientContext): () => void {
  let stopped = false;
  let agents: TrackedAgent[] = [];
  const summariesByAgent = new Map<string, AgentSummary>();
  const workspaceMeta = new Map<string, { paused: boolean; configured: boolean; enabled: boolean }>();
  const workspaceSubs = new Map<string, PluginSubscriptionHandle>();
  const pills = new Map<string, PillState>();
  const iconListeners = new Set<() => void>();

  const notifyIcons = () => {
    for (const listener of iconListeners) listener();
  };

  function PillIcon(props: PluginButtonIconProps) {
    const agentId = props.context === "agent" ? props.agentId : "";
    const state = useSyncExternalStore(
      (listener) => {
        iconListeners.add(listener);
        return () => {
          iconListeners.delete(listener);
        };
      },
      () => {
        const s = summariesByAgent.get(agentId);
        if (!s) return "idle";
        if (s.needsAttention) return "attention";
        if (s.state === "summarizing") return "summarizing";
        if (s.state === "error") return "error";
        if (s.agentStatus === "running") return "running";
        return "ready";
      },
    );

    if (state === "attention") {
      return <Icon name="AlertTriangle" size={props.size} color={props.theme.colors.statusWarning} />;
    }
    if (state === "error") {
      return <Icon name="CircleAlert" size={props.size} color={props.theme.colors.statusDanger} />;
    }
    if (state === "summarizing" || state === "running") {
      return <Icon name="Sparkles" size={props.size} color={props.theme.colors.accent} />;
    }
    return <Icon name="Languages" size={props.size} color={props.color} />;
  }

  const labelFor = (agentId: string, workspaceId: string): { label: string; title: string } => {
    const meta = workspaceMeta.get(workspaceId);
    const summary = summariesByAgent.get(agentId);
    if (meta && !meta.enabled) return { label: "中文解说(关)", title: "打开实时中文解说面板" };
    if (meta?.paused) return { label: "解说已暂停", title: "打开实时中文解说面板" };
    if (meta && !meta.configured) return { label: "配置中文解说", title: "请先在设置中配置兼容 API" };
    if (!summary) return { label: "中文解说", title: "打开实时中文解说面板" };
    if (summary.needsAttention) {
      const short = summary.needsAttention.length > 18 ? `${summary.needsAttention.slice(0, 17)}…` : summary.needsAttention;
      return { label: short, title: summary.needsAttention };
    }
    if (summary.state === "summarizing" && !summary.updatedAt) {
      return { label: "正在翻译进展…", title: "实时中文解说正在生成总结" };
    }
    if (summary.headline) {
      const suffix = summary.state === "summarizing" ? "…" : "";
      return { label: `${summary.headline}${suffix}`, title: summary.currentAction || summary.headline };
    }
    return { label: "中文解说", title: "打开实时中文解说面板" };
  };

  const publishPills = () => {
    if (stopped) return;
    const seen = new Set<string>();

    for (const agent of agents) {
      if (agent.background || !agent.workspaceId) continue;
      const workspaceId = agent.workspaceId;
      seen.add(agent.id);
      const { label, title } = labelFor(agent.id, workspaceId);
      const existing = pills.get(agent.id);

      if (existing && existing.workspaceId !== workspaceId) {
        existing.pill.remove();
        pills.delete(agent.id);
      }

      const current = pills.get(agent.id);
      if (!current) {
        const pill = client.addComposerPill({
          id: "live-zh-status",
          workspaceId,
          agentId: agent.id,
          button: {
            title,
            label,
            icon: PillIcon,
            behavior: {
              kind: "action",
              onPress: () => {
                focusPanelAgent(agent.id);
                client.openPanel(PANEL_ID, { workspaceId, location: "explorer" });
              },
            },
          },
        });
        pills.set(agent.id, { workspaceId, label, title, pill });
      } else if (current.label !== label || current.title !== title) {
        current.pill.update({ label, title });
        current.label = label;
        current.title = title;
      }
    }

    for (const [agentId, entry] of pills.entries()) {
      if (!seen.has(agentId)) {
        entry.pill.remove();
        pills.delete(agentId);
      }
    }
  };

  const applyWorkspacePayload = (payload: WorkspaceSummariesPayload) => {
    if (stopped) return;
    workspaceMeta.set(payload.workspaceId, {
      paused: payload.paused,
      configured: payload.configured,
      enabled: payload.enabled,
    });
    const present = new Set<string>();
    for (const agent of payload.agents) {
      present.add(agent.agentId);
      summariesByAgent.set(agent.agentId, agent);
    }
    for (const [id, summary] of summariesByAgent.entries()) {
      if (summary.workspaceId === payload.workspaceId && !present.has(id)) {
        summariesByAgent.delete(id);
      }
    }
    notifyIcons();
    publishPills();
  };

  const reconcileWorkspaceSubscriptions = () => {
    if (stopped) return;
    const needed = new Set<string>();
    for (const agent of agents) {
      if (!agent.background && agent.workspaceId) needed.add(agent.workspaceId);
    }

    for (const workspaceId of needed) {
      if (workspaceSubs.has(workspaceId)) continue;
      const handle = client.subscribe(
        watchWorkspaceSummariesSub,
        { workspaceId },
        (payload) => applyWorkspacePayload(payload),
        { onClosed: () => workspaceSubs.delete(workspaceId) },
      );
      workspaceSubs.set(workspaceId, handle);
    }

    for (const [workspaceId, handle] of workspaceSubs.entries()) {
      if (!needed.has(workspaceId)) {
        handle();
        workspaceSubs.delete(workspaceId);
      }
    }
  };

  let releaseAgentSub: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const startWatchingAgents = async () => {
    try {
      const result = await client.paseo.agents.list({
        subscribe: {},
        filter: { includeArchived: false },
        page: { limit: 100 },
      });
      if (stopped) {
        void result.subscription?.release().catch(() => undefined);
        return;
      }
      agents = result.entries.map(({ agent }) => ({
        id: agent.id,
        workspaceId: agent.workspaceId ?? null,
        background: agent.background,
      }));
      reconcileWorkspaceSubscriptions();
      publishPills();

      const sub = result.subscription;
      if (sub) {
        const unsub = sub.subscribe({
          snapshot: (snap) => {
            if (stopped) return;
            agents = snap.entries.map(({ agent }) => ({
              id: agent.id,
              workspaceId: agent.workspaceId ?? null,
              background: agent.background,
            }));
            reconcileWorkspaceSubscriptions();
            publishPills();
          },
          update: (message) => {
            if (stopped || message.type !== "agent_update") return;
            const update = message.payload;
            const id = update.kind === "remove" ? update.agentId : update.agent.id;
            agents = agents.filter((item) => item.id !== id);
            if (update.kind !== "remove") {
              agents.push({
                id: update.agent.id,
                workspaceId: update.agent.workspaceId ?? null,
                background: update.agent.background,
              });
            }
            reconcileWorkspaceSubscriptions();
            publishPills();
          },
          error: () => {
            if (!stopped) retryTimer = setTimeout(() => void startWatchingAgents(), 3_000);
          },
        });
        releaseAgentSub = () => {
          unsub();
          void sub.release().catch(() => undefined);
        };
      }
    } catch {
      if (!stopped) retryTimer = setTimeout(() => void startWatchingAgents(), 3_000);
    }
  };

  void startWatchingAgents();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    releaseAgentSub?.();
    for (const handle of workspaceSubs.values()) handle();
    workspaceSubs.clear();
    for (const entry of pills.values()) entry.pill.remove();
    pills.clear();
    iconListeners.clear();
  };
}
