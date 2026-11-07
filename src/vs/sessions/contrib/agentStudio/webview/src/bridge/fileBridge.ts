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
// ★ 2026-11-07（移除 config.html）：`openAgentConfigHtml` 已删（零调用方）。
/**
 * Open an HTML file as a rendered webview preview in the host's center editor
 * area (browser-like view, not source code text).
 *
 * `agentId` is optional — when provided, the host will use it directly to
 * route SDK postMessages back to ConfigHtmlService (avoiding fragile path-
 * reverse-engineering). Callers that already know the owning agent (e.g.
 * `previewAgentConfigHtml`) should always pass it.
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
		agentId?: string;
		workspaceId?: string;
		workspaceSessionId?: string;
		agentSessionId?: string;
	},
): Promise<void> {
	await sendRequest('files.openHtmlPreview', { path, ...options });
}

/**
// ★ 2026-11-07（移除 config.html）：`previewAgentConfigHtml` 已删（零调用方）。

 * Open an in-memory text buffer as an *untitled* editor in the host's
 * center editor area. The buffer lives only in the editor model — nothing
 * is read from or written to disk — so it cannot overwrite an existing
 * agent file.
 *
 * Use case: showing reference / sample content the user wants to inspect
 * or copy from without affecting their real agent.
 */
export async function openUntitledText(
	contents: string,
	options?: OpenFileOptions & { languageId?: string; title?: string },
): Promise<void> {
	await sendRequest('files.openUntitledText', { contents, ...options });
}
