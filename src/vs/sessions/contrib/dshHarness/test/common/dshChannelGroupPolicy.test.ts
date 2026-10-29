/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「飞书渠道的群策略默认 open + 界面上有配置项」的守卫（2026-10-29）。
 *
 * 真机（用户报："打包出来的 exe 中，配置好飞书后，发送消息 VsSaros 没有收到"）：
 *
 *   Host 日志：`[vssaros-agents][im-in] 收到飞书事件：im.message.receive_v1`   ← 消息到了
 *             `[vssaros-agents][im] 入站被拒（feishu:oc_aad…）：no-whitelist`   ← 被准入拒了
 *   死信：`{ "reason": "no-whitelist", "chatType": "group", … }`
 *
 * 根因两条（缺一不可）：
 *   ① `channelPolicy.normalizePolicy` 里 `groupPolicy` 默认 `'allowlist'`，而 `rooms` 空
 *      ⇒ 群聊一律 `no-whitelist`（fail-closed）；
 *   ② **界面上根本没有 groupPolicy 这个配置项** ⇒ 用户无从下手（凭据区只有 appId/appSecret）。
 *
 * 修法（用户要求"增加 groupPolicy 配置项，默认 open"）：
 *   · 默认改 `open` —— 群里仍受 `requireMention`（默认 true）约束 ⇒ **必须 @ 机器人才响应**；
 *   · `imPlatforms` 的飞书字段加 `type: 'select'` 的 groupPolicy（open / allowlist / disabled）；
 *   · `client.channel.js` 支持 `type: 'select'` 渲染（原来只有 text / password）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshChannelGroupPolicy
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const POLICY = 'dsh-plugins/vssaros-agents/lib/channelPolicy.js';
const BINDINGS = 'dsh-plugins/vssaros-agents/lib/bindings.js';
const PLATFORMS = 'dsh-plugins/vssaros-agents/lib/imPlatforms.js';
const CHANNEL_UI = 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('飞书群策略默认 open + 有配置项', () => {

	test('1) groupPolicy 默认必须是 open（否则群聊 fail-closed ⇒ 一条都收不到）', () => {
		const src = read(POLICY);
		assert.match(src, /groupPolicy: GROUP_POLICIES\.includes\(String\(b\.groupPolicy\)\) \? String\(b\.groupPolicy\) : 'open'/,
			'groupPolicy 缺省必须是 open（原 allowlist + rooms 空 ⇒ 群聊必被 no-whitelist 拒 ✗）');
		assert.ok(!/groupPolicy: [^\n]*: 'allowlist'/.test(src),
			'不许再回退到 allowlist 作为缺省（那等于群聊默认不可用 ✗）');
		// 安全兜底必须在：群里要 @ 才响应
		assert.match(src, /requireMention,/, 'requireMention 必须在策略对象里（它才是 open 的安全兜底）');
	});

	test('2) 绑定旧路径：群聊不许因"白名单空"被拒（私聊仍 fail-closed）', () => {
		const src = read(BINDINGS);
		const at = src.indexOf('export function shouldAcceptInbound');
		assert.ok(at > 0, '找不到 shouldAcceptInbound');
		const end = src.indexOf('export function inboundKeyOf', at);
		const body = src.slice(at, end > at ? end : at + 2500);
		assert.match(body, /if \(!allow\.length && !isGroup\) \{/,
			'白名单为空只该挡住**私聊**；群聊默认放行（靠 mention 兜）—— 否则 UI 里没入口 ⇒ 永远收不到 ✗');
		assert.match(body, /reason: 'no-whitelist'/, '私聊的 fail-closed 必须保留');
		// ⚠ isGroup 只许声明一次（提到前面后容易重复声明 ⇒ 语法能过但语义乱）
		assert.strictEqual((body.match(/const isGroup =/g) || []).length, 1,
			'isGroup 只能声明一次（重复声明会遮蔽前面的值）');
	});

	test('3) 渠道页必须有 groupPolicy 配置项，且 UI 真能渲染 select', () => {
		const plat = read(PLATFORMS);
		assert.match(plat, /key: 'groupPolicy'/, '飞书字段里必须有 groupPolicy');
		assert.match(plat, /key: 'groupPolicy'[^}]*type: 'select'/s, 'groupPolicy 必须是 select（枚举字段不该手打）');
		assert.match(plat, /default: 'open'/, 'groupPolicy 的界面默认值必须是 open');
		assert.match(plat, /value: 'open'/, '选项里必须有 open');
		assert.match(plat, /value: 'allowlist'/, '选项里必须有 allowlist');
		assert.match(plat, /value: 'disabled'/, '选项里必须有 disabled');

		const ui = read(CHANNEL_UI);
		// ⚠ 必须钉**渲染分支**：只查字符串 "select" 会被注释或字段名骗过（实测踩过 ✗）
		const iSel = ui.indexOf('f.type === "select"');
		assert.ok(iSel > 0, 'UI 必须按 f.type === "select" 分支渲染');
		const iOpt = ui.indexOf('el("option"', iSel);
		assert.ok(iOpt > iSel, 'select 分支里必须真的渲染 option');
		// 原来只支持 text/password —— 必须还在（别把凭据输入框改坏）
		assert.match(ui, /f\.type === "password" \? "password" : "text"/, '普通输入框（text/password）必须保留');
	});
});
