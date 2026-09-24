/*---------------------------------------------------------------------------------------------
 *  diagramEmbedPipeline.ts — 笔记里的图表文件嵌入 `![[x.drawio|.mermaid|.mmd|.canvas]]`
 *  → PNG 附件 → 改写引用（编排层）—— 2026-09-24
 *
 *  背景：webview 预览侧已能把这三类嵌入渲染成图（DiagramEmbedComponent），但飞书
 *  markdown 导入不认识 `![[x.drawio]]`（原样显示为文本，kbFeishuSyncScript 有测试锁定
 *  这一现状）⇒ 同步前必须**预转换**：
 *
 *      ![[架构图.drawio]]
 *        → 解析目标文件（相对笔记目录 → 相对 vault 根 → 全库按文件名搜）
 *        → 读源文本 → SVG（mermaid/drawio 走宿主渲染服务；canvas 走纯函数 canvasToSvg）
 *        → 栅格化 PNG（注入，通常是 svgToPng）→ 落盘 `<note>.attachments/embed-<n>.png`
 *        → 把 embed 改写为 `![[…embed-n.png]]`（独占段落）
 *        → 之后交给既有飞书图片链路（PNG 已实测可用）
 *
 *  与 diagramRenderPipeline（围栏代码块版）刻意并列：那管 ```mermaid 代码块，本管 ![[文件]] 嵌入。
 *  同样的取舍：依赖全注入（可单测）；单个失败保留原文、不中断其它；无嵌入不写盘。
 *
 *  ⚠ 只转换**独占段落**的 embed（该行去除空白后恰好是 `![[...]]`）：与 webview 预览的
 *    提升规则一致，且飞书插图走 block_replace 整块替换，行内 embed 本就无法插图。
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { attachmentsDirName } from './diagramRenderPipeline.js';
import { canvasToSvg } from './canvasToSvg.js';

export type DiagramEmbedKind = 'mermaid' | 'drawio' | 'canvas';

export interface IDiagramEmbed {
	kind: DiagramEmbedKind;
	/** `![[...]]` 里的原始目标（可能含路径/别名） */
	target: string;
	/** 整行（独占段落的 embed 行）在原文中的区间 `[start, end)`（含行尾换行） */
	start: number;
	end: number;
}

const EMBED_LINE_RE = /^[ \t]*!\[\[([^\]\n]+?)\]\][ \t]*$/;

function embedKindOf(target: string): DiagramEmbedKind | undefined {
	const base = target.split(/[|#]/)[0].trim().toLowerCase();
	if (base.endsWith('.mermaid') || base.endsWith('.mmd')) { return 'mermaid'; }
	if (base.endsWith('.drawio')) { return 'drawio'; }
	if (base.endsWith('.canvas')) { return 'canvas'; }
	return undefined;
}

/**
 * 提取 markdown 中所有**独占段落**的图表文件 embed（跳过围栏代码块内部）。
 * 行内 embed（夹杂在文字中）不转换 —— 预览侧也只对独占段落的 embed 提升渲染，口径一致。
 */
export function extractDiagramEmbeds(markdown: string): IDiagramEmbed[] {
	const out: IDiagramEmbed[] = [];
	if (!markdown) { return out; }
	const lines = markdown.split('\n');
	let offset = 0;
	let fence: { char: string; len: number } | undefined;
	for (const line of lines) {
		const start = offset;
		offset += line.length + 1; // +1 = 被 split 掉的 \n
		const fenceMatch = /^[ \t]*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			const char = fenceMatch[1][0];
			const len = fenceMatch[1].length;
			if (!fence) { fence = { char, len }; }
			else if (char === fence.char && len >= fence.len) { fence = undefined; }
			continue;
		}
		if (fence) { continue; }
		const m = EMBED_LINE_RE.exec(line);
		if (!m) { continue; }
		const kind = embedKindOf(m[1]);
		if (!kind) { continue; }
		out.push({ kind, target: m[1].trim(), start, end: offset });
	}
	return out;
}

/** 递归按文件名（basename，大小写不敏感）在 vault 的 库/笔记 下找文件（带条目上限）。 */
async function findByBasename(fileService: IFileService, dir: URI, basename: string, budget: { left: number }): Promise<URI | undefined> {
	if (budget.left <= 0) { return undefined; }
	let stat;
	try { stat = await fileService.resolve(dir); } catch { return undefined; }
	if (!stat?.children) { return undefined; }
	for (const c of stat.children) {
		budget.left--;
		if (c.isDirectory) {
			const hit = await findByBasename(fileService, c.resource, basename, budget);
			if (hit) { return hit; }
		} else if (c.name.toLowerCase() === basename) {
			return c.resource;
		}
	}
	return undefined;
}

/**
 * 解析 embed 目标到实际文件：相对笔记目录 → 相对 vault 根 → 全库按文件名搜。
 * （与预览侧 resolveWikilink 的「路径形 / 裸文件名」两模式对齐。）
 */
export async function resolveEmbedTarget(
	fileService: IFileService, vaultRoot: URI, noteUri: URI, target: string,
): Promise<URI | undefined> {
	const cleaned = target.split(/[|#]/)[0].trim();
	if (!cleaned) { return undefined; }
	const direct = [
		URI.joinPath(noteUri, '..', cleaned),
		URI.joinPath(vaultRoot, cleaned),
	];
	for (const c of direct) {
		try {
			const s = await fileService.resolve(c);
			if (s && !s.isDirectory) { return c; }
		} catch { /* 继续下一个候选 */ }
	}
	const basename = (cleaned.split(/[\\/]/).pop() ?? cleaned).toLowerCase();
	const budget = { left: 20000 };
	for (const section of ['库', '笔记']) {
		const hit = await findByBasename(fileService, URI.joinPath(vaultRoot, section), basename, budget);
		if (hit) { return hit; }
	}
	return undefined;
}

export interface IRenderNoteDiagramEmbedsOptions {
	vaultRoot: URI;
	noteUri: URI;
	fileService: IFileService;
	/**
	 * mermaid 源码 → SVG。
	 * ⚠ 2026-09-24 起**不再被使用**：mermaid embed 改为内联展开成围栏（飞书转画板活图）。
	 *   保留签名仅为兼容既有调用方。
	 */
	renderMermaid?: (source: string) => Promise<string>;
	/** drawio 源码 → SVG（通常注入 `IDrawioInlineRenderer.renderToSvg`） */
	renderDrawio: (source: string) => Promise<string>;
	/** SVG → PNG 字节（通常注入 `svgToPng`）。注入以便单测 mock。 */
	rasterize: (svg: string, scale?: number) => Promise<Uint8Array>;
	logService?: ILogService;
	/** 清晰度倍率，默认 2 */
	scale?: number;
	/** 是否真的写回笔记（false = 只演练，用于 dry-run 预览） */
	writeBack?: boolean;
}

export interface IRenderedEmbed {
	kind: DiagramEmbedKind;
	target: string;
	/** 落盘图片相对**笔记目录**的路径（即写进笔记的 `![[…]]` 内容） */
	relPath: string;
	bytes: number;
}

export interface IInlinedEmbed {
	kind: 'mermaid';
	target: string;
	/** 展开后的围栏内容长度（便于日志/断言） */
	chars: number;
}

export interface IRenderNoteDiagramEmbedsResult {
	rendered: IRenderedEmbed[];
	/**
	 * 内联展开为 ```mermaid 围栏的嵌入（★ 2026-09-24）：飞书 markdown 导入会把 mermaid 围栏
	 * 转成 whiteboard(type="mermaid") 画板（原生活图）⇒ mermaid embed 不落 PNG，改为内联展开。
	 */
	inlined: IInlinedEmbed[];
	/** 失败的嵌入（保留原 embed 文本，不丢内容） */
	failures: Array<{ kind: DiagramEmbedKind; target: string; reason: string }>;
	changed: boolean;
	message: string;
}

/** 把某段区间替换为**独占段落**的新内容（两侧空行规范化，与既有替换函数同口径）。 */
function replaceEmbedRangeWith(markdown: string, embed: IDiagramEmbed, replacement: string): string {
	const before = markdown.slice(0, embed.start).replace(/\n+$/, '');
	const after = markdown.slice(embed.end).replace(/^\n+/, '');
	const head = before.length ? `${before}\n\n` : '';
	const tail = after.length ? `\n\n${after}` : '\n';
	return `${head}${replacement}${tail}`;
}

/** 与 replaceDiagramBlock 同一口径：替换为**独占段落**的图片引用。 */
function replaceEmbedRange(markdown: string, embed: IDiagramEmbed, imageRelPath: string): string {
	return replaceEmbedRangeWith(markdown, embed, `![[${imageRelPath}]]`);
}

/** mermaid embed → 独占段落的 ```mermaid 围栏（飞书导入时自动转成画板活图）。 */
function mermaidFence(source: string): string {
	const body = source.replace(/\s+$/, '');
	return `\`\`\`mermaid\n${body}\n\`\`\``;
}

/**
 * 把一篇笔记中的图表文件 embed 渲染为 PNG 附件并改写引用。
 *
 * ⚠ 逐个替换**必须从后往前**：替换会改变后续区间偏移，正序会错位（与 renderNoteDiagrams 同理）。
 */
export async function renderNoteDiagramEmbeds(opts: IRenderNoteDiagramEmbedsOptions): Promise<IRenderNoteDiagramEmbedsResult> {
	const { noteUri, fileService, rasterize } = opts;
	const writeBack = opts.writeBack !== false;
	const scale = opts.scale && opts.scale > 0 ? opts.scale : 2;

	let markdown: string;
	try {
		markdown = (await fileService.readFile(noteUri)).value.toString();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { rendered: [], inlined: [], failures: [], changed: false, message: `读取笔记失败：${reason}` };
	}

	const embeds = extractDiagramEmbeds(markdown);
	if (embeds.length === 0) {
		return { rendered: [], inlined: [], failures: [], changed: false, message: '笔记中没有需要转换的图表文件嵌入。' };
	}

	const assetsDirName = attachmentsDirName(noteUri);
	const assetsDir = URI.joinPath(noteUri, '..', assetsDirName);
	let out = markdown;
	const rendered: IRenderedEmbed[] = [];
	const inlined: IInlinedEmbed[] = [];
	const failures: Array<{ kind: DiagramEmbedKind; target: string; reason: string }> = [];
	let pngIndex = 0;

	for (let i = embeds.length - 1; i >= 0; i--) {
		const embed = embeds[i];
		try {
			const targetUri = await resolveEmbedTarget(fileService, opts.vaultRoot, noteUri, embed.target);
			if (!targetUri) { throw new Error(`找不到目标文件「${embed.target}」`); }
			const source = (await fileService.readFile(targetUri)).value.toString();
			if (!source.trim()) { throw new Error('目标文件为空'); }

			// ★ 2026-09-24：mermaid **不转 PNG** —— 内联展开为 ```mermaid 围栏，交给飞书导入
			//   转成 whiteboard(type="mermaid") 画板（原生活图，可编辑）。
			if (embed.kind === 'mermaid') {
				out = replaceEmbedRangeWith(out, embed, mermaidFence(source));
				inlined.push({ kind: 'mermaid', target: embed.target, chars: source.length });
				continue;
			}

			const svg = embed.kind === 'canvas' ? canvasToSvg(source) : await opts.renderDrawio(source);
			if (!svg || !svg.trim()) { throw new Error('渲染得到空 SVG'); }

			const png = await rasterize(svg, scale);
			if (!png || png.byteLength === 0) { throw new Error('栅格化得到空 PNG'); }

			const fileName = `embed-${++pngIndex}.png`;
			try { await fileService.createFolder(assetsDir); } catch { /* 已存在 */ }
			await fileService.writeFile(URI.joinPath(assetsDir, fileName), VSBuffer.wrap(png));

			const relPath = `${assetsDirName}/${fileName}`;
			out = replaceEmbedRange(out, embed, relPath);
			rendered.push({ kind: embed.kind, target: embed.target, relPath, bytes: png.byteLength });
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			opts.logService?.warn(`[KB diagram embeds] ${embed.kind} 嵌入转换失败（保留原文）：${embed.target} —— ${reason}`);
			failures.push({ kind: embed.kind, target: embed.target, reason });
		}
	}

	// 倒序遍历（保证替换偏移有效）⇒ 结果转回原文顺序
	rendered.reverse();
	inlined.reverse();
	failures.reverse();

	const changed = rendered.length > 0 || inlined.length > 0;
	if (changed && writeBack) {
		try {
			await fileService.writeFile(noteUri, VSBuffer.fromString(out));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				rendered: [], inlined: [], failures: [...failures, { kind: 'mermaid', target: '-', reason: `写回笔记失败：${reason}` }],
				changed: false, message: `图片已生成但写回笔记失败：${reason}`,
			};
		}
	}

	const parts: string[] = [];
	if (rendered.length) { parts.push(`转换 ${rendered.length} 个图表嵌入为 PNG`); }
	if (inlined.length) { parts.push(`${inlined.length} 个 mermaid 嵌入内联为围栏（飞书转画板）`); }
	if (!parts.length) { parts.push('无需转换'); }
	if (failures.length) { parts.push(`${failures.length} 个失败（保留原文）`); }
	if (changed && !writeBack) { parts.push('（演练模式，未写回笔记）'); }
	return { rendered, inlined, failures, changed, message: `${parts.join('，')}。` };
}
