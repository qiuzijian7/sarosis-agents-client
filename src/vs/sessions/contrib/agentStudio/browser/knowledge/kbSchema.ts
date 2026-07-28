/*---------------------------------------------------------------------------------------------
 *  KBSchema — 可配置的知识库分类体系（对齐 llm_wiki schema.md 设计）。
 *
 *  设计原则（借鉴 llm_wiki）：
 *  - 类型体系定义在可持久化的 JSON schema 文件中（vault 根目录 kb-schema.json），
 *    用户可编辑，无需改源码。
 *  - LLM Agent 读取 schema 后自主决定笔记的类型和路径（声明式），而非控制器预计算
 *    死路径（命令式）。
 *  - 每篇笔记的 YAML frontmatter 必须包含 `type` 字段，与 schema 类型 ID 对应，
 *    作为目录路径之外的二次校验。
 *  - 关键词仅作为 LLM 不可用时的 fallback，不再作为主分类手段。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

// ─── Schema 类型定义 ────────────────────────────────────────────────────────

/** 单个知识库笔记类型定义（对齐 llm_wiki Page Types 表）。 */
export interface IKBTypeDef {
	/** 唯一标识（如 "entity"、"concept"），写入 frontmatter type 字段 */
	readonly id: string;
	/** 人类可读标签（如 "实体"、"概念"） */
	readonly label: string;
	/** 目录名（vault 中的实际文件夹名） */
	readonly dir: string;
	/** 描述（供 LLM 分类时理解该类型的语义） */
	readonly desc: string;
	/** LLM 分类提示（额外指引，帮助 LLM 判断何时选择此类型） */
	readonly promptHint: string;
	/** fallback 关键词（LLM 不可用时用于关键词匹配） */
	readonly keywords: string[];
}

/** 完整的知识库 schema 定义 */
export interface IKBSchema {
	readonly version: number;
	/** 笔记类型列表 */
	readonly types: readonly IKBTypeDef[];
	/** 兜底类型 ID（当所有类型都不匹配时使用） */
	readonly defaultType: string;
	/** 命名规范 */
	readonly naming: {
		/** 文件名最大长度 */
		readonly fileMaxLength: number;
		/** 命名约定（人类可读说明，注入 prompt） */
		readonly conventions: string;
	};
	/** Frontmatter 规范 */
	readonly frontmatter: {
		/** 必填字段 */
		readonly required: readonly string[];
		/** 所有字段及说明 */
		readonly fields: Record<string, string>;
	};
	/** 导航文件配置 */
	readonly navigation: {
		readonly indexFile: string;
		readonly overviewFile: string;
		readonly insightsFile: string;
		readonly logFile: string;
		/** 扫描笔记时需排除的系统文件名 */
		readonly excludeFromScan: readonly string[];
	};
}

// ─── 默认 schema（对齐 llm_wiki 的 6 种 Page Types + 当前项目的 8 种类型） ─────

/**
 * 默认知识库 schema。
 *
 * 类型设计融合了 llm_wiki 的语义化分类（entity/concept/source/query/comparison/synthesis）
 * 和当前项目的受管类型词表，同时保持向后兼容。
 *
 * llm_wiki 的 6 种类型：
 *   entity | concept | source | query | comparison | synthesis
 *
 * 当前项目的 8 种类型：
 *   实体 | 概念 | 方法 | 对比 | 源 | 查询 | 综合 | 杂记
 *
 * 合并后保留 8 种类型，但 id 采用英文语义 ID（方便 LLM 理解），
 * dir 保留中文目录名（与现有 vault 结构兼容）。
 */
export const DEFAULT_KB_SCHEMA: IKBSchema = Object.freeze({
	version: 1,
	types: Object.freeze([
		{
			id: 'entity',
			label: '实体',
			dir: '实体',
			desc: '命名事物：模型、公司、人物、框架、库、工具、数据集、产品',
			promptHint: '当内容主要介绍/描述一个具体的事物、工具或实体时选择此类型。特征：包含"是什么"、"简介"、"介绍"、公司名、框架名、工具名等。',
			keywords: ['是什么', '简介', '介绍', 'profile', '公司', '框架', '库', '人物', '组织', '团队'],
		},
		{
			id: 'concept',
			label: '概念',
			dir: '概念',
			desc: '思想、原理、机制、技术概念、理论、抽象知识',
			promptHint: '当内容主要解释一个抽象概念、原理、机制或理论时选择此类型。特征：包含"定义"、"原理"、"机制"、"为什么"、"本质"等。',
			keywords: ['定义', '原理', '机制', '概念', 'why', '为什么', '本质', '核心'],
		},
		{
			id: 'method',
			label: '方法',
			dir: '方法',
			desc: '操作步骤、教程、实践指南、最佳实践、解决方案',
			promptHint: '当内容主要是操作步骤、教程、how-to 指南或实践方法时选择此类型。特征：包含"如何"、"怎么"、"步骤"、"教程"、"指南"、"上手"等。',
			keywords: ['如何', '怎么', '步骤', '教程', '实践', 'best practice', 'guide', '指南', '上手'],
		},
		{
			id: 'comparison',
			label: '对比',
			dir: '对比',
			desc: '对比分析、方案比较、优劣评估、差异说明',
			promptHint: '当内容主要对比多个事物、方案或技术选项时选择此类型。特征：包含"对比"、"区别"、"vs"、"优劣"、"比较"、"差异"等。',
			keywords: ['对比', '区别', 'vs', 'versus', '优劣', '比较', '差异'],
		},
		{
			id: 'source',
			label: '源',
			dir: '源',
			desc: '原文引用、参考来源、外部资料原文、文献',
			promptHint: '当内容主要是外部资料的引用、原文或参考文献时选择此类型。特征：包含 URL、"来源"、"原文"、"引用"、"参考文献"等。',
			keywords: ['http', '来源', '原文', '引用', '参考文献', 'reference'],
		},
		{
			id: 'query',
			label: '查询',
			dir: '查询',
			desc: '开放问题、疑问、FAQ、调研问题、待研究课题',
			promptHint: '当内容以问题/疑问形式呈现，尚未有确定答案时选择此类型。特征：包含"？"、"?"、"怎么理解"、"疑问"、"faq"等。',
			keywords: ['？', '?', '怎么理解', '如何理解', '疑问', 'faq'],
		},
		{
			id: 'synthesis',
			label: '综合',
			dir: '综合',
			desc: '总结、概述、多来源综合、复盘、报告、跨领域分析',
			promptHint: '当内容综合多个来源的信息、进行总结归纳或复盘时选择此类型。特征：包含"总结"、"概述"、"复盘"、"summary"、"报告"、"归纳"、"纪要"等。',
			keywords: ['总结', '概述', '复盘', 'summary', '报告', '归纳', '纪要'],
		},
		{
			id: 'misc',
			label: '杂记',
			dir: '杂记',
			desc: '无法归入以上类型的一般性内容（兜底类型）',
			promptHint: '仅当内容确实无法匹配以上任何类型时才选择此类型。大多数内容应能归入前 7 种类型之一。',
			keywords: [],
		},
	] as readonly IKBTypeDef[]),
	defaultType: 'misc',
	naming: Object.freeze({
		fileMaxLength: 100,
		conventions: '文件名使用安全字符（中文/英文/数字/连字符/下划线），不含 < > : " | ? * 等特殊字符。实体类尽量匹配官方名称，概念类使用描述性短语，来源类使用 作者-年份-主题 格式。',
	}),
	frontmatter: Object.freeze({
		required: Object.freeze(['type', 'title', 'created']),
		fields: Object.freeze({
			type: '笔记类型 ID，必须匹配 schema 中 types 列表的某个 id（如 entity/concept/method/comparison/source/query/synthesis/misc）',
			title: '笔记标题（人类可读）',
			tags: '标签数组，如 [AI, 性能优化]',
			related: '相关笔记的 wikilink 数组，如 [[概念/缓存策略]]',
			source: '来源引用（库文件路径或外部链接）',
			created: '创建日期，格式 YYYY-MM-DD',
			updated: '最后更新日期，格式 YYYY-MM-DD',
		}),
	}),
	navigation: Object.freeze({
		indexFile: 'index.md',
		overviewFile: 'overview.md',
		insightsFile: 'insights.md',
		logFile: 'log.md',
		excludeFromScan: Object.freeze(['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md']),
	}),
});

// ─── Schema 加载/保存 ────────────────────────────────────────────────────────

/** kb-schema.json 在 vault 根目录下的文件名 */
const SCHEMA_FILENAME = 'kb-schema.json';

/**
 * 从 vault 根目录加载知识库 schema。
 * 若 kb-schema.json 存在且格式兼容 → 返回用户自定义 schema；
 * 若不存在或格式不兼容 → 返回 DEFAULT_KB_SCHEMA 并自动写入到 vault 根目录。
 *
 * 对齐 llm_wiki：schema.md 在项目根目录，用户可编辑。
 */
export async function loadKbSchema(fileService: IFileService, vaultRoot: URI): Promise<IKBSchema> {
	const schemaUri = URI.joinPath(vaultRoot, SCHEMA_FILENAME);
	try {
		const raw = (await fileService.readFile(schemaUri)).value.toString();
		const parsed = JSON.parse(raw);
		if (isValidSchema(parsed)) {
			return parsed as IKBSchema;
		}
	} catch {
		// 文件不存在或解析失败 → 使用默认 schema
	}
	// 自动写入默认 schema（方便用户后续编辑）
	try {
		await fileService.writeFile(schemaUri, VSBuffer.fromString(JSON.stringify(DEFAULT_KB_SCHEMA, null, 2)));
	} catch { /* best-effort */ }
	return DEFAULT_KB_SCHEMA;
}

/**
 * 将 schema 保存到 vault 根目录的 kb-schema.json。
 */
export async function saveKbSchema(fileService: IFileService, vaultRoot: URI, schema: IKBSchema): Promise<void> {
	const schemaUri = URI.joinPath(vaultRoot, SCHEMA_FILENAME);
	await fileService.writeFile(schemaUri, VSBuffer.fromString(JSON.stringify(schema, null, 2)));
}

/** 基本校验：version 为数字、types 为非空数组、defaultType 为字符串。 */
function isValidSchema(obj: any): boolean {
	return typeof obj?.version === 'number'
		&& Array.isArray(obj?.types) && obj.types.length > 0
		&& typeof obj?.defaultType === 'string'
		&& obj.types.every((t: any) => typeof t?.id === 'string' && typeof t?.dir === 'string');
}

// ─── Schema 辅助方法 ────────────────────────────────────────────────────────

/** 根据 type id 查找类型定义。 */
export function findTypeById(schema: IKBSchema, typeId: string): IKBTypeDef | undefined {
	return schema.types.find(t => t.id === typeId);
}

/** 根据目录名查找类型定义。 */
export function findTypeByDir(schema: IKBSchema, dir: string): IKBTypeDef | undefined {
	return schema.types.find(t => t.dir === dir);
}

/**
 * 生成供 LLM Agent 阅读的 schema 描述文本（Markdown 格式，对齐 llm_wiki schema.md）。
 * 注入到 Agent prompt 中，让 Agent 自主决定类型和目录。
 */
export function buildSchemaPromptText(schema: IKBSchema): string {
	const typeTable = schema.types.map(t =>
		`| ${t.id} | ${t.dir}/ | ${t.desc} |`
	).join('\n');

	const typeHints = schema.types.map(t =>
		`- **${t.label}** (${t.id}): ${t.promptHint}`
	).join('\n');

	const fmFields = Object.entries(schema.frontmatter.fields)
		.map(([k, v]) => `  - \`${k}\`: ${v}`)
		.join('\n');

	const requiredFm = schema.frontmatter.required.join('`, `');

	return [
		'## Knowledge Base Schema (follow this exactly)',
		'',
		'### Note Types',
		'| Type ID | Directory | Description |',
		'|---------|-----------|-------------|',
		typeTable,
		'',
		'### Type Selection Guide',
		typeHints,
		'',
		'### Naming Conventions',
		schema.naming.conventions,
		`Maximum file name length: ${schema.naming.fileMaxLength} characters.`,
		'',
		'### Required Frontmatter',
		`Every note MUST include YAML frontmatter with at least: \`${requiredFm}\``,
		'All frontmatter fields:',
		fmFields,
		'',
		'### Critical Rules',
		'- NEVER create or modify these navigation files: ' + schema.navigation.excludeFromScan.join(', '),
		'- The `type` field in frontmatter MUST match one of the Type IDs above',
		'- Place notes directly in the current topic directory. Do NOT create a type subdirectory; the `type` belongs only in frontmatter (e.g., path `GC机制.md` with frontmatter `type: concept`, NOT `概念/GC机制.md`)',
		'- Use `[[wikilinks]]` to reference related notes',
		'- If no type clearly fits, use `' + schema.defaultType + '` as the fallback',
	].join('\n');
}

/**
 * 生成供 LLM 分类器使用的 prompt（简洁版，仅用于类型判定 + 主题建议）。
 * 与上面的完整 schema prompt 不同，这个是给 `classifyContent` 用的结构化提取 prompt。
 */
export function buildTypeClassificationPrompt(schema: IKBSchema, content: string, existingTopics?: string[]): string {
	const typeList = schema.types.map(t =>
		`- **${t.label}** (id: "${t.id}", dir: "${t.dir}/"): ${t.desc} — ${t.promptHint}`
	).join('\n');

	const truncated = content.length > 4000 ? content.slice(0, 3997) + '...' : content;

	// 既有主题目录：引导 LLM 优先复用（避免同一主题因语言/格式漂移而新建分裂目录）
	const existingBlock = existingTopics && existingTopics.length
		? ['## 已有主题目录（优先复用：若内容属于其中某个主题，topic 必须原样返回该目录名，不要新造名称）',
			existingTopics.map(s => `- ${s}`).join('\n')].join('\n')
		: '';

	return [
		'你是一位知识分类专家。请根据以下 schema 判断内容的笔记类型，并建议一个主题目录名。',
		'',
		'## Schema（笔记类型定义）',
		typeList,
		'',
		`默认类型: "${schema.defaultType}"（当内容无法匹配任何类型时使用）`,
		'',
		existingBlock,
		'## 分类规则',
		'1. 仔细阅读内容，判断它最适合哪种笔记类型',
		'2. 选择一个最匹配的类型 ID（必须是上面列出的 id 之一）',
		'3. 建议一个主题目录名（topic）：用于在类型目录下创建子文件夹。若已有主题目录与内容相关，必须优先复用并原样返回该目录名；否则用简短的中文或英文描述主题',
		'4. 如果内容涉及多个类型，选择最核心的那个',
		'5. confidence 反映分类的确定性（单一主题 0.9+，模糊内容 0.5-0.7）',
		'',
		'## 待分类内容',
		'```',
		truncated,
		'```',
		'',
		'严格按以下 JSON 格式输出：',
		'{"typeId": "<类型 id>", "typeLabel": "<类型标签>", "topic": "<建议的主题目录名>", "confidence": 0.9, "reasoning": "<一句话分类理由>"}',
	].join('\n');
}

/**
 * 清洗 topic 候选字符串：去除 HTML 标签 / DOCTYPE / 注释、Markdown 记号、文件系统
 * 非法字符与多余空白，截断到 40 字符。
 * 返回清洗后的短标题；若结果不含任何中文字符或字母数字（即纯符号/标记），
 * 返回 undefined ——调用方应回退到「未分类」或既有目录匹配。
 *
 * 注意：这是「文件名安全」纯函数（对齐 llm_wiki makeQuerySlug），输入必须是
 * 分类产物（LLM topic / 既有目录名），**禁止从内容行派生语义 topic**。
 */
export function sanitizeKbTopic(raw: string): string | undefined {
	const cleaned = (raw ?? '')
		.replace(/<![^>]*>/g, ' ')                 // <!DOCTYPE ...> / 条件注释
		.replace(/<!--[\s\S]*?-->/g, ' ')          // HTML 注释
		.replace(/<[^>]+>/g, ' ')                  // HTML 标签
		.replace(/[#*_`~\[\]{}()<>\\|"'：:]/g, ' ') // Markdown 记号 / 非法文件名字符
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 40)
		.trim();
	return /[\u4e00-\u9fff\w]/.test(cleaned) ? cleaned : undefined;
}
