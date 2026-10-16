/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「真·积分」探针代理的**跨进程稳定性**（2026-10-15，事故驱动：首启 `providers.sync` 实测拆解）。
 *
 * 现场：profile 里持久化的 baseURL 是 `http://127.0.0.1:<随机端口>/r/<每进程随机 secret>/<route>` ⇒
 * 每次首启幂等比对都 `changed=true` ⇒ 每次都 `settings.mutate`（= 整份 profile 热重组，
 * 本机实测 20–24s，首启最大单项）⇒ "dsh 首次启动很慢"里最大的一块**每次启动都付**。
 * 修法（本类）：secret 持久化到 `<userData>/dsh-credit-proxy.secret` + 固定端口优先（撞了才退回随机）。
 *
 * 这组测试守的是**行为**（不是源码长什么样）：
 *   ① 同一 userDataPath 的先后两个实例 ⇒ **baseURL 逐字相同**（= 幂等的前提 ✓）；
 *   ② secret 真的落盘、且第二实例读的是同一份；
 *   ③ 固定端口被占 ⇒ 退回随机端口、服务照常（且留痕日志）——撞车不该是"起不来"；
 *   ④ 不给 userDataPath ⇒ 回到"每进程随机"（调用方传不传都不该炸 ✓）；
 *   ⑤ 既有安全边界不破：错 secret ⇒ 404、未登记路由 ⇒ 502。
 */

import assert from 'assert';
// ⚠ `existsSync` **不在这里导入**：它只出现在下面那段注释里（"被否掉的方案"的说明 ✓），
//   代码里一律以**内容形态**为准 ⇒ 导入它会被 tsgo 判 TS6133（未使用）✗（2026-10-15 实测）。
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshCreditProxy } from '../../electron-main/dshCreditProxy.js';

/** 等 secret 文件落盘**且内容写完**（写入是 fire-and-forget 的异步 ⇒ 立刻读会偶发读不到；
 *  只判 `existsSync` 还会撞上"文件已创建、内容还没写"的窗口（Windows 上全套件高负载时实测读到空串 ✗）
 *  ⇒ 以内容形态为准（与断言同一条正则）。 */
async function waitFor(file: string, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (/^[0-9a-f]{32}$/.test(readFileSync(file, 'utf8').trim())) {
				return true;
			}
		} catch { /* 还没创建 */ }
		await new Promise(r => setTimeout(r, 25));
	}
	return false;
}

suite('dshHarness / dshCreditProxy（跨进程稳定 ⇒ providers.sync 幂等）', function () {
	this.timeout(30_000);

	let root: string;
	const live: DshCreditProxy[] = [];
	const logs: string[] = [];
	const make = (userDataPath?: string) => {
		const p = new DshCreditProxy({ onSample: () => undefined, ...(userDataPath ? { userDataPath } : {}), log: l => logs.push(l) });
		live.push(p);
		return p;
	};

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'vssaros-credit-proxy-'));
		logs.length = 0;
	});
	teardown(() => {
		while (live.length) {
			live.pop()!.dispose();
		}
		rmSync(root, { recursive: true, force: true });
	});

	test('recentSamples 暴露样本环（2026-10-15：页面重载后回放积分的来源 ✓）', async () => {
		const p = make(root);
		// 页面侧的积分样本池是"活推送"（chunk 级数组），页面重载即清零 ✗ ⇒ 主进程必须能给出
		// 最近样本供回放（viewHost.setCreditReplaySource ← 这里）—— 这个 getter 丢了 ⇒ 历史回合
		// 的「积分」chip 在任何重载后都永远显示"—" ✗。
		assert.ok(Array.isArray(p.recentSamples), 'recentSamples 必须是数组（回放源 ✓）');
		assert.strictEqual(p.recentSamples.length, 0, '新实例没有样本 ✓');
	});

	test('★ 同一 userDataPath 的先后两个实例 ⇒ baseURL 逐字相同（幂等的前提）', async () => {
		const first = make(root);
		const urlA = await first.routeBaseURL('vssaros-ollama', 'https://gw.example.com/v1');
		first.dispose();
		const second = make(root);
		const urlB = await second.routeBaseURL('vssaros-ollama', 'https://gw.example.com/v1');
		assert.strictEqual(urlB, urlA,
			`跨进程（重启）必须给出同一个 baseURL，否则 profile 幂等比对永远 changed ⇒ 每次首启都付热重组：\nA=${urlA}\nB=${urlB}`);
	});

	test('secret 落盘到 <userData>/dsh-credit-proxy.secret，且两个实例读到同一份', async () => {
		const first = make(root);
		const urlA = await first.routeBaseURL('vssaros-ollama', 'https://gw.example.com');
		const file = join(root, 'dsh-credit-proxy.secret');
		assert.ok(await waitFor(file), `secret 应落盘：${file}`);
		const persisted = readFileSync(file, 'utf8').trim();
		assert.match(persisted, /^[0-9a-f]{32}$/, `secret 形态不对：${persisted}`);
		assert.ok(urlA.includes(`/r/${persisted}/`), 'URL 里的 secret 必须是落盘那份');
		first.dispose();
		const second = make(root);
		const url = await second.routeBaseURL('vssaros-ollama', 'https://gw.example.com');
		assert.ok(url.includes(`/r/${persisted}/`), '第二实例必须读到同一份 secret（否则跨进程照样 flap ✗）');
	});

	test('固定端口被占用 ⇒ 退回随机端口 + 留痕 + 服务照常（404/502 边界不破）', async () => {
		const first = make(root);
		const urlA = await first.routeBaseURL('vssaros-ollama', 'https://gw.example.com');
		// 第一个还开着 ⇒ 第二个的固定端口必撞车 ⇒ 必须退回随机而不是起不来 ✗。
		const second = make(root);
		const urlB = await second.routeBaseURL('vssaros-grnexus', 'https://gw2.example.com');
		assert.notStrictEqual(urlOf(urlB).port, urlOf(urlA).port, '撞车时应退回别的端口');
		assert.ok(logs.some(l => l.includes('退回随机端口')), `退回随机要留痕：${logs.join(' | ')}`);
		// 服务照常：错 secret ⇒ 404（边界 2）；对 secret 但未登记路由 ⇒ 502（边界 3）。
		const port = urlOf(urlB).port;
		const wrongSecret = await fetch(`http://127.0.0.1:${port}/r/${'0'.repeat(32)}/vssaros-grnexus/chat/completions`);
		assert.strictEqual(wrongSecret.status, 404, `错 secret 必须 404，实为 ${wrongSecret.status}`);
		const unregistered = await fetch(`http://127.0.0.1:${port}/r/${secretOf(urlB)}/vssaros-nope/chat/completions`);
		assert.strictEqual(unregistered.status, 502, `未登记路由必须 502，实为 ${unregistered.status}`);
	});

	test('不给 userDataPath ⇒ 每进程随机（老行为，单测/探针走这条）', async () => {
		const a = make();
		const b = make();
		const urlA = await a.routeBaseURL('vssaros-ollama', 'https://gw.example.com');
		const urlB = await b.routeBaseURL('vssaros-ollama', 'https://gw.example.com');
		assert.notStrictEqual(urlA, urlB, '没给 userDataPath 时两个实例不该撞 secret/端口');
	});
});

function urlOf(url: string): URL {
	return new URL(url);
}

function secretOf(url: string): string {
	return /^\/r\/([0-9a-f]+)\//.exec(urlOf(url).pathname)?.[1] ?? '';
}
