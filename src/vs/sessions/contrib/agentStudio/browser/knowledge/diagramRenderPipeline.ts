/*---------------------------------------------------------------------------------------------
 *  笔记里的图表（drawio）→ PNG 附件 → 改写引用（编排层）—— 2026-09-23 建 / 09-24 收窄
 *
 *  这是「图表同步到飞书能正确显示」链路的**编排**：
 *
 *      ```drawio 代码块
 *        → renderToSvg（宿主隐藏 webview：IDrawioInlineRenderer）
 *        → 栅格化为 PNG（渲染进程 canvas，见 svgRasterizer.ts —— **以函数注入**，便于单测）
 *        → 落盘到笔记同级附件目录（`<note>.attachments/chart-<n>.png`）
 *        → 把代码块替换为 `![[…png]]`（独占段落，飞书插图走 block_replace 整块替换）
 *        → 之后交给既有飞书同步（PNG 是已实测可用的格式）
 *
 *  ★★ 2026-09-24：**mermaid 已从本管线移除**（不再转 PNG）—— 飞书 markdown 导入会把
 *  ```mermaid 围栏转成 whiteboard(type="mermaid") 画板（原生「文本绘图」活图，可编辑），
 *  抢转 PNG 会把活图变死图；drawio 飞书无对应格式（只显示代码块）⇒ 只有它需要 PNG。
 *
 *  设计取舍：
 *   · 全部依赖（fileService / 渲染器 / 栅格化）都**注入** ⇒ 本模块可全 mock 单测；
 *   · 单个图表失败**不中断**其它图表（部分成功也写回，失败块保留原源码，不丢内容）；
 *   · 没有图表时**不写盘**（避免每次同步都无意义地改文件 mtime）。
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { extractDiagramBlocks, replaceDiagramBlock, type IDiagramBlock } from './diagramBlocks.js';

export interface IRenderNoteDiagramsOptions {
	vaultRoot: URI;
	/** 目标笔记文件 */
	noteUri: URI;
	fileService: IFileService;
	/**
	 * mermaid 源码 → SVG。
	 * ⚠ 2026-09-24 起**不再被本管线使用**（mermaid 交给飞书转画板，不转 PNG）；
	 *   保留签名仅为兼容既有调用方 / 其它潜在消费者。
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

export interface IRenderedDiagram {
	kind: IDiagramBlock['kind'];
	/** 落盘图片相对**笔记目录**的路径（即写进笔记的 `![[…]]` 内容） */
	relPath: string;
	bytes: number;
}

export interface IRenderNoteDiagramsResult {
	/** 成功转换的图表 */
	rendered: IRenderedDiagram[];
	/** 失败的图表（保留原源码块，不丢内容） */
	failures: Array<{ kind: IDiagramBlock['kind']; reason: string }>;
	/** 笔记内容是否发生变化（没有图表 / 全部失败 ⇒ false） */
	changed: boolean;
	message: string;
}

/** 附件目录名：与笔记同名 + `.attachments`（与既有附件约定一致）。导出供 embed 管线共用（口径必须一致）。 */
export function attachmentsDirName(noteUri: URI): string {
	const base = noteUri.path.split('/').filter(Boolean).pop() ?? 'note';
	return `${base.replace(/\.(md|markdown)$/i, '')}.attachments`;
}

/**
 * 把一篇笔记中的 mermaid / drawio 代码块渲染为 PNG 附件，并把代码块改写为图片引用。
 *
 * ⚠ 逐块替换**必须从后往前**做：替换会改变后续块的偏移量，正序会让区间错位。
 */
export async function renderNoteDiagrams(opts: IRenderNoteDiagramsOptions): Promise<IRenderNoteDiagramsResult> {
	const { noteUri, fileService, rasterize } = opts;
	const writeBack = opts.writeBack !== false;
	const scale = opts.scale && opts.scale > 0 ? opts.scale : 2;

	let markdown: string;
	try {
		markdown = (await fileService.readFile(noteUri)).value.toString();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { rendered: [], failures: [], changed: false, message: `读取笔记失败：${reason}` };
	}

	// ★★ 2026-09-24（用户要求「飞书兼容格式，不转 PNG」+ 探针实测）：
	//   ```mermaid 围栏**不再转 PNG** —— 飞书 markdown 导入（lark-cli `docs +create/+update
	//   --doc-format markdown`）会把它转成 **whiteboard(type="mermaid") 画板**（飞书原生
	//   「文本绘图」，可编辑的活图；官方帮助《使用文本绘图小组件》同源能力）⇒ 抢转 PNG
	//   反而把活图变成死图。drawio 飞书无对应格式（只会显示为代码块）⇒ 仍转 PNG。
	const blocks = extractDiagramBlocks(markdown).filter(b => b.kind !== 'mermaid');
	if (blocks.length === 0) {
		return { rendered: [], failures: [], changed: false, message: '笔记中没有需要转换的图表代码块（mermaid 由飞书转画板，跳过）。' };
	}

	const assetsDir = URI.joinPath(noteUri, '..', attachmentsDirName(noteUri));
	let out = markdown;
	const rendered: IRenderedDiagram[] = [];
	const failures: Array<{ kind: IDiagramBlock['kind']; reason: string }> = [];

	// 从后往前：替换只影响其后的偏移，倒序可保证前面的区间仍然有效
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		try {
			// mermaid 已在上方过滤（交给飞书转画板）⇒ 走到这里的只可能是 drawio
			const svg = await opts.renderDrawio(block.source);
			if (!svg || !svg.trim()) { throw new Error('渲染得到空 SVG'); }

			const png = await rasterize(svg, scale);
			if (!png || png.byteLength === 0) { throw new Error('栅格化得到空 PNG'); }

			const fileName = `chart-${i + 1}.png`;
			try { await fileService.createFolder(assetsDir); } catch { /* 已存在 */ }
			await fileService.writeFile(URI.joinPath(assetsDir, fileName), VSBuffer.wrap(png));

			const relPath = `${attachmentsDirName(noteUri)}/${fileName}`;
			out = replaceDiagramBlock(out, block, relPath);
			rendered.push({ kind: block.kind, relPath, bytes: png.byteLength });
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			opts.logService?.warn(`[KB diagrams] ${block.kind} 转换失败（保留源码）：${reason}`);
			failures.push({ kind: block.kind, reason });
		}
	}

	// ⚠ 上面是**倒序**遍历（保证替换偏移有效）⇒ 这里把结果转回原文顺序，
	// 否则调用方拿到的 `rendered` / `failures` 顺序是反的，日志与 UI 都会看着别扭。
	rendered.reverse();
	failures.reverse();

	const changed = rendered.length > 0;
	if (changed && writeBack) {
		try {
			await fileService.writeFile(noteUri, VSBuffer.fromString(out));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				rendered: [], failures: [...failures, { kind: 'mermaid', reason: `写回笔记失败：${reason}` }],
				changed: false, message: `图片已生成但写回笔记失败：${reason}`,
			};
		}
	}

	const parts = [`转换 ${rendered.length} 个图表为 PNG`];
	if (failures.length) { parts.push(`${failures.length} 个失败（保留源码）`); }
	if (changed && !writeBack) { parts.push('（演练模式，未写回笔记）'); }
	return { rendered, failures, changed, message: `${parts.join('，')}。` };
}
