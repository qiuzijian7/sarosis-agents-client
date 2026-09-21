/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Token 消耗明细浮层（`tokens-popup`）—— 2026-09-21 从 `agentChatPanel.messages.ts` 抽出。
 *
 * ── 为什么抽出来 ──────────────────────────────────────────────────────────────
 * ① **可测**：此前它内联在 6.3k 行的消息渲染方法里 ⇒ 只能用源码结构断言"假装测过" ✗；
 *    抽成纯 DOM 函数后可以直接用 jsdom 断言**每一行都在**（本文件对应的测试 ✓）；
 * ② **不再撑大巨物文件** ✗（与 `agentChatPanel.footerPills.ts` 同一套路 ✓）；
 * ③ **格式只此一处** ✓：用户要求"内容与格式固定"✓ ⇒ 任何修改都必须过测试 ✓。
 *
 * ── 两条硬性语义（用户实测驱动 ✓）─────────────────────────────────────────────
 * ① **所有行无条件渲染** ✗：此前每行都带 `> 0` 门控 ⇒ 零值行整行消失 ✗
 *    （实测截图只剩「输入 / 缓存未命中 / 输出 / 回复内容」✓，连命中率条都没有 ✗）。
 *    **0 是真实读数**（该轮确实没有缓存命中 ✓），不是"没数据" ✗；
 * ② **缺数据与零值必须区分** ✓：字段 `undefined`（旧版本落盘的记录 ✓ / 该 provider 不报该字段 ✓）
 *    显示 `—` ✓；数值 0 显示 `0` ✓。
 *
 * ── 与落盘侧的约定（重要 ✗）───────────────────────────────────────────────────
 * `ChatMessage.tokenUsage` **必须**落齐本文件读取的字段（含 0 ✓）——
 * 否则重启后这里只能显示 `—` ✗（2026-09-21 实测：`reasoning`/`cacheMiss`/`cacheHitRate`/
 * `providerId`/`model` 此前**完全没落盘** ✗ ⇒ 重启后明细残缺 ✓✓）。
 * 落盘处：`agentChatService` 的 `sharedTokenUsage`（与 live 路径字段集对齐 ✓）。
 */

import { $, append } from '../../../base/browser/dom.js';

/** 浮层读取的字段（结构化类型 ⇒ 与 `ChatMessage.tokenUsage` 兼容但不互相耦合 ✓）。 */
export interface ITokenUsageLike {
	readonly input: number;
	readonly output: number;
	readonly total: number;
	readonly cached?: number;
	readonly cachedRead?: number;
	readonly cacheWrite?: number;
	readonly cacheMiss?: number;
	readonly reasoning?: number;
	/** 命中率（百分比，例如 99.8 ✓）。缺省时由 cached/input 现算 ✓。 */
	readonly cacheHitRate?: number;
	readonly providerId?: string;
	readonly model?: string;
	readonly credit?: number;
}

/** 数值渲染：`undefined` ⇒ `—`（缺数据 ✓）；`0` ⇒ `"0"`（真实读数 ✓）。 */
function fmtNum(n: number | undefined): string {
	return typeof n === 'number' ? n.toLocaleString() : '—';
}

/**
 * 在 `host`（tokens 药丸）内挂出明细浮层 ✓（CSS 用 `:hover` 控制显隐 ✓）。
 * 返回浮层根节点（测试用 ✓）。
 */
export function appendTokenUsagePopup(host: HTMLElement, tu: ITokenUsageLike): HTMLElement {
	const cachedRead = tu.cachedRead ?? tu.cached ?? 0;
	const cacheWrite = tu.cacheWrite ?? 0;
	// 旧记录可能没有 cacheMiss ⇒ 由 input − cached − write 派生（与落盘侧同式 ✓）
	const cacheMiss = tu.cacheMiss ?? Math.max(0, tu.input - cachedRead - cacheWrite);
	const reasoning = tu.reasoning ?? 0;
	const contentTokens = Math.max(0, tu.output - reasoning);
	// 命中率：优先用落盘值 ✓（percentage ✓），否则现算 ✓
	const hitRate = tu.cacheHitRate ?? (tu.input > 0 ? (cachedRead / tu.input) * 100 : 0);

	const popup = append(host, $('div.tokens-popup'));
	// 标题行：左侧 "Token 消耗明细" + 右侧 "总计 X"
	const titleRow = append(popup, $('div.tokens-popup-header'));
	append(titleRow, $('span.tokens-popup-title', undefined, 'Token 消耗明细'));
	const totalEl = append(titleRow, $('span.tokens-popup-total-inline'));
	append(totalEl, $('span.label', undefined, '总计'));
	append(totalEl, $('span.value', undefined, tu.total.toLocaleString()));
	// Provider/Model 行：跨模型对比时直接识别（多轮取最近一轮 ✓；由落盘侧注入 ✓）
	if (tu.providerId || tu.model) {
		const metaRow = append(popup, $('div.tokens-popup-meta'));
		const metaText = [tu.providerId, tu.model].filter(Boolean).join(' / ');
		append(metaRow, $('span.meta-label', undefined, '模型'));
		append(metaRow, $('span.meta-value', undefined, metaText));
	}
	// 输入分组：命中 / 未命中 / 写入 —— **三行无条件渲染** ✓
	const inputGroup = append(popup, $('div.tokens-popup-group'));
	const inputTitle = append(inputGroup, $('div.tokens-popup-group-title'));
	append(inputTitle, $('span.group-name', undefined, '输入'));
	append(inputTitle, $('span.group-value', undefined, tu.input.toLocaleString()));
	const subRow = (group: HTMLElement, dot: string | undefined, label: string, value: number | undefined, valueCls = 'sub-value'): void => {
		const row = append(group, $('div.tokens-popup-sub-row'));
		if (dot) { append(row, $(`span.sub-dot.${dot}`)); }
		append(row, $('span.sub-label', undefined, label));
		append(row, $(`span.${valueCls}`, undefined, fmtNum(value)));
	};
	subRow(inputGroup, 'hit', '缓存命中', tu.cachedRead ?? tu.cached, 'sub-value.highlight');
	subRow(inputGroup, 'miss', '缓存未命中', cacheMiss);
	// ⚠ 传 `tu.cacheWrite`（而非上面已默认成 0 的 `cacheWrite`）✗ ——
	//   否则"字段缺失"会被显示成 `0` ✓，与 `—`（缺数据）语义混淆 ✗✓（本文件测试抓到的 ✓）。
	subRow(inputGroup, 'write', '缓存写入', tu.cacheWrite);

	// 输出分组：思考过程 / 回复内容 —— **两行无条件渲染** ✓
	const outputGroup = append(popup, $('div.tokens-popup-group'));
	const outputTitle = append(outputGroup, $('div.tokens-popup-group-title'));
	append(outputTitle, $('span.group-name', undefined, '输出'));
	append(outputTitle, $('span.group-value', undefined, tu.output.toLocaleString()));
	subRow(outputGroup, undefined, '思考过程', tu.reasoning);
	subRow(outputGroup, undefined, '回复内容', contentTokens);

	// 缓存命中率：**无条件**渲染（含三段进度条 + 图例 ✓）—— 0% 也是有效读数 ✓
	const hitRateEl = append(popup, $('div.tokens-popup-hit-rate'));
	const rateHeader = append(hitRateEl, $('div.rate-header'));
	append(rateHeader, $('span.rate-icon.codicon.codicon-zap'));
	append(rateHeader, $('span.rate-label', undefined, '缓存命中率'));
	append(rateHeader, $('span.rate-value', undefined, `${hitRate.toFixed(1)}%`));
	const bar = append(hitRateEl, $('div.tokens-popup-hit-bar'));
	if (tu.input > 0) {
		const hitSeg = append(bar, $('span.seg.hit')) as HTMLElement;
		hitSeg.style.width = `${(cachedRead / tu.input) * 100}%`;
		const writeSeg = append(bar, $('span.seg.write')) as HTMLElement;
		writeSeg.style.width = `${(cacheWrite / tu.input) * 100}%`;
		const missSeg = append(bar, $('span.seg.miss')) as HTMLElement;
		missSeg.style.width = `${(cacheMiss / tu.input) * 100}%`;
	}
	const legend = append(hitRateEl, $('div.tokens-popup-legend'));
	const lg1 = append(legend, $('span.legend-item'));
	append(lg1, $('span.legend-dot.hit'));
	append(lg1, $('span.legend-label', undefined, '命中'));
	const lg2 = append(legend, $('span.legend-item'));
	append(lg2, $('span.legend-dot.write'));
	append(lg2, $('span.legend-label', undefined, '写入'));
	const lg3 = append(legend, $('span.legend-item'));
	append(lg3, $('span.legend-dot.miss'));
	append(lg3, $('span.legend-label', undefined, '未命中'));

	return popup;
}
