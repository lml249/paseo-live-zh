import type { SummaryStep, SummaryStepIcon, SummaryStepStatus } from "../shared/contracts";
import type { LiveZhSettingsValues } from "../shared/settings";

export interface LlmSummaryResult {
  headline: string;
  currentAction: string;
  steps: SummaryStep[];
  takeaway: string;
  needsAttention: string;
  latencyMs: number;
}

const VALID_ICONS = new Set<SummaryStepIcon>([
  "read",
  "edit",
  "shell",
  "search",
  "think",
  "reply",
  "warn",
  "other",
]);

const VALID_STATUS = new Set<SummaryStepStatus>(["running", "done", "failed"]);
const unsupportedThinkingHosts = new Set<string>();

function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function buildHeaders(baseUrl: string, apiKey: string, sessionKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  if (/opencode\.ai/i.test(baseUrl)) {
    headers["x-opencode-session"] = sessionKey;
    headers["x-opencode-client"] = "paseo-live-zh";
  }
  return headers;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function parseSteps(rawSteps: unknown): SummaryStep[] {
  if (!Array.isArray(rawSteps)) return [];
  const result: SummaryStep[] = [];
  for (const entry of rawSteps.slice(0, 10)) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const text = asString(obj.text);
    if (!text) continue;
    const rawIcon = asString(obj.icon, "other") as SummaryStepIcon;
    const icon: SummaryStepIcon = VALID_ICONS.has(rawIcon) ? rawIcon : "other";
    const rawStatus = asString(obj.status) as SummaryStepStatus;
    const status = VALID_STATUS.has(rawStatus) ? rawStatus : undefined;
    result.push(status ? { icon, text, status } : { icon, text });
  }
  return result;
}

function clipHeadline(text: string): string {
  const cleaned = text.replace(/[。！!？?.,，\s]+$/, "").trim();
  return cleaned.length <= 24 ? cleaned : `${cleaned.slice(0, 23)}…`;
}

async function postChatCompletion(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  disableThinking: boolean;
  sessionKey: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<{ content: string; latencyMs: number }> {
  const endpoint = normalizeEndpoint(options.baseUrl);
  const headers = buildHeaders(options.baseUrl, options.apiKey, options.sessionKey);
  const hostKey = endpoint.toLowerCase();

  const runRequest = async (includeThinkingFlag: boolean) => {
    const body: Record<string, unknown> = {
      model: options.model.trim(),
      temperature: 0.2,
      max_tokens: options.maxTokens,
      messages: [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.userPrompt },
      ],
    };
    if (includeThinkingFlag) body.thinking = { type: "disabled" };

    const timeoutSignal = AbortSignal.timeout(25_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const started = Date.now();
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal });
    const latencyMs = Date.now() - started;
    const rawText = await response.text();
    return { response, rawText, latencyMs };
  };

  const wantThinkingOff = options.disableThinking && !unsupportedThinkingHosts.has(hostKey);
  let attempt = await runRequest(wantThinkingOff);

  if (
    !attempt.response.ok &&
    attempt.response.status === 400 &&
    wantThinkingOff &&
    /thinking|unknown|unrecognized|extra|invalid/i.test(attempt.rawText)
  ) {
    unsupportedThinkingHosts.add(hostKey);
    attempt = await runRequest(false);
  }

  if (!attempt.response.ok) {
    let detail = attempt.rawText.slice(0, 260);
    try {
      const errJson = JSON.parse(attempt.rawText) as { error?: { message?: string } | string };
      if (typeof errJson.error === "string") detail = errJson.error;
      else if (errJson.error?.message) detail = errJson.error.message;
    } catch {
      // keep snippet
    }
    throw new Error(`HTTP ${attempt.response.status}: ${detail}`);
  }

  const parsed = JSON.parse(attempt.rawText) as {
    choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
  };
  const msg = parsed.choices?.[0]?.message;
  const content = (msg?.content ?? "").trim() || (msg?.reasoning_content ?? "").trim();
  if (!content) throw new Error("模型返回了空内容");
  return { content, latencyMs: attempt.latencyMs };
}

export async function summarizeTimelineWithLlm(options: {
  settings: LiveZhSettingsValues;
  agentId: string;
  agentTitle: string;
  provider: string;
  agentStatus: string;
  phase: "live" | "turn_end" | "manual";
  digestText: string;
  permissionHint?: string;
  signal?: AbortSignal;
}): Promise<LlmSummaryResult> {
  const { settings } = options;
  const extraRule = settings.customPrompt.trim() ? `\n额外要求：${settings.customPrompt.trim()}` : "";

  const systemPrompt = [
    "你是编程 Agent 的「实时中文解说员」，帮助不擅长英文的用户一眼看懂 AI 编程助手刚才和正在做什么。",
    "请严格只输出一个合法 JSON 对象，不要包含 markdown 代码块或多余文字。",
    'JSON 格式：{"headline":"<=18汉字状态标题，末尾无标点","currentAction":"1句大白话说明此刻在做/刚做完什么","steps":[{"icon":"read|edit|shell|search|think|reply|warn|other","text":"通俗中文描述该步操作","status":"running|done|failed"}],"takeaway":"1-2句阶段进展或最终结论","needsAttention":"报错/权限确认/需用户决策时1句提醒，否则空字符串"}',
    "规则：steps 列出最近 3~6 个关键步骤（从旧到新），英文自然意译为简体中文，文件名和命令可保留原文，禁止编造。",
    extraRule,
  ]
    .filter(Boolean)
    .join("\n");

  const phaseHint =
    options.phase === "live"
      ? "阶段：运行中实时追更"
      : options.phase === "turn_end"
        ? "阶段：本轮执行结束，请给出完整结论"
        : "阶段：用户手动刷新";

  const userPrompt = [
    `Agent: ${options.agentTitle} (provider=${options.provider}, status=${options.agentStatus})`,
    phaseHint,
    options.permissionHint ? `PENDING_PERMISSION: ${options.permissionHint}` : "",
    "最近执行记录（从旧到新）：",
    options.digestText,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { content, latencyMs } = await postChatCompletion({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    disableThinking: settings.disableThinking,
    sessionKey: `paseo-live-zh-${options.agentId}`,
    systemPrompt,
    userPrompt,
    maxTokens: 520,
    signal: options.signal,
  });

  const obj = extractJsonObject(content);
  if (!obj) {
    const plain = content.replace(/\s+/g, " ").trim();
    return {
      headline: clipHeadline(plain.slice(0, 20) || "已生成中文总结"),
      currentAction: plain.slice(0, 220),
      steps: [],
      takeaway: plain.slice(0, 320),
      needsAttention: options.permissionHint ? `等待你确认：${options.permissionHint}` : "",
      latencyMs,
    };
  }

  const headline = clipHeadline(asString(obj.headline, "正在执行任务"));
  const currentAction = asString(obj.currentAction, headline);
  return {
    headline,
    currentAction,
    steps: parseSteps(obj.steps),
    takeaway: asString(obj.takeaway, currentAction),
    needsAttention: asString(obj.needsAttention, options.permissionHint ? `等待你确认：${options.permissionHint}` : ""),
    latencyMs,
  };
}

export async function testLlmConnection(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  disableThinking?: boolean;
}): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const started = Date.now();
  try {
    const { content, latencyMs } = await postChatCompletion({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      disableThinking: options.disableThinking ?? true,
      sessionKey: "paseo-live-zh-connection-test",
      systemPrompt: '你是连通性测试助手，只回复 JSON：{"ok":true,"reply":"连接正常"}',
      userPrompt: "ping",
      maxTokens: 60,
    });
    const obj = extractJsonObject(content);
    const reply = obj && typeof obj.reply === "string" ? obj.reply : content.slice(0, 60);
    return { ok: true, latencyMs, message: `连接成功（${latencyMs}ms）：${reply}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, latencyMs: Date.now() - started, message: `连接失败：${msg}` };
  }
}
