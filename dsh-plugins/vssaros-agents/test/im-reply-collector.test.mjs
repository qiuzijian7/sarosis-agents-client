// @vssaros/dsh-agents — IM 回复回收单测（2026-11-10）
//   跑法：node dsh-plugins/vssaros-agents/test/im-reply-collector.test.mjs
//
// 真机事故：飞书消息到了、知识库专家也答了（会话 outputTokens 有值、回合结束），
// 但 outbox 里 `kind:'im'` 的条目永远 pending ⇒ 飞书收不到任何回复。
// 根因：installRelay 只回收 `kind:'relay'`，IM 回收分支随群聊下线一起被删。
// 这里守的是：turn-stopping 事件 → 确认本回合消费了 IM 消息 → 最终答复推回绑定。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installRelay } from '../lib/relay.js';
import { ensureOutboxLoaded, outboxList, outboxNote, outboxPendingFor } from '../lib/outbox.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const dir = mkdtempSync(join(tmpdir(), 'vsa-im-reply-'));
const config = { dataRoot: dir };
await ensureOutboxLoaded(config); // 固定 loadedRoot，后续 outboxList 不会重新读盘冲掉内存条目
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
const tick = () => new Promise((r) => setTimeout(r, 30));

/** 装一个 fake 顶层角色，抓到 turn-stopping 的 handler。 */
function harness({ deliverResult } = {}) {
	const delivered = [];
	const followups = [];
	let handler = null;
	const ctx = { on: (event, cb) => { if (event === 'agent/turn-stopping') { handler = cb; } return () => {}; } };
	const state = {
		agents: { get: () => ({ followup: (m) => followups.push(m) }) },
		bindingHub: {
			deliverForEntry: async (entry, text, images) => {
				delivered.push({ entry, text, images });
				return deliverResult ?? { ok: true, sent: 1 };
			},
		},
	};
	installRelay(ctx, config, state);
	assert.ok(handler, 'turn-stopping 监听未安装');
	return { delivered, followups, fire: async (session, events) => {
		await handler({ agent: { session: { ...session, snapshotEvents: () => events } } });
		await tick();
	} };
}

const spliced = (id) => ({ type: 'agent/inbox/spliced', data: { inserted: [{ id }] } });
const assistant = (parts) => ({ type: 'assistant/message', data: { message: { content: parts } } });
const imEntry = (sessionId, messageId, bindingId = 'b1') => outboxNote(config, {
	kind: 'im', sessionId, messageId, bindingId, platform: 'feishu', chatId: 'oc_1',
});

await checkAsync('★ IM 答复在 turn-stopping 后被推回绑定（含图），outbox 清空', async () => {
	const h = harness();
	const sid = 's-im-ok';
	const e = imEntry(sid, 'm-im-ok');
	await h.fire({ id: sid, seq: 10 }, [
		spliced(e.messageId),
		assistant([{ type: 'text', text: '  这是给飞书的答复  ' },
			{ type: 'image', mediaType: 'image/png', data: 'QQ==', name: 'p.png' }]),
	]);
	assert.equal(h.delivered.length, 1, '必须调用 deliverForEntry');
	assert.equal(h.delivered[0].text, '这是给飞书的答复');
	assert.equal(h.delivered[0].images.length, 1);
	assert.equal(h.delivered[0].images[0].data, 'QQ==');
	assert.equal(h.delivered[0].entry.bindingId, 'b1');
	assert.equal(outboxPendingFor(sid).length, 0, '投递成功要 resolve');
	assert.equal(h.followups.length, 0, 'IM 条目不该走 relay 的 followup');
});

await checkAsync('★ IM 投递失败 ⇒ 标 unknown + 记日志，不静默删', async () => {
	const h = harness({ deliverResult: { ok: false, reason: 'send-failed', error: 'token 失效' } });
	const sid = 's-im-fail';
	const e = imEntry(sid, 'm-im-fail');
	await h.fire({ id: sid, seq: 10 }, [spliced(e.messageId), assistant([{ type: 'text', text: '答复' }])]);
	assert.equal(h.delivered.length, 1);
	assert.equal(outboxPendingFor(sid).length, 0, '失败条目不能还挂在 pending');
	const all = await outboxList(config);
	const row = all.entries.find((x) => x.messageId === e.messageId);
	assert.equal(row?.status, 'unknown');
	assert.match(String(row?.note || ''), /token 失效/);
	assert.ok(warnings.some((w) => /IM 回复投递失败/.test(w)), '失败要留日志，便于排查');
});

await checkAsync('★ 同回合命中多条 im pending（含历史遗留）⇒ 只投一次，全部回收', async () => {
	const h = harness();
	const sid = 's-im-dup';
	const old = imEntry(sid, 'm-im-old', 'b-old');
	const recent = imEntry(sid, 'm-im-recent', 'b-recent');
	await h.fire({ id: sid, seq: 20 }, [
		spliced(old.messageId),     // Host 重启后 seenSeq 归零 ⇒ 全量窗口会带上的历史 splice
		spliced(recent.messageId),  // 本回合新消息
		assistant([{ type: 'text', text: '唯一答复' }]),
	]);
	assert.equal(h.delivered.length, 1, '一个回合只准回一条，别把同一份答复推 N 次');
	assert.equal(h.delivered[0].entry.messageId, recent.messageId, '应投给本回合最后消费的那条');
	assert.equal(h.delivered[0].entry.bindingId, 'b-recent');
	assert.equal(h.delivered[0].text, '唯一答复');
	assert.equal(outboxPendingFor(sid).length, 0, '历史 pending 也要一并回收，别留到下次再被命中');
});

await checkAsync('★ 投递失败时历史 im pending 也不留在 pending（避免下次重复推）', async () => {
	const h = harness({ deliverResult: { ok: false, error: 'token 失效' } });
	const sid = 's-im-dup-fail';
	const old = imEntry(sid, 'm-im-dup-old');
	const recent = imEntry(sid, 'm-im-dup-recent');
	await h.fire({ id: sid, seq: 20 }, [
		spliced(old.messageId), spliced(recent.messageId),
		assistant([{ type: 'text', text: '答复' }]),
	]);
	assert.equal(h.delivered.length, 1, '失败也只尝试一次');
	assert.equal(outboxPendingFor(sid).length, 0);
	const all = await outboxList(config);
	for (const mid of [old.messageId, recent.messageId]) {
		assert.equal(all.entries.find((x) => x.messageId === mid)?.status, 'unknown');
	}
});

await checkAsync('★ 群绑定：群会话（sessionId = roomId）的 im pending 同样回传到 IM', async () => {
	const h = harness();
	const sid = 'room-番茄钟-H5';
	const e = imEntry(sid, 'm-room-post');
	await h.fire({ id: sid, seq: 10 }, [
		spliced(e.messageId),
		assistant([{ type: 'text', text: '**Designer**：交互稿好了' }]),
	]);
	assert.equal(h.delivered.length, 1, '回复回收器不挑会话类型，群会话也要推回飞书');
	assert.equal(h.delivered[0].text, '**Designer**：交互稿好了');
	assert.equal(outboxPendingFor(sid).length, 0);
});

await checkAsync('★ relay 分支行为不变（followup 回发送方，不碰 IM 出站）', async () => {
	const h = harness();
	const sid = 's-relay';
	const e = outboxNote(config, { kind: 'relay', sessionId: sid, messageId: 'm-relay', from: 'sender-1', hop: 1 });
	await h.fire({ id: sid, seq: 10 }, [spliced(e.messageId), assistant([{ type: 'text', text: 'relay 答复' }])]);
	assert.equal(h.followups.length, 1);
	assert.match(h.followups[0].content[0].text, /relay 答复/);
	assert.equal(h.delivered.length, 0);
	assert.equal(outboxPendingFor(sid).length, 0);
});

await checkAsync('★ 回合没消费我们的消息 ⇒ 不投递、pending 留着', async () => {
	const h = harness();
	const sid = 's-unrelated';
	const e = imEntry(sid, 'm-im-other');
	await h.fire({ id: sid, seq: 10 }, [spliced('someone-else'), assistant([{ type: 'text', text: '别人的答复' }])]);
	assert.equal(h.delivered.length, 0);
	assert.equal(outboxPendingFor(sid).length, 1, 'pending 不能被误删');
});

await checkAsync('★ 回合没有最终答复 ⇒ 标 unknown（不假装成功、也不永久 pending）', async () => {
	const h = harness();
	const sid = 's-no-final';
	const e = imEntry(sid, 'm-im-no-final');
	await h.fire({ id: sid, seq: 10 }, [spliced(e.messageId), { type: 'tool/result', data: {} }]);
	assert.equal(h.delivered.length, 0);
	const all = await outboxList(config);
	assert.equal(all.entries.find((x) => x.messageId === e.messageId)?.status, 'unknown');
});

console.warn = realWarn;
try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
if (fails.length) {
	console.error(`✗ IM 回复回收单测：${fails.length} 失败 / ${pass} 通过`);
	for (const f of fails) { console.error('  - ' + f); }
	process.exit(1);
}
console.log(`✓ IM 回复回收单测 ${pass}/${pass} 全部通过`);
