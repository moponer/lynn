# 工作区模型与生命周期方案

- 日期：2026-11-10
- 状态：**已定稿**（2026-11-10 决策完成，未改代码；决策与理由见 §11）
- 涉及：`kernel.ts` / `threads.ts` / `task-store.ts` / `task-case.ts` / `member-runner.ts` / `toolkit.ts` / `settings.ts` / `App.tsx` / `Desk.tsx`
- 目标读者：产品 + 内核 + 前端。行号以当前工作树为准，仅用于定位。

---

## 0. 一句话结论

现在的「工作区」是一个**进程内可变的单值 `projectRoot`**，被会话、任务、成员、@检索、附件、Pi cwd 六处共享；缺省值又是应用内部目录 `~/.lynn/project`。于是所有边界问题都从这一处漏出来：没会话不敢发消息、新建会话强弹框、切会话串目录、成员撞只读墙、产出和临时文件混在一起、删单删不干净。

建议改成：**四层作用域上的「根集合（RootSet）」+ 一套产物分级（交付物 / 过程证据 / 临时文件）**。工作区从此不是"一个目录"，而是"这次活能读哪些、能写哪些、东西落在哪、活干完留什么"。

---

## 1. 现状拆解（代码事实）

### 1.1 现在只有一个真相：`Kernel.projectRoot`

| 位置 | 事实 | 后果 |
|---|---|---|
| `kernel.ts:647-649` | 默认 `~/.lynn/project`，或 `LYNN_PROJECT_DIR` | 默认工作区在**应用数据目录里**，用户既不知道也不会去那里找文件 |
| `kernel.ts:1042-1051` | `applyProjectRoot()` 改全局值，同时重建 Pi、重载 MCP/技能、清 `createFreshSession` | 换根是"全局副作用"，不是会话属性 |
| `threads.ts:16` | `ThreadMeta.projectRoot?` 可选 | 「没选过」和「选了但为空」无法区分 |
| `kernel.ts:1119-1122` | 切会话时**只有** `meta.projectRoot` 存在才改根 | 未显式选根的会话会**漂移到上一个会话的目录**（隐式串目录） |
| `kernel.ts:3624` | 快照里 `workspace: { project: basename(projectRoot), subdir: "指挥台" }` | `subdir` 是硬编码，界面显示的"工作区"只是个目录名 |
| `kernel.ts:3718` | `files.search` 只搜 `this.projectRoot` | @ 检索看不到只读授权目录 |
| `kernel.ts:3215` | `buildTurnAttachments(this.projectRoot, …)` | 附件同样只有一个根 |

### 1.2 六条真实链路

**① 新建会话（强弹框）**

`App.tsx:386-402` → `app.pickDir`（`main.ts:533-541`，`openDirectory` 单选）→ `session.new`（`kernel.ts:4813-4818`）→ `threads.create("新会话", projectRoot?)`。

- 取消 = 不传 `projectRoot` = 沿用全局当前值，但用户看不到"当前值"是什么；
- 传了才写 `ThreadMeta.projectRoot`，否则永远走隐式继承；
- 每开一个会话都打断一次，而多数会话其实沿用同一个项目。

**② 没有任何会话时直接发消息**

`feed.send`（`kernel.ts:3674`）→ `submitTurn`（`3205`）→ `ensureThreadId`（`1152`，就地建"新会话"，**不带 projectRoot**）→ 用全局 `projectRoot`。

结果：用户第一次说话，文件可能被写进 `~/.lynn/project`。而 `submitTurn` 里 `ensureThreadId` 的注释只说"不用先点新建会话"，没有回答"这条消息落在哪个目录"。

**③ 控制台模式**

`ConsoleDesk.tsx` 与主界面共用同一个 `Desk` 和 `feed.send`；`ConfigTab`（`1451-1465`）只**只读展示** `desk.project`。控制台里既不能改根，也不能声明"这条是临时活"，而控制台恰是最常接临时活的地方。

**④ 任务分解（风铃派单）**

`assign_task` schema（`kernel.ts:186-196`）→ `wsFinal = workspace ?? this.projectRoot`（`2411`）→ 建单时钉 `workspaceRoot`（`2433`）→ 契约卡展示（`2447`）。

- 风铃默认拿到的是"当前会话根"，但它不知道用户想不想让这单写进那个项目；
- `readRoots` 只是"申请"，要用户点「开始」才落权（`1606-1610`）；
- 成员在开工前完全看不到只读材料，开工后才撞墙。

**⑤ 成员执行**

`dispatchMember`（`1632`）→ `workdir = draftId ? 草稿 : task.workspaceRoot ?? tasks/<id>/workspace`（`1688-1690`）→ `runMemberTask` → `Toolkit(workdir)`。

- 老单/无根单落到 `~/.lynn/tasks/<id>/workspace`，与 `task.json`、`timeline.jsonl`、`artifacts/`、`_brief.md` 混在同一棵树；
- `submit_report` 的证据必须 `resolveWithin(workdir)`（`member-runner.ts:250`）——**只读授权目录里的真实文件无法作为证据**；
- `run_command` 的 cwd 固定 workdir，审查外部项目时无法跑它的测试。

**⑥ 删除与归档**

`purgeTask`（`2035-2051`）→ `taskStore.remove()`（`task-store.ts:187-203`）→ `fs.rm(tasks/<id>)`。

- 若 `workspaceRoot` 是用户项目目录：**只删元数据，项目文件留着**，但界面文案（`kernel.ts:2124`）说"工单、卷宗与工作区一并移除"；
- 若是 sandbox：产物被整棵删掉，且没有"先把交付物固化"的动作；
- 删会话级联删单（`2074-2088`）同样留下用户项目里的文件，不告知。

### 1.3 缺陷清单

| ID | 缺陷 | 严重度 | 证据 |
|---|---|---|---|
| D1 | 工作区是全局可变单值，不是会话/任务属性 | P0 | `kernel.ts:600,1042` |
| D2 | 新建会话强制弹原生目录框 | P1（体验） | `App.tsx:386` |
| D3 | 没选根就隐式沿用上一个会话，串目录且不可见 | P0 | `kernel.ts:1119` |
| D4 | 默认根是应用内部目录 `~/.lynn/project` | P0 | `kernel.ts:647` |
| D5 | 只有 1 个可写根；只读根只能按单、逐个、手动加 | P1 | `kernel.ts:1912`, `main.ts:537` |
| D6 | 只读根里的文件不能当证据（功能 bug） | P0 | `member-runner.ts:250` |
| D7 | 命令 cwd 固定工作区，审查项目不能跑测试 | P1 | `member-runner.ts` / `toolkit.ts` |
| D8 | 团队不持有任何工作区，成员无继承链 | P1 | `team-store.ts:207-214` |
| D9 | 产出没有落点约定，"写哪儿"全凭模型 | P0 | 无 |
| D10 | 测试/中间产物/交付物混在一起 | P1 | 无 |
| D11 | `artifacts` 全量复制每个 evidence，无阈值 | P2 | `task-case.ts:65-83` |
| D12 | 没有清理生命周期，`workspace/`+`artifacts/` 只增不减 | P1 | `task-store.ts:164` |
| D13 | 删除语义与文案不一致；级联删单不告知 | P0（信任） | `kernel.ts:2124`, `2074` |
| D14 | 命名混乱：`projectRoot / workspace / subdir / workdir / workspaceRoot / readRoots` 六个词指七件事 | P1（认知） | 全局 |
| D15 | 换根副作用大（重建 Pi / MCP / 技能），用户不敢切 | P2 | `kernel.ts:1042` |
| D16 | 路径安全未解析 symlink/junction、大小写、UNC | P2 | `toolkit.ts:85` |

---

## 2. 设计目标与不变量

**目标**

- **G1 零阻断**：任何时刻都能直接说第一句话，不被"先选目录"拦住。
- **G2 可解释**：任何文件写到哪，界面上一句话能说清；不出现"隐式沿用"。
- **G3 可继承**：全局 → 会话 → 团队 → 任务 → 成员，逐级派生，成员不用重复配置。
- **G4 读宽写窄**：读默认可跨根，写必须显式；扩权只能用户发起。
- **G5 产出与过程分离**：交付物可带走，过程文件可清理。
- **G6 单一真相**：RootSet 落盘于会话/任务，进程内不再有"当前目录"这种隐式状态。

**不变量（实现时必须守）**

1. 写路径只能落在 `primary` 或用户显式设为 `rw` 的附加根内；`ro` 根永远拒绝写。
2. `.git/`、`.lynn/` 在任何根里都拒写（保留现有规则）。
3. 成员的有效根 = 任务根 ∪ 团队根 ∪ 会话根；成员**不能**自我扩权，也不能把用户给它的只读根"删掉"。
4. 任何"写进用户项目"的动作必须能在契约卡上看到具体路径。
5. 删除工单时，数据根外的文件**一律不动**，界面必须列出"将删 / 不动"两张清单。
6. 交付物一旦验收，必须有一份在 `artifacts/`（或明确的永久路径），不能只存在于可清理的 scratch。

---

## 3. 目标模型：四层根集合

### 3.1 术语重新定义（先把话说清）

| 新名字 | 含义 | 旧名字 | 可写 | 谁设 |
|---|---|---|---|---|
| **DataRoot** | `~/.lynn`，她的家（凭据/会话/编制） | `dataRoot` | 仅她自己 | 固定 |
| **DefaultRoot** | 用户设置的默认工作区 | 无 | 是 | 设置页 |
| **SessionRoots** | 一个会话的根集合（primary + extras） | `ThreadMeta.projectRoot` + 全局 | 部分 | 用户/继承 |
| **TeamRoots** | 一支团队默认继承的根集合 | 无 | 部分 | 建队时派生 |
| **TaskRoots** | 一张单的根集合（派单时钉住） | `TaskRecord.workspaceRoot` + `readRoots` | primary 可写 | 契约卡 |
| **Scratch** | 过程文件（下载、解压、日志、测试缓存） | 无 | 是 | 自动 |
| **Deliverables** | 交付物（用户要带走的） | evidence 混在一起 | 是 | 任务约定 |
| **Artifacts** | 卷宗里的永久副本 | `tasks/<id>/artifacts` | 否（只读归档） | 验收时固化 |

> 核心变化：**"工作区"从一个路径变成一个带模式、带来源、带作用域的根列表**。界面只说"能读 / 能写"，不说 `projectRoot`。

### 3.2 数据结构（草案）

```ts
type RootMode = "rw" | "ro";
type RootScope = "default" | "session" | "team" | "task";

interface Root {
  path: string;          // 绝对路径，落盘前 realpath 解析
  mode: RootMode;        // 默认 ro
  scope: RootScope;
  label?: string;        // 界面短名（如「客户资料 D 盘」），避免长路径噪音
  addedAt: string;
  addedBy: "user" | "inherit";
}

interface RootSet {
  /** 主根：唯一 rw，@ 检索/附件/Pi cwd 的基准；可以为空（sandbox-only 模式） */
  primary?: string;
  extras: Root[];        // 附加根，ro 或 rw
}

interface ThreadMeta {
  // 旧 projectRoot 迁移为 roots.primary
  roots?: RootSet;
}

interface TeamRecord {
  // 建队时从会话派生；后续任务默认继承
  roots?: RootSet;
}

interface TaskWorkspace {
  mode: "project" | "sandbox";
  root: string;          // project=会话 primary；sandbox=~/.lynn/tasks/<id>/workspace
  deliverablesDir: string;
  scratchDir: string;    // 永远在数据根内，永不污染用户项目
  roots: Root[];         // 任务级附加根（含用户批准）
}

interface TaskRecord {
  workspace?: TaskWorkspace;   // 替换现有 workspaceRoot / readRoots
  deliverables?: DeliverableRef[]; // 验收时固化
}
```

### 3.3 继承与收窄规则

```
DefaultRoot（设置）
   └─ SessionRoots（会话，用户可改）
        └─ TeamRoots（建队时快照，可改）
             └─ TaskRoots（派单时快照，可改）
                  └─ Member effective roots（运行时只读派生）
```

- **可写主根**：继承只传一个 `primary`。任务可以选择 `sandbox` 模式，表示"这单不碰用户项目"。
- **只读附加根**：**取并集**（default ∪ session ∪ team ∪ task）。任务只能**新增**，不能删除上层给的只读根——否则成员会以为"用户没给我看"，又去撞墙。
- **可写附加根**：默认不继承（写扩权必须逐次由用户确认）。
- **扩权**：只有用户入口（设置页 / 会话 chip / 契约卡 / 右键）能加 `rw`；模型工具面永远没有这个能力。
- **撤销**：用户可撤销任意一层；撤销只影响之后启动的成员（运行中的成员下一轮生效）。

### 3.4 解析顺序（消除隐式沿用）

```
1. 当前会话有 roots          → 用它
2. 当前任务有 workspace      → 用它（任务级覆盖会话）
3. 团队有 roots              → 用它
4. 设置里有 defaultWorkspace → 用它
5. 都没有                    → sandbox-only（primary = 空）
```

**永远不再"沿用上一个会话的根"**。第 5 种是合法状态，不是错误：纯对话、查资料、临时整理都该走它，产出落 `~/.lynn/tasks/<id>/workspace`。

---

## 4. 工作区在哪里设定（场景矩阵）

| 场景 | 现在 | 改成 | 用户入口 | 可为空 |
|---|---|---|---|---|
| **首次启动** | 无提示，默认 `~/.lynn/project` | 自动建 `~/LynnWorkspace`（界面名「我的工作区」）并落一张卡（**不弹框**） | 卡上「换一个」/设置页 | 是（选"先不用工作区"） |
| **新建会话** | 强弹原生目录框 | **不弹框**：默认继承当前会话根；若当前无根则用 DefaultRoot；会话头 chip 显示 | chip → 沿用 / 换目录 / 无工作区 | 是 |
| **无会话直接发消息** | 就地建会话 + 隐式全局根 | 就地建会话，根 = DefaultRoot，消息上方一行「本条在 X 里」 | 该行可点改，仅影响本条之后 | 是 |
| **控制台模式** | 只读展示 | 底部 `/cd` chip；命令面板支持 `cd <path>`、`cd -`（回默认）、`cd --none` | 控制台顶部 chip | 是 |
| **风铃派单** | `workspace ?? projectRoot` | `workspace` 三态：省略=继承会话；绝对路径=项目模式；`"sandbox"`=任务沙箱 | 契约卡展示并可改（改根要重签） | 否（必须有落点） |
| **团队** | 无 | `create_team` 时快照会话根；复用模板时带上次的根 | 团队卡显示，可改 | 是 |
| **中途换根** | 改全局，重载一堆东西 | 只改当前会话；任务已开工则**不自动跟随**，需风铃重新派单或用户确认 | 顶栏 chip | — |
| **外部材料** | 只能按单、右键、逐个授权 | 会话级「可读目录」一次给多个；任务继承；盘根需二次确认 | chip → 可读目录 / 设置页 | — |

### 4.1 交互与文案（不引入术语）

- 顶栏 chip：`工作：my-project ▾`；无根时 `工作：临时（产出在任务卷宗）`。
- chip 下拉三项：**用这个目录…** / **这次不用工作区** / **可读目录（N）**。
- 会话首条消息下方一行小字：`写入 my-project；可读：客户资料、D:\归档`。点开可改。
- 派单契约卡：`工作区（可写）：my-project\deliverables\T-1024\` + `可读：…`，两行都能点「改」。
- 删除确认：`将删除：工单、卷宗、3 个临时文件（共 42MB）` / `不会动：my-project 里的 12 个文件`。

> 关键：**不再出现 `projectRoot` / `subdir` / `workspaceRoot` 这些词**；界面统一「工作区 / 可读目录 / 交付物 / 临时文件」四个词。

---

## 5. 只读多目录 / 整盘授权

### 5.1 三级授权模型

| 级别 | 存放 | 典型用途 | 谁能加 | 生命周期 |
|---|---|---|---|---|
| **L0 全局常用根** | `settings.json` → `knownReadRoots[]` | `D:\客户资料`、`\\nas\共享` | 用户（设置页，可多选） | 长期，跨会话 |
| **L1 会话根** | `ThreadMeta.roots.extras` | 本次要审的那个仓库 | 用户（chip，可多选） | 跟会话 |
| **L2 任务根** | `TaskRecord.workspace.roots` | 这单才需要的测试数据 | 用户（契约卡 / 右键；风铃可**申请**） | 跟工单 |

成员有效只读根 = `L0 ∪ L1 ∪ L2`（去重 + 前缀包含时保留最短根）。

### 5.2 多选与整盘

- `app.pickDirs`：`properties: ["openDirectory","multiSelections"]`，一次选多个，返回 `string[]`。
- 拖一个目录到窗口 = 弹出「作为只读根加入？」确认卡（不做静默授权）。
- **整盘只读授权**（已定稿，见 §11-D4）：允许，但必须走三段门——
  1. 勾选「我知道这是整盘，只读」；
  2. **手输盘符确认**（如输入 `D` 才生效）；
  3. 落 `audit.jsonl` + 会话卡明示。
  仍永久拒绝：`C:\`（系统盘根）、`C:\Windows`、`C:\Program Files*`、`DataRoot`、用户主目录顶层（`C:\Users\<name>`）。
- **整盘永不可写**：`rw` 根必须是指定目录，盘符根只能是 `ro`。
- UNC 网络路径：允许只读，但明确提示"网络盘读慢、可能断"；不作为主根（对齐 Claude Code 对网络路径的处理）。

### 5.3 授权的作用面（要一起改的地方）

| 能力 | 可用的根 | 说明 |
|---|---|---|
| `read_file` / `list_dir` / `glob` / `grep` | primary + 所有 ro/rw 附加根 | 现有 `resolveReadable` 已支持，只需把根来源换成 RootSet |
| `office_read_table` | 同上 | 已在做（`toolkit.ts:576`） |
| `write_file` / `edit_file` | primary + rw 附加根 | 仍走 `resolveWithin`；`ro` 根直接拒 |
| `run_command` 的 cwd | primary + **rw** 附加根 | `ro` 根不跑命令：读授权解决"看"，不解决"跑" |
| `@` 文件检索 / 附件 | primary（+ 可选附加根） | 先只搜 primary，避免结果爆炸；附加根命中时标注来源 |
| `submit_report.evidence` | **任意可读根**（修复 D6） | 见 5.4 |
| `browser_*` / `kb_add` | 与根无关 | 不变 |

### 5.4 证据原则 vs 只读根的冲突（P0 真 bug）

**现状**：`member-runner.ts:249-253`

```ts
const missing = evidence.filter((e) => !fs.existsSync(resolveWithin(input.workdir, e)));
```

只读授权目录里的文件因越界被判"不存在"，成员审完外部项目后**拿不出证据**，工单卡在 `in_progress`。

**修法**：

1. 证据形状从 `string` 改为 `{ path: string; root?: "workspace" | "read" }`，或允许绝对路径且校验时走 `resolveReadable` 的同一套根集合。
2. 卷宗收录时记录来源根，`verifyRef` 支持多根。
3. 显示名保持成员原文，`ref` 用解析后的绝对路径（现有 `displayNames` 机制可复用）。
4. **只读根里的文件可以作为证据，但不会被复制进 artifacts**（避免把用户项目整份拷走）；只登记引用，用户点开仍在原位置。

### 5.5 路径安全

- 所有根 `fs.realpathSync.native` 解析后再做前缀比较；写路径比较**大小写不敏感**（Windows）。
- 解析 symlink/junction：解析后的真实路径必须仍在允许根内（参考 Claude Code：allow 要求"请求路径与解析目标都匹配"，deny 任一匹配即拒）。
- 拒绝 `DataRoot` 及其子目录；拒绝盘符根（除显式整盘只读）。
- 授权/撤销写 `audit.jsonl`（`grant_read` / `revoke_read`），可在设置页查。

---

## 6. 产出、测试、临时文件放哪

### 6.1 两种任务模式

| 模式 | 什么时候用 | 可写主根 | 优势 |
|---|---|---|---|
| **project** | 改代码、改文档、在真实项目里干活 | 会话 primary（用户项目） | 成员能真改、能跑构建测试 |
| **sandbox** | 研究、整理、一次性加工、没选定项目 | `~/.lynn/tasks/<id>/workspace` | 不污染用户项目，删起来干净 |

派单时风铃按简报判断；用户可在契约卡上改。**默认跟随会话**：会话有主根 → project；会话无根 → sandbox。

### 6.2 目录约定（三条线分开）

```
project 模式
<sessionRoot>/
  ├─ 源码/文档 …            ← 成员就地改（这是交付物的一部分）
  ├─ deliverables/<taskId>/ ← 生成物（报告、xlsx、图、导出）
  │    └─ .gitignore        ← 内容 `*`：生成物不进用户的 git status
  └─ .lynn/                 ← 仍拒写

sandbox 模式
~/.lynn/tasks/<taskId>/
  ├─ workspace/             ← 成员可写（= 根）
  │    └─ deliverables/     ← 生成物
  ├─ scratch/               ← 过程文件（下载、解压、缓存、测试输出）
  ├─ artifacts/             ← 验收固化（永久）
  ├─ task.json / timeline.jsonl / summary.md / _brief.md
  └─ _brief.md              ← 简报（保持在卷宗，不污染项目）
```

**规则**

1. **代码/文档改动就地做**（project 模式），不要先写到别处再复制——否则 diff、检查点、撤销全部失效。
2. **生成的成品进 `deliverables/<taskId>/`**，与源码分开，便于打包带走。
3. **过程文件永远进 `scratch/`**（数据根内），并注入环境变量 `LYNN_SCRATCH`、`TMPDIR`，让 `npm test`、解压、下载默认落在可清理的位置。
4. **测试代码属于项目**（`tests/` 就地写），**测试输出/缓存**进 scratch。
5. `.git/`、`.lynn/` 仍拒写；`node_modules`、`dist` 允许（用户项目本来就这样），但删除类命令仍需审批。
6. `deliverables/` 首次写入时自动落一个 `.gitignore`（内容 `*`），避免生成物污染用户的 `git status`；该文件本身不删。
7. 界面另设**交付箱**视图：跨任务汇总所有 `deliverables`（文件名 / 大小 / 所属单 / 打开 / 另存为 / 导出 zip），但**物理文件不搬家**——项目里的留在项目里，sandbox 里的留在卷宗里。

### 6.3 交付物判定标准（DDR）

一个文件算"交付物"，当且仅当满足任一：

- 成员在 `submit_report` 里显式列进 **`deliverables[]`**（与 `evidence[]` 分开）；
- 用户验收时点名"这个文件我要"；
- 位于 `deliverablesDir` 下且非空。

其余一律算**过程证据**（可点开看，但不承诺保留）。

实现：

- `submit_report` schema 增加 `deliverables`（相对工作区路径数组）；提示词明确"交付物列这里，证据列 evidence；交付物会永久保留"。
- 验收台分两栏：**交付物**（默认展开，显示大小/路径/打开）/ **过程证据**（折叠）。
- `task.json` 增 `deliverables: DeliverableRef[]`，验收通过时写死。

### 6.4 artifacts 策略（修 D11）

- 只复制 **deliverables + 关键证据**，不再复制每一条 evidence。
- 单文件阈值 10MB：超过只登记引用（绝对路径 + 大小 + mtime），不复制。
- 单任务配额 500MB（可配）：超了在验收台提示"仅登记引用"。
- 同名不覆盖（现有逻辑保留）；未变的文件按内容 hash 去重。
- 卷宗支持「导出为 zip」（交付物 + timeline + summary），给用户一个能带走的包。

---

## 7. 生命周期与清理

### 7.1 状态 × 目录

| 工单状态 | scratch | sandbox workspace | deliverables | artifacts |
|---|---|---|---|---|
| `backlog/todo` | 保留 | 保留 | 保留 | 空 |
| `in_progress` | 保留 | 保留 | 保留 | 逐步写入 |
| `in_review` | 保留 | 保留 | 保留 | 已固化 |
| `blocked` | 保留 30 天 | 保留 90 天 | 保留 | 保留 |
| `done` | **14 天后自动清** | **90 天后清理**（交付物已固化） | **永久** | **永久** |
| `canceled` | **7 天后自动清** | **30 天后清理** | 保留（若已声明） | 保留 |
| 用户删除 | 立即删 | 立即删 | 先固化再删 | 立即删 |
| 删除会话 | 随单 | 随单 | 见下 | 随单 |

### 7.2 清理分级

**A. 自动（不打扰）**

- `logs/*.log` 轮转（已有 5MB 轮转，追加按天归档、保留 7 天）；
- `checkpoints/` 超过 7 天；
- `scratch/` 按上表 TTL；
- 崩溃残留 worker / 临时目录；
- `tasks/_archive/` 里 sandbox workspace 超过 90 天且交付物已固化——**删前先压成 `artifacts/task-workspace.zip`**（保留一棵完整树，体积远小于散文件），再删原目录。
- 所有保留天数集中在 `Prefs.retention`（`scratchDays` / `sandboxDays` / `checkpointDays` / `logDays`），设置页可改，改小立即生效但**只影响下次扫描**。

**B. 提示（一键清理，显示预计释放）**

- 归档带里超过 90 天的单；
- 无主单（现有 `purgeOrphanTasks`）；
- artifacts 超配额的单；
- `~/.lynn/project`（旧默认目录）迁移后剩余内容。

**C. 永不自动**

- `deliverables/`（无论项目内还是 sandbox 内）；
- `done` 单的 `artifacts/`；
- 用户项目目录里的任何文件（包括成员写的）；
- 用户手动标记「保留」的单。

### 7.3 用量与配额

- 设置 → 数据页显示：`tasks/`（按 scratch / workspace / artifacts 分）、`logs/`、`checkpoints/`、`plugins/`、`knowledge/`。
- 每项一个「清理」按钮，先算再删，显示"预计释放 X MB"。
- 数据盘剩余 < 2GB 时在设置页与派单卡上提示，不静默失败。

### 7.4 删除 / 归档语义修正（修 D13）

- `removeTask` 返回结构改为 `{ ok, removed: Item[], kept: { path, reason }[] }`。
- 界面二次确认分两段：
  - 「将删除」：工单、卷宗、N 个临时文件（共 X MB）；
  - 「不会动」：用户项目里的文件（列前 5 个 + 总数）。
- **project 模式**：只删数据根内元数据与 scratch；用户项目不动。
- **sandbox 模式**：删之前先检查 `deliverables` 是否已固化，未固化先复制进 artifacts 并提示。
- 删会话级联删单：同上，且删完给一张卡说明"哪些文件留在了你的项目里"。
- `archiveOld` 保持只移动不删除；归档单在界面上仍可搜。

---

## 8. 开源同类产品参考

### 8.1 Codex：主根 + `writable_roots` + 独立 tmp

源码（`F:/tmp/ref-codex/codex-rs/protocol/src/protocol.rs:1206-1224`）：

```rust
/// Same as `ReadOnly` but additionally grants write access to the current
/// working directory ("workspace").
WorkspaceWrite {
    /// Additional folders (beyond cwd and possibly TMPDIR) that should be writable.
    writable_roots: Vec<AbsolutePathBuf>,
    network_access: bool,
    /// When true, will NOT include the per-user `TMPDIR` ... among the default writable roots.
    exclude_tmpdir_env_var: bool,
    exclude_slash_tmp: bool,
}
```

**借什么**

- 主根 = cwd，附加根是可写根列表，**不是**"另选一个工作区"；
- `TMPDIR` 默认可写、可排除 —— 承认"过程文件需要一个默认落点"；
- 沙箱策略（写哪儿）与审批策略（要不要问）**正交**：我们现在的"权限四档"也应该与根集合正交，`full` 不等于"全盘可写"。

### 8.2 Claude Code：`additionalDirectories` + 读写分离的硬边界

官方文档（settings / permissions）确认：

- `permissions.additionalDirectories` 把额外目录加入"工作目录集合"：**读与主目录同等（免提示），编辑跟随当前 permission mode**；settings 键形式**只给文件访问，不加载 `.claude/` 配置**；
- `--add-dir` / `/add-dir` 额外还会加载该目录的 skills/commands/agents/settings 子集；
- `permissions.blockReadsOutsideWorkingDirectories`（v2.1.257+）与 `blockWritesOutsideWorkingDirectories`（v2.1.314+）**分别**拦截目录外的读与写；
- 路径规则锚点：`//path` 绝对、`~/path` home、`/path` 相对 settings 来源；**符号链接 allow 要求请求路径与解析目标都匹配，deny 任一匹配即生效**；
- 网络路径不能作工作目录，Windows 上要先映射盘符；
- 子代理是否继承目录权限，官方页面**没有明确表述**（只讲了 `Agent(...)` 规则控制可用性）。

**借什么**

- "额外目录 = 工作目录集合的扩展"这个心智，比"另一个工作区"更简单；
- **读、写用两个独立开关**（我们现在只有"工作区可写 / 只读根"两档，但缺少"是否允许越界读"的总闸）；
- 符号链接的双向校验；
- 我们比它多走一步：**明确声明成员继承规则**（对方文档留白，我们不能留白）。

### 8.3 VS Code 多根工作区：`folders[]`

`.code-workspace` 的形态是 `{ folders: [{ path, name }], settings: {...} }` —— **根有名字、有顺序、可多个**。

**借什么**：`Root.label` 让界面显示「客户资料」而不是 `D:\2026\Q3\客户资料\原始数据`；多根是一个正常形态，不是补丁。

### 8.4 Aider：`--read` 只读文件 / 目录

Aider 允许把文件或目录以 **read-only** 方式加入上下文（能看、不参与编辑），与"可编辑文件"分开。

**借什么**：这正是我们的 `ro` 根；并且它证明"只读入上下文"是独立于"工作区"的一等概念。

### 8.5 OpenHands / Devin：`/workspace` 挂载点

任务级容器把项目挂在 `/workspace`，产物通过挂载/导出取回。

**借什么**：任务有自己的"挂载点"，与宿主目录解耦；这对应我们的 `sandbox` 模式 + `deliverables/`。

### 8.6 OpenCode：配置向上合并，worktree 落数据目录

官方文档（config）确认：

- **项目根不是单点**：从 cwd 向上逐层合并 `opencode.json(c)` 与 `.opencode/`，`.opencode/` 恒覆盖同级直接配置；系统级配置压过全部。
- **worktree 默认落在应用数据目录**：`worktree.directory` 未设时用"服务器数据目录 / `worktree/<project-id 前六位>`"；相对路径以项目的 canonical checkout 为基准，不是 cwd。
- **权限两层**：`permissions`（工具-资源级、可被项目覆盖）与 `policies`（系统级强制，求值顺序相反）。
- 没有通用的"额外工作目录"配置，额外上下文靠 `references` / `skills` / `instructions` 三种各自实现。

**借什么**

- "默认落在应用数据目录、不污染项目"正是我们 `sandbox` 模式的形态，证明它不是权宜之计；
- 权限分两层：**可覆盖的会话/任务规则** + **不可覆盖的硬边界（数据根、系统目录）** —— 对应我们"任务可继承但不可扩权"；
- 同时反向印证：OpenCode 靠 cwd 定位项目，**独立 GUI 应用没有 cwd 信号，必须显式 DefaultRoot**，不能靠"猜"。

### 8.7 Zed：线程 = 隔离单元，worktree 只在并发冲突时用

官方文档（agent-panel）确认：

- 工作区组织单位是**线程**，每个线程独立 agent / context / 历史，可同时跑多个；
- 两个线程可能改同一批文件时，**用标题栏 worktree picker 把其中一个隔离到新 Git worktree**——worktree 是**并发冲突的解法**，不是默认状态；
- 工具可见性（Agent Profiles）、调用门控（Tool Permissions）、外部扩展（MCP）三层分开；
- 改动按文件/行数汇总，可逐个 hunk 接受或拒绝。

**借什么**

- 我们的"任务"就是 Zed 的"线程"：**隔离单元**；
- **sandbox 不该是默认**——只有"同一项目并发多单"时才需要隔离；这条直接支撑 §11-D5（默认跟随会话，不默认复制项目）；
- 工具可见性与路径权限**分开配置**（我们现在的权限四档 + RootSet 也应该正交）。

### 8.8 Cline：影子 git 检查点，与项目仓库分离

官方文档（checkpoints）确认：

- Cline 维护**独立的影子 Git 仓库**，与项目真实 Git 历史分离；每次工具使用后提交一次，**连未跟踪文件一起捕获**，跨编辑器会话持久；
- 大仓库会显著占空间、拖慢工具调用，官方明确建议性能有问题就关；
- 提供三种恢复：**只恢复文件 / 只恢复对话 / 两者都恢复**。

**借什么**

- 检查点留在数据根（`~/.lynn/checkpoints`）是对的，不要塞进用户仓库；
- 我们已有 `CheckpointStore`，但缺"恢复对话 / 恢复文件"的分离语义，可后补；
- 大仓库要能一键关检查点（现在没有这个开关）。

### 8.9 对比表

| 维度 | 本方案目标 | 当前 lynn | Codex | Claude Code | OpenCode | Zed | Cline | Aider |
|---|---|---|---|---|---|---|---|---|
| 主根 | 会话 1 个（可空） | 全局 1 个 | cwd 1 个 | primary 1 个 | cwd 向上合并链 | 窗口多 worktree | IDE 工作区 | repo 1 个 |
| 附加根 | 多（ro/rw） | 仅任务 ro | `writable_roots` | `additionalDirectories` | references/skills/instructions | 多 worktree | 多根（随 IDE） | `--read` |
| 读/写分离 | 是 | 是（弱） | 是（沙箱） | 是（两个 block 开关） | 是（permissions/policies） | 是（工具权限） | 靠 auto-approve | 是 |
| 临时目录 | 统一 scratch | 无 | TMPDIR | /tmp | 数据目录 | 系统 tmp | 全局存储 | 无 |
| 任务隔离 | sandbox / project | 有（但混在卷宗里） | worktree/sandbox | worktree | worktree | worktree（按线程） | 无 | 无 |
| 产出目录 | deliverables | 无 | 无约定 | 无约定 | 无约定 | 无约定 | 无约定 | 无约定 |
| 清理策略 | 分级 TTL | 无 | 无 | 无 | 无 | 无 | 检查点需手动关 | 无 |
| 继承链 | 全局→会话→团队→任务 | 无 | 子代理继承 cwd | 未明确 | 配置向上合并 | 线程内继承 | 无 | 无 |

---

## 9. 落地路线（按卡执行）

### P0-1 根集合模型 + 零阻断入口 + 命名统一

**改动**

- 新增 `RootSet` / `TaskWorkspace` 类型；`ThreadMeta.roots`、`TeamRecord.roots`、`TaskRecord.workspace`；`Prefs.defaultWorkspace`。
- `Kernel.projectRoot` 改为**只读派生**（`currentRoots()`），删除全局可变语义；`applyProjectRoot` 拆成 `setSessionRoot()`（只改会话状态，不立刻重建 Pi；根指纹进 `hostStamp`，下一次发消息时惰性重建 worker）。
- 新建会话不弹框：`App.onNew` 直接 `session.new`，默认继承当前会话根；chip 提供三选项。设置里保留「新建会话时询问工作区」开关，**默认关**。
- 无会话发消息：`ensureThreadId` 时写入 DefaultRoot（没有 DefaultRoot 则进无主根 sandbox，并在消息上标注）。
- 首启：建 `~/LynnWorkspace`（ASCII 路径，界面显示「我的工作区」），落卡说明；不阻塞。
- 快照去掉硬编码 `subdir: "指挥台"`，改为根集合摘要。
- 统一术语：代码内注释、界面文案、i18n 全部换掉 `projectRoot/subdir/workspaceRoot`。

**验收**

- 4 个测试：无会话发消息落默认根；新建会话不弹框且继承；切旧会话不串目录；首启创建默认根。
- 界面走查：顶栏 chip / 契约卡 / 控制台配置页三处显示一致。

**风险（已核实）**：Pi worker 的 `cwd` 只在 spawn 时传入（`pi-rpc-host.ts:153-154`），而 `ensureHost` 的重建指纹 `hostStamp`（`kernel.ts:2732`）**不包含 projectRoot**——现在换根全靠 `applyProjectRoot` 里显式 `resetAgentHost()`。改造后必须把根指纹并入 `hostStamp`（例如 `roots:${primary}`），否则换根后 Pi 的 cwd 还是旧的、@ 检索却已经变了，出现"界面一个目录、命令另一个目录"。chip 上注明"下一条消息起生效"。

### P0-2 证据可来自只读根（修 D6）

- `submit_report` 证据改为多根解析；`TaskCase.verifyRef` 接受根集合。
- 只读根证据只登记引用，不复制 artifacts。
- 测试：只读根文件作证据 → `verified=true`，工单能进 `in_review`。

### P0-3 删除语义与文案对齐（修 D13）

- `removeTask` 返回 removed/kept；界面两段式确认；project 模式不动用户项目；sandbox 先固化交付物。
- 测试：两种模式各一条，断言用户项目文件仍在、返回清单正确。

### P1-1 三级只读授权 + 多选 + 整盘逃生门

- `app.pickDirs`（多选）、`workspace.roots.add/remove`（支持批量）、设置页「常用可读目录」。
- 授权来源三级合并；撤销只影响后续。
- 盘根走三段门（勾选 → 手输盘符 → 审计）+ 系统目录/DataRoot 黑名单；**盘根不可设为 rw**。
- `rw` 附加根单独入口（默认折叠），逐次确认，同样进审计。
- 测试：多选落库、整盘需手输确认、盘根写被拒、黑名单拒、成员可见并集。

### P1-2 团队/任务继承

- `create_team` 快照会话根；`assign_task` 省略 workspace = 继承团队/会话；`"sandbox"` 关键字。
- 契约卡展示并允许改（改根需重签）。
- 测试：团队根 → 任务根 → 成员 effectiveRoots 的并集断言。

### P1-3 产出目录 + 交付物

- `submit_report.deliverables`；`deliverablesDir` 约定；验收台两栏；`task.json.deliverables`。
- 测试：交付物进 artifacts、过程证据不复制、超过 10MB 只登记引用。

### P2-1 清理与用量

- TTL 清理器（启动 + 每日）；设置页用量面板；一键清理；删除清单。
- 测试：TTL 边界、永不清理项、配额提示。

### P2-2 命令 cwd 放宽 + 控制台 `cd`

- `run_command` 允许 `cwd` 只能是 primary 或 rw 附加根；`cd` 命令改会话根。
- 测试：ro 根 cwd 被拒、rw 根可跑、控制台命令改根不影响别的会话。

### P2-3 artifacts 去重/导出

- hash 去重、配额、卷宗 zip 导出。

### P2-4 审查快照（只读根要跑测试的解法）

- 只读授权解决"看"，不解决"跑"。审查一个项目要跑它的测试时，提供一键**「拷进任务沙箱跑」**：把项目（排除 `node_modules`/`dist`/`.git` 大目录，可配）复制到 `tasks/<id>/workspace/`，任务切 sandbox 模式执行；产物与测试输出都留在卷宗，不碰原项目。
- 优先用硬链接 / `robocopy /MIR` 之类的快速复制；复制前显示预计体积。
- 不做"只读根里跑命令"：命令无法可靠判定是否只读，放开等于放弃边界。
- 测试：复制后原项目未被修改；副本里能跑通测试并交证据。

### P2-5 交付箱视图

- 跨任务汇总 deliverables（文件名 / 大小 / 单号 / 打开 / 另存为 / 导出 zip）；物理文件不搬家。
- 测试：验收后出现在交付箱；删除工单后从交付箱消失但 artifacts 仍在。

---

## 10. 兼容与迁移

启动时一次性迁移（写 `~/.lynn/.workspace-migrated` 标记，失败不阻塞启动）：

| 旧数据 | 新形态 |
|---|---|
| `ThreadMeta.projectRoot` | `roots.primary`；无值 → 空（不再继承） |
| `TaskRecord.workspaceRoot` 在数据根外 | `workspace.mode = "project"` |
| `TaskRecord.workspaceRoot` 在数据根内（`tasks/<id>/workspace`） | `workspace.mode = "sandbox"` |
| `TaskRecord.workspaceRoot` 缺失 | `sandbox`，并在工单卡上标「老单，未指定工作区」 |
| `TaskRecord.readRoots` | 合并进 `workspace.roots`（`mode: "ro"`） |
| `~/.lynn/project` 有内容 | 保留，进"待清理"提示，不自动删 |
| `Prefs` 无 `defaultWorkspace` | 取 `~/LynnWorkspace`，首次启动创建 |

**不做**：不搬动用户项目里的任何文件；不重命名现有 `tasks/<id>` 目录。

---

## 11. 决策记录（已定稿，2026-11-10）

> 结论先行：**工作区必须显式、可继承、读宽写窄；产物留在用户能看见的地方，过程文件留在应用能清理的地方。** 下面 6 条是主决策，后面 8 条是由此推导出的连带决定，不再单列问题。

### D1 首启默认根 = `~/LynnWorkspace`（界面名「我的工作区」）

- **定论**：首次启动自动创建并落卡，不弹框；用户可改成任意目录，也可选「先不用工作区」。弃用 `~/.lynn/project`。
- **理由**：独立 GUI 启动时**没有任何 cwd 信号**；应用数据目录用户永远不会去翻；`Documents` 在 Windows 上常被 OneDrive 重定向，生成物会引发同步噪音；ASCII 路径避免成员跑命令时在中文目录上翻车（npm/node/Python 工具链仍偶发）。无主根保留为合法状态，但**不作为默认**——否则新手的第一份产出就埋在 `~/.lynn` 里。
- **参考**：OpenCode 从 cwd 向上合并配置、Codex 以 cwd 为工作区、Claude Code 以 primary working directory 锚定路径——它们都有 cwd 可依，lynn 没有，所以必须显式给默认值。

### D2 新建会话不弹目录框；默认继承，chip 可改

- **定论**：`session.new` 直接开，根继承当前会话；当前无根则用 DefaultRoot；会话头 chip 三选项（换目录 / 不用工作区 / 可读目录）。设置里保留「新建会话时询问」开关，**默认关**。
- **理由**：阻断式原生对话框把"选择"变成了"每次都要过的关"；多数会话沿用同一个项目；可见的 chip 比一次性的对话框更可纠错，也不打断心流。
- **参考**：Claude Code 用 `/add-dir`、`/cd` 而非启动弹框；Zed 的线程绑定 worktree，由 picker 按需选而不是每次新建强制询问；OpenCode 直接用 cwd。

### D3 允许「附加可写根」，默认关、逐次确认、模型永不可添加

- **定论**：`Root.mode = "rw"` 支持多根；入口只在用户侧（chip / 契约卡 / 设置），每次确认并落审计；任务继承只能收窄。**整盘永不可设为 rw**。
- **理由**：真实开发经常跨 repo + 共享库 + 生成目录；只给一个可写根会逼成员"复制—改—再复制"，diff/检查点/撤销全失效。但默认开等于把"写"变成默认行为，违背"读宽写窄"。折中是默认关、逐次授权。
- **参考**：Codex `WorkspaceWrite.writable_roots` 原生支持多个可写根；Claude Code `additionalDirectories` 的写随 permission mode 走，不是无条件放行。

### D4 整盘只读授权允许，但走三段门

- **定论**：非系统数据盘（`D:\`、`E:\`…）可整盘**只读**：勾选风险确认 → 手输盘符 → 审计 + 卡上明示。永久拒绝：`C:\`、`C:\Windows`、`C:\Program Files*`、`DataRoot`、`C:\Users\<name>` 顶层。UNC 网络盘可只读，不作主根。
- **理由**：用户的资料本来就按盘组织，逐目录点选正是"不必要的边界限制成员工作"；只读风险可控（写、删、命令 cwd 都不在盘根上）；手输盘符能挡住误点，不挡真需求。
- **参考**：Claude Code 对网络路径要求先映射盘符（说明盘根并不天然危险，危险的是写）；Codex 的 `writable_roots` 只接受目录，可写从不给盘根。

### D5 交付物：项目内 `deliverables/<taskId>/`，验收再固化一份

- **定论**：project 模式生成物落 `<sessionRoot>/deliverables/<taskId>/`（自动 `.gitignore` 内容 `*`）；sandbox 模式落 `<workspace>/deliverables/`；验收时复制进 `~/.lynn/tasks/<id>/artifacts/`（≤10MB，超阈值只登记引用）。另设「交付箱」汇总视图，但物理文件不搬家。
- **理由**：用户要能直接打开、直接带走；集中到 `~/.lynn` 会被"清数据/卸载"顺手带走；项目内又必须解决 `git status` 污染，`.gitignore` 是最小代价。artifacts 副本解决"项目删了/搬了还能找回"。
- **参考**：Codex / Claude Code / Zed 都把产物留在工作区（cwd / worktree），没有任何一家做"集中交付仓库"；Cline 的全局存储只放检查点，不放产物。

### D6 清理 TTL：过程 14/90 天，交付物与证据永久

- **定论**：`scratch` 14 天、sandbox workspace 90 天（**删前压 `artifacts/task-workspace.zip`**）、`logs` 7 天、`checkpoints` 7 天；`deliverables` 与 `done` 单的 `artifacts` **永久**；全部进 `Prefs.retention` 可配。用户项目目录、数据根外的文件**永不自动删**。
- **理由**：过程文件增长最快、价值最低；sandbox 是完整工作树，直接删会丢追溯，压 zip 是体积与可追溯的折中；交付物与证据是用户资产，自动删等于毁约。
- **参考**：Cline 官方明确警告检查点"可能占显著存储并拖慢工具调用，性能有问题就关"——说明这类数据必须可控；但没人敢自动删用户产物。

### 连带决定（推导而来，不再询问）

| # | 决定 | 理由 |
|---|---|---|
| 7 | 团队根在 `create_team` 时快照会话根；**团队模板不带根** | 模板复用的是"人"，不是某个项目；带根会把 A 项目的路径带到 B 项目 |
| 8 | 任务默认模式跟随会话（有主根 → project；无根 → sandbox）；**不默认复制项目** | Zed 的 worktree 只在"两个线程可能改同一批文件"时才用；默认复制会让用户以为在改真项目 |
| 9 | 审查要跑测试：不放开 `ro` 根执行，提供「拷进任务沙箱跑」 | 命令无法可靠判定只读，放开等于放弃边界；复制跑既安全又能留证据 |
| 10 | 成员证据可来自任意可读根；只读根证据**只登记不复制** | 修复 D6；避免把用户项目整份拷进 artifacts |
| 11 | `run_command` 的 cwd 仅 primary + `rw` 附加根 | 同上，"看"与"跑"分开 |
| 12 | 删除：数据根外一律不动，两段式清单 | 修 D13；用户对"删了什么"必须有知情权 |
| 13 | 权限四档与根集合**正交**：`full` 不等于全盘可写 | Codex 的 approval × sandbox 就是正交模型；混在一起会让"放手模式"变成"全盘写" |
| 14 | 网络盘只读、不作主根 | 断连/延迟会让 Pi 与命令卡死；Claude Code 同样限制 |

### 与现状的差异（一句话版）

| 维度 | 现在 | 定稿后 |
|---|---|---|
| 默认根 | `~/.lynn/project` | `~/LynnWorkspace` |
| 新会话 | 强弹框 | 不弹，继承 + chip |
| 无会话发消息 | 隐式全局根 | 显式 DefaultRoot，消息上标注 |
| 可读范围 | 工作区 + 逐单单目录 | 全局/会话/任务三级，多目录，可整盘只读 |
| 可写范围 | 一个 | primary + 用户逐次授权的 rw 根 |
| 团队继承 | 无 | 建队快照 → 任务继承 → 成员派生 |
| 产出 | 混在工作区 | `deliverables/` + artifacts 固化 + 交付箱 |
| 临时 | 无约定 | `scratch/` + `LYNN_SCRATCH` |
| 清理 | 只增不减 | 分级 TTL，交付物永久 |
| 删除 | 文案与行为不一致 | 两段式清单，数据根外不动 |

---

## 12. 一页图（目标形态）

```
┌ 设置：默认工作区 ~/LynnWorkspace（界面「我的工作区」）
│        常用可读根 [D:\客户资料] [\\nas\共享] [E:\ (ro，整盘)]
│
├ 会话 A ── roots { primary: ~/LynnWorkspace,
│                    extras: [D:\客户资料 (ro)] }
│    │
│    ├ 团队「Q3 订单核对」 roots（快照自会话）
│    │    │
│    │    ├ 任务 T-1024  workspace { mode: project,
│    │    │                root: <会话 primary>,
│    │    │                deliverables: <root>/deliverables/T-1024/,
│    │    │                scratch: ~/.lynn/tasks/T-1024/scratch/,
│    │    │                roots: [+D:\客户资料 (ro)] }
│    │    │      └ 成员 阿明：可写 = primary；可读 = primary + D:\客户资料
│    │    │
│    │    └ 任务 T-1025  workspace { mode: sandbox, ... }
│    │
│    └ 任务 T-1026（无会话时发起）→ 自动建会话，继承默认根
│
└ 会话 B ── roots { primary: 空 }  ← 临时对话，产出落任务卷宗
```

---

## 附录 A：RPC / 契约变更清单

| 变更 | 说明 |
|---|---|
| `app.pickDirs` | 新增，多选；`app.pickDir` 保留兼容 |
| `workspace.get` / `workspace.set` | 新增：读/改会话根集合 |
| `workspace.roots.add` / `remove` | 新增：批量加/撤，带 scope 与 mode |
| `session.new` | `projectRoot` 继续可用；新增 `roots?: RootSet` |
| `project.setRoot` | 保留，语义改为"设当前会话 primary" |
| `task.grantRead` | 参数支持 `dirs: string[]`；单 `dir` 兼容 |
| `task.deliverables` | 新增：列出交付物 |
| `task.remove` | 返回 `{ removed, kept }` |
| `submit_report` | 新增 `deliverables: string[]` |
| `feed.send` | 可选 `workspaceHint`（本条临时用哪个根，不落会话） |
| `task.snapshotProject` | 新增（P2-4）：把只读项目复制进任务沙箱跑测试 |
| `prefs.defaultWorkspace` / `prefs.knownReadRoots` / `prefs.retention` | 新增 |

## 附录 B：必须同步改的提示词

- `persona.ts`：派单三问里"工作区"改为"落点"——项目模式 / 任务沙箱，二选一必须说清。
- `member-runner.ts` 的 `memberSystemPrompt`：
  - 明确三条路径：工作区（可写）、可读根（只读、用绝对路径）、scratch（临时）；
  - 明确交付物写 `deliverables/`，并要在 `submit_report.deliverables` 里列出来；
  - 明确证据可以来自可读根（不再暗示"只能在 workspace"）。
- `builtin-skills/plugin-dev`：工坊草稿仍是独立根，不受会话根影响（现状正确）。

## 附录 C：暂不做（避免范围膨胀）

- OS 级沙箱（M1-11）不在本方案内；本方案只做**应用层路径边界**，文案不承诺隔离。
- 不做 git worktree 自动隔离（Zed/Codex 的做法；我们的"审查快照"是用户显式触发的复制，不是自动 worktree）。
- 不做网络盘为主根、不做跨盘写扩展的自动探测（都要用户显式授权）。
- 不做"成员之间共享写入同一主根"的并发保护（同项目并行多单仍靠 sandbox 隔离或用户排期，P3 再看）。

---

## 13. 实施进度（2026-11-10）

验证基线：`npm run typecheck` 0 错、`npm run lint:design` 通过、`npm test` **434 条（433 过；`pi-rpc-smoke` 单跑必过，全量并发时偶发冷启动超时，已把该用例超时提到 180s）**。新增 `tests/workspace-roots.test.mjs` 9 条、`tests/cleanup.test.mjs` 3 条、`tests/workspace-extra.test.mjs` 5 条、成员只读根证据/交付物 2 条。

| 卡 | 状态 | 落地内容 |
|---|---|---|
| P0-1 根集合 + 零阻断 | ✅ | `src/main/roots.ts`（RootSet/继承/读写派生/禁区）；`ThreadMeta.roots` + `ThreadStore.setRoots`；`Kernel.roots` + `setSessionRoots`；默认工作区（设置 > `LYNN_PROJECT_DIR` > `~/LynnWorkspace`，隔离环境落 `dataRoot/workspace`）；新建会话不弹框、继承当前根；无会话发消息就地建会话落默认根；`hostStamp` 加根指纹；快照去掉硬编码 subdir |
| P0-2 证据跨只读根 | ✅ | `member-runner` 用 `resolveReadable(工作区, 只读根)` 校验证据；`resolveMemberPath` 统一解析；只读根证据只登记绝对引用、不复制 artifacts |
| P0-3 删除语义 | ✅ | `removeTask` 返回 `{ removed, kept }`；共享工作区/用户项目一律不动，文案分开说；界面提示 kept |
| P1-1 多目录/整盘 | ✅ | `app.pickDirs` 多选；`task.grantRead { dirs }`；`workspace.addRoot/removeRoot/get`；整盘只读需确认、系统盘根永久拒、敏感数据子目录拒；顶栏 chip 菜单（换目录 / 不用工作区 / 加/撤可读目录）+ 设置页「默认工作区 / 常用只读根」 |
| P1-2 团队/任务继承 | ✅ | `TeamRecord.roots` 建队快照；`assign_task` 继承链 显式 > 团队 > 会话 > 沙箱；成员可读根 = 全局常用 ∪ 会话 ∪ 团队 ∪ 任务 |
| P1-3 交付物 | ✅ | `submit_report.deliverables`；`TaskRecord.deliverables/deliverablesDir/scratchDir`；`solidifyDeliverables`（≤10MB 复制 artifacts，超限只登记）；验收页「交付物 / 证据链」两栏；左栏「交付箱」跨任务汇总（物理文件不搬家）；**缺**：导出 zip |
| P2-1 清理与用量 | ✅ | `src/main/cleanup.ts`（scratch 14d / 检查点 7d / 轮转日志 7d；交付物、证据、sandbox workspace 永不自动删）；启动自动跑一次 + `data.usage` / `data.cleanup` RPC + 设置页「存储与清理」用量与一键清理 |
| P2-2 命令 cwd / 控制台 cd | ✅ | `findPathEscape` 支持多根；`run_command` 新增 `cwd`（只许工作区或 rw 附加根，文件写入仍限工作区）；控制台命令栏认 `cd`（空=选目录 / `-`=回默认 / `--none`=不用工作区 / 路径支持相对与 `~`）；命令面板加「换工作区 / 不用工作区 / 加只读目录」 |
| P2-3 artifacts 去重/导出 | ✅ | `TaskCase.importArtifact` 用 sha256 索引去重（同名不同内容仍各存）；`task.export` 生成真实 zip（task.json / timeline / summary / artifacts / 交付清单），`app.openPath` 只允许数据根内路径 |
| P2-4 审查快照 | ✅ | `task.snapshotProject`：把工作区复制进任务沙箱（排除 node_modules/.git/dist 等，>50MB 文件不复制），记录切 sandbox；原项目不动 |
| P2-5 交付箱 | ✅ | 左栏第三视图：文件名 / 所属单 / 大小 / 打开（外部只读根路径只显示不伪装可点） |

**已知遗留**

1. 老工单的 `workspace` 字段是首次开工时补记的；补记前 `mode` 可能按旧 `workspaceRoot` 推断（不影响读写，只影响删除清单文案）。
2. sandbox workspace 目前只统计、不自动清理（避免误删未固化的产物）；由用户在工单删除时处理（P2-1 只清 scratch / 检查点 / 旧日志）。
3. 「拷进沙箱跑测试」是显式复制（不做 git worktree 自动隔离）；复制时排除的大目录需要用户自己 `npm i` 后重建。
4. 单测里内核默认降级直连（`NODE_TEST_CONTEXT`），Pi 真链路只由 `pi-rpc-smoke` 直接起 AgentHost 覆盖；全量并发时该用例仍可能冷启动超时，已把超时提到 180s。
