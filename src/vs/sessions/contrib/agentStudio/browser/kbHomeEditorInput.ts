/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';

/**
 * 知识库「主页」在**中间栏**打开的 EditorInput（★ 2026-11-02）。
 *
 * 为什么要有它：侧栏只能当作"入口"，库级总览（数据栏 + 库卡片 + 最近编辑）需要一整页宽度才读得清。
 * 与「关系图谱」（`KbGraphEditorInput`）同一个范式：中心 Tab、单例、只读。
 *
 * 只携带 `vaultId`：页面本体由 KB 插件的 `/x/kb/home` 渲染（数据在服务端现取，避免双份缓存）。
 */
export class KbHomeEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.kbHome';

	override get typeId(): string {
		return KbHomeEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return 'workbench.editor.agentStudio.kbHomePane';
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly;
	}

	private readonly _vaultId: string;

	constructor(vaultId: string) {
		super();
		this._vaultId = vaultId;
	}

	get vaultId(): string {
		return this._vaultId;
	}

	override get resource(): URI {
		// 合成 URI：用于 Tab 标识与匹配（非真实文件）
		return URI.from({ scheme: 'saros-kb-home', path: '/home' });
	}

	override getName(): string {
		return '知识库主页';
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		// 主页为单例：任意 KbHomeEditorInput 视为同一 Tab
		return other instanceof KbHomeEditorInput;
	}
}
