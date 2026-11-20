import type { PaseoApi } from "@getpaseo/client";
import type {
  AgentSummary,
  SummaryHistoryEntry,
  WorkspaceSummariesPayload,
} from "../shared/contracts";
import { DEFAULT_LIVE_ZH_SETTINGS, type LiveZhSettingsValues } from "../shared/settings";
import { summarizeTimelineWithLlm } from "./llm";
import { extractRecentTimeline } from "./timeline";

interface TrackedAgentMeta {
  agentId: string;
  workspaceId: string | null;
  title: string;
  provider: string;
  status: string;
  lastActivityAt: number;
}

interface AgentRecord {
  summary: AgentSummary;
  lastFingerprint: string | null;
  inFlight: boolean;
  queuedPhase: "live" | "turn_end" | "manual" | null;
  queuedForce: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
  settleTimer?: ReturnType<typeof setTimeout>;
  pendingPermission: string | null;
  lastActivityAt: number;
}

interface WorkspaceSubscriber {
  workspaceId: string;
  push: (payload: WorkspaceSummariesPayload) => Promise<void>;
  signal: AbortSignal;
}

const MAX_HISTORY = 5;

function isLoopbackUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(baseUrl.trim());
}

function isConfigured(settings: LiveZhSettingsValues): boolean {
  if (!settings.baseUrl.trim() || !settings.model.trim()) return false;
  if (settings.apiKey.trim()) return true;
  return isLoopbackUrl(settings.baseUrl);
}

function defaultHeadline(status: string, configured: boolean, enabled: boolean, paused: boolean): string {
  if (!enabled) return "已关闭解说";
  if (paused) return "已暂停追更";
  if (!configured) return "请先配置 API";
  if (status === "running") return "正在分析进展…";
  return "中文解说就绪";
}

export class LiveZhService {
  private settings: LiveZhSettingsValues = DEFAULT_LIVE_ZH_SETTINGS;
  private paused = false;
  private stopped = false;
  private paseo: PaseoApi | null = null;
  private readonly records = new Map<string, AgentRecord>();
  private readonly subscribers = new Set<WorkspaceSubscriber>();

  setSettings(next: LiveZhSettingsValues): void {
    const prevInterval = this.settings.pollIntervalSec;
    const prevLive = this.settings.liveFollow;
    const prevEnabled = this.settings.enabled;
    this.settings = next;

    if (prevInterval !== next.pollIntervalSec || prevLive !== next.liveFollow || prevEnabled !== next.enabled) {
      this.reconcilePollTimers();
    }
    this.broadcastAllWorkspaces();
  }

  getSettings(): LiveZhSettingsValues {
    return this.settings;
  }

  isPaused(): boolean {
    return this.paused;
  }

  togglePaused(explicit?: boolean): boolean {
    this.paused = typeof explicit === "boolean" ? explicit : !this.paused;
    this.reconcilePollTimers();
    this.broadcastAllWorkspaces();
    return this.paused;
  }

  attachPaseo(paseo: PaseoApi): void {
    this.paseo = paseo;
  }

  stop(): void {
    this.stopped = true;
    for (const rec of this.records.values()) {
      if (rec.pollTimer) clearInterval(rec.pollTimer);
      if (rec.settleTimer) clearTimeout(rec.settleTimer);
      rec.pollTimer = undefined;
      rec.settleTimer = undefined;
    }
    this.subscribers.clear();
  }

  private ensureRecord(meta: TrackedAgentMeta): AgentRecord {
    const existing = this.records.get(meta.agentId);
    const configured = isConfigured(this.settings);
    if (existing) {
      existing.summary.workspaceId = meta.workspaceId ?? existing.summary.workspaceId;
      existing.summary.agentTitle = meta.title || existing.summary.agentTitle;
      existing.summary.provider = meta.provider || existing.summary.provider;
      existing.summary.agentStatus = meta.status || existing.summary.agentStatus;
      existing.lastActivityAt = Math.max(existing.lastActivityAt, meta.lastActivityAt);
      if (existing.summary.state === "unconfigured" && configured) {
        existing.summary.state = "idle";
        existing.summary.headline = defaultHeadline(meta.status, configured, this.settings.enabled, this.paused);
      }
      return existing;
    }

    const summary: AgentSummary = {
      agentId: meta.agentId,
      workspaceId: meta.workspaceId,
      agentTitle: meta.title || "未命名 Agent",
      provider: meta.provider || "unknown",
      agentStatus: meta.status || "idle",
      state: configured ? "idle" : "unconfigured",
      phase: "live",
      headline: defaultHeadline(meta.status, configured, this.settings.enabled, this.paused),
      currentAction: configured
        ? "等待 Agent 产生新步骤，或点击右上角手动刷新。"
        : "请在插件设置中填写 OpenAI 兼容 API 地址、Key 与模型名。",
      steps: [],
      takeaway: "",
      needsAttention: "",
      updatedAt: null,
      latencyMs: null,
      error: null,
      history: [],
    };
    const record: AgentRecord = {
      summary,
      lastFingerprint: null,
      inFlight: false,
      queuedPhase: null,
      queuedForce: false,
      pendingPermission: null,
      lastActivityAt: meta.lastActivityAt,
    };
    this.records.set(meta.agentId, record);
    return record;
  }

  async syncWorkspaceAgents(workspaceId: string, paseo: PaseoApi): Promise<void> {
    this.attachPaseo(paseo);
    try {
      const result = await paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: 100 },
      });
      const activeIds = new Set<string>();
      for (const entry of result.entries) {
        const agent = entry.agent;
        if (agent.background) continue;
        if (agent.workspaceId !== workspaceId) continue;
        activeIds.add(agent.id);
        const rec = this.ensureRecord({
          agentId: agent.id,
          workspaceId: agent.workspaceId ?? null,
          title: agent.title?.trim() || `${agent.provider} Agent`,
          provider: agent.provider,
          status: agent.status,
          lastActivityAt: Date.parse(agent.updatedAt || agent.lastUserMessageAt || "") || Date.now(),
        });
        if (agent.status === "running") {
          this.startPolling(agent.id);
          if (!rec.summary.updatedAt && !rec.inFlight && this.settings.enabled && !this.paused && isConfigured(this.settings)) {
            void this.summarizeAgent(agent.id, "live", false, paseo);
          }
        } else {
          this.stopPolling(agent.id);
        }
      }

      // Drop stale agents that disappeared from this workspace
      for (const [id, rec] of this.records.entries()) {
        if (rec.summary.workspaceId === workspaceId && !activeIds.has(id)) {
          this.cleanupAgent(id);
        }
      }
    } catch (error) {
      console.error("[paseo-live-zh] syncWorkspaceAgents failed:", error);
    }
  }

  async getWorkspacePayload(workspaceId: string, paseo: PaseoApi): Promise<WorkspaceSummariesPayload> {
    await this.syncWorkspaceAgents(workspaceId, paseo);
    return this.buildWorkspacePayload(workspaceId);
  }

  buildWorkspacePayload(workspaceId: string): WorkspaceSummariesPayload {
    const agents = Array.from(this.records.values())
      .filter((rec) => rec.summary.workspaceId === workspaceId)
      .sort((a, b) => {
        const aRunning = a.summary.agentStatus === "running" ? 1 : 0;
        const bRunning = b.summary.agentStatus === "running" ? 1 : 0;
        if (aRunning !== bRunning) return bRunning - aRunning;
        return b.lastActivityAt - a.lastActivityAt;
      })
      .map((rec) => ({ ...rec.summary, steps: [...rec.summary.steps], history: [...rec.summary.history] }));

    return {
      workspaceId,
      agents,
      paused: this.paused,
      configured: isConfigured(this.settings),
      enabled: this.settings.enabled,
      liveFollow: this.settings.liveFollow,
      model: this.settings.model,
    };
  }

  getAgentSummary(agentId: string): AgentSummary | null {
    const rec = this.records.get(agentId);
    return rec ? { ...rec.summary, steps: [...rec.summary.steps], history: [...rec.summary.history] } : null;
  }

  addWorkspaceSubscriber(subscriber: WorkspaceSubscriber): () => void {
    this.subscribers.add(subscriber);
    const remove = () => {
      this.subscribers.delete(subscriber);
    };
    subscriber.signal.addEventListener("abort", remove, { once: true });
    return remove;
  }

  private broadcastWorkspace(workspaceId: string | null): void {
    if (!workspaceId || this.stopped) return;
    const payload = this.buildWorkspacePayload(workspaceId);
    for (const sub of this.subscribers) {
      if (sub.workspaceId !== workspaceId || sub.signal.aborted) continue;
      void sub.push(payload).catch(() => undefined);
    }
  }

  private broadcastAllWorkspaces(): void {
    const ids = new Set<string>();
    for (const sub of this.subscribers) {
      if (!sub.signal.aborted) ids.add(sub.workspaceId);
    }
    for (const id of ids) {
      this.broadcastWorkspace(id);
    }
  }

  onTurnBefore(agent: { id: string; workspaceId: string | null; title: string | null; provider: string; background: boolean }, paseo: PaseoApi): void {
    if (agent.background || this.stopped) return;
    this.attachPaseo(paseo);
    const rec = this.ensureRecord({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      title: agent.title?.trim() || `${agent.provider} Agent`,
      provider: agent.provider,
      status: "running",
      lastActivityAt: Date.now(),
    });
    rec.summary.agentStatus = "running";
    rec.summary.error = null;
    if (rec.settleTimer) {
      clearTimeout(rec.settleTimer);
      rec.settleTimer = undefined;
    }
    this.startPolling(agent.id);
    this.broadcastWorkspace(rec.summary.workspaceId);

    // Kick an initial live check after 2.5s so the user sees progress quickly
    if (this.settings.enabled && this.settings.liveFollow && !this.paused && isConfigured(this.settings)) {
      rec.settleTimer = setTimeout(() => {
        rec.settleTimer = undefined;
        void this.summarizeAgent(agent.id, "live", false, paseo);
      }, 2_500);
    }
  }

  onTurnAfter(
    agent: { id: string; workspaceId: string | null; title: string | null; provider: string; background: boolean },
    outcomeKind: "completed" | "failed" | "canceled",
    paseo: PaseoApi,
  ): void {
    if (agent.background || this.stopped) return;
    this.attachPaseo(paseo);
    const rec = this.ensureRecord({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      title: agent.title?.trim() || `${agent.provider} Agent`,
      provider: agent.provider,
      status: outcomeKind === "failed" ? "error" : "idle",
      lastActivityAt: Date.now(),
    });
    rec.summary.agentStatus = outcomeKind === "failed" ? "error" : "idle";
    rec.pendingPermission = null;
    this.stopPolling(agent.id);
    if (rec.settleTimer) {
      clearTimeout(rec.settleTimer);
      rec.settleTimer = undefined;
    }
    this.broadcastWorkspace(rec.summary.workspaceId);

    if (
      this.settings.enabled &&
      this.settings.summarizeOnTurnEnd &&
      !this.paused &&
      isConfigured(this.settings)
    ) {
      rec.settleTimer = setTimeout(() => {
        rec.settleTimer = undefined;
        void this.summarizeAgent(agent.id, "turn_end", true, paseo);
      }, 450);
    }
  }

  onPermissionBefore(
    agent: { id: string; workspaceId: string | null; title: string | null; provider: string; background: boolean },
    request: { name: string; title?: string; description?: string },
    paseo: PaseoApi,
  ): void {
    if (agent.background || this.stopped) return;
    this.attachPaseo(paseo);
    const rec = this.ensureRecord({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      title: agent.title?.trim() || `${agent.provider} Agent`,
      provider: agent.provider,
      status: "running",
      lastActivityAt: Date.now(),
    });
    const desc = [request.title, request.name, request.description].filter(Boolean).join(" - ").slice(0, 180);
    rec.pendingPermission = desc || request.name;
    rec.summary.needsAttention = `等待你批准操作：${rec.pendingPermission}`;
    rec.summary.headline = "等待你确认权限";
    this.broadcastWorkspace(rec.summary.workspaceId);

    if (this.settings.enabled && !this.paused && isConfigured(this.settings)) {
      void this.summarizeAgent(agent.id, "live", true, paseo);
    }
  }

  onPermissionAfter(agentId: string): void {
    const rec = this.records.get(agentId);
    if (!rec) return;
    rec.pendingPermission = null;
    if (rec.summary.needsAttention.startsWith("等待你批准操作")) {
      rec.summary.needsAttention = "";
    }
    this.broadcastWorkspace(rec.summary.workspaceId);
  }

  cleanupAgent(agentId: string): void {
    const rec = this.records.get(agentId);
    if (!rec) return;
    const workspaceId = rec.summary.workspaceId;
    this.stopPolling(agentId);
    if (rec.settleTimer) clearTimeout(rec.settleTimer);
    this.records.delete(agentId);
    this.broadcastWorkspace(workspaceId);
  }

  private startPolling(agentId: string): void {
    const rec = this.records.get(agentId);
    if (!rec || this.stopped) return;
    if (!this.settings.enabled || !this.settings.liveFollow || this.paused) {
      this.stopPolling(agentId);
      return;
    }
    if (rec.pollTimer) return;
    const intervalMs = Math.max(3, Math.min(60, this.settings.pollIntervalSec)) * 1000;
    rec.pollTimer = setInterval(() => {
      if (this.stopped || this.paused || !this.settings.enabled || !this.settings.liveFollow) {
        this.stopPolling(agentId);
        return;
      }
      if (!this.paseo || !isConfigured(this.settings)) return;
      void this.summarizeAgent(agentId, "live", false, this.paseo);
    }, intervalMs);
  }

  private stopPolling(agentId: string): void {
    const rec = this.records.get(agentId);
    if (!rec?.pollTimer) return;
    clearInterval(rec.pollTimer);
    rec.pollTimer = undefined;
  }

  private reconcilePollTimers(): void {
    for (const [agentId, rec] of this.records.entries()) {
      this.stopPolling(agentId);
      if (rec.summary.agentStatus === "running" && this.settings.enabled && this.settings.liveFollow && !this.paused) {
        this.startPolling(agentId);
      }
    }
  }

  async refreshAgent(agentId: string, force: boolean, paseo: PaseoApi): Promise<AgentSummary> {
    this.attachPaseo(paseo);
    const refreshed = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const agent = refreshed?.agent;
    if (agent) {
      this.ensureRecord({
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        title: agent.title?.trim() || `${agent.provider} Agent`,
        provider: agent.provider,
        status: agent.status,
        lastActivityAt: Date.parse(agent.updatedAt || agent.lastUserMessageAt || "") || Date.now(),
      });
    } else if (!this.records.has(agentId)) {
      this.ensureRecord({
        agentId,
        workspaceId: null,
        title: "Agent",
        provider: "unknown",
        status: "idle",
        lastActivityAt: Date.now(),
      });
    }

    await this.summarizeAgent(agentId, "manual", force, paseo);
    return this.getAgentSummary(agentId)!;
  }

  private async summarizeAgent(
    agentId: string,
    phase: "live" | "turn_end" | "manual",
    force: boolean,
    paseo: PaseoApi,
  ): Promise<void> {
    if (this.stopped) return;
    const rec = this.records.get(agentId);
    if (!rec) return;

    if (!isConfigured(this.settings)) {
      rec.summary.state = "unconfigured";
      rec.summary.headline = "请先配置 API";
      rec.summary.currentAction = "打开插件设置填写 OpenAI 兼容 API Key 与模型名即可启用。";
      this.broadcastWorkspace(rec.summary.workspaceId);
      return;
    }

    if (rec.inFlight) {
      // Merge queued request; turn_end/manual takes precedence over live.
      if (!rec.queuedPhase || phase !== "live") {
        rec.queuedPhase = phase;
      }
      rec.queuedForce = rec.queuedForce || force;
      return;
    }

    rec.inFlight = true;
    try {
      // Refresh status so we stop polling if agent already finished
      const refreshed = await paseo.agents.ref(agentId).refresh().catch(() => null);
      if (refreshed?.agent) {
        rec.summary.agentStatus = refreshed.agent.status;
        rec.summary.agentTitle = refreshed.agent.title?.trim() || `${refreshed.agent.provider} Agent`;
        rec.summary.provider = refreshed.agent.provider;
        rec.summary.workspaceId = refreshed.agent.workspaceId ?? rec.summary.workspaceId;
        rec.lastActivityAt = Date.parse(refreshed.agent.updatedAt || refreshed.agent.lastUserMessageAt || "") || Date.now();
        if (refreshed.agent.status !== "running") {
          this.stopPolling(agentId);
        }
      }

      const page = await paseo.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", limit: 35 });
      const items = page.entries.map((entry) => entry.item);
      const extracted = extractRecentTimeline(items, this.settings.maxSteps);

      if (!extracted) {
        rec.summary.state = "idle";
        rec.summary.headline = "暂无对话记录";
        rec.summary.currentAction = "Agent 还没有产生输出步骤。";
        this.broadcastWorkspace(rec.summary.workspaceId);
        return;
      }

      if (!force && extracted.fingerprint === rec.lastFingerprint && rec.summary.state === "ready") {
        return;
      }

      if (!force && this.settings.skipPureChinese && extracted.mostlyChinese && !rec.pendingPermission) {
        rec.lastFingerprint = extracted.fingerprint;
        return;
      }

      rec.summary.state = "summarizing";
      rec.summary.error = null;
      this.broadcastWorkspace(rec.summary.workspaceId);

      const result = await summarizeTimelineWithLlm({
        settings: this.settings,
        agentId,
        agentTitle: rec.summary.agentTitle,
        provider: rec.summary.provider,
        agentStatus: rec.summary.agentStatus,
        phase,
        digestText: extracted.digestText,
        permissionHint: rec.pendingPermission ?? undefined,
      });

      const nowIso = new Date().toISOString();
      rec.lastFingerprint = extracted.fingerprint;
      rec.summary.state = "ready";
      rec.summary.phase = phase;
      rec.summary.headline = result.headline;
      rec.summary.currentAction = result.currentAction;
      rec.summary.steps = result.steps;
      rec.summary.takeaway = result.takeaway;
      rec.summary.needsAttention = result.needsAttention;
      rec.summary.updatedAt = nowIso;
      rec.summary.latencyMs = result.latencyMs;
      rec.summary.error = null;

      if (phase === "turn_end" || phase === "manual") {
        const lastHist = rec.summary.history[0];
        if (!lastHist || lastHist.headline !== result.headline || lastHist.takeaway !== result.takeaway) {
          const entry: SummaryHistoryEntry = {
            headline: result.headline,
            takeaway: result.takeaway,
            updatedAt: nowIso,
            phase,
          };
          rec.summary.history = [entry, ...rec.summary.history].slice(0, MAX_HISTORY);
        }
      }

      this.broadcastWorkspace(rec.summary.workspaceId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[paseo-live-zh] summarizeAgent(${agentId}) failed:`, msg);
      rec.summary.state = "error";
      rec.summary.error = msg;
      if (!rec.summary.updatedAt) {
        rec.summary.headline = "解说请求失败";
      }
      this.broadcastWorkspace(rec.summary.workspaceId);
    } finally {
      rec.inFlight = false;
      const nextPhase = rec.queuedPhase;
      const nextForce = rec.queuedForce;
      rec.queuedPhase = null;
      rec.queuedForce = false;
      if (nextPhase && !this.stopped) {
        void this.summarizeAgent(agentId, nextPhase, nextForce, paseo);
      }
    }
  }
}
