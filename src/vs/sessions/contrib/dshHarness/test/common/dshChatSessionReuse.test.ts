/*---------------------------------------------------------------------------------------------
 *  「新页签复用空白会话」的纯判定（`common/dshChatSession.ts` 的 pickReusableBlankSession）
 *
 *  背景（2026-10-19 用户提问）：为什么会有这么多空白会话、官方怎么做。
 *  dsh 官方 `session.create` 的参数语义是
 *    "Blank Session to reuse while it is reusable, or the identity of a new Session when none is
 *     stored under it."
 *  —— 即「新建对话」**优先复用**那个还没说过话的会话。我们此前每开一个页签就派生**新** id，
 *  从不复用 ⇒ 每开一次页签就永久多一条 blank 会话（实测本机 1691 条里 1681 条是空的）。
 *
 *  这里把"哪些能复用"钉死：复用错一条的后果比多一条空白严重得多
 *  （把有内容的会话当新对话用掉 / 让两个页签显示同一条 / 让新对话跑在别人的 preset 上）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';
import { pickReusableBlankSession } from '../../common/dshChatSession.js';

/** 宿主接线（源码契约）：纯函数对了，但没人调用 / 调用顺序错了，等于没做。 */
const HOST = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshChatInstanceHost.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';

const CWD = 'G:\\SarosWorkspace\\sarosis-agents-client';

suite('复用空白会话：只挑「空的 + 同目录 + 同 preset + 没被别的页签占着」的那条', () => {
	test('命中：路径大小写 / 斜杠写法不同也算同一目录', () => {
		const id = pickReusableBlankSession([
			{ id: 'blank-a', cwd: 'g:/SarosWorkspace/sarosis-agents-client/', agentPreset: 'vssaros-standard', blank: true, updatedAt: 10 },
		], { cwd: CWD, agentPreset: 'vssaros-standard' });
		assert.strictEqual(id, 'blank-a');
	});

	test('★ 有内容的会话**绝不能**当新对话复用（否则等于把历史会话占掉）', () => {
		const id = pickReusableBlankSession([
			{ id: 'used', cwd: CWD, agentPreset: 'vssaros-standard', blank: false, updatedAt: 99 },
			{ id: 'unknown', cwd: CWD, agentPreset: 'vssaros-standard', updatedAt: 98 },
		], { cwd: CWD, agentPreset: 'vssaros-standard' });
		assert.strictEqual(id, undefined, 'blank 非 true（含 undefined）一律不选 ✗');
	});

	test('preset 必须一致（否则新对话会跑在别人设的人设上）', () => {
		const id = pickReusableBlankSession([
			{ id: 'other-preset', cwd: CWD, agentPreset: 'vssaros-ppt-slides-master', blank: true },
			{ id: 'base', cwd: CWD, blank: true },
		], { cwd: CWD });   // 本次是 base preset（无 preset）
		assert.strictEqual(id, 'base');
	});

	test('目录必须一致：前缀相同但**不是**同一目录的不选', () => {
		const id = pickReusableBlankSession([
			{ id: 'sibling', cwd: 'g:/SarosWorkspace/sarosis-agents-client-old', blank: true },
			{ id: 'other', cwd: 'g:/SarosWorkspace/other-repo', blank: true },
		], { cwd: CWD });
		assert.strictEqual(id, undefined);
	});

	test('已被别的页签绑着的会话不能复用（会让两个页签显示同一条）', () => {
		const id = pickReusableBlankSession([
			{ id: 'bound', cwd: CWD, blank: true, updatedAt: 50 },
			{ id: 'free', cwd: CWD, blank: true, updatedAt: 10 },
		], { cwd: CWD, exclude: new Set(['bound']) });
		assert.strictEqual(id, 'free');
	});

	test('多条候选取 **updatedAt 最新** 的（最近关掉的空白页签最可能仍然干净）', () => {
		const id = pickReusableBlankSession([
			{ id: 'old', cwd: CWD, blank: true, updatedAt: 1 },
			{ id: 'new', cwd: CWD, blank: true, updatedAt: 9 },
			{ id: 'mid', cwd: CWD, blank: true, updatedAt: 5 },
		], { cwd: CWD });
		assert.strictEqual(id, 'new');
	});

	test('边界：空 cwd / 空候选 / 坏项 ⇒ undefined（绝不抛）', () => {
		assert.strictEqual(pickReusableBlankSession([{ id: 'x', cwd: CWD, blank: true }], { cwd: '' }), undefined);
		assert.strictEqual(pickReusableBlankSession([], { cwd: CWD }), undefined);
		assert.strictEqual(pickReusableBlankSession([{ id: '', cwd: CWD, blank: true }], { cwd: CWD }), undefined);
	});

	test('宿主接线：新页签先取候选再绑定；失败必须退回派生 id；并排除已被绑定的会话', () => {
		const src = fs.readFileSync(HOST, 'utf8');
		assert.ok(/await this\._preferReusableBlank\(derivedSessionId/.test(src),
			'新页签必须在 startSession 之前先尝试复用 ✗');
		assert.ok(/_bindSessionWithFallback\(\{ cwd: cwdAtBind!/.test(src), '绑定必须走带兜底的那条路 ✗');
		assert.ok(/没绑上 ⇒ 退回派生会话/.test(src), '复用失败必须退回派生 id（否则新页签打不开）✗');
		assert.ok(/exclude: this\._dsh\.boundChatSessionIds\(\)/.test(src),
			'必须排除本窗口已绑定的会话（否则两个页签显示同一条）✗');
		// 服务侧：这个"已绑定集合"必须真的有实现（不是只写进接口）
		const svc = fs.readFileSync(SERVICE, 'utf8');
		assert.ok(/boundChatSessionIds\(\): Set<string> \{[\s\S]{0,400}this\._chatSession\.values\(\)/.test(svc),
			'boundChatSessionIds 必须有真实实现（含已绑定的那部分）✗');
	});

	// ── 并发（2026-10-21，中间栏并排多聊天）──────────────────────────────────
	// 场景：用户几乎同时点两次「新建聊天」⇒ 两个页签**同时**挑空白会话。
	// 第一个的记账要等 `createView` 的 `.then()` 才落 ⇒ 第二个可能挑走**同一条** ⇒
	// 两个视图绑同一 dsh 会话 ⇒ Host 侧"会话已被占用"，或两个页面显示同一段对话。
	// ⇒ 宿主必须在定下 sessionId 后**立刻预占**，让另一个页签在挑的时候就能排除它。
	test('★ 并发开两个聊天：第二个不能挑到第一个正在占用的那条会话（预占）', () => {
		const src = fs.readFileSync(HOST, 'utf8');
		assert.ok(/reserveChatSession\(sessionId\)/.test(src),
			'定下 sessionId 后必须立刻预占（否则并发开两个聊天会绑到同一条会话）✗');
		// 预占必须落在"选会话"之后、"绑定"之前（顺序反了就白占）。
		const reserveAt = src.indexOf('reserveChatSession(sessionId)');
		const bindAt = src.indexOf('this._bindSessionWithFallback(');
		assert.ok(reserveAt > 0 && bindAt > 0 && reserveAt < bindAt,
			'预占必须在选出会话之后、绑定之前 ✗');
		// 服务侧：预占集合必须真的参与"能不能复用"的判断。
		const svc = fs.readFileSync(SERVICE, 'utf8');
		assert.ok(/boundChatSessionIds\(\): Set<string> \{[\s\S]{0,400}this\._reservedChatSessions/.test(svc),
			'boundChatSessionIds 必须把「已预占」的会话也算进去（否则预占形同虚设）✗');
		assert.ok(/reserveChatSession\(sessionId: string\): void/.test(svc),
			'预占必须有真实实现 ✗');
	});
});
