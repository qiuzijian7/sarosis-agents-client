/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

(function () {

	const { ipcRenderer, webFrame, contextBridge } = require('electron');

	function validateIPC(channel: string): true | never {
		if (!channel?.startsWith('vscode:')) {
			throw new Error(`Unsupported event IPC channel '${channel}'`);
		}

		return true;
	}

	const globals = {

		/**
		 * A minimal set of methods exposed from Electron's `ipcRenderer`
		 * to support communication to main process.
		 */
		ipcRenderer: {

			send(channel: string, ...args: unknown[]): void {
				if (validateIPC(channel)) {
					ipcRenderer.send(channel, ...args);
				}
			},

			invoke(channel: string, ...args: unknown[]): Promise<unknown> {
				validateIPC(channel);

				return ipcRenderer.invoke(channel, ...args);
			},

			// B 方案的轻量 desktop 壳复用 ElectronIPCClient：它需要监听 `vscode:message`。
			on(channel: string, listener: (...args: unknown[]) => void): void {
				if (validateIPC(channel)) {
					ipcRenderer.on(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
				}
			},

			removeListener(channel: string, listener: (...args: unknown[]) => void): void {
				if (validateIPC(channel)) {
					ipcRenderer.removeListener(channel, listener as Parameters<typeof ipcRenderer.removeListener>[1]);
				}
			}
		},

		/**
		 * Support for subset of methods of Electron's `webFrame` type.
		 */
		webFrame: {

			setZoomLevel(level: number): void {
				if (typeof level === 'number') {
					webFrame.setZoomLevel(level);
				}
			},

			getZoomFactor(): number {
				return webFrame.getZoomFactor();
			}
		}
	};

	try {
		contextBridge.exposeInMainWorld('vscode', globals);
	} catch (error) {
		console.error(error);
	}
}());
