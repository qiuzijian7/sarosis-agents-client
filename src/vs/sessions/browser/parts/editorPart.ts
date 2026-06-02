/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { MainEditorPart as MainEditorPartBase } from '../../../workbench/browser/parts/editor/editorPart.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';

/**
 * [Sarosis] File-zone editor part.
 *
 * After the path-A refactor the editor area is split into two *physically
 * independent* EditorPart instances:
 *   - `MainEditorPart` (this class) → File zone, registered as
 *     `Parts.EDITOR_PART`. Regular file editors live here.
 *   - `AgentEditorPart` → Agent Studio zone, registered as
 *     `Parts.AGENT_EDITOR_PART`. Canvas / Chat live there.
 *
 * This class is therefore a plain single-grid editor part (the upstream
 * default). It only customises `layout()` to drop the left margin when a
 * sidebar / chat bar is present, matching the sessions grid metrics.
 */
export class MainEditorPart extends MainEditorPartBase {
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_LEFT = 10;
	static readonly MARGIN_BOTTOM = 0;

	/**
	 * Height reserved for the workspace toolbar that overlays the area
	 * above the agent editor part. Consumed by workbench.ts when it
	 * positions the floating WorkspaceToolbar; kept here so both parts
	 * agree on the reserved band height.
	 */
	static readonly TOOLBAR_HEIGHT = 32;

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
			return;
		}

		const adjustedMargin = this.layoutService.isVisible(Parts.SIDEBAR_PART) ||
			this.layoutService.isVisible(Parts.CHATBAR_PART)
			? 0
			: MainEditorPart.MARGIN_LEFT;
		const adjustedWidth = width - adjustedMargin - 2 /* border width */;
		const adjustedHeight = height - MainEditorPart.MARGIN_TOP - MainEditorPart.MARGIN_BOTTOM - 2 /* border width */;

		super.layout(adjustedWidth, adjustedHeight, top, left);
	}
}
