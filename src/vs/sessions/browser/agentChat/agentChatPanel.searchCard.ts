import { $, append } from '../../../base/browser/dom.js';
import { IToolCall } from './agentChatTypes.js';
import { parseSearchResultItems, parseToonGraphData, parseToonTraceData, type SearchResultItem, type ToonGraphData, type ToonTraceData } from './agentChatPanel.searchResultParse.js';
import { AgentChatPanelConfirmCards } from './agentChatPanel.confirmCards.js';
import { createSvgIcon, SEARCH_ICON_D } from './agentChatPanel.toolCards.js';

/**
 * 搜索/查询专用工具卡片（search_code / search_files / search_graph / query_graph / trace_path）+ TOON 渲染。
 * 自 agentChatPanel.toolCards.ts 抽离（上帝对象拆分）。继承链 ToolCards → SearchCard → MermaidCard。
 * 注：web_search / web_extract / anysearch 已迁移到 agentChatPanel.webCard.ts（WebCard 位于本类之上）。
 */
export abstract class AgentChatPanelSearchCard extends AgentChatPanelConfirmCards {
	/**
	 * 搜索/查询专用卡片：search_code / search_graph / search_files / query_graph / trace_path。
	 * 默认折叠：显示搜索栏 + 匹配数摘要；点击搜索栏展开结果列表（T 徽标+文件名+行号）。
	 * 使用原生 DOM，零 innerHTML。
	 */
	protected override _createSearchToolCard(tc: IToolCall, key: string): HTMLElement {
		const wrapper = $('.tool-card.tool-card-search');
		const isRunning = tc.status === 'running';
		const isErr = tc.status === 'error';

		// ── 解析查询参数 ──
		let query = '';
		let project = '';
		try {
			if (tc.args) {
			const args = JSON.parse(tc.args);
			query = args.query || args.pattern || args.q || args.keyword || args.name || '';
			// 多根工作区：LLM 可指定 project 限定搜索根，标题展示以区分同 query 不同根的卡片
			project = (args.project || args.projects || '') || '';
				// 工具特定的主检索字段（通用字段未命中时回退）
				if (!query) {
					switch (key) {
						case 'get_code_snippet':
							query = args.qualifiedName || args.qualified_name || args.id || '';
							break;
						case 'query_graph':
							query = args.cypher || '';
							break;
						case 'trace_path':
							query = [args.source, args.target].filter(Boolean).join(' → ') || args.sourceName || args.targetName || '';
							break;
						case 'get_architecture':
							query = args.dimensions || args.aspects || '';
							break;
						default:
							query = '';
					}
				}
			}
		} catch { /* ignore */ }

		// ── 标题行（整行可点击展开/折叠）──
		const header = append(wrapper, $('.tool-header'));
		const iconEl = append(header, $('span.tool-icon'));
		iconEl.appendChild(createSvgIcon(SEARCH_ICON_D));

		const titleMap: Record<string, string> = {
			search_code: '代码搜索',
			search_graph: '图谱搜索',
			search_files: '搜索',
			query_graph: '图谱查询',
			trace_path: '调用链追踪',
			get_architecture: '架构概览',
			get_code_snippet: '获取代码片段',
		};

		// 标题：类型 + 搜索内容（query）
		const title = append(header, $('span.tool-title'));
		const baseLabel = titleMap[key] || '搜索';
		if (query) {
			title.textContent = `${baseLabel} · `;
			const qSpan = append(title, $('span.search-title-query'));
			qSpan.textContent = String(query).slice(0, 80);
			// 多根工作区：同 query 不同 project 的并行搜索卡片，展示根名以区分
			if (project) {
				title.appendChild(document.createTextNode(' '));
				const pSpan = append(title, $('span.search-title-project'));
				pSpan.textContent = `[${String(project).slice(0, 40)}]`;
			}
		} else {
			title.textContent = baseLabel;
		}
		if (isRunning) { title.classList.add('shimmer'); }

	// 匹配数徽标（标题右侧）— 仅统计有效文件路径项
	let totalItems = 0;
	if (tc.result && !isRunning) {
		const raw = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
		const resultText = this._toolResultText(raw);
		const items = this._parseSearchResultItems(resultText, key);
		totalItems = items ? items.length : 0;
	}
		if (!isRunning && totalItems > 0) {
			const countBadge = append(header, $('span.search-header-count'));
			countBadge.textContent = `${totalItems}`;
		}

		if (typeof tc.duration === 'number' && tc.duration >= 0) {
			const dur = append(header, $('span.tool-duration'));
			dur.textContent = this._formatDuration(tc.duration);
		}

		// 展开箭头
		const chevron = append(header, $('span.search-bar-chevron'));
		chevron.appendChild(this._createChevronIcon());

		if (isErr) { wrapper.classList.add('tool-card-error'); }

		// ── 结果区域（固定高度，内部滚动）──
		const resultsArea = append(wrapper, $('.search-results-area'));
		// TOON 卡片：外层不滚动（内层 .toon-table-wrap 已有 overflow-y: auto）
		if (tc.result && !isRunning) {
			const raw = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
			const resultText = this._toolResultText(raw);
			if (resultText.startsWith('TOON ')) { resultsArea.classList.add('toon-card'); }
		}
		// 始终可展开（无结果时展示 "没有找到匹配结果" 占位，不再让卡片 "死了"）
		if (tc.result && !isRunning) {
			const raw = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
			const resultText = this._toolResultText(raw);

			// TOON 格式富卡片渲染（search_graph / trace_path）
			if (this._tryRenderToonCard(resultsArea, resultText, key)) {
				// rendered
			} else {
				const items = this._parseSearchResultItems(resultText, key);
				if (items && items.length > 0) {
					const list = append(resultsArea, $('ul.search-result-list'));
					const displayItems = items.slice(0, 200);
					for (const item of displayItems) {
						const li = append(list, $('li.search-result-item'));
						this._renderSearchResultItem(li, item);
					}
					if (items.length > 200) {
						const more = append(resultsArea, $('.search-more'));
						more.textContent = `... 还有 ${items.length - 200} 条结果`;
					}
				} else {
					// 无结构化结果：尝试原始文本预览，否则显示 "没有找到匹配结果"
					const lines = resultText.split('\n').filter(l => l.trim()).slice(0, 8);
					if (lines.length > 0) {
						const preview = append(resultsArea, $('.search-text-preview'));
						preview.textContent = lines.join('\n').slice(0, 600);
					} else {
						const noMatch = append(resultsArea, $('.search-no-match'));
						noMatch.textContent = '没有找到匹配结果';
					}
				}
			}
		} else if (isRunning) {
			const progress = append(resultsArea, $('.search-progress'));
			progress.textContent = '\u23F3 正在搜索...'; // ⏳
		}

		// 始终可展开
		header.addEventListener('click', () => {
			const isExpanded = wrapper.classList.toggle('expanded');
			chevron.classList.toggle('expanded', isExpanded);
		});

		return wrapper;
	}

	/**
	 * 解析搜索工具返回的结果为结构化列表项。
	 * 支持 search_graph (nodes[])、search_code (results[])、search_files (uris/items[])
	 * 以及通用字符串数组。
	 */
	private _parseSearchResultItems(
		resultText: string,
		key: string
	): SearchResultItem[] | null {
		return parseSearchResultItems(resultText, key);
	}

	/** 渲染单个搜索结果项（文件名 + 行号范围，不含类型徽标） */
	private _renderSearchResultItem(li: HTMLElement, item: {
		name: string; path?: string; lineStart?: number | string; lineEnd?: number | string; type?: string;
	}): void {
		// 文件信息区（仅文件名 + 行号，已移除类型徽标）
		const info = append(li, $('span.search-result-file-info'));
		const nameEl = append(info, $('span.search-result-file-name'));
		nameEl.textContent = item.name;

		// 行号范围
		if (item.lineStart != null) {
			const rangeEl = append(info, $('span.search-result-line-range'));
			if (item.lineEnd != null && item.lineEnd !== item.lineStart) {
				rangeEl.textContent = `L${item.lineStart}-L${item.lineEnd}`;
			} else {
				rangeEl.textContent = `L${item.lineStart}`;
			}
		}

		// 点击跳转到文件
		if (item.path) {
			li.addEventListener('click', () => {
				const line = typeof item.lineStart === 'number' ? item.lineStart
					: typeof item.lineStart === 'string' ? parseInt(item.lineStart, 10) || undefined
						: undefined;
				this._onOpenFile?.(item.path!, line);
			});
		}
	}

	/**
	 * 尝试用 TOON 富卡片渲染结果。成功返回 true，否则返回 false 由调用方回退。
	 * 支持 search_graph（节点表格）和 trace_path（hop 链）。
	 */
	private _tryRenderToonCard(
		parent: HTMLElement,
		resultText: string,
		key: string,
	): boolean {
		// search_graph TOON
		if (key === 'search_graph') {
			const data = parseToonGraphData(resultText);
			if (data) { this._renderToonGraphCard(parent, data); return true; }
			return false;
		}
		// trace_path TOON
		if (key === 'trace_path') {
			const data = parseToonTraceData(resultText);
			if (data) { this._renderToonTraceCard(parent, data); return true; }
			return false;
		}
		return false;
	}

	/** 渲染 search_graph TOON 卡片（summary + 表格 + semantic，虚拟滚动 + 事件委托 + 批量 DOM） */
	private _renderToonGraphCard(parent: HTMLElement, data: ToonGraphData): void {
		const { total, returned, nodes, scores, semanticResults } = data;

		// ── 摘要条 ──
		const strip = append(parent, $('.toon-strip'));
		const returnedCount = returned > 0 ? Math.min(returned, nodes.length) : nodes.length;
		append(strip, $('.toon-stat')).textContent = `${returnedCount} / ${total} 显示`;
		if (semanticResults && semanticResults.length > 0) {
			const sem = append(strip, $('.toon-stat.toon-stat-sem'));
			sem.textContent = `+${semanticResults.length} semantic`;
		}

		// ── 主表格（虚拟滚动 + 事件委托 + 批量 DOM）──
		if (nodes.length > 0) {
			const hasScore = !!scores;
			// 列定义：rank / name / type / file / score
			const colDefs = [
				{ key: 'rank', label: '#', initialWidth: 30, minWidth: 24 },
				{ key: 'name', label: 'Symbol', initialWidth: 200, minWidth: 80 },
				{ key: 'type', label: 'Type', initialWidth: 70, minWidth: 50 },
				{ key: 'file', label: 'File', initialWidth: 160, minWidth: 80 },
			] as const;
			if (hasScore) {
				(colDefs as any).push({ key: 'score', label: 'Score', initialWidth: 50, minWidth: 40 });
			}

			// 当前列宽（px）
			const colWidths: number[] = colDefs.map(c => c.initialWidth);
			const tableWrap = append(parent, $('.toon-table-wrap'));
			// 自适应 maxHeight：条目少时容器贴合内容，避免 1/1 等场景下空滚动条（2026-07-29）。
			// 行高 ~26px（12px * 1.5 行高 + 4px×2 padding），表头 24px，容器 padding 8px。
			const adaptiveMaxH = Math.min(400, 32 + 26 * nodes.length);
			tableWrap.style.maxHeight = adaptiveMaxH + 'px';
			tableWrap.style.overflowY = 'auto';
			const table = append(tableWrap, $('.toon-table'));

			// 表头（含拖拽手柄）
			const headerRow = append(table, $('.toon-row.toon-row-head'));
			for (let i = 0; i < colDefs.length; i++) {
				const def = colDefs[i];
				const colEl = append(headerRow, $('.toon-col.toon-col-' + def.key));
				colEl.textContent = def.label;
				colEl.style.width = def.initialWidth + 'px';
				colEl.style.minWidth = def.minWidth + 'px';
				colEl.style.maxWidth = def.initialWidth + 'px';
				colEl.style.flex = '0 0 auto';
				// 最后一列不添加手柄
				if (i < colDefs.length - 1) {
					const handle = append(colEl, $('.toon-resize-handle'));
					handle.addEventListener('mousedown', (e) => {
						e.preventDefault();
						e.stopPropagation();
						this._startColResize(table, i, colWidths, colDefs, e);
					});
				}
			}

			// ── 虚拟滚动：只渲染可见行，用占位符支撑滚动高度 ──
			const ROW_HEIGHT = 24; // 每行约 24px
			const VISIBLE_BUFFER = 10; // 上下各预渲染 10 行缓冲
			const totalHeight = nodes.length * ROW_HEIGHT;
			const spacer = append(table, $('.toon-spacer'));
			spacer.style.height = totalHeight + 'px';
			spacer.style.position = 'relative';

			// 事件委托：点击事件绑定在容器上，用 data-rank 定位行
			table.addEventListener('click', (e) => {
				const target = e.target as HTMLElement;
				const row = target.closest('.toon-row') as HTMLElement;
				if (!row || row.classList.contains('toon-row-head')) { return; }
				const rank = parseInt(row.getAttribute('data-rank') || '0', 10);
				if (rank > 0) {
					const node = nodes[rank - 1];
					if (node) { this._onOpenFile?.(node.filePath, node.startLine); }
				}
			});

			// 批量 DOM：用 DocumentFragment 一次性创建行，减少重排
			const renderRows = (startIdx: number, endIdx: number): void => {
				const frag = document.createDocumentFragment();
				for (let i = startIdx; i < endIdx && i < nodes.length; i++) {
					const node = nodes[i];
					const row = document.createElement('div');
					row.className = 'toon-row';
					row.setAttribute('data-rank', String(i + 1));
					row.style.position = 'absolute';
					row.style.top = (i * ROW_HEIGHT) + 'px';
					row.style.width = '100%';
					row.style.display = 'flex';

					// rank
					const rankEl = document.createElement('span');
					rankEl.className = 'toon-col toon-col-rank';
					rankEl.textContent = String(i + 1);
					row.appendChild(rankEl);
					// name
					const nameEl = document.createElement('span');
					nameEl.className = 'toon-col toon-col-name';
					nameEl.textContent = node.name;
					if (node.startLine > 0) {
						const ln = document.createElement('span');
						ln.className = 'toon-loc';
						ln.textContent = `:${node.startLine}`;
						nameEl.appendChild(ln);
					}
					row.appendChild(nameEl);
					// type
					const typeEl = document.createElement('span');
					typeEl.className = 'toon-col toon-col-type';
					typeEl.textContent = node.type || '-';
					row.appendChild(typeEl);
					// file
					const fileEl = document.createElement('span');
					fileEl.className = 'toon-col toon-col-file';
					fileEl.textContent = node.filePath.split(/[\\/]/).pop() || node.filePath;
					row.appendChild(fileEl);
					// score
					if (hasScore) {
						const sc = document.createElement('span');
						sc.className = 'toon-col toon-col-score';
						sc.textContent = (scores![node.filePath] ?? 0).toFixed(2);
						row.appendChild(sc);
					}
					frag.appendChild(row);
				}
				spacer.appendChild(frag);
			};

			// 初始渲染前 VISIBLE_BUFFER * 2 行
			renderRows(0, Math.min(VISIBLE_BUFFER * 2, nodes.length));

			// 滚动监听：根据滚动位置渲染可见行
			const onScroll = (): void => {
				const scrollTop = tableWrap.scrollTop;
				const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER);
				const endIdx = Math.min(nodes.length, startIdx + VISIBLE_BUFFER * 2 + Math.ceil(tableWrap.clientHeight / ROW_HEIGHT));
				// 清除所有行，重新渲染（简单方案，避免复杂 diff）
				const existingRows = spacer.querySelectorAll('.toon-row:not(.toon-row-head)');
				for (const r of existingRows) { r.remove(); }
				renderRows(startIdx, endIdx);
			};
			tableWrap.addEventListener('scroll', onScroll, { passive: true });
		}

		// ── Semantic Results（事件委托 + 批量 DOM）──
		if (semanticResults && semanticResults.length > 0) {
			const secTitle = append(parent, $('.toon-sec-title'));
			secTitle.textContent = '🔮 Semantic Results';
			const semContainer = append(parent, $('.toon-sem-container'));
			// 事件委托
			semContainer.addEventListener('click', (e) => {
				const target = e.target as HTMLElement;
				const row = target.closest('.toon-row-sem') as HTMLElement;
				if (!row) { return; }
				const rank = parseInt(row.getAttribute('data-rank') || '0', 10);
				if (rank > 0) {
					const sn = semanticResults[rank - 1];
					if (sn) { this._onOpenFile?.(sn.filePath, sn.startLine); }
				}
			});
			// 批量 DOM
			const frag = document.createDocumentFragment();
			for (let i = 0; i < Math.min(semanticResults.length, 20); i++) {
				const sn = semanticResults[i];
				const row = document.createElement('div');
				row.className = 'toon-row toon-row-sem';
				row.setAttribute('data-rank', String(i + 1));
				row.style.display = 'flex';

				const rankEl = document.createElement('span');
				rankEl.className = 'toon-col toon-col-rank';
				rankEl.textContent = `s${sn.rank}`;
				row.appendChild(rankEl);

				const nameEl = document.createElement('span');
				nameEl.className = 'toon-col toon-col-name';
				nameEl.textContent = sn.name;
				if (sn.startLine > 0) {
					const ln = document.createElement('span');
					ln.className = 'toon-loc';
					ln.textContent = `:${sn.startLine}`;
					nameEl.appendChild(ln);
				}
				row.appendChild(nameEl);

				const typeEl = document.createElement('span');
				typeEl.className = 'toon-col toon-col-type';
				typeEl.textContent = sn.type || '-';
				row.appendChild(typeEl);

				const fileEl = document.createElement('span');
				fileEl.className = 'toon-col toon-col-file';
				fileEl.textContent = sn.filePath.split(/[\\/]/).pop() || sn.filePath;
				row.appendChild(fileEl);

				const sc = document.createElement('span');
				sc.className = 'toon-col toon-col-score';
				sc.textContent = sn.score != null ? sn.score.toFixed(2) : '-';
				row.appendChild(sc);

				frag.appendChild(row);
			}
			semContainer.appendChild(frag);
		}
	}

	/** 启动列宽拖拽。idx 为被拖拽的列索引（非最后一列）。 */
	private _startColResize(
		table: HTMLElement,
		colIdx: number,
		colWidths: number[],
		colDefs: readonly { key: string; label: string; initialWidth: number; minWidth: number }[],
		e: MouseEvent,
	): void {
		const startX = e.clientX;
		const startWidth = colWidths[colIdx];
		const minWidth = colDefs[colIdx].minWidth; // 固定下限，不受当前宽度影响
		const tableEl = table;

		const onMouseMove = (ev: MouseEvent) => {
			const delta = ev.clientX - startX;
			const newWidth = Math.max(minWidth, startWidth + delta);
			colWidths[colIdx] = newWidth;
			// 更新表头所有该列的宽度
			const headerCols = tableEl.querySelectorAll('.toon-row-head .toon-col');
			if (headerCols[colIdx]) {
				const col = headerCols[colIdx] as HTMLElement;
				col.style.width = newWidth + 'px';
				col.style.maxWidth = newWidth + 'px';
				col.style.flex = '0 0 auto'; // 覆盖 CSS flex，确保 JS 宽度生效
			}
			// 更新所有数据行该列的宽度
			const rows = tableEl.querySelectorAll('.toon-row:not(.toon-row-head)');
			for (const row of rows) {
				const cols = row.querySelectorAll('.toon-col');
				if (cols[colIdx]) {
					const col = cols[colIdx] as HTMLElement;
					col.style.width = newWidth + 'px';
					col.style.maxWidth = newWidth + 'px';
					col.style.flex = '0 0 auto'; // 覆盖 CSS flex
				}
			}
		};

		const onMouseUp = () => {
			this._ownerDocument.removeEventListener('mousemove', onMouseMove);
			this._ownerDocument.removeEventListener('mouseup', onMouseUp);
			this._ownerDocument.body.style.cursor = '';
			this._ownerDocument.body.style.userSelect = '';
		};

		this._ownerDocument.addEventListener('mousemove', onMouseMove);
		this._ownerDocument.addEventListener('mouseup', onMouseUp);
		this._ownerDocument.body.style.cursor = 'col-resize';
		this._ownerDocument.body.style.userSelect = 'none';
	}

	/** 渲染 trace_path TOON 卡片（hop 链） */
	private _renderToonTraceCard(parent: HTMLElement, data: ToonTraceData): void {
		const { hops, depth, hasCycle, from, to, hopList } = data;

		// ── 摘要条 ──
		const strip = append(parent, $('.toon-strip'));
		append(strip, $('.toon-stat')).textContent = `${hops} hops`;
		append(strip, $('.toon-stat')).textContent = `depth: ${depth}`;
		if (hasCycle) {
			const cyc = append(strip, $('.toon-stat.toon-stat-warn'));
			cyc.textContent = 'hasCycle';
		}

		// ── Hop 链（事件委托 + 批量 DOM）──
		if (hopList.length > 0) {
			const hasRisk = hopList.some(h => h.risk);
			const hasEdge = hopList.some(h => h.edgeType);
			const hasScore = hopList.some(h => h.score != null);

			const chain = append(parent, $('.toon-trace-chain'));
			// 事件委托
			chain.addEventListener('click', (e) => {
				const target = e.target as HTMLElement;
				const row = target.closest('.toon-trace-hop') as HTMLElement;
				if (!row) { return; }
				const rank = parseInt(row.getAttribute('data-rank') || '0', 10);
				if (rank > 0) {
					const hop = hopList[rank - 1];
					if (hop) { this._onOpenFile?.(hop.filePath, hop.startLine); }
				}
			});
			// 批量 DOM
			const frag = document.createDocumentFragment();
			for (let i = 0; i < hopList.length; i++) {
				const hop = hopList[i];
				const hopRow = document.createElement('div');
				hopRow.className = 'toon-trace-hop';
				hopRow.setAttribute('data-rank', String(i + 1));
				hopRow.style.display = 'flex';

				// Hop 编号
				const numEl = document.createElement('span');
				numEl.className = 'toon-trace-num';
				numEl.textContent = `H${hop.depth}`;
				hopRow.appendChild(numEl);
				// 箭头（非第一个）
				if (i > 0) {
					const arrow = document.createElement('span');
					arrow.className = 'toon-trace-arrow';
					arrow.textContent = '→';
					hopRow.appendChild(arrow);
				}
				// 符号名
				const nameEl = document.createElement('span');
				nameEl.className = 'toon-trace-name';
				nameEl.textContent = hop.name;
				if (hop.startLine > 0) {
					const ln = document.createElement('span');
					ln.className = 'toon-loc';
					ln.textContent = `:${hop.startLine}`;
					nameEl.appendChild(ln);
				}
				hopRow.appendChild(nameEl);
				// 类型
				const typeEl = document.createElement('span');
				typeEl.className = 'toon-col toon-col-type';
				typeEl.textContent = hop.type || '-';
				hopRow.appendChild(typeEl);
				// 文件
				const fileEl = document.createElement('span');
				fileEl.className = 'toon-col toon-col-file';
				fileEl.textContent = hop.filePath.split(/[\\/]/).pop() || hop.filePath;
				hopRow.appendChild(fileEl);
				// edgeType
				if (hasEdge) {
					const edgeEl = document.createElement('span');
					edgeEl.className = 'toon-col toon-col-edge';
					edgeEl.textContent = hop.edgeType || '';
					hopRow.appendChild(edgeEl);
				}
				// risk
				if (hasRisk) {
					const risk = document.createElement('span');
					risk.className = `toon-risk risk-${(hop.risk || 'low').toLowerCase()}`;
					risk.textContent = hop.risk || 'Low';
					hopRow.appendChild(risk);
				}
				// score
				if (hasScore) {
					const sc = document.createElement('span');
					sc.className = 'toon-col toon-col-score';
					sc.textContent = hop.score != null ? hop.score.toFixed(2) : '-';
					hopRow.appendChild(sc);
				}
				frag.appendChild(hopRow);
			}
			chain.appendChild(frag);
		}

		// ── 路径提示 ──
		const hint = append(parent, $('.toon-page-hint'));
		hint.textContent = `🔗 ${from} → ${to} (${hops} hops, depth ${depth})`;
	}

	/** 创建 chevron SVG 图标（用于折叠/展开） */
	protected _createChevronIcon(): SVGElement {
		const svg = $.SVG('svg', { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'currentColor' });
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path') as SVGPathElement;
		path.setAttribute('d', 'M6 4l4 4-4 4');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
		return svg;
	}
}
