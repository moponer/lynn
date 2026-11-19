import * as fs from "node:fs";
import * as path from "node:path";
import { generateTeamId, type TeamStore, type MemberProfile } from "./team-store";
import { avatarFor, isAvatarId } from "../shared/avatars";
import { MEMBER_EXEC_TOOLS } from "./member-runner";
import { validateMemberProfile, memberProfileRejection } from "./member-profile";
import { resolveRole, mixedRoleRejection, roleSpec } from "./role-registry";
import { MemberPool } from "./member-pool";

/**
 * 风铃的管理型工具 8 件套（§3.1 / §4.10.3）。
 *
 * 「她不会自己去做」的硬实现：这个文件里**只有管理动作**，
 * 没有 bash / write / browser / office —— 执行类工具只发给成员。
 * 约束不靠提示词自律，全部在代码里强制：
 *  - 成员工具集 = min(岗位模板上限, 本次分配)，只能收窄（§4.10.3）
 *  - 打回必须可执行：哪里不合格/期望是什么/时限（§4.10.5）
 *  - 打回上限 3 轮，之后必须升级问你（§4.10.5）
 *  - 编制默认 6 人上限，超过须写理由（§4.10.6）
 *  - 每次动作写审计账本（§4.2.7：审计独立于被审计者）
 */

export interface AssignBrief {
  taskId: string;
  member: string;
  /** 简报包：成员只拿这个，不继承全量会话（§4.10.1 上下文隔离） */
  brief: string;
  deadline: string;
  /** 本次分配的工具集：必须是岗位白名单的子集（只能收窄） */
  tools?: string[];
  /** Pi session 追溯（M0-13）：派单时主会话所在的 Pi session */
  sessionId?: string;
  /** 超过 6 人编制时必须写理由 */
  staffingJustification?: string;
}

export interface RejectReason {
  what: string;
  expect: string;
  deadline: string;
}

export interface UserReport {
  taskId: string;
  conclusion: string;
  evidence: string[];
  unfinished: string[];
  decisionsNeeded: string[];
}

export interface UserQuestion {
  id: string;
  question: string;
  context: string;
  askedAt: string;
}

const MEMBER_CAP = 6;
const REJECT_LIMIT = 3;

/**
 * 只属于风铃的管理型工具。成员白名单里出现任何一个都算越权通道：
 * 成员没有 ask_user、不能招募、不能验收（§4.10.3 单层指挥）。
 */
export const MANAGEMENT_ONLY_TOOLS = [
  "create_team",
  "create_member",
  "assign_task",
  "check_progress",
  "check_roster",
  // 2026-11-19：派单前只读探路（连撞三次拒绝 → 先探再派）。成员不需要探路能力。
  "probe_path",
  // 验收前读产物正文：成员不能自己读自己的卷宗去自证（审查归风铃）
  "read_artifact",
  "review_result",
  "accept_or_reject",
  "report_to_user",
  // 群公告（全局段）：只有风铃能写——成员看不到群，也不该改群的分工
  "set_group_notice",
  "ask_user",
  "dissolve_team",
  "ship_plugin",
  // 指挥者的两只手：催办在跑的成员、停掉明显做不到的单
  "nudge_member",
  // 2026-11-16 群内协作：成员会中途提问/报风险，回答与纠正归她（成员没有问用户/问领导的通道）
  "reply_member",
  "stop_task",
  // 插件自举三件套（P8-2）：看清单 / 开关已装的 / 删掉装错的。只做用户也能做的事
  "list_plugins",
  "set_plugin_enabled",
  "uninstall_plugin",
  "install_plugin",
  "list_plugin_versions",
  "rollback_plugin",
  // 主动工作闭环：沉淀记忆（M2-05 记忆进系统提示词）、自开插件草稿（M3-07 工坊）
  "save_memory",
  // 2026-11-13：记忆要能"删一条"（此前只能追加与整版回滚，作废事实只能越滚越绕）
  "read_memory",
  "forget_memory",
  "create_plugin_draft",
] as const;

export class ManagementTools {
  private questions: UserQuestion[] = [];
  private qCounter = 0;

  constructor(
    private readonly store: TeamStore,
    private readonly dataRoot: string,
  ) {}

  /** 审计账本：独立文件，只追加（§4.2.7 内核红线） */
  private audit(tool: string, detail: Record<string, unknown>): void {
    const entry = { at: new Date().toISOString(), tool, ...detail };
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.appendFileSync(path.join(this.dataRoot, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  }

  private assertTeamActive(teamId: string): void {
    const file = path.join(this.store.teamDir(teamId), "team.json");
    if (!fs.existsSync(file)) throw new Error(`团队不存在: ${teamId}`);
    const rec = JSON.parse(fs.readFileSync(file, "utf-8")) as { status: string };
    if (rec.status !== "active") throw new Error(`团队 ${teamId} 状态为 ${rec.status}，不能派活`);
  }

  /**
   * 0. create_team —— 建团队。**ID 由系统生成，不要问用户要**（§4.10.3 修正）。
   * 缺团队时 assign_task / create_member 也会走这条路自动起队，不需要人先建。
   */
  createTeam(name?: string, teamId?: string, idWasGenerated = false): { id: string; name: string } {
    // 同名在职队直接复用：模型重复调 create_team 不该造出一堆同名团队
    const display0 = (name ?? "").trim();
    if (display0 && !teamId) {
      const same = this.store.activeTeams().find((t) => t.name === display0);
      if (same) return { id: same.id, name: same.name };
    }
    const id = teamId?.trim()
      ? teamId.trim()
      : generateTeamId(name, (candidate) => this.store.teamExists(candidate));
    if (this.store.teamExists(id)) {
      const rec = this.store.readTeam(id);
      // 已存在就当顺带把 ID 告诉模型，不重复覆盖（覆盖会抹掉成员与战绩）
      return { id: rec.id, name: rec.name };
    }
    const display = (name ?? "").trim() || id;
    this.store.createTeam(id, display);
    this.audit("create_team", { teamId: id, name: display, generated: idWasGenerated || !teamId });
    return { id, name: display };
  }

  /** 1. create_member —— 书面招募；>6 人必须给理由（§4.10.6 组织膨胀防线） */
  createMember(teamId: string, profile: MemberProfile, staffingJustification?: string): string {
    // 档案闸早于一切副作用（人数/工具/写盘/审计）：不合格就不留半个人。
    // 覆盖所有入口，包括模板导入与用户手改之外的直调路径。
    const issues = validateMemberProfile(profile);
    if (issues.length) throw new Error(memberProfileRejection(issues));
    /**
     * G1 准入的**硬兜底**（2026-11-17 P3-1 / 07 章 §4）。
     * 风铃那条路径已经在建队之前拦过一次；这里再拦一次是因为 create_member 不止一个入口——
     * 模板导入、用户手改、脚本直调都走同一个写盘口。闸只放在"看起来会走"的地方等于没放。
     */
    const roleGate = resolveRole({ roleId: profile.roleId, role: profile.role });
    if (roleGate.mixed) throw new Error(mixedRoleRejection(profile.role, roleGate.suggestion ?? null));
    this.assertTeamActive(teamId);
    const existing = this.store.listMembers(teamId).length;
    // 2026-11-11：小任务起手就招 3~8 人是实机最大浪费（一次长任务曾招 16 人、重派 24 次）。
    // 第 3 人起必须写明分工；1~2 人直接放行，6 人以上仍要理由（硬上限见 MEMBER_CAP）。
    if (existing >= 2 && !staffingJustification) {
      throw new Error(
        `起手编制先控制在 2 人（当前 ${existing} 人）：小任务 1 人足够；确需第 3 人请在 justification 写明各人分工（组织膨胀防线 §4.10.6）`,
      );
    }
    if (existing >= MEMBER_CAP && !staffingJustification) {
      throw new Error(`编制已达 ${MEMBER_CAP} 人上限；如确需扩编，请在派单记录里写明理由（组织膨胀防线 §4.10.6）`);
    }
    if (!profile.tools.length) throw new Error("成员岗位必须有至少一个工具白名单项");
    const managementTools = profile.tools.filter((t) =>
      (MANAGEMENT_ONLY_TOOLS as readonly string[]).includes(t),
    );
    if (managementTools.length > 0) {
      throw new Error(
        `成员白名单不得包含管理型工具：${managementTools.join("、")}——成员没有 ask_user，也不能再招募或验收（§4.10.3）`,
      );
    }
    // 工具名写错会在派单时被静默过滤掉，成员带着空工具集开工——必须当场拒
    const unknown = profile.tools.filter((t) => !(MEMBER_EXEC_TOOLS as readonly string[]).includes(t));
    if (unknown.length > 0) {
      throw new Error(
        `未知工具：${unknown.join("、")}。成员可用执行工具只有：${MEMBER_EXEC_TOOLS.join("、")}（请按这些名字重写白名单）`,
      );
    }
    // 招募即入像：没指定就从头像库挑一张本队还没用的（同一名字永远稳定），
    // 指定但 id 不认识就当场拒，别让界面渲染出一张谁都对不上的脸。
    if (profile.avatarId && !isAvatarId(profile.avatarId)) {
      throw new Error(`未知头像 id：${profile.avatarId}`);
    }
    const used = this.store
      .listMembers(teamId)
      .map((m) => m.avatarId)
      .filter((x): x is string => typeof x === "string");
    const picked: MemberProfile = {
      ...profile,
      roleId: roleGate.roleId,
      avatarId: profile.avatarId ?? avatarFor(profile.name, used).id,
    };
    /**
     * 入池（2026-11-17 P3-2 / 08 章 §2）：团队是雇佣关系，人是池子里的那个人。
     * 先入池再写团队档案，这样档案里带得上 memberId——战绩与经验都挂在它上面。
     * `hire` 幂等：同一个 roleId+名字+团队重复招募会拿回同一个人，不会凭空多一个分身。
     */
    const pool = new MemberPool(this.dataRoot);
    const domain = roleSpec(roleGate.roleId)?.domains[0] ?? "general";
    const hired = pool.hire({ profile: picked, roleId: roleGate.roleId, domain, hiredFrom: teamId });
    const withPoolId: MemberProfile = { ...picked, memberId: hired.memberId };
    const file = this.store.writeMember(teamId, withPoolId);
    this.audit("create_member", {
      teamId,
      member: withPoolId.name,
      avatarId: withPoolId.avatarId,
      tools: withPoolId.tools.length,
      justified: existing >= MEMBER_CAP,
      // G1/G4（07 章）：角色归属要进审计，否则「按 roleId 统计成功率」没有数据源
      roleId: roleGate.roleId,
      roleSource: roleGate.source,
      roleConfidence: roleGate.confidence,
      promptFallback: roleGate.source === "fallback",
      // P3-2：池内身份；hired=false 表示这个人本来就在池子里（复用，不是新人）
      memberId: hired.memberId,
      memberReused: !hired.created,
    });
    return file;
  }

  /** 2. assign_task —— 派简报包；本次工具集只能比岗位白名单更窄 */
  assignTask(teamId: string, brief: AssignBrief): void {
    this.assertTeamActive(teamId);
    const profile = this.store.readMember(teamId, brief.member);
    if (brief.tools) {
      const overreach = brief.tools.filter((t) => !profile.tools.includes(t));
      if (overreach.length > 0) {
        throw new Error(
          `本次分配越权：${overreach.join(", ")} 不在 ${brief.member} 的岗位白名单内。成员工具集只能收窄不能扩张（§4.10.3）`,
        );
      }
    }
    this.store.appendAssignment(teamId, {
      taskId: brief.taskId,
      at: new Date().toISOString(),
      kind: "assign",
      member: brief.member,
      sessionId: brief.sessionId,
      text: JSON.stringify({
        brief: brief.brief,
        deadline: brief.deadline,
        tools: brief.tools ?? profile.tools,
      }),
      evidence: brief.staffingJustification ? [brief.staffingJustification] : undefined,
    });
    this.audit("assign_task", { teamId, taskId: brief.taskId, member: brief.member });
  }

  /**
   * 3. check_progress —— 她的上下文只保留状态与最新回报索引，不读成员全量日志（§4.10.6）。
   * 2026-11-13 缓存分析：latest.text 是完整简报 JSON / 回报正文，无上限——她轮询频繁
   * （实机一张单查过 246 次）+ 心跳每 5 分钟一轮，全文反复进上下文是稳态膨胀的主源之一。
   * 对齐 Codex/ZCode 的工具结果预算：超过 400 字截头 + 截断声明（原文多少字）+ 指路卷宗，
   * 细读走 read_artifact / 卷宗，不在轮询里反复付全文的钱。
   */
  static readonly PROGRESS_TEXT_CAP = 400;
  static capProgressText(text: string): string {
    if (text.length <= ManagementTools.PROGRESS_TEXT_CAP) return text;
    return (
      text.slice(0, ManagementTools.PROGRESS_TEXT_CAP) +
      `\n[已截断：原文 ${text.length} 字，全文在任务卷宗里；要细读就用 read_artifact 读产物或看卷宗 timeline，别靠反复 check_progress 拿全文]`
    );
  }
  checkProgress(teamId: string, taskId: string): {
    assigns: number;
    reports: number;
    rejects: number;
    latest: { at: string; kind: string; member?: string; text: string } | null;
  } {
    const recs = this.store.readAssignments(teamId, taskId);
    const latest = recs.length ? recs[recs.length - 1] : null;
    return {
      assigns: recs.filter((r) => r.kind === "assign").length,
      reports: recs.filter((r) => r.kind === "report").length,
      rejects: recs.filter((r) => r.kind === "reject").length,
      latest: latest
        ? { at: latest.at, kind: latest.kind, member: latest.member, text: ManagementTools.capProgressText(latest.text) }
        : null,
    };
  }

  /** 3b. check_roster —— 花名册 + 战绩（M2-14）：档案是资产，下一单派谁看历史表现 */
  roster(teamId?: string): unknown {
    if (teamId) return this.store.roster(teamId);
    return this.store.listTeams().map((t) => {
      try {
        const r = this.store.roster(t.id);
        return {
          team: t,
          members: r.members.map((m) => ({
            name: m.profile.name,
            role: m.profile.role,
            tools: m.profile.tools,
            record: m.record,
          })),
        };
      } catch {
        return { team: t, members: [] };
      }
    });
  }

  /**
   * 4. review_result —— 登记回报。
   * 2026-11-11：证据改为可选（普通任务不再因为缺证据被拒登）；是否有证据由卷宗与
   * 界面如实标注，关键任务的强制点下沉到 task.evidencePolicy + accept 前的拍板闸。
   */
  reviewResult(
    teamId: string,
    taskId: string,
    opts: { member: string; text: string; evidence: string[]; sessionId?: string },
  ): { verdict: "logged" } {
    this.store.appendAssignment(teamId, {
      taskId,
      at: new Date().toISOString(),
      kind: "report",
      member: opts.member,
      sessionId: opts.sessionId,
      text: opts.text,
      evidence: opts.evidence,
    });
    this.audit("review_result", { teamId, taskId, member: opts.member, evidence: opts.evidence.length });
    return { verdict: "logged" };
  }

  /**
   * 5. accept_or_reject —— 打回/验收。
   *
   * 打回上限（§4.10.5 的防死循环闸）**不再问用户**（2026-11-15）：
   * 用户只出需求，不该在"继续打回还是换策略"这种执行层选择上被打断。
   * 到上限就把单停在 blocked，由风铃自己定下一步（换人 / 换法 / 拆小 / 关单并如实汇报），
   * 用户只在最终汇报里看到"没做成 + 卡在哪 + 建议"。
   */
  acceptOrReject(
    teamId: string,
    taskId: string,
    verdict: "accept" | "reject",
    opts: {
      member: string;
      rejectReason?: RejectReason;
      evidence?: string[];
      /**
       * 打回轮次（含本次）。交给调用方从**权威工单**传进来（2026-11-16）：
       * 这里自己读派单账本会与工单的 rejectRounds 漂移，导致"刚打回一次就说到上限"。
       */
      priorRejects?: number;
    },
  ): { escalated: boolean } {
    if (verdict === "reject") {
      const r = opts.rejectReason;
      if (!r || !r.what || !r.expect || !r.deadline) {
        throw new Error("打回必须可执行：写清哪里不合格(what)、期望是什么(expect)、多久内重交(deadline)——不带理由的打回视为风铃失职（§4.10.5）");
      }
      const rejects = opts.priorRejects ?? this.store.rejectCount(teamId, taskId);
      if (rejects >= REJECT_LIMIT) {
        // 不再循环，也不再问用户：单停在 blocked，交给风铃换法（这一层是她的活）
        this.store.appendAssignment(teamId, {
          taskId,
          at: new Date().toISOString(),
          kind: "escalate",
          member: opts.member,
          text: `打回上限 ${REJECT_LIMIT} 轮已到（最近一次：${r.what}）：停止打回，改由风铃换人/换法/关单`,
        });
        this.audit("accept_or_reject", { teamId, taskId, escalated: true });
        return { escalated: true };
      }
    }
    this.store.appendAssignment(teamId, {
      taskId,
      at: new Date().toISOString(),
      kind: verdict === "accept" ? "accept" : "reject",
      member: opts.member,
      text:
        verdict === "accept"
          ? `验收通过${opts.evidence?.length ? "：证据齐全且可复跑" : "（无附证据，按普通任务放行）"}`
          : JSON.stringify(opts.rejectReason),
      evidence: opts.evidence,
      rejectReason: verdict === "reject" ? opts.rejectReason : undefined,
    });
    this.audit("accept_or_reject", { teamId, taskId, verdict });
    return { escalated: false };
  }

  /** 6. report_to_user —— 汇报四件套：结论+证据+未完成+待拍板（§4.10.4） */
  reportToUser(teamId: string, report: UserReport): UserReport {
    this.store.appendAssignment(teamId, {
      taskId: report.taskId,
      at: new Date().toISOString(),
      kind: "report",
      text: JSON.stringify({ report: true, ...report }),
      evidence: report.evidence,
    });
    this.audit("report_to_user", { teamId, taskId: report.taskId });
    return report;
  }

  /** 7. ask_user —— 成员没有问用户的通道，问题归集到她、由她转呈（§4.10.3） */
  askUser(question: string, context: string): UserQuestion {
    const q: UserQuestion = {
      id: `q-${++this.qCounter}`,
      question,
      context,
      askedAt: new Date().toISOString(),
    };
    this.questions.push(q);
    this.audit("ask_user", { questionId: q.id, question });
    return q;
  }

  pendingQuestions(): UserQuestion[] {
    return [...this.questions];
  }

  /**
   * 8. dissolve_team —— 解散或保留复用由她判断，但动作要审计。
   * keep=true 时把当前编制存进 `team/_templates/`（M1-08）：下一单同类任务直接复用，
   * 不用重新招人；存模板失败就如实抛错，不假装保留。
   */
  dissolveTeam(teamId: string, keep: boolean): "dissolved" | "kept" {
    if (keep) {
      const saved = this.store.saveTemplate(teamId);
      this.store.dissolveTeam(teamId);
      this.audit("dissolve_team", { teamId, keep: true, template: saved.name, members: saved.members });
      return "kept";
    }
    this.store.dissolveTeam(teamId);
    this.audit("dissolve_team", { teamId, keep: false });
    return "dissolved";
  }

  /** 编制模板：列出来给风铃/界面看 */
  listTemplates(): { name: string; members: number; createdAt: string }[] {
    return this.store.listTemplates().map((t) => ({ name: t.name, members: t.members.length, createdAt: t.createdAt }));
  }

  /**
   * 团队不存在时按模板起一支（M1-08）：显式指定优先，否则按任务标题匹配。
   * 返回用了哪套模板；没有可用模板返回 null（调用方据此如实报错，不硬造团队）。
   */
  ensureTeamFromTemplate(teamId: string, taskTitle: string, template?: string): { name: string; members: number } | null {
    if (this.store.teamExists(teamId)) return null;
    const picked = template?.trim()
      ? this.store.findTemplate(template.trim())
      : this.store.matchTemplate(taskTitle);
    if (!picked) return null;
    const res = this.store.instantiateTemplate(picked.name, teamId);
    return { name: res.template, members: res.members };
  }
}
