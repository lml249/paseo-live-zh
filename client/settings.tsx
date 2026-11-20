import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { testConnectionRpc } from "../shared/contracts";
import { API_PRESETS, type LiveZhSettingsValues, liveZhSettings } from "../shared/settings";

const POLL_OPTIONS = [
  { value: "4", label: "每 4 秒（最及时）" },
  { value: "6", label: "每 6 秒（推荐）" },
  { value: "10", label: "每 10 秒（省流量）" },
  { value: "15", label: "每 15 秒" },
] as const;

const STEP_OPTIONS = [
  { value: "5", label: "最近 5 步" },
  { value: "8", label: "最近 8 步（推荐）" },
  { value: "12", label: "最近 12 步" },
  { value: "16", label: "最近 16 步" },
] as const;

export function LiveZhSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(liveZhSettings);
  const testConnection = useRpc(testConnectionRpc);
  const toast = useToast();

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const baseUrlRef = useRef<SettingsInputHandle>(null);
  const apiKeyRef = useRef<SettingsInputHandle>(null);
  const modelRef = useRef<SettingsInputHandle>(null);
  const customPromptRef = useRef<SettingsInputHandle>(null);

  const mutedStyle = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 };

  if (settings.status === "loading") {
    return <Text style={mutedStyle}>正在读取配置…</Text>;
  }

  if (settings.status !== "ready") {
    return (
      <SettingsSection title="实时中文解说">
        <SettingsCard>
          <SettingsAction
            label="配置读取异常"
            hint={settings.error}
            actionLabel="重置默认配置"
            disabled={settings.saving}
            onPress={() => {
              void settings.reset();
            }}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = settings.values;

  const savePatch = (patch: Partial<LiveZhSettingsValues>) => {
    void settings.save({ ...values, ...patch }, settings.revision);
  };

  const currentPresetId =
    API_PRESETS.find((p) => p.baseUrl === values.baseUrl && p.model === values.model)?.id ?? "custom";

  const presetOptions = [
    ...API_PRESETS.map((p) => ({ value: p.id as string, label: p.label })),
    { value: "custom", label: "自定义 OpenAI 兼容接口" },
  ];

  const handleSelectPreset = (presetId: string) => {
    const preset = API_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    baseUrlRef.current?.replaceText(preset.baseUrl);
    modelRef.current?.replaceText(preset.model);
    savePatch({
      baseUrl: preset.baseUrl,
      model: preset.model,
      disableThinking: preset.disableThinking,
    });
    toast.show(`已切换预设：${preset.label}`, { variant: "info" });
  };

  const handleSaveApiFields = () => {
    const baseUrl = (baseUrlRef.current?.getText() ?? values.baseUrl).trim();
    const apiKey = apiKeyRef.current?.getText() ?? values.apiKey;
    const model = (modelRef.current?.getText() ?? values.model).trim();
    const customPrompt = customPromptRef.current?.getText() ?? values.customPrompt;
    savePatch({ baseUrl, apiKey, model, customPrompt });
    toast.show("API 配置已保存", { variant: "success" });
  };

  const handleTestConnection = async () => {
    const baseUrl = (baseUrlRef.current?.getText() ?? values.baseUrl).trim();
    const apiKey = apiKeyRef.current?.getText() ?? values.apiKey;
    const model = (modelRef.current?.getText() ?? values.model).trim();
    if (!baseUrl || !model) {
      toast.error("请先填写 Base URL 和模型名称");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testConnection({
        baseUrl,
        apiKey,
        model,
        disableThinking: values.disableThinking,
      });
      setTestResult({ ok: res.ok, message: res.message });
      if (res.ok) {
        toast.show(res.message, { variant: "success" });
      } else {
        toast.error(res.message);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setTestResult({ ok: false, message: `测试失败：${msg}` });
      toast.error(`测试失败：${msg}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <View style={{ gap: 20 }}>
      <SettingsSection title="OpenAI 兼容 API 配置">
        <SettingsCard>
          <SettingsSelect
            label="快捷服务预设"
            hint="选择 OpenCode Go、DeepSeek 官方或本机 oMLX 自动填充地址与模型"
            value={currentPresetId}
            options={presetOptions}
            disabled={settings.saving}
            onValueChange={handleSelectPreset}
          />
          <SettingsInput
            ref={baseUrlRef}
            label="Base URL"
            hint="支持任意 OpenAI 兼容接口（末尾可不带 /chat/completions）"
            initialValue={values.baseUrl}
            placeholder="https://opencode.ai/inference/go/v1"
            disabled={settings.saving}
            onChangeText={() => {}}
          />
          <SettingsInput
            ref={apiKeyRef}
            label="API Key"
            hint="OpenCode Go 或其他兼容服务的 API Key（本机 localhost 可留空）"
            initialValue={values.apiKey}
            placeholder="sk-..."
            secureTextEntry
            disabled={settings.saving}
            onChangeText={() => {}}
          />
          <SettingsInput
            ref={modelRef}
            label="模型名称"
            hint="推荐速度快、成本低的 Flash / Chat 模型，如 deepseek-v4.1-flash"
            initialValue={values.model}
            placeholder="deepseek-v4.1-flash"
            disabled={settings.saving}
            onChangeText={() => {}}
          />
          <SettingsSwitch
            label="关闭深度思考（提速）"
            hint="对 DeepSeek 等支持关闭思考的模型发送 thinking: disabled，响应更快更省额度"
            value={values.disableThinking}
            disabled={settings.saving}
            onValueChange={(disableThinking) => savePatch({ disableThinking })}
          />
          <SettingsAction
            label="保存 API 配置"
            hint={settings.saveError ?? "修改上方输入框后点击保存"}
            actionLabel={settings.saving ? "保存中…" : "保存"}
            disabled={settings.saving}
            onPress={handleSaveApiFields}
          />
          <SettingsAction
            label="测试连通性"
            hint={
              testResult
                ? testResult.message
                : "发送一条极短 ping 请求验证地址、Key 和模型是否可用"
            }
            error={testResult && !testResult.ok ? testResult.message : null}
            actionLabel={testing ? "测试中…" : "测试连接"}
            disabled={testing}
            onPress={() => void handleTestConnection()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="实时追更与总结行为">
        <SettingsCard>
          <SettingsSwitch
            label="启用实时中文解说"
            hint="总开关：关闭后不会再自动请求模型"
            value={values.enabled}
            disabled={settings.saving}
            onValueChange={(enabled) => savePatch({ enabled })}
          />
          <SettingsSwitch
            label="运行中实时追更"
            hint="Agent 干活过程中定时检测新步骤并增量更新中文解说（无新进展不发请求）"
            value={values.liveFollow}
            disabled={settings.saving || !values.enabled}
            onValueChange={(liveFollow) => savePatch({ liveFollow })}
          />
          <SettingsSelect
            label="实时追更间隔"
            hint="运行中每隔几秒检查一次新进展"
            value={String(values.pollIntervalSec)}
            options={POLL_OPTIONS}
            disabled={settings.saving || !values.enabled || !values.liveFollow}
            onValueChange={(val) => savePatch({ pollIntervalSec: Number(val) })}
          />
          <SettingsSwitch
            label="每轮结束自动生成完整总结"
            hint="Agent 完成一轮任务后自动总结本轮成果并写入历史记录"
            value={values.summarizeOnTurnEnd}
            disabled={settings.saving || !values.enabled}
            onValueChange={(summarizeOnTurnEnd) => savePatch({ summarizeOnTurnEnd })}
          />
          <SettingsSelect
            label="总结参考范围"
            hint="每次总结读取最近多少条关键步骤"
            value={String(values.maxSteps)}
            options={STEP_OPTIONS}
            disabled={settings.saving || !values.enabled}
            onValueChange={(val) => savePatch({ maxSteps: Number(val) })}
          />
          <SettingsSwitch
            label="跳过纯中文对话"
            hint="若最近回复本身已是纯中文且没有工具调用，则跳过自动总结以省额度"
            value={values.skipPureChinese}
            disabled={settings.saving || !values.enabled}
            onValueChange={(skipPureChinese) => savePatch({ skipPureChinese })}
          />
          <SettingsInput
            ref={customPromptRef}
            label="附加解说风格（可选）"
            hint="例如：尽量用非技术人员也能听懂的比喻解释技术操作"
            initialValue={values.customPrompt}
            placeholder="留空则使用默认大白话风格"
            disabled={settings.saving}
            onChangeText={() => {}}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
