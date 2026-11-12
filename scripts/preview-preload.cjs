// 预览截图用的假桥：让渲染层在没有内核进程时也能拿到一份快照。
// 只在开发截图脚本里使用，不参与打包。这里的样例只服务截图，不是产品兜底数据。
const { contextBridge } = require("electron");

const now = "11-02 14:32";
const feed = [
  { id: "c1", kind: "user", createdAt: "14:30", jobId: "WO-2418", text: "把 issues_0914.csv 整理成周报，少一条要说明。",
    author: { kind: "user" } },
  {
    id: "c2",
    kind: "lynn",
    createdAt: "14:31",
    jobId: "WO-2418",
    author: { kind: "lynn", name: "风铃" },
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
  // 群聊：风铃点名 @成员（工具层强制），成员以本人名义交回报
  {
    id: "c8",
    kind: "user",
    createdAt: "14:31",
    text: "@顾明 这段口径按季度重出，别再按周聚合。",
    author: { kind: "user" },
    mentions: [{ kind: "member", name: "顾明", memberId: "顾明" }],
  },
  {
    id: "c3",
    kind: "tool",
    badge: "派单",
    title: "顾明 · WO-2418",
    meta: "截止 15:00",
    body: "@顾明 简报：读 issues_0914.csv，按 number 去重，输出 report_0914.md 第 3 节；附行数对账。",
    jobId: "WO-2418",
    author: { kind: "lynn", name: "风铃" },
    mentions: [{ kind: "member", name: "顾明", memberId: "顾明" }],
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
    author: { kind: "member", name: "顾明", memberId: "顾明", role: "数据整理员", avatarId: "a01", teamId: "t1" },
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
  // 走查：系统总结输出带表格/代码块，验证「不是一坨纯文本」
  {
    id: "c7",
    kind: "system",
    createdAt: "14:33",
    text: [
      "**上下文压缩完成**，账目如下：",
      "",
      "- 归档早期往来 12 条，保留最近 3 轮与全部工单编号",
      "- 未动任何卷宗文件；需要回看时按工单号检索",
      "",
      "| 项目 | 数量 | 处理 |",
      "| --- | --- | --- |",
      "| 早期往来 | 12 | 归档 |",
      "| 最近往来 | 8 | 保留 |",
      "| 工单编号 | 19 | 全留 |",
      "",
      "```ts",
      "const kept = cards.slice(-8);",
      "await archive(cards.slice(0, -8));",
      "```",
    ].join("\n"),
  },
  // 走查：系统消息分类（清理/巡检/预算/恢复/授权/错误），验证标签、图标与底色能一眼分开
  { id: "s1", kind: "system", title: "清理", systemTone: "cleanup", createdAt: "09:58", text: "已删除 3 张单：perm-locate-002、perm-audit-003、perm-audit-001（工单/卷宗/临时文件已清；共享工作区未改动）" },
  { id: "s2", kind: "system", title: "巡检", systemTone: "patrol", createdAt: "10:02", text: "心跳巡检（待审查 2 张）。机器事实已摆到桌面上，由风铃判断处置。" },
  { id: "s3", kind: "system", title: "预算提示", systemTone: "budget", createdAt: "10:04", text: "会话已用 82% 软预算，已切到备用模型。" },
  { id: "s4", kind: "system", title: "恢复", systemTone: "recover", createdAt: "10:05", text: "2 张单在上次运行时中断，已标成「卡住」。" },
  { id: "s5", kind: "system", title: "授权", systemTone: "auth", createdAt: "10:06", text: "已批准只读授权：F:\\TMP-RU~1" },
  { id: "s6", kind: "system", title: "需要注意", systemTone: "error", code: "E_PROVIDER", createdAt: "10:07", text: "端点 429：稍后自动重试。" },
  // 走查：最新跟踪进度在对话流底部，按步逐行（旧版是一张卡堆在顶部）
  {
    id: "c8",
    kind: "tool",
    badge: "进度",
    title: "顾明 · WO-2418",
    meta: "第 6 步 · 42s",
    createdAt: "14:34",
    body: [
      "读取 issues_0914.csv（1284 行）",
      "按 number 去重 → 1284 条唯一，无缺口",
      "生成第 3 节草稿",
      "写入 report_0914.md",
      "附行数对账日志 rowcount.log",
      "等待风铃验收",
    ].join("\n"),
  },
  // 走查：正在跑的任务，进度卡应亮起「执行中」脉冲（jobId 在 snapshot.running 内）
  {
    id: "c9",
    kind: "tool",
    badge: "进度",
    title: "阿黎 · WO-2420",
    jobId: "WO-2420",
    meta: "第 3 步 · 8s",
    createdAt: "14:35",
    body: [
      "browser_navigate → 超星学习平台",
      "browser_click #submit（登录）",
      "正在抓取第 3 门课进度…",
    ].join("\n"),
  },
];

// 走查：超长思考让对话流真的可滚，验证「贴底跟随」与细滚动条（不进产品数据）
if (process.env.LYNN_PREVIEW_LONGTHINK) {
  feed.push({
    id: "c6",
    kind: "lynn",
    createdAt: "14:33",
    streaming: true,
    text: "",
    thinking: Array.from({ length: 36 }, (_, i) =>
      `【阶段 ${i + 1}】核对第 ${i + 1} 批数据的编号与行数；缺一条就记进对账日志，先不急着改口径。`,
    ).join("\n"),
  });
}

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
          // 走查：同岗位空闲成员聚合（4 个「源码审查员」应收成一行 ×4，而不是铺 4 张卡）
          ...[1, 2, 3, 4].map((i) => ({
            name: `源码审查员${i}`,
            role: "源码审查工程师",
            goal: "对任意给定代码范围给出可复核的问题清单",
            status: "idle",
            statusNote: "空闲",
            progress: 0,
            budgetUsed: 0,
            budgetTotal: 300,
            rejections: 0,
            rejectionLimit: 3,
            toolWhitelist: ["read_file", "list_dir"],
            color: "#6fa892",
            avatarId: "a02",
            model: "deepseek-chat",
            turnLimit: 12,
          })),
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
            goal: "用浏览器完成需要交互的页面取数与表单操作",
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
        // 内置预览走查：交付箱里有一份可点开的报告
        deliverables: [
          { path: "report_0914.md", ref: "artifacts/report_0914.md", bytes: 2048 },
          { path: "rowcount.log", ref: "artifacts/rowcount.log", bytes: 512 },
        ],
        // 详情区走查：时间线只留两条有信息量的（session 与最后一条 transition 会被过滤）
        round: 2,
        timeline: [
          { at: "11-02 14:31", kind: "assign", text: "派给顾明：把 issues_0914.csv 整理成周报第 3 节" },
          { at: "11-02 14:32", kind: "session", text: "lynn-mwcvacuv" },
          { at: "11-02 14:34", kind: "report", text: "任务已重新派单，成员正在后台执行。正在等待回报，不做提前审核。" },
          { at: "11-02 14:35", kind: "note", text: "第 2 轮重做：沿用原工单，未新建工单" },
          { at: "11-02 14:36", kind: "transition", text: "→ in_review（待风铃验收）" },
        ],
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
      // 走查归档带折叠：满 11 条时默认只露 5 条、删除动作 hover 才显形
      ...(process.env.LYNN_PREVIEW_ARCHIVE_MANY
        ? Array.from({ length: 9 }, (_, i) => ({
            id: `task-mwbio-${String(i + 1).padStart(3, "0")}`,
            teamId: "t1",
            title: [
              "权限定位核对", "审计留痕归档", "插件扫描", "周报样例校验",
              "依赖清单复核", "日志切分", "索引重建", "缓存预热", "收尾对账",
            ][i],
            status: i % 3 === 0 ? "canceled" : "done",
            member: "顾明",
            at: "2026-10-24T09:12:00.000Z",
            evidenceCount: 0,
            version: 1,
            rejectRounds: 0,
            evidence: [],
          }))
        : []),
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

// 运行信号走查（LYNN_PREVIEW_RUN=1）：当前会话(t-main)真有一张在跑的单，
// 让「成员卡呼吸环 / 工单卡呼吸环 / 进度卡执行中」三处同时成立。
// 默认（无此 env）不触发，不影响已认可的正常截图。
if (process.env.LYNN_PREVIEW_RUN) {
  snapshot.board.track.push({
    id: "WO-2425",
    teamId: "t1",
    title: "周报第 3 节正在生成（浏览器抓对账数据）",
    status: "in_progress",
    statusNote: "in_progress · 阿计",
    member: "阿计",
    at: now,
    threadId: "t-main",
    evidenceCount: 0,
    version: 1,
    rejectRounds: 0,
    evidence: [],
  });
  // desk.running 由内核 runningTaskIds() 提供；夹具里直接对齐当前在跑单
  snapshot.running = ["WO-2425"];
  // 当前会话往来里加一张该单的进度卡，亮起「执行中」脉冲（jobId 命中 running）
  feed.push({
    id: "c10",
    kind: "tool",
    badge: "进度",
    title: "阿计 · WO-2425",
    jobId: "WO-2425",
    meta: "第 2 步 · 3s",
    createdAt: "14:36",
    body: [
      "browser_navigate → 对账后台",
      "browser_click #export（导出 CSV）",
      "正在解析第 3 节字段…",
    ].join("\n"),
  });
}

// 产出柜走查（LYNN_PREVIEW_OUT=1）：照真机那屏的样子造数据 ——
// 真交付物（docx/md，带字节数）+ 几条"整句话当 ref"的 command 证据。
// 旧版会把后者当文档卡铺一屏（「成员回报正文结论：…」+「文档 未核 …qnj8-5」），
// 新版必须只留真文件、能点开预览。
if (process.env.LYNN_PREVIEW_OUT) {
  const outJob = snapshot.board.track.find((t) => t.id === "WO-2418");
  if (outJob) {
    outJob.deliverables = [
      {
        path: "G:\\实习相关文件\\上海第二工业大学继续教育学院_毕业实习四方协议书_25工企Z11(2).docx",
        ref: "artifacts/毕业实习四方协议书.docx",
        bytes: 40045,
      },
      {
        path: "G:\\实习相关文件\\上海第二工业大学继续教育学院_毕业实习日志_25工企Z11(2).docx",
        ref: "artifacts/毕业实习日志.docx",
        bytes: 61244,
      },
      { path: "G:\\实习相关文件\\_build\\日志正文.md", ref: "artifacts/日志正文.md", bytes: 9210 },
      { path: "G:\\实习相关文件\\_build\\封面.png", ref: "artifacts/封面.png", bytes: 128000 },
      ...(outJob.deliverables || []),
    ];
    outJob.evidence = [
      ...outJob.evidence,
      {
        kind: "command",
        label: "成员回报正文结论：「共 4 个 .docx 文件 + 1 个空目录」",
        ref: "成员回报正文结论：「共 4 个 .docx 文件 + 1 个空目录」，逐文件核对见 §2",
        verified: false,
        at: now,
      },
      {
        kind: "command",
        label: "成员自述曾在 G:\\实习相关文件 下逐个打开过",
        ref: "成员自述曾在 G:\\实习相关文件 下逐个打开过，均为可解析 OOXML",
        verified: false,
        at: now,
      },
    ];
  }
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
    // 内置预览走查：假桥按后缀给内容，渲染层照常排版/高亮，不启外部程序
    if (method === "preview.pdfWindow") return { ok: true };
    if (method === "preview.read") {
      const ref = String(params?.ref || "report.md");
      const ext = ref.split(".").pop().toLowerCase();
      if (ext === "ts" || ext === "tsx") {
        return {
          ok: true, kind: "text", ext, bytes: 512,
          text: [
            "export function summarize(rows: Row[]): Summary {",
            "  // 编号去重后再对账，避免同一条被算两次",
            "  const seen = new Set<string>();",
            "  const kept = rows.filter((r) => !seen.has(r.number) && seen.add(r.number));",
            "  return { total: rows.length, unique: kept.length, gap: rows.length - kept.length };",
            "}",
          ].join("\n"),
        };
      }
      if (ext === "csv") {
        return { ok: true, kind: "text", ext, bytes: 240, text: "number,title,status\nA-1,登录超时,open\nA-2,导出为空,done\nA-3,排序错乱,open" };
      }
      if (ext === "log") {
        return { ok: true, kind: "text", ext, bytes: 512, text: "[14:31] read issues_0914.csv 1284 rows\n[14:32] dedupe by number -> 1284 unique\n[14:33] write report_0914.md section 3\n[14:34] verify rowcount 1284 == 1284" };
      }
      if (ext === "json") {
        return { ok: true, kind: "text", ext, bytes: 380, text: '{"task":"task-abc","status":"in_review","totals":{"rows":1284,"unique":1284},"steps":["读取源表","去重对账","写报告"]}' };
      }
      // docx：用真的 buildDocx 造一份（渲染层 docx-preview 走真解析，不是假 HTML）
      if (ext === "docx" || ext === "docm") {
        try {
          const { buildDocx } = require("../dist/main/docx.js");
          const buf = buildDocx({
            title: "周报 · 仓库评估结论",
            blocks: [
              { type: "heading", level: 1, text: "核对结论" },
              { type: "paragraph", text: "数据完整，条数可与源表逐条对齐。" },
              { type: "heading", level: 2, text: "核对过程" },
              { type: "table", headers: ["阶段", "产出"], rows: [["读取源表", "issues_0914.csv（1284 行）"], ["去重对账", "唯一编号 1284 条"]] },
            ],
          });
          return { ok: true, kind: "office", ext, bytes: buf.length, dataBase64: buf.toString("base64") };
        } catch {
          return { ok: true, kind: "binary", ext, bytes: 40045 };
        }
      }
      // xlsx / pptx：开源库渲染（mock 里没有真文件，给错误路径验降级文案）
      if (ext === "xlsx" || ext === "xlsm" || ext === "pptx") {
        return { ok: true, kind: "office", ext, bytes: 51200, dataBase64: Buffer.from("not a real office file").toString("base64") };
      }
      // pdf：沙箱 iframe 开不动阅读器，真机引导开独立预览窗口
      if (ext === "pdf") return { ok: true, kind: "pdf", ext, bytes: 88213 };
      // 其余二进制如实说（xlsx 真机会带替代路径提示）
      if (/^(xlsx?|pptx?|zip|rar|7z|et|wps|dps)$/.test(ext)) {
        return { ok: true, kind: "binary", ext, bytes: 40045 };
      }
      // 图片：给一张真图（内联 SVG），验卡面缩略图与抽屉内嵌渲染
      if (/^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext)) {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100">' +
          '<rect width="160" height="100" fill="#22313a"/>' +
          '<rect x="16" y="22" width="72" height="9" fill="#8fa9b3"/>' +
          '<rect x="16" y="42" width="122" height="6" fill="#4a5f6a"/>' +
          '<rect x="16" y="56" width="96" height="6" fill="#4a5f6a"/>' +
          '<rect x="16" y="70" width="108" height="6" fill="#4a5f6a"/></svg>';
        return { ok: true, kind: "image", ext, bytes: 128000, dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
      }
      return {
        ok: true, kind: "text", ext: ext || "md", bytes: 2048,
        text: [
          "# 周报第 3 节 · 仓库评估结论",
          "",
          "**结论**：数据完整，条数可与源表逐条对齐。",
          "",
          "## 核对过程",
          "",
          "1. 读取 `issues_0914.csv`，共 1284 行",
          "2. 按 `number` 去重，仍为 1284 条，无缺口",
          "3. 生成第 3 节并附行数对账日志",
          "",
          "| 检查项 | 源表 | 报告 | 结果 |",
          "| --- | --- | --- | --- |",
          "| 总行数 | 1284 | 1284 | 一致 |",
          "| 唯一编号 | 1284 | 1284 | 一致 |",
          "| 缺失来源 | 0 | 0 | 通过 |",
          "",
          "> 验收标准：条数对得上、每条都有来源。",
          "",
          "```ts",
          "const gap = source.length - unique.length;",
          "if (gap !== 0) throw new Error(`缺 ${gap} 条`);",
          "```",
        ].join("\n"),
      };
    }
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
    if (method === "gateway.list") {
      return {
        gateways: [
          { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, docsUrl: "https://ollama.com/download", note: "本地模型，不联网；需要先 ollama serve。", status: "running", latencyMs: 8, modelCount: 3 },
          { id: "ofm", name: "OFM 免费模型网关", baseUrl: "http://127.0.0.1:18900/v1", needsKey: true, docsUrl: "https://github.com/Ebony-Vinyl/dsh-our-free-model", note: "第三方免费池；只建议非敏感数据。", status: "needs_key" },
        ],
      };
    }
    if (method === "model.discover") {
      return { ok: true, models: [{ id: "free-a", ownedBy: "ofm" }, { id: "free-b" }], latencyMs: 12, url: "http://127.0.0.1:18899/v1/models" };
    }
    if (method === "model.health") return { ok: true, latencyMs: 12, modelCount: 3, via: "models" };
    if (method === "app.openExternal") return { ok: true };
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
            riskLevel: "remote",
            riskAccepted: true,
          }]
          : [],
        defaultModelId: m.configured ? id : null,
        threadModelId: null,
        activeModelId: m.configured ? id : null,
        threadTitle: snapshot.thread?.title ?? "新会话",
      };
    }
    // 成员战绩：走查时给一份可读的成绩，验证「点开才拉」这条按需通路
    if (method === "team.member.record") {
      return { tasks: 7, accepted: 5, rejected: 1, escalations: 1 };
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
