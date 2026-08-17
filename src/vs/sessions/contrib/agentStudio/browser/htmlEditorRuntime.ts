/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HTML 编辑器运行时 — 从 frontend-slides-editable 项目移植。
 *
 * 这个模块将完整的可视化编辑器运行时（CSS + HTML chrome + JS）封装为
 * 字符串常量，供 HtmlFileEditorPane 在 edit 模式注入到 webview 中。
 *
 * 运行时功能包括：
 *   - 对象拖拽、多选、边角/边缘缩放
 *   - 富文本工具栏（加粗/斜体/字体/字号）
 *   - 撤销/重做
 *   - Pages 侧栏（缩略图、重排、删除、复制、新建）
 *   - 添加元素（文本/图片/视频）
 *   - Ctrl+S 保存、导出 HTML
 *   - 吸附对齐
 */

/**
 * 将原始 HTML 包装为带编辑器运行时的完整 HTML 文档。
 *
 * 对于普通 HTML 页面（非幻灯片），使用 contentEditable + 浮动工具栏
 * 实现可视化编辑：点击元素可直接编辑文本，工具栏提供格式化功能。
 *
 * @param rawHtml 用户的 HTML 文件原始内容
 * @returns 包装后的完整 HTML 文档字符串
 */
export function wrapHtmlWithEditorRuntime(rawHtml: string): string {
	const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; script-src 'unsafe-inline' 'unsafe-eval' https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; img-src 'self' data: https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; font-src data: https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; connect-src https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; frame-src https: vscode-webview: vscode-file:;">`;

	const editorCss = getEditorCss();
	const editorHtml = getEditorChromeHtml();
	const editorJs = getEditorJs();

	// 检查原始 HTML 是否已有 <head>
	const lower = rawHtml.toLowerCase();
	const headIdx = lower.indexOf('<head>');

	// 构建编辑器 chrome + 运行时注入块
	const injection = `${csp}\n    <style data-editor-runtime>\n${editorCss}\n    </style>`;

	let result: string;

	if (headIdx >= 0) {
		// 在 <head> 后注入 CSS
		const insertPos = headIdx + '<head>'.length;
		const withCss = rawHtml.slice(0, insertPos) + injection + rawHtml.slice(insertPos);

		// 在 </body> 前注入 chrome HTML + JS
		const bodyCloseIdx = withCss.toLowerCase().lastIndexOf('</body>');
		if (bodyCloseIdx >= 0) {
			result = withCss.slice(0, bodyCloseIdx) + editorHtml + '\n<script data-editor-runtime>\n' + editorJs + '\n</script>\n' + withCss.slice(bodyCloseIdx);
		} else {
			result = withCss + editorHtml + '\n<script data-editor-runtime>\n' + editorJs + '\n</script>\n';
		}
	} else {
		// 没有 <head>，包装为完整文档
		const htmlIdx = lower.indexOf('<html');
		if (htmlIdx >= 0) {
			const closeBracket = rawHtml.indexOf('>', htmlIdx);
			if (closeBracket >= 0) {
				result = rawHtml.slice(0, closeBracket + 1)
					+ `<head>${injection}</head>`
					+ rawHtml.slice(closeBracket + 1);
				const bodyCloseIdx = result.toLowerCase().lastIndexOf('</body>');
				if (bodyCloseIdx >= 0) {
					result = result.slice(0, bodyCloseIdx) + editorHtml + '\n<script data-editor-runtime>\n' + editorJs + '\n</script>\n' + result.slice(bodyCloseIdx);
				} else {
					result += editorHtml + '\n<script data-editor-runtime>\n' + editorJs + '\n</script>\n';
				}
			} else {
				result = `<!doctype html><html><head>${injection}</head><body>${rawHtml}${editorHtml}<script data-editor-runtime>${editorJs}</script></body></html>`;
			}
		} else {
			// Fragment: wrap into a full document
			result = `<!doctype html><html><head>${injection}</head><body>${rawHtml}${editorHtml}<script data-editor-runtime>${editorJs}</script></body></html>`;
		}
	}

	return result;
}

/**
 * 从带编辑器运行时的 HTML 中提取清理后的 HTML（去除编辑态）。
 * 这个函数在 host 侧调用，但实际清理逻辑在 webview 内执行。
 * Host 侧通过 postMessage 请求 webview 执行清理并返回结果。
 */
export const CLEANUP_REQUEST_MESSAGE = 'htmlEditor.requestCleanup';
export const CLEANUP_RESPONSE_MESSAGE = 'htmlEditor.cleanupResult';

/**
 * 编辑器 CSS — 简洁的可视化编辑器样式。
 * 工具栏默认隐藏，点击元素时才显示。左上角只显示 Add element 按钮。
 */
function getEditorCss(): string {
	return `
/* Add element 按钮 — 左上角固定 */
#html-edit-add-btn {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 99999;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: rgba(34, 211, 238, 0.15);
  border: 1px solid rgba(34, 211, 238, 0.4);
  border-radius: 8px;
  color: #22d3ee;
  font-size: 13px;
  font-weight: 600;
  font-family: system-ui, -apple-system, sans-serif;
  cursor: pointer;
  backdrop-filter: blur(12px);
  transition: background 0.15s;
}
body.html-edit-mode #html-edit-add-btn { display: flex; }
#html-edit-add-btn:hover { background: rgba(34, 211, 238, 0.25); }

/* Add element 下拉菜单 */
#html-edit-add-menu {
  position: fixed;
  top: 44px;
  left: 8px;
  z-index: 99999;
  display: none;
  flex-direction: column;
  gap: 4px;
  min-width: 120px;
  padding: 6px;
  background: rgba(30, 30, 30, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(12px);
}
#html-edit-add-menu.open { display: flex; }
#html-edit-add-menu button {
  text-align: left;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(60, 60, 60, 0.8);
  color: #e0e0e0;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
#html-edit-add-menu button:hover {
  background: rgba(90, 90, 90, 0.9);
}

/* 浮动格式化工具栏 — 点击元素时显示（方案 A：紧凑横排） */
#html-edit-toolbar {
  position: fixed;
  z-index: 99999;
  display: none;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: rgba(24, 24, 27, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 10px 38px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(16px);
  font-family: system-ui, -apple-system, sans-serif;
  white-space: nowrap;
}
#html-edit-toolbar.visible { display: flex; }
#html-edit-toolbar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #e4e4e7;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s;
}
#html-edit-toolbar button:hover:not(:disabled) {
  background: rgba(63, 63, 70, 0.8);
}
#html-edit-toolbar button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
#html-edit-toolbar button.is-active {
  background: rgba(34, 211, 238, 0.12);
  color: #22d3ee;
}
#html-edit-toolbar .tb-separator {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.12);
  margin: 0 3px;
  flex-shrink: 0;
}

/* popover 容器：相对定位，弹出面板基于此定位 */
#html-edit-toolbar .popover-wrap {
  position: relative;
  display: inline-flex;
}

/* popover 下拉面板（字号 / 字体 / 颜色） */
#html-edit-toolbar .popover {
  position: absolute;
  top: 100%;
  left: 0;
  display: none;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  padding: 6px;
  min-width: 140px;
  background: rgba(24, 24, 27, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 10px 38px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(16px);
  z-index: 100000;
}
#html-edit-toolbar .popover.open { display: flex; }
#html-edit-toolbar .popover-item {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 12px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: #e4e4e7;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
  white-space: nowrap;
}
#html-edit-toolbar .popover-item:hover { background: rgba(63, 63, 70, 0.8); }
#html-edit-toolbar .popover-item.is-active { color: #22d3ee; }

/* 颜色面板 */
#html-edit-toolbar .color-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  padding: 4px;
}
#html-edit-toolbar .color-swatch {
  width: 22px;
  height: 22px;
  border: 2px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.1s, transform 0.1s;
}
#html-edit-toolbar .color-swatch:hover { border-color: #22d3ee; transform: scale(1.1); }

/* 内联输入框弹窗（链接 / 图片） */
#html-edit-toolbar .input-popover {
  position: absolute;
  top: 100%;
  left: 0;
  display: none;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 8px;
  background: rgba(24, 24, 27, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 10px 38px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(16px);
  z-index: 100000;
}
#html-edit-toolbar .input-popover.open { display: flex; }
#html-edit-toolbar .input-popover input {
  width: 220px;
  padding: 5px 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.3);
  color: #e4e4e7;
  font-size: 12px;
  outline: none;
}
#html-edit-toolbar .input-popover input:focus { border-color: #22d3ee; }
#html-edit-toolbar .input-popover button {
  width: auto;
  padding: 5px 12px;
  border: none;
  border-radius: 5px;
  background: #22d3ee;
  color: #000;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
body.html-edit-mode {
  cursor: text;
}
body.html-edit-mode [contenteditable="true"]:focus {
  outline: 2px solid rgba(34, 211, 238, 0.5);
  outline-offset: 2px;
}

/* 保存按钮 — 蓝色高亮，明显区别于其他工具按钮 */
#html-edit-toolbar .tb-save-btn {
  width: auto;
  padding: 0 10px;
  gap: 6px;
  background: rgba(34, 211, 238, 0.18);
  color: #22d3ee;
  font-weight: 600;
  font-size: 12px;
}
#html-edit-toolbar .tb-save-btn:hover {
  background: rgba(34, 211, 238, 0.32);
}
#html-edit-toolbar .tb-save-btn:active {
  background: rgba(34, 211, 238, 0.45);
}

/* ===== Slide/Deck 对象级编辑 chrome ===== */
/* 重要：不要覆写 .slide 自身的 position！用户 deck 经常用
   .slide { position: absolute; inset:0; opacity:0 } + .slide.active { opacity:1 }
   这类「JS 切换型」布局，覆写会破坏 active slide 的绝对定位。
   1) 父级容器（.stage/.deck/.slides-offset）做定位上下文，
      确保对象 .slide.getBoundingClientRect() 返回有意义位置；
   2) 强制所有 slide 在编辑态下可见（用户 deck 默认 opacity:0）。 */
body.html-edit-mode .stage,
body.html-edit-mode .deck,
body.html-edit-mode .slides-offset {
  position: relative;
}
/* 关键：JS 切换型 deck 默认 .slide { opacity:0; visibility:hidden }。
   编辑态下让「当前 active slide」+「相邻 +/-1 slide」可见，避免对象编辑时
   多个 slide 全堆在原点导致文字重叠（用户的 slide 是 position:absolute inset:0）。 */
body.html-edit-mode section.slide,
body.html-edit-mode [data-slide] {
  pointer-events: auto !important;
}
body.html-edit-mode section.slide.active,
body.html-edit-mode [data-slide].active,
body.html-edit-mode section.slide.current,
body.html-edit-mode [data-slide].current,
body.html-edit-mode section.slide.visible,
body.html-edit-mode [data-slide].visible {
  opacity: 1 !important;
  visibility: visible !important;
}
/* 非 deck 文档（全局 stack）的 slide，全部可见即可 */
body.html-edit-mode:not(.html-deck-mode) section.slide,
body.html-edit-mode:not(.html-deck-mode) [data-slide] {
  opacity: 1 !important;
  visibility: visible !important;
}

/* 左上 hover 编辑簇 */
#sar-deck-hover {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100000;
  display: none;
  flex-direction: column;
  gap: 4px;
}
body.html-edit-mode.html-deck-mode #sar-deck-hover { display: flex; }
#sar-deck-hover .sar-hover-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  background: rgba(24, 24, 27, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
}
#sar-deck-hover button {
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: #e4e4e7;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
#sar-deck-hover button:hover { background: #333; }
#sar-deck-hover button:disabled { opacity: 0.35; cursor: default; }
#sar-deck-hover button.sar-primary { background: #22d3ee; color: #083344; font-weight: 600; }
#sar-deck-hover button.sar-active { background: rgba(34, 211, 238, 0.18); color: #22d3ee; }
#sar-deck-hover .sar-sep { width: 1px; height: 18px; background: rgba(255, 255, 255, 0.14); }

/* 右侧 Pages 侧栏 */
#sar-slide-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 196px;
  z-index: 99998;
  background: #252526;
  border-left: 1px solid #2a2a2a;
  display: none;
  flex-direction: column;
}
body.html-edit-mode.html-deck-mode #sar-slide-sidebar { display: flex; }
body.html-edit-mode.html-deck-mode #sar-slide-sidebar.sar-hidden { display: none; }
#sar-slide-sidebar .sar-sidebar-head {
  padding: 10px 12px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #8a8a8a;
}
#sar-slide-sidebar .sar-filmstrip {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sar-fs-item {
  border: 2px solid transparent;
  border-radius: 6px;
  padding: 3px;
  background: #1e1e1e;
  cursor: pointer;
}
.sar-fs-item.sar-current { border-color: #22d3ee; }
.sar-fs-item.sar-dragging { opacity: 0.5; }
.sar-fs-thumb {
  aspect-ratio: 16 / 9;
  border-radius: 4px;
  overflow: hidden;
  background: #020617;
  position: relative;
  pointer-events: none;
}
.sar-fs-thumb .sar-fs-inner {
  position: absolute;
  inset: 0;
  transform-origin: top left;
  pointer-events: none;
}
.sar-fs-item .sar-fs-num {
  display: block;
  font-size: 10px;
  color: #8a8a8a;
  margin-top: 3px;
}
.sar-fs-actions { display: flex; gap: 3px; margin-top: 2px; }
.sar-fs-actions button {
  flex: 0 0 auto;
  border: 1px solid #3a3a3a;
  background: #333;
  color: #ccc;
  border-radius: 4px;
  font-size: 10px;
  padding: 1px 6px;
  cursor: pointer;
}
.sar-fs-actions button:hover { border-color: rgba(34, 211, 238, 0.5); color: #22d3ee; }
#sar-slide-sidebar .sar-sidebar-foot {
  border-top: 1px solid #2a2a2a;
  padding: 8px 10px;
  display: flex;
  gap: 6px;
}
#sar-slide-sidebar .sar-sidebar-foot button {
  flex: 1;
  border: 1px solid #3a3a3a;
  background: #333;
  color: #ccc;
  border-radius: 5px;
  font-size: 11px;
  padding: 5px 0;
  cursor: pointer;
}
#sar-slide-sidebar .sar-sidebar-foot button.sar-new {
  border-color: rgba(34, 211, 238, 0.5);
  background: rgba(34, 211, 238, 0.14);
  color: #22d3ee;
  font-weight: 600;
}

/* 对象选中态 + 控件 */
.sar-obj-selected { outline: 2px solid #22d3ee !important; outline-offset: -1px; }
#sar-obj-controls {
  position: fixed;
  z-index: 100001;
  pointer-events: none;
}
.sar-obj-move {
  position: absolute;
  left: -27px;
  top: 4px;
  width: 20px;
  height: 20px;
  background: #22d3ee;
  color: #083344;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 13px;
  cursor: grab;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  pointer-events: auto;
}
.sar-obj-delete {
  position: absolute;
  right: -10px;
  top: -10px;
  width: 18px;
  height: 18px;
  background: #fff;
  color: #ef4444;
  border: 1px solid #fecaca;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  pointer-events: auto;
}
.sar-obj-resize {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 10px;
  height: 10px;
  background: #fff;
  border: 2px solid #22d3ee;
  border-radius: 2px;
  cursor: nwse-resize;
  pointer-events: auto;
}
.sar-snap {
  position: fixed;
  background: #ef4444;
  opacity: 0.85;
  pointer-events: none;
  z-index: 100002;
}
`;
}

/**
 * 编辑器 chrome HTML — Add element 按钮 + 菜单 + 浮动工具栏。
 * 定义为模块级常量，host 端注入与 webview 运行时自建兜底都使用同一份，避免重复维护。
 */
const EDITOR_CHROME_HTML = `
<div id="html-edit-add-btn">+ Add element</div>
<div id="html-edit-add-menu">
  <button type="button" data-add="text">Text</button>
  <button type="button" data-add="image">Image</button>
  <button type="button" data-add="divider">Divider</button>
  <div id="add-image-row" style="display:none; flex-direction:column; gap:4px; margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1);">
    <input type="text" id="add-image-url" placeholder="Image URL..." style="width:100%; padding:5px 8px; border:1px solid rgba(255,255,255,0.12); border-radius:5px; background:rgba(0,0,0,0.3); color:#e0e0e0; font-size:12px; outline:none; box-sizing:border-box;" />
    <button type="button" id="add-image-ok" style="align-self:flex-end; padding:4px 12px; border:none; border-radius:5px; background:#22d3ee; color:#000; font-size:12px; font-weight:600; cursor:pointer;">OK</button>
  </div>
</div>
<div id="html-edit-toolbar" role="toolbar" aria-label="Text format">
  <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><strong>B</strong></button>
  <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><em>I</em></button>
  <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
  <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
  <span class="tb-separator"></span>
  <span class="popover-wrap">
    <button type="button" class="tb-trigger" data-popover="tb-size" title="Font size">Aa &#9662;</button>
    <div class="popover" id="tb-size">
      <button type="button" class="popover-item" data-cmd="fontSize" data-value="1">XS — 10px</button>
      <button type="button" class="popover-item" data-cmd="fontSize" data-value="2">S — 13px</button>
      <button type="button" class="popover-item is-active" data-cmd="fontSize" data-value="3">M — 16px</button>
      <button type="button" class="popover-item" data-cmd="fontSize" data-value="4">L — 18px</button>
      <button type="button" class="popover-item" data-cmd="fontSize" data-value="5">XL — 24px</button>
      <button type="button" class="popover-item" data-cmd="fontSize" data-value="6">XXL — 32px</button>
    </div>
  </span>
  <span class="popover-wrap">
    <button type="button" class="tb-trigger" data-popover="tb-font" title="Font family">Font &#9662;</button>
    <div class="popover" id="tb-font">
      <button type="button" class="popover-item" data-cmd="fontName" data-value="Arial, sans-serif">Arial</button>
      <button type="button" class="popover-item" data-cmd="fontName" data-value="Georgia, serif">Georgia</button>
      <button type="button" class="popover-item" data-cmd="fontName" data-value="'Courier New', monospace">Courier (Mono)</button>
      <button type="button" class="popover-item" data-cmd="fontName" data-value="'Times New Roman', serif">Times</button>
      <button type="button" class="popover-item" data-cmd="fontName" data-value="system-ui, sans-serif">System UI</button>
    </div>
  </span>
  <span class="popover-wrap">
    <button type="button" class="tb-trigger" data-popover="tb-color" title="Text color" style="border-bottom:3px solid #ef4444;">A</button>
    <div class="popover" id="tb-color" style="padding:8px;">
      <span class="color-grid">
        <span class="color-swatch" data-cmd="foreColor" data-value="#000000" style="background:#000000" title="Black"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#ffffff" style="background:#ffffff" title="White"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#ef4444" style="background:#ef4444" title="Red"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#f97316" style="background:#f97316" title="Orange"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#eab308" style="background:#eab308" title="Yellow"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#22c55e" style="background:#22c55e" title="Green"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#06b6d4" style="background:#06b6d4" title="Cyan"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#3b82f6" style="background:#3b82f6" title="Blue"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#8b5cf6" style="background:#8b5cf6" title="Purple"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#ec4899" style="background:#ec4899" title="Pink"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#6b7280" style="background:#6b7280" title="Gray"></span>
        <span class="color-swatch" data-cmd="foreColor" data-value="#a855f7" style="background:#a855f7" title="Violet"></span>
      </span>
    </div>
  </span>
  <span class="tb-separator"></span>
  <button type="button" data-cmd="justifyLeft" title="Align left">&#8676;</button>
  <button type="button" data-cmd="justifyCenter" title="Align center">&#8801;</button>
  <button type="button" data-cmd="justifyRight" title="Align right">&#8677;</button>
  <span class="tb-separator"></span>
  <button type="button" data-cmd="insertUnorderedList" title="Bullet list">&#8226;</button>
  <button type="button" data-cmd="insertOrderedList" title="Numbered list">1.</button>
  <span class="tb-separator"></span>
  <span class="popover-wrap">
    <button type="button" class="tb-trigger" data-popover="tb-link" title="Insert link">&#128279;</button>
    <div class="input-popover" id="tb-link">
      <input type="text" placeholder="https://example.com" />
      <button type="button" data-cmd="createLink">OK</button>
    </div>
  </span>
  <span class="popover-wrap">
    <button type="button" class="tb-trigger" data-popover="tb-image" title="Insert image">&#128247;</button>
    <div class="input-popover" id="tb-image">
      <input type="text" placeholder="https://example.com/img.png" />
      <button type="button" data-cmd="insertImage">OK</button>
    </div>
  </span>
  <span class="tb-separator"></span>
  <button type="button" id="tb-undo" title="Undo (Ctrl+Z)">&#8617;</button>
  <button type="button" id="tb-redo" title="Redo (Ctrl+Y)">&#8618;</button>
  <span class="tb-separator"></span>
  <button type="button" id="tb-save" class="tb-save-btn" title="Save">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    <span>保存</span>
  </button>
</div>
<div id="sar-deck-hover">
  <div class="sar-hover-row">
    <button type="button" class="sar-active" data-sar-act="edit">Edit</button>
    <button type="button" data-sar-act="pages">Pages</button>
    <span class="sar-sep"></span>
    <button type="button" id="sar-save">&#128190; Save</button>
    <button type="button" class="sar-primary" data-sar-act="add">+ Add</button>
  </div>
  <div class="sar-hover-row">
    <button type="button" id="sar-undo" disabled>&#8617; Undo</button>
    <button type="button" id="sar-redo" disabled>&#8618; Redo</button>
    <span class="sar-sep"></span>
    <button type="button" data-sar-align="left" title="Align left">&#8676;</button>
    <button type="button" data-sar-align="hcenter" title="Align center (H)">&#8660;</button>
    <button type="button" data-sar-align="right" title="Align right">&#8677;</button>
    <span class="sar-sep"></span>
    <button type="button" data-sar-align="top" title="Align top">&#8672;</button>
    <button type="button" data-sar-align="vcenter" title="Align center (V)">&#8657;</button>
    <button type="button" data-sar-align="bottom" title="Align bottom">&#8674;</button>
    <span class="sar-sep"></span>
    <button type="button" id="sar-done">Done</button>
  </div>
</div>
<div id="sar-slide-sidebar">
  <div class="sar-sidebar-head">SLIDES</div>
  <div class="sar-filmstrip" id="sar-filmstrip"></div>
  <div class="sar-sidebar-foot">
    <button type="button" id="sar-export">Export</button>
    <button type="button" class="sar-new" id="sar-new-page">+ New Page</button>
  </div>
</div>
`;

function getEditorChromeHtml(): string {
	return EDITOR_CHROME_HTML;
}

/**
 * 编辑器运行时 JS — contentEditable + 点击元素显示工具栏。
 * 运行时自带 chrome（若 host 未注入则自建），并对所有 DOM 查询做 null 兜底，
 * 避免任一元素缺失导致整个 IIFE 抛出而中断。
 */
function getEditorJs(): string {
	return `
(function () {
  'use strict';

  // chrome 兜底：若 host 未注入编辑器 chrome，则运行时自建，保证工具栏始终可用
  var CHROME_HTML = \`${EDITOR_CHROME_HTML}\`;

  var toolbar = null;
  var addBtn = null;
  var addMenu = null;
  var editMode = false;
  var savedHtml = '';
  var toolbarHideTimer = null;
  var savedRange = null;
  var syncTimer = null;
  var formObserver = null;
  var boundFormElements = [];
  var vscodeApi = null;
  // ===== Slide/Deck 对象级编辑状态 =====
  var deckSlides = null;      // slide 元素数组
  var selectedObj = null;     // 主选中对象（控件/拖拽定位绑定）
  var selectedObjs = [];      // 多选集合（Ctrl+click）
  var historyStack = { undo: [], redo: [] };
  var snapEl = null;
  var objectSeq = 0;
  try { vscodeApi = acquireVsCodeApi(); } catch (e) { log('acquireVsCodeApi failed: ' + e); }

  function log(m) { try { console.log('[EditRuntime] ' + m); } catch (e) {} }

  function ensureChrome() {
    if (document.getElementById('html-edit-toolbar')) return;
    try {
      var holder = document.createElement('div');
      holder.innerHTML = CHROME_HTML;
      while (holder.firstChild) { document.body.appendChild(holder.firstChild); }
      log('ensureChrome: built chrome dynamically');
    } catch (e) { log('ensureChrome FAILED: ' + e); }
  }

  function init() {
    if (!document.body) { log('init aborted: no body'); return; }
    ensureChrome();
    toolbar = document.getElementById('html-edit-toolbar');
    addBtn = document.getElementById('html-edit-add-btn');
    addMenu = document.getElementById('html-edit-add-menu');
    if (!toolbar) { log('init: toolbar missing after ensureChrome, aborting'); return; }
    log('init done, body.children.length=' + document.body.children.length);

  function saveSelection() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    if (savedRange) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }

  function bindFormInputs() {
    if (formObserver) return; // already bound
    boundFormElements = [];

    // 为单个表单控件绑定 input/change 事件，实时同步值到 attribute
    function bindOne(el) {
      if (el.dataset.noPersist || boundFormElements.indexOf(el) >= 0) return;
      boundFormElements.push(el);

      var handler = function () {
        if (!editMode) return;
        var tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'input') {
          var type = (el.type || 'text').toLowerCase();
          if (type === 'checkbox' || type === 'radio') {
            if (el.checked) el.setAttribute('checked', '');
            else el.removeAttribute('checked');
          } else {
            el.setAttribute('value', el.value);
          }
        } else if (tag === 'textarea') {
          el.textContent = el.value;
        } else if (tag === 'select') {
          var opts = el.querySelectorAll('option');
          for (var i = 0; i < opts.length; i++) {
            if (opts[i].selected) opts[i].setAttribute('selected', '');
            else opts[i].removeAttribute('selected');
          }
        }
      };

      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
      // 存储 handler 引用以便后续清理
      el._formHandler = handler;
    }

    // 绑定已有表单控件
    var inputs = document.body.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i++) { bindOne(inputs[i]); }

    // MutationObserver 捕获动态添加的表单控件
    formObserver = new MutationObserver(function (mutations) {
      for (var mi = 0; mi < mutations.length; mi++) {
        var added = mutations[mi].addedNodes;
        for (var ni = 0; ni < added.length; ni++) {
          var node = added[ni];
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('input, textarea, select')) {
            bindOne(node);
          }
          // 递归查找子节点中的表单控件
          if (node.querySelectorAll) {
            var children = node.querySelectorAll('input, textarea, select');
            for (var ci = 0; ci < children.length; ci++) { bindOne(children[ci]); }
          }
        }
      }
    });
    formObserver.observe(document.body, { childList: true, subtree: true });
    log('bindFormInputs: ' + boundFormElements.length + ' form controls bound');
  }

  function unbindFormInputs() {
    for (var i = 0; i < boundFormElements.length; i++) {
      var el = boundFormElements[i];
      if (el._formHandler) {
        el.removeEventListener('input', el._formHandler);
        el.removeEventListener('change', el._formHandler);
        delete el._formHandler;
      }
    }
    boundFormElements = [];
    if (formObserver) { formObserver.disconnect(); formObserver = null; }
    log('unbindFormInputs: done');
  }

  // ===== Slide/Deck 对象级编辑（双轨编辑：deck 文档走对象编辑，普通页面走全局 contenteditable）=====
  function detectDeck() {
    if (deckSlides) return deckSlides.length > 0 ? deckSlides : null;
    // 选择器覆盖：①滚动堆叠型 ②JS 切换型（如 .deck > .stage > section.slide）
    // ③data-slide 标注型；④带 stage 容器的所有 section.slide
    var slides = document.querySelectorAll(
      'section.slide, [data-slide], [data-slides], .slides-offset > section, .deck > section, .stage > section, [class*="stage"] section.slide, .deck-container section.slide'
    );
    if (slides.length >= 1) {
      deckSlides = Array.prototype.slice.call(slides);
      return deckSlides;
    }
    return null;
  }

  function isDeckDoc() {
    return !!detectDeck();
  }

  // 为 slide 内可编辑对象打唯一标记；文本类对象额外设 contenteditable（对象级，不污染全局）
  function ensureObjectMarkers() {
    var slides = detectDeck();
    if (!slides) return;
    var textTags = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, LI: 1, BLOCKQUOTE: 1, FIGCAPTION: 1 };
    for (var i = 0; i < slides.length; i++) {
      var s = slides[i];
      var candidates = s.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,img,video,button,[data-slide-object],[data-oid],[data-edit-slot]');
      for (var j = 0; j < candidates.length; j++) {
        var el = candidates[j];
        if (!el.getAttribute('data-sar-oid')) {
          el.setAttribute('data-sar-oid', 's' + i + '-o' + (objectSeq++));
        }
        if (textTags[el.tagName]) {
          el.setAttribute('contenteditable', 'true');
          el.setAttribute('data-sar-text-editable', '1');
        }
      }
    }
  }

  function getObjectEl(target) {
    if (!target || !target.closest) return null;
    var el = target.closest('[data-sar-oid]');
    if (!el) return null;
    if (!el.closest('section.slide, [data-slide], .slide')) return null;
    return el;
  }

  function deselectObject() {
    for (var i = 0; i < selectedObjs.length; i++) {
      selectedObjs[i].classList.remove('sar-obj-selected');
    }
    selectedObjs = [];
    selectedObj = null;
    removeObjectControls();
  }

  // additive=true 时按 Ctrl+click 语义 toggle；否则单选
  function selectObject(el, additive) {
    if (additive) {
      toggleSelectObject(el);
      return;
    }
    deselectObject();
    if (!el) return;
    selectedObj = el;
    selectedObjs.push(el);
    el.classList.add('sar-obj-selected');
    ensureObjectControls(el);
  }

  function toggleSelectObject(el) {
    if (!el) return;
    var idx = selectedObjs.indexOf(el);
    if (idx >= 0) {
      el.classList.remove('sar-obj-selected');
      selectedObjs.splice(idx, 1);
      if (selectedObj === el) {
        selectedObj = selectedObjs.length ? selectedObjs[selectedObjs.length - 1] : null;
      }
    } else {
      el.classList.add('sar-obj-selected');
      selectedObjs.push(el);
      selectedObj = el;
    }
    if (selectedObj) { ensureObjectControls(selectedObj); }
    else { removeObjectControls(); }
  }

  function removeObjectControls() {
    var c = document.getElementById('sar-obj-controls');
    if (c) c.remove();
  }

  function ensureObjectControls(el) {
    removeObjectControls();
    var controls = document.createElement('div');
    controls.id = 'sar-obj-controls';
    var move = document.createElement('div');
    move.className = 'sar-obj-move';
    move.textContent = '\u2808';
    move.title = 'Drag';
    var del = document.createElement('div');
    del.className = 'sar-obj-delete';
    del.textContent = '\u00d7';
    del.title = 'Delete';
    var resize = document.createElement('div');
    resize.className = 'sar-obj-resize';
    resize.title = 'Resize';
    controls.appendChild(move);
    controls.appendChild(del);
    controls.appendChild(resize);
    document.body.appendChild(controls);
    positionControls();
    bindDrag(el, move);
    del.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); deleteObject(el); });
    resize.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); startResize(e, el); });
  }

  function positionControls() {
    var controls = document.getElementById('sar-obj-controls');
    if (!controls || !selectedObj) return;
    var r = selectedObj.getBoundingClientRect();
    controls.style.left = r.left + 'px';
    controls.style.top = r.top + 'px';
    controls.style.width = r.width + 'px';
    controls.style.height = r.height + 'px';
  }

  // 把对象转为绝对定位（自由对象化），保持当前视觉位置
  function makeFreeObject(el) {
    if (el.style.position === 'absolute') return;
    var slideEl = el.closest('section.slide, [data-slide], .slide');
    var slideRect = slideEl ? slideEl.getBoundingClientRect() : { left: 0, top: 0 };
    var elRect = el.getBoundingClientRect();
    el.style.position = 'absolute';
    el.style.left = (elRect.left - slideRect.left) + 'px';
    el.style.top = (elRect.top - slideRect.top) + 'px';
    el.style.width = elRect.width + 'px';
    el.style.height = elRect.height + 'px';
    el.style.margin = '0';
  }

  function bindDrag(el, handle) {
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      // 拖拽组：主对象在多选集合中 → 整组移动；否则仅移动自身
      var group = selectedObjs.indexOf(el) >= 0 ? selectedObjs.slice() : [el];
      var slideEl = el.closest('section.slide, [data-slide], .slide');
      var slideRect = slideEl ? slideEl.getBoundingClientRect() : { left: 0, top: 0 };
      var starts = [];
      for (var gi = 0; gi < group.length; gi++) {
        var g = group[gi];
        makeFreeObject(g);
        var gr = g.getBoundingClientRect();
        starts.push({ g: g, left: gr.left - slideRect.left, top: gr.top - slideRect.top });
      }
      var startX = e.clientX;
      var startY = e.clientY;
      var moved = false;
      function onMove(ev) {
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
        for (var si = 0; si < starts.length; si++) {
          starts[si].g.style.left = (starts[si].left + dx) + 'px';
          starts[si].g.style.top = (starts[si].top + dy) + 'px';
        }
        positionControls();
        showSnap(el);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        hideSnap();
        if (moved) {
          var groupCmd = [];
          for (var ci = 0; ci < starts.length; ci++) {
            var s = starts[ci];
            groupCmd.push({ g: s.g, from: { left: s.left, top: s.top }, to: { left: s.g.offsetLeft, top: s.g.offsetTop } });
          }
          pushHistory({ type: 'moveGroup', group: groupCmd });
        }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function startResize(e, el) {
    makeFreeObject(el);
    var startX = e.clientX;
    var startY = e.clientY;
    var origW = el.offsetWidth;
    var origH = el.offsetHeight;
    function onMove(ev) {
      el.style.width = Math.max(20, origW + (ev.clientX - startX)) + 'px';
      el.style.height = Math.max(16, origH + (ev.clientY - startY)) + 'px';
      positionControls();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      pushHistory({ type: 'resize', el: el, from: { w: origW, h: origH }, to: { w: el.offsetWidth, h: el.offsetHeight } });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // 吸附：对象中线对齐 slide 中线（8px 阈值）
  function showSnap(el) {
    hideSnap();
    var deck = el.closest('section.slide, [data-slide], .slide');
    if (!deck) return;
    var dr = deck.getBoundingClientRect();
    var er = el.getBoundingClientRect();
    var cx = er.left + er.width / 2;
    var cy = er.top + er.height / 2;
    var threshold = 8;
    snapEl = document.createElement('div');
    snapEl.className = 'sar-snap';
    if (Math.abs(cx - (dr.left + dr.width / 2)) < threshold) {
      snapEl.style.left = (dr.left + dr.width / 2) + 'px';
      snapEl.style.top = dr.top + 'px';
      snapEl.style.width = '1px';
      snapEl.style.height = dr.height + 'px';
    } else if (Math.abs(cy - (dr.top + dr.height / 2)) < threshold) {
      snapEl.style.left = dr.left + 'px';
      snapEl.style.top = (dr.top + dr.height / 2) + 'px';
      snapEl.style.width = dr.width + 'px';
      snapEl.style.height = '1px';
    } else {
      snapEl.remove();
      snapEl = null;
      return;
    }
    document.body.appendChild(snapEl);
  }
  function hideSnap() { if (snapEl) { snapEl.remove(); snapEl = null; } }

  function deleteObject(el) {
    // 删除组：主对象在多选集合中 → 整组删除；否则仅删除自身
    var group = selectedObjs.indexOf(el) >= 0 ? selectedObjs.slice() : [el];
    var cmds = [];
    for (var i = 0; i < group.length; i++) {
      var g = group[i];
      cmds.push({ type: 'delete', parent: g.parentNode, next: g.nextSibling, el: g });
      g.remove();
    }
    deselectObject();
    pushHistory({ type: 'deleteGroup', cmds: cmds });
    rebuildFilmstrip();
  }

  // slide 模式下 Add element：插入到当前 slide 内并对象化（进入撤销栈）
  function addSlideObject(kind, src) {
    var slides = detectDeck();
    if (!slides) return false;
    var idx = currentSlideIndex();
    var slide = slides[idx];
    var el = null;
    if (kind === 'text') {
      el = document.createElement('p');
      el.textContent = 'New text block';
      el.style.padding = '8px';
    } else if (kind === 'divider') {
      el = document.createElement('hr');
    } else if (kind === 'image') {
      el = document.createElement('img');
      el.src = src || '';
      el.style.maxWidth = '100%';
      el.style.height = 'auto';
    }
    if (!el) return false;
    el.setAttribute('data-sar-oid', 's' + idx + '-o' + (objectSeq++));
    if (kind === 'text') {
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('data-sar-text-editable', '1');
    }
    slide.appendChild(el);
    // 复用 addSlide 命令语义：undo=移除，redo=插入
    pushHistory({ type: 'addSlide', parent: slide, next: null, el: el });
    selectObject(el);
    rebuildFilmstrip();
    return true;
  }

  // 命令栈（撤销/重做）
  function pushHistory(cmd) {
    historyStack.undo.push(cmd);
    if (historyStack.undo.length > 200) historyStack.undo.shift();
    historyStack.redo = [];
    updateUndoRedo();
  }
  function undo() {
    var cmd = historyStack.undo.pop();
    if (!cmd) return;
    historyStack.redo.push(cmd);
    applyCommand(cmd, true);
    updateUndoRedo();
  }
  function redo() {
    var cmd = historyStack.redo.pop();
    if (!cmd) return;
    historyStack.undo.push(cmd);
    applyCommand(cmd, false);
    updateUndoRedo();
  }
  function applyCommand(cmd, isUndo) {
    if (cmd.type === 'move') {
      var p = isUndo ? cmd.from : cmd.to;
      cmd.el.style.left = p.left + 'px';
      cmd.el.style.top = p.top + 'px';
    } else if (cmd.type === 'resize') {
      var r = isUndo ? cmd.from : cmd.to;
      cmd.el.style.width = r.w + 'px';
      cmd.el.style.height = r.h + 'px';
    } else if (cmd.type === 'delete') {
      if (isUndo) { cmd.parent.insertBefore(cmd.el, cmd.next); }
      else { cmd.el.remove(); }
      // delete 命令可能作用于 slide（deleteSlide）或对象（deleteObject），
      // 重置 deck 缓存 + 刷新 filmstrip，二者都无害
      deckSlides = null;
      detectDeck();
      rebuildFilmstrip();
    } else if (cmd.type === 'addSlide') {
      if (isUndo) { cmd.el.remove(); }
      else { cmd.parent.insertBefore(cmd.el, cmd.next); }
      deckSlides = null;
      detectDeck();
      rebuildFilmstrip();
    } else if (cmd.type === 'moveGroup') {
      for (var mi = 0; mi < cmd.group.length; mi++) {
        var m = cmd.group[mi];
        var mp = isUndo ? m.from : m.to;
        m.g.style.left = mp.left + 'px';
        m.g.style.top = mp.top + 'px';
      }
    } else if (cmd.type === 'deleteGroup') {
      for (var di = 0; di < cmd.cmds.length; di++) {
        var dc = cmd.cmds[di];
        if (isUndo) { dc.parent.insertBefore(dc.el, dc.next); }
        else { dc.el.remove(); }
      }
      deckSlides = null;
      detectDeck();
      rebuildFilmstrip();
    } else if (cmd.type === 'reorderSlide') {
      var ref = isUndo ? cmd.beforeMove : cmd.afterMove;
      cmd.el.parentNode.insertBefore(cmd.el, ref);
      deckSlides = null;
      detectDeck();
      rebuildFilmstrip();
    } else if (cmd.type === 'patchObject') {
      for (var pi = 0; pi < cmd.patches.length; pi++) {
        var p = cmd.patches[pi];
        var style = isUndo ? p.before : p.after;
        if (style) { p.el.setAttribute('style', style); }
        else { p.el.removeAttribute('style'); }
      }
    }
  }
  function updateUndoRedo() {
    var u = document.getElementById('sar-undo');
    var r = document.getElementById('sar-redo');
    if (u) u.disabled = historyStack.undo.length === 0;
    if (r) r.disabled = historyStack.redo.length === 0;
  }

  // Pages 侧栏（filmstrip）
  function initSlideChrome() {
    rebuildFilmstrip();
    var saveBtn = document.getElementById('sar-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveContent(); });
    var undoBtn = document.getElementById('sar-undo');
    if (undoBtn) undoBtn.addEventListener('click', undo);
    var redoBtn = document.getElementById('sar-redo');
    if (redoBtn) redoBtn.addEventListener('click', redo);
    var doneBtn = document.getElementById('sar-done');
    if (doneBtn) doneBtn.addEventListener('click', function () { exitEditMode(); });
    var exportBtn = document.getElementById('sar-export');
    if (exportBtn) exportBtn.addEventListener('click', function () { saveContent(); });
    var newBtn = document.getElementById('sar-new-page');
    if (newBtn) newBtn.addEventListener('click', addNewSlide);
    var addActBtn = document.querySelector('#sar-deck-hover [data-sar-act="add"]');
    if (addActBtn && addBtn) addActBtn.addEventListener('click', function () { addMenu.classList.toggle('open'); });
    var pagesBtn = document.querySelector('#sar-deck-hover [data-sar-act="pages"]');
    if (pagesBtn) pagesBtn.addEventListener('click', function () {
      var sidebar = document.getElementById('sar-slide-sidebar');
      if (sidebar) sidebar.classList.toggle('sar-hidden');
    });
    var alignBtns = document.querySelectorAll('#sar-deck-hover [data-sar-align]');
    for (var ai = 0; ai < alignBtns.length; ai++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          alignObjects(btn.getAttribute('data-sar-align'));
        });
      })(alignBtns[ai]);
    }
  }

  function currentSlideIndex() {
    var slides = detectDeck();
    if (!slides) return 0;
    // JS 切换型 deck：优先找 .slide.active；否则用可视距离判定（滚动型）
    var activeIdx = -1;
    for (var ai = 0; ai < slides.length; ai++) {
      if (slides[ai].classList.contains('active') || slides[ai].classList.contains('current')) {
        activeIdx = ai; break;
      }
    }
    if (activeIdx >= 0) return activeIdx;
    var best = 0;
    var bestScore = Infinity;
    for (var i = 0; i < slides.length; i++) {
      var r = slides[i].getBoundingClientRect();
      var d = Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
      if (d < bestScore) { bestScore = d; best = i; }
    }
    return best;
  }

  function goToSlide(idx) {
    var slides = detectDeck();
    if (!slides || !slides[idx]) return;
    // 判定 deck 模型：滚动堆叠型（含 .slides-offset）→ scrollIntoView；
    // JS 切换型（含 .slide.active 或 .stage 容器）→ 切 active class。
    var isScrollModel = !!document.querySelector('.slides-offset');
    if (isScrollModel) {
      slides[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      // JS 切换型：把所有 .slide.active 移除 active，加到目标 slide
      var allActives = document.querySelectorAll('.slide.active');
      for (var ai = 0; ai < allActives.length; ai++) { allActives[ai].classList.remove('active'); }
      slides[idx].classList.add('active');
    }
    setTimeout(rebuildFilmstrip, 400);
  }

  function rebuildFilmstrip() {
    var filmstrip = document.getElementById('sar-filmstrip');
    if (!filmstrip) return;
    filmstrip.innerHTML = '';
    var slides = detectDeck();
    if (!slides) return;
    var current = currentSlideIndex();
    for (var i = 0; i < slides.length; i++) {
      (function (idx) {
        var item = document.createElement('div');
        item.className = 'sar-fs-item';
        item.setAttribute('draggable', 'true');
        var thumb = document.createElement('div');
        thumb.className = 'sar-fs-thumb';
        var inner = document.createElement('div');
        inner.className = 'sar-fs-inner';
        inner.innerHTML = slides[idx].innerHTML;
        var sw = 168;
        var tw = slides[idx].offsetWidth || 760;
        var scale = sw / tw;
        inner.style.width = tw + 'px';
        inner.style.height = (slides[idx].offsetHeight || 428) + 'px';
        inner.style.transform = 'scale(' + scale + ')';
        thumb.appendChild(inner);
        item.appendChild(thumb);
        var num = document.createElement('span');
        num.className = 'sar-fs-num';
        num.textContent = String(idx + 1);
        item.appendChild(num);
        var actions = document.createElement('div');
        actions.className = 'sar-fs-actions';
        var dup = document.createElement('button');
        dup.textContent = 'Dup';
        dup.addEventListener('click', function (e) { e.stopPropagation(); duplicateSlide(idx); });
        var del = document.createElement('button');
        del.textContent = 'Del';
        del.addEventListener('click', function (e) { e.stopPropagation(); deleteSlide(idx); });
        actions.appendChild(dup);
        actions.appendChild(del);
        item.appendChild(actions);
        item.addEventListener('click', function () { goToSlide(idx); });
        item.addEventListener('dragstart', function (e) { item.classList.add('sar-dragging'); e.dataTransfer.setData('text/plain', String(idx)); });
        item.addEventListener('dragend', function () { item.classList.remove('sar-dragging'); });
        item.addEventListener('dragover', function (e) { e.preventDefault(); });
        item.addEventListener('drop', function (e) {
          e.preventDefault();
          var from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (!isNaN(from) && from !== idx) reorderSlides(from, idx);
        });
        filmstrip.appendChild(item);
        if (idx === current) item.classList.add('sar-current');
      })(i);
    }
  }

  function addNewSlide() {
    var slides = detectDeck();
    if (!slides) return;
    var last = slides[slides.length - 1];
    var clone = last.cloneNode(true);
    var olds = clone.querySelectorAll('[data-sar-oid]');
    for (var k = 0; k < olds.length; k++) olds[k].removeAttribute('data-sar-oid');
    var parent = last.parentNode;
    var next = last.nextSibling;
    parent.insertBefore(clone, next);
    deckSlides = null;
    detectDeck();
    rebuildFilmstrip();
    pushHistory({ type: 'addSlide', parent: parent, next: next, el: clone });
  }

  function deleteSlide(idx) {
    var slides = detectDeck();
    if (!slides || slides.length <= 1) return;
    var el = slides[idx];
    var parent = el.parentNode;
    var next = el.nextSibling;
    el.remove();
    deckSlides = null;
    detectDeck();
    rebuildFilmstrip();
    // 复用 delete 命令语义：undo=恢复插入，redo=再次删除
    pushHistory({ type: 'delete', parent: parent, next: next, el: el });
  }

  function duplicateSlide(idx) {
    var slides = detectDeck();
    if (!slides || !slides[idx]) return;
    var clone = slides[idx].cloneNode(true);
    var parent = slides[idx].parentNode;
    var next = slides[idx].nextSibling;
    parent.insertBefore(clone, next);
    deckSlides = null;
    detectDeck();
    rebuildFilmstrip();
    pushHistory({ type: 'addSlide', parent: parent, next: next, el: clone });
  }

  function reorderSlides(from, to) {
    var slides = detectDeck();
    if (!slides) return;
    var el = slides[from];
    var target = slides[to];
    if (!el || !target || from === to) return;
    // 记录移动前后的参考节点（用于撤销恢复位置）
    var beforeMove = el.nextSibling;
    if (from < to) {
      target.parentNode.insertBefore(el, target.nextSibling);
    } else {
      target.parentNode.insertBefore(el, target);
    }
    var afterMove = el.nextSibling;
    deckSlides = null;
    detectDeck();
    rebuildFilmstrip();
    pushHistory({ type: 'reorderSlide', el: el, beforeMove: beforeMove, afterMove: afterMove });
  }

  function enterEditMode() {
    if (!document.body) return;
    console.log('[EditRuntime] enterEditMode called, editMode=' + editMode + ' body.children.length=' + document.body.children.length);
    // 防御性：若 init() 还没运行（极端时序，例如 webview 注入慢），先补 chrome 并绑引用
    if (!document.getElementById('html-edit-toolbar')) {
      ensureChrome();
      toolbar = document.getElementById('html-edit-toolbar');
      addBtn = document.getElementById('html-edit-add-btn');
      addMenu = document.getElementById('html-edit-add-menu');
      log('enterEditMode: late chrome init');
    }
    editMode = true;
    savedHtml = document.body.innerHTML;
    document.body.classList.add('html-edit-mode');
    if (detectDeck()) {
      // deck：对象级编辑，不设全局 contenteditable（避免破坏 slide 布局、误触翻页）
      // 标记 deck 文档，slide chrome（编辑簇 + SLIDES 侧栏）仅此时显示
      document.body.classList.add('html-deck-mode');
      // JS 切换型 deck：保证进入编辑时只有一个 slide active（其它 opacity:0）
      // —— 否则用户 .slide { position:absolute inset:0 } 的 9 个 slide 会全堆在原点
      var hasActive = false;
      var allSlides = document.querySelectorAll('section.slide, [data-slide]');
      for (var hai = 0; hai < allSlides.length; hai++) {
        if (allSlides[hai].classList.contains('active') || allSlides[hai].classList.contains('current')) {
          hasActive = true; break;
        }
      }
      if (!hasActive && allSlides.length > 0) {
        allSlides[0].classList.add('active');
      }
      ensureObjectMarkers();
      initSlideChrome();
    } else {
      // 普通页面：全局 contenteditable
      document.body.contentEditable = 'true';
    }
    // 只对 body 设置 contentEditable，不用 designMode（避免 toolbar 也被设为 editable）
    if (toolbar) toolbar.classList.remove('visible');
    // 绑定表单控件：编辑模式下输入/选择实时更新 attribute
    bindFormInputs();
    console.log('[EditRuntime] enterEditMode done, deck=' + !!detectDeck() + ' body.children.length=' + document.body.children.length + ' contentEditable=' + document.body.contentEditable);
  }

  function exitEditMode() {
    console.log('[EditRuntime] exitEditMode called');
    editMode = false;
    // 解绑表单控件监听
    unbindFormInputs();
    if (!document.body) return;
    document.body.classList.remove('html-edit-mode');
    document.body.classList.remove('html-deck-mode');
    document.body.contentEditable = 'false';
    // 清理对象选中态与对象级 contenteditable
    deselectObject();
    var texts = document.querySelectorAll('[data-sar-text-editable]');
    for (var ti = 0; ti < texts.length; ti++) {
      texts[ti].removeAttribute('contenteditable');
    }
    if (toolbar) toolbar.classList.remove('visible');
    if (addMenu) addMenu.classList.remove('open');
  }

  /** 获取不含编辑器 chrome 以及编辑状态代码的干净 HTML */
  function getCleanHtml() {
    var beforeCount = document.body.children.length;
    var t = document.getElementById('html-edit-toolbar');
    var a = document.getElementById('html-edit-add-btn');
    var m = document.getElementById('html-edit-add-menu');
    var dh = document.getElementById('sar-deck-hover');
    var ss = document.getElementById('sar-slide-sidebar');
    var oc = document.getElementById('sar-obj-controls');
    var snaps = Array.prototype.slice.call(document.querySelectorAll('.sar-snap'));
    var tExists = !!t, aExists = !!a, mExists = !!m;
    if (t) t.remove();
    if (a) a.remove();
    if (m) m.remove();
    if (dh) dh.remove();
    if (ss) ss.remove();
    if (oc) oc.remove();
    snaps.forEach(function(el){ el.remove(); });
    console.log('[EditRuntime] getCleanHtml: removed chrome (t=' + tExists + ' a=' + aExists + ' m=' + mExists + '), body.children before=' + beforeCount + ' afterRemove=' + document.body.children.length);
    // 递归剥离所有 contenteditable 属性和 html-edit-mode 类（可能残留在任意子元素上）
    var allEditable = Array.prototype.slice.call(document.querySelectorAll('[contenteditable],[contentEditable]'));
    var savedEditables = allEditable.map(function(el){ return el.getAttribute('contenteditable'); });
    allEditable.forEach(function(el){ el.removeAttribute('contenteditable'); el.removeAttribute('contentEditable'); });
    // 剥离 slide 对象编辑标记（运行时临时标记，不应持久化到保存的 HTML）
    var sarObjects = Array.prototype.slice.call(document.querySelectorAll('[data-sar-oid]'));
    var savedOids = sarObjects.map(function(el){ return el.getAttribute('data-sar-oid'); });
    sarObjects.forEach(function(el){ el.removeAttribute('data-sar-oid'); });
    var sarTexts = Array.prototype.slice.call(document.querySelectorAll('[data-sar-text-editable]'));
    var savedTextFlags = sarTexts.map(function(el){ return el.getAttribute('data-sar-text-editable'); });
    sarTexts.forEach(function(el){ el.removeAttribute('data-sar-text-editable'); });
    var sarSelected = Array.prototype.slice.call(document.querySelectorAll('.sar-obj-selected'));
    sarSelected.forEach(function(el){ el.classList.remove('sar-obj-selected'); });
    var hadClassEdit = document.body.classList.contains('html-edit-mode');
    if (hadClassEdit) document.body.classList.remove('html-edit-mode');
    var hadClassDeck = document.body.classList.contains('html-deck-mode');
    if (hadClassDeck) document.body.classList.remove('html-deck-mode');
    // 剥离 data-template-edit-mode 属性，防止预览模式下编辑器运行时自动进入编辑
    var hadTemplateEdit = document.documentElement.getAttribute('data-template-edit-mode');
    if (hadTemplateEdit) document.documentElement.removeAttribute('data-template-edit-mode');
    // 剥离编辑器运行时 CSS/JS（标记为 data-editor-runtime），预览模式下不需要这些代码
    var editorRuntimeEls = Array.prototype.slice.call(document.querySelectorAll('[data-editor-runtime]'));
    var editorRuntimeParents = editorRuntimeEls.map(function(el){ return el.parentNode; });
    editorRuntimeEls.forEach(function(el){ el.remove(); });
    console.log('[EditRuntime] getCleanHtml: removed ' + editorRuntimeEls.length + ' editor-runtime element(s)');
    var html = document.documentElement.outerHTML;
    // 恢复编辑状态（仅 chrome DOM，编辑器 CSS/JS 由 host 重新注入）
    allEditable.forEach(function(el, i){ if (savedEditables[i] != null) el.setAttribute('contenteditable', savedEditables[i]); });
    sarObjects.forEach(function(el, i){ if (savedOids[i] != null) el.setAttribute('data-sar-oid', savedOids[i]); });
    sarTexts.forEach(function(el, i){ if (savedTextFlags[i] != null) el.setAttribute('data-sar-text-editable', savedTextFlags[i]); });
    sarSelected.forEach(function(el){ el.classList.add('sar-obj-selected'); });
    if (hadClassEdit) document.body.classList.add('html-edit-mode');
    if (hadClassDeck) document.body.classList.add('html-deck-mode');
    if (hadTemplateEdit) document.documentElement.setAttribute('data-template-edit-mode', hadTemplateEdit);
    if (a) document.body.appendChild(a);
    if (m) document.body.appendChild(m);
    if (t) document.body.appendChild(t);
    if (dh) document.body.appendChild(dh);
    if (ss) document.body.appendChild(ss);
    if (oc) document.body.appendChild(oc);
    console.log('[EditRuntime] getCleanHtml: re-appended chrome, body.children.after=' + document.body.children.length);
    return html;
  }

  function saveContent() {
    console.log('[EditRuntime] saveContent called');
    var prevCe = document.body.contentEditable;
    document.body.contentEditable = 'false';
    var html = getCleanHtml();
    document.body.contentEditable = prevCe;
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'htmlEditor.saveContent', html: html });
    }
  }

  /** 实时同步编辑内容到 host（debounce 500ms） */
  var syncTimer = null;
  function syncContent() {
    if (!editMode) { console.log('[EditRuntime] syncContent skipped (editMode=false)'); return; }
    console.log('[EditRuntime] syncContent: sending htmlEditor.syncContent, body.children.length=' + document.body.children.length);
    var html = getCleanHtml();
    if (vscodeApi) {
      vscodeApi.postMessage({
        type: 'htmlEditor.syncContent',
        html: html
      });
    }
  }

  function showToolbar() {
    if (!toolbar) return;
    console.log('[EditRuntime] showToolbar: editMode=' + editMode + ' body.children=' + document.body.children.length);
    clearTimeout(toolbarHideTimer);
    saveSelection();
    toolbar.classList.add('visible');
    // 定位工具栏到选中元素附近
    // 注意：toolbar 是 position:fixed，直接使用 getBoundingClientRect() 的视口坐标，
    // 不需要加 scrollY/scrollX
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        var top = rect.top - toolbar.offsetHeight - 8;
        if (top < 8) top = rect.bottom + 8;
        var left = rect.left + (rect.width / 2) - (toolbar.offsetWidth / 2);
        left = Math.max(8, Math.min(window.innerWidth - toolbar.offsetWidth - 8, left));
        toolbar.style.top = top + 'px';
        toolbar.style.left = left + 'px';
      }
    }
  }

  function hideToolbar() {
    // 延迟隐藏，让按钮点击有时间生效
    toolbarHideTimer = setTimeout(function () {
      toolbar.classList.remove('visible');
    }, 200);
  }

  function exec(cmd, value) {
    // deck 模式下：无文本选区（未选中文字）时，样式命令作用于选中对象整体
    if (isDeckDoc() && selectedObj && (cmd === 'fontSize' || cmd === 'fontName' || cmd === 'foreColor')) {
      var sel0 = window.getSelection();
      var hasTextSel = sel0 && !sel0.isCollapsed && sel0.anchorNode;
      if (!hasTextSel) {
        applyObjectStyle(cmd, value);
        return;
      }
    }
    document.execCommand(cmd, false, value || null);
    updateButtonStates();
  }

  // 对象级样式：fontSize/fontName/foreColor 直接作用于选中对象（含多选），入撤销栈
  function applyObjectStyle(cmd, value) {
    var group = selectedObjs.length ? selectedObjs.slice() : [selectedObj];
    var patches = [];
    var sizeMap = { '1': '10px', '2': '13px', '3': '16px', '4': '18px', '5': '24px', '6': '32px' };
    for (var i = 0; i < group.length; i++) {
      var el = group[i];
      var before = el.getAttribute('style');
      if (cmd === 'fontSize') {
        el.style.fontSize = sizeMap[value] || value || '16px';
      } else if (cmd === 'fontName') {
        el.style.fontFamily = value;
      } else if (cmd === 'foreColor') {
        el.style.color = value;
      }
      patches.push({ el: el, before: before, after: el.getAttribute('style') });
    }
    pushHistory({ type: 'patchObject', patches: patches });
  }

  // 多选对齐分发：左/右/顶/底/水平居中/垂直居中，作用于选中集合（含单选）
  function alignObjects(mode) {
    var group = selectedObjs.length ? selectedObjs.slice() : (selectedObj ? [selectedObj] : []);
    if (group.length < 1) return;
    // 以每个对象自身的父级 slide 为参照（不同 slide 内的对象各自相对其 slide 对齐）
    var patches = [];
    for (var i = 0; i < group.length; i++) {
      var el = group[i];
      makeFreeObject(el);
      var slideEl = el.closest('section.slide, [data-slide], .slide');
      var sr = slideEl ? slideEl.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      var er = el.getBoundingClientRect();
      var before = el.getAttribute('style');
      var nl = er.left - sr.left;
      var nt = er.top - sr.top;
      if (mode === 'left') { nl = 0; }
      else if (mode === 'right') { nl = sr.width - er.width; }
      else if (mode === 'hcenter') { nl = (sr.width - er.width) / 2; }
      else if (mode === 'top') { nt = 0; }
      else if (mode === 'bottom') { nt = sr.height - er.height; }
      else if (mode === 'vcenter') { nt = (sr.height - er.height) / 2; }
      el.style.left = nl + 'px';
      el.style.top = nt + 'px';
      patches.push({ el: el, before: before, after: el.getAttribute('style') });
    }
    pushHistory({ type: 'patchObject', patches: patches });
    if (selectedObj) positionControls();
  }

  function updateButtonStates() {
    if (!toolbar) return;
    var cmds = ['bold', 'italic', 'underline', 'strikeThrough', 'justifyLeft', 'justifyCenter', 'justifyRight', 'insertUnorderedList', 'insertOrderedList'];
    cmds.forEach(function (cmd) {
      var btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
      if (btn) {
        try {
          if (document.queryCommandState(cmd)) {
            btn.classList.add('is-active');
          } else {
            btn.classList.remove('is-active');
          }
        } catch (e) {}
      }
    });
  }

  // 阻止工具栏内 mousedown 破坏选区（输入框除外，允许聚焦输入）
  toolbar.addEventListener('mousedown', function (e) {
    if (e.target && e.target.tagName && e.target.tagName.toLowerCase() === 'input') return;
    e.preventDefault();
  });

  // 关闭所有 popover / input-popover
  function closeAllPopovers() {
    if (!toolbar) return;
    toolbar.querySelectorAll('.popover, .input-popover').forEach(function (p) { p.classList.remove('open'); });
  }

  // 切换指定 popover
  function togglePopover(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var wasOpen = el.classList.contains('open');
    closeAllPopovers();
    if (!wasOpen) el.classList.add('open');
  }

  // 点击触发器按钮切换对应 popover
  toolbar.querySelectorAll('.tb-trigger').forEach(function (trigger) {
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(toolbarHideTimer);
      togglePopover(trigger.getAttribute('data-popover'));
    });
  });

  // 工具栏内所有带 data-cmd 的元素（格式按钮 / popover-item / color-swatch / input OK）
  toolbar.querySelectorAll('[data-cmd]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(toolbarHideTimer);
      var cmd = el.getAttribute('data-cmd');
      var val = el.getAttribute('data-value');

      // 链接 / 图片：从同 popover 的 input 取值，并恢复选区后执行
      if (cmd === 'createLink' || cmd === 'insertImage') {
        var ip = el.closest('.input-popover');
        var input = ip ? ip.querySelector('input') : null;
        var v = input ? input.value.trim() : '';
        if (v) {
          restoreSelection();
          exec(cmd, v);
          if (ip) ip.classList.remove('open');
        }
        return;
      }

      // 恢复 contentEditable 选区后再执行命令（解决 popover 点击导致选区丢失）
      restoreSelection();

      if (val) {
        exec(cmd, val);
      } else {
        exec(cmd);
      }

      // 关闭所属 popover（fontSize / fontName / foreColor）
      var pop = el.closest('.popover');
      if (pop) pop.classList.remove('open');
    });
  });

  // 点击工具栏外部关闭所有 popover
  document.addEventListener('click', function (e) {
    if (!editMode) return;
    if (e.target.closest && e.target.closest('.popover-wrap')) return;
    if (toolbar.contains(e.target)) return;
    closeAllPopovers();
  });

  var undoBtn = document.getElementById('tb-undo');
  if (undoBtn) undoBtn.addEventListener('click', function () { exec('undo'); });

  var redoBtn = document.getElementById('tb-redo');
  if (redoBtn) redoBtn.addEventListener('click', function () { exec('redo'); });

  var saveBtn = document.getElementById('tb-save');
  if (saveBtn) saveBtn.addEventListener('click', function (e) {
    e.preventDefault();
    saveContent();
  });

  // Add element 按钮
  if (addBtn) {
    addBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      addMenu.classList.toggle('open');
    });
  }
  if (addMenu) {
    addMenu.querySelectorAll('button[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var kind = btn.getAttribute('data-add');
        if (kind === 'text') {
          addMenu.classList.remove('open');
          // slide 模式：插入到当前 slide 并对象化；普通模式：追加到 body
          if (!addSlideObject('text')) {
            var el = document.createElement('p');
            el.textContent = 'New text block';
            el.style.padding = '8px';
            document.body.appendChild(el);
          }
        } else if (kind === 'image') {
          var row = document.getElementById('add-image-row');
          if (row) {
            var showing = (row.style.display !== 'none');
            row.style.display = showing ? 'none' : 'flex';
            if (!showing) {
              var inp = document.getElementById('add-image-url');
              if (inp) inp.focus();
            }
          }
        } else if (kind === 'divider') {
          addMenu.classList.remove('open');
          if (!addSlideObject('divider')) {
            document.body.appendChild(document.createElement('hr'));
          }
        }
      });
    });

    var addImageOk = document.getElementById('add-image-ok');
    if (addImageOk) {
      addImageOk.addEventListener('click', function (e) {
        e.preventDefault();
        var inp = document.getElementById('add-image-url');
        var src = inp ? inp.value.trim() : '';
        if (src) {
          // slide 模式：插入到当前 slide 并对象化；普通模式：追加到 body
          if (!addSlideObject('image', src)) {
            var img = document.createElement('img');
            img.src = src;
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            document.body.appendChild(img);
          }
        }
        if (inp) inp.value = '';
        var row = document.getElementById('add-image-row');
        if (row) row.style.display = 'none';
        addMenu.classList.remove('open');
      });
    }

    // 点击外部关闭菜单
    document.addEventListener('click', function (e) {
      if (!addMenu.classList.contains('open')) return;
      if (addMenu.contains(e.target) || (addBtn && addBtn.contains(e.target))) return;
      addMenu.classList.remove('open');
      var row = document.getElementById('add-image-row');
      if (row) row.style.display = 'none';
    });
  }

  // 点击元素时显示工具栏
  document.addEventListener('selectionchange', function () {
    if (!editMode) return;
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      showToolbar();
    }
    updateButtonStates();
  });

  // 光标在元素内时也显示工具栏
  document.addEventListener('click', function (e) {
    if (!editMode) return;
    // 点击工具栏内部不处理
    if (toolbar.contains(e.target)) return;
    if (addBtn && addBtn.contains(e.target)) return;
    if (addMenu && addMenu.contains(e.target)) return;
    // 延迟显示，等 selection 更新
    setTimeout(function () {
      var sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        var node = sel.anchorNode;
        if (node && node.nodeType === 3) node = node.parentElement;
        if (node && node !== document.body) {
          showToolbar();
        }
      }
    }, 10);
  });

  // 鼠标离开工具栏时延迟隐藏
  toolbar.addEventListener('mouseleave', hideToolbar);
  toolbar.addEventListener('mouseenter', function () { clearTimeout(toolbarHideTimer); });

  document.addEventListener('keydown', function (e) {
    if (!editMode) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) exec('redo'); else exec('undo'); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); exec('redo'); return; }
  });

  // ── 编辑态翻页拦截：编辑 PPT/幻灯片 HTML 时，避免点击/滚轮/方向键误触翻页 ──
  // isDeckDoc() 已在 slide 模块中定义（复用 detectDeck，带缓存），此处不再重复声明。
  // 判定点击目标是否属于编辑器 chrome（工具栏/新增按钮/新增菜单/slide chrome）
  function isEditChrome(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('#html-edit-toolbar, #html-edit-add-btn, #html-edit-add-menu, #sar-deck-hover, #sar-slide-sidebar, #sar-obj-controls');
  }
  // 键盘翻页键：编辑态 + deck 下，capture 阶段 stopPropagation 阻断 deck 翻页脚本。
  // 仅 stopPropagation、不 preventDefault——保留 contenteditable 的原生光标移动/空格输入。
  document.addEventListener('keydown', function (e) {
    if (!editMode) return;
    if (!isDeckDoc()) return;
    var k = e.key;
    var isNav = k === ' ' || k === 'PageUp' || k === 'PageDown' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight';
    if (isNav) e.stopPropagation();
  }, true);
  // 滚轮翻页：编辑态 + deck 下禁用（deck 本身无滚动，wheel 仅翻页；普通页面不拦截、保留滚动查看）
  window.addEventListener('wheel', function (e) {
    if (!editMode) return;
    if (!isDeckDoc()) return;
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true, passive: false });
  // 点击翻页：编辑态 + deck 下，阻断 deck 的「点击翻页」脚本。
  // 编辑器 chrome / 表单 / 链接放行；其余（文本对象、空白背景）点击：
  //   1) 手动触发工具栏显示（因 stopPropagation 阻断了原有的冒泡 showToolbar 逻辑）；
  //   2) stopPropagation 阻断 deck 脚本翻页。contenteditable 光标放置是浏览器默认行为，不受影响。
  document.addEventListener('click', function (e) {
    if (!editMode) return;
    if (!isDeckDoc()) return;
    var el = e.target;
    if (isEditChrome(el)) return;
    if (el && el.closest && el.closest('input, textarea, select, a[href]')) return;
    // 对象选中：点击 slide 内对象 → 选中并显示控件；Ctrl+点击 → toggle 多选；点击空白 → 取消选中
    var objEl = getObjectEl(el);
    var additive = !!(e.ctrlKey || e.metaKey);
    if (objEl) {
      selectObject(objEl, additive);
    } else {
      deselectObject();
    }
    setTimeout(function () {
      var sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        var node = sel.anchorNode;
        if (node && node.nodeType === 3) node = node.parentElement;
        if (node && node !== document.body) showToolbar();
      }
    }, 10);
    if (addMenu) addMenu.classList.remove('open');
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // 实时同步编辑内容到 host（input 事件触发，debounce 500ms）
  document.body.addEventListener('input', function () {
    console.log('[EditRuntime] input event fired, editMode=' + editMode);
    if (!editMode) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncContent, 500);
  });

  // Enter edit mode ONLY when host signals edit context (has data-template-edit-mode attribute).
  // DO NOT auto-enter — the editor runtime may load in preview mode when the saved HTML
  // was written from edit mode (the runtime JS/CSS gets persisted to disk).
  if (document.documentElement.getAttribute('data-template-edit-mode') === 'slots') {
    enterEditMode();
  }

  // Listen for host messages
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;
    console.log('[EditRuntime] received host message: type=' + msg.type);
    if (msg.type === 'htmlEditor.enterEditMode') {
      enterEditMode();
    } else if (msg.type === 'htmlEditor.exitEditMode') {
      exitEditMode();
    } else if (msg.type === 'htmlEditor.saveContent') {
      saveContent();
    }
  });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;
}
