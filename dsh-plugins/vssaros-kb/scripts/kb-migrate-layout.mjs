#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  kb-migrate-layout.mjs — 知识库目录改名迁移（`库`→`数据源`、`笔记`→`知识库列表`）
 *
 *  为什么需要它：改名不只是 `mv` 两个目录 ——
 *    ① `.feishu-sync.json` 的 `spaces`/`files` **键就是路径前缀**，不改 ⇒ 飞书会**重复建文档**（最贵的错误）
 *    ② `.kbkernel.json` 存的是**绝对路径**，改名后全失效 ⇒ 必须删掉重建
 *    ③ 正文里的相对链接 `](../库/raw/x.png)` 会断 ⇒ 需要重写
 *
 *  用法：
 *    node kb-migrate-layout.mjs --vault E:/VsSarosVault            # 只打印计划（dry-run，默认）
 *    node kb-migrate-layout.mjs --vault E:/VsSarosVault --apply    # 实际执行
 *    node kb-migrate-layout.mjs --vault E:/VsSarosVault --rollback # 回滚
 *
 *  幂等：已迁移的库再跑一次只会打印"已是新布局"。
 *  可回滚：改名前备份 `.feishu-sync.json` 为 `.feishu-sync.json.bak-<时间戳>`。
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OLD = { notes: '笔记', lib: '库' };
const NEW = { notes: '知识库列表', lib: '数据源' };
// ★ 2026-11-02：布局标记已收进 .kb/（其余元数据同）
const LAYOUT_FILE = '.kb/layout.json';
/*
 * 飞书同步索引的位置（★ 2026-11-02：已收进 `.kb/`）。
 *   · 新位置优先，老位置兜底 —— 迁移脚本要能同时处理"已搬"和"还没搬"的库
 */
const FEISHU_FILE_NEW = '.kb/feishu-sync.json';
const FEISHU_FILE_LEGACY = '.feishu-sync.json';
function feishuPathOf(vault) {
	const next = path.join(vault, FEISHU_FILE_NEW);
	return fs.existsSync(next) ? next : path.join(vault, FEISHU_FILE_LEGACY);
}
const KERNEL_FILE = '.kbkernel.json';
const HTML_CACHE = '.kb-html-cache';

const args = process.argv.slice(2);
const get = (k, d = '') => {
	const i = args.indexOf(k);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const VAULT = path.resolve(get('--vault', process.cwd()));
const APPLY = args.includes('--apply');
const ROLLBACK = args.includes('--rollback');

const log = (s) => console.log(s);
const has = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isRepo = () => has(path.join(VAULT, '.git'));

const countMd = (dir) => {
	let n = 0;
	const walk = (d, depth) => {
		if (depth > 8) { return; }
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const f of list) {
			if (f.name === '.git' || f.name === 'node_modules') { continue; }
			const p = path.join(d, f.name);
			if (f.isDirectory()) { walk(p, depth + 1); continue; }
			if (/\.md$/i.test(f.name)) { n += 1; }
		}
	};
	walk(dir, 0);
	return n;
};
const countAll = (dir) => {
	let n = 0;
	const walk = (d, depth) => {
		if (depth > 8) { return; }
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const f of list) {
			if (f.name === '.git' || f.name === 'node_modules') { continue; }
			const p = path.join(d, f.name);
			if (f.isDirectory()) { walk(p, depth + 1); continue; }
			n += 1;
		}
	};
	walk(dir, 0);
	return n;
};

/** git mv（保留历史）；不是仓库就退回 fs.rename */
const moveDir = (from, to) => {
	if (!has(from)) { return 'skip'; }
	if (has(to)) { throw new Error(`目标已存在：${to}（半迁移状态，请手工确认）`); }
	if (!APPLY) { return 'plan'; }
	if (isRepo()) {
		const r = spawnSync('git', ['mv', path.basename(from), path.basename(to)], { cwd: VAULT, encoding: 'utf8', windowsHide: true });
		if (r.status === 0) { return 'git-mv'; }
	}
	fs.renameSync(from, to);
	return 'rename';
};

/** 重写 `.feishu-sync.json` 的路径键前缀 */
function rewriteFeishu() {
	const p = feishuPathOf(VAULT);
	if (!has(p)) { return { skipped: true }; }
	const raw = fs.readFileSync(p, 'utf8');
	let j;
	try { j = JSON.parse(raw); } catch { return { error: 'JSON 解析失败' }; }

	const table = ROLLBACK
		? [[NEW.notes + '/', OLD.notes + '/'], [NEW.lib + '/', OLD.lib + '/']]
		: [[OLD.notes + '/', NEW.notes + '/'], [OLD.lib + '/', NEW.lib + '/']];

	const remapKey = (k) => {
		for (const [a, b] of table) { if (k.startsWith(a)) { return b + k.slice(a.length); } }
		return k;
	};
	const remapObj = (obj) => {
		if (!obj || typeof obj !== 'object') { return obj; }
		const out = {};
		for (const k of Object.keys(obj)) { out[remapKey(k)] = obj[k]; }
		return out;
	};

	const before = {
		spaces: j.spaces ? Object.keys(j.spaces).length : 0,
		files: j.files ? Object.keys(j.files).length : 0,
		mindmaps: j.mindmaps ? Object.keys(j.mindmaps).length : 0,
	};
	if (j.spaces) { j.spaces = remapObj(j.spaces); }
	if (j.files) { j.files = remapObj(j.files); }
	if (j.mindmaps) { j.mindmaps = remapObj(j.mindmaps); }
	const after = {
		spaces: j.spaces ? Object.keys(j.spaces).length : 0,
		files: j.files ? Object.keys(j.files).length : 0,
		mindmaps: j.mindmaps ? Object.keys(j.mindmaps).length : 0,
	};

	if (APPLY) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const bak = p + (ROLLBACK ? '.rollback-' : '.bak-') + stamp;
		fs.copyFileSync(p, bak);
		fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
	}
	return { before, after, ok: JSON.stringify(before) === JSON.stringify(after) };
}

/** 重写正文里的相对链接（只改"路径段"，不碰正文文字） */
function rewriteMdLinks() {
	const table = ROLLBACK
		? [[NEW.notes, OLD.notes], [NEW.lib, OLD.lib]]
		: [[OLD.notes, NEW.notes], [OLD.lib, NEW.lib]];

	/** 把 `库/` `笔记/` 这类**路径段**换掉（要求出现在开头或 `/` 之后） */
	const remapPath = (p) => {
		let out = p;
		for (const [a, b] of table) {
			out = out.split(a + "/").join(b + "/");
		}
		return out;
	};

	let files = 0;
	let edits = 0;
	const walk = (d, depth) => {
		if (depth > 8) { return; }
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const f of list) {
			if (f.name === ".git" || f.name === "node_modules") { continue; }
			const p = path.join(d, f.name);
			if (f.isDirectory()) { walk(p, depth + 1); continue; }
			if (!/\.md$/i.test(f.name)) { continue; }
			let s = "";
			try { s = fs.readFileSync(p, "utf8"); } catch { continue; }
			const t0 = s;
			// markdown 链接 / 图片：](<目标>)，目标里的相对路径重映射
			s = s.replace(/\]\(([^)\s]+)\)/g, (m, target) => {
				const t2 = remapPath(target);
				if (t2 !== target) { edits += 1; }
				return t2 === target ? m : "](" + t2 + ")";
			});
			// HTML 形式：src="<目标>"
			s = s.replace(/src="([^"]+)"/g, (m, target) => {
				const t2 = remapPath(target);
				if (t2 !== target) { edits += 1; }
				return t2 === target ? m : 'src="' + t2 + '"';
			});
			// wiki 双链：`[[库/x.md]]` —— **必须保留双方括号**（旧写法剥掉 [[ 是 bug）
			s = s.replace(/\[\[([^\]]+)\]\]/g, (m, inner) => {
				const t2 = remapPath(inner);
				if (t2 !== inner) { edits += 1; }
				return t2 === inner ? m : "[[" + t2 + "]]";
			});
			// frontmatter 列表项：`- 库/x.md`（保留缩进与 "- "）
			s = s.replace(/^(\s*-\s*)(库|笔记)\//gm, (m, pre, name) => {
				edits += 1;
				return pre + (name === "库" ? NEW.lib : NEW.notes) + "/";
			});
			if (s !== t0) {
				files += 1;
				if (APPLY) { fs.writeFileSync(p, s, "utf8"); }
			}
		}
	};
	walk(VAULT, 0);
	return { files, edits };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
log('  库：' + VAULT);
log('  模式：' + (ROLLBACK ? 'ROLLBACK（回滚）' : APPLY ? 'APPLY（执行）' : 'DRY-RUN（只打印）'));

const notesOld = path.join(VAULT, OLD.notes);
const notesNew = path.join(VAULT, NEW.notes);
const libOld = path.join(VAULT, OLD.lib);
const libNew = path.join(VAULT, NEW.lib);

// ① 状态判定
const state = ROLLBACK
	? { from: notesNew, to: notesOld, from2: libNew, to2: libOld }
	: { from: notesOld, to: notesNew, from2: libOld, to2: libNew };

const already = !has(state.from) && !has(state.from2) && has(state.to) && has(state.to2);
if (already) {
	log('  ✓ 已是' + (ROLLBACK ? '旧' : '新') + '布局，无需迁移');
	process.exit(0);
}
if (has(state.from) && has(state.to)) {
	console.error('  ✗ 半迁移状态：`' + path.basename(state.from) + '` 与 `' + path.basename(state.to) + '` 同时存在');
	process.exit(1);
}

// ② 迁移前统计
const stat = {};
for (const [k, p] of [['notes', notesOld], ['lib', libOld], ['notesNew', notesNew], ['libNew', libNew]]) {
	if (has(p)) { stat[k] = { md: countMd(p), all: countAll(p) }; }
}
log('\n  迁移前：');
Object.entries(stat).forEach(([k, v]) => log('    ' + k.padEnd(9) + v.all + ' 文件 · ' + v.md + ' md'));

// ③ 改目录
log('\n  ① 改目录');
for (const [from, to] of [[state.from, state.to], [state.from2, state.to2]]) {
	const r = moveDir(from, to);
	log('    ' + path.basename(from) + ' → ' + path.basename(to) + '  [' + r + ']');
	if (r === 'skip') { continue; }
}

// ④ 飞书键重写
log('\n  ② 飞书映射键重写（' + path.relative(VAULT, feishuPathOf(VAULT)) + '）');
const f = rewriteFeishu();
if (f.skipped) { log('    无该文件，跳过'); }
else if (f.error) { log('    ✗ ' + f.error); }
else {
	log('    spaces ' + f.before.spaces + '→' + f.after.spaces + ' · files ' + f.before.files + '→' + f.after.files
		+ (f.ok ? '  ✓ 数量一致' : '  ✗ 数量不一致，请检查'));
}

// ⑤ 正文相对链接
log('\n  ③ 正文相对链接（](../<旧名>/… → ../<新名>/…）');
const lk = rewriteMdLinks();
log('    待改写文件 ' + lk.files + ' 个' + (APPLY ? '（已写）' : '（dry-run 未写）'));

// ⑥ 索引与缓存（绝对路径已失效）
log('\n  ④ 清理派生数据（可由重建产生）');
for (const name of [KERNEL_FILE, HTML_CACHE]) {
	const p = path.join(VAULT, name);
	if (!has(p)) { log('    ' + name + ' 不存在'); continue; }
	if (APPLY) {
		fs.rmSync(p, { recursive: true, force: true });
		log('    已删 ' + name);
	} else { log('    将删 ' + name); }
}

// ⑥.5 ★ 2026-11-02（用户报「知识库不显示内容」）：删完索引**必须立刻重建**，
//   否则页面按索引渲染 ⇒ 全 0 篇、看起来像空白（要等用户手动点"重建"才恢复 ✗）。
if (APPLY && !ROLLBACK) {
	log('\n  ④.5 重建索引（删了就必须补，否则界面空白）');
	try {
		const mod = await import(new URL('../lib/core/kbKernelBuild.js', import.meta.url).href);
		const r = await mod.rebuildKernelCache(VAULT);
		const docs = Array.isArray(r?.docs) ? r.docs.length : 0;
		log('    已重建：' + docs + ' 篇');
	} catch (e) {
		log('    ⚠ 重建失败（可稍后在界面点「重建索引」）：' + String((e && e.message) || e).slice(0, 120));
	}
}

// ⑦ 布局标记
log('\n  ⑤ 写布局标记');
const layoutPath = path.join(VAULT, LAYOUT_FILE);
if (APPLY) {
	fs.writeFileSync(layoutPath, JSON.stringify({
		version: ROLLBACK ? 1 : 2,
		notesDir: ROLLBACK ? OLD.notes : NEW.notes,
		libraryDir: ROLLBACK ? OLD.lib : NEW.lib,
		migratedAt: new Date().toISOString(),
	}, null, 2), 'utf8');
	log('    已写 ' + LAYOUT_FILE);
} else { log('    将写 ' + LAYOUT_FILE); }

// ⑧ 校验
if (APPLY) {
	log('\n  ⑥ 校验');
	const after = {};
	for (const [k, p] of [['notes', state.to], ['lib', state.to2]]) {
		if (has(p)) { after[k] = { md: countMd(p), all: countAll(p) }; }
	}
	let ok = true;
	for (const [k, v] of Object.entries(after)) {
		log('    ' + k.padEnd(6) + v.all + ' 文件 · ' + v.md + ' md');
	}
	const beforeAll = (stat.notes ? stat.notes.all : 0) + (stat.lib ? stat.lib.all : 0);
	const afterAll = (after.notes ? after.notes.all : 0) + (after.lib ? after.lib.all : 0);
	if (beforeAll !== afterAll) { ok = false; log('    ✗ 文件总数不一致：' + beforeAll + ' → ' + afterAll); }
	else { log('    ✓ 文件总数一致（' + afterAll + '）'); }
	process.exitCode = ok ? 0 : 2;
} else {
	log('\n  （dry-run 结束；加 --apply 执行）');
}
