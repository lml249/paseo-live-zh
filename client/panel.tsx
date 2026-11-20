import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type AgentSummary,
  type SummaryStepIcon,
  type WorkspaceSummariesPayload,
  listWorkspaceSummariesRpc,
  refreshAgentSummaryRpc,
  togglePausedRpc,
  watchWorkspaceSummariesSub,
} from "../shared/contracts";
import { getFocusedAgent, subscribeFocusedAgent } from "./pills";

interface LiveZhPanelProps extends PluginWorkspacePanelProps {
  openSettings: () => void;
}

function iconForStep(kind: SummaryStepIcon): string {
  switch (kind) {
    case "read":
      return "FileText";
    case "edit":
      return "Pencil";
    case "shell":
      return "Terminal";
    case "search":
      return "Search";
    case "think":
      return "Brain";
    case "reply":
      return "MessageSquare";
    case "warn":
      return "AlertTriangle";
    default:
      return "Sparkles";
  }
}

function formatRelativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return "尚未更新";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "刚刚";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 5) return "刚刚";
  if (diffSec < 60) return `${diffSec}秒前`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}分钟前`;
  return `${Math.floor(mins / 60)}小时前`;
}

function statusBadge(summary: AgentSummary): {
  text: string;
  tone: "accent" | "success" | "warning" | "danger" | "muted";
} {
  if (summary.needsAttention) return { text: "需要关注", tone: "warning" };
  if (summary.state === "summarizing") return { text: "总结中…", tone: "accent" };
  if (summary.state === "error") return { text: "请求失败", tone: "danger" };
  if (summary.agentStatus === "running") return { text: "运行追更中", tone: "accent" };
  if (summary.agentStatus === "error") return { text: "Agent 报错", tone: "danger" };
  if (summary.state === "ready") return { text: "本轮已完成", tone: "success" };
  return { text: "待机", tone: "muted" };
}

export function LiveZhPanel({ workspaceId, theme, openSettings }: LiveZhPanelProps) {
  const { colors } = theme;
  const toast = useToast();
  const listWorkspace = useRpc(listWorkspaceSummariesRpc);
  const refreshAgent = useRpc(refreshAgentSummaryRpc);
  const togglePaused = useRpc(togglePausedRpc);

  const [payload, setPayload] = useState<WorkspaceSummariesPayload | null>(null);
  useSubscription(watchWorkspaceSummariesSub, { workspaceId }, (event) => {
    setPayload(event);
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const focusedFromPill = useSyncExternalStore(subscribeFocusedAgent, getFocusedAgent);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    void listWorkspace({ workspaceId })
      .then((res) => {
        if (active) setPayload((prev) => prev ?? res);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [workspaceId, listWorkspace]);

  const agents = payload?.agents ?? [];

  useEffect(() => {
    if (focusedFromPill && agents.some((a) => a.agentId === focusedFromPill)) {
      setSelectedAgentId(focusedFromPill);
    }
  }, [focusedFromPill, agents]);

  const activeAgent = useMemo(() => {
    if (agents.length === 0) return null;
    if (selectedAgentId) {
      const found = agents.find((a) => a.agentId === selectedAgentId);
      if (found) return found;
    }
    return agents.find((a) => a.agentStatus === "running") ?? agents[0];
  }, [agents, selectedAgentId]);

  const handleRefresh = async () => {
    if (!activeAgent || refreshing) return;
    setRefreshing(true);
    try {
      await refreshAgent({ agentId: activeAgent.agentId, force: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  };

  const handleTogglePause = async () => {
    try {
      const res = await togglePaused({});
      toast.show(res.paused ? "已暂停实时中文追更" : "已恢复实时中文追更", { variant: "info" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换暂停状态失败");
    }
  };

  const handleCopySummary = async () => {
    if (!activeAgent) return;
    const lines = [
      `【${activeAgent.headline}】`,
      activeAgent.currentAction,
      ...activeAgent.steps.map((s, i) => `${i + 1}. ${s.text}`),
      activeAgent.takeaway ? `结论：${activeAgent.takeaway}` : "",
      activeAgent.needsAttention ? `需关注：${activeAgent.needsAttention}` : "",
    ].filter(Boolean);
    try {
      await copyText(lines.join("\n"));
      toast.show("已复制中文摘要", { variant: "success" });
    } catch {
      toast.error("复制失败");
    }
  };

  const toneColor = (tone: "accent" | "success" | "warning" | "danger" | "muted") => {
    if (tone === "accent") return colors.accent;
    if (tone === "success") return colors.statusSuccess;
    if (tone === "warning") return colors.statusWarning;
    if (tone === "danger") return colors.statusDanger;
    return colors.foregroundMuted;
  };

  const cardStyle = {
    padding: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface1,
    gap: 8,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.surface1,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <Icon name="Languages" size={16} color={colors.accent} />
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
            实时中文解说
          </Text>
          {payload?.paused ? (
            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.surface2 }}>
              <Text style={{ color: colors.statusWarning, fontSize: 11, fontWeight: "500" }}>已暂停</Text>
            </View>
          ) : payload?.liveFollow ? (
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: payload.configured && payload.enabled ? colors.statusSuccess : colors.statusWarning,
              }}
            />
          ) : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="立即刷新中文总结"
            onPress={() => void handleRefresh()}
            disabled={!activeAgent || refreshing}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 5,
              borderRadius: 6,
              backgroundColor: colors.surface2,
              opacity: !activeAgent || refreshing ? 0.5 : 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Icon name="RefreshCw" size={13} color={colors.foreground} />
            <Text style={{ color: colors.foreground, fontSize: 12 }}>{refreshing ? "更新中" : "刷新"}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={payload?.paused ? "恢复追更" : "暂停追更"}
            onPress={() => void handleTogglePause()}
            style={{ padding: 6, borderRadius: 6, backgroundColor: colors.surface2 }}
          >
            <Icon
              name={payload?.paused ? "Play" : "Pause"}
              size={13}
              color={payload?.paused ? colors.statusWarning : colors.foregroundMuted}
            />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开设置"
            onPress={openSettings}
            style={{ padding: 6, borderRadius: 6, backgroundColor: colors.surface2 }}
          >
            <Icon name="Settings" size={13} color={colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>

      {payload && (!payload.configured || !payload.enabled) ? (
        <View style={{ ...cardStyle, margin: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
            {!payload.enabled ? "实时中文解说已关闭" : "还没有配置兼容 API"}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
            {!payload.enabled
              ? "你可以在插件设置中重新开启自动追更。"
              : "请打开插件设置填写 OpenAI 兼容 API 地址、API Key 和模型名。"}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={openSettings}
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: colors.accent,
            }}
          >
            <Text style={{ color: colors.accentForeground, fontSize: 12, fontWeight: "600" }}>前往设置</Text>
          </Pressable>
        </View>
      ) : null}

      {agents.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 }}>
          {agents.map((agent) => {
            const selected = activeAgent?.agentId === agent.agentId;
            return (
              <Pressable
                key={agent.agentId}
                accessibilityRole="button"
                onPress={() => setSelectedAgentId(agent.agentId)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: selected ? colors.accent : colors.border,
                  backgroundColor: selected ? colors.surface2 : colors.surface1,
                  maxWidth: 190,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: agent.needsAttention
                      ? colors.statusWarning
                      : agent.agentStatus === "running"
                        ? colors.statusSuccess
                        : colors.foregroundMuted,
                  }}
                />
                <Text
                  style={{
                    color: selected ? colors.foreground : colors.foregroundMuted,
                    fontSize: 12,
                    fontWeight: selected ? "600" : "400",
                  }}
                  numberOfLines={1}
                >
                  {agent.agentTitle}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 28 }}>
        {!activeAgent ? (
          <View style={{ ...cardStyle, padding: 20, alignItems: "center" }}>
            <Icon name="Languages" size={24} color={colors.foregroundMuted} />
            <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>当前工作区暂无活跃 Agent</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, textAlign: "center", lineHeight: 18 }}>
              在左侧发起对话后，这里会自动实时翻译并总结 Agent 最近几步的工作内容。
            </Text>
          </View>
        ) : (
          <>
            {activeAgent.needsAttention ? (
              <View style={{ ...cardStyle, borderColor: colors.statusWarning }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Icon name="AlertTriangle" size={14} color={colors.statusWarning} />
                  <Text style={{ color: colors.statusWarning, fontSize: 12, fontWeight: "600" }}>需要你关注 / 确认</Text>
                </View>
                <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{activeAgent.needsAttention}</Text>
              </View>
            ) : null}

            <View style={cardStyle}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
                  <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.surface2 }}>
                    <Text style={{ color: toneColor(statusBadge(activeAgent).tone), fontSize: 11, fontWeight: "600" }}>
                      {statusBadge(activeAgent).text}
                    </Text>
                  </View>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                    {activeAgent.provider}
                  </Text>
                </View>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {formatRelativeTime(activeAgent.updatedAt, nowMs)}
                  {activeAgent.latencyMs ? ` · ${(activeAgent.latencyMs / 1000).toFixed(1)}s` : ""}
                </Text>
              </View>

              <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700", lineHeight: 22 }}>
                {activeAgent.headline}
              </Text>

              {activeAgent.currentAction ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>
                  {activeAgent.currentAction}
                </Text>
              ) : null}

              {activeAgent.error ? (
                <View style={{ padding: 8, borderRadius: 6, backgroundColor: colors.surface2 }}>
                  <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17 }}>错误：{activeAgent.error}</Text>
                </View>
              ) : null}
            </View>

            <View style={{ ...cardStyle, gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>最近几步（中文大白话）</Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {activeAgent.steps.length > 0 ? `共 ${activeAgent.steps.length} 步` : "暂无"}
                </Text>
              </View>

              {activeAgent.steps.length === 0 ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
                  还没有可展示的步骤。点击右上角「刷新」可立即分析当前对话。
                </Text>
              ) : (
                <View style={{ gap: 9 }}>
                  {activeAgent.steps.map((step, idx) => {
                    const stepColor =
                      step.status === "failed"
                        ? colors.statusDanger
                        : step.status === "running"
                          ? colors.accent
                          : colors.statusSuccess;
                    return (
                      <View key={`${idx}-${step.text.slice(0, 16)}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                        <View
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 6,
                            backgroundColor: colors.surface2,
                            alignItems: "center",
                            justifyContent: "center",
                            marginTop: 1,
                          }}
                        >
                          <Icon name={iconForStep(step.icon)} size={12} color={stepColor} />
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{step.text}</Text>
                          {step.status === "running" ? (
                            <Text style={{ color: colors.accent, fontSize: 11 }}>正在执行…</Text>
                          ) : step.status === "failed" ? (
                            <Text style={{ color: colors.statusDanger, fontSize: 11 }}>该步出错</Text>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>

            {activeAgent.takeaway ? (
              <View style={cardStyle}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>阶段进展 / 结论</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void handleCopySummary()}
                    style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2, paddingHorizontal: 6 }}
                  >
                    <Icon name="Copy" size={12} color={colors.foregroundMuted} />
                    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>复制</Text>
                  </Pressable>
                </View>
                <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}>{activeAgent.takeaway}</Text>
              </View>
            ) : null}

            {activeAgent.history.length > 0 ? (
              <View style={cardStyle}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowHistory((v) => !v)}
                  style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
                >
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
                    历史回合小结（最近 {activeAgent.history.length} 条）
                  </Text>
                  <Icon name={showHistory ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
                </Pressable>
                {showHistory ? (
                  <View style={{ gap: 10, marginTop: 2 }}>
                    {activeAgent.history.map((item, idx) => (
                      <View
                        key={`${item.updatedAt}-${idx}`}
                        style={{
                          paddingTop: idx === 0 ? 0 : 8,
                          borderTopWidth: idx === 0 ? 0 : 1,
                          borderTopColor: colors.border,
                          gap: 3,
                        }}
                      >
                        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}>
                            {item.headline}
                          </Text>
                          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                            {formatRelativeTime(item.updatedAt, nowMs)}
                          </Text>
                        </View>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{item.takeaway}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {payload?.model ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 11, textAlign: "center", marginTop: 4 }}>
                当前解说模型：{payload.model}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
