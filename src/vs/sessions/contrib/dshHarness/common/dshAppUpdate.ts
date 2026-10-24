/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **应用（IDE）自身升级**的纯逻辑（2026-10-23）。
 *
 * 背景（用户："desktop 窗口下，缺少升级入口" → "改成 一键升级按钮"）：桌面窗口里点一次按钮，
 * 就要走完「检查更新源 → 比版本 → 下载 → 安装并重启」。这里只放**可单测**的那部分：
 *   · 版本号怎么比（`2.2.26125` vs `2.2.26080`）；
 *   · 什么时候**不许**升（更新源比本地旧 ⇒ 那是降级 ✗）；
 *   · 更新源的 URL 怎么拼。
 *
 * ⚠ 为什么一定要自己比版本：VS Code 的 win32 更新服务判"有没有新版"用的是 **commit 不相等**
 *   （`updateService.win32.ts` 的 `doCheckForUpdate`），它并不比较版本高低 ⇒ 更新源里放着一个**更旧**的
 *   构建时，它照样会下载安装 ⇒ 真机实测的 `2.2.26080 < 2.2.26125` 会变成"一键降级" ✗✗。
 *   所以这道闸门必须在我们这边（见 {@link decideAppUpdate}）。
 */

/** 一次"应用更新"的结论。 */
export type AppUpdateAction =
	/** 更新源比本地新 ⇒ 可以一键升级 ✓ */
	| 'upgrade'
	/** 更新源与本地相同（或没有可用信息）⇒ 已是最新 */
	| 'uptodate'
	/** 更新源比本地**旧** ⇒ 拒绝（否则就是降级） */
	| 'downgrade';

/** 版本号切段；认不出数字的段一律 0（`2.2.26125-rc.1` 与 `2.2.26125` 视为同版）。 */
function segments(version: string): number[] {
	return String(version ?? '')
		.split(/[.+-]/)
		.slice(0, 4)
		.map(part => {
			const n = Number.parseInt(part, 10);
			return Number.isFinite(n) && n >= 0 ? n : 0;
		});
}

/**
 * 语义化版本比较（数字段逐个比，缺的段按 0）。
 * @returns 负数 = a 更旧；0 = 相同；正数 = a 更新。
 */
export function compareVersions(a: string, b: string): number {
	const sa = segments(a);
	const sb = segments(b);
	const len = Math.max(sa.length, sb.length);
	for (let i = 0; i < len; i++) {
		const d = (sa[i] ?? 0) - (sb[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	return 0;
}

/**
 * 一键升级的**硬闸门**：只有更新源严格比本地新才允许升。
 *
 * `remote` 缺失（没查到 / 更新源没给 productVersion）按"已是最新"处理 —— 宁可不升，
 * 也不要因为一个残缺响应就把用户装回旧版（可重试，成本低；降级要重装，成本高）。
 */
export function decideAppUpdate(local: string, remote: string | undefined): AppUpdateAction {
	const r = String(remote ?? '').trim();
	if (!r) {
		return 'uptodate';
	}
	const cmp = compareVersions(r, local);
	if (cmp > 0) {
		return 'upgrade';
	}
	return cmp === 0 ? 'uptodate' : 'downgrade';
}

/**
 * 更新检查的端点（与 `updateService.win32.ts` 同形状）。
 *
 * 例：`http://host:3030/api/update/win32-x64/saros/<commit>?channel=latest&noversioncheck=true`
 * ⚠ `noversioncheck=true` 是为了让服务端**总是**回它手上那一版（我们自己做版本比较）；
 *   不带这个参数时服务端可能直接回 204/空 ⇒ 我们就分不清"没新版"和"源坏了" ✗。
 */
export function buildUpdateEndpoint(base: string, platform: string, quality: string, commit: string): string {
	const root = String(base ?? '').replace(/\/+$/, '');
	const h = encodeURIComponent(commit || 'unknown');
	return `${root}/api/update/${platform}/${quality}/${h}?channel=latest&noversioncheck=true`;
}

/** 更新源返回体的形状（VS Code win32 更新服务的 response）。 */
export interface IAppUpdateResponse {
	/** 服务端构建的 commit（VS Code 拿它当 `version`）。 */
	readonly version?: string;
	/** 人可读的产品版本（`2.2.26080`）—— 我们**按它**做降级闸门。 */
	readonly productVersion?: string;
	/** 安装包下载地址。 */
	readonly url?: string;
	readonly sha256hash?: string;
}

/** 解析更新源返回体（只认需要的字段；形状不对 ⇒ undefined）。 */
export function parseAppUpdateResponse(raw: unknown): IAppUpdateResponse | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
	const out: IAppUpdateResponse = {
		...(str(o.version) ? { version: str(o.version) } : {}),
		...(str(o.productVersion) ? { productVersion: str(o.productVersion) } : {}),
		...(str(o.url) ? { url: str(o.url) } : {}),
		...(str(o.sha256hash) ? { sha256hash: str(o.sha256hash) } : {}),
	};
	return Object.keys(out).length ? out : undefined;
}
