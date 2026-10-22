/*---------------------------------------------------------------------------------------------
 *  「上次绑定的会话」的纯判定（`common/dshChatSession.ts`）
 *
 *  背景（2026-10-20 用户报）：从会话 A 切到 B 聊完，关掉 app 重开 ⇒ 聊天框又显示 A。
 *  根因：切换只改宿主内存（`slot.sessionId` / `_chatSession`），而启动时目标会话是
 *  `_sessionIdFor()` **纯函数派生**的 ⇒ 必然回到派生会话 A（B 其实完好地躺在磁盘上）。
 *  修法：切换时落盘，启动时优先恢复；恢复前必须过"目录 / preset / 仍存在"三道校验 ——
 *  恢复错一条的后果比回到 A 严重得多（串了别的目录的历史、把已删会话复活成空会话）。
 *
 *  这里钉的是纯函数那两道（目录 / preset）；第三道"仍存在"要查会话索引，由宿主补。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';
import {
	normalizeRememberedPreset,
	parseRememberedSession,
	rememberedSessionMatches,
	serializeRememberedSession,
} from '../../common/dshChatSession.js';

const CWD = 'G:\\SarosWorkspace\\sarosis-agents-client';
const BASE = 'vssaros-standard';

suite('上次绑定的会话：序列化 / 解析 / 是否仍可用', () => {
	test('序列化后能原样解析回来（round-trip）', () => {
		const raw = serializeRememberedSession('vssaros-chat-c1--preset-x', CWD, 'preset-x', BASE);
		const back = parseRememberedSession(raw);
		assert.deepStrictEqual(back, { sessionId: 'vssaros-chat-c1--preset-x', cwd: CWD, preset: 'preset-x' });
	});

	test('基座 preset 与"未显式选择"归一成同一个值（否则重启后永远判"preset 变了"）', () => {
		assert.strictEqual(normalizeRememberedPreset(undefined, BASE), '');
		assert.strictEqual(normalizeRememberedPreset(BASE, BASE), '');
		assert.strictEqual(normalizeRememberedPreset('preset-x', BASE), 'preset-x');
		// basePreset 还没习得（undefined）时，显式值保持不变（不能把一切吞成 ''）
		assert.strictEqual(normalizeRememberedPreset(BASE, undefined), BASE);
	});

	test('记录损坏 / 缺字段 ⇒ 当作没记过（回退派生会话，而不是拿半个记录去绑）', () => {
		assert.strictEqual(parseRememberedSession(undefined), undefined);
		assert.strictEqual(parseRememberedSession(''), undefined);
		assert.strictEqual(parseRememberedSession('{'), undefined);
		assert.strictEqual(parseRememberedSession('{}'), undefined);
		assert.strictEqual(parseRememberedSession(JSON.stringify({ sessionId: 's1' })), undefined);
		assert.strictEqual(parseRememberedSession(JSON.stringify({ cwd: CWD })), undefined);
	});

	test('目录写法不同（大小写 / 斜杠 / 尾斜杠）仍算同一条记录可用', () => {
		const stored = parseRememberedSession(serializeRememberedSession('s1', CWD, undefined, BASE))!;
		assert.ok(rememberedSessionMatches(stored, { cwd: 'g:/SarosWorkspace/sarosis-agents-client/', basePreset: BASE }));
	});

	test('★ 目录不同 ⇒ 不可用（换过 worktree / 工作区，不能把别处的历史串进来）', () => {
		const stored = parseRememberedSession(serializeRememberedSession('s1', CWD, undefined, BASE))!;
		assert.strictEqual(rememberedSessionMatches(stored, { cwd: 'D:\\Other\\Repo', basePreset: BASE }), false);
	});

	test('★ preset 不同 ⇒ 不可用（各 preset 有专属会话，串了就是显示别人的历史）', () => {
		const stored = parseRememberedSession(serializeRememberedSession('s1', CWD, 'preset-x', BASE))!;
		assert.strictEqual(rememberedSessionMatches(stored, { cwd: CWD, preset: 'preset-y', basePreset: BASE }), false);
		assert.strictEqual(rememberedSessionMatches(stored, { cwd: CWD, preset: 'preset-x', basePreset: BASE }), true);
	});

	test('★ 最核心的一条：A→B 切换后记的是 B，重启恢复时不会又拿回派生的 A', () => {
		// 派生会话 A（基座），用户切到历史会话 B（无 preset）
		const a = 'vssaros-chat-c1';
		const b = 'vssaros-chat-session-history-sess-abc';
		const stored = parseRememberedSession(serializeRememberedSession(b, CWD, undefined, BASE))!;
		assert.notStrictEqual(stored.sessionId, a);
		assert.strictEqual(stored.sessionId, b);
		assert.ok(rememberedSessionMatches(stored, { cwd: CWD, basePreset: BASE }), '同目录同 preset ⇒ 应当恢复 B');
	});

	test('空 cwd ⇒ 不可用（宁可不恢复，也别拿一条无目录的记录去绑）', () => {
		const stored = parseRememberedSession(serializeRememberedSession('s1', CWD, undefined, BASE))!;
		assert.strictEqual(rememberedSessionMatches(stored, { cwd: '', basePreset: BASE }), false);
	});
});

/**
 * 宿主接线（源码契约）：纯函数对了，但**没在切换处落盘 / 启动处没读**，等于没做。
 *
 * 五个写入点缺一不可（少一条就有一条路径"切完关掉 app 又回旧会话"）：
 *   `_ensureViewOnce`（绑定结果）、`_doSwitchPreset`、`_doSwitchWorktree`、
 *   `_openSession`（历史会话 / 子会话切换 —— 用户报的那条）、`_doNewSessionInPlace`（本页签新建）。
 */
suite('上次绑定的会话：宿主接线（写 5 处 / 读 1 处）', () => {
	const HOST = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshChatInstanceHost.ts';
	const source = fs.readFileSync(HOST, 'utf8');
	/** 取某个方法体（从签名到下一个 `\n\tprivate` / `\n\tpublic` / 文件尾）。 */
	const bodyOf = (signature: string): string => {
		const at = source.indexOf(signature);
		assert.ok(at >= 0, `找不到 ${signature} —— 方法被改名了？测试要跟着更新`);
		const rest = source.slice(at + signature.length);
		const next = rest.search(/\n\t(?:private|public|protected) /);
		return next < 0 ? rest : rest.slice(0, next);
	};

	test('切换会话（_openSession）必须落盘 —— 这是用户报的 A→B 场景', () => {
		assert.ok(bodyOf('private async _openSession(').includes('_rememberSession(sessionId'),
			'历史会话切换后必须记住新会话，否则重启又回派生的旧会话');
	});

	test('其余四条换绑路径也都要落盘（preset / worktree / 本页签新建 / 初始绑定结果）', () => {
		assert.ok(bodyOf('private async _doSwitchPreset(').includes('_rememberSession(res.sessionId'),
			'切 preset 后要记住 preset 专属会话');
		assert.ok(bodyOf('private async _doSwitchWorktree(').includes('_rememberSession(res.sessionId'),
			'换目录后要记住该目录的会话');
		assert.ok(bodyOf('private async _doNewSessionInPlace(').includes('_rememberSession(res.sessionId'),
			'本页签新建的会话 id 不确定，只能靠记录恢复');
		assert.ok(bodyOf('private async _ensureViewOnce(').includes('_rememberSession(actual'),
			'绑定结果（Host 可能返回别的 id）也要记住');
	});

	test('启动绑定必须先问记录（_rememberedSessionId），且不可信时回退派生', () => {
		const body = bodyOf('private async _ensureViewOnce(');
		assert.ok(body.includes('_rememberedSessionId('), '启动时要优先恢复上次绑定的会话');
		assert.ok(/rememberedSessionId\s*\n?\s*\?\?\s*/.test(body), '恢复不到时必须回退（?? 派生 / 复用空白）');
	});

	test('恢复前必须查"会话是否仍存在"（否则会把已删会话复活成空会话）', () => {
		const body = bodyOf('private async _rememberedSessionId(');
		assert.ok(body.includes('listDshSessions('), '必须确认会话还在，不能只信存储里的 id');
	});
});
