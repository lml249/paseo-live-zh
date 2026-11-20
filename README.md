# 实时中文解说（paseo-live-zh）

一个 [Paseo](https://paseo.sh) 插件：实时监控 Paseo 中各个 Agent（Claude、Codex/GPT、Antigravity/Gemini、DeepSeek 等）的最近执行步骤，通过任意 OpenAI 兼容 API 将英文思维链、工具调用和执行进展翻译总结为通俗易懂的**中文大白话**，并在输入框上方胶囊与右侧边栏面板中实时展示。

## ✨ 主要功能

- **输入框上方实时胶囊（Composer Pill）**
  - 为每个活跃的工作区 Agent 展示当前一句话中文状态。
  - 根据状态自动切换图标与提示色（运行中/总结中、权限确认/异常提醒、报错）。
  - 点击胶囊即可打开右侧解说面板并自动定位到对应 Agent。
- **右侧独立解说面板（Explorer / Workspace Panel）**
  - **此刻正在干嘛**：一句话状态标题（`headline`）+ 当前动作大白话说明，附带更新相对时间与接口耗时。
  - **最近几步时间线**：提取最近关键操作（读文件、改代码、跑命令、搜索、思考、回复等），配以对应图标和状态标识（运行中 / 完成 / 出错）。
  - **阶段进展 / 结论**：提炼 1~2 句阶段小结，支持一键复制完整中文摘要。
  - **需要你关注 / 确认**：监听 Agent 权限请求（`agent.permission.before`）和错误，在面板顶部高亮提示。
  - **历史回合小结**：在每轮对话结束或手动刷新时自动沉淀最近 5 条回合摘要，支持折叠回看。
  - **多 Agent 切换与快捷控制**：支持同一工作区内切换查看多个 Agent，顶部提供「刷新」「暂停/恢复追更」「打开设置」按钮。
- **运行中实时追更 & 省额度机制**
  - Agent 运行期间按设定间隔定时检查新步骤；基于时间线内容计算 SHA-1 指纹，**内容无变化时不发请求**。
  - 每轮结束（`agent.turn.after`）自动生成完整本轮结论。
  - 支持开启「跳过纯中文对话」，当最近回复已是纯中文且无工具调用时自动跳过总结。
  - 并发请求自动排队合并，`turn_end` 与手动刷新优先于常规轮询。
- **OpenAI 兼容接口 & 快捷预设**
  - 支持任意提供 `/chat/completions` 接口的模型服务，并内置以下预设：
    - **OpenCode Go（DeepSeek V4.1 Flash）**：`https://opencode.ai/inference/go/v1` / `deepseek-v4.1-flash`
    - **OpenCode Go（GLM-5.3 Flash）**：`https://opencode.ai/inference/go/v1` / `glm-5.3-flash`
    - **DeepSeek 官方（deepseek-chat）**：`https://api.deepseek.com/v1` / `deepseek-chat`
    - **本机 oMLX / Ollama（兼容接口）**：`http://127.0.0.1:8000/v1` / `qwen3.8`（`localhost` / `127.0.0.1` 等本机地址可不填 API Key）
  - 支持「关闭深度思考（提速）」（发送 `thinking: { type: "disabled" }`，若目标接口返回不支持该字段则自动回退）。
  - 设置页内置**一键测试连接**与自定义**附加解说风格**输入框。
- **命令中心快捷入口**
  - `打开实时中文解说面板`（工作区上下文）
  - `配置实时中文解说 API`（全局上下文）

## 📋 环境要求

- Paseo `>= 0.16.0`
- 一个可用的 OpenAI 兼容 Chat Completions API（云端或本机服务均可）

## 📦 安装方法

### 方式一：直接通过 GitHub 仓库安装（推荐）

```bash
paseo plugin install https://github.com/lml249/paseo-live-zh.git
```

### 方式二：克隆到本地后安装

```bash
git clone https://github.com/lml249/paseo-live-zh.git
paseo plugin install ./paseo-live-zh
```

## ⚙️ 配置与使用

1. 安装后，在 Paseo 中打开设置 → **实时中文解说**（或打开命令中心搜索 `配置实时中文解说 API`）。
2. 选择一个**快捷服务预设**，或手动填写：
   - **Base URL**：OpenAI 兼容接口地址（末尾可不带 `/chat/completions`）
   - **API Key**：对应服务商的密钥（本机 `127.0.0.1` / `localhost` 服务可留空）
   - **模型名称**：推荐使用响应快、成本低的轻量模型（如 `deepseek-v4.1-flash`、`deepseek-chat` 等）
3. 点击 **保存**，然后点击 **测试连接** 确认模型返回正常。
4. 按需调整追更与总结选项：
   - **启用实时中文解说**：总开关
   - **运行中实时追更**：开启后在 Agent 运行期间定期增量更新
   - **实时追更间隔**：可选 `4 秒` / `6 秒（推荐）` / `10 秒` / `15 秒`
   - **每轮结束自动生成完整总结**：回合结束自动总结并写入历史记录
   - **总结参考范围**：每次总结读取最近 `5` / `8（推荐）` / `12` / `16` 步关键记录
   - **跳过纯中文对话**：无工具调用且内容主要为中文时跳过请求
   - **附加解说风格（可选）**：自定义额外提示词（如“用非技术人员能听懂的比喻解释”）
5. 回到任意工作区发起 Agent 对话，即可在输入框上方看到实时中文状态胶囊，点击即可在右侧打开完整解说面板。

## 🗂️ 项目结构

```text
paseo-live-zh/
├── paseo-plugin.json     # Paseo 插件清单（id、名称、最低版本要求）
├── package.json          # 依赖与脚本配置
├── tsconfig.json         # TypeScript 配置
├── OVERVIEW.md           # 插件概览说明
├── index.server.ts       # 服务端入口：注册设置、Agent Hooks、RPC 与订阅
├── index.client.tsx      # 客户端入口：注册胶囊、侧边栏面板、设置页与命令中心
├── shared/
│   ├── contracts.ts      # RPC、Subscription 与数据结构 Zod Schema 定义
│   └── settings.ts       # 插件设置 Schema 与 API 预设
├── server/
│   ├── service.ts        # 轮询调度、防抖指纹比对、状态管理与广播
│   ├── timeline.ts       # Agent 时间线提取、格式化与指纹计算
│   └── llm.ts            # OpenAI 兼容接口调用、JSON 解析与连通性测试
└── client/
    ├── pills.tsx         # 输入框上方实时状态胶囊
    ├── panel.tsx         # 右侧独立中文解说面板
    └── settings.tsx      # 插件设置页面
```

## 🛠️ 本地开发与类型检查

```bash
npm install
npm run typecheck
```
