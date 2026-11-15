/**
 * 壳层 RPC 注册表（2026-11-13，审计 #14 拆分第一刀）。
 *
 * 此前 main.ts 的唯一 RPC 通道是一条约 330 行的 if 链——窗口/截图/预览/对话流/
 * 语音/消息平台/更新器全内联，每加一个壳层方法都要在链上找一个不挡别人的位置。
 * 这里改成注册表：每个方法一个 handler，`update.*` 前缀单独走子分派，
 * 注册表查不到再落回 kernel.handle（内核方法面不在此处重复）。
 *
 * ctx 全部用取值函数/句柄传入（getWin/closePet），不缓存 BrowserWindow 引用——
 * 窗口可以随时销毁重建，缓存引用会拿到 isDestroyed 的尸体。
 */
import { app, BrowserWindow, dialog, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CaptureRect } from "../shared/contract";
import type { Kernel } from "./kernel";
import { discoverModels } from "./providers";
import { endpointRiskError } from "./endpoint";
import { insideBase, openPathBlockReason, taskIdError } from "./path-guard";

export interface ShellRpcCtx {
  kernel: Kernel;
  getWin: () => BrowserWindow | null;
  createPet: () => void;
  closePet: () => void;
  focusMain: () => void;
  captureHost: {
    status(): unknown;
    start(): unknown;
    frame(): unknown;
    commit(input: { rect: CaptureRect; dataUrl: string; action: "attach" | "copy" | "save" }): unknown;
    cancel(): unknown;
    takePending(): unknown;
    setHotkey(hotkey: string): { ok: boolean; error?: string };
  };
  voice: {
    voices(): unknown;
    preview(input: { text: string; voiceId?: string; rate?: string; volume?: string; proxy?: string }): Promise<unknown>;
    stop(): void;
    status(): unknown;
  };
  handleMsg: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  handleUpdate: (method: string) => Promise<unknown>;
}

type ShellHandler = (params: unknown, ctx: ShellRpcCtx) => unknown | Promise<unknown>;
const registry = new Map<string, ShellHandler>();

function rpc(method: string, handler: ShellHandler): void {
  registry.set(method, handler);
}

/** 主进程查到注册表命中就处理；未命中返回 undefined，调用方落回 kernel.handle */
export async function handleShellRpc(method: string, params: unknown, ctx: ShellRpcCtx): Promise<unknown | undefined> {
  if (method.startsWith("update.")) return ctx.handleUpdate(method);
  const handler = registry.get(method);
  if (!handler) return undefined;
  return await handler(params, ctx);
}

// ---------- 桌宠与窗口（自绘标题栏） ----------

rpc("pet.open", (_p, ctx) => {
  ctx.createPet();
  return { ok: true };
});
rpc("pet.close", (_p, ctx) => {
  ctx.closePet();
  return { ok: true };
});
rpc("pet.focus", (_p, ctx) => {
  ctx.focusMain();
  return { ok: true };
});
rpc("window.control", (params, ctx) => {
  const p = params as { action: "minimize" | "maximize" | "close" | "query" };
  if (!["minimize", "maximize", "close", "query"].includes(String(p?.action))) {
    return { ok: false, error: "window.control：action 必须是 minimize/maximize/close/query" };
  }
  const win = ctx.getWin();
  if (!win || win.isDestroyed()) return { ok: true, maximized: false };
  if (p.action === "minimize") {
    win.minimize();
  } else if (p.action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (p.action === "close") {
    // 走 close 事件：尊重"关窗进托盘"设置（真退由托盘菜单触发）
    win.close();
  }
  return { ok: true, maximized: win.isMaximized() };
});
rpc("app.restart", () => {
  // 一键重启：改了代码 / 内核比界面旧时，用户不必自己去托盘翻「退出」
  app.relaunch();
  setTimeout(() => app.exit(0), 80);
  return { ok: true };
});
rpc("app.appearance", (params, ctx) => {
  const p = params as { mode?: string; desk?: string };
  // 审计 #17：mode 进主题状态、desk 直接喂给 setBackgroundColor——都按取值域收口
  if (p.mode !== undefined && p.mode !== "light" && p.mode !== "dark") {
    return { ok: false, error: "appearance.mode 只接受 light/dark" };
  }
  if (p.desk !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(String(p.desk))) {
    return { ok: false, error: "appearance.desk 必须是十六进制颜色" };
  }
  const win = ctx.getWin();
  if (typeof p.desk === "string") win?.setBackgroundColor(p.desk);
  try {
    fs.writeFileSync(path.join(app.getPath("userData"), "appearance.json"), JSON.stringify({ mode: p.mode, desk: p.desk }), "utf-8");
  } catch {
    /* 写不了就下次再试 */
  }
  return { ok: true };
});

// ---------- 语音播报（合成与播放都在壳层） ----------

rpc("voice.voices", (_p, ctx) => ({ voices: ctx.voice.voices() }));
rpc("voice.preview", (params, ctx) => ctx.voice.preview((params ?? {}) as { text: string; voiceId?: string; rate?: string; volume?: string; proxy?: string }));
rpc("voice.stop", (_p, ctx) => {
  ctx.voice.stop();
  return { ok: true };
});
rpc("voice.status", (_p, ctx) => ctx.voice.status());

// ---------- 自定义端点发现（携带 Key 的出站，必须过风险闸） ----------

rpc("providers.discover", async (params) => {
  const p = params as { baseUrl: string; apiKey?: string; riskAccepted?: boolean };
  if (!p.baseUrl) return { models: [], error: "缺 baseUrl" };
  // 审计 #6：携带 Key 的出站探测必须过风险闸——此前只有 kernel.modelDiscover 有，
  // 这条路径明文 HTTP 端点也能拿到用户 Key。现在两条路径同一道闸。
  const riskError = endpointRiskError(p.baseUrl, p.riskAccepted, "发现模型");
  if (riskError) return { models: [], error: riskError };
  return await discoverModels(p.baseUrl, p.apiKey);
});
rpc("app.openExternal", async (params) => {
  const p = params as { url: string };
  try {
    const u = new URL(String(p.url ?? ""));
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "只允许打开 http/https 链接" };
    await shell.openExternal(u.toString());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ---------- 消息平台（凭据加密在壳层 safeStorage） ----------

rpc("msg.configure", (params, ctx) => ctx.handleMsg("msg.configure", params as Record<string, unknown>));
rpc("msg.send", (params, ctx) => ctx.handleMsg("msg.send", params as Record<string, unknown>));

// ---------- 插件试装（转发内核） ----------

rpc("plugins.probe", (params, ctx) => ctx.kernel.probePlugin((params as { id: string }).id));

// ---------- 区域截图：捕获与窗口都在壳层，内核完全不参与（不进模型工具面） ----------

rpc("capture.status", (_p, ctx) => ctx.captureHost.status());
rpc("capture.start", (_p, ctx) => ctx.captureHost.start());
rpc("capture.frame", (_p, ctx) => ctx.captureHost.frame());
rpc("capture.commit", (params, ctx) => {
  const p = params as { rect?: Partial<CaptureRect>; dataUrl?: string; action?: string } | undefined;
  const r = p?.rect;
  if (!r || ![r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { ok: false, error: "选区坐标无效" };
  }
  if (typeof p?.dataUrl !== "string" || !["attach", "copy", "save"].includes(p.action ?? "")) {
    return { ok: false, error: "完成动作或图片数据无效" };
  }
  return ctx.captureHost.commit({ rect: r as CaptureRect, dataUrl: p.dataUrl, action: p.action as "attach" | "copy" | "save" });
});
rpc("capture.cancel", (_p, ctx) => ctx.captureHost.cancel());
rpc("capture.pending", (_p, ctx) => ({ shots: ctx.captureHost.takePending() }));
rpc("config.prefs", async (params, ctx) => {
  const r = ctx.kernel.handle("config.prefs", params);
  const p = params as { captureHotkey?: string };
  const out = r as { ok?: boolean; captureHotkey?: string };
  if (p.captureHotkey !== undefined && out.ok && out.captureHotkey) {
    const changed = ctx.captureHost.setHotkey(out.captureHotkey);
    if (!changed.ok) console.warn(`[capture] ${changed.error ?? "改键没生效"}`);
  }
  return r;
});

// ---------- 卷宗路径面：守卫三件套（taskId 字符集 → insideBase containment → 登记豁免） ----------

/** evidence.open / resolveRef / revealPath / preview.read / preview.pdfWindow 共用的解析与守卫 */
function resolveTaskRef(
  ctx: ShellRpcCtx,
  params: unknown,
): { target: string; taskId: string; ref: string; guardError?: string; error?: string } {
  const p = params as { taskId: string; ref: string };
  // taskId 会被拼进 base 本身：`..`/绝对路径能让 base 跳出数据根，
  // containment 对着 base 比就形同虚设——先按字符集收口（审计 #17）。
  const tidErr = taskIdError(p.taskId);
  if (tidErr) return { target: "", taskId: "", ref: "", error: tidErr };
  const base = path.resolve(ctx.kernel.dataRoot, "tasks", p.taskId);
  const target = path.resolve(base, String(p.ref ?? ""));
  if (!insideBase(base, target)) {
    // 目录外的交付物（只读根原件 / 超 10MB 未复制进 artifacts）只登记绝对路径：
    // 认 task.json 里登记过的那几个，别的一律照旧拒绝。
    const abs = path.isAbsolute(String(p.ref ?? ""));
    if (!abs || !ctx.kernel.isTaskDeliverable(p.taskId, String(p.ref ?? ""))) {
      return { target, taskId: p.taskId, ref: String(p.ref ?? ""), guardError: "越界" };
    }
  }
  return { target, taskId: p.taskId, ref: String(p.ref ?? "") };
}

rpc("evidence.open", async (params, ctx) => {
  const r = resolveTaskRef(ctx, params);
  if (r.error) return { ok: false, error: r.error };
  if (r.guardError) return { ok: false, error: "证据路径越界，已拒绝" };
  if (!fs.existsSync(r.target)) return { ok: false, error: "文件不存在（可能已被移动）" };
  const err = await shell.openPath(r.target);
  return err ? { ok: false, error: err } : { ok: true };
});
rpc("app.resolveRef", (params, ctx) => {
  const r = resolveTaskRef(ctx, params);
  if (r.error) return { ok: false, error: r.error };
  if (r.guardError) return { ok: false, error: "路径越界，已拒绝" };
  return { ok: true, path: r.target, exists: fs.existsSync(r.target) };
});
rpc("app.revealPath", (params, ctx) => {
  // 「打开所在目录」（2026-11-13）：路径守卫与 evidence.open 完全一致，
  // 只是把"用关联程序打开"换成"在文件管理器里定位"。
  const r = resolveTaskRef(ctx, params);
  if (r.error) return { ok: false, error: r.error };
  if (r.guardError) return { ok: false, error: "路径越界，已拒绝" };
  if (!fs.existsSync(r.target)) return { ok: false, error: "文件不存在（可能已被移动或删除）" };
  shell.showItemInFolder(r.target);
  return { ok: true };
});
rpc("preview.read", async (params, ctx) => {
  // 内置预览：只把内容交给渲染层，不调 shell.openPath，外部程序零启动开销。
  // 路径守卫与 evidence.open 完全一致，前端拿不到工作区之外的字节。
  const r = resolveTaskRef(ctx, params);
  if (r.error) return { ok: false, kind: "missing", error: r.error };
  if (r.guardError) return { ok: false, kind: "missing", error: "预览路径越界，已拒绝" };
  const target = r.target;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return { ok: false, kind: "missing", error: "文件不存在（可能已被移动）" };
  }
  const ext = path.extname(target).slice(1).toLowerCase();
  const bytes = fs.statSync(target).size;
  const mime: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
  };
  if (mime[ext]) {
    if (bytes > 8 * 1024 * 1024) return { ok: true, kind: "binary", ext, bytes };
    const buf = fs.readFileSync(target);
    return { ok: true, kind: "image", dataUrl: `data:${mime[ext]};base64,${buf.toString("base64")}`, ext, bytes };
  }
  /**
   * 音频 / 视频（2026-11-15）：常见格式直接给 data URL，渲染层用原生 <audio>/<video> 播放。
   * 只认 Chromium 真能解码的容器/编码——把 .wma/.mkv 这类塞进 <audio> 只会得到一块黑着的控件，
   * 不如如实说"没有内置播放"并给系统程序出口。
   * 上限压在 IPC 能一次带动的量级（base64 膨胀 33%），超了不硬塞。
   */
  const audioMime: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
    m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg", weba: "audio/webm",
  };
  const videoMime: Record<string, string> = {
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg",
  };
  if (audioMime[ext] || videoMime[ext]) {
    if (bytes === 0) return { ok: true, kind: "empty", ext, bytes };
    const isAudio = Boolean(audioMime[ext]);
    const limit = (isAudio ? 20 : 32) * 1024 * 1024;
    if (bytes > limit) {
      return {
        ok: true,
        kind: "binary",
        ext,
        bytes,
        error: `文件超过 ${isAudio ? 20 : 32}MB，内置播放器带不动（一次性搬运整份字节会卡住界面），请用系统程序打开。`,
      };
    }
    const buf = await fs.promises.readFile(target);
    const mimeType = isAudio ? audioMime[ext] : videoMime[ext];
    return {
      ok: true,
      kind: isAudio ? "audio" : "video",
      ext,
      bytes,
      dataUrl: `data:${mimeType};base64,${buf.toString("base64")}`,
    };
  }
  // PDF：沙箱 iframe 里开不了 Chromium 阅读器，返回标记由抽屉引导开独立预览窗口
  if (ext === "pdf") return { ok: true, kind: "pdf", ext, bytes };
  // Office 三件套（docx/xlsx/pptx）：渲染层用开源库保真渲染（docx-preview /
  // @js-preview/excel / pptx-preview，懒加载），主进程只递字节。此前自研的
  // docx→HTML 只能出"素颜正文"，图片样式全丢；正文提取仍走 docx-read（read_artifact）。
  if (ext === "docx" || ext === "docm" || ext === "xlsx" || ext === "xlsm" || ext === "pptx") {
    // 审计 #12：16MB → 8MB（base64 膨胀 33% 后约 10.7MB 字符串 + 渲染层同份 Uint8Array）；
    // 同步 readFileSync 换异步，避免主进程事件循环上一次大分配停顿。
    // 真正的流式方案（自定义协议按块下发）留作后续，不假装已解决。
    const OFFICE_LIMIT = 8 * 1024 * 1024;
    if (bytes > OFFICE_LIMIT) {
      return { ok: true, kind: "binary", ext, bytes, error: "文件超过 8MB，内置预览带不动，请用系统程序打开。" };
    }
    const buf = await fs.promises.readFile(target);
    return { ok: true, kind: "office", ext, bytes, dataBase64: buf.toString("base64") };
  }
  const LIMIT = 600_000;
  const fd = fs.openSync(target, "r");
  const take = Math.min(bytes, LIMIT);
  const buf = Buffer.alloc(take);
  try {
    fs.readSync(fd, buf, 0, take, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (bytes === 0) return { ok: true, kind: "empty", ext, bytes };
  // 二进制（xlsx/pptx/zip…）不做乱码文本预览，如实说清有什么替代路径
  if (buf.includes(0)) {
    // 常见但浏览器解不了的格式：说清"为什么看不了 + 替代路径"，比一句"二进制文件"有用
    const hint: Record<string, string> = {
      xlsx: "Excel 文件暂无内置预览。可以让风铃用 office_read_table 把数据读出来，或转存成 CSV 再看。",
      pptx: "演示文稿暂无内置预览，可用系统程序打开。",
      doc: "旧版 .doc 不支持内置预览；让风铃转存成 .docx 就能直接看。",
      xls: "旧版 .xls 不支持内置预览；让风铃转存成 .xlsx 或 CSV 就能直接看。",
      ppt: "旧版 .ppt 不支持内置预览；让风铃转存成 .pptx 就能直接看。",
      zip: "压缩包不做解包预览，可用系统程序打开。",
      rar: "压缩包不做解包预览，可用系统程序打开。",
      "7z": "压缩包不做解包预览，可用系统程序打开。",
      exe: "可执行文件不做内置预览（也不该在预览里点开它），需要时用系统程序打开。",
      wma: "这个音频编码（.wma）内置播放器解不了，可用系统程序打开的播放器听。",
      mkv: "这个视频容器（.mkv）内置播放器解不了，可用系统程序打开的播放器看。",
      avi: "这个视频容器（.avi）内置播放器解不了，可用系统程序打开的播放器看。",
      mov: "这个视频容器（.mov）内置播放器解不了，可用系统程序打开的播放器看。",
    };
    return { ok: true, kind: "binary", ext, bytes, error: hint[ext] };
  }
  return { ok: true, kind: "text", text: buf.toString("utf8"), ext, bytes, truncated: bytes > LIMIT };
});
rpc("preview.pdfWindow", (params, ctx) => {
  // PDF 预览：应用内独立窗口，Chromium 自带阅读器（翻页/缩放/搜索都有）。
  // 路径守卫与 preview.read 完全一致：只放行 tasks/<id>/ 内或已登记的交付物。
  const r = resolveTaskRef(ctx, params);
  if (r.error) return { ok: false, error: r.error };
  if (r.guardError) return { ok: false, error: "预览路径越界，已拒绝" };
  const target = r.target;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, error: "文件不存在（可能已被移动）" };
  // 审计 #4：独立预览窗口只放行 PDF。成员可写 tasks/<id>/，不校验扩展名
  // 等于"应用窗口内渲染成员可控 HTML"（钓鱼面）。
  if (path.extname(target).toLowerCase() !== ".pdf") {
    return { ok: false, error: "独立预览窗口只放行 PDF，其他类型请用内置预览或系统程序打开" };
  }
  const win = ctx.getWin();
  if (!win || win.isDestroyed()) return { ok: false, error: "主窗口不在了" };
  const pdfWin = new BrowserWindow({
    width: 1080,
    height: 860,
    parent: win,
    autoHideMenuBar: true,
    title: `${path.basename(target)} · 预览`,
    backgroundColor: "#26282d",
    // 独立 partition：不给预览窗口共享主窗口 session，下面的网络拦截才不会误伤主界面
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "lynn-pdfview" },
  });
  // PDF 是本地文件，预览窗口不需要网络：页面里藏的外发请求一律取消（审计 #4）
  pdfWin.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) =>
    callback({ cancel: true }),
  );
  void pdfWin.loadFile(target);
  return { ok: true };
});

// ---------- 目录选择与打开（原生对话框，用户亲手选） ----------

rpc("app.pickDirs", async (params, ctx) => {
  // 只读授权多选：一次选多个目录（整盘等敏感选择由内核再验）
  const p = params as { title?: string } | undefined;
  const win = ctx.getWin();
  if (!win || win.isDestroyed()) return { canceled: true };
  const r = await dialog.showOpenDialog(win, {
    title: p?.title ?? "选择要授权只读访问的目录（可多选）",
    properties: ["openDirectory", "multiSelections"],
  });
  return r.canceled || !r.filePaths.length ? { canceled: true } : { paths: r.filePaths };
});
rpc("app.pickDir", async (params, ctx) => {
  // 只读授权的目录选择：原生对话框，用户亲手选，模型无法代为选择
  const p = params as { title?: string } | undefined;
  const win = ctx.getWin();
  if (!win || win.isDestroyed()) return { canceled: true };
  const r = await dialog.showOpenDialog(win, {
    title: p?.title ?? "选择要授权只读访问的目录",
    properties: ["openDirectory"],
  });
  return r.canceled || !r.filePaths[0] ? { canceled: true } : { path: r.filePaths[0] };
});
rpc("app.openPath", async (params, ctx) => {
  // 只允许打开数据根内的文件（导出包 / 工件），不当前端可调的任意文件执行器。
  // 审计 #1：数据根内有成员可写的目录（tasks/<id>/workspace），只挡目录不够——
  // .bat/.ps1 写进工作区再被打开就等于任意程序执行；扩展名走白名单（审计三轮 P0）。
  const p = params as { path: string };
  const target = path.resolve(String(p.path ?? ""));
  const reason = openPathBlockReason(ctx.kernel.dataRoot, target);
  if (reason) return { ok: false, error: reason };
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});
rpc("app.openData", (params, ctx) => {
  const kind = (params as { kind: "data" | "logs" }).kind;
  const target = kind === "logs" ? path.join(ctx.kernel.dataRoot, "logs") : ctx.kernel.dataRoot;
  fs.mkdirSync(target, { recursive: true });
  void shell.openPath(target);
  return { ok: true, path: target };
});

// ---------- 内核异步面（handle 是同步路由，这几个要真发 HTTP，单独 await） ----------

export const KERNEL_ASYNC_METHODS = ["model.discover", "model.health", "gateway.list"] as const;

export function isKernelAsyncMethod(method: string): boolean {
  return (KERNEL_ASYNC_METHODS as readonly string[]).includes(method);
}

export function handleKernelAsync(method: string, params: unknown, ctx: ShellRpcCtx): unknown {
  if (method === "model.discover") return ctx.kernel.modelDiscover(params as never);
  if (method === "model.health") return ctx.kernel.modelHealth(params as never);
  if (method === "gateway.list") return ctx.kernel.listGateways();
  return undefined;
}
