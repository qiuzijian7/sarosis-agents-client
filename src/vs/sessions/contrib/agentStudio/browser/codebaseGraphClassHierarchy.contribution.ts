/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 类继承关系命令（对齐 Visual Assist X 的类浏览器，Alt+Shift+G）。
 *
 *  - 命令 `sarosis.classHierarchy.show`（默认快捷键 Alt+Shift+G）
 *  - 取编辑器光标处的单词作为根类，弹出模态对话框展示 INHERITS/IMPLEMENTS 双向继承树
 *  - 单击树中任意类节点即跳转到其定义（file:line）并关闭对话框
 *
 * UI 实现：browser/widgets/classHierarchyModal.ts
 * 数据源：ICodebaseGraphService.getClassHierarchy（Codebase 图谱继承边）
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize2 } from '../../../../nls.js';
import { ICodebaseGraphService } from './codebaseGraphService.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ClassHierarchyModal } from './widgets/classHierarchyModal.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ITextModel } from '../../../../editor/common/model.js';

registerAction2(class ShowClassHierarchyAction extends Action2 {
	constructor() {
		super({
			id: 'sarosis.classHierarchy.show',
			title: localize2('sarosis.classHierarchy.show', 'Show Class Hierarchy'),
			f1: true,
			category: localize2('sarosis.category', 'Saros'),
			keybinding: {
				primary: KeyMod.Alt | KeyMod.Shift | KeyCode.KeyG,
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
			logService.info('[CodebaseGraph]', 'Class Hierarchy requested but graph has no data yet');
			return;
		}

		// 取光标位置的单词作为根类
		let initialQuery: string | undefined;
		const editor = editorService.activeTextEditorControl as ICodeEditor | undefined;
		const model = editor?.getModel() as ITextModel | undefined;
		const pos = editor?.getPosition();
		if (model && pos) {
			const wordInfo = model.getWordAtPosition(pos);
			if (wordInfo) { initialQuery = wordInfo.word; }
		}

		instantiationService.createInstance(ClassHierarchyModal).open(initialQuery);
	}
});
