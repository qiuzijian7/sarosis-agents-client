// @vssaros/dsh-codebase — watcher：**影子的常驻保鲜**（P4，2026-10-12）。
//
// 为什么必须有它（而不是"让用户记得手点一次 `codebase_index`"✗）：影子产物一旦过期，
// 读侧不但给你旧图，还会**优先**给你旧图（P1 的"影子优先"）—— P3-b 的新鲜度纪律只能挡住
// "IDE 也更新过"那种情况；**用户改了代码、两边都没重算**时，唯一诚实的答案就是"把它重算" ✓。
// 所以这一层是把"影子索引"从**工具**变成**能力**的最后一块 ✓。
//
// ## 五条纪律（每条都对应一种"悄悄坏掉"）
//
//   ① **缺省不启用** ✓（`config.indexWatch === true` 才起）—— 常驻监听是资源，装上来就偷偷 `fs.watch`
//      整仓是越界 ✓；没启用时状态里要能说出"为什么没启用" ✓。
//   ② **合并抖动**：一次保存常触发多事件（写临时文件 + rename ✓）⇒ 去抖；但**上限**必须有
//      （`maxDebounceMs`）—— 否则"一直在编辑"的仓库会**永远不索引** ✗。
//   ③ **绝不并发**：上一轮没跑完就不再开一轮（`run` 串行化 ✓）—— 两个索引撞同一把锁只会互相干扰 ✓
//      （拿不到锁 = 别人在写 ⇒ 记下来、等下一次事件，**不排队死等** ✓）。
//   ④ **不看自己**：产物目录与常见生成目录的事件一律忽略 ✓（否则"索引写产物 ⇒ 触发事件 ⇒ 再索引"自激 ✗）。
//   ⑤ **可停**：`stop()` 关掉所有 watcher 与定时器 ✓（`fs.watch` 不跟着插件消失 ✗，与 worker_threads 同理 ✓）。
//
// ⚠ 平台差异如实处理：`fs.watch({ recursive: true })` 在 Windows/macOS 原生支持，Linux 上 Node 20+ 也支持，
//   但**不保证**（也取决于文件系统）⇒ 起不来的话**退化成"只盯一层"**（`mode: 'shallow'`）并**如实报出** ✓，
//   而不是静默地少看一半目录 ✗。

import { watch } from 'node:fs';
import { sep } from 'node:path';

/** 一次变更之后等多久才动手（合并连续保存 ✓）。 */
export const DEFAULT_DEBOUNCE_MS = 5_000;
/** 一直有变更时的**兜底上限**：到点照样跑一轮，免得"永远在编辑"⇒"永远不索引" ✗。 */
export const DEFAULT_MAX_DEBOUNCE_MS = 60_000;
/**
 * 与 indexer.js 的 `SKIP_DIRS` **同义**（重复一份是有意的：两层判据各自独立 ✓）。
 * ⚠ 这份名单**不能被裁剪**成"只忽略产物目录"✗ —— 它必须覆盖索引器**不扫**的那些目录，
 * 否则会出现"改了 node_modules 触发一轮索引、而索引结果一点没变"这种白跑（噪声 ✓）。
 */
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'dsh-runtime', '.vscode-test', '.codebase-memory']);

/**
 * 这个路径值得看一眼吗？（`relPath` 用 `/` 分隔 ✓）
 *
 * ⚠ 两条判据都不能省（都是**实测**出来的）：
 *   ① 按**路径段**精确匹配，不是子串 —— 子串会把 `outline.ts` 也当 `out/` ✗；
 *   ② **最后一段也要查名单**：`fs.watch` 在 Windows 递归模式下会报出"只到目录"的路径
 *      （创建 `node_modules/dep.js` 时报 `node_modules` ✓）—— 第一版只查目录段 ⇒ 这种事件**漏过**
 *      ⇒ "改 node_modules 也触发一轮索引"（本探针当场抓到 ✓ 白跑噪声）。
 *   ③ 隐藏段（`.` 开头）与产物临时文件（`.tmp-<pid>-<rand>`）同样忽略 ✓（④ 自激的主要来源）。
 */
export function shouldIgnoreRelPath(relPath) {
	const segments = String(relPath ?? '').split('/').filter(Boolean);
	if (segments.length === 0) {
		return false;
	}
	for (const segment of segments.slice(0, -1)) {
		if (IGNORED_SEGMENTS.has(segment) || segment.startsWith('.')) {
			return true;
		}
	}
	const name = segments.at(-1);
	return IGNORED_SEGMENTS.has(name) || name.startsWith('.') || /\.tmp-\d+-[0-9a-f]+$/.test(name);
}

/**
 * 建一个影子保鲜 watcher。**`run` 是注入的**（`() => runShadowIndex(...)` ✓）—— 这样它的时序逻辑
 * 可以在探针里用假 run 精确验证（不用起真索引、不用等真解析 ✓）。
 *
 * @returns `{ start, stop, state }`；`state` 是可展示的实时状态（页面/状态工具都读它 ✓）
 */
export function createShadowWatcher(config, {
	root,
	run,
	debounceMs = DEFAULT_DEBOUNCE_MS,
	maxDebounceMs = DEFAULT_MAX_DEBOUNCE_MS,
	ignored = shouldIgnoreRelPath,
	now = () => Date.now(),
	onLog = () => { },
} = {}) {
	const state = {
		active: false,
		mode: 'none',
		debounceMs,
		maxDebounceMs,
		root,
		watchers: 0,
		events: 0,
		ignored: 0,
		runs: 0,
		lastRunAt: undefined,
		lastRunMs: undefined,
		lastRunOk: undefined,
		lastRunKind: undefined,
		lastRunError: undefined,
		pendingSince: undefined,
		firstEventAt: undefined,
		startedAt: undefined,
		error: undefined,
	};
	let handles = [];
	let timer;
	let running = false;
	let stopped = false;

	const clearTimer = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	async function fire() {
		clearTimer();
		if (stopped) {
			return;
		}
		if (running) {
			// ⚠⚠ 这里**不能直接 return**（第一版就是直接返回，p3-42 当场抓到 ✗）：那会把"这次变更"**丢掉** ——
			// 要等下一个事件才会再被看见，而下一个事件可能很久以后才有（用户改完就切走了 ✓）⇒ 影子一直旧 ✗。
			// 也不能用 `delay 0` 立刻重试：那会在"长 run + 持续变更"时变成**忙循环** ✗ ⇒ 固定隔一个去抖周期再看 ✓。
			timer = setTimeout(() => { void fire(); }, Math.max(50, debounceMs));
			if (typeof timer.unref === 'function') {
				timer.unref();
			}
			return;
		}
		running = true;
		const startedAt = now();
		state.pendingSince = undefined;
		state.firstEventAt = undefined;
		try {
			const got = await run();
			state.lastRunOk = got?.ok !== false;
			state.lastRunKind = got?.kind;
			state.lastRunError = got?.ok === false ? String(got.why ?? '').slice(0, 200) : undefined;
		} catch (e) {
			state.lastRunOk = false;
			state.lastRunError = String(e?.message ?? e).slice(0, 200);
		} finally {
			running = false;
			state.runs += 1;
			state.lastRunAt = startedAt;
			state.lastRunMs = now() - startedAt;
		}
	}

	/** 收到一个"值得管"的事件：安排一轮索引（去抖 + 上限 ✓）。 */
	function schedule() {
		if (stopped) {
			return;
		}
		const at = now();
		if (state.firstEventAt === undefined) {
			state.firstEventAt = at;
		}
		if (state.pendingSince === undefined) {
			state.pendingSince = at;
		}
		const waited = at - state.firstEventAt;
		// 已经在编辑很久了（超过上限）⇒ 别等了，这一轮先跑 ✓
		const delay = waited >= maxDebounceMs ? 0 : debounceMs;
		clearTimer();
		timer = setTimeout(() => { void fire(); }, delay);
		if (typeof timer.unref === 'function') {
			timer.unref(); // 别让一个待跑的定时器把进程吊住（Host 里很要紧 ✓）
		}
	}

	function onEvent(eventType, filename) {
		state.events += 1;
		const rel = filename ? String(filename).split(sep).join('/') : '';
		// `filename` 可能为 null（某些平台/某些事件 ✓）⇒ 那种情况下**不能**当成"忽略"（宁可多跑一轮 ✓）
		if (rel && ignored(rel)) {
			state.ignored += 1;
			return;
		}
		schedule();
	}

	function attach(path, recursive) {
		const handle = watch(path, { recursive }, onEvent);
		handle.on('error', error => {
			state.error = `watcher 出错（${path}）：${String(error?.message ?? error).slice(0, 160)}`;
		});
		handles.push(handle);
	}

	return {
		state,
		start() {
			if (state.active || stopped) {
				return state;
			}
			try {
				attach(root, true);
				state.mode = 'recursive';
			} catch (e) {
				// ⚠ 退化成"只盯一层"，并**如实报出**（宁可少看，也不能假装看得全 ✗）
				state.error = `递归监听不可用（${String(e?.message ?? e).slice(0, 120)}）⇒ 退化为只盯一层`;
				state.mode = 'shallow';
				try {
					attach(root, false);
				} catch (e2) {
					state.error = `连一层都监听不起来：${String(e2?.message ?? e2).slice(0, 160)}`;
					state.mode = 'none';
				}
			}
			state.active = handles.length > 0;
			state.watchers = handles.length;
			state.startedAt = now();
			onLog(`影子保鲜开始监听 ${root}（mode=${state.mode}，去抖 ${debounceMs}ms）`);
			return state;
		},
		stop() {
			stopped = true;
			clearTimer();
			for (const handle of handles) {
				try {
					handle.close();
				} catch { /* 已经关了就算了 ✓ */ }
			}
			handles = [];
			state.active = false;
			state.watchers = 0;
			state.pendingSince = undefined;
			return state;
		},
		/** 探针/测试用：把当前状态转成可展示的摘要（生产路径上页面与状态工具用同一份 ✓）。 */
		snapshot() {
			return { ...state };
		},
	};
}

/** 页面/状态工具读的摘要（只挑"人能看懂 + 机器能断言"的那些 ✓）。 */
export function watchSummaryOf(watcher) {
	if (!watcher) {
		return { active: false, why: '未启用（`config.indexWatch` 不是 true）' };
	}
	const state = watcher.state ?? watcher;
	return {
		active: state.active === true,
		mode: state.mode,
		debounceMs: state.debounceMs,
		watchers: state.watchers,
		events: state.events,
		ignored: state.ignored,
		runs: state.runs,
		...(state.pendingSince !== undefined ? { pendingSince: state.pendingSince } : {}),
		...(state.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt, lastRunMs: state.lastRunMs, lastRunOk: state.lastRunOk, lastRunKind: state.lastRunKind } : {}),
		...(state.lastRunError ? { lastRunError: state.lastRunError } : {}),
		...(state.error ? { error: state.error } : {}),
	};
}
