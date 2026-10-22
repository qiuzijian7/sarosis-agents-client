/*
 * 生成 `lib/core/icons.js`（agent 图标表）—— **只在需要换/加图标时跑一次**，产物提交进仓。
 *
 * 为什么这么做（而不是运行时从 CDN 取）：
 *   · dsh 页跑在本地 WebContentsView 里，离线/内网是常态 ⇒ 图标必须有**内联**一份；
 *   · 一次性生成 = 构建可复现，也方便审 license（Lucide 是 ISC，头注释带上出处与许可）。
 *
 * 用法：
 *   node dsh-plugins/vssaros-agents/scripts/gen-icons.mjs            # 用默认候选表
 *   node ... --version 0.460.0                                      # 指定 lucide-static 版本
 *   node ... --out ../lib/core/icons.js
 *
 * 数据源：https://unpkg.com/lucide-static@<ver>/icons/<name>.svg（每个文件自带 @license 注释）
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
	const i = argv.indexOf(flag);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const VERSION = argOf('--version', '0.460.0');
const OUT = resolve(HERE, argOf('--out', '../lib/core/icons.js'));

/** 候选图标（覆盖面优先；取不到的自动跳过并列出）。名字用 lucide 的 kebab-case。 */
const CANDIDATES = [
	// 身份 / 角色
	'bot', 'bot-message-square', 'user-round', 'users', 'user-cog', 'contact', 'smile', 'venetian-mask',
	// 智能 / 创意
	'sparkles', 'wand-sparkles', 'brain', 'brain-circuit', 'lightbulb', 'compass', 'target', 'crosshair',
	// 代码 / 工程
	'code', 'code-xml', 'terminal', 'square-terminal', 'bug', 'wrench', 'hammer', 'git-branch', 'git-merge', 'git-pull-request',
	// 数据 / 后端
	'database', 'server', 'cpu', 'hard-drive', 'cloud', 'network', 'workflow', 'route', 'share-2', 'plug',
	// 文件 / 文档
	'file-text', 'files', 'folder-open', 'book-open', 'notebook-pen', 'clipboard-list', 'list-checks', 'layers', 'package', 'box',
	// 检索 / 分析
	'search', 'scan-search', 'microscope', 'flask-conical', 'chart-line', 'chart-column', 'chart-pie', 'gauge', 'activity',
	// 安全 / 权限
	'shield', 'shield-check', 'lock', 'key-round', 'eye', 'fingerprint', 'file-badge',
	// 沟通 / 协作
	'mail', 'message-square', 'messages-square', 'phone', 'send', 'radio', 'megaphone',
	// 时间 / 计划
	'calendar', 'clock', 'timer', 'list-todo', 'kanban',
	// 表现 / 设计
	'palette', 'pen-tool', 'pencil-ruler', 'presentation', 'image', 'video', 'music',
	// 其他常用
	'rocket', 'zap', 'flame', 'star', 'heart', 'globe', 'languages', 'cog', 'settings-2', 'sliders-horizontal',
	'filter', 'bookmark', 'tag', 'flag', 'circle-check', 'triangle-alert', 'info', 'circle-help', 'life-buoy', 'scale',
];

const fetchSvg = async (name) => {
	const url = `https://unpkg.com/lucide-static@${VERSION}/icons/${name}.svg`;
	const res = await fetch(url);
	if (!res.ok) {
		return { name, error: `HTTP ${res.status}` };
	}
	const text = await res.text();
	const inner = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(text)?.[1] ?? '';
	const body = inner
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\s*\n\s*/g, ' ')
		.replace(/>\s+</g, '><')
		.trim();
	if (!body) {
		return { name, error: 'empty svg' };
	}
	return { name, body };
};

const ok = [];
const failed = [];
for (const name of CANDIDATES) {
	const result = await fetchSvg(name);
	if (result.error) {
		failed.push(`${name} (${result.error})`);
	} else {
		ok.push(result);
	}
}

const lines = ok
	.sort((a, b) => a.name.localeCompare(b.name))
	.map(({ name, body }) => `\t'${name}': ${JSON.stringify(body)},`);

const file = `// @vssaros/dsh-agents — agent 图标表（**自动生成，别手改**）。
//
// 生成：node dsh-plugins/vssaros-agents/scripts/gen-icons.mjs
// 数据源：Lucide v${VERSION} — https://lucide.dev
// 许可：ISC（见下方 LICENSE 段；图标内联在仓里，运行时不联网、不引 CDN）。
//
// 用法：\`.agent.md\` 的 \`icon:\` 字段写 \`lucide:<name>\`（如 \`lucide:bot\`）；
// 老数据里直接写 emoji 的继续按 emoji 渲染（见 \`core/icons.js\` 的 \`parseIconValue\`）。
//
/*
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
OF THIS SOFTWARE.
*/

/** 生成时使用的 lucide 版本（换版本要重跑生成器）。 */
export const ICON_SET_VERSION = '${VERSION}';

/** 图标集元信息（页面展示/license 页用）。 */
export const ICON_SET = { id: 'lucide', name: 'Lucide', license: 'ISC', version: '${VERSION}', url: 'https://lucide.dev' };

/** name → SVG 内部片段（24×24 viewBox，stroke 由外层给）。 */
export const ICON_PATHS = {
${lines.join('\n')}
};

/** 全部图标名（页面图标选择器用；已排序）。 */
export const ICON_NAMES = Object.keys(ICON_PATHS);
`;

await writeFile(OUT, file, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`icons: ${ok.length} 个（失败 ${failed.length}）`);
if (failed.length) {
	console.log(`失败：\n  ${failed.join('\n  ')}`);
}
