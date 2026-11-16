/*
 * 2026-11-12：飞书同步「身份策略」与「失败如实汇总」守卫。
 *
 * 真机事故（用户贴的同步日志）：当前 profile strict-mode=bot，但脚本 18 条命令全带
 *   `--as user` ⇒ 每条都回 `strict mode is "bot", only bot-identity commands are available`，
 *   20 篇 ✗ + 5 条导图警告刷屏，结尾却报「完成 20 篇」（失败也计入 done，退出码 0）。
 *
 * 修复契约：
 *   · 身份由 `--identity bot|user` 统一注入（默认 user，保持旧行为）；
 *   · 开跑前**只读** `config strict-mode` 预检，冲突就一次性给指引并退出；
 *   · 绝不写 strict-mode（CLI help 明示须用户明确确认，AI 不得擅自切换）；
 *   · 失败单列计数，结尾如实汇总 + 非零退出码，报告文件带失败数。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-feishu-identity.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = readFileSync(HERE + '../scripts/feishu-sync.mjs', 'utf8');
const IDE_SCRIPT = readFileSync(HERE + '../../../resources/.agents/kb/feishu-sync.mjs', 'utf8');
const KB_CORE = readFileSync(HERE + '../lib/core/kb.js', 'utf8');
const INDEX = readFileSync(HERE + '../lib/index.js', 'utf8');
const { buildFeishuSyncArgs } = await import(new URL('../lib/core/kb.js', import.meta.url).href);

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

/** 取某个 flag 后面的值 */
const valOf = (args, flag) => {
	const i = args.indexOf(flag);
	return i < 0 ? undefined : args[i + 1];
};

check('① 两份同步脚本字节一致（改一份必须同步另一份）', () => {
	assert.equal(Buffer.compare(Buffer.from(SCRIPT), Buffer.from(IDE_SCRIPT)), 0);
});

check('② 参数组装：identity 只认 bot/user，空值不下发', () => {
	assert.equal(valOf(buildFeishuSyncArgs({ vault: 'V', identity: 'bot' }), '--identity'), 'bot');
	assert.equal(valOf(buildFeishuSyncArgs({ vault: 'V', identity: 'user' }), '--identity'), 'user');
	assert.equal(valOf(buildFeishuSyncArgs({ vault: 'V', identity: 'BOT' }), '--identity'), 'bot');
	assert.equal(valOf(buildFeishuSyncArgs({ vault: 'V', identity: 'root' }), '--identity'), undefined,
		'非法身份不能透传（防命令注入/误配）');
	assert.equal(valOf(buildFeishuSyncArgs({ vault: 'V' }), '--identity'), undefined);
});

check('③ Host 把设置的 identity 透传给同步脚本', () => {
	assert.ok(/identity:\s*String\(feishuCfg\.identity/.test(INDEX));
	assert.ok(/identity:\s*'user'/.test(INDEX), '设置默认值缺 identity');
});

check('④ 脚本：18 条命令不再写死 user，统一读 IDENTITY', async () => {
	assert.ok(/let IDENTITY = 'user'/.test(SCRIPT), '缺模块级身份变量');
	assert.ok(!/'--as', 'user'/.test(SCRIPT), '仍有写死 user 身份的调用');
	const hits = (SCRIPT.match(/'--as', IDENTITY/g) || []).length;
	assert.ok(hits >= 15, '注入点数量异常：' + hits);
	assert.ok(/IDENTITY = args\.identity/.test(SCRIPT), 'main 没把参数写进 IDENTITY');
	assert.ok(/identity:\s*'user'/.test(SCRIPT) && /a === '--identity'/.test(SCRIPT), 'parseArgs 缺 identity');
});

check('⑤ 预检只读 strict-mode，冲突给一次性指引，绝不写策略', () => {
	assert.ok(/function checkIdentityPolicy\(/.test(SCRIPT));
	assert.ok(/lark\(\['config', 'strict-mode'\]\)/.test(SCRIPT), '预检必须是无参数的只读查询');
	// 只抓 argv 形态的三参数切换；指引文案里必然出现建议命令 `config strict-mode off`，不能拿来误判
	assert.ok(!/\['config',\s*'strict-mode',\s*'(bot|user|off)'/.test(SCRIPT), '不许把切换值作为 argv 执行');
	assert.ok(!/config\s+strict-mode\s+(bot|user|off)\s*['"`\]]/.test(SCRIPT), '疑似执行了切换');
	assert.ok(/policy\.conflict/.test(SCRIPT) && /process\.exit\(2\)/.test(SCRIPT), '冲突要提前退出');
	assert.ok(/identityPolicyHint\(/.test(SCRIPT));
	assert.ok(SCRIPT.includes('wiki:wiki:readonly') && SCRIPT.includes('auth login'), '指引缺权限/登录路线');
	assert.ok(SCRIPT.includes('不会擅自修改安全策略'), '指引必须声明不擅自改策略');
});

check('⑥ 失败如实汇总：计数、非零退出码、报告带失败数', () => {
	assert.ok(/let failed = 0/.test(SCRIPT));
	assert.ok(/catch \(e\) \{\s*\n\s*failed\+\+/.test(SCRIPT), 'catch 里没记失败');
	assert.ok(/process\.exitCode = 1/.test(SCRIPT), '失败没有非零退出码 ⇒ Host 会误判成功');
	assert.ok(/其中失败 \$\{failed\} 篇/.test(SCRIPT), '结尾没如实汇总');
	assert.ok(/total: plan\.length, failed,/.test(SCRIPT), '报告文件没带失败数');
	assert.ok(/# 失败 \$\{o\.failed/.test(SCRIPT), '报告头部没写失败数');
});

check('⑥b ★ dry-run 不被身份策略挡死，且汇总不冒充「已完成」', () => {
	assert.ok(/if \(args\.dryRun\) \{\s*\n\s*console\.warn\(`\[identity\]/.test(SCRIPT),
		'dry-run 仍被预检 process.exit(2) 拦住 ⇒ 用户看不到计划');
	assert.ok(/预览 \$\{done\} 篇.*DRY-RUN，未写入任何远端/.test(SCRIPT), 'dry-run 汇总没标明未写远端');
	assert.ok(SCRIPT.includes('以上为预览计划，未写入任何远端'), '报告头部没标明预览');
	assert.ok(/if \(args\.dryRun\) \{[\s\S]*?\} else \{[\s\S]*?process\.exitCode = 1/.test(SCRIPT),
		'失败非零退出码应只在 apply 分支生效');
});

check('⑦ 反向突变自证：把写死 user 塞回去会被 ④ 抓到', () => {
	const broken = SCRIPT + "\nconst ignored = ['--as', 'user'];\n";
	assert.ok(/'--as', 'user'/.test(broken) && !/'--as', 'user'/.test(SCRIPT));
});

const TSX = readFileSync(HERE + '../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', 'utf8');
const CLIENT = readFileSync(HERE + '../lib/client.js', 'utf8');
check('⑦b 两份设置页都有「飞书身份」下拉，且只给 bot/user 两个值', () => {
	for (const [name, src] of [['TSX', TSX], ['client.js', CLIENT]]) {
		assert.ok(src.includes('data-vssaros-kb-identity-select'), name + ' 缺身份下拉锚点');
		assert.ok(src.includes('飞书身份'), name + ' 缺标签');
		assert.ok(/identity:\s*e\.target\.value === 'bot' \? 'bot' : 'user'/.test(src)
			|| /patchFeishu\('identity',\s*e\.target\.value === 'bot' \? 'bot' : 'user'/.test(src),
			name + ' 保存值没收敛到 bot/user（脏值会透传到 argv）');
		assert.ok(src.includes('不会擅自修改'), name + ' 缺「不改安全策略」说明');
	}
});

// ── 端到端：用假 lark-cli 跑真脚本，验证「身份透传」与「预检冲突提前中止」 ──────
const { spawnSync } = await import('node:child_process');
const tmp = mkdtempSync(path.join(tmpdir(), 'kb-feishu-identity-'));
try {
	// 假 CLI 必须做成 npm shim 形态（.cmd + node_modules/*.js），
	// 否则 resolveCliLaunch 解析不出 node 入口 ⇒ 预检读不到输出。
	const { mkdirSync } = await import('node:fs');
	const cliDir = path.join(tmp, 'node_modules', 'fake-lark');
	mkdirSync(cliDir, { recursive: true });
	const argvLog = path.join(tmp, 'argv.log');
	const fakeEntry = path.join(cliDir, 'cli.js');
	const fakeShim = path.join(tmp, 'fake-lark.cmd');
	writeFileSync(fakeEntry, [
		"const fs = require('fs');",
		`const log = ${JSON.stringify(argvLog)};`,
		'fs.appendFileSync(log, process.argv.slice(2).join("\\t") + "\\n");',
		'if (process.argv.slice(2).includes("strict-mode")) {',
		'  console.log("strict-mode: " + (process.env.FAKE_STRICT_MODE || "off") + " (source: profile cli_fake)");',
		'  process.exit(0);',
		'}',
		'console.log(JSON.stringify({ ok: true, data: {} }));',
	].join('\n'), 'utf8');
	writeFileSync(fakeShim, '@echo off\nnode %~dp0node_modules\\fake-lark\\cli.js %*\n', 'utf8');
	const fakeCli = fakeShim;
	const vault = path.join(tmp, 'vault');
	mkdirSync(path.join(vault, '知识库列表', '游戏设计'), { recursive: true });
	writeFileSync(path.join(vault, '知识库列表', '游戏设计', 'a.md'), '# A\n\n正文。\n', 'utf8');
	const scriptPath = path.join(HERE, '../scripts/feishu-sync.mjs');
	const run = (extra, env = {}) => spawnSync(process.execPath,
		[scriptPath, '--vault', vault, '--src', '知识库列表', '--cli', fakeCli, ...extra],
		{ encoding: 'utf8', env: { ...process.env, ...env } });

	check('⑧ ★ 端到端：策略与身份一致时放行，且下发的身份不跑偏', () => {
		try { rmSync(argvLog); } catch { /* 首次不存在 */ }
		const r = run(['--apply', '--identity', 'bot'], { FAKE_STRICT_MODE: 'bot' });
		const log = (() => { try { return readFileSync(argvLog, 'utf8'); } catch { return ''; } })();
		assert.ok(log.includes('strict-mode'), '没有做预检');
		assert.ok(!String(r.stderr || '').includes('飞书身份冲突'), 'bot/bot 不该报冲突');
		assert.ok(!/--as\tuser/.test(log), '配置成 bot 却仍在下发 user 身份 ✗');
		const asValues = [...log.matchAll(/--as\t(\w+)/g)].map(m => m[1]);
		if (asValues.length) { assert.ok(asValues.every(v => v === 'bot'), '身份值不一致：' + asValues.join(',')); }
	});

	check('⑨ ★ 端到端：策略=bot 而身份=user ⇒ apply 一次性中止，不刷屏', () => {
		const r = run(['--apply', '--identity', 'user'], { FAKE_STRICT_MODE: 'bot' });
		const out = String(r.stdout || '') + String(r.stderr || '');
		assert.equal(r.status, 2, 'apply 应以退出码 2 提前中止，实际 ' + r.status);
		assert.ok(out.includes('飞书身份冲突'), '没有一次性指引');
		assert.ok(out.includes('strict-mode=bot') && out.includes('wiki:wiki:readonly'), '指引缺关键信息');
		assert.ok(!out.includes('[update] ✗'), '不该继续逐篇执行并刷屏');
		assert.ok(!out.includes('完成 20 篇'), '不该假装完成');
	});

	check('⑨b ★ 端到端：同样冲突下 dry-run 仍放行并输出计划，且不冒充完成', () => {
		const r = run(['--dry-run', '--identity', 'user'], { FAKE_STRICT_MODE: 'bot' });
		const out = String(r.stdout || '') + String(r.stderr || '');
		assert.equal(r.status, 0, 'dry-run 不该被身份策略挡死，实际 ' + r.status + '：' + out.slice(0, 200));
		assert.ok(out.includes('飞书身份冲突'), '缺冲突提示');
		assert.ok(out.includes('仍继续输出计划'), '缺「仅预览」说明');
		assert.ok(out.includes('DRY-RUN，未写入任何远端'), '汇总没标明未写远端');
		assert.ok(!out.includes('未出现失败 ✓'), 'dry-run 不该说「未出现失败」（会误导为已同步）');
	});

	check('⑩ 端到端：策略=off ⇒ 不拦截，正常跑完', () => {
		const r = run(['--dry-run', '--identity', 'user'], { FAKE_STRICT_MODE: 'off' });
		assert.equal(r.status, 0, String(r.stderr || '').slice(0, 300));
		assert.ok(!String(r.stderr || '').includes('飞书身份冲突'));
	});
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
