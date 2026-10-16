/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力请求**闸门**（反向通道 `ide.request` 的"授权 → 分发"）的单元测试。
 *
 * 要点：这是放行面，所以除了"该放行的放行"，更要钉住**不该放行的一律不放**，尤其那条顺序不变式：
 * **被拒时分发器一次都不能被调用**（未授权的请求不该惊动 renderer）。
 * 闸门只依赖两个回调，所以不需要 electron 主进程就能测。
 */

import assert from 'assert';
import { IIdeCapabilityDeclaration } from '../../common/dshIdeAuthorization.js';
import { IDshIdeRequest } from '../../common/dshHarness.js';
import { IDE_REQUEST_SLOW_TIMEOUT_MS, IDE_REQUEST_TIMEOUT_MS } from '../../common/dshIdeCapabilities.js';
import { DshIdeRequestGate } from '../../electron-main/dshIdeRequestGate.js';

/** 造一个闸门：声明表与分发的调用情况都暴露出来，便于断言"有没有被调用"。 */
function gateOf(declarations: Record<string, string[]>, options: { dispatch?: (request: Omit<IDshIdeRequest, 'id'>) => Promise<unknown>; notes?: string[] } = {}) {
	const table = new Map<string, IIdeCapabilityDeclaration>(Object.entries(declarations).map(([pluginId, capabilities]) => [pluginId, { pluginId, capabilities: capabilities as IIdeCapabilityDeclaration['capabilities'] }]));
	const dispatched: (Omit<IDshIdeRequest, 'id'>)[] = [];
	const timeouts: number[] = [];
	const logged: string[] = [];
	const gate = new DshIdeRequestGate({
		readDeclarations: () => ({ declarations: table, notes: options.notes ?? [] }),
		dispatch: (request, timeoutMs) => {
			dispatched.push(request);
			timeouts.push(timeoutMs);
			return options.dispatch ? options.dispatch(request) : Promise.resolve({ ok: true, via: 'renderer' });
		},
		log: line => logged.push(line),
	});
	return { gate, dispatched, timeouts, logged };
}

const requestOf = (params: Record<string, unknown>) => ({ id: -7, method: 'ide.request', params });

suite('dshHarness / IDE request gate', () => {

	test('授权通过：交给 renderer 执行，参数原样（capability / pluginId / params），结果透传', async () => {
		const { gate, dispatched } = gateOf({ '@vssaros/dsh-ide': ['getDiagnostics'] });
		const result = await gate.handle(requestOf({ token: 't', capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide', params: { path: 'a.ts' } }));
		assert.deepStrictEqual(result, { ok: true, via: 'renderer' });
		assert.deepStrictEqual(dispatched, [{ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide', params: { path: 'a.ts' } }]);
	});

	test('★★ 会话 id **原样带给分发**（定向投递靠它；丢了不报错、只静默退化成广播——Electron 探针抓过这个漏）', async () => {
		const { gate, dispatched } = gateOf({ '@vssaros/dsh-ide': ['getDiagnostics'] });
		await gate.handle(requestOf({ token: 't', capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide', sessionId: 'sess-42', params: { path: 'a.ts' } }));
		assert.deepStrictEqual(dispatched[0], { capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide', sessionId: 'sess-42', params: { path: 'a.ts' } });
		// 没有会话 id（老版本 dsh / IDE 侧自检 `ide.probe`）⇒ 字段**不出现**（主进程据此退回广播）
		await gate.handle(requestOf({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide' }));
		assert.strictEqual(dispatched[1]?.sessionId, undefined, '拿不到会话时不该编一个出来');
		// 空串不是有效会话 id
		await gate.handle(requestOf({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide', sessionId: '' }));
		assert.strictEqual(dispatched[2]?.sessionId, undefined);
	});

	test('★ 渲染侧等待预算由闸门按操作给出：慢操作给慢预算（10s 写死会误伤 apply_ops）', async () => {
		// ⚠ `browser` 那一族已随"不保留 IDE 直连 CDP"整体删除（README 4.80 / 4.89）⇒ 本侧只剩 canvas 一档：
		// **需用户确认**的 `apply_ops` 走慢预算（确认发生在能力执行内部，算在同一份预算里），其余走默认。
		const { gate, timeouts } = gateOf({ '@vssaros/dsh-ide': ['canvas', 'getSelection'] });
		await gate.handle(requestOf({ capability: 'canvas', pluginId: '@vssaros/dsh-ide', params: { op: 'apply_ops' } }));
		await gate.handle(requestOf({ capability: 'canvas', pluginId: '@vssaros/dsh-ide', params: { op: 'state' } }));
		await gate.handle(requestOf({ capability: 'getSelection', pluginId: '@vssaros/dsh-ide' }));
		assert.deepStrictEqual(timeouts, [IDE_REQUEST_SLOW_TIMEOUT_MS, IDE_REQUEST_TIMEOUT_MS, IDE_REQUEST_TIMEOUT_MS]);
	});

	test('★ 被拒时**分发器一次都不被调用**（未授权不进 renderer），错误即拒绝原因', async () => {
		const { gate, dispatched, logged } = gateOf({ '@vssaros/dsh-ide': ['openFile'] });
		await assert.rejects(
			() => gate.handle(requestOf({ token: 't', capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide' })),
			/未声明能力 getDiagnostics/,
		);
		assert.deepStrictEqual(dispatched, [], '被拒的请求不该进 renderer');
		assert.ok(logged.some(line => /拒绝 IDE 能力请求/.test(line)), `日志应记下拒绝：${JSON.stringify(logged)}`);
	});

	test('未知能力名 / 缺 pluginId / 插件没装：都拒且不进 renderer', async () => {
		const { gate, dispatched } = gateOf({ '@vssaros/dsh-ide': ['getDiagnostics'] });
		// 样本用 `teleport`（`mindmap` / `unreal` 自 v1.2.12 起已在白名单里，会走"未声明"那条）
		await assert.rejects(() => gate.handle(requestOf({ capability: 'teleport', pluginId: '@vssaros/dsh-ide' })), /未知的 IDE 能力：teleport/);
		await assert.rejects(() => gate.handle(requestOf({ capability: 'getDiagnostics' })), /必须带 pluginId/);
		await assert.rejects(() => gate.handle(requestOf({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-not-installed' })), /未安装或没有可读清单/);
		assert.deepStrictEqual(dispatched, []);
	});

	test('非 `ide.request` 的方法一律不支持（`ide.echo` 由客户端内建，不该到这里）', async () => {
		const { gate, dispatched } = gateOf({ '@vssaros/dsh-ide': ['getDiagnostics'] });
		await assert.rejects(() => gate.handle({ id: -1, method: 'ide.echo', params: { token: 't' } }), /反向通道不支持的方法：ide.echo/);
		await assert.rejects(() => gate.handle({ id: -2, method: 'ide.whatever', params: {} }), /反向通道不支持的方法/);
		assert.deepStrictEqual(dispatched, []);
	});

	test('renderer 执行失败：错误原样回到 Host（带可读原因，不吞）', async () => {
		const { gate, dispatched } = gateOf({ '@vssaros/dsh-ide': ['showDiff'] }, {
			dispatch: () => Promise.reject(new Error('用户取消了 diff')),
		});
		await assert.rejects(() => gate.handle(requestOf({ capability: 'showDiff', pluginId: '@vssaros/dsh-ide' })), /用户取消了 diff/);
		assert.strictEqual(dispatched.length, 1, '已授权的请求确实进了 renderer（是执行失败，不是被拒）');
	});

	test('声明读取的 notes 会进日志（坏清单可见）', async () => {
		const { gate, logged } = gateOf({ '@vssaros/dsh-ide': ['getDiagnostics'] }, { notes: ['@vssaros/dsh-broken 的清单读不了（…）⇒ 视为零 IDE 能力'] });
		await gate.handle(requestOf({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide' }));
		assert.ok(logged.some(line => /视为零 IDE 能力/.test(line)), JSON.stringify(logged));
	});
});
