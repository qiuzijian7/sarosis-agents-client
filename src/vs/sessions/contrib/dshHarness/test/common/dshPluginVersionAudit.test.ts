/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「profile 已装版本 vs 随包版本」错配审计的守卫（2026-10-21）。
 *
 * 现场：用户报"新建会话失败: agent-preset/invalid: vssaros-memory (@vssaros/dsh-memory): never started"
 * ⇒ 真因是 profile 里的插件与随包**不同代**（记忆插件 0.3.81，而携带预设的 agents 插件已是新一代）
 * ⇒ 预设里 memory 那一行挂不起来 ⇒ 整个 preset 判 invalid ⇒ **新建会话被直接拒掉**；
 * 而当时的启动日志里只有别的插件的 installing 行 ⇒ **看不出**是版本没装齐 ✗✗。
 *
 * 本守卫钉住"这类错配必须在日志里看得见（名字 + 两个版本号）"这条口径：
 *   ① 一致 ⇒ 不产出任何行（不刷屏）；
 *   ② 不一致 ⇒ 行里同时含**插件名**与**已装/随包两个版本号**；
 *   ③ 没装（installed 缺）⇒ 也算错配（显示"（缺失）"）——"没装"比"版本旧"更容易让会话起不来；
 *   ④ 随包版本读不到 ⇒ **不**误报（无从比对 ≠ 错配）；
 *   ⑤ 反向突变：把"缺失"当一致 ⇒ 必须变红。
 */

import assert from 'assert';

import { auditBundledPluginVersions, isVersionNewer, renderBundledVersionAudit } from '../../common/dshPluginVersionAudit.js';

suite('dsh 插件版本错配审计', () => {
	test('全部一致 ⇒ 不产出任何行（不刷屏）', () => {
		const audit = auditBundledPluginVersions([
			{ name: '@vssaros/dsh-memory', label: '记忆模块', installed: '0.3.83', bundled: '0.3.83' },
			{ name: '@vssaros/dsh-agents', label: '代理模块', installed: '0.2.100', bundled: '0.2.100' },
		]);
		assert.equal(audit.mismatched.length, 0);
		assert.equal(audit.lines.length, 0);
		assert.equal(renderBundledVersionAudit(audit), '');
	});

	test('版本不同 ⇒ 行里同时有插件名与两个版本号（能直接看出"没装齐"）', () => {
		const audit = auditBundledPluginVersions([
			{ name: '@vssaros/dsh-memory', label: '记忆模块', installed: '0.3.81', bundled: '0.3.83' },
		]);
		assert.equal(audit.mismatched.length, 1);
		assert.ok(audit.lines[0].includes('@vssaros/dsh-memory'), '行里必须有插件名');
		assert.ok(audit.lines[0].includes('0.3.81'), '行里必须有已装版本');
		assert.ok(audit.lines[0].includes('0.3.83'), '行里必须有随包版本');
		const text = renderBundledVersionAudit(audit);
		assert.ok(text.includes('never started'), '提示语要指向那个报错原文（否则没人知道该看哪里）');
	});

	test('没装（installed 缺）⇒ 也算错配并显示（缺失）', () => {
		const audit = auditBundledPluginVersions([
			{ name: '@vssaros/dsh-kb', label: '知识库模块', installed: undefined, bundled: '0.5.38' },
		]);
		assert.equal(audit.mismatched.length, 1);
		assert.ok(audit.lines[0].includes('（缺失）'), '缺失要写得看得见');
	});

	test('随包版本读不到 ⇒ 不误报（无从比对 ≠ 错配）', () => {
		const audit = auditBundledPluginVersions([
			{ name: '@vssaros/dsh-unreal', label: 'unreal', installed: '0.1.0', bundled: undefined },
			{ name: '@vssaros/dsh-nothing', label: 'x', installed: undefined, bundled: undefined },
		]);
		assert.equal(audit.mismatched.length, 0);
		assert.equal(renderBundledVersionAudit(audit), '');
	});

	// ★★ 2026-10-28（真机：打包版 exe 启动卡在"正在启动 VsSaros…"六分钟）：
	//   那个 exe 随包 chat-surface@0.2.243，profile 里已装 0.2.259 ⇒ 原来判"不相等就装" ⇒
	//   每次启动降级重装 8 个包（一条命令装 8 个，跑满 4 分钟超时 + 逐项回退再失败）✗。
	test('已装比随包**新** ⇒ 不算错配、不进告警（且安装侧据此不降级）', () => {
		const audit = auditBundledPluginVersions([
			{ name: '@vssaros/dsh-chat-surface', label: '聊天界面', installed: '0.2.259', bundled: '0.2.243' },
		]);
		assert.equal(audit.mismatched.length, 0, '已装更新不是错配 ✗');
		assert.equal(audit.newer.length, 1, '必须归到 newer 里（供安装侧跳过降级）✗');
		const text = renderBundledVersionAudit(audit);
		assert.ok(!text.includes('never started'), '"已装更新"不许混进"版本不一致 ⇒ 先看这里"的告警（会把人引错方向 ✗）');
		assert.ok(text.includes('不降级'), '要写明保留已装版本（否则看不出发生了什么）✗');
	});

	test('版本比较（isVersionNewer）：数字段 / 预发布 / 脏值', () => {
		assert.equal(isVersionNewer('0.2.259', '0.2.243'), true);
		assert.equal(isVersionNewer('0.2.243', '0.2.259'), false);
		assert.equal(isVersionNewer('0.10.0', '0.9.9'), true, '按数字段比，不能按字符串比 ✗');
		assert.equal(isVersionNewer('1.0.0', '1.0.0-rc.1'), true, '正式版比预发布新 ✗');
		assert.equal(isVersionNewer('1.0.0-rc.1', '1.0.0'), false);
		assert.equal(isVersionNewer('1.0.0', '1.0.0'), false, '相同不算更新 ✗');
		// 读不懂 ⇒ 保守返回 false（宁可多装一次，也别漏装）
		assert.equal(isVersionNewer('abc', '1.0.0'), false);
		assert.equal(isVersionNewer(undefined, '1.0.0'), false);
	});

	test('反向突变：把"缺失"当一致 ⇒ 必须变红（这是本守卫要抓的回归）', () => {
		const entries = [{ name: '@vssaros/dsh-kb', label: '知识库模块', installed: undefined, bundled: '0.5.38' }];
		// 突变：缺失直接 filter 掉（漏掉"没装"这一类）
		const mutated = entries.filter(e => e.installed !== undefined);
		const audit = auditBundledPluginVersions(mutated as never);
		assert.notEqual(audit.mismatched.length, 1, '原实现必须把"缺失"算成错配');
		assert.equal(audit.mismatched.length, 0, '突变后"缺失"不再被报出来 ⇒ 守卫应变红');
	});
});
