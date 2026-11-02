// 项目信任（M1-13）：陌生仓库的 `.lynn/mcp.json` 不得自动注入工具。
// 信任是"这个目录我认"，按绝对路径记，换机器/换目录都要重新认。
import * as fs from "node:fs";
import * as path from "node:path";

interface TrustFile {
  trusted: string[];
}

export class TrustStore {
  private readonly file: string;

  constructor(private readonly dataRoot: string) {
    this.file = path.join(dataRoot, "trust.json");
  }

  private norm(p: string): string {
    const abs = path.resolve(p);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  }

  list(): string[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf-8")) as TrustFile;
      return Array.isArray(j.trusted) ? j.trusted : [];
    } catch {
      return [];
    }
  }

  isTrusted(p: string): boolean {
    const target = this.norm(p);
    return this.list().some((t) => this.norm(t) === target);
  }

  setTrusted(p: string, trusted: boolean): string[] {
    const abs = path.resolve(p);
    const next = this.list().filter((t) => this.norm(t) !== this.norm(abs));
    if (trusted) next.push(abs);
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ trusted: next }, null, 2), "utf-8");
    return next;
  }
}
