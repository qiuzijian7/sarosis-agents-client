// @vssaros/dsh-pele — 图表渲染（Mermaid → SVG）：随包内置 pele 渲染器 + 一个 `render_diagram` 工具。
//
// 定位（2026-10-19）：**本项目所有 Mermaid 图表的唯一渲染引擎**。
//   · dsh 侧：本插件的 `render_diagram` 工具（校验 / 量尺寸 / 可选返回 SVG）；
//   · IDE 侧：渲染进程读同一份 `assets/pele.global.js`（`peleDiagramRenderer.ts`），
//     聊天卡片、```mermaid 代码块、知识库笔记、`.mermaid` 文件预览全部走它。
// ⇒ 换引擎只换 `assets/` 里那一个文件，两处一起变（不存在"两个渲染器"）。
//
// 为什么不再用 mermaid（原方案是"隐藏 webview + mermaid 12"）：
//   · pele 是**同步、纯字符串、零 DOM 依赖**的（内置字宽表测文本）⇒ 不需要 webview、
//     不需要 20s/30s 超时、不需要先 `npm run build-chat-webview` 才有图（那个 bundle 缺了就整片空白 ✗）；
//   · 颜色全是 CSS 变量 ⇒ 主题只是换一组变量，重绘都不用。
//
// 不导出 `inject`：本模块没有**必需**依赖（`ctx.tools` 可缺）⇒ 任何 profile 都能激活 ✓。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { renderDiagram } from './core/render.js';
import { themeNames } from './core/theme.js';

export const name = 'vssaros-pele';

const TOOL_NAME = 'render_diagram';

/**
 * 把渲染好的 SVG 落到盘上。
 *
 * ★ 2026-10-19：dsh 聊天页**不渲染** mermaid/drawio（运行时里 `mermaid` 只出现在 Shiki 的高亮
 *   语言表里），而官方留的 `conversation.chat.node` 是"按 ChatNodeKind 整体替换消息渲染器"
 *   ——为了一张图去重写整条 markdown 渲染不划算 ✗。
 *   ⇒ 走官方**交付卡**范式：`present` 工具的文档模型工作流就是「先建文件，再调 present」
 *      （`present` 在 standard / ptc / cordis 三个 preset 里都挂着）。
 *   所以本工具只负责**把 .svg 落盘**，回路径；「调 present 交付给用户」由模型接着做 ✓。
 *
 * ⚠ 为什么不让工具自己去调 present：那需要 `ctx.sessionProjections` +
 *   `session.append('deliverables/presented', …)`（dsh 内部投影语义），写错形状会直接
 *   弄坏交付卡 ✗，而本机没法起真实会话验证 ⇒ 不冒这个险。
 *
 * @returns 写盘后的绝对路径；失败时返回 `{ error }`（调用方把错误原样带回给模型）
 */
function saveSvg(rawPath, svg) {
	const target = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '';
	if (!target) { return { error: 'saveTo 为空' }; }
	try {
		// 相对路径按 **Host 进程 cwd** 解析；拿不准就传绝对路径（模型的系统提示里有工作区路径 ✓）
		const abs = isAbsolute(target) ? target : resolve(process.cwd(), target);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, svg, 'utf8');
		return { path: abs };
	} catch (err) {
		return { error: `写盘失败：${err instanceof Error ? err.message : String(err)}` };
	}
}

export function apply(ctx, config = {}) {
	// ── 审批闸（2026-10-20，补）──────────────────────────────────────────────
	// 为什么必须有：`render_diagram` 的 `saveTo` 会**落盘**（`saveSvg` → mkdirSync + writeFileSync，
	//   路径由模型给，相对路径按 Host cwd 解析）⇒ 与 kanban / kb 的写属同一档，官方派发前必须问用户。
	// 契约（`dsh-tools` 的 `tools/pre-execute` waterfall）：返回 `{ kind: 'ask' }` ⇒ 只有审批服务回
	//   `allowed-once` 才执行；**没有审批支持的部署会把 ask 变成拒绝**（fail-closed ✓，正是想要的）。
	// ⚠ 只在**真要落盘**时问：不传 `saveTo` 的纯校验/取 SVG 不打扰用户
	//   （每次都弹窗的话这个工具就没法用了 ✗）。参数键是 `exec.arguments`（`ToolExecutionInput`）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (!exec || exec.name !== TOOL_NAME) {
			return next();
		}
		const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
		const saveTo = typeof args.saveTo === 'string' ? args.saveTo.trim() : '';
		if (!saveTo) {
			return next();
		}
		return {
			kind: 'ask',
			reason: `${TOOL_NAME} 会把 SVG 写入 ${saveTo}（模型指定的路径）`,
			displayReason: {
				en: `Allow ${TOOL_NAME} to write an SVG file to "${saveTo}"?`,
				zh: `允许 ${TOOL_NAME} 把 SVG 写到 ${saveTo}？`,
			},
		};
	}));

	ctx.inject(['tools'], tools => {
		const definition = {
			name: TOOL_NAME,
			description: [
				'把 Mermaid 源码渲染成 SVG（pele 引擎，覆盖 Mermaid 12.1.0 的全部图种：flowchart / sequence / class / state / er / gantt / pie / mindmap / timeline / c4 / quadrant / sankey / architecture 等）。',
				'用途一**校验**：输出图之前先调一次，语法/语义错误会带回具体成因与改法，别把画不出来的图直接给用户。',
				'用途二**取成品**：',
				'  · `saveTo=<路径>` ⇒ 把 SVG **写盘**并返回路径。**想让用户在聊天里看到这张图就用它**：',
				'    写完立刻再调一次 `present`（files:[{path}]）把它标为交付物 ⇒ 聊天里出现交付卡 ✓',
				'    （dsh 聊天页本身不渲染 mermaid 围栏，只认交付文件 —— 这是它的官方范式）。',
				'  · `includeSvg=true` ⇒ 直接回传 SVG 字符串（自己写文件/嵌网页时用）。',
				'默认只回图种、宽高、链接数与字符数（SVG 通常上万字符，白占上下文）。',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					source: { type: 'string', description: 'Mermaid 源码（不要带 ``` 代码围栏）' },
					theme: { type: 'string', enum: themeNames(), description: '配色预设：default=浅色 / dark=深色（默认 default）' },
					includeSvg: { type: 'boolean', description: '是否一并返回 SVG 字符串（默认 false）' },
					saveTo: { type: 'string', description: '把 SVG 写到这个路径（.svg）。相对路径按工作目录解析；要给绝对路径最稳。写完请再调 present 交付' },
					maxWidth: { type: 'integer', description: '宿主可用宽度（px）；超过这个宽度的图会自动改为纵向排布（默认不限）' },
				},
				required: ['source'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' }, type: { type: 'string' },
						width: { type: 'number' }, height: { type: 'number' },
						links: { type: 'number' }, svgChars: { type: 'number' },
						theme: { type: 'string' }, svg: { type: 'string' },
						savedTo: { type: 'string' }, saveError: { type: 'string' },
						code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' },
					},
					required: ['ok'],
				},
				render: (_args, value) => {
					if (!value.ok) {
						return [{ type: 'text', text: `画不出来（${value.code}）：${value.message}\n${value.hint ?? ''}`.trim() }];
					}
					const lines = [`${value.type}：${value.width}×${value.height}`];
					if (value.links) { lines.push(`链接 ${value.links} 个`); }
					lines.push(`SVG ${value.svgChars} 字符（${value.theme}）`);
					if (value.saveError) {
						// 写盘失败必须**喊出来**：不喊的话模型会以为图已经落好、接着调 present 撞一个不存在的文件 ✗
						lines.push(`⚠ 写盘失败：${value.saveError}`);
						return [{ type: 'text', text: lines.join('；') }];
					}
					if (value.savedTo) {
						lines.push(`已写到 ${value.savedTo}`);
						lines.push('下一步：调 present（files:[{path}]）把它交付给用户 ⇒ 聊天里出现交付卡 ✓');
						return [{ type: 'text', text: lines.join('；') }];
					}
					if (!value.svg) { lines.push('（SVG 未回传：要拿成品请带 includeSvg=true 或 saveTo=<路径>）'); }
					return [{ type: 'text', text: lines.join('；') }];
				},
			},
			isConcurrencySafe: () => true,
			execute: async (params) => {
				const source = typeof params?.source === 'string' ? params.source : '';
				const theme = params?.theme === 'dark' ? 'dark' : 'default';
				const options = {
					theme,
					...(Number.isInteger(params?.maxWidth) && params.maxWidth > 0 ? { maxWidth: params.maxWidth } : {}),
				};
				const rendered = renderDiagram(source, options);
				if (!rendered.ok) {
					// 失败面只留机器可比的三件套（dsh 校验器拒绝 undefined ⇒ 缺的键直接不出现 ✓）
					return { ok: false, code: rendered.code, message: rendered.message, hint: rendered.hint };
				}
				// ① 落盘（`saveTo`）—— dsh 聊天里想让用户看到图就走这条（写完由模型调 present 交付 ✓）
				if (typeof params?.saveTo === 'string' && params.saveTo.trim()) {
					const saved = saveSvg(params.saveTo, rendered.svg);
					const base = { ok: true, type: rendered.type, width: rendered.width, height: rendered.height, links: rendered.links, theme: rendered.theme, svgChars: rendered.svgChars };
					return saved.path ? { ...base, savedTo: saved.path } : { ...base, saveError: saved.error };
				}
				// ② 回传 SVG 字符串（调用方自己处理）
				if (params?.includeSvg === true) { return rendered; }
				// 默认不回传 SVG：上万的字符进上下文只会挤掉有用的东西 ⇒ 只留"画出来了、多大"这层事实。
				return { ok: true, type: rendered.type, width: rendered.width, height: rendered.height, links: rendered.links, theme: rendered.theme, svgChars: rendered.svgChars };
			},
		};
		tools.tools.register(definition);
	});
}
