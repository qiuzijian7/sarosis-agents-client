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
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshCreditProxy, IDshCreditSample } from '../../electron-main/dshCreditProxy.js';

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

/**
 * ★★ 2026-10-20（用户报「积分 —」）：**客户端读完末块就断开**时，样本也不能丢。
 *
 * 现场：今天 19:00–19:07 会话日志里 38 次模型响应，代理只记下 1 条；21:48 那轮 0 条。
 * 根因：dsh 的 pi-ai 适配器读完流后无条件 `consumer.abort(...)` ⇒ 客户端几乎总先于上游断开 ⇒
 * 代理 abort 上游读取 ⇒ `reader.read()` 抛 ⇒ 写在循环之后的 `_record` 不执行，且 catch 里不留日志。
 * 这里用假上游复现：发完带 credit 的 usage 末块后**不关连接**，客户端读到末块即 abort。
 */
suite('dshHarness / dshCreditProxy（客户端提前断开也要记样本）', function () {
	this.timeout(20_000);

	const live: Array<{ dispose(): void }> = [];
	teardown(() => {
		while (live.length) {
			live.pop()!.dispose();
		}
	});

	/** 假网关：SSE 两块（正文 + usage 末块），之后 hold 住连接 `holdMs` 再关。 */
	async function fakeGateway(holdMs: number): Promise<{ base: string; requests: () => number }> {
		let count = 0;
		const server = createServer((req, res) => {
			count++;
			req.resume();
			req.on('end', () => {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
				res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"credit":0.15}}\n\n');
				const t = setTimeout(() => { res.write('data: [DONE]\n\n'); res.end(); }, holdMs);
				res.on('close', () => clearTimeout(t));
			});
		});
		await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		live.push({ dispose: () => server.close() });
		const address = server.address() as AddressInfo;
		return { base: `http://127.0.0.1:${address.port}/v1`, requests: () => count };
	}

	async function proxyWith(base: string) {
		const samples: IDshCreditSample[] = [];
		const logs: string[] = [];
		const p = new DshCreditProxy({ onSample: s => samples.push(s), log: l => logs.push(l) });
		live.push(p);
		const url = await p.routeBaseURL('vssaros-codebuddy', base);
		return { samples, logs, url };
	}

	async function waitSamples(samples: IDshCreditSample[], n: number, timeoutMs = 5000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (samples.length < n && Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 20));
		}
	}

	test('★ 读到 usage 末块后客户端 abort（pi-ai 的真实行为）⇒ 仍记下样本与 credit', async () => {
		const gw = await fakeGateway(3_000);
		const { samples, url } = await proxyWith(gw.base);
		const controller = new AbortController();
		const res = await fetch(`${url}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'deepseek-v4-flash-ioa', stream: true }),
			signal: controller.signal,
		});
		const reader = res.body!.getReader();
		let text = '';
		while (!text.includes('"credit"')) {
			const { done, value } = await reader.read();
			if (done) { break; }
			text += Buffer.from(value!).toString('utf8');
		}
		controller.abort();   // 上游还没关 ⇒ 客户端先断开
		await waitSamples(samples, 1);
		assert.strictEqual(samples.length, 1, '客户端先断开时样本不能静默丢失');
		assert.strictEqual(samples[0].credit, 0.15);
		assert.strictEqual(samples[0].model, 'deepseek-v4-flash-ioa');
		assert.strictEqual(samples[0].route, 'vssaros-codebuddy');
	});

	test('正常读完（上游先关）⇒ 只记一次（不因 finally 重复记）', async () => {
		const gw = await fakeGateway(10);
		const { samples, url } = await proxyWith(gw.base);
		const res = await fetch(`${url}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'm', stream: true }),
		});
		await res.text();
		await waitSamples(samples, 1);
		await new Promise(r => setTimeout(r, 200));
		assert.strictEqual(samples.length, 1);
		assert.strictEqual(samples[0].credit, 0.15);
		assert.strictEqual(gw.requests(), 1);
	});

	test('还没读到 usage 就断开（用户点停止）⇒ 记一条没有 credit 的样本（与"积分 0"区分）', async () => {
		const gw = await fakeGateway(3_000);
		const { samples, url } = await proxyWith(gw.base);
		const controller = new AbortController();
		const res = await fetch(`${url}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'm', stream: true }),
			signal: controller.signal,
		});
		const reader = res.body!.getReader();
		await reader.read();          // 只读第一块
		controller.abort();
		await waitSamples(samples, 1);
		assert.strictEqual(samples.length, 1);
		// 第一块与末块可能被合并成一次 read 到达 ⇒ 此处只要求"记了样本"，credit 允许已读到或缺省
		assert.ok(samples[0].credit === undefined || samples[0].credit === 0.15);
	});
});

function urlOf(url: string): URL {
	return new URL(url);
}

function secretOf(url: string): string {
	return /^\/r\/([0-9a-f]+)\//.exec(urlOf(url).pathname)?.[1] ?? '';
}
