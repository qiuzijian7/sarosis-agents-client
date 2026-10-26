/**
 * 读**当前宿主（dsh）的版本** + 与插件 `peerDependencies` 做兼容性提示
 * （★ 2026-10-26，`doc/marketplace-workbench-github-flow.html` §10 最后一条）。
 *
 * ## 为什么需要
 * 商城**不校验** peerDependencies。插件要求 `@deepseek-ai/cordis ^4.0.2`、
 * `dsh-llm ^0.1.5-rc.3 || ^0.2.0-rc.1` 这类范围；宿主版本不匹配时
 * **安装会成功、加载才报错** ⇒ 用户以为"装了没用"。
 *
 * ## ⚠ 这一步只做**提示**，绝不阻断
 * 三个理由：
 * ① 判断依赖 semver 语义（预发布版 `-rc.1` 的排序很容易判错）
 * ② 宿主的真实版本**未必读得到**（pnpm 隔离 ⇒ 插件目录 resolve 不到 `@deepseek-ai/dsh`）
 * ③ 版本匹配也不保证能跑（插件自身 bug、原生依赖等）
 * ⇒ 拿不到版本就 `checked: false` **如实说"无法校验"**，不假装兼容。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 只校验这几个"宿主自身"的包（其余的 peer 是业务依赖，不判）。 */
const HOST_PEERS = ['@deepseek-ai/dsh', '@deepseek-ai/cordis'];

let cached = null;

/**
 * 当前 dsh 版本。
 *
 * 三条路（按可靠性）：
 * ① `process.argv[1]` —— Host 是 `node <dsh>/lib/bin.js --profile …` 起的，上溯能到 `package.json`
 * ② `createRequire(import.meta.url).resolve('@deepseek-ai/dsh')` —— pnpm 真装了 peer 才有
 * ③ 读 `~/.vssaros-dev/dsh-runtime/` 的目录名（最后手段，可能是多版本共存 ⇒ 取最新）
 *
 * @returns {{ version: string, source: string }} 读不到时 `version === ''`
 */
export function currentDshVersion() {
	if (cached) { return cached; }

	const readPkg = (file) => {
		try {
			const j = JSON.parse(fs.readFileSync(file, 'utf8'));
			return typeof j.version === 'string' ? j.version.trim() : '';
		} catch { return ''; }
	};

	// ① 从 Host 启动脚本上溯
	try {
		let dir = path.dirname(String(process.argv[1] ?? ''));
		for (let i = 0; i < 6 && dir; i += 1) {
			const pj = path.join(dir, 'package.json');
			if (fs.existsSync(pj)) {
				const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
				if (j.name === '@deepseek-ai/dsh') {
					cached = { version: String(j.version ?? ''), source: 'process.argv[1]' };
					return cached;
				}
			}
			const next = path.dirname(dir);
			if (next === dir) { break; }
			dir = next;
		}
	} catch { /* 试下一条 */ }

	// ② 依赖树里找
	try {
		const req = createRequire(fileURLToPath(import.meta.url));
		const entry = req.resolve('@deepseek-ai/dsh');
		let dir = path.dirname(entry);
		for (let i = 0; i < 5; i += 1) {
			const pj = path.join(dir, 'package.json');
			if (fs.existsSync(pj)) {
				const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
				if (j.name === '@deepseek-ai/dsh') {
					cached = { version: String(j.version ?? ''), source: 'require.resolve' };
					return cached;
				}
			}
			const next = path.dirname(dir);
			if (next === dir) { break; }
			dir = next;
		}
	} catch { /* 试下一条 */ }

	// ③ dsh-runtime 目录名兜底
	try {
		const home = process.env.USERPROFILE || process.env.HOME || '';
		const rt = path.join(home, '.vssaros-dev', 'dsh-runtime');
		if (rt && fs.existsSync(rt)) {
			const dirs = fs.readdirSync(rt, { withFileTypes: true })
				.filter(d => d.isDirectory() && /^\d+\./.test(d.name))
				.map(d => d.name)
				.sort((a, b) => cmpVersion(b, a));
			if (dirs.length) {
				cached = { version: dirs[0], source: 'dsh-runtime 目录名（可能不精确）' };
				return cached;
			}
		}
	} catch { /* 放弃 */ }

	cached = { version: '', source: '未找到' };
	return cached;
}

/** 版本比较（数字段逐个比；预发布后缀按字符串退化比较，够做提示用）。 */
export function cmpVersion(a, b) {
	const split = (v) => {
		const [core, pre = ''] = String(v).split('-');
		return { nums: core.split('.').map(n => Number(n) || 0), pre };
	};
	const A = split(a); const B = split(b);
	for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i += 1) {
		const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
		if (d !== 0) { return d > 0 ? 1 : -1; }
	}
	// 无预发布 > 有预发布（1.0.0 > 1.0.0-rc.1）
	if (!A.pre && B.pre) { return 1; }
	if (A.pre && !B.pre) { return -1; }
	if (A.pre === B.pre) { return 0; }
	return A.pre > B.pre ? 1 : -1;
}

/**
 * 判断 `version` 是否满足一个（**单个**）semver range。
 *
 * 只支持常见形态：`^x.y.z` / `~x.y.z` / `>=x.y.z` / `>x.y.z` / `<=x` / `<x` / `x.y.z` / `*`，
 * 以及用 `||` 连接的多段。**看不懂的形态返回 `null`**（调用方按"未知"处理，不当失败）。
 */
export function satisfies(version, range) {
	const v = String(version ?? '').trim();
	const r = String(range ?? '').trim();
	if (!v) { return null; }
	if (!r || r === '*' || r === 'latest') { return true; }

	for (const part of r.split('||').map(s => s.trim()).filter(Boolean)) {
		const res = satisfiesOne(v, part);
		if (res === true) { return true; }
		if (res === null) { return null; }   // 有一段看不懂 ⇒ 整体"未知"
	}
	return false;
}

function satisfiesOne(version, range) {
	const norm = (x) => x.replace(/^v/, '');
	const v = norm(version);

	const m = /^(\^|~|>=|>|<=|<|=)?\s*(.+)$/.exec(range);
	if (!m) { return null; }
	const op = m[1] ?? '=';
	const target = norm(m[2].trim());
	if (!/^\d+(\.\d+)*/.test(target)) { return null; }

	const t = target.split('-')[0].split('.').map(n => Number(n) || 0);
	const c = cmpVersion(v.split('-')[0], target.split('-')[0]);

	switch (op) {
		case '=': return c === 0;
		case '>': return c > 0;
		case '>=': return c >= 0;
		case '<': return c < 0;
		case '<=': return c <= 0;
		case '~': {
			// ~1.2.3 ⇒ >=1.2.3 <1.3.0
			if (c < 0) { return false; }
			const vv = v.split('-')[0].split('.').map(n => Number(n) || 0);
			return vv[0] === t[0] && vv[1] === (t[1] ?? 0);
		}
		case '^': {
			// ^1.2.3 ⇒ >=1.2.3 <2.0.0；^0.2.3 ⇒ >=0.2.3 <0.3.0
			if (c < 0) { return false; }
			const vv = v.split('-')[0].split('.').map(n => Number(n) || 0);
			if (t[0] > 0) { return vv[0] === t[0]; }
			if ((t[1] ?? 0) > 0) { return vv[0] === 0 && vv[1] === t[1]; }
			return vv[0] === 0 && vv[1] === 0 && vv[2] === (t[2] ?? 0);
		}
		default: return null;
	}
}

/**
 * 校验插件的 `peerDependencies` 与当前宿主的兼容性（**只提示，不阻断**）。
 *
 * @param {object} peerDependencies 插件的 peerDependencies
 * @returns {{
 *   checked: boolean,          // 宿主版本拿到了没有（false ⇒ 不能说兼容）
 *   host: string,              // 宿主版本（空 = 未知）
 *   hostSource: string,
 *   warnings: string[],        // 人话警告（空 = 没发现问题或没校验）
 * }}
 */
export function checkPeerCompat(peerDependencies) {
	const peers = (peerDependencies && typeof peerDependencies === 'object') ? peerDependencies : {};
	const { version: host, source: hostSource } = currentDshVersion();

	if (!host) {
		return { checked: false, host: '', hostSource, warnings: ['读不到宿主版本 ⇒ **未校验** peerDependencies 兼容性'] };
	}

	// ⚠ 版本来源不可靠（只是目录名）时**不报"不兼容"** —— 那会误报：
	//   `dsh-runtime/` 下多版本共存，目录名未必是正在跑的那个；
	//   报错比不报更糟（用户会去改一个其实没问题的东西 ✗）
	const reliable = hostSource === 'process.argv[1]' || hostSource === 'require.resolve';
	if (!reliable) {
		return {
			checked: false,
			host,
			hostSource,
			warnings: [`宿主版本读自「${hostSource}」，不够可靠 ⇒ **未校验** peerDependencies 兼容性`],
		};
	}

	const warnings = [];
	let anyChecked = false;
	for (const name of HOST_PEERS) {
		const range = peers[name];
		if (typeof range !== 'string' || !range.trim()) { continue; }
		const ok = satisfies(host, range);
		if (ok === null) { continue; }        // 看不懂的 range ⇒ 不算校验过
		anyChecked = true;
		if (ok === false) {
			warnings.push(`要求 ${name} ${range}，但宿主是 ${host}`);
		}
	}
	return { checked: anyChecked, host, hostSource, warnings };
}
