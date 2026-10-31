/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「系统与更新」面板的 EditorInput（2026-10-30）。
 *
 * 背景（用户："IDE中，点开面板，手动点击检查升级"）：升级状态本来只有 dsh 页面那边能看
 * （desktop 窗口左下角那行 + 它的面板）。IDE 侧此前只有 VS Code 自带的「检查更新…」——
 * 那条走的是**原生更新服务**（只会下载安装包，看不到随包插件 / 商城资产）。
 *
 * 现在：VsSaros 菜单的「检查更新…」打开本输入对应的面板，四段数据与 desktop 完全同源
 * （`IDshHarnessService.getUpgradeState()`），检查也**只由用户点**（打开面板不联网）。
 *
 * 单例口径：全局一个（`getOrCreate`）—— 重复点菜单不会开出一堆 tab ✓。
 */

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

export class DshUpgradeEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.dshUpgrade';

	private static _instance: DshUpgradeEditorInput | undefined;

	/** 单例（已打开就复用，不新开 tab）。 */
	static getOrCreate(): DshUpgradeEditorInput {
		if (!DshUpgradeEditorInput._instance || DshUpgradeEditorInput._instance.isDisposed()) {
			DshUpgradeEditorInput._instance = new DshUpgradeEditorInput();
		}
		return DshUpgradeEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return DshUpgradeEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return DshUpgradeEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// 只读（面板只发起动作，不承载"保存"语义）+ 单例（与 getOrCreate 同口径）
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '系统与更新';
	}

	override get resource(): URI {
		return URI.from({ scheme: 'dsh-upgrade', path: '/state' });
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof DshUpgradeEditorInput;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: DshUpgradeEditorInput.ID, pinned: true },
		};
	}

	override dispose(): void {
		if (DshUpgradeEditorInput._instance === this) {
			DshUpgradeEditorInput._instance = undefined;
		}
		super.dispose();
	}
}
