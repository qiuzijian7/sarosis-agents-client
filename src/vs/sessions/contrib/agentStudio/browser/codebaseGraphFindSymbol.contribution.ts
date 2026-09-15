/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 基于 Codebase 图谱的符号搜索命令（对齐 Visual Assist X 的 Find Symbol in Solution，Shift+Alt+S）。
 *
 *  - 命令 `sarosis.findGraphSymbol`（默认快捷键 Shift+Alt+S）
 *  - 打开类 VS 的模态对话框：标题（Find Symbol）+ 双列表格（Symbol | Definition）
 *  + 搜索框（防抖 150ms）+ 复选框（Show only current solution / Only classes, structs & namespaces）
 *  + OK/Cancel 按钮（参考 VS Find Symbol 对话框 UI）
 *  - Enter 跳转定义（file:line），↑↓ 移动选择，Esc 关闭
 *
 * UI 实现：browser/widgets/findSymbolModal.ts
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../nls.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { FindSymbolModal } from './widgets/findSymbolModal.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ITextModel } from '../../../../editor/common/model.js';

registerAction2(class FindGraphSymbolAction extends Action2 {
	constructor() {
		super({
			id: 'sarosis.findGraphSymbol',
			title: localize2('sarosis.findGraphSymbol', 'Find Symbol in Codebase'),
			f1: true,
			category: localize2('sarosis.category', 'Saros'),
			keybinding: {
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyS,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// 2026-09-15（用户要求）：**不再以 `hasGraphData()` 为前提**。
		// 旧实现无图时静默 return（只打一条 info 日志）⇒ 用户按 Alt+Shift+S 完全没反应。
		// 现在无条件打开模态；「无图则自动建图 + 在 UI 内显示进度/失败原因」由 FindSymbolModal
		// 内的 `ensureGraphForUi()` 负责（见 widgets/codebaseGraphAutoBuild.ts）。
		// 自动填充光标位置的单词
		let initialQuery: string | undefined;
		const editor = editorService.activeTextEditorControl as ICodeEditor | undefined;
		const model = editor?.getModel() as ITextModel | undefined;
		const pos = editor?.getPosition();
		if (model && pos) {
			const wordInfo = model.getWordAtPosition(pos);
			if (wordInfo) { initialQuery = wordInfo.word; }
		}

		instantiationService.createInstance(FindSymbolModal).open(initialQuery);
	}
});
