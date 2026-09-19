/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  communitySummaries.ts — 社区语义摘要（对齐 GraphRAG community reports 思路）。
 *
 *  Louvain 社区检测只给「成员列表」，insights.md 缺少「这个社区在讲什么」的语义层。
 *  本模块在检测之后追加一次（仅一次）LLM 调用，为每个社区生成「主题名 + 摘要」：
 *   - 成本控制：社区按规模降序取 top N、成员标题截断、所有社区合并为单次调用；
 *   - 缓存：按「成员指纹」（成员标题归一排序 join）命中直接复用，社区重编号不影响命中，
 *     落盘 <notesDir>/.kb-insights-cache.json（点开头，_collectMdFiles 自动跳过）；
 *   - 降级：无 chatModel / 调用失败 ⇒ 返回已缓存部分，调用方回退纯成员列表，管线不阻塞。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { IChatModel } from './llm.js';

/** 缓存文件名（点开头：不会被 _collectMdFiles 当笔记扫描）。 */
export const KB_INSIGHTS_CACHE_FILE = '.kb-insights-cache.json';

/** 参与摘要的社区数上限（按规模降序）。 */
const MAX_COMMUNITIES = 8;
/** 每社区参与摘要的成员标题数上限。 */
const MAX_MEMBERS_PER_COMMUNITY = 15;
/** 单社区最小规模：小于该规模的社区不值得花 LLM 成本。 */
const MIN_COMMUNITY_SIZE = 2;

export interface ICommunityInput {
	/** 社区 id（detectCommunities 产出 c0/c1/... 字符串）。 */
	id: string;
	members: string[];
}

export interface ICommunitySummary {
	topic: string;
	summary: string;
}

/** 成员指纹：归一（trim+小写）排序后 join。社区重跑重编号不影响命中。 */
export function communityFingerprint(members: string[]): string {
	return members.map(m => m.trim().toLowerCase()).sort().join('|');
}

/** 构造单次 LLM 调用的 prompt（所有待摘要社区合并，控成本）。 */
export function buildCommunitySummaryPrompt(communities: ICommunityInput[]): string {
	const parts: string[] = [
		'下面是知识图谱 Louvain 社区检测的结果，每个社区是一组通过 [[双链]] 互联的笔记标题。',
		'请为每个社区输出：一个简短主题名（≤10 字）+ 2~3 句中文摘要（概括该社区笔记 collectively 覆盖的主题与关键结论）。',
		'严格按以下格式输出（不要额外解释、不要 markdown 围栏）：',
		'',
		'### 社区 <id>',
		'主题：<短语>',
		'摘要：<2~3 句>',
		'',
	];
	for (const c of communities) {
		parts.push(`### 社区 ${c.id}`, c.members.map(m => `- ${m}`).join('\n'), '');
	}
	return parts.join('\n');
}

/**
 * 解析 LLM 输出为 id → 摘要。容错：缺「主题」时 topic 为空串；
 * 段内无任何可解析字段时，整段非空文本作为 summary。
 * id 按字符串解析（与 detectCommunities 的 c0/c1/... 口径一致）。
 */
export function parseCommunitySummaries(text: string): Map<string, ICommunitySummary> {
	const out = new Map<string, ICommunitySummary>();
	const re = /###\s*社区\s*(\S+)\s*\n([\s\S]*?)(?=###\s*社区\s*\S+|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const id = m[1];
		const body = m[2].trim();
		if (!body) { continue; }
		const topicMatch = body.match(/^主题[:：]\s*(.+)$/m);
		const summaryMatch = body.match(/^摘要[:：]\s*([\s\S]+)$/m);
		const topic = topicMatch?.[1]?.trim() ?? '';
		const summary = (summaryMatch?.[1] ?? body).trim();
		if (summary) { out.set(id, { topic, summary }); }
	}
	return out;
}

type InsightsCache = Record<string, ICommunitySummary>;

export async function readInsightsCache(fileService: IFileService, dir: URI): Promise<InsightsCache> {
	try {
		const raw = (await fileService.readFile(URI.joinPath(dir, KB_INSIGHTS_CACHE_FILE))).value.toString();
		const parsed = JSON.parse(raw);
		return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as InsightsCache : {};
	} catch { return {}; }
}

export async function writeInsightsCache(fileService: IFileService, dir: URI, cache: InsightsCache): Promise<void> {
	await fileService.writeFile(URI.joinPath(dir, KB_INSIGHTS_CACHE_FILE), VSBuffer.fromString(JSON.stringify(cache, null, 1)));
}

/**
 * 为社区生成语义摘要（缓存优先，缺失部分一次 LLM 调用补齐）。
 * 永不抛出：失败时返回已缓存部分并 warn。
 */
export async function summarizeCommunities(
	fileService: IFileService,
	dir: URI,
	communities: ICommunityInput[],
	chatModel: IChatModel | undefined,
	log?: { warn(msg: string, ...args: unknown[]): void },
): Promise<Map<string, ICommunitySummary>> {
	const result = new Map<string, ICommunitySummary>();
	if (!chatModel) { return result; }

	// 规模过滤 + top N + 成员截断（成本上限）
	const eligible = communities
		.filter(c => c.members.length >= MIN_COMMUNITY_SIZE)
		.sort((a, b) => b.members.length - a.members.length)
		.slice(0, MAX_COMMUNITIES)
		.map(c => ({ id: c.id, members: c.members.slice(0, MAX_MEMBERS_PER_COMMUNITY) }));
	if (eligible.length === 0) { return result; }

	const cache = await readInsightsCache(fileService, dir);
	const missing: ICommunityInput[] = [];
	for (const c of eligible) {
		const hit = cache[communityFingerprint(c.members)];
		if (hit?.summary) { result.set(c.id, hit); } else { missing.push(c); }
	}
	if (missing.length === 0) { return result; }

	try {
		const text = await chatModel.complete(
			'你是知识图谱分析师。为一组笔记社区撰写主题名与摘要，严格按用户要求的格式输出。',
			buildCommunitySummaryPrompt(missing),
			0.2,
		);
		const fresh = parseCommunitySummaries(text);
		let dirty = false;
		for (const c of missing) {
			const s = fresh.get(c.id);
			if (s?.summary) {
				result.set(c.id, s);
				cache[communityFingerprint(c.members)] = s;
				dirty = true;
			}
		}
		if (dirty) { await writeInsightsCache(fileService, dir, cache); }
	} catch (e) {
		log?.warn('[communitySummaries] LLM summarize failed, falling back to member list:', e);
	}
	return result;
}
