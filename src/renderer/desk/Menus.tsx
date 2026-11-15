// 右键菜单族（2026-11-14）：从 Desk.tsx 拆出。
//
// 2026-11-15 统一：外壳与交互（定位/关闭/键盘）全部交给 components/Menu，
// 这里只剩"这张菜单有哪些项、怎么分组、哪一项危险"。
// 分组口径（与确认卡片一致）：
//   主动作 → 次要动作 → （发丝线）→ 不可恢复动作（永远在最后、永远单独一段）。
// 危险动作不再在菜单里换页确认——统一交给 components/ConfirmCard 的卡片，
// 菜单只负责把"要做危险动作"这个意图抛给调用方（onAsk / onDelete）。
import { useState } from "react";
import { useT } from "../i18n";
import { Icon, type IconName } from "../components/Icon";
import { Menu, MenuCap, MenuItem, MenuSep } from "../components/Menu";
import { STATUS_KEY, statusChipClass, type DeskJob, type DeskMember, type DeskOutput } from "./model";

/** 交付箱右键菜单：打开 / 定位 / 复制 / 查看所属，删除单独成段 */
export function OutputMenu({
  out,
  x,
  y,
  onClose,
  onOpen,
  onReveal,
  onInfo,
  onDelete,
}: {
  out: DeskOutput;
  x: number;
  y: number;
  onClose: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onInfo: () => void;
  /** 删除交给确认卡片（"只移除记录"和"连文件一起删"是两件事，卡片里说清） */
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const name = out.abs.split(/[\\/]/).filter(Boolean).pop() ?? out.path;
  return (
    <Menu x={x} y={y} estW={236} estH={280} label={name} onClose={onClose}>
      <div className="jobmenu-h">
        <Icon name="file" size="sm" />
        <span className="jobmenu-title" title={out.abs}>
          {name}
        </span>
      </div>
      <div className="jobmenu-sub mono" title={out.job.title}>
        {out.job.title}
      </div>
      <MenuCap>打开</MenuCap>
      <MenuItem icon={<Icon name="file" size="sm" />} label="打开文件" lead onSelect={onOpen} />
      <MenuItem icon={<Icon name="folder" size="sm" />} label="打开所在目录" onSelect={onReveal} />
      <MenuCap>文件信息</MenuCap>
      <MenuItem
        icon={<Icon name="clip" size="sm" />}
        label={copied ? "已复制" : "复制路径"}
        onSelect={() => {
          void navigator.clipboard
            ?.writeText(out.abs)
            .then(() => {
              setCopied(true);
              window.setTimeout(onClose, 480);
            })
            .catch(() => setCopied(false));
        }}
      />
      <MenuItem icon={<Icon name="info" size="sm" />} label="查看所属" onSelect={onInfo} />
      <MenuSep />
      <MenuItem icon={<Icon name="trash" size="sm" />} label="删除…" danger onSelect={onDelete} />
    </Menu>
  );
}

/**
 * 通用「文件」右键菜单：证据链、产物清单共用。
 *
 * 和交付箱那份的区别：这里只有"这个文件"能做的事——打开 / 定位 / 复制路径。
 * 「查看所属」「删除」是交付物才有的语义（交付物有归属、可移出交付箱），
 * 证据是"我核对过"的记录，不该给一个删除入口。
 */
export function RefMenu({
  taskId,
  fileRef,
  label,
  x,
  y,
  onClose,
  onOpen,
  onReveal,
  onCopied,
}: {
  taskId: string;
  fileRef: string;
  label?: string;
  x: number;
  y: number;
  onClose: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopied?: (msg: string) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const name = fileRef.split(/[\\/]/).filter(Boolean).pop() ?? fileRef;
  return (
    <Menu x={x} y={y} estW={236} estH={200} label={name} onClose={onClose}>
      <div className="jobmenu-h">
        <Icon name="file" size="sm" />
        <span className="jobmenu-title" title={fileRef}>
          {name}
        </span>
      </div>
      {/* 说明行只在"和文件名不一样"时才出：一样就是同一句话说两遍 */}
      {label && label !== name && (
        <div className="jobmenu-sub" title={label}>
          {label}
        </div>
      )}
      <MenuCap>打开</MenuCap>
      <MenuItem icon={<Icon name="file" size="sm" />} label="打开文件" lead onSelect={onOpen} />
      <MenuItem icon={<Icon name="folder" size="sm" />} label="打开所在目录" onSelect={onReveal} />
      <MenuSep />
      <MenuItem
        icon={<Icon name="clip" size="sm" />}
        label={note === "已复制" ? "已复制" : "复制路径"}
        onSelect={() => {
          // 绝对路径要主进程解析（渲染层只有卷宗内相对 ref）
          void window.lynn
            ?.rpc("app.resolveRef", { taskId, ref: fileRef })
            .then((r: { ok: boolean; path?: string; error?: string }) => {
              if (!r?.ok || !r.path) {
                setNote(r?.error ?? "解析路径失败");
                return;
              }
              void navigator.clipboard
                ?.writeText(r.path)
                .then(() => {
                  onCopied?.("已复制路径");
                  setNote("已复制");
                  window.setTimeout(onClose, 460);
                })
                .catch(() => setNote("复制失败（剪贴板不可用）"));
            });
        }}
      />
      {note && note !== "已复制" && <div className="jobmenu-note">{note}</div>}
    </Menu>
  );
}

/**
 * 工单卡右键菜单（2026-11-04）：
 * 卡住的单一度只能挂在台账里——「停」只 abort 成员、不改状态，「新对话」也不动后台。
 *
 * 分组：看待这张单（打开 / 去出发会话）→ 成员（停 / 授权）→ 卷宗（沙箱 / 导出）
 *       → 发丝线 → 撤回、删除（不可恢复，走确认卡片）。
 */
export function JobMenu({
  job,
  x,
  y,
  running,
  onClose,
  onOpen,
  onThread,
  onStop,
  onDismiss,
  onRemove,
  onGrantRead,
  onRevokeRead,
  onSnapshotProject,
  onExport,
}: {
  job: DeskJob;
  x: number;
  y: number;
  running: boolean;
  onClose: () => void;
  onOpen: () => void;
  onThread?: () => void;
  onStop?: () => void;
  /** 撤回 / 删除：菜单不换页，调用方负责弹确认卡片 */
  onDismiss?: () => void;
  onRemove?: () => void;
  /** 只读授权（用户亲手选目录；写仍限工作区） */
  onGrantRead?: () => void;
  onRevokeRead?: () => void;
  /** 把工作区复制进任务沙箱再跑测试（原项目不动） */
  onSnapshotProject?: () => void;
  /** 导出卷宗 zip */
  onExport?: () => void;
}) {
  const t = useT();
  const done = job.status === "done" || job.status === "canceled";
  return (
    <Menu x={x} y={y} estW={236} estH={360} label={job.id} onClose={onClose}>
      <div className="jobmenu-h">
        <Icon name="cube" size="sm" />
        {/* 菜单头也用任务名：工单号放下面一行小字，审计时再认 */}
        <span className="jobmenu-title" title={job.title}>
          {job.title}
        </span>
        <span className={`st ${statusChipClass(job)}`}>{t(STATUS_KEY[job.status] ?? "status.todo")}</span>
      </div>
      <div className="jobmenu-sub mono" title={t("tov.idHint")}>
        {job.id}
        {job.teamName ? ` · ${job.teamName}` : ""}
      </div>
      <MenuItem icon={<Icon name="eye" size="sm" />} label={t("menu.open")} lead onSelect={onOpen} />
      {onThread && <MenuItem icon={<Icon name="send" size="sm" />} label={t("menu.thread")} onSelect={onThread} />}
      {(onStop || onGrantRead || onRevokeRead) && <MenuCap>成员</MenuCap>}
      {onStop && <MenuItem icon={<Icon name="stop" size="sm" />} label={t("menu.stop")} onSelect={onStop} />}
      {onGrantRead && (
        <MenuItem icon={<Icon name="lock" size="sm" />} label={t("menu.grantRead")} onSelect={onGrantRead} />
      )}
      {onRevokeRead && (
        <MenuItem icon={<Icon name="eye" size="sm" />} label={t("menu.revokeRead")} onSelect={onRevokeRead} />
      )}
      {(onSnapshotProject || onExport) && <MenuCap>卷宗</MenuCap>}
      {onSnapshotProject && (
        <MenuItem
          icon={<Icon name="cube" size="sm" />}
          label="拷进任务沙箱跑测试…"
          onSelect={onSnapshotProject}
        />
      )}
      {onExport && <MenuItem icon={<Icon name="archive" size="sm" />} label="导出卷宗 zip…" onSelect={onExport} />}
      {((!done && onDismiss) || (!running && job.status !== "in_progress" && onRemove)) && <MenuSep />}
      {!done && onDismiss && (
        <MenuItem
          icon={<Icon name="undo" size="sm" />}
          label={t("menu.dismiss")}
          hint={t("menu.dismissAsk")}
          onSelect={onDismiss}
        />
      )}
      {!running && job.status !== "in_progress" && onRemove && (
        <MenuItem
          icon={<Icon name="trash" size="sm" />}
          label={t("menu.remove")}
          hint={t("menu.removeAsk")}
          danger
          onSelect={onRemove}
        />
      )}
    </Menu>
  );
}

/**
 * 成员右键菜单（群聊模式）：资料 / 目标 / 进度 / @他 / 催一下。
 * 分组：看他的状态 → 发丝线 → 找他说话。
 */
export function MemberMenu({
  member,
  x,
  y,
  onClose,
  onProfile,
  onJob,
  onProgress,
  onAt,
  onNudge,
}: {
  member: DeskMember;
  x: number;
  y: number;
  onClose: () => void;
  onProfile: () => void;
  onJob: () => void;
  onProgress: () => void;
  onAt: () => void;
  onNudge: () => void;
}) {
  const items: {
    label: string;
    icon: IconName;
    hint: string;
    on: () => void;
    off?: boolean;
    lead?: boolean;
  }[] = [
    { label: "查看资料", icon: "user", hint: "岗位档案 · 战绩", on: onProfile, lead: true },
    { label: "任务目标", icon: "target", hint: member.jobId ? "他被要求做什么" : "他手上没单", on: onJob, off: !member.jobId },
    { label: "进度", icon: "clock", hint: "最近在干什么 · 卷宗时间线", on: onProgress, off: !member.jobId },
  ];
  const talk: typeof items = [
    { label: "@他说话", icon: "at", hint: "插到输入框里", on: onAt },
    { label: "催一下", icon: "bell", hint: "话转给他，下一轮生效", on: onNudge, off: !member.jobId || member.status !== "running" },
  ];
  return (
    <Menu x={x} y={y} estW={236} estH={260} label={member.name} onClose={onClose}>
      <div className="jobmenu-h">
        <Icon name="user" size="sm" />
        <span className="jobmenu-title">{member.name}</span>
        <span className="st">{member.role}</span>
      </div>
      <div className="jobmenu-sub mono">
        {member.teamName ?? member.teamId}
        {member.jobId ? ` · ${member.jobId}` : ""}
      </div>
      {items.map((it) => (
        <MenuItem
          key={it.label}
          icon={<Icon name={it.icon} size="sm" />}
          label={it.label}
          hint={it.hint}
          lead={it.lead}
          disabled={it.off}
          onSelect={it.on}
        />
      ))}
      <MenuSep />
      {talk.map((it) => (
        <MenuItem
          key={it.label}
          icon={<Icon name={it.icon} size="sm" />}
          label={it.label}
          hint={it.hint}
          disabled={it.off}
          onSelect={it.on}
        />
      ))}
    </Menu>
  );
}

/**
 * 群操作菜单（群列表）：置顶 / 改名 / 删除。
 * 一个入口就够——原来三个小图标散在行尾，越窄越挤，还占掉摘要的宽度。
 */
export function ThreadMenu({
  title,
  pinned,
  x,
  y,
  onClose,
  onPin,
  onRename,
  onDelete,
}: {
  title: string;
  pinned?: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onPin: (pinned: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <Menu x={x} y={y} estW={228} estH={170} label={title} onClose={onClose}>
      <div className="jobmenu-h">
        <Icon name="list" size="sm" />
        <span className="jobmenu-title">{title}</span>
      </div>
      <MenuCap>这个群</MenuCap>
      <MenuItem
        icon={<Icon name="pin" size="sm" />}
        label={pinned ? "取消置顶" : "置顶"}
        lead
        onSelect={() => {
          onPin(!pinned);
          onClose();
        }}
      />
      <MenuItem
        icon={<Icon name="pen" size="sm" />}
        label={t("ledger.threadRename")}
        onSelect={() => {
          onRename();
          onClose();
        }}
      />
      <MenuSep />
      <MenuItem
        icon={<Icon name="trash" size="sm" />}
        label={t("ledger.threadDelete")}
        danger
        onSelect={() => {
          onDelete();
          onClose();
        }}
      />
    </Menu>
  );
}
