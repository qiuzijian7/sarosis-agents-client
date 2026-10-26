/*
 * Markdown → HTML（服务端渲染，2026-10-25）。
 *
 * 为什么放在**服务端**而不是打进 webview bundle：
 *   · 三个宿主共用一份视图，但只有 dsh 侧能连到我们的路由；把解析器放服务端，
 *     dsh 的正文 HTML 一次到位，视图只需注入 —— 视图 bundle 不增重（当前 243KB）。
 *   · 选择器、方言插件、KaTeX 全在 Node 侧，改语法不用重打前端包。
 *   · IDE 侧宿主不提供 `html` ⇒ 视图自动回落到原来的手写渲染器（能力缺失可见）。
 *
 * 安全基线：`html: false` —— **原始 HTML 一律转义**，因此产出的 HTML 由我们自己
 * 拼出来的标签构成，不需要再跑 DOMPurify（少一个依赖、少一层解析开销）。
 * 所有拼进属性的字符串都过 `escapeHtml`。
 *
 * 方言覆盖（对齐真实库扫描结果）：
 *   frontmatter 77 篇 · Callout 189 · 双链 790 · 表格 694 · 嵌套列表 584 · 任务清单 30 · 行内数学 16
 */
import MarkdownIt from '../../vendor/markdown-it.cjs';
import frontMatter from '../../vendor/markdown-it-front-matter.cjs';
import katex from '../../vendor/katex.cjs';

/** Callout 类型 → 中文默认标题（与视图侧同一份说法） */
const CALLOUT_TITLES = {
	note: '注意', info: '信息', tip: '提示', hint: '提示', important: '重要',
	warning: '警告', caution: '小心', danger: '危险', error: '错误',
	success: '完成', check: '完成', failure: '失败', fail: '失败', bug: '缺陷',
	question: '问题', help: '帮助', faq: '问答', quote: '引用', cite: '引用',
	abstract: '摘要', summary: '摘要', tldr: '摘要', example: '示例', todo: '待办',
};

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * 轻量代码高亮（2026-10-25）。
 *
 * 为什么自己写而不引 highlight.js：那个包 3.8MB，而我们只要「注释/字符串/数字/关键字」四类
 * （与视图侧原来的四色口径一致）。这里按**片段切分后逐段转义**，不会出现
 * "在已插入的 <span> 里再匹配" 的嵌套破坏。
 */
const TOKEN_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b(?:const|let|var|function|return|if|else|for|while|class|new|import|export|from|await|async|try|catch|throw|extends|implements|interface|namespace|using|template|typename|constexpr|struct|enum|public|private|protected|static|switch|case|break|continue|def|elif|lambda|def|in|not|and|or|None|True|False|local|end|then|do|nil|self|this|void|int|float|double|bool|true|false|null|undefined|override|virtual|inline)\b)/g;

function highlightCode(code) {
	const src = String(code ?? '');
	let out = '';
	let last = 0;
	TOKEN_RE.lastIndex = 0;
	let m;
	while ((m = TOKEN_RE.exec(src)) !== null) {
		out += escapeHtml(src.slice(last, m.index));
		const token = m[0];
		let cls = 'kw';
		if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*')) { cls = 'com'; }
		else if (/^["'`]/.test(token)) { cls = 'str'; }
		else if (/^\d/.test(token)) { cls = 'num'; }
		out += `<span class="kb-tok-${cls}">${escapeHtml(token)}</span>`;
		last = m.index + token.length;
	}
	out += escapeHtml(src.slice(last));
	return out;
}

/**
 * 渲染 Markdown。
 *
 * @param {string} text 原文（**含 frontmatter**，行号要与磁盘一致）
 * @param {object} [ctx]
 * @param {(target: string) => string|undefined} [ctx.resolveWiki] `[[双链]]` 解析器
 * @returns {{ html: string, frontmatter: string, math: boolean }}
 *   `math=true` 表示包含公式 ⇒ 视图需要引入 katex 样式（由 vendor 路由提供）
 */
export function renderMarkdownHtml(text, ctx = {}) {
	const src = String(text ?? '').replace(/\r\n?/g, '\n');
	const resolveWiki = typeof ctx.resolveWiki === 'function' ? ctx.resolveWiki : () => undefined;
	let frontmatter = '';
	let hasMath = false;

	const mdit = new MarkdownIt({
		html: false,        // 原始 HTML 转义（安全基线，见文件头）
		linkify: true,      // 裸 URL 变链接（库内有 3 处 <http…>）
		breaks: false,      // 与 Obsidian 一致：单换行不断段
		typographer: false,
	});

	// ── frontmatter：交给插件吃掉，内容留给调用方（标题/别名可用） ──────────
	mdit.use(frontMatter, (fm) => { frontmatter = String(fm ?? ''); });

	// ── `[[双链]]`（真机 790 处）───────────────────────────────────────
	mdit.inline.ruler.before('link', 'kb_wikilink', (state, silent) => {
		const s = state.src;
		const pos = state.pos;
		if (s.charCodeAt(pos) !== 0x5B || s.charCodeAt(pos + 1) !== 0x5B) { return false; }
		const end = s.indexOf(']]', pos + 2);
		if (end < 0) { return false; }
		const inner = s.slice(pos + 2, end);
		if (!inner || inner.includes('\n')) { return false; }
		if (!silent) {
			// ⚠ 表格里写双链要转义竖线（`[[笔记\|别名]]`）⇒ 先把 `\|` 还原，否则目标名带反斜杠、
			//   永远解析不到（体检报告报出的 23 条断链里多数是这个原因）。
			const normalized = inner.replace(/\\\|/g, '|');
			const target = normalized.split('|')[0].split('#')[0].trim();
			const label = ((normalized.split('|')[1] ?? normalized).split('#')[0] || target).trim();
			const path = resolveWiki(target);
			const token = state.push('html_inline', '', 0);
			token.content = path
				? `<a class="kb-wiki" data-wiki="${escapeHtml(path)}" title="${escapeHtml(path)}">${escapeHtml(label)}</a>`
				: `<span class="kb-wiki-missing" data-wiki-missing="${escapeHtml(target)}" title="未找到这篇笔记：${escapeHtml(target)}">${escapeHtml(label)}</span>`;
		}
		state.pos = end + 2;
		return true;
	});

	// ── 行内数学 `$x$`（16 处）与单行块 `$$x$$` ────────────────────────
	mdit.inline.ruler.after('escape', 'kb_math', (state, silent) => {
		const s = state.src;
		const pos = state.pos;
		if (s.charCodeAt(pos) !== 0x24) { return false; }
		const double = s.charCodeAt(pos + 1) === 0x24;
		const open = double ? 2 : 1;
		const close = s.indexOf(double ? '$$' : '$', pos + open);
		if (close < 0 || close === pos + open) { return false; }
		const expr = s.slice(pos + open, close);
		if (!expr.trim() || expr.includes('\n')) { return false; }
		let html = '';
		try {
			html = katex.renderToString(expr, { throwOnError: false, displayMode: double });
			hasMath = true;
		} catch {
			html = `<code>${escapeHtml(expr)}</code>`;
		}
		if (!silent) {
			const token = state.push('html_inline', '', 0);
			token.content = html;
		}
		state.pos = close + (double ? 2 : 1);
		return true;
	});

	// ── 任务清单：`- [ ]` → 可点击 checkbox（带行号，交回视图做写回） ─────
	//   ⚠ 必须 `after('inline')`：`after('block')` 时 inline token 的 `children` 还没解析出来
	//     （children 由 inline 规则填充）⇒ 那段代码会永远看到空 children、静默不生效。
	mdit.core.ruler.after('inline', 'kb_task', (state) => {
		const tokens = state.tokens;
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.type !== 'inline' || !t.children || !t.children.length) { continue; }
			const first = t.children[0];
			if (!first || first.type !== 'text') { continue; }
			const m = /^\[([ xX])\]\s+/.exec(first.content);
			if (!m) { continue; }
			const line = Array.isArray(t.map) ? t.map[0] : -1;
			const checked = m[1].toLowerCase() === 'x' ? ' checked' : '';
			first.content = first.content.slice(m[0].length);
			const box = new state.Token('html_inline', '', 0);
			box.content = `<input type="checkbox" class="kb-task" data-task-line="${line}"${checked}> `;
			t.children.unshift(box);
		}
	});

	// ── 粗体兜底（CJK 标点场景，2026-10-25）──────────────────────────────
	//   CommonMark 的 `**…**` 要求右分隔符 right-flanking；当中文全角标点紧贴在闭合
	//   `**` 之前（如 `靠**掩码自注意力（因果掩码）**遮蔽`）时，`）` 属 punctuation
	//   且后面紧跟正文 ⇒ 判定失败、`**` 原样留在正文里（真机 3 篇各 2 处）。
	//   这里在 inline 解析之后扫一遍 **残留的 text token**，把它们补成 <strong>：
	//   只处理标准规则没吃掉的部分，因此不会改变既有语义。
	mdit.core.ruler.after('inline', 'kb_strong_cjk', (state) => {
		for (const token of state.tokens) {
			if (token.type !== 'inline' || !Array.isArray(token.children)) { continue; }
			const next = [];
			for (const child of token.children) {
				if (child.type !== 'text' || !child.content.includes('**')) { next.push(child); continue; }
				const parts = child.content.split(/(\*\*[^*\n]+\*\*)/g);
				for (const part of parts) {
					if (!part) { continue; }
					const m = /^\*\*([^*\n]+)\*\*$/.exec(part);
					if (m) {
						const span = new state.Token('html_inline', '', 0);
						span.content = `<strong>${escapeHtml(m[1])}</strong>`;
						next.push(span);
					} else {
						const txt = new state.Token('text', '', 0);
						txt.content = part;
						next.push(txt);
					}
				}
			}
			token.children = next;
		}
	});

	// ── Callout：`> [!note] 标题` → 带类型与标题的块（189 处）────────────
	//   ⚠ 必须 `after('block')`（**inline 解析之前**）：渲染最终用的是 `children`，
	//     而 `[!note]` 会被 inline 解析器拆成多个 text token（`[` / `!note]`），
	//     在 inline 之后去改 `children[0]` 改不干净 ⇒ 输出里仍会残留标记。
	//     在 block 之后改 `inline.content`，inline 规则会按新内容重新解析。
	mdit.core.ruler.after('block', 'kb_callout', (state) => {
		const tokens = state.tokens;
		for (let i = 0; i < tokens.length; i++) {
			const open = tokens[i];
			if (open.type !== 'blockquote_open') { continue; }
			const inl = tokens[i + 2];
			if (!inl || inl.type !== 'inline') { continue; }
			const m = /^\[!([A-Za-z]+)\][+-]?\s*/.exec(inl.content);
			if (!m) { continue; }
			const type = m[1].toLowerCase();
			const title = CALLOUT_TITLES[type] ?? m[1];
			inl.content = inl.content.slice(m[0].length);
			if (inl.children && inl.children[0] && inl.children[0].type === 'text') {
				inl.children[0].content = inl.children[0].content.replace(m, '');
			}
			open.attrJoin('class', 'kb-callout');
			open.attrSet('data-callout', type);
			open.attrSet('data-callout-title', title);
			i += 2;
		}
	});

	// ── 表格/代码块的 class（供视图样式挂载，不改语义）────────────────
	mdit.renderer.rules.table_open = () => '<table class="kb-table">\n';
	mdit.renderer.rules.fence = (tokens, idx) => {
		const t = tokens[idx];
		const info = String(t.info ?? '').trim().split(/\s+/)[0].toLowerCase();
		// ── mermaid：服务端用 pele 渲染成**内联 SVG**（2026-10-26）────────────
		//   为什么放服务端：三个宿主读同一份 html，客户端就不需要任何脚本；
		//   而 pele 是同步、零 DOM 依赖的 ⇒ Node 里能直接出 SVG。
		//   `ctx.renderMermaid` 返回空串表示"当前环境渲染不了"（没装 pele / 语法错 / 超限）
		//   ⇒ 保留源码块：源码本身也是信息，绝不吞内容。
		if (info === 'mermaid' && typeof ctx.renderMermaid === 'function') {
			let svg = '';
			try { svg = String(ctx.renderMermaid(t.content) ?? ''); } catch { svg = ''; }
			if (svg) {
				return `<div class="kb-mermaid-block" data-mermaid="svg">${svg}</div>\n`;
			}
			return `<pre class="kb-code lang-mermaid" title="mermaid 未能渲染，已按源码显示"><code>${escapeHtml(t.content)}</code></pre>\n`;
		}
		const cls = info ? ` class="kb-code lang-${escapeHtml(info)}"` : ' class="kb-code"';
		// 其余代码块走四色高亮；mermaid 在此分支里只可能是"渲染失败后的源码"
		const body = info === 'mermaid' ? escapeHtml(t.content) : highlightCode(t.content);
		return `<pre${cls}><code>${body}</code></pre>\n`;
	};

	// ── 站外链接补 `target` / `rel`（2026-10-26）──────────────────────────
	// 为什么在渲染器里补而不是前端改 DOM：三端（面板 / 插件页 / 独立文档页）读的是同一份 HTML，
	// 在这里补一次就全都有；前端只在"点了之后"接管行为。
	// `rel="noopener noreferrer"` 是必需的：站外页面拿不到 `window.opener`，也无法读 Referer。
	mdit.renderer.rules.link_open = (tokens, idx, options) => {
		const t = tokens[idx];
		const href = String(t.attrGet('href') ?? '');
		if (/^https?:/i.test(href)) {
			t.attrSet('target', '_blank');
			t.attrSet('rel', 'noopener noreferrer');
		}
		return mdit.renderer.renderToken(tokens, idx, options);
	};

	return { html: mdit.render(src), frontmatter, math: hasMath };
}

export { CALLOUT_TITLES };
