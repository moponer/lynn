import type {
  BoardData,
  Decision,
  Evidence,
  FeedCard,
  PermissionMode,
  RpcContracts,
  RpcMethod,
  SessionSnapshot,
  Task,
  Team,
} from "../shared/contract";

/**
 * MockKernel —— 指挥环的纯内存模拟实现。
 * 目的：在接入 Pi 运行时之前，让渲染层可以完整跑通
 * 「对话 → 受理 → 派单 → 回报 → 审查 → 审批 → 汇报」的界面闭环。
 * 接口与未来真正的内核转发层完全一致（见 main.ts 注释）。
 */

interface KernelState {
  permission: PermissionMode;
  task: Task;
  team: Team;
  feed: FeedCard[];
  track: BoardData["track"];
  decisions: Decision[];
  budget: BoardData["budget"];
  evidence: Record<string, Evidence>;
}

const now = () =>
  new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

function seedEvidence(): Record<string, Evidence> {
  return {
    "ev-orders": {
      id: "ev-orders",
      kind: "file",
      label: "orders_202509.xlsx",
      title: "证据 · orders_202509.xlsx",
      body: [
        "文件    ~/.lynn/tasks/0912/artifacts/orders_202509.xlsx",
        "大小    412 KB · 修改  14:31",
        "结构    sheet[明细] 3,842 行 × 12 列 · sheet[汇总] 1 行",
        "校验    sha256 9f2c…e1 · 与回报一致 ✓",
        "预览    首行: 订单号,日期,渠道,SKU,数量,净额,退款,…",
      ].join("\n"),
    },
    "ev-reconcile": {
      id: "ev-reconcile",
      kind: "command",
      label: "reconcile.log · 可复跑",
      title: "证据 · 对账脚本输出",
      body: [
        "$ node scripts/reconcile.mjs --month=9",
        "读取 orders_202509.xlsx … 3,842 条",
        "后台汇总读取 … 3,844 条",
        "逐单比对 … 3,840 一致",
        "差异 2 条：",
        "  #20250918-0071  退款状态不同  api=refunded  sheet=paid",
        "  #20250927-0033  金额舍入差 0.01",
        "→ 已写入 diff_report.csv，未影响大盘口径",
        "exit 0",
      ].join("\n"),
    },
    "ev-brief": {
      id: "ev-brief",
      kind: "brief",
      label: "查看简报包",
      title: "简报包 · 林工",
      body: [
        "[任务] 导出并清洗 9 月订单明细，与后台汇总对账",
        "[完成标准] 明细行数一致；差异逐条列出；产出底稿 xlsx + 对账日志",
        "[上下文] 后台入口(已配登录态) · 对账口径 v2 · 上月基线",
        "[边界] 只读后台导出；不改动任何线上数据；不装新依赖(需升级申请)",
        "[时限] 今天 18:00 · 预算 120K tok · 白名单 browser/office/fs读",
      ].join("\n"),
    },
  };
}

function seedState(): KernelState {
  return {
    permission: "auto",
    task: {
      id: "0912",
      title: "整理 9 月销售月报",
      stage: "execute",
      stageProgress: "2/3",
      status: "running",
      statusNote: "执行 2/3 · 团队 2 人 · 今天 18:00",
      teamId: "team-0912",
      deadline: "18:00",
    },
    team: {
      id: "team-0912",
      name: "销售月报突击队",
      members: [
        {
          id: "m-lin",
          name: "林工",
          role: "后端/数据",
          goal: "导出并清洗 9 月订单明细，与后台汇总对账",
          status: "running",
          statusNote: "清洗对账 · 执行中 · 白名单 6 工具",
          progress: 62,
          budgetUsed: 74,
          budgetTotal: 120,
          rejections: 0,
          rejectionLimit: 3,
          toolWhitelist: ["read", "write", "edit", "bash", "glob", "grep"],
          color: "#6396BC",
        },
        {
          id: "m-mei",
          name: "小眉",
          role: "成稿编辑",
          goal: "按净订单口径重排月报并成稿",
          status: "delivered",
          statusNote: "已交付 · 待风铃审查（第 2 稿）",
          progress: 100,
          budgetUsed: 31,
          budgetTotal: 80,
          rejections: 1,
          rejectionLimit: 3,
          toolWhitelist: ["read", "write", "office"],
          color: "#E8B04B",
        },
        {
          id: "m-xun",
          name: "阿迅",
          role: "网页抓取",
          goal: "后台报表导出（已复用登录态）",
          status: "idle",
          statusNote: "空闲 · 保留编制（下次直接调用）",
          progress: 0,
          budgetUsed: 0,
          budgetTotal: 60,
          rejections: 0,
          rejectionLimit: 3,
          toolWhitelist: ["browser", "read"],
          color: "#8DA0AB",
        },
      ],
    },
    feed: [
      {
        id: "f-001",
        kind: "user",
        createdAt: "14:02",
        text: "把 9 月的销售数据整理成月报，发我一份能直接用的。",
      },
      {
        id: "f-002",
        kind: "accept",
        createdAt: "14:03",
        title: "风铃",
        badge: "已受理",
        text:
          "好，这件事我不自己动手。我把它拆成三步：抓取后台报表 → 清洗对账 → 排版成稿，组了一支两人小队，我盯进度和验收。",
        body: "完成标准：月报 PDF + 数据底稿，关键数字与后台汇总对得上。对不上我打回，最多三轮，之后来问你。",
        members: [
          { id: "m-lin", name: "林工", role: "数据工程师", color: "#6396BC" },
          { id: "m-mei", name: "小眉", role: "成稿编辑", color: "#E8B04B" },
        ],
      },
      {
        id: "f-003",
        kind: "dispatch",
        createdAt: "14:05",
        badge: "派单",
        title: "林工 · 抓取并清洗 9 月订单明细",
        meta: "截止 18:00 · 预算 120K tok · 白名单 browser/office/fs读",
        body: "简报包已下发：任务说明 + 后台入口 + 对账口径。他看不到我们的对话，只拿这一页简报。",
        evidence: [{ ...seedEvidence()["ev-brief"], label: "查看简报包" }],
      },
      {
        id: "f-004",
        kind: "member_report",
        createdAt: "14:32",
        badge: "回报",
        title: "林工 · 节点回报",
        meta: "14:32 · 第 2/3 节点",
        body: "明细已导出并清洗完成，共 3,842 单，与后台汇总差 2 笔（已单独标记，不影响大盘）。",
        evidence: [seedEvidence()["ev-orders"], seedEvidence()["ev-reconcile"]],
      },
      {
        id: "f-005",
        kind: "review_reject",
        createdAt: "15:40",
        badge: "打回",
        title: "风铃 审查小眉的初稿",
        meta: "第 1/3 轮 · 15:40",
        body: "不合格：图表 3 用的是含退款订单口径，与上月不可比。期望：改用净订单口径（总单 − 退款），重交。时限：16:30 前。",
        members: [{ id: "m-mei", name: "小眉", role: "成稿编辑", color: "#E8B04B" }],
      },
      {
        id: "f-006",
        kind: "approval",
        createdAt: "15:52",
        badge: "需要你拍板",
        title: "成员升级申请 · 归集自风铃",
        meta: "15:52",
        body: "谁在做：林工（清洗对账步骤）。申请：安装新依赖 openpyxl==3.1.2。为什么：当前引擎解析合并单元格的 .xlsx 会丢样式。她的意见：同意，本地解析、无外联，权限不变。",
        actions: ["approve", "reject", "ask"],
      },
      {
        id: "f-007",
        kind: "lynn_report",
        createdAt: "15:55",
        title: "风铃",
        badge: "进行中",
        text:
          "小眉正在按净订单口径改稿。等她重交后我复核证据，没问题就给你出汇报——结论、证据、没做完的、需要你拍板的，四样齐全才算数。",
      },
      {
        id: "f-008",
        kind: "member_report",
        createdAt: "16:04",
        badge: "回报",
        title: "小眉 · 成稿中",
        meta: "16:04",
        body: "正在重排图表 3 与结论段……预计 16:25 重交。",
      },
    ],
    track: [
      { id: "0912", title: "整理 9 月销售月报", status: "running", statusNote: "执行 2/3 · 团队 2 人 · 今天 18:00" },
      { id: "cron-1", title: "每日竞品快报（cron）", status: "waiting", statusNote: "等你拍板口径 · 每天 09:00" },
      { id: "done-1", title: "官网证书过期监控", status: "done", statusNote: "已验收 · 今晨 09:12 · 证据 3 条" },
    ],
    decisions: [
      {
        id: "d-1",
        from: "升级",
        title: "林工申请新依赖 openpyxl",
        detail: "解析合并单元格需要 · 她同意 · 等你批准",
      },
      {
        id: "d-2",
        from: "口径",
        title: "竞品快报抓哪几家？",
        detail: "她给不出偏好，连续 3 次同类问题 → 按规则升级问你",
      },
    ],
    budget: { teamUsed: 412, teamTotal: 1000, lynnUsed: 38, membersUsed: 374, costYuan: 12.4 },
    evidence: seedEvidence(),
  };
}

export interface MockKernel {
  handle<M extends RpcMethod>(method: M, params: unknown): RpcContracts[M]["result"];
}

export function createMockKernel(): MockKernel {
  const s = seedState();
  let counter = 100;

  const nextId = () => `f-${++counter}`;

  const kernel: MockKernel = {
    handle<M extends RpcMethod>(method: M, params: unknown): RpcContracts[M]["result"] {
      switch (method) {
        case "session.snapshot": {
          const snap: SessionSnapshot = {
            workspace: { project: "月报自动化", subdir: "销售数据工作区" },
            permission: s.permission,
            model: { name: "DeepSeek-V3.2", thinking: true },
            task: s.task,
            feed: s.feed,
            board: { team: s.team, track: s.track, decisions: s.decisions, budget: s.budget },
          };
          return snap as RpcContracts[M]["result"];
        }

        case "permission.set": {
          const { mode } = params as { mode: PermissionMode };
          s.permission = mode;
          return { ok: true, mode } as RpcContracts[M]["result"];
        }

        case "feed.send": {
          const { text } = params as { text: string };
          const cards: FeedCard[] = [];
          cards.push({
            id: nextId(),
            kind: "user",
            createdAt: now(),
            text,
          });
          // Mock 指挥环：把任何新输入都当作新委托受理
          cards.push({
            id: nextId(),
            kind: "accept",
            createdAt: now(),
            title: "风铃",
            badge: "已受理",
            text: "收到，我先写清「要做什么、什么算完成」，再决定是自己答还是要组队。（Mock 内核：接入 Pi 运行时后，这里由真实指挥环驱动。）",
          });
          cards.push({
            id: nextId(),
            kind: "typing",
            createdAt: now(),
            title: "风铃",
            text: "拆解中……",
          });
          s.feed.push(...cards);
          return { ok: true, cards } as RpcContracts[M]["result"];
        }

        case "decision.resolve": {
          const { id, action } = params as { id: string; action: "approve" | "reject" | "ask" };
          const d = s.decisions.find((x) => x.id === id);
          s.decisions = s.decisions.filter((x) => x.id !== id);
          s.feed.push({
            id: nextId(),
            kind: action === "reject" ? "review_reject" : "lynn_report",
            createdAt: now(),
            title: "风铃",
            badge: action === "approve" ? "已批准" : action === "reject" ? "已拒绝" : "已转达",
            text:
              action === "approve"
                ? `你批准了「${d?.title ?? id}」。我已通知对应成员继续，并把这个决定记进了任务卷宗。`
                : action === "reject"
                  ? `你拒绝了「${d?.title ?? id}」。我会换一条不越权的路径，稍后给你替代方案。`
                  : `你的问题已经转给对应成员，等她回报我再汇总给你。`,
          });
          return { ok: true, resolvedId: id } as RpcContracts[M]["result"];
        }

        case "evidence.get": {
          const { id } = params as { id: string };
          const ev = s.evidence[id];
          if (!ev) throw new Error(`evidence not found: ${id}`);
          return ev as RpcContracts[M]["result"];
        }

        default:
          throw new Error(`unknown rpc method: ${method as string}`);
      }
    },
  };
  return kernel;
}
