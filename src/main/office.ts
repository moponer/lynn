// M2-06：lynn-office 本地引擎 + 能力装配器（§4.3.1/§4.3.2）。
//  - 形态：office 能力层（进程内，工具形状对齐 MCP；未来可平移成 stdio server）。
//  - **不装也能用（CSV 降级）**：CSV 读写纯 TS 零依赖，永远可用。
//  - xlsx：走本机 LibreOffice（soffice --convert-to csv 中转）→ 复用 CSV 管线；没装如实报，
//    不假装读出来了。
//  - 装配器：健康检查（探测 soffice）+ 引擎包 recipe（版本钉死 + sha256 + 镜像轮询，可测纯函数）。
//    下载型引擎当前无包源，装配器如实报"未配置"，不谎报可用。
import { execFile, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------- CSV（RFC 4180 子集：引号/转义/CRLF；零依赖） ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const push = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    push();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      push();
      i += 1;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== "" || row.length) pushRow();
  return rows;
}

export function toCsv(rows: string[][]): string {
  const esc = (s: string): string =>
    /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return rows.map((r) => r.map((x) => esc(String(x ?? ""))).join(",")).join("\r\n") + "\r\n";
}

export interface Table {
  headers: string[];
  rows: string[][];
}

export function tableFromCsv(text: string): Table {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (!rows.length) return { headers: [], rows: [] };
  return { headers: rows[0], rows: rows.slice(1) };
}

export function tableToCsv(t: Table): string {
  return toCsv([t.headers, ...t.rows]);
}

// ---------- 引擎探测 / 健康检查 ----------

export interface EngineHealth {
  found: boolean;
  kind: "libreoffice" | "none";
  version?: string;
  sofficePath?: string;
  detail: string;
}

const SOFFICE_DEFAULTS = [
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  "/usr/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
];

/** 探测本机 LibreOffice；execFn 可注入测试；LYNN_SOFFICE 每次调用时读（可注入覆盖） */
export async function probeSoffice(execFn = execFile): Promise<EngineHealth> {
  const envOverride = process.env.LYNN_SOFFICE?.trim();
  const candidates = [envOverride ?? "", ...SOFFICE_DEFAULTS].filter(Boolean);
  for (const p of candidates) {
    // 显式 env 指定的路径不查存在性（可能是 WSL/虚拟路径），直接试执行；默认候选才先查
    if (p !== envOverride && (p.includes("\\") || p.includes("/")) && !fs.existsSync(p)) continue;
    const found = await new Promise<EngineHealth>((resolve) => {
      execFn(p, ["--version"], { timeout: 5000 }, (err: Error | null, stdout: string) => {
        if (err) {
          resolve({ found: false, kind: "none", detail: `${p} 不可用：${err.message.split("\n")[0]}` });
          return;
        }
        const v = /LibreOffice[^\d]*([\d.]+)/.exec(stdout ?? "")?.[1];
        resolve({ found: true, kind: "libreoffice", version: v, sofficePath: p, detail: `LibreOffice ${v ?? "未知版本"}（${p}）` });
      });
    });
    if (found.found) return found;
  }
  return { found: false, kind: "none", detail: "本机没有 LibreOffice（SOFFICE 未安装或不在常见路径）；xlsx/docx 转换不可用，CSV 不受影响" };
}

// ---------- 引擎包 recipe（版本钉死 + sha256 + 镜像轮询） ----------

export interface EngineRecipe {
  id: string;
  /** 钉死的引擎包版本 */
  version: string;
  url?: string;
  sha256?: string;
  mirrors?: string[];
  /** 解压后的引擎根目录（相对 dataRoot/engine/<id>） */
  installDir: string;
}

/** 镜像轮询：官方源放最后；tried 里的跳过 */
export function pickMirror(recipe: EngineRecipe, tried: string[] = []): string | null {
  const list = [...(recipe.mirrors ?? []), ...(recipe.url ? [recipe.url] : [])].filter((u) => !tried.includes(u));
  return list[0] ?? null;
}

/** sha256 校验（下载后必过这一关；不符即拒收——不静默用坏包） */
export function assertSha256(buf: Buffer, expected: string): void {
  const got = crypto.createHash("sha256").update(buf).digest("hex");
  if (got.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`引擎包 sha256 不符：期望 ${expected.slice(0, 12)}…，实际 ${got.slice(0, 12)}…——已拒收`);
  }
}

// ---------- 读写表（CSV 永远可用；xlsx 走 LibreOffice 中转） ----------

export interface OfficeBackend {
  csv: boolean;
  xlsx: boolean;
  detail: string;
}

export function readTable(file: string, health: EngineHealth): { table?: Table; error?: string } {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".csv" || ext === ".txt") {
    try {
      return { table: tableFromCsv(fs.readFileSync(file, "utf-8")) };
    } catch (err) {
      return { error: `CSV 读取失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (ext === ".xlsx" || ext === ".xls") {
    if (!health.found) {
      return {
        error: "xlsx 需要本机 LibreOffice（lynn-office 引擎）：未安装，CSV 能力不受影响。可在设置里引导安装。",
      };
    }
    const outDir = fs.mkdtempSync(path.join(path.dirname(file), ".lynn-cvt-"));
    try {
      // 同步转换（有界 ≤60s）：runTool 是同步管线；读表是低频短操作，可接受
      const r = spawnSync(health.sofficePath!, ["--headless", "--convert-to", "csv", "--outdir", outDir, file], {
        timeout: 60_000,
      });
      if (r.error) {
        return { error: `xlsx 转换失败：${r.error.message}` };
      }
      const csv = path.join(outDir, path.basename(file, path.extname(file)) + ".csv");
      if (!fs.existsSync(csv)) {
        return { error: `转换没有产出 CSV（exit=${r.status}，可能是不支持的表结构）` };
      }
      return { table: tableFromCsv(fs.readFileSync(csv, "utf-8")) };
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
  return { error: `暂不支持 ${ext || "无扩展名"}：当前可用 csv/txt（直读）与 xlsx（需引擎）` };
}

export function writeTable(file: string, t: Table): { ok: boolean; error?: string } {
  const ext = path.extname(file).toLowerCase();
  if (ext && ext !== ".csv" && ext !== ".txt") {
    return { ok: false, error: "写表当前只支持 CSV（xlsx 写入需引擎包，未配置时如实拒绝，不产出坏文件）" };
  }
  const full = ext ? file : `${file}.csv`;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, tableToCsv(t), "utf-8");
  return { ok: true };
}
