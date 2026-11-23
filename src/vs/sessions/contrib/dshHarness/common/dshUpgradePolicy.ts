/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **升级策略**（灰度 / 强制最低版本）与**统一更新内容**的纯逻辑真源（2026-11-23）。
 *
 * 之前：应用侧只有一段 `notes` 发布日志，插件 / 资产没有 changelog；有没有新版只看
 * 「版本号是否更高」，没有最低版本强制、没有灰度 ⇒ 要么全量推、要么靠人工改更新源。
 *
 * 口径（刻意保守，默认行为与改造前一致）：
 *  · 更新源**不给** `minVersion` / `rolloutPercent` ⇒ 全量（`100%`）、不强制；
 *  · 本地版本 < `minVersion` ⇒ `required`（必须升级），不受灰度影响；
 *  · 有新版但分桶未命中灰度 ⇒ `optional` + 说明「暂缓」，**不改状态机**
 *    （`available` 该弹还弹，策略只是附加信息，避免破坏现有呈现判据）；
 *  · 分桶用 FNV-1a 把稳定标识（commit / 机器 id）映射到 `0..99` ⇒ 同一台机器每次结论一致，
 *    刷新一下就换结论是灰度的大忌 ✗。
 *
 * ⚠ `notes` 是更新源给的**纯文本**：`validateUpgradePolicyState` 限长后由渲染层用
 *   `textContent` / React 文本节点渲染，绝不当 HTML（与 `releaseNotes` 同口径）。
 */

import { compareVersions } from './dshVersion.js';
import { clampPercent } from './appUpdateState.js';

export type UpgradeUrgency = 'optional' | 'recommended' | 'required';

export interface IUpgradePolicyInput {
	readonly local: string;
	readonly remote?: string;
	readonly channel?: string;
	/** 更新源要求的最低可运行版本；本地低于它 ⇒ 必须升级。 */
	readonly minRequiredVersion?: string;
	/** 0..100；缺省 = 100（全量）。 */
	readonly rolloutPercent?: number;
	/** 稳定分桶标识（宿主传 `productService.commit` 一类）。 */
	readonly bucket?: string;
	/** 更新源给的纯文本更新内容。 */
	readonly notes?: string;
}

/** 随 `IDshUpgradeState` 推给页面的策略投影（页面只读）。 */
export interface IUpgradePolicyState {
	readonly urgency: UpgradeUrgency;
	readonly channel: string;
	readonly rolloutPercent: number;
	readonly minRequiredVersion?: string;
	readonly notes?: string;
	/** 一句人话：为什么是这个结论（面板直接显示）。 */
	readonly reason: string;
}

/** FNV-1a 32 位 → `0..99`；纯函数、无随机源，保证同一标识每次同结论。 */
export function bucketOf(seed: string | undefined): number {
	const s = String(seed ?? '');
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) % 100;
}

/** 没给分桶标识时按「命中」处理：缺配置不该把整批用户都挡在灰度外。 */
export function rolloutHit(percent: number, seed?: string): boolean {
	if (percent >= 100) {
		return true;
	}
	if (!seed) {
		return true;
	}
	return bucketOf(seed) < percent;
}

export function decideUpgradePolicy(input: IUpgradePolicyInput): IUpgradePolicyState {
	const channel = String(input.channel ?? 'stable').slice(0, 64) || 'stable';
	const rolloutPercent = input.rolloutPercent === undefined ? 100 : clampPercent(input.rolloutPercent);
	const min = input.minRequiredVersion?.trim() || undefined;
	const notes = input.notes?.trim() || undefined;
	const common = {
		channel,
		rolloutPercent,
		...(min ? { minRequiredVersion: min.slice(0, 64) } : {}),
		...(notes ? { notes: notes.slice(0, 20_000) } : {}),
	};

	if (min && compareVersions(input.local, min) < 0) {
		return {
			...common,
			urgency: 'required',
			reason: `当前 v${input.local} 低于最低要求 v${min}，必须升级`,
		};
	}
	if (!input.remote || compareVersions(input.remote, input.local) <= 0) {
		return {
			...common,
			urgency: 'optional',
			reason: '已是最新版本',
		};
	}
	if (!rolloutHit(rolloutPercent, input.bucket)) {
		return {
			...common,
			urgency: 'optional',
			reason: `v${input.remote} 已发布，但当前分桶未命中 ${rolloutPercent}% 灰度，暂缓提示`,
		};
	}
	return {
		...common,
		urgency: 'recommended',
		reason: `检测到新版本 v${input.remote}，建议升级`,
	};
}

/** 信任边界：策略随快照穿过主进程再推给页面，逐字段白名单重建。 */
export function validateUpgradePolicyState(value: unknown): IUpgradePolicyState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	const urgency = v.urgency === 'optional' || v.urgency === 'recommended' || v.urgency === 'required' ? v.urgency : undefined;
	if (!urgency) {
		return undefined;
	}
	const pct = typeof v.rolloutPercent === 'number' && Number.isFinite(v.rolloutPercent) ? clampPercent(v.rolloutPercent) : 100;
	return {
		urgency,
		channel: typeof v.channel === 'string' ? v.channel.slice(0, 64) : 'stable',
		rolloutPercent: pct,
		...(typeof v.minRequiredVersion === 'string' && v.minRequiredVersion.trim() ? { minRequiredVersion: v.minRequiredVersion.trim().slice(0, 64) } : {}),
		...(typeof v.notes === 'string' && v.notes ? { notes: v.notes.slice(0, 20_000) } : {}),
		reason: typeof v.reason === 'string' ? v.reason.slice(0, 300) : '',
	};
}
