/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — LLM-driven content classifier
 *
 *  Replicates Hyper-Extract's `guideline.target` role-playing + structured-output
 *  classification pattern. 给定一段内容，用 LLM 进行领域/类别判断（替代纯关键词匹配）。
 *
 *  Fallback: 若 LLM 不可用/超时，退回到关键词启发式分类。
 *--------------------------------------------------------------------------------------------*/

import { IChatModel } from './engine/llm.js';

/** 预定义分类标签（对齐 Hyper-Extract 模板领域分组）。 */
export const KB_CATEGORIES: readonly KBCategoryDef[] = Object.freeze([
	{ id: 'code_example',	label: '代码示例',		desc: '包含代码片段、实现逻辑、语言特性的内容' },
	{ id: 'api_doc',		label: 'API 文档',		desc: '关于 API 端点、请求响应格式、接口定义' },
	{ id: 'architecture',	label: '架构设计',		desc: '系统架构、设计模式、组件关系、技术选型' },
	{ id: 'bug_fix',		label: '问题记录',		desc: '错误、bug、异常处理、故障排查、修复方案' },
	{ id: 'config',			label: '配置管理',		desc: '环境变量、配置文件、设置参数' },
	{ id: 'tutorial',		label: '教程指南',		desc: '教学、步骤说明、操作指南、how-to' },
	{ id: 'performance',	label: '性能优化',		desc: '性能调优、benchmark、缓存策略、资源优化' },
	{ id: 'security',		label: '安全相关',		desc: '认证授权、加密、安全漏洞、防护措施' },
	{ id: 'devops',			label: '部署运维',		desc: 'CI/CD、容器化、Docker、Kubernetes、部署发布' },
	{ id: 'database',		label: '数据库',		desc: 'SQL、数据模型、查询优化、存储引擎' },
	{ id: 'general',		label: '通用收藏',		desc: '无法归入以上类别的一般性知识内容' },
]);

export interface KBCategoryDef {
	readonly id: string;
	readonly label: string;
	readonly desc: string;
}

export interface ClassifyResult {
	/** 匹配到的分类 ID（如 'code_example'）*/
	readonly category: string;
	/** 分类标签（如 '代码示例'）*/
	readonly label: string;
	/** 置信度 0-1 */
	readonly confidence: number;
	/** LLM 给出的分类理由（便于审计/调试）*/
	readonly reasoning: string;
	/** 来源：'llm' | 'keyword' */
	readonly source: 'llm' | 'keyword';
}

/** 构建分类 prompt（Hyper-Extract 风格：角色扮演 + 约束 + structured output）。 */
function buildClassificationPrompt(categories: readonly KBCategoryDef[], content: string): string {
	const catList = categories.map(c => `- **${c.label}** (${c.id}): ${c.desc}`).join('\n');
	// 截断过长内容以节省 token
	const truncated = content.length > 3000 ? content.slice(0, 2997) + '...' : content;
	return [
		'你是一位知识分类专家，负责将文本内容准确分类到预定义的知识类别中。',
		'',
		'## 分类规则',
		'1. 仔细阅读内容，判断其最主要的主题和用途',
		'2. 从下面可选类别中选择最匹配的一个',
		'3. 如果有多个可能类别，选择最核心、最具体的那个',
		'4. confidence 反映分类的确定性（0.0-1.0，单一主题 0.9+，模糊 0.5-0.7）',
		'5. reasoning 中简要说明为什么选择这个类别（一句话即可）',
		'',
		'## 可选类别',
		catList,
		'',
		'## 待分类内容',
		'```',
		truncated,
		'```',
		'',
		'严格按以下 JSON 格式输出（不要输出其他内容）：',
		'{"category": "(类别 id)", "label": "(类别标签)", "confidence": 0.95, "reasoning": "(分类理由)"}',
	].join('\n');
}

/** 关键词启发式分类（LLM 不可用时的 fallback）。使用频率加权而非首次匹配。 */
export function classifyByKeywords(content: string): ClassifyResult {
	const lower = content.slice(0, 2000).toLowerCase();
	const patterns: Array<{ id: string; label: string; keywords: string[]; weight: number }> = [
		{ id: 'code_example', label: '代码示例', keywords: ['function ', 'async ', 'class ', 'interface ', 'const ', 'let ', 'import ', 'export ', '```ts', '```js', '```py', '```go', '```rust', '```java', '```css', '```html', '```typescript', '```javascript', '```python', '```'], weight: 8 },
		{ id: 'api_doc', label: 'API 文档', keywords: ['api', 'endpoint', 'rest ', 'graphql', 'post ', 'get ', 'put ', 'delete ', 'patch', 'request', 'response'], weight: 4 },
		{ id: 'architecture', label: '架构设计', keywords: ['architecture', 'design pattern', 'component', 'module', 'system design', 'microservice', '架构', '设计模式', '模块', '系统设计', '微服务'], weight: 6 },
		{ id: 'bug_fix', label: '问题记录', keywords: ['error', 'exception', 'failed', 'bug', 'issue', 'fix', '修复', '错误', '异常', '失败', 'crash', 'stack trace'], weight: 7 },
		{ id: 'config', label: '配置管理', keywords: ['config', 'setting', 'env', '.env', '变量', '配置', '设置', '环境变量', 'yaml', '.json'], weight: 3 },
		{ id: 'tutorial', label: '教程指南', keywords: ['tutorial', 'guide', 'how to', 'step', 'example', '教程', '指南', '示例', '步骤', 'walkthrough'], weight: 5 },
		{ id: 'performance', label: '性能优化', keywords: ['performance', 'optimize', 'benchmark', 'fast', 'slow', 'memory', '性能', '优化', '加速', '内存', 'latency', 'throughput', 'cache'], weight: 5 },
		{ id: 'security', label: '安全相关', keywords: ['security', 'auth', 'token', 'password', 'encrypt', '安全', '认证', '加密', '密码', 'jwt', 'oauth', 'csrf', 'xss'], weight: 5 },
		{ id: 'devops', label: '部署运维', keywords: ['deploy', 'ci/cd', 'pipeline', 'docker', 'kubernetes', '部署', '容器', '发布', 'helm', 'terraform', 'ansible', 'jenkins'], weight: 5 },
		{ id: 'database', label: '数据库', keywords: ['database', 'sql', 'query', 'mysql', 'postgres', 'mongo', '数据', '查询', '存储', 'table', 'index', 'join', 'orm'], weight: 5 },
	];
	let best: ClassifyResult = { category: 'general', label: '通用收藏', confidence: 0, reasoning: '未匹配任何关键词模式', source: 'keyword' };
	let bestScore = 0;
	for (const p of patterns) {
		let score = 0;
		for (const kw of p.keywords) {
			const count = lower.split(kw).length - 1;
			score += count * 3;
		}
		score *= p.weight;
		if (score > bestScore) {
			bestScore = score;
			best = { category: p.id, label: p.label, confidence: Math.min(0.85, score / 60), reasoning: `关键词加权匹配 (score=${score.toFixed(0)})`, source: 'keyword' };
		}
	}
	return best;
}

/**
 * LLM 驱动的智能分类（主流程，复刻 Hyper-Extract 模式）。
 *
 * @param llm  IChatModel 实例（与 kb_build 共享同一个 LLM 客户端）
 * @param content 待分类文本
 * @param signal 可选中止信号
 * @returns ClassifyResult（失败时自动降级到 keyword fallback）
 */
export async function classifyContentViaLLM(
	llm: IChatModel,
	content: string,
	signal?: AbortSignal,
): Promise<ClassifyResult> {
	try {
		// 4000 char timeout → 快速分类
		if (signal?.aborted) { return classifyByKeywords(content); }

		const prompt = buildClassificationPrompt(KB_CATEGORIES, content);
		const result = await llm.extract({
			prompt,
			schema: {
				type: 'object',
				properties: {
					category: { type: 'string', description: 'The most likely category id from the predefined list' },
					label: { type: 'string', description: 'The category label matching the picked id' },
					confidence: { type: 'number', description: 'Confidence score 0.0 to 1.0', minimum: 0, maximum: 1 },
					reasoning: { type: 'string', description: 'One-line rationale for the classification' },
				},
				required: ['category', 'label', 'confidence', 'reasoning'],
			} as any,
			abortSignal: signal,
		});

		const parsed = (result as any)?.parsed ?? result;
		const categoryId = typeof parsed?.category === 'string' ? parsed.category : '';
		const catDef = KB_CATEGORIES.find(c => c.id === categoryId) ?? KB_CATEGORIES.find(c => c.label === parsed?.label);
		if (!catDef || !categoryId) {
			return classifyByKeywords(content);
		}
		return {
			category: catDef.id,
			label: catDef.label,
			confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.8,
			reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'LLM classified',
			source: 'llm',
		};
	} catch (err) {
		// LLM 不可用/超时 → 降级到关键词分类
		return classifyByKeywords(content);
	}
}
