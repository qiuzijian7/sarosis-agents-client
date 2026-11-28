/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * desktop-only 启动覆盖层的**阶段时间线**（纯数据，不碰 DOM / electron ⇒ 可被单测）。
 *
 * 背景：原来壳里只有一行 `showBooting('正在准备 dsh 运行环境…')` 的 `textContent`，
 * 首启几十秒（profile 种子复制 / 伴生插件直装 / 下载托管 Node / 拉起 Host）里用户既不知道
 * 卡在哪一步，也不知道已经等了多久，只能看到最后抛出来的错误。
 *
 * 这里把启动拆成固定阶段，每个阶段再按主进程 `OnDidProgress` 的文本切出子步骤，
 * 逐个记录开始/结束时间；渲染层（`dshDesktop.ts`）只负责把 `view()` 画成 DOM。
 * 时间点可以由构造函数注入，测试不需要真的等墙钟。
 */

export type BootStageId = 'shell' | 'view' | 'runtime' | 'ui';
export type BootStageState = 'pending' | 'running' | 'done' | 'failed';

export interface IBootStageDefinition {
	readonly id: BootStageId;
	readonly label: string;
	/** 常驻说明：这一步在做什么、为什么可能慢、卡住意味着什么。 */
	readonly detail: string;
}

/**
 * 顺序即启动顺序。改这里等于改 UI 上的阶段清单，**不要**在渲染层另立一份名单。
 */
export const BOOT_STAGES: readonly IBootStageDefinition[] = [
	{
		id: 'shell',
		label: '初始化窗口',
		detail: '连接主进程 IPC、认领唯一的桌面窗口；已经有一扇桌面窗口时，本窗口不会重复创建。',
	},
	{
		id: 'view',
		label: '准备桌面视图',
		detail: '预建独立网络分区的页面视图并绑定窗口尺寸；视图槽先就位，后台服务一就绪就立刻加载页面。',
	},
	{
		id: 'runtime',
		label: '准备运行环境',
		detail: '校验随包的 dsh 与 Node（机器上没有 Node 时会下载约 30 MB 便携版并校验 SHA-256）；首次启动还要从内置副本初始化 profile、安装伴生插件并拉起 Host 进程，通常是耗时最长的一步。',
	},
	{
		id: 'ui',
		label: '加载桌面界面',
		detail: '等待 dsh 页面的换皮锚点出现，最多等 5 秒；即使超时也会直接显示页面，不会一直卡住。',
	},
];

/** 当前阶段停留超过这个时长，UI 就提示「去哪看日志」。 */
export const BOOT_STUCK_HINT_MS = 15_000;

export interface IBootStepView {
	readonly label: string;
	readonly elapsedMs: number;
	readonly running: boolean;
}

export interface IBootStageView extends IBootStageDefinition {
	readonly state: BootStageState;
	/** running 是从开始到「现在」的实时耗时；done/failed 是冻结值；pending 为 0。 */
	readonly elapsedMs: number;
	readonly steps: readonly IBootStepView[];
}

export interface IBootView {
	readonly stages: readonly IBootStageView[];
	readonly totalMs: number;
	readonly runningStageId: BootStageId | undefined;
	readonly runningStageMs: number;
	readonly message: string;
	readonly finished: boolean;
	readonly failed: boolean;
}

/** 启动面板里给人看的时间：<1s 用毫秒， thereafter 秒 / 分。 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return '—';
	}
	if (ms < 1_000) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000).toString().padStart(2, '0');
	return `${minutes}m${seconds}s`;
}

interface IBootStep {
	label: string;
	startedAt: number;
	elapsedMs?: number;
}

interface IBootStageEntry extends IBootStageDefinition {
	state: BootStageState;
	startedAt?: number;
	elapsedMs?: number;
	steps: IBootStep[];
}

export class BootTimeline {
	private readonly _t0: number;
	private readonly _stages: IBootStageEntry[];
	private _message = '正在启动 dsh 桌面窗口…';
	private _finished = false;
	private _failed = false;
	private _totalFrozen: number | undefined;

	constructor(private readonly _now: () => number = () => Date.now()) {
		this._t0 = this._now();
		this._stages = BOOT_STAGES.map(s => ({ ...s, state: 'pending' as const, steps: [] }));
	}

	private _stage(id: BootStageId): IBootStageEntry {
		const stage = this._stages.find(s => s.id === id);
		if (!stage) {
			throw new Error(`unknown boot stage: ${id}`);
		}
		return stage;
	}

	private _running(): IBootStageEntry | undefined {
		return this._stages.find(s => s.state === 'running');
	}

	/** 结算阶段与它最后一条子步骤，耗时从此冻结。 */
	private _end(stage: IBootStageEntry, at: number): void {
		const last = stage.steps[stage.steps.length - 1];
		if (last && last.elapsedMs === undefined) {
			last.elapsedMs = Math.max(0, at - last.startedAt);
		}
		stage.elapsedMs = stage.startedAt === undefined ? 0 : Math.max(0, at - stage.startedAt);
	}

	/** 进入阶段；上一个仍在 running 的阶段自动完成，界面上永远只有一个「进行中」。 */
	begin(id: BootStageId, at: number = this._now()): void {
		if (this._finished || this._failed) {
			return;
		}
		const stage = this._stage(id);
		// 幂等：已开始 / 已结束的阶段不重置计时。
		if (stage.state !== 'pending') {
			return;
		}
		const previous = this._running();
		if (previous) {
			this._end(previous, at);
			previous.state = 'done';
		}
		stage.state = 'running';
		stage.startedAt = at;
	}

	/**
	 * 主进程 `OnDidProgress` 的一行文本 ⇒ 当前阶段的一个子步骤。
	 * 上一条子步骤的耗时就此结算，于是「卡在哪条进度上」和「每条进度花了多久」都能看见。
	 * 同一文案连发两次时合并，不制造 0ms 的重复行。
	 */
	note(text: string, at: number = this._now()): void {
		const label = String(text ?? '').trim();
		if (!label || this._finished || this._failed) {
			return;
		}
		const stage = this._running();
		if (!stage) {
			return;
		}
		const last = stage.steps[stage.steps.length - 1];
		if (last?.label === label) {
			return;
		}
		if (last && last.elapsedMs === undefined) {
			last.elapsedMs = Math.max(0, at - last.startedAt);
		}
		stage.steps.push({ label, startedAt: at });
	}

	/** 显式结束阶段（下一个 begin 也会自动结束它，这里给最后一步用）。 */
	complete(id: BootStageId, at: number = this._now()): void {
		const stage = this._stage(id);
		if (stage.state === 'running') {
			this._end(stage, at);
			stage.state = 'done';
		}
	}

	/** 顶层消息（正常进度文案 / 失败原因），由渲染层显示在卡片头部。 */
	setMessage(message: string): void {
		this._message = String(message ?? '');
	}

	/** 失败：当前阶段标红并冻结耗时，面板不再自动消失。 */
	failCurrent(message: string, at: number = this._now()): void {
		if (this._finished) {
			return;
		}
		const stage = this._running();
		if (stage) {
			this._end(stage, at);
			stage.state = 'failed';
		}
		this._failed = true;
		this._message = message;
		this._totalFrozen = Math.max(0, at - this._t0);
	}

	/** 全部完成：冻结总耗时，供面板展示「各阶段耗时」汇总。 */
	finish(message: string, at: number = this._now()): void {
		if (this._finished || this._failed) {
			return;
		}
		const stage = this._running();
		if (stage) {
			this._end(stage, at);
			stage.state = 'done';
		}
		this._finished = true;
		this._message = message;
		this._totalFrozen = Math.max(0, at - this._t0);
	}

	view(at: number = this._now()): IBootView {
		const stages: IBootStageView[] = this._stages.map(stage => {
			const running = stage.state === 'running';
			return {
				id: stage.id,
				label: stage.label,
				detail: stage.detail,
				state: stage.state,
				elapsedMs: running ? Math.max(0, at - (stage.startedAt ?? at)) : (stage.elapsedMs ?? 0),
				steps: stage.steps.map(step => ({
					label: step.label,
					elapsedMs: step.elapsedMs ?? Math.max(0, at - step.startedAt),
					running: step.elapsedMs === undefined,
				})),
			};
		});
		const runningStage = this._running();
		return {
			stages,
			totalMs: this._totalFrozen ?? Math.max(0, at - this._t0),
			runningStageId: runningStage?.id,
			runningStageMs: runningStage ? Math.max(0, at - (runningStage.startedAt ?? at)) : 0,
			message: this._message,
			finished: this._finished,
			failed: this._failed,
		};
	}
}
