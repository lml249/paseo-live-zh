# 实时中文解说（paseo-live-zh）

实时监控 Paseo 中所有 Agent（Claude、Codex/GPT、Antigravity/Gemini、DeepSeek 等）的最近执行步骤，通过 OpenAI 兼容 API 翻译并总结为易懂的中文大白话。

## 主要功能

- **输入框上方实时胶囊**：一句话实时播报当前 Agent 正在做什么，点击即可打开右侧面板。
- **右侧独立解说面板**：显示「此刻正在干嘛」「最近几步大白话时间线」「本轮结论 / 进展小结」「需要你确认或报错提醒」以及历史回合记录。
- **运行中实时追更**：Agent 运行时定时检查是否有新步骤（仅内容变化时才请求 API，不浪费额度），回合结束自动生成完整中文总结。
- **支持 OpenAI 兼容接口**：内置 OpenCode Go、DeepSeek 官方、本地 oMLX/Ollama 快捷预设，支持一键测试连接。
