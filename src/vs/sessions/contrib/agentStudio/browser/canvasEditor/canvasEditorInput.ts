/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Canvas Editor Input
 *
 *  EditorInput 用于在中栏文件编辑器打开 .canvas 思维导图。
 *  携带文件 URI 和已解析的 IMindmapData。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import type { EditorInputCapabilities } from '../../../../../workbench/common/editor.js';
import type { IMindmapData } from '../../common/mindmap/mindmapTypes.js';

export class CanvasEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.canvasEditor';

	override get typeId(): string {
		return CanvasEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return 'workbench.editor.agentStudio.canvasEditorPane';
	}

	override get capabilities(): EditorInputCapabilities {
		return 0; // editable, not readonly
	}

	private readonly _resource: URI;
	private _mindmapData: IMindmapData;

	constructor(resource: URI, mindmapData: IMindmapData) {
		super();
		this._resource = resource;
		this._mindmapData = mindmapData;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._resource.path.split('/').pop() || this._resource.path || 'mindmap.canvas';
	}

	get mindmapData(): IMindmapData {
		return this._mindmapData;
	}

	set mindmapData(data: IMindmapData) {
		this._mindmapData = data;
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof CanvasEditorInput) {
			return this._resource.toString() === other._resource.toString();
		}
		return false;
	}
}
