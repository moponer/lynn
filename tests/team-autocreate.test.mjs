import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { ManagementTools } from "../dist/main/management-tools.js";
import { TeamStore, assertValidTeamId, generateTeamId } from "../dist/main/team-store.js";

/**
 * §4.10.3 修正：团队 ID 是内部主键，不是用户输入项。
 *
 * 真实事故复现：模型被要求传 teamId → 向用户索要 → 用户只能给"团队名" →
 * 连试六种命名规则全回「团队不存在」→ 四个回合卡死，任务一步没做。
 * 这些用例锁住三件事：ID 系统生成、缺团队就地建、绝不把 ID 问题退回给用户。
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-team-"));

test("generateTeamId：名字全是 ASCII 就退化成 slug，中文名退回 team- 前缀", () => {
  const ascii = generateTeamId("chaoxing");
  assert.match(ascii, /^chaoxing-[a-z0-9]+$/, "ASCII 名字应当变成可读 slug");

  const cn = generateTeamId("超星学霸");
  assert.match(cn, /^team-[a-z0-9]+$/, "中文名不参与 slug，ID 只能是 ASCII");
  assert.doesNotMatch(cn, /[\u4e00-\u9fa5]/, "ID 里不能混中文（要当目录名）");
});

test("generateTeamId：撞了就换一个，不会覆盖已有团队", () => {
  const taken = new Set();
  for (let i = 0; i < 20; i += 1) {
    const id = generateTeamId("chaoxing", (c) => taken.has(c));
    assert.ok(!taken.has(id), "生成的 ID 必须是没被占用的");
    taken.add(id);
  }
  assert.equal(taken.size, 20);
});

test("teamId 会当目录名用：路径穿越一律拒", () => {
  for (const bad of ["../escape", "..", ".", "a/b", "a\\b", "x*", "y|z"]) {
    assert.throws(() => assertValidTeamId(bad), /不合法|分隔符|cannot|为空/, `${bad} 必须被拒`);
  }
  assert.equal(assertValidTeamId("超星学霸"), "超星学霸", "中文名当 ID 合法（无分隔符）");
  assert.equal(assertValidTeamId("chaoxing-abc"), "chaoxing-abc");

  const store = new TeamStore(tmp());
  assert.equal(store.teamExists("../../etc"), false, "非法 ID 当不存在，不抛异常打断工具轮");
});

test("create_team：只给名字，ID 由系统生成并落盘", () => {
  const root = tmp();
  const store = new TeamStore(root);
  const tools = new ManagementTools(store, root);

  const created = tools.createTeam("超星学霸");
  assert.ok(created.id);
  assert.equal(created.name, "超星学霸");
  assert.ok(store.teamExists(created.id), "团队目录真的建出来了");

  // 再建同名：不覆盖、直接把既有 ID 返回（覆盖会抹掉成员与战绩）
  const again = tools.createTeam("超星学霸");
  assert.equal(again.id, created.id);
});

test("内核 create_team：模型只传名字，拿回 teamId", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  await kernel.init();

  const out = JSON.parse(kernel.runTool("create_team", { name: "超星学霸" }));
  assert.ok(out.teamId, "必须回一个系统生成的 teamId");
  assert.equal(out.teamName, "超星学霸");
  assert.ok(new TeamStore(root).teamExists(out.teamId));
});

test("assign_task 缺团队时自动建队，不再回「团队不存在」让用户去建", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  await kernel.init();

  const msg = kernel.runTool("assign_task", {
    taskId: "cx-1",
    member: "网页操作员",
    brief: "【目标】打开超星网页并确认登录态\n【完成标准】产出登录态截图文件，页面元素可核对\n【材料与位置】目标网址见简报附带说明\n【限制】不要代填验证码，不要提交任何表单",
    deadline: "2026-11-04 12:00",
  });

  // 关键断言：不许把"团队不存在"当成用户要解决的问题退回去
  assert.doesNotMatch(msg, /团队.*不存在/);
  assert.match(msg, /没有成员|任务契约已呈给用户/, "团队建好后应当走到「缺成员」或「契约已呈」这两步");
  const teams = new TeamStore(root).activeTeams();
  assert.equal(teams.length, 1, "应当自动建出一支在职团队");
});

test("create_member 省略 teamId：绑当前唯一在职队，不要求用户给 ID", async () => {
  const root = tmp();
  const store = new TeamStore(root);
  store.createTeam("t-existing", "既有的队");
  const kernel = new Kernel(root);
  await kernel.init();

  const msg = kernel.runTool("create_member", {
    name: "网页操作员",
    role: "浏览器操作",
    goal: "按简报操作网页",
    tools: ["browser_navigate", "browser_snapshot"],
    boundaries: ["不代填验证码"],
  });
  assert.match(msg, /已招募 网页操作员/);
  assert.match(msg, /t-existing/, "返回里要告诉模型绑到了哪支队伍");
  assert.equal(store.listMembers("t-existing").length, 1);
});

test("create_member 没有团队也不问人：自己建一支再招募", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  await kernel.init();

  const msg = kernel.runTool("create_member", {
    teamName: "超星学霸",
    name: "网页操作员",
    role: "浏览器操作",
    goal: "按简报操作网页",
    tools: ["browser_navigate"],
    boundaries: [],
  });
  assert.match(msg, /已招募 网页操作员/);
  const teams = new TeamStore(root).activeTeams();
  assert.equal(teams.length, 1);
  assert.equal(teams[0].name, "超星学霸", "用户说的名字直接当团队名");
});

test("RPC team.create：界面只给名字，返回系统生成的 ID", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  await kernel.init();

  const r = kernel.handle("team.create", { name: "网页组" });
  assert.equal(r.ok, true);
  assert.ok(r.id, "必须返回系统生成的 teamId");
  assert.equal(r.name, "网页组");
  assert.ok(new TeamStore(root).teamExists(r.id));
});

test("白名单写假工具名：create_member 当场拒，并给出真实名字", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  await kernel.init();

  assert.throws(
    () =>
      kernel.runTool("create_member", {
        name: "网页操作员",
        role: "浏览器操作",
        goal: "按简报操作网页",
        tools: ["browser"], // 旧 schema 里的假名字
        boundaries: [],
      }),
    /browser_navigate/,
  );
});
