/**
 * 内置技能包（M3-01）：随包分发的 SKILL.md，init 时缺失才写入
 * `<dataRoot>/skills/<dir>/SKILL.md`（用户改过就不覆盖；删除后下次启动会还原）。
 * 当前：插件开发手册——风铃自主改进/新增插件时的方法论与验收标准。
 */

export const BUILTIN_SKILLS: Record<string, string> = {
  "plugin-dev/SKILL.md": `---
name: plugin-dev
description: 插件开发与验收：当用户需要新能力、某类任务反复出现值得做成插件、或要改进现有插件时使用。涵盖档位选型（L0/L1/L2）、工坊流程（开草稿→派插件工程师→验收→启用）、manifest 规范与验证测试标准。
allowed-tools: [create_plugin_draft, assign_task, create_member, check_progress, nudge_member, stop_task, ship_plugin, save_memory, review_result, report_to_user, ask_user]
---

# 插件开发手册（风铃版）

## 1. 先决策，再动手：要不要做成插件？

- 这个能力**只做一次** → 不做插件，正常派单完成即可。
- 会**重复出现**（每周报表、固定格式转换、固定网页操作）→ 值得做成插件。
- 先用 save_memory 记下「这类任务重复出现 + 用户原话」，再走工坊流程。

## 2. 档位选型（能用低档不用高档）

| 档位 | 是什么 | 什么时候用 | 验收侧重 |
|---|---|---|---|
| L0 | 纯声明零代码（主题/文案/静态卡槽/SKILL.md） | 换肤、文案包、提示词模板 | 声明文件齐全、静态检查过 |
| L1 | 进程内 TS 扩展（jiti 加载，注册工具） | 需要新工具且逻辑简单、依赖少 | 禁项扫描过 + 真激活能出工具 |
| L2 | 外挂 MCP server（独立进程） | 复用现成 MCP 生态 | initialize 握手成功 |

红线：**能用 L0 不写代码，能用 MCP 不进进程**。需要 child_process/eval/原生模块的，直接拒绝并说明。

## 3. 工坊流程（五步，全程留痕）

1. **开草稿**：create_plugin_draft（title/kind/spec）。spec 四段写全：解决什么、输入输出、边界（不许做什么）、验收用例。
2. **招人派单**：create_member 招插件工程师 → assign_task，**workspace 必须填返回的 draftDir**（产物只能写进草稿区，永不自动生效）。岗位档案只写能力域与做事风格，draftDir、本次路径、档位与验收用例一律放简报；简报里带上：本手册的对应档位规范 + 用户的原始需求 + spec。
3. **跟进**：check_progress / nudge_member 常规管理。
4. **验收**：成员回报后按 §4 清单验收 → ship_plugin 走准入审查（自动：manifest 校验、id 冲突、L1 禁项扫描、L2 命令形状）。
5. **启用**：L0 过审可自启用（会记审计并告知用户）；**L1/L2 过审后必须请用户在插件面板点启用**——你不能给自己的产物提权。

## 4. 验收标准（交付前逐条过，任何一条不过就打回）

**通用（所有档位）：**
- [ ] plugin.json 存在且字段全：id（反向域名，如 lynn.tool.xxx）/ name / version / apiVersion: 1 / tier / engines.kernel / source: self-authored / generatedBy
- [ ] tier 与草稿档位一致；id 与现有插件不冲突
- [ ] 有 plugin-guide.md 或 README：说清这插件做什么、怎么用、怎么卸载

**L0 附加：**
- [ ] 无任何代码文件（.js/.ts 等直接拒）
- [ ] 声明的每个产物（theme/style/langs/slots）文件真实存在且通过静态检查
- [ ] 至少一种声明式产物

**L1 附加：**
- [ ] 源码无 eval / new Function / child_process / postinstall / 原生模块 / 64 位长 hex
- [ ] 单文件 ≤ 256KB；entry 存在于插件目录内
- [ ] 静态检查后，向用户说明它会拿到什么权限（fs/net/proc/secrets）

**L2 附加：**
- [ ] mcp.recipe 的 command 是单一可执行、无 shell 元字符、args 是数组

**行为验收（所有档位，写进成员简报的验收用例）：**
- [ ] spec 里的每条验收用例都能对着产物走一遍并给出结论
- [ ] 插件加载失败时的表现（不拖垮主程序）

## 5. 收尾与复用

- 上线后用 save_memory 记：插件 id、解决什么问题、验收时的坑。
- 用户反馈插件有问题 → 先查工坊草稿与审计记录，必要时开新草稿改进（旧 id 冲突会被准入拦下，改进走新版本）。
- 手册本身不够用时，如实告诉用户「这个场景超出手册」，不要硬造。
`,
};
