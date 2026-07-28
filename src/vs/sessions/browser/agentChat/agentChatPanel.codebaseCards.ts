import { $, append } from '../../../base/browser/dom.js';
import { AgentChatPanelToolCards } from './agentChatPanel.toolCards.js';

/**
 * Codebase 知识图谱工具的结构化结果卡片
 *（search_graph / grep / get_architecture / trace_path / index_repository 等）。
 * 自 agentChatPanel.toolCards.ts 抽离（上帝对象拆分 P5c）。
 * 调用方 _createCodebaseResultCard 在 fileCards 层（本层为其父类）。
 */
export abstract class AgentChatPanelCodebaseCards extends AgentChatPanelToolCards {

protected override _renderSearchGraphCard(card: HTMLElement, data: any): HTMLElement {
		const nodes = data.nodes || [];
		const total = data.total ?? nodes.length;
		const hasMore = data.hasMore ?? false;
		const semResults = data.semantic_results || [];

		// Summary strip
		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${nodes.length} / ${total} results`));
		if (hasMore) {
			append(strip, $('span.codebase-stat.codebase-stat-more', undefined, 'hasMore → paginate'));
		}
		if (semResults.length > 0) {
			append(strip, $('span.codebase-stat', undefined, `+${semResults.length} semantic`));
		}

		// Column headers
		const hdr = append(card, $('.codebase-result-row.codebase-result-header'));
		append(hdr, $('span.codebase-col-rank', undefined, '#'));
		append(hdr, $('span.codebase-col-name', undefined, 'Symbol'));
		append(hdr, $('span.codebase-col-type', undefined, 'Type'));
		append(hdr, $('span.codebase-col-file', undefined, 'File'));
		append(hdr, $('span.codebase-col-score', undefined, 'Score'));

		const maxShow = Math.min(nodes.length, 10);
		for (let i = 0; i < maxShow; i++) {
			const n = nodes[i];
			const row = append(card, $('.codebase-result-row'));
			append(row, $('span.codebase-col-rank', undefined, String(i + 1)));
			append(row, $('span.codebase-col-name', undefined, n.name || n.id || '?'));
			append(row, $('span.codebase-col-type', undefined, n.type || ''));
			const file = (n.filePath || '').split('/').pop() || n.filePath || '';
			append(row, $('span.codebase-col-file', undefined, file));
			const score = data.scores && data.scores[n.id] ? data.scores[n.id].toFixed(1) : (n.score ? n.score.toFixed(1) : '-');
			append(row, $('span.codebase-col-score', undefined, score));
		}

		// Semantic results section
		if (semResults.length > 0) {
			append(card, $('.codebase-section-title', undefined, '🔮 Semantic Results'));
			for (let i = 0; i < Math.min(semResults.length, 5); i++) {
				const s = semResults[i];
				const srow = append(card, $('.codebase-result-row.codebase-semantic-row'));
				append(srow, $('span.codebase-col-name', undefined, s.name || s.id));
				append(srow, $('span.codebase-col-type', undefined, s.type || ''));
				const sScore = s.score ? s.score.toFixed(2) : '-';
				append(srow, $('span.codebase-col-score', undefined, sScore));
			}
		}

		if (hasMore) {
			append(card, $('.codebase-page-hint', undefined, `⚡ hasMore = true — 共 ${total} 条结果，当前显示前 ${maxShow} 条。用 offset=${maxShow} 翻页查看更多。`));
		}

		return card;
	}

protected override _renderSearchCodeCard(card: HTMLElement, data: any): HTMLElement {
		const results = data.results || [];
		const total = data.total ?? results.length;
		const mode = data.mode || 'compact';

		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${results.length} / ${total} matches`));
		append(strip, $('span.codebase-stat', undefined, `mode: ${mode}`));

		for (let i = 0; i < Math.min(results.length, 5); i++) {
			const r = results[i];
			const entry = append(card, $('.codebase-search-code-entry'));

			const meta = append(entry, $('.codebase-search-code-meta'));
			const sym = r.symbol ? ` [${r.type || ''} ${r.symbol}]` : '';
			append(meta, $('span', undefined, `${r.filePath || ''}:${r.lineNo || ''}${sym}`));

			if (r.text) {
				append(entry, $('pre.codebase-search-code-line', undefined, r.text));
			}
			if (r.context) {
				const ctx = append(entry, $('.codebase-search-code-context'));
				append(ctx, $('pre', undefined, r.context));
			}
		}

		return card;
	}

protected override _renderArchitectureCard(card: HTMLElement, data: any): HTMLElement {
		// Stats grid
		const grid = append(card, $('.codebase-arch-grid'));
		const stats: [string, any, string][] = [
			['Total Nodes', data.totalNodes, ''],
			['Total Edges', data.totalEdges, ''],
			['Languages', Array.isArray(data.languages) ? data.languages.length : Object.keys(data.languages || {}).length, ''],
			['Packages', data.packages ? data.packages.length : 0, ''],
		];
		for (const [label, value, ] of stats) {
			if (value === null || value === undefined) { continue; }
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(value)));
			append(cell, $('.codebase-arch-label', undefined, label));
		}

		// Communities
		const communities = data.communities || [];
		if (communities.length > 0) {
			append(card, $('.codebase-section-title', undefined, `🏘️ Communities (${communities.length})`));
			const cGrid = append(card, $('.codebase-comm-grid'));
			for (const c of communities.slice(0, 6)) {
				const cc = append(cGrid, $('.codebase-comm-card'));
				append(cc, $('.codebase-comm-name', undefined, c.label || c.name || ''));
				const mems = c.members || c.size || 0;
				const coh = c.cohesion != null ? ` · cohesion ${(c.cohesion * 100).toFixed(0)}%` : '';
				append(cc, $('.codebase-comm-stats', undefined, `${mems} nodes${coh}`));
				if (c.top_nodes && c.top_nodes.length > 0) {
					const tops = c.top_nodes.slice(0, 3).join(', ');
					append(cc, $('.codebase-comm-top', undefined, `Top: ${tops}`));
				}
			}
		}

		return card;
	}

protected override _renderTracePathCard(card: HTMLElement, data: any): HTMLElement {
		const hops = data.hops || data.path || [];
		if (!Array.isArray(hops) || hops.length === 0) { return card; }

		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${hops.length} hops`));
		if (data.mode) { append(strip, $('span.codebase-stat', undefined, `mode: ${data.mode}`)); }

		for (let i = 0; i < Math.min(hops.length, 15); i++) {
			const h = hops[i];
			const row = append(card, $('.codebase-trace-hop'));
			append(row, $('span.codebase-hop-num', undefined, `H${i}`));
			if (i > 0) { append(row, $('span.codebase-hop-arrow', undefined, '→')); }
			append(row, $('span.codebase-hop-name', undefined, h.name || h.function || h.callee || h.caller || '?'));

			const risk = h.risk || (h.depth >= 3 ? 'High' : h.depth >= 2 ? 'Med' : 'Low');
			const riskClass = risk === 'Critical' ? 'codebase-risk-crit' : risk === 'High' ? 'codebase-risk-high' : risk === 'Med' ? 'codebase-risk-med' : 'codebase-risk-low';
			append(row, $('span.codebase-hop-risk.' + riskClass, undefined, risk));
		}

		return card;
	}

protected override _renderIndexRepoCard(card: HTMLElement, data: any): HTMLElement {
		const strip = append(card, $('.codebase-summary'));
		if (data.success !== false) {
			append(strip, $('span.codebase-stat.codebase-stat-ok', undefined, '✓ success'));
		} else {
			append(strip, $('span.codebase-stat.codebase-stat-err', undefined, '✗ failed'));
		}
		if (data.message) {
			append(strip, $('span.codebase-stat', undefined, data.message));
		}

		const grid = append(card, $('.codebase-arch-grid'));
		if (data.filesScanned) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.filesScanned)));
			append(cell, $('.codebase-arch-label', undefined, 'Files Scanned'));
		}
		if (data.nodesExtracted) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.nodesExtracted)));
			append(cell, $('.codebase-arch-label', undefined, 'Nodes'));
		}
		if (data.edgesExtracted) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.edgesExtracted)));
			append(cell, $('.codebase-arch-label', undefined, 'Edges'));
		}
		const excludedDirs = data.excludedDirs || data.skipped || [];
		if (excludedDirs.length > 0) {
			append(card, $('.codebase-page-hint', undefined, `⏭️ Skipped: ${Array.isArray(excludedDirs) ? excludedDirs.length : excludedDirs} paths (e.g. ${String(Array.isArray(excludedDirs) ? excludedDirs.slice(0, 3).join(', ') : excludedDirs)})`));
		}

		return card;
	}

protected override _renderCodebaseSummaryCard(card: HTMLElement, key: string, data: any): HTMLElement {
		// 提取关键字段
		const keys = Object.keys(data).filter(k => !['success', 'message', 'hint', '_scopePath', '_scoped'].includes(k));
		const grid = append(card, $('.codebase-arch-grid'));
		for (const k of keys.slice(0, 6)) {
			const v = data[k];
			if (v === null || v === undefined) { continue; }
			const display = typeof v === 'object' ? JSON.stringify(v).substring(0, 60) : String(v);
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, display));
			append(cell, $('.codebase-arch-label', undefined, k));
		}
		return card;
	}

}