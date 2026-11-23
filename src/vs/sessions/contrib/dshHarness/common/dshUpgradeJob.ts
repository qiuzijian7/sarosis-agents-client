/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「全部升级」的**任务状态机**（2026-11-23，纯逻辑、零 IO）。
 *
 * 之前的问题：批量升级只有 `_upgradeBusy` 一个布尔，页面/IDE 面板只知道「在跑」，
 * 不知道第几项、哪一项失败、失败原因是什么；失败通知还只汇总前 3 条。IDE 面板与 dsh 页面
 * 各自 for 循环下发 N 条命令 ⇒ 同一个 profile 被并发写（pnpm 锁竞争 + 半装）。
 *
 * ⇒ 收敛成宿主侧一个 job：`jobId` + 逐项状态 + 失败原因，每完成一项就把 job 放进
 *   `IDshUpgradeState` 快照推给所有视图；「重试」就是再发一次 `upgradeAll`
 *   （宿主从当前清单重算，失败项仍在里面 ✓）。
 *
 * ⚠ 本文件只管状态推进，不碰 IPC / 文件系统；编排的串行执行在
 *   `dshHarnessService.upgradeAll()`（那里才拿得到插件中心与商城服务）。
 */

export type UpgradeJobItemKind = 'bundled' | 'asset';
export type UpgradeJobItemStatus = 'pending' | 'running' | 'done' | 'failed';
export type UpgradeJobStatus = 'running' | 'done' | 'failed';

export interface IUpgradeJobSpec {
	readonly kind: UpgradeJobItemKind;
	/** 任务内唯一键：随包插件用包名，商城资产用 `kind/slug`。 */
	readonly key: string;
	readonly label: string;
}

export interface IUpgradeJobItem {
	readonly kind: UpgradeJobItemKind;
	readonly key: string;
	readonly label: string;
	readonly status: UpgradeJobItemStatus;
	readonly error?: string;
}

/** 推给页面的 job 投影（全量、可序列化；页面只读）。 */
export interface IUpgradeJobState {
	readonly id: number;
	readonly status: UpgradeJobStatus;
	readonly total: number;
	/** 已结束的项数（成功 + 失败）。 */
	readonly done: number;
	readonly failed: number;
	readonly current?: string;
	readonly items: readonly IUpgradeJobItem[];
}

export function createUpgradeJob(id: number, specs: readonly IUpgradeJobSpec[]): IUpgradeJobState {
	return {
		id,
		status: 'running',
		total: specs.length,
		done: 0,
		failed: 0,
		items: specs.map(s => ({ kind: s.kind, key: s.key, label: s.label, status: 'pending' as const })),
	};
}

export function startUpgradeJobItem(job: IUpgradeJobState, key: string): IUpgradeJobState {
	return {
		...job,
		current: key,
		items: job.items.map(i => i.key === key && i.status === 'pending' ? { ...i, status: 'running' as const } : i),
	};
}

/** 幂等：同一项重复回执不会把 done/failed 数错。 */
export function finishUpgradeJobItem(job: IUpgradeJobState, key: string, ok: boolean, error?: string): IUpgradeJobState {
	let changed = false;
	const items = job.items.map(i => {
		if (i.key !== key || i.status === 'done' || i.status === 'failed') {
			return i;
		}
		changed = true;
		return {
			...i,
			status: (ok ? 'done' : 'failed') as UpgradeJobItemStatus,
			...(ok || !error ? {} : { error: String(error).slice(0, 300) }),
		};
	});
	if (!changed) {
		return { ...job, current: undefined };
	}
	return {
		...job,
		items,
		done: job.done + 1,
		failed: job.failed + (ok ? 0 : 1),
		current: undefined,
	};
}

export function finishUpgradeJob(job: IUpgradeJobState): IUpgradeJobState {
	return { ...job, status: job.failed > 0 ? 'failed' : 'done', current: undefined };
}

/** 面板/通知用的一行人话；失败数比「已完成 N 项」更能说明要做什么。 */
export function upgradeJobSummary(job: IUpgradeJobState): string {
	if (job.status === 'running') {
		return `升级 ${job.done}/${job.total}${job.current ? `：${job.current}` : ''}`;
	}
	if (job.failed > 0) {
		return `有 ${job.failed} 项没升成（共 ${job.total} 项）`;
	}
	return `全部完成（${job.total} 项）`;
}

/**
 * 信任边界：job 随 `IDshUpgradeState` 穿过主进程再推给页面，字段必须逐项白名单重建。
 * 只认形状，值域超了就丢（宁可少显示一行，也不要把脏数据写进 dataset）。
 */
export function validateUpgradeJobState(value: unknown): IUpgradeJobState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== 'number' || !Number.isFinite(v.id)) {
		return undefined;
	}
	const status = v.status === 'running' || v.status === 'done' || v.status === 'failed' ? v.status : undefined;
	if (!status || !Array.isArray(v.items)) {
		return undefined;
	}
	const items: IUpgradeJobItem[] = [];
	for (const raw of v.items.slice(0, 100)) {
		const i = raw as Record<string, unknown> | null;
		if (!i || typeof i !== 'object') {
			continue;
		}
		const kind = i.kind === 'bundled' || i.kind === 'asset' ? i.kind : undefined;
		const itemStatus = i.status === 'pending' || i.status === 'running' || i.status === 'done' || i.status === 'failed' ? i.status : undefined;
		if (!kind || !itemStatus || typeof i.key !== 'string' || !i.key) {
			continue;
		}
		items.push({
			kind,
			key: i.key.slice(0, 200),
			label: typeof i.label === 'string' ? i.label.slice(0, 200) : i.key.slice(0, 200),
			status: itemStatus,
			...(typeof i.error === 'string' && i.error ? { error: i.error.slice(0, 300) } : {}),
		});
	}
	const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0;
	return {
		id: Math.max(0, Math.floor(v.id)),
		status,
		total: num(v.total),
		done: num(v.done),
		failed: num(v.failed),
		...(typeof v.current === 'string' && v.current ? { current: v.current.slice(0, 200) } : {}),
		items,
	};
}
