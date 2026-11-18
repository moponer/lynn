import { useState } from "react";
import { useT } from "../i18n";
import { Icon } from "./Icon";

/**
 * 插件包导入面板（2026-11-18 P9-4）。
 *
 * 补的是 25 章第 7 节列的缺口：「UI 包导入无图形入口，只有 RPC」。
 * 用户拿到的插件是 `.zip`，得能**点两下就装上**，不该让他去调 RPC。
 *
 * 三个设计要点：
 *
 * 1. **两个入口而不是一个**：原生对话框一次只能开"选文件"或"选目录"之一。
 *    用户拿到的可能是 zip（下载的），也可能是目录（自己写的）——两个按钮最省事。
 *
 * 2. **失败要摊开说**：`plugins.import` 返回的 `issues` 有 `stage` 与 `message`。
 *    这里**逐条**显示，不合并成一句"导入失败"——那条信息对用户毫无用处，
 *    对风铃也一样（她会照着 stage 判断是改清单还是改入口）。
 *
 * 3. **成功后不自动启用**：装上是"有了这个插件"，启用是"让它开始干活"。
 *    两件事分开，用户能先看清楚再决定——尤其是 L1（有代码）。
 */
interface ImportIssue {
  stage: string;
  message: string;
}

export function PluginImportPanel({ onImported }: { onImported?: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<"file" | "dir" | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const pick = async (mode: "file" | "dir") => {
    setBusy(mode);
    setIssues([]);
    setDone(null);
    try {
      const picked = await window.lynn.rpc("app.pickPluginPackage", { mode });
      if (picked.canceled || !picked.path) return;
      const r = await window.lynn.rpc("plugins.import", { path: picked.path });
      if (r.ok && r.id) {
        setDone(r.id);
        onImported?.();
      } else {
        setIssues(r.issues?.length ? r.issues : [{ stage: "unknown", message: t("pluginImport.noReason") }]);
      }
    } catch (e) {
      setIssues([{ stage: "io", message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="plugin-import">
      <div className="sf-actions">
        <button type="button" className="sf-btn primary" disabled={busy !== null} onClick={() => void pick("file")}>
          <Icon name="plus" size="sm" />
          {busy === "file" ? t("pluginImport.reading") : t("pluginImport.fromZip")}
        </button>
        <button type="button" className="sf-btn" disabled={busy !== null} onClick={() => void pick("dir")}>
          {busy === "dir" ? t("pluginImport.reading") : t("pluginImport.fromDir")}
        </button>
      </div>

      {done && (
        <div className="sf-result ok">
          {t("pluginImport.done", { id: done })}
          {/* 装上 ≠ 启用：L1 有代码，先让用户看清再决定 */}
          <small className="plugin-import-hint">{t("pluginImport.enableHint")}</small>
        </div>
      )}

      {issues.length > 0 && (
        <div className="sf-result bad" role="alert">
          <b>{t("pluginImport.failed")}</b>
          {/* 逐条摊开：stage 说明卡在哪一步，message 说明具体是什么 */}
          <ul className="plugin-import-issues">
            {issues.map((i, n) => (
              <li key={n}>
                <code>{i.stage}</code> {i.message}
              </li>
            ))}
          </ul>
          <small className="plugin-import-hint">{t("pluginImport.fixHint")}</small>
        </div>
      )}
    </div>
  );
}