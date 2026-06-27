/*---------------------------------------------------------------------------------------------
 *  记忆工具函数 — 合并/对比/转换记忆条目。
 *  1:1 复刻 agentmemory src/state/memory-utils.ts
 *--------------------------------------------------------------------------------------------*/

export interface MemoryLike {
	id: string;
	title?: string;
	content: string;
	concepts?: string[];
	files?: string[];
	sessionIds?: string[];
	strength?: number;
	importance?: number;
	createdAt?: string;
	updatedAt?: string;
}

export interface ObservationLike {
	id: string;
	sessionId: string;
	timestamp: string;
	type: string;
	title: string;
	facts: string[];
	narrative?: string;
	concepts?: string[];
	files?: string[];
	importance?: number;
}

/**
 * 将 Memory 转换为 Observation 形状（用于搜索索引）
 */
export function memoryToObservation(memory: MemoryLike): ObservationLike {
	return {
		id: memory.id,
		sessionId: memory.sessionIds?.[0] ?? 'memory',
		timestamp: memory.createdAt ?? new Date().toISOString(),
		type: 'decision',
		title: memory.title ?? memory.content.slice(0, 80),
		facts: [memory.content],
		narrative: memory.content,
		concepts: memory.concepts ?? [],
		files: memory.files ?? [],
		importance: memory.strength,
	};
}

/**
 * 合并多条记忆为一条
 */
export function mergeMemories(memories: MemoryLike[]): MemoryLike {
	if (memories.length === 0) return { id: '', content: '' };
	if (memories.length === 1) return memories[0];

	const allConcepts = new Set<string>();
	const allFiles = new Set<string>();
	const allSessionIds = new Set<string>();

	for (const mem of memories) {
		for (const c of mem.concepts ?? []) allConcepts.add(c);
		for (const f of mem.files ?? []) allFiles.add(f);
		for (const s of mem.sessionIds ?? []) allSessionIds.add(s);
	}

	return {
		id: memories[0].id,
		title: memories[0].title,
		content: memories.map(m => m.content).join('\n\n'),
		concepts: Array.from(allConcepts),
		files: Array.from(allFiles),
		sessionIds: Array.from(allSessionIds),
		strength: Math.max(...memories.map(m => m.strength ?? 0)),
		importance: Math.max(...memories.map(m => m.importance ?? 0)),
		createdAt: memories[0].createdAt,
		updatedAt: memories[memories.length - 1].updatedAt,
	};
}

/**
 * 比较两条记忆的相似度
 */
export function compareMemories(a: MemoryLike, b: MemoryLike): {
	contentSimilarity: number;
	conceptOverlap: number;
	fileOverlap: number;
	overallSimilarity: number;
} {
	// 内容相似度（基于 Jaccard）
	const tokensA = new Set(a.content.toLowerCase().split(/\s+/));
	const tokensB = new Set(b.content.toLowerCase().split(/\s+/));
	let intersection = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) intersection++;
	}
	const contentSim = (tokensA.size + tokensB.size - intersection) > 0
		? intersection / (tokensA.size + tokensB.size - intersection)
		: 0;

	// 概念重叠
	const conceptsA = new Set(a.concepts ?? []);
	const conceptsB = new Set(b.concepts ?? []);
	const conceptInter = Array.from(conceptsA).filter(c => conceptsB.has(c)).length;
	const conceptOverlap = (conceptsA.size + conceptsB.size - conceptInter) > 0
		? conceptInter / (conceptsA.size + conceptsB.size - conceptInter)
		: 0;

	// 文件重叠
	const filesA = new Set(a.files ?? []);
	const filesB = new Set(b.files ?? []);
	const fileInter = Array.from(filesA).filter(f => filesB.has(f)).length;
	const fileOverlap = (filesA.size + filesB.size - fileInter) > 0
		? fileInter / (filesA.size + filesB.size - fileInter)
		: 0;

	const overall = contentSim * 0.5 + conceptOverlap * 0.3 + fileOverlap * 0.2;

	return {
		contentSimilarity: Math.round(contentSim * 100) / 100,
		conceptOverlap: Math.round(conceptOverlap * 100) / 100,
		fileOverlap: Math.round(fileOverlap * 100) / 100,
		overallSimilarity: Math.round(overall * 100) / 100,
	};
}

/**
 * 提取记忆的关键信息摘要
 */
export function extractKeyInfo(memory: MemoryLike): {
	title: string;
	topConcepts: string[];
	topFiles: string[];
	contentPreview: string;
} {
	return {
		title: memory.title ?? memory.content.slice(0, 80),
		topConcepts: (memory.concepts ?? []).slice(0, 5),
		topFiles: (memory.files ?? []).slice(0, 5),
		contentPreview: memory.content.slice(0, 200),
	};
}

/**
 * 格式化记忆为可读字符串
 */
export function formatMemory(memory: MemoryLike): string {
	const lines: string[] = [];
	if (memory.title) lines.push(`## ${memory.title}`);
	lines.push(memory.content);
	if (memory.concepts && memory.concepts.length > 0) {
		lines.push(`\n**Concepts:** ${memory.concepts.join(', ')}`);
	}
	if (memory.files && memory.files.length > 0) {
		lines.push(`**Files:** ${memory.files.join(', ')}`);
	}
	return lines.join('\n');
}
