/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 同步前「图表准备」—— 把笔记里的图表源码/嵌入转成 PNG 并改写引用（编排层，2026-09-24 抽出）。
 *
 * ## 为什么必须做
 *
 * 飞书 **不渲染 drawio 源码**（```drawio / ```xml<mxfile> 只当代码块显示），且飞书
 * **图片不支持 SVG**（实测：`file is not a supported BMP, GIF, JPEG, PNG, TIFF, or WebP image`）
 * ⇒ 不转换的话，同步过去只能看到一堆源码。转换后正文变成 `![[xxx.png]]`，
 * 走的是**已实测可用**的图片插入链路 ⇒ 飞书里显示为真正的图。
 *
 * ★★ 2026-09-24（用户要求「用飞书兼容格式，不要转 PNG」）：
 *   **mermaid 已从「转 PNG」名单移除** —— 飞书 markdown 导入会把 ```mermaid 围栏转成
 *   `whiteboard type="mermaid"` **画板**（原生「文本绘图」活图，可编辑；官方帮助
 *   《使用文本绘图小组件》同源能力，实测缩略图确认为真实图表）⇒ 转 PNG 反而把活图变死图。
 *   `![[x.mermaid]]` 嵌入同样改为**内联展开成围栏**（不落 PNG）。
 *   ⇒ 现在只有 **drawio / canvas** 需要转 PNG（飞书无对应格式）。
 *
 * ## 为什么抽成共享函数
 *
 * 这一步原本只长在「知识库视图 → 同步飞书」按钮里（`knowledgeBaseView` 的私有方法），
 * agent 走 `kb_feishu_sync` 工具时**不触发** ⇒ 图表源码原样同步到飞书。
 * 抽到这里后**按钮与工具共用同一份口径**（收集范围、两条管线的先后、失败语义都只有一处），
 * 不会出现第二套实现漂移。
 *
 * ## 两种模式
 *
 * · `dryRun: true`  —— **零副作用**：只静态统计笔记里有多少图表（不渲染、不写盘）。
 *                      供 dry-run 预览如实告诉用户「apply 时会转换 N 张图」；
 * · `dryRun: false` —— 真渲染：drawio / canvas → SVG → PNG → 落盘 + 改写引用，
 *                      mermaid 内联为围栏（沿用两条管线的既有语义）。
 *
 * ## 安全性
 *
 * · 只有**确实含图表**的笔记会被改动（无图表的笔记一个字节都不动）；
 * · 单篇失败 ⇒ 记入结果、**继续**处理其余笔记（不中断整批）；
 * · 依赖全部注入（渲染器 / 栅格化 / fileService）⇒ 与两条管线一样可 mock，便于单测。
 */

import { URI } from '../../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { extractDiagramBlocks } from './diagramBlocks.js';
import { extractDiagramEmbeds, renderNoteDiagramEmbeds } from './diagramEmbedPipeline.js';
import { renderNoteDiagrams } from './diagramRenderPipeline.js';
import { extractHtmlEmbeds, prepareHtmlAttachmentsForNote } from './htmlAttachmentPrepare.js';

/**
 * 兜底扫描范围：`srcDirs` 留空时用。
 *
 * ★ 2026-09-24：改为只含「笔记」—— 同步范围恒为「笔记」区内的映射目录
 * （见 `feishuSyncCore.deriveMappedSrcDirs`），「库」是素材层、永不参与同步。
 * 正常调用方（视图按钮 / `kb_feishu_sync` 工具）都会显式传入推导结果，这里只是防御性兜底。
 */
export const DEFAULT_DIAGRAM_SRC_DIRS: readonly string[] = ['笔记'];

/** 收集上限（防御性：极端大的 vault 不至于把同步拖死）。 */
const MAX_FILES = 20000;

export interface IDiagramPrepareFileResult {
	/** 笔记文件名（日志 / 回显用） */
	readonly name: string;
	readonly noteUri: URI;
	/** 将/已转成 PNG 的图表数（drawio / canvas） */
	readonly charts: number;
	/** 内联展开为 ```mermaid 围栏的数量（飞书转画板，不落 PNG）★ 2026-09-24 */
	readonly inlined: number;
	/** 将/已复制进附件的 HTML 数（飞书以 file block + Preview 渲染）★ 2026-09-24 */
	readonly attachments: number;
	/** 失败数（已保留源码，不丢内容） */
	readonly failures: number;
	/** 笔记内容是否被改动（dryRun 恒为 false） */
	readonly changed: boolean;
	/** 人话摘要（与两条管线的 message 口径一致） */
	readonly message: string;
}

export interface IDiagramPrepareResult {
	/** 扫描到的 markdown 篇数 */
	readonly scanned: number;
	/** 含图表的笔记（按遍历顺序；无图表的不列入） */
	readonly notes: readonly IDiagramPrepareFileResult[];
	/** 将/已转成 PNG 的图表总数（drawio / canvas） */
	readonly charts: number;
	/** 内联为围栏的 mermaid 总数 ★ 2026-09-24 */
	readonly inlined: number;
	/** 复制进附件的 HTML 总数 ★ 2026-09-24 */
	readonly attachments: number;
	/** 失败总数（已保留源码） */
	readonly failures: number;
	/** 内容被改动的笔记数 */
	readonly touched: number;
	/** 本次是否为「只统计不写盘」 */
	readonly dryRun: boolean;
}

/**
 * 「同步」调用方给图表准备的最小入参（不含渲染器等宿主依赖 —— 那些在注入处绑定）。
 * 定义在这里是为了**工具与视图共用同一签名**，避免两处各写一遍回调类型。
 */
export interface IDiagramPrepareRequest {
	readonly vaultRoot: URI;
	/** 库内相对目录（如 `['笔记']`）；空数组 ⇒ 扫描 `库` 与 `笔记` */
	readonly srcDirs: readonly string[];
	/** true = 只统计不写盘（dry-run 预览用） */
	readonly dryRun: boolean;
}

/** 宿主注入的图表准备入口（`kb_feishu_sync` 工具上下文 / 知识库视图使用）。 */
export type KbDiagramPrepareFn = (request: IDiagramPrepareRequest) => Promise<IDiagramPrepareResult>;

export interface IPrepareDiagramsOptions {
	readonly vaultRoot: URI;
	/** 库内相对目录（如 `['笔记']`）；空数组 ⇒ `DEFAULT_DIAGRAM_SRC_DIRS` */
	readonly srcDirs: readonly string[];
	readonly fileService: IFileService;
	/** mermaid 源码 → SVG（通常注入 `IMermaidInlineRenderer.renderToSvg`） */
	readonly renderMermaid: (source: string) => Promise<string>;
	/** drawio 源码 → SVG（通常注入 `IDrawioInlineRenderer.renderToSvg`） */
	readonly renderDrawio: (source: string) => Promise<string>;
	/** SVG → PNG 字节（通常注入 `svgToPng`）。注入以便单测 mock。 */
	readonly rasterize: (svg: string, scale?: number) => Promise<Uint8Array>;
	readonly logService?: ILogService;
	/** true = 只统计图表数量（不渲染、不写盘）；默认 false（真渲染 + 写回） */
	readonly dryRun?: boolean;
	/** 逐条进度回调（视图用它把过程实时打到同步输出；工具侧不需要） */
	readonly onProgress?: (line: string) => void;
}

/**
 * 扫描 `srcDirs` 下的 markdown，把其中的图表转成 PNG 并改写引用（或只统计）。
 *
 * 不抛异常：单篇失败只记日志 + 跳过；调用方（同步流程）永远可以继续。
 */
export async function prepareDiagramsForSync(opts: IPrepareDiagramsOptions): Promise<IDiagramPrepareResult> {
	const dryRun = opts.dryRun === true;
	const roots = (opts.srcDirs.length ? opts.srcDirs : DEFAULT_DIAGRAM_SRC_DIRS)
		.map(d => URI.joinPath(opts.vaultRoot, ...String(d).split('/').filter(Boolean)));

	const files: URI[] = [];
	for (const root of roots) { await collectMarkdown(root, files, opts.fileService); }

	const notes: IDiagramPrepareFileResult[] = [];
	let charts = 0;
	let inlined = 0;
	let attachments = 0;
	let failures = 0;
	let touched = 0;

	for (const file of files) {
		const name = file.path.split('/').filter(Boolean).pop() ?? '';
		let per: IDiagramPrepareFileResult;
		try {
			per = dryRun
				? await countNoteDiagrams(file, name, opts.fileService)
				: await renderNote(file, name, opts);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			opts.logService?.warn(`[KB diagram prepare] ${name}: ${reason}`);
			opts.onProgress?.(`  · ${name}: 图表准备异常 ${reason}\n`);
			continue;
		}
		if (!per.charts && !per.inlined && !per.attachments && !per.failures) { continue; }   // 无图表/附件 ⇒ 不打扰用户
		charts += per.charts;
		inlined += per.inlined;
		attachments += per.attachments;
		failures += per.failures;
		if (per.changed) { touched++; }
		notes.push(per);
		if (per.message) { opts.onProgress?.(`  · ${name}: ${per.message}\n`); }
	}

	return { scanned: files.length, notes, charts, inlined, attachments, failures, touched, dryRun };
}

/** 真渲染：① 围栏代码块，② 图表文件嵌入（顺序不可颠倒，见下）。 */
async function renderNote(noteUri: URI, name: string, opts: IPrepareDiagramsOptions): Promise<IDiagramPrepareFileResult> {
	const renderers = {
		vaultRoot: opts.vaultRoot,
		noteUri,
		fileService: opts.fileService,
		renderMermaid: opts.renderMermaid,
		renderDrawio: opts.renderDrawio,
		rasterize: opts.rasterize,
		logService: opts.logService,
	};
	// ⓪ HTML 附件准备（★ 2026-09-24）：把 `![[x.html]]` 的目标复制进 `<note>.attachments/`
	//    并改写为相对引用 —— 飞书侧才能以 `@./<相对路径>` 上传（绝对/跨目录路径会被判 unsafe）。
	//    放在最前：它是纯文件复制 + 引用改写，与图表两条管线目标不重叠。
	const html = await prepareHtmlAttachmentsForNote({ vaultRoot: opts.vaultRoot, noteUri, fileService: opts.fileService, logService: opts.logService });
	// ① 围栏代码块（```drawio；mermaid 由飞书转画板，已过滤）
	const blocks = await renderNoteDiagrams(renderers);
	// ② 图表文件嵌入（![[x.drawio|.mermaid|.mmd|.canvas]]）—— 必须在 ① 之后：
	//    ① 已写回笔记，② 读的是更新后的内容；两者替换目标不重叠（围栏 vs embed 行）。
	const embeds = await renderNoteDiagramEmbeds(renderers);

	const parts = [blocks, embeds]
		.filter(x => x.rendered.length || x.failures.length || ('inlined' in x && x.inlined.length))
		.map(x => x.message);
	if (html.attachments) {
		parts.push(`复制 ${html.attachments} 个 HTML 附件（飞书 file block + Preview 渲染）`
			+ (html.missing.length ? `，${html.missing.length} 个未找到（保留原文）` : ''));
	}
	return {
		name,
		noteUri,
		charts: blocks.rendered.length + embeds.rendered.length,
		inlined: embeds.inlined.length,
		attachments: html.attachments,
		failures: blocks.failures.length + embeds.failures.length,
		changed: blocks.changed || embeds.changed || html.changed,
		message: parts.join('；'),
	};
}

/** dryRun：只读原文做静态统计（不渲染、不写盘）。 */
async function countNoteDiagrams(noteUri: URI, name: string, fileService: IFileService): Promise<IDiagramPrepareFileResult> {
	const base = { name, noteUri, failures: 0, changed: false };
	let markdown: string;
	try {
		markdown = (await fileService.readFile(noteUri)).value.toString();
	} catch {
		return { ...base, charts: 0, inlined: 0, attachments: 0, message: '' };
	}
	// ★ mermaid 不转 PNG（飞书转画板）⇒ 统计里单独计数，不计入 charts
	const pngBlocks = extractDiagramBlocks(markdown).filter(b => b.kind !== 'mermaid').length;
	const embeds = extractDiagramEmbeds(markdown);
	const charts = pngBlocks + embeds.filter(e => e.kind !== 'mermaid').length;
	const inlined = embeds.filter(e => e.kind === 'mermaid').length;
	// ★ HTML 附件（![[x.html]]）：apply 时会复制进 <note>.attachments/ 并改写引用
	const attachments = extractHtmlEmbeds(markdown).length;
	const parts: string[] = [];
	if (charts) { parts.push(`发现 ${charts} 张图表源码（apply 时转为 PNG）`); }
	if (inlined) { parts.push(`${inlined} 个 mermaid 嵌入（apply 时内联为围栏，飞书转画板）`); }
	if (attachments) { parts.push(`${attachments} 个 HTML 附件（apply 时复制到 .attachments/，飞书以 Preview 渲染）`); }
	return {
		...base,
		charts,
		inlined,
		attachments,
		message: parts.join('；'),
	};
}

/** 递归收集 markdown（`resolve` 失败 / 无子项时静默跳过）。 */
async function collectMarkdown(dir: URI, out: URI[], fileService: IFileService): Promise<void> {
	if (out.length > MAX_FILES) { return; }
	let stat: IFileStat | undefined;
	try { stat = await fileService.resolve(dir); } catch { return; }
	if (!stat?.children) { return; }
	for (const child of stat.children) {
		if (child.isDirectory) { await collectMarkdown(child.resource, out, fileService); }
		else if (/\.(md|markdown)$/i.test(child.name)) { out.push(child.resource); }
	}
}
