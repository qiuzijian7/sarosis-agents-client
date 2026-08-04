import { $, append } from '../../../base/browser/dom.js';
import { IToolCall } from './agentChatTypes.js';
import { AgentChatPanelSearchCard } from './agentChatPanel.searchCard.js';
import { createSvgIcon, SEARCH_ICON_D, parseToolArgs } from './agentChatPanel.toolCards.js';

/**
 * Web 族工具卡片：web_search / web_extract / anysearch（execute_code 运行 anysearch_cli.py）。
 *
 * 自 agentChatPanel.searchCard.ts / agentChatPanel.extractCard.ts 抽离统一：
 * - web_search：搜索栏壳（查询词 + 结果数徽标）+ 展开体 markdown 渲染（链接可点）。
 * - web_extract：URL + 页面标题 + 字符数 + 可折叠内容预览（展开态持久化）。
 * - anysearch：命令 + 查询词 + 输出预览（execute_code 的专用呈现）。
 *
 * 继承链：ConfirmCards → SearchCard → WebCard → MermaidCard → Markdown → ...
 */

// ════════════════════════════════════════════════════════════
// 模块级：web_extract 卡片实现（自 extractCard.ts 迁入，纯函数无 this 依赖）
// ════════════════════════════════════════════════════════════

/** 抓取卡片展开状态持久化（key = tc.id 或 tc.name+url），在重渲染后能恢复 */
const _webCardExpandState = new Map<string, boolean>();

/** 从 URL 派生一个易读的标题（用于主进程未返回 title 的场景）。 */
function deriveTitleFromUrl(rawUrl: string): string {
	if (!rawUrl) { return ''; }
	try {
		const u = new URL(rawUrl);
		const lastSeg = u.pathname.replace(/\/+$/, '').split('/').pop() || u.hostname;
		// 把 kebab/snake 转成空格、首字母大写
		const pretty = decodeURIComponent(lastSeg)
			.replace(/[-_]+/g, ' ')
			.replace(/\.\w+$/, '') // 去后缀
			.trim();
		return pretty
			? pretty.replace(/\b\w/g, (c) => c.toUpperCase())
			: u.hostname;
	} catch {
		return rawUrl;
	}
}

/** 判断 title 是否实质上"等于 URL"（即主进程没拿到标题，回退成了 URL） */
function isTitleJustUrl(title: string, url: string): boolean {
	if (!title) { return true; }
	if (!url) { return false; }
	// 含协议或主机名即视为 URL 字符串
	return /^https?:\/\//i.test(title) || title === url;
}

/** 从 anysearch CLI 命令中解析子命令与查询词。 */
function parseAnysearchCommand(cmd: string): { subcommand: string; query: string } {
	const sub = cmd.match(/anysearch_cli\.py\s+(\w+)/);
	const qm = cmd.match(/--query[=\s]+"([^"]+)"/)
		?? cmd.match(/--query[=\s]+'([^']+)'/)
		?? cmd.match(/--query[=\s]+(\S+)/);
	let query = qm?.[1] ?? '';
	// 无 --query 时回退：search "text" 位置参数
	if (!query && sub?.[1] === 'search') {
		const pos = cmd.match(/anysearch_cli\.py\s+search\s+"([^"]+)"/)
			?? cmd.match(/anysearch_cli\.py\s+search\s+'([^']+)'/);
		query = pos?.[1] ?? '';
	}
	return { subcommand: sub?.[1] ?? '', query };
}

function createWebExtractCard(tc: IToolCall): HTMLElement {
	const wrapper = $('.tool-card.tool-card-extract');
	const isRunning = tc.status === 'running';
	const isErr = tc.status === 'error';

	// ── 解析参数 ──
	// tc.args 是 JSON 字符串（IToolCall/ISubAgentToolTrace 定义），需先 parse 才能取 url
	const args = parseToolArgs(tc.args);
	const url = typeof args.url === 'string' ? args.url : '';

	// ── 解析结果 ──
	let rawTitle = '';
	let content = '';
	let fullResultLen = 0;
	if (tc.result) {
		const result = tc.result;
		if (typeof result === 'string') {
			// web_extract 返回 # Title\n\nURL: ...\n\n{body} 格式
			const titleMatch = result.match(/^#\s*(.+?)$/m);
			if (titleMatch) { rawTitle = titleMatch[1].trim(); }
			fullResultLen = result.length;
			// 仅取正文（去掉 # Title\n\nURL: ...\n\n 前缀），供字符数与预览使用
			const bodyMatch = result.match(/^#\s*.+?\n\nURL:\s*.+?\n\n([\s\S]*)$/);
			content = bodyMatch ? bodyMatch[1] : result;
		} else if (typeof result === 'object') {
			const obj = result as Record<string, unknown>;
			if (typeof obj.title === 'string') { rawTitle = obj.title; }
			if (typeof obj.content === 'string') { content = obj.content; }
			if (typeof obj.charCount === 'number') { fullResultLen = obj.charCount; }
		}
	}
	// 若解析到的 title 实际是 URL（主进程没拿到标题），用 URL 派生一个易读标题
	const title = isTitleJustUrl(rawTitle, url) ? deriveTitleFromUrl(url) : rawTitle;
	// 字符数用纯正文长度（不含 # Title\n\nURL: \n\n 前缀）
	const charCount = content.length || fullResultLen;

	// ── Header ──
	const header = append(wrapper, $('.tool-header'));
	header.setAttribute('data-part-key', `tool:${tc.id ?? 'auto'}`);

	append(header, $('.tool-card-icon')).textContent = '🌐';
	append(header, $('span.tool-title')).textContent = '抓取';
	// 描述优先显示页面标题；没有标题再回退到 URL
	append(header, $('span.tool-desc')).textContent = title || url;

	// Status badge（带 spinner 动画）
	const badge = append(header, $('span.tool-status'));
	badge.classList.add(
		isRunning ? 'tool-card-running' : isErr ? 'tool-card-error' : 'tool-card-success'
	);
	if (isRunning) {
		// 运行时：spinner + "抓取中"（明确文字 + 旋转图标，不让用户误以为已完成）
		const spinner = append(badge, $('span.tool-status-spinner'));
		spinner.textContent = '◐';
		append(badge, $('span.tool-status-text')).textContent = '抓取中';
	} else if (isErr) {
		append(badge, $('span.tool-status-text')).textContent = '失败';
	} else {
		append(badge, $('span.tool-status-text')).textContent = '完成';
	}

	// Chevron
	const chevron = append(header, $('.tool-header-chevron'));
	chevron.textContent = '▶';

	// ── 摘要行（默认可见）──
	const summary = append(wrapper, $('.tool-header-summary'));
	const summaryText = append(summary, $('span.tool-summary-text'));
	if (isRunning) {
		summaryText.textContent = `抓取中 ${url || ''}`;
	} else if (charCount > 0) {
		summaryText.textContent = `已抓取 ${charCount.toLocaleString()} 字符`;
	} else if (isErr) {
		summaryText.textContent = '抓取失败';
	} else {
		summaryText.textContent = '等待结果';
	}

	// ── Body（折叠内容）──
	const body = append(wrapper, $('.tool-header-children'));

	// URL（可点击）
	if (url) {
		const urlRow = append(body, $('.extract-url-row'));
		append(urlRow, $('span.extract-label')).textContent = 'URL';
		const urlLink = append(urlRow, $('a.extract-value.extract-url-link')) as HTMLAnchorElement;
		urlLink.href = url;
		urlLink.textContent = url;
		urlLink.title = url;
		urlLink.target = '_blank';
		urlLink.rel = 'noopener noreferrer';
	}

	// 标题
	if (title) {
		const titleRow = append(body, $('.extract-title-row'));
		append(titleRow, $('span.extract-label')).textContent = '页面标题';
		append(titleRow, $('span.extract-value')).textContent = title;
	}

	// 内容预览（运行中显示 spinner，完成后显示内容）
	if (content) {
		const contentLabel = append(body, $('div.extract-content-label'));
		contentLabel.textContent = `内容预览 (${charCount.toLocaleString()} 字符)`;
		const contentBox = append(body, $('div.extract-content-box'));
		contentBox.textContent = content.length > 4000 ? content.slice(0, 4000) + '\n\n... (内容已截断)' : content;
	} else if (isRunning) {
		const pending = append(body, $('div.extract-pending'));
		pending.textContent = '正在抓取页面内容…';
	} else if (isErr && tc.error) {
		const errBox = append(body, $('div.extract-error-box'));
		errBox.textContent = String(tc.error).slice(0, 2000);
	}

	// ── 展开/收起（默认折叠）──
	const stateKey = `${tc.id ?? tc.name ?? 'auto'}|${url}`;
	const wasExpanded = _webCardExpandState.get(stateKey) === true;
	if (wasExpanded) {
		body.classList.add('tool-header-children-expanded');
		chevron.classList.add('tool-header-chevron-expanded');
	}
	header.addEventListener('click', (e) => {
		// 阻止 link 上的 click 冒泡触发收起
		if ((e.target as HTMLElement).closest('a')) { return; }
		const expanded = body.classList.toggle('tool-header-children-expanded');
		chevron.classList.toggle('tool-header-chevron-expanded', expanded);
		_webCardExpandState.set(stateKey, expanded);
	});

	return wrapper;
}

// ════════════════════════════════════════════════════════════
// 类：Web 族卡片调度与实现
// ════════════════════════════════════════════════════════════

export abstract class AgentChatPanelWebCard extends AgentChatPanelSearchCard {

	/**
	 * Web 族卡片统一入口（dispatcher `_createToolCallCard` 调用）：
	 * web_search → 搜索壳 + markdown 结果；web_extract → 抓取卡片；anysearch → CLI 卡片。
	 */
	protected override _createWebToolCard(tc: IToolCall, key: string): HTMLElement {
		if (key === 'web_extract') { return createWebExtractCard(tc); }
		if (key === 'anysearch') { return this._createAnysearchCard(tc); }
		return this._createWebSearchCard(tc);
	}

	/**
	 * web_search 专用卡片：搜索栏壳（查询词 + 编号结果数徽标），
	 * 展开体用 markdown 渲染（## 标题 / 编号 **加粗标题** / URL / 摘要），链接可点击。
	 */
	protected _createWebSearchCard(tc: IToolCall): HTMLElement {
		const wrapper = $('.tool-card.tool-card-search.tool-card-web-search');
		const isRunning = tc.status === 'running';
		const isErr = tc.status === 'error';

		// ── 解析查询参数 ──
		let query = '';
		try {
			if (tc.args) {
				const args = JSON.parse(tc.args);
				query = args.query || args.q || args.keyword || '';
			}
		} catch { /* ignore */ }

		// ── 标题行（整行可点击展开/折叠）──
		const header = append(wrapper, $('.tool-header'));
		const iconEl = append(header, $('span.tool-icon'));
		iconEl.appendChild(createSvgIcon(SEARCH_ICON_D));

		const title = append(header, $('span.tool-title'));
		if (query) {
			title.textContent = 'Web 搜索 · ';
			const qSpan = append(title, $('span.search-title-query'));
			qSpan.textContent = String(query).slice(0, 80);
		} else {
			title.textContent = 'Web 搜索';
		}
		if (isRunning) { title.classList.add('shimmer'); }

		// 结果数徽标（按编号结果块统计）
		let totalItems = 0;
		if (tc.result && !isRunning) {
			const raw = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
			const resultText = this._toolResultText(raw);
			totalItems = (resultText.match(/^\s*\d+\.\s+\*\*/gm) ?? []).length;
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

		// ── 结果区域（markdown 渲染）──
		const resultsArea = append(wrapper, $('.search-results-area'));
		if (tc.result && !isRunning) {
			const raw = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
			const resultText = this._toolResultText(raw);
			const mdBody = append(resultsArea, $('.search-web-md-body'));
			this._renderMarkdownContent(mdBody, resultText, false);
		} else if (isRunning) {
			const progress = append(resultsArea, $('.search-progress'));
			progress.textContent = '⏳ 正在搜索...';
		}

		// 始终可展开
		header.addEventListener('click', () => {
			const isExpanded = wrapper.classList.toggle('expanded');
			chevron.classList.toggle('expanded', isExpanded);
		});

		return wrapper;
	}

	/**
	 * anysearch CLI 专用卡片（execute_code 运行 anysearch_cli.py 的呈现）：
	 * 查询词 + 命令 + 输出预览。壳复用 extract 卡片样式。
	 */
	protected _createAnysearchCard(tc: IToolCall): HTMLElement {
		const wrapper = $('.tool-card.tool-card-extract.tool-card-anysearch');
		const isRunning = tc.status === 'running';
		const isErr = tc.status === 'error';

		const args = parseToolArgs(tc.args);
		const command = typeof args.command === 'string' ? args.command : '';
		const { query } = parseAnysearchCommand(command);

		const raw = tc.result ? (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)) : '';
		const output = raw ? this._toolResultText(raw) : '';

		// ── Header ──
		const header = append(wrapper, $('.tool-header'));
		header.setAttribute('data-part-key', `tool:${tc.id ?? 'auto'}`);

		append(header, $('.tool-card-icon')).textContent = '🔍';
		append(header, $('span.tool-title')).textContent = 'Anysearch 搜索';
		append(header, $('span.tool-desc')).textContent = query || command.slice(0, 80);

		const badge = append(header, $('span.tool-status'));
		badge.classList.add(
			isRunning ? 'tool-card-running' : isErr ? 'tool-card-error' : 'tool-card-success'
		);
		if (isRunning) {
			const spinner = append(badge, $('span.tool-status-spinner'));
			spinner.textContent = '◐';
			append(badge, $('span.tool-status-text')).textContent = '搜索中';
		} else if (isErr) {
			append(badge, $('span.tool-status-text')).textContent = '失败';
		} else {
			append(badge, $('span.tool-status-text')).textContent = '完成';
		}

		const chevron = append(header, $('.tool-header-chevron'));
		chevron.textContent = '▶';

		// ── 摘要行 ──
		const summary = append(wrapper, $('.tool-header-summary'));
		const summaryText = append(summary, $('span.tool-summary-text'));
		if (isRunning) {
			summaryText.textContent = `搜索中 ${query || ''}`;
		} else if (output) {
			summaryText.textContent = `输出 ${output.length.toLocaleString()} 字符`;
		} else if (isErr) {
			summaryText.textContent = '搜索失败';
		} else {
			summaryText.textContent = '等待结果';
		}

		// ── Body ──
		const body = append(wrapper, $('.tool-header-children'));
		if (command) {
			const cmdRow = append(body, $('.extract-url-row'));
			append(cmdRow, $('span.extract-label')).textContent = '命令';
			append(cmdRow, $('span.extract-value')).textContent = command;
		}
		if (output) {
			const outLabel = append(body, $('div.extract-content-label'));
			outLabel.textContent = `输出 (${output.length.toLocaleString()} 字符)`;
			const outBox = append(body, $('div.extract-content-box'));
			outBox.textContent = output.length > 4000 ? output.slice(0, 4000) + '\n\n... (内容已截断)' : output;
		} else if (isRunning) {
			const pending = append(body, $('div.extract-pending'));
			pending.textContent = '正在执行 anysearch CLI…';
		} else if (isErr && tc.error) {
			const errBox = append(body, $('div.extract-error-box'));
			errBox.textContent = String(tc.error).slice(0, 2000);
		}

		// ── 展开/收起（默认折叠，展开态持久化）──
		const stateKey = `${tc.id ?? tc.name ?? 'auto'}|${command}`;
		const wasExpanded = _webCardExpandState.get(stateKey) === true;
		if (wasExpanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
		}
		header.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('a')) { return; }
			const expanded = body.classList.toggle('tool-header-children-expanded');
			chevron.classList.toggle('tool-header-chevron-expanded', expanded);
			_webCardExpandState.set(stateKey, expanded);
		});

		return wrapper;
	}
}
