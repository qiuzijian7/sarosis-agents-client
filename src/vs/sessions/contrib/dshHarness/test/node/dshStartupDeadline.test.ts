/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 进度感知的启动截止（`dshStartupDeadline`）。
 *
 * 这些用例对应真机上抓到的那个缺陷：冷机器上 Host 正在"安装伴生插件（1/3）"（合法耗时）却被
 * 固定 60s 的秒表判成"启动失败"。所以这里钉的是**两个预算**的语义：
 * 安静预算判"卡住"、总时长上限判"没完没了"，且**有进展就续期**。
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { MAX_LISTED_PLUGIN_PROBLEMS, StartupDeadlineExpiry, createStartupDeadline, formatPluginProblems, startupExpiryMessage } from '../../electron-main/dshStartupDeadline.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

suite('dshStartupDeadline（进度感知的启动截止）', () => {

	test('没有任何进展 ⇒ 安静预算到点报 quiet（保留旧的 60s 语义）', async () => {
		const expiries: StartupDeadlineExpiry[] = [];
		createStartupDeadline({ quietMs: 30, maxMs: 5_000, onExpire: reason => expiries.push(reason) });
		await sleep(90);
		assert.deepStrictEqual(expiries, ['quiet']);
	});

	test('★ 有进展就续期：每次 touch 重置安静预算（"正在安装伴生插件"这类合法耗时不该被判失败）', async () => {
		const expiries: StartupDeadlineExpiry[] = [];
		const deadline = createStartupDeadline({ quietMs: 40, maxMs: 5_000, onExpire: reason => expiries.push(reason) });
		// 每 20ms 报一次进展，持续 200ms ⇒ 远超安静预算，但一次都不该超时
		for (let i = 0; i < 10; i++) {
			await sleep(20);
			deadline.touch();
		}
		assert.deepStrictEqual(expiries, [], '持续有进展 ⇒ 不该判卡住');
		// 停止报进展 ⇒ 安静预算到点，仍然会失败（不是"永不失败"）
		await sleep(90);
		assert.deepStrictEqual(expiries, ['quiet'], '进展停下后仍要判失败');
	});

	test('★ 总时长上限：进展不断也不能超过 maxMs（否则坏进程能永远吊住 UI）', async () => {
		const expiries: StartupDeadlineExpiry[] = [];
		const sees: number[] = [];
		const deadline = createStartupDeadline({
			quietMs: 1_000, maxMs: 60,
			onExpire: (reason, detail) => { expiries.push(reason); sees.push(detail.elapsedMs); },
		});
		for (let i = 0; i < 8; i++) {
			await sleep(15);
			deadline.touch();
		}
		assert.deepStrictEqual(expiries, ['max'], `续期不该突破总时长上限（elapsed=${sees.join(',')}）`);
		// elapsed 允许**略小于** maxMs：定时器会提前 1ms 触发（这条真机口径曾在 59ms 上把原因
		// 误报成 'quiet'，见模块里那段注释）。要的是"约等于 60"，不是精确 60。
		assert.ok(sees[0] >= 55 && sees[0] <= 120, `报出的 elapsed 应约等于 maxMs：${sees[0]}`);
	});

	test('到期只回调一次；dispose 之后不再回调（幂等）', async () => {
		const expiries: StartupDeadlineExpiry[] = [];
		const deadline = createStartupDeadline({ quietMs: 20, maxMs: 5_000, onExpire: reason => expiries.push(reason) });
		await sleep(50);
		deadline.touch();
		deadline.dispose();
		await sleep(30);
		assert.deepStrictEqual(expiries, ['quiet'], '到期一次 + dispose 后不再开会话');
		const other = createStartupDeadline({ quietMs: 20, maxMs: 5_000, onExpire: reason => expiries.push(reason) });
		other.dispose();
		await sleep(40);
		assert.deepStrictEqual(expiries, ['quiet'], 'dispose 之后不该回调');
	});

	test('注入 now：elapsed 用注入的时钟算（便于断言，不依赖真实时间）', async () => {
		let clock = 1_000;
		const seen: number[] = [];
		const deadline = createStartupDeadline({
			quietMs: 25, maxMs: 10_000, now: () => clock,
			onExpire: (_reason, detail) => seen.push(detail.elapsedMs),
		});
		clock = 1_040;                    // 人为把时钟推后 40ms ⇒ 安静预算（25ms）已过
		await sleep(40);
		deadline.dispose();
		assert.deepStrictEqual(seen, [40], `elapsed 应来自注入时钟：${seen.join(',')}`);
	});

	// ── 文案（`startupExpiryMessage`）────────────────────────────────────────
	// 起因：真机上"profile 缺官方 web-app ⇒ 控制桥永远 pending ⇒ 管道 ENOENT"，而界面只说
	// "Host 在 60 秒内没有任何进展"——用户据此去查"进程卡住了"，方向错了。桥连接失败过就必须报出来。

	test('★ 安静到点：说"没有进展"，并带上最后一行', () => {
		const msg = startupExpiryMessage({ reason: 'quiet', quietMs: 60_000, maxMs: 600_000, lastLine: '(无输出)' });
		assert.ok(msg.includes('60 秒内没有任何进展'), msg);
		assert.ok(msg.includes('(无输出)'), msg);
		assert.ok(!msg.includes('控制桥'), `没桥错误时不该提桥：${msg}`);
	});

	test('★★ 桥连接失败过 ⇒ 文案里必须有"控制桥未握手"+原因（否则引导用户查错方向）', () => {
		const msg = startupExpiryMessage({
			reason: 'quiet', quietMs: 60_000, maxMs: 600_000,
			lastLine: 'bridge connect failed: 控制桥连接超时（60000 ms）：connect ENOENT \\\\.\\pipe\\vssaros-dsh-11fe',
			bridgeError: '控制桥连接超时（60000 ms）：connect ENOENT \\\\.\\pipe\\vssaros-dsh-11fe',
		});
		assert.ok(msg.includes('控制桥未握手'), msg);
		assert.ok(msg.includes('ENOENT'), msg);
		assert.ok(msg.includes('没有任何进展'), `仍要保留"没进展"这一层（两种原因都有用）：${msg}`);
	});

	test('总时长上限：文案说"有进展但不结束"（与"卡住"区分开），桥错误同样带上', () => {
		const msg = startupExpiryMessage({
			reason: 'max', quietMs: 60_000, maxMs: 600_000, lastLine: 'installing …',
			bridgeError: 'pipe ENOENT',
		});
		assert.ok(msg.includes('10 分钟仍未就绪'), msg);
		assert.ok(msg.includes('有进展但不结束'), msg);
		assert.ok(msg.includes('控制桥未握手：pipe ENOENT'), msg);
	});

	// ── 插件缺失清单（`pluginProblems` / `formatPluginProblems`）───────────────
	// 上面那条实测教训的延伸：伴生插件没装上时 `_ensurePlugin` **只写日志并继续**，
	// 于是缺包的 profile 最终只会说"没有进展"✗，用户去查进程/网络 —— 方向全错。

	test('没有插件问题时文案一字不多（不引入噪音）', () => {
		const base = startupExpiryMessage({ reason: 'quiet', quietMs: 60_000, maxMs: 600_000, lastLine: 'x' });
		for (const problems of [undefined, [], ['   ']]) {
			const msg = startupExpiryMessage({ reason: 'quiet', quietMs: 60_000, maxMs: 600_000, lastLine: 'x', pluginProblems: problems });
			assert.strictEqual(msg, base, `空清单（${JSON.stringify(problems)}）不该改变文案`);
		}
		assert.strictEqual(formatPluginProblems(undefined), '');
		assert.strictEqual(formatPluginProblems([]), '');
	});

	test('★ 有插件没装上 ⇒ 文案点名它，并给出"这常是真因"的可操作提示', () => {
		const msg = startupExpiryMessage({
			reason: 'quiet', quietMs: 60_000, maxMs: 600_000, lastLine: '(无输出)',
			pluginProblems: ['@vssaros/dsh-bridge（应 0.2.20，实为 未装）'],
		});
		assert.ok(msg.includes('有 1 个插件没装上'), msg);
		assert.ok(msg.includes('@vssaros/dsh-bridge'), msg);
		assert.ok(msg.includes('应 0.2.20'), msg);
		assert.ok(msg.includes('详见 Host 日志'), msg);
		assert.ok(msg.includes('没有任何进展'), `仍保留"没进展"这一层（两种原因都有用）：${msg}`);
	});

	test('★ 截断口径：超过 3 个只列前 3 个并报总数（否则通知会长到没法读）', () => {
		const five = ['p1', 'p2', 'p3', 'p4', 'p5'];
		const line = formatPluginProblems(five);
		assert.ok(line.includes(`有 5 个插件没装上（只列前 ${MAX_LISTED_PLUGIN_PROBLEMS} 个）`), line);
		assert.ok(line.includes('p1、p2、p3'), line);
		assert.ok(!line.includes('p4') && !line.includes('p5'), `第 4 个之后不该列出来：${line}`);
		// 恰好等于上限 ⇒ 不出现"只列前"
		const three = formatPluginProblems(['p1', 'p2', 'p3']);
		assert.ok(!three.includes('只列前'), three);
		assert.ok(three.includes('有 3 个插件没装上'), three);
	});

	test('总时长上限分支同样带上插件缺失（两个分支不能只改一个）', () => {
		const msg = startupExpiryMessage({
			reason: 'max', quietMs: 60_000, maxMs: 600_000, lastLine: 'installing …',
			pluginProblems: ['@vssaros/dsh-voice（应 1.0.0，实为 未装）'],
		});
		assert.ok(msg.includes('有进展但不结束'), msg);
		assert.ok(msg.includes('@vssaros/dsh-voice'), msg);
	});

	test('接线守卫：supervisor 真的收集、且真的传给了文案（防"收集了没人用"）', () => {
		const src = readFileSync(join(process.cwd(), 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts'), 'utf8');
		assert.ok(/_startupPluginProblems\s*=\s*\[\]/.test(src),
			'启动前没重置清单 ⇒ 上一次启动的残留会混进这次的失败文案 ✗');
		assert.ok(/_startupPluginProblems\.push\(/.test(src),
			'没有任何地方写入清单 ⇒ 收集恒为空（等于没做）✗');
		assert.ok(/pluginProblems:\s*this\._startupPluginProblems/.test(src),
			'清单没传给 startupExpiryMessage ⇒ 用户还是只看到"没有进展"✗');
	});
});
