import { useEffect, useState } from "react";
import { useT } from "../../i18n";

/**
 * IM 渠道设置页（2026-11-18 P14-2）。
 *
 * 为什么单独一个组件而不是塞进 `SettingsModal`：
 * 那个文件已经 2,814 行，再加一块会让维护更难。这里只依赖两个 RPC，
 * 边界干净。
 *
 * ## 安全设计（这是重点）
 *
 * **appSecret 走 safeStorage 加密落盘**，与模型 API Key 同一套路径：
 *  - 前端只传明文一次（用户点保存时）；
 *  - 内核立刻加密存盘，之后**只回传"已配置"标记，不回传明文**；
 *  - 界面上永远看不到已存的 secret，只能覆盖写。
 *
 * 这是"凭据只经内核注入，不下发渲染层"（项目既有约定）的具体落实。
 *
 * ## 白名单是必填的
 *
 * 飞书消息来自陌生人，而 Lynn 的成员有文件与命令权限。
 * 白名单为空时**渠道拒绝启动**——所以这里必须让用户填，不能留空就点保存。
 */
interface ImStatus {
  bridgeEnabled: boolean;
  feishu: {
    appId: string;
    /** 只回传"有没有配过"，不回传明文 */
    secretSet: boolean;
    allowOpenIds: string[];
    allowGroup: boolean;
    enabled: boolean;
  } | null;
}

export function ImSettingsPane() {
  const t = useT();
  const [status, setStatus] = useState<ImStatus | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [allowOpenIds, setAllowOpenIds] = useState("");
  const [allowGroup, setAllowGroup] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await window.lynn.rpc("im.status");
      setStatus(r);
      if (r.feishu) {
        setAppId(r.feishu.appId);
        setAllowOpenIds(r.feishu.allowOpenIds.join("\n"));
        setAllowGroup(r.feishu.allowGroup);
        setEnabled(r.feishu.enabled);
      }
    } catch {
      setStatus({ bridgeEnabled: false, feishu: null });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const ids = allowOpenIds
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await window.lynn.rpc("im.saveFeishu", {
        appId: appId.trim(),
        // 空字符串 = 不修改已存的 secret（用户只改别的字段时不必重输）
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        allowOpenIds: ids,
        allowGroup,
        enabled,
      });
      if (r.ok) {
        setAppSecret("");
        setMsg({ ok: true, text: t("im.saved") });
        await load();
      } else {
        setMsg({ ok: false, text: r.error ?? t("im.saveFailed") });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** 自检结果（P14-3）：逐步展示，用户不用开终端就知道哪里错了 */
  const [checks, setChecks] = useState<{ label: string; ok: boolean; detail: string }[]>([]);
  const [checking, setChecking] = useState(false);
  const runCheck = async () => {
    setChecking(true);
    setChecks([]);
    try {
      const r = await window.lynn.rpc("im.checkFeishu", {
        ...(appId.trim() ? { appId: appId.trim() } : {}),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
      });
      setChecks(r.steps ?? []);
    } catch (e) {
      setChecks([{ label: t("im.checkFailed"), ok: false, detail: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setChecking(false);
    }
  };

  const f = status?.feishu;

  return (
    <div className="sf-pane">
      <h3>{t("im.title")}</h3>
      <p className="sf-lede">{t("im.lede")}</p>

      {/* 端点状态：用户要知道现在到底开没开 */}
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("im.bridgeTitle")}</b>
          <small>{t("im.bridgeHint")}</small>
        </div>
        <div className="sf-row">
          <span className="sf-label" style={{ flex: 1 }}>
            {t("im.bridgeState")}
          </span>
          <span className={`sf-badge ${status?.bridgeEnabled ? "ok" : ""}`}>
            {status?.bridgeEnabled ? t("im.bridgeOn") : t("im.bridgeOff")}
          </span>
        </div>
        {!status?.bridgeEnabled && <p className="sf-empty">{t("im.bridgeEnvHint")}</p>}
      </div>

      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("im.feishuTitle")}</b>
          <small>{t("im.feishuHint")}</small>
        </div>

        <label className="sf-field">
          <span className="sf-label">{t("im.appId")}</span>
          <input
            className="sf-input"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            spellCheck={false}
          />
        </label>

        <label className="sf-field">
          <span className="sf-label">
            {t("im.appSecret")}
            {f?.secretSet && <span className="sf-badge ok">{t("im.secretSet")}</span>}
          </span>
          <input
            className="sf-input"
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={f?.secretSet ? t("im.secretKeep") : t("im.secretPlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
          <small className="sf-hint">{t("im.secretHint")}</small>
        </label>

        <label className="sf-field">
          <span className="sf-label">{t("im.allowList")}</span>
          <textarea
            className="sf-input"
            rows={4}
            value={allowOpenIds}
            onChange={(e) => setAllowOpenIds(e.target.value)}
            placeholder={"ou_xxxxxxxxxxxxxxxx\nou_yyyyyyyyyyyyyyyy"}
            spellCheck={false}
          />
          {/* 白名单是必填：留空渠道拒绝启动，必须在这里说清 */}
          <small className="sf-hint">{t("im.allowListHint")}</small>
        </label>

        <label className="sf-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={allowGroup} onChange={(e) => setAllowGroup(e.target.checked)} />
          <span className="sf-label">{t("im.allowGroup")}</span>
        </label>

        <label className="sf-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="sf-label">{t("im.enable")}</span>
        </label>

        <div className="sf-actions">
          <button type="button" className="sf-btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? t("im.saving") : t("im.save")}
          </button>
          {/* 自检：不用开终端就能知道凭据/机器人对不对 */}
          <button type="button" className="sf-btn" disabled={checking} onClick={() => void runCheck()}>
            {checking ? t("im.checking") : t("im.check")}
          </button>
        </div>

        {msg && <div className={`sf-result ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}

        {checks.length > 0 && (
          <div className="sf-list">
            {checks.map((c, i) => (
              <div className="sf-row" key={i}>
                <div className="sf-row-main">
                  <b>{c.ok ? "✅" : "✖"} {c.label}</b>
                  {c.detail && <small>{c.detail}</small>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 怎么拿到 open_id：不写这一步用户会卡住 */}
      <div className="sf-group">
        <div className="sf-group-head">
          <b>{t("im.howToTitle")}</b>
        </div>
        <ol className="sf-about-lines">
          <li>{t("im.howTo1")}</li>
          <li>{t("im.howTo2")}</li>
          <li>{t("im.howTo3")}</li>
          <li>{t("im.howTo4")}</li>
        </ol>
      </div>
    </div>
  );
}