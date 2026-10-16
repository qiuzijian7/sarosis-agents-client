/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	WEB_PAGE_QUALITY_SIGNAL_LABELS,
	assessManualAction,
	browserPageWallNotice,
	classifyExtractQuality,
	manualActionLine,
} from '../../common/webPageQuality.js';
import { webExtractBlockedMessage } from '../../browser/providers/tool/webSearchParse.js';

/**
 * `browserPageWallNotice` —— 浏览器通道上的「登录墙 / 内容不可用 / 反爬」自诊断。
 *
 * 为什么单独一个文件（此前它**零覆盖**）：这段文案是模型在浏览器通道上**唯一的解释来源** ——
 * 快照的语义是"屏幕上现在是什么"（保留页面原文），解释权由这段通知接管。三支的下一步动作互不相同，
 * 写错任意一支就等于把模型指向一条死路：
 *   · `login-required` ⇒ 重试**永远**无用，只能请人在真实窗口登录一次（并用 `login` op 验证）；
 *   · `unavailable`    ⇒ 登录也没用（内容本身不在了），只能换来源或承认读不到；
 *   · `interstitial`   ⇒ 不是身份问题（是"看起来不像人"），换真实浏览器或稍后重试。
 *
 * 另有一条**反向保护**：正常页面绝不能带这段 —— 每次都喊就会变成"狼来了"，模型再也不信它。
 */

/** 生成长度可控的"正文"（长度是弱特征阈值那一关的判据，必须可控）。 */
const long = (n: number): string => '正文内容'.repeat(Math.ceil(n / 4)).slice(0, n);

suite('browserPageWallNotice — 三种 blocked 成因给三种下一步（2026-10-13 登录墙单列）', () => {

	test('★ 正常页面绝不带通知（"狼来了"护栏：thin 也不是 blocked）', () => {
		const ok = classifyExtractQuality(long(4000), '一篇正常的长文');
		assert.strictEqual(ok.verdict, 'ok');
		assert.strictEqual(browserPageWallNotice('https://example.com/a', ok), '');

		const thin = classifyExtractQuality('短');
		assert.strictEqual(thin.verdict, 'thin');
		assert.strictEqual(browserPageWallNotice('https://example.com/a', thin), '', 'thin 不是 blocked ⇒ 不带通知');
	});

	test('★★ 登录墙：明说"重试无用"、点名 login op + done 验证、凭据纪律；且不套"内容已删"那一支的话', () => {
		const q = classifyExtractQuality('请先登录后查看');
		assert.strictEqual(q.kind, 'login-required');
		const n = browserPageWallNotice('https://www.xiaohongshu.com/explore', q);

		assert.ok(n.includes('login wall'), '要说清这是登录墙（不能只说是 placeholder）');
		assert.ok(n.includes('https://www.xiaohongshu.com/explore'), '要点名是哪一页');
		assert.ok(n.includes('retrying changes nothing'), '同一堵墙重试无用 —— 必须明说，否则模型反复撞');
		assert.ok(n.includes('op: "login"'), '要给可执行的下一步（login op）');
		assert.ok(n.includes('done: true'), '要给**可验证**的那一步（done=true 才会去查登录态）');
		assert.ok(/never ask for credentials/.test(n), '凭据纪律：只请用户自己登录');
		assert.ok(n.includes('the identity is missing'), '这一支的原因就是缺登录态');
		assert.ok(!n.includes('Signing in will not bring it back'), '登录墙 ≠ 内容已删：不许套另一支的判词');
	});

	test('★★ 内容已删 / 受限：明确否掉"去登录"，且不点名 login op（那是另一条死路）', () => {
		const q = classifyExtractQuality('你访问的页面不见了');
		assert.strictEqual(q.kind, 'unavailable');
		const n = browserPageWallNotice('https://www.xiaohongshu.com/discovery/item/abc', q);

		assert.ok(n.includes('Signing in will not bring it back'), '必须点明"登录救不回来"');
		assert.ok(n.includes('not') && /not\*\* about credentials/.test(n), '必须显式否掉"缺身份"这个判断');
		assert.ok(!n.includes('op: "login"'), '内容已删 ⇒ 不许把模型送去跑登录流程');
		assert.ok(!n.includes('the identity is missing'), '这一支与身份无关');
	});

	test('★★ 反爬 / 人机校验：不是身份问题（旧文案那句对它是错的），给"换真实浏览器 / 稍后重试"', () => {
		const q = classifyExtractQuality('Just a moment...');
		assert.strictEqual(q.kind, 'interstitial');
		const n = browserPageWallNotice('https://example.com/blocked', q);

		assert.ok(n.includes('classified this session as automated'), '要说清成因在"how"而不是"who"');
		assert.ok(n.includes('The identity is not the issue here'), '必须否掉"缺登录态"这个误判');
		assert.ok(!n.includes('the identity is missing'), '反爬不是缺身份 —— 旧文案那句对它是错的');
		assert.ok(n.includes('chrome://inspect/#remote-debugging'), '要点名那个勾选框页面（用户唯一行动依据）');
		assert.ok(!n.includes('op: "login"'), '反爬 ≠ 登录墙');
	});

	test('★ 图片清单变体：点破"登录墙下仍有图（头像/图标）"这个最容易骗过模型的现象', () => {
		const q = classifyExtractQuality('请先登录后查看');
		const n = browserPageWallNotice('https://www.xiaohongshu.com/explore', q, { imageList: true });
		assert.ok(n.includes("do NOT treat the list above as the page's images"),
			'图片清单这一路必须额外点破"有图 ≠ 页面正常"');

		// 非图片清单时**不得**出现这句（否则每条快照都在说一件不属于它的事）
		const plain = browserPageWallNotice('https://www.xiaohongshu.com/explore', q);
		assert.ok(!plain.includes("do NOT treat the list above as the page's images"));
	});
});

/**
 * `manualAction`（P1-2）—— 把"哪一类墙"进一步翻成"**谁**该做下一步"。
 *
 * 为什么要有这一层：`kind` 只说类别，而下一步**该谁做**是另一个问题 —— 有些墙只有人能解
 * （登录 / 扫码 / 过验证码 / 在 App 里打开），有些墙重试就好（反爬常能自己过 / 频率限制）。
 * 不给这个区分，模型两头都会做错：在登录墙上死循环重试，或在 Cloudflare 页上直接把用户叫来。
 */
suite('manualAction — 每条拦截特征都要有"谁做下一步"', () => {

	const pick = (q: ReturnType<typeof classifyExtractQuality>) => {
		const a = assessManualAction(q);
		return a ? { action: a.action, needsHuman: a.needsHuman } : undefined;
	};

	test('★★ 每个已登记的特征标签都归入某个 manualAction（新增特征忘登记 ⇒ 这里红）', () => {
		const labels = WEB_PAGE_QUALITY_SIGNAL_LABELS;
		// 防「特征表被清空 ⇒ 空跑全绿」
		assert.ok(labels.length >= 15, `已登记特征数异常偏少（${labels.length}）—— 四张特征表结构变了？`);

		const unmapped: string[] = [];
		for (const label of labels) {
			const q = { verdict: 'blocked' as const, kind: 'interstitial' as const, length: 10, reason: 'probe', signals: [label] };
			const assessed = assessManualAction(q);
			if (!assessed || assessed.action === 'unknown') { unmapped.push(label); }
		}
		assert.deepStrictEqual(unmapped, [],
			`这些特征没有对应的 manualAction（要么登记动作，要么明确归 unknown 并写理由）：${unmapped.join(', ')}`);
	});

	test('★★ needsHuman 的判据：登录 / 验证码 / App 墙**要人**；反爬 / 限流 / 已删**不要人**', () => {
		assert.deepStrictEqual(pick(classifyExtractQuality('请先登录后查看')), { action: 'login-required', needsHuman: true });
		assert.deepStrictEqual(pick(classifyExtractQuality('请在App内打开')), { action: 'app-only', needsHuman: true });
		assert.deepStrictEqual(pick(classifyExtractQuality('Verifying you are a human')),
			{ action: 'captcha-required', needsHuman: true }, '人机校验只有人能过 ⇒ 不许让模型重试');

		assert.deepStrictEqual(pick(classifyExtractQuality('Just a moment...')),
			{ action: 'browser-check', needsHuman: false }, 'Cloudflare 那类常常自己就过了 ⇒ 别把人叫来');
		assert.deepStrictEqual(pick(classifyExtractQuality('too many requests')),
			{ action: 'rate-limited', needsHuman: false });
		assert.deepStrictEqual(pick(classifyExtractQuality('403 Forbidden')),
			{ action: 'permission-required', needsHuman: false }, '403 不是登录问题');
		assert.deepStrictEqual(pick(classifyExtractQuality('你访问的页面不见了')),
			{ action: 'content-gone', needsHuman: false }, '已删的内容，登录也救不回来');
	});

	test('★ 正常页面**不产出**人工动作（"狼来了"护栏）+ 格式固定（守卫/UI 按前缀解析）', () => {
		const ok = classifyExtractQuality('正文'.repeat(200), '正常标题');
		assert.strictEqual(ok.verdict, 'ok');
		assert.strictEqual(assessManualAction(ok), undefined, '正常页面不该产出人工动作');
		assert.strictEqual(manualActionLine(ok), '', '正常页面必须返回空串（否则每次快照都多一行噪声）');

		const line = manualActionLine(classifyExtractQuality('请先登录后查看'));
		assert.match(line, /^manualAction: login-required \(needsHuman=yes\) — /, `前缀/格式变了：${line}`);
	});

	test('★★ 两条通道都带这一行，而且都在**最后**（末尾才是模型开口前的最后一句）', () => {
		const q = classifyExtractQuality('请先登录后查看');
		const browserText = browserPageWallNotice('https://www.xiaohongshu.com/explore', q);
		assert.ok(browserText.trimEnd().endsWith('(a QR code scan is fine)'),
			'浏览器通道：manualAction 必须是最后一行');
		assert.ok(browserText.includes('manualAction: login-required (needsHuman=yes)'), '浏览器通道要带上前缀');

		const httpText = webExtractBlockedMessage('https://www.xiaohongshu.com/explore', q);
		assert.ok(httpText.includes('manualAction: login-required (needsHuman=yes)'),
			'HTTP 通道也要带（同一份真源 ⇒ 措辞必须逐字一致）');
		assert.ok(httpText.trimEnd().endsWith('(a QR code scan is fine)'), 'HTTP 通道同样放在最后');
	});
});
