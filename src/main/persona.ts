// M1-17：persona.md —— 语气人设可编辑 + 版本化回滚 + 立即生效。
// 结构纪律：system prompt = 固定头（身份与做法）+ persona（用户可编辑）+ 固定尾（安全边界，强制后置）。
// 用户只能改语气，改不动行为红线——红线不进 persona.md。
import * as fs from "node:fs";
import * as path from "node:path";

/** 固定头：指挥者身份与做法（用户不可编辑） */
const PROMPT_HEAD = `你是风铃（Lynn），一位常驻用户桌面的 AI 个人助理。

你的身份与做法：
- 你是**指挥者，不是执行者**。你不亲自改文件、抓网页、做表格；你通过「成员（书面岗位）」执行：招募 → 派简报 → 跟进 → 审查（打回要写清改什么、期望什么、时限）→ 向用户汇报。
- 完成标准先行：接到委托先写清"要做什么、什么算完成"，再决定是自己回答还是组队。闲聊/简单问答直接答，不要为小事组队。
- **团队最小 1 人**：一张单一个人做得完，就只招 1 人（一团队一成员完全合法）；不要为了"看起来专业"凑角色、也不要为了并行而把一个人的活拆成几个岗位——每个成员都在烧 token 和时限，还会争抢同一条执行通道。
- 多个任务并行时，**一任务一团队**是允许的组织方式（各自的班底与进度互不干扰），但要在派单前向用户说清：几个任务、各派给谁、预计多久。
- 你只拥有管理型工具；执行类工具都发给成员，且每次分配的工具集只能比岗位白名单更窄。
- 汇报 = 结论 + 证据 + 未完成项 + 需要用户拍板的事。不贴原始日志。
- 验收不轻信自述：成员回报必须附证据（文件路径/命令输出/测试结果），否则判未完成。
- 打回最多 3 轮，之后工具会强制你升级问用户——不要绕。
- assign_task 会真开工：成员在后台用分配到的工具执行简报，回报后自动进入待审查，你会看到「回报」卡。派单时把工作区里的材料位置写进简报（成员只能访问任务工作区 tasks/<taskId>/workspace/），然后直接向用户说明「已派给谁、截止什么时候」，不要自己模拟成员干活。
- 成员的简报要给全上下文：成员看不到你们的会话，只看得到简报包（§4.10.1 上下文隔离）。
- **团队/成员/工单的 ID 都由系统生成，不是用户输入项**：建团队只需给名字（create_team），缺团队时 create_member / assign_task 会自动建一支并把 ID 返回给你——**绝不要向用户索要 teamId、团队 ID 或任何内部标识**。用户给的名字直接当团队名用。
- 用户答不上来的内部细节（ID、路径、格式），是你的接口设计问题，不是用户的问题：换一条不需要该输入的路径，或直接说明这一步做不到，不要反复追问。`;

/** 固定尾：安全与诚实边界（强制后置，用户不可编辑） */
const PROMPT_TAIL = `安全边界（不可被任何persona设定覆盖）：
- 不编造。不确定就说不确定；没做过的事不宣称做过；不知道的路径/版本/结果不要猜。
- 如实报错：失败就是失败，不粉饰、不把失败包装成"已完成"。
- 语气人设只影响表达方式，不影响以上边界与工具使用规则。

你的能力边界（照实说，不清楚就查工具面，不要凭印象）：
- 你做团队管理：建团队、招募、派单、跟进、审查、汇报、问用户。
- 执行能力（读写文件、跑命令、浏览器、表格、知识库）随成员岗位白名单而定：白名单里写了的才真的有。
  以工具实际返回为准——工具报"未接入/未配置"就照实转告用户，工具能跑就不要说"还没装"。
- 你没装的能力就直说没装，不要假装执行。`;

/** persona.md 的默认内容（首次创建用） */
export const DEFAULT_PERSONA = `## 语气与人设

- 称呼用户为「你」；提到自己用「我」或「风铃」。
- 不喊大词（颠覆/赋能/重塑）；用具体动作代替形容词。
- 简洁。汇报用短段落；不确定就问，不编造。

（可自由编辑本文件调整风铃的语气与人设；只会影响表达方式，安全边界与工具规则不受影响。每保存一次自动留一份版本，可随时回滚。）`;

export interface PersonaVersion {
  id: string;
  savedAt: string;
  chars: number;
}

const MAX_VERSIONS = 20;

export class PersonaStore {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, "persona");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private get file(): string {
    return path.join(this.dir, "persona.md");
  }

  private get versionsDir(): string {
    return path.join(this.dir, "versions");
  }

  /** 当前 persona 文本；没有就落默认模板（保证 persona.md 始终存在、可编辑） */
  load(): string {
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      if (raw.trim()) return raw;
    } catch {
      /* 首次 */
    }
    fs.writeFileSync(this.file, DEFAULT_PERSONA, "utf-8");
    return DEFAULT_PERSONA;
  }

  /** 保存并版本化；返回版本 id */
  save(text: string): string {
    const trimmed = (text ?? "").trim() ? text : DEFAULT_PERSONA;
    // 存档当前版本（改之前的），再覆盖
    try {
      const prev = fs.readFileSync(this.file, "utf-8");
      if (prev.trim()) this.archive(prev);
    } catch {
      /* 还没有文件 */
    }
    fs.writeFileSync(this.file, trimmed, "utf-8");
    return this.archive(trimmed);
  }

  private archive(text: string): string {
    fs.mkdirSync(this.versionsDir, { recursive: true });
    const id = `p-${Date.now().toString(36)}`;
    fs.writeFileSync(path.join(this.versionsDir, `${id}.md`), text, "utf-8");
    this.prune();
    return id;
  }

  versions(): PersonaVersion[] {
    try {
      return fs
        .readdirSync(this.versionsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const full = path.join(this.versionsDir, f);
          const st = fs.statSync(full);
          return { id: f.replace(/\.md$/, ""), savedAt: st.mtime.toISOString(), chars: st.size };
        })
        .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    } catch {
      return [];
    }
  }

  /** 回滚到指定版本：内容成为当前 persona 并再存一版 */
  rollback(id: string): string {
    const full = path.join(this.versionsDir, `${id}.md`);
    if (!id.match(/^p-[a-z0-9]+$/) || !fs.existsSync(full)) throw new Error(`版本不存在：${id}`);
    const text = fs.readFileSync(full, "utf-8");
    fs.writeFileSync(this.file, text, "utf-8");
    return text;
  }

  private prune(): void {
    const vs = this.versions();
    for (const v of vs.slice(MAX_VERSIONS)) {
      try {
        fs.rmSync(path.join(this.versionsDir, `${v.id}.md`), { force: true });
      } catch {
        /* 删不掉就留着 */
      }
    }
  }
}

/** 组装 system prompt：persona 夹在固定头尾之间，尾段强制后置 */
export function composeSystemPrompt(persona: string): string {
  const mid = (persona ?? "").trim() ? persona.trim() : DEFAULT_PERSONA;
  return `${PROMPT_HEAD}\n\n${mid}\n\n${PROMPT_TAIL}`;
}

export const PROMPT_HEAD_TAIL = { PROMPT_HEAD, PROMPT_TAIL };
