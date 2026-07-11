/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Community Summarization
 *
 *  Given a `CommunityDetectionResult`, ask the LLM to produce a short TITLE
 *  and a 1-3 sentence SUMMARY for each community. This is the GraphRAG
 *  "community report" step that enables hierarchical / community-level
 *  retrieval (you can search whole communities, not just raw nodes/edges).
 *
 *  Kept separate from the detection algorithm so the (pure) Louvain code
 *  stays LLM-free and easy to unit-test.
 *--------------------------------------------------------------------------------------------*/

import { IChatModel } from './llm.js';
import { CommunityDetectionResult } from './communityDetection.js';

export interface CommunitySummary {
	/** Community id (matches `CommunityDetectionResult.communities` key). */
	id: string;
	/** Short LLM-generated title for the community. */
	title: string;
	/** 1-3 sentence LLM-generated summary. */
	summary: string;
	/** Member node ids. */
	nodeIds: string[];
	/** Number of internal/incident edges considered. */
	edgeCount: number;
}

const DEFAULT_COMM_PROMPT =
	'You are a knowledge-graph analyst. Given a COMMUNITY of related entities and ' +
	'their internal relationships, produce a short TITLE and a 1-3 sentence SUMMARY ' +
	'that captures the unifying theme (what binds these entities together). ' +
	'Be specific; avoid generic phrasing. Respond as:\n' +
	'Title: <short title>\nSummary: <1-3 sentences>';

export interface SummarizeOptions {
	llm: IChatModel;
	result: CommunityDetectionResult;
	/** Resolve a community id to its member descriptors (names + descriptions). */
	membersOf: (commId: string) => { id: string; name: string; description?: string }[];
	/** Resolve a community id to its internal/incident edges. */
	incidentEdgesOf: (commId: string) => { source: string; target: string; relation?: string }[];
	/** Optional custom summarization prompt. */
	prompt?: string;
}

export async function summarizeCommunities(opts: SummarizeOptions): Promise<CommunitySummary[]> {
	const { llm, result, membersOf, incidentEdgesOf, prompt = DEFAULT_COMM_PROMPT } = opts;
	const out: CommunitySummary[] = [];

	for (const [commId, nodeIds] of result.communities) {
		const members = membersOf(commId);
		const edges = incidentEdgesOf(commId);
		try {
			const user =
				`Community ID: ${commId}\n` +
				`Members (${members.length}):\n` +
				members.map(mm => `- ${mm.name}${mm.description ? `: ${mm.description}` : ''}`).join('\n') +
				`\n\nInternal / incident relationships (${edges.length}):\n` +
				edges.map(e => `- ${e.source} --${e.relation ?? 'relates'}--> ${e.target}`).join('\n') +
				`\n\nProduce a concise title and a 1-3 sentence summary of this community.`;
			const text = await llm.complete(prompt, user);
			const parsed = parseSummary(text);
			out.push({
				id: commId,
				title: parsed.title || commId,
				summary: parsed.summary || text.trim(),
				nodeIds: [...nodeIds],
				edgeCount: edges.length,
			});
		} catch (e) {
			if (typeof process !== 'undefined' && (process.env?.['KB_VERBOSE'])) {
				console.warn('[summarizeCommunities] failed for', commId, e);
			}
			out.push({
				id: commId,
				title: commId,
				summary: '',
				nodeIds: [...nodeIds],
				edgeCount: edges.length,
			});
		}
	}
	return out;
}

function parseSummary(text: string): { title: string; summary: string } {
	const t = String(text ?? '').trim();
	try {
		const j = JSON.parse(t);
		if (j && typeof j === 'object') {
			return { title: String(j.title ?? ''), summary: String(j.summary ?? '') };
		}
	} catch { /* not JSON */ }
	const titleMatch = t.match(/title\s*[:：]\s*(.+)/i);
	const summaryMatch = t.match(/summary\s*[:：]\s*([\s\S]+)/i);
	return {
		title: titleMatch ? titleMatch[1].trim() : '',
		summary: summaryMatch ? summaryMatch[1].trim() : t,
	};
}
