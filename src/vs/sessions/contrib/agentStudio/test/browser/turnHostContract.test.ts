/*---------------------------------------------------------------------------------------------
 *  turnHost 契约测试（阶段 4 / 方案 A，2026-09-17）
 *
 *  背景：`executeAgentTurnDirect` 的首参曾是 `host: any`，导致 4000 行函数体内
 *  64 个 `host._xxx` 成员访问**全部没有编译期检查** —— 拼错成员名、改错参数个数
 *  都要等到运行时才炸。
 *
 *  阶段 4 把首参收窄为 `ITurnHost`（`browser/turnHost.ts`），并把不可避免的
 *  不安全转型收敛到唯一调用点 `agentOSService.ts::_executeWithFallbackDirectly`
 *  的一行 `this as unknown as ITurnHost`（宿主 26 个成员是 `private`，而 TS 的
 *  `private` 不参与结构类型匹配，直接传 `this` 会报 TS2345）。
 *
 *  本文件用**源码级断言**锚定这个结果，防止后人把首参改回 `any`（那样会静默
 *  失去全部 64 个成员的类型检查，且编译依然通过 —— 没有测试就无法发现）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';

const AGENT_STUDIO_ROOT = path.resolve(process.cwd(), 'src/vs/sessions/contrib/agentStudio');

function readSource(relativePath: string): string {
	return readFileSync(path.join(AGENT_STUDIO_ROOT, relativePath), 'utf8');
}

suite('turnHost 契约 — host 参数类型收口（禁止回退到 any）', () => {

	test('executeAgentTurnDirect 首参必须是 ITurnHost，不得是 any', () => {
		const source = readSource('browser/agentTurnExecutor.ts');
		const signature = /export async function\* executeAgentTurnDirect\(\s*host:\s*([A-Za-z0-9_]+)/.exec(source);

		assert.ok(signature, '未找到 executeAgentTurnDirect 的导出签名 —— 函数被重命名或签名格式变了，请同步本测试');
		assert.strictEqual(
			signature![1],
			'ITurnHost',
			`executeAgentTurnDirect 首参类型是 "${signature![1]}"，期望 "ITurnHost"。`
			+ '\n改回 any 会让函数体内 64 个 host._xxx 成员访问静默失去类型检查（编译仍会通过）。'
			+ '\n若确需放宽，请先在 turnHost.ts 记录理由，并同步本断言。',
		);
	});

	test('ITurnHost 由 5 个分面组合，且分面本身都已导出', () => {
		const source = readSource('browser/turnHost.ts');

		const composition = /export type ITurnHost\s*=\s*([^;]+);/.exec(source);
		assert.ok(composition, '未找到 ITurnHost 的组合定义');

		const facets = [
			'ITurnInitHost',
			'ITurnHostCounters',
			'ITurnHostLifecycle',
			'ITurnHostSandbox',
			'ITurnHostExecution',
		];
		for (const facet of facets) {
			assert.ok(
				composition![1].includes(facet),
				`ITurnHost 的组合里缺少分面 ${facet} —— 移除分面会让对应成员访问失去检查`,
			);
			assert.ok(
				new RegExp(`export (?:interface|type) ${facet}\\b`).test(source),
				`分面 ${facet} 未从 turnHost.ts 导出`,
			);
		}
	});

	test('不安全转型只允许存在于唯一调用点，且必须带 ITurnHost 目标类型', () => {
		const source = readSource('browser/agentOSService.ts');
		const casts = source.match(/this as unknown as ITurnHost/g) ?? [];

		assert.strictEqual(
			casts.length,
			1,
			`agentOSService.ts 中 "this as unknown as ITurnHost" 出现 ${casts.length} 次，期望恰好 1 次（单点收口）。`
			+ '\n出现多次说明 executor 有了第二个调用入口 —— 应先收敛入口，而不是复制转型。',
		);

		assert.ok(
			/yield\* executeAgentTurnDirect\(this as unknown as ITurnHost,/.test(source),
			'executeAgentTurnDirect 的调用点未使用 ITurnHost 转型 —— 若已改为其它写法，请同步本断言',
		);
	});

	test('turnHost.ts 保留「private 不参与结构匹配」的边界说明', () => {
		const source = readSource('browser/turnHost.ts');

		assert.ok(
			source.includes('private'),
			'turnHost.ts 丢失了 private 可见性的边界说明 —— 后人会重复踩 TS2345 的坑',
		);
		assert.ok(
			/TS2345/.test(source) || /结构类型匹配/.test(source),
			'turnHost.ts 应说明为什么顶层不能直接传 this（TS2345 / private 不参与结构类型匹配）',
		);
	});
});

suite('checkpoint 续跑契约 — phase 不得驱动断点重放', () => {

	/**
	 * 快照里存在 `phase` 字段（`AgentRunState.phase`），但它对续跑**不可用**：
	 * checkpoint 每 3 轮才落盘，恢复出的 phase 最多陈旧 3 轮，无法回答
	 * 「这批工具执行了没有」。据此跳过 LLM 直接执行工具会重复执行副作用工具。
	 *
	 * 该风险纯属语义约定、无编译期约束，故用源码级断言锁死。
	 */
	test('resumeFrom 恢复不得读取 restored.phase / resumeFrom.phase', () => {
		const source = readSource('browser/agentTurnExecutor.ts');

		// 必须先剥离注释：恢复块的说明文字里**故意**写了该字段名（解释为何不用它），
		// 直接全文匹配会被自己的文档命中，把守护变成永久红灯。
		const codeOnly = source
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');

		const forbidden = codeOnly.match(/\b(?:restored|resumeState|resumeFrom)\s*(?:\?)?\.\s*phase\b/g);
		assert.strictEqual(
			forbidden, null,
			`检测到从 checkpoint 快照读取 phase：${JSON.stringify(forbidden)}。\n` +
			'checkpoint 每 3 轮落盘（iteration % 3），phase 可能陈旧 3 轮 —— 据此跳过 LLM ' +
			'直接执行工具会重复执行副作用工具（写文件/跑命令/发请求）。\n' +
			'若确需断点恢复精度，先让 checkpoint 每轮落盘并记录工具批次 settled 状态。',
		);
	});

	test('落盘频率仍是每 3 轮 —— 变更时必须同步复核 phase 决策', () => {
		// ★ 2026-09-18：落盘点已从 `agentTurnExecutor` 的内联判定迁到
		// `parts/turnPostIteration.ts` 的具名常量（P0-b 抽取）—— 旧断言盯死的是
		// executor 里的字面 `iteration % 3 === 0`，迁走后**恒红**（不是频率变了，
		// 是它注视的位置变了，属于「守护自己过期」而非「约定被违反」）。
		// 现改为盯「常量值 + 该常量确实是取模落盘判定的入参」：频率一旦不是 3 仍会红。
		const postIteration = readSource('browser/parts/turnPostIteration.ts');
		const interval = /const\s+CHECKPOINT_PERSIST_INTERVAL\s*=\s*(\d+)\s*;/.exec(postIteration);
		assert.strictEqual(
			interval?.[1], '3',
			'checkpoint 落盘频率已从「每 3 轮」变更。这是「phase 不可用于续跑」结论的前提，' +
			'请复核 .design/agentloop-pi-alignment-refactor.md 阶段 5 的裁定是否仍成立。',
		);
		assert.ok(
			/checkpointSink\s*&&\s*iteration\s*%\s*CHECKPOINT_PERSIST_INTERVAL\s*===\s*0/.test(postIteration),
			'具名常量必须真的用在取模落盘判定里 —— 否则常量被架空、频率已实质变化',
		);
	});

	test('恢复块保留「故意不恢复 phase」的原因说明', () => {
		const source = readSource('browser/agentTurnExecutor.ts');

		assert.ok(
			/故意不恢复\s*`?restored\.phase`?/.test(source),
			'恢复块丢失了「故意不恢复 phase」的说明 —— 后人会以为这是遗漏并顺手补上',
		);
		assert.ok(
			/重复执行副作用工具/.test(source),
			'说明必须点明后果（重复执行副作用工具），否则读者无法判断该约定的严重性',
		);
	});
});
