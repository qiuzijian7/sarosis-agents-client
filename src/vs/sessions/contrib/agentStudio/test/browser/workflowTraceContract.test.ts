/*---------------------------------------------------------------------------------------------
 *  Unit test: 工作流 trace 契约校验（2026-09-11 质量评估 P2）。
 *
 *  host 发送端（多处 `.fire`）与消费端（workflowTraceController 的 switch）之间没有
 *  编译期连接——字段名写错 / 必填漏传 / kind 拼错只会**运行时静默失效**。本测试锁定：
 *    · 契约表对 13 种 kind 的必填字段与类型约束；
 *    · 未知 kind 能被识别（契约漂移信号）；
 *    · ★ controller 实际处理的每个 kind 都在契约表内（防契约表落后于实现）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { validateWorkflowTrace, TRACE_REQUIRED_FIELDS } from '../../browser/workflow/traceContract.js';
import { mergeSnapshotMedia, trimSnapshotForPersist, PERSIST_MEDIA_MAX, PERSIST_MEDIA_REF_MAX } from '../../browser/workflowTraceController.js';

/** 构造一条覆盖全部必填字段的合法 trace（按 kind 填最小合法载荷）。 */
function makeValidTrace(kind: string): Record<string, unknown> {
	const base: Record<string, unknown> = { kind, executionId: 'e1', sessionId: 's1', nodeId: 'n1' };
	switch (kind) {
		case 'subagent_start': return { ...base, nodeName: 'Node', workflowAgentId: 'a1', nodeType: 'comfyStage', task: 't' };
		case 'delta': return { ...base, delta: { text: 'x' } };
		case 'subagent_end': return { ...base, status: 'done' };
		case 'node_values_changed': return { ...base, values: {} };
		case 'ask_user': return { ...base, nodeName: 'Node', question: 'q', options: [], multiSelect: false };
		case 'ask_user_end': return { ...base, status: 'answered' };
		// ★ 已移除 picker_select / picker_select_end（2026-09-13）：契约表不再登记它们
		//   （全仓无发射端，交互由 node_interaction 的 applyMode='snapshot' 承载）。
		case 'node_interaction': return { ...base, nodeName: 'Node', title: 't', fields: [], initialValues: {} };
		case 'node_interaction_end': return { ...base, status: 'submitted' };
		case 'collect_variables': return { ...base, variables: [{ name: 'v' }] };
		case 'collect_variables_end': return { ...base, status: 'submitted' };
		case 'execution_end': return { ...base, status: 'completed', durationMs: 1234 };
		case 'node_progress': return { ...base, nodeName: 'Node', progress: 42 };
		default: return base;
	}
}

suite('工作流 trace 契约校验（traceContract）', () => {
	test('★ 契约表覆盖 12 种 kind，且每种都有必填字段', () => {
		const kinds = Object.keys(TRACE_REQUIRED_FIELDS);
		assert.strictEqual(kinds.length, 12, `契约表 kind 数应为 12，实际 ${kinds.length}`);
		for (const k of kinds) {
			assert.ok(TRACE_REQUIRED_FIELDS[k].length > 0, `${k} 应有必填字段`);
			assert.ok(TRACE_REQUIRED_FIELDS[k].includes('executionId'), `${k} 必须要求 executionId`);
			assert.ok(TRACE_REQUIRED_FIELDS[k].includes('sessionId'), `${k} 必须要求 sessionId`);
		}
	});

	test('★ 全部 kind 的合法载荷均通过校验', () => {
		for (const k of Object.keys(TRACE_REQUIRED_FIELDS)) {
			const r = validateWorkflowTrace(makeValidTrace(k));
			assert.strictEqual(r.ok, true, `${k} 应通过，实际违规: ${r.violations.map(v => v.detail).join('; ')}`);
			assert.strictEqual(r.unknownKind, false);
			assert.strictEqual(r.signature, '');
		}
	});

	test('★ 必填字段缺失 → 报出具体字段（node_interaction 缺 fields）', () => {
		const t = makeValidTrace('node_interaction');
		delete t['fields'];
		const r = validateWorkflowTrace(t);
		assert.strictEqual(r.ok, false);
		assert.ok(r.violations.some(v => v.field === 'fields' && v.reason === 'missing'));
	});

	test('★ 字段类型不符 → 报 wrong-type（node_progress.progress 传字符串）', () => {
		const r = validateWorkflowTrace({ ...makeValidTrace('node_progress'), progress: '97%' });
		assert.strictEqual(r.ok, false);
		assert.ok(r.violations.some(v => v.field === 'progress' && v.reason === 'wrong-type'));
	});

	/**
	 * ★ P2-2（2026-09-13）：`execution_end.durationMs` 必须是 number ——
	 * 聊天卡的耗时直接 `(durationMs/1000).toFixed(1)`，传字符串会渲染成 NaN ✗。
	 */
	test('★ execution_end.durationMs 类型约束（number 通过 / 字符串报 wrong-type）', () => {
		const ok = validateWorkflowTrace({ ...makeValidTrace('execution_end'), durationMs: 1234 });
		assert.strictEqual(ok.ok, true, `number 应通过，实际: ${ok.violations.map(v => v.detail).join('; ')}`);
		const bad = validateWorkflowTrace({ ...makeValidTrace('execution_end'), durationMs: '12s' });
		assert.strictEqual(bad.ok, false);
		assert.ok(bad.violations.some(v => v.field === 'durationMs' && v.reason === 'wrong-type'));
	});

	test('★ 枚举越界 → 报 bad-enum（subagent_end.status 写成 success）', () => {
		const r = validateWorkflowTrace({ ...makeValidTrace('subagent_end'), status: 'success' });
		assert.strictEqual(r.ok, false);
		assert.ok(r.violations.some(v => v.field === 'status' && v.reason === 'bad-enum'));
	});

	test('★ 未知 kind → unknownKind 标记（发送端新增而契约表未登记）', () => {
		const r = validateWorkflowTrace({ kind: 'brand_new_event', executionId: 'e', sessionId: 's' });
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.unknownKind, true);
		assert.match(r.signature, /^unknown:/);
	});

	test('非法输入（undefined / 非对象）不抛异常', () => {
		assert.strictEqual(validateWorkflowTrace(undefined).ok, false);
		assert.strictEqual(validateWorkflowTrace(null).unknownKind, true);
		assert.strictEqual(validateWorkflowTrace('nope' as unknown).ok, false);
	});

	test('签名可用于去重（同 kind 同违规 → 同签名）', () => {
		const a = validateWorkflowTrace({ kind: 'execution_end', executionId: 'e', sessionId: 's' });
		const b = validateWorkflowTrace({ kind: 'execution_end', executionId: 'other', sessionId: 'x' });
		assert.strictEqual(a.signature, b.signature);
		assert.ok(a.signature.length > 0);
	});

	test('★ 防漂移守卫：controller 处理的每个 kind 都在契约表内', () => {
		// 契约表若落后于实现（controller 新增 case 但忘了登记），本测试立刻失败。
		const root = process.cwd();
		const ctrl = path.join(root, 'src/vs/sessions/contrib/agentStudio/browser/workflowTraceController.ts');
		const src = fs.readFileSync(ctrl, 'utf8');
		const start = src.indexOf('switch (trace.kind)');
		assert.ok(start >= 0, '未找到 controller 的 trace.kind switch');
		const end = src.indexOf('\n\t}', start);
		const body = src.slice(start, end > start ? end : undefined);
		const handled = new Set(Array.from(body.matchAll(/case '([^']+)'/g)).map(m => m[1]));
		assert.ok(handled.size >= 10, `应解析到多个 case，实际 ${handled.size}`);
		const missing = [...handled].filter(k => !(k in TRACE_REQUIRED_FIELDS));
		assert.deepStrictEqual(missing, [], `controller 处理但契约表未登记的 kind: ${missing.join(', ')}`);
	});

	test('★★ 反向守卫：契约表登记的每个 kind 都必须被 controller 处理（防静默丢弃）', () => {
		// 由来（2026-09-11 实测 bug）：`node_progress` 早已在契约表里、host 也一直在发，
		//   但 controller 的 switch **没有该分支** → 逐格生成进度被**静默丢弃**，
		//   阶段卡只有 spinner 没有百分比（用户反馈「画布生成进度没同步到卡片」）。
		//   上方那条守卫只查「controller → 契约」方向，**查不出这个缺口** ✗。
		const root = process.cwd();
		const ctrl = path.join(root, 'src/vs/sessions/contrib/agentStudio/browser/workflowTraceController.ts');
		const src = fs.readFileSync(ctrl, 'utf8');
		const start = src.indexOf('switch (trace.kind)');
		assert.ok(start >= 0, '未找到 controller 的 trace.kind switch');
		const end = src.indexOf('\n\t}', start);
		const body = src.slice(start, end > start ? end : undefined);
		const handled = new Set(Array.from(body.matchAll(/case '([^']+)'/g)).map(m => m[1]));
		const unhandled = Object.keys(TRACE_REQUIRED_FIELDS).filter(k => !handled.has(k));
		assert.deepStrictEqual(
			unhandled,
			[],
			`契约表已登记但 controller 未处理的 kind（会被静默丢弃）: ${unhandled.join(', ')}`,
		);
	});

	test('★★ 逐格媒体合并：增量追加、按 ref 去重、不改原数组（「输出一个就显示一个」）', () => {
		// 由来（2026-09-11 用户需求「动态表情包节点，输出一个就显示一个」）：
		//   画布逐格归档 → 随 node_progress 带一条**增量** media → 卡片必须**合并**。
		//   若误写成整体替换 ✗，每来一格就把之前已显示的格刷掉（只剩最新一张）。
		const cur = [{ port: 'images', kind: 'image', ref: 'cell-0' }];
		const r1 = mergeSnapshotMedia(cur, { ref: 'cell-1', kind: 'image', port: 'images' });
		assert.strictEqual(r1.length, 2, '新格应追加（不是替换）');
		assert.strictEqual(r1[1]['ref'], 'cell-1');
		assert.strictEqual(cur.length, 1, '不得原地修改传入数组');

		// 同 ref 幂等（画布侧已保证增量，这里是第二道防线）
		assert.strictEqual(mergeSnapshotMedia(r1, { ref: 'cell-1' }).length, 2, '同 ref 应幂等');

		// 缺省 kind/port 有兜底
		assert.deepStrictEqual(mergeSnapshotMedia([], { ref: 'x' })[0], { port: 'output', kind: 'image', ref: 'x' });

		// 无 ref / 非法输入 → 原样返回（不炸）
		assert.deepStrictEqual(mergeSnapshotMedia(cur, {}), cur);
		assert.deepStrictEqual(mergeSnapshotMedia(cur, { ref: 123 }), cur);
	});
});

/**
 * 节点媒体快照的**落盘裁剪**（2026-09-12 修用户报障「9 格生成成功，但聊天卡只显示
 * 6 张 GIF」）。
 *
 * 事故链：`_handleExecutionEnd` 为落盘做的裁剪（每节点 ≤6 条）**同时被用于活卡刷新**
 * ✗ → 工作流一结束，活卡就被换成只剩 6 条的裁剪副本（9 格产物 → 卡上 6 格）✗✗。
 * 修法：裁剪只作用于**落盘副本**，活卡用全量（`snapSubAgentsLive`）✓。
 */
suite('trimSnapshotForPersist（落盘裁剪 —— 绝不能喂给活卡）', () => {

	const gif = (i: number, len = 488_000) => ({ port: 'output', kind: 'image', ref: 'g'.repeat(len) + i });
	const matte = (i: number) => ({ port: 'matte', kind: 'image', ref: `matte-${i}` });
	const video = (i: number) => ({ port: 'video', kind: 'video', ref: `video-${i}` });

	test('★ 无缩略图：9 格 GIF 原图（488KB/张）→ 受累计预算裁到 6 条', () => {
		const snap = Array.from({ length: 9 }, (_, i) => gif(i));
		const out = trimSnapshotForPersist(snap);
		// 6 × 488_000 ≈ 2.93MB ≤ 3MB 预算；第 7 条会超 → 停
		assert.strictEqual(out.length, 6, '累计预算（3MB）为闸门');
		// ★ 活卡用的是 `this._subAgents` 全量（9 条）—— 若哪天有人把本函数接到活卡上，
		//   卡片就会从 9 格掉到 6 格（本次事故）✗。
		assert.strictEqual(snap.length, 9, '原数组不得被修改');
	});

	test('★★ 有缩略图：9 格 → **全部 9 条**落盘（用户需求「重启后也要看全 9 张」）', () => {
		// 执行器为每格写 meta.thumb（240×240 首帧 PNG ≈ 60KB）→ 9 × 60KB ≈ 540KB ✓
		const snap = Array.from({ length: 9 }, (_, i) => ({ ...gif(i), meta: { thumb: 't'.repeat(60_000) } }));
		const out = trimSnapshotForPersist(snap);
		assert.strictEqual(out.length, 9, '缩略图让 9 格全部落盘');
		assert.ok(out.every(m => m.ref.length === 60_000), '落盘 ref 必须是缩略图（不是 488KB 原图）');
		assert.ok(out.every(m => m.ref !== gif(0).ref), '不得把 GIF 原图写进历史');
	});

	test('★ 缩略图缺失/超上限 → 回退原图；两者都不可用 → 丢弃', () => {
		const noThumb = { port: 'output', kind: 'image', ref: 'small-ref' };
		assert.strictEqual(trimSnapshotForPersist([noThumb])[0].ref, 'small-ref', '无缩略图 → 原图');

		const hugeThumb = { port: 'output', kind: 'image', ref: 'small-ref', meta: { thumb: 'x'.repeat(PERSIST_MEDIA_REF_MAX + 1) } };
		assert.strictEqual(trimSnapshotForPersist([hugeThumb])[0].ref, 'small-ref', '缩略图超上限 → 原图');

		const bothTooBig = { port: 'output', kind: 'image', ref: 'x'.repeat(PERSIST_MEDIA_REF_MAX + 1), meta: { thumb: '' } };
		assert.deepStrictEqual(trimSnapshotForPersist([bothTooBig]), [], '都不可用 → 丢弃');
	});

	test('★ 条数上限（12）挡住「超多小图」把历史撑爆', () => {
		const snap = Array.from({ length: 30 }, (_, i) => ({
			port: 'output', kind: 'image', ref: `tiny-${i}`, meta: { thumb: `t-${i}` },
		}));
		assert.strictEqual(trimSnapshotForPersist(snap).length, PERSIST_MEDIA_MAX);
	});

	test('★ 优先级：output > matte，且**排除 video**（mp4 data URL 必超上限）', () => {
		const snap = [video(0), matte(0), gif(0), video(1), matte(1), gif(1)];
		const out = trimSnapshotForPersist(snap);
		assert.ok(out.every(m => m.port === 'output'), '有 output 时只落 output');
		assert.strictEqual(out.length, 2);

		// 无 output → 退到 matte（仍排除 video）
		const out2 = trimSnapshotForPersist([video(0), matte(0), matte(1)]);
		assert.deepStrictEqual(out2.map(m => m.port), ['matte', 'matte']);

		// 都没有 → 其余端口（排除 video）
		const out3 = trimSnapshotForPersist([video(0), { port: 'images', kind: 'image', ref: 'a' }]);
		assert.deepStrictEqual(out3.map(m => m.port), ['images']);
	});

	test('★ 单条 ref 超上限（>500KB 字符）→ 丢弃（会话文件体积兜底）', () => {
		const huge = { port: 'output', kind: 'image', ref: 'x'.repeat(PERSIST_MEDIA_REF_MAX + 1) };
		assert.deepStrictEqual(trimSnapshotForPersist([huge]), []);
		// 恰好等于上限 → 保留（边界：`<=`）
		const edge = { port: 'output', kind: 'image', ref: 'x'.repeat(PERSIST_MEDIA_REF_MAX) };
		assert.strictEqual(trimSnapshotForPersist([edge]).length, 1);
	});

	test('空快照 / 非字符串 ref → 安全（不炸）', () => {
		assert.deepStrictEqual(trimSnapshotForPersist([]), []);
		assert.deepStrictEqual(
			trimSnapshotForPersist([{ port: 'output', kind: 'image' } as { port: string; kind: string; ref?: string }]),
			[],
		);
	});
});
