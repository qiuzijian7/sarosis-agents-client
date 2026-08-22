/*---------------------------------------------------------------------------------------------
 *  工具调用合理性审计（toolAuditReport）单元测试
 *
 *  重点（这套日志的价值全在「不误报」上）：
 *   [WARN]  该报的必须报：高空结果率、同参数重复读、串行连击、后期不收敛
 *   [CLEAN] ★★ 控制组 —— 一个健康 turn 必须**零告警**、level=info。
 *           只测「能报出问题」会让噪音进生产，届时 warn 失去筛查价值。
 *   [WATER] 闸门水位：max 是最高值而非最终值；near-miss（差 1 次触发）可见
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	buildToolAuditReport,
	formatToolAuditLog,
	formatGuardrailFiredLog,
	EMPTY_RATE_WARN,
	MIN_CALLS_FOR_RATE,
	DUP_CALLS_WARN,
	LATE_EXPLORE_RATE_WARN,
	type IToolCallRecord,
} from '../../common/toolAuditReport.js';

/** 造一条记录，默认「成功、有输出、非空」。 */
const rec = (name: string, over: Partial<IToolCallRecord> = {}): IToolCallRecord => ({
	name, iteration: 1, ok: true, ms: 100, outputBytes: 500, empty: false, ...over,
});

const READ_ONLY = new Set(['file_read', 'search_code', 'search_files']);
// ★ 探索 = 语义纯粹的「搜索」工具（searchToolGroups 的 TEXT ∪ STRUCTURAL）。
//   file_read / execute_code / terminal 有双重语义（探索 vs 验证），**刻意不在其中**。
const EXPLORE = new Set(['search_code', 'search_files', 'search_graph', 'query_graph', 'trace_path']);
const judges = {
	isReadOnlyTool: (n: string) => READ_ONLY.has(n),
	isExplorationTool: (n: string) => EXPLORE.has(n),
};

suite('toolAuditReport', () => {

	suite('[CLEAN] ★★ 控制组：健康 turn 必须零告警', () => {
		test('正常混合调用 → 无 efficacy / 无 pattern / level=info', () => {
			const r = buildToolAuditReport({
				records: [
					rec('file_read', { iteration: 1 }),
					rec('patch', { iteration: 2, ms: 40 }),
					rec('terminal', { iteration: 3, ms: 1200 }),
					rec('file_write', { iteration: 4 }),
				],
				iterations: 4,
				wallMs: 8000,
				...judges,
			});
			assert.deepStrictEqual([...r.efficacy], []);
			assert.deepStrictEqual([...r.patterns], []);
			assert.strictEqual(r.hasWarning, false);
			assert.strictEqual(formatToolAuditLog(r).level, 'info');
		});

		test('空结果率高但样本不足（< MIN_CALLS_FOR_RATE）→ 不告警', () => {
			const r = buildToolAuditReport({
				records: [rec('search_code', { empty: true }), rec('search_code', { empty: true })],
				iterations: 2, wallMs: 100, ...judges,
			});
			assert.strictEqual(MIN_CALLS_FOR_RATE, 3);
			assert.strictEqual(r.efficacy.length, 0, '2 次调用不足以判定「空结果率高」');
		});

		test('★ 写类工具重复同参数不算 dup（patch 反复改同一文件是合法迭代）', () => {
			const r = buildToolAuditReport({
				records: [
					rec('patch', { argsKey: 'a.ts' }),
					rec('patch', { argsKey: 'a.ts' }),
					rec('patch', { argsKey: 'a.ts' }),
				],
				iterations: 3, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.efficacy.length, 0, '写类工具不得计入 dup');
		});

		test('缺 argsKey 的记录不参与 dup（宁可漏报不误报）', () => {
			const r = buildToolAuditReport({
				records: [rec('file_read'), rec('file_read'), rec('file_read')],
				iterations: 3, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.efficacy.length, 0);
		});

		test('未提供 isReadOnlyTool 时完全不做 dup 统计', () => {
			const r = buildToolAuditReport({
				records: [rec('file_read', { argsKey: 'x' }), rec('file_read', { argsKey: 'x' })],
				iterations: 2, wallMs: 100,
			});
			assert.strictEqual(r.efficacy.length, 0);
		});

		test('短 turn 全是探索 → 不报 late-phase（探索期本该如此）', () => {
			const r = buildToolAuditReport({
				records: [rec('search_code', { iteration: 1 }), rec('file_read', { iteration: 2 })],
				iterations: 3, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.patterns.length, 0, 'iterations < 6 不做收敛判定');
		});

		test('连击未达阈值 → 不报 serial-single-tool', () => {
			const r = buildToolAuditReport({
				records: [rec('file_read')],
				iterations: 3, wallMs: 100,
				maxSingleToolStreak: 3, singleToolStreakThreshold: 4,
				...judges,
			});
			assert.strictEqual(r.patterns.length, 0);
		});
	});

	suite('[WARN] 该报的必须报', () => {
		test('空结果率 ≥ 50% 且样本足够 → efficacy 告警', () => {
			assert.strictEqual(EMPTY_RATE_WARN, 0.5);
			const r = buildToolAuditReport({
				records: [
					rec('search_code', { empty: true }), rec('search_code', { empty: true }),
					rec('search_code', { empty: true }), rec('search_code'),
				],
				iterations: 4, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.efficacy.length, 1);
			assert.strictEqual(r.efficacy[0].name, 'search_code');
			assert.strictEqual(r.efficacy[0].empty, 3);
			assert.ok(Math.abs(r.efficacy[0].emptyRate - 0.75) < 1e-9);
			assert.strictEqual(r.hasWarning, true);
			assert.strictEqual(formatToolAuditLog(r).level, 'warn');
		});

		test('失败不计入 empty（失败已有独立通道）', () => {
			const r = buildToolAuditReport({
				records: [
					rec('search_code', { ok: false, empty: true }),
					rec('search_code', { ok: false, empty: true }),
					rec('search_code', { ok: false, empty: true }),
				],
				iterations: 3, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.failed, 3);
			assert.strictEqual(r.efficacy.length, 0, 'ok=false 不应算空结果');
		});

		test('只读工具同参数重复 ≥ 阈值 → dup 告警', () => {
			assert.strictEqual(DUP_CALLS_WARN, 2);
			const r = buildToolAuditReport({
				records: [
					rec('file_read', { argsKey: 'a.ts' }),
					rec('file_read', { argsKey: 'a.ts' }),
					rec('file_read', { argsKey: 'a.ts' }),
					rec('file_read', { argsKey: 'b.ts' }),
				],
				iterations: 4, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.efficacy.length, 1);
			assert.strictEqual(r.efficacy[0].dup, 2, '3 次同参数 = 2 次重复');
		});

		test('不同参数不算重复（控制组）', () => {
			const r = buildToolAuditReport({
				records: [
					rec('file_read', { argsKey: 'a.ts' }),
					rec('file_read', { argsKey: 'b.ts' }),
					rec('file_read', { argsKey: 'c.ts' }),
				],
				iterations: 3, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.efficacy.length, 0);
		});

		test('串行连击达阈值 → pattern 含可并行工具名', () => {
			const r = buildToolAuditReport({
				records: [rec('file_read')],
				iterations: 20, wallMs: 100,
				maxSingleToolStreak: 17, singleToolStreakThreshold: 4,
				parallelizableInStreak: ['search_code', 'file_read'],
				...judges,
			});
			assert.strictEqual(r.patterns.length, 1);
			assert.ok(r.patterns[0].includes('serial-single-tool: 17'), r.patterns[0]);
			assert.ok(r.patterns[0].includes('threshold=4'));
			assert.ok(r.patterns[0].includes('file_read, search_code'), '工具名应排序输出');
		});

		test('后期高比例搜索 → late-phase-exploration', () => {
			assert.strictEqual(LATE_EXPLORE_RATE_WARN, 0.6);
			const records = [
				rec('patch', { iteration: 1 }), rec('patch', { iteration: 2 }),
				// 后半段（iteration >= 5）仍在搜新信息
				rec('search_code', { iteration: 5 }), rec('search_files', { iteration: 6 }),
				rec('search_graph', { iteration: 7 }), rec('search_code', { iteration: 8 }),
			];
			const r = buildToolAuditReport({ records, iterations: 10, wallMs: 100, ...judges });
			const p = r.patterns.find((x) => x.startsWith('late-phase-exploration'));
			assert.ok(p, JSON.stringify(r.patterns));
			assert.ok(p!.includes('not converging'));
			assert.ok(p!.includes('are search'), '文案不再说 search/read');
		});

		test('★★ 修改-验证循环不误报（patch + file_read 确认 + execute_code 验证）', () => {
			// 2026-08-22 日志 1787381220642 的实测场景：修改 webview 代码任务后期是
			//   patch×7 + file_read(改完确认) + execute_code(tsc/git diff 验证)。
			// 这些 file_read / execute_code 是收敛的**表现**，不是「探索不收敛」。
			const records = [
				rec('search_code', { iteration: 1 }), rec('file_read', { iteration: 2 }),
				rec('patch', { iteration: 5 }), rec('file_read', { iteration: 6 }),
				rec('patch', { iteration: 7 }), rec('execute_code', { iteration: 8 }),
				rec('file_read', { iteration: 9 }), rec('execute_code', { iteration: 10 }),
			];
			const r = buildToolAuditReport({ records, iterations: 12, wallMs: 100, ...judges });
			assert.strictEqual(
				r.patterns.filter((x) => x.startsWith('late-phase')).length, 0,
				'file_read/execute_code 不应算探索 → 修改-验证循环不得误报',
			);
		});

		test('后期以写为主 → 不报不收敛（控制组）', () => {
			const records = [
				rec('search_code', { iteration: 1 }),
				rec('patch', { iteration: 5 }), rec('patch', { iteration: 6 }),
				rec('file_write', { iteration: 7 }), rec('terminal', { iteration: 8 }),
			];
			const r = buildToolAuditReport({ records, iterations: 10, wallMs: 100, ...judges });
			assert.strictEqual(r.patterns.filter((x) => x.startsWith('late-phase')).length, 0);
		});
	});

	suite('[WATER] 闸门水位', () => {
		test('输出 max/threshold/fired，按「距阈值远近」排序', () => {
			const r = buildToolAuditReport({
				records: [rec('x')], iterations: 2, wallMs: 10,
				guardrails: [
					{ name: 'searchRepeat', max: 2, threshold: 3, fired: 0 },
					{ name: 'terminalSearch', max: 3, threshold: 3, fired: 1 },
				],
				...judges,
			});
			assert.strictEqual(r.guardrails[0].name, 'terminalSearch', '已触发的排最前');
			const { text } = formatToolAuditLog(r);
			assert.ok(text.includes('max=3/3'), text);
			assert.ok(text.includes('max=2/3'), text);
		});

		test('★ near-miss 标注：差 1 次触发且未触发过', () => {
			const r = buildToolAuditReport({
				records: [rec('x')], iterations: 2, wallMs: 10,
				guardrails: [{ name: 'searchRepeat', max: 2, threshold: 3, fired: 0 }],
				...judges,
			});
			const { text } = formatToolAuditLog(r);
			assert.ok(text.includes('near-miss'), text);
			assert.ok(text.includes('1 away from firing'), text);
		});

		test('已触发过的不再标 near-miss（避免重复语义）', () => {
			const r = buildToolAuditReport({
				records: [rec('x')], iterations: 2, wallMs: 10,
				guardrails: [{ name: 'g', max: 3, threshold: 3, fired: 1 }],
				...judges,
			});
			assert.ok(!formatToolAuditLog(r).text.includes('near-miss'));
		});

		test('max=0 不标 near-miss（从未计数过）', () => {
			const r = buildToolAuditReport({
				records: [rec('x')], iterations: 2, wallMs: 10,
				guardrails: [{ name: 'g', max: 0, threshold: 1, fired: 0 }],
				...judges,
			});
			assert.ok(!formatToolAuditLog(r).text.includes('near-miss'));
		});

		test('★ 闸门水位本身不触发 warn（水位是参考信息，不是缺陷）', () => {
			const r = buildToolAuditReport({
				records: [rec('x')], iterations: 2, wallMs: 10,
				guardrails: [{ name: 'g', max: 3, threshold: 3, fired: 1 }],
				...judges,
			});
			assert.strictEqual(r.hasWarning, false);
			assert.strictEqual(formatToolAuditLog(r).level, 'info');
		});

		test('hot 字段输出（直接定位贡献最多的工具）', () => {
			const r = buildToolAuditReport({
				records: [rec('x')], iterations: 2, wallMs: 10,
				guardrails: [{ name: 'consecutiveFail', max: 2, threshold: 3, fired: 0, hot: 'patch' }],
				...judges,
			});
			assert.ok(formatToolAuditLog(r).text.includes('hot=patch'));
		});
	});

	suite('cost 归因', () => {
		test('按耗时降序；msPct / bytesPct 归一', () => {
			const r = buildToolAuditReport({
				records: [
					rec('terminal', { ms: 8000, outputBytes: 1000 }),
					rec('file_read', { ms: 1000, outputBytes: 9000 }),
					rec('patch', { ms: 1000, outputBytes: 0 }),
				],
				iterations: 3, wallMs: 12000, ...judges,
			});
			assert.strictEqual(r.cost[0].name, 'terminal');
			assert.strictEqual(r.toolMs, 10000);
			assert.ok(Math.abs(r.cost[0].msPct - 80) < 1e-6);
			const sumPct = r.cost.reduce((n, c) => n + c.msPct, 0);
			assert.ok(Math.abs(sumPct - 100) < 1e-6, `${sumPct}`);
		});

		test('同工具多次调用聚合为一行', () => {
			const r = buildToolAuditReport({
				records: [rec('file_read', { ms: 10 }), rec('file_read', { ms: 20 })],
				iterations: 2, wallMs: 100, ...judges,
			});
			assert.strictEqual(r.cost.length, 1);
			assert.strictEqual(r.cost[0].calls, 2);
			assert.strictEqual(r.cost[0].ms, 30);
		});

        test('ms 缺省为 0 时不产生 NaN', () => {
			const r = buildToolAuditReport({
				records: [rec('a', { ms: 0 }), rec('b', { ms: 0 })],
				iterations: 2, wallMs: 0, ...judges,
			});
			assert.strictEqual(r.toolMs, 0);
			assert.strictEqual(r.cost[0].msPct, 0);
			assert.ok(!formatToolAuditLog(r).text.includes('NaN'));
		});
	});

	suite('格式契约', () => {
		const report = () => buildToolAuditReport({
			records: [
				rec('terminal', { ms: 5000, outputBytes: 2048 }),
				rec('search_code', { empty: true }), rec('search_code', { empty: true }), rec('search_code', { empty: true }),
			],
			iterations: 8, wallMs: 20000, turnId: 'sess-1',
			guardrails: [{ name: 'searchRepeat', max: 2, threshold: 3, fired: 0 }],
			maxSingleToolStreak: 5, singleToolStreakThreshold: 4,
			...judges,
		});

		test('首行以 [ToolAudit] SUMMARY 开头并含核心计数', () => {
			const head = formatToolAuditLog(report()).text.split('\n')[0];
			assert.ok(head.startsWith('[ToolAudit] SUMMARY turn=sess-1'), head);
			assert.ok(head.includes('iters=8 calls=4 (ok=4 failed=0)'), head);
			assert.ok(head.includes('wall=20.0s'), head);
		});

		test('段标题固定为 ── xxx ──；明细行 4 空格缩进', () => {
			const lines = formatToolAuditLog(report()).text.split('\n');
			assert.ok(lines.some((l) => l === '  ── cost ──'));
			assert.ok(lines.some((l) => l.startsWith('  ── efficacy')));
			assert.ok(lines.some((l) => l === '  ── pattern ──'));
			assert.ok(lines.some((l) => l.startsWith('  ── guardrails')));
			for (const l of lines.slice(1)) {
				assert.ok(l.startsWith('  '), l);
			}
		});

		test('无记录时也能出报告（不崩）', () => {
			const r = buildToolAuditReport({ records: [], iterations: 0, wallMs: 0 });
			assert.strictEqual(r.calls, 0);
			assert.strictEqual(formatToolAuditLog(r).level, 'info');
		});

		test('cost 超过上限合并为 (others ×N tools)', () => {
			const records = Array.from({ length: 14 }, (_, i) => rec(`t${i}`, { ms: 100 - i }));
			const { text } = formatToolAuditLog(buildToolAuditReport({ records, iterations: 14, wallMs: 5000, ...judges }));
			assert.ok(text.includes('(others ×6 tools)'), text);
		});
	});

	suite('formatGuardrailFiredLog', () => {
		test('即时告警格式含 count/threshold', () => {
			const s = formatGuardrailFiredLog('consecutiveFail', 3, 3, 'tool=patch');
			assert.strictEqual(s, '[ToolAudit] guardrail FIRED: consecutiveFail count=3/3 — tool=patch');
		});

		test('detail 可省略', () => {
			assert.strictEqual(formatGuardrailFiredLog('g', 1, 2), '[ToolAudit] guardrail FIRED: g count=1/2');
		});
	});
});
