/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for a **single node's editor** opened in its own tab
 * （2026-09-13，P2：节点内编辑器 → 独立 editor tab）。
 *
 * 与 `WorkflowEditorInput` 的关系：那个承载「一整个工作流」（画布 + 工具栏），
 * 本 Input 承载「工作流里的某一个节点的编辑器」。两者是**不同的 resource**，
 * 因此可以同时打开（画布 tab + 节点编辑器 tab 并排）—— 这正是 P2 的价值。
 *
 * ★ resource 唯一性决定 tab 去重语义：`saros-workflow-node:/{workflowId}/{nodeId}`
 *   → 同一节点重复点「独立窗口」只会聚焦已有 tab（不会开一堆）；不同节点各一个 tab。
 *
 * ★ 承载方式：Pane 内**复用** `panelType='workflow-editor'` 的 webview（同一套 React
 *   App），仅通过 `initialData.focusNodeId` 告知「加载完成后自动打开该节点的全屏
 *   编辑器」→ 零新增编辑器装配代码（store / 快照库 / runner 全部现成）。
 */
export class WorkflowNodeEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.workflowNode';

	override get typeId(): string {
		return WorkflowNodeEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return 'workbench.editor.agentStudio.workflowNodePane';
	}

	override get capabilities(): EditorInputCapabilities {
		return 0; // Non-singleton, mutable —— 每个 (workflowId, nodeId) 一个 tab
	}

	constructor(
		readonly workflowId: string,
		readonly nodeId: string,
		/** 节点类型（仅用于 tab 标题展示，真实类型以加载后的节点数据为准）。 */
		readonly nodeType: string | undefined,
		/** 编辑器标题（来自 `stageEditorDescriptor().title`，如「导演台」）。 */
		readonly editorTitle: string,
		readonly workflowName: string | undefined,
	) {
		super();
	}

	override get resource(): URI {
		return URI.from({ scheme: 'saros-workflow-node', path: `/${this.workflowId}/${this.nodeId}` });
	}

	override getName(): string {
		const title = this.editorTitle || this.nodeType || '节点编辑器';
		return this.workflowName ? `${title} · ${this.workflowName}` : title;
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof WorkflowNodeEditorInput) {
			return this.workflowId === other.workflowId && this.nodeId === other.nodeId;
		}
		return false;
	}
}
