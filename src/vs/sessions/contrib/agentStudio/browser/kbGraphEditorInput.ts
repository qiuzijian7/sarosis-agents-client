/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IGraphNode, IGraphLink } from './views/knowledgeBase/kbGraphView.js';
import { IKbGraphRoot } from './views/knowledgeBase/kbGraph.js';

/**
 * EditorInput 用于在中栏文件编辑器打开知识库「关系图谱」。
 *
 * 携带已构建好的力导向图数据（节点 / 边），由 KnowledgeBaseGraphEditorPane
 * 挂载 KbGraphView 渲染。对齐 SiYuan 的「图谱作为中心 Tab」范式
 * （openGraph → wnd.split("lr").addTab(new Tab(...))）。
 */
export class KbGraphEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.kbGraph';

	override get typeId(): string {
		return KbGraphEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return 'workbench.editor.agentStudio.kbGraphPane';
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly;
	}

	private readonly _nodes: IGraphNode[];
	private readonly _links: IGraphLink[];
	private readonly _roots?: IKbGraphRoot[];
	private _title: string;

	constructor(nodes: IGraphNode[], links: IGraphLink[], title = '关系图谱', roots?: IKbGraphRoot[]) {
		super();
		this._nodes = nodes;
		this._links = links;
		this._roots = roots;
		this._title = title;
	}

	get nodes(): IGraphNode[] {
		return this._nodes;
	}

	get links(): IGraphLink[] {
		return this._links;
	}

	/** 知识库分区根目录（库 + 笔记）。供「构建图谱」按钮重新扫描时复用。 */
	get roots(): IKbGraphRoot[] | undefined {
		return this._roots;
	}

	override get resource(): URI {
		// 合成 URI：用于 Tab 标识与匹配（非真实文件）
		return URI.from({ scheme: 'saros-kb-graph', path: '/' + this._title });
	}

	override getName(): string {
		return this._title;
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		// 关系图谱为单例：任意 KbGraphEditorInput 视为同一 Tab
		return other instanceof KbGraphEditorInput;
	}
}
