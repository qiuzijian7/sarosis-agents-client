// @vssaros/dsh-agents — 飞书入站网关的「不可恢复」语义（2026-10-27 真机反馈）
//   跑法：node dsh-plugins/vssaros-agents/test/feishu-gateway.test.mjs
//
// 真机现象：点「启动入站」→ `unavailable：未安装 @larksuiteoapi/node-sdk`，
//   界面显示"失败（第 1 次重试）"，然后在后台无限退避重试。
//
// 这是两层错：
//   ① 缺依赖**重试不会变好** —— 该停下并告诉用户去装包
//   ② 文案"第 1 次重试"让人以为"等等就好"
//
// 本文件钉住 ①；② 在客户端 chunk 里（守卫盯着前缀文案）。
import assert from 'node:assert/strict';
import { sep } from 'node:path';

import {
	createFeishuGateway, createSdkTransport, installDirOf, isUnrecoverableError,
	parseFeishuEvent, profileDirFrom,
} from '../lib/adapters/feishuInbound.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* ── ① 判定 ───────────────────────────────────────────────────────────── */

check('★ 缺依赖 / 缺凭据 ⇒ 不可恢复', () => {
	assert.equal(isUnrecoverableError(new Error('unavailable：未安装 @larksuiteoapi/node-sdk（npm i … 后重启 Host）')), true);
	assert.equal(isUnrecoverableError(new Error('unavailable：缺少 app_id / app_secret')), true);
	assert.equal(isUnrecoverableError('unavailable：SDK 里没有 WSClient（版本不匹配）'), true);
	assert.equal(isUnrecoverableError(new Error('unavailable：缺少 Bot Token')), true);
});

check('网络抖动 / 普通错误 ⇒ 仍要重试', () => {
	assert.equal(isUnrecoverableError(new Error('ECONNRESET')), false);
	assert.equal(isUnrecoverableError(new Error('socket hang up')), false);
	assert.equal(isUnrecoverableError(new Error('HTTP 500')), false);
	assert.equal(isUnrecoverableError(null), false);
});

/* ── ② 网关：不可恢复时不重试 ─────────────────────────────────────────── */

await checkAsync('★ 缺依赖 ⇒ start 后停在 error，且**不再重试**', async () => {
	let starts = 0;
	const logs = [];
	const gw = createFeishuGateway({
		transport: {
			async start() { starts += 1; throw new Error('unavailable：未安装 @larksuiteoapi/node-sdk（npm i … 后重启 Host）'); },
		},
		log: (level, msg) => logs.push(String(msg)),
		baseDelayMs: 5,
	});
	await gw.start();
	const st = gw.state();
	assert.equal(st.status, 'error');
	assert.equal(st.attempts, 0, '不可恢复的错误不该累加尝试次数');
	assert.ok(String(st.lastError).includes('未安装'), st.lastError);
	/* 等一小会儿，确认没有被调起第二次 */
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(starts, 1, '缺依赖时不该重试：' + starts);
	assert.ok(logs.some((l) => l.includes('不可恢复')), logs.join(' | '));
});

await checkAsync('可恢复错误 ⇒ 仍会退避重试（不能把真故障也停掉）', async () => {
	let starts = 0;
	const gw = createFeishuGateway({
		transport: {
			async start() { starts += 1; throw new Error('ECONNRESET'); },
		},
		log: () => undefined,
		baseDelayMs: 5,
	});
	await gw.start();
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(starts >= 2, '普通错误应当重试：' + starts);
	assert.ok(gw.state().attempts >= 1);
	await gw.stop();
	assert.equal(gw.state().status, 'stopped');
});

await checkAsync('缺依赖停下后，再点「启动入站」还能重新试（stopped 会被重置）', async () => {
	let starts = 0;
	const gw = createFeishuGateway({
		transport: {
			async start() { starts += 1; throw new Error('unavailable：缺少 app_id / app_secret'); },
		},
		log: () => undefined,
		baseDelayMs: 5,
	});
	await gw.start();
	assert.equal(starts, 1);
	await gw.start();          // 用户装完包/填完凭据后重点
	assert.equal(starts, 2, '重点启动应当重新尝试：' + starts);
});

/* ── ③ 顺带确认解析层没被这次改动碰到 ─────────────────────────────────── */

check('文本消息仍能解析（回归）', () => {
	const r = parseFeishuEvent({
		header: { event_type: 'im.message.receive_v1' },
		event: {
			sender: { sender_id: { open_id: 'u1' } },
			message: { message_id: 'm1', chat_id: 'c1', chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}' },
		},
	});
	assert.equal(r.kind, 'message');
	assert.equal(r.msg.content, '你好');
});

/* ── ④ 装依赖该去哪（2026-10-27 真机教训）────────────────────────────── */

check('★ profileDirFrom：真机路径 ⇒ 返回 profile 目录', () => {
	const p = profileDirFrom(['C:', 'Users', 'me', '.vssaros-dev', 'dsh-home', 'profiles', 'vssaros', 'node_modules', '@vssaros', 'dsh-agents', 'lib', 'adapters', 'feishuInbound.js'].join(sep));
	assert.equal(p, ['C:', 'Users', 'me', '.vssaros-dev', 'dsh-home', 'profiles', 'vssaros'].join(sep));
});

check('★ profileDirFrom：源码路径（无 node_modules）⇒ 空串（宁可空也不给错目录）', () => {
	assert.equal(profileDirFrom('G:/SarosWorkspace/x/dsh-plugins/vssaros-agents/lib/adapters/feishuInbound.js'), '');
	assert.equal(profileDirFrom(''), '');
	assert.equal(profileDirFrom(null), '');
});

check('嵌套 node_modules ⇒ 取最近的（在哪儿装都能被解析到）', () => {
	/* ⚠ 用 `sep` 拼，不要写死 `/`：Windows 上 sep 是 `\\`，写死就永远匹配不到。 */
	const middle = ['', 'a', 'node_modules', '@vssaros', 'dsh-agents', 'node_modules', 'dep', 'x.js'].join(sep);
	assert.equal(profileDirFrom(middle), ['', 'a', 'node_modules', '@vssaros', 'dsh-agents'].join(sep));
});

await checkAsync('★ 包内自带的 SDK 可加载（方案 C：装完即用，无需 npm i）', async () => {
	const mod = await import('../lib/adapters/vendor/node-sdk/lib/index.js');
	assert.equal(typeof mod.WSClient, 'function', 'WSClient 必须在（入站靠它）');
	assert.equal(typeof mod.Client, 'function', 'Client 也要在（下载图片等 REST 调用要用）');
});

await checkAsync('importSdk 抛错时原样透出（不伪造"未安装"文案）', async () => {
	const t = createSdkTransport({
		resolve: async () => ({ appId: 'a', appSecret: 'b' }),
		importSdk: async () => { throw new Error('boom-from-test'); },
	});
	await assert.rejects(
		() => t.start({ onEvent: () => undefined, onError: () => undefined }),
		(e) => String(e.message).includes('boom-from-test'),
	);
});

await checkAsync('vendor 缺失时的兜底线索：installDirOf 与可复制命令仍要给出', async () => {
	/* 这条只在"有人手动删了 vendor"时才走到；断言的是**报错里必须同时给出
	   目录线索与 npm 命令**（我们不再伪造"未安装"，但兜底信息不能少）。 */
	const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/adapters/feishuInbound.js', import.meta.url), 'utf8'));
	assert.ok(src.includes('npm i @larksuiteoapi/node-sdk'), '报错里要有可复制的安装命令');
	assert.ok(src.includes('loadVendored') && src.includes('loadNpm'), '两条加载路径都要在（vendor + npm 兜底）');
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 飞书入站网关单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
