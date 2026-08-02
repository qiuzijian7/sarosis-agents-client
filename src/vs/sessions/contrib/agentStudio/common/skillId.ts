/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill ID 计算 —— 全项目唯一真源（对齐 Hermes-Agent `skill_bundles._slugify` 单点约定）。
 *
 * 设计要点（复刻 Hermes-Agent 技能身份模型）：
 *   1. **slug 规则单点化**：registry 扫描、安装、重命名全部走 `slugifySkillId()`，
 *      保证「磁盘目录名 ≡ 加载进 registry 的 id」，杜绝多处规则漂移导致的重复漏检。
 *   2. **双层身份**：`name` 是人类可读展示名（不唯一），`id` 是机器标识（唯一键）。
 *      frontmatter 可显式声明 `id:` 作为权威键（对齐 Hermes 的 `identifier`），
 *      同名技能可通过显式指定不同 id 共存（`logger-a` / `logger-b`）。
 *   3. **合法性校验**：显式 id 必须匹配 `SKILL_ID_PATTERN`，拦截路径穿越（`../evil`）
 *      与无效名（空、纯符号）。
 *
 * 注意：slug 规则与 SkillRegistry 既有行为严格一致（保留下划线 `_`、不去首尾 `-`），
 * 不得随意更改——否则已安装技能的目录名与新计算的 id 不一致，引发重复/丢失。
 */

import { stringHash } from '../../../../base/common/hash.js';

/**
 * 合法 skill id：小写字母开头，后跟小写字母/数字/`-`/`_`。
 * 对齐 Hermes-Agent `_VALID_NAME_RE = ^[a-z][a-z0-9_-]*$`。
 */
export const SKILL_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * 将技能名 slug 化为 id。规则（与 SkillRegistry 历史行为一致，勿改）：
 *   小写 → 空白转 `-` → 移除非 `[a-z0-9_-]` 字符 → 折叠连续 `-`。
 *
 * 纯 ASCII 输出；非 ASCII 名（如纯中文）会产出空串，调用方需用
 * `ensureNonEmptySkillId` 兜底或要求显式 `id`。
 */
export function slugifySkillId(name: string): string {
	return name.trim().toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9\-_]/g, '')
		.replace(/-+/g, '-');
}

/** 判定字符串是否为合法 skill id（用于 frontmatter 显式 `id` 字段校验）。 */
export function isValidSkillId(id: string): boolean {
	return SKILL_ID_PATTERN.test(id);
}

/**
 * 权威 id 解析（对齐 Hermes `identifier` 语义）：
 *   - frontmatter 显式 `id` 合法时优先采用（trim + 小写归一）；
 *   - 否则从 `name` slug 派生。
 *
 * 返回空串表示 name 无法 slug 出有效 id（如纯中文名），调用方决定
 * 是报错要求显式 id（安装路径）还是哈希兜底（registry 扫描路径）。
 */
export function resolveSkillId(explicitId: string | undefined, name: string): string {
	if (explicitId) {
		const normalized = explicitId.trim().toLowerCase();
		if (isValidSkillId(normalized)) {
			return normalized;
		}
	}
	return slugifySkillId(name);
}

/**
 * 空 id 兜底：当 slug 结果为空（纯非 ASCII 名）时，基于种子生成确定性的
 * `skill-<hash8>` id，保证同一目录/同名技能跨重载 id 稳定。
 */
export function ensureNonEmptySkillId(id: string, seed: string): string {
	if (id) {
		return id;
	}
	const h = (stringHash(seed, 0) >>> 0).toString(16).padStart(8, '0');
	return `skill-${h}`;
}
