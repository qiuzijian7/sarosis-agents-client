/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput：**dsh 插件商城**页（编辑区页面，2026-10-14）。
 *
 * 为什么要有它：侧栏「插件中心」宽约 380px，只能放"策展推荐 + 手输 spec"；而 dsh 插件真正的**浏览**体验
 * （搜索 4500+ 条社区目录、按来源筛、看 ★/下载量）需要宽度 ⇒ 按仓库既有先例
 * （`AgentMarketEditorInput` / `PluginDetailEditorInput`）做成**编辑区页面**，由侧栏的按钮打开 ✓。
 *
 * 单例语义（`getInstance()` + `Singleton` capability）：重复点按钮只会聚焦同一个 tab，不会堆出 N 个商城页。
 */
export class DshPluginMarketEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.dshPluginMarketInput';

	private static _instance: DshPluginMarketEditorInput | undefined;

	static getInstance(): DshPluginMarketEditorInput {
		if (!DshPluginMarketEditorInput._instance || DshPluginMarketEditorInput._instance.isDisposed()) {
			DshPluginMarketEditorInput._instance = new DshPluginMarketEditorInput();
		}
		return DshPluginMarketEditorInput._instance;
	}

	override get typeId(): string {
		return DshPluginMarketEditorInput.TypeID;
	}

	override get editorId(): string {
		// ⚠ 写字符串字面量（与 `DshPluginMarketEditorPane.ID` 同值），避免 input ↔ pane 互相 import 成环。
		return 'workbench.editor.dshPluginMarket';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'dsh-plugin-market',
			path: '/market',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/**
	 * tab 标题。**不加 emoji**：本仓几个页面（Agent 商城 🛒 / 插件详情 📦）各自带一个，风格已经不统一，
	 * 而设计稿里给的建议正是"把 emoji 换成 SVG 图标"⇒ 新页面先从标题里不带 emoji 开始 ✓。
	 */
	override getName(): string {
		return 'dsh 插件商城';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof DshPluginMarketEditorInput;
	}
}
