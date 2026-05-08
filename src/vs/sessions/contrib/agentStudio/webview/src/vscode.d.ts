/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - VS Code API Type Declarations
 *--------------------------------------------------------------------------------------------*/

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
