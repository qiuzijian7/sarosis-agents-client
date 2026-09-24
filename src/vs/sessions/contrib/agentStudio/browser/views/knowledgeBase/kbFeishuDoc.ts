/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书云文档 → 本地 markdown 的**纯逻辑**（2026-09-23）。
 *
 * 为什么单列一层：与 `kbUrlScraper.ts` 同属「导入链接 / URL」的解析层 ——
 * 这里只放不依赖 DI 的纯函数（URL 判定 / CLI 输出解析 / 资源标签抽取与改写 / markdown 组装），
 * 由单测覆盖；真正的 CLI 调用（需 child_process + IPC）在
 * `kbImportController._importFeishuDoc` 里编排。
 *
 * ## 为什么飞书文档必须走 CLI，而不是网页抓取
 *
 * 飞书文档在未登录的网页里只有登录墙/骨架 ⇒ 拿不到正文，更拿不到图片、画板（思维导图）、表格。
 * 官方 CLI 能按当前登录身份读取：
 *   · 正文（标题 / 列表 / **表格** / **超链接**）：
 *     `docs +fetch --doc <url> --doc-format markdown`
 *   · 图片 / 附件素材（正文里的 `<img token>`、`<source token>`）：
 *     `docs +media-download --token <file_token> --output <path>`
 *   · **画板 / 思维导图**（正文里的 `<whiteboard token>`）：
 *     `docs +media-download --type whiteboard --token <whiteboard_id> --output <path>`（得缩略图）
 * 命令与返回形态出自 CLI 自带参考：`lark-cli skills read lark-doc/references/lark-doc-fetch.md`
 * 与 `…/lark-doc-media-download.md`。
 *
 * ⚠ 覆盖范围：`/docx/`、旧版 `/docs/`、知识库 `/wiki/`（CLI 的 `--doc` 直接支持 wiki 链接）。
 *   `/sheets/`（电子表格）、`/base/`（多维表格）、`/mindnotes/`（独立思维笔记）**不在**本模块范围 ——
 *   它们需要各自领域的命令（`lark-sheets` / `lark-base`），暂时仍走通用网页抓取。
 */

import { larkCliErrorText, parseLarkCliJson } from '../../../common/larkCli.js';

/** 飞书文档的路径段（`/docx/`、旧版 `/docs/`、知识库 `/wiki/`，后面跟 token）。 */
const FEISHU_DOC_PATH_RE = /\/(docx|docs|wiki)\/[A-Za-z0-9]/i;

/** 飞书域名。与 `kbUrlScraper` 的 `feishu` 平台口径一致，另加私有化部署常见域名。 */
const FEISHU_HOST_RE = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/i;

/** 该 URL 是否是**可由 `docs +fetch` 读取**的飞书云文档链接。 */
export function isFeishuDocUrl(rawUrl: string): boolean {
	let u: URL;
	try { u = new URL((rawUrl ?? '').trim()); } catch { return false; }
	if (!FEISHU_HOST_RE.test(u.hostname)) { return false; }
	return FEISHU_DOC_PATH_RE.test(u.pathname);
}

/** `docs +fetch` 的解析结果。 */
export interface IFeishuDocFetch {
	readonly ok: boolean;
	/** 文档标题（正文首个 `# 标题`；取不到则 undefined，由调用方回退）。 */
	readonly title?: string;
	readonly content?: string;
	/** 失败原因（权限不足 / 未登录 / 未找到…），已从 CLI 的 `error.hint` 里提取成可读文本。 */
	readonly error?: string;
}

/**
 * 解析 `lark-cli docs +fetch --doc-format markdown` 的结果。
 *
 * 返回形态（官方参考）：
 * `{ ok, identity, data: { document: { document_id, revision_id, content, reference_map } } }`
 * · `content` = markdown 正文（表格/超链接已由 CLI 转换）；
 * · `ok:false` 或没有 `content` ⇒ 视为失败，用 `larkCliErrorText` 提取可读原因
 *   （权限类错误主要靠 `error.hint`，只回 `code` 对用户没用）。
 */
export function parseFeishuDocFetch(stdout: string, stderr = ''): IFeishuDocFetch {
	const parsed = parseLarkCliJson<{
		ok?: boolean;
		data?: { document?: { content?: unknown; document_id?: unknown } };
	}>(stdout);
	const content = typeof parsed?.data?.document?.content === 'string' ? parsed.data.document.content : undefined;
	if (parsed?.ok === false || !content) {
		return { ok: false, error: larkCliErrorText(parsed, stderr || stdout) };
	}
	return { ok: true, content, title: firstHeading(content) };
}

/** 取正文里的第一个标题文本（`# x` → `x`；兼容 `##`）。找不到返回 undefined。 */
export function firstHeading(content: string): string | undefined {
	const m = /^\s{0,3}#{1,6}\s+(.+?)\s*$/m.exec(content ?? '');
	return m?.[1]?.trim() || undefined;
}

/** 正文里的一处内嵌资源。 */
export interface IFeishuMediaRef {
	/** `media` = 图片/附件（`<img>` / `<source>`）；`whiteboard` = 画板/思维导图。 */
	readonly kind: 'media' | 'whiteboard';
	readonly token: string;
	/** 原始文件名（`<source name="…">` 才有）。 */
	readonly name?: string;
	/** 原始标签文本，用于原位替换。 */
	readonly raw: string;
}

/**
 * 抽出正文里的内嵌资源（**按出现顺序**，同一资源只留一次）。
 *
 * · 带 `token` 的 ⇒ 需要走 `+media-download` 下载；
 * · 只带 `url` 的（公开图片）⇒ **不下载、原样保留** —— CLI 参考明确说「有 url 时仅下载可信的
 *   公开 HTTPS URL」，这类链接在笔记里可被预览直接加载，不需要本地化。
 */
export function extractFeishuMediaRefs(content: string): IFeishuMediaRef[] {
	const out: IFeishuMediaRef[] = [];
	const seen = new Set<string>();
	const re = /<(img|source|whiteboard)\b([^>]*?)\/?>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content ?? ''))) {
		const tag = m[1].toLowerCase();
		const attrs = m[2] ?? '';
		const token = attr(attrs, 'token');
		if (!token) { continue; }
		const kind: 'media' | 'whiteboard' = tag === 'whiteboard' ? 'whiteboard' : 'media';
		const key = `${kind}:${token}`;
		if (seen.has(key)) { continue; }
		seen.add(key);
		out.push({ kind, token, name: attr(attrs, 'name') ?? attr(attrs, 'file_name'), raw: m[0] });
	}
	return out;
}

/** 从标签的属性串里取某个属性值（支持双引号 / 单引号 / 无引号）。 */
function attr(attrs: string, key: string): string | undefined {
	const m = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
	return m?.[1] ?? m?.[2] ?? m?.[3];
}

/**
 * 规划内嵌资源在知识库内的**文件名**（不含扩展名、不含目录）。
 * 形如 `img-01` / `board-01`；序号与来源标签一一对应，保证不互相覆盖。
 *
 * ⚠ 为什么不带扩展名：CLI 的 `--output` 不带扩展名时会**按响应 `Content-Type` 自动补全**，
 *   而我们在下载前无从知道是 png 还是 jpg ⇒ 下完后按前缀去目录里查真实文件名（见控制器）。
 */
export function planFeishuMediaName(index: number, ref: IFeishuMediaRef): string {
	const prefix = ref.kind === 'whiteboard' ? 'board' : 'img';
	return `${prefix}-${String(index + 1).padStart(2, '0')}`;
}

/**
 * 把正文里的资源标签替换为本地 markdown 图片引用。
 *
 * ⚠ 关键约定：**绝不在最终 md 里留下原始 XML 标签** —— 下载失败的也换成一行可读占位说明，
 *   否则笔记正文会出现 `<img token="…">` 这种没人能读的片段（而且会被后续构建当成素材内容喂给 LLM）。
 *
 * @param relByKey 键为 `planFeishuMediaKey(ref)`，值为相对 markdown 所在目录的图片路径
 */
export function replaceFeishuMediaRefs(content: string, relByKey: ReadonlyMap<string, string>): string {
	let out = content ?? '';
	for (const ref of extractFeishuMediaRefs(out)) {
		const rel = relByKey.get(planFeishuMediaKey(ref));
		const label = ref.kind === 'whiteboard' ? '画板/思维导图' : (ref.name || '图片');
		const replacement = rel ? `![${label}](${rel})` : `> （未能下载${label}：token ${ref.token}）`;
		out = out.split(ref.raw).join(replacement);
	}
	return out;
}

/** 资源的稳定键（`media:<token>` / `whiteboard:<token>`），替换与下载两侧共用。 */
export function planFeishuMediaKey(ref: IFeishuMediaRef): string {
	return `${ref.kind}:${ref.token}`;
}

/**
 * 组装飞书文档的 markdown（标题 / 来源信息 / 正文 / 资源统计）。
 * 版式与 `kbUrlScraper.composeArticleMarkdown` 保持一致（`# 标题` + `>` 来源行 + 正文）。
 */
export function composeFeishuDocMarkdown(opts: {
	url: string;
	title: string;
	body: string;
	images: number;
	/** 正文里出现但未能下载的资源数（会在来源行里如实说明，不静默吞掉）。 */
	mediaFailed?: number;
}): string {
	const lines: string[] = [`# ${opts.title}`, ''];
	lines.push(`> 来源：飞书云文档 · 原文：${opts.url}`, '');
	const extra = `${opts.images ? `已本地化图片 ${opts.images} 张` : '无本地图片'}`
		+ `${opts.mediaFailed ? ` · ${opts.mediaFailed} 个资源未能下载` : ''}`;
	lines.push(`> 导入方式：飞书 CLI（lark-cli）读取 · ${extra}`, '');
	lines.push((opts.body ?? '').trim(), '');
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
