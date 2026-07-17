import { $, append } from '../../../base/browser/dom.js';
import { renderMarkdown, MarkdownRenderOptions } from '../../../base/browser/markdownRenderer.js';
import type { IMarkdownString } from '../../../base/common/htmlContent.js';
import { IMessagePart } from './agentChatTypes.js';
import { _patchNestedMarkdown, AgentChatPanelBase } from './agentChatPanel.base.js';
import { AgentChatPanelToolCards } from './agentChatPanel.toolCards.js';

// Feature: markdown. Extracted from AgentChatPanelBase.
export class AgentChatPanelMarkdown extends AgentChatPanelToolCards {

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
		const processed = _patchNestedMarkdown(content);
		const md: IMarkdownString = { value: processed, isTrusted: true };
		const options = this._getMarkdownOptions(isStreaming);

		// Dispose previous markdown disposable for this parent to avoid leakage
		const existingDisposable = this._markdownDisposables.get(parent);
		if (existingDisposable) {
			existingDisposable.dispose();
		}

		// renderMarkdown returns a disposable that must be managed
		const disposable = renderMarkdown(md, options, parent);
		this._markdownDisposables.set(parent, disposable);

		// Intercept clicks on http(s) links so they open in the editor area
		// (middle column) instead of the system browser. Event delegation on
		// the parent element covers all <a> tags rendered by renderMarkdown,
		// including those added during streaming updates.
		this._attachLinkInterceptor(parent);
		this._linkifyPlainText(parent);
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

protected override _tryIncrementalMarkdownRender(container: HTMLElement, newContent: string): boolean {
		const oldContent = this._streamingMdLastRendered;

		// 无上次渲染 → 无法增量
		if (!oldContent) { return false; }

		// 新内容必须以旧内容为前缀（追加模式）
		if (!newContent.startsWith(oldContent)) { return false; }

		const appended = newContent.slice(oldContent.length);
		if (!appended) { return true; } // 无变化

		// 大内容强制全量重建：增量渲染会在表格/代码块/嵌套列表边界产生碎片 DOM，
		// 导致复杂 markdown（如模型返回的设计方案文档含表格+代码+CSS）显示混乱。
		// 小内容（<4KB）保留增量以降低流式渲染开销。全量重建已按 200ms 节流，性能可接受。
		if (newContent.length > 4096) { return false; }

		// 安全检查：旧内容不能结束在代码块中间（``` 标记数为奇数）
		const fenceCount = (oldContent.match(/```/g) || []).length;
		if (fenceCount % 2 !== 0) { return false; }

		// 安全检查：旧内容必须在块边界处结束（以 \n 结尾或为空）
		// 不在行中间切断，否则追加的文本会与旧文本合并不完整的 markdown 块
		if (!oldContent.endsWith('\n') && oldContent.length > 0) { return false; }

		// 安全：只渲染追加部分——renderMarkdown 会 append 到 container，保留已有 DOM
		const md: IMarkdownString = { value: appended, isTrusted: true };
		const options = this._getMarkdownOptions();
		const newDisposable = renderMarkdown(md, options, container);

		// 组合新旧 disposable——全量重建时一起 dispose
		const existing = this._markdownDisposables.get(container);
		this._markdownDisposables.set(container, {
			dispose: () => {
				try { newDisposable.dispose(); } catch { /* already disposed */ }
				try { existing?.dispose(); } catch { /* already disposed */ }
			},
		});
		this._attachLinkInterceptor(container);
		this._linkifyPlainText(container);
		this._streamingMdLastRendered = newContent;
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
			//   容器」的模式（见 _streamingMdTimer 回调），replaceChildren 同步把节点搬出
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

protected override _renderPartsContent(bubble: HTMLElement, parts: readonly IMessagePart[], isStreaming: boolean): void {
		// 找到最后一个非空文本片段索引，流式时把它标记为 streaming-container（增量更新目标）。
		let lastTextIdx = -1;
		for (let k = 0; k < parts.length; k++) {
			const p = parts[k];
			if (p.kind === 'text' && p.text.trim().length > 0) { lastTextIdx = k; }
		}
		// 2026-07-04: update_plan 是"替换语义"——多张卡片只保留最后一张
		let lastUpdatePlanIndex = -1;
		for (let k = 0; k < parts.length; k++) {
			const p = parts[k] as any;
			if (p.kind === 'tool' && p.tool?.name === 'update_plan') {
				lastUpdatePlanIndex = k;
			}
		}
		for (let k = 0; k < parts.length; k++) {
			const part = parts[k];
			if (part.kind === 'text') {
				if (part.text.trim().length === 0) { continue; }
				const segEl = append(bubble, $(".message-content.parts-text-segment"));
				if (isStreaming && k === lastTextIdx) {
					segEl.classList.add('streaming-container');
				}
				this._renderMarkdownContent(segEl, part.text, isStreaming);
			} else {
				// 跳过非最后的 update_plan 卡片（替换语义）
				const toolPart = (part as any).tool;
				if (toolPart?.name === 'update_plan' && k !== lastUpdatePlanIndex) { continue; }
				bubble.appendChild(this._createToolCallCard(toolPart));
			}
		}
	}
}
