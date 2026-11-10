// 预览截图用的假桥：让渲染层在没有内核进程时也能拿到一份快照。
// 只在开发截图脚本里使用，不参与打包。这里的样例只服务截图，不是产品兜底数据。
const { contextBridge } = require("electron");

const now = "11-02 14:32";
const feed = [
  { id: "c1", kind: "user", createdAt: "14:30", jobId: "WO-2418", text: "把 issues_0914.csv 整理成周报，少一条要说明。" },
  {
    id: "c2",
    kind: "lynn",
    createdAt: "14:31",
    jobId: "WO-2418",
    thinking: "先看表头和行数：如果 number 有重复，直接按周聚合会把同一条算两次。\n先核对总数，再决定去重口径。",
    text: [
      "**收到**，我拆成三步：",
      "",
      "1. 先核对 `issues_0914.csv` 的条数",
      "2. 按编号去重，生成第 3 节",
      "3. 附行数对账日志",
      "",
      "验收标准：**条数对得上**、每条都有来源。",
    ].join("\n"),
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
    // 战报（report_to_user 落进 feed 的那份）：战果抽屉按 jobId 取最近一条
    report: {
      conclusion: "第 3 节已写完，条数从 1284 对到 1284，无缺口。",
      evidence: "report_0914.md · rowcount.log",
      unfinished: "按来源拆分的那张表还差两家",
      decision: "要不要现在补那两家，还是随下期一起",
    },
    createdAt: "14:32",
  },
  {
    id: "c5",
    kind: "tool",
    badge: "回报",
    title: "顾明 · WO-2402",
    meta: "已归档",
    body: "依赖升级清单已交付，9 个包全部升到目标版本。",
    jobId: "WO-2402",
    report: {
      conclusion: "9 个包全部升级完成，构建与测试通过。",
      evidence: "upgrade.md",
      unfinished: "无",
      decision: "是否同步通知运维窗口",
    },
    createdAt: "10-28",
  },
];

const avatarPicks = {};
const snapshot = {
  workspace: {
    project: "my-notes",
    subdir: "值台",
    primary: "F:/spiker/my-notes",
    extras: [{ path: "D:/客户资料", mode: "ro", label: "客户资料" }],
  },
  permission: "ask",
  // 设计走查：模拟"会话删了单还在"的无主单（档案抽屉要能看到清理出口）
  orphans: Number(process.env.LYNN_PREVIEW_ORPHANS || 0),
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
            color: "#6fa892",
            avatarId: avatarPicks["顾明"] ?? "a01",
            model: "deepseek-chat",
            turnLimit: 12,
          },
          // 工具多的成员：走查右栏"只露 3 个 + N"的卡片密度（8 件套）
          {
            name: "阿计",
            role: "浏览器自动化",
            goal: "登录后台并截取对账数据",
            status: "running",
            statusNote: "正在跑",
            progress: 42,
            lastStep: "browser_click #submit",
            budgetUsed: 6,
            budgetTotal: 300,
            rejections: 1,
            rejectionLimit: 3,
            toolWhitelist: [
              "browser_navigate",
              "browser_snapshot",
              "browser_click",
              "browser_fill",
              "read_file",
              "write_file",
              "run_command",
              "list_dir",
            ],
            color: "#c9a227",
            avatarId: avatarPicks["阿计"] ?? "a03",
            model: "deepseek-chat",
            turnLimit: 40,
          },
          {
            name: "阿元",
            role: "信息核对",
            goal: "核对每一条来源能否追溯",
            status: "idle",
            statusNote: "空闲",
            progress: 0,
            budgetUsed: 0,
            budgetTotal: 300,
            rejections: 0,
            rejectionLimit: 3,
            toolWhitelist: ["read_file", "list_dir", "grep"],
            color: "#5c9b83",
            avatarId: "a07",
            model: "deepseek-chat",
            turnLimit: 8,
          },
        ],
      },
    ],
    track: [
      {
        id: "WO-2418",
        teamId: "t1",
        // LYNN_PREVIEW_HEAVY=1：模拟"标题是整段话 + 22 项证据"的重载单，专治一堵墙
        title: process.env.LYNN_PREVIEW_HEAVY
          ? "背景：用户问「分析项目，如何开发插件」。项目根目录是 F:/spiker/lynn，只做两件事：读官方指南 + 写一份规范速查。"
          : "把 issues_0914.csv 整理成周报第 3 节",
        status: "in_review",
        statusNote: process.env.LYNN_PREVIEW_HEAVY ? "in_review · 探针 · 证据 22" : "in_review · 顾明 · 证据 2",
        member: process.env.LYNN_PREVIEW_HEAVY ? "探针" : "顾明",
        at: now,
        // C3 演示：这张单是另一个会话派的——眉标出「回到会话」，印章头出「来自会话」
        threadId: "t-2",
        // 只读授权演示：图纸上会显示「只读授权：…」
        readRoots: ["F:/spiker/hermix-desktop"],
        // 成员读写工作区演示：图纸上会显示「成员工作区（可读写…）」
        workspaceRoot: "F:/spiker/hermix-desktop",
        evidenceCount: process.env.LYNN_PREVIEW_HEAVY ? 22 : 2,
        version: 3,
        rejectRounds: 0,
        evidence: process.env.LYNN_PREVIEW_HEAVY
          ? [
              "PLUGIN-CONTRACT.md",
              "src/main/plugin-manifests.ts",
              "src/main/plugin-host.ts",
              "src/main/plugin-l1.ts",
              "src/shared/ui-plugin.ts",
              "examples/plugins/lynn.tool.dice/plugin.json",
              "examples/plugins/lynn.tool.dice/index.ts",
              "examples/plugins/lynn.theme.dusk/plugin.json",
              "examples/plugins/lynn.theme.dusk/theme.json",
              "examples/plugins/lynn.demo.hello/plugin.json",
              "examples/plugins/lynn.demo.hello/ui.html",
              "examples/mcp/mcp.example.json",
              "docs/site/zh/plugin-index.md",
              "docs/site/zh/plugin-guide.md",
              "src/main/kernel.ts",
              "src/main/skills.ts",
              "src/main/plugin-probe.ts",
              "src/main/plugin-set.ts",
              "tests/ui-plugins.test.mjs",
              "tests/plugin-manifest.test.mjs",
              "tests/plugin-l1.test.mjs",
              "tests/contract-frozen.test.mjs",
            ].map((label, i) => ({
              label,
              ref: `artifacts/${label.replace(/[\\/]/g, "_")}`,
              verified: i % 7 !== 6,
              at: now,
            }))
          : [
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
  // D3：配了软上限才出预算 chip（60000 × 21400 累计 ≈ 36%）
  prefs: { autoStart: false, trayOnClose: true, notify: true, lang: "zh", softBudgetTokens: 60000 },
  project: { root: "C:/Users/demo/notes", trusted: true, hasMcp: false },
  // LYNN_PREVIEW_EMPTY=1：走查"最后一条会话也删掉"之后的空场
  thread: process.env.LYNN_PREVIEW_EMPTY ? { id: "", title: "" } : { id: "t-main", title: "月报整理" },
  threads: process.env.LYNN_PREVIEW_EMPTY
    ? []
    : [
        { id: "t-main", title: "月报整理", updatedAt: "2026-11-02T14:32:00.000Z", counts: { active: 0, archived: 2 } },
        { id: "t-2", title: "插件工坊", updatedAt: "2026-11-01T10:05:00.000Z", counts: { active: 1, archived: 0 } },
      ],
};

// 多任务并行夹具（LYNN_PREVIEW_MULTI=1）：两个团队、两张在跑的单——
// 用来验「任务总览 / 在跑 N / 右栏按团队分组」，默认截图不受影响。
if (process.env.LYNN_PREVIEW_MULTI) {
  snapshot.board.teams.push({
    id: "t2",
    name: "超星刷课",
    status: "active",
    members: [
      {
        name: "阿黎",
        role: "流程执行",
        goal: "把剩余课程刷完并留下完成截图",
        status: "running",
        statusNote: "正在刷第 3 门课",
        progress: 42,
        budgetUsed: 12,
        budgetTotal: 300,
        rejections: 0,
        rejectionLimit: 3,
        toolWhitelist: ["browser_navigate", "browser_click"],
        lastStep: "browser_click · 第 3 门课第 12 节",
        color: "#d08a4e",
        avatarId: avatarPicks["阿黎"] ?? "a09",
        model: "deepseek-chat",
        turnLimit: 12,
      },
    ],
  });
  const at = "2026-11-04T06:13:00.000Z";
  snapshot.board.track.push(
    {
      id: "WO-2420",
      teamId: "t2",
      title: "超星剩余课程刷完（第 3 门进行中）",
      status: "in_progress",
      statusNote: "in_progress · 阿黎",
      member: "阿黎",
      at,
      threadId: "t-2",
      evidenceCount: 0,
      version: 2,
      rejectRounds: 0,
      evidence: [],
    },
    {
      id: "WO-2421",
      teamId: "t1",
      title: "竞品价格抓取（每日 09:00）",
      status: "in_progress",
      statusNote: "in_progress · 顾明",
      member: "顾明",
      at,
      threadId: "t-main",
      evidenceCount: 0,
      version: 2,
      rejectRounds: 0,
      evidence: [],
    },
    // 卡住（blocked）走查夹具不在这里：见下方块外那一条，默认截图也要能看到
  );
  snapshot.running = ["WO-2420", "WO-2421"];
}

// 卡住（blocked）：连续两个节点没交新证据。默认就挂一张——
// 走查要能看见「卡住 2 时 41 分」转红 + 卡上的「停掉止损」。
snapshot.board.track.push({
  id: "WO-2422",
  teamId: "t1",
  title: "权限审计主体已完成，缺最后一份印证",
  status: "blocked",
  statusNote: "连续两个节点没有新证据",
  member: "杜衡",
  at: new Date(Date.now() - (2 * 60 + 41) * 60_000).toISOString(),
  threadId: "t-main",
  evidenceCount: 1,
  version: 5,
  rejectRounds: 2,
  evidence: [],
});

// 成员交的活：等风铃验（reviewer=lynn）。默认就挂一张——
// 走查要能看见它和 WO-2418 的区别：台账里按"执行中"上色，不弹印章给你。
snapshot.board.track.push({
  id: "WO-2424",
  teamId: "t1",
  title: "权限白名单冒烟：执行期拦截是否真的生效",
  status: "in_review",
  statusNote: "in_review · 冒烟测试员 · 证据 1",
  member: "冒烟测试员",
  reviewer: "lynn",
  at: new Date(Date.now() - 9 * 60_000).toISOString(),
  threadId: "t-main",
  evidenceCount: 1,
  version: 1,
  rejectRounds: 0,
  evidence: [{ label: "smoke-shell.txt", ref: "artifacts/smoke-shell.txt", verified: true, at: new Date().toISOString() }],
});

// 空场走查：会话删光 = 名下的工单连带清掉，成员回到空闲。
// 放在所有夹具 push 之后，才不会被默认样例单"复活"。
if (process.env.LYNN_PREVIEW_EMPTY) {
  snapshot.board.track = [];
  snapshot.board.decisions = [];
  snapshot.feed = [];
  for (const t of snapshot.board.teams) {
    for (const m of t.members) {
      m.status = "idle";
      m.progress = 0;
      m.lastStep = undefined;
    }
  }
}

contextBridge.exposeInMainWorld("lynn", {
  rpc: async (method, params) => {
    if (method === "session.snapshot") return snapshot;
    // 版本握手：预览没有真内核，给一个"刚刚构建"的时间；LYNN_PREVIEW_STALE=1 时模拟旧内核
    if (method === "app.info") {
      return process.env.LYNN_PREVIEW_STALE ? { ok: true } : { buildAt: new Date().toISOString() };
    }
    if (method === "app.pickDir") return { canceled: true };
    if (method === "app.pickDirs") return { canceled: true };
    if (method === "project.setRoot") return { ok: true, root: "F:/spiker/hermix-desktop", trusted: false };
    if (method === "project.clearRoot") return { ok: true };
    if (method === "workspace.get") {
      return {
        ...(snapshot.workspace.primary ? { primary: snapshot.workspace.primary } : {}),
        extras: snapshot.workspace.extras,
        readable: [snapshot.workspace.primary, ...snapshot.workspace.extras.map((r) => r.path)].filter(Boolean),
        writable: [snapshot.workspace.primary].filter(Boolean),
      };
    }
    if (method === "workspace.addRoot" || method === "workspace.removeRoot") return { ok: true, roots: [] };
    if (method === "workspace.prefs") {
      return { defaultWorkspace: snapshot.workspace.primary, knownReadRoots: snapshot.workspace.extras.map((r) => r.path) };
    }
    if (method === "workspace.savePrefs") return { ok: true, defaultWorkspace: snapshot.workspace.primary, knownReadRoots: [] };
    if (method === "data.usage") {
      return {
        usage: {
          totalBytes: 48 * 1024 * 1024,
          tasksBytes: 42 * 1024 * 1024,
          scratchBytes: 6 * 1024 * 1024,
          artifactsBytes: 18 * 1024 * 1024,
          sandboxBytes: 18 * 1024 * 1024,
          logsBytes: 4 * 1024 * 1024,
          checkpointsBytes: 2 * 1024 * 1024,
        },
        retention: { scratchDays: 14, checkpointDays: 7, logDays: 7 },
      };
    }
    if (method === "data.cleanup") return { ok: true, freedBytes: 1024 * 1024, removed: 3 };
    if (method === "permission.set") return { ok: true, mode: "ask" };
    if (method === "feed.send") return { ok: true, queued: false };
    if (method === "session.abort") return { ok: true, aborted: true };
    if (method === "session.queue") return { items: [] };
    if (method === "session.reload") return { ok: true };
    if (method === "app.openData") return { ok: true, path: "C:/Users/demo/.lynn" };
    if (method === "decision.resolve") return { ok: true };
    if (method === "task.feed") return { cards: [], threadId: "t-2", threadTitle: "插件工坊" };
    if (method === "thread.rename") return { ok: true, title: "改名" };
    if (method === "thread.remove") return { ok: true };
    // 设计走查里换头像也要看得见：把选择记在内存里，team.list 下次读就带上
    if (method === "team.member.save" && params?.avatarId) {
      avatarPicks[String(params.name)] = String(params.avatarId);
      return { ok: true };
    }
    if (method === "task.cancelAll") return { ok: true, stopped: 0 };
    if (method === "config.get") return snapshot.model;
    if (method === "config.prefs") return { ok: true, autoStart: false };
    // 设计走查没有真壳层：截图相关调用给空结果，避免面板 / 输入框按钮读到 undefined
    if (method === "capture.pending") return { shots: [] };
    if (method === "capture.frame") return { ok: false, width: 0, height: 0, view: { width: 0, height: 0 }, windows: [], error: "预览环境没有真实截图能力" };
    if (method === "capture.status") {
      return { engine: false, hotkey: "Alt+Shift+S", registered: false, active: false, note: "预览环境没有真实截图能力" };
    }
    if (method === "capture.start") return { ok: false, error: "预览环境没有真实截图能力" };
    if (method === "config.clearKey") return { ok: true };
    // 模型库：预览里用快照那一条当唯一已配置模型，保证「已配置列表」不空白、不崩
    if (method === "model.list") {
      const m = snapshot.model;
      const id = "m-preview";
      return {
        models: m.configured
          ? [{
            id,
            label: `${m.provider || "模型"} · ${m.model}`,
            provider: m.provider,
            baseUrl: m.baseUrl,
            model: m.model,
            apiKeySet: m.apiKeySet,
            isDefault: true,
            isThreadModel: false,
            updatedAt: new Date().toISOString(),
          }]
          : [],
        defaultModelId: m.configured ? id : null,
        threadModelId: null,
        activeModelId: m.configured ? id : null,
        threadTitle: snapshot.thread?.title ?? "新会话",
      };
    }
    // 编制页：预览给一队两成员（含岗位提示词），便于设计走查
    if (method === "team.list") {
      return {
        teams: [
          {
            id: "t1",
            name: "月报突击队",
            status: "active",
            createdAt: "2026-11-02T10:00:00.000Z",
            members: [
              {
                name: "顾明",
                role: "数据整理",
                goal: "把源数据整理成可核对的周报",
                body: "先对账，再出稿；条数对不上就上报，不自行补数。",
                tools: ["read_file", "write_file", "run_command"],
                model: "deepseek-chat",
                avatarId: avatarPicks["顾明"] ?? "a01",
              },
              {
                name: "林晚",
                role: "图表校对",
                goal: "所有图表口径与数据源一致",
                body: "每张图必须能回溯到具体数据行。",
                tools: ["read_file"],
                model: "deepseek-chat",
                avatarId: avatarPicks["林晚"] ?? "a05",
              },
            ],
          },
        ],
      };
    }
    if (method === "team.member.save") return { ok: true };
    if (method === "team.member.remove") return { ok: true };
    if (method === "team.dissolve") return { ok: true };
    // 自动化（定时任务）：预览给两条，状态有开有关
    if (method === "schedule.list") {
      return {
        tasks: [
          {
            id: "s1",
            name: "每日站会纪要",
            kind: "daily",
            enabled: true,
            nextRun: new Date(Date.now() + 3600_000).toISOString(),
            lastRun: new Date(Date.now() - 86_400_000).toISOString(),
            lastStatus: "ok",
          },
          {
            id: "s2",
            name: "周报催办",
            kind: "interval",
            enabled: false,
            nextRun: new Date(Date.now() + 7_200_000).toISOString(),
            lastRun: new Date(Date.now() - 7_200_000).toISOString(),
            lastStatus: "skipped",
          },
        ],
      };
    }
    if (method === "schedule.add") {
      return { ok: true, task: { id: "s3", name: "预览任务", nextRun: new Date(Date.now() + 3_600_000).toISOString() } };
    }
    if (method === "schedule.toggle") return { ok: true, enabled: true };
    if (method === "schedule.remove") return { ok: true };
    if (method === "mcp.reload") {
      return {
        ok: true,
        servers: [
          { id: "files", command: "npx -y @modelcontextprotocol/server-filesystem F:/spiker", enabled: true, lazy: false, connected: true, tools: 12 },
          { id: "github", command: "npx -y @modelcontextprotocol/server-github", enabled: true, lazy: true, connected: false, tools: 0 },
        ],
        globalFile: "C:/Users/demo/.lynn/mcp.json",
        projectFile: "F:/spiker/lynn/.lynn/mcp.json",
        projectTrusted: false,
      };
    }
    // MCP：一台连上、一台按需、一台连不上（状态如实展示）
    if (method === "mcp.status") {
      return {
        servers: [
          { id: "files", command: "npx -y @modelcontextprotocol/server-filesystem F:/spiker", enabled: true, lazy: false, connected: true, tools: 12 },
          { id: "github", command: "npx -y @modelcontextprotocol/server-github", enabled: true, lazy: true, connected: false, tools: 0 },
          { id: "docs", command: "node ./tools/docs-mcp.js", enabled: true, lazy: false, connected: false, tools: 0, error: "spawn node ENOENT" },
        ],
        globalFile: "C:/Users/demo/.lynn/mcp.json",
        projectFile: "F:/spiker/lynn/.lynn/mcp.json",
        projectTrusted: false,
      };
    }
    if (method === "model.test") return { ok: false, error: "预览模式不连接真实端点" };
    if (method === "model.save") return { ok: true, id: "m-preview" };
    if (method.startsWith("model.")) return { ok: true };
    if (method === "ui.plugins") {
      // 设计走查：与 plugins.list 同源（真机由 ~/.lynn/plugins 的启用状态决定）
      const plugins =
        process.env.LYNN_PREVIEW_CONSOLE === "1"
          ? [
              {
                id: "lynn.view.console",
                name: "沉浸控制台",
                version: "0.1.0",
                slots: ["stage.console"],
                source: "official",
                sandbox: false,
                view: "console",
                tier: "L0",
                enabled: true,
              },
            ]
          : [];
      return { plugins, errors: [] };
    }
    if (method === "plugins.list") {
      return {
        plugins: [
          {
            id: "lynn.view.console",
            name: "沉浸控制台",
            version: "0.1.0",
            tier: "L0",
            enabled: true,
            loadable: true,
            description: "整屏控制台视图：态势球 + 双流 + 军印",
            slots: ["stage.console"],
            view: "console",
          },
          {
            id: "lynn.theme.console",
            name: "沉浸控制台 · 配色",
            version: "1.0.0",
            tier: "L0",
            enabled: true,
            loadable: true,
            description: "给控制台视图配色的主题与样式",
            theme: {
              name: "沉浸控制台 · 配色",
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
    if (method === "persona.get") return { text: "## 语气与人设\n\n- 称呼用户为「你」；提到自己用「我」或「风铃」。\n- 简洁。汇报用短段落；不确定就问，不编造。\n" };
    if (method === "persona.versions") return { versions: [{ id: "p-abc", savedAt: new Date().toISOString(), chars: 128 }] };
    if (method === "workshop.list") return { drafts: [] };
    if (method === "window.control") return { ok: true, maximized: false };
    if (method === "i18n.get") {
      // 截图只验版式：直接给内置中文（与 src/shared/i18n-strings.ts 的 zh 同源，缺 key 回退键名）
      return { lang: "zh", strings: {}, sources: [] };
    }
    return { ok: true };
  },
  logError: (e) => {
    // 设计走查也要能看见 React 渲染崩溃：转发到 console，electron 主进程 console-message 事件可抓
    try { console.error("[react-error]", JSON.stringify(e)); } catch { /* 忽略 */ }
  },
  onEvent: (cb) => {
    // 设计走查：控制台视图要靠事件才有双流可看（真机由内核推送，这里按节奏喂样例）
    if (process.env.LYNN_PREVIEW_CONSOLE !== "1" || typeof cb !== "function") return () => {};
    const feed = [
      { type: "tool", badge: "派单", title: "派单 · 清理清洗两行数据", body: "把 63 行异常值退回来源，保留可核对的两列" },
      { type: "tool", badge: "工具", title: "run_command", body: "node scripts/aggregate.mjs --only-task-workspace" },
      { type: "tool", badge: "汇报", title: "回执 · 3 节分桶口径", body: "按周聚合已核对，第 3 节分桶口径待你定" },
      { type: "tool", badge: "需要你拍板", title: "分桶口径", body: "按自然周还是按交付周聚合？" },
      { type: "tool", badge: "审查", title: "自查 · 证据链", body: "2 条证据均已核对，产物落 artifacts/04" },
      { type: "done", tokens: 18432 },
    ];
    let i = 0;
    const timer = setInterval(() => {
      const ev = feed[i % feed.length];
      i += 1;
      try {
        cb(ev);
      } catch {
        /* 走查模式吞掉渲染层异常，别让截图脚本挂死 */
      }
    }, 700);
    return () => clearInterval(timer);
  },
});
