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
 *  ★ 2026-10-29（连续 8 次"报成功但不同步"的四个根因，都已修）：
 *    ① 目标只写 node_modules/@vssaros/<pkg> ⇒ 宿主真正读的
 *       `.vssaros/plugins/<pkg>-<版本>-<哈希>/`（已安装副本）根本没被更新 ⇒ 现在两者都写；
 *    ② `--changed` 遇到"repo 版本 ≠ 已装版本"就跳过复制 ⇒ 天天在改的插件正好命中 ⇒ 现在照拷；
 *    ③ SKIP_DIRS 含 'scripts' ⇒ 插件的 scripts/（服务端 spawn 的那份）永远同步不过去 ⇒ 已移除；
 *    ④ 复制后不校验 ⇒ 现在逐文件 sha256 比对 + rev 校验，不过 ⇒ **非零退出**。
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
 * profile 根（2026-10-28 最终形态：**开发版与稳定版各一套 userData**）。
 *
 * 本脚本是**开发期**工具 ⇒ 目标应优先 dev 的 `~/.vssaros-dev/dsh-home/profiles`；
 * 其余候选只为兼容过渡期（`~/.vssaros/dsh-home-dev` 是中间方案留下的目录）。
 * 部署必须落到**实际在用的**那一份，否则会出现"脚本说同步成功、宿主读的还是旧目录"这种最难查的假成功 ✗。
 */
const pickProfilesRoot = () => {
	const home = os.homedir();
	const candidates = [
		path.join(home, '.vssaros-dev', 'dsh-home', 'profiles'),   // dev（最终形态）
		path.join(home, '.vssaros', 'dsh-home-dev', 'profiles'),   // 中间方案遗留
		path.join(home, '.vssaros', 'dsh-home', 'profiles'),       // 打包版
	];
	for (const root of candidates) {
		if (fs.existsSync(root)) {
			return root;
		}
	}
	return candidates[0];
};
const HOME = pickProfilesRoot();

/**
 * 全部候选 profile 根（dev / 中间方案 / 打包版）—— 2026-10-29：
 * 原先只取**第一个存在的**根（通常是 dev），于是"宿主其实跑的是 prod"时，
 * 脚本把字节写进了没人读的目录 ⇒ 页面拿旧字节（"报成功但不同步"的第一层原因）。
 * ⇒ 现在**所有存在的根都同步** ✓
 */
const PROFILE_ROOTS = [
	path.join(os.homedir(), '.vssaros-dev', 'dsh-home', 'profiles'),
	path.join(os.homedir(), '.vssaros', 'dsh-home-dev', 'profiles'),
	path.join(os.homedir(), '.vssaros', 'dsh-home', 'profiles'),
].filter((r) => fs.existsSync(r));

/**
 * 找出某个插件在 profile 下的**已安装副本**（官方 `_ensurePlugin` 暂存 + `dsh plugin add` 生成的那份）。
 *
 * ★ 2026-10-29（真机："报成功但不同步"的第一主因）：
 *   宿主**实际读**的是 `.vssaros/plugins/<pkg>-<版本>-<哈希>/`，
 *   而不是 `node_modules/@vssaros/<pkg>` —— 后者只是 pnpm 的安装位。
 *   只写 node_modules ⇒ 页面永远拿旧字节（连续 8 次"部署成功却没生效"都栽在这）。
 *
 * 目录名形如 `vssaros-dsh-kb-0.5.58-14c87146` ⇒ 前缀 `vssaros-<包名>-`，
 * 后面必须紧跟**版本号**（数字开头）⇒ 天然排除 `vssaros-dsh-kb-refs-*` 这类**别的插件** ✓。
 */
const installedCopiesOf = (profileDir, pkgName) => {
	const base = String(pkgName || '').replace(/^@[^/]+\//, '');
	const prefix = 'vssaros-' + base + '-';
	const pluginsDir = path.join(profileDir, '.vssaros', 'plugins');
	let ents = [];
	try { ents = fs.readdirSync(pluginsDir, { withFileTypes: true }); } catch { return []; }
	return ents
		.filter((e) => e.isDirectory() && e.name.startsWith(prefix))
		.map((e) => e.name)
		.filter((n) => /^\d/.test(n.slice(prefix.length)))
		.map((n) => ({ dir: path.join(pluginsDir, n), name: n }));
};

/** profile 根的短标签（dev / prod / legacy），便于区分"写到哪一份"。 */
const rootTagOf = (root) => {
	if (String(root).startsWith(path.join(os.homedir(), '.vssaros-dev'))) { return 'dev'; }
	if (String(root).includes('dsh-home-dev')) { return 'legacy'; }
	return 'prod';
};

/** 文件 sha256（校验"真的落地了"用）。 */
const sha256File = (f) => {
	try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; }
};

/** 安装份本来就不含的目录（只在 repo 里）。 */
/**
 * 安装份本来就不含的目录（只在 repo 里）。
 *
 * ⚠ 2026-10-29（两次真机事故，都因为这里多排了一个目录）：
 *   ① 原先含 'scripts' ⇒ 插件的 scripts/ 永远同步不过去
 *      （典型：vssaros-kb 的 scripts/feishu-sync.mjs —— **服务端 spawn 的就是它**）⇒ 已移除 ✓
 *   ② 原先含 'vendor' ⇒ **运行时依赖**没同步过去 ⇒ 插件 import 直接失败：
 *      `vssaros-kb (@vssaros/dsh-kb): failed to import: Error [ERR_MODULE_NOT_FOUND]:
 *       Cannot find module '…/node_modules/@vssaros/dsh-kb/vendor/markdown-it.cjs'`
 *      （lib/md/render.js 要 import 它）⇒ 插件整个没激活 ⇒ /x/kb/ 404 ⇒ **知识库白屏**。
 *      ⇒ vendor 是**源码**（git 跟踪 67 个文件）⇒ 必须同步 ✓ 已移除。
 */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '.git', 'e2e', 'dist.e2e']);

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

/** 所有 profile 目录（跨全部根）⇒ [{ root, prof, dir }]。 */
const profiles = [];
for (const root of PROFILE_ROOTS) {
	let ents = [];
	try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
	for (const d of ents) {
		if (!d.isDirectory()) { continue; }
		profiles.push({ root, prof: d.name, dir: path.join(root, d.name) });
	}
}

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
/** 落地失败清单（复制后校验不通过 / rev 没变）⇒ 最后非零退出。 */
const failures = [];
for (const dir of pluginDirs) {
	const srcRoot = path.join(PLUGINS, dir);
	let pkg;
	try { pkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8')); } catch { continue; }
	if (!pkg.name) { continue; }

	const entryRel = clientEntryOf(pkg);
	const dests = [];
	for (const p of profiles) {
		const nm = path.join(p.dir, 'node_modules', pkg.name);
		if (fs.existsSync(nm)) { dests.push({ prof: rootTagOf(p.root) + '/' + p.prof, root: p.root, dir: nm, kind: 'node_modules' }); }
		// ★ 宿主真正读的是**已安装副本**（版本化目录）⇒ 必须一并同步（见 installedCopiesOf 注释）
		for (const inst of installedCopiesOf(p.dir, pkg.name)) {
			dests.push({ prof: rootTagOf(p.root) + '/' + p.prof, root: p.root, dir: inst.dir, kind: 'installed:' + inst.name });
		}
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
		/*
		 * ★ 2026-10-29：原先这里在"版本不一致"时 `continue`（交给官方通道）⇒
		 *   我们天天在改的插件恰好版本不一致 ⇒ **每次都跳过复制，却打印成"已部署"**。
		 *   ⇒ 现在**照样复制**（开发期要立刻生效），只把版本漂移写进结果行提醒去跑 --bump。
		 */
		const versionDrift = (repoVer && instVer && repoVer !== instVer)
			? `repo ${repoVer} ≠ installed ${instVer}` : '';
		// --changed 也**不跳过**：内容一致时仍要刷新入口 mtime。
		// 否则会出现"内容已经同步、但 rev 还是旧的"这种半生效状态（本机 11:47 实测撞到），
		// 页面继续用旧 chunk。开发态每次重启换一次 rev 的代价只是重新下载插件 chunk，可以接受。
		if (!dry) {
			// ★ 2026-10-29：复制失败（权限/占用/EISDIR…）必须**变成可读的失败**，而不是抛栈。
			try {
				for (const rel of changed) {
					const to = path.join(d.dir, rel);
					fs.mkdirSync(path.dirname(to), { recursive: true });
					fs.copyFileSync(path.join(srcRoot, rel), to);
				}
			} catch (e) {
				failures.push(`${dir} → ${d.dir}：复制失败（${String((e && e.message) || e)}）`);
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

		/*
		 * ★ 2026-10-29：复制完必须**证明**落地了 —— 逐文件 sha256 比对。
		 *   以前"复制了就说成功"，于是漏文件/失败/写错目录全都看不出来（连续 8 次假成功）。
		 *   现在：不一致 ⇒ 记进 failures ⇒ 进程以**非零码**退出（CI/启动器能立刻发现）。
		 */
		if (!dry && changed.length) {
			const bad = [];
			for (const rel of changed) {
				const a = sha256File(path.join(srcRoot, rel));
				const b = sha256File(path.join(d.dir, rel));
				if (!a || a !== b) { bad.push(rel); }
			}
			if (bad.length) {
				failures.push(`${dir} → ${d.dir}：${bad.length} 个文件校验不一致（${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}）`);
			}
		}
		// 有文件变更却 rev 没变 ⇒ 浏览器会继续吃旧 chunk ⇒ 同样算失败
		if (!dry && changed.length && hasEntry && revBefore && revBefore === revAfter) {
			failures.push(`${dir} → ${d.dir}：内容已同步但入口 rev 未变（${revBefore}）⇒ 浏览器会吃旧缓存`);
		}

		const state = !hasEntry ? 'no-client-entry'
			: (changed.length ? (versionDrift ? 'deployed(version-drift)' : 'deployed') : 'touch-only');
		summary.push([dir, d.prof + (d.kind && d.kind !== 'node_modules' ? '/' + d.kind : ''), changed.length,
			revBefore || '(no client entry)', revAfter || '(no client entry)', state, versionDrift]);
	}
}

const drifts = summary.filter((r) => r[6]);
if (drifts.length) {
	console.log('\n⚠ 有 ' + drifts.length + ' 处**版本漂移**（repo ≠ installed）⇒ 官方锁文件未对齐；');
	console.log('   提交前跑一次：node scripts/dsh-plugin-deploy.mjs --bump');
}

if (failures.length) {
	console.log('\n✗ 部署校验未通过（下面这些**没有真正生效**）：');
	for (const f of failures) { console.log('   - ' + f); }
	// ★ 2026-10-29：假成功必须**让机器看见** ⇒ 非零退出（以前一律 0 ⇒ 调用方以为成功）
	process.exitCode = 1;
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
		console.log(pad(dir, W) + pad(prof, 48) + pad(cnt, 9) + after);
	}
} else {
	for (const [dir, prof, cnt, before, after, note, drift] of summary) {
		if (note === 'leave-to-official') {
			console.log('→ ' + pad(dir, W) + pad(prof, 48) + before + '  ⇒ 交给官方安装（F5 时暂存 + dsh plugin add）');
			continue;
		}
		if (note === 'no-client-entry') {
			console.log('· ' + pad(dir, W) + pad(prof, 48) + 'files=' + pad(cnt, 4) + '该包没有 exports["./client"] ⇒ 无 rev（改的是服务端文件，重启即读）');
			continue;
		}
		const changedRev = before !== after;
		console.log('✓ ' + pad(dir, W) + pad(prof, 48) + 'files=' + pad(cnt, 4) + 'rev ' + before + ' -> ' + after +
			(changedRev ? '' : '  ⚠ REV-UNCHANGED（缓存不会失效）') +
			(note === 'touch-only' ? '  (内容未变，仅刷新缓存)' : ''));
	}
	if (!summary.some(s => s[5] === 'deployed')) {
		console.log('（没有需要同步的插件改动；若你刚改了 chunk，入口会被重写以刷新 rev）');
	}
	if (!dry) { console.log('下一步：重启应用（宿主在 activation 时抓 rev）。'); }
}
