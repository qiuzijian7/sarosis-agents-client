/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, GroupIdentifier } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * Runtime state snapshot for a chat tab.
 *
 * VS Code reuses a single EditorPane instance for same-editorId tabs and
 * switches content via `setInput()`. This means the panel's in-memory state
 * (messages, streaming phase, sending flag) belongs to the **pane**, not the
 * chat. When the user switches tabs, we must save the current chat's runtime
 * state onto its input and restore the target chat's state from its input.
 *
 * Without this, switching tabs during streaming would show stale messages
 * or lose the "thinking..." indicator.
 */
export interface IChatRuntimeState {
	/** Current messages array (live, including streaming placeholder). */
	messages: unknown[];
	/** Stream phase ('llm_streaming' | 'tool_executing' | 'idle' | ...). */
	streamPhase: string;
	/** Whether a send is in progress. */
	isSending: boolean;
	/** Whether agent has been loaded for this chat. */
	agentLoaded: boolean;
}

/**
 * Chat tab status indicator state — drives the status dot rendered on the
 * editor tab label via {@link NativeChatEditorInput.getLabelExtraClasses}.
 *
 *  - `running`: execution in progress (green, animated pulse)
 *  - `error`:   execution failed (red)
 *  - `pending`: execution finished but user has not viewed the tab (white)
 *  - `idle`:    no notable status (no dot shown)
 *
 * Transition rules:
 *  - running/error are set live as deltas arrive.
 *  - When a run completes (idle phase) while the tab is NOT active → pending.
 *  - When the user activates the tab (focus) → pending clears to idle.
 */
export type ChatTabStatus = 'running' | 'error' | 'pending' | 'idle';

/**
 * EditorInput for the native (DOM-based) Agent Chat pane.
 *
 * Each chat window gets its own `NativeChatEditorInput` instance with a unique
 * URI (`native-chat://chat/<id>`), so VS Code opens it as a separate editor tab.
 * The `chatId` is used for `matches()` comparison, allowing multiple chat tabs
 * to coexist in the editor area.
 *
 * The tab label is dynamically updated to reflect the selected agent name via
 * {@link setAgentName}. The pane calls this whenever the agent changes.
 */
export class NativeChatEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.nativeChatInput';
	static readonly EditorID = 'workbench.editor.nativeChat';

	private static _instance: NativeChatEditorInput | undefined;

	/** Legacy singleton accessor — returns the default chat instance. */
	static getInstance(): NativeChatEditorInput {
		if (!NativeChatEditorInput._instance || NativeChatEditorInput._instance.isDisposed()) {
			NativeChatEditorInput._instance = NativeChatEditorInput.create('default');
		}
		return NativeChatEditorInput._instance;
	}

	/**
	 * Create a new chat editor input with a unique chatId.
	 * Each call produces a distinct URI, so VS Code treats it as a new editor tab.
	 * @param chatId Unique chat tab ID (auto-generated if omitted)
	 * @param agentId Optional agent ID to pre-select for this chat tab
	 * @param sessionId Optional session ID to restore (from history or persistence)
	 * @param name Optional tab label to restore (from persistence)
	 */
	static create(chatId?: string, agentId?: string, sessionId?: string, name?: string): NativeChatEditorInput {
		const id = chatId ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		return new NativeChatEditorInput(id, agentId, sessionId, name);
	}

	private readonly _chatId: string;
	private _agentId: string | undefined;
	private _sessionId: string | undefined;
	private readonly _resource: URI;
	/** Dynamic tab label — set by the pane when agent changes. */
	private _name: string = 'Agent Chat';
	/**
	 * Runtime state snapshot — saved by the pane on tab switch (setInput),
	 * restored when switching back. Not serialized (transient).
	 */
	private _runtimeState: IChatRuntimeState | undefined;
	/**
	 * Tab status indicator state. Drives the status dot on the editor tab
	 * label via {@link getLabelExtraClasses}. Updated by the pane as the
	 * stream phase / sending flag changes. Survives tab switches because
	 * the input instance is retained per chat.
	 */
	private _tabStatus: ChatTabStatus = 'idle';

	constructor(chatId: string = 'default', agentId?: string, sessionId?: string, name?: string) {
		super();
		this._chatId = chatId;
		this._agentId = agentId;
		this._sessionId = sessionId;
		this._name = name ?? 'Agent Chat';
		this._resource = URI.from({
			scheme: 'native-chat',
			path: `/${chatId}`,
		});
	}

	/** Unique chat ID for this editor input. */
	get chatId(): string {
		return this._chatId;
	}

	/** Pre-selected agent ID for this chat tab (optional, written back on agent change). */
	get agentId(): string | undefined {
		return this._agentId;
	}

	/** Pre-existing session ID to restore (optional). */
	get sessionId(): string | undefined {
		return this._sessionId;
	}

	/** Current tab label (agent name). */
	get name(): string {
		return this._name;
	}

	/**
	 * Update the tab label and persist agent info to this input.
	 * Called by NativeChatEditorPane when the selected agent changes.
	 * Fires {@link EditorInput.onDidChangeLabel} so VS Code updates the tab.
	 *
	 * Agent info is written to the input so that when the tab is dragged to a
	 * new group (creating a new EditorPane), setInput can restore the agent
	 * from the input's persisted state.
	 *
	 * @param agentName Agent display name (becomes tab label)
	 * @param agentId Agent ID
	 * @param sessionId Optional session ID to persist (for drag-to-new-group restore)
	 */
	setAgentInfo(agentName: string, agentId: string, sessionId?: string): void {
		let changed = false;
		if (this._name !== agentName) {
			this._name = agentName;
			changed = true;
		}
		if (this._agentId !== agentId) {
			this._agentId = agentId;
			changed = true;
		}
		if (sessionId !== undefined && this._sessionId !== sessionId) {
			this._sessionId = sessionId;
			changed = true;
		}
		if (changed) {
			(this as any)._onDidChangeLabel.fire();
		}
	}

	/**
	 * Update the tab status indicator. Fires {@link EditorInput.onDidChangeLabel}
	 * so VS Code redraws the tab label (re-applying extra classes) — which in
	 * turn re-evaluates {@link getLabelExtraClasses} and the CSS status dot.
	 *
	 * @param status New tab status. No-op if unchanged.
	 */
	setTabStatus(status: ChatTabStatus): void {
		if (this._tabStatus === status) {
			return;
		}
		this._tabStatus = status;
		(this as any)._onDidChangeLabel.fire();
	}

	/** Current tab status indicator state. */
	getTabStatus(): ChatTabStatus {
		return this._tabStatus;
	}

	override get typeId(): string {
		return NativeChatEditorInput.TypeID;
	}

	override get editorId(): string {
		return NativeChatEditorInput.EditorID;
	}

	override get resource(): URI | undefined {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return this._name;
	}

	/**
	 * Injects status-indicator CSS classes onto the editor tab label element.
	 *
	 * VS Code's `MultiEditorTabsControl.redrawTabLabel` calls this method and
	 * applies the returned classes to the `.tab-label` container. A CSS
	 * `::before` pseudo-element on `.chat-tab-status-*` renders the colored
	 * status dot (green=running, red=error, white=pending, none=idle).
	 */
	override getLabelExtraClasses(): string[] {
		const classes = ['chat-tab-status'];
		if (this._tabStatus !== 'idle') {
			classes.push(`chat-tab-status-${this._tabStatus}`);
		}
		return classes;
	}

	override getDescription(): string | undefined {
		return undefined;
	}

	override canMove(_sourceGroup: GroupIdentifier, _targetGroup: GroupIdentifier): true | string {
		return true;
	}

	/**
	 * Save runtime state onto this input. Called by the pane when switching
	 * away from this chat tab (before setInput loads the new chat).
	 */
	saveRuntimeState(state: IChatRuntimeState): void {
		this._runtimeState = state;
	}

	/**
	 * Retrieve previously saved runtime state. Called by the pane when
	 * switching TO this chat tab — if state exists, the pane restores
	 * messages + streaming phase directly without a server round-trip.
	 *
	 * @returns The saved state, or undefined if this chat was never active.
	 */
	getRuntimeState(): IChatRuntimeState | undefined {
		return this._runtimeState;
	}

	/**
	 * Clear runtime state (e.g. after the state has been consumed by the pane).
	 */
	clearRuntimeState(): void {
		this._runtimeState = undefined;
	}

	/**
	 * Two inputs match only if they are both NativeChatEditorInput AND share the same chatId.
	 * This allows multiple chat tabs to coexist (different chatId → different tab).
	 */
	override matches(otherInput: EditorInput | unknown): boolean {
		if (otherInput instanceof NativeChatEditorInput) {
			return otherInput._chatId === this._chatId;
		}
		return false;
	}
}
