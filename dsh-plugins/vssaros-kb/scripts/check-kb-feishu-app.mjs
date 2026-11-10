/*
 * 2026-11-10：知识库设置页可指定飞书应用（appId / appSecret）的守卫。
 *
 * 为什么必须有它：随包内置的 `cli_a860911d2e7f5013` 不是用户想要的应用；换应用要走
 *   lark-cli 的 `profile add --app-secret-stdin` + 每条命令 `--profile <appId>`
 *   （照 vssaros-superagent/lib/environment-YhSAne6L.js:284-305、:1252-1256）。
 * 安全红线：appSecret 不进 argv / 不进 .kb-settings.json / 不进日志 / 不回显，
 *   只进 ctx.credentials 与 lark-cli 的 stdin。
 *
 * 除了纯函数与静态接线，还跑一次**真实 HTTP POST**（fake Host）验证红线没被绕过。
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-feishu-app.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = new URL('.', import.meta.url);
const app = await import(new URL('../lib/core/kbFeishuApp.js', HERE).href);
const INDEX = readFileSync(new URL('../lib/index.js', HERE), 'utf8');
const CLIENT = readFileSync(new URL('../lib/client.js', HERE), 'utf8');
const TSX = readFileSync(new URL('../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', HERE), 'utf8');
const SCRIPT = readFileSync(new URL('../scripts/feishu-sync.mjs', HERE), 'utf8');
const IDE_SCRIPT = readFileSync(new URL('../../../resources/.agents/kb/feishu-sync.mjs', HERE), 'utf8');
const BUNDLE = readFileSync(new URL('../lib/web/kbSideview.js', HERE), 'utf8');
const FND = await import(new URL('../../vssaros-foundation/lib/index.js', HERE).href);
const KB = await import(new URL('../lib/index.js', HERE).href);

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

// ── 纯函数 ──────────────────────────────────────────────────────────────────
check('① appId 校验：cli_ 形态通过、乱填拒绝、空串合法（未配置）', () => {
	assert.equal(app.isValidAppId('cli_a1b2c3'), true);
	assert.equal(app.isValidAppId(''), true);
	assert.equal(app.isValidAppId('abc123'), false);
	assert.equal(app.isValidAppId('../etc'), false);
});
check('② 凭据引用名按 appId 区分且是 POSIX 标识符', () => {
	const ref = app.credentialRefForApp('cli_a1b2c3');
	assert.equal(ref, 'VSSAROS_KB_FEISHU_APP_SECRET_CLI_A1B2C3');
	assert.ok(/^[A-Z][A-Z0-9_]*$/.test(ref));
	assert.equal(app.credentialRefForApp(''), '');
});
check('③ profile 参数：全局 --profile 在子命令前；没配应用 ⇒ 空数组', () => {
	assert.deepEqual(app.profileArgsOf('cli_a1b2c3'), ['--profile', 'cli_a1b2c3']);
	assert.deepEqual(app.profileArgsOf(''), []);
	assert.deepEqual(app.profileArgsOf('bad/../id'), []);
});
check('④ profileAddArgs 用 stdin 收 secret（argv 里没有 secret、也没有 --profile）', () => {
	const args = app.profileAddArgs('cli_a1b2c3');
	assert.deepEqual(args, ['profile', 'add', '--name', 'cli_a1b2c3', '--app-id', 'cli_a1b2c3',
		'--app-secret-stdin', '--brand', 'feishu']);
	assert.ok(args.includes('--app-secret-stdin'));
	assert.ok(!args.includes('--profile'));
});
check('⑤ appSecret 三种语义：留空=不改 / null=清除 / 非空=设置', () => {
	assert.equal(app.secretIntentOf(undefined), 'keep');
	assert.equal(app.secretIntentOf(''), 'keep');
	assert.equal(app.secretIntentOf(null), 'clear');
	assert.equal(app.secretIntentOf('s3cr3t'), 'set');
});

// ── 静态接线 ────────────────────────────────────────────────────────────────
check('⑥ Host 启动时读 appId；runLarkCli 统一注入 --profile', () => {
	assert.ok(/loadFeishuAppId\(config\)/.test(INDEX));
	assert.ok(/profileArgsOf\(KB_FEISHU_APP_ID\)/.test(INDEX), '没在 runLarkCli 注入 profile');
	assert.ok(/opts\.skipProfile/.test(INDEX), '建 profile 时必须能跳过注入');
});
check('⑦ secret 只经 stdin；同步脚本只拿 appId（非机密）', () => {
	assert.ok(/stdin:\s*secret \+ '\\n'/.test(INDEX));
	assert.ok(/VSSAROS_KB_FEISHU_PROFILE:\s*KB_FEISHU_APP_ID/.test(INDEX));
	assert.ok(!/LARK_APP_SECRET|LARK_APP_ID/.test(INDEX), '不要走无依据的 env 路线');
});
check('⑧ 两份同步脚本字节一致，且两条 spawn 分支都带 --profile', () => {
	assert.equal(SCRIPT, IDE_SCRIPT, '两份脚本漂移了（守卫钉住字节一致）');
	assert.ok(/VSSAROS_KB_FEISHU_PROFILE/.test(SCRIPT));
	assert.equal((SCRIPT.match(/profilePrefix/g) || []).length >= 3, true);
});
check('⑨ 设置页：secret 不落盘、不回显，走凭据库', () => {
	assert.ok(/delete next\.feishu\.appSecret/.test(INDEX), 'POST 没删 appSecret');
	assert.ok(/delete merged\.feishu\.appSecret/.test(INDEX), 'GET 会回显历史明文');
	assert.ok(/KB_CREDENTIALS\.set\(ref, typedSecret\)/.test(INDEX));
	assert.ok(/hasAppSecret:\s*Boolean\(/.test(INDEX));
	assert.ok(!/send\(200, \{ ok: true, settings: readSettings\(\) \}\)/.test(INDEX));
});
check('⑩ 两份前端都有 password 输入与 hasAppSecret 状态', () => {
	for (const [name, src] of [['TSX', TSX], ['client.js', CLIENT]]) {
		assert.ok(src.includes("type: 'password'") || src.includes('type="password"'), name + ' 没有 password 输入');
		assert.ok(src.includes('hasAppSecret'), name + ' 没有配置状态');
		assert.ok(src.includes('saveApp'), name + ' 没有保存应用入口');
		assert.ok(/已配置（明文不回显）/.test(src), name + ' 没有「不回显」提示');
	}
});
check('⑪ 产物 bundle 已同步（改 TSX 不跑 build+sync 会红）', () =>
	assert.ok(/\\u98DE\\u4E66\\u5E94\\u7528|飞书应用/.test(BUNDLE), 'bundle 还是旧版'));
check('⑪b 常规保存不重复建 profile（只在填新 secret 或换 appId 时）', () =>
	assert.ok(/intent === 'set' \|\| appId !== prevAppId/.test(INDEX),
		'改 mappings/开关不该每次都跑一次 lark-cli profile add'));

// ── 端到端 HTTP：POST /api/kb-settings ──────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'kb-feishu-app-'));
const kbDir = join(tmp, 'knowledge-base');
mkdirSync(kbDir, { recursive: true });
const settingsFile = join(kbDir, '.kb-settings.json');
const credStore = new Map();
const fakeCredentials = {
	async resolve(ref) { return credStore.has(ref) ? { value: credStore.get(ref) } : undefined; },
	async describe(ref) { return { configured: credStore.has(ref) }; },
	async set(ref, value) { credStore.set(ref, value); },
	async unset(ref) { credStore.delete(ref); },
};
let handler;
const noop = () => () => {};
const foundation = FND.createFoundationService();
const ctx = new Proxy({}, {
	get(_t, key) {
		if (key === 'inject') {
			return (deps, cb) => {
				if (Array.isArray(deps) && deps.includes('webServer')) {
					cb({ effect: fn => { fn(); return noop(); }, connection: { requestRejection: () => undefined },
						webServer: { register: spec => { handler = spec.handler; return noop(); } } });
				} else if (Array.isArray(deps) && deps.includes('vssarosFoundation')) {
					cb({ vssarosFoundation: foundation });
				} else if (Array.isArray(deps) && deps.includes('credentials')) {
					cb({ credentials: fakeCredentials });
				}
				return noop();
			};
		}
		if (key === 'effect') { return fn => { try { const d = fn(); return typeof d === 'function' ? d : noop(); } catch { return noop(); } }; }
		if (key === 'get') { return n => (n === 'vssarosFoundation' ? foundation : null); }
		if (key === 'tools') { return { register: noop }; }
		if (key === 'on') { return noop; }
		return undefined;
	},
});

try {
	KB.apply(ctx, { dataRoot: tmp, hostHalf: true });
	const call = async (method, body) => {
		const out = [];
		const req = { method, url: '/x/kb/api/kb-settings' };
		if (method === 'POST') {
			const text = JSON.stringify(body);
			req[Symbol.asyncIterator] = async function* () { yield Buffer.from(text); };
		}
		await handler(req, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
		return { text: out.join(''), json: JSON.parse(out.join('') || '{}') };
	};

	const SECRET = 'SUPER_SECRET_2026_11_10';
	// cliPath 指向不存在的可执行名 ⇒ profile add 会快速失败，但设置与凭据仍应正确保存
	const posted = await call('POST', { feishu: { appId: 'cli_test01', appSecret: SECRET, cliPath: '__no_such_lark_cli__' } });
	check('⑫ POST 成功且 appId 已保存', () => {
		assert.equal(posted.json.ok, true);
		assert.equal(posted.json.settings?.feishu?.appId, 'cli_test01');
		assert.equal(posted.json.settings?.feishu?.hasAppSecret, true);
	});
	check('⑬ ★ secret 不进 .kb-settings.json / 不进 HTTP 响应', () => {
		assert.ok(existsSync(settingsFile), '设置文件没写');
		const disk = readFileSync(settingsFile, 'utf8');
		assert.ok(!disk.includes(SECRET), 'secret 明文落盘了 ✗');
		assert.ok(!disk.includes('appSecret'), '文件里还留着 appSecret 键 ✗');
		assert.ok(!posted.text.includes(SECRET), '响应里回显了 secret ✗');
		assert.ok(!posted.text.includes('appSecret'), '响应里带了 appSecret 字段 ✗');
	});
	check('⑭ ★ secret 只进凭据库（ref 按 appId）', () =>
		assert.equal(credStore.get(app.credentialRefForApp('cli_test01')), SECRET));

	const got = await call('GET');
	check('⑮ GET 只回 appId + hasAppSecret，不回明文', () => {
		assert.equal(got.json.settings?.feishu?.appId, 'cli_test01');
		assert.equal(got.json.settings?.feishu?.hasAppSecret, true);
		assert.ok(!got.text.includes(SECRET));
		assert.equal(got.json.settings?.feishu?.appSecret, undefined);
	});
	const cleared = await call('POST', { feishu: { appId: 'cli_test01', appSecret: null } });
	check('⑯ appSecret=null ⇒ 清凭据（同步断言，别写成 async 让 check 抓不到 ✗）', () => {
		assert.equal(cleared.json.ok, true);
		assert.equal(credStore.has(app.credentialRefForApp('cli_test01')), false);
	});
	const bad = await call('POST', { feishu: { appId: '../not-an-app' } });
	check('⑰ 非法 appId 被 400 拒绝（不让脏值进 profile 参数）', () =>
		assert.equal(bad.json.ok, false));
} catch (e) {
	fail++;
	console.log('FAIL  端到端 HTTP 夹具异常 — ' + String(e?.message ?? e));
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
