/*
 * 2026-11-10：知识库设置页可指定飞书应用（appId / appSecret）的守卫。
 *
 * 为什么必须有它：产品不再随包内置飞书应用，用户必须能指定自己的应用；换应用要走
 *   lark-cli 的 `profile add --app-secret-stdin` + 每条命令 `--profile <appId>`
 *   （照 vssaros-superagent/lib/environment-YhSAne6L.js:284-305、:1252-1256）。
 * 安全红线：appSecret 不进 argv / 不进 .kb-settings.json / 不进日志 / 不回显，
 *   只进 ctx.credentials 与 lark-cli 的 stdin。
 *
 * 除了纯函数与静态接线，还跑一次**真实 HTTP POST**（fake Host）验证红线没被绕过。
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-feishu-app.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const HERE = new URL('.', import.meta.url);
const app = await import(new URL('../lib/core/kbFeishuApp.js', HERE).href);
// ★ 2026-11-11：下拉纯逻辑（与 bot 设置页同款掩码列表）
const appsCore = await import(new URL('../lib/core/kbFeishuApps.js', HERE).href);
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

// ── 下拉纯逻辑（与 bot 页 appOptions 同款） ─────────────────────────────────
check('⑤b agents 凭据池读取：默认应用 / 额外应用 / 都不回给前端', () => {
	const accounts = { feishu: { appId: 'cli_default', appSecret: 'DEF_SECRET' },
		feishuApps: { cli_extra: { name: '测试应用', appSecret: 'EXTRA_SECRET' } } };
	assert.equal(appsCore.agentsSecretOf(accounts, 'cli_default'), 'DEF_SECRET');
	assert.equal(appsCore.agentsSecretOf(accounts, 'cli_extra'), 'EXTRA_SECRET');
	assert.equal(appsCore.agentsSecretOf(accounts, 'cli_missing'), '');
});
check('⑤c 掩码列表：默认在前 / hasSecret 而非明文 / KB 侧新建应用合并去重', () => {
	const list = appsCore.buildFeishuAppList({
		accounts: { feishu: { appId: 'cli_default', appSecret: 'DEF_SECRET' },
			feishuApps: { cli_extra: { name: '测试应用', appSecret: 'EXTRA_SECRET' } } },
		customApps: [{ appId: 'cli_kb', name: 'KB 专属' }, { appId: 'cli_extra', name: '重复' }],
		kbSecretIds: new Set(['cli_kb']),
	});
	assert.equal(list[0].appId, 'cli_default');
	assert.equal(list[0].isDefault, true);
	assert.equal(list.find(x => x.appId === 'cli_extra')?.name, '测试应用');
	assert.equal(list.find(x => x.appId === 'cli_kb')?.hasSecret, true);
	assert.equal(list.filter(x => x.appId === 'cli_extra').length, 1, '没去重');
	assert.ok(!JSON.stringify(list).includes('DEF_SECRET') && !JSON.stringify(list).includes('EXTRA_SECRET'),
		'掩码列表里漏了 secret 明文 ✗');
});
check('⑤d appOptions：首项 默认应用 / 缺 secret 禁用 / 末尾「+ 添加新应用」', () => {
	const opts = appsCore.buildAppOptions([
		{ appId: 'cli_default', isDefault: true, hasSecret: true },
		{ appId: 'cli_extra', name: '测试应用', hasSecret: true },
		{ appId: 'cli_nosecret', hasSecret: false },
	]);
	assert.deepEqual(opts[0], { value: '', label: '默认应用' });
	assert.equal(opts[1].label, '测试应用 · cli_extra');
	assert.equal(opts[2].disabled, true);
	assert.ok(opts[2].label.includes('（缺 App Secret）'));
	assert.equal(opts.length, 4);
	assert.equal(opts.at(-1).value, '__new__', '下拉里少了「+ 添加新应用」入口');
	assert.ok(opts.at(-1).label.includes('+ 添加新应用'));
	assert.equal(opts.some(o => o.value === 'cli_default'), false, 'isDefault 不该重复列（首项已代表）');
});

check('⑤e ★ profile list 能认出已存在的 profile（真机 cli_aa8b38921fa35bb4）', () => {
	const real = JSON.stringify([
		{ name: 'cli_aa8b38921fa35bb4', appId: 'cli_aa8b38921fa35bb4', brand: 'feishu', active: true, effective: true },
		{ name: 'cli_inactive', appId: 'cli_inactive', brand: 'feishu', active: false },
	]);
	assert.equal(app.hasLarkProfile(real, 'cli_aa8b38921fa35bb4'), true);
	assert.equal(app.hasLarkProfile(real, 'cli_missing'), false);
	// 混日志行 / 通知块也不能误判（不依赖严格 JSON）
	assert.equal(app.hasLarkProfile('log line\n' + real + '\n', 'cli_aa8b38921fa35bb4'), true);
	assert.equal(app.hasLarkProfile('', 'cli_aa8b38921fa35bb4'), false);
	assert.deepEqual(app.PROFILE_LIST_ARGS, ['profile', 'list']);
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
check('⑦b ★ 建 profile 前先 list；关掉升级通知；失败给真实错误而非尾部噪声', () => {
	assert.ok(/PROFILE_LIST_ARGS/.test(INDEX) && /hasLarkProfile\(/.test(INDEX),
		'没先查已有 profile ⇒ 重复 add 会失败并误报');
	assert.ok(/LARKSUITE_CLI_NO_UPDATE_NOTIFIER/.test(INDEX)
		&& /LARKSUITE_CLI_NO_SKILLS_NOTIFIER/.test(INDEX),
		'没关掉 _notice 升级通知（真机：它把真正的错误整段挤走）');
	assert.ok(/describeLarkCliFailure\(/.test(INDEX) && INDEX.includes("'建立应用 profile'"),
		'profile add 失败没走解析器');
	// 只抓**方法调用**，不抓注释里提到这个写法（源码注释曾因此误伤 ✗）
	assert.ok(!/\.slice\(-200\)/.test(INDEX), '还在截输出尾部（只会截到升级提示）');
	assert.ok(!/但命令可能仍用旧应用/.test(INDEX), '还在无条件误报「可能仍用旧应用」');
	assert.ok(/已存在，直接沿用/.test(INDEX), '已存在的 profile 应明确告知沿用');
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
check('⑩ ★ App Secret 输入框**只在**「+ 添加新应用」分支出现（常态不显示）', () => {
	for (const [name, src] of [['TSX', TSX], ['client.js', CLIENT]]) {
		// 密码框要有（新增应用得填），但必须挂在 __new__ 的就地表单里 ⇒ 常态看不到
		assert.ok(src.includes("appIdDraft === '__new__'"), name + ' 没有 __new__ 就地表单');
		assert.ok(src.includes('type="password"') || src.includes("type: 'password'"),
			name + ' 新增应用缺 App Secret 输入框');
		assert.ok(!src.includes('showAppSecret'), name + ' 又出现了常态显示的密钥框（showAppSecret 复活）');
		assert.ok(!src.includes('已配置（明文不回显）· 留空 = 不改'), name + ' 旧常驻 placeholder 复活');
		// 新增应用必须提交 secret + newApp，保存后清空草稿，并刷新下拉
		assert.ok(src.includes('patch.appSecret') || src.includes('f.appSecret'), name + ' 没提交 appSecret');
		assert.ok(src.includes('newApp'), name + ' 没提交 newApp 登记');
		assert.ok(src.includes('setNewAppSecret'), name + ' 保存后没清空 secret 草稿');
		assert.ok(src.includes('void loadApps()'), name + ' 新增后没刷新下拉');
		assert.ok(src.includes('hasAppSecret'), name + ' 没有只读配置状态');
		assert.ok(src.includes('saveApp'), name + ' 没有保存应用入口');
	}
});
check('⑩b ★ 两份前端都用下拉框，选项/样式与 bot 设置页一致，含「+ 添加新应用」入口', () => {
	for (const [name, src] of [['TSX', TSX], ['client.js', CLIENT]]) {
		assert.ok(/data-vssaros-kb-app-select/.test(src), name + ' 没有下拉锚点');
		assert.ok(/<select|h\('select'/.test(src), name + ' 不是 select');
		assert.ok(/appOptions/.test(src), name + ' 没有 bot 页同款选项');
		// 只抓**代码里的字面值**，不抓注释里提到这个词（入口 stamp 注释曾因此误伤 ✗）
		assert.ok(/['"]__new__['"]/.test(src), name + ' 下拉里缺「+ 添加新应用」选项');
		assert.ok(/\+ 添加新应用/.test(src), name + ' 缺新增应用文案');
		assert.ok(/默认应用/.test(src), name + ' 首项文案不一致');
		assert.ok(/（缺 App Secret）/.test(src), name + ' 缺 secret 的项没标注');
		assert.ok(/--dsw-alias-border-l2/.test(src) && /--dsw-alias-bg-layer-1/.test(src),
			name + ' 样式没用 bot 页的 --dsw-alias 令牌');
		assert.ok(/feishu-apps/.test(src), name + ' 没接掩码下拉数据源');
	}
});
check('⑩c ★ 后端有掩码端点 + 选已有应用时自动镜像 agents 凭据', () => {
	assert.ok(/\/api\/feishu-apps/.test(INDEX), '缺 KB 侧下拉数据源端点');
	assert.ok(/buildFeishuAppList\(/.test(INDEX));
	assert.ok(/agentsAppSecretOf\(config, appId\)/.test(INDEX),
		'没把 agents 池的 secret 同步进 KB 凭据库 ⇒ 选了应用却建不出 profile');
	assert.ok(/customApps/.test(INDEX), '新增应用没登记进下拉清单');
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
// ★ bot 设置页那批应用的凭据池（真机是 <dataRoot>/agent-im-accounts.json）
writeFileSync(join(tmp, 'agent-im-accounts.json'), JSON.stringify({
	accounts: {
		feishu: { appId: 'cli_default', appSecret: 'DEF_SECRET_FROM_AGENTS' },
		feishuApps: { cli_pick: { name: '可选用应用', appSecret: 'PICK_SECRET_FROM_AGENTS' } },
	},
}), 'utf8');
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
	const call = async (method, body, path = '/x/kb/api/kb-settings') => {
		const out = [];
		const req = { method, url: path };
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

	const appsResp = await call('GET', undefined, '/x/kb/api/feishu-apps');
	check('⑱ ★ feishu-apps 下拉数据：与 bot 页同形状掩码，不回明文', () => {
		assert.equal(appsResp.json.ok, true);
		const list = appsResp.json.apps || [];
		assert.ok(list.some((a) => a.appId === 'cli_pick' && a.hasSecret === true && a.name === '可选用应用'));
		assert.ok(list.some((a) => a.appId === 'cli_default' && a.isDefault === true));
		assert.ok(!appsResp.text.includes('PICK_SECRET_FROM_AGENTS'));
		assert.ok(!appsResp.text.includes('DEF_SECRET_FROM_AGENTS'));
		assert.ok(!appsResp.text.includes('appSecret'), '响应里带了 secret 键 ✗');
	});
	const picked = await call('POST', { feishu: { appId: 'cli_pick', cliPath: '__no_such_lark_cli__' } });
	check('⑲ ★ 下拉选已有应用 ⇒ 自动把 agents secret 镜像进 KB 凭据库', () => {
		assert.equal(picked.json.ok, true);
		assert.equal(credStore.get(app.credentialRefForApp('cli_pick')), 'PICK_SECRET_FROM_AGENTS');
		assert.ok(!picked.text.includes('PICK_SECRET_FROM_AGENTS'), '响应回显了 secret ✗');
		assert.equal(picked.json.settings?.feishu?.hasAppSecret, true);
	});
	const added = await call('POST', { feishu: {
		appId: 'cli_kbnew', appSecret: 'KB_SECRET_2026', newApp: { appId: 'cli_kbnew', name: 'KB 新建' },
		cliPath: '__no_such_lark_cli__',
	} });
	// ★ 下拉里的「+ 添加新应用」会发 newApp：后端登记 customApps（非机密）并继续守住
	//   「secret 不落盘」红线；端到端夹具直接走 POST，与前端路径同形。
	check('⑳ ★ 新增应用登记进 customApps（非机密），secret 仍不落盘', () => {
		assert.equal(added.json.ok, true);
		assert.ok((added.json.settings?.feishu?.customApps || [])
			.some((a) => a.appId === 'cli_kbnew' && a.name === 'KB 新建'));
		const disk = readFileSync(settingsFile, 'utf8');
		assert.ok(!disk.includes('KB_SECRET_2026') && !disk.includes('newApp'), 'secret / newApp 落盘了 ✗');
	});
	const appsAfter = await call('GET', undefined, '/x/kb/api/feishu-apps');
	check('⑳b ★ 新增应用保存后刷新下拉即可选中（hasSecret 掩码，仍不回明文）', () => {
		assert.equal(appsAfter.json.ok, true);
		const hit = (appsAfter.json.apps || []).find(a => a.appId === 'cli_kbnew');
		assert.ok(hit, '新应用没出现在下拉数据里 ⇒ 保存成功但选不到 ✗');
		assert.equal(hit.hasSecret, true, '缺 secret 会被前端 disabled');
		assert.ok(!appsAfter.text.includes('KB_SECRET_2026'), '下拉数据漏了 secret 明文 ✗');
	});
	check('㉑ ★ profile 失败提示不含升级通知噪声，且给出真实原因', () => {
		// fake Host 里 cliPath 指向不存在的可执行 ⇒ 两次 CLI 都失败，但提示必须可读
		const t = String(posted.json.note || '');
		assert.ok(!t.includes('_notice') && !t.includes('"update"') && !t.includes('available, current'),
			'note 里混进了 _notice 升级提示 ✗');
		assert.ok(t.includes('退出码') && t.includes('建立应用 profile'), 'note 没给出真实失败原因 ✗');
	});
} catch (e) {
	fail++;
	console.log('FAIL  端到端 HTTP 夹具异常 — ' + String(e?.message ?? e));
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

try {
	const source = INDEX.match(/function runLarkCli\([\s\S]*?\n\}/)?.[0];
	assert.ok(source, '找不到真实 CLI runner');
	for (const killThrows of [false, true]) {
		const child = new EventEmitter();
		child.stdin = { end() {} };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => { if (killThrows) { throw new Error('kill failed'); } return true; };
		const runner = new Function('spawn', 'process', 'profileArgsOf', 'KB_FEISHU_APP_ID', 'return ' + source)(
			() => child, { platform: 'linux', env: {} }, () => [], '');
		let deadline;
		try {
			const result = await Promise.race([
				runner('fake-cli', [], 20),
				new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('CLI runner 永久等待 close')), 1000); }),
			]);
			check('CLI 超时直接返回失败，即使没有 close 事件' + (killThrows ? '且 kill 抛错' : ''), () => {
				assert.equal(result.code, -1);
				assert.equal(result.timedOut, true);
				assert.ok(result.stderr.includes('[超时]'));
			});
		} finally { clearTimeout(deadline); }
	}
} catch (e) {
	fail++;
	console.log('FAIL  CLI 超时回归 — ' + String(e?.message ?? e));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
