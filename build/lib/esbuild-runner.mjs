/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * esbuild-runner.mjs — thin wrapper to run esbuild config .mts files.
 *
 * Usage: node esbuild-runner.mjs <config-path> [args...]
 *
 * The config file (e.g. extensions/configuration-editing/esbuild.mts) is a TypeScript
 * ESM module that imports ../esbuild-extension-common.mts and calls run().
 * Node.js 22 needs --experimental-strip-types to handle .mts files directly.
 */

import { spawn } from 'child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
	console.error('Usage: node esbuild-runner.mjs <config-path> [args...]');
	process.exit(1);
}

const configPath = args[0];
const restArgs = args.slice(1);

const child = spawn(process.execPath, ['--experimental-strip-types', configPath, ...restArgs], {
	stdio: 'inherit',
	env: { ...process.env, FORCE_COLOR: '1' }
});

child.on('exit', (code) => {
	process.exit(code ?? 1);
});
