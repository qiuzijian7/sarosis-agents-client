/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **共享（只读）profile / 延迟物化**的原语。
 *
 * 背景（2026-11-23，安装版首启太慢）：种子 `node_modules` 有 3 万多个文件、600 多 MB，
 * 首启整目录复制既慢又要逐文件过 Defender。实验已证明：把 `node_modules` 换成指向随包种子的
 * **目录联接（junction）**，Host 能正常启动、控制桥握手成功、插件全部激活 —— 因为 importer 的
 * 真实路径落在共享依赖树内，第三方依赖同树可解析。
 *
 * ⇒ 首启只复制**可写层**（清单 / patch / 随包 tgz，约 32 MB），依赖树保持只读共享；
 *   一旦需要**写**依赖树（装/卸/升级插件），再 `materializeSharedProfile()` 把它落为可写副本。
 *
 * ⚠ 两条安全红线：
 * 1. **共享态绝不写 `node_modules`**（它指向安装目录）。调用方在任何写操作前必须先物化；
 *    只读元数据校正（`.modules.yaml`）与单实例收敛（junction 替换）在共享态一律跳过。
 * 2. **删除必须先摘联接**：`rm -r` / `Remove-Item -Recurse` 会跟随 junction 递归到安装目录。
 *    这里所有清理都走 `fsp.rmdir(link)`（只删链接本身），再处理剩余目录。
 */
import { promises as fsp } from 'fs';
import { dirname, join } from '../../../../base/common/path.js';
import { copyDirectoryConcurrently } from './dshConcurrentCopy.js';

/** 实验开关：只有显式 `VSSAROS_PROFILE_SHARED=1` 才走共享首启（默认仍是完整复制）。 */
export const SHARED_PROFILE_ENV = 'VSSAROS_PROFILE_SHARED';

export function sharedProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = (env[SHARED_PROFILE_ENV] ?? '').trim().toLowerCase();
	return value === '1' || value === 'true';
}

/** 只删链接本身：Windows junction 用 `rmdir`，POSIX 的目录符号链接用 `unlink`。 */
async function removeLink(link: string): Promise<void> {
	try {
		await fsp.rmdir(link);
	} catch {
		await fsp.unlink(link);
	}
}

/** `<runtimeRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js` → `<runtimeRoot>`；形状不符返回 `undefined`。 */
export function runtimeRootOfDshBin(dshBin: string): string | undefined {
	const parts = dshBin.replace(/\\/g, '/').split('/');
	const i = parts.lastIndexOf('@deepseek-ai');
	if (i < 1 || parts[i - 1] !== 'node_modules' || parts[i + 1] !== 'dsh') {
		return undefined;
	}
	return parts.slice(0, i - 1).join('/');
}

function canonical(path: string): string {
	const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
	return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * 种子与 Host 实际使用的 dsh 是否**同属一棵 runtime 树**。
 *
 * 为什么必须卡住（2026-11-23 真机定位）：种子里只含部分 `@deepseek-ai` 作用域的包（实测 183/338），
 * 缺失的包（如 `dsh-session-query`）会沿祖先链落到**更上层的 runtime**去加载。若种子被放到另一棵
 * runtime 树下（例如把安装版种子链接到 dev 的 runtime 上使用），同一个类会被加载两次 ——
 * `error instanceof SessionQueryError` 变成 false ⇒ `session/not-found` 不再被识别 ⇒
 * superagent 一族全部 `did not activate`。这类故障极难归因，所以 shared 只在同树时启用，
 * 否则退回完整复制（`copyProfileSeed`）。
 */
export async function isSharedSeedInRuntimeTree(seedDir: string, dshBin: string): Promise<boolean> {
	const [seed, bin] = await Promise.all([
		fsp.realpath(seedDir).then(canonical).catch(() => undefined),
		fsp.realpath(dshBin).then(canonical).catch(() => undefined),
	]);
	if (!seed || !bin) {
		return false;
	}
	const root = runtimeRootOfDshBin(bin);
	if (!root) {
		return false;
	}
	const canonicalRoot = canonical(root);
	return seed === canonicalRoot || seed.startsWith(`${canonicalRoot}/`);
}

/** profile 是否处于共享态（`node_modules` 是指向随包种子的联接，而不是真实目录）。 */
export async function isSharedProfile(profileDir: string): Promise<boolean> {
	try {
		return (await fsp.lstat(join(profileDir, 'node_modules'))).isSymbolicLink();
	} catch {
		return false; // 没有 node_modules：按可写处理，交给调用方决定怎么建
	}
}

/**
 * 建一个共享 profile：复制可写层（种子顶层除 `node_modules` 外的条目）+ 建依赖树联接。
 *
 * 与 `copyProfileSeed` 同口径：`package.json` 必须是对象、`mkdir(profileDir)` 原子认领、失败清理半成品。
 * 建完立刻 `realpath` 校验联接可用（真机踩过「指向 dsh-runtime 的 junction realpath 失败」），
 * 不可用就抛错，由调用方退回完整复制。
 */
export async function createSharedProfile(seedDir: string, profileDir: string): Promise<void> {
	const manifestPath = join(seedDir, 'package.json');
	const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
	if (Object.prototype.toString.call(manifest) !== '[object Object]') {
		throw new Error(`profile seed manifest is invalid: ${manifestPath}`);
	}
	await fsp.mkdir(dirname(profileDir), { recursive: true });
	await fsp.mkdir(profileDir);
	try {
		for (const entry of await fsp.readdir(seedDir, { withFileTypes: true })) {
			if (entry.name === 'node_modules') {
				continue;
			}
			const from = join(seedDir, entry.name);
			const to = join(profileDir, entry.name);
			if (entry.isDirectory()) {
				await copyDirectoryConcurrently(from, to, { dereference: true });
			} else {
				await fsp.copyFile(from, to);
			}
		}
		const link = join(profileDir, 'node_modules');
		await fsp.symlink(join(seedDir, 'node_modules'), link, 'junction');
		await fsp.realpath(link);
	} catch (e) {
		await removeProfileSafely(profileDir);
		throw e;
	}
}

/** 只摘掉依赖树联接（不碰它指向的目录）；不是联接/不存在时静默返回。 */
export async function unlinkSharedNodeModules(profileDir: string): Promise<void> {
	const link = join(profileDir, 'node_modules');
	try {
		if ((await fsp.lstat(link)).isSymbolicLink()) {
			await removeLink(link);
		}
	} catch {
		// 不存在或不是联接：无需处理
	}
}

/**
 * 把共享依赖树落为可写副本（物化）：复制到同级临时目录 → 摘联接 → 原子就位。
 * 已是真实目录时 no-op；失败时尽力把联接接回去，绝不让 profile 停在"没有 node_modules"的状态。
 */
export async function materializeSharedProfile(profileDir: string): Promise<void> {
	const link = join(profileDir, 'node_modules');
	const stats = await fsp.lstat(link).catch(() => undefined);
	if (!stats?.isSymbolicLink()) {
		return;
	}
	const source = await fsp.realpath(link);
	const temp = join(profileDir, `.node_modules.materialize-${process.pid}-${Date.now()}`);
	let unlinked = false;
	try {
		await copyDirectoryConcurrently(source, temp, { dereference: true });
		await removeLink(link);
		unlinked = true;
		await fsp.rename(temp, link);
	} catch (e) {
		if (unlinked) {
			await fsp.symlink(source, link, 'junction').catch(() => undefined);
		}
		await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
		throw e;
	}
}

/** 删 profile 目录：先摘联接再递归删，避免顺着 junction 删到安装目录。 */
export async function removeProfileSafely(profileDir: string): Promise<void> {
	await unlinkSharedNodeModules(profileDir);
	await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}
