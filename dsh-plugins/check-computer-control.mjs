#!/usr/bin/env node
// check-computer-control.mjs — 电脑操控 P0 只读层的静态对账（2026-11-09）
//
// 为什么：策略有**两份副本** —— 主进程 TS（守中继）与 Host JS（守工具）。任何一侧漂移都会
// 出现「工具放行但中继拒绝」或更糟的「中继执行了工具以为被挡的动作」。另外 P0 的安全不变量
// 是「中继里根本没有输入注入代码」，这条不能只靠注释保证。
//
//   node dsh-plugins/check-computer-control.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGINS = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(PLUGINS);
const TS_POLICY = join(REPO, 'src/vs/sessions/contrib/dshHarness/common/desktopControlProtocol.ts');
const TS_RELAY = join(REPO, 'src/vs/sessions/contrib/dshHarness/electron-main/desktopControlRelay.ts');
const TS_INPUT = join(REPO, 'src/vs/sessions/contrib/dshHarness/electron-main/desktopInputService.ts');
const TS_PRESENCE = join(REPO, 'src/vs/sessions/contrib/dshHarness/electron-main/desktopControlPresence.ts');
const APP = join(REPO, 'src/vs/code/electron-main/app.ts');
const PLUGIN = join(PLUGINS, 'vssaros-computer');

const problems = [];
const check = (name, condition, detail = '') => {
	if (condition) console.log(`  ok   ${name}`);
	else { problems.push(`${name}${detail ? ` — ${detail}` : ''}`); console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const text = (file) => readFileSync(file, 'utf8');
const tsSet = (source, name) => {
	const match = source.match(new RegExp(`export const ${name}[^=]*= new Set\\(\\[([\\s\\S]*?)\\]\\)`));
	if (!match) throw new Error(`TS 里找不到 ${name}`);
	return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
};
const tsArray = (source, name) => {
	const match = source.match(new RegExp(`export const ${name}[^=]*= \\[([\\s\\S]*?)\\];`));
	if (!match) throw new Error(`TS 里找不到 ${name}`);
	return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

for (const file of [TS_POLICY, TS_RELAY, TS_INPUT, TS_PRESENCE, APP, join(PLUGIN, 'package.json'), join(PLUGIN, 'lib/index.js')]) {
	check(`必需文件存在：${relative(REPO, file).split(sep).join('/')}`, existsSync(file));
}
if (problems.length) { process.exit(1); }

const policy = text(TS_POLICY);
const relay = text(TS_RELAY);
const app = text(APP);
const levels = await import(pathToFileURL(join(PLUGIN, 'lib/core/levels.js')).href);
const relayJs = await import(pathToFileURL(join(PLUGIN, 'lib/core/relay.js')).href);
const indexJs = await import(pathToFileURL(join(PLUGIN, 'lib/index.js')).href);

const same = (label, a, b) => check(label, JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()),
	`TS=[${[...a].sort().join(',')}] JS=[${[...b].sort().join(',')}]`);

// ① 两份策略逐项对账
same('observe 方法集：TS 白名单 = JS op 集', tsSet(policy, 'DESKTOP_OBSERVE_METHODS'), levels.OBSERVE_OPS);
same('background 方法集一致', tsSet(policy, 'DESKTOP_BACKGROUND_METHODS'), levels.BACKGROUND_OPS);
same('foreground 方法集一致', tsSet(policy, 'DESKTOP_FOREGROUND_METHODS'), levels.FOREGROUND_OPS);
same('永久拒绝名单一致', tsSet(policy, 'DESKTOP_REFUSED_METHODS'), levels.REFUSED_OPS);
same('四档顺序一致', tsArray(policy, 'DESKTOP_LEVELS'), levels.LEVELS);
same('受保护应用名单一致', tsArray(policy, 'PROTECTED_APP_HINTS'), levels.PROTECTED_APP_HINTS);
same('工具 op enum = 只读白名单', levels.OBSERVE_OPS,
	indexJs.createToolDefinition({ relay: {}, state: levels.defaultState(), level: 'view' }).parameters.properties.op.enum);

// ② 发现文件契约
const tsFile = policy.match(/DESKTOP_CONTROL_FILE\s*=\s*'([^']+)'/)?.[1];
const tsPath = policy.match(/DESKTOP_CONTROL_PATH\s*=\s*'([^']+)'/)?.[1];
check('发现文件名两侧一致', tsFile === relayJs.ENDPOINT_FILE && tsFile === 'desktop-control.json', `${tsFile} / ${relayJs.ENDPOINT_FILE}`);
check('WS token 路径两侧一致', tsPath === relayJs.ENDPOINT_PATH && tsPath === '/desktop-control/vssaros/', `${tsPath} / ${relayJs.ENDPOINT_PATH}`);
check('wsUrl 正则只认 loopback + 48 位 token', /127\\\.0\\\.0\\\.1/.test(text(join(PLUGIN, 'lib/core/relay.js'))) && /\{48\}/.test(text(join(PLUGIN, 'lib/core/relay.js'))));
check('中继启动写 0600 发现文件', /mode:\s*0o600/.test(relay));

// ③ ★ 安全不变量：原生输入注入只在独立 service，且默认档下永不触发
const service = text(TS_INPUT);
const forbidden = ['nut-js', 'injectInput(', 'mouse.setPosition', 'keyboard.type', 'SendInput', 'robotjs', 'dispatchMouseEvent'];
const hits = forbidden.filter((word) => relay.includes(word));
check('★ 中继不直接调用任何原生输入 API（注入实现只在独立 service）', hits.length === 0, `命中：${hits.join(', ')}`);
check('★ 注入实现集中在 desktopInputService.ts', service.includes('@nut-tree/nut-js') && service.includes('injectDesktopInput'));
check('★ 默认最高档 = view（策略层常量）', /DESKTOP_DEFAULT_MAX_LEVEL: DesktopLevel = 'view'/.test(policy));
check("★ app.ts 显式声明 maxLevel: 'view'（开 P1 需两处同时改）", /maxLevel:\s*'view'/.test(app));
check('★ 中继逐请求按主进程最高档裁决，不接受 Host 传来的档位',
	/desktopControlRefusal\(request\.method,\s*this\._maxLevel/.test(relay) && !/params\.level|arguments\.level/.test(relay));
check('★ 输入分派前必过 refusal（_handle 中 refusal 早于 _dispatch）',
	relay.indexOf('desktopControlRefusal(request.method') > 0
	&& relay.indexOf('desktopControlRefusal(request.method') < relay.indexOf('await this._dispatch'));
check('★ P1 后台输入默认关闭（插件挂载行 + DEFAULTS 两处）',
	/allowBackground:\s*false/.test(text(join(PLUGIN, 'cordis.patch.yml'))) && indexJs.DEFAULTS.allowBackground === false);
check('★ 默认工具面仍只有 9 个只读 op',
	JSON.stringify(indexJs.createToolDefinition({ relay: {}, state: levels.defaultState(), level: 'view' })
		.parameters.properties.op.enum) === JSON.stringify(levels.OBSERVE_OPS));
check('中继确实提供只读能力（截图 / 屏幕 / 窗口）',
	relay.includes('desktopCapturer.getSources') && relay.includes('screen.getPrimaryDisplay') && relay.includes('BrowserWindow.getAllWindows'));

// ③b ★ P2：前台能力默认不开放，空闲门不可被 Host 绕过
const pluginIndex = text(join(PLUGIN, 'lib/index.js'));
const pluginYml = text(join(PLUGIN, 'cordis.patch.yml'));
const handoffSrc = text(join(PLUGIN, 'lib/core/handoff.js'));
check('★ P2 空闲门策略存在（3s 阈值；NaN/Infinity/无法读取一律拒）',
	/DESKTOP_USER_IDLE_THRESHOLD_SECONDS = 3/.test(policy)
	&& /!Number\.isFinite\(idleSeconds\)/.test(policy)
	&& /idleSeconds < threshold/.test(policy));
check('★ P2 前台方法逐请求过 OS 空闲门，且门在分派之前',
	relay.indexOf('isForegroundMethod(request.method)') > 0
	&& relay.indexOf('foregroundIdleRefusal') > 0
	&& relay.indexOf('foregroundIdleRefusal') < relay.indexOf('await this._dispatch'));
check('★ 主进程没有打开 foreground 档（app.ts 仍显式 view）',
	/maxLevel:\s*'view'/.test(app) && !/maxLevel:\s*'foreground'/.test(app));
check('★ P2 三个开关默认全关（挂载行 + DEFAULTS）',
	/allowForeground:\s*false/.test(pluginYml) && /allowHandoff:\s*false/.test(pluginYml)
	&& indexJs.DEFAULTS.allowForeground === false && indexJs.DEFAULTS.allowHandoff === false);
check('★ 控制 op 在闸之前分派（用户接管中仍能交还）',
	pluginIndex.indexOf('if (isControlOp(args?.op))') > 0
	&& pluginIndex.indexOf('if (isControlOp(args?.op))') < pluginIndex.indexOf('const gate = preGate(context)'));
check('★ 接管/交接状态机不记录用户输入',
	/不记录/.test(handoffSrc) && !/keylog|recordInput|inputLog/i.test(handoffSrc));

// ③c ★ P2 托盘 / 浮动指示器
const presenceSrc = text(TS_PRESENCE);
check('★ 指示器 setContentProtection(true) 防自己进入 Bot 截图',
	presenceSrc.includes('setContentProtection(true)'));
check('★ 指示器空闲时零 UI（active/stopped/handoff 全空才不创建窗口）',
	/status\.active \|\| status\.stopped \|\| status\.handoffState !== 'idle'/.test(presenceSrc));
check('★ 托盘停止 / 重新允许直达中继，不经 Host',
	app.includes('new DesktopControlPresence({')
	&& app.includes('onStop: () => desktopControlRelay.stop()')
	&& app.includes('onRearm: () => desktopControlRelay.rearm()'));
check('★ presence 方法在档位闸之前分派（紧急停止任何档位都可用）',
	relay.indexOf('isPresenceMethod(request.method)') > 0
	&& relay.indexOf('isPresenceMethod(request.method)') < relay.indexOf('desktopControlRefusal(request.method'));
check('★ 紧急停止后锁住动作类，只读仍可用',
	relay.includes('this._status.stopped && !DESKTOP_OBSERVE_METHODS.has'));
check('★ 状态上报只带展示元数据（白名单字段 + 长度夹紧）',
	relay.includes('raw.botId === \'string\' ? raw.botId.slice(0, 80)')
	&& /reportStatus/.test(relay));
check('★ Host presence 上报默认关闭（避免中继不可达时每动作多等超时）',
	/presenceEnabled:\s*false/.test(pluginYml) && indexJs.DEFAULTS.presenceEnabled === false);

// ④ 主进程接线
check('app.ts import 了 DesktopControlRelay', /import \{ DesktopControlRelay \}/.test(app));
check('app.ts 构造并启动中继', /new DesktopControlRelay\(\{/.test(app) && /desktopControlRelay\.start\(\)/.test(app));
check('app.ts 接线在右栏中继之后（同一 runDir）', app.indexOf('new DesktopControlRelay') > app.indexOf('new DshRightbarCdpRelay'));

// ⑤ 插件随包文件覆盖（干净检出不能缺件）
const pkg = JSON.parse(text(join(PLUGIN, 'package.json')));
const walk = (dir, base = dir, out = []) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, base, out);
		else if (/\.(js|mjs|yml)$/.test(entry.name)) out.push(relative(base, path).split(sep).join('/'));
	}
	return out;
};
const runtime = [
	...walk(join(PLUGIN, 'lib')).map((f) => `lib/${f}`),
	...readdirSync(PLUGIN).filter((f) => /\.ya?ml$/.test(f) && statSync(join(PLUGIN, f)).isFile()),
];
const listed = new Set(pkg.files);
const missing = runtime.filter((f) => !listed.has(f));
check(`files 白名单覆盖全部运行时文件（${runtime.length} 个）`, missing.length === 0, `没列：${missing.join(', ')}`);
check('插件默认关闭（fail-closed）', /enabled:\s*false/.test(text(join(PLUGIN, 'cordis.patch.yml'))) && indexJs.DEFAULTS.enabled === false);

if (problems.length) {
	console.error(`\n[check-computer-control] ✗ ${problems.length} 处：`);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}
console.log('\n[check-computer-control] ✓ 双份策略一致、注入隔离、默认只读 + P2 空闲门、接线与随包清单齐全');
