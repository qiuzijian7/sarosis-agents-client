/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - postMessage RPC Client
 *
 *  Provides a typed, Promise-based wrapper around VS Code's postMessage API.
 *  Handles request/response matching, timeouts, and batching.
 *--------------------------------------------------------------------------------------------*/

// Mirror of RequestType from the host messageProtocol (kept in sync manually)
export type RequestType =
	| 'workspace.list'
	| 'workspace.get'
	| 'workspace.create'
	| 'workspace.createWithWorktree'
	| 'workspace.assignWorktree'
	| 'workspace.resetWorktree'
	| 'workspace.removeWorktree'
	| 'workspace.delete'
	| 'workspace.update'
	| 'workspace.updateLayout'
	| 'workspace.connections.list'
	| 'workspace.connections.add'
	| 'workspace.connections.remove'
	| 'chat.send'
	| 'chat.history'
	| 'chat.append'              // v6: webview commits a synthesized message (e.g. wf_run_* with subAgents) to host
	| 'chat.clear'
	| 'chat.cancel'
	| 'delegation.list'
	| 'delegation.get'
	| 'delegation.create'
	| 'delegation.update'
	| 'delegation.delete'
	| 'delegation.autoPlan'
	| 'taskBoard.list'
	| 'taskBoard.create'
	| 'taskBoard.update'
	| 'taskBoard.delete'
	| 'taskBoard.archive'
	| 'taskBoard.openOverview'
	| 'board.list'
	| 'board.create'
	| 'board.rename'
	| 'board.delete'
	| 'attachment.add'
	| 'attachment.remove'
	| 'attachment.read'
	| 'session.list'
	| 'session.get'
	| 'session.create'
	| 'session.delete'
	| 'providers.list'
	| 'providers.select'
	| 'providers.getSelection'
	| 'providers.getSelectionForAgent'
	| 'providers.openSettings'
	| 'workspaceSession.list'
	| 'workspaceSession.get'
	| 'workspaceSession.create'
	| 'workspaceSession.delete'
	| 'workspaceSession.archive'
	| 'workspaceSession.switch'
	| 'workspaceSession.switchRoot'
	| 'workspaceSession.updateStatus'
	| 'agentSession.list'
	| 'agentSession.create'
	| 'agentSession.rename'
	| 'agentSession.delete'
	| 'agentSession.getActive'
	| 'orchestration.plan'
	| 'orchestration.approve'
	| 'orchestration.reject'
	| 'orchestration.getPlan'
	| 'orchestration.listPlans'
	| 'orchestration.taskAction'
	| 'triage.specify'
	| 'triage.decompose'
	| 'diagnostics.run'
	| 'diagnostics.list'
	| 'diagnostics.dismiss'
	| 'swarm.create'
	| 'swarm.status'
	| 'swarm.list'
	| 'swarm.blackboard'
	| 'swarm.cancel'
	| 'confightml.event'
	| 'confightml.getHtml'
	| 'confightml.writeHtml'
	| 'confightml.chatSend'
	| 'confightml.notify'
	| 'confightml.previewToFile'
	| 'confightml.htmlGenerate'
	| 'files.open'
	| 'files.openHtmlPreview'
	| 'files.openUntitledText'
	| 'files.applyCode'
	| 'chat.jumpToCheckpoint'
	| 'chat.openCheckpointDiff'
	| 'chat.listCheckpoints'
	| 'chat.revertAllCheckpoints'
	| 'chat.keepAllCheckpoints'
	| 'chat.openAllCheckpointsDiff'
	| 'chat.toolApprove'
	| 'worktree.list'
	| 'agent.worktree.switch'
	| 'memory.listL0'
	| 'memory.listL1'
	| 'memory.deleteL0'
	| 'memory.deleteL1'
	| 'skills.list'
	| 'chat.activeSessionChanged'
	| 'workflow.save'
	| 'workflow.execute'
	| 'workflow.pause'
	| 'workflow.resume'
	| 'workflow.cancel'
	| 'workflow.breakpoint.set'
	| 'workflow.breakpoint.clear'
	| 'workflow.breakpoint.get'
	| 'workflow.list'
	| 'workflow.reorder'
	| 'workflow.open'
	| 'workflow.submitVariables'
	| 'agents.list'
	| 'agents.create'
	| 'agents.update'
	| 'agents.delete'
	| 'agents.export'
	| 'agents.import'
	| 'agents.selected'
	| 'agents.getLastSelected'
	| 'agents.openSettings'
	| 'orchestration.approveWithoutExecute'
	| 'orchestration.approveTask'
	| 'orchestration.rejectTask'
	| 'orchestration.commentTask'
	| 'orchestration.blockTask'
	| 'orchestration.unblockTask'
	| 'orchestration.updatePlan'
	| 'orchestration.updateTask'
	| 'orchestration.decomposeTask'
	| 'workspace.getActive'
	| 'workspace.setActive';

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT = 30_000; // 30s timeout for requests
let requestIdCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();

// Acquire VS Code API (available in webview context)
const vscode = acquireVsCodeApi();

/**
 * Send a request to the Host and wait for a response.
 *
 * Pass `timeout = 0` to disable the timeout entirely (useful for long-running
 * streamed operations such as `chat.send`, where the actual user-visible result
 * arrives via `chat.stream.*` events; cancellation should be done explicitly
 * via a paired cancel request like `chat.cancel`).
 */
export function sendRequest<TPayload = unknown, TResponse = unknown>(
	type: RequestType,
	payload: TPayload,
	timeout: number = DEFAULT_TIMEOUT,
): Promise<TResponse> {
	return new Promise<TResponse>((resolve, reject) => {
		const id = `req_${++requestIdCounter}_${Date.now()}`;

		const timer: ReturnType<typeof setTimeout> | undefined = timeout > 0
			? setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error(`Request ${type} timed out after ${timeout}ms`));
			}, timeout)
			: undefined;

		pendingRequests.set(id, {
			resolve: resolve as (data: unknown) => void,
			reject,
			timer,
		});

		vscode.postMessage({
			id,
			direction: 'toHost',
			type,
			payload,
		});
	});
}

/**
 * Handle incoming messages from the Host.
 * Call this once during initialization.
 */
export function initMessageClient(onEvent: (type: string, data: unknown) => void): void {
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || !message.direction) {
			return;
		}

		if (message.direction === 'toWebview') {
			// Check if this is a response to a pending request
			if (message.id && message.type?.endsWith('.response')) {
				const pending = pendingRequests.get(message.id);
				if (pending) {
					pendingRequests.delete(message.id);
					if (pending.timer) {
						clearTimeout(pending.timer);
					}

					if (message.error) {
						pending.reject(new Error(message.error.message || 'Unknown error'));
					} else {
						pending.resolve(message.data);
					}
					return;
				}
			}

			// Otherwise it's an event (unsolicited push from Host)
			// Log stream-related events for debugging

			onEvent(message.type, message.data);
		}
	});
}

/**
 * Post a fire-and-forget message (no response expected).
 */
export function postMessage(type: string, payload: unknown): void {
	vscode.postMessage({
		direction: 'toHost',
		type,
		payload,
	});
}

/**
 * Save/restore webview state (survives hide/show cycles).
 */
export function getState<T>(): T | undefined {
	return vscode.getState() as T | undefined;
}

export function setState<T>(state: T): void {
	vscode.setState(state);
}
