import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pi 配置根重定向（计划书 §1.6）——变量名取自 Pi 官方
 * `docs/environment-variables.md`，不猜：
 *
 *  - `PI_CODING_AGENT_DIR`         agent 目录，默认 `~/.pi/agent`
 *  - `PI_CODING_AGENT_SESSION_DIR` 会话目录，默认 `<agent-dir>/sessions/<encoded-cwd>`
 *  - `PI_TELEMETRY`                安装/更新遥测与 provider 归因头，`0` 关闭（§4.7 无遥测）
 *  - `PI_SKIP_VERSION_CHECK`       启动时不请求 pi.dev 版本（不在出站域名白名单）
 *
 * 必须在 Pi 被 import 之前调用（kernel.init 里的动态 import 之前）；
 * 项目级 `.pi/` 目录由 Pi 的项目信任（§3.3）把关，不在本函数范围内。
 */
export function applyPiEnvironment(dataRoot: string): { agentDir: string; sessionDir: string } {
  const kernelRoot = path.join(dataRoot, "kernel");
  const agentDir = path.join(kernelRoot, "agent");
  const sessionDir = path.join(kernelRoot, "sessions");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  process.env.PI_TELEMETRY = "0";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  return { agentDir, sessionDir };
}
