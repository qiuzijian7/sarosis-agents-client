/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';

export const DSH_PLUGIN_PATCH_LOCK = '.vssaros-plugin-patch.lock';

/** Restores profile metadata and re-materializes the original dependency graph on a failed batch. */
export async function runPluginPatchTransaction<T>(profile: string, apply: () => Promise<T>, restoreDependencies: () => Promise<void>): Promise<T> {
	const lockPath = join(profile, DSH_PLUGIN_PATCH_LOCK);
	const lock = await fs.open(lockPath, 'wx');
	const backup = join(profile, '.vssaros', `plugin-patch-backup-${generateUuid()}`);
	let keepBackup = false;
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid, backup }));
		const names = ['package.json', 'pnpm-lock.yaml'];
		const originals = await Promise.all(names.map(name => fs.readFile(join(profile, name))));
		await fs.mkdir(backup, { recursive: true });
		await Promise.all(names.map((name, i) => fs.writeFile(join(backup, name), originals[i])));
		try {
			return await apply();
		} catch (error) {
			try {
				for (let i = 0; i < names.length; i++) {
					const target = join(profile, names[i]);
					const temp = `${target}.${generateUuid()}.restore`;
					await fs.writeFile(temp, originals[i]);
					await fs.rename(temp, target);
				}
				await restoreDependencies();
			} catch (restoreError) {
				keepBackup = true;
				throw new Error(`插件补丁失败且依赖恢复失败；备份保留在 ${backup}。安装错误：${String(error)}；恢复错误：${String(restoreError)}`);
			}
			throw new Error(`插件补丁失败，已恢复原锁文件及依赖树：${String(error)}`);
		}
	} finally {
		await lock.close();
		if (!keepBackup) {
			await fs.rm(backup, { recursive: true, force: true });
			await fs.unlink(lockPath);
		}
	}
}
