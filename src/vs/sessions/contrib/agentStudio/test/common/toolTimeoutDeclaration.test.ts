/*---------------------------------------------------------------------------------------------
 *  工具超时**声明契约**（2026-10-12）。
 *
 *  背景：官方 dsh 把执行超时放在**工具自己的定义**上（`ToolDefinition.timeoutMs`），
 *  我们此前只有 `browser/toolExecutionGuard.ts` 里一张**按工具名/类别维护**的分级表
 *  —— 新工具忘了登记就静默落到 60s 默认。本次补上同名同义字段并让它**优先级最高**。
 *
 *  本文件钉住三件事（都非空跑）：
 *    ① **声明优先** —— 含 `0`（禁用）、含"表里已有档位"的工具（覆盖现象必须真的发生）；
 *    ② **未声明 / 非法声明 ⇒ 回落分级表** —— 逐档都钉，保证既有行为逐字不变；
 *    ③ **跨源码守卫** —— 字段必须**真的被消费**（防「加了字段没人读」的静默失效 ✗）；
 *       并发判定的两份名单**不得自相矛盾**（同一工具既"绝不并行"又"安全并行"）。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-toolTimeoutDeclaration-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DANGEROUS_TOOL_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
	DELEGATION_TOOL_TIMEOUT_MS,
	MCP_TOOL_TIMEOUT_MS,
	VIDEO_TOOL_TIMEOUT_MS,
	getTimeoutForTool,
} from '../../browser/toolExecutionGuard.js';
import { isParallelSafeReadOnlyTool } from '../../browser/toolCallUtils.js';
import type { IToolDefinition } from '../../common/providers.js';

/** 造一个最小合法定义（`IToolDefinition` 有三个必填字段）。 */
function def(name: string, extra: Partial<IToolDefinition> = {}): IToolDefinition {
	return { name, description: '', inputSchema: {}, ...extra };
}

/**
 * 危险档用**字符串字面量**而非 `ToolSecurityLevel.Dangerous`：后者是
 * `const enum`（`common/providers.ts:959`），在本目录的 esbuild 打包路径上
 * 取值形态不稳定；写错时下面的断言会立刻红（回落 60s ≠ 300s），不会静默通过。
 */
const DANGEROUS = { securityLevel: 'dangerous' as IToolDefinition['securityLevel'] };

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 取某函数体的文本切片（到下一个顶层 `export ` 为止），避免"读了别的函数也算过"。 */
function bodyOf(src: string, signature: string): string {
	const start = src.indexOf(signature);
	assert.ok(start > 0, `未找到 \`${signature}\`（改名了？守卫需同步更新 ✗）`);
	const rest = src.slice(start + signature.length);
	const next = rest.indexOf('\nexport ');
	return next > 0 ? rest.slice(0, next) : rest;
}

/** 从源码里抓 `const <name> = new Set([...])` 的名字字面量；解析不到返回 null。 */
function grabNameSet(src: string, constName: string): string[] | null {
	const m = new RegExp(`const ${constName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`, 'm').exec(src);
	return m ? [...m[1].matchAll(/"([a-zA-Z0-9_]+)"/g)].map(x => x[1]) : null;
}

suite('工具超时声明 — 声明优先于分级表（对齐 dsh 官方 ToolDefinition.timeoutMs）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('声明值直接生效（默认档工具）', () => {
		assert.strictEqual(
			getTimeoutForTool('file_read', def('file_read', { timeoutMs: 12_345 })),
			12_345,
			'声明了 timeoutMs 就必须原样生效，不得落回默认 60s',
		);
	});

	test('声明可**覆盖**分级表已有的档位（execute_code: 0 → 声明值）', () => {
		assert.strictEqual(getTimeoutForTool('execute_code'), DELEGATION_TOOL_TIMEOUT_MS,
			'前提：未声明时 execute_code 走"禁用守卫超时"档');
		assert.strictEqual(
			getTimeoutForTool('execute_code', def('execute_code', { timeoutMs: 1_000 })),
			1_000,
			'显式声明必须能覆盖类别推断（否则就是"声明了却不生效"的静默失效 ✗）',
		);
	});

	test('声明可覆盖「危险工具」档（securityLevel=dangerous 未声明时才 300s）', () => {
		assert.strictEqual(
			getTimeoutForTool('whatever', def('whatever', { ...DANGEROUS })),
			DANGEROUS_TOOL_TIMEOUT_MS,
			'前提：未声明时危险工具拿 300s（含审批等待）',
		);
		assert.strictEqual(
			getTimeoutForTool('whatever', def('whatever', { ...DANGEROUS, timeoutMs: 7 })),
			7,
		);
	});

	test('声明 `0` = 禁用守卫 wall-clock 超时（与编排类同一语义）', () => {
		assert.strictEqual(getTimeoutForTool('file_read', def('file_read', { timeoutMs: 0 })), 0);
	});

	test('非法声明值（负数 / NaN / Infinity）不生效 ⇒ 静默回落分级表（fail-safe）', () => {
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.strictEqual(
				getTimeoutForTool('file_read', def('file_read', { timeoutMs: bad })),
				DEFAULT_TOOL_TIMEOUT_MS,
				`非法值 ${String(bad)} 不得生效（写错的超时不该让工具变成"永不超时"）`,
			);
		}
	});

	test('未声明 ⇒ 逐档回落（既有行为逐字不变）', () => {
		assert.strictEqual(getTimeoutForTool('file_read'), DEFAULT_TOOL_TIMEOUT_MS, '默认档');
		assert.strictEqual(getTimeoutForTool('video_analyze'), VIDEO_TOOL_TIMEOUT_MS, '视频档（15min）');
		assert.strictEqual(getTimeoutForTool('extract_video_frames'), VIDEO_TOOL_TIMEOUT_MS);
		assert.strictEqual(getTimeoutForTool('execute_code'), DELEGATION_TOOL_TIMEOUT_MS, '自管超时档');
		assert.strictEqual(getTimeoutForTool('process'), DELEGATION_TOOL_TIMEOUT_MS);
		assert.strictEqual(getTimeoutForTool('delegate_task'), DELEGATION_TOOL_TIMEOUT_MS, '编排档');
		assert.strictEqual(getTimeoutForTool('mcp__probe__probe_ping'), MCP_TOOL_TIMEOUT_MS, 'MCP（名字含 __）');
		assert.strictEqual(getTimeoutForTool('whatever', undefined, 'mcp-server-x'), MCP_TOOL_TIMEOUT_MS, 'MCP（source 含 mcp）');
		assert.strictEqual(getTimeoutForTool('whatever', def('whatever', { ...DANGEROUS })), DANGEROUS_TOOL_TIMEOUT_MS);
		assert.strictEqual(getTimeoutForTool('get_architecture'), 30_000, '代码图谱分析档（fail fast）');
		assert.strictEqual(getTimeoutForTool('terminal'), MCP_TOOL_TIMEOUT_MS, '已知慢工具档');
	});

	test('未传 toolDef 也不炸（三条生产调用点之一可能拿不到定义）', () => {
		assert.strictEqual(getTimeoutForTool('file_read', undefined, undefined), DEFAULT_TOOL_TIMEOUT_MS);
	});
});

suite('工具超时声明 — 跨源码守卫', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ `getTimeoutForTool` 必须真的读 `toolDef?.timeoutMs`（防「加了字段没人消费」）', () => {
		const src = readSource(`${DOMAIN_REL}/browser/toolExecutionGuard.ts`);
		const body = bodyOf(src, 'export function getTimeoutForTool(');
		// ⚠ 必须带右边界：不带边界的 `/toolDef\?\.timeoutMs/` 会**错放** `toolDef?.timeoutMsXxx`
		//   （前缀匹配）—— 2026-10-12 的反向突变实测抓出来的，别退回宽松写法 ✗。
		assert.ok(/toolDef\?\.timeoutMs(?![A-Za-z0-9_])/.test(body),
			'getTimeoutForTool 里找不到对 `toolDef?.timeoutMs` 的读取 —— '
			+ '字段被声明却没人消费，`IToolDefinition.timeoutMs` 会退化成装饰性字段 ✗');
		assert.ok(/Number\.isFinite/.test(body),
			'缺少非法值防护（负数 / NaN / Infinity 必须回落分级表）✗');
	});

	test('★★ 并发判定两份名单不得自相矛盾（同一工具既「绝不并行」又「安全并行」）', () => {
		const src = readSource(`${DOMAIN_REL}/browser/toolCallUtils.ts`);
		const never = grabNameSet(src, 'NEVER_PARALLEL_TOOLS');
		const safe = grabNameSet(src, 'PARALLEL_SAFE_TOOLS');
		assert.ok(never && never.length >= 5,
			`解析 NEVER_PARALLEL_TOOLS 失败或过小（${never ? never.length : 'null'}）—— 守卫正则失配，别当成通过 ✗`);
		assert.ok(safe && safe.length >= 10,
			`解析 PARALLEL_SAFE_TOOLS 失败或过小（${safe ? safe.length : 'null'}）—— 守卫正则失配，别当成通过 ✗`);

		const overlap = safe.filter(n => never.includes(n));
		assert.deepStrictEqual(overlap, [],
			`同一工具不能同时进两份名单（判据自相矛盾）：${overlap.join(', ')}`);

		// 行为面复核：NEVER 名单里的每个名字，`isParallelSafeReadOnlyTool` 都必须为 false。
		for (const name of never) {
			assert.strictEqual(isParallelSafeReadOnlyTool(name), false,
				`"${name}" 在 NEVER_PARALLEL_TOOLS 里，却同时对 isParallelSafeReadOnlyTool 返回 true ✗`);
		}
	});
});
