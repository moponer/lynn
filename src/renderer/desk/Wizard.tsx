import { useState } from "react";
import type { ModelConfigView, PermissionMode } from "../../shared/contract";
import { Icon } from "../components/Icon";
import { WindowControls } from "../components/WindowControls";
import { THEMES, type ThemeId, type ThemeMode } from "./theme";

/**
 * 造铃向导（规范 §5 场景 3 / 计划书 §2.2）：
 * 主题 → 形象 → 模型 → 能力，四步都可"先用默认，之后再换"。
 * 右侧实时显示"你正在造的那只风铃"：皮 / 形 / 能 / 脑 + 班底。
 */

const STEP_NAMES = ["主题", "形象", "模型", "能力"] as const;

export interface WizardResult {
  theme: ThemeId;
  mode: ThemeMode;
  avatar: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function Wizard({
  current,
  theme,
  mode,
  onTheme,
  onDone,
  onSkip,
}: {
  current: ModelConfigView;
  theme: ThemeId;
  mode: ThemeMode;
  onTheme: (id: ThemeId, mode: ThemeMode) => void;
  onDone: (r: WizardResult) => void;
  /** 先跳过：任何时候都能进主界面（别把人困在引导里） */
  onSkip?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [avatar, setAvatar] = useState(true);
  const [provider, setProvider] = useState(current.provider || "DeepSeek");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl || "https://api.deepseek.com/v1");
  const [model, setModel] = useState(current.model || "deepseek-chat");
  const [apiKey, setApiKey] = useState("");

  const t = THEMES.find((x) => x.id === theme)!;

  const finish = (useDefaults: boolean) => {
    onDone({
      theme,
      mode,
      avatar: useDefaults ? true : avatar,
      provider: provider.trim(),
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: apiKey.trim() || undefined,
    });
  };

  return (
    <div className="scene">
      <header className="rail-top">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="bell" />
          </div>
          <div>
            <div className="brand-name">风铃</div>
            <div className="brand-sub">Lynn</div>
          </div>
        </div>
        <div className="spacer" />
        <div className="crumbs">
          <span className="seg">首次启动 · 造铃</span>
          <Icon name="chev" size="sm" />
          <span className="cur">
            第 {step + 1} 步 / 共 {STEP_NAMES.length} 步
          </span>
        </div>
        <div className="spacer" />
        <span className="mono" style={{ fontSize: "var(--fs-label)", color: "var(--ink-4)" }}>
          四步都可用默认，之后随时在「我的风铃」里换
        </span>
        {onSkip && (
          <button className="ghost-btn" onClick={onSkip} title="直接进入指挥台（模型可在「我的风铃」里随时配）">
            先跳过
          </button>
        )}
        <WindowControls />
      </header>

      <div className="body" style={{ padding: 0 }}>
        <div className="wiz">
          <div className="steps" style={{ marginTop: 0, padding: "0 26px" }}>
            {STEP_NAMES.map((n, i) => (
              <span key={n} style={{ display: "flex", alignItems: "center" }}>
                <span className={`step${i < step ? " done" : i === step ? " now" : ""}`}>
                  <span className="n">{i < step ? "✓" : i + 1}</span>
                  <span className="l">{n}</span>
                </span>
                {i < STEP_NAMES.length - 1 && <span className={`step-line${i < step ? " done" : ""}`} />}
              </span>
            ))}
          </div>

          <div className="wiz-body">
            {step === 0 && (
              <>
                <div className="wiz-h1">
                  先挑一张皮，<span>其余以后都能改</span>
                </div>
                <div className="wiz-sub">
                  主题只决定颜色与光影，<span className="mono">persona.md</span>、记忆与插件都不受影响 —— 随时在「我的风铃」里换。
                </div>

                <div className="theme-row">
                  {THEMES.map((x) => {
                    const cc = x[mode];
                    return (
                      <div
                        key={x.id}
                        className={`theme${theme === x.id ? " on" : ""}`}
                        onClick={() => onTheme(x.id, mode)}
                      >
                        <div className="tp" style={{ background: cc.desk }}>
                          <div className="tp-top" style={{ background: cc.sheet, opacity: 0.14 }} />
                          <div className="tp-side" style={{ background: cc.desk, opacity: 0.9 }} />
                          <div className="tp-sheet" style={{ background: cc.sheet }} />
                          <div className="tp-line" style={{ background: cc.blue, width: 62 }} />
                          <div className="tp-line" style={{ background: cc.blue, width: 40, opacity: 0.55, top: 46 }} />
                          <div className="tp-box" style={{ background: cc.seal, opacity: 0.9 }} />
                          <div className="tp-dot" style={{ background: cc.brass }} />
                        </div>
                        <div className="theme-name">
                          <span className="t">{x.name}</span>
                        </div>
                        <div className="theme-desc">{x.hint}</div>
                        <div className="swatches">
                          <i style={{ background: cc.desk }} />
                          <i style={{ background: cc.blue }} />
                          <i style={{ background: cc.seal }} />
                          <i style={{ background: cc.brass }} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="sf-modes" style={{ marginTop: 14 }}>
                  <button className={`sf-btn${mode === "dark" ? " primary" : ""}`} onClick={() => onTheme(theme, "dark")}>
                    暗色
                  </button>
                  <button className={`sf-btn${mode === "light" ? " primary" : ""}`} onClick={() => onTheme(theme, "light")}>
                    亮色
                  </button>
                  <span className="sf-note" style={{ marginLeft: 6 }}>
                    换皮不改语义：青瓷蓝是结构、朱砂等你拍板、红笔打回、黄铜预算
                  </span>
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div className="wiz-h1">
                  给她一个样子，<span>不装也不影响任何功能</span>
                </div>
                <div className="wiz-sub">形象只消费她的状态流 —— 思考、等待、跑完。常驻 GPU 有红线，随时可整体关闭。</div>

                <div className="wiz-avatar">
                  <div className="wiz-avatar-figure" aria-hidden="true">
                    <svg viewBox="0 0 120 160">
                      <circle cx="60" cy="52" r="26" fill="var(--sheet-3)" />
                      <path d="M20 160c0-28 18-44 40-44s40 16 40 44z" fill="var(--sheet-3)" />
                      <circle cx="86" cy="30" r="5" fill="var(--blue)" />
                    </svg>
                  </div>
                  <div className="wiz-avatar-text">
                    <div className="t">VRM · 三视图 · 可整体关闭</div>
                    <p>发间一枚小铃铛的少女形象。正/侧/背三视图可旋转，状态机接她的思考与交付。</p>
                    <div className="sf-modes">
                      <button className={`sf-btn${avatar ? " primary" : ""}`} onClick={() => setAvatar(true)}>
                        先装上
                      </button>
                      <button className={`sf-btn${!avatar ? " primary" : ""}`} onClick={() => setAvatar(false)}>
                        先不装
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div className="wiz-h1">
                  接上自己的脑，<span>Key 只在你本机</span>
                </div>
                <div className="wiz-sub">OpenAI 兼容端点都行：DeepSeek、GLM、Kimi、Qwen、MiniMax、Ollama…</div>

                <div className="wiz-form">
                  <label className="sf-field">
                    <span className="sf-label">服务商</span>
                    <input className="sf-input" value={provider} onChange={(e) => setProvider(e.target.value)} />
                  </label>
                  <label className="sf-field">
                    <span className="sf-label">Base URL</span>
                    <input className="sf-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                  </label>
                  <label className="sf-field">
                    <span className="sf-label">模型</span>
                    <input className="sf-input" value={model} onChange={(e) => setModel(e.target.value)} />
                  </label>
                  <label className="sf-field">
                    <span className="sf-label">API Key</span>
                    <input
                      className="sf-input"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={current.apiKeySet ? "已保存（留空则沿用）" : "sk-…"}
                    />
                    <small className="sf-hint">用系统凭据库加密存本机；不填也能先看界面，之后再配</small>
                  </label>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="wiz-h1">
                  她能替你做主，<span>但不替你签字</span>
                </div>
                <div className="wiz-sub">动手前先给你看任务契约；交付看结果；验收与打回都由你按章。</div>

                <div className="wiz-caps">
                  <div className="wiz-cap">
                    <div className="wc-h">
                      <span className="t">她手上的工具</span>
                      <span className="mono">8 件管理型</span>
                    </div>
                    <div className="wc-d">招募、派单、跟进、审查、汇报、问你。她不会自己改文件或抓网页。</div>
                  </div>
                  <div className="wiz-cap">
                    <div className="wc-h">
                      <span className="t">动手的人是成员</span>
                      <span className="mono">在任务工作区里</span>
                    </div>
                    <div className="wc-d">成员只拿到本次分配的工具，文件活动被钉在 tasks/&lt;id&gt;/workspace/。</div>
                  </div>
                  <div className="wiz-cap">
                    <div className="wc-h">
                      <span className="t">还没接入的能力</span>
                      <span className="mono">不显示假开关</span>
                    </div>
                    <div className="wc-d">办公文档、浏览器、OCR 还没装；用到时她会如实说没装，不会假装执行。</div>
                  </div>
                </div>
              </>
            )}

            <div className="wiz-actions">
              {step > 0 && (
                <button className="sf-btn" onClick={() => setStep((s) => s - 1)}>
                  上一步
                </button>
              )}
              {step < STEP_NAMES.length - 1 ? (
                <>
                  <button
                    type="button"
                    className="btn btn-accept"
                    style={{ flex: "none", padding: "10px 26px", fontSize: "var(--fs-body)" }}
                    onClick={() => setStep((s) => s + 1)}
                  >
                    下一步 · {STEP_NAMES[step + 1]}
                  </button>
                  <button className="ghost-btn" style={{ padding: "9px 16px", fontSize: "var(--fs-meta)" }} onClick={() => finish(true)}>
                    先用默认，之后再换
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-accept"
                    style={{ flex: "none", padding: "10px 26px", fontSize: "var(--fs-body)" }}
                    onClick={() => finish(false)}
                  >
                    开始使用
                  </button>
                  <button className="ghost-btn" style={{ padding: "9px 16px", fontSize: "var(--fs-meta)" }} onClick={() => finish(true)}>
                    先这样，之后再换
                  </button>
                </>
              )}
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--ink-4)" }}>三分钟造完，直接开始第一次对话</span>
            </div>
          </div>
        </div>

        <aside className="right" style={{ width: 412 }}>
          <div className="right-scroll" style={{ padding: "22px 18px" }}>
            <div className="h-cap" style={{ marginBottom: 14 }}>
              你正在造的那只风铃
            </div>

            <div className="idcard">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="brand-mark" style={{ width: 52, height: 52, borderRadius: 8 }}>
                  <Icon name="bell" size="lg" />
                </div>
                <div>
                  <div className="id-name">风铃</div>
                  <div className="id-sub">名字固定 · 语气可以调</div>
                </div>
              </div>

              <div className="idgrid">
                <div className="idtile">
                  <div className="k">
                    <Icon name="layers" size="sm" />
                    <span>皮</span>
                  </div>
                  <div className="v">{t.name}</div>
                  <div className="d">{mode === "dark" ? "暗色" : "亮色"} · 换皮不改记忆</div>
                </div>
                <div className="idtile">
                  <div className="k">
                    <Icon name="eye" size="sm" />
                    <span>形</span>
                  </div>
                  <div className="v">{avatar ? "默认少女" : "未启用"}</div>
                  <div className="d">三视图 · 可整体关闭</div>
                </div>
                <div className="idtile">
                  <div className="k">
                    <Icon name="pkg" size="sm" />
                    <span>能</span>
                  </div>
                  <div className="v">只有管理型 8 件</div>
                  <div className="d">第 4 步按需装</div>
                </div>
                <div className="idtile">
                  <div className="k">
                    <Icon name="brain" size="sm" />
                    <span>脑</span>
                  </div>
                  <div className="v">{apiKey.trim() || current.apiKeySet ? model : "尚未配置"}</div>
                  <div className="d">{provider}</div>
                </div>
              </div>

              <ul className="give-list">
                <li>
                  <Icon name="check" size="sm" />
                  <span>
                    她的<b>班底</b>：不是预置的。她会按你交给的事自己招人，写下岗位、边界和验收标准。
                  </span>
                </li>
                <li>
                  <Icon name="check" size="sm" />
                  <span>
                    招来的人<b>留在编制表里</b>，可解散、可复用 —— 下次同类活直接叫她上。
                  </span>
                </li>
                <li>
                  <Icon name="check" size="sm" />
                  <span>
                    换主题、换模型、换工具，<b>都不会清空记忆与会话</b>。
                  </span>
                </li>
              </ul>
            </div>

            <div className="note">
              <Icon name="lock" size="sm" />
              所有数据留在 <span className="mono">~/.lynn/</span>，无遥测、无中转。你随时能带走 —— 换电脑时一个目录就搬完了。
            </div>

            <div className="wiz-cant">
              <div className="h-cap" style={{ color: "var(--seal)", marginBottom: 7 }}>
                她做不到的事
              </div>
              <div className="wiz-cant-text">
                她不会自己改文件、不会自己抓网页。她只有 8 件调度工具 —— 动手的永远是她的成员，出了事她负责。
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="h-cap" style={{ marginBottom: 9 }}>
                造完之后 · 你会看到
              </div>
              <div className="wiz-after">
                <div className="idtile">
                  <div className="k">
                    <Icon name="list" size="sm" />
                    <span>台账</span>
                  </div>
                  <div className="d" style={{ marginTop: 5 }}>
                    任务按「事」排，不按「话」
                  </div>
                </div>
                <div className="idtile">
                  <div className="k">
                    <Icon name="users" size="sm" />
                    <span>编制</span>
                  </div>
                  <div className="d" style={{ marginTop: 5 }}>
                    她招的人都在册上
                  </div>
                </div>
                <div className="idtile">
                  <div className="k">
                    <Icon name="target" size="sm" />
                    <span>结果</span>
                  </div>
                  <div className="d" style={{ marginTop: 5 }}>
                    交付才算完成
                  </div>
                </div>
                <div className="idtile">
                  <div className="k">
                    <Icon name="shield" size="sm" />
                    <span>权限</span>
                  </div>
                  <div className="d" style={{ marginTop: 5 }}>
                    四档，随手看得见
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** 造铃完成后的权限档位默认值（首启不吓人：询问） */
export const DEFAULT_PERMISSION: PermissionMode = "ask";
