/*---------------------------------------------------------------------------------------------
 *  LLM 提示模板 — 所有系统提示词的集中管理。
 *  1:1 复刻 agentmemory src/prompts/ 目录（7 个文件合并）
 *
 *  包含：
 *    1. compression — 压缩提示
 *    2. consolidation — 固化提示
 *    3. graph-extraction — 图谱提取提示
 *    4. reflect — 反思提示
 *    5. summary — 摘要提示
 *    6. vision — 视觉提示
 *    7. xml — XML 解析工具
 *--------------------------------------------------------------------------------------------*/

// ─── Compression Prompts ───────────────────────────────────────────────────

export const COMPRESSION_SYSTEM_PROMPT = `You compress conversation observations while preserving key information.
Rules:
- Extract structured fields: title, narrative, facts, concepts, files, importance (1-10)
- Remove redundant content and conversational filler
- Keep technical details, code references, and file paths
- Output as JSON: { "title": "...", "narrative": "...", "facts": [...], "concepts": [...], "files": [...], "importance": N }`;

// ─── Consolidation Prompts ─────────────────────────────────────────────────

export const CONSOLIDATION_EPISODIC_SYSTEM = `You are an episodic memory consolidation engine.
Given observations from a session, create a structured episodic memory summary.
Output as JSON:
{
  "title": "Short title",
  "narrative": "1-3 sentence summary of what happened",
  "keyDecisions": ["decision 1", "decision 2"],
  "filesModified": ["file1.ts", "file2.js"],
  "concepts": ["concept1", "concept2"],
  "observationCount": N
}`;

export const CONSOLIDATION_SEMANTIC_SYSTEM = `You are a semantic memory extraction engine.
Given multiple episodic memories, extract cross-session facts and patterns.
Output as JSON:
{
  "fact": "The extracted fact or pattern",
  "confidence": 0.0-1.0,
  "sourceSessionIds": ["session1", "session2"],
  "evidence": "Why this fact is derived"
}`;

export const CONSOLIDATION_PROCEDURAL_SYSTEM = `You are a procedural memory extraction engine.
Given semantic memories, extract reusable workflow patterns.
Output as JSON:
{
  "name": "Pattern name",
  "steps": ["step 1", "step 2"],
  "triggerCondition": "When to apply this pattern",
  "expectedOutcome": "What success looks like",
  "frequency": N
}`;

// ─── Graph Extraction Prompts ─────────────────────────────────────────────

export const GRAPH_EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine.
Given observations, extract entities and their relationships.
Output as JSON:
{
  "entities": [{ "type": "file|function|concept|error|decision|pattern", "name": "exact name" }],
  "relationships": [{ "type": "uses|imports|modifies|causes|fixes|depends_on|related_to", "source": "entity name", "target": "entity name", "weight": 0.1-1.0 }]
}`;

// ─── Reflect Prompts ───────────────────────────────────────────────────────

export const REFLECT_SYSTEM = `You are a memory reflection engine.
Analyze recent observations and extract actionable insights:
1. TODOs — pending tasks that need follow-up
2. Preferences — user's coding/work preferences
3. Conventions — project conventions or patterns
Output as JSON:
{
  "todos": ["todo 1", "todo 2"],
  "preferences": ["preference 1"],
  "conventions": ["convention 1"]
}`;

// ─── Summary Prompts ───────────────────────────────────────────────────────

export const SUMMARY_SYSTEM = `You are summarizing a completed multi-step session.
Extract: (1) what was accomplished, (2) key decisions, (3) files affected, (4) lessons learned.
Output as JSON:
{
  "title": "Short session title",
  "narrative": "1-2 sentence summary",
  "keyDecisions": ["decision 1"],
  "filesAffected": ["file1"],
  "lessons": ["lesson 1"]
}`;

// ─── Vision Prompts ────────────────────────────────────────────────────────

export const VISION_DESCRIPTION_SYSTEM = `You are describing an image for memory storage.
Extract: (1) what the image shows, (2) any text/labels visible, (3) technical context.
Output as JSON:
{
  "description": "What the image shows",
  "textLabels": ["any visible text"],
  "technicalContext": "diagram/screenshot/code/etc",
  "tags": ["tag1", "tag2"]
}`;

// ─── XML Parsing Utilities ─────────────────────────────────────────────────

export function parseXmlTag(xml: string, tag: string): string | null {
	const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
	const match = xml.match(regex);
	return match ? match[1].trim() : null;
}

export function parseXmlTags(xml: string, tag: string): string[] {
	const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
	const results: string[] = [];
	let match;
	while ((match = regex.exec(xml)) !== null) {
		results.push(match[1].trim());
	}
	return results;
}

export function parseXmlAttribute(xml: string, tag: string, attr: string): string | null {
	const regex = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
	const match = xml.match(regex);
	return match ? match[1] : null;
}

export function stripXmlTags(xml: string): string {
	return xml.replace(/<[^>]+>/g, '').trim();
}

export function buildXmlString(tag: string, content: string, attrs?: Record<string, string>): string {
	const attrStr = attrs ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ') : '';
	return `<${tag}${attrStr}>${content}</${tag}>`;
}

// ─── Prompt Registry ───────────────────────────────────────────────────────

export interface PromptEntry {
	name: string;
	systemPrompt: string;
	description: string;
}

export const ALL_PROMPTS: PromptEntry[] = [
	{ name: 'compression', systemPrompt: COMPRESSION_SYSTEM_PROMPT, description: '记忆压缩' },
	{ name: 'consolidation_episodic', systemPrompt: CONSOLIDATION_EPISODIC_SYSTEM, description: '情景固化' },
	{ name: 'consolidation_semantic', systemPrompt: CONSOLIDATION_SEMANTIC_SYSTEM, description: '语义固化' },
	{ name: 'consolidation_procedural', systemPrompt: CONSOLIDATION_PROCEDURAL_SYSTEM, description: '程序固化' },
	{ name: 'graph_extraction', systemPrompt: GRAPH_EXTRACTION_SYSTEM, description: '图谱提取' },
	{ name: 'reflect', systemPrompt: REFLECT_SYSTEM, description: '反思提取' },
	{ name: 'summary', systemPrompt: SUMMARY_SYSTEM, description: '会话摘要' },
	{ name: 'vision_description', systemPrompt: VISION_DESCRIPTION_SYSTEM, description: '视觉描述' },
];

export function getPrompt(name: string): PromptEntry | null {
	return ALL_PROMPTS.find(p => p.name === name) ?? null;
}

export class PromptManager {
	private _customPrompts = new Map<string, PromptEntry>();

	get(name: string): PromptEntry | null {
		return this._customPrompts.get(name) ?? getPrompt(name);
	}

	register(name: string, systemPrompt: string, description?: string): void {
		this._customPrompts.set(name, { name, systemPrompt, description: description ?? 'custom' });
	}

	list(): PromptEntry[] {
		return [...ALL_PROMPTS, ...Array.from(this._customPrompts.values())];
	}

	clear(): void {
		this._customPrompts.clear();
	}
}
