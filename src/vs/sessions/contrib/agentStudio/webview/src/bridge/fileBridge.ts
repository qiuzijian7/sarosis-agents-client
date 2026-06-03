/*---------------------------------------------------------------------------------------------
 *  fileBridge — open files in the host's center editor area.
 *--------------------------------------------------------------------------------------------*/

import { sendRequest } from './messageClient';

export interface OpenFileOptions {
	preserveFocus?: boolean;
	pinned?: boolean;
	/** Line number to scroll to after opening (1-based) */
	lineNumber?: number;
	/**
	 * Owning workspace id. Lets the host resolve a *relative* file path
	 * (e.g. "product.json", "src/app.ts") against that workspace's on-disk
	 * root. Without it, relative paths fail to open ("file not found").
	 */
	workspaceId?: string;
}

/**
 * Open a file by absolute filesystem path.
 * Supports `path:line` format (e.g., "/foo/bar.ts:42") for line jumping.
 */
export async function openFile(path: string, options?: OpenFileOptions): Promise<void> {
	// Parse path:line format
	let filePath = path;
	let lineNumber = options?.lineNumber;
	const colonMatch = path.match(/^(.+):(\d+)$/);
	if (colonMatch) {
		filePath = colonMatch[1];
		lineNumber = parseInt(colonMatch[2], 10);
	}
	await sendRequest('files.open', { path: filePath, lineNumber, ...options });
}

/**
 * Open the agent's ConfigMD source file (`config.md` by default) in the
 * host's center editor area. Edits made there auto-sync back to the panel
 * via the file watcher.
 */
export async function openAgentConfigMd(employeeId: string, options?: OpenFileOptions): Promise<void> {
	await sendRequest('files.open', { employeeId, kind: 'configMd', ...options });
}

/**
 * Open an HTML file as a rendered webview preview in the host's center editor
 * area (browser-like view, not source code text).
 *
 * `employeeId` is optional — when provided, the host will use it directly to
 * route SDK postMessages back to ConfigHtmlService (avoiding fragile path-
 * reverse-engineering). Callers that already know the owning agent (e.g.
 * `previewAgentConfigMd`) should always pass it.
 *
 * `workspaceId` / `workspaceSessionId` / `agentSessionId` are also optional.
 * When supplied, the preview pane forwards them into the imgui SDK so
 * `imgui.submit` events carry the exact (workspace, fork session, agent
 * session) tuple that was active when the preview was opened — instead of
 * falling back to whatever the chat panel currently shows. This matters
 * when multiple Forks run in parallel.
 */
export async function openHtmlPreview(
	path: string,
	options?: OpenFileOptions & {
		employeeId?: string;
		workspaceId?: string;
		workspaceSessionId?: string;
		agentSessionId?: string;
	},
): Promise<void> {
	await sendRequest('files.openHtmlPreview', { path, ...options });
}

/**
 * Render the agent's ConfigMD into a standalone HTML preview file
 * (`<agentDir>/.preview.html`), then open it as a rendered webview preview
 * in the host's center editor area. Returns the absolute path of the file.
 *
 * Captures the current chat/workspace context at call time so the preview's
 * imgui submits can be routed back to the same Fork session even after the
 * user changes selection in the chat panel.
 */
export async function previewAgentConfigMd(
	employeeId: string,
	options?: OpenFileOptions,
): Promise<string> {
	const r = await sendRequest('configmd.previewToFile', { employeeId }) as { path: string };
	if (!r?.path) {
		throw new Error('previewToFile did not return a path');
	}

	// Best-effort context capture. The stores are imported lazily because
	// fileBridge is loaded very early — direct top-level imports would risk
	// circular initialization order issues in the bundle.
	let workspaceId: string | undefined;
	let workspaceSessionId: string | undefined;
	let agentSessionId: string | undefined;
	try {
		const { useWorkspaceStore } = require('../store/useWorkspaceStore');
		workspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? undefined;
	} catch { /* store unavailable in this entry point */ }
	try {
		const { useWorkspaceSessionStore } = require('../store/useWorkspaceSessionStore');
		const sessionStore = useWorkspaceSessionStore.getState();
		// Only meaningful in Fork mode (Root mode has activeSessionId === null).
		workspaceSessionId = sessionStore.activeSessionId ?? undefined;
		// Prefer the per-Fork agentSessionId mapping if available; this is
		// how the webview maps (agent, fork) → that fork's chat session.
		const forkAgentSessionId = sessionStore.getAgentSessionId(employeeId);
		if (forkAgentSessionId) {
			agentSessionId = forkAgentSessionId;
		}
	} catch { /* store unavailable */ }
	if (!agentSessionId) {
		try {
			const { useChatStore } = require('../store/useChatStore');
			const cs = useChatStore.getState();
			// Only attach a session id if the chat panel is showing the
			// same employee — otherwise the captured id would be for an
			// unrelated agent and would silently mis-route imgui submits.
			if (cs.activeEmployeeId === employeeId) {
				agentSessionId = cs.activeAgentSessionId ?? undefined;
			}
		} catch { /* store unavailable */ }
	}

	await sendRequest('files.openHtmlPreview', {
		path: r.path,
		employeeId,
		workspaceId,
		workspaceSessionId,
		agentSessionId,
		...options,
	});
	return r.path;
}

/**
 * Open the agent's custom parser script (if configured).
 */
export async function openAgentParser(employeeId: string, options?: OpenFileOptions): Promise<void> {
	await sendRequest('files.open', { employeeId, kind: 'configMdParser', ...options });
}

/**
 * Open the agent's custom styles file (if configured).
 */
export async function openAgentStyles(employeeId: string, options?: OpenFileOptions): Promise<void> {
	await sendRequest('files.open', { employeeId, kind: 'configMdStyles', ...options });
}

/**
 * Open an in-memory text buffer as an *untitled* editor in the host's
 * center editor area. The buffer lives only in the editor model — nothing
 * is read from or written to disk — so it cannot overwrite an existing
 * agent file.
 *
 * Use case: showing reference / sample content (e.g. ConfigMD demo source)
 * the user wants to inspect or copy from without affecting their real agent.
 */
export async function openUntitledText(
	contents: string,
	options?: OpenFileOptions & { languageId?: string; title?: string },
): Promise<void> {
	await sendRequest('files.openUntitledText', { contents, ...options });
}
