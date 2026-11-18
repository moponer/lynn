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
    // 长回报走查（2026-11-13）：1200+ 字全铺开会把一屏占满 → 应折叠成前几行 + 「展开全文」
    body:
      "【完成有保留】报告已写完并写入 audit-report.md，共 19 条隐患。\n" +
      "覆盖：安全 11 条、性能 3 条、架构 2 条、代码质量 3 条。\n" +
      "其中 7 条为「待进一步验证」：主要是 src/renderer/ 未覆盖区域与具体实现现状的差异，" +
      "需要拿到运行期数据或补充动态执行才能定性；本次仅为只读静态通读，未运行构建、未跑测试、未修改源码。\n" +
      "重点问题（按严重度）：\n" +
      "1. 主进程 IPC 通道缺少入参校验，渲染层可传入任意路径触发文件读写边界外的读取；\n" +
      "2. 插件加载器对 L1 入口未做路径逃逸二次校验，依赖了外层 resolveWithin；\n" +
      "3. 会话落盘为全量重写，崩溃时可能截断 json，缺原子写；\n" +
      "4. 成员运行的删除类命令审批只做字符串前缀匹配，可被拼接绕过；\n" +
      "5. run_command 的 120s 超时未杀进程树，超时后子进程仍可能存活；\n" +
      "6. HTML 预览用 dangerouslySetInnerHTML 渲染产物，未做 CSP 收敛；\n" +
      "7. electron-builder.yml 未签名，安装包可被替换；\n" +
      "8. 日志里落过模型 Key 的明文片段，需脱敏。\n" +
      "建议先修 1、4、8（改动小、收益直接），其余进入专项。",
    jobId: "WO-2418",
    author: { kind: "member", name: "顾明", memberId: "顾明", role: "数据整理员", avatarId: "a01", teamId: "t1" },
    // 战报（report_to_user 落进 feed 的那份）：战果抽屉按 jobId 取最近一条
    report: {
      conclusion: "第 3 节已写完，条数从 1284 对到 1284，无缺口。",
      evidence: "report_0914.md · rowcount.log",
      unfinished: "按来源拆分的那张表还差两家",
      decision: "要不要现在补那两家，还是随下期一起",
    },
    // 产物 chip（2026-11-13）：右键可定位文件 / 复制路径
    artifacts: [
      { label: "周报第 3 节", ref: "artifacts/report_0914.md", bytes: 5120 },
      { label: "行数对账日志", ref: "artifacts/rowcount.log", bytes: 512 },
    ],
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
  // 走查：群里 @ 了成员但风铃还没接住 → 该卡要标「待风铃处理」
  {
    id: "c9",
    kind: "user",
    createdAt: "14:34",
    text: "@林工 这张表的第二列按季度重出，别按周。",
    author: { kind: "user" },
    mentions: [{ kind: "member", name: "林工", memberId: "林工" }],
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

// 走查：群内协作（2026-11-16）——成员像同事一样发进展/结论/疑问，风铃当场回答。
// 这三条不是"进度流水"：进展/结论不打断人，疑问要风铃接；回答是 she 在群里说的话。
if (process.env.LYNN_PREVIEW_DIALOGUE) {
  feed.push(
    {
      id: "c-dlg1",
      kind: "tool",
      badge: "进展",
      title: "顾明 · WO-2418",
      meta: "第 4 步 · 22s",
      jobId: "WO-2418",
      author: { kind: "member", name: "顾明", memberId: "顾明", role: "数据分析", avatarId: "a02", teamId: "t1" },
      body: "去重口径先按 number 走完了，1284 条唯一、没有缺口。下一步把季度聚合落到第 3 节。",
      createdAt: "14:36",
    },
    {
      id: "c-dlg2",
      kind: "tool",
      badge: "结论",
      title: "顾明 · WO-2418",
      meta: "第 5 步 · 35s",
      jobId: "WO-2418",
      author: { kind: "member", name: "顾明", memberId: "顾明", role: "数据分析", avatarId: "a02", teamId: "t1" },
      body: "按季度聚合比按周少 3 条，差的是只有月份没有日期的三条记录（2026-09）——它们会被丢掉，不是重复。",
      createdAt: "14:37",
    },
    {
      id: "c-dlg3",
      kind: "tool",
      badge: "疑问",
      title: "顾明 · WO-2418",
      meta: "等你答复",
      jobId: "WO-2418",
      author: { kind: "member", name: "顾明", memberId: "顾明", role: "数据分析", avatarId: "a02", teamId: "t1" },
      body: "这三条只有月份的记录要算进季度合计吗？按含税还是不含税？简报里没写，我先按不含税做，你确认下。",
      createdAt: "14:38",
    },
    {
      id: "c-dlg4",
      kind: "lynn",
      createdAt: "14:39",
      jobId: "WO-2418",
      author: { kind: "lynn", name: "风铃" },
      text: "@顾明 算进合计，按不含税；那三条另开一行备注「日期缺失」，别丢。",
      mentions: [{ kind: "member", name: "顾明", memberId: "顾明" }],
    },
  );
}

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

// 长回报走查（2026-11-13）：成员回报动辄千字，全铺开会把一屏占满
// → 应折成前几行 + 「展开全文」。这张卡不带 report 字段，走的就是派单收尾那条真实形状。
if (process.env.LYNN_PREVIEW_LONGREPORT) {
  feed.push({
    id: "c-longreport",
    kind: "tool",
    badge: "回报",
    title: "代码审计员 回报 · task-audit",
    meta: "9 轮 · 132s",
    jobId: "WO-2418",
    author: { kind: "member", name: "代码审计员", memberId: "代码审计员", role: "代码审计", avatarId: "a03", teamId: "t1" },
    body:
      "【完成有保留】代码审计报告已完成，已写入 audit-report.md 并回读验证。覆盖 19 条隐患：\n" +
      "安全 11 条、性能 3 条、架构 2 条、代码质量 3 条。其中 7 条「待进一步验证」：\n" +
      "主要是 src/renderer/ 未覆盖区域与具体实现现状的差异，需要运行期数据才能定性。\n" +
      "本次仅为只读静态通读，未运行构建、未跑测试、未修改源码。\n" +
      "1. IPC 通道缺少入参校验，可触发边界外读取；\n2. 插件加载器未做路径逃逸二次校验；\n" +
      "3. 会话落盘全量重写、非原子；\n4. 删除类命令审批只做前缀匹配；\n" +
      "5. run_command 超时不杀进程树；\n6. HTML 预览未收敛 CSP；\n7. 安装包未签名；\n8. 日志落过明文 Key 片段。\n" +
      "建议先修 1、4、8 三条（改动小、收益直接），其余进入专项：\n" +
      "1 加一层入参白名单；4 改成解析命令结构再判；8 用脱敏正则兜住日志写入。" +
      "补证计划：拿到运行期数据后重跑一遍动态检查，把 7 条待验证收敛成结论或排除；" +
      "预计半天，需要一次构建与一次端到端跑批。",
    createdAt: "14:36",
  });
}

// 表格回报走查（2026-11-15）：成员把环境自检写成 Markdown 表格。
// 此前表头被压成竖排（"实测结果"一列一个字）、python 被切成 pyt/hon，
// 展开后仍被 320px 的内层滚动框截住，还看不到滚动条。
if (process.env.LYNN_PREVIEW_TABLEREPORT) {
  feed.push({
    id: "c-tablereport",
    kind: "tool",
    badge: "回报",
    title: "环境检测员 回报 · task-env",
    meta: "6 轮 · 78s",
    jobId: "WO-2419",
    author: { kind: "member", name: "环境检测员", memberId: "环境检测员", role: "环境核查", avatarId: "a05", teamId: "t1" },
    body:
      "【完成】环境自检已跑完，逐项实测结果如下（只读检查，未改动任何系统配置）。\n\n" +
      "| 项 | 实测结果 | 关键原始输出 |\n" +
      "| --- | --- | --- |\n" +
      "| python | 存在 | Python 3.13.12（exit=0） |\n" +
      "| python3 | 不存在 | ERR：无法将“python3”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。 |\n" +
      "| py | 存在 | Python 3.13.12（exit=0） |\n" +
      "| node | 可用 | v26.12.1（exit=0） |\n" +
      "| npm | 可用 | 11.20.0（exit=0） |\n" +
      "| ffmpeg | 可用 | ffmpeg version 8.1.1-essentials_build-www.gyan.dev（-version 被当作参数，报 Unrecognized option；编码实测正常） |\n" +
      "| ffprobe | 可用 | ffprobe version 8.1.1-essentials_build-www.gyan.dev（同上，命令可执行） |\n" +
      "| git | 可用 | git version 2.51.0.windows.1（exit=0） |\n\n" +
      "结论：Python 与 Node 工具链齐备；python3 这个别名在本机不存在，脚本里统一写 python 或 py。\n" +
      "未做：没有跑任何需要联网的安装命令。",
    createdAt: "14:52",
  });
}

const avatarPicks = {};
const snapshot = {
  workspace: {
    project: "我的笔记",
    subdir: "值台",
    primary: "F:/spiker/my-notes",
    // 项目身份（2026-11-12）：走查要看得见项目条与群列表的项目名
    projectId: "pj-preview-my-notes",
    projectName: "我的笔记",
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
        // 队→群归属（2026-11-12）：右栏按群分家，组头可跳过去
        threadId: "t-main",
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
            // 消耗看板走查（2026-11-13）
            cacheUsed: 13.1,
            hitRate: 72.8,
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
            cacheUsed: 3.3,
            hitRate: 55.2,
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
          // 验收员（2026-11-16）：走查消耗看板里「验收」身份标会不会把名字列挤爆
          {
            name: "验收员",
            role: "验收",
            goal: "只验收不执行：按完成标准逐条核对成员回报",
            status: "review",
            statusNote: "正在验收",
            progress: 60,
            budgetUsed: 180,
            budgetTotal: 300,
            cacheUsed: 112.5,
            hitRate: 62.5,
            rejections: 0,
            rejectionLimit: 3,
            toolWhitelist: ["read_file", "list_dir", "submit_report"],
            color: "#b07d3a",
            avatarId: "a11",
            model: "deepseek-chat",
            turnLimit: 8,
            acceptor: true,
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
      {
        // 走查：别群的队——右栏应折叠在「其他群」下面，不与本群混排
        id: "t3",
        name: "竞品调研组",
        status: "active",
        threadId: "t-2",
        members: [
          {
            name: "周禾",
            role: "竞品调研",
            goal: "把同类产品的做法摸清楚",
            status: "idle",
            statusNote: "空闲",
            progress: 0,
            budgetUsed: 0,
            budgetTotal: 300,
            rejections: 0,
            rejectionLimit: 3,
            toolWhitelist: ["read_file", "list_dir"],
            color: "#d08a4e",
            avatarId: "a09",
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
        // LYNN_PREVIEW_HEAVY=1：模拟"标题是整段话 + 22 项证据"的重载单，专治一堵墙
        title: process.env.LYNN_PREVIEW_HEAVY
          ? "背景：用户问「分析项目，如何开发插件」。项目根目录是 F:/spiker/lynn，只做两件事：读官方指南 + 写一份规范速查。"
          : "把 issues_0914.csv 整理成周报第 3 节",
        status: "in_review",
        statusNote: process.env.LYNN_PREVIEW_HEAVY ? "in_review · 探针 · 证据 22" : "in_review · 顾明 · 证据 2",
        member: process.env.LYNN_PREVIEW_HEAVY ? "探针" : "顾明",
        at: now,
        // 交付物「查看所属」要报项目（2026-11-13）
        projectName: "我的笔记",
        // C3 演示：这张单是另一个会话派的——眉标出「回到会话」，印章头出「来自会话」
        threadId: "t-2",
        // 只读授权演示：图纸上会显示「只读授权：…」
        readRoots: ["F:/spiker/hermix-desktop"],
        // 成员读写工作区演示：图纸上会显示「成员工作区（可读写…）」
        workspaceRoot: "F:/spiker/hermix-desktop",
        evidenceCount: process.env.LYNN_PREVIEW_HEAVY ? 22 : 2,
        // 内置预览走查：交付箱里有一份可点开的报告
        // 彩色类型图标走查（2026-11-15）：一份交付里凑齐表格/PDF/图片/音频/压缩包/文档
        deliverables: [
          { path: "report_0914.md", ref: "artifacts/report_0914.md", bytes: 2048 },
          { path: "rowcount.log", ref: "artifacts/rowcount.log", bytes: 512 },
          { path: "季度汇总.xlsx", ref: "artifacts/quarterly.xlsx", bytes: 18240 },
          { path: "评审结论.pdf", ref: "artifacts/review.pdf", bytes: 220000 },
          { path: "封面.png", ref: "artifacts/cover.png", bytes: 96000 },
          { path: "会议录音.mp3", ref: "artifacts/meeting.mp3", bytes: 3145728 },
          { path: "交付包.zip", ref: "artifacts/delivery.zip", bytes: 745000 },
          { path: "说明.docx", ref: "artifacts/readme.docx", bytes: 12000 },
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
        // 阶段账摘要（2026-11-15）：台账一行看见"走到第几段"
        stage: { done: 2, total: 4, current: "独立验收" },
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
      // LYNN_PREVIEW_APPROVE=1：走查审批卡（带 family 才有「这类以后都允许」）
      ...(process.env.LYNN_PREVIEW_APPROVE === "1"
        ? [
            {
              id: "dc-approve",
              threadId: "t-main",
              from: "顾明",
              title: "顾明 要删除文件（WO-2418）",
              detail: "命令：del issues_0914.bak\n工作区：tasks/WO-2418/workspace",
              kind: "approval",
              family: "delete",
              jobId: "WO-2418",
              at: "11-02 14:40",
            },
          ]
        : []),
      {
        id: "dc-plan",
        threadId: "t-main",
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
          // 契约卡要回答「动哪个项目、落在哪个目录」（2026-11-15 控制台补齐）
          projectName: "我的笔记",
          workspaceRoot: "F:/spiker/my-notes",
        },
      },
      {
        id: "dc-ask",
        threadId: "t-main",
        from: "顾明",
        title: "周报要按自然周还是按交付周聚合？",
        detail: "影响第 3 节的分桶口径",
        kind: "question",
        at: "11-02 14:40",
      },
      {
        id: "dc-appr",
        threadId: "t-main",
        from: "顾明",
        title: "允许运行 run_command：node scripts/aggregate.mjs",
        detail: "只读工作区脚本，输出落 tasks/WO-2418/workspace/",
        kind: "approval",
        jobId: "WO-2418",
        // 族级放行：控制台要给出「这类以后都准」（2026-11-15）
        family: "delete",
        at: "11-02 14:41",
      },
    ].filter(Boolean),
    tokensUsed: 21400,
  },
  turn: { phase: "review", busy: false, pending: 0, taskId: "WO-2418" },
  // 消耗看板（2026-11-13）：带缓存字段，走查命中率行
  usage: {
    turnIn: 3120, turnOut: 860, sessionIn: 18400, sessionOut: 3000,
    cacheRead: 210000, cacheWrite: 0, turnHitRate: 96.5,
    contextTokens: 42000, contextWindow: 1000190, contextPercent: 4.2,
  },
  queue: [],
  // D3：配了软上限才出预算 chip（60000 × 21400 累计 ≈ 36%）
  prefs: {
    autoStart: false, trayOnClose: true, notify: true, lang: "zh", softBudgetTokens: 60000,
    voiceEnabled: true, voiceId: "zh-CN-XiaoxiaoNeural", voiceRate: "+0%", voiceVolume: "+0%",
    voiceScope: "brief", voiceMaxChars: 120, voiceWhenHidden: false, voiceProxy: "",
    advisorEnabled: true,
  },
  project: {
    root: "C:/Users/demo/notes",
    trusted: true,
    hasMcp: false,
    // 信任闸门只管这两样（2026-11-13）：都没有 = 无所谓信不信
    gated: { mcp: false, skills: false },
  },
  // LYNN_PREVIEW_EMPTY=1：走查"最后一条会话也删掉"之后的空场
  thread: process.env.LYNN_PREVIEW_EMPTY
    ? { id: "", title: "" }
    : { id: "t-main", title: "月报整理", halted: false },
  threads: process.env.LYNN_PREVIEW_EMPTY
    ? []
    : [
        {
          id: "t-main",
          title: "月报整理",
          updatedAt: "2026-11-02T14:32:00.000Z",
          counts: { active: 1, archived: 2 },
          pinned: true,
          lastPreview: "顾明：第 3 节已写完，条数从 1284 对到 1284，无缺口。",
          lastAt: "2026-11-02T14:32:00.000Z",
          // 项目身份（2026-11-12）：群列表里要显示这个群在做哪个项目
          projectId: "pj-preview-my-notes",
          projectName: "我的笔记",
          announcement:
            "整体：把 issues_0914.csv 整理成周报第 3 节，按「问题—处理—结果」三段式排版，正文不少于两千字，数据段必须和计算口径对得上。\n顾明：清洗源表并出 clean.csv，缺失值单列说明，不要随手填零。\n周禾：对账并出差异表，逐条标注差异来源，别只给汇总。\n接缝：顾明的清洗结果交给周禾，别两边各做一半；谁改了共享目录要在这说一声。\n共享写入点：q3/ 目录归周禾，其他人只读；最终稿由风铃汇总后交你拍板。",
        },
        {
          id: "t-2",
          title: "插件工坊",
          updatedAt: "2026-11-01T10:05:00.000Z",
          counts: { active: 1, archived: 0 },
          lastPreview: "风铃：草稿已生成，等你点「发布」。",
          lastAt: "2026-11-01T10:05:00.000Z",
          projectId: "pj-preview-hermix",
          projectName: "hermix-desktop",
        },
      ],
};

// 交付箱去重夹具（LYNN_PREVIEW_DUPOUT=1）：后一张单**原地更新了同一个文件**。
// 实机症状：audit-report.md 在交付箱里出现两次（任务号不同）。
if (process.env.LYNN_PREVIEW_DUPOUT) {
  const src = snapshot.board.track.find((t) => t.id === "WO-2418");
  if (src) {
    snapshot.board.track.push({
      ...src,
      id: "WO-2499",
      title: "代码审计（二轮深入）",
      status: "done",
      statusNote: "done · 顾明",
      at: "2026-11-13T12:33:00.000Z",
      // 同一个物理文件：路径一致、内容更新过、体积更大
      deliverables: [{ path: "report_0914.md", ref: "artifacts/report_0914-v2.md", bytes: 3072 }],
    });
  }
}

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

// LYNN_PREVIEW_SEAL=1：本群挂一张"等你验收"的单，专供走查
// 「终止任务之后印章该消失」（2026-11-15）。默认不挂——否则所有走查图都会多一枚印章。
if (process.env.LYNN_PREVIEW_SEAL) {
  // 没有挂起的契约/提问、也没有本群卡住的单，印章区才会露出「验收归档 / 打回重做」那一枚
  // （这才是实机截图里那枚；卡住卡优先级更高，会把它顶掉）
  snapshot.board.decisions = [];
  snapshot.board.track = snapshot.board.track.filter(
    (t) => !(t.status === "blocked" && (!t.threadId || t.threadId === "t-main")),
  );
  snapshot.board.track.push({
    id: "task-seal",
    teamId: "t1",
    title: "音频运行诊断：把 11 月 15 日的异常段整理成结论",
    status: "in_review",
    statusNote: "in_review · 音频运行诊断员 · 证据 2",
    member: "音频运行诊断员",
    reviewer: "user",
    at: new Date(Date.now() - 3 * 60_000).toISOString(),
    threadId: "t-main",
    evidenceCount: 2,
    version: 2,
    rejectRounds: 0,
    evidence: [
      { label: "audio-report.md", ref: "artifacts/report_0914.md", verified: true, at: new Date().toISOString() },
      { label: "timeline.json", ref: "artifacts/report_0914.md", verified: true, at: new Date().toISOString() },
    ],
  });
}

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
  // 语音播报：设计走查不真合成，也不真播放
  onVoice: () => () => {},
  rpc: async (method, params) => {
    if (method === "session.snapshot") return snapshot;
    // 新建群（2026-11-15）：假桥也得真的换当前群，才能走查「新群右栏不该挂着别群的等你拍板」。
    // 裁决保留在 board 里（带 threadId=t-main），由渲染层按当前群过滤，跟真内核的快照口径一致。
    if (method === "session.new") {
      const id = `th-new-${Date.now().toString(36)}`;
      snapshot.threads.unshift({ id, title: "新群", updatedAt: new Date().toISOString(), unread: 0 });
      snapshot.thread = { id, title: "新群" };
      snapshot.announcement = "";
      snapshot.feed = [];
      return { ok: true, threadId: id };
    }
    // 切群（2026-11-12）：右栏「去那个群」组头要真能跳——假桥也得认这件事
    if (method === "thread.switch") {
      const id = String(params?.id ?? "");
      const target = snapshot.threads.find((t) => t.id === id);
      if (!target) return { ok: false, error: "没有这个群" };
      snapshot.thread = { id: target.id, title: target.title, ...(target.halted ? { halted: true } : {}) };
      // 公告跟着当前群走（否则公告永远停在第一个群）
      snapshot.announcement = target.announcement ?? "";
      return { ok: true, thread: { id: target.id, title: target.title } };
    }
    // 终止本群（2026-11-15）：成员停机 + 心跳/巡检全停，发消息才恢复
    if (method === "thread.halt") {
      const id = String(params?.id || snapshot.thread?.id || "");
      if (!id) return { ok: false, stopped: 0, threadId: "", error: "没有可终止的群" };
      if (snapshot.thread && snapshot.thread.id === id) snapshot.thread.halted = true;
      const meta = snapshot.threads.find((t) => t.id === id);
      if (meta) meta.halted = true;
      snapshot.running = [];
      return { ok: true, stopped: 1, threadId: id };
    }
    // 内置预览走查：假桥按后缀给内容，渲染层照常排版/高亮，不启外部程序
    if (method === "preview.pdfWindow") return { ok: true };
    if (method === "preview.read") {
      const ref = String(params?.ref || "report.md");
      const ext = ref.split(".").pop().toLowerCase();
      // 音频走查（2026-11-15）：现场合成 1 秒 440Hz WAV，播放器能真点开
      if (ext === "mp3" || ext === "wav" || ext === "m4a" || ext === "flac" || ext === "ogg") {
        // 注意：preload 里没有 Node 的 Buffer（沙箱环境），只用 Uint8Array + DataView + btoa
        const rate = 8000;
        const n = rate;
        const bytes = new Uint8Array(44 + n * 2);
        const dv = new DataView(bytes.buffer);
        const ascii = (off, s) => {
          for (let i = 0; i < s.length; i += 1) bytes[off + i] = s.charCodeAt(i);
        };
        ascii(0, "RIFF");
        dv.setUint32(4, 36 + n * 2, true);
        ascii(8, "WAVE");
        ascii(12, "fmt ");
        dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true);
        dv.setUint32(28, rate * 2, true);
        dv.setUint16(32, 2, true);
        dv.setUint16(34, 16, true);
        ascii(36, "data");
        dv.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i += 1) {
          dv.setInt16(44 + i * 2, Math.round(Math.sin(((i / rate) * 2 * Math.PI * 440)) * 8000), true);
        }
        let bin = "";
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
        return { ok: true, kind: "audio", ext, bytes: bytes.length, dataUrl: `data:audio/wav;base64,${btoa(bin)}` };
      }
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
    if (method === "app.pickDir") {
      // LYNN_PREVIEW_PICKDIR=1：假装用户真选了一个目录（走查信任询问用）
      if (process.env.LYNN_PREVIEW_PICKDIR) return { path: process.env.LYNN_PREVIEW_PICKDIR };
      return { canceled: true };
    }
    if (method === "app.pickDirs") return { canceled: true };
    if (method === "project.setRoot") {
      return {
        ok: true,
        root: "F:/spiker/hermix-desktop",
        trusted: false,
        // 这个目录里有项目级技能 → 界面会当场问「信任并加载 / 先不信任」
        gated: { mcp: true, skills: true },
        project: { id: "pj-preview-hermix", name: "hermix-desktop" },
      };
    }
    if (method === "project.clearRoot") return { ok: true };
    // 项目身份（2026-11-12）：预览没有真项目库，给一份能改名能切的项目
    if (method === "project.list") {
      return {
        projects: [
          { id: "pj-preview-my-notes", name: "我的笔记", path: "F:/spiker/my-notes" },
          { id: "pj-preview-hermix", name: "hermix-desktop", path: "F:/spiker/hermix-desktop" },
        ],
        current: { id: "pj-preview-my-notes", name: "我的笔记", path: "F:/spiker/my-notes" },
      };
    }
    if (method === "project.rename") {
      return { ok: true, id: String(params?.id ?? ""), name: String(params?.name ?? "") };
    }
    if (method === "project.use") {
      return { ok: true, id: String(params?.id ?? ""), name: "我的笔记", root: "F:/spiker/my-notes" };
    }
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
    if (method === "config.prefs") return { ok: true, autoStart: false, ...snapshot.prefs };
    if (method === "voice.voices") return { voices: [{ id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 温柔女声", locale: "zh-CN" }] };
    if (method === "voice.preview") return { ok: true };
    if (method === "voice.stop") return { ok: true };
    if (method === "voice.status") return { enabled: snapshot.prefs.voiceEnabled, queued: 0, lastError: null };
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
    // 群聊走查：成员资料卡（右键成员 → 查看资料）
    if (method === "team.member.detail") {
      return {
        ok: true,
        profile: {
          name: String(params?.name || "顾明"),
          role: "数据整理",
          goal: "把源数据整理成可核对的周报",
          boundaries: ["只动工作区", "不碰源材料"],
          tools: ["read_file", "write_file", "run_command"],
          model: "deepseek-chat",
          limits: { maxTurns: 12, budgetTokens: 300000, wallClockMin: 30 },
          outputContract: {
            deliverable: "report_0914.md",
            evidence: ["报告文件", "行数对账日志"],
            acceptance: ["条数对得上", "每条有来源"],
          },
          escalateWhen: "材料缺失或口径冲突",
          body: "先对账，再出稿；条数对不上就上报，不自行补数。",
          avatarId: "a01",
        },
        record: { tasks: 7, accepted: 5, rejected: 1, escalations: 1 },
        job: { id: "WO-2418", title: "把 issues_0914.csv 整理成周报第 3 节", status: "in_review" },
      };
    }
    // 群聊走查：工单详情（右键成员 → 任务目标 / 进度）
    if (method === "task.detail") {
      return {
        ok: true,
        detail: {
          id: String(params?.taskId || "WO-2418"),
          title: "把 issues_0914.csv 整理成周报第 3 节",
          member: "顾明",
          teamId: "t1",
          status: "in_review",
          statusNote: "in_review · 顾明 · 证据 2",
          goal: "把 issues_0914.csv 整理成周报第 3 节",
          acceptance: ["条数从 1284 对到 1284", "每条都有来源"],
          workspaceRoot: "F:/spiker/lynn",
          deliverables: [{ label: "report_0914.md", ref: "artifacts/report_0914.md", bytes: 2048 }],
          timeline: [
            { at: "14:31", kind: "report", text: "成员回报：第 3 节已写完" },
            { at: "14:30", kind: "step", text: "写入 report_0914.md" },
          ],
        },
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
    // 关于页要显示版本号（走查里不假装能检查更新，理由如实写）
    if (method === "update.status")
      return { supported: false, reason: "走查环境不检查更新", version: "0.0.1", phase: "idle" };
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
    // 版本历史（2026-11-16）：照实机的一组（同日多版、字符数上下跳），
    // 否则走查看不到「字符差 / 最近标」这两个新东西
    if (method === "persona.versions") {
      const base = Date.parse("2026-11-13T20:20:23");
      const chars = [1722, 938, 938, 1621, 1621, 819, 819];
      return {
        versions: chars.map((c, i) => ({
          id: `p-${i}`,
          savedAt: new Date(base - i * 9 * 60 * 1000).toISOString(),
          chars: c,
        })),
      };
    }
  // 去 AI 味（2026-11-15）：预览里插件是真装着的（仓库就在旁边），所以如实报 loaded
  if (method === "humanizer.status") return { enabled: true, loaded: true, dir: "~/.lynn/plugins/humanizer-stream", version: "0.1.0" };
    if (method === "workshop.list") {
      return {
        drafts: [
          {
            draftId: "d-0914",
            title: "周报分桶口径插件",
            kind: "L0",
            createdAt: new Date(Date.now() - 3_600_000).toISOString(),
            status: "draft",
          },
        ],
      };
    }
    if (method === "workshop.promote") return { ok: true, id: "lynn.tool.preview", tier: "L0", byUser: true };
    if (method === "workshop.discard") return { ok: true };
    // 能力中心（2026-11-15）：预置清单 + 外部应用连接（走查要看齐五段与开关）
    if (method === "plugins.toggle") return { ok: true };
    if (method === "plugins.probe") return { ok: true, detail: "试装通过（预览）" };
    if (method === "plugins.rollback") return { ok: true, detail: "已回滚（预览）" };
    if (method === "plugins.safeMode") return { ok: true };
    if (method === "skills.list") {
      return {
        skills: [
          {
            name: "docx-report",
            description: "正式 Word 报告的结构、排版与交付前自检",
            allowedTools: ["office_write_docx", "read_file", "write_file"],
            level: "user",
            dir: "C:/Users/demo/.lynn/skills/docx-report",
            disabled: false,
            warnings: [],
          },
          {
            name: "plugin-dev",
            description: "插件开发与验收：档位选型、工坊流程与验收标准",
            allowedTools: ["create_plugin_draft", "assign_task", "ship_plugin"],
            level: "user",
            dir: "C:/Users/demo/.lynn/skills/plugin-dev",
            disabled: false,
            warnings: [],
          },
          {
            name: "text-check",
            description: "写稿/改稿前的文本体检",
            allowedTools: ["text_check", "read_file"],
            level: "plugin",
            dir: "C:/Users/demo/.lynn/plugins/lynn.tool.textstat",
            disabled: true,
            warnings: [],
          },
        ],
        errors: [],
      };
    }
    if (method === "skills.toggle") return { ok: true, enabled: true };
    if (method === "mcp.toggle") return { ok: true };
    if (method === "cap.presets") {
      return {
        presets: [
          {
            kind: "plugin",
            id: "lynn.tool.textstat",
            name: "文本体检",
            summary: "统计字数/中英文占比/句长分布/重复短语，写稿前先量一遍",
            source: "lynn 官方预置（自研，零依赖）",
            license: "MIT",
            requires: "无（随内核加载）",
            icon: "pkg",
            skill: "text-check",
            installed: true,
            skillReady: true,
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
            skill: "csv-profile",
            installed: false,
            skillReady: false,
          },
          {
            kind: "mcp",
            id: "filesystem",
            name: "文件系统",
            summary: "在指定目录内列目录、读文件、搜索（官方 server）",
            source: "@modelcontextprotocol/server-filesystem",
            license: "MIT",
            requires: "Node.js（npx 首次会联网安装）",
            icon: "file",
            skill: "mcp-filesystem",
            installed: true,
            skillReady: true,
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
            skill: "mcp-memory",
            installed: false,
            skillReady: false,
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
            skill: "data-audit",
            installed: true,
            skillReady: true,
          },
          {
            kind: "skill",
            id: "web-research",
            name: "调研取证",
            summary: "外部调研的来源分级、交叉验证与结论写法",
            source: "lynn 官方预置（自写工作流）",
            license: "MIT",
            requires: "能联网（浏览器或 fetch 工具）",
            icon: "globe",
            skill: "web-research",
            installed: false,
            skillReady: false,
          },
          {
            kind: "schedule",
            id: "daily-standup",
            name: "每日开工巡检",
            summary: "每天 09:30 汇总在办工单、待审查、卡住的单",
            source: "lynn 官方预置",
            license: "MIT",
            requires: "心跳/调度已启用",
            icon: "clock",
            installed: false,
          },
        ],
      };
    }
    if (method === "cap.install") {
      const p = params || {};
      return { ok: true, detail: `${p.id} 已装上（预览）`, id: String(p.id || ""), created: true };
    }
    if (method === "connectors.list") {
      const catalog = [
        {
          id: "github",
          name: { zh: "GitHub", en: "GitHub" },
          category: "code",
          icon: "git",
          summary: { zh: "读仓库、Issue、PR，把代码线索带进任务", en: "Read repos, issues and PRs" },
          detail: {
            zh: "用 Personal Access Token 直连 GitHub REST API，建议只授 repo:read 与 issues:read。令牌只加密存在本机。",
            en: "Connects to the GitHub REST API with a personal access token; stored encrypted locally.",
          },
          docUrl: "https://github.com/settings/tokens",
          authType: "token",
          fields: [
            { key: "token", label: { zh: "访问令牌", en: "Access token" }, hint: { zh: "建议只勾 repo:read、issues:read", en: "repo:read and issues:read only" }, placeholder: "ghp_…", secret: true, required: true },
            { key: "owner", label: { zh: "默认组织/账号", en: "Default owner" }, hint: { zh: "可留空", en: "Optional" }, placeholder: "openai" },
          ],
          skill: "connector-github",
        },
        {
          id: "gitee",
          name: { zh: "Gitee", en: "Gitee" },
          category: "code",
          icon: "git",
          summary: { zh: "国内代码托管：仓库、Issue 与 PR 查询", en: "Chinese Git hosting: repos and issues" },
          detail: { zh: "用私人令牌直连 Gitee OpenAPI v5，只读即可。", en: "Uses a Gitee personal token against OpenAPI v5." },
          docUrl: "https://gitee.com/personal_access_tokens",
          authType: "token",
          fields: [
            { key: "token", label: { zh: "私人令牌", en: "Private token" }, placeholder: "粘贴 Gitee 私人令牌", secret: true, required: true },
            { key: "owner", label: { zh: "默认组织/账号", en: "Default owner" }, placeholder: "my-org" },
          ],
          skill: "connector-gitee",
        },
        {
          id: "atomgit",
          name: { zh: "AtomGit", en: "AtomGit" },
          category: "code",
          icon: "git",
          summary: { zh: "开放原子 AtomGit：仓库与 Issue 查询", en: "OpenAtom AtomGit: repos and issues" },
          detail: { zh: "接口与 Gitee v5 兼容；令牌在 AtomGit 设置里创建。", en: "Gitee-v5 compatible API." },
          docUrl: "https://atomgit.com",
          authType: "token",
          fields: [{ key: "token", label: { zh: "访问令牌", en: "Access token" }, placeholder: "粘贴 AtomGit 访问令牌", secret: true, required: true }],
          skill: "connector-atomgit",
        },
        {
          id: "email",
          name: { zh: "邮箱（IMAP / SMTP）", en: "Email (IMAP / SMTP)" },
          category: "mail",
          icon: "mail",
          summary: { zh: "收发邮件：读信、发周报与通知", en: "Read and send mail" },
          detail: { zh: "填服务商的 IMAP/SMTP 主机与授权码（不是登录密码）。", en: "Provide IMAP/SMTP hosts and an app password." },
          docUrl: "https://support.google.com/mail/answer/7126229",
          authType: "basic",
          fields: [
            { key: "host", label: { zh: "IMAP 主机", en: "IMAP host" }, placeholder: "imap.example.com", required: true },
            { key: "port", label: { zh: "IMAP 端口", en: "IMAP port" }, placeholder: "993", required: true },
            { key: "user", label: { zh: "邮箱账号", en: "Mailbox" }, placeholder: "you@example.com", required: true },
            { key: "password", label: { zh: "授权码 / 应用密码", en: "App password" }, hint: { zh: "多数邮箱需要单独生成应用密码", en: "Most providers require an app password" }, secret: true, required: true },
          ],
          skill: "connector-email",
        },
        {
          id: "webdav",
          name: { zh: "网盘（WebDAV）", en: "Cloud drive (WebDAV)" },
          category: "drive",
          icon: "cloud",
          summary: { zh: "坚果云 / Nextcloud / 群晖：读写网盘文件", en: "Jianguoyun / Nextcloud / Synology" },
          detail: { zh: "填 WebDAV 地址与应用密码；地址形如 https://dav.jianguoyun.com/dav/。", en: "Enter the WebDAV URL and an app password." },
          docUrl: "https://help.jianguoyun.com/?p=2064",
          authType: "basic",
          fields: [
            { key: "url", label: { zh: "WebDAV 地址", en: "WebDAV URL" }, placeholder: "https://dav.jianguoyun.com/dav/", required: true },
            { key: "user", label: { zh: "账号", en: "Account" }, placeholder: "you@example.com", required: true },
            { key: "password", label: { zh: "应用密码", en: "App password" }, secret: true, required: true },
          ],
          skill: "connector-webdav",
        },
        {
          id: "ssh",
          name: { zh: "SSH 服务器", en: "SSH server" },
          category: "server",
          icon: "server",
          summary: { zh: "远程服务器：跑命令、同步文件", en: "Remote host: run commands, sync files" },
          detail: { zh: "填主机、端口、账号与私钥路径；lynn 只记路径、不复制私钥内容。", en: "Host, port, user and private key path; the key itself is never copied." },
          docUrl: "https://www.openssh.com/manual.html",
          authType: "ssh",
          fields: [
            { key: "host", label: { zh: "主机", en: "Host" }, placeholder: "10.0.0.12", required: true },
            { key: "port", label: { zh: "端口", en: "Port" }, placeholder: "22", required: true },
            { key: "user", label: { zh: "账号", en: "User" }, placeholder: "deploy", required: true },
            { key: "keyPath", label: { zh: "私钥路径", en: "Private key path" }, placeholder: "~/.ssh/id_ed25519", required: true },
          ],
          skill: "connector-ssh",
        },
      ];
      return {
        catalog,
        canEncrypt: true,
        items: [
          {
            id: "github",
            enabled: true,
            configured: true,
            values: { owner: "spiker" },
            hasSecret: { token: true },
            updatedAt: new Date(Date.now() - 7_200_000).toISOString(),
            checkedAt: new Date(Date.now() - 3_600_000).toISOString(),
            checkOk: true,
            checkDetail: "令牌有效，账号 spiker",
          },
          { id: "gitee", enabled: false, configured: false, values: {}, hasSecret: {} },
          { id: "atomgit", enabled: false, configured: false, values: {}, hasSecret: {} },
          {
            id: "webdav",
            enabled: false,
            configured: true,
            values: { url: "https://dav.jianguoyun.com/dav/", user: "me@example.com" },
            hasSecret: { password: true },
            updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
          },
          { id: "email", enabled: false, configured: false, values: {}, hasSecret: {} },
          { id: "ssh", enabled: false, configured: false, values: {}, hasSecret: {} },
        ],
      };
    }
    if (method === "connectors.save") return { ok: true, enabled: true };
    if (method === "connectors.toggle") return { ok: true, enabled: true };
    if (method === "connectors.forget") return { ok: true };
    if (method === "connectors.test") return { ok: true, detail: "令牌有效，账号 demo（预览）" };

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
