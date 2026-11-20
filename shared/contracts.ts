import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const SummaryStepIconSchema = z.enum([
  "read",
  "edit",
  "shell",
  "search",
  "think",
  "reply",
  "warn",
  "other",
]);
export type SummaryStepIcon = z.infer<typeof SummaryStepIconSchema>;

export const SummaryStepStatusSchema = z.enum(["running", "done", "failed"]);
export type SummaryStepStatus = z.infer<typeof SummaryStepStatusSchema>;

export const SummaryStepSchema = z.object({
  icon: SummaryStepIconSchema,
  text: z.string(),
  status: SummaryStepStatusSchema.optional(),
});
export type SummaryStep = z.infer<typeof SummaryStepSchema>;

export const SummaryHistoryEntrySchema = z.object({
  headline: z.string(),
  takeaway: z.string(),
  updatedAt: z.string(),
  phase: z.enum(["live", "turn_end", "manual"]),
});
export type SummaryHistoryEntry = z.infer<typeof SummaryHistoryEntrySchema>;

export const SummaryStateSchema = z.enum([
  "idle",
  "summarizing",
  "ready",
  "error",
  "paused",
  "unconfigured",
]);
export type SummaryState = z.infer<typeof SummaryStateSchema>;

export const AgentSummarySchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  agentTitle: z.string(),
  provider: z.string(),
  agentStatus: z.string(),
  state: SummaryStateSchema,
  phase: z.enum(["live", "turn_end", "manual"]),
  headline: z.string(),
  currentAction: z.string(),
  steps: z.array(SummaryStepSchema),
  takeaway: z.string(),
  needsAttention: z.string(),
  updatedAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
  history: z.array(SummaryHistoryEntrySchema),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const WorkspaceSummariesPayloadSchema = z.object({
  workspaceId: z.string(),
  agents: z.array(AgentSummarySchema),
  paused: z.boolean(),
  configured: z.boolean(),
  enabled: z.boolean(),
  liveFollow: z.boolean(),
  model: z.string(),
});
export type WorkspaceSummariesPayload = z.infer<typeof WorkspaceSummariesPayloadSchema>;

export const listWorkspaceSummariesRpc = defineRpc({
  name: "live_zh.list_workspace",
  input: z.object({
    workspaceId: z.string(),
  }),
  output: WorkspaceSummariesPayloadSchema,
});

export const getAgentSummaryRpc = defineRpc({
  name: "live_zh.get_agent",
  input: z.object({
    agentId: z.string(),
  }),
  output: AgentSummarySchema.nullable(),
});

export const refreshAgentSummaryRpc = defineRpc({
  name: "live_zh.refresh_agent",
  input: z.object({
    agentId: z.string(),
    force: z.boolean().optional(),
  }),
  output: AgentSummarySchema,
});

export const togglePausedRpc = defineRpc({
  name: "live_zh.toggle_paused",
  input: z.object({
    paused: z.boolean().optional(),
  }),
  output: z.object({
    paused: z.boolean(),
  }),
});

export const testConnectionRpc = defineRpc({
  name: "live_zh.test_connection",
  input: z.object({
    baseUrl: z.string(),
    apiKey: z.string(),
    model: z.string(),
    disableThinking: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    latencyMs: z.number(),
    message: z.string(),
  }),
});

export const watchWorkspaceSummariesSub = defineSubscription({
  name: "live_zh.watch_workspace",
  input: z.object({
    workspaceId: z.string(),
  }),
  event: WorkspaceSummariesPayloadSchema,
});
