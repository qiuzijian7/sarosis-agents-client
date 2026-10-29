#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  separate-dev-userdata — 让开发版拥有**自己的一套 userData**（2026-10-28 最终形态）。
 *
 * ## 为什么必须分开
 *
 * “dev 与稳定版同时开着”**只能**靠两份 userData —— Electron 的单实例锁绑在 userData 上，
 * 共用一份时第二个进程会直接退出（这也是 VS Code 用 `code` / `code-insiders` / `code-oss-dev`
 * 三份目录的原因）。DSH_HOME 随之回到一条统一规则 `<userData>/dsh-home`：
 *
 *     ~/.vssaros/       ← 稳定版（打包 exe）
 *     ~/.vssaros-dev/   ← 开发版
 *
 * 本脚本把**当前统一状态**下的数据搬到这个布局：
 *   1. 旧 `~/.vssaros-dev/dsh-home` 先改名备份（可回滚）；
 *   2. `~/.vssaros` → `~/.vssaros-dev` 做**增量**同步（`/E /XO`：只覆盖源更新的文件，
 *      目标独有的旧文件保留），排除缓存 / 日志 / 运行期文件 / 两套 dsh-home；
 *   3. 把中间方案留下的 `~/.vssaros/dsh-home-dev`（最新 dev profile）**移动**成
 *      `~/.vssaros-dev/dsh-home`；
 *   4. 重写 profile 里的 `file:` 绝对路径指针（`…/.vssaros/dsh-home-dev/…` → `…/.vssaros-dev/dsh-home/…`）。
 *
 * ## 用法
 *
 *   node scripts/separate-dev-userdata.mjs --dry
 *   node scripts/separate-dev-userdata.mjs
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');

const PROD = path.join(os.homedir(), '.vssaros');
const DEV = path.join(os.homedir(), '.vssaros-dev');
const PROD_DEV_DSH = path.join(PROD, 'dsh-home-dev');   // 中间方案留下的"dev DSH_HOME"
const DEV_DSH = path.join(DEV, 'dsh-home');
/** exe 名：2026-10-29 起叫 `VsSaros.exe`（原来 `Saroasis harness.exe`）⇒ 两个都查。 */
const APP_IMAGES = ['VsSaros.exe', 'Saroasis harness.exe'];

/** 不参与同步的东西：缓存/日志/运行期文件，以及两套 dsh-home（各自单独处理）。 */
const EXCLUDE_DIRS = [
	'dsh-home', 'dsh-home-dev', 'dsh-run', 'dsh-runtime', 'logs',
	'Cache', 'Code Cache', 'CachedData', 'CachedProfilesData', 'GPUCache',
	'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache',
	'browser-profile', 'Service Worker', 'Local Storage', 'Session Storage',
	'blob_storage', 'Network', 'Session Storage', 'Crashpad', 'Partitions',
	'Backups', 'tmp',
];
const EXCLUDE_FILES = ['*.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'DIPS*', '*.wal'];

const log = (s) => console.log(s);

const isAppRunning = () => {
	for (const image of APP_IMAGES) {
		const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8', windowsHide: true });
		if (String(r.stdout || '').toLowerCase().includes(image.toLowerCase())) {
			return true;
		}
	}
	return false;
};

const stamp = () => {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const readJson = (p) => {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; }
};

const summary = (userData, label) => {
	const home = path.join(userData, 'dsh-home');
	const profiles = path.join(home, 'profiles');
	let names = [];
	try { names = fs.readdirSync(profiles, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* 没有 */ }
	if (!names.length) {
		log(`  ${label}: （没有 dsh-home/profile）`);
		return;
	}
	for (const name of names) {
		const version = readJson(path.join(profiles, name, 'node_modules', '@vssaros', 'dsh-chat-surface', 'package.json'))?.version ?? '(未装)';
		let sessions = 0;
		try { sessions = fs.readdirSync(path.join(home, 'sessions')).length; } catch { /* 忽略 */ }
		log(`  ${label}: profile=${name}  chat-surface=${version}  sessions=${sessions}`);
	}
};

/** 把 profile 里的 `file:` 绝对路径从 `fromDir` 改到 `toDir`（正/反斜杠两种形态都改）。 */
const rewritePointers = (dshHomeDir, fromDir, toDir) => {
	const profiles = path.join(dshHomeDir, 'profiles');
	const targets = new Set(['package.json', 'pnpm-lock.yaml']);
	const pairs = [
		[`/${fromDir}/profiles`, `/${toDir}/profiles`],
		[`\\${fromDir.replace(/\//g, '\\')}\\profiles`, `\\${toDir.replace(/\//g, '\\')}\\profiles`],
	];
	const changed = [];
	const fix = (p) => {
		let s;
		try { s = fs.readFileSync(p, 'utf8'); } catch { return; }
		let next = s;
		let total = 0;
		for (const [a, b] of pairs) {
			const n = next.split(a).length - 1;
			if (n) { total += n; next = next.split(a).join(b); }
		}
		if (!total) { return; }
		fs.writeFileSync(p, next);
		changed.push({ file: path.relative(dshHomeDir, p), n: total });
	};
	const walk = (dir, depth) => {
		if (depth > 3) { return; }
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === 'node_modules') { continue; }
				walk(p, depth + 1);
			} else if (targets.has(e.name)) {
				fix(p);
			}
		}
	};
	walk(profiles, 0);
	try {
		const pnpmDir = path.join(profiles, 'vssaros', 'node_modules', '.pnpm');
		for (const e of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
			if (e.isFile() && /^(lock\.yaml|.*lock.*\.(yaml|json))$/i.test(e.name)) {
				fix(path.join(pnpmDir, e.name));
			}
		}
	} catch { /* 没有 .pnpm */ }
	return changed;
};

const robocopy = (from, to, extra) => {
	const r = spawnSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', ...extra], { windowsHide: true });
	const code = r.status ?? -1;
	return code;   // <8 都算成功
};

const main = () => {
	log('=== 让开发版拥有独立 userData ===');
	log(`  稳定版：${PROD}`);
	log(`  开发版：${DEV}`);
	if (!fs.existsSync(DEV) && !fs.existsSync(PROD_DEV_DSH)) {
		log('');
		log('看不到 `.vssaros-dev` 也看不到中间方案的 `dsh-home-dev` ⇒ 可能已经完成过，无需处理。');
		return;
	}
	if (isAppRunning() && !FORCE && !DRY) {
		log(`✗ 应用正在运行（${APP_IMAGE}）—— 请先关掉窗口再跑（或加 --force）。`);
		process.exitCode = 2;
		return;
	}

	log('');
	log('现状：');
	summary(PROD, 'stable  ');
	// 中间方案留下的 dev DSH_HOME（最新 dev profile 在这里）
	if (fs.existsSync(PROD_DEV_DSH)) {
		log(`  mid-dev : ${PROD_DEV_DSH}（将移动到 ${DEV_DSH}）`);
	}

	const backup = `${DEV_DSH}.bak-${stamp()}`;
	const xd = EXCLUDE_DIRS.flatMap(d => ['/XD', d]);
	const xf = EXCLUDE_FILES.flatMap(f => ['/XF', f]);

	log('');
	log('计划：');
	log(`  1. 旧 dev 的 dsh-home 若存在 → 改名备份（${path.basename(backup)}）`);
	log(`  2. ${PROD} → ${DEV} 增量同步（/E /XO，排除 ${EXCLUDE_DIRS.length} 类目录 + 缓存/锁）`);
	log(`  3. ${PROD_DEV_DSH} → ${DEV_DSH}（移动，最新 dev profile）`);
	log('  4. 重写 dev profile 里的绝对路径指针');
	if (DRY) {
		log('');
		log('（--dry：只打印计划，未改动任何文件）');
		return;
	}

	// 1. 旧 dev DSH_HOME 备份（改名，秒级）
	if (fs.existsSync(DEV_DSH)) {
		try {
			fs.renameSync(DEV_DSH, backup);
			log(`[1/4] 旧 dev dsh-home 已备份为 ${path.basename(backup)}`);
		} catch (e) {
			log(`[1/4] ✗ 备份失败（${e.message}）⇒ 中止，未做任何其他改动`);
			process.exitCode = 1;
			return;
		}
	} else {
		log('[1/4] 旧 dev dsh-home 不存在，跳过备份');
	}

	// 2. 增量同步（/XO = 只覆盖源更新的文件；目标独有旧文件保留）
	fs.mkdirSync(DEV, { recursive: true });
	const syncCode = robocopy(PROD, DEV, ['/XO', ...xd, ...xf]);
	log(syncCode >= 8 ? `[2/4] ⚠ 同步有错误（exit=${syncCode}）` : `[2/4] 已增量同步 ${PROD} → ${DEV}`);

	// 3. 把中间方案的 dev DSH_HOME 移动成 dev 的 dsh-home
	if (fs.existsSync(PROD_DEV_DSH)) {
		const moveCode = robocopy(PROD_DEV_DSH, DEV_DSH, ['/MOVE', '/XF', '*.lock', 'host.json', 'host-port.json', 'run-marker.json']);
		log(moveCode >= 8 ? `[3/4] ⚠ 移动有错误（exit=${moveCode}）` : '[3/4] 已把最新 dev profile 移到 dsh-home-dev → dsh-home');
	} else {
		log('[3/4] 没有中间方案的 dsh-home-dev，跳过');
	}

	// 4. 指针重写
	const fixed = rewritePointers(DEV_DSH, '.vssaros/dsh-home-dev', '.vssaros-dev/dsh-home');
	log(fixed.length
		? `[4/4] 已重写指针：${fixed.map(f => `${f.file}(${f.n})`).join('，')}`
		: '[4/4] 指针无需改写');

	log('');
	log('结果：');
	summary(PROD, 'stable  ');
	summary(DEV, 'dev     ');
	log('');
	log('✓ 完成。两个形态现在可以同时开着（各自的 userData ⇒ 各自的单实例锁）。');
	log(`  · 回滚：把 ${DEV} 里的 dsh-home 换回 ${path.basename(backup)}（同法 robocopy /MOVE 反向）。`);
	log('  · 注意：此后两边的配置/技能/知识库**各自演进**（需要同步时再跑 --sync-only，见下）。');
};

main();
