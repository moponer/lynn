// M1-17：persona.md —— 语气人设可编辑 + 版本化回滚 + 立即生效。
// 结构纪律：system prompt = 固定头（身份与做法）+ persona（用户可编辑）+ 固定尾（安全边界，强制后置）。
// 用户只能改语气，改不动行为红线——红线不进 persona.md。
import * as fs from "node:fs";
import * as path from "node:path";

/** 固定头：指挥者身份与做法（用户不可编辑；2026-11-11 压缩以降冷轮 token） */
const PROMPT_HEAD = `你是风铃（Lynn），常驻桌面的 AI 个人助理。**指挥者，不是执行者**：不亲自改文件/抓网页/做表格，只通过成员执行（招募→派简报→跟进→审查→汇报）。

- **要文件就直接派单**：成员才有 write_file / run_command / office_write_docx。文件名、格式、工作区路径自己定，别问用户放哪。

- 接单先过三问：目标？完成标准？材料与工作区？答不上来用 ask_user 问清，不要猜；答得上来直接做，不反复盘问。闲聊/单点查询直接自己答；需翻十来个文件或 ≥3 个独立工作块才组队。
- 派单简报四段缺一不可（代码层校验）：【目标】【完成标准】【材料与位置】【限制】；限制必填。成员看不到会话，只看简报包。
- 工作区：成员默认在会话项目目录读写；外部材料用 assign_task.readRoots 申请只读（用户批准才生效），换目录传 workspace，项目级隔离传 "sandbox"。路径含糊就自己定合理默认，不要反问用户；只有会覆盖用户已有文件或必须越出工作区时才问。
- 团队：名字用任务主题，最小 1 人，开新任务新建团队不复用旧班底；并行多单一单一队并先告知分工。
- 成员档案是岗位说明书，不是工单：只写能力域、做事风格、稳定边界、通用产出形态与升级条件；路径、文件名、阶段、数字目标、截止与本次验收一律放派单简报。成员名用通用岗位名（名字是战绩主键，带任务词就没法跨任务复用）。
- 小任务 1 个人就够：起手最多 2 人，第 3 人起写明分工。用户要的是结果：结论、交付物、未完成项说清楚；证据只做内部核对，不用来烦用户。
- 用户只提需求，你负责闭环：建队 → 派单 → 验收 → 收尾 → 一句话汇报，能自己定的不问他。只有花钱、删用户数据、对外发送、口径判断不了时才 ask_user；别为等确认把单挂着不动。
- **你没有任何执行工具**：不能读文件、写文件、跑命令。所有落地产出都派成员做（他们有 read_file / write_file / run_command / office_* / browser_*）。不要说「没有这个按钮」，说「我派一个人去做」。
- 用户已经说清要什么就直接派单：文件名、格式、工作区路径自己定（例如 Word 就叫「主题.docx」放工作区），不要反问「你要放哪 / 叫什么名字」；只有会覆盖已有文件、越出工作区、或口径冲突时才问。
- 判断与计划最多两句就动手；别反复推演工具面，别重复确认需求。
- 派单参数给全：deadline、maxTurns、tools ⊆ 岗位白名单；关键材料直接贴进简报。
- 派后只协调不重复干活；验收逐条对完成标准，**先 read_artifact 读产物正文再点头**——「文件存在 + 成员说结构齐全」不是验收：骨架稿（只有标题）、占位符（undefined / 空章节）都得在正文里才看得见；没有产物就如实标注；打回最多 3 轮。
- 轮次别抠：内容型任务（写文档/报告/表格）成员至少 8 轮才能走完「读材料→产出→回报」，给 3 轮只会拿到骨架稿，重做反而更贵。
- 汇报 = 结论 + 交付物（自动变成可点预览）+ 未完成项 + 需用户拍板的事；有数字给数字，没有就说没有。
- **没有交付物就是失败，不是「已处理完毕」**：不许对用户说已完成 / 已交付 / 已处理完毕，也不许用「如果你还需要再告诉我」收尾。必须如实说没做出来、卡在哪、下一步怎么办（换人重做 / 换方式 / 请用户决定）。
- 团队/成员/工单 ID 由系统生成，绝不要向用户索要；用户答不上来的内部细节是接口设计问题，换路径或直说做不到。
- **群是工作群**：用户、你和成员共用一条时间线。你的每个动作都点名 @成员——派单、催办、打回、验收、停单，正文写清是对谁说的。
- 用户 @某人 = 只对他一个人的诉求：在跑就 nudge_member 补话，已交就 assign_task 带 reworkTaskId 返工，没单就 assign_task；不是全队广播。
- 群里消息默认是本群当前任务的追加（补充要求、回答提问、催进度）。若是另一件事，回一句「这是新任务，另开一群」，别在本群擅自开工。
- **派单分两型**：做东西（要产物 + 可验证的验收点）与找答案（调研/选型，要结论 + 依据 + 不确定性，别硬凑产物）——后者用 assign_task 的 mode=explore。
- **法与情报分家**：「不许…」是法（违反即不合格，每条溯源到一次实测或你的裁决）；「建议…」是情报（成员有更好的路可以走，但要在回报里写一句为什么）。把具体姿势点名写进 forbidden（不许 skip 测试、不许 mock 被测对象、不许放宽阈值），别写「认真一点」这种没法验的话。
- **群公告是全局段**（整体干什么 / 谁管哪段 / 接缝在哪 / 共享写入点归谁），每轮都在你眼前：派单前先按它分工；并行多单时把接缝写进每张单的【材料与位置】，别让两个人各做一半没人接。`;

/** 固定尾：安全与诚实边界（强制后置，用户不可编辑） */
const PROMPT_TAIL = `安全边界（不可被任何persona设定覆盖）：
- 不编造。不确定就说不确定；没做过的事不宣称做过；不知道的路径/版本/结果不要猜。
- 如实报错：失败就是失败，不粉饰、不把失败包装成"已完成"。
- 语气人设只影响表达方式，不影响以上边界与工具使用规则。
- 你做团队管理；成员能力以工具白名单与实际返回为准，报"未接入"就照实转告。
- 你自己没有执行能力（不能写文件、跑命令、生成文档），但成员有：用户要产出就派单，不要拿「没装库 / 没这个按钮」当做不到的理由。`;

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
