// @vssaros/dsh-marketplace — **本机工作台枚举**（★ 2026-10-23 用户：
// "将设置→工作台里的内容也上传到商城数据库中，统一数据源"）
//
// 为什么要单独一个模块：工作台清单在仓里已经有**三份硬编码**
// （宿主页表 `DSH_MODULE_PAGES` / 主页卡片 `WORKBENCH_MODULES` / 侧栏 `DEFAULT_ITEMS`），
// 再手写第四份给商城用 ⇒ 必然漂移 ✗
//
// ⇒ 这里的"真源"是**已装插件树本身**（客观事实）：
//   读 `<profile>/package.json` 的 dependencies → 逐个读
//   `<profile>/node_modules/<pkg>/package.json` → 只要 `vssaros.view.kind === 'page'`
//   就是本机的一个工作台 ✓（2026-10-23 实测本机 14 个）

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从本文件位置反推 profile 根目录。
 *
 * 插件一定装在 `<profile>/node_modules/@vssaros/dsh-marketplace/lib/` 下
 * ⇒ 上溯 4 级就是 profile 根。**不依赖任何配置**（多 profile / 换数据根都不会错）。
 *
 * ⚠ 在**仓库源码目录**里跑（`dsh-plugins/vssaros-marketplace/lib`）时推不出 profile
 *   ⇒ 上层会得到"没有工作台"，这也是为什么函数都接受显式 `profileDir`（可测）。
 *
 * @returns {string}
 */
export function profileDirFromModule() {
	return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

/**
 * 包名 → 商城 slug（服务端规则：`^[a-z0-9][a-z0-9_-]*$`）。
 *
 * `@vssaros/dsh-kanban` → `dsh-kanban`；`dsh-xiaohongshu-note-workbench` 原样 ✓
 *
 * @param {string} packageName
 * @returns {string}
 */
export function slugFromPackageName(packageName) {
	const raw = String(packageName ?? '');
	const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
	return tail
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** 读一个 JSON（读不到/坏 JSON ⇒ null，不抛）。 */
async function readJson(file) {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * 枚举本机已装的**工作台**（`vssaros.view.kind === 'page'`）。
 *
 * @param {string} profileDir profile 根（含 `package.json` 与 `node_modules`）
 * @returns {Promise<{
 *   packageName: string, slug: string, name: string, version: string,
 *   route: string, description: string, distribution: { type: 'npm', name: string }
 * }[]>}
 */
export async function listLocalWorkbenches(profileDir) {
	const root = String(profileDir ?? '').trim();
	if (!root) { return []; }
	const profilePkg = await readJson(join(root, 'package.json'));
	const deps = profilePkg?.dependencies;
	if (!deps || typeof deps !== 'object') { return []; }

	const out = [];
	for (const packageName of Object.keys(deps)) {
		const meta = await readJson(join(root, 'node_modules', packageName, 'package.json'));
		if (!meta) { continue; }
		const view = meta.vssaros?.view;
		// 只要"页面型"模块 —— 这才是用户眼里的"工作台"
		if (!view || view.kind !== 'page') { continue; }
		const slug = slugFromPackageName(packageName);
		if (!slug) { continue; }
		out.push({
			packageName,
			slug,
			// 商城里的显示名：优先 displayName（人话），退到包名尾部
			name: String(meta.displayName ?? meta.vssaros?.view?.label ?? slug),
			version: String(meta.version ?? '0.0.0'),
			route: String(view.route ?? ''),
			// ⚠ 必须截断：服务端 `description` 上限 2048，而插件的 package.json 描述可以很长
			//   ⇒ 真机踩到 4 个工作台因"String must contain at most 2048 character(s)"被拒 ✗
			//   商城卡片只展示两三行，300 字足够 ✓
			description: String(meta.description ?? '').trim().slice(0, 300),
			// 本体就是一个 npm 包 ⇒ 服务端 DistributionSchema 的 npm 型（必须给 name）
			distribution: { type: 'npm', name: packageName },
		});
	}
	// 稳定排序：slug 升序（页面/日志可读，且幂等同步时不会来回跳）
	out.sort((a, b) => a.slug.localeCompare(b.slug));
	return out;
}
