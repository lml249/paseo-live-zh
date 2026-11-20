import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_BASE_URL = "https://opencode.ai/inference/go/v1";
export const DEFAULT_MODEL = "deepseek-v4.1-flash";

export const API_PRESETS = [
  {
    id: "opencode-go",
    label: "OpenCode Go（DeepSeek V4.1 Flash）",
    baseUrl: "https://opencode.ai/inference/go/v1",
    model: "deepseek-v4.1-flash",
    disableThinking: true,
  },
  {
    id: "opencode-go-glm",
    label: "OpenCode Go（GLM-5.3 Flash）",
    baseUrl: "https://opencode.ai/inference/go/v1",
    model: "glm-5.3-flash",
    disableThinking: true,
  },
  {
    id: "deepseek-official",
    label: "DeepSeek 官方（deepseek-chat）",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    disableThinking: true,
  },
  {
    id: "local-omlx",
    label: "本机 oMLX / Ollama（兼容接口）",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "qwen3.8",
    disableThinking: true,
  },
] as const;

export const liveZhSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  liveFollow: z.boolean().default(true),
  pollIntervalSec: z.number().int().min(3).max(60).default(6),
  summarizeOnTurnEnd: z.boolean().default(true),
  maxSteps: z.number().int().min(3).max(20).default(8),
  skipPureChinese: z.boolean().default(false),
  baseUrl: z.string().trim().default(DEFAULT_BASE_URL),
  apiKey: z.string().default(""),
  model: z.string().trim().default(DEFAULT_MODEL),
  disableThinking: z.boolean().default(true),
  customPrompt: z.string().default(""),
});

export type LiveZhSettingsValues = z.infer<typeof liveZhSettingsSchema>;

export const DEFAULT_LIVE_ZH_SETTINGS: LiveZhSettingsValues = liveZhSettingsSchema.parse({});

export const liveZhSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: liveZhSettingsSchema,
});
