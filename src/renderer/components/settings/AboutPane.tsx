import { useT } from "../../i18n";
import type { I18nKey } from "../../../shared/i18n-strings";

/**
 * 「关于」页（2026-11-17 P6-9 / 18 章 F4 的第一步）。
 *
 * 为什么先拆这一页：它是设置页里**依赖最少**的一页——只用到 `t` 和版本号，
 * 不碰任何跨页共享的 state（模型/团队/自动化那几组都在别的页里）。
 * 拿它当第一刀，是为了在动大块之前先把"抽取 → 传参 → 断言不变"这条流程走通一遍。
 *
 * 拆分的纪律：**只搬 JSX，不改文案、不改类名、不改结构**。
 * 这样 diff 只反映"位置变了"，出问题时一眼能看出不是逻辑改动引起的。
 * （第一版我凭记忆重写了结构，类名与标签全错——已照原文改回。）
 */

/** 写法照 tether-ai 的 README：一句定义 + 事实清单 + 主动免责，版本号从壳层读，不写死。 */
const WAY: { k: I18nKey; v: I18nKey }[] = [
  { k: "about.wayDispatchK", v: "about.wayDispatchV" },
  { k: "about.wayReportK", v: "about.wayReportV" },
  { k: "about.wayApproveK", v: "about.wayApproveV" },
  { k: "about.wayPipeK", v: "about.wayPipeV" },
];

const CAPS: { k: I18nKey; v: I18nKey }[] = [
  { k: "about.capTeamK", v: "about.capTeamV" },
  { k: "about.capSkillK", v: "about.capSkillV" },
  { k: "about.capPluginK", v: "about.capPluginV" },
  { k: "about.capMemoryK", v: "about.capMemoryV" },
  { k: "about.capPreviewK", v: "about.capPreviewV" },
  { k: "about.capAutoK", v: "about.capAutoV" },
];

const PRIVACY: { k: I18nKey; v: I18nKey }[] = [
  { k: "about.privRootK", v: "about.privRootV" },
  { k: "about.privKeyK", v: "about.privKeyV" },
  { k: "about.privUninstallK", v: "about.privUninstallV" },
  { k: "about.privSignK", v: "about.privSignV" },
];

const LIMITS: I18nKey[] = ["about.limit1", "about.limit2", "about.limit3", "about.limit4"];
const CREDITS: I18nKey[] = ["about.creditLicense", "about.creditThird", "about.creditFont"];

export function AboutPane({ version }: { version?: string }) {
  const t = useT();
  return (
    <div className="sf-pane">
      <div className="sf-about-head">
        <h3>{t("about.title")}</h3>
        <p className="sf-about-lead">{t("about.lead")}</p>
        <div className="sf-about-meta">
          {version ? `v${version} · ` : ""}
          {t("about.meta")}
        </div>
      </div>

      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("about.wayTitle")}</b>
        </div>
        {WAY.map((r) => (
          <div className="sf-row" key={r.k}>
            <span className="sf-about-k">{t(r.k)}</span>
            <span className="sf-about-v">{t(r.v)}</span>
          </div>
        ))}
      </div>

      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("about.capTitle")}</b>
        </div>
        {CAPS.map((r) => (
          <div className="sf-row" key={r.k}>
            <span className="sf-about-k">{t(r.k)}</span>
            <span className="sf-about-v">{t(r.v)}</span>
          </div>
        ))}
      </div>

      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("about.privacyTitle")}</b>
        </div>
        {PRIVACY.map((r) => (
          <div className="sf-row" key={r.k}>
            <span className="sf-about-k">{t(r.k)}</span>
            <span className="sf-about-v">{t(r.v)}</span>
          </div>
        ))}
      </div>

      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("about.limitTitle")}</b>
        </div>
        <div className="sf-about-lines">
          {LIMITS.map((k) => (
            <p className="sf-about-line" key={k}>
              {t(k)}
            </p>
          ))}
        </div>
      </div>

      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("about.creditTitle")}</b>
        </div>
        <div className="sf-about-lines">
          {CREDITS.map((k) => (
            <p className="sf-about-line" key={k}>
              {t(k)}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}