/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

export class MemoryDetailEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.memoryDetail';

	override get typeId(): string {
		return MemoryDetailEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return MemoryDetailEditorInput.ID;
	}

	private static _instances = new Map<string, MemoryDetailEditorInput>();

	static getOrCreate(agentId: string): MemoryDetailEditorInput {
		let inst = MemoryDetailEditorInput._instances.get(agentId);
		if (!inst || inst.isDisposed()) {
			inst = new MemoryDetailEditorInput(agentId);
			MemoryDetailEditorInput._instances.set(agentId, inst);
		}
		return inst;
	}

	private readonly _agentId: string;
	/** 目标记忆 ID（点击系统栏条目时设置，用于滚动定位） */
	public targetMemoryId: string | null = null;
	/** 目标层级过滤（点击系统栏条目时设置，如 working/episodic） */
	public targetLayer: string | null = null;
	/** 是否从 Agent 聊天框跳转而来（true → 默认仅显示当前 agent 数据，false → 默认显示全部 agent） */
	public fromAgentChat: boolean = false;

	constructor(agentId?: string) {
		super();
		this._agentId = agentId ?? 'default';
	}

	get agentId(): string {
		return this._agentId;
	}

	override get resource(): URI {
		return URI.parse(`agent-studio://memory-detail/${this._agentId}`);
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '记忆详情';
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: MemoryDetailEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof MemoryDetailEditorInput) {
			return this._agentId === other._agentId;
		}
		return false;
	}

	override dispose(): void {
		MemoryDetailEditorInput._instances.delete(this._agentId);
		super.dispose();
	}
}
