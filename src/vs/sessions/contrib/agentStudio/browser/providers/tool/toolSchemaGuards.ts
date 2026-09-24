/*---------------------------------------------------------------------------------------------
 *  Saros Agents — 工具 schema 形状守卫（纯字符串逻辑：无 fs、无 VS Code 依赖）
 *
 *  与 terminalCommandGuards.ts / executeCodeGuards.ts 同一约定：护栏逻辑与工具同目录、
 *  纯函数、可在 Node 单测里直接跑（渲染器可以直接 import，不会拖进 Node 模块）。
 *
 *  本文件只提供**检测**能力；"扫哪些文件"由测试承担
 *  （test/browser/toolSchemaShapeGuard.test.ts），因为那需要 fs。
 *--------------------------------------------------------------------------------------------*/

/**
 * 反模式：`type: 'object'` 的 schema 带**空 properties**。
 *
 * ## 为什么必须挡住（第 N 次发生）
 *
 * 空 properties 的 schema 会被 IOA 网关判为"不兼容模式"并**自动改写**，每次请求都刷一条
 * `[CodeBuddy][sanitize] ... empty properties {} replaced with _no_params` 告警。后果不止是
 * 日志噪音：我们声明的 schema 与模型实际收到的 schema **不再是同一份**，"schema 就是契约"
 * 这个前提被悄悄破坏（排查 schema 相关问题时会被误导）。
 *
 * 正确写法：无参工具用**共享常量**，不要再手写字面量。
 *
 * ```ts
 * import { NO_PARAMS_SCHEMA } from '../../../common/providers.js';
 * // ...
 * inputSchema: NO_PARAMS_SCHEMA,
 * ```
 *
 * 这条约定此前在 9 个文件里各抄一份（browserTools / unrealTools / mindmapTools / workflowTools /
 * codebaseTools / kanbanTools / compatibilityTools / advancedMemoryTools / kbVaultRecallTools）、
 * 没有共享常量 —— "每处都要重新记一遍规则"正是它反复发生的根因。2026-09-24 已收敛到
 * `common/providers.ts` 的 `NO_PARAMS_SCHEMA`（理由与使用约定记在那里），本文件只负责守。
 *
 * ## 注释里出现这个写法**不算违规**
 *
 * 恰恰相反：解释本条规则的地方就在注释里（例如 mindmapTools.ts 的注释写着"这三处原先手写了
 * `properties: {}`，已由该常量取代"）。所以匹配前必须先剥掉注释，否则守卫会被自己的说明文字
 * 绊倒 —— 这不是假想问题，本目录当前就有一处这样的注释。
 */
export interface IEmptyPropertiesHit {
	/** 1-based 行号（基于**剥离注释后**的文本，注释被替换成空格 ⇒ 行号与原文一致）。 */
	readonly line: number;
	/** 命中所在行的原文（已去注释、trim），便于直接贴进报错信息。 */
	readonly text: string;
}

/**
 * 把 TS 注释替换成空格，**保留所有换行与字符偏移**。
 *
 * 保留偏移是刻意的：这样后续按 index 反查行号时，行号与原文一一对应，报错能直接定位到源码行。
 *
 * 处理 `'` / `"` / `` ` `` 三种字符串：否则 `'https://x'` 里的 `//` 会被误当行注释、
 * 反过来把该行后面的真实代码当成注释吃掉（→ 漏报）。**字符串内容本身不清空**（保守：
 * 宁可多报也不漏报，误报的代价只是有人来看一眼）。
 */
export function stripTsComments(source: string): string {
	const out = source.split('');
	const n = source.length;
	let i = 0;
	let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';

	while (i < n) {
		const ch = source[i];
		const next = source[i + 1];

		switch (state) {
			case 'code':
				if (ch === '/' && next === '/') {
					state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue;
				}
				if (ch === '/' && next === '*') {
					state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue;
				}
				if (ch === "'") { state = 'single'; }
				else if (ch === '"') { state = 'double'; }
				else if (ch === '`') { state = 'template'; }
				i++; continue;

			case 'line':
				if (ch === '\n') { state = 'code'; } else { out[i] = ' '; }
				i++; continue;

			case 'block':
				if (ch === '*' && next === '/') {
					out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue;
				}
				if (ch !== '\n') { out[i] = ' '; }
				i++; continue;

			default: {
				// single / double / template
				const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
				if (ch === '\\') { i += 2; continue; }	// 转义：跳过下一个字符
				if (ch === quote) { state = 'code'; }
				i++; continue;
			}
		}
	}
	return out.join('');
}

/** 空 properties 的字面写法（含跨行/多余空白）。 */
const EMPTY_PROPERTIES_SOURCE = 'properties\\s*:\\s*\\{\\s*\\}';

/**
 * 找出源码里所有"空 properties"的 schema。
 *
 * ⚠ 正则**在函数内构造**，刻意不做模块级带 `g` 的常量：带 `g` 的正则持有可变的 `lastIndex`，
 * 复用会漏掉下一次调用（本仓已有 `searchRegexStateless.test.ts` 专门盯这个坑）。
 */
export function findEmptyPropertiesSchemas(source: string): IEmptyPropertiesHit[] {
	const stripped = stripTsComments(source);
	const re = new RegExp(EMPTY_PROPERTIES_SOURCE, 'g');
	const hits: IEmptyPropertiesHit[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(stripped)) !== null) {
		hits.push({ line: lineAt(stripped, m.index), text: lineTextAt(stripped, m.index) });
	}
	return hits;
}

/** 修复指引 —— 与检测结果一起抛出，让人不必去翻注释找约定。 */
export const EMPTY_PROPERTIES_FIX_HINT =
	'空 properties 的 schema 会被 IOA 网关自动改写（每轮刷 sanitize 告警，'
	+ '且"声明的 schema"与"模型收到的 schema"不再一致）。'
	+ '无参工具请直接用共享常量：从 common/providers.js 导入 NO_PARAMS_SCHEMA，然后写 inputSchema: NO_PARAMS_SCHEMA；'
	+ '不要再手写字面量 —— 这条约定被抄过 9 次、每处都要重新记一遍规则，正是它反复发生的原因。';

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === '\n') { line++; }
	}
	return line;
}

function lineTextAt(text: string, index: number): string {
	const start = text.lastIndexOf('\n', index - 1) + 1;
	const end = text.indexOf('\n', index);
	return (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
}
