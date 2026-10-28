/*---------------------------------------------------------------------------------------------
 *  migrate-userdata-dev-to-prod — 把旧 dev 数据目录合并进统一目录（2026-10-28）。
 *
 * ## 为什么需要
 *
 * 以前 dev 用 `~/.vssaros-dev`、打包版用 `~/.vssaros` ⇒ **两套独立 profile**：
 *   · 同一个插件在两处版本不同（真机：打包 0.2.243 / dev 0.2.268）⇒ 旧的一侧启动时会
 *     尝试"降级重装"（一条 `dsh plugin add` 装 8 个包，跑满 4 分钟超时 + 逐项回退再失败）；
 *   · 会话历史、技能、看板、知识库各在一份，用户在两个 app 里看到的世界不一样。
 * ⇒ 现在 `scripts/start-dev-app.mjs` 与 `.vscode/launch.json` 都改用 `~/.vssaros`。
 *
 * ## 本脚本做什么
 *
 * **合并、不是覆盖**：把 `~/.vssaros-dev` 的内容合并进 `~/.vssaros`
 *   · 同名文件：**以 dev 为准**（dev 的 profile 更新，正是要保住的那份）；
 *   · 目标独有文件：**保留**（打包版写过而 dev 没有的，删掉就是丢数据）；
 *   · 迁移前先把目标整体备份成 `~/.vssaros.bak-<时间戳>`（可回滚）。
 *
 * 源目录**不删除**（确认没问题后自己删），运行期文件（锁 / 端口标记）**不迁移**。
 *
 * ## 用法
 *
 *   node scripts/migrate-userdata-dev-to-prod.mjs --dry     # 只看计划
 *   node scripts/migrate-userdata-dev-to-prod.mjs           # 真执行（会先备份）
 *   node scripts/migrate-userdata-dev-to-prod.mjs --force   # 应用在跑也照做（不推荐）
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');

const SRC = path.join(os.homedir(), '.vssaros-dev');
const DST = path.join(os.homedir(), '.vssaros');
const APP_IMAGE = 'Saroasis harness.exe';

/**
 * 运行期文件：绝不能带过去。
 *
 * ⚠ `*.lock` 必须排除（2026-10-28 真机教训）：dsh 的 `dsh-atomic-write` 用
 *   `profiles/<p>/package.json.lock` 做写锁。旧目录里有一把 **5 天前的死锁**（上次安装被中断，
 *   writer 早没了、锁没释放），迁移把它一起带进新目录 ⇒ 之后每次 `dsh plugin add` 都
 *   `atomic-write: timed out waiting for the writer lock` ⇒ 装包跑满 120s 超时 ⇒
 *   桌面窗口永远停在"正在启动后台服务…" ✗✗。
 */
const SKIP_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'code.lock', '*.lock'];

const log = (s) => console.log(s);

const isAppRunning = () => {
	const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${APP_IMAGE}`, '/NH'], { encoding: 'utf8', windowsHide: true });
	const out = String(r.stdout || '');
	return out.toLowerCase().includes(APP_IMAGE.toLowerCase());
};

const dirSize = (dir) => {
	let total = 0;
	const walk = (d) => {
		let entries;
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { walk(p); }
			else { try { total += fs.statSync(p).size; } catch { /* 读不到略过 */ } }
		}
	};
	walk(dir);
	return total;
};

const readJson = (p) => {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; }
};

const profileSummary = (userData) => {
	const profiles = path.join(userData, 'dsh-home', 'profiles');
	let names = [];
	try { names = fs.readdirSync(profiles, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* 没有 */ }
	const out = [];
	for (const name of names) {
		const pkg = readJson(path.join(profiles, name, 'node_modules', '@vssaros', 'dsh-chat-surface', 'package.json'));
		const sessions = path.join(userData, 'dsh-home', 'sessions');
		let sessionCount = 0;
		try { sessionCount = fs.readdirSync(sessions).length; } catch { /* 没有 */ }
		out.push({ profile: name, chatSurface: pkg?.version ?? '(未装)', sessions: sessionCount });
	}
	return out;
};

/**
 * 把 profile 里指向旧 dev 目录的**绝对路径**改到统一目录（2026-10-28）。
 *
 * 为什么必须做：`dsh plugin add` 写进 profile 的依赖是 `file:<绝对路径>`，迁移只搬文件
 * 不搬指针的话 —— 旧目录一删全坏，且每次启动 pnpm 都要重写整个依赖图（真机卡 1 分钟+）。
 *
 * @returns 改过的文件与处数（空数组 = 本来就没有旧路径）
 */
const rewriteProfilePointers = (userData) => {
	const profiles = path.join(userData, 'dsh-home', 'profiles');
	const targets = new Set(['package.json', 'pnpm-lock.yaml']);
	const changed = [];
	const fix = (p) => {
		let s;
		try { s = fs.readFileSync(p, 'utf8'); } catch { return; }
		const n = (s.match(/\.vssaros-dev/g) || []).length;
		if (!n) { return; }
		fs.writeFileSync(p, s.split('.vssaros-dev').join('.vssaros'));
		changed.push({ file: path.relative(userData, p), n });
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
	// pnpm 在 `node_modules/.pnpm` 下还放一份 lock 副本（不改它会与主 lockfile 打架）
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

const stamp = () => {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const main = () => {
	log('=== userData 合并：~/.vssaros-dev  →  ~/.vssaros ===');
	if (!fs.existsSync(SRC)) {
		log(`源目录不存在：${SRC}`);
		log('无需迁移（已经是单一目录）。');
		return;
	}
	if (!fs.existsSync(DST)) {
		fs.mkdirSync(DST, { recursive: true });
	}
	// `--dry` 不写盘 ⇒ 应用在跑也能看计划（只有真执行才需要独占）
	if (isAppRunning() && !FORCE && !DRY) {
		log(`✗ 应用正在运行（${APP_IMAGE}）—— 文件被占用时迁移会写坏数据。`);
		log('  请先关掉桌面窗口（会退出 app）再重跑本脚本；确实要冒险加 --force。');
		process.exitCode = 2;
		return;
	}

	log('');
	log('迁移前对照（同名文件以 dev 为准，目标独有文件保留）：');
	for (const s of profileSummary(SRC)) { log(`  dev      profile=${s.profile}  chat-surface=${s.chatSurface}  sessions=${s.sessions}`); }
	for (const s of profileSummary(DST)) { log(`  packaged profile=${s.profile}  chat-surface=${s.chatSurface}  sessions=${s.sessions}`); }
	log(`  体积：dev ${(dirSize(SRC) / 1024 / 1024).toFixed(0)} MB，目标 ${(dirSize(DST) / 1024 / 1024).toFixed(0)} MB`);

	const backup = `${DST}.bak-${stamp()}`;
	log('');
	log(`计划：① 备份目标 → ${path.basename(backup)}；② 用 robocopy /E 把 dev 合并进目标（不删除目标多余文件）；③ 源目录保留。`);
	if (DRY) {
		log('');
		log('（--dry：只打印计划，未改动任何文件）');
		return;
	}

	const copy = (from, to, extra = []) => {
		const r = spawnSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', ...extra], { windowsHide: true });
		const code = r.status ?? -1;
		if (code >= 8) {
			throw new Error(`robocopy 失败（exit=${code}）：${from} → ${to}`);
		}
		return code;
	};

	log('');
	log(`[1/2] 备份目标 → ${backup}`);
	copy(DST, backup);
	log('      done');

	// 打包版历史上把 DSH_HOME 落在 `~/.dsh`（`isBuilt ? undefined` 的后果）⇒ 先把它的
	// sessions / storages / 凭据**补缺**进统一目录（`/XC /XN /XO` = 目标已有的一律不动），
	// 再让 dev 那份覆盖一遍 ⇒ 最终以 dev 为准，但打包版独有的历史会话不会丢 ✓。
	const LEGACY_DSH_HOME = path.join(os.homedir(), '.dsh');
	const dstDshHome = path.join(DST, 'dsh-home');
	if (fs.existsSync(LEGACY_DSH_HOME)) {
		log('');
		log('[1/3] 旧打包版 DSH_HOME（~/.dsh）补缺 → 目标/dsh-home（已有的一律不动）');
		fs.mkdirSync(dstDshHome, { recursive: true });
		const r = spawnSync('robocopy', [LEGACY_DSH_HOME, dstDshHome, '/E', '/XC', '/XN', '/XO',
			'/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', '/XF', 'host.json', 'host-port.json'], { windowsHide: true });
		const code = r.status ?? -1;
		log(code >= 8 ? `      ⚠ 补缺失败（exit=${code}），继续（只是少了几条历史会话）` : '      done');
	}

	log('[2/3] 合并 dev → 目标（同名以 dev 为准）');
	copy(SRC, DST, ['/XF', ...SKIP_FILES]);
	log('      done');

	// ★★ 2026-10-28（真机：迁移完桌面窗口卡在"正在启动后台服务…"直到超时）：
	//   profile 的 `package.json` / `pnpm-lock.yaml` 里，35 条依赖是 **绝对路径**
	//   （`file:C:/Users/<u>/.vssaros-dev/dsh-home/...`）⇒ 只搬文件不搬指针，等于
	//   ① 永远依赖旧目录还在（删掉旧目录就全坏）；② 每次启动 pnpm 都要重写整个依赖图
	//   （真机卡在 `dsh plugin add` 一分多钟 ⇒ 界面停在启动占位）✗✗。
	//   ⇒ 迁移必须把指针一起改到新根。
	const rewritten = rewriteProfilePointers(DST);
	log(`[3/3] 重写 profile 里的绝对路径（.vssaros-dev → .vssaros）：${rewritten.length ? rewritten.map(r => `${r.file}(${r.n})`).join('，') : '无需改写'}`);

	log('');
	log('迁移后对照：');
	for (const s of profileSummary(DST)) { log(`  target profile=${s.profile}  chat-surface=${s.chatSurface}  sessions=${s.sessions}`); }
	log('');
	log('✓ 完成。');
	log(`  · 源目录仍在：${SRC}（确认新实例正常后可自行删除）`);
	log(`  · 回滚：把 ${path.basename(DST)} 里的内容换回 ${path.basename(backup)}（同法 robocopy 反向即可）`);
	log('  · 下一步：按 F5（launch.json 与启动器都已指向 ~/.vssaros）');
};

main();
