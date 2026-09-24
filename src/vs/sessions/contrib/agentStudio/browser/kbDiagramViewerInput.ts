/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbDiagramViewerInput.ts — 图表文件（.drawio / .mermaid / .mmd）的编辑器输入。
 *  与 KbDiagramViewerPane 配对（editorId 必须一致，否则 resolver 找不到面板会回退纯文本）。
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { URI } from '../../../../base/common/uri.js';

export type KbDiagramKind = 'mermaid' | 'drawio';

export function diagramKindOfPath(path: string): KbDiagramKind | undefined {
	const lower = path.toLowerCase();
	if (lower.endsWith('.mermaid') || lower.endsWith('.mmd')) { return 'mermaid'; }
	if (lower.endsWith('.drawio')) { return 'drawio'; }
	return undefined;
}

export class KbDiagramViewerInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.kbDiagramViewer';

	override get typeId(): string {
		return KbDiagramViewerInput.ID;
	}

	override get editorId(): string | undefined {
		return KbDiagramViewerInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return 0; // 源码可编辑（预览 + 源码双模式）
	}

	constructor(readonly resource: URI) {
		super();
	}

	get kind(): KbDiagramKind {
		return diagramKindOfPath(this.resource.path) ?? 'drawio';
	}

	override getName(): string {
		return this.resource.path.split('/').pop() || this.resource.path;
	}

	override matches(other: unknown): boolean {
		return other instanceof KbDiagramViewerInput
			&& other.resource.toString() === this.resource.toString();
	}
}
