/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 沉淀技能（Extract Skill）—— Hyper-Extract 风格结构化提取。
 *
 * 设计借鉴 Hyper-Extract 的 BaseAutoType + Pydantic schema 模式：
 *   1. JSON Schema 驱动的 structured output（TS 版 Pydantic）
 *   2. 意图分类前置（isSkill 判定，避免浪费 LLM token 提取非技能内容）
 *   3. 大文本分块（chunkSize=2048, overlap=256）
 *   4. 附属脚本提取（scripts 数组）
 *   5. LLM-first 提取 + 启发式 fallback
 *
 * 纯函数模块，无 DOM / DI / LLM 调用，可单测。
 * LLM 调用由 `agentStudioService.extractSkillViaLLM()` 执行。
 */

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/** 从消息内容中提取出的技能组分 */
export interface IExtractedSkillComponents {
	/** 技能名称（slug 格式，如 "git-commit-guide"） */
	readonly name: string;
	/** 一行简短描述 */
	readonly description: string;
	/** 技能正文（markdown，不含 frontmatter） */
	readonly prompt: string;
	/** 可选分类目录名 */
	readonly category?: string;
	/** Hermes-Agent 兼容：适用平台 */
	readonly platforms?: readonly string[];
	/** Hermes-Agent 兼容：分类标签 */
	readonly tags?: readonly string[];
	/** Hermes-Agent 兼容：关联技能 ID 列表 */
	readonly relatedSkills?: readonly string[];
	/** 技能作者 */
	readonly author?: string;
	/** 技能许可证 */
	readonly license?: string;
	/** Skill 版本号（语义化版本） */
	readonly version?: string;
	/** 附属脚本 */
	readonly scripts?: readonly IExtractedSkillScript[];
}

/** 附属脚本定义 */
export interface IExtractedSkillScript {
	readonly filename: string;
	readonly content: string;
	readonly language: string;
}

/**
 * LLM 结构化提取结果 —— Hyper-Extract 的 Pydantic model 在 TS 的等价物。
 * 对应 LLM 返回的 JSON 对象，由 JSON Schema 约束。
 */
export interface ISkillExtractionLLMResult {
	/** 是否包含值得沉淀的可复用技能 */
	isSkill: boolean;
	/** 分类理由（"one-time task" / "reusable pattern" / "error report" 等） */
	reason: string;
	/** 技能名称（slug 格式） */
	name: string;
	/** 一行简短描述 */
	description: string;
	/** 可选分类 */
	category?: string;
	/** 技能正文（markdown） */
	prompt: string;
	/** 附属脚本 */
	scripts?: IExtractedSkillScript[];
}

/** buildSkillMd 的输入参数 */
export interface IBuildSkillMdOptions {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	readonly category?: string;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESC_MAX_LENGTH = 1024;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 从自由文本生成 slug 格式的 skill name。
 * 规则：
 *   - 取小写
 *   - 保留字母、数字、连字符、下划线、点
 *   - 空格/下划线→连字符
 *   - 连续非 slug 字符压缩为单个连字符
 *   - 截断到 64 字符
 *   - 如果为空，返回 "extracted-skill-{timestampHash}"
 */
export function toSkillSlug(raw: string): string {
	let slug = raw.trim();
	if (!slug) {
		return `extracted-skill-${Date.now().toString(36)}`;
	}

	slug = slug.toLowerCase();
	// 空格、中文标点 → 连字符
	slug = slug.replace(/[\s，。！？、：；""''（）【】《》]+/g, '-');
	// 保留 slug 合法字符，其余替换为连字符
	slug = slug.replace(/[^a-z0-9._-]/g, '-');
	// 连续连字符合并
	slug = slug.replace(/-{2,}/g, '-');
	// 首尾去连字符
	slug = slug.replace(/^-+|-+$/g, '');
	// 截断
	if (slug.length > SKILL_NAME_MAX_LENGTH) {
		slug = slug.slice(0, SKILL_NAME_MAX_LENGTH).replace(/-$/, '');
	}
	if (!slug) {
		return `extracted-skill-${Date.now().toString(36)}`;
	}
	return slug;
}

/**
 * 验证 skill name 是否满足 slug 格式要求。
 * 与 SkillManagerTool.validateSkillSlug 一致。
 */
export function isValidSkillSlug(name: string): boolean {
	if (!name || name.length > SKILL_NAME_MAX_LENGTH) { return false; }
	return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

// ─── Hyper-Extract: JSON Schema for Structured Output ─────────────────────

/**
 * 技能提取 JSON Schema —— 驱动 LLM structured output（TS 版 Pydantic schema）。
 * 仅 `isSkill` 为必填；当 isSkill=false 时其余字段可为空。
 * 与 Hyper-Extract 的 `DEFAULT_NODE_PROMPT` + Pydantic model 对齐。
 */
export const EXTRACT_SKILL_JSON_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		isSkill: {
			type: 'boolean',
			description: 'Whether this content contains a reusable skill worth extracting as a standalone SKILL.md'
		},
		reason: {
			type: 'string',
			description: 'Brief classification reason: "reusable pattern", "one-time task narrative", "error report", "casual chat", "configuration snippet", "tutorial step", "workaround technique", "environment-specific failure", etc.'
		},
		name: {
			type: 'string',
			description: 'Suggested skill name in lowercase slug format (e.g., "git-commit-guide", "k8s-deploy-rollback"). Only provide when isSkill=true.'
		},
		description: {
			type: 'string',
			description: 'One-line description of what the skill does and when to use it. Only provide when isSkill=true.'
		},
		category: {
			type: 'string',
			description: 'Optional category: "coding", "devops", "debugging", "testing", "architecture", "security", "data", "workflow". Only provide when isSkill=true.'
		},
		prompt: {
			type: 'string',
			description: 'Full skill body as markdown. Include clear instructions, steps, examples, and caveats. Should be self-contained enough that another LLM can execute it. Only provide when isSkill=true.'
		},
		scripts: {
			type: 'array',
			description: 'Any standalone executable scripts to extract alongside the skill (shell scripts, Python helpers, etc.). Only provide when isSkill=true and scripts are present.',
			items: {
				type: 'object',
				properties: {
					filename: { type: 'string', description: 'Script filename (e.g., "deploy.sh", "validate.py")' },
					content: { type: 'string', description: 'Full script source code' },
					language: { type: 'string', description: 'Script language identifier (sh, py, js, ts, sql, etc.)' }
				},
				required: ['filename', 'content', 'language']
			}
		}
	},
	required: ['isSkill']
};

/** LLM 提取结果的类型化校验：确保必填字段存在且 isSkill=true 时相关字段非空。 */
export function validateExtractionResult(raw: unknown): ISkillExtractionLLMResult | { error: string } {
	if (!raw || typeof raw !== 'object') {
		return { error: 'LLM returned non-object' };
	}
	const r = raw as Record<string, unknown>;

	if (typeof r.isSkill !== 'boolean') {
		return { error: 'Missing or invalid "isSkill" field' };
	}

	const result: ISkillExtractionLLMResult = {
		isSkill: r.isSkill,
		reason: typeof r.reason === 'string' ? r.reason : '',
		name: typeof r.name === 'string' ? r.name : '',
		description: typeof r.description === 'string' ? r.description : '',
		category: typeof r.category === 'string' ? r.category : undefined,
		prompt: typeof r.prompt === 'string' ? r.prompt : '',
	};

	if (r.isSkill) {
		// isSkill=true 时，关键字段必须存在
		if (!result.name) { return { error: 'isSkill=true but "name" is empty' }; }
		if (!result.prompt || result.prompt.length < 20) {
			return { error: 'isSkill=true but "prompt" is too short (<20 chars)' };
		}

		// 解析 scripts
		if (Array.isArray(r.scripts)) {
			const scripts: IExtractedSkillScript[] = [];
			for (const s of r.scripts) {
				if (typeof s === 'object' && s !== null) {
					const sc = s as Record<string, unknown>;
					if (typeof sc.filename === 'string' && typeof sc.content === 'string' && typeof sc.language === 'string') {
						scripts.push({ filename: sc.filename, content: sc.content, language: sc.language });
					}
				}
			}
			if (scripts.length > 0) { result.scripts = scripts; }
		}
	}

	return result;
}

// ─── Hyper-Extract: LLM Prompt Builder ────────────────────────────────────

/**
 * 构建技能提取 LLM prompt（Hyper-Extract 风格：角色扮演 + 约束 + 分类指导）。
 * 参考 Hermes-Agent 的 _SKILL_REVIEW_PROMPT 中的应捕获/应忽略分类。
 */
export function buildExtractSkillPrompt(content: string): string {
	const truncated = content.length > 6000 ? content.slice(0, 5997) + '...' : content;
	return [
		'You are a Skill Extraction Agent. Analyze the following conversation content and determine whether it contains a reusable skill worth extracting as a standalone SKILL.md file.',
		'',
		'CAPTURE (isSkill=true) — content that is a reusable pattern (teaches a repeatable technique):',
		'- User style corrections or workflow improvements',
		'- Non-trivial techniques, workarounds, debugging approaches',
		'- Tool usage patterns (command sequences, API workflows)',
		'- Configuration templates or boilerplate worth reusing',
		'- Multi-step processes that were successfully executed',
		'',
		'IGNORE (isSkill=false) — content that should NOT become a skill:',
		'- one-time task narratives ("today I deployed...")',
		'- Environment-specific failures ("my AWS key was wrong")',
		'- casual chat, greetings, small talk',
		'- Error messages without actionable workarounds',
		'- Pure code blocks without explanation of when/why to use them',
		'- Claims about tools being broken (transient issues)',
		'',
		'When isSkill=true, extract:',
		'1. name: lowercase slug (e.g., "git-rebase-workflow")',
		'2. description: one-line summary of what and when',
		'3. category: devops / coding / debugging / testing / architecture / security / data / workflow',
		'4. prompt: self-contained markdown with clear steps, examples, and caveats',
		'5. scripts: any standalone executable scripts (optional)',
		'',
		'CONVERSATION CONTENT:',
		truncated,
	].join('\n');
}

// ─── Hyper-Extract: Text Chunking (Large Message Support) ─────────────────

/** Chunking 默认参数（与 Hyper-Extract `DEFAULT_CHUNK_SIZE` / `DEFAULT_CHUNK_OVERLAP` 对齐） */
export const SKILL_EXTRACT_CHUNK_SIZE = 2048;
export const SKILL_EXTRACT_CHUNK_OVERLAP = 256;

/**
 * 将大段文本按 chunkSize 切分，保留 overlap 重叠区域。
 * Hyper-Extract 风格：优先在段落/句子边界切分。
 */
export function chunkLargeMessage(content: string, chunkSize: number = SKILL_EXTRACT_CHUNK_SIZE, overlap: number = SKILL_EXTRACT_CHUNK_OVERLAP): string[] {
	if (content.length <= chunkSize) { return [content]; }

	const chunks: string[] = [];
	let start = 0;

	while (start < content.length) {
		let end = Math.min(start + chunkSize, content.length);

		// 尝试在句子/段落边界断开
		if (end < content.length) {
			// 优先级: 双换行 → 单换行 → 句号 + 空格 → 空格
			const breakPoints = ['\n\n', '\n', '. ', '。', '！', '？', '! ', '? ', ' '];
			let bestBreak = -1;
			for (const sep of breakPoints) {
				const idx = content.lastIndexOf(sep, end);
				if (idx > start + chunkSize / 2) { bestBreak = idx + sep.length; break; }
			}
			if (bestBreak > 0) { end = bestBreak; }
		}

		chunks.push(content.slice(start, end));
		// 已覆盖到内容末尾 — 正常终止。
		// 否则 start 回退 overlap 后，下一轮 end 仍等于 content.length，原地死循环直至 OOM。
		if (end >= content.length) { break; }
		const prevStart = start;
		start = end - overlap;
		// 避免无限循环：确保前进（防御 overlap >= chunkSize 的异常参数）
		if (start <= prevStart) { start = end; }
	}

	return chunks;
}

/**
 * 快速意图预判（无需 LLM）：根据消息长度和关键词判断是否可能包含技能。
 * 用于在调 LLM 之前过滤掉明显不可能是技能的内容，节省 token。
 * 返回 false 时直接拒绝提取，不调 LLM。
 */
export function prefilterSkillIntent(content: string): { likely: boolean; reason: string } {
	const trimmed = content.trim();

	// 0. 纯代码块 → 无说明文字，不是技能。
	// 置于长度检查之前（纯代码块往往 <50 字符），但要求确实剥离了代码块，
	// 避免把普通的短文本误判为「纯代码块」。
	const codeBlockStripped = trimmed.replace(/```[\s\S]*?```/g, '').trim();
	if (codeBlockStripped.length < 30 && codeBlockStripped.length < trimmed.length) {
		return { likely: false, reason: 'content is almost entirely code blocks without explanation' };
	}

	// 1. 太短 → 不可能包含完整技能
	if (trimmed.length < 50) {
		return { likely: false, reason: 'content too short (<50 chars)' };
	}

	// 3. 指示性关键词：含步骤/流程/指南等词汇更可能是技能
	const skillIndicators = [
		/\b(步骤|流程|方法|技巧|指南|手册|规范|规则|模板|范式|模式|workflow|guide|pattern|template|best.?practice|how.?to)\b/i,
		/(^\s*#{1,3}\s+)/m,   // 有 markdown 标题结构
		/\b(when|whenever|if you (?:see|get|encounter|need|want))\b/i, // 条件触发式语言
	];
	const hasIndicator = skillIndicators.some(re => re.test(trimmed));

	// 4. 对话句式 → 不太可能是技能
	const chatPatterns = [
		/^(hi|hello|hey|thank|thanks|ok|okay|sure|yes|no|maybe)[\s,]/im,
		/\b(good morning|good afternoon|good evening|how are you)\b/i,
	];
	const isChat = chatPatterns.some(re => re.test(trimmed));

	if (isChat && !hasIndicator) {
		return { likely: false, reason: 'appears to be casual conversation, not a skill' };
	}

	return { likely: true, reason: hasIndicator ? 'contains skill indicators' : 'length sufficient, will attempt extraction' };
}

// ─── 纯函数：构建 SKILL.md ──────────────────────────────────────────────────

/**
 * 从组分构建完整的 SKILL.md 内容（YAML frontmatter + markdown body）。
 *
 * @param name 技能名（slug），用于 frontmatter name 字段
 * @param description 一行描述，用于 frontmatter description 字段
 * @param prompt 技能正文（markdown）
 * @param category 可选分类，写入 frontmatter category 字段
 * @returns 完整 SKILL.md 文本，以换行符 `\n` 分隔
 */
export function buildSkillMd(name: string, description: string, prompt: string, category?: string): string {
	return buildSkillMdFull({ name, description, prompt, category });
}

/**
 * 从完整组分构建 SKILL.md（含所有 Hermes-Agent 兼容字段）。
 * @param c 技能组分，只包含非空/非默认字段
 */
export function buildSkillMdFull(c: IExtractedSkillComponents): string {
	const lines: string[] = ['---'];
	lines.push(`name: "${escapeYamlValue(c.name)}"`);
	lines.push(`description: "${escapeYamlValue(c.description.slice(0, SKILL_DESC_MAX_LENGTH))}"`);
	if (c.category && c.category.trim()) {
		lines.push(`category: "${escapeYamlValue(c.category.trim())}"`);
	}
	if (c.version) {
		lines.push(`version: "${escapeYamlValue(c.version)}"`);
	}
	if (c.author) {
		lines.push(`author: "${escapeYamlValue(c.author)}"`);
	}
	if (c.license) {
		lines.push(`license: "${escapeYamlValue(c.license)}"`);
	}
	if (c.platforms && c.platforms.length > 0) {
		lines.push(`platforms: [${c.platforms.map(p => `"${escapeYamlValue(p)}"`).join(', ')}]`);
	}
	if (c.tags && c.tags.length > 0) {
		lines.push(`tags: [${c.tags.map(t => `"${escapeYamlValue(t)}"`).join(', ')}]`);
	}
	if (c.relatedSkills && c.relatedSkills.length > 0) {
		lines.push(`related_skills: [${c.relatedSkills.map(r => `"${escapeYamlValue(r)}"`).join(', ')}]`);
	}
	lines.push('---');
	lines.push('');
	// prompt 正文（保持原始缩进与空行）
	const body = c.prompt.trim();
	if (body) {
		lines.push(body);
	}
	lines.push(''); // trailing newline
	return lines.join('\n');
}

/**
 * 从 IExtractedSkillComponents 构建 SKILL.md（便捷包装）。
 */
export function buildSkillMdFromComponents(components: IExtractedSkillComponents): string {
	return buildSkillMdFull(components);
}

// ─── 纯函数：解析 SKILL.md ──────────────────────────────────────────────────

/**
 * 解析 SKILL.md 内容，提取 frontmatter 中各字段及正文。
 * @returns 解析结果，或 null（格式不符合 SKILL.md）
 */
export function parseSkillMd(content: string): IExtractedSkillComponents | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith('---')) { return null; }

	const endIdx = trimmed.indexOf('\n---', 3);
	if (endIdx < 0) { return null; }

	const fmBlock = trimmed.slice(4, endIdx); // 跳过 "---\n"
	const body = trimmed.slice(endIdx + 4).trim();

	const name = extractYamlField(fmBlock, 'name') ?? 'extracted-skill';
	const description = extractYamlField(fmBlock, 'description') ?? '';
	const category = extractYamlField(fmBlock, 'category');
	const version = extractYamlField(fmBlock, 'version');
	const author = extractYamlField(fmBlock, 'author');
	const license = extractYamlField(fmBlock, 'license');
	const platforms = extractYamlList(fmBlock, 'platforms');
	const tags = extractYamlList(fmBlock, 'tags');
	const relatedSkills = extractYamlList(fmBlock, 'related_skills');

	return { name, description, prompt: body, category: category || undefined, version: version || undefined, author: author || undefined, license: license || undefined, platforms: platforms || undefined, tags: tags || undefined, relatedSkills: relatedSkills || undefined };
}

// ─── 纯函数：从原始消息提取 ─────────────────────────────────────────────────

/**
 * 从消息内容中尝试提取技能名称。
 * 启发式优先级：
 *   1. 以 "# " 或 "## " 开头的第一行（去掉前缀）
 *   2. 第一行非空文本（最长 80 字符）
 *   3. 兜底 "extracted-skill"
 */
/**
 * 判断提取的名称是否质量足够（非过短、非纯数字、非纯符号）。
 * 返回 false 表示质量不足，应尝试下一个启发式。
 */
function isGoodSkillName(name: string): boolean {
	const trimmed = name.trim();
	// 过短（< 4 个可见字符）
	if (trimmed.length < 4) { return false; }
	// 纯数字或仅含少量字母（如 "2ms"、"123"、"v1"）
	if (/^[0-9a-z]{1,3}$/i.test(trimmed)) { return false; }
	// 纯符号/标点
	if (/^[^a-zA-Z0-9\u4e00-\u9fff]+$/.test(trimmed)) { return false; }
	return true;
}

export function tryExtractSkillName(content: string): string {
	const lines = content.split('\n');
	// 1. 找第一个 # 标题
	for (const line of lines) {
		const m = line.match(/^#{1,3}\s+(.+)/);
		if (m) {
			const title = m[1].trim();
			const name = title.length > 80 ? title.slice(0, 77) + '...' : title;
			if (isGoodSkillName(name)) { return name; }
			// 标题太短→继续找下一个
		}
	}
	// 2. 第一行有意义的非空文本（跳过质量不足的行）
	for (const line of lines) {
		const t = line.trim();
		if (t.length > 0 && isGoodSkillName(t)) {
			return t.length > 80 ? t.slice(0, 77) + '...' : t;
		}
	}
	// 3. 兜底：用时间戳生成唯一名
	return `extracted-skill-${Date.now().toString(36)}`;
}

/**
 * 从消息内容中尝试提取技能描述。
 * 启发式优先级：
 *   1. 第一段非空非标题文本（最多 200 字符）
 *   2. 兜底 "Extracted skill from chat message"
 */
export function tryExtractSkillDescription(content: string): string {
	const lines = content.split('\n');
	const paragraphs: string[] = [];
	let currentPara = '';

	for (const line of lines) {
		const t = line.trim();
		// 跳过标题行
		if (t.startsWith('#')) { continue; }
		// 跳过代码块
		if (t.startsWith('```')) { continue; }

		if (t.length === 0) {
			// 空行 → 段落结束
			if (currentPara.length > 10) {
				paragraphs.push(currentPara);
			}
			currentPara = '';
		} else {
			currentPara += (currentPara ? ' ' : '') + t;
		}
	}
	// 最后一段
	if (currentPara.length > 10) {
		paragraphs.push(currentPara);
	}

	for (const para of paragraphs) {
		if (para.length >= 20) {
			return para.length > 200 ? para.slice(0, 197) + '...' : para;
		}
	}
	return 'Extracted skill from chat message';
}

/**
 * 从消息内容中提取技能正文（prompt，去除 frontmatter 和标题）。
 * 规则：
 *   - 如果内容已经是 SKILL.md 格式（包含 --- frontmatter），返回 body 部分
 *   - 否则返回去除第一行标题后的全文
 */
export function tryExtractSkillPrompt(content: string): string {
	// 如果已经是 SKILL.md 格式
	if (content.trim().startsWith('---')) {
		const parsed = parseSkillMd(content);
		if (parsed) { return parsed.prompt; }
	}
	// 否则：去掉第一行标题后作为正文
	const lines = content.split('\n');
	const startIdx = lines[0]?.startsWith('#') ? 1 : 0;
	return lines.slice(startIdx).join('\n').trim();
}

/**
 * 综合提取：从消息内容中一次性提取技能的所有组分。
 * 这是「沉淀技能」按钮点击后调用的主函数。
 *
 * @param content 消息完整文本
 * @returns 提取出的技能组分（name 已转为 slug 并校验）
 */
export function extractSkillComponents(content: string): IExtractedSkillComponents {
	// 内容已是 SKILL.md 格式 → 以 frontmatter 字段为准（避免被正文首个标题抢走 name）
	if (content.trim().startsWith('---')) {
		const parsed = parseSkillMd(content);
		if (parsed) {
			return { ...parsed, name: isValidSkillSlug(parsed.name) ? parsed.name : toSkillSlug(parsed.name) };
		}
	}

	const rawName = tryExtractSkillName(content);
	const description = tryExtractSkillDescription(content);
	const prompt = tryExtractSkillPrompt(content);

	// 如果 name 已经是 slug 有效的（如 SKILL.md 内已有），直接使用
	let name: string;
	if (isValidSkillSlug(rawName)) {
		name = rawName;
	} else {
		// 否则转 slug
		name = toSkillSlug(rawName);
	}

	return { name, description, prompt, category: undefined, platforms: undefined, tags: undefined, relatedSkills: undefined, author: undefined, license: undefined };
}

// ─── 内部 helper ─────────────────────────────────────────────────────────────

/**
 * 转义 YAML 双引号字符串中的特殊字符（双引号、反斜杠）。
 */
function escapeYamlValue(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 从 YAML frontmatter 文本中提取指定字段值。
 * 支持带引号和不带引号的值。
 */
/**
 * 从 YAML frontmatter 中提取列表字段。
 * 支持两种格式：
 *   1. `key: [a, b, c]` — 内联数组
 *   2. `key:` + 缩进 `  - a` / `  - b` — 缩进列表
 */
function extractYamlList(fmBlock: string, key: string): string[] | undefined {
	// 1. 尝试内联数组
	const reInline = new RegExp(`^${key}:\\s*\\[(.*?)\\]`, 'im');
	const m = fmBlock.match(reInline);
	if (m) {
		const items = m[1].split(',').map(s => {
			let v = s.trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			return v;
		}).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	// 2. 尝试缩进列表
	const reBlock = new RegExp(`^${key}:\\s*$`, 'im');
	const keyMatch = fmBlock.match(reBlock);
	if (keyMatch) {
		const idx = fmBlock.indexOf(keyMatch[0]) + keyMatch[0].length;
		const rest = fmBlock.slice(idx);
		const items: string[] = [];
		const itemRe = /^\s+-\s+(.+)/gm;
		let im: RegExpExecArray | null;
		while ((im = itemRe.exec(rest)) !== null) {
			let v = im[1].trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			items.push(v);
		}
		if (items.length > 0) { return items; }
	}
	return undefined;
}

function extractYamlField(fmBlock: string, key: string): string | undefined {
	const re = new RegExp(`^${key}:\\s*(.+)`, 'im');
	const m = fmBlock.match(re);
	if (!m) { return undefined; }
	let val = m[1].trim();
	// 去掉首尾引号
	if ((val.startsWith('"') && val.endsWith('"')) ||
		(val.startsWith("'") && val.endsWith("'"))) {
		val = val.slice(1, -1);
		// 反转 escapeYamlValue 的转义（\\ → \，\" → "），保证 build→parse 往返一致
		val = val.replace(/\\(["\\])/g, '$1');
	}
	return val || undefined;
}
