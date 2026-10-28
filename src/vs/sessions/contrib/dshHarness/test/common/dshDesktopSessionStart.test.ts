/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 桌面窗口"自己的会话"启动失败后该不该重试（2026-10-27）。
 *
 * 现场（真机 `logs/20261027T100853`，用户报「弹窗停在 hero、输入框被官方 inert 禁用」）：
 *   10:09:07.734 Host ready
 *   10:09:08.551 `full window: 独立会话启动失败 ⇒ 回落官方默认页
 *                 vssaros-agents (@vssaros/dsh-agents): never started`
 *   10:09:19.129 mux route available **+11394 ms after Host ready**
 * ⇒ 会话创建发生在 Host ready 后 0.8s，而真正可用要等 11s ⇒ 那是"插件还没挂载完"，
 *   **值得重试**；以前一次失败就放弃 ⇒ 桌面窗口永远停在 hero，且页面上没有任何说明 ✗。
 *
 * 本守卫钉两件事：
 *   ① 判据表（哪些错误值得重试 / 哪些是真失败 / 次数上限）；
 *   ② 接线（contribution 真的用了这个判据、真的把原因显示给用户、成功时把提示条撤掉）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDesktopSessionStart
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { decideSessionStartRetry, SESSION_START_MAX_ATTEMPTS, sessionStartRetryDelayMs } from '../../common/dshDesktopSessionStart.js';

const CONTRIBUTION = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉注释（防"注释里写了 case xxx"造成假绿）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('desktop 窗口：会话启动失败 ⇒ 重试 + 把原因显示给用户', () => {

	test('① 判据表：插件未挂载 / Host 还在热起来 ⇒ 重试', () => {
		// ★ 本次真机的那条：`agent-preset/invalid: vssaros-agents (@vssaros/dsh-agents): never started`
		assert.strictEqual(decideSessionStartRetry('vssaros-agents (@vssaros/dsh-agents): never started', 1, 3), 'retry');
		assert.strictEqual(decideSessionStartRetry('session create failed: agent-preset/invalid: vssaros-agents: never started', 2, 3), 'retry');
		assert.strictEqual(decideSessionStartRetry('socket hang up', 1, 3), 'retry');
		assert.strictEqual(decideSessionStartRetry('request timeout', 1, 3), 'retry');
		assert.strictEqual(decideSessionStartRetry('ECONNREFUSED 127.0.0.1:6474', 1, 3), 'retry');
		// 大小写不敏感（跨进程过来的文本形态不统一）
		assert.strictEqual(decideSessionStartRetry('Never Started', 1, 3), 'retry');
	});

	test('② 判据表：真失败 ⇒ 不重试（重试只会拖慢报错 + 刷空会话）', () => {
		assert.strictEqual(decideSessionStartRetry('unknown session session-abc', 1, 3), 'fail');
		assert.strictEqual(decideSessionStartRetry('session/conflict: session "x" belongs to "y"', 1, 3), 'fail');
		assert.strictEqual(decideSessionStartRetry('permission denied', 1, 3), 'fail');
		// ⚠ 负对照：致命特征**优先于**可重试特征 —— 一条消息同时含两者时必须判死
		//   （只查"出现 retry"会被"去掉 FATAL_MARKERS"骗过 ✗）。
		assert.strictEqual(decideSessionStartRetry('unknown session (never started)', 1, 3), 'fail',
			'致命特征必须优先于可重试特征 ✗');
		// ★★ 2026-10-28 真机原文（桌面窗口弹出的那条）：Host 被外部杀掉后 supervisor 自动重启
		//   （实测 25.8s），重启窗口期 `bridge` 为 undefined ⇒ startSession 抛这条中文文案。
		//   它**明显是瞬时态**，必须重试（否则第 1 次就判死、窗口停在提示条上 ✗✗）。
		// ⚠ 每条用例只留**一个**特征：真机原文里既有"控制桥不可用"又有"Host 未运行"，
		//   直接拿它当用例会让"删掉其中一个特征"仍然绿（实测假绿 ✗）。
		assert.strictEqual(
			decideSessionStartRetry('[dshHarness] startSession: 控制桥不可用', 1, 3),
			'retry',
			'"控制桥不可用"必须可重试（Host 重启期只有 ~26s，等一等就好 ✗）');
		assert.strictEqual(decideSessionStartRetry('未安装伴生插件或 Host 未运行', 1, 3), 'retry');
		assert.strictEqual(decideSessionStartRetry('Host 意外退出（code -1）', 1, 3), 'retry');
		assert.strictEqual(decideSessionStartRetry('Host exited unexpectedly (code 4294967295)', 1, 3), 'retry');
		// 真机原文整体也必须判 retry（回归用例）
		assert.strictEqual(
			decideSessionStartRetry('[dshHarness] startSession: 控制桥不可用（未安装伴生插件或 Host 未运行）', 1, 3),
			'retry');
		// 未知错误 ⇒ 别瞎重试（真机上这是"什么都不知道"）
		assert.strictEqual(decideSessionStartRetry('something else entirely', 1, 3), 'fail');
		// 空消息 ⇒ 不重试
		assert.strictEqual(decideSessionStartRetry('', 1, 3), 'fail');
	});

	test('③ 次数上限：最后一次失败必须判死（不许无限重试）', () => {
		// ⚠ 必须钉**绝对次数**：只断言"attempt === max 时 fail"会被"把上限改成 99"骗过
		//   （真机：窗口在后台重试 99 次 = 好几分钟没反应 ✗）。
		assert.strictEqual(SESSION_START_MAX_ATTEMPTS, 3, '最多只能试 3 次（含第一次）✗');
		assert.strictEqual(decideSessionStartRetry('never started', 3, 3), 'fail',
			'第 3 次仍失败 ⇒ 必须收手（否则窗口永远在后台刷）✗');
		assert.strictEqual(decideSessionStartRetry('never started', 4, 3), 'fail');
		assert.strictEqual(decideSessionStartRetry('never started', SESSION_START_MAX_ATTEMPTS + 1, SESSION_START_MAX_ATTEMPTS), 'fail');
		// 非法参数一律判死
		assert.strictEqual(decideSessionStartRetry('never started', 1, 0), 'fail');
		assert.strictEqual(decideSessionStartRetry('never started', 0, 3), 'fail');
		assert.strictEqual(decideSessionStartRetry('never started', Number.NaN, 3), 'fail');
	});

	test('④ 退避：递增且有上限（真机上 mux 要 11s 才可用）', () => {
		const d1 = sessionStartRetryDelayMs(1);
		const d2 = sessionStartRetryDelayMs(2);
		const d3 = sessionStartRetryDelayMs(3);
		assert.ok(d1 > 0 && d2 > d1 && d3 > d2, `退避必须递增（${d1}/${d2}/${d3}）✗`);
		assert.ok(d1 + d2 >= 10_000, `前两跳要盖到 mux 就绪的 ~11s 量级（实际 ${d1 + d2}ms）✗`);
		// ★ 2026-10-28：Host 被杀后的自动重启实测 25.8s ⇒ 三跳合计必须**明显**盖住它
		//   （3/8/15=26s 只是勉强擦边，实测那次重启 25.774s + 首跳前的开销就会超 ⇒ 阈值取 35s）✗。
		assert.ok(d1 + d2 + d3 >= 35_000, `三跳合计要明显盖住一次 Host 重启（实测 25.8s，实际 ${d1 + d2 + d3}ms）✗`);
		// 越界不抖
		assert.strictEqual(sessionStartRetryDelayMs(99), d3);
		assert.strictEqual(sessionStartRetryDelayMs(0), d1);
	});

	test('⑤ 接线：contribution 真的用了判据，并把原因显示给用户', () => {
		const src = stripComments(read(CONTRIBUTION));
		assert.match(src, /decideSessionStartRetry\(message, attempt, SESSION_START_MAX_ATTEMPTS\)/,
			'判据必须走 common 的纯函数（口径只有一份，且可单测 ✗）');
		assert.match(src, /sessionStartRetryDelayMs\(attempt\)/, '重试之间必须退避（连发只会刷屏 ✗）');
		// ⚠ 必须**两个分支都报**（判死分支 + 重试分支）：只断言"出现过一次"会被
		//   "删掉其中一条"骗过 —— 真机上表现是"某类失败窗口上什么都没有" ✗。
		const ensureAt = src.indexOf('private async _ensurePopoutSessionId(');
		assert.ok(ensureAt > 0, '找不到 _ensurePopoutSessionId ✗');
		const ensure = src.slice(ensureAt, src.indexOf('\n\tprivate ', ensureAt + 1));
		// ⚠ 按**行**切片：字符切片会把"没有工作区"那次 `reporter?.('…')` 也算进来 ⇒ 删掉
		//   判死分支那次照样绿（实测假绿 ✗），而且匹配 `reporter?\.` 时它也能蒙对。
		const lines = ensure.split('\n');
		const liDecide = lines.findIndex(l => l.includes("!== 'retry'"));
		const liDelay = lines.findIndex(l => l.includes('sessionStartRetryDelayMs(attempt)'));
		const liFatalEnd = lines.findIndex((l, i) => i > liDecide && /^\s*\}\s*$/.test(l));   // 判死分支的收尾大括号
		assert.ok(liDecide > 0 && liFatalEnd > liDecide && liDelay > liFatalEnd, '找不到"判定 → 判死收尾 → 退避"三处锚点（切片口径失效）✗');

		const fatalBranch = lines.slice(liDecide, liFatalEnd).join('\n');
		assert.match(fatalBranch, /reporter\?\.\(message, attempt\)/,
			'判为不可重试时必须把原因报给页面（否则用户只看到 hero + 禁用输入框 ✗）');

		const retryBranch = lines.slice(liFatalEnd, liDelay).join('\n');
		assert.match(retryBranch, /reporter\?\.\(message, attempt\)/,
			'还会重试时也要先报一次（否则前 10 秒窗口上什么都没有 ✗）');

		const bannerAt = src.indexOf('private _showStartupBanner(');
		assert.ok(bannerAt > 0, '找不到 _showStartupBanner ✗');
		const banner = src.slice(bannerAt, src.indexOf('\n\tprivate ', bannerAt + 1));
		assert.match(banner, /'z-index:3'/,
			'提示条必须盖在原生视图之上（dsh 界面是 WebContentsView，默认在 DOM 之上 ✗）');
		assert.match(banner, /'right:132px'/,
			'右侧必须给 Electron 画的窗控按钮留位（压住它们 = 关不了窗口 ✗）');
		assert.match(banner, /retry\.addEventListener\('click', \(\) => onRetry\(\)\)/,
			'「重试」按钮必须真的接上重试动作 ✗');
		assert.match(banner, /第 \$\{attempt\}\/\$\{SESSION_START_MAX_ATTEMPTS\} 次/,
			'提示条必须写明"第几次"（否则用户不知道还要等多久）✗');

		// 成功 / 关窗都要撤掉（留着 = 明明能用却挂着一条错误 ✗）
		assert.match(src, /if \(sessionId\) \{\s*this\._clearStartupBanner\(\);\s*\}/, '会话成功后必须撤掉提示条 ✗');
		assert.match(src, /private _clearStartupBanner\(\)/, '必须有撤掉提示条的方法 ✗');

		// 没有工作区目录 ⇒ 明确告知（真机出现过"取不到 cwd ⇒ 停 hero"的另一条路）
		assert.match(src, /reporter\?\.\('没有打开工作区/, '没有工作区时必须明确告知原因（静默停 hero ✗）');
	});
});
