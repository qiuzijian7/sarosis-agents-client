/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — LLM-driven content classifier
 *
 *  Replicates Hyper-Extract's `guideline.target` role-playing + structured-output
 *  classification pattern. 给定一段内容，用 LLM 依据知识库 schema（kb-schema.json，
 *  用户可编辑）进行语义类型判断 —— **唯一的分类路径**。
 *
 *  Fallback 语义（对齐 llm_wiki）：LLM 不可用/输出无效时**不做关键词猜测**，
 *  安全降级为 schema 默认类型（misc）+ 「未分类」topic。语义归类 100% 归 LLM；
 *  代码侧只保留确定性的文件名安全清洗（sanitizeTopic / sanitizeKbTopic）。
 *--------------------------------------------------------------------------------------------*/

import { IChatModel } from './engine/llm.js';
import { IKBSchema, buildTypeClassificationPrompt, findTypeById } from './kbSchema.js';

// ─── Schema-driven 分类（LLM 语义分类，唯一分类路径） ───────────────────────

export interface SchemaClassifyResult {
	/** 匹配到的 schema 类型 ID（如 "entity", "concept"） */
	readonly typeId: string;
	/** 类型标签（如 "实体"、"概念"） */
	readonly typeLabel: string;
	/** 对应的目录名（如 "实体"、"概念"） */
	readonly typeDir: string;
	/** 建议的主题目录名（用于在类型目录下创建子文件夹） */
	readonly topic: string;
	/** 置信度 0-1 */
	readonly confidence: number;
	/** 分类理由 */
	readonly reasoning: string;
	/** 来源：'llm'（LLM 语义分类）| 'fallback'（LLM 不可用时的安全降级，非关键词猜测） */
	readonly source: 'llm' | 'fallback';
}

/**
 * LLM 不可用/输出无效时的安全降级结果：schema 默认类型（misc）+ 「未分类」topic。
 * 对齐 llm_wiki 语义：LLM 不可用时不做关键词猜测（避免 `!DOCTYPE html` 式垃圾目录）。
 */
export function safeSchemaFallback(schema: IKBSchema, reason = 'LLM 不可用，安全降级到默认类型'): SchemaClassifyResult {
	const misc = findTypeById(schema, schema.defaultType) ?? schema.types[schema.types.length - 1];
	return {
		typeId: misc?.id ?? 'misc',
		typeLabel: misc?.label ?? '杂记',
		typeDir: misc?.dir ?? '杂记',
		topic: '未分类',
		confidence: 0,
		reasoning: reason,
		source: 'fallback',
	};
}

/**
 * Schema-driven 智能分类（P0 改进核心）。
 *
 * 将内容 + 完整 schema 发送给 LLM，让 LLM 根据 schema 的语义描述判断笔记类型，
 * 同时建议一个主题目录名。这是从「关键词匹配」到「语义理解」的关键升级。
 *
 * 对齐 llm_wiki：LLM 读取 schema.md → 自主判断 type → 调用 wiki.write_page 写入对应目录。
 *
 * @param llm     IChatModel 实例
 * @param schema  知识库 schema（类型定义 + 描述 + 提示）
 * @param content 待分类文本
 * @param signal  可选中止信号
 * @param existingTopics 可选：既有主题目录列表，引导 LLM 优先复用（避免分裂目录）
 */
export async function classifyContentViaSchema(
	llm: IChatModel,
	schema: IKBSchema,
	content: string,
	signal?: AbortSignal,
	existingTopics?: string[],
): Promise<SchemaClassifyResult> {
	try {
		if (signal?.aborted) {
			return safeSchemaFallback(schema, '分类请求已中止');
		}

		const prompt = buildTypeClassificationPrompt(schema, content, existingTopics);
		const result = await llm.extract({
			prompt,
			schema: {
				type: 'object',
				properties: {
					typeId: { type: 'string', description: 'The most appropriate note type ID from the schema' },
					typeLabel: { type: 'string', description: 'The human-readable type label' },
					topic: { type: 'string', description: 'Suggested topic directory name (short, safe for filesystem)' },
					confidence: { type: 'number', description: 'Confidence score 0.0 to 1.0', minimum: 0, maximum: 1 },
					reasoning: { type: 'string', description: 'One-line rationale for the type choice and topic' },
				},
				required: ['typeId', 'typeLabel', 'topic', 'confidence', 'reasoning'],
			} as any,
			abortSignal: signal,
		});

		const parsed = (result as any)?.parsed ?? result;
		const typeId = typeof parsed?.typeId === 'string' ? parsed.typeId : '';
		const typeDef = findTypeById(schema, typeId);

		if (!typeDef || !typeId) {
			// LLM 返回了无效 typeId → 安全降级（不做关键词猜测）
			return safeSchemaFallback(schema, `LLM 返回无效类型 "${typeId}"，安全降级到默认类型`);
		}

		// 清洗 topic：去非法字符、限长
		const topic = sanitizeTopic(parsed?.topic ?? typeDef.label);

		return {
			typeId: typeDef.id,
			typeLabel: typeDef.label,
			typeDir: typeDef.dir,
			topic,
			confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.8,
			reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : `LLM classified as ${typeDef.label}`,
			source: 'llm',
		};
	} catch {
		// LLM 不可用/超时 → 安全降级（不做关键词猜测）
		return safeSchemaFallback(schema);
	}
}

/** 清洗主题名：去掉路径穿越与非法字符，限长。 */
function sanitizeTopic(raw: string | undefined): string {
	if (!raw || typeof raw !== 'string') { return '未分类'; }
	const cleaned = raw
		.replace(/\.\./g, '')
		.replace(/[<>:"|?*\x00-\x1f]/g, '_')
		.trim()
		.slice(0, 60);
	return cleaned.length >= 2 ? cleaned : '未分类';
}
