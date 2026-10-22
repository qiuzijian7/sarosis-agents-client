#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-dsh-tof-standalone.mjs — 守卫：dsh 侧**独立**的 TOF/OA 登录（不经 IDE）。
 *
 * 背景（2026-10-21，用户裁决"两侧用同一份 TOF/OA 企业身份"）：
 *   原先只有一条路 —— IDE 登录 → 票据经控制桥 `tof.sync` 同步到 dsh ⇒ **依附 IDE**。
 *   dsh 单独跑（没有 IDE / IDE 没开）时 Host 手里没有身份 ⇒ 商城 / 内网服务 / 内网 MCP 全用不了。
 *   ⇒ 补上"dsh 自己登"：vendored TOF 客户端（loopback → spawn 开浏览器 → whoami）＋ 票据落 `ctx.credentials`。
 *
 * 这条守卫**以行为断言为主**（真跑服务与工具，假凭据 + 假 whoami ⇒ 不联网、不开浏览器）：
 *   ① 采集面齐（tof.js 在、index.js 装了并注册了工具）；
 *   ② 三个工具名齐，且**官方契约**（output.schema + output.render）齐；
 *   ③ 本地票据 ref 与 IDE 同步那份**不同**（两份分开存 ⇒ 两条路不互相覆盖），且等于绝对期望值；
 *   ④ 有效票据优先级 = **本地自登 > IDE 同步**；
 *   ⑤ 没有票时如实说"未登录"；
 *   ⑥ **回执绝不含票据**（工具回执会进模型上下文与页面 ⇒ 等同"下发页面"✗）；
 *   ⑦ 登出默认只清本地那份；`all:true` 才连 IDE 同步那份一起清；
 *   ⑧ 开浏览器**不经 shell**（Windows 上 `cmd /c start` 会被 URL 里的 `&` 截断 ⇒ 回调永远不来）。
 *
 * 判据纪律（沿用本仓既有规矩）：绝对期望值而不是相对比较；采集面缺失直接失败；改完必须做**反向突变**。
 *
 * 用法：node dsh-plugins/check-dsh-tof-standalone.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const problems = [];
const ok = (label) => console.log(`  ✓ ${label}`);

/** 剥注释：块注释 + 行注释（行注释的 `//` 要求前一个字符不是引号/冒号/反斜杠 ⇒ URL 里的 `//` 不算注释）。 */
function code(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

function read(rel) {
	const full = join(repo, rel);
	if (!existsSync(full)) {
		problems.push(`文件不存在：${rel}（守卫的采集面失效 ⇒ 不能当通过）`);
		return '';
	}
	return readFileSync(full, 'utf8');
}

// ── 采集面（缺文件即失败）────────────────────────────────────────────────────
const tofRel = 'dsh-plugins/vssaros-bridge/lib/tof.js';
const indexRel = 'dsh-plugins/vssaros-bridge/lib/index.js';
const tofSrc = code(read(tofRel));
const indexSrc = code(read(indexRel));

if (!tofSrc || !indexSrc) {
	console.error('[check-dsh-tof-standalone] ✗ 采集面缺失（文件读不到）—— 不能当通过');
	process.exit(1);
}

const mod = await import(pathToFileURL(join(repo, tofRel)).href);

// ── 假凭据服务（Map 支撑，接口与 dsh 的 CredentialProvider 对齐）──────────────
function fakeCredentials(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		async resolve(ref) {
			const value = store.get(ref);
			return value === undefined ? undefined : { value, source: 'file' };
		},
		async describe(ref) {
			return { configured: store.has(ref), writable: true };
		},
		async set(ref, value) {
			store.set(ref, value);
		},
		async unset(ref) {
			store.delete(ref);
		},
	};
}

const TICKET_LOCAL = 'TICKET-LOCAL-0123456789';
const TICKET_IDE = 'TICKET-IDE-9876543210';
const IDE_REF = 'VSSAROS_TOF_TICKET';

const fakeUser = {
	user_id: 'taihu:staffid:10001',
	staff_id: '10001',
	login_name: 'tester',
	team: '某团队',
	is_admin: false,
	expires_at: '2030-01-01T00:00:00Z',
};
const fakeWhoami = async () => fakeUser;

/** 深扫一个值：收集所有键名与所有字符串值（用来判定"有没有票据漏出去"）。 */
function collect(value, keys = [], strings = []) {
	if (value === null || value === undefined) { return { keys, strings }; }
	if (typeof value === 'string') { strings.push(value); return { keys, strings }; }
	if (typeof value !== 'object') { return { keys, strings }; }
	if (Array.isArray(value)) {
		for (const item of value) { collect(item, keys, strings); }
		return { keys, strings };
	}
	for (const [k, v] of Object.entries(value)) {
		keys.push(String(k));
		collect(v, keys, strings);
	}
	return { keys, strings };
}

// ── ① 采集面齐 ──────────────────────────────────────────────────────────────
{
	if (!/from '\.\/tof\.js'/.test(indexSrc)) {
		problems.push("index.js 没有 import './tof.js'（dsh 侧独立登录根本没接上 ✗）");
	} else if (!/createTofService\(/.test(indexSrc) || !/tofToolDefinitions\(/.test(indexSrc)) {
		problems.push('index.js 没有建 tof 服务 / 没有取工具定义（工具注册链断了一节 ✗）');
	} else if (!/ctx\.tools\.register\(/.test(indexSrc)) {
		problems.push('index.js 没有 ctx.tools.register（工具不会出现在模型可见清单里 ✗）');
	} else {
		ok('① index.js 接上了 dsh 侧独立登录（服务 + 工具注册）');
	}
	// ⚠ 登录能力必须在"没有 IDE 管道"时也可用 ⇒ 注册点必须**早于** pipe/token 的早退。
	// ⚠ 判据用 `ctx.provide('vssarosTof'` 这个**注册点**做锚 —— 不能用 `createTofService(`：
	//   那是 import 语句里的名字，位置永远在最前面 ⇒ 相对比较恒真（假绿 ✗，反向突变实测过）。
	const provideAt = indexSrc.indexOf("ctx.provide('vssarosTof'");
	const earlyReturnAt = indexSrc.indexOf('if (!pipe || !token)');
	if (provideAt < 0 || earlyReturnAt < 0 || provideAt > earlyReturnAt) {
		problems.push('index.js：tof 注册点在 pipe/token 早退**之后** ⇒ dsh 独立跑（没有 IDE）时登录能力整个消失 ✗');
	} else {
		ok('① 登录能力注册在管道早退之前（dsh 独立跑也可用）');
	}
}

// ── ② 工具齐 + 官方契约齐 ──────────────────────────────────────────────────
{
	const service = mod.createTofService({
		credentials: fakeCredentials(),
		ideCredentialRef: IDE_REF,
		whoami: fakeWhoami,
	});
	const defs = mod.tofToolDefinitions(service);
	const names = defs.map(d => d?.name).sort();
	const want = ['tof_signin', 'tof_signout', 'tof_status'];
	if (JSON.stringify(names) !== JSON.stringify(want)) {
		problems.push(`工具名不齐：实际 ${JSON.stringify(names)}（应为 ${JSON.stringify(want)}）✗`);
	} else {
		ok('② 三个工具齐（signin / status / signout）');
	}
	for (const d of defs) {
		if (!d || typeof d.output !== 'object' || typeof d.output.render !== 'function' || typeof d.output.schema !== 'object') {
			problems.push(`工具 ${d?.name} 缺 output { schema, render }（官方契约：注册期就拒 ⇒ preset invalid ⇒ 连新建会话都不行 ✗）`);
		}
	}
	if (!problems.some(p => p.includes('output { schema, render }'))) {
		ok('② 工具的 output { schema, render } 齐');
	}
}

// ── ③ 两份票据分开存（ref 不同 + 绝对期望值）────────────────────────────────
{
	const localRef = mod.TOF_LOCAL_CREDENTIAL_REF;
	if (!localRef) {
		problems.push('tof.js 没有导出本地票据的凭据 ref ✗');
	} else if (localRef === IDE_REF) {
		problems.push(`本地票据与 IDE 同步那份用了同一个 ref（${localRef}）⇒ 两条路互相覆盖 ✗`);
	} else if (localRef !== 'VSSAROS_TOF_TICKET_DSH') {
		problems.push(`本地票据 ref 的绝对期望值是 'VSSAROS_TOF_TICKET_DSH'（实际 '${localRef}'）✗`);
	} else {
		ok('③ 本地票据 ref 与 IDE 那份分开，且等于绝对期望值');
	}
}

// ── ④⑤ 有效票据优先级 + 无票如实说 ─────────────────────────────────────────
{
	const service = mod.createTofService({
		credentials: fakeCredentials({ [mod.TOF_LOCAL_CREDENTIAL_REF]: TICKET_LOCAL, [IDE_REF]: TICKET_IDE }),
		ideCredentialRef: IDE_REF,
		whoami: fakeWhoami,
	});
	const st = await service.status();
	if (st?.source !== 'dsh') {
		problems.push(`有效票据优先级不是"本地自登 > IDE 同步"（source=${st?.source}）✗`);
	} else {
		ok('④ 有效票据取本地自登那份');
	}
	const empty = mod.createTofService({
		credentials: fakeCredentials(),
		ideCredentialRef: IDE_REF,
		whoami: fakeWhoami,
	});
	const st2 = await empty.status();
	if (st2?.signedIn !== false) {
		problems.push(`没有票据时 status() 没说未登录（signedIn=${st2?.signedIn}）✗`);
	} else {
		ok('⑤ 没票据时如实说未登录');
	}
}

// ── ⑥ 回执绝不含票据 ───────────────────────────────────────────────────────
{
	const credentials = fakeCredentials({ [mod.TOF_LOCAL_CREDENTIAL_REF]: TICKET_LOCAL });
	const service = mod.createTofService({ credentials, ideCredentialRef: IDE_REF, whoami: fakeWhoami });
	const st = await service.status();
	const defs = mod.tofToolDefinitions(service);
	const toolOut = await defs.find(d => d.name === 'tof_status').execute({});
	const leaks = [];
	for (const [label, value] of [['status()', st], ['tof_status 回执', toolOut]]) {
		const { keys, strings } = collect(value);
		for (const k of keys) {
			if (/ticket|identity|secret|token|passport/i.test(k)) {
				leaks.push(`${label} 的键名 '${k}'`);
			}
		}
		for (const s of strings) {
			if (s === TICKET_LOCAL || s === TICKET_IDE) {
				leaks.push(`${label} 的值里出现了票据本身`);
			}
		}
	}
	if (leaks.length) {
		problems.push(`回执里漏了票据：${leaks.join('；')}（票据绝不能进模型上下文/页面 ✗）`);
	} else {
		ok('⑥ status / 工具回执里都没有票据');
	}
}

// ── ⑦ 登出的两种语义 ───────────────────────────────────────────────────────
{
	const credentials = fakeCredentials({ [mod.TOF_LOCAL_CREDENTIAL_REF]: TICKET_LOCAL, [IDE_REF]: TICKET_IDE });
	const service = mod.createTofService({ credentials, ideCredentialRef: IDE_REF, whoami: fakeWhoami });
	const out = await service.signOut({});
	if (credentials.store.has(mod.TOF_LOCAL_CREDENTIAL_REF)) {
		problems.push('signOut() 没清掉本地那份票据 ✗');
	} else if (!credentials.store.has(IDE_REF)) {
		problems.push('signOut() 默认把 IDE 同步那份也清了（应当只清本地；IDE 仍登录着 ⇒ 它会再同步回来）✗');
	} else if (out?.ideStillSynced !== true) {
		problems.push('signOut() 没如实报告"IDE 那份还在"（ideStillSynced）✗');
	} else {
		ok('⑦ 默认只清本地那份，并如实报告 IDE 仍持有');
	}
	const credentials2 = fakeCredentials({ [mod.TOF_LOCAL_CREDENTIAL_REF]: TICKET_LOCAL, [IDE_REF]: TICKET_IDE });
	const service2 = mod.createTofService({ credentials: credentials2, ideCredentialRef: IDE_REF, whoami: fakeWhoami });
	await service2.signOut({ all: true });
	if (credentials2.store.has(IDE_REF) || credentials2.store.has(mod.TOF_LOCAL_CREDENTIAL_REF)) {
		problems.push('signOut({all:true}) 没把两份都清掉 ✗');
	} else {
		ok('⑦ all:true 两份都清');
	}
}

// ── ⑧ 开浏览器不经 shell（`cmd /c start` 会被 URL 里的 & 截断）───────────────
{
	const winBranch = tofSrc.match(/process\.platform === 'win32'\s*\?[\s\S]{0,400}/);
	if (!winBranch) {
		problems.push('tof.js 里找不到 Windows 的开浏览器分支 ✗');
	} else {
		const branch = winBranch[0];
		if (!/rundll32/.test(branch)) {
			problems.push("Windows 的开浏览器分支不是 rundll32（`cmd /c start` 会被 URL 里的 `&` 截断 ⇒ 回调永远不来 ✗）");
		} else if (!/explorer\.exe/.test(branch)) {
			problems.push('Windows 分支没有 explorer.exe 兜底（rundll32 不可用时就没有第二条路 ✗）');
		} else {
			ok('⑧ Windows 开浏览器走 rundll32（+ explorer 兜底），不经 shell');
		}
	}
	if (/\/c['"]\s*,\s*['"]start/.test(tofSrc) || /cmd\.exe/.test(tofSrc)) {
		problems.push("tof.js 里出现了 cmd.exe / `start`（Windows shell 会把 URL 里的 `&` 当命令分隔符 ✗）");
	} else {
		ok('⑧ 代码里没有 cmd.exe / start 这条路');
	}
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
if (problems.length > 0) {
	console.error(`[check-dsh-tof-standalone] ✗ 发现 ${problems.length} 处问题：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
console.log('[check-dsh-tof-standalone] ✓ dsh 侧独立登录（TOF/OA）链路齐 + 票据没有外泄');
