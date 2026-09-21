/*---------------------------------------------------------------------------------------------
 *  会话回放 / digest / 不变量体检（P1-7，2026-09-21）回归测试。
 *
 *  三件事分别钉住：
 *    ① **回放语义**：快照 + 追加日志 ⇒ 消息列表 ✓（语义完全复用 P0-1 ✓，本模块不重复实现 ✗）；
 *    ② **digest 计数**：角色分布 / 工具配对 / parts 覆盖 / 卡片 / 附件 ✓；
 *    ③ **不变量体检**：把本仓真实踩过的数据缺陷各造一份 ⇒ 必须能报出来 ✓
 *       （重复 id ✗ / 历史中段孤儿工具调用 ✗ / 空 assistant ✗ / 无内容用户消息 ✗）；
 *       并且**健康数据必须 0 违规** ✓ —— 否则它就是噪音，没人会看 ✗。
 *
 *  ⚠ 末端的未完成工具调用**只算 warning** ✓：会话可能正被 kill ✓（每次"中途关 app"都红 ✗
 *    ⇒ 体检会被无视 ✗✓）。
 *
 *  ⚠ 最后一条用例是**机会性真数据**检查 ✓：本机存在 `chat-history` 就跑一遍真会话，
 *    只断言"不抛 + digest 自洽"，**不因历史数据债而失败** ✗✓（否则测试会长期红 ✗）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildSessionDigest,
	checkSessionInvariants,
	formatDigestLine,
	hasBlockingFindings,
	replaySessionHistory,
} from '../../common/sessionReplay.js';
import { serializeSessionLogAppends, serializeSessionLogBarrier } from '../../common/sessionHistoryLog.js';

import type { ChatMessage } from '../../common/types.js';

function user(id: string, content = 'hi'): ChatMessage {
	return { id, role: 'user', content, agentSessionId: 's1', timestamp: '2026-09-21T00:00:00.000Z' } as ChatMessage;
}
function assistant(id: string, content = 'ok', extra: Record<string, unknown> = {}): ChatMessage {
	return { id, role: 'assistant', content, agentSessionId: 's1', timestamp: '2026-09-21T00:00:01.000Z', ...extra } as ChatMessage;
}
function toolCall(id: string, name = 'execute_code', extra: Record<string, unknown> = {}) {
	return { id, name, arguments: '{}', ...extra };
}

suite('会话回放 / digest / 不变量（P1-7）', () => {

	test('★ digest：角色分布、工具配对、parts/卡片/附件计数', () => {
		const messages: ChatMessage[] = [
			user('u1'),
			assistant('a1', '我先跑个命令', {
				toolCalls: [toolCall('t1', 'execute_code', { status: 'done', result: 'ok' }), toolCall('t2', 'read_file', { status: 'running' })],
				parts: [{ kind: 'text', text: '我先跑个命令' }, { kind: 'tool', toolCallId: 't1' }],
				turnId: 'turn-1',
			}),
			{ id: 'u2', role: 'user', content: '', agentSessionId: 's1', timestamp: '2026-09-21T00:00:02.000Z', attachments: [{ id: 'at1', type: 'file', kind: 'snippet' }] } as unknown as ChatMessage,
			assistant('a2', '', { todos: [{ id: 'x', text: 'y' }], turnId: 'turn-1' }),
		];
		const d = buildSessionDigest(messages);
		assert.strictEqual(d.messages, 4);
		assert.strictEqual(d.byRole.user, 2);
		assert.strictEqual(d.byRole.assistant, 2);
		assert.strictEqual(d.turns, 1, '同一 turnId 只计一次 ✓');
		assert.strictEqual(d.toolCalls, 2);
		assert.strictEqual(d.resolvedToolCalls, 1, 'status=done 或 result 存在才算完成 ✓');
		assert.strictEqual(d.messagesWithParts, 1);
		assert.strictEqual(d.cardMessages, 1, 'todos 属于卡片字段 ✓');
		assert.strictEqual(d.attachments, 1);
		assert.strictEqual(d.firstTimestamp, '2026-09-21T00:00:00.000Z');
		assert.strictEqual(d.lastTimestamp, '2026-09-21T00:00:02.000Z');
		// ★ 无压缩边界 ⇒ 模型能看到全部 ✓（这是"正常会话"的基线 ✓）
		assert.strictEqual(d.modelVisibleMessages, 4);
		assert.strictEqual(d.droppedByCompactionBoundary, 0);
		assert.strictEqual(d.hasCompactionBoundary, false);
		assert.ok(formatDigestLine(d).includes('模型可见=4/4'), `摘要行必须以"模型可见"开头 ✓：${formatDigestLine(d)}`);
	});

	test('★★★ 「模型可见条数」必须与请求侧同源：**可信**边界丢弃边界之前全部消息 ✗✓', () => {
		// 真机事故（2026-09-21）：13 条会话里含 1 条压缩边界 ⇒ 模型只看到 7 条 ✓，
		// 且边界摘要写着「当前任务：无」✗ ⇒ 用户说「执行」时模型失忆 ✓✓。
		// ⚠ 2026-09-21 起切片还要求边界**可信**（摘要信息量与压缩量相称 + tokensSaved>0）：
		//   本用例给"可信"边界（长摘要 + 正收益）⇒ 语义与事故当时一致 ✓；
		//   "不可信"边界的行为见下一个用例（不切片 ⇒ 不丢历史 ✓）。
		const messages: ChatMessage[] = [
			user('u1', '请把 agent 存储路径找出来'),
			assistant('a1', '我先看看'),
			assistant('boundary', '[上下文压缩] 此前的对话历史（11 条消息）已压缩为以下摘要：\n'
				+ '## Active Task（当前任务）\n先定位 agent 存储路径，再核对默认数据目录与迁移脚本。\n'.repeat(20),
				{ metadata: { type: 'compaction', originalCount: 11, compressedCount: 10, tokensSaved: 4200 } }),
			assistant('a2', '找到了路径'),
		];
		const d = buildSessionDigest(messages);
		assert.strictEqual(d.hasCompactionBoundary, true);
		assert.strictEqual(d.modelVisibleMessages, 2, '边界 + 其后消息是模型能看到的全部 ✗');
		assert.strictEqual(d.droppedByCompactionBoundary, 2, '边界之前 2 条被丢弃 ✗✓');
		assert.ok(formatDigestLine(d).includes('⚠ 模型可见=2/4'), `摘要行必须显式告警 ✗：${formatDigestLine(d)}`);

		// 体检必须把这条列出来（用户看到它就知道该查摘要了 ✓）
		const findings = checkSessionInvariants(messages);
		const f = findings.find(x => x.kind === 'compaction-boundary-hides-history');
		assert.ok(f, `必须有 compaction-boundary-hides-history 提示 ✓：${JSON.stringify(findings.map(x => x.kind))}`);
		assert.strictEqual(f.severity, 'warning', '它是提示而非违规（压缩是正常机制 ✓）');
		assert.ok(f.detail.includes('2/4'), '提示里要带比例（一眼看出裁了多少 ✓）');
	});

	test('★★★ 「摘要饥饿」边界**不得**切片：模型恢复看到全部历史（2026-09-21 fail-safe ✓）', () => {
		// 真机数据（`sess_ms5kriv8_0j6atj`）：`tokensSaved=-73`（压缩反而变大）+
		// 摘要只写着「当前任务：无」⇒ 该边界生效就是**纯丢上下文** ✗。
		// 切模型事故（`vscode-app-1789994132110.log`）同理：153 条消息 → 129 token 的
		// 检索摘要、`saved=24836 > 0` ⇒ 用"省了 token"当成功判据 ⇒ 模型永久失忆 ✗✗。
		const messages: ChatMessage[] = [
			user('u1', '请把 agent 存储路径找出来'),
			assistant('a1', '我先看看'),
			assistant('boundary', '[上下文压缩] 此前的对话历史（11 条消息）已压缩为以下摘要：\n## Active Task（当前任务）\n无',
				{ metadata: { type: 'compaction', originalCount: 11, compressedCount: 10, tokensSaved: -73 } }),
			assistant('a2', '找到了路径'),
		];
		const d = buildSessionDigest(messages);
		assert.strictEqual(d.hasCompactionBoundary, true, '历史里确实有边界（这是事实，与是否切片无关 ✓）');
		assert.strictEqual(d.modelVisibleMessages, 3,
			'不可信边界 ⇒ 不切片 ⇒ 3 条历史全部可见，边界标记本身被剔除 ✓');
		assert.strictEqual(d.droppedByCompactionBoundary, 0,
			'⚠ 不得从"看不见的条数"反推：被剔除的是标记而非历史 ⇒ 历史丢失为 0 ✓');
		assert.ok(formatDigestLine(d).includes('模型可见=3/4'), `不应告警"历史被裁"（未丢历史 ✓）：${formatDigestLine(d)}`);
	});

	test('★★ 健康数据必须**零**发现（否则体检就是噪音 ✗）', () => {
		const messages: ChatMessage[] = [
			user('u1'),
			assistant('a1', '跑命令', { toolCalls: [toolCall('t1', 'execute_code', { status: 'done', result: 'ok' })], turnId: 'T' }),
			{ id: 'r1', role: 'tool', content: 'ok', agentSessionId: 's1', timestamp: '2026-09-21T00:00:02.000Z', toolCallId: 't1' } as unknown as ChatMessage,
			assistant('a2', '完成', { turnId: 'T' }),
		];
		assert.deepStrictEqual(checkSessionInvariants(messages), []);
		assert.strictEqual(hasBlockingFindings([]), false);
	});

	test('★★★ 历史中段的孤儿工具调用 ⇒ violation（模型看到的上下文与磁盘不一致 ✗）', () => {
		const messages: ChatMessage[] = [
			user('u1'),
			assistant('a1', '', { toolCalls: [toolCall('t1', 'execute_code')] }),   // 无 result ✗ 且不在末尾 ✓
			assistant('a2', '我继续'),
		];
		const f = checkSessionInvariants(messages);
		const orphan = f.filter(x => x.kind === 'orphan-tool-call');
		assert.strictEqual(orphan.length, 1);
		assert.strictEqual(orphan[0].severity, 'violation');
		assert.strictEqual(orphan[0].messageId, 'a1');
		assert.ok(hasBlockingFindings(f), '违规必须能阻塞（exit 1 的依据 ✓）');
	});

	test('★★★ 末尾的未完成调用 ⇒ 只算 warning（会话可能正被 kill ✓，不该红 ✗）', () => {
		const messages: ChatMessage[] = [
			user('u1'),
			assistant('a1', '跑一个长命令', { toolCalls: [toolCall('t1', 'execute_code')] }),
		];
		const f = checkSessionInvariants(messages);
		assert.deepStrictEqual(f.map(x => [x.kind, x.severity]), [['orphan-tool-call', 'warning']]);
		assert.ok(!hasBlockingFindings(f), 'warning 不得阻塞 ✓');
	});

	test('★★ 重复 id ⇒ violation（P0-1 的按 id 归并本应杜绝 ✓）', () => {
		const f = checkSessionInvariants([user('dup'), assistant('dup')]);
		assert.deepStrictEqual(f.filter(x => x.kind === 'duplicate-id').map(x => x.severity), ['violation']);
	});

	test('★★ 孤儿工具结果 / 无 id 的 tool 消息 / 无名调用 ⇒ 各自报出', () => {
		const orphanResult = checkSessionInvariants([
			user('u1'),
			{ id: 'r1', role: 'tool', content: 'x', timestamp: '', toolCallId: 'ghost' } as unknown as ChatMessage,
		]);
		assert.ok(orphanResult.some(f => f.kind === 'orphan-tool-result' && f.severity === 'violation'));

		const noIdTool = checkSessionInvariants([
			user('u1'),
			{ id: 'r2', role: 'tool', content: 'x', timestamp: '' } as unknown as ChatMessage,
		]);
		assert.ok(noIdTool.some(f => f.kind === 'tool-message-without-id' && f.severity === 'warning'));

		const noName = checkSessionInvariants([
			user('u1'),
			assistant('a1', '', { toolCalls: [{ id: 't9', arguments: '{}', status: 'done', result: 'r' }] }),
		]);
		assert.ok(noName.some(f => f.kind === 'tool-call-without-name' && f.severity === 'violation'));
	});

	test('★★ 空 assistant / 无内容用户消息 ⇒ warning（真实踩过的数据缺陷 ✓）', () => {
		const f = checkSessionInvariants([
			assistant('a-empty', ''),                              // ⚠ 必须显式传 '' ✗（helper 默认 content='ok' ⇒ 不空 ✗✓）
			{ id: 'u-empty', role: 'user', content: '', timestamp: '' } as ChatMessage,   // 无文本也无附件 ✗
		]);
		assert.ok(f.some(x => x.kind === 'empty-assistant-message' && x.severity === 'warning'));
		assert.ok(f.some(x => x.kind === 'user-message-without-payload' && x.severity === 'warning'));
	});

	test('★★★ 回放 = 快照 + 日志（屏障语义复用 P0-1 ✓，替换掉的内容不复活 ✓）', () => {
		const snapshot = JSON.stringify([user('snap-1'), assistant('snap-2')]);
		// 日志中：barier 之前的内容已被快照取代 ⇒ 必须被丢弃 ✓
		const log =
			serializeSessionLogAppends([assistant('should-be-dropped')]) +
			serializeSessionLogBarrier() +
			serializeSessionLogAppends([assistant('log-1')]);
		const r = replaySessionHistory(snapshot, log);
		assert.deepStrictEqual(r.messages.map(m => m.id), ['snap-1', 'snap-2', 'log-1']);
		assert.strictEqual(r.logStats.barrierSeen, true);
		assert.strictEqual(r.logStats.appends, 1);
	});

	test('★ 只有日志 / 只有快照 / 快照损坏 ⇒ 都不抛（体检脚本不能因单份文件坏掉而中断 ✗）', () => {
		const logOnly = replaySessionHistory(undefined, serializeSessionLogAppends([assistant('a')]));
		assert.deepStrictEqual(logOnly.messages.map(m => m.id), ['a']);

		const snapOnly = replaySessionHistory(JSON.stringify([user('u')]), undefined);
		assert.deepStrictEqual(snapOnly.messages.map(m => m.id), ['u']);

		const broken = replaySessionHistory('{ this is not json', serializeSessionLogAppends([assistant('a')]));
		assert.deepStrictEqual(broken.messages.map(m => m.id), ['a'], '损坏快照 ⇒ 退回日志重建 ✓');

		assert.deepStrictEqual(replaySessionHistory(undefined, undefined).messages, []);
	});

	test('★ 日志尾行截断 ⇒ 忽略该行（其余照常 ✓）', () => {
		const r = replaySessionHistory(undefined, serializeSessionLogAppends([assistant('a')]) + '{"op":"a","msg":{"id":"b"');
		assert.deepStrictEqual(r.messages.map(m => m.id), ['a']);
		assert.strictEqual(r.logStats.tornLines, 1);
	});

	test('★ 机会性真数据：本机存在 chat-history ⇒ 真会话必须能回放且 digest 自洽（不为历史债失败 ✗）', () => {
		const root = process.env.APPDATA
			? path.join(process.env.APPDATA, 'vssaros', 'chat-history')
			: path.join(os.homedir(), '.vssaros', 'chat-history');
		if (!fs.existsSync(root)) { return; }   // 无本地数据 ⇒ 跳过 ✓（不让用例变成环境依赖 ✗）

		let scanned = 0;
		let withViolation = 0;
		for (const agent of fs.readdirSync(root)) {
			const sessionsDir = path.join(root, agent, 'sessions');
			if (!fs.existsSync(sessionsDir)) { continue; }
			for (const f of fs.readdirSync(sessionsDir)) {
				if (!/\.(json|jsonl)$/.test(f) || f.endsWith('.draft.json')) { continue; }
				const id = f.replace(/\.(jsonl|json)$/, '');
				const snapPath = path.join(sessionsDir, `${id}.json`);
				const logPath = path.join(sessionsDir, `${id}.jsonl`);
				const r = replaySessionHistory(
					fs.existsSync(snapPath) ? fs.readFileSync(snapPath, 'utf8') : undefined,
					fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : undefined,
				);
				scanned++;
				// 自洽性：角色计数之和 == 总条数 ✓（digest 自身不能算错 ✗）
				const sum = Object.values(r.digest.byRole).reduce((a, b) => a + b, 0);
				assert.strictEqual(sum, r.digest.messages, `${agent}/${id}: digest 角色计数与总条数不一致 ✗`);
				assert.ok(r.digest.resolvedToolCalls <= r.digest.toolCalls, `${agent}/${id}: 完成数不得大于总数 ✗`);
				if (hasBlockingFindings(r.findings)) {
					withViolation++;
					// 只报告（历史数据债不该让用例长期红 ✗）；真机排查请看 `npm run session:digest -- --all`
					console.log(`[sessionReplay.test] ${agent}/${id} 存在 violation：` +
						r.findings.filter(x => x.severity === 'violation').map(x => x.kind).join(', '));
				}
			}
		}
		console.log(`[sessionReplay.test] 真数据扫描：${scanned} 个会话文件，其中 ${withViolation} 个含 violation`);
	});
});
