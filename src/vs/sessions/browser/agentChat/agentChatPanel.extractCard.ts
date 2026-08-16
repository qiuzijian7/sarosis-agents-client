import { $, append } from '../../../base/browser/dom.js';
import { IToolCall } from './agentChatTypes.js';

/**
 * 抓取/提取工具专用卡片：web_extract（DDG html→lite + parallel instant answer）。
 *
 * 与搜索卡片的区别：返回**整页内容**而非匹配列表。
 * UI 展示：URL + 页面标题 + 内容字符数 + 可折叠内容预览。
 * 默认折叠，运行中显示 spinner。
 */

/** 抓取卡片展开状态持久化（key = tc.id 或 tc.name+url），在重渲染后能恢复 */
const _extractExpandState = new Map<string, boolean>();

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

/** 解析 tc.args —— 兼容 string(JSON) / object / undefined 三种形态。 */
function _parseArgs(raw: unknown): Record<string, unknown> {
	if (!raw) { return {}; }
	if (typeof raw === 'object') { return raw as Record<string, unknown>; }
	if (typeof raw === 'string') {
		try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
	}
	return {};
}

export function createExtractToolCard(tc: IToolCall, key: string): HTMLElement {
	const wrapper = $('.tool-card.tool-card-extract');
	const isRunning = tc.status === 'running';
	const isErr = tc.status === 'error';

	// ── 解析参数 ──
	// tc.args 是 JSON 字符串（IToolCall/ISubAgentToolTrace 定义），需先 parse 才能取 url
	const args = _parseArgs(tc.args);
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
	const wasExpanded = _extractExpandState.get(stateKey) === true;
	if (wasExpanded) {
		body.classList.add('tool-header-children-expanded');
		chevron.classList.add('tool-header-chevron-expanded');
	}
	header.addEventListener('click', (e) => {
		// 阻止 link 上的 click 冒泡触发收起
		if ((e.target as HTMLElement).closest('a')) { return; }
		const expanded = body.classList.toggle('tool-header-children-expanded');
		chevron.classList.toggle('tool-header-chevron-expanded', expanded);
		_extractExpandState.set(stateKey, expanded);
	});

	return wrapper;
}
