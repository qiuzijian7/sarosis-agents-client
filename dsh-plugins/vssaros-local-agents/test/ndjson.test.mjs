#!/usr/bin/env node
// 事件归一与 StreamChunk 形状的纯函数测试（零依赖，直接 node 跑）。
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { linesOf, normalizeEvent, parseLine, toChunks } from '../lib/core/ndjson.js';
import { promptOf, textOfContent } from '../lib/core/adapter.js';

const fails = [];
let passed = 0;
const check = (name, fn) => {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};
const collect = async (events) => { const out = []; for await (const c of toChunks(events)) out.push(c); return out; };

check('parseLine 只认 JSON 对象，坏行安全跳过', () => {
	assert.deepEqual(parseLine('{"type":"x"}'), { type: 'x' });
	assert.equal(parseLine('not json'), undefined);
	assert.equal(parseLine('[1,2]'), undefined);
	assert.equal(parseLine(''), undefined);
});

check('Codex item.completed / turn.completed 归一', () => {
	assert.deepEqual(normalizeEvent('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}', 'codex-json'),
		{ type: 'text', text: 'hi' });
	assert.deepEqual(normalizeEvent('{"type":"turn.completed","usage":{"input_tokens":3}}', 'codex-json'),
		{ type: 'done', usage: { input_tokens: 3 } });
	assert.equal(normalizeEvent('{"type":"thread.started"}', 'codex-json'), undefined);
});

check('Claude assistant / result 归一', () => {
	assert.deepEqual(normalizeEvent('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}', 'claude-stream-json'),
		{ type: 'text', text: 'ok' });
	assert.deepEqual(normalizeEvent('{"type":"result","subtype":"success"}', 'claude-stream-json'),
		{ type: 'done', usage: undefined });
	assert.equal(normalizeEvent('{"type":"system","subtype":"init"}', 'claude-stream-json'), undefined);
});

check('错误事件归一为 error（交给 runtime 转 error finish）', () => {
	const error = normalizeEvent('{"type":"error","message":"not logged in"}', 'codex-json');
	assert.equal(error.type, 'error');
	assert.match(error.text, /not logged in/);
});

await checkAsync('toChunks 产出 block-start → text-delta → block-end → finish', async () => {
	const chunks = await collect([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
	assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'finish']);
	assert.equal(chunks[3].block.text, 'ab');
	assert.deepEqual(chunks[4].reason, { kind: 'stop' });
});
await checkAsync('无文本事件也必须以 finish 收尾（不挂住回合）', async () => {
	assert.deepEqual((await collect([])).map((c) => c.type), ['finish']);
});
await checkAsync('error 事件中断并抛错', async () => {
	await assert.rejects(async () => {
		for await (const _ of toChunks([{ type: 'text', text: 'a' }, { type: 'error', text: 'boom' }])) { /* drain */ }
	}, /boom/);
});
await checkAsync('usage 事件落在 finish 之前', async () => {
	const chunks = await collect([{ type: 'usage', usage: { input_tokens: 1 } }]);
	assert.deepEqual(chunks.map((c) => c.type), ['usage', 'finish']);
});
await checkAsync('linesOf 跨 chunk 拼接行、末尾无换行也吐出', async () => {
	const readable = Readable.from(['{"a":', '1}\n{"b":', '2}']);
	const lines = [];
	for await (const line of linesOf(readable)) lines.push(line);
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

check('promptOf 取最后一条 user + system 作为附加指令', () => {
	const options = {
		system: '  TEAM RULES  ',
		messages: [
			{ role: 'user', content: [{ type: 'text', text: 'first' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
			{ role: 'user', content: [{ type: 'text', text: 'second' }] },
		],
	};
	assert.equal(promptOf(options), 'TEAM RULES\n\nsecond');
	assert.equal(textOfContent('plain'), 'plain');
	assert.equal(textOfContent(null), '');
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
