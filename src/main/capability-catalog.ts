/**
 * 能力预置清单与安装器（能力中心）
 *
 * 四类预置都来自公开/开源生态，用户点「预装」即可落地成本机配置，**不需要联网下载包**：
 *  - mcp：写进 ~/.lynn/mcp.json（server 本体是 npx / uvx 拉的开源 MCP server，首次连接才需要网络）
 *  - plugin：写进 ~/.lynn/plugins/<id>/（L1 插件源码 + 一个 SKILL.md，随插件走）
 *  - skill：写进 ~/.lynn/skills/<name>/SKILL.md（纯提示词能力）
 *  - schedule：交给调度器建一条定时任务
 *
 * 纪律：
 *  1. 幂等——已存在的目录/配置不覆盖（用户的改动优先），返回"已在，没动它"；
 *  2. 每个插件/MCP 预置**必须**带一个提示词技能（skill），风铃建团队时按需命中，
 *     否则成员拿到了工具却不知道该怎么用；
 *  3. 安装只落配置，不谎报"已连接"——MCP 能不能连上，界面读 mcp.status 的实况。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadMcpConfig } from "./mcp";

export type CapKind = "mcp" | "plugin" | "skill" | "schedule";

export interface PresetSkillSeed {
  name: string;
  description: string;
  allowedTools: string[];
  body: string;
}

export interface CapPreset {
  kind: CapKind;
  id: string;
  name: string;
  /** 一句话说清"装上能干什么" */
  summary: string;
  /** 来源开源项目 / 官方包名（可追溯，避免"来路不明的预置"） */
  source?: string;
  license?: string;
  /** 运行条件（用户得先有什么） */
  requires?: string;
  icon?: "pkg" | "globe" | "table" | "file" | "clock" | "layers" | "brain" | "shield" | "term";
  /** mcp 专用：写进 mcp.json 的 server 配置 */
  server?: { command: string; args: string[]; env?: Record<string, string>; lazy?: boolean };
  /** plugin 专用：相对插件目录的文件（plugin.json / index.ts …） */
  files?: Record<string, string>;
  /** 提示词技能（插件与 MCP 必填；独立技能项自己就是技能） */
  skill?: PresetSkillSeed;
  /** schedule 专用 */
  schedule?: { name: string; prompt: string; kind: "daily" | "interval"; time?: string; intervalMin?: number };
}

/** SKILL.md 文本：frontmatter 只写解析器认的三个字段（name/description/allowed-tools） */
export function buildSkillMd(seed: PresetSkillSeed): string {
  return [
    "---",
    `name: ${seed.name}`,
    `description: ${seed.description}`,
    `allowed-tools: [${seed.allowedTools.join(", ")}]`,
    "---",
    "",
    seed.body.trim(),
    "",
  ].join("\n");
}

/** 落地一个技能文件（幂等：已存在就不覆盖） */
export function writeSkillFile(root: string, seed: PresetSkillSeed): { ok: boolean; dir: string; created: boolean } {
  const dir = path.join(root, seed.name);
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) return { ok: true, dir, created: false };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buildSkillMd(seed), "utf-8");
  return { ok: true, dir, created: true };
}

// ---------- MCP 预置（开源、常见、按 npx / uvx 一行起步） ----------

const MCP_SKILL: Record<string, PresetSkillSeed> = {
  filesystem: {
    name: "mcp-filesystem",
    description:
      "用 filesystem MCP 在指定目录内列目录、读文件、搜索。当任务需要访问工作区之外但用户已授权的一个目录时使用。",
    allowedTools: ["mcp__filesystem__list_directory", "mcp__filesystem__read_file", "mcp__filesystem__search_files", "read_file", "list_dir", "write_file", "submit_report"],
    body: [
      "# filesystem MCP",
      "",
      "工具名形如 `mcp__filesystem__read_file`、`mcp__filesystem__list_directory`、`mcp__filesystem__search_files`。",
      "",
      "- 只在该 server 启动参数里列出的目录内活动；越界会直接失败，不要试第二次。",
      "- 读大文件先看大小（`get_file_info`）；超过 200KB 分页读，别一次拖回来。",
      "- 写文件优先用工作区里的 `write_file`（有 diff 与检查点），MCP 的写不做备份。",
    ].join("\n"),
  },
  memory: {
    name: "mcp-memory",
    description:
      "用 memory MCP 把跨任务的事实（客户口径、字段含义、踩过的坑）存成知识图谱，下次任务先查再问。",
    allowedTools: ["mcp__memory__create_entities", "mcp__memory__search_nodes", "mcp__memory__create_relations", "mcp__memory__read_graph", "read_file", "write_file", "submit_report"],
    body: [
      "# memory MCP",
      "",
      "开场先 `mcp__memory__search_nodes` 查本任务相关的实体（客户名、系统名、字段名），有结论就复用，别重复问用户。",
      "收尾把**稳定事实**写成实体（一个实体一条，别塞整段报告）：字段含义、口径约定、系统限制。",
      "临时数字、一次性中间结果不进 memory——那是交付物的事。",
    ].join("\n"),
  },
  "sequential-thinking": {
    name: "mcp-sequential-thinking",
    description:
      "用 sequential-thinking MCP 把复杂问题拆成可检查的推理步骤。当任务需要多步权衡（方案比较、根因定位）时使用。",
    allowedTools: ["mcp__sequential_thinking__sequentialthinking", "read_file", "list_dir", "submit_report"],
    body: [
      "# sequential-thinking MCP",
      "",
      "`mcp__sequential_thinking__sequentialthinking`：一次一步，标注 `thoughtNumber` / `totalThoughts`，必要时 `revise` 回退。",
      "只在真的有分支权衡时用（方案比较、根因假设、影响面评估）；线性任务直接做，别为了用工具而用。",
      "最后一步必须落到「结论 + 依据 + 剩余不确定」，把推理过程写进回报正文。",
    ].join("\n"),
  },
  sqlite: {
    name: "mcp-sqlite",
    description:
      "用 sqlite MCP 在本机数据库上只读查询（表结构、抽样、聚合）。当任务是核对数据、查历史记录时使用。",
    allowedTools: ["mcp__sqlite__list_tables", "mcp__sqlite__describe_table", "mcp__sqlite__read_query", "read_file", "write_file", "submit_report"],
    body: [
      "# sqlite MCP",
      "",
      "顺序：`list_tables` → `describe_table` → `read_query`（只写 SELECT）。",
      "聚合前先 `SELECT COUNT(*)` 看规模；大表别 `SELECT *`，给列名 + LIMIT。",
      "任何写语句（INSERT/UPDATE/DELETE）都不许发——需要改数据就回报让用户决定。",
    ].join("\n"),
  },
  everything: {
    name: "mcp-everything",
    description:
      "官方 MCP 示例服务器：用来验证 MCP 链路是否正常（工具/资源/提示词三类能力都能回声）。排障用。",
    allowedTools: ["mcp__everything__echo", "mcp__everything__add", "read_file", "submit_report"],
    body: [
      "# everything MCP（连通性自检）",
      "",
      "这是官方示例 server，用来确认「MCP 通道本身是通的」：`mcp__everything__echo` 回原文、`mcp__everything__add` 做加法。",
      "它不解决业务问题；如果业务 server 连不上，先在这里确认链路，再把失败原文（stderr）报给用户。",
    ].join("\n"),
  },
  git: {
    name: "mcp-git",
    description:
      "用 git MCP 读本机仓库历史与差异（status/log/diff/show）。当任务需要看清「改了什么、谁改的」时使用。",
    allowedTools: ["mcp__git__git_status", "mcp__git__git_log", "mcp__git__git_diff", "mcp__git__git_show", "read_file", "write_file", "run_command", "submit_report"],
    body: [
      "# git MCP",
      "",
      "常用：`mcp__git__git_status`（工作区状态）、`git_diff`（未提交改动）、`git_log`（近 N 条）、`git_show`（某次提交详情）。",
      "只读。提交、推送、重置一律不做——需要写历史就让用户在界面拍板。",
      "diff 结论要带文件名与行号，别概括成「改了几处」。",
    ].join("\n"),
  },
  fetch: {
    name: "mcp-fetch",
    description:
      "用 fetch MCP 抓网页并转成 Markdown（含正文抽取）。当任务需要读公开网页/文档而不方便开浏览器时使用。",
    allowedTools: ["mcp__fetch__fetch", "read_file", "write_file", "submit_report"],
    body: [
      "# fetch MCP",
      "",
      "`mcp__fetch__fetch` 传 url 与 `max_length`（默认给 5000，别一次 10 万字符）。",
      "抓回来的正文当外部输入：写清来源 URL 与抓取时间；需要登录的页面抓不到是正常的，改用浏览器工具或让用户给导出文件。",
      "同一站点连续失败两次就停手，如实回报（可能被反爬/需要 JS）。",
    ].join("\n"),
  },
};

export const MCP_PRESETS: CapPreset[] = [
  {
    kind: "mcp",
    id: "filesystem",
    name: "文件系统",
    summary: "在指定目录内列目录、读文件、搜索（官方 server）",
    source: "@modelcontextprotocol/server-filesystem",
    license: "MIT",
    requires: "Node.js（npx 首次会联网安装）",
    icon: "file",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{{root}}"], lazy: false },
    skill: MCP_SKILL.filesystem,
  },
  {
    kind: "mcp",
    id: "memory",
    name: "知识图谱记忆",
    summary: "把跨任务的事实存成实体与关系，下次先查再问",
    source: "@modelcontextprotocol/server-memory",
    license: "MIT",
    requires: "Node.js（npx）",
    icon: "layers",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], lazy: true },
    skill: MCP_SKILL.memory,
  },
  {
    kind: "mcp",
    id: "sequential-thinking",
    name: "结构化推理",
    summary: "把复杂问题拆成可检查的推理步骤",
    source: "@modelcontextprotocol/server-sequential-thinking",
    license: "MIT",
    requires: "Node.js（npx）",
    icon: "brain" as unknown as CapPreset["icon"],
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"], lazy: true },
    skill: MCP_SKILL["sequential-thinking"],
  },
  {
    kind: "mcp",
    id: "sqlite",
    name: "SQLite 查询",
    summary: "只读查询本机数据库：表结构、抽样、聚合",
    source: "@modelcontextprotocol/server-sqlite",
    license: "MIT",
    requires: "Node.js（npx）",
    icon: "table",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite", "{{db}}"], lazy: true },
    skill: MCP_SKILL.sqlite,
  },
  {
    kind: "mcp",
    id: "git",
    name: "Git 仓库",
    summary: "读仓库历史与差异：status / log / diff",
    source: "mcp-server-git（Python，官方参考实现）",
    license: "MIT",
    requires: "uv（uvx 首次会联网安装）",
    icon: "pkg",
    server: { command: "uvx", args: ["mcp-server-git", "--repository", "{{root}}"], lazy: true },
    skill: MCP_SKILL.git,
  },
  {
    kind: "mcp",
    id: "fetch",
    name: "网页抓取",
    summary: "抓公开网页并转 Markdown，不必开浏览器",
    source: "mcp-server-fetch（Python，官方参考实现）",
    license: "MIT",
    requires: "uv（uvx）",
    icon: "globe",
    server: { command: "uvx", args: ["mcp-server-fetch"], lazy: true },
    skill: MCP_SKILL.fetch,
  },
  {
    kind: "mcp",
    id: "everything",
    name: "MCP 自检",
    summary: "官方示例服务器：确认 MCP 链路是否正常（排障用）",
    source: "@modelcontextprotocol/server-everything",
    license: "MIT",
    requires: "Node.js（npx）",
    icon: "term",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], lazy: true },
    skill: MCP_SKILL.everything,
  },
];

// ---------- 插件预置（L1，零依赖纯计算；每个都带 SKILL.md） ----------

const PLUGIN_JSON = (id: string, name: string, tools: string[], description: string): string =>
  JSON.stringify(
    {
      id,
      name,
      version: "1.0.0",
      apiVersion: 1,
      tier: "L1",
      engines: { kernel: "^0.0.1" },
      entry: "./index.ts",
      description,
      contributes: { tools },
      permissions: { fs: [], net: [], proc: false },
      source: "official",
    },
    null,
    2,
  ) + "\n";

export const PLUGIN_PRESETS: CapPreset[] = [
  {
    kind: "plugin",
    id: "lynn.tool.textstat",
    name: "文本体检",
    summary: "统计字数/中英文占比/句子长度/重复短语/预计朗读时长，写稿前先量一遍",
    source: "lynn 官方预置（自研，零依赖）",
    license: "MIT",
    requires: "无（随内核加载）",
    icon: "pkg",
    files: {
      "plugin.json": PLUGIN_JSON("lynn.tool.textstat", "文本体检", ["analyze"], "文本统计：字数、中英文占比、句长分布、重复短语、朗读时长"),
      "index.ts": `/**
 * 文本体检（官方预置 L1）：纯计算，不读写文件、不联网。
 * 用途：写稿/改稿前量一遍——字数、中英文占比、句长、重复短语、朗读时长。
 */
const CJK = /[\\u4e00-\\u9fa5]/g;

function splitSentences(text: string): string[] {
  return text
    .replace(/\\r\\n/g, "\\n")
    .split(/(?<=[。！？!?；;\\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function topPhrases(text: string, n: number, top: number): { phrase: string; count: number }[] {
  const clean = text.replace(/[\\s\\p{P}+]/gu, "");
  const map = new Map<string, number>();
  for (let i = 0; i + n <= clean.length; i += 1) {
    const g = clean.slice(i, i + n);
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return [...map.entries()]
    .filter(([, c]) => c > 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([phrase, count]) => ({ phrase, count }));
}

export default function activate(api: {
  registerTool(def: { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => string | Promise<string> }): void;
  log(...parts: unknown[]): void;
}): void {
  api.registerTool({
    name: "analyze",
    description: "文本体检：字数、中英文占比、句子数与平均句长、重复短语、预计朗读时长。纯计算，不改原文。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要体检的正文" },
        phraseLen: { type: "number", description: "重复短语的字数，默认 4" },
      },
      required: ["text"],
    },
    execute: (args) => {
      const text = String(args.text ?? "");
      if (!text.trim()) return "文本为空，没什么可体检的。";
      const cjk = (text.match(CJK) ?? []).length;
      const words = text.replace(CJK, " ").split(/\\s+/).filter(Boolean).length;
      const sentences = splitSentences(text);
      const lens = sentences.map((s) => (s.match(CJK) ?? []).length || s.split(/\\s+/).length);
      const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
      const longOnes = sentences.filter((s, i) => lens[i] > avg * 2 && lens[i] > 40).slice(0, 5);
      const n = Math.max(2, Math.floor(Number(args.phraseLen) || 4));
      const phrases = topPhrases(text, n, 8);
      const chars = text.replace(/\\s/g, "").length;
      const minutes = Math.max(1, Math.round(cjk / 240 + words / 180));
      const lines = [
        "文本体检",
        "---",
        "字符数（不含空白）：" + chars,
        "中文字符：" + cjk + " · 英文词：" + words,
        "句子数：" + sentences.length + " · 平均句长：" + avg.toFixed(1) + "（字/词）",
        "预计朗读：" + minutes + " 分钟",
      ];
      if (phrases.length) lines.push("高频重复（" + n + " 字窗口，出现 >2 次）：" + phrases.map((p) => p.phrase + "×" + p.count).join("、"));
      else lines.push("高频重复：无（没有连续出现 3 次以上的 " + n + " 字片段）");
      if (longOnes.length) {
        lines.push("过长的句子（可能该拆开）：");
        for (const s of longOnes) lines.push("  · " + s.slice(0, 60) + (s.length > 60 ? "…" : ""));
      }
      return lines.join("\\n");
    },
  });
  api.log("文本体检已就绪");
}
`,
      "SKILL.md": buildSkillMd({
        name: "text-check",
        description:
          "写稿/改稿前的文本体检：用 text_check 工具量字数、中英文占比、句长分布、重复短语与朗读时长，再决定怎么改。适合周报、公告、对外文档的定稿环节。",
        allowedTools: ["text_check", "read_file", "write_file", "submit_report"],
        body: [
          "# 文本体检（插件工具 `text_check`）",
          "",
          "## 什么时候用",
          "- 定稿前：字数是否合口径（比如简报要求 800 字以内/以上）",
          "- 读起来发闷：句长分布里超过平均 2 倍的长句要拆",
          "- 公告/对外文案：重复短语多说明车轱辘话，删掉一半不影响信息",
          "",
          "## 怎么用",
          "1. 把正文传进 `text_check`（也可以先 read_file 再粘）",
          "2. 只改「确实有问题」的地方：长句拆开、重复片段留一处、字数超标就删掉解释性内容而不是删结论",
          "3. 改完再跑一遍 `text_check` 做前后对比，把两组数字写进回报",
          "",
          "## 边界",
          "- 它只统计，不改写；改稿是人的判断",
          "- 中英混排时「平均句长」单位是字/词混合，别当精确指标用",
        ].join("\n"),
      }),
    },
    skill: {
      name: "text-check",
      description:
        "写稿/改稿前的文本体检：用 text_check 工具量字数、中英文占比、句长分布、重复短语与朗读时长，再决定怎么改。",
      allowedTools: ["text_check", "read_file", "write_file", "submit_report"],
      body: "",
    },
  },
  {
    kind: "plugin",
    id: "lynn.tool.csv",
    name: "CSV 表分析",
    summary: "识别列、统计空值与数值分布、找重复行，不必写脚本",
    source: "lynn 官方预置（自研，零依赖）",
    license: "MIT",
    requires: "无（随内核加载）",
    icon: "table",
    files: {
      "plugin.json": PLUGIN_JSON("lynn.tool.csv", "CSV 表分析", ["profile"], "CSV 表格体检：列类型、空值、数值分布、重复行"),
      "index.ts": `/**
 * CSV 表分析（官方预置 L1）：纯计算，只吃文本。
 * 用于拿到一张表先"看一眼"：几列几行、哪列有空值、数值范围、有没有重复行。
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\\r") cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const isNum = (s: string) => s.trim() !== "" && Number.isFinite(Number(s.replace(/,/g, "")));

export default function activate(api: {
  registerTool(def: { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => string | Promise<string> }): void;
  log(...parts: unknown[]): void;
}): void {
  api.registerTool({
    name: "profile",
    description: "CSV 表格体检：行列数、每列类型与空值、数值列的分布、重复行数。纯文本输入，不读文件。",
    parameters: {
      type: "object",
      properties: {
        csv: { type: "string", description: "CSV 原文（首行为表头）" },
        maxCols: { type: "number", description: "最多看几列，默认 12" },
      },
      required: ["csv"],
    },
    execute: (args) => {
      const rows = parseCsv(String(args.csv ?? ""));
      if (rows.length < 2) return "表格至少要有表头 + 一行数据，当前不足。";
      const header = rows[0];
      const body = rows.slice(1);
      const maxCols = Math.min(header.length, Math.max(1, Math.floor(Number(args.maxCols) || 12)));
      const out: string[] = ["CSV 体检", "---", "行数：" + body.length + " · 列数：" + header.length];
      for (let c = 0; c < maxCols; c += 1) {
        const vals = body.map((r) => (r[c] ?? "").trim());
        const empty = vals.filter((v) => v === "").length;
        const nums = vals.filter(isNum).map((v) => Number(v.replace(/,/g, "")));
        const uniq = new Set(vals).size;
        let line = "· " + (header[c] || "第" + (c + 1) + "列") + "：";
        line += nums.length > vals.length * 0.8 ? "数值" : "文本";
        line += " · 唯一值 " + uniq + "/" + vals.length;
        if (empty) line += " · 空 " + empty;
        if (nums.length > 0) {
          const sum = nums.reduce((a, b) => a + b, 0);
          line += " · 范围 " + Math.min(...nums) + " ~ " + Math.max(...nums) + " · 均值 " + (sum / nums.length).toFixed(2);
        }
        out.push(line);
      }
      const seen = new Map<string, number>();
      for (const r of body) {
        const k = r.join("\\u0001");
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      const dup = [...seen.values()].filter((n) => n > 1).length;
      out.push(dup ? "重复行：" + dup + " 组（同一行出现多次）" : "重复行：无");
      return out.join("\\n");
    },
  });
  api.log("CSV 表分析已就绪");
}
`,
      "SKILL.md": buildSkillMd({
        name: "csv-profile",
        description:
          "拿到 CSV 表格先做体检：用 csv_profile 看行列数、每列类型与空值、数值范围、重复行，再决定怎么清洗与汇总。适合报表核对、导入前检查。",
        allowedTools: ["csv_profile", "read_file", "write_file", "run_command", "submit_report"],
        body: [
          "# CSV 表分析（插件工具 `csv_profile`）",
          "",
          "## 顺序",
          "1. `read_file` 读表（超过 200KB 只读前 500 行做体检，再决定是否分段）",
          "2. `csv_profile` 出体检结论：哪列有空、哪列是数值、有没有重复行",
          "3. 按结论决定清洗动作（去重/补空/类型转换），清洗后重新体检一遍对比",
          "",
          "## 口径纪律",
          "- 空值 ≠ 0；缺失率要在结论里写出来，别悄悄当 0 汇总",
          "- 数值列里出现非数（如「-」「无」）要在报告里点出来，这是脏数据",
          "- 重复行按整行判等；主键重复要单独查（同一单号多行可能是明细，不是重复）",
        ].join("\n"),
      }),
    },
    skill: {
      name: "csv-profile",
      description: "拿到 CSV 表格先做体检：用 csv_profile 看行列数、每列类型与空值、数值范围、重复行。",
      allowedTools: ["csv_profile", "read_file", "write_file", "run_command", "submit_report"],
      body: "",
    },
  },
  {
    kind: "plugin",
    id: "lynn.tool.diff",
    name: "文本差异",
    summary: "两份文本的行级差异，改稿前后比一遍（不必装 diff 工具）",
    source: "lynn 官方预置（自研，零依赖）",
    license: "MIT",
    requires: "无（随内核加载）",
    icon: "file",
    files: {
      "plugin.json": PLUGIN_JSON("lynn.tool.diff", "文本差异", ["compare"], "文本行级差异：新增/删除/修改各几行，附变更片段"),
      "index.ts": `/**
 * 文本差异（官方预置 L1）：纯计算，LCS 行级 diff。
 * 用于改稿前后对比、配置变更核对，比"我看了一遍"可靠。
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

export default function activate(api: {
  registerTool(def: { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => string | Promise<string> }): void;
  log(...parts: unknown[]): void;
}): void {
  api.registerTool({
    name: "compare",
    description: "两份文本的行级差异（最长公共子序列）：列出删除行、新增行，统计改了几行。纯计算。",
    parameters: {
      type: "object",
      properties: {
        before: { type: "string", description: "改之前的全文" },
        after: { type: "string", description: "改之后的全文" },
        limit: { type: "number", description: "最多展示几条变更，默认 40" },
      },
      required: ["before", "after"],
    },
    execute: (args) => {
      const a = String(args.before ?? "").replace(/\\r\\n/g, "\\n").split("\\n");
      const b = String(args.after ?? "").replace(/\\r\\n/g, "\\n").split("\\n");
      if (a.length * b.length > 4_000_000) return "两段文本太大（超过约 2000×2000 行），请分段比较。";
      const dp = lcsTable(a, b);
      const ops: { t: "-" | "+" | " "; line: string }[] = [];
      let i = 0;
      let j = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
          ops.push({ t: " ", line: a[i] });
          i += 1;
          j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          ops.push({ t: "-", line: a[i] });
          i += 1;
        } else {
          ops.push({ t: "+", line: b[j] });
          j += 1;
        }
      }
      while (i < a.length) ops.push({ t: "-", line: a[i++] });
      while (j < b.length) ops.push({ t: "+", line: b[j++] });
      const removed = ops.filter((o) => o.t === "-").length;
      const added = ops.filter((o) => o.t === "+").length;
      const limit = Math.max(1, Math.floor(Number(args.limit) || 40));
      const out = ["文本差异", "---", "删除 " + removed + " 行 · 新增 " + added + " 行 · 未变 " + ops.filter((o) => o.t === " ").length + " 行"];
      if (!removed && !added) return out.concat(["两份文本完全一致。"]).join("\\n");
      const changed = ops.filter((o) => o.t !== " ");
      out.push("", "变更片段：");
      for (const o of changed.slice(0, limit)) out.push(o.t + " " + o.line.slice(0, 200));
      if (changed.length > limit) out.push("…还有 " + (changed.length - limit) + " 行变更未展示（调 limit 看更多）");
      return out.join("\\n");
    },
  });
  api.log("文本差异已就绪");
}
`,
      "SKILL.md": buildSkillMd({
        name: "text-diff",
        description:
          "改稿/改配置后的差异核对：用 text_diff 比两份文本，把改了几行、改了哪几句写进回报，而不是只写「已更新」。",
        allowedTools: ["text_diff", "read_file", "write_file", "submit_report"],
        body: [
          "# 文本差异（插件工具 `text_diff`）",
          "",
          "## 什么时候用",
          "- 改完稿子要向风铃证明「只改了该改的地方」",
          "- 两份版本（v1/v2 报表、旧新配置）要对齐差异",
          "- 怀疑自己漏改，回看补充是否真的写进去了",
          "",
          "## 纪律",
          "1. 差异结论必须带行数与片段，不能只写「无变化」——真无变化工具会明说。",
          "2. 删除行要能解释为什么删（不是误删）；新增行要能对应到需求点。",
          "3. 超过 40 行变更分批看，别把整段差异贴进回报。",
        ].join("\n"),
      }),
    },
    skill: {
      name: "text-diff",
      description: "改稿/改配置后的差异核对：用 text_diff 比两份文本，把改了几行、改了哪几句写进回报。",
      allowedTools: ["text_diff", "read_file", "write_file", "submit_report"],
      body: "",
    },
  },
];

// ---------- 技能预置（纯提示词，自写正文，参考公开工作流方法论） ----------

export const SKILL_PRESETS: CapPreset[] = [
  {
    kind: "skill",
    id: "docx-report",
    name: "Word 报告",
    summary: "正式 Word 报告的结构、排版与交付前自检（结构化生成，不手写 OOXML）",
    source: "lynn 官方预置（自写工作流）",
    license: "MIT",
    requires: "无",
    icon: "file",
    skill: {
      name: "docx-report",
      description:
        "要交正式 Word 文档时使用：封面要点、章节层级、表格规范、页脚页码与交付前自检清单。含 office_write_docx 的正确用法与常见驳回原因。",
      allowedTools: ["office_write_docx", "office_write_table", "office_read_table", "read_file", "write_file", "list_dir", "run_command", "read_artifact", "submit_report"],
      body: [
        "# Word 报告工作流",
        "",
        "## 1. 先定骨架，再填内容",
        "1. 从简报里抽出「读者是谁 / 要回答哪几个问题 / 有没有格式要求」；缺就按最保守的正式报告结构走。",
        "2. 结构：标题 → 一、摘要（3~5 句，结论先行）→ 二、背景与口径 → 三、正文分析（按问题分节）→ 四、结论与建议 → 附录（数据表/来源）。",
        "3. **每节至少 2~3 句实质内容**（结论 + 依据 + 处置）。只有小节标题＝骨架稿，必被驳回。",
        "",
        "## 2. 用 office_write_docx，不要手写 OOXML",
        "- 参数：`path`（工作区内 `.docx`）、`title`、`author`、`footerText`、`pageNumbers`、`blocks`。",
        "- `blocks` 每项：`{type:'heading', level:1-3, text}` / `{type:'paragraph', text}` / `{type:'bullet', text}` / `{type:'table', headers:[], rows:[[]]}`。",
        "- `heading`/`paragraph`/`bullet` 的 `text` 必须非空——模板变量取不到值会原样印成 undefined，生成前自己检查一遍。",
        "- 表格列宽会按内容自动分配并撑满页宽、表头跨页重复；列不要超过 8 列，太宽就读不清。",
        "- 图片、公式、自动目录域才需要 python-docx 脚本兜底；没装就如实说做不到，不要硬造。",
        "",
        "## 3. 交付前自检（逐条过，任何一条不过就改）",
        "- [ ] 文件真实存在，大小 > 5KB（0 字节或 1KB 说明只写了个空壳）",
        "- [ ] 打开后标题层级正确，没有连续两个一级标题",
        "- [ ] 每个数字都能在附录/表格里找到出处，没有拍脑袋的百分比",
        "- [ ] 没有「待补充」「TODO」「undefined」「{{变量}}」残留",
        "- [ ] 表格有表头，数值列右对齐感（数字不夹中文单位）",
        "- [ ] 页脚有页码与署名（对外文档必须有）",
        "",
        "## 4. 回报写法",
        "写清「文件路径 + 页数/字数 + 每章一句话概括 + 哪些数据是估算」，别只写「已生成」。",
      ].join("\n"),
    },
  },
  {
    kind: "skill",
    id: "data-audit",
    name: "数据核对",
    summary: "报表/台账对账口径：先定口径、再独立复算、差异逐项归零",
    source: "lynn 官方预置（自写工作流）",
    license: "MIT",
    requires: "无",
    icon: "table",
    skill: {
      name: "data-audit",
      description:
        "核对数字类任务（报表对账、台账核对、口径比对）时使用：定口径 → 独立复算 → 差异逐项归零 → 出结论。含常见口径陷阱与证据要求。",
      allowedTools: ["office_read_table", "office_write_table", "csv_profile", "read_file", "write_file", "list_dir", "run_command", "submit_report"],
      body: [
        "# 数据核对工作流",
        "",
        "## 1. 先把口径写下来（写不进一句话就别开始算）",
        "- 统计范围：时间区间、包含/排除哪些状态（作废、退货、测试单）",
        "- 计数单位：单号 / 明细行 / 客户；同一单号多行时「总单数」和「总行数」是两回事",
        "- 金额口径：含税/不含税、是否含运费、币种与汇率日期",
        "- 缺失值：空值算 0 还是剔除？两种都要给数，别偷偷选一个",
        "",
        "## 2. 独立复算，不复用别人的中间结果",
        "- 用 `office_read_table` / `csv_profile` 自己读原始表，别拿上游报表的汇总值当输入。",
        "- 至少两条路径算同一个数（比如按明细求和 vs 按分组汇总再求和），两条对上才算过。",
        "- 计算过程落成文件（脚本或表格），别只在脑内算。",
        "",
        "## 3. 差异逐项归零",
        "对每个对不上的差异，给出一条**可验证的原因**：",
        "- 口径不同（含税/排除作废）→ 按对方口径重算一遍，看是否归零",
        "- 数据缺失（某天没导）→ 指出缺哪天的哪张表",
        "- 真实错误（源数据错）→ 指出哪一行哪个字段，附原始值",
        "「大概是四舍五入」不算原因——四舍五入的差异必须 < 0.01×笔数。",
        "",
        "## 4. 结论写法",
        "`总差异 = X，其中口径差异 A、缺失 B、真实错误 C；A 与 B 已解释，C 需业务确认（列出 3 条以内具体行）`。",
        "没有差异就明说「按上述口径复算，差异为 0，两条路径一致」。",
        "",
        "## 5. 证据",
        "每个结论都要能指到：文件 + 工作表/行号 + 字段。截图不算证据，原始数据行才算。",
      ].join("\n"),
    },
  },
  {
    kind: "skill",
    id: "web-research",
    name: "调研取证",
    summary: "外部调研的来源分级、交叉验证与结论写法（区分事实/推断/传闻）",
    source: "lynn 官方预置（自写工作流）",
    license: "MIT",
    requires: "能联网（浏览器或 fetch 工具）",
    icon: "globe",
    skill: {
      name: "web-research",
      description:
        "需要查外部资料（竞品、政策、技术方案、价格）时使用：来源分级、交叉验证、区分事实与推断、结论带可复核链接。",
      allowedTools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_extract", "mcp__fetch__fetch", "read_file", "write_file", "submit_report"],
      body: [
        "# 外部调研工作流",
        "",
        "## 1. 先问清三件事",
        "要回答的具体问题（不是一个话题）、时间范围、用途（决策/科普/合规）。",
        "问题不清楚就先给「我打算查这 3 个问题」再动手，别一头扎进搜索结果。",
        "",
        "## 2. 来源分级（每条结论都要标级别）",
        "| 级别 | 是什么 | 举例 |",
        "|---|---|---|",
        "| A | 一手权威：官方文档、法规原文、官方定价页、财报 | 厂商 pricing 页、国家统计局 |",
        "| B | 二手可信：主流媒体调查、行业协会报告、知名技术博客 | 有署名与日期的长文 |",
        "| C | 参考：论坛、问答、自媒体、聚合站 | 只能用来找线索 |",
        "结论只用 A/B；C 只能写「有用户反映…（未核实）」。",
        "",
        "## 3. 交叉验证",
        "- 关键数字至少两个独立来源；只有一个来源就写「单一来源，未交叉验证」。",
        "- 注意时间：价格/政策类必须写「截至 YYYY-MM-DD」。过期数据比没数据更危险。",
        "- 官方页面改版很快：抓到的正文里带上 URL 与抓取时间。",
        "",
        "## 4. 结论结构",
        "`问题 → 短答案（一句话）→ 依据（逐条带级别 + 链接）→ 不确定的地方 → 建议下一步`。",
        "严禁把「我推测」写成「资料显示」。",
      ].join("\n"),
    },
  },
  {
    kind: "skill",
    id: "meeting-notes",
    name: "会议纪要",
    summary: "把录音转写/速记整理成可执行的决议、待办与责任人",
    source: "lynn 官方预置（自写工作流）",
    license: "MIT",
    requires: "无",
    icon: "clock",
    skill: {
      name: "meeting-notes",
      description:
        "整理会议纪要时使用：从速记里抽出决议、待办（含责任人与时限）、未决问题，区分「说过」与「定了」。含纪要模板与常见失真。",
      allowedTools: ["read_file", "write_file", "list_dir", "office_write_docx", "submit_report"],
      body: [
        "# 会议纪要工作流",
        "",
        "## 1. 三段式结构（不要写成流水账）",
        "1. **结论/决议**：定了几件事，每件一句话（含金额、日期、范围）",
        "2. **待办**：`做什么｜谁负责｜什么时候要`——三要素缺一不可；没写责任人的，标「待指派」而不是猜",
        "3. **未决**：讨论了但没定的事，写明分歧点与下次再议时间",
        "",
        "## 2. 严格区分「说过」与「定了」",
        "- 「我觉得可以试试」≠ 决议；「那就这么定」才算。拿不准就放进未决，标「原话：…」。",
        "- 数字、日期、人名逐字核对；听不清标 `[听不清]`，不要补全成合理猜测。",
        "- 别人的评价性发言（「这个方案不行」）只记结论与理由要点，不复述情绪。",
        "",
        "## 3. 交付形式",
        "- 默认 Markdown（`write_file`）；用户要正式文件时用 `office_write_docx`（标题 + 表格列待办）。",
        "- 待办用表格：| 事项 | 负责人 | 时限 | 备注 |",
        "- 篇幅控制在 1 页内；超出说明会议本身太长，把细节放附录。",
        "",
        "## 4. 自检",
        "- [ ] 每条待办都有责任人与时限（或明确标「待指派/待定」）",
        "- [ ] 决议里没有「可能/大概/看情况」这类模糊词",
        "- [ ] 没有把讨论中的方案写成已定方案",
      ].join("\n"),
    },
  },
];

// ---------- 自动化预置（定时交给风铃的指令） ----------

export const SCHEDULE_PRESETS: CapPreset[] = [
  {
    kind: "schedule",
    id: "daily-standup",
    name: "每日开工巡检",
    summary: "每天 09:30 汇总在办工单、待审查、卡住的单，并点名该跟的事",
    source: "lynn 官方预置",
    license: "MIT",
    requires: "心跳/调度已启用",
    icon: "clock",
    schedule: {
      name: "每日开工巡检",
      kind: "daily",
      time: "09:30",
      prompt: [
        "【定时任务 · 每日开工巡检】",
        "按下面顺序看一遍，只报需要用户知道的事，没有就一句话说不用管：",
        "1. 在跑的工单：谁在跑、跑了几轮、有没有超过 30 分钟没动静的；",
        "2. 待审查：列单号与成员，说明你打算今天什么时候验收；",
        "3. 卡住/受阻：卡在哪、需要用户拍板什么（一条一行）；",
        "4. 今天到期的定时任务与提醒。",
        "不要罗列已经验收归档的单，也不要重述昨天聊过的结论。",
      ].join("\n"),
    },
  },
  {
    kind: "schedule",
    id: "weekly-review",
    name: "每周复盘",
    summary: "每周一次：这周交付了什么、打回了几次、哪类活最费 token",
    source: "lynn 官方预置",
    license: "MIT",
    requires: "调度已启用",
    icon: "layers",
    schedule: {
      name: "每周复盘",
      kind: "interval",
      intervalMin: 10080,
      prompt: [
        "【定时任务 · 每周复盘】",
        "用卷宗里的事实做一份短复盘（不要凭印象）：",
        "1. 本周验收通过的单：单号、成员、一句话产出；",
        "2. 打回记录：哪张单打回几次、原因是什么（归成一两类）；",
        "3. 成本：本周大致 token 消耗与最贵的两件事；",
        "4. 一条改进建议（只给一条，能落地的那种）。",
        "如果本周没有任何交付，直接说「本周没有交付」，不要编。",
      ].join("\n"),
    },
  },
  {
    kind: "schedule",
    id: "stuck-patrol",
    name: "停滞工单巡检",
    summary: "每 2 小时看一次：有没有单卡在半路没人管",
    source: "lynn 官方预置",
    license: "MIT",
    requires: "调度已启用",
    icon: "shield",
    schedule: {
      name: "停滞工单巡检",
      kind: "interval",
      intervalMin: 120,
      prompt: [
        "【定时任务 · 停滞巡检】",
        "只看一件事：有没有工单卡住了。判定标准：",
        "- 状态是 backlog/blocked 超过 2 小时没人动；",
        "- 成员在跑但超过 30 分钟没有新进展（check_progress 的 running 与轮次能看出）；",
        "- 回报里带 ESCALATE 的。",
        "有就逐条给出处置（催、重派、还是请用户拍板）；一条都没有就回一句话「没有停滞的单」。",
      ].join("\n"),
    },
  },
];

/** 四类合一的清单（界面一次拉完） */
export function allPresets(): CapPreset[] {
  return [...PLUGIN_PRESETS, ...MCP_PRESETS, ...SKILL_PRESETS, ...SCHEDULE_PRESETS];
}

// ---------- 安装（幂等，不覆盖用户改动） ----------

export interface InstallOutcome {
  ok: boolean;
  detail: string;
  id: string;
  /** 一并落地的提示词技能名 */
  skill?: string;
  created: boolean;
}

function fail(id: string, error: string): InstallOutcome {
  return { ok: false, detail: error, id, created: false };
}

/** 把 {{root}} / {{db}} / {{dataRoot}} 换成真实路径（目录会先建好） */
function expandArgs(args: string[], dataRoot: string): string[] {
  const roots = path.join(dataRoot, "mcp-roots");
  return args.map((a) => {
    if (a === "{{root}}") {
      fs.mkdirSync(roots, { recursive: true });
      return roots;
    }
    if (a === "{{db}}") return path.join(dataRoot, "mcp.sqlite");
    return a.replace(/\{\{dataRoot\}\}/g, dataRoot);
  });
}

function installMcp(dataRoot: string, preset: CapPreset): InstallOutcome {
  if (!preset.server) return fail(preset.id, "预置项缺 server 配置");
  const file = path.join(dataRoot, "mcp.json");
  let raw: { servers?: unknown[] } = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { servers?: unknown[] };
    } catch (err) {
      // 坏配置不覆盖：用户手写的内容比"装上预置"重要
      return fail(preset.id, `mcp.json 解析失败，已停止安装（避免覆盖你的手写内容）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const servers = Array.isArray(raw.servers) ? raw.servers : [];
  const exists = servers.some((s) => (s as { id?: string })?.id === preset.id);
  if (!exists) {
    servers.push({
      id: preset.id,
      command: preset.server.command,
      args: expandArgs(preset.server.args, dataRoot),
      ...(preset.server.env ? { env: preset.server.env } : {}),
      enabled: true,
      lazy: preset.server.lazy === true,
    });
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...raw, servers }, null, 2), { encoding: "utf-8", mode: 0o600 });
  const skillOut = preset.skill ? writeSkillFile(path.join(dataRoot, "skills"), preset.skill) : null;
  return {
    ok: true,
    detail: exists
      ? `mcp.json 里已经有 ${preset.id}，没动它；${skillOut?.created ? `提示词技能 ${preset.skill?.name} 已补齐` : "提示词技能已在"}`
      : `已写入 mcp.json（${preset.server.command} ${preset.server.args.join(" ")}）。首次连接要联网装包，连没连上看下面的 MCP 实况。`,
    id: preset.id,
    skill: preset.skill?.name,
    created: !exists,
  };
}

function installPlugin(dataRoot: string, preset: CapPreset): InstallOutcome {
  if (!preset.files) return fail(preset.id, "预置项缺文件内容");
  const dir = path.join(dataRoot, "plugins", preset.id);
  const manifest = path.join(dir, "plugin.json");
  if (fs.existsSync(manifest)) {
    // 已装：只补技能（缺才写），不动用户改过的插件代码
    const skillOut = preset.skill ? writeSkillFile(dir, preset.skill) : null;
    return {
      ok: true,
      detail: skillOut?.created
        ? `插件已在（${preset.id}），补齐了提示词技能 ${preset.skill?.name}`
        : `插件已在（${preset.id}），没动它`,
      id: preset.id,
      skill: preset.skill?.name,
      created: false,
    };
  }
  const base = path.resolve(dir);
  for (const [rel, content] of Object.entries(preset.files)) {
    const full = path.resolve(dir, rel);
    if (!full.startsWith(base + path.sep)) return fail(preset.id, `文件路径跳出插件目录：${rel}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  const skillOut = preset.skill ? writeSkillFile(dir, preset.skill) : null;
  return {
    ok: true,
    detail: `已装入 ${preset.id}（${Object.keys(preset.files).length} 个文件）${skillOut?.created ? `，并带上提示词技能 ${preset.skill?.name}` : ""}。插件面板里已可启停。`,
    id: preset.id,
    skill: preset.skill?.name,
    created: true,
  };
}

function installSkill(dataRoot: string, preset: CapPreset): InstallOutcome {
  if (!preset.skill) return fail(preset.id, "预置项缺技能正文");
  const r = writeSkillFile(path.join(dataRoot, "skills"), preset.skill);
  return {
    ok: true,
    detail: r.created ? `技能 ${preset.skill.name} 已写入（风铃下一轮起可用）` : `技能 ${preset.skill.name} 已在，没动它`,
    id: preset.id,
    skill: preset.skill.name,
    created: r.created,
  };
}

/** 文件类安装（mcp / plugin / skill）。schedule 由内核交给调度器，不在这里。 */
export function installPreset(dataRoot: string, kind: CapKind, id: string): InstallOutcome {
  if (kind === "mcp") {
    const p = MCP_PRESETS.find((x) => x.id === id);
    return p ? installMcp(dataRoot, p) : fail(id, `没有这个 MCP 预置：${id}`);
  }
  if (kind === "plugin") {
    const p = PLUGIN_PRESETS.find((x) => x.id === id);
    return p ? installPlugin(dataRoot, p) : fail(id, `没有这个插件预置：${id}`);
  }
  if (kind === "skill") {
    const p = SKILL_PRESETS.find((x) => x.id === id);
    return p ? installSkill(dataRoot, p) : fail(id, `没有这个技能预置：${id}`);
  }
  return fail(id, "定时任务预置由调度器安装，不走文件安装器");
}

/** 已安装判定（界面据此显示「已装」而不是「预装」） */
export function presetInstalled(dataRoot: string, kind: CapKind, id: string): boolean {
  if (kind === "mcp") {
    return loadMcpConfig(dataRoot).servers.some((s) => s.id === id);
  }
  if (kind === "plugin") return fs.existsSync(path.join(dataRoot, "plugins", id, "plugin.json"));
  if (kind === "skill") {
    const p = SKILL_PRESETS.find((x) => x.id === id);
    if (!p?.skill) return false;
    return fs.existsSync(path.join(dataRoot, "skills", p.skill.name, "SKILL.md"));
  }
  return false;
}
