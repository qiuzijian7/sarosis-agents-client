/*---------------------------------------------------------------------------------------------
 *  Unit test: PendingRegistry 的**空闲超时**语义（2026-09-11 修「长任务被固定墙钟误杀」）
 *
 *  实测报障：`stage 执行超时（720s）：Saros.AnimatedEmoji` —— 但该 stage 当时仍在
 *  正常上报进度（9 格逐格生成 + 抠像 + 拼 GIF，本就可能超过 12 分钟）。
 *
 *  根因：`PendingRegistry` 用**固定墙钟** setTimeout，`progress()` 只转发进度、
 *  **不续期** → 12 分钟是从**启动**起算的死线，与是否仍在推进无关 ✗。
 *
 *  修法：改为**空闲超时** —— 有进度即重排定时器（节流 1s）；另设绝对上限
 *  （空闲额度 × 6）防「伪进度」僵尸。本测试锁定该语义。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { PendingRegistry, extractStageSnapshot } from '../../browser/workflow/workflowSnapshotBridge.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 挂一个 pending，返回收集到的拒绝原因（若已拒绝）。 */
function arm(
	reg: PendingRegistry,
	id: string,
	timeoutMs: number,
	extras?: { executionId?: string; hardCapMs?: number },
) {
	const state: { rejected?: Error; reason?: 'idle' | 'cap'; resolved?: unknown; progressCount: number; abandoned: string[] } = { progressCount: 0, abandoned: [] };
	reg.register(
		id,
		v => { state.resolved = v; },
		err => { state.rejected = err; },
		timeoutMs,
		(reason) => { state.reason = reason; return new Error(`timeout:${reason}`); },
		() => { state.progressCount++; },
		{ onAbandon: abandonedId => { state.abandoned.push(abandonedId); }, ...extras },
	);
	return state;
}

suite('PendingRegistry 空闲超时（长任务不被误杀）', () => {

	test('无进度 → 空闲额度耗尽即超时（reason=idle）', async () => {
		const reg = new PendingRegistry();
		const s = arm(reg, 'r1', 60);
		await sleep(120);
		assert.ok(s.rejected, '应超时');
		assert.strictEqual(s.reason, 'idle');
	});

	test('★ 核心回归：持续上报进度 → 不被固定墙钟误杀', async () => {
		const reg = new PendingRegistry();
		// 空闲额度 100ms（绝对上限 600ms）；每 25ms 一条进度持续 300ms
		// = 空闲额度的 3 倍，同时远低于上限 → 只可能因「固定墙钟」而失败。
		// 修复前：100ms 就被判死 ✗；修复后：一直续期，不超时 ✓
		const s = arm(reg, 'r2', 100);
		for (let i = 0; i < 12; i++) {
			await sleep(25);
			reg.progress('r2', i * 8);
		}
		assert.strictEqual(s.rejected, undefined, `不应超时，实际：${s.rejected?.message}`);
		assert.ok(s.progressCount >= 10, `进度应被转发，实际 ${s.progressCount}`);
		// 正常完成
		assert.strictEqual(reg.resolve('r2', true, 'ok'), true);
		assert.strictEqual(s.resolved, 'ok');
	});

	test('进度停止 → 从**最后一次**进度起算空闲超时', async () => {
		const reg = new PendingRegistry();
		const s = arm(reg, 'r3', 60);
		await sleep(40);
		reg.progress('r3', 50);       // 续期一次
		await sleep(30);
		assert.strictEqual(s.rejected, undefined, '续期后不应立即超时');
		await sleep(120);
		assert.ok(s.rejected, '停止进度后应超时');
		assert.strictEqual(s.reason, 'idle');
	});

	test('★ 绝对上限：即使一直有进度，也不超过 空闲额度 × HARD_CAP_FACTOR（reason=cap）', async () => {
		const reg = new PendingRegistry();
		// 上限 = 30ms × PendingRegistry.HARD_CAP_FACTOR（不写死倍数，避免调参后测试失效）
		const s = arm(reg, 'r4', 30);
		for (let i = 0; i < 30; i++) {
			await sleep(20);
			reg.progress('r4', i);            // 一直有进度
			if (s.rejected) { break; }
		}
		assert.ok(s.rejected, '触达绝对上限应超时（防伪进度僵尸）');
		assert.strictEqual(s.reason, 'cap');
	});

	test('已解决/已超时的 id：progress 返回 false 且不再触发回调', async () => {
		const reg = new PendingRegistry();
		const s = arm(reg, 'r5', 200);
		reg.resolve('r5', true, 1);
		assert.strictEqual(reg.progress('r5', 99), false);
		assert.strictEqual(s.progressCount, 0);
	});

	test('timeoutMs <= 0 → 不限时（进度续期不改变该语义）', async () => {
		const reg = new PendingRegistry();
		const s = arm(reg, 'r6', 0);
		reg.progress('r6', 10);
		await sleep(80);
		assert.strictEqual(s.rejected, undefined);
	});

	test('★ 超时前触发 onAbandon（供通知画布停止执行，消除僵尸运行）', async () => {
		const reg = new PendingRegistry();
		const s = arm(reg, 'r7', 40);
		await sleep(90);
		assert.deepStrictEqual(s.abandoned, ['r7'], '超时应通知调用方「已放弃」');
		assert.ok(s.rejected, '通知后仍应 reject（调用方拿到超时错误）');
	});

	test('正常 resolve 不触发 onAbandon（不该误停画布）', async () => {
		const reg = new PendingRegistry();
		const s = arm(reg, 'r8', 40);
		reg.resolve('r8', true, 'ok');
		await sleep(90);
		assert.deepStrictEqual(s.abandoned, [], '成功完成不应触发放弃回调');
		assert.strictEqual(s.resolved, 'ok');
	});

	test('★★ 不限总时长（hardCapMs=Infinity）：持续进度可跑任意久，不再有上限', async () => {
		const reg = new PendingRegistry();
		// 空闲 30ms；默认上限 = 30 × HARD_CAP_FACTOR = 360ms（上面第 4 例已证明会触发）。
		// 这里显式 hardCapMs=Infinity（直跑的实际配置）→ 跑 600ms 仍不应超时 ✓
		const s = arm(reg, 'r9', 30, { hardCapMs: Number.POSITIVE_INFINITY });
		for (let i = 0; i < 30; i++) {
			await sleep(20);
			reg.progress('r9', i);
		}
		assert.strictEqual(s.rejected, undefined, `不限总时长后不应超时，实际：${s.rejected?.message}`);
		reg.resolve('r9', true, 'done');
	});

	test('★★ 心跳：只续期、不触发进度回调（解耦「活性」与「进度」）', async () => {
		const reg = new PendingRegistry();
		// 空闲 100ms（上限 1200ms）；每 25ms 一条**心跳**持续 300ms（= 空闲额度 3 倍）
		// —— 对应「stage 合法地长时间不上报进度」的场景：修复前会被误杀 ✗
		const s = arm(reg, 'h1', 100);
		for (let i = 0; i < 12; i++) {
			await sleep(25);
			reg.heartbeat('h1');
		}
		assert.strictEqual(s.rejected, undefined, `心跳应续期，实际：${s.rejected?.message}`);
		assert.strictEqual(s.progressCount, 0, '心跳不得触发进度回调（UI 不该被打扰）');
		reg.resolve('h1', true, 'ok');
	});

	test('心跳停止 → 仍会空闲超时（心跳不是免死金牌）', async () => {
		const reg = new PendingRegistry();
		const s = arm(reg, 'h2', 50);
		reg.heartbeat('h2');
		await sleep(150);
		assert.ok(s.rejected, '心跳停止后应超时');
		assert.strictEqual(s.reason, 'idle');
	});

	test('未知 id 的心跳返回 false（幂等）', () => {
		const reg = new PendingRegistry();
		assert.strictEqual(reg.heartbeat('nope'), false);
	});

	test('★ abandonByExecution：取消执行时放弃其名下直跑（通知画布 + reject 收尾）', async () => {
		const reg = new PendingRegistry();
		const a = arm(reg, 'a1', 5_000, { executionId: 'exec-A' });
		const b = arm(reg, 'a2', 5_000, { executionId: 'exec-A' });
		const other = arm(reg, 'b1', 5_000, { executionId: 'exec-B' });

		const n = reg.abandonByExecution('exec-A', new Error('cancelled'));
		assert.strictEqual(n, 2, '应放弃 exec-A 名下的两个直跑');
		assert.deepStrictEqual(a.abandoned, ['a1'], '应通知画布停止（a1）');
		assert.deepStrictEqual(b.abandoned, ['a2'], '应通知画布停止（a2）');
		assert.ok(a.rejected && b.rejected, '应 reject 让等待方立即收尾');
		assert.strictEqual(other.rejected, undefined, '其他执行的直跑不受影响');
		assert.deepStrictEqual(other.abandoned, []);

		// 重复放弃同一执行：幂等，返回 0
		assert.strictEqual(reg.abandonByExecution('exec-A', new Error('again')), 0);
		reg.resolve('b1', true, 'ok');
	});
});


/**
 * ★ `executionIdOf`（P0 修复，2026-09-13）：脚本内 `stage()` 的进度回程只有 runId，
 * 要把它归到「发起该 stage 的 script 节点卡」必须先反查归属的 executionId。
 * 本 suite 锁定该查询语义 —— 尤其「无归属 → undefined」分支：调用方据此**跳过**归因，
 * 否则会把画布直跑的进度错记到某个 script 节点上。
 */
suite('PendingRegistry.executionIdOf（脚本进度归属）', () => {

	test('返回注册时声明的 executionId', () => {
		const reg = new PendingRegistry();
		arm(reg, 'run-1', 5000, { executionId: 'exec-A' });
		assert.strictEqual(reg.executionIdOf('run-1'), 'exec-A');
	});

	test('★ 未声明归属（画布直跑）→ undefined（调用方据此跳过节点卡归因）', () => {
		const reg = new PendingRegistry();
		arm(reg, 'run-2', 5000);
		assert.strictEqual(reg.executionIdOf('run-2'), undefined);
	});

	test('未注册的 runId → undefined（不抛错）', () => {
		const reg = new PendingRegistry();
		assert.strictEqual(reg.executionIdOf('nope'), undefined);
		assert.strictEqual(reg.executionIdOf(''), undefined);
	});

	test('进度上报不影响归属（长任务期间持续可查）', () => {
		const reg = new PendingRegistry();
		arm(reg, 'run-3', 5000, { executionId: 'exec-B' });
		reg.progress('run-3', 30);
		reg.progress('run-3', 60);
		assert.strictEqual(reg.executionIdOf('run-3'), 'exec-B');
	});
});


/**
 * ★ `extractStageSnapshot`（P1-1 修复，2026-09-13）：脚本内 `stage()` 回程的产物提取。
 *
 * 输入是画布 runner 的返回值（`StageRunResultPayload.value: unknown`，结构类型）
 * → 必须全程防御式读取；非法条目静默跳过（产物展示属增益，不能因脏数据打断脚本收尾）。
 */
suite('extractStageSnapshot（脚本产物提取）', () => {

	test('正常提取 port/kind/ref/meta', () => {
		const out = extractStageSnapshot({ snapshot: [
			{ port: 'output', kind: 'image', ref: 'http://cdn/a.png', meta: { batch: '1' } },
			{ port: 'matte', kind: 'video', ref: 'http://cdn/a.mp4' },
		] });
		assert.strictEqual(out.length, 2);
		assert.deepStrictEqual(out[0], { port: 'output', kind: 'image', ref: 'http://cdn/a.png', meta: { batch: '1' } });
		assert.strictEqual(out[1].kind, 'video');
		assert.strictEqual(out[1].meta, undefined);
	});

	test('★ 非对象 / 无 snapshot / snapshot 非数组 → 空数组（不抛错）', () => {
		assert.deepStrictEqual(extractStageSnapshot(undefined), []);
		assert.deepStrictEqual(extractStageSnapshot(null), []);
		assert.deepStrictEqual(extractStageSnapshot('text'), []);
		assert.deepStrictEqual(extractStageSnapshot({}), []);
		assert.deepStrictEqual(extractStageSnapshot({ snapshot: 'nope' }), []);
	});

	test('★ 非法条目被跳过（缺 ref / 空 ref / 非字符串 ref / null 元素）', () => {
		const out = extractStageSnapshot({ snapshot: [
			{ port: 'output', kind: 'image' },
			{ port: 'output', kind: 'image', ref: '' },
			{ port: 'output', kind: 'image', ref: 42 },
			null,
			{ port: 'output', kind: 'image', ref: 'ok' },
		] });
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].ref, 'ok');
	});

	test('port 缺省 → output；kind 缺省 → unknown', () => {
		const out = extractStageSnapshot({ snapshot: [{ ref: 'x' }] });
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].port, 'output');
		assert.strictEqual(out[0].kind, 'unknown');
	});
});
