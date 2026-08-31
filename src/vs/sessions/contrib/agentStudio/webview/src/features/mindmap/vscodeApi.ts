/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface VsCodeApi {
	getState(): any;
	setState(state: any): void;
	postMessage(message: any): void;
}

/**
 * 获取 VS Code webview 的宿主通信 API。
 * 在隐藏渲染 webview 内调用一次，缓存实例（acquireVsCodeApi 只允许调用一次）。
 */
export const vscodeApi: VsCodeApi = (() => {
	const acquired = (window as any).acquireVsCodeApi?.();
	if (!acquired) {
		// 非 webview 环境（如本地调试）的兜底实现
		return {
			getState: () => undefined,
			setState: () => undefined,
			postMessage: (message: any) => {
				(window.parent as any)?.postMessage?.(message, '*');
			},
		};
	}
	return acquired as VsCodeApi;
})();
