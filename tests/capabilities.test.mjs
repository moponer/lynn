// 能力中心（2026-11-15）：预置清单与安装器 + 外部应用连接
//  1) 四类预置都得齐全，插件/MCP 预置必须带一个提示词技能（否则成员拿到工具也不会用）
//  2) 安装幂等：重复点「预装」不改用户已有内容
//  3) 外部应用凭据：加密落盘、界面拿不到明文、系统密钥库不可用时拒绝
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allPresets,
  installPreset,
  presetInstalled,
  MCP_PRESETS,
  PLUGIN_PRESETS,
  SKILL_PRESETS,
  SCHEDULE_PRESETS,
  buildSkillMd,
} from "../dist/main/capability-catalog.js";
import { Kernel } from "../dist/main/kernel.js";
import { ConnectorStore, CONNECTOR_CATALOG, probeConnector } from "../dist/main/connectors.js";
import { checkManifest } from "../dist/main/plugin-manifest.js";
import { discoverSkills } from "../dist/main/skills.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cap-"));

test("预置清单：四类齐全，插件与 MCP 都带提示词技能", () => {
  assert.ok(PLUGIN_PRESETS.length >= 3, "插件预置至少三条");
  assert.ok(MCP_PRESETS.length >= 5, "MCP 预置至少五条");
  assert.ok(SKILL_PRESETS.length >= 3, "技能预置至少三条");
  assert.ok(SCHEDULE_PRESETS.length >= 2, "自动化预置至少两条");
  assert.equal(allPresets().length, PLUGIN_PRESETS.length + MCP_PRESETS.length + SKILL_PRESETS.length + SCHEDULE_PRESETS.length);

  const ids = new Set();
  for (const p of allPresets()) {
    assert.ok(p.id && p.name && p.summary, `预置项缺字段：${p.id}`);
    const key = `${p.kind}:${p.id}`;
    assert.equal(ids.has(key), false, `预置 id 重复：${key}`);
    ids.add(key);
  }
  // 插件与 MCP 必须配技能：风铃建团队时靠它决定"这个人该用什么"
  for (const p of [...PLUGIN_PRESETS, ...MCP_PRESETS]) {
    assert.ok(p.skill, `${p.id} 缺提示词技能`);
    assert.ok(p.skill.description.length > 20, `${p.id} 的技能描述太短（要写清何时用）`);
    assert.ok(p.skill.allowedTools.length > 0, `${p.id} 的技能没声明工具白名单`);
  }
  for (const p of SKILL_PRESETS) {
    assert.ok(p.skill?.body?.trim(), `${p.id} 技能正文为空`);
    assert.match(buildSkillMd(p.skill), /^---\nname: /);
  }
});

test("插件预置：manifest 通过校验、文件齐全、工具名与声明一致", () => {
  for (const p of PLUGIN_PRESETS) {
    assert.ok(p.files?.["plugin.json"], `${p.id} 缺 plugin.json`);
    const manifest = JSON.parse(p.files["plugin.json"]);
    const check = checkManifest(manifest);
    assert.equal(check.ok, true, `${p.id} manifest 不合法：${check.issues.map((i) => i.field).join(",")}`);
    assert.equal(manifest.tier, "L1");
    assert.equal(manifest.source, "official");
    assert.ok(p.files["index.ts"]?.includes("registerTool"), `${p.id} 的入口没注册工具`);
    for (const t of manifest.contributes.tools) {
      assert.ok(p.files["index.ts"].includes(`name: "${t}"`), `${p.id} 的工具 ${t} 没在 index.ts 里注册`);
    }
  }
});

test("安装 MCP 预置：写 mcp.json（参数已展开）、装技能、重复安装不动内容", () => {
  const root = tmp();
  const out = installPreset(root, "mcp", "filesystem");
  assert.equal(out.ok, true, out.detail);
  assert.equal(out.created, true);
  assert.equal(out.skill, "mcp-filesystem");

  const file = path.join(root, "mcp.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(cfg.servers.length, 1);
  assert.equal(cfg.servers[0].id, "filesystem");
  assert.equal(cfg.servers[0].command, "npx");
  assert.equal(cfg.servers[0].enabled, true);
  // {{root}} 不能原样留在配置里（那会让 server 启动到一个叫 {{root}} 的目录）
  assert.equal(cfg.servers[0].args.includes("{{root}}"), false);
  assert.ok(fs.existsSync(path.join(root, "mcp-roots")), "占位目录应被创建");
  assert.ok(fs.existsSync(path.join(root, "skills", "mcp-filesystem", "SKILL.md")), "技能要一起装上");
  assert.equal(presetInstalled(root, "mcp", "filesystem"), true);

  const again = installPreset(root, "mcp", "filesystem");
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).servers.length, 1);
});

test("安装插件预置：文件落地、技能随插件目录被发现（插件级）", () => {
  const root = tmp();
  const out = installPreset(root, "plugin", "lynn.tool.textstat");
  assert.equal(out.ok, true, out.detail);
  const dir = path.join(root, "plugins", "lynn.tool.textstat");
  assert.ok(fs.existsSync(path.join(dir, "plugin.json")));
  assert.ok(fs.existsSync(path.join(dir, "index.ts")));
  assert.ok(fs.existsSync(path.join(dir, "SKILL.md")), "插件必须自带 SKILL.md");
  assert.equal(presetInstalled(root, "plugin", "lynn.tool.textstat"), true);

  // 插件级技能发现：root=plugins，<root>/<dir>/SKILL.md
  const { entries } = discoverSkills([{ dir: path.join(root, "plugins"), level: "plugin" }]);
  const hit = entries.find((e) => e.name === "text-check");
  assert.ok(hit, "插件里的 SKILL.md 应被发现");
  assert.equal(hit.level, "plugin");
  /**
   * 技能必须声明**插件注册后的真实全名**（2026-11-19 C1 修）。
   * 插件 id `lynn.tool.textstat` + 工具短名 `analyze` → `lynn_tool_textstat_analyze`。
   * 之前这里（和 SKILL.md）写的是短名 `text_check`——那是模型根本找不到的工具名，
   * 激活后工具面收窄反而自锁。测试改成断言真实全名，防止再退回去。
   */
  assert.ok(
    hit.allowedTools.includes("lynn_tool_textstat_analyze"),
    `技能要声明插件工具的真实全名（l1ToolFullName 规则），实际：${hit.allowedTools.join("、")}`,
  );

  // 重复安装：不动用户改过的文件
  fs.writeFileSync(path.join(dir, "index.ts"), "// 用户改过\n", "utf-8");
  const again = installPreset(root, "plugin", "lynn.tool.textstat");
  assert.equal(again.created, false);
  assert.equal(fs.readFileSync(path.join(dir, "index.ts"), "utf-8"), "// 用户改过\n");
});

test("安装技能预置：SKILL.md 落地并能被用户级发现", () => {
  const root = tmp();
  const out = installPreset(root, "skill", "data-audit");
  assert.equal(out.ok, true, out.detail);
  const { entries } = discoverSkills([{ dir: path.join(root, "skills"), level: "user" }]);
  const hit = entries.find((e) => e.name === "data-audit");
  assert.ok(hit);
  assert.match(hit.description, /核对|口径/);
  assert.ok(hit.allowedTools.length > 0);
  assert.ok(fs.readFileSync(path.join(root, "skills", "data-audit", "SKILL.md"), "utf-8").length > 500);
});

test("外部应用：凭据加密落盘、列表只回有没有填、明文永不下发", () => {
  const root = tmp();
  const store = new ConnectorStore(root, (plain) => Buffer.from(`enc:${plain}`, "utf-8"), () => true);
  const saved = store.save({ id: "github", values: { token: "ghp_secret", owner: "spiker" } });
  assert.equal(saved.ok, true);

  const raw = fs.readFileSync(path.join(root, "connectors.json"), "utf-8");
  assert.equal(raw.includes("ghp_secret"), false, "磁盘上不该有明文令牌");
  assert.match(raw, /"encrypted": true/);

  const view = store.list(["github"]).find((i) => i.id === "github");
  assert.equal(view.hasSecret.token, true);
  assert.equal(JSON.stringify(view).includes("ghp_secret"), false, "视图里不许出现令牌");
  assert.equal(view.values.owner, "spiker", "非密文字段可以回显");
  assert.equal(view.configured, true);
  assert.equal(view.enabled, false, "保存不等于启用");

  // 启用前查必填：github 只要 token，已填 → 可以启用
  const on = store.toggle("github", true, (b) => b.toString("utf-8").replace(/^enc:/, ""));
  assert.equal(on.ok, true);

  // 缺必填就拒（gitee 没填任何东西）
  const bad = store.toggle("gitee", true, null);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /还没配置|缺/);

  // 删凭据：不留残影
  assert.equal(store.forget("github"), true);
  assert.equal(store.get("github"), null);
});

test("外部应用：系统密钥库不可用时拒绝保存（除非显式确认明文）", () => {
  const root = tmp();
  const store = new ConnectorStore(root, null, () => false);
  const denied = store.save({ id: "gitee", values: { token: "abc" } });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /明文/);
  assert.equal(fs.existsSync(path.join(root, "connectors.json")), false, "拒绝时不该落盘");

  const ok = store.save({ id: "gitee", values: { token: "abc" }, plaintextOk: true });
  assert.equal(ok.ok, true);
  const view = store.list(["gitee"]).find((i) => i.id === "gitee");
  assert.equal(view.hasSecret.token, true);
  assert.equal(JSON.stringify(view).includes("abc"), false, "即使明文存储，视图也不回值");
});

test("外部应用探测：真请求、失败带原因、未知应用如实说", async () => {
  // 假 fetch：github 令牌有效
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ login: "spiker" }) });
  const r1 = await probeConnector("github", {}, { token: "t" }, okFetch);
  assert.equal(r1.ok, true);
  assert.match(r1.detail, /spiker/);

  const badFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r2 = await probeConnector("github", {}, { token: "t" }, badFetch);
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /401/);

  // WebDAV：207 才算通
  const davFetch = async () => ({ ok: true, status: 207, json: async () => ({}) });
  const r3 = await probeConnector("webdav", { url: "https://dav.example.com/dav/", user: "u" }, { password: "p" }, davFetch);
  assert.equal(r3.ok, true);
  assert.match(r3.detail, /207/);

  const r4 = await probeConnector("nope", {}, {}, okFetch);
  assert.equal(r4.ok, false);
  assert.match(r4.detail, /未知的外部应用/);

  // 缺令牌：不发请求就如实报
  const r5 = await probeConnector("gitee", {}, {}, okFetch);
  assert.equal(r5.ok, false);
  assert.match(r5.detail, /令牌/);
});

test("预置清单里的外部应用都有必填字段与配套技能", () => {
  for (const spec of CONNECTOR_CATALOG) {
    assert.ok(spec.fields.some((f) => f.required), `${spec.id} 没有必填字段`);
    // SSH 是设计上的例外：只记私钥路径，不复制私钥内容，所以没有密文字段
    if (spec.authType === "ssh") {
      assert.ok(spec.fields.some((f) => f.key === "keyPath"), "SSH 必须记私钥路径");
      assert.equal(spec.fields.some((f) => f.secret), false, "SSH 不该存私钥内容");
    } else {
      assert.ok(spec.fields.some((f) => f.secret), `${spec.id} 没有密文字段（令牌/密码要加密存）`);
    }
    assert.ok(spec.skill.name.startsWith("connector-"), `${spec.id} 的配套技能命名应可辨识`);
    assert.ok(spec.skill.body.length > 200, `${spec.id} 的技能正文太薄`);
    assert.ok(spec.docUrl.startsWith("https://"), `${spec.id} 的凭据申请地址必须是 https`);
  }
});

test("内核 RPC：cap.presets 读磁盘实况、cap.install 即时进技能表、connectors 不泄漏明文", async () => {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: { provider: "t", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() },
    }),
    "utf-8",
  );
  const kernel = new Kernel(root);
  // 测试里没有 safeStorage：注入可识别的假加密，验证"落盘是密文、视图无明文"
  kernel.setEncryptors((plain) => Buffer.from(`enc:${plain}`, "utf-8"), () => true, (blob) => blob.toString("utf-8").replace(/^enc:/, ""));
  await kernel.init();
  try {
    const p1 = kernel.handle("cap.presets");
    assert.ok(p1.presets.some((p) => p.kind === "plugin"), "插件预置要出现在清单里");
    const target = p1.presets.find((p) => p.kind === "skill" && p.id === "meeting-notes");
    assert.equal(target.installed, false);

    const ins = kernel.handle("cap.install", { kind: "skill", id: "meeting-notes" });
    assert.equal(ins.ok, true, ins.detail);
    // 装完不用重启：技能表立刻更新（风铃下一轮就能命中）
    assert.ok(kernel.skillEntries.some((s) => s.name === "meeting-notes"), "装完技能应立刻进运行时表");
    assert.equal(kernel.handle("cap.presets").presets.find((p) => p.kind === "skill" && p.id === "meeting-notes").installed, true);

    const save = kernel.handle("connectors.save", { id: "github", values: { token: "ghp_x", owner: "o" } });
    assert.equal(save.ok, true, save.error);
    const cl = kernel.handle("connectors.list");
    const item = cl.items.find((i) => i.id === "github");
    assert.equal(item.hasSecret.token, true);
    assert.equal(JSON.stringify(cl).includes("ghp_x"), false, "列表不许回明文");
    assert.equal(cl.canEncrypt, true);
    assert.ok(fs.existsSync(path.join(root, "skills", "connector-github", "SKILL.md")), "连接器配套技能要一起落盘");
    assert.ok(
      kernel.skillEntries.some((s) => s.name === "connector-github"),
      "连接器技能要进运行时表（风铃建团队时靠它）",
    );
    // 磁盘上也是密文
    const raw = fs.readFileSync(path.join(root, "connectors.json"), "utf-8");
    assert.equal(raw.includes("ghp_x"), false);
  } finally {
    await kernel.dispose();
  }
});
