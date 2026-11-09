#!/usr/bin/env node
// P2：模型侧图片内容块 → 本地 Agent 输入（ACP 真发图 / NDJSON 明确降级）。
import assert from 'node:assert/strict';
import {
	MAX_IMAGES_PER_TURN, MAX_IMAGE_BYTES, acpPromptBlocks, imageNoticeOf, imageRefsOf,
	lastUserContent, supportsImages, withInstructions,
} from '../lib/core/images.js';
import { createAcpAdapter } from '../lib/core/acpAdapter.js';
import { createLocalAgentAdapter } from '../lib/core/adapter.js';
import { EventQueue } from '../lib/core/queue.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};

const ref = (id = 'att-1', mediaType = 'image/png') => ({ attachmentId: id, mediaType, bytes: 4, width: 1, height: 1 });
const readImage = async () => ({ data: Buffer.from('PNGDATA') });
const contentWithImage = [
	{ type: 'text', text: '看看这张图' },
	{ type: 'image', attachment: ref() },
];

class FakeEngine {
	constructor() {
		this.queue = new EventQueue();
		this.prompts = [];
	}
	async ensure() {}
	async listModels() { return [{ id: 'default', name: 'CLI default' }]; }
	async openSession() { return 'cli-s1'; }
	events() { return this.queue; }
	prompt(id, text, options) { this.prompts.push({ id, text, options }); }
	cancel() {}
	answerPermission() { return true; }
	dispose() {}
}

const ACP_ROUTE = 'vssaros-acp-probe';
const ND_ROUTE = 'vssaros-ndjson-probe';
const table = {
	[ACP_ROUTE]: { kind: 'acp', name: 'ACP', command: 'x', args: [], models: [] },
	[ND_ROUTE]: { kind: 'codex-json', name: 'NDJSON', command: 'x', args: [], models: [] },
};
const msg = (content) => ({ role: 'user', content });

await checkAsync('imageRefsOf 只收 {type:image, attachment} 块', async () => {
	assert.equal(imageRefsOf(contentWithImage).length, 1);
	assert.equal(imageRefsOf(contentWithImage)[0].attachmentId, 'att-1');
	assert.deepEqual(imageRefsOf('text'), []);
	assert.deepEqual(imageRefsOf([{ type: 'image' }, { type: 'text', text: 'x' }]), []);
});

await checkAsync('supportsImages：只有 ACP + readImage 才为真', async () => {
	assert.equal(supportsImages(table[ACP_ROUTE], readImage), true);
	assert.equal(supportsImages(table[ACP_ROUTE], undefined), false);
	assert.equal(supportsImages(table[ND_ROUTE], readImage), false);
	assert.equal(supportsImages(undefined, readImage), false);
});

await checkAsync('lastUserContent 取最后一条 user；imageNoticeOf 明确说明未看图', async () => {
	const options = { messages: [msg([{ type: 'text', text: '旧' }]), msg(contentWithImage)] };
	assert.equal(lastUserContent(options).length, 2);
	assert.equal(imageNoticeOf([{ type: 'text', text: 'x' }]), '');
	const notice = imageNoticeOf(contentWithImage);
	assert.match(notice, /1 张图片/);
	assert.match(notice, /不支持图片输入/);
	assert.match(notice, /ACP 引擎/);
});

await checkAsync('★ acpPromptBlocks：按原顺序发 text + ACP image 块，base64/mimeType 正确', async () => {
	const { blocks, images } = await acpPromptBlocks({ content: contentWithImage, readImage });
	assert.equal(images, 1);
	assert.equal(blocks.length, 2);
	assert.deepEqual(blocks[0], { type: 'text', text: '看看这张图' });
	assert.equal(blocks[1].type, 'image');
	assert.equal(blocks[1].mimeType, 'image/png');
	assert.equal(Buffer.from(blocks[1].data, 'base64').toString(), 'PNGDATA');
});

await checkAsync('读图失败 / 无附件服务：降级成明确文本，不中断回合也不静默丢', async () => {
	const missing = await acpPromptBlocks({ content: contentWithImage });
	assert.equal(missing.images, 0);
	assert.match(missing.blocks.at(-1).text, /附件服务不可用/);
	const throwing = await acpPromptBlocks({
		content: contentWithImage,
		readImage: async () => { throw new Error('附件已过期'); },
	});
	assert.match(throwing.blocks.at(-1).text, /附件已过期/);
	const empty = await acpPromptBlocks({ content: contentWithImage, readImage: async () => ({ data: new Uint8Array() }) });
	assert.match(empty.blocks.at(-1).text, /字节为空/);
});

await checkAsync('张数与体积上限：超限给可读说明，不放大攻击面', async () => {
	const many = Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, (_, i) => ({ type: 'image', attachment: ref(`att-${i}`) }));
	const tooMany = await acpPromptBlocks({ content: many, readImage });
	assert.equal(tooMany.images, MAX_IMAGES_PER_TURN);
	assert.match(tooMany.blocks.at(-1).text, /超出单次/);
	const tooBig = await acpPromptBlocks({
		content: contentWithImage,
		readImage: async () => ({ data: new Uint8Array(MAX_IMAGE_BYTES + 1) }),
	});
	assert.match(tooBig.blocks.at(-1).text, /超过 .* 上限/);
});

await checkAsync('未知内容块降级为文本提示；withInstructions 把 system 放最前', async () => {
	const out = await acpPromptBlocks({ content: [{ type: 'file', attachment: {} }, { type: 'text', text: 'hi' }], readImage });
	assert.match(out.blocks[0].text, /file 内容未传/);
	const withSystem = withInstructions(out.blocks, '团队规则');
	assert.deepEqual(withSystem[0], { type: 'text', text: '团队规则' });
	assert.deepEqual(withInstructions(out.blocks, ''), out.blocks);
});

await checkAsync('★ resolveModel 声明与实现一致：ACP+附件才含 image，NDJSON 永远纯文本', async () => {
	const withService = createLocalAgentAdapter({ engineTable: table, readImage });
	assert.deepEqual((await withService.resolveModel(ACP_ROUTE, 'default')).inputModalities, ['text', 'image']);
	assert.deepEqual((await withService.resolveModel(ND_ROUTE, 'default')).inputModalities, ['text']);
	const withoutService = createLocalAgentAdapter({ engineTable: table });
	assert.deepEqual((await withoutService.resolveModel(ACP_ROUTE, 'default')).inputModalities, ['text']);
	withService.dispose();
	withoutService.dispose();
});

await checkAsync('★ NDJSON 单轮路径：有图时 stdin 附明确提示（不假装看过图）', async () => {
	let written = '';
	const child = {
		stdin: { write(text) { written += text; }, end() {} },
		stdout: (async function* () { yield JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }); })(),
		kill() {},
	};
	const adapter = createLocalAgentAdapter({
		engineTable: table,
		findExecutable: () => '/fake/x',
		cleanEnv: () => ({}),
		spawnProcess: () => child,
	});
	const out = [];
	for await (const chunk of adapter.stream({ provider: ND_ROUTE, model: 'default', messages: [msg(contentWithImage)] })) out.push(chunk);
	assert.match(written, /不支持图片输入/);
	assert.match(written, /看看这张图/);
	assert.equal(out.at(-1).type, 'finish');
	adapter.dispose();
});

await checkAsync('★ ACP 多轮路径：有图时 engine.prompt 收到含 image 块的数组，纯文本仍是字符串', async () => {
	const engine = new FakeEngine();
	const adapter = createAcpAdapter({
		engineTable: { [ACP_ROUTE]: table[ACP_ROUTE] },
		deps: { engineFactory: () => engine, readImage },
	});
	try {
		engine.queue.push({ type: 'done' });
		const out = [];
		for await (const chunk of adapter.stream({
			provider: ACP_ROUTE, model: 'default', sessionId: 's-img', messages: [msg(contentWithImage)],
		})) out.push(chunk);
		assert.equal(out.at(-1).reason.kind, 'stop');
		const prompt = engine.prompts[0].text;
		assert.ok(Array.isArray(prompt), '含图片时必须是 ContentBlock[]');
		assert.equal(prompt.at(-1).type, 'image');
		assert.equal(prompt.at(-1).mimeType, 'image/png');

		engine.queue.push({ type: 'done' });
		const textOnly = [];
		for await (const chunk of adapter.stream({
			provider: ACP_ROUTE, model: 'default', sessionId: 's-img',
			messages: [msg(contentWithImage), msg([{ type: 'text', text: '继续' }])],
		})) textOnly.push(chunk);
		assert.equal(typeof engine.prompts[1].text, 'string', '纯文本回合保持 P1 字符串路径');
		assert.equal(engine.prompts[1].text, '继续');
	} finally {
		adapter.dispose();
	}
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
