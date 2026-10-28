/*---------------------------------------------------------------------------------------------
 *  dsh-plugin-deploy — 让「改完 dsh 插件 → 重启」**立刻生效**的同步器。
 *
 *  为什么必须有它（2026-10-24 实测链路，见 @deepseek-ai/dsh-client-modules/lib/index.js）：
 *
 *    repo `dsh-plugins/<x>`              ← 你编辑的地方（页面**不读**这里）
 *      ↓ 本脚本同步
 *    ~/.vssaros-dev/dsh-home/profiles/<profile>/node_modules/@vssaros/<pkg>
 *                                        ← 宿主实际读取、并按它算 rev 的那份
 *      ↓ 宿主 activation 时 stat 入口（exports["./client"]，即 lib/client.js）
 *    URL `/plugins/@vssaros/<pkg>/<chunk>?rev=<sha1(mtimeMs,ctimeMs,size)[:12]>`
 *                                        ← 一个插件的**所有** chunk 共用入口的 rev
 *      ↓ 响应头 `public, max-age=31536000, immutable`
 *    同一 rev 的 URL 浏览器**永久缓存**，不回源校验
 *
 *  ⇒ 「修改没生效」只有三种可能，本脚本负责前两条，第三条靠重启：
 *    ① 只改了 repo、没进 profile      → 服务端字节没变；
 *    ② 只改了 chunk、入口元数据没变    → rev 不变 → 浏览器吃旧缓存（重启也没用）；
 *    ③ 没重启宿主（rev 在 activation 时抓取）。
 *  整包同步必然重写入口 ⇒ mtime/ctime/size 变 ⇒ rev 变 ⇒ 新 URL ⇒ 缓存必然失效 ✓
 *
 *  用法：
 *    node scripts/dsh-plugin-deploy.mjs --changed       # 快通道：按内容差异同步（启动器用这个）
 *    node scripts/dsh-plugin-deploy.mjs --bump          # 官方通道：内容有差异的插件 bump 补丁版本
 *    node scripts/dsh-plugin-deploy.mjs --all
 *    node scripts/dsh-plugin-deploy.mjs vssaros-chat-surface vssaros-agents
 *    node scripts/dsh-plugin-deploy.mjs --verify        # 只打印每个插件当前应有的 rev，不写盘
 *    node scripts/dsh-plugin-deploy.mjs --all --dry     # 不写盘
 *
 *  ★ `--bump` 与 `--changed` 的分工（2026-10-24）：
 *    · 官方机制是「版本不同 ⇒ 启动时 `_ensurePlugin` 暂存 + `dsh plugin add`（pnpm 同步 lock）」；
 *      内容改了但版本没变时 pnpm 认为 `file:` 依赖没变化 ⇒ **一个字节都不替换**。
 *    · `--bump`：只改**仓库** package.json 版本，**不复制文件** —— 把安装留给官方那条路，
 *      于是锁文件 / `dsh.profile.bundles` / 暂存目录都会对齐 ✓（提交前跑一次）。
 *    · `--changed`：直接复制 + 刷新入口 mtime，毫秒级生效（日常高频改动），但绕过 pnpm ⇒
 *      锁文件会漂移。它**会自动让路**：一旦发现仓库版本 ≠ 已装版本，就跳过复制、交给官方 ✓
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGINS = path.join(REPO, 'dsh-plugins');

/**
 * profile 根：**2026-10-28 起 userData 统一为 `~/.vssaros`**（dev 不再用 `.vssaros-dev`）。
 *
 * 仍保留对旧目录的探测：迁移完成前 / 别人机器上还没迁移时，部署要落到**实际在用的**那一份，
 * 否则会出现"脚本说同步成功、宿主读的还是旧目录"这种最难查的假成功 ✗。
 */
const pickProfilesRoot = () => {
	for (const dirName of ['.vssaros', '.vssaros-dev']) {
		const root = path.join(os.homedir(), dirName, 'dsh-home', 'profiles');
		if (fs.existsSync(root)) {
			return root;
		}
	}
	return path.join(os.homedir(), '.vssaros', 'dsh-home', 'profiles');
};
const HOME = pickProfilesRoot();

/** 安装份本来就不含的目录（只在 repo 里）。 */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', 'scripts', 'vendor', '.git', 'e2e', 'dist.e2e']);

// 与 @deepseek-ai/dsh-client-modules 的 framedHash / artifactRevision 逐字一致
const framedHash = (domain, parts) => {
	const h = crypto.createHash('sha1').update(domain).update('\0');
	for (const p of parts) h.update(`${String(Buffer.byteLength(p))}:`).update(p);
	return h.digest('hex').slice(0, 12);
};
export const artifactRevision = (file) => {
	try {
		const st = fs.statSync(file);
		return framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]);
	} catch {
		return '';
	}
};

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const dry = flag('--dry');
const onlyChanged = flag('--changed');
const verify = flag('--verify');
const all = flag('--all');
/** `--bump`：给**内容有差异**的插件自动 bump 补丁版本（让官方 `_ensurePlugin` 判定为需重装）。 */
const bump = flag('--bump');
const wanted = args.filter(a => !a.startsWith('--'));

/** package.json 的 exports["./client"] → 相对入口路径（string 或 { default }）。 */
const clientEntryOf = (pkg) => {
	const c = pkg?.exports?.['./client'];
	if (typeof c === 'string') { return c.replace(/^\.\//, ''); }
	if (c && typeof c === 'object' && typeof c.default === 'string') { return c.default.replace(/^\.\//, ''); }
	return '';
};

const pluginDirs = fs.readdirSync(PLUGINS, { withFileTypes: true })
	.filter(d => d.isDirectory() && fs.existsSync(path.join(PLUGINS, d.name, 'package.json')))
	.map(d => d.name)
	// 显式点名的插件优先（`--verify vssaros-kb` 只看那一个）；没点名才按模式跑全量
	.filter(n => wanted.length ? wanted.includes(n) : (all || onlyChanged || bump || verify));

if (pluginDirs.length === 0) {
	console.log('用法: node scripts/dsh-plugin-deploy.mjs --changed | --bump | --verify | --all | <pluginDir>... [--dry]');
	process.exit(1);
}

const profiles = fs.existsSync(HOME) ? fs.readdirSync(HOME, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];

/** 列出参与运行时的文件（跳过 test/scripts/vendor）。 */
const runtimeFiles = (root, base = root, out = []) => {
	let es;
	try { es = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
	for (const e of es) {
		const p = path.join(root, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) { continue; }
			runtimeFiles(p, base, out);
			continue;
		}
		out.push(path.relative(base, p));
	}
	return out;
};

const differs = (srcRoot, dstRoot, rel) => {
	const a = path.join(srcRoot, rel), b = path.join(dstRoot, rel);
	let sa, sb;
	try { sa = fs.statSync(a); } catch { return false; }
	try { sb = fs.statSync(b); } catch { return true; }
	if (sa.size !== sb.size) { return true; }
	try { return !fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return true; }
};

/** 读 `<pkgDir>/package.json` 的 version（读不到返回空串）。 */
const versionOf = (pkgDir) => {
	try { return String(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version ?? ''); } catch { return ''; }
};

/**
 * `1.2.3` → `1.2.4`；预发布后缀原样保留（`1.2.3-rc.1` → `1.2.4-rc.1`）。
 * 只做补丁位：官方判定只看版本字符串是否变化，补丁位最不易误伤。
 */
const bumpPatch = (v) => {
	const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(v || '').trim());
	if (!m) { return ''; }
	return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] ?? ''}`;
};

/** 写回 package.json，**保留原缩进与结尾换行**（仓库里是 tab 缩进，别改成 2 空格）。 */
const writeJsonPreservingFormat = (file, obj) => {
	const text = fs.readFileSync(file, 'utf8');
	const indentMatch = /\n([\t ]+)"/.exec(text);
	const indent = indentMatch ? indentMatch[1] : '\t';
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const out = JSON.stringify(obj, null, indent).replace(/\n/g, eol) + (text.endsWith('\n') ? eol : '');
	fs.writeFileSync(file, out, 'utf8');
};

const summary = [];
for (const dir of pluginDirs) {
	const srcRoot = path.join(PLUGINS, dir);
	let pkg;
	try { pkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8')); } catch { continue; }
	if (!pkg.name) { continue; }

	const entryRel = clientEntryOf(pkg);
	const dests = [];
	for (const prof of profiles) {
		const nm = path.join(HOME, prof, 'node_modules', pkg.name);
		if (fs.existsSync(nm)) { dests.push({ prof, dir: nm }); }
	}
	if (!dests.length) { continue; }

	const files = runtimeFiles(srcRoot);
	const repoVer = String(pkg.version ?? '');

	// ── `--bump`：内容有差异的插件，把**仓库** package.json 的补丁位 +1 ──────────────
	// 目的：让官方那条判定（启动时 `_ensurePlugin` 比 "随包版本 vs 已装版本"）认为需要重装，
	// 从而走 `暂存 → dsh plugin add`（会顺带更新 pnpm-lock / dsh.profile.bundles）。
	// ⚠ 本模式下**不复制文件**：一旦抢先复制，profile 里的版本就等于仓库版本 ⇒ 官方判"已最新"
	//    直接跳过 ⇒ 锁文件与暂存目录仍然漂移，--bump 就白做了 ✗
	if (bump) {
		const dirty = dests.some(d => files.some(rel => differs(srcRoot, d.dir, rel)));
		if (!dirty) {
			summary.push([dir, dests[0].prof, 0, repoVer, repoVer, 'clean']);
			continue;
		}
		const nextVer = bumpPatch(repoVer);
		if (!nextVer) {
			summary.push([dir, dests[0].prof, 0, repoVer, repoVer, 'bump-failed']);
			continue;
		}
		if (!dry) {
			pkg.version = nextVer;
			writeJsonPreservingFormat(path.join(srcRoot, 'package.json'), pkg);
		}
		summary.push([dir, dests[0].prof, 0, repoVer, nextVer, 'bumped']);
		continue;
	}

	for (const d of dests) {
		const changed = files.filter(rel => differs(srcRoot, d.dir, rel));
		const entryDst = entryRel ? path.join(d.dir, entryRel) : '';
		const revBefore = entryRel ? artifactRevision(entryDst) : '';

		if (verify) {
			summary.push([dir, d.prof, changed.length, revBefore || '(no client entry)', revBefore, '']);
			continue;
		}

		// 版本已经不一致 ⇒ 这是**官方通道**的活（F5 时 `_ensurePlugin` 会暂存 + `dsh plugin add`）。
		// 若这里抢先复制，profile 版本就会等于仓库版本 ⇒ 官方判"已是最新"跳过 ⇒ 锁文件永久漂移 ✗
		const instVer = versionOf(d.dir);
		if (onlyChanged && repoVer && instVer && repoVer !== instVer) {
			summary.push([dir, d.prof, changed.length, `repo ${repoVer} ≠ installed ${instVer}`, '', 'leave-to-official']);
			continue;
		}
		// --changed 也**不跳过**：内容一致时仍要刷新入口 mtime。
		// 否则会出现"内容已经同步、但 rev 还是旧的"这种半生效状态（本机 11:47 实测撞到），
		// 页面继续用旧 chunk。开发态每次重启换一次 rev 的代价只是重新下载插件 chunk，可以接受。
		if (!dry) {
			for (const rel of changed) {
				const to = path.join(d.dir, rel);
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.copyFileSync(path.join(srcRoot, rel), to);
			}
			// 入口必须让 rev 变：rev = sha1(mtimeMs, ctimeMs, size)。
			// ⚠ Windows 的 CopyFile（= fs.copyFileSync）会**连时间戳一起复制** —— 实测 repo
			//   与安装份的 (mtimeMs, ctimeMs, size) 完全相等 ⇒ rev 不变 ⇒ 只改 chunk 时
			//   浏览器永远吃旧缓存（这就是"改完重启不生效"的②号坑）。所以复制之后必须
			//   显式把入口的 mtime 推到现在，让 rev 一定变化 ✓
			if (entryRel && fs.existsSync(path.join(srcRoot, entryRel))) {
				const from = path.join(srcRoot, entryRel), to = entryDst;
				if (path.resolve(from) !== path.resolve(to)) { fs.copyFileSync(from, to); }
				const now = new Date();
				fs.utimesSync(to, now, now);
			}
		}
		const revAfter = entryRel ? artifactRevision(entryDst) : '';
		const hasEntry = !!entryRel && fs.existsSync(path.join(srcRoot, entryRel));
		const state = !hasEntry ? 'no-client-entry' : (revBefore === revAfter ? 'REV-UNCHANGED(!)' : (changed.length ? 'deployed' : 'touch-only'));
		summary.push([dir, d.prof, changed.length, revBefore || '(no client entry)', revAfter || '(no client entry)', state]);
	}
}

const pad = (s, n) => String(s).padEnd(n);
const W = 26;   // 最长的包目录名是 vssaros-web-content-import（25 字符）

if (bump) {
	if (dry) { console.log('[dry] 以下版本会被 +1 补丁位（不写盘、不复制文件）'); }
	let n = 0;
	for (const [dir, , , before, after, note] of summary) {
		if (note === 'bumped') {
			n++;
			console.log('↑ ' + pad(dir, W) + 'version ' + before + ' -> ' + after + (dry ? '  [dry]' : '  (已写入仓库 package.json)'));
		} else if (note === 'bump-failed') {
			console.log('✗ ' + pad(dir, W) + 'version "' + before + '" 不是 x.y.z 形式 ⇒ 无法自动 bump，请手动改');
		}
	}
	if (!n) { console.log('（没有内容有差异的插件 ⇒ 无需 bump）'); }
	else if (!dry) {
		console.log('\n下一步：F5 启动 —— 主进程 `_ensurePlugin` 会判定版本不一致 ⇒ 暂存到 .vssaros/plugins/<ver>/ + `dsh plugin add`（pnpm 会同步 lock 与 dsh.profile.bundles）。');
		console.log('       （本模式刻意**不复制**文件；若想跳过 pnpm 直接生效，改用 --changed）');
	}
} else if (verify) {
	console.log(pad('plugin', W) + pad('profile', 10) + pad('pending', 9) + 'rev (served as ?rev=…)');
	for (const [dir, prof, cnt, , after] of summary) {
		console.log(pad(dir, W) + pad(prof, 10) + pad(cnt, 9) + after);
	}
} else {
	for (const [dir, prof, cnt, before, after, note] of summary) {
		if (note === 'leave-to-official') {
			console.log('→ ' + pad(dir, W) + pad(prof, 10) + before + '  ⇒ 交给官方安装（F5 时暂存 + dsh plugin add）');
			continue;
		}
		if (note === 'no-client-entry') {
			console.log('· ' + pad(dir, W) + pad(prof, 10) + 'files=' + pad(cnt, 4) + '该包没有 exports["./client"] ⇒ 无 rev（改的是服务端文件，重启即读）');
			continue;
		}
		const changedRev = before !== after;
		console.log('✓ ' + pad(dir, W) + pad(prof, 10) + 'files=' + pad(cnt, 4) + 'rev ' + before + ' -> ' + after +
			(changedRev ? '' : '  ⚠ REV-UNCHANGED（缓存不会失效）') +
			(note === 'touch-only' ? '  (内容未变，仅刷新缓存)' : ''));
	}
	if (!summary.some(s => s[5] === 'deployed')) {
		console.log('（没有需要同步的插件改动；若你刚改了 chunk，入口会被重写以刷新 rev）');
	}
	if (!dry) { console.log('下一步：重启应用（宿主在 activation 时抓 rev）。'); }
}
