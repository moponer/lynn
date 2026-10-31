# 风铃 Lynn

**每个人都该有一只自己的风铃。** *A Lynn of your own.*

本地优先、插件化的桌面 AI 个人助理——**她是指挥者，不是执行者**：她组队、派单、盯进度、审查证据、向你汇报。基于 [earendil-works/pi](https://github.com/earendil-works/pi) 生态，薄壳 + 三档插件 + MCP 能力外挂。

> 当前状态：**M0 前期脚手架**。内核侧为 MockKernel（纯内存模拟指挥环），渲染层界面闭环可跑；接入 Pi 运行时（JSON-RPC over stdio）后仅替换主进程内核层，渲染层契约不变。

## 运行

```bash
npm install
npm run build   # typecheck + renderer(vite) + main(tsc)
npm start       # electron .
```

要求 Node ≥ 22.19（Pi 生态的 engines 约束；当前机器 22.15 只影响未来接 Pi，Mock 阶段不影响）。

## 结构

```
src/
├── shared/contract.ts    # 类型化 IPC 契约（唯一契约，单一来源）
├── main/
│   ├── main.ts           # Electron 薄壳：窗口 + IPC 转发（无 Agent 逻辑）
│   ├── preload.ts        # contextBridge 暴露 window.lynn.rpc
│   └── mock-kernel.ts    # MockKernel：指挥环内存模拟（受理/派单/回报/审批/汇报）
└── renderer/             # React 界面：三栏作战室
    ├── App.tsx           # 状态 + RPC 数据流（Mock 阶段轮询，接 Pi 后换事件推送）
    └── components/       # TopBar / Channel(流水线+指挥卡) / Board / Composer / Avatar / EvidenceModal
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
