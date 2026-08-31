import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../base/browser/trustedTypes.js';
import { IToolCall } from './agentChatTypes.js';
import { AgentChatPanelMermaidCard } from './agentChatPanel.mermaidCard.js';
import { parseToolArgsLoose } from './toolArgsJson.js';

// 工作台启用了 Trusted Types：渲染好的 SVG 字符串需转成 TrustedHTML 才能赋给
// innerHTML。drawio 的 SVG 由 maxgraph 只读渲染产出（无 <script>、无交互 on* 事件），
// 与 mermaid 同源，故复用基类的 _sanitizeMermaidSvg 清洗策略。
const _drawioTtPolicy = createTrustedTypesPolicy('agentDrawioCard', { createHTML: value => value });

/**
 * Draw.io 图示工具卡片（renderDrawioDiagram）
 *
 * 结构与 Mermaid 卡片（_createMermaidCard）保持一致：同样的 header（chevron / 图标 /
 * kind badge / 标题 / 状态 / 耗时）、同样的正文分段（预览面板 + 工具栏 + 可折叠源码）、
 * 同样的错误与 loading 展示，仅在以下两点不同：
 *   - kind badge 文案为 DRAWIO，标题默认「Draw.io 图示」
 *   - 渲染调用 `_agentStudio.renderDrawioSvg`（maxgraph 只读渲染），预览命令走
 *     `_drawio-chat.openPreview`（drawio 源码不是 mermaid 语法，不能交给 mermaid 命令）
 */
export abstract class AgentChatPanelDrawioCard extends AgentChatPanelMermaidCard {

	protected override _createDrawioCard(tc: IToolCall, key: string): HTMLElement {
		const wrapper = $('.tool-header-wrapper.tool-card-delegate');
		const isDone = tc.status === 'success' || (!tc.status) ||
			(tc.status !== 'running' && tc.status !== 'error' && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');
		const isRunning = tc.status === 'running';
		const isErr = tc.status === 'error';

		// 参数解析：schema 主参数名为 source；兼容 xml / xmlBase64 / content 等历史别名。
		const args: Record<string, unknown> = parseToolArgsLoose(tc.args);
		const rawSource = (args?.source ?? args?.xml ?? args?.xmlBase64 ?? args?.content ?? '').toString();
		let diagramTitle: string | undefined = args?.title?.toString() || undefined;
		if (!diagramTitle && tc.result && typeof tc.result === 'string') {
			const m = tc.result.match(/\[Drawio\]\s*Diagram\s*"([^"]+)"/);
			if (m) { diagramTitle = m[1]; }
		}
		const resultText = (typeof tc.result === 'string' ? tc.result : '');

		// 未转义的 `source` 里常把换行写成字面量 `\n`，与 mermaid 卡片同样做一次还原。
		const fullMarkup = rawSource.replace(/\\n/g, '\n');
		let markup = fullMarkup;
		if (args?.xmlBase64 && !args?.source && !args?.xml) {
			markup = decodeBase64Utf8(fullMarkup) || fullMarkup;
		}

		// ── Header ──
		const header = append(wrapper, $('.tool-header'));
		const row = append(header, $('.tool-header-row'));
		const left = append(row, $('.tool-header-left'));
		const chevron = this._svgChevron(left, 'tool-header-chevron', 14);
		const iconEl = append(left, $('span.tool-header-icon'));
		iconEl.textContent = '🔷';

		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const kindBadge = append(titleContainer, $('span.mc-kind-badge'));
		kindBadge.textContent = 'DRAWIO';
		kindBadge.style.cssText = 'font-size:10px;font-weight:700;color:var(--accent,#60a5fa);' +
			'text-transform:uppercase;letter-spacing:0.4px;margin-right:4px;';
		const titleEl = append(titleContainer, $('span.tool-header-title'));
		titleEl.textContent = diagramTitle || 'Draw.io 图示';
		if (isRunning) { titleEl.classList.add('shimmer'); }

		const right = append(row, $('.tool-header-right'));
		if (isErr) {
			const errBadge = append(right, $('span.tool-status.tool-status.error'));
			errBadge.textContent = '✗';
		} else if (isDone) {
			const check = append(right, $('span.tool-status.tool-status.done'));
			check.textContent = '✓';
		} else if (isRunning) {
			append(right, $('span.tool-header-loading-dots'));
		}
		if (typeof tc.duration === 'number' && tc.duration >= 0) {
			const durEl = append(right, $('span.delegate-time'));
			durEl.textContent = this._formatDuration(tc.duration);
		}

		// ── Body ──
		const body = append(wrapper, $('.tool-header-children'));

		// ── Preview Panel（与 Mermaid 卡片同一套网格背景与尺寸约束）──
		const previewPanel = append(body, $('.mc-preview'));
		previewPanel.style.cssText =
			'position:relative;min-height:48px;display:flex;align-items:center;justify-content:center;' +
			'padding:12px;overflow:auto;max-height:420px;' +
			'background:repeating-linear-gradient(0deg,transparent,transparent 19px,' +
			'rgba(255,255,255,0.008) 19px,rgba(255,255,255,0.008) 20px),' +
			'repeating-linear-gradient(90deg,transparent,transparent 19px,' +
			'rgba(255,255,255,0.008) 19px,rgba(255,255,255,0.008) 20px);' +
			'border-bottom:1px solid var(--void-border-1,rgba(255,255,255,0.08));';

		if (isRunning && !markup.trim()) {
			previewPanel.appendChild(this._mcLoadingDots('正在准备 Draw.io 图示…'));
		} else if (markup.trim()) {
			const previewLoading = this._mcLoadingDots('正在渲染图示…');
			previewPanel.appendChild(previewLoading);

			// ── Toolbar ──
			const toolbar = append(body, $('.mc-toolbar'));
			toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;' +
				'border-bottom:1px solid var(--void-border-1,rgba(255,255,255,0.08));' +
				'background:var(--void-bg-3,#252525);';
			const tbLabel = append(toolbar, $('span.mc-toolbar-label'));
			tbLabel.textContent = '图示';
			tbLabel.style.cssText = 'font-size:10px;color:var(--void-fg-4,#6e7681);' +
				'text-transform:uppercase;letter-spacing:0.8px;margin-right:auto;';

			// Open in new tab（primary）
			toolbar.appendChild(this._mcBtn(
				'M3 3h4v1H4v8h8v-3h1v4H3V3zm5 1h5v5h-1V5.7l-5.65 5.65-.7-.7L11.3 5H8V4z',
				'在新标签页打开', true,
				(e) => {
					e.stopPropagation();
					if (this._onExecuteCommand) {
						this._onExecuteCommand('_drawio-chat.openPreview', markup, diagramTitle || 'Draw.io 预览')
							.catch(err => console.warn('[DrawioCard] openPreview failed:', err));
					}
				}
			));

			// Copy SVG（渲染完成前不可用，与 Mermaid 卡片一致）
			const svgCopyBtn = this._mcBtn(
				'M4 4h3v1H5v7h7v-2h1v3H4V4zm3 0h5v5h-1V5.7l-6.35 10.35l-.7-.7L10.3 5H7V4z',
				'复制 SVG', false,
				(e) => {
					e.stopPropagation();
					const svgEl = previewPanel.querySelector('svg');
					if (svgEl) {
						try { navigator.clipboard.writeText(svgEl.outerHTML); } catch { /* ignore */ }
						const labelText = svgCopyBtn.lastChild;
						if (labelText && labelText.nodeType === 3) {
							labelText.textContent = '✓ 已复制';
							setTimeout(() => { labelText.textContent = '复制 SVG'; }, 1500);
						}
					}
				}
			);
			svgCopyBtn.style.opacity = '0.5';
			svgCopyBtn.style.pointerEvents = 'none';
			toolbar.appendChild(svgCopyBtn);

			// Copy Source
			const srcCopyBtn = this._mcBtn(
				'M5 4l-4 4 4 4M11 4l4 4-4 4', '复制源代码', false,
				(e) => {
					e.stopPropagation();
					try { navigator.clipboard.writeText(markup); } catch { /* ignore */ }
					const labelText = srcCopyBtn.lastChild;
					if (labelText && labelText.nodeType === 3) {
						labelText.textContent = '✓ 已复制';
						setTimeout(() => { labelText.textContent = '复制源代码'; }, 1500);
					}
				}
			);
			toolbar.appendChild(srcCopyBtn);

			// ── Source Code Panel (collapsed by default) ──
			const srcSection = append(body, $('.mc-source'));
			srcSection.style.cssText = 'border-top:1px solid var(--void-border-1,rgba(255,255,255,0.08));';
			const srcToggle = append(srcSection, $('.mc-source-toggle'));
			srcToggle.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;' +
				'cursor:pointer;font-size:11px;color:var(--void-fg-4,#6e7681);font-weight:600;transition:color 0.15s;';
			const srcChev = append(srcToggle, $('span.mc-source-chevron'));
			srcChev.textContent = '▶';
			srcChev.style.cssText = 'font-size:9px;transition:transform 0.15s;display:inline-block;';
			append(srcToggle, $('span.mc-source-label')).textContent = 'Draw.io 源代码';

			const srcCode = append(srcSection, $('.mc-source-code'));
			srcCode.style.cssText = 'display:none;margin:0 12px 10px;padding:10px 12px;' +
				'background:var(--void-bg-3,#252525);border:1px solid var(--void-border-1,rgba(255,255,255,0.08));' +
				'border-radius:6px;font-family:var(--monaco-monospace-font,monospace);font-size:11px;' +
				'line-height:1.55;color:var(--void-fg-2,#ccc);white-space:pre-wrap;word-break:break-word;' +
				'max-height:220px;overflow-y:auto;';
			srcCode.textContent = markup;

			this._register(addDisposableListener(srcToggle, EventType.CLICK, () => {
				const open = srcCode.classList.toggle('mc-source-code-open');
				srcCode.style.display = open ? 'block' : 'none';
				srcChev.textContent = open ? '▼' : '▶';
				srcChev.style.transform = open ? 'rotate(0deg)' : '';
			}));
			this._register(addDisposableListener(srcToggle, EventType.MOUSE_ENTER, () => {
				srcToggle.style.color = 'var(--void-fg-3,#9d9d9d)';
			}));
			this._register(addDisposableListener(srcToggle, EventType.MOUSE_LEAVE, () => {
				srcToggle.style.color = 'var(--void-fg-4,#6e7681)';
			}));

			// ── Async SVG render ──
			void this._renderDrawioCardSvg(markup, previewPanel, previewLoading, svgCopyBtn);
		} else {
			const tip = append(previewPanel, $('.mc-preview-empty'));
			tip.style.cssText = 'color:var(--void-fg-4,#6e7681);font-size:12px;';
			tip.textContent = 'Draw.io 图示内容为空';
		}

		// ── Tool-call-level error ──
		if (isErr && resultText) {
			const errSec = append(body, $('.delegate-sec'));
			const errHeader = append(errSec, $('.delegate-sec-header.delegate-sec-header-error'));
			append(errHeader, $('span.delegate-sec-chevron')).textContent = '▾';
			append(errHeader, $('span.delegate-sec-label')).textContent = '错误信息';
			const errBody = append(errSec, $('.delegate-sec-body.delegate-sec-body-open'));
			const errBox = append(errBody, $('.delegate-result-box.delegate-result-error'));
			errBox.textContent = resultText.slice(0, 600);
		}

		// ── Collapse toggle ──
		this._register(addDisposableListener(header, EventType.CLICK, () => {
			const expanded = body.classList.toggle('tool-header-children-expanded');
			chevron.classList.toggle('tool-header-chevron-expanded', expanded);
		}));

		return wrapper;
	}

	/**
	 * 把 mxGraphModel 渲染成 SVG 注入预览面板。
	 * 成功时注入 SVG 并启用「复制 SVG」；失败时展示错误信息。
	 */
	private async _renderDrawioCardSvg(
		markup: string,
		previewPanel: HTMLElement,
		loadingEl: HTMLElement,
		copySvgBtn?: HTMLButtonElement,
	): Promise<void> {
		const cmd = this._onExecuteCommand;
		if (!cmd) {
			loadingEl.textContent = 'Draw.io 渲染不可用';
			return;
		}

		try {
			const bodyCls = this._container.ownerDocument.body.classList;
			const isDark = bodyCls.contains('vs-dark') || bodyCls.contains('hc-black')
				|| bodyCls.contains('vscode-dark') || bodyCls.contains('vscode-high-contrast');
			const svg = await cmd('_agentStudio.renderDrawioSvg', markup, isDark ? 'dark' : 'default');
			if (typeof svg === 'string' && svg.indexOf('<svg') !== -1) {
				const safeSvg = this._sanitizeMermaidSvg(svg);
				if (!safeSvg) {
					this._mcShowError(previewPanel, loadingEl, 'Draw.io 渲染结果不是合法的 SVG');
					return;
				}
				previewPanel.innerHTML = (_drawioTtPolicy?.createHTML(safeSvg) ?? safeSvg) as string;
				if (copySvgBtn) {
					copySvgBtn.style.opacity = '1';
					copySvgBtn.style.pointerEvents = 'auto';
				}
				return;
			}
			this._mcShowError(previewPanel, loadingEl, '无法渲染该 Draw.io 图示');
		} catch (err) {
			const msg = (err instanceof Error ? err.message : String(err));
			this._mcShowError(previewPanel, loadingEl, msg);
		}
	}
}

/** 解码 base64 的 mxGraphModel；失败时返回空串由调用方回退到原文。 */
function decodeBase64Utf8(b64: string): string {
	try {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
		return new TextDecoder('utf-8').decode(bytes);
	} catch {
		return '';
	}
}
