/**
 * 自动生成 —— 请勿手改。改图标清单请编辑 scripts/build-codicon-subset.py 后重跑。
 *
 * codicon 子集（25 个字形）以 woff2 + base64 内联，供知识库 dsh 页面（/x/kb/）自用。
 * 目的：dsh 自托管页不在 VS Code 的 DOM 里、拿不到 codicon 字体 ⇒ 把字形随包带来，
 * 让页面的文件/目录/箭头/动作图标与原资料库（IDE 侧 kbView）逐字一致。
 *
 * 许可：vscode-codicons 0.0.46-0 —— MIT and Creative Commons Attribution 4.0
 *      （口径照抄本仓 ThirdPartyNotices.txt:3062）。字体侧 CC BY 4.0 带署名义务，
 *      随包分发时本注释即为署名载体，勿删。
 * 来源字体：src/vs/base/browser/ui/codicons/codicon/codicon.ttf
 * 码位来源：src/vs/base/common/codiconsLibrary.ts
 */
export const CODICON_SUBSET_NAMES = ['file', 'folder', 'folder-opened', 'chevron-right', 'chevron-down', 'new-file', 'new-folder', 'trash', 'pencil', 'search', 'close', 'book', 'note', 'tag', 'check', 'ellipsis', 'refresh', 'gear', 'graph', 'type-hierarchy', 'list-tree', 'sort-precedence', 'add', 'clock', 'cloud-upload'];

export const CODICON_FONT_CSS = `@font-face{font-family:"vsaros-codicon";src:url(data:font/woff2;base64,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) format("woff2");font-display:block}
.dsh-cod{font:normal normal normal 16px/1 vsaros-codicon;display:inline-block;text-decoration:none;text-rendering:auto;text-align:center;text-transform:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;user-select:none;-webkit-user-select:none}
.dsh-cod-file::before{content:"\\ea7b"}
.dsh-cod-folder::before{content:"\\ea83"}
.dsh-cod-folder-opened::before{content:"\\eaf7"}
.dsh-cod-chevron-right::before{content:"\\eab6"}
.dsh-cod-chevron-down::before{content:"\\eab4"}
.dsh-cod-new-file::before{content:"\\ea7f"}
.dsh-cod-new-folder::before{content:"\\ea80"}
.dsh-cod-trash::before{content:"\\ea81"}
.dsh-cod-pencil::before{content:"\\ea73"}
.dsh-cod-search::before{content:"\\ea6d"}
.dsh-cod-close::before{content:"\\ea76"}
.dsh-cod-book::before{content:"\\eaa4"}
.dsh-cod-note::before{content:"\\eb26"}
.dsh-cod-tag::before{content:"\\ea66"}
.dsh-cod-check::before{content:"\\eab2"}
.dsh-cod-ellipsis::before{content:"\\ea7c"}
.dsh-cod-refresh::before{content:"\\eb37"}
.dsh-cod-gear::before{content:"\\eaf8"}
.dsh-cod-graph::before{content:"\\eb03"}
.dsh-cod-type-hierarchy::before{content:"\\ebb9"}
.dsh-cod-list-tree::before{content:"\\eb86"}
.dsh-cod-sort-precedence::before{content:"\\eb55"}
.dsh-cod-add::before{content:"\\ea60"}
.dsh-cod-clock::before{content:"\\ea82"}
.dsh-cod-cloud-upload::before{content:"\\eac3"}`;

/**
 * 渲染一枚图标（服务端拼 HTML 用）。
 * ⚠ 返回的 span 是**空元素**，字形由 ::before 的 content 给出 ⇒ 不要往里塞文本。
 */
export function codicon(name) {
	return '<span class="dsh-cod dsh-cod-' + name + '" aria-hidden="true"></span>';
}
