/**
 * 共享（只读）profile 的「写前物化」（2026-11-23）。
 *
 * 背景：安装版首启可以把 `node_modules` 做成指向随包种子的只读 junction（`VSSAROS_PROFILE_SHARED=1`
 * 实验开关），把首启的 3 万多次文件复制省掉。主进程在所有它经手的写路径（伴生安装、`dsh plugin add`、
 * 通道里的 install/remove/启停）之前都会先物化；但**本插件在 Host 进程内**直接调 `pluginManager`
 * （控制桥不可用时的回落通道）时，主进程插不上手 —— 不先物化就会让 pnpm 写进安装目录。
 *
 * ⇒ 这里提供同样的兜底：Host 内要写 `node_modules` 之前调一次 `ensureWritableProfile()`。
 * 非共享态 / 未注入标记时是 no-op，**默认行为完全不变**。
 */
import { cp, lstat, realpath, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** 主进程在共享态注入的标记；未注入（普通安装 / 旧版本）返回 undefined。 */
export function sharedProfileDir(env = process.env) {
	const shared = String(env.VSSAROS_PROFILE_SHARED ?? '').trim();
	const dir = String(env.VSSAROS_PROFILE_DIR ?? '').trim();
	return shared === '1' && dir ? dir : undefined;
}

/**
 * `node_modules` 是联接就落为真实副本（复制 → 摘链接 → 原子就位），返回是否真的物化了。
 * 已是真实目录 / 没有 `node_modules` 时返回 false；失败抛错并尽力把联接接回去。
 */
export async function ensureWritableProfile(profileDir) {
	if (!profileDir) {
		return false;
	}
	const link = join(profileDir, 'node_modules');
	let stats;
	try {
		stats = await lstat(link);
	} catch {
		return false;
	}
	if (!stats.isSymbolicLink()) {
		return false;
	}
	const source = await realpath(link);
	const temp = join(profileDir, `.node_modules.materialize-${process.pid}-${Date.now()}`);
	let unlinked = false;
	try {
		await cp(source, temp, { recursive: true, dereference: true, force: true });
		try {
			await rmdir(link);
		} catch {
			await unlink(link);
		}
		unlinked = true;
		await rename(temp, link);
		return true;
	} catch (e) {
		if (unlinked) {
			await symlink(source, link, 'junction').catch(() => undefined);
		}
		await rm(temp, { recursive: true, force: true }).catch(() => undefined);
		throw e;
	}
}
