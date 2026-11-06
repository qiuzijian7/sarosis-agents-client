// 随包技能根 —— 唯一真源（P0，2026-11-06）。
//
// 背景：用户要求把随包内置技能全部迁到 dsh 侧、IDE 侧不再保留技能文件。
// P3（2026-11-07）已完成：旧根 `resources/.agents/skills` 的 500 个文件逐字节迁到
// `BUNDLED_SKILL_ROOT` 后整体删除（git 版本化，可回滚）。所有守卫与运行时只认新根；
// `LEGACY_BUNDLED_SKILL_ROOT` 保留为「防重建」常量 —— check-skill-bundle.mjs 硬判它不存在。
//
// ⚠ 任何守卫/脚本都不许再自己拼 `resources/.agents/skills` 字面量 —— 一律从本模块取。

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');

/** dsh 侧随包技能插件（@vssaros/dsh-skill-bundle）的仓库目录。 */
export const BUNDLE_PLUGIN_DIR = join(REPO_ROOT, 'dsh-plugins', 'vssaros-skill-bundle');

/** ★ 新真源：随包技能都放在这个 dsh 插件包内，由 Host 进程读取。 */
export const BUNDLED_SKILL_ROOT = join(BUNDLE_PLUGIN_DIR, 'skills');

/** 旧根（IDE 侧），P3 删除前仅作对照/兼容扫描，不再是真源。 */
export const LEGACY_BUNDLED_SKILL_ROOT = join(REPO_ROOT, 'resources', '.agents', 'skills');

/** 用户技能根（两套数据根，dev / 产品）。 */
export const USER_SKILL_ROOTS = [
	join(homedir(), '.vssaros-dev', 'skills'),
	join(homedir(), '.vssaros', 'skills'),
];

/**
 * 守卫实际要扫的随包根列表。
 * 新根不存在（干净检出里插件尚未生成产物）时回落到旧根，避免守卫"一个都没扫到"却假绿。
 */
export function bundledSkillRoots() {
	const roots = [];
	if (existsSync(BUNDLED_SKILL_ROOT)) { roots.push(BUNDLED_SKILL_ROOT); }
	if (existsSync(LEGACY_BUNDLED_SKILL_ROOT)) { roots.push(LEGACY_BUNDLED_SKILL_ROOT); }
	return roots;
}

/** 真源根（优先新根）。运行期只有一份技能会被挂载，绝不两处同时生效。 */
export function primaryBundledSkillRoot() {
	return existsSync(BUNDLED_SKILL_ROOT) ? BUNDLED_SKILL_ROOT : LEGACY_BUNDLED_SKILL_ROOT;
}
