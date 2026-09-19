/**
 * S3c 抽取的接线 + 行为契约 —— `browser/turnDeltaDispatch.ts`。
 *
 * ## 背景
 *
 * `agentTurnExecutor.ts` 的流消费循环里，`delta.type` 这个 7 值联合
 * （text|thinking|tool_call|done|error|usage|tool_progress）被**三处独立重复判定**：
 *   - 诊断字符串化  `String(delta.type ?? 'unknown')`
 *   - 业务分派      `if (delta.type === 'text') ... else if ('thinking') ...`
 *   - 日志预览      `if (delta.type === 'text' && delta.content) ...`
 *
 * 三处相距 100+ 行，任何联合变更都要同时改三处；更危险的是**漏改不报错**
 * （字符串字面量比较，非穷尽 switch，TS 不做穷尽性检查）。
 *
 * 本文件锁住两件事：
 *   1. **行为**：每个分类函数对 7 种 type × 边界输入返回正确结果，
 *      尤其是两条**契约关键**语义——
 *        · tool_progress 严禁被判为 tool_call（否则会污染工具完成判定）
 *        · 非 done 类型上的 finishReason 必须被忽略
 *   2. **接线**：executor 确实改为调用本模块，且原三处字面量判定已被收敛
 *      （防止"抽了模块但没接线"或"接线后又回退成内联"）。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { IModelDelta } from '../../common/providers.js';
import {
	classifyTurnDelta,
	isDoneWithFinishReason,
	isErrorDelta,
	isLivenessDelta,
	isTextDelta,
	isThinkingDelta,
	isToolCallDelta,
	isUsageDelta,
} from '../../browser/turnDeltaDispatch.js';

const BROWSER_DIR = 'src/vs/sessions/contrib/agentStudio/browser';
const EXECUTOR = `${BROWSER_DIR}/agentTurnExecutor.ts`;
const DISPATCH = `${BROWSER_DIR}/turnDeltaDispatch.ts`;

function read(rel: string): string {
	return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/** 去掉整行 `//` 注释与块注释，避免注释里的字样造成误判。 */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter(line => !/^\s*\/\//.test(line))
		.join('\n');
}

/** 构造一个仅含指定字段的 delta，避免测试依赖未声明字段。 */
function delta(partial: Partial<IModelDelta>): IModelDelta {
	return partial as IModelDelta;
}

suite('S3c — delta 分派纯函数（行为契约）', () => {

	test('classifyTurnDelta 覆盖全部 7 种已声明 type', () => {
		const declared = ['text', 'thinking', 'tool_call', 'done', 'error', 'usage', 'tool_progress'] as const;
		for (const type of declared) {
			assert.strictEqual(classifyTurnDelta(delta({ type })), type, `type=${type} 应原样归类`);
		}
	});

	test('classifyTurnDelta 把契约外 type 降级为 unknown（而非泄漏原值）', () => {
		// 历史事故：网关透传了联合中未声明的 type，原实现在日志里直接打出原始字符串。
		assert.strictEqual(classifyTurnDelta(delta({ type: 'gateway_ping' as never })), 'unknown');
		assert.strictEqual(classifyTurnDelta(delta({ type: '' as never })), 'unknown');
	});

	test('classifyTurnDelta 对 nullish 输入返回 unknown 且不抛异常', () => {
		assert.strictEqual(classifyTurnDelta(undefined), 'unknown');
		assert.strictEqual(classifyTurnDelta(null), 'unknown');
	});

	test('isTextDelta 要求 type 与 content 同时满足', () => {
		assert.strictEqual(isTextDelta(delta({ type: 'text', content: 'hi' })), true);
		assert.strictEqual(isTextDelta(delta({ type: 'text' })), false, '空 content 不算正文');
		assert.strictEqual(isTextDelta(delta({ type: 'text', content: '' })), false, '空串不算正文');
		assert.strictEqual(isTextDelta(delta({ type: 'thinking', content: 'x' })), false, 'thinking 不得判为正文');
	});

	test('isThinkingDelta 要求 type 与 content 同时满足', () => {
		assert.strictEqual(isThinkingDelta(delta({ type: 'thinking', content: 'r' })), true);
		assert.strictEqual(isThinkingDelta(delta({ type: 'thinking' })), false);
		assert.strictEqual(isThinkingDelta(delta({ type: 'text', content: 'x' })), false, 'text 不得判为思考');
	});

	test('isTextDelta 与 isThinkingDelta 互斥（同为 content 载荷，靠 type 区分）', () => {
		// 二者都读 content 字段，若任一判定漏看 type，思维链会被当成正文流式显示给用户。
		const thinking = delta({ type: 'thinking', content: 'reasoning' });
		const text = delta({ type: 'text', content: 'answer' });
		assert.strictEqual(isTextDelta(thinking), false, 'thinking 不得混入正文');
		assert.strictEqual(isThinkingDelta(text), false, 'text 不得混入思考');
		for (const sample of [thinking, text]) {
			assert.strictEqual(isTextDelta(sample) && isThinkingDelta(sample), false,
				`同一 delta（type=${sample.type}）不得同时被判为正文与思考`);
		}
	});

	test('isUsageDelta 只在 type=usage 且携带 usage 时为真', () => {
		assert.strictEqual(isUsageDelta(delta({ type: 'usage', usage: { inputTokens: 1 } as never })), true);
		assert.strictEqual(isUsageDelta(delta({ type: 'usage' })), false, '无 usage 载荷不算');
		assert.strictEqual(isUsageDelta(delta({ type: 'text', usage: { inputTokens: 1 } as never })), false,
			'非 usage 类型上的杂散 usage 字段必须被忽略');
	});

	test('【契约关键】tool_progress 严禁被判为 tool_call', () => {
		// providers.ts 明确：tool_progress 不进入工具装配，完成判定唯一来源是 tool_start。
		const progress = delta({ type: 'tool_progress', toolName: 'file_write', bytes: 42 });
		assert.strictEqual(isToolCallDelta(progress), false,
			'tool_progress 若被判为 tool_call 会污染工具完成判定');
		assert.strictEqual(isLivenessDelta(progress), true, 'tool_progress 必须续命 idle 计时器');
	});

	test('isToolCallDelta 要求 type=tool_call 且携带 toolCall 载荷', () => {
		assert.strictEqual(isToolCallDelta(delta({ type: 'tool_call', toolCall: { name: 'read' } as never })), true);
		assert.strictEqual(isToolCallDelta(delta({ type: 'tool_call' })), false, '缺 toolCall 载荷不算');
		assert.strictEqual(isToolCallDelta(delta({ type: 'text', toolCall: { name: 'read' } as never })), false,
			'非 tool_call 类型上的杂散 toolCall 必须被忽略');
	});

	test('【契约关键】非 done 类型上的 finishReason 必须被忽略', () => {
		assert.strictEqual(isDoneWithFinishReason(delta({ type: 'done', finishReason: 'stop' } as never)), true);
		assert.strictEqual(isDoneWithFinishReason(delta({ type: 'done' } as never)), false, 'done 无原因不算');
		assert.strictEqual(isDoneWithFinishReason(delta({ type: 'text', finishReason: 'stop' } as never)), false,
			'text 上出现 finishReason 不得被当作轮次结束');
	});

	test('isErrorDelta 只认 error 类型', () => {
		assert.strictEqual(isErrorDelta(delta({ type: 'error', error: 'boom' })), true);
		assert.strictEqual(isErrorDelta(delta({ type: 'text', error: 'boom' })), false,
			'正文 delta 上的 error 字段不构成错误信号');
	});

	test('isLivenessDelta 只认 tool_progress', () => {
		assert.strictEqual(isLivenessDelta(delta({ type: 'tool_progress' })), true);
		for (const type of ['text', 'thinking', 'tool_call', 'done', 'error', 'usage'] as const) {
			assert.strictEqual(isLivenessDelta(delta({ type })), false, `${type} 不应续命 idle`);
		}
	});
});

suite('S3c — delta 分派接线（executor 不变量）', () => {

	test('executor 从 turnDeltaDispatch 导入分类函数', () => {
		const src = read(EXECUTOR);
		assert.ok(/from\s+'\.\/turnDeltaDispatch\.js'/.test(src),
			'executor 必须从 ./turnDeltaDispatch.js 导入');
		assert.ok(/classifyTurnDelta/.test(src), 'executor 必须使用 classifyTurnDelta');
	});

	test('executor 不再以内联字符串字面量做 delta 分类', () => {
		const body = stripComments(read(EXECUTOR));
		assert.ok(!/String\(delta\.type\s*\?\?\s*'unknown'\)/.test(body),
			'原 `String(delta.type ?? \'unknown\')` 已被 classifyTurnDelta 取代');
		assert.ok(!/delta\.type === 'text' && delta\.content/.test(body),
			'原内联 `delta.type === \'text\' && delta.content` 已被 isTextDelta 取代');
		assert.ok(!/delta\.type === 'thinking' && \(delta as any\)\.content/.test(body),
			'原 thinking 分支的 `(delta as any).content` 强转已被 isThinkingDelta 取代（消除 any）');
	});

	test('分派模块自身保持纯函数（无 IO / 无时间 / 无闭包状态）', () => {
		const body = stripComments(read(DISPATCH));
		assert.ok(!/Date\.now\(\)/.test(body), '分类层不得读取时间（应保持可确定性单测）');
		assert.ok(!/_logService|console\.|fs\./.test(body), '分类层不得做 IO');
		assert.ok(!/\blet\s+_/.test(body), '分类层不得持有可变闭包状态');
	});
});
