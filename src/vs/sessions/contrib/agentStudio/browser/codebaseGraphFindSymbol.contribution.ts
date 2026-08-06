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
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize2 } from '../../../../nls.js';
import { ICodebaseGraphService } from './codebaseGraphService.js';
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
			category: localize2('sarosis.category', 'Sarosis'),
			keybinding: {
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyS,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const graphService = accessor.get(ICodebaseGraphService);
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const logService = accessor.get(ILogService);

		if (!graphService.hasGraphData()) {
			logService.info('[CodebaseGraph]', 'Find Symbol requested but graph has no data yet');
			return;
		}

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
