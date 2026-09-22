/*---------------------------------------------------------------------------------------------
 *  unreal_* 工具卡片的**终端风格 · 时间线（方案 E）**正文 —— 独立函数 ✓ 不进面板继承链
 *  ⇒ 可在 jsdom 里直接单测 ✓✓（unreal 卡在继承链末端：`DrawioCard → UnrealCard → Markdown`，
 *  直接实例化整条链代价极高 ✗）。
 *
 *  ★ 2026-09-22 用户拍板：**方案 E（时间线）** ✓ 并要求「**限制高度，与 mockup 一致**」✓✓
 *    · 结构 = 竖轴 + 两个节点：`① 请求`（命令 + 代码）→ `② 结果`（结果面板 + 规模/截断）
 *      ⇒ 视觉上**只有 1 段**（一条轴串起来 ✓），取代原先「标题行 + 命令带 + 结果带 + 页脚」的 3~4 段 ✗；
 *    · **限高取值来自 mockup 实测**（Chrome DevTools 量 plan E ✓，不是拍脑袋 ✓）：
 *        整卡实测区间 **192 – 386px**（running 192 / execOk 269 / build 233 / dump 331 / long 386 ✓）
 *        ⇒ 限高落在**时间线本体**：**354px** = 386（最坏整卡）− 32（卡片头）✓✓
 *    · ⚠ 2026-09-22 用户反馈两条，直接决定了最终形态（细节见 UNREAL_BODY_MAX_HEIGHT_PX 注释 ✓）：
 *        ①「高度超出限制」✗（旧版把限高加在内部分区、**整体无上限** ✗ + 命令行内联整段脚本 ✗）
 *        ②「紫色代码块多出一个滚动条」✗ ⇒ 现在**整块只有一个滚动条** ✓✓
 *
 *  ★ 硬要求「**结果必须显示出来**」✓✓ 仍然成立（且更强 ✓）：
 *    · 正文里**没有任何折叠** ✗；结果面板**始终可见** ✓，限高只作用在**显示**上 ✓ ——
 *      **数据全量留在 DOM 里** ✓（滚动可看全 ✓），单测有一条专门断言"61 行一行不少" ✓✓。
 *
 *  ★ 真机契约（`vscode-app-1790084962792.log` 取证 ✓）：
 *    · `unreal_exec`   → `{ ok, repr, output }` ⇒ 结果取 **output** ✓（不是 `result` ✗）；
 *      `ok:false` = **Python 失败** ✗✓（HTTP 200 ≠ 成功 ⇒ 必须 `exit ✗` ✓）
 *    · `unreal_health` → `{ status, project, pid, uptime_seconds }` ⇒ 扁平对象 ⇒ `key = value` 终端行 ✓
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../base/browser/dom.js';
import { resultStats, summarizeToolResult } from './toolResultPreview.js';

/** exec 代码片段上限（原在卡片里 ✓ 随实现一起搬到本模块 ✓）。 */
export const UNREAL_CODE_SNIPPET_LIMIT = 600;

/**
 * ⚠ **唯一的限高常量** —— 作用在**时间线本体**（`.unreal-term-tl` ✓，它同时也是**唯一的滚动容器** ✓）。
 *
 * ★ 2026-09-22 用户反馈两条 ⇒ 本设计是被它们逼出来的 ✓✓：
 *   ①「高度超出限制」✗ —— 旧版把限高加在**内部分区**（代码 96 / 结果 190），而**整体没有上限** ✗，
 *      且命令行内联了整段脚本（`code="…"` 几百字符 ✗）⇒ 三段各自不超、加起来远超 ✗；
 *   ②「紫色代码块多出一个滚动条」✗ ⇒ 用户要「内容部分**仅有一个整体滚动条**」✓✓。
 *   ⇒ 修法：**限高与滚动一起上移到时间线本体** ✓；内部分区一律 `max-height: none; overflow: visible` ✗✓。
 *
 * 取值依据 = mockup plan E 的 **Chrome 实测**（不估算 ✓）：
 *   整卡最坏 386px（long 场景）− 卡片头 ≈ 32px ⇒ **本体 354px** ✓
 * ⚠ 单测会核对「本常量 = CSS 里 `.unreal-term-tl` 的 max-height」✗✓（改一处忘另一处 ⇒ 红 ✓）。
 */
export const UNREAL_BODY_MAX_HEIGHT_PX = 354;

/**
 * 命令行里**单个参数值**的字符上限（超出即截断 + `…` ✓）。
 * ⚠ 起因同 ①：`unreal_exec` 的 `code` 参数动辄几百字符，整段内联进命令行会：
 *   把卡片顶到几百像素 ✗、且与下方代码块**完全重复** ✗。
 *   完整命令仍通过 `title` 挂在命令行上 ✓（悬停可看 / 可复制 ⇒ 信息不丢 ✓）。
 */
export const UNREAL_CMD_VALUE_MAX_CHARS = 60;

/** 结果面板的渲染模式（纯函数判定的产物 ✓）。 */
export interface IUnrealResultView {
	/** `kv` = 扁平对象 ⇒ `key = value` 行 ✓；`json` = 嵌套/数组 ⇒ 美化 JSON ✓；`text` = 纯文本 ✓。 */
	readonly mode: 'kv' | 'json' | 'text';
	readonly kv: ReadonlyArray<readonly [string, string]>;
	/** 面板里要显示的正文（**一律非空** ✓ —— 空结果也给 `(无输出)` 兜底 ✗✓）。 */
	readonly text: string;
	/** 人类可读内容是否来自**内容字段**（`output` 等 ✓ 真机契约 ✓）。 */
	readonly fromContentField: boolean;
}

/** 判定「Python 侧是否成功」—— `ok:false` 必须走失败态 ✗✓（真机契约 ✓）。 */
export interface IUnrealExitView {
	readonly ok: boolean;
	/** 页脚展示文案：`exit 0` / `exit ✗ python` / `exit ✗ <理由>` ✓。 */
	readonly label: string;
}

const PRIMITIVE = (v: unknown): boolean =>
	v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function tryParse(text: string): unknown {
	const raw = (text ?? '').trim();
	if (!raw.startsWith('{') && !raw.startsWith('[')) { return undefined; }
	try { return JSON.parse(raw); } catch { return undefined; }
}

/** 把 value 压成一行终端可读文本 ✓（字符串去掉引号 ✓ 便于 `key = value` ✓）。 */
function inline(v: unknown): string {
	if (v === null) { return 'null'; }
	if (typeof v === 'string') { return v.replace(/\s+/g, ' ').trim(); }
	return String(v);
}

/**
 * 结果 → 终端面板视图模型 ✓（纯函数 ✓）。
 * 优先取**内容字段**（`output`/`result`/… ✓ 真机契约 ✓）⇒ 扁平对象 ⇒ 嵌套 ⇒ 纯文本 ✓。
 */
export function formatUnrealResult(text: string): IUnrealResultView {
	const raw = (text ?? '').trim();
	if (!raw) { return { mode: 'text', kv: [], text: '(无输出)', fromContentField: false }; }

	const parsed = tryParse(raw);
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		const obj = parsed as Record<string, unknown>;
		// ① 内容字段优先（`unreal_exec.output` ✓）：它就是该给的"结果" ✓
		for (const name of ['output', 'result', 'text', 'message', 'summary', 'docstring'] as const) {
			const v = obj[name];
			if (typeof v === 'string' && v.trim().length > 0) {
				return { mode: 'text', kv: [], text: v, fromContentField: true };
			}
		}
		// ② 扁平对象（如 `unreal_health` ✓）⇒ `key = value` 终端行 ✓
		const entries = Object.entries(obj);
		if (entries.length > 0 && entries.every(([, v]) => PRIMITIVE(v))) {
			return { mode: 'kv', kv: entries.map(([k, v]) => [k, inline(v)] as const), text: '', fromContentField: false };
		}
		// ③ 嵌套（如 `unreal_dump` ✓）⇒ 美化 JSON ✓（保留结构，靠滚动看全 ✓）
		return { mode: 'json', kv: [], text: JSON.stringify(obj, null, 2), fromContentField: false };
	}
	if (Array.isArray(parsed)) {
		return { mode: 'json', kv: [], text: JSON.stringify(parsed, null, 2), fromContentField: false };
	}
	return { mode: 'text', kv: [], text: raw, fromContentField: false };
}

/** 出口状态 ✓（`ok:false` / `status!=ok` / bridge 错误文案 都必须显式失败 ✗✓）。 */
export function readUnrealExit(toolName: string, resultText: string, status: string): IUnrealExitView {
	if (status === 'error') { return { ok: false, label: 'exit ✗ bridge 不可达' }; }
	const parsed = tryParse(resultText);
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		const obj = parsed as Record<string, unknown>;
		if (obj.ok === false) { return { ok: false, label: 'exit ✗ python 执行失败' }; }
		if (typeof obj.status === 'string' && obj.status.length > 0 && obj.status !== 'ok') {
			return { ok: false, label: `exit ✗ status=${obj.status}` };
		}
	}
	if (toolName === 'unreal_health' && /ECONNREFUSED|unreachable|不可达/i.test(resultText)) {
		return { ok: false, label: 'exit ✗ bridge 不可达' };
	}
	return { ok: true, label: 'exit 0' };
}

/** 终端正文的入参（全部由卡片传入 ⇒ 本模块零特权 ✓）。 */
export interface IUnrealTerminalBodyOptions {
	readonly toolName: string;
	readonly args: ReadonlyArray<readonly [string, string]>;
	readonly code?: string;
	readonly resultText: string;
	readonly status: string;
	/**
	 * 执行耗时 —— ⚠ **本模块刻意不渲染它** ✗：耗时已由卡片头部（`.tool-header` 的
	 * `tool-header-duration` ✓）显示，正文再显示一遍是同一条信息说两次 ✗✓。
	 * 保留字段是为了签名稳定（调用方无需改）。mockup plan E 同样只把它放在标题行 ✓。
	 */
	readonly durationMs?: number;
}

/**
 * `$ unreal_exec …` 这一行 ✓。
 * @param truncate `true` ⇒ 超长参数值截断成 `…`（**正文用** ✓ 防把卡片顶高 ✗）；
 *                 `false` ⇒ 完整不截断（**只用于 `title`** ✓ ⇒ 信息不丢 ✓）。
 */
function commandLine(opts: IUnrealTerminalBodyOptions, truncate: boolean): string {
	const parts = opts.args
		.filter(([, v]) => (v ?? '').trim().length > 0)
		.map(([k, v]) => {
			const quoted = /[\s"']/.test(v) ? JSON.stringify(v) : v;
			if (!truncate || quoted.length <= UNREAL_CMD_VALUE_MAX_CHARS) { return `${k}=${quoted}`; }
			return `${k}=${JSON.stringify(v.slice(0, UNREAL_CMD_VALUE_MAX_CHARS))}…`;
		});
	return `$ ${opts.toolName}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

/**
 * 建**时间线**正文 ✓（方案 E ✓，**结果一律可见** ✓✓）。
 * 结构：`.unreal-term-tl`（竖轴容器）
 *         ├─ 节点① `.unreal-term-node`     → 头 `① 请求` + 命令 + 代码
 *         └─ 节点② `.unreal-term-node[(-ok|-bad)]` → 头 `② 结果 · exit …` + **结果面板** + 规模/截断
 */
export function createUnrealTerminalBody(opts: IUnrealTerminalBodyOptions): HTMLElement {
	const term = $('.unreal-term');
	const xit = readUnrealExit(opts.toolName, opts.resultText, opts.status);
	if (!xit.ok) { term.classList.add('unreal-term-failed'); }

	const tl = append(term, $('.unreal-term-tl'));

	// ── 节点①：请求（命令 + 代码）────────────────────────────────────────
	const req = append(tl, $('.unreal-term-node'));
	append(req, $('.unreal-term-node-head', undefined, '① 请求'));
	const cmd = append(req, $('.unreal-term-cmd', undefined, commandLine(opts, true)));
	// ⚠ 完整命令（**未截断** ✓）挂 `title` ⇒ 正文截断不丢信息 ✓（悬停可看 / 可复制 ✓）
	cmd.setAttribute('title', commandLine(opts, false));
	if (opts.code && opts.code.trim()) {
		const code = opts.code.length > UNREAL_CODE_SNIPPET_LIMIT
			? opts.code.slice(0, UNREAL_CODE_SNIPPET_LIMIT) + '\n… (已截断)'
			: opts.code;
		append(req, $('pre.unreal-term-code', undefined, code));
	}

	// ── 节点②：结果（**始终可见** ✓ 限高只作用于显示、不裁数据 ✓）────────────
	const res = append(tl, $('.unreal-term-node' + (xit.ok ? '.unreal-term-node-ok' : '.unreal-term-node-bad')));
	const head = append(res, $('.unreal-term-node-head'));
	append(head, $('span', undefined, '② 结果'));
	append(head, $('span.unreal-term-exit' + (xit.ok ? '' : '.bad'), undefined, ` · ${xit.label}`));

	const view = formatUnrealResult(opts.resultText);
	if (view.mode === 'kv') {
		// 扁平对象（如 `unreal_health` ✓）⇒ 终端式 `key = value` 两列 ✓
		const kv = append(res, $('.unreal-term-out.unreal-term-kv'));
		for (const [k, v] of view.kv) {
			append(kv, $('span.unreal-term-key', undefined, k));
			append(kv, $('span.unreal-term-eq', undefined, '='));
			append(kv, $('span.unreal-term-val', undefined, v));
		}
	} else {
		// ⚠ 正文**全量**写入（限高由 CSS 负责 ✓ 不在 JS 里截数据 ✗✓）
		append(res, $('pre.unreal-term-out', undefined, view.text));
	}

	// ── 规模 / 截断 / 摘要（贴在结果节点内 ⇒ 不额外占一段 ✓）──────────────────
	const stats = resultStats(opts.resultText);
	const meta = append(res, $('.unreal-term-meta'));
	append(meta, $('span', undefined, `${stats.lines} 行 · ${stats.chars} 字符`));
	if (stats.truncated) {
		append(meta, $('span.unreal-term-warn', undefined, '⚠ 已截断'));
	}
	const summary = summarizeToolResult(opts.resultText, 100);
	if (summary) { append(meta, $('span.unreal-term-summary', undefined, summary)); }

	return term;
}
