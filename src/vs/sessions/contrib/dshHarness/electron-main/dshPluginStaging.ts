/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 随包插件的**暂存目录**落位（`<profile>/.vssaros/plugins/<name>-<version>[-<指纹>]/`）。
 *
 * ## 为什么单独成模块
 * 这段逻辑要能用**真实文件系统**做并发测试（`test/common/dshPluginStaging.test.ts`），
 * 而 supervisor 依赖 electron ⇒ 抽出来（只依赖 `node:fs`）。
 *
 * ## 为什么必须是"临时目录 + rename 就位"（2026-11-03 真机事故）
 *
 * 真机（别人的机器，F5 直接起不来）：
 * ```
 * start failed: EEXIST: file already exists, mkdir '…\.vssaros\plugins\vssaros-dsh-loop-0.2.1-6c0fe768\docs'
 * start failed: ENOTEMPTY: directory not empty, rmdir '…\.vssaros\plugins\vssaros-dsh-kb-0.5.64-4d99a5d1\lib'
 * ```
 * 旧实现是"**先 `rm` 目标、再 `cp` 进去**"，而并发有两个来源：
 *   ① 同一进程里 `Promise.all(wants.map(_stagePlugin))` 并行装 20 个插件；
 *   ② 3 秒内开了 3 个窗口 ⇒ **3 个进程**各自跑同一批安装。
 * ⇒ 一个进程在 rm/cp 的同时，另一个正在同一路径里建子目录/写文件 ⇒ EEXIST / ENOTEMPTY ✗✗
 * ⇒ Host 的预启动直接抛错 ⇒ 起不来。
 *
 * ## 现在的规矩
 * - 各自复制到自己**独占**的 `<dest>.staging-<pid>-<rand>`；
 * - 落位用 `rename`（同一卷上原子）⇒ 谁先成功都行，内容由 name+version+指纹 唯一确定，一样；
 * - **每次都刷新**（不许"目标已存在就复用"）：目录名里的指纹只覆盖**入口文件**（见 `_entryFingerprint`），
 *   非入口文件（client 分包、assets、lib 下其它模块）变了指纹不变 ⇒ 早退复用会让陈旧副本永久生效 ✗。
 *   早退只在"**本次**落位失败、而另一个并发调用刚装好"时使用（那一轮写的是同一份源）；
 * - 输掉竞争的一方**弃掉自己的临时目录**，绝不删别人正在写的目录；
 * - Windows 上 `rename` 覆盖已存在目录会 EPERM/EEXIST ⇒ 先把旧的挪到 `<dest>.stale-…`，
 *   挪不动就说明别人刚装好 ⇒ 用他那份；旧副本被挪开了而新副本又没落位 ⇒ 把它挪回去。
 */

import { promises as fsp } from 'fs';
import { randomBytes } from 'crypto';
import { join, resolve } from '../../../../base/common/path.js';

/** 同一个 `<dest>` 的进程内串行化：并行装同一插件时不要互相看着对方写。 */
const stageLocks = new Map<string, Promise<string>>();

export interface IStagePluginOptions {
	/** 源目录（随包插件 / 暂存目录本身）。 */
	readonly sourceDir: string;
	/** 目标目录（`<profile>/.vssaros/plugins/<name>-<version>[-<指纹>]`）。 */
	readonly destDir: string;
	/** 平台（默认 `process.platform`；测试可注入）。 */
	readonly platform?: NodeJS.Platform;
	/** 唯一的临时后缀来源（测试可注入，便于固定路径）。 */
	readonly uniqueSuffix?: () => string;
	/**
	 * 是否走进程内串行化（默认 `true`）。
	 *
	 * 测试用 `false` 来**模拟"另一个进程"**：跨进程没有共享内存锁 ⇒ 唯一能保证正确性的就是
	 * "临时目录 + rename 原子落位"本身。这条开关让单进程测试能真的把并发写撞在一起。
	 */
	readonly serialize?: boolean;
}

/** 目标是否已经是可用副本（有 `package.json` = 装完整了）。 */
async function isUsable(dest: string): Promise<boolean> {
	try {
		await fsp.access(join(dest, 'package.json'));
		return true;
	} catch {
		return false;
	}
}

/**
 * 把 `sourceDir` 落位到 `destDir`（并发安全、幂等）。返回 `destDir`。
 *
 * 失败时**不留下半成品**：临时目录会被清掉；旧副本会被挪回原位。
 */
export async function stagePluginDir(options: IStagePluginOptions): Promise<string> {
	const { sourceDir, destDir } = options;
	const platform = options.platform ?? process.platform;
	const norm = (p: string): string => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
	// 源**就是**目标：它已经在位（e2e 探针会把暂存目录当 spec 传进来），此时"先删再拷"会把源一起删掉，
	// `cp` 拷出空目录、`dsh plugin add` 报缺 package.json。直接返回。
	if (norm(sourceDir) === norm(destDir)) {
		return destDir;
	}
	const once = (): Promise<string> => stageOnce({ sourceDir, destDir, uniqueSuffix: options.uniqueSuffix });
	if (options.serialize === false) {
		return once();   // 测试：模拟"没有共享内存锁的另一个进程"
	}
	const prev = stageLocks.get(destDir) ?? Promise.resolve();
	const run = prev.then(once, once);
	stageLocks.set(destDir, run);
	try {
		return await run;
	} finally {
		if (stageLocks.get(destDir) === run) {
			stageLocks.delete(destDir);
		}
	}
}

async function stageOnce({ sourceDir, destDir, uniqueSuffix }: { sourceDir: string; destDir: string; uniqueSuffix?: () => string }): Promise<string> {
	// ⚠ 这里**故意不**"目标已存在就直接复用"：见文件头"每次都刷新"那条。
	const uniq = uniqueSuffix ? uniqueSuffix() : `${process.pid}-${randomBytes(4).toString('hex')}`;
	const tmp = `${destDir}.staging-${uniq}`;
	const stale = `${destDir}.stale-${uniq}`;
	await fsp.rm(tmp, { recursive: true, force: true });
	await fsp.mkdir(tmp, { recursive: true });
	// 只排源目录**内部**的 node_modules：源本身可能就在 node_modules 里
	//（如官方 voice-input bundle 随运行时分发），按绝对路径排会把所有文件滤光（实测）。
	await fsp.cp(sourceDir, tmp, {
		recursive: true,
		filter: (src: string) => !/[\\/]node_modules([\\/]|$)/.test(src.slice(sourceDir.length)),
	});
	// 旧的就挪开（不存在 / 正被别的进程用着 ⇒ 都只影响这一份旧副本）
	let movedAside = false;
	try {
		await fsp.rename(destDir, stale);
		movedAside = true;
	} catch { /* ENOENT = 本来没有；EPERM/EBUSY = 别人在用 ⇒ 下面 rename 会失败，走"用他那份" */ }
	try {
		await fsp.rename(tmp, destDir);
	} catch (e) {
		// 另一个进程抢先生成了目标（或旧副本挪不动）⇒ 弃掉自己这份，用现成的
		await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
		if (await isUsable(destDir)) {
			// ⚠ 这里**必须先把自己挪开的旧副本删掉**再返回：并发时很常见的序列是
			//   「A 把旧 dest 挪成 stale-A → B 抢先 rename 成功 → A 的 rename 失败」，
			//   若直接 return，stale-A 就永久留在 plugins 目录里（行为测试 6 个用例里的第 4 个抓到）。
			if (movedAside) {
				await fsp.rm(stale, { recursive: true, force: true }).catch(() => undefined);
			}
			return destDir;
		}
		// 旧副本被挪开了、新副本又没落位 ⇒ 把它挪回来，至少别让插件消失
		if (movedAside) {
			await fsp.rename(stale, destDir).catch(() => undefined);
		}
		throw e;
	}
	if (movedAside) {
		await fsp.rm(stale, { recursive: true, force: true }).catch(() => undefined);
	}
	return destDir;
}
