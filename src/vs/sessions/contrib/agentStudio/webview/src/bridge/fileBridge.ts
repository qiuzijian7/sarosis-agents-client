/*---------------------------------------------------------------------------------------------
 *  fileBridge — open files in the host's center editor area.
 *--------------------------------------------------------------------------------------------*/

import { sendRequest } from './messageClient';

export interface OpenFileOptions {
	preserveFocus?: boolean;
	pinned?: boolean;
}

/**
 * Open a file by absolute filesystem path.
 */
export async function openFile(path: string, options?: OpenFileOptions): Promise<void> {
	await sendRequest('files.open', { path, ...options });
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
 */
export async function openHtmlPreview(path: string, options?: OpenFileOptions): Promise<void> {
	await sendRequest('files.openHtmlPreview', { path, ...options });
}

/**
 * Render the agent's ConfigMD into a standalone HTML preview file
 * (`<agentDir>/.preview.html`), then open it as a rendered webview preview
 * in the host's center editor area. Returns the absolute path of the file.
 */
export async function previewAgentConfigMd(
	employeeId: string,
	options?: OpenFileOptions,
): Promise<string> {
	const r = await sendRequest('configmd.previewToFile', { employeeId }) as { path: string };
	if (!r?.path) {
		throw new Error('previewToFile did not return a path');
	}
	await sendRequest('files.openHtmlPreview', { path: r.path, ...options });
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
