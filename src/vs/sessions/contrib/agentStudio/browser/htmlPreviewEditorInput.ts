/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

/**
 * EditorInput for rendering a self-contained HTML file (e.g. ConfigMD's
 * `.preview.html`) inside the workbench editor area.
 *
 * Why a custom input?
 *   The standard `WebviewInput` route (used by simple-browser, markdown
 *   preview, etc.) relies on `IOverlayWebview`, which positions the
 *   webview iframe via CSS anchor-positioning. On this fork's Chromium
 *   build that path renders an empty pane. Our own input + pane uses the
 *   same `createWebviewElement` + `mountTo(container)` model that the
 *   chat panel already uses successfully — i.e. a regular DOM-mounted
 *   iframe with no anchor-positioning involvement.
 *
 * Carrying context (agentId / workspaceId / agentSessionId):
 *   When the preview is opened from ConfigMD's "preview" button we know
 *   exactly which agent owns it AND which Fork session is active in the
 *   chat panel at that moment. We pass all three through the input so:
 *     - the pane can route SDK postMessages back to ConfigHtmlService
 *       without having to reverse-engineer the file path;
 *     - imgui form submits land in the SAME Fork session the user was
 *       looking at when they opened the preview, even if they later
 *       switch the chat panel to a different agent or session;
 *     - multiple parallel Forks for the same agent can each open their
 *       own preview without cross-talk.
 *   When opened generically (e.g. directly clicking a `.html` file),
 *   these fields are left undefined and the pane falls back to path-
 *   based resolution / current-active-session registry lookup.
 */
export class HtmlPreviewEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.htmlPreview';

	override get typeId(): string {
		return HtmlPreviewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return HtmlPreviewEditorInput.ID;
	}

	private readonly _resource: URI;
	private _title: string;
	private readonly _agentId: string | undefined;
	private readonly _workspaceId: string | undefined;
	private readonly _workspaceSessionId: string | undefined;
	private readonly _agentSessionId: string | undefined;

	constructor(
		resource: URI,
		title: string,
		agentId?: string,
		workspaceId?: string,
		workspaceSessionId?: string,
		agentSessionId?: string,
	) {
		super();
		this._resource = resource;
		this._title = title;
		this._agentId = agentId;
		this._workspaceId = workspaceId;
		this._workspaceSessionId = workspaceSessionId;
		this._agentSessionId = agentSessionId;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._title;
	}

	/**
	 * Update the tab title at runtime (e.g. once the owning agent's display
	 * name has been resolved asynchronously). Fires {@link onDidChangeLabel}
	 * so the editor tab refreshes.
	 */
	setName(name: string): void {
		if (this._title === name) {
			return;
		}
		this._title = name;
		this._onDidChangeLabel.fire();
	}

	get agentId(): string | undefined {
		return this._agentId;
	}

	get workspaceId(): string | undefined {
		return this._workspaceId;
	}

	get workspaceSessionId(): string | undefined {
		return this._workspaceSessionId;
	}

	get agentSessionId(): string | undefined {
		return this._agentSessionId;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this._resource,
			options: { override: HtmlPreviewEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof HtmlPreviewEditorInput) {
			// Match by URL only (we treat the same `.preview.html` resource
			// as the same input regardless of the captured workspace/session
			// context — otherwise re-opening with a freshly-active session
			// would spawn a duplicate editor tab).
			return this._resource.toString() === other._resource.toString();
		}
		return false;
	}
}

