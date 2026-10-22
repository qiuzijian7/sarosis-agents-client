/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ⚠ 2026-10-22 还原件：原文件（未入库）在 2026-10-21 23:08 被本地 `align-workspace.ps1` 的 `git clean -fd` 删除，
//   本地历史与 agent 快照里都没有它（当初是用终端命令写的）。本文件按 `out/` 里重置前的编译产物
//   （`out/vs/sessions/contrib/agentStudio/browser/middleColumnChatEntry.js`）逐行还原：逻辑与产物一致，
//   原文件头部约 28 行的说明注释**未能还原**。
//
// 作用：给每个编辑器组维护**组作用域** context key `EditorGroupInMainPartContext`
//（该组是否在 main part，即中间栏）⇒ 中间栏专属的入口（如"在中间栏开聊天"）可以用 when 子句只在中间栏出现。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorGroupInMainPartContext } from '../../../common/contextkeys.js';

export class MiddleColumnChatEntryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentStudio.middleColumnChatEntry';

	constructor(@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService) {
		super();
		// 新组出现即打标
		this._register(this._editorGroupsService.onDidAddGroup(group => this._mark(group)));
		// 组在 part 之间移动（拖出/拖回中间栏）后，激活组变化时整体重打一遍
		this._register(this._editorGroupsService.onDidChangeActiveGroup(() => this._markAll()));
		this._markAll();
	}

	/** 给**所有**组打标（组作用域 key）。 */
	private _markAll(): void {
		for (const part of this._editorGroupsService.parts) {
			for (const group of part.groups) {
				this._mark(group);
			}
		}
	}

	/** 给一个组打标：它在 main part（中间栏）里吗？ */
	private _mark(group: IEditorGroup): void {
		const part = this._editorGroupsService.getPart(group);
		const mainPart = this._editorGroupsService.mainPart;
		const inMainPart = !!part && !!mainPart && part === mainPart;
		group.scopedContextKeyService.createKey(EditorGroupInMainPartContext.key, inMainPart);
	}
}

registerWorkbenchContribution2(MiddleColumnChatEntryContribution.ID, MiddleColumnChatEntryContribution, WorkbenchPhase.AfterRestored);
