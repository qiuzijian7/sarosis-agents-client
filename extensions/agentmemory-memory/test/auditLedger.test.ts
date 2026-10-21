/*---------------------------------------------------------------------------------------------
 *  auditLedger.test.ts — 审计账本读取的守卫（2026-10-21）
 *
 * 病根：审计有**两套**数据源，面板一直读错的那套 ⇒ 审计页长期空白 ✗✗：
 *   · 引擎自带的 `AuditLog`：**纯内存**（进程重启即失、也没人调 `record()`）⇒ 恒 0 条
 *   · **真源**：dsh 侧记忆插件写的**落盘账本** `<数据根>/memory-audit/audit.jsonl`
 *
 * 本守卫钉住：
 *   ① 账本路径 = `dirname(AGENTMEMORY_DATA_DIR)`（= IDE 数据根）下的 `memory-audit/audit.jsonl`
 *      —— 与插件的 `dataRootOf(config)` 同一处 ✓（显式 `VSSAROS_DATA_ROOT` 优先）；
 *   ② 能读到账本行，并**归一**成引擎那套字段（`operation` / `timestamp` / `type`）——
 *      账本原字段是 `action` / `ts` / `tool` ⇒ 不归一就渲染成 "unknown / 空时间" ✗；
 *   ③ 读不到（文件不存在）⇒ 返回空数组，**不抛**（审计读不到不该影响主流程 ✓）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentMemoryProviderV2 } from '../src/agentMemoryProviderV2.js';

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
declare function suiteSetup(fn: () => void): void;
declare function suiteTeardown(fn: () => void): void;

const savedDataDir = process.env['AGENTMEMORY_DATA_DIR'];
const savedRoot = process.env['VSSAROS_DATA_ROOT'];
let tmpRoot = '';

suite('审计账本读取（单一真源）', () => {
	suiteSetup(() => {
		tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'am-audit-ledger-'));
		// 网关的数据根是 `<IDE 数据根>/.agentmemory` ⇒ 账本在它的**父目录**下
		process.env['AGENTMEMORY_DATA_DIR'] = path.join(tmpRoot, '.agentmemory');
		delete process.env['VSSAROS_DATA_ROOT'];
	});
	suiteTeardown(() => {
		if (savedDataDir === undefined) { delete process.env['AGENTMEMORY_DATA_DIR']; }
		else { process.env['AGENTMEMORY_DATA_DIR'] = savedDataDir; }
		if (savedRoot === undefined) { delete process.env['VSSAROS_DATA_ROOT']; }
		else { process.env['VSSAROS_DATA_ROOT'] = savedRoot; }
	});

	test('① 能读到账本行并归一成引擎字段（action/ts/tool => operation/timestamp/type）', async () => {
		const dir = path.join(tmpRoot, 'memory-audit');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, 'audit.jsonl'),
			[
				JSON.stringify({ ts: 1700000000000, action: 'request', tool: 'memory_remember', agentId: 'a1', target: 'm-1' }),
				JSON.stringify({ ts: 1700000001000, action: 'executed', tool: 'memory_remember', agentId: 'a1', outcome: 'written' }),
			].join('\n') + '\n',
			'utf8',
		);
		const p = new AgentMemoryProviderV2({ hosted: true });
		const rows = await p.getAuditLedger({ limit: 50 });
		assert.equal(rows.length, 2, `应读到 2 行，实际 ${rows.length}`);
		assert.equal(rows[0]['operation'], 'executed', '最新在前');
		assert.equal(typeof rows[0]['timestamp'], 'number');
		assert.equal(rows[0]['type'], 'memory_remember');
		assert.equal(rows[0]['agentId'], 'a1');
		assert.equal(rows[0]['action'], 'executed', '原始字段要保留（明细 JSON 里仍可见）');
	});

	test('② 账本不存在 => 空数组，不抛（审计读不到不该影响主流程）', async () => {
		// ⚠ 必须先删掉 ① 建的文件（否则这里测的是"有账本"而不是"没账本" ✗）
		await fs.rm(path.join(tmpRoot, 'memory-audit', 'audit.jsonl'), { force: true });
		const p = new AgentMemoryProviderV2({ hosted: true });
		const rows = await p.getAuditLedger({ limit: 10 });
		assert.ok(Array.isArray(rows));
		assert.equal(rows.length, 0);
	});

	test('③ 坏行跳过、其余照常返回（账本可能被外部编辑过）', async () => {
		const dir = path.join(tmpRoot, 'memory-audit');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, 'audit.jsonl'),
			['{ 这不是 JSON', JSON.stringify({ ts: 1, action: 'request', agentId: 'a2' })].join('\n') + '\n',
			'utf8',
		);
		const p = new AgentMemoryProviderV2({ hosted: true });
		const rows = await p.getAuditLedger({ limit: 10 });
		assert.equal(rows.length, 1, `只应返回 1 条好行，实际 ${rows.length}`);
		assert.equal(rows[0]['operation'], 'request');
	});
});