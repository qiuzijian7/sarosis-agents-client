// @vssaros/dsh-agents — IM 图片 → prompt image part（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/binding-media.test.mjs
//
// 这是富媒体整条链路**最后一环**、也是最关键的一环：
//   适配器把图下成 base64 之后，`dispatchImToAgent` 必须真的把它放进 prompt 的 content 数组，
//   否则前面全白做（用户发了图，agent 只看到一行 `[图片]`）。
//
// 依据：dsh 的 `PromptContentPart` 已支持 `{ type:'image', mediaType, data }`（data 为 base64）。
// ⚠ 只放行 jpeg/png —— 标错 mediaType 比丢掉更糟（上游按错误格式解码会得到乱码）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchImToAgent } from '../lib/bindings.js';
import { ensureOutboxLoaded, resetOutbox } from '../lib/outbox.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-bm-'));
const config = { dataRoot: root };
resetOutbox();
await ensureOutboxLoaded(config);

const deps = {
	scanAgents: async () => ({ agents: [{ id: 'coder', name: 'Coder', presetId: 'p' }] }),
	ensureSession: async () => ({ sessionId: 's1' }),
};

/** 每个用例独立的 state：把 steer/followup 收到的 message 收进数组。 */
function makeState() {
	const got = [];
	const live = { steer: (m) => got.push(m), followup: (m) => got.push(m) };
	return { got, state: { agents: { get: () => live } } };
}

const binding = {
	id: 'b1', platform: 'telegram', chatId: 'c1', chatType: 'p2p',
	targetKind: 'agent', targetId: 'coder', direction: 'both', enabled: true,
};

await checkAsync('★ 带图片 ⇒ prompt content = [text, image]', async () => {
	const { got, state } = makeState();
	await dispatchImToAgent(config, state, binding, {
		content: '看看这个报错',
		images: [{ mediaType: 'image/png', data: 'QUJD', name: 'shot.png' }],
	}, deps);
	assert.equal(got.length, 1);
	const parts = got[0].content;
	assert.equal(parts.length, 2, JSON.stringify(parts.map((p) => p.type)));
	assert.equal(parts[0].type, 'text');
	assert.ok(String(parts[0].text).includes('看看这个报错'));
	assert.equal(parts[1].type, 'image');
	assert.equal(parts[1].mediaType, 'image/png');
	assert.equal(parts[1].data, 'QUJD');
	assert.equal(parts[1].name, 'shot.png');
});

await checkAsync('没有图片 ⇒ content 只有一段 text（行为与从前一致）', async () => {
	const { got, state } = makeState();
	await dispatchImToAgent(config, state, binding, { content: '纯文字' }, deps);
	assert.equal(got[0].content.length, 1);
	assert.equal(got[0].content[0].type, 'text');
});

await checkAsync('★ 超过 2 张 ⇒ 只取前 2 张（prompt 装不下更多）', async () => {
	const { got, state } = makeState();
	await dispatchImToAgent(config, state, binding, {
		content: '三张图',
		images: [
			{ mediaType: 'image/png', data: 'A' },
			{ mediaType: 'image/png', data: 'B' },
			{ mediaType: 'image/png', data: 'C' },
		],
	}, deps);
	const imgs = got[0].content.filter((p) => p.type === 'image');
	assert.equal(imgs.length, 2);
	assert.deepEqual(imgs.map((p) => p.data), ['A', 'B']);
});

await checkAsync('★ 不支持的类型 / 空 data ⇒ 跳过（不要产出坏 part）', async () => {
	const { got, state } = makeState();
	await dispatchImToAgent(config, state, binding, {
		content: '混合',
		images: [
			{ mediaType: 'image/webp', data: 'X' },      // 类型不放行
			/* ⚠ 有效的那条必须落在 `slice(0,2)` 之内 —— 上一版把它放在第 3 位，
			   被"最多 2 张"的截断切掉了，于是断言误判成"代码把 jpeg 也丢了"。 */
			{ mediaType: 'image/jpeg', data: 'OK' },     // 这条要留
			{ mediaType: 'image/png', data: '' },        // 没数据（本来就会被截断）
		],
	}, deps);
	const imgs = got[0].content.filter((p) => p.type === 'image');
	assert.equal(imgs.length, 1, JSON.stringify(got[0].content.map((p) => p.type)));
	assert.equal(imgs[0].mediaType, 'image/jpeg');
});

await checkAsync('jpg 别名归一成 image/jpeg', async () => {
	const { got, state } = makeState();
	await dispatchImToAgent(config, state, binding, {
		content: 'x', images: [{ mediaType: 'image/jpg', data: 'Q' }],
	}, deps);
	const img = got[0].content.find((p) => p.type === 'image');
	assert.equal(img.mediaType, 'image/jpeg');
});

await checkAsync('纯图片消息（content 占位 [图片]）也能派发', async () => {
	const { got, state } = makeState();
	await dispatchImToAgent(config, state, binding, { content: '[图片]', images: [{ mediaType: 'image/png', data: 'Z' }] }, deps);
	assert.equal(got[0].content.length, 2);
	assert.ok(String(got[0].content[0].text).includes('[图片]'));
});

/* ⚠ 先等一下再删目录：`outboxNote` 是**不等**的异步写，删太快会报 ENOENT（噪音，不是失败） */
await new Promise((r) => setTimeout(r, 80));
try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ IM 图片进 prompt 单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
