/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath, basename } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IContextStorage,
} from '../common/contextTypes.js';
import { SarosPath, resolveSarosPath } from '../common/sarosPaths.js';

/**
 * File-based implementation of {@link IContextStorage}.
 *
 * Stores data as JSON files under `{userDataRoot}/context-storage/`.
 * Each key maps to a file: `key=snapshot:abc` → `context-storage/snapshot_abc.json`.
 * The colon (`:`) in keys is replaced with underscore (`_`) for filesystem safety.
 */
export class FileContextStorageService implements IContextStorage {

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		private readonly _userDataRoot: URI,
	) { }

	private get _storageDir(): URI {
		return resolveSarosPath(this._userDataRoot, SarosPath.contextStorage);
	}

	/** Convert a logical key to a safe filesystem path. */
	private _keyToUri(key: string): URI {
		const safeName = key.replace(/[:<>"|?*\\]/g, '_') + '.json';
		return joinPath(this._storageDir, safeName);
	}

	/** Convert a file URI back to a logical key. */
	private _uriToKey(uri: URI): string {
		const name = basename(uri);
		// Remove .json suffix and restore colons (first underscore only, to minimize false positives)
		return name.replace(/\.json$/, '').replace(/_/g, ':');
	}

	async write(key: string, data: unknown): Promise<void> {
		try {
			const uri = this._keyToUri(key);
			const content = JSON.stringify(data, null, 2);
			await this._fileService.writeFile(uri, VSBuffer.fromString(content));
		} catch (err) {
			this._logService.error(`[ContextStorage] Failed to write key "${key}":`, err);
			throw err;
		}
	}

	async read(key: string): Promise<unknown | undefined> {
		try {
			const uri = this._keyToUri(key);
			if (!(await this._fileService.exists(uri))) {
				return undefined;
			}
			const content = await this._fileService.readFile(uri);
			return JSON.parse(content.value.toString());
		} catch (err) {
			this._logService.warn(`[ContextStorage] Failed to read key "${key}":`, err);
			return undefined;
		}
	}

	async delete(key: string): Promise<void> {
		try {
			const uri = this._keyToUri(key);
			if (await this._fileService.exists(uri)) {
				await this._fileService.del(uri);
			}
		} catch (err) {
			this._logService.warn(`[ContextStorage] Failed to delete key "${key}":`, err);
		}
	}

	async list(prefix: string): Promise<string[]> {
		try {
			const dir = this._storageDir;
			if (!(await this._fileService.exists(dir))) {
				return [];
			}
			const stat = await this._fileService.resolve(dir);
			if (!stat.children) {
				return [];
			}
			const keys: string[] = [];
			for (const child of stat.children) {
				if (!child.isFile) { continue; }
				const key = this._uriToKey(child.resource);
				if (key.startsWith(prefix)) {
					keys.push(key);
				}
			}
			return keys;
		} catch (err) {
			this._logService.warn(`[ContextStorage] Failed to list with prefix "${prefix}":`, err);
			return [];
		}
	}
}
