import { $, append } from '../../../base/browser/dom.js';
import { renderMarkdown, MarkdownRenderOptions } from '../../../base/browser/markdownRenderer.js';
import { DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import type { IMarkdownString } from '../../../base/common/htmlContent.js';
import { IAgentChatMessage, IMessagePart, IThinkingMessagePart } from './agentChatTypes.js';
import { _patchNestedMarkdown, AgentChatPanelBase } from './agentChatPanel.base.js';
import { AgentChatPanelDrawioCard } from './agentChatPanel.drawioCard.js';

// Feature: markdown. Extracted from AgentChatPanelBase.
export class AgentChatPanelMarkdown extends AgentChatPanelDrawioCard {

/** 单块 Markdown 渲染的字符上限（超出则按行分片，见 _renderMarkdownSafe）。 */
private static readonly _MD_CHUNK_MAX_CHARS = 512 * 1024;

protected override _cleanupMarkdownDisposables(root: HTMLElement): void {
		const toRemove: HTMLElement[] = [];
		for (const [el, disposable] of this._markdownDisposables) {
			if (root.contains(el)) {
				disposable.dispose();
				toRemove.push(el);
			}
		}
		for (const el of toRemove) {
			this._markdownDisposables.delete(el);
		}
	}

protected override _renderMarkdownContent(parent: HTMLElement, content: string, isStreaming: boolean = false): void {
	// 预处理：嵌套 markdown 代码块围栏冲突（移植自 Continue patchNestedMarkdown）。
		// 模型返回 ```markdown 代码块内含 ``` 时，VS Code renderMarkdown 的围栏解析
		// 会错位 → 内层代码块泄漏为正文。把外层 ```markdown``` 的围栏转成 ~~~ 避免冲突。
		// 注：此处曾有两个启发式补丁（_ensureFencedCodeBlock 自动包裹裸代码、
		// _mergeAdjacentCodeBlocks 合并相邻代码块），已于 2026-08-30 移除。
		// 二者本质是用渲染层正则去补数据层的坑，且 _ensureFencedCodeBlock 会
		// 把含路径/代码特征的中文分析文本误包成 code 卡片。若个别历史消息确实
		// 因缩进丢失而渲染为纯文本，应修数据层（持久化/读取期迁移），而非渲染层猜测。
		const processed = _patchNestedMarkdown(content);
		const md: IMarkdownString = { value: processed, isTrusted: true };
		const options = this._getMarkdownOptions(isStreaming);

		// Dispose previous markdown disposable for this parent to avoid leakage
		const existingDisposable = this._markdownDisposables.get(parent);
		if (existingDisposable) {
			existingDisposable.dispose();
		}

		// renderMarkdown returns a disposable that must be managed
		const disposable = this._renderMarkdownSafe(md, options, parent);
		this._markdownDisposables.set(parent, disposable);

		// Intercept clicks on http(s) links so they open in the editor area
		// (middle column) instead of the system browser. Event delegation on
		// the parent element covers all <a> tags rendered by renderMarkdown,
		// including those added during streaming updates.
		this._attachLinkInterceptor(parent);
		this._linkifyPlainText(parent);
	}

	/**
	 * ★ 2026-09-11：超长 content 分片 + 异常兜底渲染。
	 *
	 * **事故**（用户「切换会话后，带有图片消息显示错误」/ 日志 1789133432350）：
	 * workflow 收尾把**全部**媒体快照的 data URI 内联成 Markdown 图片
	 * （`agentDriverService.ts` 的 `![输出 N](data:image/jpeg;base64,…)`），
	 * 42 张 × 数百 KB ≈ **8.4MB 单条 content**。`renderMarkdown` 内部
	 * `marked.parse` 处理超长单行触发 `RangeError: Maximum call stack size
	 * exceeded`（实测 8.4MB 必现，栈顶 `lheading` 正则）——而
	 * `markdownRenderer.ts:288` 的 parse 与本方法**都没有 try/catch**，
	 * 异常直接冒泡 → 整条消息渲染中断（用户看到的是兜底/残破内容）。
	 *
	 * **为何「流式正常、切换会话才错」**：流式走 `_tryIncrementalMarkdownRender`
	 * 的 frozen/tail **分段**渲染（每段仅几 KB）侥幸不溢出；切换会话重载历史走
	 * `_renderMarkdownContent` **全量**渲染才暴露。
	 *
	 * 两道保护（对**已落盘的历史脏数据**同样生效）：
	 *  ① **分片**：超过 `_MD_CHUNK_MAX_CHARS` 时按**行**切块逐块渲染。
	 *     行内不切，保证 `![alt](url)`、围栏等语法完整。
	 *  ② **兜底**：某块渲染抛错 → 该块降级为纯文本，不冒泡中断整条消息。
	 */
	private _renderMarkdownSafe(md: IMarkdownString, options: MarkdownRenderOptions, parent: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const value = md.value ?? '';
		if (value.length <= AgentChatPanelMarkdown._MD_CHUNK_MAX_CHARS) {
			store.add(this._renderMarkdownChunk(md, options, parent));
			return store;
		}
		const lines = value.split('\n');
		let buf: string[] = [];
		let bufLen = 0;
		const flush = () => {
			if (buf.length === 0) { return; }
			store.add(this._renderMarkdownChunk({ ...md, value: buf.join('\n') }, options, parent));
			buf = [];
			bufLen = 0;
		};
		for (const rawLine of lines) {
			// ★ 2026-09-12：单行自身超阈值（如一张巨图的 base64）**按字符再切**。
			// 原实现让该行独占一块并注释「仍可能溢出，由 _renderMarkdownChunk 兜底」——
			// 但兜底会把**整块**降级为纯文本，用户看到一大段 base64 原文。
			// 现按字符切碎（优先在 `)` 处切，尽量不破坏 `![alt](url)`），
			// 使单块必然低于 marked 的栈溢出阈值；即便某段语法被切断，
			// 也只退化为该段文本，不影响其余内容。
			const pieces = AgentChatPanelMarkdown._splitOversizedLine(rawLine, AgentChatPanelMarkdown._MD_CHUNK_MAX_CHARS);
			for (const line of pieces) {
				if (bufLen > 0 && bufLen + line.length > AgentChatPanelMarkdown._MD_CHUNK_MAX_CHARS) { flush(); }
				buf.push(line);
				bufLen += line.length + 1;
			}
		}
		flush();
		return store;
	}

	/**
	 * ★ 2026-09-12：把「单行超阈值」拆成多个 ≤ maxChars 的片段。
	 *
	 * 切点优先取 `)` 之后（图片/链接 `![alt](url)` 的语法边界，切在边界后不破坏该段）；
	 * 退而在 maxChars 处硬切。硬切会让被切断的那段 Markdown 退化为纯文本显示——
	 * 这是**有意的降级**：宁可让一张超长图显示为文本，也不能让 `marked.parse`
	 * 栈溢出把整条消息的渲染打掉（日志 1789133432350 事故）。
	 */
	private static _splitOversizedLine(line: string, maxChars: number): string[] {
		if (line.length <= maxChars) { return [line]; }
		const out: string[] = [];
		let start = 0;
		while (start < line.length) {
			let end = Math.min(start + maxChars, line.length);
			if (end < line.length) {
				// 优先在 `)` 后切（且不能把块切得太小，否则碎片过多）
				const paren = line.lastIndexOf(')', end);
				if (paren > start + maxChars / 2) { end = paren + 1; }
			}
			out.push(line.slice(start, end));
			start = end;
		}
		return out;
	}

	/** 渲染单块；失败则降级为纯文本（不冒泡，避免一条脏数据毁掉整条消息的渲染）。 */
	private _renderMarkdownChunk(md: IMarkdownString, options: MarkdownRenderOptions, parent: HTMLElement): IDisposable {
		try {
			return renderMarkdown(md, options, parent);
		} catch (err) {
			this._logService.warn(
				'[AgentChatPanel] renderMarkdown failed (likely oversized markdown), falling back to plain text:',
				err,
			);
			const fallback = append(parent, $('div.message-content.md-render-fallback'));
			fallback.textContent = md.value;
			return { dispose: () => { /* no-op */ } };
		}
	}

protected override _linkifyPlainText(parent: HTMLElement): void {
		const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT, {
			acceptNode: (node: Text) => {
				// 跳过已位于链接/代码块/预格式化/脚本/样式/页脚内的文本
				let el: HTMLElement | null = node.parentElement;
				while (el && el !== parent) {
					const tag = el.tagName;
					if (tag === 'A' || tag === 'PRE' || tag === 'CODE' || tag === 'SCRIPT' || tag === 'STYLE') {
						return NodeFilter.FILTER_REJECT;
					}
					if (el.classList.contains('tool-code-children')
						|| el.classList.contains('tool-children-wrapper')
						|| el.classList.contains('chat-bubble-footer')) {
						return NodeFilter.FILTER_REJECT;
					}
					el = el.parentElement;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});

		let node: Text | null;
		const nodesToReplace: Array<{ node: Text; parts: Array<string | { type: 'file' | 'url'; text: string }> }> = [];
		while ((node = walker.nextNode() as Text | null)) {
			const text = node.textContent ?? '';
			if (text.length < 3) { continue; }
			const combined = this._parseLinkifyText(text);
			if (combined) {
				nodesToReplace.push({ node, parts: combined });
			}
		}

		for (const { node, parts } of nodesToReplace) {
			const frag = document.createDocumentFragment();
			for (const part of parts) {
				if (typeof part === 'string') {
					frag.appendChild(document.createTextNode(part));
				} else if (part.type === 'file') {
					const a = document.createElement('a');
					a.setAttribute('data-file', part.text);
					a.textContent = part.text;
					a.className = 'msg-file-link';
					// 阻止默认导航行为（由 _attachLinkInterceptor 处理）
					a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
					frag.appendChild(a);
				} else {
					const a = document.createElement('a');
					a.href = part.text;
					a.textContent = part.text;
					a.target = '_blank';
					a.rel = 'noopener noreferrer';
					a.className = 'msg-url-link';
					frag.appendChild(a);
				}
			}
			node.parentNode?.replaceChild(frag, node);
		}
	}

protected override _parseLinkifyText(text: string): Array<string | { type: 'file' | 'url'; text: string }> | null {
		// 找到所有匹配的文件路径和网址位置
		const matches: Array<{ index: number; length: number; type: 'file' | 'url'; text: string }> = [];

		// 文件路径
		AgentChatPanelBase._FILE_PATH_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = AgentChatPanelBase._FILE_PATH_RE.exec(text)) !== null) {
			matches.push({ index: m.index, length: m[0].length, type: 'file', text: m[0] });
		}
		// 网址（排除已被文件路径匹配覆盖的区域）
		AgentChatPanelBase._URL_RE.lastIndex = 0;
		while ((m = AgentChatPanelBase._URL_RE.exec(text)) !== null) {
			const urlStart = m.index, urlEnd = m.index + m[0].length;
			const overlaps = matches.some(fm => fm.index < urlEnd && (fm.index + fm.length) > urlStart);
			if (!overlaps) {
				matches.push({ index: m.index, length: m[0].length, type: 'url', text: m[0] });
			}
		}

		if (matches.length === 0) { return null; }

		// 按位置排序，构建分段数组
		matches.sort((a, b) => a.index - b.index);
		const result: Array<string | { type: 'file' | 'url'; text: string }> = [];
		let cursor = 0;
		for (const match of matches) {
			if (match.index > cursor) {
				result.push(text.slice(cursor, match.index));
			}
			result.push({ type: match.type, text: match.text });
			cursor = match.index + match.length;
		}
		if (cursor < text.length) {
			result.push(text.slice(cursor));
		}
		return result;
	}

/**
 * 流式增量 markdown 渲染（块边界冻结法）。
 *
 * 思路：把 content 分为「已冻结的稳定前缀」+「仍在增长的尾部块」。
 *  - 稳定前缀：仅在出现新的块边界（空行 \n\n 且代码围栏闭合）时，增量渲染这一段并
 *    append 到 tailEl 之前冻结（不重排已有 DOM）。
 *  - 尾部块：每次更新整体重渲（含 fillInIncompleteTokens 补全未闭合围栏），因为尾部
 *    通常是唯一还在变化的那一块（一段落 / 一个未闭合代码块）。
 *
 * 每次更新成本 ≈ O(尾部) 而非 O(整篇)，整条流式渲染由 O(N²) 降为 O(N)；且冻结块是
 * 完整块（边界处围栏必闭合），规避了旧实现「>4KB 强制全量重建」的碎片化问题。
 */

/** 每个流式 markdown 容器的增量渲染状态。 */
private _incMdState = new WeakMap<HTMLElement, {
	/** 已冻结（渲染进 DOM）的内容长度。 */
	frozenLen: number;
	/** 上次渲染的完整 content（用于追加校验）。 */
	lastRendered: string;
	/** 尾部块元素（每次更新整体重渲）。 */
	tailEl: HTMLElement;
	frozenDisposables: IDisposable[];
	tailDisposable: IDisposable | null;
}>();

/**
 * 查找 content 中自 fromOffset 起、最后一个「块边界」的结束偏移。
 * 块边界 = 空行（\n\n）且该处代码围栏闭合（偶数个 ```）。
 * 返回 fromOffset 表示无新边界。fromOffset 处围栏必闭合（只有闭合才冻结），
 * 因此可从 fromOffset 起扫描 → 摊销 O(新增内容)。
 */
protected _advanceStableBoundary(content: string, fromOffset: number): number {
	let stable = fromOffset;
	let fenceOpen = false;
	const n = content.length;
	let i = fromOffset;
	while (i < n) {
		// 行首 ``` → 围栏开/关切换，跳到该行行尾
		if (content.startsWith('```', i) && (i === 0 || content[i - 1] === '\n')) {
			fenceOpen = !fenceOpen;
			while (i < n && content[i] !== '\n') { i++; }
			continue;
		}
		// 空行且围栏闭合 → 新的稳定边界（越过 \n\n）
		if (!fenceOpen && content[i] === '\n' && content[i + 1] === '\n') {
			stable = i + 2;
		}
		i++;
	}
	return stable;
}

/** 清空某容器的增量渲染状态（全量重建前调用，避免在旧骨架上误增量）。 */
protected override _resetIncrementalMd(container: HTMLElement): void {
	const state = this._incMdState.get(container);
	if (state) {
		try { state.tailDisposable?.dispose(); } catch { /* ignore */ }
		for (const d of state.frozenDisposables) { try { d.dispose(); } catch { /* ignore */ } }
		this._incMdState.delete(container);
	}
	const md = this._markdownDisposables.get(container);
	if (md) {
		try { md.dispose(); } catch { /* ignore */ }
		this._markdownDisposables.delete(container);
	}
}

	protected override _tryIncrementalMarkdownRender(container: HTMLElement, newContent: string): boolean {
	let state = this._incMdState.get(container);

	// ★★ 2026-09-12：**孤儿守卫**（把一类静默失效变成自愈 + 告警）★★
	//
	// `state.tailEl` 必须仍在 container 内。若某调用方清空了容器 DOM 却忘了先调
	// `_resetIncrementalMd`，tailEl 会脱离 DOM —— 此后本方法会把新内容渲染进那个
	// **孤儿节点**并**返回 true**：调用方（scheduler）据此同步基线、后续帧因"内容未变"
	// 跳过 → **UI 永远停在首帧**，且因为没走全量替换，`md:incremental-failed`
	// 一条都不会有（日志 1788662336134 的 thinking 卡事故正是此形态，当年因"所有
	// 日志都正常"而三次修复未找到根因）。
	//
	// 这里直接判定 state 失效 → 走下面的重建分支（`container.replaceChildren()` 重建骨架），
	// 保证**无论谁漏了 reset，渲染都不会静默失败**；同时告警留痕，便于发现新的漏 reset 点。
	if (state && (!state.tailEl.isConnected || state.tailEl.parentNode !== container)) {
		this._logService.warn(
			'[AgentChatPanel] incremental markdown state orphaned (container DOM was cleared without _resetIncrementalMd) — rebuilding. ' +
			'Caller missed the reset; historical case: statusCards.ts _renderThinkingCardBody (log 1788662336134).',
		);
		this._resetIncrementalMd(container);
		state = undefined;
	}

	// 内容被改写（非严格追加）→ 按**分歧点位置**决定「重渲 tail」还是「全量重建」。
	//
	// ★ 2026-08-31 优化：原实现只要 `!newContent.startsWith(lastRendered)` 就全量重建。
	// 但 `content_replace` 会用 host 的「当前轮文本」覆盖最后一段（sanitize 后与流式
	// 累积的文本常有出入），**并非严格追加** —— 于是几乎每次都落到全量替换
	// （`md:incremental-failed`，实测 34~46 次/日志，直接表现为流式闪烁）。
	//
	// 而冻结块只在「空行 + 围栏闭合」处推进（见 _advanceStableBoundary），本身是完整
	// 块。所以只要分歧点**不早于 frozenLen**，已冻结的 DOM 就依然有效 —— 重渲 tail
	// 即可，完全不必全量重建。仅当分歧侵入冻结区时才真的需要推倒重来。
	if (state) {
		const prev = state.lastRendered;
		if (newContent !== prev) {
			// 最长公共前缀（分歧点）。纯追加是流式的绝对主路径，
			// 用原生 startsWith 短路，省掉逐字符扫描。
			let cpl: number;
			if (newContent.startsWith(prev)) {
				cpl = prev.length;
			} else {
				cpl = 0;
				const max = Math.min(prev.length, newContent.length);
				while (cpl < max && prev.charCodeAt(cpl) === newContent.charCodeAt(cpl)) { cpl++; }
			}
			if (cpl < state.frozenLen) {
				// 分歧落在已冻结区 → 冻结内容已失效，只能全量重建
				this._resetIncrementalMd(container);
				state = undefined;
			}
			// 否则分歧在 tail 区间：冻结块有效，下面照常重渲 tail
		} else {
			// 内容完全相同（scheduler 通常已拦截），无需任何 DOM 操作
			return true;
		}
	}

	// 首次：清掉旧的 markdown disposable / 链接拦截监听，搭建 frozen + tail 骨架。
	if (!state) {
		this._resetIncrementalMd(container);
		container.replaceChildren();
		const tailEl = append(container, $('div.md-streaming-tail'));
		state = { frozenLen: 0, lastRendered: '', tailEl, frozenDisposables: [], tailDisposable: null };
		this._incMdState.set(container, state);
		// 统一清理入口：dispose 时回收 tail + frozen（读取最新 state）。
		// 用局部常量捕获，避免 TS 闭包内 possibly-undefined（赋值后 state 必非空）。
		const st = state;
		this._markdownDisposables.set(container, {
			dispose: () => {
				try { st.tailDisposable?.dispose(); } catch { /* ignore */ }
				for (const d of st.frozenDisposables) { try { d.dispose(); } catch { /* ignore */ } }
			},
		});
		// 事件委托挂在容器上一次即可（覆盖未来所有子节点）。
		this._attachLinkInterceptor(container);
	}

	// 推进稳定边界（仅从 frozenLen 向前扫，摊销 O(新增)）。
	const newStable = this._advanceStableBoundary(newContent, state.frozenLen);

	// 有新稳定块 → 渲染并插入 tailEl 之前（冻结，append 不重排）。
	if (newStable > state.frozenLen) {
		const stableText = _patchNestedMarkdown(newContent.slice(state.frozenLen, newStable));
		const tempDiv = $('div');
		const d = renderMarkdown({ value: stableText, isTrusted: true }, this._getMarkdownOptions(false), tempDiv);
		state.frozenDisposables.push(d);
		this._linkifyPlainText(tempDiv);
		while (tempDiv.firstChild) {
			state.tailEl.parentNode!.insertBefore(tempDiv.firstChild, state.tailEl);
		}
		state.frozenLen = newStable;
	}

	// 重渲尾部（不完整块，可能含未闭合围栏 → isStreaming 补全）。
	const tailText = _patchNestedMarkdown(newContent.slice(state.frozenLen));
	if (state.tailDisposable) { try { state.tailDisposable.dispose(); } catch { /* ignore */ } }
	state.tailEl.replaceChildren();
	state.tailDisposable = renderMarkdown(
		{ value: tailText, isTrusted: true },
		this._getMarkdownOptions(true),
		state.tailEl,
	);
	this._linkifyPlainText(state.tailEl);

	state.lastRendered = newContent;
	// 全局流式基线由 StreamingRenderScheduler 在增量成功后自行同步（P5a）。
	return true;
}

protected override _getMarkdownOptions(isStreaming: boolean = false): MarkdownRenderOptions {
		const LARGE_CODE_THRESHOLD = 30; // lines before auto-collapse

		return {
			// 流式时自动补全未闭合的 ``` 围栏 / 表格 / 列表（对齐 Void/VS Code 原生 chat
			// 的 fillIncompleteTokens 机制）。这是防止流式错乱的根因修复——之前流式
			// 过程中未闭合的代码块会以 raw text 形式泄漏到正文，表现为 CSS/HTML 裸露。
			fillInIncompleteTokens: isStreaming,
			// 显式开启 GFM：表格 / 任务列表 / 删除线 / 自动链接。marked 实例的默认值
			// 在某些版本下 gfm=false，导致 | col1 | col2 | 表格语法以 raw text 渲染。
			markedOptions: { gfm: true, breaks: false },
			// ⚠️ 关键修复（流式代码块显示为裸露 HTML/CSS 文本，输出结束后才正常，2026-07-13）：
			//   必须用 codeBlockRendererSync（同步）而非 codeBlockRenderer（异步 Promise）。
			//   原因：异步 codeBlockRenderer 下，renderMarkdown 会先同步插入占位符
			//   `<div class="code" data-code="N">${escape(code)}</div>`（内容是转义后的原始
			//   代码文本），再在 `Promise.all(codeBlocks).then()`（微任务）里用
			//   `outElement.querySelectorAll('div[data-code]')` 替换为真正的代码块。
			//   但流式全量重建走「离屏 tempDiv 渲染 → replaceChildren 把子节点移动到真实
			//   容器」的模式（见 StreamingRenderScheduler._flush），replaceChildren 同步把节点搬出
			//   tempDiv 后，微任务里的 querySelectorAll 在**已清空的 tempDiv** 上找不到占位符
			//   → 永不替换 → 占位符里转义的裸露 HTML/CSS 文本一直留在可见容器（即错乱）。
			//   流式结束时 _rebuildMessageElement 直接渲染进真实容器，故「结束后正常」。
			//   改用同步渲染后，renderMarkdown 在返回前就完成占位符替换（markdownRenderer.ts
			//   L343-351），移动子节点时代码块已就位，彻底消除该竞态。本渲染器体内无真正
			//   异步操作，转同步零副作用。
			codeBlockRendererSync: (languageAlias: string, code: string) => {
				const lang = languageAlias || '';
				const lines = code.split('\n');
				const isLarge = lines.length > LARGE_CODE_THRESHOLD;

				// ── Mermaid fence 兜底内联预览（2026-09-05，日志 1788596740459）────────
				// 设计意图是模型调 renderMermaidDiagram 工具出专用卡片；但模型有时无视
				// 「DIAGRAM REQUESTS — ALWAYS USE THE TOOL」直接在文本里输出 ```mermaid
				// fence，此前被渲染成普通代码块，用户看不到图。兜底：代码块上方追加
				// 异步 SVG 预览（复用 renderMermaidSvg 隐藏 webview），源码块保留
				// （Copy/Apply 不受影响）。
				// 节流：流式期间 wrapper 每帧重建，setTimeout 随元素废弃自然丢弃——
				// 仅流结束后的最终重建真正触发渲染（零状态节流）。
				let mermaidPreview: HTMLElement | undefined;
				if (lang.toLowerCase() === 'mermaid' && code.trim()) {
					mermaidPreview = document.createElement('div');
					mermaidPreview.className = 'mermaid-fallback-preview';
					const mermaidLoading = document.createElement('div');
					mermaidLoading.className = 'mermaid-card-loading';
					mermaidLoading.textContent = 'Mermaid 预览渲染中…';
					mermaidPreview.appendChild(mermaidLoading);
					window.setTimeout(() => {
						// 元素已随流式重建脱离 DOM 则跳过
						if (!mermaidPreview?.isConnected) { return; }
						void this._renderMermaidCardSvg(code, mermaidPreview, mermaidLoading);
					}, 800);
				}

				// Wrapper
				const wrapper = document.createElement('div');
				wrapper.className = `code-block-wrapper${isLarge ? ' code-block-collapsed' : ''}`;

				// Header bar
				const header = document.createElement('div');
				header.className = 'code-block-header';

				const langLabel = document.createElement('span');
				langLabel.className = 'code-block-lang';
				langLabel.textContent = lang || 'code';
				header.appendChild(langLabel);

				const actions = document.createElement('span');
				actions.className = 'code-block-actions';

				// Copy button
				const copyBtn = document.createElement('button');
				copyBtn.className = 'code-block-copy-btn';
				copyBtn.title = 'Copy code';
				// P2+: 复用缓存 SVG 模板（cloneNode），只改尺寸为 12x12
				const copySvg = this._svgCopyIcon();
				copySvg.setAttribute('width', '12');
				copySvg.setAttribute('height', '12');
				copyBtn.appendChild(copySvg);
				copyBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					const ok = await this._copyToClipboard(code);
					copyBtn.textContent = '';
					if (ok) {
						// 成功：复用缓存 check SVG 模板
						const copiedSvg = this._svgCheckSmall();
						copiedSvg.setAttribute('width', '12');
						copiedSvg.setAttribute('height', '12');
						copyBtn.appendChild(copiedSvg);
						copyBtn.classList.add('copied');
						copyBtn.title = 'Copied';
					} else {
						// 失败：显示错误状态
						copyBtn.classList.add('copy-failed');
						copyBtn.title = 'Copy failed';
					}
					setTimeout(() => {
						copyBtn.textContent = '';
						const copySvg2 = this._svgCopyIcon();
						copySvg2.setAttribute('width', '12');
						copySvg2.setAttribute('height', '12');
						copyBtn.appendChild(copySvg2);
						copyBtn.classList.remove('copied');
						copyBtn.classList.remove('copy-failed');
						copyBtn.title = 'Copy code';
					}, 1500);
				});
				actions.appendChild(copyBtn);

				// Apply button (Void-inspired BlockCodeApplyWrapper)
				const applyBtn = document.createElement('button');
				applyBtn.className = 'code-block-apply-btn';
				applyBtn.title = 'Diff 预览并应用代码到文件';
				applyBtn.textContent = 'Apply';
			applyBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				console.log(`[AgentChatPanel] Apply button clicked — lang="${lang}", codeLen=${code.length}, hasOnApplyCode=${!!this._onApplyCode}`);
				this._onApplyCode?.(code, lang);
			});
				actions.appendChild(applyBtn);

				// P1-1: 终端运行按钮（仅 shell 语言代码块显示）
				const shellLangs = ['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'cmd', 'bat'];
				if (shellLangs.includes(lang.toLowerCase()) && this._onRunInTerminal) {
					const runBtn = document.createElement('button');
					runBtn.className = 'code-block-run-btn';
					runBtn.title = '在终端中运行';
					runBtn.textContent = '▶ Run';
					runBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						this._onRunInTerminal?.(code);
						// 视觉反馈
						runBtn.textContent = '✓ 已发送';
						runBtn.classList.add('ran');
						setTimeout(() => {
							runBtn.textContent = '▶ Run';
							runBtn.classList.remove('ran');
						}, 1500);
					});
					actions.appendChild(runBtn);
				}

				// Expand/collapse button for large blocks
				if (isLarge) {
					const toggleBtn = document.createElement('button');
					toggleBtn.className = 'code-block-toggle-btn';
					toggleBtn.textContent = `+ Expand (${lines.length} lines)`;
					toggleBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						const collapsed = wrapper.classList.toggle('code-block-collapsed');
						toggleBtn.textContent = collapsed
							? `+ Expand (${lines.length} lines)`
							: `- Collapse`;
					});
					actions.appendChild(toggleBtn);
				}

				header.appendChild(actions);
				wrapper.appendChild(header);

				// Code block
				const pre = document.createElement('pre');
				const codeEl = document.createElement('code');
				if (lang) { codeEl.classList.add(`language-${lang}`); }
				codeEl.textContent = code;
				pre.appendChild(codeEl);
				wrapper.appendChild(pre);

				// Mermaid 预览插在代码块上方（图优先，源码在下可折叠）
				if (mermaidPreview) {
					wrapper.insertBefore(mermaidPreview, pre);
				}

				return wrapper;
			},
		};
	}

protected override _attachLinkInterceptor(parent: HTMLElement): void {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) { return; }
			const anchor = target.closest('a') as HTMLAnchorElement | null;
			if (!anchor) { return; }
			// 文件路径链接
			const filePath = anchor.getAttribute('data-file');
			if (filePath) {
				e.preventDefault();
				e.stopPropagation();
				this._onOpenFile?.(filePath);
				return;
			}
			const href = anchor.getAttribute('data-href') || anchor.href;
			if (!href) { return; }
			// Only intercept http(s) links.
			if (!/^https?:\/\//i.test(href)) { return; }
			e.preventDefault();
			e.stopPropagation();
			this._onOpenLink?.(href);
		};
		parent.addEventListener('click', handler);
		// Track the listener for disposal when the parent is cleaned up.
		const existingDisposable = this._markdownDisposables.get(parent);
		if (existingDisposable) {
			this._markdownDisposables.set(parent, {
				dispose: () => {
					parent.removeEventListener('click', handler);
					existingDisposable.dispose();
				},
			});
		}
	}

protected override _renderPartsContent(bubble: HTMLElement, parts: readonly IMessagePart[], isStreaming: boolean, hostMsg?: IAgentChatMessage): void {
		// ── Diag: 进入时输出 parts 概览 ──
		if ((window as any).__SAROSIS_PARTS_DIAG) {
			const partsSummary = (parts as readonly any[]).map((p: any, i: number) => {
				if (p.kind === 'text') return `[${i}] text len=${p.text.length}`;
				if (p.kind === 'tool') return `[${i}] tool:${p.tool?.name}`;
				if (p.kind === 'subagent') return `[${i}] subagent:${p.subAgent?.name}`;
				return `[${i}] ${p.kind}`;
			}).join(', ');
			console.info(`[PartsDiag] _renderPartsContent START partsLen=${parts.length} isStreaming=${isStreaming} parts=[${partsSummary}]`);
		}

		// 找到最后一个非空文本片段索引，流式时把它标记为 streaming-container（增量更新目标）。
		let lastTextIdx = -1;
		for (let k = 0; k < parts.length; k++) {
			const p = parts[k];
			if (p.kind === 'text' && p.text.trim().length > 0) { lastTextIdx = k; }
		}
	for (let k = 0; k < parts.length; k++) {
			const part = parts[k];
			if (part.kind === 'text') {
				if (part.text.trim().length === 0) { continue; }
				const segEl = append(bubble, $(".message-content.parts-text-segment"));
				segEl.setAttribute('data-part-key', `text:${hostMsg?.id ?? ''}#t${k}`);
				if (isStreaming && k === lastTextIdx) {
					segEl.classList.add('streaming-container');
				}
				this._renderMarkdownContent(segEl, part.text, isStreaming);
				if ((window as any).__SAROSIS_PARTS_DIAG) {
					console.info(`[PartsDiag] render parts[${k}] TEXT → append .parts-text-segment, textLen=${part.text.length}, isLastText=${k === lastTextIdx}`);
				}
		} else if (part.kind === 'tool') {
			const toolPart = (part as any).tool;
			// clarify 工具走专用交互卡片（含选项按钮），否则普通工具卡片
			const clarifyCard = this._maybeCreateClarifyCard(toolPart);
				const renderedCard = clarifyCard ?? this._createToolCallCard(toolPart, this._getToolConfirmation(hostMsg, toolPart?.id));
				renderedCard.setAttribute('data-part-key', `tool:${toolPart?.id ?? `auto-${k}`}`);
				bubble.appendChild(renderedCard);
				if ((window as any).__SAROSIS_PARTS_DIAG) {
					const cardType = clarifyCard ? 'clarify-card' : (toolPart?.name === 'delegate_task' ? 'delegate-card' : 'tool-card');
					console.info(`[PartsDiag] render parts[${k}] TOOL → append ${cardType} toolName=${toolPart?.name} toolStatus=${toolPart?.status} cardClasses="${(renderedCard as HTMLElement).className?.split(' ').slice(0,3).join(' ')}"`);
				}
			} else if (part.kind === 'thinking') {
				// 2026-07-26 用户要求：thinking 卡片跟随流式发生位置渲染（不固定顶部）。
				// 每个思考 episode 一张卡；仅最后一个 episode 且仍在流式时显示
				// 「思考中...」活跃态，其余为完成的「思考过程」。
				const isLastEpisode = k === parts.length - 1;
				const thinkCard = this._createThinkingCard({
					...hostMsg,
					// 每 episode 独立 id——折叠状态 Map（_thinkingCardState）按 msgId 记忆，
					// 共享同一 msgId 会导致多卡折叠状态串扰
					id: `${hostMsg?.id ?? ''}#tk${k}`,
					thinking: (part as IThinkingMessagePart).text,
					isThinking: isStreaming && isLastEpisode && !!hostMsg?.isThinking,
				} as IAgentChatMessage);
				thinkCard.setAttribute('data-part-key', `thinking:${hostMsg?.id ?? ''}#tk${k}`);
				bubble.appendChild(thinkCard);
				if ((window as any).__SAROSIS_PARTS_DIAG) {
					console.info(`[PartsDiag] render parts[${k}] THINKING → len=${(part as IThinkingMessagePart).text.length}`);
				}
			}
		}
	}

	/**
	 * 为单个 part 创建 DOM 元素（追加模式用，避免整卡重建导致闪烁）。
	 * 从 _renderPartsContent 提取的逐 part 创建逻辑，供 _ruleAppendNewParts 调用。
	 * @returns 创建的 DOM 元素，或 null（空 text part 等）。
	 */
	protected _createPartElement(part: IMessagePart, partIndex: number, msg: IAgentChatMessage, isStreaming: boolean): HTMLElement | null {
		if (part.kind === 'text') {
			if (part.text.trim().length === 0) { return null; }
			const segEl = document.createElement('div');
			segEl.className = 'message-content parts-text-segment';
			segEl.setAttribute('data-part-key', `text:${msg.id}#t${partIndex}`);
			this._renderMarkdownContent(segEl, part.text, isStreaming);
			return segEl;
		}
		if (part.kind === 'tool') {
		const toolPart = (part as any).tool;
		const clarifyCard = this._maybeCreateClarifyCard(toolPart);
		const card = clarifyCard ?? this._createToolCallCard(toolPart, this._getToolConfirmation(msg, toolPart?.id));
		card.setAttribute('data-part-key', `tool:${toolPart?.id ?? `auto-${partIndex}`}`);
		return card;
	}
	if (part.kind === 'thinking') {
			const isLastEpisode = partIndex === (msg.parts?.length ?? 0) - 1;
			const thinkCard = this._createThinkingCard({
				...msg,
				id: `${msg.id}#tk${partIndex}`,
				thinking: (part as IThinkingMessagePart).text,
				isThinking: isStreaming && isLastEpisode && !!msg.isThinking,
			} as IAgentChatMessage);
			thinkCard.setAttribute('data-part-key', `thinking:${msg.id}#tk${partIndex}`);
			return thinkCard;
		}
		return null;
	}
}
