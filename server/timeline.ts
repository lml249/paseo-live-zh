import { createHash } from "node:crypto";
import type { AgentTimelineItem, ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

export interface ExtractedTimeline {
  fingerprint: string;
  digestText: string;
  recentItemCount: number;
  hasRunningTool: boolean;
  mostlyChinese: boolean;
}

function clip(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function clipTail(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `…${normalized.slice(-(maxChars - 1))}`;
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolDetail(name: string, detail: ToolCallDetail): string {
  switch (detail.type) {
    case "shell": {
      const exit = detail.exitCode !== undefined && detail.exitCode !== null ? ` (exit=${detail.exitCode})` : "";
      const out = detail.output ? ` -> ${clipTail(detail.output, 180)}` : "";
      return `shell: ${clip(detail.command, 160)}${exit}${out}`;
    }
    case "read":
      return `read: ${detail.filePath}`;
    case "edit":
      return `edit: ${detail.filePath}${detail.unifiedDiff ? ` (${clip(detail.unifiedDiff, 120)})` : ""}`;
    case "write":
      return `write: ${detail.filePath}`;
    case "search": {
      const hits = typeof detail.numMatches === "number" ? ` (${detail.numMatches} matches)` : "";
      return `${detail.toolName ?? "search"}: ${clip(detail.query, 120)}${hits}`;
    }
    case "fetch":
      return `fetch: ${clip(detail.url, 120)}${detail.code ? ` (HTTP ${detail.code})` : ""}`;
    case "sub_agent":
      return `sub_agent(${detail.subAgentType ?? "helper"}): ${clip(detail.description ?? detail.log ?? "", 160)}`;
    case "plan":
      return `plan: ${clip(detail.text, 200)}`;
    case "worktree_setup":
      return `worktree_setup: branch=${detail.branchName}`;
    case "plain_text":
      return `${detail.label ?? name}: ${clip(detail.text ?? "", 160)}`;
    case "unknown": {
      const inputStr = detail.input ? clip(safeJson(detail.input), 120) : "";
      const outStr = detail.output ? clip(safeJson(detail.output), 120) : "";
      return `${name}${inputStr ? `(${inputStr})` : ""}${outStr ? ` -> ${outStr}` : ""}`;
    }
    default:
      return name;
  }
}

function formatToolItem(item: ToolCallTimelineItem): string {
  const statusTag =
    item.status === "running"
      ? "[RUNNING]"
      : item.status === "failed"
        ? "[FAILED]"
        : item.status === "canceled"
          ? "[CANCELED]"
          : "[DONE]";
  const errStr = item.status === "failed" && item.error ? ` ERROR: ${clip(safeJson(item.error), 140)}` : "";
  return `TOOL ${statusTag} ${formatToolDetail(item.name, item.detail)}${errStr}`;
}

export function isMostlyChinese(text: string): boolean {
  const stripped = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (stripped.length < 16) return false;
  const cjk = (stripped.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (stripped.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk >= latin * 2;
}

export function extractRecentTimeline(
  items: readonly AgentTimelineItem[],
  maxSteps: number,
): ExtractedTimeline | null {
  const meaningful = items.filter((item) => item.type !== "plugin" && item.type !== "compaction");
  if (meaningful.length === 0) return null;

  let lastUserIdx = -1;
  for (let i = meaningful.length - 1; i >= 0; i--) {
    if (meaningful[i].type === "user_message") {
      lastUserIdx = i;
      break;
    }
  }

  const lines: string[] = [];
  if (lastUserIdx >= 0) {
    const userItem = meaningful[lastUserIdx];
    if (userItem.type === "user_message") {
      lines.push(`USER_GOAL: ${clip(userItem.text, 300)}`);
    }
  }

  const startAfterUser = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const currentTurnItems = meaningful.slice(startAfterUser);
  const windowSize = Math.max(4, Math.min(maxSteps * 2, 24));
  const recent = (currentTurnItems.length > 0 ? currentTurnItems : meaningful).slice(-windowSize);

  let hasRunningTool = false;
  let assistantAndReasoningText = "";

  for (const item of recent) {
    switch (item.type) {
      case "user_message":
        lines.push(`USER: ${clip(item.text, 240)}`);
        break;
      case "assistant_message":
        lines.push(`ASSISTANT: ${clipTail(item.text, 650)}`);
        assistantAndReasoningText += " " + item.text;
        break;
      case "reasoning":
        lines.push(`THINKING: ${clipTail(item.text, 320)}`);
        assistantAndReasoningText += " " + item.text;
        break;
      case "tool_call":
        if (item.status === "running") hasRunningTool = true;
        lines.push(formatToolItem(item));
        break;
      case "todo": {
        const todoSummary = item.items
          .slice(0, 6)
          .map((t) => `${t.completed ? "[x]" : "[ ]"} ${clip(t.text, 60)}`)
          .join("; ");
        if (todoSummary) lines.push(`TODO: ${todoSummary}`);
        break;
      }
      case "error":
        lines.push(`ERROR: ${clip(item.message, 260)}`);
        break;
      case "notification":
        lines.push(`NOTICE(${item.level}): ${clip(item.message, 200)}`);
        break;
      default:
        break;
    }
  }

  if (lines.length === 0) return null;

  const digestText = lines.join("\n");
  const fingerprint = createHash("sha1").update(digestText).digest("hex").slice(0, 16);

  return {
    fingerprint,
    digestText,
    recentItemCount: recent.length,
    hasRunningTool,
    mostlyChinese:
      !hasRunningTool &&
      isMostlyChinese(assistantAndReasoningText) &&
      recent.every((i) => i.type !== "tool_call"),
  };
}
