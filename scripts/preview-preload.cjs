// 预览截图用的假桥：让渲染层在没有内核进程时也能拿到一份快照。
// 只在开发截图脚本里使用，不参与打包。这里的样例只服务截图，不是产品兜底数据。
const { contextBridge } = require("electron");

const now = "11-02 14:32";
const feed = [
  { id: "c1", kind: "user", createdAt: "14:30", text: "把 issues_0914.csv 整理成周报，少一条要说明。" },
  {
    id: "c2",
    kind: "lynn",
    createdAt: "14:31",
    text: "明白了。我拆成两件：先核对源数据条数，再按编号去重生成第 3 节。验收标准：条数对得上、每条都有来源。",
  },
  {
    id: "c3",
    kind: "tool",
    badge: "派单",
    title: "顾明 · WO-2418",
    meta: "截止 15:00",
    body: "简报：读 issues_0914.csv，按 number 去重，输出 report_0914.md 第 3 节；附行数对账。",
    jobId: "WO-2418",
    createdAt: "14:31",
  },
  {
    id: "c4",
    kind: "tool",
    badge: "回报",
    title: "顾明 · WO-2418",
    meta: "证据 2 项",
    body: "已生成第 3 节；附 report_0914.md 与行数对账日志。",
    jobId: "WO-2418",
    createdAt: "14:32",
  },
];

const snapshot = {
  workspace: { project: "my-notes", subdir: "值台" },
  permission: "ask",
  model: {
    // LYNN_PREVIEW_WIZARD=1：模型未配 → 首启向导不被 App 的"已配就跳过"逻辑关掉
    configured: process.env.LYNN_PREVIEW_WIZARD !== "1",
    provider: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKeySet: true,
  },
  feed,
  board: {
    teams: [
      {
        id: "t1",
        name: "月报突击队",
        status: "active",
        members: [
          {
            name: "顾明",
            role: "数据整理",
            goal: "把源数据整理成可核对的周报",
            status: "delivered",
            statusNote: "已交付，等你拍板",
            progress: 100,
            budgetUsed: 18,
            budgetTotal: 300,
            rejections: 0,
            rejectionLimit: 3,
            toolWhitelist: ["read_file", "write_file"],
            color: "#5ea9c9",
            model: "deepseek-chat",
            turnLimit: 12,
          },
        ],
      },
    ],
    track: [
      {
        id: "WO-2418",
        teamId: "t1",
        title: "把 issues_0914.csv 整理成周报第 3 节",
        status: "in_review",
        statusNote: "in_review · 顾明 · 证据 2",
        member: "顾明",
        at: now,
        evidenceCount: 2,
        version: 3,
        rejectRounds: 0,
        evidence: [
          { label: "report_0914.md", ref: "artifacts/report_0914.md", verified: true, at: now },
          { label: "rowcount.log", ref: "artifacts/rowcount.log", verified: true, at: now },
        ],
      },
      // 归档带也要有人：一张已归档 + 一张已取消，走查时能验"点得开"
      {
        id: "WO-2402",
        teamId: "t1",
        title: "上周依赖升级清单",
        status: "done",
        statusNote: "done · 顾明 · 证据 1",
        member: "顾明",
        at: "2026-10-28T09:12:00.000Z",
        evidenceCount: 1,
        version: 2,
        rejectRounds: 0,
        evidence: [{ label: "upgrade.md", ref: "artifacts/upgrade.md", verified: true, at: now }],
      },
      {
        id: "WO-2399",
        teamId: "t1",
        title: "抓取竞品价格（已撤回）",
        status: "canceled",
        statusNote: "canceled · 用户撤回",
        member: "顾明",
        at: "2026-10-26T15:40:00.000Z",
        evidenceCount: 0,
        version: 1,
        rejectRounds: 0,
        evidence: [],
      },
    ],
    // A5 演示用三条挂起裁决；review 模式要进审查台（印章区得让位给验收印章），env 关掉
    decisions: process.env.LYNN_PREVIEW_NO_DECISIONS
      ? []
      : [
      {
        id: "dc-plan",
        from: "顾明",
        title: "把 issues_0914.csv 整理成周报第 3 节",
        detail: "计划：清洗两行脏数据 → 按周聚合 → 出周报草稿",
        kind: "plan",
        jobId: "WO-2418",
        at: "11-02 14:32",
        plan: {
          taskId: "WO-2418",
          title: "把 issues_0914.csv 整理成周报第 3 节",
          goal: "清洗 + 聚合 + 草稿",
          acceptance: ["CSV 行数对账一致", "周报第 3 节可读"],
          member: "顾明",
          budgetTokens: 30000,
          deadline: "15:00",
        },
      },
      {
        id: "dc-ask",
        from: "顾明",
        title: "周报要按自然周还是按交付周聚合？",
        detail: "影响第 3 节的分桶口径",
        kind: "question",
        at: "11-02 14:40",
      },
      {
        id: "dc-appr",
        from: "顾明",
        title: "允许运行 run_command：node scripts/aggregate.mjs",
        detail: "只读工作区脚本，输出落 tasks/WO-2418/workspace/",
        kind: "approval",
        jobId: "WO-2418",
        at: "11-02 14:41",
      },
    ].filter(Boolean),
    tokensUsed: 21400,
  },
  turn: { phase: "review", busy: false, pending: 0, taskId: "WO-2418" },
  usage: { turnIn: 3120, turnOut: 860, sessionIn: 18400, sessionOut: 3000, contextTokens: 42000, contextWindow: 128000 },
  queue: [],
  prefs: { autoStart: false, trayOnClose: true, notify: true, lang: "zh" },
  project: { root: "C:/Users/demo/notes", trusted: true, hasMcp: false },
  thread: { id: "t-main", title: "月报整理" },
  threads: [
    { id: "t-main", title: "月报整理", updatedAt: "2026-11-02T14:32:00.000Z" },
    { id: "t-2", title: "插件工坊", updatedAt: "2026-11-01T10:05:00.000Z" },
  ],
};

contextBridge.exposeInMainWorld("lynn", {
  rpc: async (method) => {
    if (method === "session.snapshot") return snapshot;
    if (method === "permission.set") return { ok: true, mode: "ask" };
    if (method === "feed.send") return { ok: true, queued: false };
    if (method === "session.abort") return { ok: true, aborted: true };
    if (method === "session.queue") return { items: [] };
    if (method === "session.reload") return { ok: true };
    if (method === "app.openData") return { ok: true, path: "C:/Users/demo/.lynn" };
    if (method === "decision.resolve") return { ok: true };
    if (method === "config.get") return snapshot.model;
    if (method === "config.prefs") return { ok: true, autoStart: false };
    if (method === "config.clearKey") return { ok: true };
    if (method === "ui.plugins") {
      return { plugins: [], errors: [] };
    }
    if (method === "plugins.list") {
      return {
        plugins: [
          {
            id: "lynn.theme.dusk",
            name: "暮色",
            version: "1.0.0",
            tier: "L0",
            enabled: true,
            loadable: true,
            description: "示例 L0 主题插件（只带 Token）",
            theme: {
              name: "暮色",
              dark: { "--blue": "#6fb3d1", "--brass": "#d0ab35" },
              light: { "--blue": "#2c6c86", "--brass": "#8a6f1e" },
            },
          },
        ],
        errors: [],
      };
    }
    if (method === "plugins.status") {
      return { fingerprint: "3f9c1a2b4d5e6f70", count: 3, safeMode: false, snapshots: [] };
    }
    if (method === "window.control") return { ok: true, maximized: false };
    if (method === "i18n.get") {
      // 截图只验版式：直接给内置中文（与 src/shared/i18n-strings.ts 的 zh 同源，缺 key 回退键名）
      return { lang: "zh", strings: {}, sources: [] };
    }
    return { ok: true };
  },
  onEvent: () => () => {},
});
