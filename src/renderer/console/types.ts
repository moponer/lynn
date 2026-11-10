import type { PermissionMode } from "../../shared/contract";
import type { Desk } from "../desk/model";

/**
 * 控制台视图的入参（`stage.console` 卡槽传给注册表里的组件）。
 *
 * 约定：视图只读 Desk 模型与回调，**不自己发 rpc 取业务数据**——
 * 快照与事件订阅在 App 里已经拉好，视图重渲染不产生新的后端请求。
 */
export interface ConsoleViewProps {
  desk: Desk;
  permission: PermissionMode;
  configured: boolean;
  /** 退回值台（桌面版） */
  onExit: () => void;
  onSend: (text: string) => void;
  /**
   * 控制台 `cd` 命令：空参数 = 选目录；`-` = 回默认工作区；`--none` = 这次不用工作区；
   * 其它按路径解析（相对路径基于当前根）。返回一句人话回执。
   */
  onCd?: (arg: string) => Promise<string>;
  onAbort: () => void;
  onOpenSettings: () => void;
  /** 底栏权限档（plan / ask / auto / full）：与值台同一个 RPC，控制台不另存一份状态 */
  onPermission: (mode: PermissionMode) => void;
  onDecisionResolve: (id: string, action: "answer" | "start" | "revise" | "reject", text?: string) => void;
  /**
   * 验收 / 打回（task.decide）。打回必须带三要素，后端会校验：
   * 哪里不合格 / 期望是什么 / 多久内重交。
   */
  onDecision: (
    taskId: string,
    action: "approve" | "reject",
    reason?: { what: string; expect: string; deadline: string },
  ) => void;
  onCancelTask: (taskId: string) => void;
  onDismissTask: (taskId: string) => void;
  /** 彻底删除这张单（连卷宗）：比 dismiss 更狠，只在锁定卡里给 */
  onRemoveTask: (taskId: string) => void;
  /** 解卡：给卡住的单授权一个只读目录（目录由用户在原生选择框里点选） */
  onGrantRead: (taskId: string) => void;
  /** 重开已归档的单：风铃代验可能判错，这是唯一的回退路 */
  onReopenTask: (taskId: string) => void;
  /** 清掉无主单（所属会话已删）：删会话级联只能管新数据，旧的无主单要有出口 */
  onPurgeOrphans?: () => void;
  /** 打开任务往来（详情抽屉） */
  onOpenTask?: (taskId: string) => void;
}
