/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, relative } from '../../../base/common/path.js';
import { FileAccess } from '../../../base/common/network.js';
import { StopWatch } from '../../../base/common/stopwatch.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';

export const ICSSDevelopmentService = createDecorator<ICSSDevelopmentService>('ICSSDevelopmentService');

export interface ICSSDevelopmentService {
	_serviceBrand: undefined;
	isEnabled: boolean;
	getCssModules(): Promise<string[]>;
}

export class CSSDevelopmentService implements ICSSDevelopmentService {

	declare _serviceBrand: undefined;

	private _cssModules?: Promise<string[]>;

	constructor(
		@IEnvironmentService private readonly envService: IEnvironmentService,
		@ILogService private readonly logService: ILogService
	) { }

	get isEnabled(): boolean {
		return !this.envService.isBuilt;
	}

	getCssModules(): Promise<string[]> {
		this._cssModules ??= this.computeCssModules();
		return this._cssModules;
	}

	private async computeCssModules(): Promise<string[]> {
		if (!this.isEnabled) {
			return [];
		}

		const rg = await import('@vscode/ripgrep');
		return await new Promise<string[]>((resolve) => {

			const sw = StopWatch.create();

			const chunks: Buffer[] = [];
			const basePath = FileAccess.asFileUri('').fsPath;

			// Resolve the ripgrep binary with fallbacks. `npm install --ignore-scripts`
			// skips the @vscode/ripgrep postinstall download, leaving bin/rg.exe missing;
			// without a working rg the CSS module list is empty and the dev CSS import-map
			// is never generated -> every `import "*.css"` fails with a MIME error.
			const binName = process.platform === 'win32' ? 'rg.exe' : 'rg';
			const rgCandidates = [
				rg.rgPath,
				join(basePath, 'node_modules', '@vscode', 'ripgrep', 'bin', binName),
				join(basePath, 'build', 'saros', 'bin', binName)
			];
			const rgPath = rgCandidates.find(candidate => existsSync(candidate));
			if (!rgPath) {
				this.logService.error('[CSS_DEV] FAILED to compute CSS data: no ripgrep binary found. Candidates: ' + rgCandidates.join(', '));
				resolve([]);
				return;
			}
			if (rgPath !== rg.rgPath) {
				this.logService.warn(`[CSS_DEV] Using fallback ripgrep binary: ${rgPath}`);
			}

			const rgProcess = spawn(rgPath, ['-g', '**/*.css', '--files', '--no-ignore', basePath], {});

			rgProcess.stdout.on('data', data => {
				chunks.push(data);
			});
			rgProcess.on('error', err => {
				this.logService.error('[CSS_DEV] FAILED to compute CSS data', err);
				resolve([]);
			});
			rgProcess.on('close', () => {
				const data = Buffer.concat(chunks).toString('utf8');
				const result = data.split('\n').filter(Boolean).map(path => relative(basePath, path).replace(/\\/g, '/')).filter(Boolean).sort();
				if (result.some(path => path.indexOf('vs/') !== 0)) {
					this.logService.error(`[CSS_DEV] Detected invalid paths in css modules, raw output: ${data}`);
				}
				resolve(result);
				this.logService.info(`[CSS_DEV] DONE, ${result.length} css modules (${Math.round(sw.elapsed())}ms)`);
			});
		});
	}
}
