/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  topicOverviews.ts — 目录摘要中间层（对齐 OpenViking 的目录摘要 + freshness 阈值策略）。
 *
 *  现状痛点：知识库内容供聊天/检索使用时只有「元信息 / 全文」两态，缺少中间层，
 *  注入全文太贵、只看标题又丢语义。本模块为每个一级目录（schema typeDir）维护一份
 *  `.overview.md`（点开头，不会被 _collectMdFiles 当笔记扫描）：
 *   - freshness 阈值：目录内文件印章（name:mtime:size）集合变更比例 ≥10% 才重算，
 *     避免每次构建都付 LLM 成本（对齐 OpenViking「待刷新占比 ≥0.10」）；
 *   - 成本控制：所有待更新目录合并为单次 LLM 调用，每目录最多采样 12 篇；
 *   - 降级：无 chatModel / 调用失败 ⇒ 保留旧摘要，管线不阻塞（内部不抛）。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { IChatModel } from './llm.js';

/** 每个目录的摘要文件名（点开头：不被笔记扫描 / 图谱索引收录）。 */
export const TOPIC_OVERVIEW_FILE = '.overview.md';
/** 缓存文件名（记录各目录上次生成时的文件印章集合）。 */
export const TOPIC_OVERVIEW_CACHE_FILE = '.kb-topic-overview-cache.json';

/** freshness 阈值：变更比例达到该值才重算（对齐 OpenViking 0.10）。 */
const FRESHNESS_THRESHOLD = 0.10;
/** 每目录最多采样笔记数。 */
const MAX_SAMPLE_PER_DIR = 12;
/** 单篇笔记采样的正文字符数。 */
const SAMPLE_CHARS = 160;

type TopicCache = Record<string, { stamps: string[] }>;

/** 文件印章：name:mtime:size（内容/重命名/增删都会改变集合）。 */
export function fileStamp(name: string, mtime: number, size: number): string {
	return `${name}:${mtime}:${size}`;
}

/**
 * 变更比例 = 变更文件数 / max(旧文件数, 新文件数, 1)。
 * 按「文件名」计数（而非印章对称差——单文件内容变更会产生新旧两条印章，
 * 对称差口径会把 1 个文件变更算成 2，阈值体感直接翻倍）。
 */
export function topicChangeRatio(oldStamps: string[], newStamps: string[]): number {
	const nameOf = (s: string) => s.split(':')[0];
	const oldMap = new Map(oldStamps.map(s => [nameOf(s), s]));
	const newMap = new Map(newStamps.map(s => [nameOf(s), s]));
	let changed = 0;
	for (const [name, stamp] of newMap) { if (oldMap.get(name) !== stamp) { changed++; } }
	for (const name of oldMap.keys()) { if (!newMap.has(name)) { changed++; } }
	return changed / Math.max(oldMap.size, newMap.size, 1);
}

/** 解析 LLM 输出为 目录名 → 摘要（容错：无「摘要：」前缀时整段作摘要）。 */
export function parseTopicOverviews(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /###\s*目录\s*(\S+)\s*\n([\s\S]*?)(?=###\s*目录\s*\S+|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const body = m[2].trim();
		if (!body) { continue; }
		const summaryMatch = body.match(/^摘要[:：]\s*([\s\S]+)$/m);
		const summary = (summaryMatch?.[1] ?? body).trim();
		if (summary) { out.set(m[1], summary); }
	}
	return out;
}

export async function readTopicOverviewCache(fileService: IFileService, dir: URI): Promise<TopicCache> {
	try {
		const raw = (await fileService.readFile(URI.joinPath(dir, TOPIC_OVERVIEW_CACHE_FILE))).value.toString();
		const parsed = JSON.parse(raw);
		return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as TopicCache : {};
	} catch { return {}; }
}

async function writeTopicOverviewCache(fileService: IFileService, dir: URI, cache: TopicCache): Promise<void> {
	await fileService.writeFile(URI.joinPath(dir, TOPIC_OVERVIEW_CACHE_FILE), VSBuffer.fromString(JSON.stringify(cache, null, 1)));
}

/** 递归收集目录下 md 文件的印章（跳过 `.` 开头文件/目录）。 */
async function collectStamps(fileService: IFileService, dir: URI, root: URI): Promise<string[]> {
	const out: string[] = [];
	const walk = async (cur: URI): Promise<void> => {
		let stat;
		try { stat = await fileService.resolve(cur); } catch { return; }
		if (!stat.children) { return; }
		for (const child of stat.children) {
			if (child.name.startsWith('.')) { continue; }
			if (child.isDirectory) {
				await walk(child.resource);
			} else if (/\.(md|markdown)$/i.test(child.name)) {
				const rel = child.resource.fsPath.slice(root.fsPath.length).replace(/\\/g, '/').replace(/^\//, '');
				out.push(fileStamp(rel, child.mtime ?? 0, child.size ?? 0));
			}
		}
	};
	await walk(dir);
	return out.sort();
}

/** 采样目录内笔记（title + 正文开头），供 LLM 摘要。 */
async function sampleNotes(fileService: IFileService, dir: URI): Promise<string[]> {
	const samples: string[] = [];
	const walk = async (cur: URI): Promise<void> => {
		if (samples.length >= MAX_SAMPLE_PER_DIR) { return; }
		let stat;
		try { stat = await fileService.resolve(cur); } catch { return; }
		if (!stat.children) { return; }
		for (const child of stat.children) {
			if (samples.length >= MAX_SAMPLE_PER_DIR) { return; }
			if (child.name.startsWith('.')) { continue; }
			if (child.isDirectory) { await walk(child.resource); continue; }
			if (!/\.(md|markdown)$/i.test(child.name)) { continue; }
			try {
				const raw = (await fileService.readFile(child.resource)).value.toString();
				const titleMatch = raw.match(/^title:\s*(.+)$/m);
				const title = titleMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || child.name.replace(/\.(md|markdown)$/i, '');
				const body = raw.replace(/^---\s*\n[\s\S]*?\n---/, '').replace(/\s+/g, ' ').trim().slice(0, SAMPLE_CHARS);
				samples.push(`- ${title}：${body}`);
			} catch { /* skip */ }
		}
	};
	await walk(dir);
	return samples;
}

/**
 * 从命中文档 URI 列表推导其所属一级目录（相对库根），按命中频次降序取 top N。
 * 纯函数（供 kbNativeKernelService.getTopicOverviewsForDocs 与测试使用）。
 */
export function extractTopTopicDirs(docIds: string[], libRootPrefix: string, topN = 3): string[] {
	const prefix = libRootPrefix.endsWith('/') ? libRootPrefix : libRootPrefix + '/';
	const counts = new Map<string, number>();
	for (const id of docIds) {
		if (!id.startsWith(prefix)) { continue; }
		const rest = id.slice(prefix.length);
		if (!rest.includes('/')) { continue; } // 库根直接文件无目录归属
		const seg = rest.split('/')[0];
		if (seg && !seg.startsWith('.')) { counts.set(seg, (counts.get(seg) ?? 0) + 1); }
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(e => e[0]);
}

/**
 * 刷新 notesDir 下各一级目录的 `.overview.md`。
 * 仅对「首次生成」或「变更比例 ≥10%」的目录付 LLM 成本；内部不抛。
 * @returns 本次实际重算摘要的目录名列表。
 */
export async function refreshTopicOverviews(
	fileService: IFileService,
	notesDir: URI,
	chatModel: IChatModel | undefined,
	log?: { warn(msg: string, ...args: unknown[]): void; info?(msg: string, ...args: unknown[]): void },
): Promise<string[]> {
	if (!chatModel) { return []; }
	try {
		let rootStat;
		try { rootStat = await fileService.resolve(notesDir); } catch { return []; }
		const dirs = (rootStat.children ?? []).filter(c => c.isDirectory && !c.name.startsWith('.'));
		if (dirs.length === 0) { return []; }

		const cache = await readTopicOverviewCache(fileService, notesDir);
		const pending: { name: string; dir: URI; stamps: string[]; samples: string[] }[] = [];
		for (const d of dirs) {
			const stamps = await collectStamps(fileService, d.resource, d.resource);
			if (stamps.length === 0) { continue; }
			const prev = cache[d.name];
			// 首次（无缓存）或变更超阈值 ⇒ 重算
			if (!prev || topicChangeRatio(prev.stamps, stamps) >= FRESHNESS_THRESHOLD) {
				pending.push({ name: d.name, dir: d.resource, stamps, samples: await sampleNotes(fileService, d.resource) });
			}
		}
		if (pending.length === 0) { return []; }

		const promptParts: string[] = [
			'下面是知识库各目录的笔记采样（标题 + 正文开头）。请为每个目录撰写 2~3 句中文摘要，',
			'概括该目录笔记覆盖的主题与关键结论，供「不看全文也能了解目录内容」的场景使用。',
			'严格按以下格式输出（不要额外解释、不要 markdown 围栏）：',
			'', '### 目录 <目录名>', '摘要：<2~3 句>', '',
		];
		for (const p of pending) {
			promptParts.push(`### 目录 ${p.name}`, p.samples.join('\n'), '');
		}
		const text = await chatModel.complete(
			'你是知识库管理员。为笔记目录撰写摘要，严格按用户要求的格式输出。',
			promptParts.join('\n'),
			0.2,
		);
		const summaries = parseTopicOverviews(text);

		const updated: string[] = [];
		for (const p of pending) {
			const summary = summaries.get(p.name);
			if (!summary) { continue; }
			const content = [
				`# ${p.name} 目录摘要`, '',
				'> 本文件由系统自动维护（目录摘要中间层，freshness ≥10% 才重算），请勿手改。',
				'> 用途：聊天上下文注入 / 检索时优先读本摘要而非目录全文。', '',
				summary.replace(/\n+/g, ' '), '',
			].join('\n');
			try {
				await fileService.writeFile(URI.joinPath(p.dir, TOPIC_OVERVIEW_FILE), VSBuffer.fromString(content));
				cache[p.name] = { stamps: p.stamps };
				updated.push(p.name);
			} catch { /* skip 单目录写失败 */ }
		}
		if (updated.length > 0) {
			await writeTopicOverviewCache(fileService, notesDir, cache);
			log?.info?.(`[topicOverviews] refreshed: ${updated.join(', ')}`);
		}
		return updated;
	} catch (e) {
		log?.warn('[topicOverviews] refresh failed (kept old overviews):', e);
		return [];
	}
}
