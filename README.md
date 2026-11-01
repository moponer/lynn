# 风铃 Lynn

**每个人都该有一只自己的风铃。** *A Lynn of your own.*

本地优先、插件化的桌面 AI 个人助理——**她是指挥者，不是执行者**：她组队、派单、盯进度、审查证据、向你汇报。基于 [earendil-works/pi](https://github.com/earendil-works/pi) 生态，薄壳 + 三档插件 + MCP 能力外挂。

> 当前状态：**M0 · 真实后端直连**。主进程内置 OpenAI 兼容流式内核（DeepSeek / GLM / Kimi / Qwen / Ollama…自配），风铃的管理工具 8 件套以 function-calling 真实执行，团队/成员档案落 `~/.lynn/`。尚未接 Pi 运行时（接入后仅替换内核层，契约不变）。

## 运行

```bash
npm install
npm run build   # typecheck + renderer(vite) + main(tsc)
npm test        # build:main + node --test（28 条）
npm start       # electron .
```

首次启动点右上角 ⚙：填 Base URL / API Key / 模型（Key 用系统 safeStorage 加密存本机，可先「测试连接」再保存）。

## 结构

```
src/
├── shared/contract.ts    # 类型化 IPC 契约（RPC + 事件流，唯一契约）
├── main/
│   ├── main.ts           # Electron 薄壳：窗口 + IPC 转发 + safeStorage（无 Agent 逻辑）
│   ├── preload.ts        # contextBridge：window.lynn.rpc / onEvent
│   ├── kernel.ts         # 内核：流式对话循环 + 管理工具 8 件套真实执行 + 指挥板推导
│   ├── llm.ts            # OpenAI 兼容 SSE 客户端（工具调用增量聚合）
│   ├── settings.ts       # ~/.lynn/settings.json（Key 加密）
│   ├── team-store.ts     # 成员书面岗位 Markdown + ~/.lynn/team 布局
│   ├── management-tools.ts # 8 件套硬约束（收窄/打回上限/证据原则/审计）
│   └── plugin-manifest.ts  # 插件 manifest v1 校验器 + 版本闸门
└── renderer/             # React 三栏作战室（指挥频道流式渲染 / 指挥板 / 设置面板）
```

## 设计基线

- 界面：三栏作战室（左导航 / 中央指挥频道 / 右侧指挥板），任务流水线七阶段，六种指挥卡（受理/派单/回报/打回/审批/汇报），证据可点开复跑。
- 权限四模式（plan/ask/auto/full）为全局驾驶模式，切换联动上下文轴与界面语义色。
- 灰蓝主色（暗 `#6396BC` / 亮 `#35618C`），无卡片左描边，动效只表达状态。
- 完整产品定义见 `../docs/立项计划书-全方位个人助理.md`（v0.4.2）。

## 下一步（M0 剩余）

1. 七个可证伪实验（见计划书 §7，最优先：纯提示词版指挥环）。
2. Pi 运行时接入：RPC 模式 + `~/.pi → ~/.lynn/kernel` 重定向（先核对 Pi 环境变量文档）。
3. 插件 manifest v1 + 三档加载器 + 版本闸门。
4. 风铃管理型工具 8 件套 + 成员档案格式 v1（`~/.lynn/team/`）。
