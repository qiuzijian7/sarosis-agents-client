// @vssaros/dsh-ego 自检（进程内：不联网、不起 Host、不碰真 app）：
//   node dsh-plugins/vssaros-ego/test/run-ego-check.mjs
//
// 覆盖四件事：
//   ① 随包产物在（技能正文 + LICENSE + files 覆盖 —— 漏打包是最难发现的错）；
//   ② CLI 定位的四条路径都真的按顺序走（fake fs ⇒ 绝对期望值，不依赖本机是否装了 ego lite）；
//   ③ 脚本拼装/解析没有"被我们自己的模板吃掉"的痕迹（`${` 残留/标记行缺失是那类事故的指纹）；
//   ④ 工具面：4 个定义齐全、`ego_run` 在没有审批通道时**真的**被拒（fail-closed 不是口号）。
//
// ⚠ 口径：全部用**夹具**（fake exists / 固定字符串）⇒ 可以钉绝对期望值。
//   "本机装没装 ego lite" 不可控，别在这里断言真机行为。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, RUN_TOOL_NAME } from '../lib/index.js';
import {
	DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS,
	buildSpawnPlan, candidateDirs, clampTimeout, executableNames, pathDirs, resolveEgoCli,
} from '../lib/core/cli.js';
import {
	JSON_MARK, buildPrelude, buildProbeScript, buildSpacesScript,
	formatMissingCli, parseMarkedJson, truncateGuide,
} from '../lib/core/scripts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

// ── 1. 随包产物 ────────────────────────────────────────────────────────────
{
	const skillPath = join(root, 'skills', 'ego-browser', 'SKILL.md');
	check('1a. 随包技能存在', existsSync(skillPath), skillPath);
	if (existsSync(skillPath)) {
		const text = readFileSync(skillPath, 'utf8');
		check('1b. frontmatter 有 name: ego-browser', /^name:\s*ego-browser\s*$/m.test(text), text.slice(0, 60));
		check('1c. frontmatter 有 description', /^description:\s*\S/m.test(text), '');
		check('1d. 正文把 `ego-browser skill` 指为指南来源', text.includes('ego-browser skill'),
			'技能正文只是 bootstrap：API 指南必须来自已安装的 app');
	}
	check('1e. 上游 LICENSE 随包（MIT 原文）', existsSync(join(root, 'skills', 'ego-browser', 'LICENSE')), '');
	check('1f. 包级 LICENSE 在', existsSync(join(root, 'LICENSE')), '');

	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const files = pkg.files ?? [];
	check('1g. files 覆盖入口', files.includes('lib/index.js'), files.join(','));
	check('1h. files 覆盖两个 core 模块', files.includes('lib/core/cli.js') && files.includes('lib/core/scripts.js'), files.join(','));
	check('1i. files 覆盖 patch', files.includes('cordis.patch.yml'), files.join(','));
	check('1j. files 覆盖 skills', files.includes('skills'), files.join(','));
	check('1k. 不声明 dependencies（装出来不该缺模块）', pkg.dependencies === undefined, JSON.stringify(pkg.dependencies ?? null));
	check('1l. 故意不声明 vssaros.module（伴生插件路径）', pkg.vssaros === undefined, JSON.stringify(pkg.vssaros ?? null));

	const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
	check('1m. patch 插入了自己那一行', new RegExp(`name:\\s*'${pkg.name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}'`).test(patch), patch.trim().split(/\r?\n/).slice(-4).join(' | '));
}

// ── 2. CLI 定位（fake fs ⇒ 绝对期望值）────────────────────────────────────
{
	const winEnv = { LOCALAPPDATA: 'C:/Users/probe/AppData/Local', PROGRAMFILES: 'C:/Program Files', PATH: 'C:/win;C:/npm' };
	const names = executableNames('win32');
	check('2a. win32 候选名含 .cmd/.exe', names.includes('ego-browser.cmd') && names.includes('ego-browser.exe'), names.join(','));

	// ① config 最优先（即便 PATH 里也有）
	const resolvedConfig = resolveEgoCli({
		explicit: 'D:/custom/ego-browser.cmd', platform: 'win32', env: { ...winEnv, VSSAROS_EGO_CLI: 'D:/env/ego-browser.cmd' },
		home: 'C:/Users/probe', exists: p => p === 'D:/custom/ego-browser.cmd' || p === 'D:/env/ego-browser.cmd',
	});
	check('2b. config.cliPath 最优先', resolvedConfig.path === 'D:/custom/ego-browser.cmd' && resolvedConfig.source === 'config', JSON.stringify(resolvedConfig.path));

	// ② 其次环境变量
	const resolvedEnv = resolveEgoCli({
		explicit: undefined, platform: 'win32', env: { ...winEnv, VSSAROS_EGO_CLI: 'D:/env/ego-browser.cmd' },
		home: 'C:/Users/probe', exists: p => p === 'D:/env/ego-browser.cmd' || p === 'C:/win/ego-browser.cmd',
	});
	check('2c. VSSAROS_EGO_CLI 次之（压过 PATH）', resolvedEnv.path === 'D:/env/ego-browser.cmd' && resolvedEnv.source === 'env', JSON.stringify(resolvedEnv.path));

	// ③ PATH 命中（目录里第一个存在的候选名）
	//    ⚠ Windows 上 `join` 会把 `/` 归一成 `\` ⇒ 夹具的存在性判断必须同样归一，
	//    否则会出现"实现是对的、夹具说没命中"的假红（本仓在路径类夹具上栽过好几次）。
	const same = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
	const resolvedPath = resolveEgoCli({
		platform: 'win32', env: winEnv, home: 'C:/Users/probe', exists: p => same(p, 'C:/npm/ego-browser.cmd'),
	});
	check('2d. PATH 命中 .cmd 候选', same(resolvedPath.path, 'C:/npm/ego-browser.cmd') && resolvedPath.source === 'path', JSON.stringify(resolvedPath.path));

	// ④ PATH 里没有 ⇒ 落到"已知安装位置"（本插件存在的理由：Host 的 PATH 是陈旧的）
	const known = candidateDirs({ platform: 'win32', env: winEnv, home: 'C:/Users/probe' });
	check('2e. 已知位置包含用户级安装目录', known.includes('C:/Users/probe/AppData/Local/ego lite')
		|| known.some(d => d.replace(/\\/g, '/').endsWith('AppData/Local/ego lite')), known.slice(0, 4).join(' | '));
	const knownHit = known.map(d => join(d, 'ego-browser.cmd')).find(p => p.replace(/\\/g, '/').includes('/AppData/Local/ego lite/'));
	const resolvedKnown = resolveEgoCli({
		platform: 'win32', env: { ...winEnv, PATH: '' }, home: 'C:/Users/probe', exists: p => p.replace(/\\/g, '/') === knownHit?.replace(/\\/g, '/'),
	});
	check('2f. PATH 为空时仍能从已知位置找到', resolvedKnown.source === 'known' && !!resolvedKnown.path, JSON.stringify(resolvedKnown.path));

	// ⑤ 都没有 ⇒ undefined + 有"试过哪些"（不允许静默一句"没找到"）
	const resolvedNone = resolveEgoCli({ platform: 'win32', env: { ...winEnv, PATH: 'C:/none' }, home: 'C:/Users/probe', exists: () => false });
	check('2g. 全都没有时返回 undefined', resolvedNone.path === undefined, String(resolvedNone.path));
	check('2h. 失败时给出非空的"试过这些位置"', Array.isArray(resolvedNone.tried) && resolvedNone.tried.length >= 5, `${resolvedNone.tried.length} 条`);

	check('2i. pathDirs 去掉空项与引号', JSON.stringify(pathDirs('"C:/a b";;C:/c', 'win32')) === JSON.stringify(['C:/a b', 'C:/c']), pathDirs('"C:/a b";;C:/c', 'win32').join(' | '));
}

// ── 3. 执行计划（.cmd 垫片）与超时夹取 ────────────────────────────────────
{
	const shim = buildSpawnPlan({ cliPath: 'C:/Users/probe/AppData/Local/ego lite/ego-browser.cmd', args: ['nodejs'], platform: 'win32', comspec: 'cmd.exe' });
	check('3a. .cmd 走 cmd.exe', shim.command === 'cmd.exe' && shim.args[0] === '/d' && shim.args[1] === '/s' && shim.args[2] === '/c', shim.args.join(' '));
	check('3b. .cmd 用 windowsVerbatimArguments（引号由我们加）', shim.options.windowsVerbatimArguments === true, JSON.stringify(shim.options));
	const line = shim.args[3] ?? '';
	check('3c. 整条命令被最外层引号包住（/s 会剥掉那对）', line.startsWith('"') && line.endsWith('"'), line);
	check('3d. 带空格的路径也被引号包住', line.includes('"C:/Users/probe/AppData/Local/ego lite/ego-browser.cmd"'), line);

	const exe = buildSpawnPlan({ cliPath: 'C:/ego/ego-browser.exe', args: ['skill'], platform: 'win32', comspec: 'cmd.exe' });
	check('3e. .exe 直接 spawn（不经 cmd）', exe.command === 'C:/ego/ego-browser.exe' && exe.options.shim === false, exe.command);
	const posix = buildSpawnPlan({ cliPath: '/usr/local/bin/ego-browser', args: ['skill'], platform: 'darwin', comspec: 'cmd.exe' });
	check('3f. posix 直接 spawn', posix.command === '/usr/local/bin/ego-browser' && posix.args.join(' ') === 'skill', posix.command);

	check('3g. 超时缺省值', clampTimeout(undefined) === DEFAULT_TIMEOUT_MS, String(clampTimeout(undefined)));
	check('3h. 超时下限夹取', clampTimeout(1) === MIN_TIMEOUT_MS, String(clampTimeout(1)));
	check('3i. 超时上限夹取', clampTimeout(1e9) === MAX_TIMEOUT_MS, String(clampTimeout(1e9)));
	check('3j. 非数值回落到 fallback（且 fallback 也夹取）', clampTimeout(Number.NaN, 60_000) === 60_000, String(clampTimeout(Number.NaN, 60_000)));
}

// ── 4. 脚本拼装/解析（含"被模板吃掉"的指纹）──────────────────────────────
{
	const probe = buildProbeScript();
	const spaces = buildSpacesScript();
	check('4a. 探测脚本带标记行', probe.includes(JSON_MARK), '');
	check('4b. 清单脚本带标记行', spaces.includes(JSON_MARK), '');
	// `${` 出现在**喂给 app 的脚本**里 = 我们的模板串把人家代码插值掉了（本仓在别处踩过）
	check('4c. 探测脚本没有模板插值残留', !probe.includes('${'), probe.includes('${') ? probe.slice(probe.indexOf('${') - 40, probe.indexOf('${') + 40) : '');
	check('4d. 清单脚本没有模板插值残留', !spaces.includes('${'), '');
	check('4e. 探测脚本用 globalThis.ego 判存在（直接引用 ego 会 ReferenceError）', probe.includes('globalThis.ego'), '');

	const mixed = 'cli log line\n' + JSON_MARK + '{"ok":true}\ntrailing';
	check('4f. 能从混着日志的 stdout 里取出 JSON', JSON.stringify(parseMarkedJson(mixed)) === '{"ok":true}', JSON.stringify(parseMarkedJson(mixed)));
	check('4g. 没有标记时返回 undefined', parseMarkedJson('just log') === undefined, String(parseMarkedJson('just log')));
	check('4h. 坏 JSON 返回 undefined（不抛）', parseMarkedJson(JSON_MARK + '{oops') === undefined, String(parseMarkedJson(JSON_MARK + '{oops')));

	check('4i. 预选语句带 id', buildPrelude(7) === 'ego.useTaskSpace(7);', buildPrelude(7));
	check('4j. 不给 id 就没有预选', buildPrelude(undefined) === '', buildPrelude(undefined));

	const long = 'x'.repeat(200);
	const cut = truncateGuide(long, 100);
	check('4k. 指南截断时明说"被截断"', cut.truncated === true && cut.text.includes('被截断'), cut.text.slice(-40));
	check('4l. 未截断时原样返回', truncateGuide('short', 100).truncated === false, '');
	check('4m. 缺 CLI 的说明里列出试过位置', formatMissingCli({ platform: 'win32', tried: ['C:/a/ego-browser.cmd', 'C:/b/ego-browser.cmd'] }).includes('C:/b/ego-browser.cmd'), '');
}

// ── 5. 工具面 + fail-closed 审批（真跑 apply）─────────────────────────────
function fakeCtx({ approval } = {}) {
	const defs = [];
	const ctx = {
		effect: fn => { fn(); return () => { }; },
		inject: () => undefined,
		provide: () => undefined,
		get: name => (name === 'approval' ? approval : undefined),
		logger: { info: () => { }, warn: () => { } },
		tools: { register: def => { defs.push(def); return () => { }; } },
	};
	return { ctx, defs };
}

{
	const { ctx, defs } = fakeCtx();
	apply(ctx, {});
	const names = defs.map(d => d.name);
	check('5a. 注册了 4 个工具', defs.length === 4, names.join(','));
	check('5b. 工具名符合预期', JSON.stringify(names) === JSON.stringify(['ego_status', 'ego_guide', 'ego_spaces', RUN_TOOL_NAME]), names.join(','));
	check('5c. 工具名不重复', new Set(names).size === names.length, names.join(','));
	check('5d. 每个定义都有 output.schema 与 output.render', defs.every(d => d.output && typeof d.output.render === 'function' && d.output.schema && typeof d.output.schema === 'object'), '');
	check('5e. 每个定义都有 execute', defs.every(d => typeof d.execute === 'function'), '');
	check('5f. ego_run 不是并发安全（独占任务空间）', defs.find(d => d.name === RUN_TOOL_NAME)?.isConcurrencySafe === false, '');
	check('5g. ego_run 的 script 是必填参数', JSON.stringify(defs.find(d => d.name === RUN_TOOL_NAME)?.parameters?.required) === JSON.stringify(['script']), '');
}

{
	// 没有审批通道 ⇒ 必须拒（且**在碰 CLI 之前**拒：本机没装 ego lite 也不该变成"command not found"）
	const { ctx, defs } = fakeCtx({ approval: undefined });
	apply(ctx, {});
	const runDef = defs.find(d => d.name === RUN_TOOL_NAME);
	let message = '';
	try {
		await runDef.execute({ script: 'console.log(1)' }, {});
	} catch (error) {
		message = String(error?.message ?? error);
	}
	check('5h. 无审批通道 ⇒ ego_run fail-closed', message.includes('没有审批通道'), message.split(/\r?\n/)[0] ?? '（没有抛错 ✗）');
	check('5i. 拒绝文案给出两条接线办法', message.includes('allowRun') && message.includes('VSSAROS_EGO_ALLOW_RUN'), '');

	// 审批被拒（用户点拒绝）⇒ 不执行
	const denied = fakeCtx({ approval: { request: async () => 'denied' } });
	apply(denied.ctx, {});
	let deniedMessage = '';
	try {
		await denied.defs.find(d => d.name === RUN_TOOL_NAME).execute({ script: 'console.log(1)' }, {});
	} catch (error) {
		deniedMessage = String(error?.message ?? error);
	}
	check('5j. 用户拒绝 ⇒ 不执行', deniedMessage.includes('未获准'), deniedMessage.split(/\r?\n/)[0] ?? '（没有抛错 ✗）');

	// 参数校验在审批之前：非法 taskSpace 不该先弹一张审批卡
	let proposed = 0;
	const asked = fakeCtx({ approval: { request: async () => { proposed++; return 'allowed-once'; } } });
	apply(asked.ctx, {});
	let invalidMessage = '';
	try {
		await asked.defs.find(d => d.name === RUN_TOOL_NAME).execute({ script: 'x', taskSpace: '3' }, {});
	} catch (error) {
		invalidMessage = String(error?.message ?? error);
	}
	check('5k. 非法 taskSpace 在审批前被拒', invalidMessage.includes('正整数') && proposed === 0, `文案=${invalidMessage.split(/\r?\n/)[0]}，审批次数=${proposed}`);
}

// ── 6. 随包技能 provider（有 skills 服务时）───────────────────────────────
{
	const providers = [];
	const defs = [];
	const base = {
		effect: fn => { fn(); return () => { }; },
		provide: () => undefined,
		get: () => undefined,
		logger: { info: () => { }, warn: () => { } },
		tools: { register: def => { defs.push(def); return () => { }; } },
	};
	const ctx = {
		...base,
		// 模拟 cordis 的可选注入：依赖在 ⇒ 调 cb（真 ctx 同语义）
		inject: (deps, cb) => {
			const wanted = Array.isArray(deps) ? deps : [deps];
			if (wanted.includes('skills')) {
				cb({ ...base, skills: { registerProvider: fn => { providers.push(fn()); } } });
			}
			return { dispose: () => { } };
		},
	};
	apply(ctx, {});
	check('6a. 有 skills 服务时注册了 1 个 provider', providers.length === 1, String(providers.length));
	const provider = providers[0];
	const listed = await provider?.list?.();
	check('6b. list() 报出 ego-browser', Array.isArray(listed) && listed.length === 1 && listed[0].name === 'ego-browser', JSON.stringify(listed?.map?.(c => c.name)));
	check('6c. 技能按 bundled + rank 600（用户自己的同名技能优先）',
		listed?.[0]?.source === 'bundled' && listed?.[0]?.rank === 600, `${listed?.[0]?.source}/${listed?.[0]?.rank}`);
	const hit = await provider?.get?.(listed?.[0]);
	check('6d. get() 返正文且含 `ego-browser skill` 引导句', typeof hit?.content === 'string' && hit.content.includes('ego-browser skill'), `${hit?.content?.length ?? 0} 字符`);
	check('6e. get() 给了 resourceBase 目录（相对引用才能解析）', hit?.resourceBase?.kind === 'directory' && String(hit.resourceBase.path).includes('ego-browser'), JSON.stringify(hit?.resourceBase?.path));
	check('6f. get() 对不匹配的 locator 返回 undefined', (await provider?.get?.({ name: 'ego-browser', locator: 'D:/elsewhere/SKILL.md' })) === undefined, '');
	check('6g. 没有 skills 服务时工具照常注册（技能缺席不连累工具）', defs.length === 4, String(defs.length));
}

// ── 7. 「两个浏览器入口」必须**双向**互指（只提示、不改道）────────────────
{
	// 2026-10-21 拍板（方案 A）：装了 ego 之后模型看得见两套浏览器工具 —— 它们**登录态不共通**。
	// 只在一侧写提示 = 模型只知道"还能用另一个"，却不知道"换了之后登录态不跟着走" ⇒ 会撞登录墙。
	// 所以两侧描述必须互相点名（这里用源码包含判断，不钉整句：文案可以改，互指不能丢）。
	const { ctx, defs } = fakeCtx();
	apply(ctx, {});
	const runDescription = defs.find(d => d.name === RUN_TOOL_NAME)?.description ?? '';
	check('7a. ego_run 的描述点名 `browser`（指向"用用户当前 Chrome"）', runDescription.includes('browser'), runDescription.slice(0, 60));
	check('7b. ego_run 说清"登录态不共通"', runDescription.includes('登录态不共通') || runDescription.includes('另一个浏览器'), '');

	const browserEntry = resolve(root, '..', 'vssaros-browser', 'lib', 'index.js');
	if (existsSync(browserEntry)) {
		const browserSrc = readFileSync(browserEntry, 'utf8');
		check('7c. browser 工具描述反向点名 `ego_run`', browserSrc.includes('ego_run'), browserEntry);
	} else {
		// 兄弟插件不在（单包外发/裁剪构建）⇒ 如实跳过，别假装通过
		console.log('（跳过 7c：找不到同仓的 vssaros-browser）');
	}
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
	if (!r.ok) { console.log('✗ ' + r.name + (r.detail ? '  —— ' + r.detail : '')); }
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
	console.log(`${failed.length} 条失败`);
	process.exit(1);
}
