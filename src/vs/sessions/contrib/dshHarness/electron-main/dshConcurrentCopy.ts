/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **并发目录复制**（`fs.cp` 的串行实现的替代品，首启提速用）。
 *
 * 背景：profile 种子在打包版里是 3 万多个小文件，`fsp.cp({ recursive: true })` 逐文件串行
 * `open → read → write`，每个文件还要过一次 Windows Defender 实时扫描 ⇒ 首启要几分钟。
 * 这里把「遍历」与「落盘」拆开：先按 Node 自己的目录语义收集清单，再用固定大小的 worker 池
 * 并发 `copyFile` —— 文件之间没有顺序依赖，串行只是实现选择，不是需求。
 *
 * 语义刻意对齐 `fsp.cp(src, dest, { recursive: true, force: true })`：
 * - 只处理**文件 / 目录 / 符号链接**；`dereference: true` 时链接按目标内容复制成真实文件/目录
 *   （Windows 非管理员创建 symlink 会 EPERM，这正是种子复制必须解引用的原因）；
 * - 目标已存在的文件被覆盖；目录一律 `recursive` 创建；不保留 mtime（`fs.cp` 默认也不保留）；
 * - 任一个文件失败即抛错，**已复制的部分不在这里清理**（与 `fsp.cp` 一致，由调用方决定回滚）。
 */
import { promises as fsp } from 'fs';
import { join } from '../../../../base/common/path.js';

export interface IConcurrentCopyOptions {
	/** 文件级并发度（默认 16）。 */
	readonly concurrency?: number;
	/** 是否跟随符号链接复制目标内容（对应 `fs.cp` 的 `dereference`）。 */
	readonly dereference?: boolean;
}

interface IFileToCopy {
	readonly from: string;
	readonly to: string;
}

export async function copyDirectoryConcurrently(srcDir: string, destDir: string, options?: IConcurrentCopyOptions): Promise<void> {
	const limit = Math.max(1, options?.concurrency ?? 16);
	const dereference = options?.dereference === true;
	const dirs: string[] = [destDir];
	const files: IFileToCopy[] = [];

	const walk = async (from: string, to: string): Promise<void> => {
		for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
			const sourcePath = join(from, entry.name);
			const targetPath = join(to, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				if (!dereference) {
					// 非解引用分支：原样复制链接（种子链路只用 dereference: true，这里仅为对齐 fs.cp 语义）。
					await fsp.symlink(await fsp.readlink(sourcePath), targetPath);
					continue;
				}
				const stats = await fsp.stat(sourcePath); // stat 跟随链接；lstat 才是链接本身
				isDirectory = stats.isDirectory();
				isFile = stats.isFile();
			}
			if (isDirectory) {
				dirs.push(targetPath);
				await walk(sourcePath, targetPath);
			} else if (isFile) {
				files.push({ from: sourcePath, to: targetPath });
			}
		}
	};
	await walk(srcDir, destDir);

	for (const dir of dirs) {
		await fsp.mkdir(dir, { recursive: true });
	}

	let next = 0;
	let failure: unknown;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, files.length)) }, async () => {
		while (failure === undefined) {
			const index = next++;
			if (index >= files.length) {
				return;
			}
			const file = files[index];
			try {
				await fsp.copyFile(file.from, file.to);
			} catch (e) {
				failure = e;
				return;
			}
		}
	});
	await Promise.all(workers);
	if (failure !== undefined) {
		throw failure;
	}
}
