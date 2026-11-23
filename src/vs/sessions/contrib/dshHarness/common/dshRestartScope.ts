/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **重启生效范围**的统一判据（2026-11-23，纯逻辑、零 IO）。
 *
 * 评估里指出的真问题：升级入口有 5 处，而「重启生效」有三种互不相干的含义 ——
 *   ① 应用安装包 `quitAndInstall()` ⇒ 关闭并重启**整个 IDE**，会话中断；
 *   ② 随包插件经 `dsh plugin add` 落 profile ⇒ 要重启 **dsh Host** 才加载；
 *   ③ 商城资产 / 回滚只改数据根 ⇒ **刷新页面**即可，重启 IDE 纯属多余。
 * 过去这些差异只散落在按钮文案与注释里，用户无从判断，面板也不知道该提示什么。
 *
 * ⇒ 收敛成一个随 `IDshUpgradeState` 推送的 `restart` 投影：宿主按当前状态算一次，
 *   IDE 面板与 dsh 页面都只做投影，不各自猜。
 *
 * 优先级（强 → 弱）：`ide` > `host` > `refresh` > `none`；
 * 任务还在跑 / 全失败（没有生效的变更）⇒ `none`，不误导。
 * ⚠ `pending` 为 true 时 UI 才显示这一行，避免常态刷屏。
 */

export type RestartScope = 'none' | 'refresh' | 'host' | 'ide';

export interface IRestartPlan {
	readonly scope: RestartScope;
	/** 简短结论，如「需要重启 VsSaros」。 */
	readonly label: string;
	/** 一句人话：为什么要这个范围 / 会中断什么。 */
	readonly detail: string;
	/** 是否有待生效的变更；false 时 UI 不显示。 */
	readonly pending: boolean;
}

export interface IRestartInput {
	/** 应用更新 8 相；`downloaded` 表示安装包已就绪。 */
	readonly appPhase?: string;
	/** 应用升级的 busy 态；`installing` 也意味着即将重启 IDE。 */
	readonly appBusy?: string;
	readonly jobStatus?: 'running' | 'done' | 'failed';
	readonly jobDone?: number;
	readonly jobFailed?: number;
	readonly jobItems?: readonly { readonly kind: string; readonly status: string }[];
	/** 刚在商城页做过回滚（数据根被换回旧版）。 */
	readonly rollback?: boolean;
}

const SCOPES: readonly RestartScope[] = ['none', 'refresh', 'host', 'ide'];

const PLAN: Record<RestartScope, { label: string; detail: string }> = {
	none: { label: '无需重启', detail: '当前没有待生效的变更。' },
	refresh: { label: '刷新页面即可', detail: '变更只落在数据根，刷新页面或重新打开工作台就能看到新版本，不必重启 IDE。' },
	host: { label: '需要重启 dsh Host', detail: '随包插件经 dsh plugin add 装入 profile，重启 dsh Host 后才会加载新版本（IDE 主窗口不用重启）。' },
	ide: { label: '需要重启 VsSaros', detail: '应用安装包已就绪，点「重新启动并安装」会关闭并重启整个 IDE，当前会话将中断。' },
};

export function decideRestartScope(input: IRestartInput): IRestartPlan {
	const plan = (scope: RestartScope, pending = true, override?: string): IRestartPlan => ({
		scope,
		label: PLAN[scope].label,
		detail: override ?? PLAN[scope].detail,
		pending,
	});

	// ① 应用安装包就绪 / 正在安装 ⇒ 整个 IDE 重启（最高优先，会话会中断）
	if (input.appPhase === 'downloaded' || input.appBusy === 'installing') {
		return plan('ide');
	}

	// ② 批量升级任务：只有真正成功落盘的项才产生「待生效」变更
	const done = Number(input.jobDone ?? 0);
	const failed = Number(input.jobFailed ?? 0);
	if (input.jobStatus && input.jobStatus !== 'running' && done > failed) {
		const items = Array.isArray(input.jobItems) ? input.jobItems : [];
		const succeededBundled = items.some(i => i && i.kind === 'bundled' && i.status === 'done');
		return plan(succeededBundled ? 'host' : 'refresh');
	}

	// ③ 商城页回滚：数据根被换回旧版，刷新即可
	if (input.rollback) {
		return plan('refresh', true, '已恢复到升级前的备份，刷新页面后生效；当前版本已留档，可再次回滚。');
	}

	return plan('none', false);
}

/** 信任边界：投影穿过主进程再推给页面，逐字段白名单重建。 */
export function validateRestartPlan(value: unknown): IRestartPlan | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	const scope = SCOPES.includes(v.scope as RestartScope) ? v.scope as RestartScope : undefined;
	if (!scope) {
		return undefined;
	}
	return {
		scope,
		label: typeof v.label === 'string' ? v.label.slice(0, 120) : PLAN[scope].label,
		detail: typeof v.detail === 'string' ? v.detail.slice(0, 500) : PLAN[scope].detail,
		pending: v.pending === true,
	};
}
