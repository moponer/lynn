import type { ReactNode } from "react";
import { useT } from "../../i18n";

/** 版本条目（与 contract 里 persona.versions 的 result 同形；那边是内联类型，这里单独命名 */
export interface PersonaVersionRow {
  id: string;
  savedAt: string;
  chars: number;
}

/**
 * 「人设」页（2026-11-17 P6-9 / 18 章 F4 第二步）。
 *
 * 与 AboutPane 的区别：这一页**有状态**（草稿文本、版本列表、提示语），
 * 但那些 state 全文件只在这一页出现（各 3–5 次），所以可以整体下沉到本组件内部——
 * 父组件不再需要保管它们。
 *
 * 唯一留在父组件的是 `VersionRows`：persona 与 memory 两页共用同一个版本列表组件。
 * 用 `renderVersions` 传进来而不是把 `VersionRows` 也搬走，是为了**不复制一份**。
 *
 * 拆分的纪律同前：只搬 JSX 与 state，不改文案、不改类名。
 */

export interface PersonaPaneProps {
  /** 当前草稿；null = 还没加载完 */
  text: string | null;
  msg: string;
  versions: PersonaVersionRow[];
  onChange: (text: string) => void;
  onMsg: (msg: string) => void;
  onVersions: (rows: PersonaVersionRow[]) => void;
  /** 重新拉一次草稿 */
  onReload: () => void;
  /** 版本列表渲染（父组件传 VersionRows，两页共用） */
  renderVersions: (rows: PersonaVersionRow[], onRollback: (id: string) => void) => ReactNode;
}

export function PersonaPane({ text, msg, versions, onChange, onMsg, onVersions, onReload, renderVersions }: PersonaPaneProps) {
  const t = useT();
  return (
    <div className="sf-pane">
      <h3>{t("persona.title")}</h3>
      <p className="sf-lede">{t("persona.lede")}</p>
      {text === null ? (
        <p className="sf-empty">{msg || t("persona.loading")}</p>
      ) : (
        <>
          <div className="sf-group">
            <div className="sf-group-head">
              <b>{t("persona.editTitle")}</b>
              <small>{t("persona.hint")}</small>
            </div>
            <textarea
              className="sf-persona"
              rows={14}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
            />
            <div className="sf-actions">
              <button
                type="button"
                className="sf-btn primary"
                onClick={() => {
                  void window.lynn.rpc("persona.save", { text }).then((r) => {
                    onMsg(r.hot ? t("persona.savedHot") : t("persona.savedNext"));
                    void window.lynn.rpc("persona.versions").then((v) => onVersions(v.versions));
                  });
                }}
              >
                {t("persona.save")}
              </button>
              <button
                type="button"
                className="sf-btn"
                onClick={() => {
                  void onReload();
                  onMsg("");
                }}
              >
                {t("persona.discard")}
              </button>
            </div>
            {msg && <div className="sf-hint">{msg}</div>}
          </div>
          {versions.length > 0 && (
            <div className="sf-group">
              <div className="sf-group-head">
                <b>{t("persona.versions")}</b>
                <small>{t("persona.verHint")}</small>
              </div>
              {renderVersions(versions, (id) => {
                void window.lynn.rpc("persona.rollback", { id }).then((r) => {
                  onChange(r.text);
                  onMsg(r.hot ? t("persona.rollbackHot") : t("persona.rollbackNext"));
                });
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}