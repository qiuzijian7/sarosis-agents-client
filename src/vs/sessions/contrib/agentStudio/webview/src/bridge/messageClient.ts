/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - postMessage RPC Client
 *
 *  Provides a typed, Promise-based wrapper around VS Code's postMessage API.
 *  Handles request/response matching, timeouts, and batching.
 *--------------------------------------------------------------------------------------------*/

// Mirror of RequestType from the host messageProtocol (kept in sync manually)
export type RequestType =
	| 'employees.list'
	| 'employees.get'
	| 'employees.create'
	| 'employees.update'
	| 'employees.delete'
	| 'employees.selected'
	| 'workspace.list'
	| 'workspace.get'
	| 'workspace.create'
	| 'workspace.delete'
	| 'workspace.update'
	| 'workspace.updateLayout'
	| 'workspace.connections.list'
	| 'workspace.connections.add'
	| 'workspace.connections.remove'
	| 'chat.send'
	| 'chat.history'
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
	| 'session.list'
	| 'session.get'
	| 'session.create'
	| 'session.delete';

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT = 30_000; // 30s timeout for requests
let requestIdCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();

// Acquire VS Code API (available in webview context)
const vscode = acquireVsCodeApi();

/**
 * Send a request to the Host and wait for a response.
 */
export function sendRequest<TPayload = unknown, TResponse = unknown>(
	type: RequestType,
	payload: TPayload,
	timeout = DEFAULT_TIMEOUT,
): Promise<TResponse> {
	return new Promise<TResponse>((resolve, reject) => {
		const id = `req_${++requestIdCounter}_${Date.now()}`;

		const timer = setTimeout(() => {
			pendingRequests.delete(id);
			reject(new Error(`Request ${type} timed out after ${timeout}ms`));
		}, timeout);

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
					clearTimeout(pending.timer);

					if (message.error) {
						pending.reject(new Error(message.error.message || 'Unknown error'));
					} else {
						pending.resolve(message.data);
					}
					return;
				}
			}

			// Otherwise it's an event (unsolicited push from Host)
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
