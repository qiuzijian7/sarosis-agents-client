import { $, append, addDisposableListener, EventType, clearNode } from '../../../base/browser/dom.js';
import { IToolCall } from './agentChatTypes.js';
import { AgentChatPanelWebCard } from './agentChatPanel.webCard.js';
import { parseToolArgsLoose } from './toolArgsJson.js';

// 2026-09-05：SVG 注入统一改为 <img> + Blob URL（_createMermaidSvgImage）。
// 该 fork 的 Chromium 对 Trusted Types 极严格：innerHTML（含清空）、DOMParser
// 任何 type（含 text/xml）都强制 TrustedHTML，只有 img.src（资源加载，非注入
// sink）能稳定绕开。不再依赖 Trusted Types policy。

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
	protected _svgIcon(d: string, size = 14, color = 'currentColor'): SVGElement {
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
	protected _mcBtn(
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
	protected _mcLoadingDots(text: string): HTMLElement {
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
		// tool-card-mermaid：专属类，覆盖 delegate 的 header-row flex-start 对齐
		//（mermaid 标题单行，需要垂直居中，见 agentChat.css）
		const wrapper = $('.tool-header-wrapper.tool-card-delegate.tool-card-mermaid');
		const isDone = tc.status === 'success' || (!tc.status) ||
			(tc.status !== 'running' && tc.status !== 'error' && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');
		const isRunning = tc.status === 'running';
		const isErr = tc.status === 'error';

		// 宽松修复链：mermaid markup 里常含 `\n` 之外的转义，裸 parse 失败会让整张图空白
		const args: Record<string, unknown> = parseToolArgsLoose(tc.args);
		const diagramMarkup = (args?.markup || args?.diagram || '').toString();
		let diagramTitle: string | undefined = args?.title?.toString() || undefined;
		if (!diagramTitle && tc.result && typeof tc.result === 'string') {
			const m = tc.result.match(/\[Mermaid\]\s*Diagram\s*"([^"]+)"/);
			if (m) { diagramTitle = m[1]; }
		}
		const resultText = (typeof tc.result === 'string' ? tc.result : '');
		const fullMarkup = diagramMarkup.replace(/\\n/g, '\n');

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
		// 2026-09-05：「在新编辑器打开」按钮移到 title 行右侧并改造为超链接样式
		// （用户要求）。样式参考编辑器内常见 link：accent 色 + 默认无下划线、hover 加下划线。
		// click 需 stopPropagation 避免触发 header 折叠，preventDefault 阻止锚点跳转。
		if (fullMarkup.trim()) {
			const openLink = document.createElement('a');
			openLink.href = '#';
			openLink.textContent = '查看文件';
			openLink.title = '在新编辑器打开预览';
			openLink.setAttribute('role', 'button');
			openLink.style.cssText = 'font-size:12px;color:var(--accent,#60a5fa);' +
				'text-decoration:none;margin-right:8px;cursor:pointer;user-select:none;';
			this._register(addDisposableListener(openLink, EventType.MOUSE_ENTER, () => {
				openLink.style.textDecoration = 'underline';
			}));
			this._register(addDisposableListener(openLink, EventType.MOUSE_LEAVE, () => {
				openLink.style.textDecoration = 'none';
			}));
			this._register(addDisposableListener(openLink, EventType.CLICK, (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (this._onExecuteCommand) {
					this._onExecuteCommand('_mermaid-chat.openPreviewHost', fullMarkup, diagramTitle || 'Mermaid 预览')
						.catch(err => console.warn('[MermaidCard] openPreview failed:', err));
				}
			}));
			right.appendChild(openLink);
		}
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
		// 2026-09-05：图表卡片默认展开（用户要求）——CSS 里 .tool-header-children
		// 默认 max-height:0/opacity:0（收起），必须初始挂 expanded class。
		const body = append(wrapper, $('.tool-header-children.tool-header-children-expanded'));

		if (isRunning && !diagramMarkup.trim()) {
			// 流式未就绪：仅加载态
			const previewPanel = append(body, $('.mc-preview'));
			previewPanel.style.cssText =
				'position:relative;min-height:48px;display:flex;align-items:center;justify-content:center;' +
				'padding:12px;overflow:auto;max-height:420px;' +
				'border-bottom:1px solid var(--void-border-1,rgba(255,255,255,0.08));';
			previewPanel.appendChild(this._mcLoadingDots('正在准备 Mermaid 图示…'));
		} else if (diagramMarkup.trim()) {
			// ── Tab 行：左「代码 | 图表」分段切换，右控件组 ──
			// 2026-09-05 按 UI 稿重构：主题切换 / 缩放 / 在新编辑器打开 / 下载。
			const tabRow = append(body, $('.mc-tab-row'));
			tabRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;' +
				'border-bottom:1px solid var(--void-border-1,rgba(255,255,255,0.08));' +
				'background:var(--void-bg-3,#1e222a);';
			const tabs = append(tabRow, $('.mc-tabs'));
			tabs.style.cssText = 'display:flex;gap:2px;padding:2px;border-radius:6px;' +
				'background:rgba(0,0,0,0.28);';
			const mkTab = (label: string, active: boolean) => {
				const t = $('button.mc-tab') as HTMLButtonElement;
				t.textContent = label;
				t.style.cssText = 'padding:3px 14px;font-size:11.5px;font-weight:500;border:none;' +
					'border-radius:4px;cursor:pointer;background:transparent;transition:all 0.15s;' +
					'color:var(--void-fg-4,#6e7681);';
				if (active) {
					t.style.background = 'rgba(96,165,250,0.18)';
					t.style.color = 'var(--void-fg-1,#dbe6ff)';
				}
				this._register(addDisposableListener(t, EventType.MOUSE_ENTER, () => {
					if (t.classList.contains('mc-tab-active')) { return; }
					t.style.color = 'var(--void-fg-2,#aab)'; t.style.background = 'rgba(255,255,255,0.05)';
				}));
				this._register(addDisposableListener(t, EventType.MOUSE_LEAVE, () => {
					if (t.classList.contains('mc-tab-active')) { return; }
					t.style.color = 'var(--void-fg-4,#6e7681)'; t.style.background = 'transparent';
				}));
				return t;
			};
			const codeTab = mkTab('代码', false);
			const chartTab = mkTab('图表', true);
			tabs.appendChild(codeTab);
			tabs.appendChild(chartTab);

			// ── 控件组（右侧）──
			const ctl = append(tabRow, $('.mc-ctl'));
			ctl.style.cssText = 'display:flex;align-items:center;gap:2px;margin-left:auto;';
			const mkIconBtn = (iconD: string | string[], title: string, label?: string) => {
				const b = $('button.mc-ctl-btn') as HTMLButtonElement;
				b.title = title;
				b.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:4px 7px;font-size:11.5px;' +
					'border:none;border-radius:5px;cursor:pointer;background:transparent;' +
					'color:var(--void-fg-3,#9aa4b2);transition:all 0.15s;white-space:nowrap;';
				const paths = Array.isArray(iconD) ? iconD : [iconD];
				for (const d of paths) { b.appendChild(this._svgIcon(d, 14)); }
				if (label) { b.appendChild(document.createTextNode(label)); }
				this._register(addDisposableListener(b, EventType.MOUSE_ENTER, () => {
					b.style.background = 'rgba(255,255,255,0.07)';
					b.style.color = 'var(--void-fg-1,#d4d4d4)';
				}));
				this._register(addDisposableListener(b, EventType.MOUSE_LEAVE, () => {
					b.style.background = 'transparent';
					b.style.color = 'var(--void-fg-3,#9aa4b2)';
				}));
				return b;
			};

			// ── 视图容器 ──
			// 图表视图：深色画布（贴合 UI 稿），SVG 居中、可缩放
			const previewPanel = append(body, $('.mc-preview'));
			previewPanel.style.cssText =
				'position:relative;min-height:220px;max-height:480px;overflow:auto;' +
				'display:flex;align-items:center;justify-content:center;padding:16px;' +
				'background:var(--void-bg-1,#14171c);';
			// 代码视图：默认隐藏
			const codeView = append(body, $('.mc-code-view'));
			codeView.style.cssText = 'display:none;padding:12px 14px;background:var(--void-bg-1,#14171c);' +
				'font-family:var(--monaco-monospace-font,monospace);font-size:11.5px;line-height:1.6;' +
				'color:var(--void-fg-2,#c9d1d9);white-space:pre-wrap;word-break:break-word;' +
				'max-height:480px;overflow:auto;margin:0;';
			codeView.textContent = fullMarkup;

			// ── 状态 ──
			let currentTheme: 'dark' | 'default' = 'dark';
			let currentSvg = '';
			let zoom = 1; // 1 = fit 卡片宽度
			let baseMaxWidth = 0; // 渲染后从 svg 的 style.max-width 解析的自然宽度（px）
			const bodyCls = this._container.ownerDocument.body.classList;
			const ideIsDark = bodyCls.contains('vs-dark') || bodyCls.contains('hc-black')
				|| bodyCls.contains('vscode-dark') || bodyCls.contains('vscode-high-contrast');
			currentTheme = ideIsDark ? 'dark' : 'default';

			// 主题切换按钮（图标随当前主题变：暗色渲染中显示 ☀ = 切到亮色）
			const themeBtn = mkIconBtn([], '切换亮/暗主题');
			themeBtn.textContent = currentTheme === 'dark' ? '☀' : '☾';
			themeBtn.style.fontSize = '13px';

			const zoomOutBtn = mkIconBtn('M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM3 3 1 1M13.5 8h-5', '缩小');
			const zoomInBtn = mkIconBtn('M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM3 3 1 1M8.75 5.5v5M6.25 8h5', '放大');
			const downloadBtn = mkIconBtn(
				'M8 1v8.5M4.8 6.8 8 10l3.2-3.2M2.5 12.5h11', '下载 SVG', '下载'
			);
			ctl.appendChild(themeBtn);
			ctl.appendChild(zoomOutBtn);
			ctl.appendChild(zoomInBtn);
			ctl.appendChild(downloadBtn);

			// ── Tab 切换 ──
			const setView = (view: 'chart' | 'code') => {
				const chartActive = view === 'chart';
				for (const [t, on] of [[chartTab, chartActive], [codeTab, !chartActive]] as const) {
					t.classList.toggle('mc-tab-active', on);
					t.style.background = on ? 'rgba(96,165,250,0.18)' : 'transparent';
					t.style.color = on ? 'var(--void-fg-1,#dbe6ff)' : 'var(--void-fg-4,#6e7681)';
				}
				previewPanel.style.display = chartActive ? 'flex' : 'none';
				codeView.style.display = chartActive ? 'none' : 'block';
				// 控件仅对图表视图有意义
				for (const b of [themeBtn, zoomOutBtn, zoomInBtn]) {
					b.style.opacity = chartActive ? '1' : '0.35';
					b.style.pointerEvents = chartActive ? 'auto' : 'none';
				}
			};
			this._register(addDisposableListener(codeTab, EventType.CLICK, (e) => { e.stopPropagation(); setView('code'); }));
			this._register(addDisposableListener(chartTab, EventType.CLICK, (e) => { e.stopPropagation(); setView('chart'); }));

			// ── 缩放（1 = mermaid 自然尺寸；通过 max-width 缩放 img）──
			const applyZoom = () => {
				const el = previewPanel.querySelector('img, svg') as HTMLElement | null;
				if (!el) { return; }
				const base = baseMaxWidth > 0 ? baseMaxWidth : (previewPanel.clientWidth - 32);
				el.style.maxWidth = Math.round(base * zoom) + 'px';
			};
			this._register(addDisposableListener(zoomOutBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				zoom = Math.max(0.3, zoom / 1.2);
				applyZoom();
			}));
			this._register(addDisposableListener(zoomInBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				zoom = Math.min(5, zoom * 1.2);
				applyZoom();
			}));

			// 「在新编辑器打开」监听已移至 header 右侧按钮（见上方 right 容器处）。

			// ── 下载 SVG ──
			this._register(addDisposableListener(downloadBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (!currentSvg) { return; }
				try {
					const blob = new Blob([currentSvg], { type: 'image/svg+xml;charset=utf-8' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = (diagramTitle || 'mermaid').replace(/[\\/:*?"<>|]+/g, '_') + '.svg';
					a.click();
					setTimeout(() => URL.revokeObjectURL(url), 2000);
				} catch { /* ignore */ }
			}));

			// ── 渲染（主题可切换重渲）──
			// 2026-09-05 修复「主题切换未生效」：mermaid SVG 背景透明，颜色全靠线条/
			// 文字——dark 主题白字需要深底、default 主题黑字需要浅底。画布背景若固定
			// 深色，切到亮色主题后黑字在深底上几乎不可见（= 用户看到的「未生效」）。
			// 故背景必须随渲染主题联动。
			const renderChart = async (theme: 'dark' | 'default') => {
				previewPanel.style.background = theme === 'dark' ? 'var(--void-bg-1,#14171c)' : '#ffffff';
				console.info(`[MermaidCard] renderChart start theme=${theme} markupLen=${fullMarkup.length} attached=${previewPanel.isConnected}`);
				clearNode(previewPanel);
				const loading = this._mcLoadingDots('正在渲染图示…');
				previewPanel.appendChild(loading);
				const cmd = this._onExecuteCommand;
				if (!cmd) {
					loading.textContent = 'Mermaid 渲染不可用（_onExecuteCommand 未注册）';
					console.warn('[MermaidCard] _onExecuteCommand unavailable');
					return;
				}
				try {
					const svg = await cmd('_agentStudio.renderMermaidSvg', fullMarkup, theme);
					if (typeof svg !== 'string' || svg.indexOf('<svg') === -1) {
						console.warn('[MermaidCard] renderMermaidSvg returned invalid:', typeof svg, svg && String(svg).slice(0, 120));
						clearNode(previewPanel);
						this._mcShowError(previewPanel, loading, '无法渲染该 Mermaid 图示（渲染器返回空结果）');
						return;
					}
					const safeSvg = this._sanitizeMermaidSvg(svg);
					if (!safeSvg) {
						console.warn('[MermaidCard] sanitize produced empty svg');
						clearNode(previewPanel);
						this._mcShowError(previewPanel, loading, '无法渲染该 Mermaid 图示（SVG 消毒失败）');
						return;
					}
					currentSvg = safeSvg;
					zoom = 1;
					loading.remove();
					// 2026-09-05：<img> + Blob URL 显示 SVG——绕开 Trusted Types
					//（img.src 是资源加载，非 HTML 注入 sink；innerHTML/DOMParser 在此
					// fork 全被 TT 拦）。缩放通过 img.style.maxWidth 调整。
					const img = this._createMermaidSvgImage(safeSvg);
					previewPanel.appendChild(img);
					const size = _svgIntrinsicSize(safeSvg);
					baseMaxWidth = size ? size.width : (previewPanel.clientWidth - 32) || 600;
					console.info(`[MermaidCard] svg injected via <img> len=${safeSvg.length} baseMaxWidth=${baseMaxWidth} attached=${previewPanel.isConnected}`);
				} catch (err) {
					console.error('[MermaidCard] render failed:', err);
					const msg = (err instanceof Error ? err.message : String(err));
					clearNode(previewPanel);
					this._mcShowError(previewPanel, loading, msg);
				}
			};

			this._register(addDisposableListener(themeBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				currentTheme = currentTheme === 'dark' ? 'default' : 'dark';
				themeBtn.textContent = currentTheme === 'dark' ? '☀' : '☾';
				void renderChart(currentTheme);
			}));

			// 首次渲染（跟随 IDE 主题）
			void renderChart(currentTheme);
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
	 * 清洗 Mermaid SVG 字符串以安全注入 innerHTML：
	 * - mermaid strict 模式已消毒输出，这里再剥掉可能的 <script> 与 on* 事件属性（防御纵深）。
	 * - 返回清洗后的 SVG 字符串；不含 <svg> 根元素时返回 null（由调用方回退到 <img> 方案）。
	 */
	protected _sanitizeMermaidSvg(svg: string): string | null {
		if (!svg || svg.indexOf('<svg') === -1) { return null; }
		return svg
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
	}

	/**
	 * Renders a Mermaid diagram to an inline SVG inside a preview panel.
	 * 2026-09-05：工具卡片已改用 renderChart（tab/主题/缩放），本方法保留给
	 * markdown 代码块（```mermaid）的轻量预览路径（markdown.ts）调用。
	 */
	protected async _renderMermaidCardSvg(
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
				const safeSvg = this._sanitizeMermaidSvg(svg);
				if (safeSvg) {
					// 2026-09-05：同工具卡片——innerHTML / DOMParser 在此 fork 全被
					// Trusted Types 拦，统一用 <img> + Blob URL（img.src 非注入 sink）。
					loadingEl.remove();
					const img = this._createMermaidSvgImage(safeSvg);
					img.onload = () => {
						if (copySvgBtn) {
							copySvgBtn.style.opacity = '1';
							copySvgBtn.style.pointerEvents = 'auto';
						}
					};
					previewPanel.appendChild(img);
					if (copySvgBtn) {
						copySvgBtn.style.opacity = '1';
						copySvgBtn.style.pointerEvents = 'auto';
					}
					return;
				}
				this._mcShowError(previewPanel, loadingEl, '无法渲染该 Mermaid 图示');
				return;
			}
			this._mcShowError(previewPanel, loadingEl, '无法渲染该 Mermaid 图示');
		} catch (err) {
			const msg = (err instanceof Error ? err.message : String(err));
			this._mcShowError(previewPanel, loadingEl, msg);
		}
	}

	/**
	 * 2026-09-05 最终方案：<img> + Blob URL 显示 SVG。
	 * 该 fork 的 Chromium 对 Trusted Types 极严格：innerHTML（含清空）、
	 * DOMParser.parseFromString 的任何 type（含 text/xml）都强制 TrustedHTML，
	 * 全部抛 "This document requires 'TrustedHTML' assignment"。唯一稳定绕开的
	 * 路径是 <img src=blob:>——img.src 是资源加载（URL），不是 HTML 注入 sink，
	 * TT 不拦截。代价：<img> 不渲染 foreignObject（mermaid 中带 <br>/<b> 等
	 * HTML 标签的节点 label 会丢富文本），但图整体形状与文字可见。
	 */
	protected _createMermaidSvgImage(safeSvg: string): HTMLImageElement {
		const blobUrl = URL.createObjectURL(new Blob([safeSvg], { type: 'image/svg+xml;charset=utf-8' }));
		this._register({ dispose: () => URL.revokeObjectURL(blobUrl) });
		const img = document.createElement('img');
		img.alt = 'Mermaid diagram';
		const size = _svgIntrinsicSize(safeSvg);
		if (size) { img.width = Math.round(size.width); }
		img.style.cssText = 'max-width:100%;height:auto;display:block;margin:0 auto;min-width:0;';
		img.onerror = () => console.error('[MermaidCard] svg <img> failed to load');
		img.src = blobUrl;
		return img;
	}

	/** Replaces the loading content in the preview panel with an error display. */
	protected _mcShowError(previewPanel: HTMLElement, loadingEl: HTMLElement, message: string): void {
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
