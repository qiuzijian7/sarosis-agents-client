/*---------------------------------------------------------------------------------------------
 *  htmlAttachmentPrepare.ts — 同步前「HTML 附件准备」（2026-09-24 新增）
 *
 *  ## 为什么需要
 *
 *  飞书**支持把 HTML 文件作为附件渲染**（实测：`<source path="@./x.html"/>` 上传后落成
 *  `<figure view-type="Preview"><source mime="text/html" …/></figure>` —— file block + Preview
 *  视图，飞书直接渲染页面）。但 CLI 的两条硬约束让「直接引用库里的 html」不可行：
 *    · `path="@./…"` 的相对路径基于 **cwd（= 笔记目录）**；
 *    · **绝对路径会被判 unsafe**（实测 `file does not exist or its path is unsafe`），
 *      跨目录 `../..` 同样有越界风险。
 *
 *  ⇒ 本步骤把 `![[x.html]]`（可指向库内任意位置）**复制到笔记同级 `<note>.attachments/`**，
 *    并把引用改写成该相对路径（不含 `..`）—— 与 PNG 落盘附件是同一套约定
 *    （`diagramRenderPipeline.attachmentsDirName`）。
 *
 *  ## 语义
 *
 *  · 只处理**独占段落**的 `![[x.html]]`（与飞书 block_replace 整块替换的要求一致）；
 *  · 目标已在附件目录里 ⇒ 视为已完成（幂等，不重复复制）；
 *  · 目标找不到 ⇒ 保留原文并记入 `missing`（不丢内容）；
 *  · `dryRun: true` ⇒ 只统计不复制/不写回（供 dry-run 预览如实告知）。
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { attachmentsDirName } from './diagramRenderPipeline.js';
import { resolveEmbedTarget } from './diagramEmbedPipeline.js';

/** 独占段落的 html embed：`![[...html|.htm]]`（整行只有它） */
const HTML_EMBED_LINE_RE = /^[ \t]*!\[\[([^\]\n]+?\.(?:html?|htm))\]\][ \t]*$/;

export interface IHtmlEmbedRef {
	ref: string;
	/** 整行区间 `[start, end)`（含行尾换行） */
	start: number;
	end: number;
}

/** 提取所有**独占段落**的 html embed（跳过围栏代码块内部）。纯函数。 */
export function extractHtmlEmbeds(markdown: string): IHtmlEmbedRef[] {
	const out: IHtmlEmbedRef[] = [];
	if (!markdown) { return out; }
	const lines = markdown.split('\n');
	let offset = 0;
	let fence: { char: string; len: number } | undefined;
	for (const line of lines) {
		const start = offset;
		offset += line.length + 1;
		const fenceMatch = /^[ \t]*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			const char = fenceMatch[1][0];
			const len = fenceMatch[1].length;
			if (!fence) { fence = { char, len }; }
			else if (char === fence.char && len >= fence.len) { fence = undefined; }
			continue;
		}
		if (fence) { continue; }
		const m = HTML_EMBED_LINE_RE.exec(line);
		if (m) { out.push({ ref: m[1].trim(), start, end: offset }); }
	}
	return out;
}

/** 独占段落替换（与既有替换函数同口径）。 */
function replaceRange(markdown: string, embed: IHtmlEmbedRef, replacement: string): string {
	const before = markdown.slice(0, embed.start).replace(/\n+$/, '');
	const after = markdown.slice(embed.end).replace(/^\n+/, '');
	const head = before.length ? `${before}\n\n` : '';
	const tail = after.length ? `\n\n${after}` : '\n';
	return `${head}${replacement}${tail}`;
}

export interface IPrepareHtmlAttachmentsOptions {
	vaultRoot: URI;
	noteUri: URI;
	fileService: IFileService;
	logService?: ILogService;
	/** true = 只统计（不复制、不写回） */
	dryRun?: boolean;
}

export interface IPrepareHtmlAttachmentsResult {
	/** 本次涉及的 html embed 数（dryRun 时 = 将复制的数量） */
	attachments: number;
	/** 目标找不到的引用（保留原文，不丢内容） */
	missing: string[];
	/** 笔记内容是否被改动（dryRun 恒 false） */
	changed: boolean;
}

/**
 * 把一篇笔记里的 html embed 目标复制进 `<note>.attachments/` 并改写引用为相对路径。
 * 不抛异常：单篇失败只记日志。
 */
export async function prepareHtmlAttachmentsForNote(
	opts: IPrepareHtmlAttachmentsOptions,
): Promise<IPrepareHtmlAttachmentsResult> {
	const { noteUri, fileService } = opts;
	const writeBack = opts.dryRun !== true;
	let markdown: string;
	try {
		markdown = (await fileService.readFile(noteUri)).value.toString();
	} catch (err) {
		opts.logService?.warn(`[KB html attachments] 读取笔记失败：${err instanceof Error ? err.message : String(err)}`);
		return { attachments: 0, missing: [], changed: false };
	}

	const embeds = extractHtmlEmbeds(markdown);
	if (embeds.length === 0) { return { attachments: 0, missing: [], changed: false }; }

	const attachDirName = attachmentsDirName(noteUri);
	const attachDir = URI.joinPath(noteUri, '..', attachDirName);
	let out = markdown;
	let changed = false;
	const missing: string[] = [];

	// 倒序替换（保证区间有效）
	for (let i = embeds.length - 1; i >= 0; i--) {
		const embed = embeds[i];
		try {
			const target = await resolveEmbedTarget(fileService, opts.vaultRoot, noteUri, embed.ref);
			if (!target) { missing.push(embed.ref); continue; }
			const fileName = target.path.split('/').pop() ?? '';
			if (!fileName) { missing.push(embed.ref); continue; }
			const relRef = `${attachDirName}/${fileName}`;
			// 已在附件目录里 ⇒ 幂等跳过（不重复复制）
			if (embed.ref === relRef) { continue; }
			if (writeBack) {
				try { await fileService.createFolder(attachDir); } catch { /* 已存在 */ }
				// VSBuffer 可直接写盘（内部就是 Uint8Array，无需经 node Buffer）
				const bytes = (await fileService.readFile(target)).value;
				await fileService.writeFile(URI.joinPath(attachDir, fileName), bytes);
				out = replaceRange(out, embed, `![[${relRef}]]`);
				changed = true;
				opts.logService?.info(`[KB html attachments] ${embed.ref} → ${relRef}`);
			}
		} catch (err) {
			missing.push(embed.ref);
			opts.logService?.warn(`[KB html attachments] ${embed.ref} 复制失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (changed && writeBack) {
		try {
			await fileService.writeFile(noteUri, VSBuffer.fromString(out));
		} catch (err) {
			opts.logService?.warn(`[KB html attachments] 写回笔记失败：${err instanceof Error ? err.message : String(err)}`);
			return { attachments: embeds.length, missing, changed: false };
		}
	}

	return { attachments: embeds.length, missing, changed };
}
