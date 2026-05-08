/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import gulp from 'gulp';
import { execSync } from 'child_process';
import * as path from 'path';
import * as task from './lib/task.ts';

const WEBVIEW_DIR = path.resolve(import.meta.dirname, '..', 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview');

/**
 * Install dependencies for the Agent Studio WebView.
 */
function installAgentStudioWebview() {
	return new Promise<void>((resolve, reject) => {
		try {
			execSync('npm install --prefer-offline', {
				cwd: WEBVIEW_DIR,
				stdio: 'inherit',
			});
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}

/**
 * Build the Agent Studio WebView React application using esbuild.
 */
function buildAgentStudioWebview() {
	return new Promise<void>((resolve, reject) => {
		try {
			execSync('node esbuild.config.mjs', {
				cwd: WEBVIEW_DIR,
				stdio: 'inherit',
			});
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}

const compileAgentStudioWebviewTask = task.define('compile-agent-studio-webview',
	task.series(installAgentStudioWebview, buildAgentStudioWebview)
);

gulp.task(compileAgentStudioWebviewTask);

export { compileAgentStudioWebviewTask };
