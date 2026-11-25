/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ★ 2026-11-23：版本比较收敛到 common/dshVersion.ts（含预发布口径）；保留同名导出，调用方不变。
import { compareVersions as compareSemver, parseVersion } from './dshVersion.js';
export { compareVersions } from './dshVersion.js';

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
	/** 更新源与本地相同 ⇒ 已是最新 */
	| 'uptodate'
	/** 更新源比本地更旧 ⇒ 禁止降级 */
	| 'downgrade'
	/** 缺失或无法识别的版本 ⇒ 无法确定，不允许升级 */
	| 'unknown';

/** 只有有效的远程版本严格高于本地才允许升级；无效数据不能判为已最新。 */
export function decideAppUpdate(local: string, remote: string | undefined): AppUpdateAction {
	const r = String(remote ?? '').trim();
	if (!parseVersion(local) || !parseVersion(r)) {
		return 'unknown';
	}
	const cmp = compareSemver(r, local);
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
	return toAppUpdateCheckUrl(`${root}/api/update/${platform}/${quality}/${h}`);
}

/** 保留原生更新服务的安装渠道和查询参数，仅关闭服务端 commit 比较。 */
export function toAppUpdateCheckUrl(feedUrl: string): string {
	const url = new URL(feedUrl);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('更新源必须使用 HTTP(S)');
	}
	url.searchParams.set('channel', 'latest');
	url.searchParams.set('noversioncheck', 'true');
	return url.toString();
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
	/**
	 * 更新日志（2026-11-05，复刻 dsh-desktop 的「查看详情」）。
	 * 更新源可不提供；UI 拿不到时回落「此版本暂无更新日志」。**纯文本**，不许当 HTML 渲染。
	 */
	readonly notes?: string;
	/**
	 * ★ 2026-11-23（P1 升级策略）：更新源**可选**的最低可运行版本与灰度百分比。
	 * 老服务端不返回这两个字段 ⇒ 全量、不强制，行为与改造前一致 ✓。
	 */
	readonly minVersion?: string;
	readonly rolloutPercent?: number;
}

/** 解析更新源返回体（只认需要的字段；形状不对 ⇒ undefined）。 */
export function parseAppUpdateResponse(raw: unknown): IAppUpdateResponse | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
	const notes = str(o.notes);
	const minVersion = str(o.minVersion);
	const rolloutPercent = typeof o.rolloutPercent === 'number' && Number.isFinite(o.rolloutPercent)
		? Math.min(100, Math.max(0, Math.round(o.rolloutPercent))) : undefined;
	const out: IAppUpdateResponse = {
		...(str(o.version) ? { version: str(o.version) } : {}),
		...(str(o.productVersion) ? { productVersion: str(o.productVersion) } : {}),
		...(str(o.url) ? { url: str(o.url) } : {}),
		...(str(o.sha256hash) ? { sha256hash: str(o.sha256hash) } : {}),
		...(notes ? { notes: notes.slice(0, 20_000) } : {}),
		...(minVersion ? { minVersion } : {}),
		...(rolloutPercent !== undefined ? { rolloutPercent } : {}),
	};
	return Object.keys(out).length ? out : undefined;
}
