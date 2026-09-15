/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * [Saros] 工作区 folder 列表的**唯一写入者**（方案 B' Step 2）。
 *
 * ## 为什么需要它
 *
 * 2026-09-14 实测：`IWorkspaceEditingService.{add,update,remove}Folders` 在 sessions 侧
 * 有 **4 个独立调用者**在改同一份列表 ——
 *
 *   ① `agentStudio/browser/workspaceFolderSync.ts`（registry 驱动）
 *   ② `contrib/workspace/browser/workspaceFolderManagement.ts`（活动会话驱动）
 *   ③ `contrib/sourceControl/browser/sourceControl.contribution.ts`（SCM 多仓驱动）
 *   ④ `browser/parts/projectBarPart.ts`（项目栏点击驱动）
 *
 * 后果（全部实测过）：互相覆盖（用户手写 3 个 folder 只显示 1 个）、
 * 切会话/点项目栏会**回写用户的 `.code-workspace`**、
 * 以及 ②③ 各自重复发明「哪些 folder 是文件声明的」判断。
 *
 * ## 契约
 *
 * - **只有 router 能写** folder 列表。其余模块调用 `ensureFolders()` 表达
 *   「我需要这些 root 在场」，**不表达**「folder 列表应该等于这些」。
 * - `ensureFolders()` 语义是 **追加式合并**（`mergeWorkspaceFolders`：现有 folder 保位、
 *   缺失的 target 追加）—— 从语义上就不可能把多根裁成单根。
 * - 想**切换**工作区不要走这里：那是「打开工作区」（`IHostService.openWindow`），
 *   见 `projectBarPart`（用户 2026-09-14 裁决：复用当前窗口）。
 *
 * 不变量由 `test/browser/workspaceFolderWriters.test.ts` 用**源码级断言**钉住：
 * 任何新增的直接写入点会当场失败。
 */
export const IWorkspaceFolderRouter = createDecorator<IWorkspaceFolderRouter>('workspaceFolderRouter');

/** 一个待确保在场的 root。 */
export interface IFolderRequest {
	readonly uri: URI;
	readonly name: string;
}

export interface IWorkspaceFolderRouter {

	readonly _serviceBrand: undefined;

	/**
	 * 确保这些 root 出现在窗口的 folder 列表里（**追加式**，不删除既有 folder）。
	 *
	 * @param reason 调用方标识，只用于日志（排查"谁改了 folder"时的关键线索）。
	 * @returns 是否真的改动了 folder 列表（已在场则返回 false）。
	 */
	ensureFolders(folders: readonly IFolderRequest[], reason: string): Promise<boolean>;

	/**
	 * 移除**由本会话注入**的 root。
	 *
	 * ⚠ 只允许移除「不在工作区文件声明集里」的 folder —— 用户在 `.code-workspace` 里
	 * 手写的 folder **永不**被自动移除（那是用户资产，只能由用户自己删）。
	 */
	releaseFolders(uris: readonly URI[], reason: string): Promise<boolean>;
}
