// TUI 运行时探测 —— "起格之前先把能不能起查清楚"。
//
// 为什么需要它（2026-10-22 实机发现的两件事）：
//  ① **PATH 里没有 `dsh`**（`where dsh` 空）⇒ 默认 `tuiCommand: 'dsh'` 起格必定失败，而且失败现场
//     只看到 "spawn dsh ENOENT"，很难查；
//  ② 社区 TUI `@tomowang/dsh-tui` 的 peer 是 **`^0.2.1-rc.2`**，而 dev Host 自己是 **rc.1**
//     ⇒ 用错 runtime 会在运行期出各种怪问题（不是明确的报错）。
// ⇒ 所以：**探测 → 排序 → 检查版本与 profile → 把结论摊在页面上**，不猜、不假装。
//
// ⚠ 口径：**不猜端口、不猜路径后就当真** —— 每个候选都要真的读到 package.json 版本才算数；
//   探测不到就说探测不到，并说清配哪里（config.tuiCommand / config.tuiHome）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 社区 TUI 要求的 dsh 最低版本（`@tomowang/dsh-tui@0.10.0` 的 peerDeps：`^0.2.1-rc.2`）。 */
export const TUI_MIN_DSH = '0.2.1-rc.2';

/**
 * 比版本"够不够"：只做**这个场景够用的**比较（主.次.补 + 预发布标签数字）。
 * ⚠ 不是通用 semver：只回答"x 是否 >= 下限"。故意保持简单可测。
 *
 * @param {string} have 实际版本（如 `0.2.1-rc.1`）。
 * @param {string} atLeast 下限（如 `0.2.1-rc.2`）。
 * @returns {boolean}
 */
export function versionAtLeast(have, atLeast) {
	const a = parse(have);
	const b = parse(atLeast);
	if (!a || !b) { return false; }
	for (let i = 0; i < 3; i += 1) {
		if (a.num[i] !== b.num[i]) { return a.num[i] > b.num[i]; }
	}
	// 主.次.补 相同 ⇒ 比预发布：没有预发布 = 正式版（更高）；都有则比标签，标签相同比数字
	if (!a.pre && !b.pre) { return true; }
	if (!a.pre) { return true; }
	if (!b.pre) { return false; }
	if (a.pre.tag !== b.pre.tag) { return a.pre.tag > b.pre.tag; }
	return a.pre.n >= b.pre.n;
}

function parse(v) {
	const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)\.?(\d+)?)?/);
	if (!m) { return null; }
	return {
		num: [Number(m[1]), Number(m[2]), Number(m[3])],
		pre: m[4] ? { tag: m[4], n: Number(m[5] || 0) } : null,
	};
}

/**
 * 扫一个 runtime 根：返回 `{ dir, version, binJs }`（读不到就 null）。
 * @param {string} dir 形如 `<root>/0.2.1-rc.2`。
 */
export function readRuntime(dir) {
	const pkgPath = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
	const binJs = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
	if (!existsSync(pkgPath)) { return null; }
	let version = '';
	try { version = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version || ''); } catch { return null; }
	return { dir, version, binJs: existsSync(binJs) ? binJs : null };
}

/**
 * 探测可用的 TUI 运行时。
 *
 * @param {object} options
 * @param {string} [options.configured] `config.tuiCommand`（非默认 `dsh` 时按用户说的用）。
 * @param {string} [options.dshHome] 格子进程的 DSH_HOME（用来查 `profiles/tui` 有没有装社区 TUI）。
 * @param {string[]} [options.roots] 额外的 runtime 根（默认含 `~/.vssaros-dev/dsh-runtime` 与 `DSH_RUNTIME_DIR`）。
 * @param {(p: string) => boolean} [options.exists] 注入（测试）。
 * @param {(p: string) => string[]} [options.list] 注入（测试）。
 * @returns {{ ok: boolean, command: string, args: string[], runtime: object|null, dshVersion: string,
 *             minDsh: string, satisfies: boolean, tuiProfile: object, problems: string[] }}
 */
export function resolveTuiRuntime(options) {
	const opt = options || {};
	const exists = typeof opt.exists === 'function' ? opt.exists : existsSync;
	const list = typeof opt.list === 'function' ? opt.list : (p) => readdirSync(p);
	const problems = [];
	const minDsh = TUI_MIN_DSH;
	// 起格时传给 dsh 的参数（默认 `--profile tui`；用户可覆盖，比如加 `--resume`）。
	const userArgs = Array.isArray(opt.args) && opt.args.length ? opt.args.map(String) : ['--profile', 'tui'];

	// ① 用户显式指定了命令 ⇒ 尊重它，只做"版本未知"的如实说明（不猜它是什么版本）。
	const configured = typeof opt.configured === 'string' ? opt.configured.trim() : '';
	if (configured && configured !== 'dsh') {
		return {
			ok: true, command: configured, args: userArgs.slice(), runtime: null, dshVersion: '',
			minDsh, satisfies: true, tuiProfile: inspectTuiProfile(opt.dshHome, exists), problems: [
				'使用了 config.tuiCommand 指定的命令：' + configured + '（版本未检查）',
			],
		};
	}

	// ② 扫候选 runtime 根，挑**版本最高且满足下限**的那个。
	const roots = Array.isArray(opt.roots) && opt.roots.length ? opt.roots : defaultRoots(opt.dshHome);
	const found = [];
	for (const root of roots) {
		let entries = [];
		try { entries = list(root); } catch { continue; }
		for (const name of entries) {
			const dir = join(root, name);
			try { if (!statSync(dir).isDirectory()) { continue; } } catch { continue; }
			const rt = readRuntime(dir);
			if (rt) { found.push(rt); }
		}
	}
	// 也允许根本身就是一个 runtime（形如 <root>/node_modules/@deepseek-ai/dsh）
	for (const root of roots) {
		const rt = readRuntime(root);
		if (rt) { found.push(rt); }
	}
	const uniq = [];
	const seen = new Set();
	for (const rt of found) {
		if (seen.has(rt.dir)) { continue; }
		seen.add(rt.dir);
		uniq.push(rt);
	}
	const usable = uniq.filter((rt) => rt.binJs).sort((a, b) => (versionAtLeast(a.version, b.version) ? -1 : 1));
	const good = usable.find((rt) => versionAtLeast(rt.version, minDsh));

	const tuiProfile = inspectTuiProfile(opt.dshHome, exists);

	if (!good) {
		if (!usable.length) {
			problems.push('没找到任何 dsh runtime（扫过：' + (roots.join('、') || '(空)') + '）⇒ 请设 config.tuiCommand 指到 dsh 0.2.1-rc.2');
		} else {
			problems.push('找到的 runtime 都低于 ' + minDsh + '：' + usable.map((r) => r.version).join('、')
				+ ' ⇒ 社区 TUI 的 peer 不满足，起格可能失败');
		}
		if (tuiProfile.state === 'missing') {
			problems.push('DSH_HOME 下没有 profiles/tui ⇒ 先在 TUI 那个 profile 里装社区 TUI（dsh plugin --profile tui add @tomowang/dsh-tui）');
		}
		return {
			ok: false, command: '', args: [], runtime: null,
			dshVersion: usable[0] ? usable[0].version : '', minDsh, satisfies: false, tuiProfile, problems,
		};
	}

	if (tuiProfile.state === 'missing') {
		problems.push('runtime 有了，但 DSH_HOME 下没有 profiles/tui ⇒ 先把社区 TUI 装进 tui profile');
	} else if (tuiProfile.state === 'no-tui') {
		problems.push('profiles/tui 存在，但没装 @tomowang/dsh-tui ⇒ 起格后会是普通 dsh 而不是 TUI');
	}

	return {
		ok: problems.length === 0 || tuiProfile.state === 'ready',
		// ⚠ 用 node 直接跑 bin.js（不依赖 .cmd / PATH）—— 更稳，也避免 shell 转义问题。
		command: process.execPath,
		args: [good.binJs, ...userArgs],
		runtime: { dir: good.dir, version: good.version },
		dshVersion: good.version,
		minDsh,
		satisfies: true,
		tuiProfile,
		problems,
	};
}

/** 默认 runtime 根：显式环境变量 → 我们的 dev 布局 → `~/.dsh/dsh-runtime`。 */
function defaultRoots(dshHome) {
	const roots = [];
	const push = (p) => { if (p) { roots.push(String(p).replace(/[\\/]+$/, '')); } };
	push(process.env.DSH_RUNTIME_DIR);
	push(process.env.VSSAROS_DSH_RUNTIME);
	const home = process.env.USERPROFILE || process.env.HOME || '';
	push(join(home, '.vssaros-dev', 'dsh-runtime'));
	if (dshHome) { push(join(dshHome, 'dsh-runtime')); }
	push(join(home, '.dsh', 'dsh-runtime'));
	return [...new Set(roots)];
}

/** 看 `profiles/tui` 在不在、里面有没有装社区 TUI。 */
function inspectTuiProfile(dshHome, exists) {
	if (!dshHome) { return { state: 'unknown', path: '', tuiVersion: '' }; }
	const profileDir = join(dshHome, 'profiles', 'tui');
	if (!exists(profileDir)) { return { state: 'missing', path: profileDir, tuiVersion: '' }; }
	const pkgPath = join(profileDir, 'node_modules', '@tomowang', 'dsh-tui', 'package.json');
	if (!exists(pkgPath)) { return { state: 'no-tui', path: profileDir, tuiVersion: '' }; }
	let v = '';
	try { v = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version || ''); } catch { /* 读不到就不报版本 */ }
	return { state: 'ready', path: profileDir, tuiVersion: v };
}
