import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IToolCall } from './agentChatTypes.js';
import { AgentChatPanelWebCard } from './agentChatPanel.webCard.js';

// Reads the pixel size from width/height attributes (absolute px only) or the
// viewBox, so the rendered <img> gets a sane intrinsic width and scales via
// max-width:100%/height:auto. Mermaid always emits a viewBox.
function _svgIntrinsicSize(svg: string): { width: number; height: number } | undefined {
	const w = svg.match(/\bwidth="([\d.]+)(?:px)?"/);
	const h = svg.match(/\bheight="([\d.]+)(?:px)?"/);
	if (w && h) {
		return { width: parseFloat(w[1]), height: parseFloat(h[1]) };
	}
	const vb = svg.match(/\bviewBox="(-?[\d.]+)[ ,]+(-?[\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
	if (vb) {
		return { width: parseFloat(vb[3]), height: parseFloat(vb[4]) };
	}
	return undefined;
}

/**
 * Mermaid 图示工具卡片（renderMermaidDiagram）
 *
 * 在聊天中显示 Mermaid 图表卡片。
 * - 实际渲染交给 `_agentStudio.renderMermaidSvg`（隐藏 webview）产出 SVG，卡片内以
 *   Blob URL `<img>` 展示（规避工作台 TrustedTypes CSP）。
 * - 卡片内显示标题、状态、源代码（默认折叠）、在新标签页打开、复制 SVG、复制源代码。
 *
 * 本类是 toolCards 上帝对象拆分的第一步：将 Mermaid 卡片整组（含辅助方法）抽离到
 * 独立 feature class，插入继承链 ToolCards → MermaidCard → Markdown。
 */
export abstract class AgentChatPanelMermaidCard extends AgentChatPanelWebCard {

	/**
	 * Creates an SVG icon element via native DOM (no innerHTML).
	 * @param d      SVG path data.
	 * @param size   Icon pixel size (default 14).
	 * @param color  Stroke/fill color (default 'currentColor', inherits from parent).
	 */
	private _svgIcon(d: string, size = 14, color = 'currentColor'): SVGElement {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('width', String(size));
		svg.setAttribute('height', String(size));
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', color);
		svg.setAttribute('stroke-width', '1.5');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
		return svg;
	}

	/** Creates a toolbar button with SVG icon + label. */
	private _mcBtn(
		iconD: string, label: string, primary: boolean,
		onClick: (e: MouseEvent) => void
	): HTMLButtonElement {
		const btn = $('button.mc-btn') as HTMLButtonElement;
		btn.appendChild(this._svgIcon(iconD));
		btn.appendChild(document.createTextNode(label));
		btn.style.cssText =
			'display:inline-flex;align-items:center;gap:5px;' +
			'padding:4px 10px;font-size:11px;font-weight:500;' +
			'border-radius:5px;cursor:pointer;white-space:nowrap;' +
			'background:transparent;color:var(--void-fg-3,#9d9d9d);border:1px solid transparent;transition:all 0.15s;';
		if (primary) {
			btn.classList.add('mc-btn-primary');
			btn.style.background = 'rgba(96,165,250,0.12)';
			btn.style.color = 'var(--accent,#60a5fa)';
			btn.style.borderColor = 'rgba(96,165,250,0.25)';
		}
		this._register(addDisposableListener(btn, EventType.CLICK, onClick));
		this._register(addDisposableListener(btn, EventType.MOUSE_ENTER, () => {
			btn.style.background = primary ? 'rgba(96,165,250,0.2)' : 'rgba(255,255,255,0.06)';
			btn.style.color = primary ? 'var(--accent,#60a5fa)' : 'var(--void-fg-1,#d4d4d4)';
			btn.style.borderColor = primary ? 'rgba(96,165,250,0.4)' : 'var(--void-border-2,rgba(255,255,255,0.12))';
		}));
		this._register(addDisposableListener(btn, EventType.MOUSE_LEAVE, () => {
			btn.style.background = primary ? 'rgba(96,165,250,0.12)' : 'transparent';
			btn.style.color = primary ? 'var(--accent,#60a5fa)' : 'var(--void-fg-3,#9d9d9d)';
			btn.style.borderColor = primary ? 'rgba(96,165,250,0.25)' : 'transparent';
		}));
		return btn;
	}

	/** Creates animated loading dots + text for the preview panel. */
	private _mcLoadingDots(text: string): HTMLElement {
		const el = $('.mc-preview-loading');
		el.style.cssText = 'color:var(--void-fg-4,#6e7681);font-size:11.5px;display:flex;align-items:center;gap:6px;';
		for (let i = 0; i < 3; i++) {
			const dot = append(el, $('span.mc-dot'));
			dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--void-fg-4,#6e7681);' +
				'opacity:0.2;animation:mc-dot-bounce 1.2s ease-in-out ' + (i * 0.2) + 's infinite;';
		}
		el.appendChild(document.createTextNode(text));
		return el;
	}

	protected override _createMermaidCard(tc: IToolCall, key: string): HTMLElement {
		const wrapper = $('.tool-header-wrapper.tool-card-delegate');
		const isDone = tc.status === 'success' || (!tc.status) ||
			(tc.status !== 'running' && tc.status !== 'error' && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');
		const isRunning = tc.status === 'running';
		const isErr = tc.status === 'error';

		let args: Record<string, unknown> = {};
		if (tc.args) { try { args = JSON.parse(tc.args); } catch { /* ignore */ } }
		const diagramMarkup = (args?.markup || args?.diagram || '').toString();
		let diagramTitle: string | undefined = args?.title?.toString() || undefined;
		if (!diagramTitle && tc.result && typeof tc.result === 'string') {
			const m = tc.result.match(/\[Mermaid\]\s*Diagram\s*"([^"]+)"/);
			if (m) { diagramTitle = m[1]; }
		}
		const resultText = (typeof tc.result === 'string' ? tc.result : '');

		// ── Header ──
		const header = append(wrapper, $('.tool-header'));
		const row = append(header, $('.tool-header-row'));
		const left = append(row, $('.tool-header-left'));
		const chevron = this._svgChevron(left, 'tool-header-chevron', 14);
		const iconEl = append(left, $('span.tool-header-icon'));
		iconEl.textContent = '🔷';

		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		// Kind badge
		const kindBadge = append(titleContainer, $('span.mc-kind-badge'));
		kindBadge.textContent = 'MERMAID';
		kindBadge.style.cssText = 'font-size:10px;font-weight:700;color:var(--accent,#60a5fa);' +
			'text-transform:uppercase;letter-spacing:0.4px;margin-right:4px;';
		const titleEl = append(titleContainer, $('span.tool-header-title'));
		titleEl.textContent = diagramTitle || 'Mermaid 图示';
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

		// ── Preview Panel (always present) ──
		const previewPanel = append(body, $('.mc-preview'));
		previewPanel.style.cssText =
			'position:relative;min-height:48px;display:flex;align-items:center;justify-content:center;' +
			'padding:12px;overflow:auto;max-height:420px;' +
			'background:repeating-linear-gradient(0deg,transparent,transparent 19px,' +
			'rgba(255,255,255,0.008) 19px,rgba(255,255,255,0.008) 20px),' +
			'repeating-linear-gradient(90deg,transparent,transparent 19px,' +
			'rgba(255,255,255,0.008) 19px,rgba(255,255,255,0.008) 20px);' +
			'border-bottom:1px solid var(--void-border-1,rgba(255,255,255,0.08));';
		const fullMarkup = diagramMarkup.replace(/\\n/g, '\n');

		if (isRunning && !diagramMarkup.trim()) {
			previewPanel.appendChild(this._mcLoadingDots('正在准备 Mermaid 图示…'));
		} else if (diagramMarkup.trim()) {
			const markdownSrc = diagramMarkup;
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

			// Open in new tab (primary)
			toolbar.appendChild(this._mcBtn(
				'M3 3h4v1H4v8h8v-3h1v4H3V3zm5 1h5v5h-1V5.7l-5.65 5.65-.7-.7L11.3 5H8V4z',
				'在新标签页打开', true,
				(e) => {
					e.stopPropagation();
					if (this._onExecuteCommand) {
						this._onExecuteCommand('_mermaid-chat.openPreview', fullMarkup, diagramTitle || 'Mermaid 预览')
							.catch(err => console.warn('[MermaidCard] openPreview failed:', err));
					}
				}
			));

			// Copy SVG
			const svgCopyBtn = this._mcBtn(
				'M4 4h3v1H5v7h7v-2h1v3H4V4zm3 0h5v5h-1V5.7L6.35 10.35l-.7-.7L10.3 5H7V4z',
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
					try { navigator.clipboard.writeText(fullMarkup); } catch { /* ignore */ }
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
			append(srcToggle, $('span.mc-source-label')).textContent = 'Mermaid 源代码';

			const srcCode = append(srcSection, $('.mc-source-code'));
			srcCode.style.cssText = 'display:none;margin:0 12px 10px;padding:10px 12px;' +
				'background:var(--void-bg-3,#252525);border:1px solid var(--void-border-1,rgba(255,255,255,0.08));' +
				'border-radius:6px;font-family:var(--monaco-monospace-font,monospace);font-size:11px;' +
				'line-height:1.55;color:var(--void-fg-2,#ccc);white-space:pre-wrap;word-break:break-word;' +
				'max-height:220px;overflow-y:auto;';
			srcCode.textContent = fullMarkup;

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
			void this._renderMermaidCardSvg(markdownSrc, previewPanel, previewLoading, svgCopyBtn);
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
	 * Renders a Mermaid diagram to an inline SVG inside the preview panel.
	 * On success appends the SVG node; on failure shows an error message with
	 * an icon. Enables the "Copy SVG" button when SVG is available.
	 */
	private async _renderMermaidCardSvg(
		markup: string,
		previewPanel: HTMLElement,
		loadingEl: HTMLElement,
		copySvgBtn?: HTMLButtonElement,
	): Promise<void> {
		const cmd = this._onExecuteCommand;
		if (!cmd) {
			loadingEl.textContent = 'Mermaid 渲染不可用';
			return;
		}

		try {
			const bodyCls = this._container.ownerDocument.body.classList;
			const isDark = bodyCls.contains('vs-dark') || bodyCls.contains('hc-black')
				|| bodyCls.contains('vscode-dark') || bodyCls.contains('vscode-high-contrast');
			const svg = await cmd('_agentStudio.renderMermaidSvg', markup.replace(/\\n/g, '\n'), isDark ? 'dark' : 'default');
			if (typeof svg === 'string' && svg.indexOf('<svg') !== -1) {
				// Render via an <img> backed by a Blob URL. This avoids DOMParser/TrustedTypes
				// entirely (CSP img-src allows blob:), is more robust than a data: URL for
				// large/arbitrary SVG payloads (no percent-encoding pitfalls or length caps),
				// and an SVG loaded as an image still applies the diagram's own internal
				// <style> for correct theming.
				const img = document.createElement('img');
				img.alt = 'Mermaid diagram';
				const size = _svgIntrinsicSize(svg);
				if (size) { img.width = Math.round(size.width); }
				// min-width:0 is essential: .mc-preview is display:flex, and a flex item
				// defaults to min-width:auto (won't shrink below its intrinsic width). With
				// a wide diagram that floor exceeds max-width:100% and wins, so the image
				// overflows instead of scaling to fit. Zeroing it lets max-width shrink it.
				img.style.cssText = 'max-width:100%;height:auto;display:block;margin:0 auto;min-width:0;';
				const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
				this._register({ dispose: () => URL.revokeObjectURL(blobUrl) });
				img.onload = () => {
					loadingEl.remove();
					previewPanel.appendChild(img);
					if (copySvgBtn) {
						copySvgBtn.style.opacity = '1';
						copySvgBtn.style.pointerEvents = 'auto';
					}
				};
				img.onerror = () => {
					console.warn('[MermaidCard] SVG <img> failed to load; svg.length=' + svg.length +
						', head=' + svg.slice(0, 120).replace(/\s+/g, ' '));
					this._mcShowError(previewPanel, loadingEl, 'SVG 图片加载失败');
				};
				// Attach handlers before assigning src so load/error are never missed.
				img.src = blobUrl;
				return;
			}
			this._mcShowError(previewPanel, loadingEl, '无法渲染该 Mermaid 图示');
		} catch (err) {
			const msg = (err instanceof Error ? err.message : String(err));
			this._mcShowError(previewPanel, loadingEl, msg);
		}
	}

	/** Replaces the loading content in the preview panel with an error display. */
	private _mcShowError(previewPanel: HTMLElement, loadingEl: HTMLElement, message: string): void {
		loadingEl.remove();
		const errEl = $('.mc-preview-error');
		errEl.style.cssText = 'color:#f87171;font-size:11.5px;display:flex;align-items:center;gap:6px;';
		errEl.appendChild(this._svgIcon(
			'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7.25 4.5h1.5v5h-1.5v-5zm0 6.5h1.5v1.5h-1.5V11z',
			14, '#f87171'
		));
		// Truncate very long parse errors for readability
		const shortMsg = message.length > 200 ? message.slice(0, 200) + '…' : message;
		errEl.appendChild(document.createTextNode(shortMsg));
		previewPanel.appendChild(errEl);
	}
}
