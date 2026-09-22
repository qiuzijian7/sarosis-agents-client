/*---------------------------------------------------------------------------------------------
 *  `AgentChatService.sendMessage` **行为基线**（2026-09-22 ✓）。
 *
 *  为什么需要它 ✓：`sendMessage` 是仓内最大的热路径方法（**757 行 / 30+ 个局部累加器** ✗），
 *  后续若要把它拆成 `StreamAccumulator` + 分发器，**结构搬运正确 ≠ 行为不变** ✗✓。
 *  本文件用**脚本化的 delta 序列**（假 driver ✓）钉住"外部可观测行为"，包括：
 *    · 返回的最终 assistant 消息（content / role / 归属 ✓）；
 *    · **落盘**结果（会话日志 + 快照 ✓）与 **`getHistory` 可见性**（重启后语义 ✓）；
 *    · `onDelta` **逐条透传**（UI 的唯一输入 ✓）；
 *    · `priorMessages` 组装（B 方案 ⇒ 模型能否看到历史 ✓）；
 *    · `discard_prior_text`（幻觉文本**必须被丢弃** —— **含 `parts` 里的那一份** ✗✓；
 *      本基线首跑即发现 host 漏丢 `parts` 的真缺陷，同日修复 ✓✓）；
 *    · 工具调用（`tool_start` + `tool_result` ⇒ 最终消息带 result ✓）。
 *
 *  ⚠ 它是**基线**不是规格 ✓：断言值 = **当前真实行为**（先跑、把实测值写进来 ✓）。
 *     动 `sendMessage` 内部结构前先跑它 ✓；红了就说明行为变了 ⇒ 要么改回去，要么**有意**更新基线 ✓✓。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/agentChatService.sendMessage.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { AgentChatService } from '../../browser/agentChatService.js';
import type { ChatMessage } from '../../common/types.js';

const pathOf = (uri: any): string => uri?.fsPath ?? String(uri);

interface IFakeFs {
	files: Map<string, string>;
	writes: { path: string; append: boolean }[];
	api: any;
	logs: { warns: string[]; infos: string[]; errors: string[] };
}

function makeFakeFs(): IFakeFs {
	const files = new Map<string, string>();
	const writes: { path: string; append: boolean }[] = [];
	const api: any = {
		exists: async (uri: any) => files.has(pathOf(uri)),
		createFolder: async () => { },
		readFile: async (uri: any) => {
			const p = pathOf(uri);
			if (!files.has(p)) { throw new Error(`ENOENT ${p}`); }
			return { value: VSBuffer.fromString(files.get(p)!) };
		},
		writeFile: async (uri: any, buf: any, opts?: any) => {
			const p = pathOf(uri);
			writes.push({ path: p, append: !!opts?.append });
			files.set(p, opts?.append ? (files.get(p) ?? '') + buf.toString() : buf.toString());
		},
		del: async (uri: any) => { files.delete(pathOf(uri)); },
		copy: async (src: any, dst: any) => {
			const s = pathOf(src);
			if (files.has(s)) { files.set(pathOf(dst), files.get(s)!); }
		},
		resolve: async () => ({ children: [] }),
		hasCapability: () => true,
	};
	return { files, writes, api, logs: { warns: [], infos: [], errors: [] } };
}

interface IDriverCall {
	agentId: string;
	message: string;
	options: any;
	priorMessages: any[] | undefined;
}

/** 假 driver：把**脚本化 delta 序列**一次性 yield 出去（并记录调用参数 ✓）。 */
function makeDriver(deltas: any[]) {
	const calls: IDriverCall[] = [];
	const driver: any = {
		executeFromChatOptions: (agentId: string, message: string, options: any, priorMessages?: any[]) => {
			calls.push({ agentId, message, options, priorMessages });
			return (async function* () {
				for (const d of deltas) { yield d; }
			})();
		},
		getActiveMemoryProvider: () => undefined,
		compactMessagesForSession: async () => ({ didCompact: false }),
	};
	return { driver, calls };
}

function makeService(fs: IFakeFs, driver: any): AgentChatService {
	const log: any = {
		info(...a: unknown[]) { fs.logs.infos.push(a.map(String).join(' ')); },
		warn(...a: unknown[]) { fs.logs.warns.push(a.map(String).join(' ')); },
		error(...a: unknown[]) { fs.logs.errors.push(a.map(String).join(' ')); },
		debug() { }, trace() { },
	};
	const environmentService: any = { userRoamingDataHome: URI.file('/tmp/vssaros') };
	return new AgentChatService(
		log, driver, fs.api, environmentService,
		{ getValue: () => undefined } as any,
		{ getActiveWorkspaceId: () => undefined, getWorkspace: async () => undefined } as any,
		{ onWillShutdown: () => ({ dispose() { } }) } as any,
	);
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 30));

/** 起一个已发过一条用户消息的会话（给 sendMessage 提供 prior 历史 ✓）。 */
async function seed(svc: AgentChatService, content = '历史消息'): Promise<void> {
	await svc.appendMessage('agent-1', {
		id: `seed_${content}`, role: 'user', content, agentSessionId: 'sess-1', timestamp: '',
	} as ChatMessage);
	await settle();
}

const sendOpts = { agentSessionId: 'sess-1' } as any;

// ─────────────────────────────────────────────────────────────────────────────
suite('sendMessage 行为基线 — 文本流', () => {

	test('★ 多段 text ⇒ 最终消息把它们拼成一条；onDelta 逐条透传', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'text', content: '你好' },
			{ type: 'text', content: '，世界' },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const seen: string[] = [];
		const final = await svc.sendMessage('agent-1', 'hi', sendOpts, d => seen.push(d.type));
		await settle();

		assert.strictEqual(final.role, 'assistant', '返回的必须是 assistant 消息 ✓');
		assert.strictEqual(final.content, '你好，世界', '多段 text 必须拼接为最终 content ✓');
		assert.strictEqual(final.agentId, 'agent-1');
		assert.strictEqual(final.agentSessionId, 'sess-1');
		assert.ok(final.id.startsWith('msg_'), `id 必须是 msg_* 形态（实际 ${final.id} ✗）`);
		assert.deepStrictEqual(seen, ['text', 'text', 'done'], 'onDelta 必须**逐条、同序**透传 ✓');
	});

	test('★★ 纯文本流的 `parts` 不变量：= 单一 text 段，且与 `content` 一致（渲染真相源 ✓）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'text', content: 'aa' },
			{ type: 'text', content: 'bb' },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const final = await svc.sendMessage('agent-1', 'hi', sendOpts, () => { });
		await settle();
		const parts = ((final as any).parts ?? []) as any[];
		assert.strictEqual(parts.length, 1, `纯文本流只应有 1 个段（实际 ${parts.length} ✗）`);
		assert.strictEqual(parts[0].kind, 'text');
		assert.strictEqual(parts[0].text, final.content,
			'`parts[0].text` 必须等于 `content` —— 二者不一致时"重启后显示的内容"会与"当时看到的"不同 ✗✓');
	});

	test('★ 落盘 + getHistory 可见：新实例重载仍能看到这一轮', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([{ type: 'text', content: '答案' }, { type: 'done' }]);
		const svc = makeService(fs, driver);
		await svc.sendMessage('agent-1', '问题', sendOpts, () => { });
		await settle();

		assert.ok(fs.writes.length > 0, '必须至少有一次落盘（日志或快照 ✓）');
		// 模拟重启：全新实例 + 同一份磁盘 ✓
		const svc2 = makeService(fs, makeDriver([]).driver);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		const contents = history.map(m => m.content);
		assert.ok(contents.includes('问题'), `user 消息必须落盘（实际 ${JSON.stringify(contents)} ✗）`);
		assert.ok(contents.some(c => c === '答案'), 'assistant 消息必须落盘 ✓');
	});

	test('★★ priorMessages 组装：driver 必须收到已有历史（B 方案 —— 否则模型失忆 ✗）', async () => {
		const fs = makeFakeFs();
		const { driver, calls } = makeDriver([{ type: 'text', content: 'ok' }, { type: 'done' }]);
		const svc = makeService(fs, driver);
		await seed(svc, '上一轮的任务指令');
		await svc.sendMessage('agent-1', '继续', sendOpts, () => { });

		assert.strictEqual(calls.length, 1, '必须恰好调用 driver 一次 ✓');
		const prior = calls[0].priorMessages ?? [];
		assert.ok(prior.length >= 1, `priorMessages 必须非空（实际 ${prior.length} ✗）—— 为空即"模型失忆"✓`);
		assert.ok(JSON.stringify(prior).includes('上一轮的任务指令'),
			'prior 必须包含已有历史内容 ✓');
		assert.ok(!JSON.stringify(prior).includes('"content":"继续"'),
			'当前这条 user 消息**不得**重复出现在 prior 里（driver 会自己追加 ✓）');
	});
});

suite('sendMessage 行为基线 — 思考 / 丢弃 / 工具 / usage', () => {

	test('thinking delta ⇒ 保留在最终消息里（reasoning/thinking 之一 ✓）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'thinking', content: '先想一想' },
			{ type: 'text', content: '答案' },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const final = await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();
		assert.strictEqual(final.content, '答案', 'thinking 不得混进 content ✓');
		assert.ok(JSON.stringify(final).includes('先想一想'),
			'思考内容必须留存（reasoning 或 thinking ✓）—— 否则 UI 丢思考链 ✗');
	});

	test('★★ discard_prior_text ⇒ 之前的幻觉文本必须被丢弃（否则污染下一轮 ✗✓）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'text', content: '我刚才假装完成了任务' },
			{ type: 'discard_prior_text', metadata: { reason: 'fake-completion' } },
			{ type: 'text', content: '真正执行' },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const final = await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();
		assert.strictEqual(final.content, '真正执行',
			'被丢弃的文本必须从 content 中消失（conversation rot 的根因对策 ✓）');
		// ✅ 2026-09-22 **已修复**（本基线首跑即发现、同日修复 ✓✓）：
		//   原实现只清 `content`、漏了 `parts` ✗ ⇒ 幻觉文本仍被渲染+落盘 ✗（conversation rot 污染 ✓）。
		//   现 `discard_prior_text` **同时丢弃 `parts` 末尾连续的 text 段** ✓✓。
		//   ⚠ 反向说明：pi 路径（`piLoop/eventAdapter.ts:65` ✓）**只发这一个 delta、不伴随
		//   `content_replace`** ✗ ⇒ 若这里不丢，就真的没人丢了 ✓（旧注释的假设只对 legacy 路径成立 ✗）。
		const partsText = JSON.stringify((final as any).parts ?? []);
		assert.ok(!partsText.includes('假装完成'),
			'幻觉文本必须从 `parts` 中一并消失（`parts` = 重载渲染的真相源 ✗✓）');
		assert.deepStrictEqual((final as any).parts, [{ kind: 'text', text: '真正执行' }],
			'丢弃后 `parts` 应只剩信号之后那段文本 ✓');
	});

	test('★★ tool_start + tool_result ⇒ 最终消息带工具调用及其结果', async () => {
		const fs = makeFakeFs();
		// ⚠ delta 契约（实测 ✓）：**参数走独立的 `tool_args` delta**，结果走
		//   `tool_result.content` ✓ —— `tool_start` 上的 `arguments` 与 `tool_result.result`
		//   是**读不到的** ✗✓（本基线首跑就因此失败 ⇒ 契约已成文 ✓）。
		const { driver } = makeDriver([
			{ type: 'tool_start', toolCallId: 't1', toolName: 'file_read' },
			{ type: 'tool_args', toolCallId: 't1', content: '{"p":"a.ts"}' },
			{ type: 'tool_result', toolCallId: 't1', content: '文件内容' },
			{ type: 'text', content: '读完了' },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const final = await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();

		const tcs = (final.toolCalls ?? []) as any[];
		assert.strictEqual(tcs.length, 1, `最终消息必须带 1 个工具调用（实际 ${tcs.length} ✗）`);
		assert.strictEqual(tcs[0].id, 't1', '工具调用 id 必须与 delta 一致（否则 tool_result 回填不上 ✗）');
		assert.strictEqual(tcs[0].name, 'file_read');
		assert.strictEqual(tcs[0].arguments, '{"p":"a.ts"}', '参数必须由 `tool_args` delta 回填 ✓');
		assert.strictEqual(String(tcs[0].result), '文件内容', '工具结果必须回填到对应调用 ✓');
		assert.strictEqual(tcs[0].status, 'done',
			'工具完成后必须打 status=done（否则刷新后卡片永远停在 loading ✗✓）');
		assert.strictEqual(final.content, '读完了', '文本与工具调用并存 ✓');
		// parts 里应有一条 tool 段 + 一条 text 段（渲染真相源 ✓）
		const kinds = ((final as any).parts ?? []).map((p: any) => p.kind);
		assert.deepStrictEqual(kinds, ['tool', 'text'], `parts 顺序应为 工具→文本（实际 ${kinds} ✗）`);
	});

	test('usage delta ⇒ token 用量进入最终消息（否则 UI 无 tokens/credit ✗）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'text', content: 'x' },
			{ type: 'usage', usage: { inputTokens: 111, outputTokens: 222, totalTokens: 333, cachedTokens: 44 } },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const final = await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();
		const json = JSON.stringify(final);
		assert.ok(json.includes('222'), `usage 必须留存（期望含 outputTokens=222 ✓ 实际：${json.slice(0, 400)} ✗）`);
	});
});
suite('sendMessage 行为基线 — 多轮 / 跨轮 usage / 压缩边界', () => {

	test('★★ 多轮 assistant_turn ⇒ **多条** assistant 消息（Hermes 回合边界 ✓；压扁成一条会教坏模型 ✗✓）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'text', content: 'A' },
			{ type: 'assistant_turn', content: 'A', metadata: { toolCallIds: [], turnIndex: 0 } },
			{ type: 'text', content: 'B' },
			{ type: 'assistant_turn', content: 'B', metadata: { toolCallIds: [], turnIndex: 1 } },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();

		const svc2 = makeService(fs, makeDriver([]).driver);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		const assistants = history.filter(m => m.role === 'assistant');
		assert.deepStrictEqual(assistants.map(m => m.content), ['A', 'B'],
			`两个 iteration 必须落成**两条** assistant 消息（实际 ${JSON.stringify(assistants.map(m => m.content))} ✗）`);
	});

	test('★★ usage 跨 delta **累加**（同一 turn 内多次 usage ⇒ 求和，不是覆盖 ✓）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'text', content: 'x' },
			{ type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } },
			{ type: 'usage', usage: { inputTokens: 20, outputTokens: 2 } },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const final = await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();
		const json = JSON.stringify(final);
		assert.ok(json.includes('"input":30'),
			`usage 必须**累加**为 input=30（实际：${json.slice(0, 400)} ✗）`);
		assert.ok(json.includes('"output":3'), 'output 同样累加为 3 ✓');
	});

	test('★★ context_compacted ⇒ 捕获边界并随落盘消息插入（压缩点回放的依据 ✓）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'text', content: '本轮输出' },
			{ type: 'context_compacted', compressionSummary: '这是压缩摘要', compressionOriginalCount: 40, compressionCompressedCount: 1, compressionTokensSaved: 500, compressionSummaryChars: 7 },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();

		const svc2 = makeService(fs, makeDriver([]).driver);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		const boundary = history.find(m => JSON.stringify(m).includes('compaction'));
		assert.ok(boundary,
			`必须落盘一条压缩边界消息（实际消息：${JSON.stringify(history.map(m => m.content)).slice(0, 300)} ✗）`);
		assert.ok(JSON.stringify(boundary).includes('这是压缩摘要'), '边界必须带摘要原文 ✓');
		assert.ok(fs.logs.infos.some(l => l.includes('Captured compaction boundary')),
			'必须留下「Captured compaction boundary」日志（宿主侧打印 ✓；本基线顺带钉住日志文案 ✓）');
	});
});
suite('sendMessage 行为基线 — 收尾落盘段（跨 turn 回填 / 边界位置 / 重启 parts）', () => {

	test('★★★ 工具调用**归属发起它的那个 turn**，且结果在后续 turn 到达时仍回填（跨 turn 回填 ✓）', async () => {
		const fs = makeFakeFs();
		// ⚠ 关键时序 ✓：`tool_result` 在 **assistant_turn 之后** 才到 ✗ ⇒ 收尾时必须回头填进
		//   **已经构建好的**那条 turn 消息里 ✓；而该工具**不得**被后面的 turn 重复认领 ✗✓
		//   （否则刷新后同一个卡片出现两次 ✓）。
		const { driver } = makeDriver([
			{ type: 'tool_start', toolCallId: 't1', toolName: 'file_read' },
			{ type: 'tool_args', toolCallId: 't1', content: '{"p":"a.ts"}' },
			{ type: 'assistant_turn', content: '先读文件', metadata: { toolCallIds: ['t1'], turnIndex: 0 } },
			{ type: 'tool_result', toolCallId: 't1', content: '文件内容' },
			{ type: 'text', content: '读完了' },
			{ type: 'assistant_turn', content: '读完了', metadata: { toolCallIds: [], turnIndex: 1 } },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();

		const svc2 = makeService(fs, makeDriver([]).driver);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		const assistants = history.filter(m => m.role === 'assistant');
		assert.strictEqual(assistants.length, 2, `应落 2 条 assistant（实际 ${assistants.length} ✗）`);

		const first = assistants[0].toolCalls ?? [];
		assert.strictEqual(first.length, 1, `第 1 个 turn 必须认领 t1（实际 ${first.length} 个 ✗）`);
		assert.strictEqual((first[0] as any).id, 't1', '工具必须归属**发起它的那个 turn** ✓');
		assert.strictEqual(String((first[0] as any).result), '文件内容',
			'结果在 turn 之后才到 ⇒ 收尾必须**跨 turn 回填**（否则卡片永远无结果 ✗✓）');
		assert.strictEqual((first[0] as any).status, 'done', '回填后必须打 status=done ✓');

		const second = assistants[1].toolCalls ?? [];
		assert.strictEqual(second.length, 0,
			`t1 已被前一个 turn 认领 ⇒ 后面的 turn **不得重复认领** ✗✓（实际 ${second.length} 个 ✗）`);
	});

	test('★★★ 压缩边界插在**它发生的位置**（= 事件时的 turnCount ✓，不是无脑追加到末尾 ✗✓）', async () => {
		const fs = makeFakeFs();
		// 边界发生在 **第 1 个 turn 之后** ⇒ `pendingCompaction.turnCount === 1` ✓
		// ⇒ 必须插在 msgA 与 msgB **之间** ✓（语义：边界之前的历史由摘要承载 ✓，
		//   插到末尾就等于把摘要当"最后发生的事" ⇒ 下一轮回放整个错位 ✗✓）。
		const { driver } = makeDriver([
			{ type: 'text', content: 'A' },
			{ type: 'assistant_turn', content: 'A', metadata: { toolCallIds: [], turnIndex: 0 } },
			{ type: 'context_compacted', compressionSummary: '摘要', compressionOriginalCount: 9, compressionCompressedCount: 1, compressionTokensSaved: 100, compressionSummaryChars: 2 },
			{ type: 'text', content: 'B' },
			{ type: 'assistant_turn', content: 'B', metadata: { toolCallIds: [], turnIndex: 1 } },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();

		const svc2 = makeService(fs, makeDriver([]).driver);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		const iA = history.findIndex(m => m.role === 'assistant' && m.content === 'A');
		const iB = history.findIndex(m => m.role === 'assistant' && m.content === 'B');
		const iC = history.findIndex(m => JSON.stringify(m).includes('compaction'));
		assert.ok(iC > 0, `必须找到边界消息（实际顺序：${JSON.stringify(history.map(m => m.role + ':' + String(m.content).slice(0, 6)))} ✗）`);
		assert.ok(iA < iC && iC < iB,
			`边界必须**夹在 A 与 B 之间**（实际 A=${iA} 边界=${iC} B=${iB} ✗ —— 插错位置会让下一轮压缩点回放错位 ✗✓）`);
	});

	test('★★★ 重启后 `parts` 顺序与 kind 保持（渲染真相源跨进程 ✓；序列化丢失即刷新后卡片乱序 ✗✓）', async () => {
		const fs = makeFakeFs();
		const { driver } = makeDriver([
			{ type: 'tool_start', toolCallId: 't9', toolName: 'grep' },
			{ type: 'tool_args', toolCallId: 't9', content: '{"q":"x"}' },
			{ type: 'tool_result', toolCallId: 't9', content: '命中 3 处' },
			{ type: 'text', content: '共 3 处' },
			{ type: 'done' },
		]);
		const svc = makeService(fs, driver);
		const final = await svc.sendMessage('agent-1', 'q', sendOpts, () => { });
		await settle();
		const inMemory = ((final as any).parts ?? []).map((p: any) => p.kind);
		assert.deepStrictEqual(inMemory, ['tool', 'text'], `内存态 parts 顺序（实际 ${inMemory} ✗）`);

		// 重启（新实例从盘上重载 ✓）—— 序列化/反序列化后必须**逐字保持** ✓
		const svc2 = makeService(fs, makeDriver([]).driver);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		const reloaded = history.filter(m => m.role === 'assistant').pop() as any;
		assert.ok(reloaded, '重启后必须能读到 assistant 消息 ✓');
		const kinds = (reloaded.parts ?? []).map((p: any) => p.kind);
		assert.deepStrictEqual(kinds, ['tool', 'text'],
			`重启后 parts 顺序必须保持 ["tool","text"]（实际 ${JSON.stringify(kinds)} ✗ —— 刷新后卡片会乱序 ✗✓）`);
		assert.ok(String(reloaded.content).includes('3 处'), '重启后文本内容必须完整 ✓');
	});
});
