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
	const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: vscode-resource: vscode-webview-resource: vscode-webview:; script-src 'unsafe-inline' 'unsafe-eval' https: vscode-resource: vscode-webview-resource: vscode-webview:; img-src 'self' data: https: vscode-resource: vscode-webview-resource: vscode-webview:; font-src data: https: vscode-resource: vscode-webview-resource: vscode-webview:; connect-src https: vscode-resource: vscode-webview-resource: vscode-webview:; frame-src https: vscode-webview:;">`;

	const editorCss = getEditorCss();
	const editorHtml = getEditorChromeHtml();
	const editorJs = getEditorJs();

	// 检查原始 HTML 是否已有 <head>
	const lower = rawHtml.toLowerCase();
	const headIdx = lower.indexOf('<head>');

	// 构建编辑器 chrome + 运行时注入块
	const injection = `${csp}\n    <style>\n${editorCss}\n    </style>`;

	let result: string;

	if (headIdx >= 0) {
		// 在 <head> 后注入 CSS
		const insertPos = headIdx + '<head>'.length;
		const withCss = rawHtml.slice(0, insertPos) + injection + rawHtml.slice(insertPos);

		// 在 </body> 前注入 chrome HTML + JS
		const bodyCloseIdx = withCss.toLowerCase().lastIndexOf('</body>');
		if (bodyCloseIdx >= 0) {
			result = withCss.slice(0, bodyCloseIdx) + editorHtml + '\n<script>\n' + editorJs + '\n</script>\n' + withCss.slice(bodyCloseIdx);
		} else {
			result = withCss + editorHtml + '\n<script>\n' + editorJs + '\n</script>\n';
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
					result = result.slice(0, bodyCloseIdx) + editorHtml + '\n<script>\n' + editorJs + '\n</script>\n' + result.slice(bodyCloseIdx);
				} else {
					result += editorHtml + '\n<script>\n' + editorJs + '\n</script>\n';
				}
			} else {
				result = `<!doctype html><html><head>${injection}</head><body>${rawHtml}${editorHtml}<script>${editorJs}</script></body></html>`;
			}
		} else {
			// Fragment: wrap into a full document
			result = `<!doctype html><html><head>${injection}</head><body>${rawHtml}${editorHtml}<script>${editorJs}</script></body></html>`;
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

  function enterEditMode() {
    if (!document.body) return;
    console.log('[EditRuntime] enterEditMode called, editMode=' + editMode + ' body.children.length=' + document.body.children.length);
    editMode = true;
    savedHtml = document.body.innerHTML;
    document.body.classList.add('html-edit-mode');
    document.body.contentEditable = 'true';
    // 只对 body 设置 contentEditable，不用 designMode（避免 toolbar 也被设为 editable）
    if (toolbar) toolbar.classList.remove('visible');
    console.log('[EditRuntime] enterEditMode done, body.children.length=' + document.body.children.length + ' contentEditable=' + document.body.contentEditable);
  }

  function exitEditMode() {
    console.log('[EditRuntime] exitEditMode called');
    editMode = false;
    if (!document.body) return;
    document.body.classList.remove('html-edit-mode');
    document.body.contentEditable = 'false';
    if (toolbar) toolbar.classList.remove('visible');
    if (addMenu) addMenu.classList.remove('open');
  }

  /** 获取不含编辑器 chrome 的干净 HTML，不改变 contentEditable 状态 */
  function getCleanHtml() {
    var beforeCount = document.body.children.length;
    var t = document.getElementById('html-edit-toolbar');
    var a = document.getElementById('html-edit-add-btn');
    var m = document.getElementById('html-edit-add-menu');
    var tExists = !!t, aExists = !!a, mExists = !!m;
    if (t) t.remove();
    if (a) a.remove();
    if (m) m.remove();
    console.log('[EditRuntime] getCleanHtml: removed chrome (t=' + tExists + ' a=' + aExists + ' m=' + mExists + '), body.children before=' + beforeCount + ' afterRemove=' + document.body.children.length);
    var html = document.documentElement.outerHTML;
    if (a) document.body.appendChild(a);
    if (m) document.body.appendChild(m);
    if (t) document.body.appendChild(t);
    console.log('[EditRuntime] getCleanHtml: re-appended chrome, body.children.after=' + document.body.children.length);
    return html;
  }

  function saveContent() {
    console.log('[EditRuntime] saveContent called');
    document.body.contentEditable = 'false';
    var html = getCleanHtml();
    document.body.contentEditable = 'true';
    if (window.acquireVsCodeApi) {
      var vscode = window.acquireVsCodeApi();
      vscode.postMessage({ type: 'htmlEditor.saveContent', html: html });
    }
  }

  /** 实时同步编辑内容到 host（debounce 500ms） */
  var syncTimer = null;
  function syncContent() {
    if (!editMode) { console.log('[EditRuntime] syncContent skipped (editMode=false)'); return; }
    console.log('[EditRuntime] syncContent: sending htmlEditor.syncContent, body.children.length=' + document.body.children.length);
    var html = getCleanHtml();
    if (window.acquireVsCodeApi) {
      window.acquireVsCodeApi().postMessage({
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
    document.execCommand(cmd, false, value || null);
    updateButtonStates();
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
          var el = document.createElement('p');
          el.textContent = 'New text block';
          el.style.padding = '8px';
          document.body.appendChild(el);
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
          document.body.appendChild(document.createElement('hr'));
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
          var img = document.createElement('img');
          img.src = src;
          img.style.maxWidth = '100%';
          img.style.height = 'auto';
          document.body.appendChild(img);
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
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveContent(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) exec('redo'); else exec('undo'); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); exec('redo'); return; }
  });

  // 实时同步编辑内容到 host（input 事件触发，debounce 500ms）
  document.body.addEventListener('input', function () {
    console.log('[EditRuntime] input event fired, editMode=' + editMode);
    if (!editMode) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncContent, 500);
  });

  // Enter edit mode automatically
  enterEditMode();

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
