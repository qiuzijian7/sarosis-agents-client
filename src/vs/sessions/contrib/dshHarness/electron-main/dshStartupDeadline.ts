/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **进度感知的启动截止**（Host 冷启动的等待）。
 *
 * 起因（真机实测，p3-16 抓到的产品缺陷）：原先是一根**固定 60s** 的秒表。但冷机器上 Host 的启动
 * 本身就包含"安装伴生插件（1/3）…"这类**合法耗时**（pnpm 装依赖），实测它正在装第 1 个时就被判超时，
 * 用户看到的是"DeepSeek Harness 启动失败 / Host 在 60 秒内没有就绪"——**明明在动，却报失败**。
 *
 * 改成两个预算：
 * - **安静预算**（`quietMs`，默认与旧的 60s 一致）：多久**没有任何进展**才算卡住；
 * - **总时长上限**（`maxMs`）：无论多有进展，超过它一律失败（否则一个不停刷日志的坏进程能永远吊住 UI）。
 *
 * 纯逻辑、无 I/O：`now` 可注入，便于单测用真实计时器 + 极小毫秒验证（不用假时钟）。
 */
export interface IStartupDeadline {
	/** 有任何进展（进度行 / Host 输出 …）时调用：重置安静预算。 */
	touch(): void;
	/** 结束或已失败时调用：清掉计时器（幂等，可重复调用）。 */
	dispose(): void;
}

export type StartupDeadlineExpiry = 'quiet' | 'max';

export interface IStartupDeadlineOptions {
	/** 多久没有任何进展算卡住。 */
	readonly quietMs: number;
	/** 总时长上限（有进展也不放宽）。 */
	readonly maxMs: number;
	/** 只回调**一次**（后续 touch 不再有意义）。 */
	readonly onExpire: (reason: StartupDeadlineExpiry, detail: { readonly elapsedMs: number }) => void;
	/** 便于测试注入；缺省 `Date.now`。 */
	readonly now?: () => number;
}

export interface IStartupExpiryMessageInput {
	readonly reason: StartupDeadlineExpiry;
	/** 安静预算（毫秒）——只用于文案。 */
	readonly quietMs: number;
	/** 总时长上限（毫秒）——只用于文案。 */
	readonly maxMs: number;
	/** 最后一行日志（调用方负责脱敏）。 */
	readonly lastLine: string;
	/**
	 * 控制桥连接失败的原因（调用方负责脱敏）。
	 *
	 * 为什么要有它：桥连不上时，安静预算到点会报"Host 在 60 秒内没有任何进展"——用户据此去查
	 * "进程是不是卡住了"，而真因是"控制桥没握手"（插件没装上 / Host 内加载失败 / 管道不通）。
	 * 2026-10-11 实测就是这么被误导的：profile 缺官方 `dsh-web-app` ⇒ bridge 永远 pending ⇒
	 * 管道不存在 ⇒ connect ENOENT，而界面只说"没有进展"。
	 */
	readonly bridgeError?: string;
	/**
	 * **本次启动里没装上的插件**（形如 `名称（应 X，实为 Y）`；调用方负责脱敏）。
	 *
	 * 与 `bridgeError` 同因同治（同一条 2026-10-11 实测）：伴生插件装不上时 `_ensurePlugin`
	 * **只写日志并继续**，于是缺包的 profile 最终以"启动超时 / 没有任何进展"收场 ✗ ——
	 * 用户去查"进程卡住 / 网络"，而真因是一个插件没装上（2026-07-26 的 web-app 缺失就是这个形状）。
	 */
	readonly pluginProblems?: readonly string[];
}

/** 文案里最多逐个列出的插件个数（超出的只报总数，避免通知里一堵墙 ✗）。 */
export const MAX_LISTED_PLUGIN_PROBLEMS = 3;

/**
 * 插件缺失清单 → 一句人话（空清单返回空串）。
 *
 * 单独一个函数是为了让人能直接钉住**截断口径**：1 个时列出它；超过 3 个时只说"共 N 个、列前 3 个"，
 * 否则一次启动坏掉 6 个插件时通知会长到没法读 ✗。
 */
export function formatPluginProblems(problems: readonly string[] | undefined): string {
	const list = (problems ?? []).filter(p => typeof p === 'string' && p.trim().length > 0);
	if (list.length === 0) {
		return '';
	}
	const shown = list.slice(0, MAX_LISTED_PLUGIN_PROBLEMS);
	const head = list.length > shown.length
		? `；有 ${list.length} 个插件没装上（只列前 ${shown.length} 个）`
		: `；有 ${list.length} 个插件没装上`;
	return `${head}：${shown.join('、')}（这常是启动失败的真因，详见 Host 日志）`;
}

/**
 * 启动截止到点时的**用户可见文案**（纯函数：脱敏与取"最后一行"都由调用方做完）。
 *
 * 三类原因分开说：`quiet` = 没进展（该查进程），`max` = 有进展但没完没了（该说"等太久了"），
 * 插件没装上 = 可操作的事实；**只要桥连接失败过、或有插件没装上，就一并报出来**。
 */
export function startupExpiryMessage(input: IStartupExpiryMessageInput): string {
	const hint = input.bridgeError ? `；控制桥未握手：${input.bridgeError}` : '';
	const plugins = formatPluginProblems(input.pluginProblems);
	return input.reason === 'max'
		? `Host 启动超过 ${Math.round(input.maxMs / 60_000)} 分钟仍未就绪（有进展但不结束）${hint}${plugins}。最后一行：${input.lastLine}`
		: `Host 在 ${input.quietMs / 1000} 秒内没有任何进展（最后一行：${input.lastLine}）${hint}${plugins}`;
}

export function createStartupDeadline(options: IStartupDeadlineOptions): IStartupDeadline {
	const now = options.now ?? Date.now;
	const startedAt = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expired = false;

	const expire = (reason: StartupDeadlineExpiry): void => {
		if (expired) {
			return;
		}
		expired = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		options.onExpire(reason, { elapsedMs: now() - startedAt });
	};

	const arm = (): void => {
		if (timer) {
			clearTimeout(timer);
		}
		const remainingMax = options.maxMs - (now() - startedAt);
		if (remainingMax <= 0) {
			expire('max');
			return;
		}
		// 分类按"**这次是被哪个预算武装的**"，而不是到点后现算 `now()`：
		// 定时器**可能提前触发**（实测 60ms 的上限会在 59ms 到点）⇒ 现算会把"总时长用完"误报成
		// "没有进展"，而后者让人去查进程状态（明明只是"等太久了"）。真机与单测都栽在这个 1ms 上。
		const kind: StartupDeadlineExpiry = remainingMax < options.quietMs ? 'max' : 'quiet';
		timer = setTimeout(() => {
			timer = undefined;
			expire(kind);
		}, Math.min(options.quietMs, remainingMax));
	};

	arm();

	return {
		touch: () => {
			if (!expired) {
				arm();
			}
		},
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
