# 插件开发指南（1 小时写出你的第一个插件）

先读一遍冻结契约：[`PLUGIN-CONTRACT.md`](../../../PLUGIN-CONTRACT.md)（v1 冻结承诺：一年兼容，允许新增、破坏性变更必须升 `apiVersion: 2`）。

## 四档插件，按风险选

| 档 | 能做什么 | 典型场景 | 你需要写的 |
|---|---|---|---|
| **L0 声明式** | 主题 / 皮肤 / 技能 / 提示词 / 命令 / **语言包** | 换配色、固化一套工作流、翻译界面 | 纯 JSON / Markdown，无代码 |
| **U 界面组件** | 注册到 8 个卡槽的界面块（iframe 沙箱） | 自定义面板、卡片视图、形象驱动 | `ui.html` + manifest |
| **L2 MCP** | 进程外能力（重型解析、需要子进程） | Office 转换、外部服务接入 | MCP server + recipe |
| **L1 进程内扩展** | 新工具 / provider / 钩子（jiti 直跑 TS，与内核同进程） | 查内网工单的自定义工具 | TS 入口 + 显式权限声明 |

**默认倾向：能用 L0 就不要写代码，能用 MCP（L2）就不要进进程（L1）。**「她会一个新能力」的首选形式是技能（L0），不是插件代码。

## manifest 骨架

每个插件一个目录：`~/.lynn/plugins/<id>/plugin.json`（开发期直接放进去，重启生效）。

```json
{
  "id": "lynn.<作者>.<插件名>",
  "name": "显示名",
  "version": "1.0.0",
  "apiVersion": 1,
  "tier": "L0",
  "engines": { "kernel": ">=0.0.1" },
  "source": "local",
  "contributes": { "...": "按档位见下" }
}
```

- `id` 必须是反向域名（2–4 段小写）；`apiVersion` 必须是 `1`；`engines.kernel` 必填（版本闸门）。
- 自研 / 工坊产物要标 `source: "self-authored"` + `generatedBy`（可追溯）。

## 例一：L0 主题插件（约 20 分钟）

完整示例在 [`examples/plugins/lynn.theme.dusk/`](../../../examples/plugins/lynn.theme.dusk/)。

```
lynn.theme.dusk/
├── plugin.json     # contributes.theme = "theme.json"
└── theme.json      # name + dark/light 的 Token 覆盖（白名单键，见皮肤包规范）
```

放进 `~/.lynn/plugins/` → 重启 → 设置 → 外观，主题出现在选择行。**L0 即时生效、无代码执行。**

## 例二：L0 语言包（约 15 分钟）

语言包就是 L0 插件：`contributes.langs: ["en.json"]`，文件结构 `{ "lang": "en", "strings": { "nav.model": "Model", ... } }`。按 `lang` 匹配后覆盖内置字典，缺词条回退中文。示例见[插件索引](./plugin-index.md)。

## 例三：L1 进程内工具（约 30 分钟）

完整示例在 [`examples/plugins/lynn.tool.dice/`](../../../examples/plugins/lynn.tool.dice/)。

```ts
// index.ts —— 默认导出工厂，jiti 直跑，无需编译
export function activate(api: { registerTool: (t: unknown) => void; dataDir: string; log: (m: string) => void }) {
  api.registerTool({
    name: "roll",                       // 运行时全名 lynn.<id>.roll
    description: "掷一个六面骰",
    parameters: { type: "object", properties: {} },
    execute: async () => "🎲 " + (1 + Math.floor(Math.random() * 6)),
  });
}
```

manifest 加 `"tier": "L1", "entry": "index.ts", "permissions": { "fs": [] }`。注意：

- L1 **必须显式声明权限**（fs/net/proc/secrets 至少一项）；`proc: true` 直接拒——要子进程请走 L2。
- 第三方 L1 默认停用，用户在插件面板逐项确认后才载入。
- 禁项扫描：`eval` / `new Function` / `child_process` / 混淆嫌疑命中即拒。

## 例四：U 界面组件（约 20 分钟）

示例在 [`examples/ui-plugins/lynn.demo.hello/`](../../../examples/ui-plugins/lynn.demo.hello/)：`ui.html` + manifest 声明 `contributes.slots`（8 个卡槽白名单：`stage.view` / `card.renderer` / `status.bar` / `composer.action` 等）。U 档跑在 iframe 沙箱里：禁网络、禁 Node、零描边约束 CI 可检出。

## 准入流水线（装之前先跑一次）

```bash
# 插件面板里的「隔离试装」：
#  L0 = 解析校验；L2 = 真起 MCP server 做 initialize 握手；L1 = 真激活一次拿工具面再反注册
```

安全网三件套：插件集指纹（崩溃可归因）、安全模式（连续崩溃自动只跑官方核心）、一键回滚（启用状态快照）。

## 发布到社区

- 插件索引见[插件索引](./plugin-index.md)；投稿要求与签名分级见契约文档。
- 自研插件默认私有；发布 = 交出源码，需要用户显式确认。

下页：[插件索引](./plugin-index.md) · [隐私说明](./privacy.md) · [发布与签名](./release.md)
