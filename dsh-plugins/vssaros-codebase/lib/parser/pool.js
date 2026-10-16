// @vssaros/dsh-codebase — parser/pool：解析器**门面**（资产解析 + worker 生命周期 + 超时 + 可观测）。
//
// 这一层是"页面/工具/探针"唯一该碰的入口 ✓（谁也不该自己去 `new Worker` ✗）。
//
// 四条设计约束（都来自本仓踩过的坑 ✓）：
//   ① **惰性**：`apply` 期不建线程、不读 wasm ✓（装在没资产的环境里也不能因此让插件 pending/crash ✗）。
//   ② **失败要说人话**：每种失败给 `kind`（no-wasm-dir / no-grammar / bad-grammar / esm-scope / timeout /
//      worker-crash / worker-killed / parse-failed）—— "解析失败"这一句对本仓来说是最没用的信息 ✗。
//   ③ **超时必须有**：worker 卡住（wasm 死循环、病态输入）不能把调用方一起拖住 ✓；超时后**把线程掐掉** ✓
//      （留着一个卡死的线程，下一次调用还会踩同一颗雷 ✗）；且**掐完要能自愈** —— 下一次调用照样成功 ✓。
//   ④ **不假装成功**：`ok: false` 一律带 `why`；`ok: true` 只可能在**真拿到 facts** 时出现 ✓。
//
// ⚠⚠ 一条被探针抓出来的真坑（2026-10-12，p3-38 第一次跑就红 ✓，值得留在注释里）：
//   请求账本**必须按线程归属**（`slot.pending`），不能放在池上一个全局 `pending` ✗ ——
//   否则"超时 ⇒ 掐掉旧线程"与"下一次调用新建线程"**并发**时，旧线程的 `exit` 事件会把
//   **新线程刚发出去的那条请求**一起判死 ⇒ 症状是"超时一次之后，这个门面永久报 `worker-exit`" ✗✗
//   （而"超时"恰恰是最需要自愈的失败 ✓）。⇒ 见 `createParserPool` 里的 slot 结构。
//
// ⚠ 线程数：P0 只用 **1 个**（够证通路，且 Host 里同时只跑一次自证 ✓）。
//   真索引（P1/P2）再按"硬件并发 − 1、上限 16"扩（真源口径），**不在这里提前做** ✗。

import { Worker } from 'node:worker_threads';

import { grammarFileOf, resolveWasmDir } from './resolve.js';

/** 单次解析的等待预算（与真源 `codebaseGraphParserPool` 的 15s 同口径 ✓）。 */
export const PARSE_TIMEOUT_MS = 15_000;

/**
 * 自证用的固定片段（TS）：**六种顶层声明各一个 + 两个缩进声明（反例）** ✓ ——
 * 与 IDE 真源 `symbolCheck` 的夹具**同构**（照抄它的意图，不照抄它的实现 ✓）：
 * 缩进的那两个是**故意的反例** —— 少了它们，"能抽"就证不了"不超抽" ✗（多抽正是这一类实现最典型的翻车方式）。
 */
export const PROOF_SNIPPET = [
	'export interface Shape {',
	'	area(): number;',
	'}',
	'',
	'export class Circle implements Shape {',
	'	area() { return 0; }',
	'}',
	'',
	'export const PI = 3.14;',
	'',
	'export async function load(): Promise<void> {}',
	'',
	'type Hidden = string;',
	'',
	'enum Color { Red }',
	'',
	'function nested() {',
	'	function inner() {}',
	'}',
].join('\n') + '\n';

/** 资产解析结果的人话摘要（页面与工具共用同一份措辞 ✓，免得两处各写一遍 ✗）。 */
export function describeParser(config, options = {}) {
	const resolved = resolveWasmDir(config, options);
	if (!resolved.dir) {
		const tried = resolved.tried.map(entry => `${entry.source}（${entry.why}）`).join('；');
		return {
			available: false,
			why: `没找到可用的 tree-sitter 资产。试过：${tried || '(没有任何候选)'}`,
			tried: resolved.tried,
		};
	}
	return {
		available: true,
		dir: resolved.dir,
		source: resolved.source,
		runtime: resolved.runtime,
		languages: resolved.languages,
		...(resolved.risk ? { risk: resolved.risk } : {}),
		why: `用 ${resolved.dir}（来自 ${resolved.source}，${resolved.languages.length} 种语言，运行时 ${resolved.runtime}）`
			+ (resolved.risk === 'esm-scope-risk'
				? ' ⚠ 目录里只有 `.js` 且它落在 "type":"module" 的作用域里 ⇒ 加载时可能被当 ESM 求值（见 resolve.js 文件头）'
				: ''),
		tried: resolved.tried,
	};
}

/**
 * 建一个解析器门面。**同一个门面复用同一个 worker** ✓（`Language.load` 很贵，每次重建线程等于每次重付 ✓）。
 * @returns `{ parseSource, describe, dispose, stats }`
 */
export function createParserPool(config, { timeoutMs = PARSE_TIMEOUT_MS, workerFile = new URL('./worker.js', import.meta.url), options = {} } = {}) {
	/** 当前线程槽：`{ instance, pending }` —— **请求账本属于线程**，不属于池（见文件头的真坑 ✓）。 */
	let slot;
	let nextId = 1;
	const stats = { parses: 0, failures: 0, workerStarts: 0, crashes: 0, timeouts: 0 };

	/** 只清**这个槽自己**的请求（别人的请求不归它管 ✓）。 */
	function failSlot(target, kind, why) {
		if (!target) {
			return;
		}
		for (const [id, entry] of target.pending) {
			target.pending.delete(id);
			clearTimeout(entry.timer);
			entry.resolve({ ok: false, kind, why, file: entry.request?.file, language: entry.request?.language });
		}
	}

	function ensureSlot(resolved) {
		if (slot) {
			return slot;
		}
		const instance = new Worker(workerFile, { workerData: { wasmDir: resolved.dir, runtime: resolved.runtime } });
		const created = { instance, pending: new Map() };
		slot = created;
		stats.workerStarts++;
		instance.on('message', message => {
			// ⚠ 只认**自己槽里**的 id：旧的（超时后被丢弃、或已被掐掉的线程）消息一律忽略 ✓
			const entry = created.pending.get(message?.id);
			if (!entry) {
				return;
			}
			created.pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.ok) {
				stats.parses++;
			} else {
				stats.failures++;
			}
			entry.resolve(message);
		});
		instance.on('error', error => {
			stats.crashes++;
			failSlot(created, 'worker-crash', `解析线程崩了：${String(error?.message ?? error)}`);
			if (slot === created) {
				slot = undefined; // 下次调用重建（不清掉的话会把消息发给一个死线程 ⇒ 永远等不到回执 ✗）
			}
		});
		instance.on('exit', code => {
			// ★ 关键：只清**自己**槽里的请求 ✓ —— 旧线程退出时不能把新线程在跑的请求一起判死（见文件头 ⚠⚠）
			failSlot(created, 'worker-exit', `解析线程退出（code=${code}）时还有请求没回执`);
			if (slot === created) {
				slot = undefined;
			}
		});
		return created;
	}

	/** 掐掉当前线程（超时/crash 后调用；下次调用会重建 ✓）。 */
	async function killSlot(why) {
		const dying = slot;
		slot = undefined;
		failSlot(dying, 'worker-killed', why);
		if (dying) {
			try {
				await dying.instance.terminate();
			} catch { /* 已经死了就算了 ✓ */ }
		}
	}

	async function parseSource(request = {}) {
		const resolved = resolveWasmDir(config, options);
		if (!resolved.dir) {
			stats.failures++;
			return { ok: false, kind: 'no-wasm-dir', why: describeParser(config, options).why };
		}
		const language = String(request.language ?? '').trim();
		if (!language) {
			stats.failures++;
			return { ok: false, kind: 'bad-request', why: '必须给 `language`（P0 刻意不做扩展名→语言映射，见 facts.js 文件头）' };
		}
		if (!resolved.languages.includes(language)) {
			stats.failures++;
			return {
				ok: false,
				kind: 'no-grammar',
				why: `目录里没有 ${language} 的 grammar（${grammarFileOf(language)} 不在 ${resolved.dir}）；可用：${resolved.languages.join(', ')}`,
			};
		}
		const active = ensureSlot(resolved);
		const id = nextId++;
		// `mode`：`'facts'`（默认，P0 自证）| `'extract'`（P2 建图）。原样透传给 worker ✓。
		const callRequest = { language, text: request.text ?? '', file: request.file, ...(request.mode === 'extract' ? { mode: 'extract' } : {}) };
		// 超时预算**可按调用覆盖**（夹在 1ms–60s ✓）：探针要用"1ms 必超时"来验证"超时后门面能自愈"，
		// 而按池建的超时是同一个值 ⇒ 不覆盖就测不出自愈 ✗。默认仍用池的预算 ✓。
		const asked = Number(request.timeoutMs);
		const budget = Number.isFinite(asked) && asked > 0 ? Math.min(60_000, Math.max(1, Math.floor(asked))) : timeoutMs;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				if (!active.pending.has(id)) {
					return;
				}
				active.pending.delete(id);
				stats.timeouts++;
				stats.failures++;
				resolve({ ok: false, kind: 'timeout', why: `解析超过 ${budget}ms 未回执（线程已掐掉，下次调用会重建）：${language}${request.file ? ` / ${request.file}` : ''}` });
				void killSlot('解析超时');
			}, budget);
			active.pending.set(id, { resolve, timer, request: callRequest });
			try {
				active.instance.postMessage({ id, request: callRequest });
			} catch (e) {
				active.pending.delete(id);
				clearTimeout(timer);
				stats.failures++;
				resolve({ ok: false, kind: 'worker-post-failed', why: `把请求交给解析线程失败：${String(e?.message ?? e)}` });
			}
		});
	}

	return {
		parseSource,
		describe: () => describeParser(config, options),
		stats,
		dispose: async () => {
			await killSlot('门面被 dispose');
		},
	};
}
