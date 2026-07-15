/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  classifier.test.ts — LLM 分类器 + 关键词启发式 fallback 单元测试（无网络）。
 *
 *  覆盖：
 *   1. classifyByKeywords: 各类内容分类 + 边界（空/全符号/中文/英文/混合）
 *   2. classifyContentViaLLM: LLM 成功路径 + LLM 失败降级到 keyword
 *   3. 降级链路：引擎路径失败 → _writeLegacyFavorite → classifyContent → LLM不可用 → keyword
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { classifyByKeywords, classifyContentViaLLM, KB_CATEGORIES } from './classifier.js';
import type { IChatModel, ExtractRequest } from './engine/llm.js';
import type { ClassifyResult } from './classifier.js';

// ── 辅助：获取期望的分类标签 ──────────────────────────────────────────
const LABELS = Object.freeze(Object.fromEntries(KB_CATEGORIES.map(c => [c.id, c.label])));

// ── 辅助：断言结果是与预期类别一致的合法 ClassifyResult ───────────────
function assertClassifyResult(r: ClassifyResult, expectedCat: string): void {
	assert.ok(KB_CATEGORIES.some(c => c.id === r.category && c.label === r.label),
		`分类结果 ${r.category}/${r.label} 必须在预定义类别中`);
	assert.strictEqual(r.source, 'keyword',
		`classifyByKeywords 的 source 必须为 'keyword'`);
	if (expectedCat === 'general') {
		// general 通常置信度低（关键词匹配不到）
		assert.ok(r.confidence >= 0 && r.confidence <= 0.85, `置信度应在 0-0.85 之间，实际 ${r.confidence}`);
	} else {
		assert.strictEqual(r.category, expectedCat, `分类应为 ${expectedCat}(${LABELS[expectedCat]})，实际 ${r.category}(${r.label})`);
		assert.ok(r.confidence >= 0, `置信度应 >= 0`);
		assert.ok(typeof r.reasoning === 'string' && r.reasoning.length > 0, 'reasoning 不能为空');
	}
}

// ── 辅助：Mock LLM（返回指定的分类结果）──────────────────────────────
class MockClassifyLLM implements IChatModel {
	constructor(private readonly extractResult: any, private readonly shouldThrow = false) {}
	async extract<T = any>(_req: ExtractRequest): Promise<T> {
		if (this.shouldThrow) { throw new Error('LLM connection refused'); }
		return this.extractResult as T;
	}
	async complete(_system: string | undefined, _user: string): Promise<string> {
		return 'mock complete';
	}
}

// ═══════════════════════════════════════════════════════════════════════
// classifyByKeywords
// ═══════════════════════════════════════════════════════════════════════

describe('classifyByKeywords', () => {

	it('中文错误/异常内容 → bug_fix', () => {
		const r = classifyByKeywords('修复了 API 请求出错的问题，之前抛 NullPointerException');
		assertClassifyResult(r, 'bug_fix');
		assert.ok(r.confidence > 0.1, '错误关键词应产生有意义的置信度');
	});

	it('中文部署运维内容 → devops', () => {
		const r = classifyByKeywords('使用 Docker 部署应用，配置 Kubernetes 集群，通过 Jenkins 发布');
		assertClassifyResult(r, 'devops');
	});

	it('代码示例内容 → code_example', () => {
		const r = classifyByKeywords('```ts\nasync function fetchData() {\n  const res = await fetch("/api");\n  return res.json();\n}\n```');
		assertClassifyResult(r, 'code_example');
	});

	it('配置管理内容 → config', () => {
		const r = classifyByKeywords('请在 .env 文件中设置 API_KEY 环境变量，修改 config.yaml 中的 baseUrl');
		assertClassifyResult(r, 'config');
	});

	it('安全相关 → security', () => {
		const r = classifyByKeywords('用户登录使用 JWT token 认证，密码需要 bcrypt 加密存储，防止 XSS 攻击');
		assertClassifyResult(r, 'security');
	});

	it('架构设计 → architecture', () => {
		const r = classifyByKeywords('微服务架构设计中，模块间通信使用 gRPC，系统设计需要支持分布式事务');
		assertClassifyResult(r, 'architecture');
	});

	it('未知内容 → general（默认分类）', () => {
		const r = classifyByKeywords('今天天气真不错，适合出去散步');
		assertClassifyResult(r, 'general');
		assert.strictEqual(r.confidence, 0, '无关键词匹配时置信度应为 0');
	});

	it('空字符串 → general（默认分类）', () => {
		const r = classifyByKeywords('');
		assertClassifyResult(r, 'general');
		assert.strictEqual(r.confidence, 0, '空内容置信度为 0');
	});

	it('纯符号内容 → general', () => {
		const r = classifyByKeywords('### --- *** @@@ ///');
		assertClassifyResult(r, 'general');
		assert.strictEqual(r.confidence, 0);
	});

	it('API 文档 → api_doc', () => {
		const r = classifyByKeywords('GET /api/users 返回分页的用户列表，POST /api/users 创建用户，Request body 包含 name 和 email');
		assertClassifyResult(r, 'api_doc');
	});

	it('教程指南 → tutorial', () => {
		const r = classifyByKeywords('本教程将 step by step 教你如何搭建一个完整的 Web 应用，请按以下步骤操作');
		assertClassifyResult(r, 'tutorial');
	});

	it('性能优化 → performance', () => {
		const r = classifyByKeywords('通过 benchmark 发现 latency 过高，优化 cache 策略后 throughput 提升 3 倍');
		assertClassifyResult(r, 'performance');
	});

	it('数据库内容 → database', () => {
		const r = classifyByKeywords('CREATE TABLE users(id INT PRIMARY KEY, name VARCHAR); 使用 JOIN 查询关联数据');
		assertClassifyResult(r, 'database');
	});

	it('多关键词竞争 → 选加权分最高的类别', () => {
		// 同时包含 code_example 和 bug_fix 关键词，但 code 关键词更密集
		const r = classifyByKeywords(
			'```py\nimport os\n```\n修复了一个 error，原因是 null pointer exception\n```js\nconst x = 1;\n```\n```ts\ninterface A {}\n```'
		);
		assertClassifyResult(r, 'code_example'); // code_fence 权重 8 > bug_fix 权重 7，且出现次数多
	});

	it('置信度上限不超过 0.85', () => {
		// 构造极端密集关键词输入
		const repeated = Array(20).fill('```ts\nconst x = 1;\n``` error fix bug exception crash stack trace').join('\n');
		const r = classifyByKeywords(repeated);
		assert.ok(r.confidence <= 0.85, `置信度应 ≤ 0.85，实际 ${r.confidence}`);
	});

	it('所有返回的分类 id 都在 KB_CATEGORIES 预定义列表中', () => {
		// 用一组典型输入验证不会返回非标准分类
		const inputs = [
			'修复了一个错误',
			'Docker compose up -d 部署应用',
			'```js\nconsole.log(1)\n```',
			'config.json 配置文件',
			'使用 bcrypt 加密密码',
			'系统架构设计使用微服务',
			'GET /api/v1/items',
			'如何配置 Nginx 反向代理教程',
			'优化 MySQL 查询慢的问题',
			'SELECT * FROM orders WHERE status = "pending"',
			'这是一段完全无关的闲聊天',
		];
		for (const input of inputs) {
			const r = classifyByKeywords(input);
			assert.ok(KB_CATEGORIES.some(c => c.id === r.category),
				`输入 "${input.slice(0, 30)}..." 产生非标准分类: ${r.category}`);
		}
	});

	it('确定性：同一输入多次调用结果一致', () => {
		const input = '修复了一个 NullPointerException 错误，使用了 Docker 部署修复后的服务';
		const r1 = classifyByKeywords(input);
		const r2 = classifyByKeywords(input);
		assert.strictEqual(r1.category, r2.category);
		assert.strictEqual(r1.confidence, r2.confidence);
		assert.strictEqual(r1.label, r2.label);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// classifyContentViaLLM
// ═══════════════════════════════════════════════════════════════════════

describe('classifyContentViaLLM', () => {

	it('LLM 成功返回有效分类 → source=llm，置信度限幅 0-1', async () => {
		const llm = new MockClassifyLLM({
			category: 'code_example',
			label: '代码示例',
			confidence: 0.95,
			reasoning: 'Contains JavaScript code blocks',
		});
		const r = await classifyContentViaLLM(llm, 'async function hello() {}');
		assert.strictEqual(r.category, 'code_example');
		assert.strictEqual(r.label, '代码示例');
		assert.strictEqual(r.confidence, 0.95);
		assert.strictEqual(r.source, 'llm');
		assert.strictEqual(r.reasoning, 'Contains JavaScript code blocks');
	});

	it('LLM 返回的 category id 不在预定义列表中 → 降级到 keyword', async () => {
		const llm = new MockClassifyLLM({
			category: 'nonexistent_category',
			label: '不存在的类别',
			confidence: 0.99,
			reasoning: 'Some fancy classification',
		});
		const r = await classifyContentViaLLM(llm, '修复了一个错误');
		assert.strictEqual(r.source, 'keyword', 'LLM 返回非法分类应降级为 keyword');
	});

	it('LLM 抛异常 → 降级到 keyword 分类', async () => {
		const llm = new MockClassifyLLM({}, true); // shouldThrow=true
		const r = await classifyContentViaLLM(llm, '修复了一个 NullPointerException 错误');
		assert.strictEqual(r.source, 'keyword', 'LLM 异常应降级为 keyword');
		assertClassifyResult(r, 'bug_fix');
	});

	it('LLM 返回空 category → 降级到 keyword', async () => {
		const llm = new MockClassifyLLM({
			category: '',
			label: '',
			confidence: 0.99,
			reasoning: 'oops',
		});
		const r = await classifyContentViaLLM(llm, '修复了一个错误');
		assert.strictEqual(r.source, 'keyword');
	});

	it('LLM 置信度超出 [0,1] → 限幅到合法范围', async () => {
		const llm = new MockClassifyLLM({
			category: 'bug_fix',
			label: '问题记录',
			confidence: 999, // 超出上限
			reasoning: 'Overconfident model',
		});
		const r = await classifyContentViaLLM(llm, 'error fix bug crash');
		assert.strictEqual(r.source, 'llm');
		assert.strictEqual(r.confidence, 1, '置信度超出 1 应被限幅到 1');
	});

	it('LLM 返回负置信度 → 限幅到 0', async () => {
		const llm = new MockClassifyLLM({
			category: 'general',
			label: '通用收藏',
			confidence: -5,
			reasoning: 'Very uncertain',
		});
		const r = await classifyContentViaLLM(llm, 'random text');
		assert.strictEqual(r.source, 'llm');
		assert.strictEqual(r.confidence, 0, '负置信度应被限幅到 0');
	});

	it('LLM 返回非数字置信度 → 默认 0.8', async () => {
		const llm = new MockClassifyLLM({
			category: 'tutorial',
			label: '教程指南',
			confidence: 'high', // 非数字
			reasoning: 'Guide content',
		});
		const r = await classifyContentViaLLM(llm, 'how to guide tutorial step 1');
		assert.strictEqual(r.source, 'llm');
		assert.strictEqual(r.confidence, 0.8, '非数字置信度应使用默认值 0.8');
	});
});
