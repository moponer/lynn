/**
 * 真模型用量 / 缓存命中对照探针（2026-11-14）。
 *
 * 用 `electron scripts/live-usage-probe.cjs` 跑（不能用 node）：API Key 由 Electron
 * safeStorage 加密，只有主进程能解密。脚本只读 settings.json，不写用户数据根；
 * 不创建窗口，跑完 app.exit(0)。
 *
 * 绝不打印 Key：只输出模型名、端点、usage 原始字段与延迟。
 *
 * 阶段 1：每个已配置模型发 1 次最小请求（max_tokens=16），看
 *   a) 端点可不可达；b) usage 里到底有没有回报缓存字段；c) 命中多少。
 * 阶段 2：对「确实回报缓存字段」的模型做 5 轮 A/B 对照，验证缓存分层收益：
 *   r1/r2 system 不变 → 前缀应命中
 *   r3    把公告塞进 system（旧方案）→ 前缀作废，命中应掉
 *   r4/r5 公告放 user 消息尾部、且 r5 改公告内容（新方案）→ 前缀应保持命中
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 密文是 Chromium OSCrypt 的 "v10" 格式：AES 密钥存在 userData/Local State 里（外层 DPAPI）。
// 独立跑脚本时 Electron 的默认 app name 不是 lynn → 找错 Local State → decryptString 必失败。
// 但不能把 userData 直接指向真实应用目录：用户正开着 lynn，GPU 缓存文件会被两个进程抢，
// 刷一屏 ERROR。做法是**只复制 Local State** 到临时 userData，其余缓存都落在临时目录。
const REAL_USER_DATA = process.env.LYNN_USER_DATA || path.join(os.homedir(), "AppData", "Roaming", "lynn");
const PROBE_USER_DATA = path.join(os.tmpdir(), "lynn-usage-probe-userdata");
fs.mkdirSync(PROBE_USER_DATA, { recursive: true });
const localState = path.join(REAL_USER_DATA, "Local State");
if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(PROBE_USER_DATA, "Local State"));
app.setName("Lynn");
app.setPath("userData", PROBE_USER_DATA);
app.disableHardwareAcceleration();

const SETTINGS = process.env.LYNN_SETTINGS || path.join(os.homedir(), ".lynn", "settings.json");
const OUT = path.join(__dirname, "..", "shots", "live-usage-probe.json");
const CACHE_KEYS = [
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "prompt_tokens_details",
];

/** 只取 usage 的可读字段，不碰请求头/密钥 */
function shapeUsage(u) {
  if (!u) return null;
  const reportedKeys = CACHE_KEYS.filter((k) => u[k] !== undefined && u[k] !== null);
  return {
    prompt_tokens: u.prompt_tokens ?? null,
    completion_tokens: u.completion_tokens ?? null,
    hit: u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    miss: u.prompt_cache_miss_tokens ?? 0,
    write: u.cache_creation_input_tokens ?? 0,
    reportedKeys,
    cacheFieldsReported: reportedKeys.length > 0,
  };
}

async function oneCall(model, apiKey, messages, maxTokens = 16) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 160) };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, ms, error: `HTTP ${res.status}: ${body.slice(0, 160).replace(/sk-[A-Za-z0-9_-]{8,}/g, "***")}` };
  }
  const text = await res.text().catch(() => "");
  let usage = null;
  let content = "";
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === "[DONE]") continue;
      try {
        const j = JSON.parse(m[1]);
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta?.content;
        if (d) content += d;
      } catch {
        /* 网关夹带的心跳行 */
      }
    }
  }
  return { ok: true, ms, usage: shapeUsage(usage), content: content.slice(0, 60) };
}

function keyOf(entry) {
  const k = entry?.apiKey;
  if (!k?.data) return "";
  if (!k.encrypted) return k.data;
  // 诊断只打印长度与错误，绝不打印明文
  try {
    const ok = safeStorage.isEncryptionAvailable();
    const plain = safeStorage.decryptString(Buffer.from(k.data, "base64"));
    if (process.env.LYNN_PROBE_DEBUG) {
      console.log(`    [dbg] available=${ok} blobLen=${k.data.length} keyLen=${plain.length}`);
    }
    return plain;
  } catch (err) {
    if (process.env.LYNN_PROBE_DEBUG) {
      console.log(`    [dbg] decrypt 失败：${String(err?.message ?? err).slice(0, 140)}`);
    }
    return "";
  }
}

const SYSTEM_STABLE = [
  "你是风铃，一个多智能体指挥助理。以下是长期不变的人设与记忆，请始终遵守。",
  "行事准则：只说能做和做过的事；没有证据不宣称完成；交付物先落盘再回报；",
  "遇到不确定的路径先 read_file 看清现状，不要凭文件名猜内容；命令失败要读 stderr 尾部。",
  "团队纪律：派单前写清目标、完成标准、材料位置、限制；成员的回报要逐条核对完成标准；",
  "验收纪律：证据必须是可点开的真实文件；打回必须写清哪里不合格、期望是什么、多久内重交。",
  "语气：写人话、简短、不用敬语、不寒暄；不重复用户刚说过的话；不给没做过的事打包票。",
  "工具纪律：改文件先读、补丁带上下文；删除类命令要用户点头；工作区外的路径一律拒绝。",
  "记忆纪律：只沉淀事实、决定、坑与做事方法；不写流水账；项目事实只在该项目里可见。",
].join("\n");

const HISTORY = [
  { role: "user", content: "记住：项目代号风铃，团队 7 人，本次任务是核对月报数字。" },
  { role: "assistant", content: "已记住：项目风铃、7 人、核对月报数字。" },
];
const TAIL = "第一轮：请只回复 OK，不要解释。";
const NOTICE_A = "\n\n【本群公告】整体：审月报；接缝：数据员交给审计员；共享写入点归审计员。";
const NOTICE_B = "\n\n【本群公告】整体：审月报；接缝：数据员交给复核员；共享写入点归复核员。";

function msgs(system, tail) {
  return [{ role: "system", content: system }, ...HISTORY, { role: "user", content: tail }];
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const entries = [
    ...(raw.models || []).map((m) => ({ id: m.id, label: m.label, baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey })),
  ];
  const filter = (process.env.LYNN_PROBE_MODELS || "").split(",").filter(Boolean);
  const models = filter.length ? entries.filter((m) => filter.includes(m.id) || filter.includes(m.label)) : entries;

  const result = { at: new Date().toISOString(), stage1: [], stage2: [] };
  console.log(`\n=== 阶段 1：${models.length} 个模型各 1 次最小探针（max_tokens=16） ===`);

  const usable = [];
  for (const m of models) {
    const key = keyOf(m);
    if (!key) {
      result.stage1.push({ id: m.id, label: m.label, ok: false, error: "Key 解密失败/未配置" });
      console.log(`  ${m.label.padEnd(30)} SKIP  Key 不可用`);
      continue;
    }
    const r = await oneCall(m, key, msgs(SYSTEM_STABLE, TAIL));
    const row = { id: m.id, label: m.label, baseUrl: m.baseUrl, modelName: m.model, ...r };
    result.stage1.push(row);
    if (r.ok && r.usage?.cacheFieldsReported) usable.push({ m, key });
    console.log(
      `  ${m.label.padEnd(30)} ${r.ok ? "OK  " : "FAIL"} ` +
        `${String(r.ms).padStart(6)}ms  prompt=${r.usage?.prompt_tokens ?? "-"} ` +
        `hit=${r.usage?.hit ?? "-"} 字段=[${r.usage?.reportedKeys?.join(",") ?? "-"}]` +
        (r.error ? `  ${r.error.slice(0, 80)}` : ""),
    );
  }

  console.log(`\n=== 阶段 2：前缀 A/B 对照（${usable.length} 个端点回报了缓存字段） ===`);
  const targets = usable.slice(0, Number(process.env.LYNN_PROBE_FULL || 2));
  for (const { m, key } of targets) {
    const rounds = [
      ["r1 稳定前缀", msgs(SYSTEM_STABLE, TAIL)],
      ["r2 稳定前缀(重复)", msgs(SYSTEM_STABLE, TAIL)],
      ["r3 公告进 system(旧)", msgs(SYSTEM_STABLE + NOTICE_A, TAIL)],
      ["r4 公告进 user 尾部(新)", msgs(SYSTEM_STABLE, TAIL + NOTICE_A)],
      ["r5 改公告内容(新)", msgs(SYSTEM_STABLE, TAIL + NOTICE_B)],
    ];
    const rows = [];
    for (const [name, messages] of rounds) {
      const r = await oneCall(m, key, messages);
      const u = r.usage ?? {};
      rows.push({ name, ok: r.ok, ms: r.ms, prompt: u.prompt_tokens ?? null, hit: u.hit ?? 0, miss: u.miss ?? 0, error: r.error });
      console.log(
        `  ${m.label.slice(0, 16).padEnd(16)} ${name.padEnd(26)} ${r.ok ? "OK  " : "FAIL"} ` +
          `prompt=${String(u.prompt_tokens ?? "-").padStart(5)} hit=${String(u.hit ?? "-").padStart(5)} ` +
          `miss=${String(u.miss ?? "-").padStart(5)} ${r.ms}ms`,
      );
    }
    result.stage2.push({ id: m.id, label: m.label, rows });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  console.log(`\n结果已写 ${OUT}`);
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.error("探针失败：", err);
  } finally {
    app.exit(0);
  }
});
