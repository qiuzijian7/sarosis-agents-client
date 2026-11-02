/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 多实例 Host 复用（方案第 7.5 节）：第一个 VsSaros 实例启动 Host 后把连接信息写进
 * `$DSH_HOME/host.json`（端口、pid、版本、profile、控制桥管道与 token），后续实例先探活，
 * 通过就直接复用；版本不同或探活失败才另起 Host。
 *
 * 本文件是纯逻辑：租约的解析与"能否复用"的判定。文件读写与探活在 electron-main 层。
 */

export interface IDshHostLease {
	readonly format: 1;
	/** 拥有者（拉起 Host 的那个 VsSaros 主进程）的 pid。 */
	readonly pid: number;
	/** 视图加载用的源与带 token 的完整地址。 */
	readonly origin: string;
	readonly authUrl: string;
	readonly dshVersion: string;
	readonly profile: string;
	/** 控制桥命名管道与 `client.register` 用 token；无桥时缺省。 */
	readonly pipe?: string;
	readonly bridgeToken?: string;
	readonly instanceId: string;
	readonly startedAt: number;
}

/** 解析 host.json；结构不完整一律视为无效（调用方按"没有租约"处理）。 */
export function parseHostLease(text: string): IDshHostLease | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	if (!o || typeof o !== 'object' || o.format !== 1) {
		return undefined;
	}
	if (typeof o.pid !== 'number' || o.pid <= 0
		|| typeof o.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(o.origin)
		|| typeof o.authUrl !== 'string' || !o.authUrl.startsWith(o.origin)
		|| typeof o.dshVersion !== 'string' || !o.dshVersion
		|| typeof o.profile !== 'string' || !o.profile
		|| typeof o.instanceId !== 'string' || !o.instanceId
		|| typeof o.startedAt !== 'number') {
		return undefined;
	}
	if ((o.pipe !== undefined && typeof o.pipe !== 'string') || (o.bridgeToken !== undefined && typeof o.bridgeToken !== 'string')) {
		return undefined;
	}
	return o as unknown as IDshHostLease;
}

/**
 * 复用阻断原因；返回 undefined 表示可以复用。
 * 只判定静态条件（版本、profile）；pid/HTTP 探活由调用方做。
 */
export function hostLeaseBlocker(lease: IDshHostLease, want: { readonly dshVersion: string; readonly profile: string }): string | undefined {
	if (lease.dshVersion !== want.dshVersion) {
		return `dsh 版本不同（运行中 ${lease.dshVersion}，本实例要用 ${want.dshVersion}）`;
	}
	if (lease.profile !== want.profile) {
		return `profile 不同（运行中 ${lease.profile}，本实例要用 ${want.profile}）`;
	}
	return undefined;
}

/** 插件文件写盘时间与 Host 启动时间的容差：吸收 FS 时间戳粒度与"装完立刻起 Host"的同秒竞争。 */
export const PLUGIN_STALE_TOLERANCE_MS = 2_000;

/**
 * "运行中的 Host 内存里是旧插件代码"的判定；返回 undefined 表示没有证据说它旧。
 *
 * 背景（2026-11-02 真机）：`_pluginsStale` 只活在**拉起安装的那个 supervisor 进程**的内存里。
 * 装完插件后 app 重启 ⇒ 新进程不知道刚装过 ⇒ 照样接管旧 Host（`reusing the Host started by pid …`）
 * ⇒ 磁盘上是新代码、Host 跑的是旧代码，而且**没有任何提示**（那次排查的探针整轮没执行）。
 * ⇒ 改用一个**跨进程都成立**的事实：profile 里插件文件的最新写盘时间晚于租约的 `startedAt`
 *   （`startedAt` 是 Host 就绪时写下的，复用时不刷新 ⇒ 它就是"那份内存代码的出生时间"）。
 *
 * @param newest 本次扫描到的最新插件文件（路径只用于日志，便于排查误判）；undefined = 没扫到任何文件。
 */
export function staleHostByPluginFiles(lease: IDshHostLease, newest: { readonly path: string; readonly mtimeMs: number } | undefined, toleranceMs: number = PLUGIN_STALE_TOLERANCE_MS): string | undefined {
	if (!newest || !Number.isFinite(newest.mtimeMs) || !Number.isFinite(lease.startedAt)) {
		return undefined;
	}
	if (newest.mtimeMs <= lease.startedAt + toleranceMs) {
		return undefined;
	}
	const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
	return `profile 里的插件文件比运行中的 Host 新（Host 启动 ${fmt(lease.startedAt)}Z，最新文件 ${fmt(newest.mtimeMs)}Z：${newest.path}）`
		+ ' ⇒ 它内存里跑的是旧插件代码';
}
