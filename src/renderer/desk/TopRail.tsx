// 顶栏（2026-11-14）：Desk 与审查台都用它，所以独立成文件（放 Desk 里会造成循环引用）。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { Icon } from "../components/Icon";
import { WindowControls } from "../components/WindowControls";
import { Slot, SandboxHtml } from "./ui-host";
import { fmtTokens } from "./model";
import { UsageMeter } from "../components/UsageMeter";
import type { Desk } from "./model";
import type { PermissionMode } from "../../shared/contract";
import type { I18nKey } from "../../shared/i18n-strings";

// ============================ TOP RAIL ============================

export function TopRail({
  desk,
  permission,
  onPermission,
  onOpenSettings,
  onUndo,
  pending,
  rightOpen,
  onToggleRight,
  mode = "desk",
  onBack,
  onPickProject,
  onClearWorkspace,
  onAddReadRoots,
  onRemoveReadRoot,
  onTrustProject,
}: {
  desk: Desk;
  permission: PermissionMode;
  onPermission: (m: PermissionMode) => void;
  onOpenSettings: () => void;
  onUndo?: () => void;
  /** 等你的件数（只在窄窗显示成按钮，宽屏右栏本来就一直看得见） */
  pending?: number;
  rightOpen?: boolean;
  onToggleRight?: () => void;
  mode?: "desk" | "review";
  /** 审查台返回值台（E2）：唯一的深页面必须有显式出口，不能靠空态里的斜体链接 */
  onBack?: () => void;
  /** 换当前会话的工作区（项目根） */
  onPickProject?: () => void;
  /** 这次不用工作区（主根清空，产出落卷宗沙箱） */
  onClearWorkspace?: () => void;
  /** 给当前会话加只读目录（可多选） */
  onAddReadRoots?: () => void;
  /** 撤掉一个会话附加根 */
  onRemoveReadRoot?: (path: string) => void;
  /** 改当前项目的信任（项目级 MCP 与技能只在信任时生效） */
  onTrustProject?: (trusted: boolean) => void;
}) {
  const [wsMenu, setWsMenu] = useState(false);
  /** 菜单用 fixed 定位：顶栏与图纸都有 overflow / 层叠上下文，absolute 会被裁掉或盖住 */
  const [wsPos, setWsPos] = useState({ top: 0, left: 0 });
  const wsRef = useRef<HTMLDivElement | null>(null);
  const wsBtnRef = useRef<HTMLButtonElement | null>(null);
  const wsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!wsMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // 菜单已 portal 到 body，不在 wsRef 里：两处都要判，否则点菜单项会被当成「点外面」
      if (wsRef.current?.contains(t) || wsMenuRef.current?.contains(t)) return;
      setWsMenu(false);
    };
    const close = () => setWsMenu(false);
    document.addEventListener("mousedown", onDown);
    // fixed 菜单不跟滚动/缩放走：位置一变就关掉，避免悬在错的地方
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [wsMenu]);
  const shortName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const extras = desk.workspaceExtras;
  /** 信任：只有目录里真有"被信任才生效"的东西时才给入口（2026-11-13） */
  const projectGated = desk.projectGated;
  const projectTrusted = desk.projectTrusted ?? false;
  const t = useT();
  return (
    <header
      className="rail-top"
      onDoubleClick={() => {
        // 拖拽区双击 = 最大化/还原（no-drag 控件不受影响）
        try {
          Promise.resolve(window.lynn.rpc("window.control", { action: "maximize" })).catch(() => undefined);
        } catch {
          /* 假桥环境下忽略 */
        }
      }}
    >
      <div className="brand">
        <div className="brand-mark" aria-label="Lynn">
          L
        </div>
        <div>
          <div className="brand-name">{t("top.brand")}</div>
          <div className="brand-sub">Lynn</div>
        </div>
      </div>
      <div className="vr" />
      {mode === "review" && onBack && (
        <button type="button" className="ghost-btn" onClick={onBack} title={t("top.backTitle")}>
          <Icon name="undo" size="sm" /> {t("top.back")}
        </button>
      )}
      <div className="crumbs">
        {/* 工作区 chip：点开是"换目录 / 不用工作区 / 可读目录"三件事，不再只跳一次目录框 */}
        <div className="wsmenu-wrap" ref={wsRef}>
          <button
            type="button"
            ref={wsBtnRef}
            className="crumb-chip crumb-btn"
            onClick={() => {
              const r = wsBtnRef.current?.getBoundingClientRect();
              if (r) setWsPos({ top: r.bottom + 6, left: r.left });
              setWsMenu((v) => !v);
            }}
            title={desk.workspacePrimary ?? t("top.projectHint", { dir: desk.project })}
          >
            <Icon name="folder" size="sm" /> {desk.project}
            {extras.length > 0 && <span className="wsmenu-badge">{extras.length}</span>}
            <Icon name="chev" size="sm" />
          </button>
          {wsMenu &&
            createPortal(
            <div ref={wsMenuRef} className="wsmenu" role="menu" style={{ top: wsPos.top, left: wsPos.left }}>
              <button
                type="button"
                className="jobmenu-item"
                onClick={() => {
                  setWsMenu(false);
                  onPickProject?.();
                }}
              >
                换工作区…
              </button>
              <button
                type="button"
                className="jobmenu-item"
                onClick={() => {
                  setWsMenu(false);
                  onClearWorkspace?.();
                }}
              >
                这次不用工作区
              </button>
              {/* 信任：只在目录里真有"被信任才生效"的东西时才出现（2026-11-13） */}
              {projectGated?.mcp || projectGated?.skills ? (
                <>
                  <div className="wsmenu-cap">这个项目</div>
                  <button
                    type="button"
                    className="jobmenu-item"
                    onClick={() => {
                      setWsMenu(false);
                      onTrustProject?.(!projectTrusted);
                    }}
                    title={
                      projectTrusted
                        ? "取消信任：项目级 MCP 与技能不再加载"
                        : "信任：加载这个目录里的项目级 MCP 与技能（项目级 MCP 会启动外部进程）"
                    }
                  >
                    {projectTrusted ? "取消信任这个项目" : "信任这个项目"}
                    <span className="wsmenu-badge">
                      {[projectGated.mcp && "MCP", projectGated.skills && "技能"].filter(Boolean).join(" + ")}
                    </span>
                  </button>
                </>
              ) : null}
              <div className="wsmenu-cap">可读目录</div>
              {extras.length === 0 && <div className="wsmenu-empty">还没有；需要读外部资料时加一个。</div>}
              {extras.map((x) => (
                <div className="wsmenu-row" key={x.path}>
                  <span className="nm" title={`${x.path}（${x.mode === "rw" ? "可写" : "只读"}）`}>
                    {x.label ?? shortName(x.path)}
                    {x.mode === "rw" && <b className="rw">可写</b>}
                  </span>
                  <button
                    type="button"
                    className="wsmenu-x"
                    title="撤掉这个目录的访问"
                    onClick={() => onRemoveReadRoot?.(x.path)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="jobmenu-item"
                onClick={() => {
                  setWsMenu(false);
                  onAddReadRoots?.();
                }}
              >
                添加只读目录…
              </button>
            </div>,
            document.body,
            )}
        </div>
      </div>
      <div className="spacer" />

      {/* 顶栏不再印工单号：左栏台账 + 右栏动态已经各有一处，第三个入口只是「—」这样的空占位 */}

      {/* 窄窗：右栏收成抽屉后，"等你拍板"必须有个进得去的入口（悬停边缘不算入口） */}
      {pending !== undefined && pending > 0 && onToggleRight && (
        <button
          type="button"
          className={`ghost-btn only-narrow pending-btn${rightOpen ? " on" : ""}`}
          onClick={onToggleRight}
          aria-pressed={rightOpen}
          title={t("top.pendingHint")}
        >
          <Icon name="shield" size="sm" /> {t("top.pending", { n: pending })}
        </button>
      )}

      {/* 审查台是深页面：权限档在这里是死按钮，干脆不渲染（E2） */}
      {mode !== "review" && (
        <>
          <div className="seg">
            {PERMISSIONS.map((p) => (
              <button
                type="button"
                key={p.mode}
                aria-pressed={permission === p.mode}
                className={`seg-item${p.mode === "full" ? " danger" : ""}${permission === p.mode ? " on" : ""}`}
                onClick={() => onPermission(p.mode)}
                title={t("top.switchTo", { label: t(p.labelKey) })}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>

          <div className="vr" />
        </>
      )}

      {/* status.bar 卡槽：官方受限组件（用量读数） */}
      <Slot
        slot="status.bar"
        render={(p) =>
          p.html ? (
            <SandboxHtml plugin={p} width={132} height={22} />
          ) : p.sandbox ? null : (
            <span className="st st-idle" title={p.description ?? p.name}>
              {p.name} {fmtTokens(desk.tokensUsed)}
            </span>
          )
        }
      />

      {/* D3：会话级预算——真的配了软上限才出现（黄铜=预算的唯一样式归属，不画假数据） */}
      {desk.budget && (
        <span
          className={`budget-chip${desk.budget.spent >= desk.budget.soft ? " over" : ""}`}
          title={t("top.budgetTitle", {
            used: fmtTokens(desk.budget.spent),
            total: fmtTokens(desk.budget.soft),
          })}
        >
          {t("top.budget")} {Math.round((desk.budget.spent / desk.budget.soft) * 100)}%
        </span>
      )}

      {/* 用量计：会话 token 消耗 + 缓存命中率 + 上下文，点开看明细。
          替代原来的「上下文 12 格仪表 + 缓存命中率徽章」两个分散元素，口径统一（D3）。 */}
      <UsageMeter usage={desk.usage} budget={desk.budget} tokensUsed={desk.tokensUsed} />

      <div className="vr" />
      {desk.turn.canUndo && onUndo && (
        <button
          className="ghost-btn"
          onClick={onUndo}
          title={t("top.undoTitle", { files: (desk.turn.changedFiles ?? []).join("、") })}
        >
          <Icon name="undo" size="sm" /> {t("top.undo")}
        </button>
      )}
      {mode !== "review" && (
        <>
          <button className="ghost-btn" onClick={onOpenSettings} title={t("top.settings")}>
            <Icon name="user" size="sm" /> {t("top.settings")}
          </button>
        </>
      )}
      {/* 自绘窗口按钮（frame:false）：拖拽由 .rail-top 的 -webkit-app-region: drag 提供 */}
      <WindowControls />
    </header>
  );
}

/**
 * 值台（Dispatch Desk）—— 设计规范 §4 的三栏骨架：
 * 台账 258 / 图纸 flex / 编制表 384，底部指令台。
 * 三种声音：成员产出（等宽）/ 风铃（纸边批注）/ 你（朱砂印章）。
 */

export const PERMISSIONS: { mode: PermissionMode; labelKey: I18nKey; en: string }[] = [
  { mode: "plan", labelKey: "perm.plan", en: "PLAN" },
  { mode: "ask", labelKey: "perm.ask", en: "ASK" },
  { mode: "auto", labelKey: "perm.auto", en: "AUTO" },
  { mode: "full", labelKey: "perm.full", en: "FULL" },
];
