#!/usr/bin/env node
/*
 * 把 `知识库列表/` 重组成**扁平主题库**（★ 2026-11-02，用户指定）。
 *
 * 目标结构（`知识库列表/` 下只有这 5 个，平级 = 一个知识库）：
 *   AIAgent / ComfyUI技术 / UnrealEngine / 财经 / 游戏设计
 *
 * 做四件事：
 *   ① 目录归并（旧的一级库 + 二级子目录 → 目标库）
 *   ② 空目录清理、根散文件归档到 `.archive-<日期>/`（点开头 ⇒ UI 不显示）
 *   ③ **重写 `.feishu-sync.json` 的路径键**（不改会重复上传，之前的教训）
 *   ④ 删旧索引 + 重建（`.kbkernel.json` 里是绝对路径，改名后全失效）
 *
 * 用法：
 *   node scripts/kb-reorg-topics.mjs --vault "E:/VsSarosVault"            # 干跑（只看计划）
 *   node scripts/kb-reorg-topics.mjs --vault "E:/VsSarosVault" --apply    # 真做
 *
 * 安全：只动 `知识库列表/` 内部；`数据源/`、`.git`、`.feishu-sync.json` 之外的元数据都不碰。
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const vaultArg = argv.indexOf('--vault');
const VAULT = path.resolve(vaultArg >= 0 ? argv[vaultArg + 1] : '');
const NOTES = '知识库列表';
const LIST = path.join(VAULT, NOTES);

const log = (s) => console.log(s);

if (!VAULT || !fs.existsSync(LIST)) {
	log('✗ 用法：--vault <库根>（且其下要有 ' + NOTES + '/）');
	process.exit(1);
}

/* ── 归并计划（`from` 相对 `知识库列表/`；`to` 也是） ───────────────────── */
const MOVES = [
	{ from: '01_学习/AI_Agent', to: 'AIAgent' },
	{ from: '01_学习/AI应用', to: 'AIAgent/AI应用' },
	{ from: '01_学习/ComfyUI技术', to: 'ComfyUI技术' },
	{ from: '01_学习/UnrealEngine', to: 'UnrealEngine' },
	{ from: '01_学习/投资', to: '财经/投资' },
	{ from: '01_学习/游戏设计', to: '游戏设计' },
];

/** 目标库（最终只应有这几个一级目录） */
const TARGET_KBS = ['AIAgent', 'ComfyUI技术', 'UnrealEngine', '财经', '游戏设计'];

/** 空目录：确认里面没有任何文件才删（有东西就跳过并报出来） */
const EMPTY_DIRS = [
	'01_学习/VsCode',
	'01_学习/游戏案例拆解',
	'01_学习/财经',
	'02_工作/GR',
	'02_工作/VsSaros',
	'02_工作',
	'03_生活',
	'01_学习',
];

const ARCHIVE_DIR = '.archive-' + new Date().toISOString().slice(0, 10);

/* ── 小工具 ──────────────────────────────────────────────────────────── */
const has = (p) => fs.existsSync(p);
/**
 * 统计文件数。
 * @param {string} dir
 * @param {{ mdOnly?: boolean }} [opt]
 *
 * ⚠ 默认**跳过点开头的文件**（`.overview.md` 这类是生成物）：否则"空目录"永远不空 ⇒
 *   `01_学习` 删不掉、校验时多出一个一级目录（2026-11-02 干跑踩到）。
 */
const countFiles = (dir, opt = {}) => {
	let n = 0;
	const walk = (p, d) => {
		if (d > 8) { return; }
		let list = [];
		try { list = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
		for (const f of list) {
			if (f.name.startsWith('.')) { continue; }
			const q = path.join(p, f.name);
			if (f.isDirectory()) { walk(q, d + 1); continue; }
			if (opt.mdOnly && !/\.md$/i.test(f.name)) { continue; }
			n += 1;
		}
	};
	walk(dir, 0);
	return n;
};

/* ── ① 预检 ──────────────────────────────────────────────────────────── */
log('═'.repeat(64));
log('库：' + VAULT);
log('模式：' + (APPLY ? '★ APPLY（真改）' : 'dry-run（只看，不改）'));
log('═'.repeat(64));

let bad = 0;
for (const m of MOVES) {
	const from = path.join(LIST, m.from);
	const to = path.join(LIST, m.to);
	if (!has(from)) { log('  ⚠ 源不存在，跳过：' + m.from); continue; }
	if (has(to)) {
		// 目标是"目录容器"（如 AIAgent/AI应用、财经/投资）时允许合并；目标是库根时说明冲突
		const isContainer = m.to.includes('/');
		log('  ' + (isContainer ? '· 合并进已存在目录：' : '✗ 目标已存在（会冲突）：') + m.to);
		if (!isContainer) { bad += 1; }
	}
	if (from === m.to) { log('  ⚠ from === to：' + m.from); bad += 1; }
}
if (bad) {
	log('\n✗ 预检失败（' + bad + ' 项冲突），未做任何改动。请先处理上面标 ✗ 的目录。');
	process.exit(1);
}

/* ── ② 目录归并 ──────────────────────────────────────────────────────── */
log('\n① 目录归并');
for (const m of MOVES) {
	const from = path.join(LIST, m.from);
	const to = path.join(LIST, m.to);
	if (!has(from)) { log('   · 跳过（源不存在）：' + m.from); continue; }
	if (m.to.includes('/')) {
		// 作为子目录合并：父目录建好，再把 from 整体搬到 to
		const parent = path.dirname(to);
		if (APPLY && !has(parent)) { fs.mkdirSync(parent, { recursive: true }); }
		if (APPLY && has(to)) {
			// 已存在同名子目录 ⇒ 内容并进去（逐项搬，冲突则改名保留两边）
			for (const e of fs.readdirSync(from, { withFileTypes: true })) {
				let dst = path.join(to, e.name);
				if (has(dst)) { dst = path.join(to, e.name.replace(/(\.[^.]*)?$/, '-from-' + path.basename(from) + '$1')); }
				fs.renameSync(path.join(from, e.name), dst);
			}
			fs.rmSync(from, { recursive: true, force: true });
			log('   ✓ 合并 ' + m.from + ' → ' + m.to + '（同名项已改名保留）');
		} else {
			if (APPLY) { fs.renameSync(from, to); }
			log('   ✓ ' + (APPLY ? '' : '将 ') + '移动 ' + m.from + ' → ' + m.to);
		}
	} else {
		if (has(to)) {
			// 目标库已存在（例如 财经 先建了）：把 from 的内容并进去
			if (APPLY) {
				for (const e of fs.readdirSync(from, { withFileTypes: true })) {
					let dst = path.join(to, e.name);
					if (has(dst)) { dst = path.join(to, e.name.replace(/(\.[^.]*)?$/, '-from-' + path.basename(from) + '$1')); }
					fs.renameSync(path.join(from, e.name), dst);
				}
				fs.rmSync(from, { recursive: true, force: true });
			}
			log('   ✓ ' + (APPLY ? '' : '将 ') + '并入 ' + m.from + ' → ' + m.to);
		} else {
			if (APPLY) { fs.renameSync(from, to); }
			log('   ✓ ' + (APPLY ? '' : '将 ') + '改名 ' + m.from + ' → ' + m.to);
		}
	}
}

/* ── ③ 空目录清理 ────────────────────────────────────────────────────── */
log('\n② 清理空目录（只删"零文件"的）');
/**
 * 干跑时目录还没真搬 ⇒ 用"现有数 − 将被搬走的子目录数"判断是否真会变空。
 * （否则 `01_学习` 永远显示"还有 77 个文件"，看起来像不能删 ✗）
 */
const remainingAfterMoves = (dir) => {
	let n = countFiles(path.join(LIST, dir));
	for (const m of MOVES) {
		if (m.from === dir) { return 0; }                      // 整个目录被搬走
		if (m.from.startsWith(dir + '/')) { n -= countFiles(path.join(LIST, m.from)); }
	}
	return Math.max(0, n);
};
for (const d of EMPTY_DIRS) {
	const p = path.join(LIST, d);
	if (!has(p)) { continue; }
	const n = remainingAfterMoves(d);
	if (n > 0) { log('   ! 保留（还有 ' + n + ' 个文件）：' + d); continue; }
	if (APPLY) { fs.rmSync(p, { recursive: true, force: true }); }
	log('   ✓ ' + (APPLY ? '' : '将 ') + '删除空目录 ' + d);
}

/* ── ④ 根散文件归档 ──────────────────────────────────────────────────── */
log('\n③ 归档根下散文件 → ' + ARCHIVE_DIR + '/（点开头 ⇒ UI 不当成知识库）');
const rootEntries = fs.readdirSync(LIST, { withFileTypes: true });
let archived = 0;
for (const e of rootEntries) {
	if (e.isDirectory()) { continue; }
	const src = path.join(LIST, e.name);
	if (APPLY) {
		const dstDir = path.join(LIST, ARCHIVE_DIR);
		if (!has(dstDir)) { fs.mkdirSync(dstDir, { recursive: true }); }
		fs.renameSync(src, path.join(dstDir, e.name));
	}
	log('   ✓ ' + (APPLY ? '' : '将 ') + '归档 ' + e.name);
	archived += 1;
}
if (!archived) { log('   · 没有散文件'); }

/* ── ⑤ 飞书键重写 ────────────────────────────────────────────────────── */
log('\n④ 重写 .feishu-sync.json 的路径键');
const FEISHU = path.join(VAULT, '.feishu-sync.json');
let feishuStat = '无文件';
if (has(FEISHU)) {
	const raw = fs.readFileSync(FEISHU, 'utf8');
	const j = JSON.parse(raw);
	const spaces0 = Object.keys(j.spaces || {});
	const files0 = Object.keys(j.files || {});

	// 长前缀优先（避免 01_学习/AI_Agent 抢了 01_学习/AI应用 的匹配）
	const PREFIX = MOVES
		.map((m) => [NOTES + '/' + m.from, NOTES + '/' + m.to])
		.sort((a, b) => b[0].length - a[0].length);

	const rewrite = (k) => {
		for (const [a, b] of PREFIX) {
			if (k === a) { return b; }
			if (k.startsWith(a + '/')) { return b + k.slice(a.length); }
		}
		return k;
	};

	const spaces = {};
	let spHit = 0;
	for (const [k, v] of Object.entries(j.spaces || {})) {
		const nk = rewrite(k);
		if (nk !== k) { spHit += 1; log('   · ' + k + ' → ' + nk); }
		else if (k === '01_学习' || k === NOTES + '/01_学习') { log('   · （历史库级键，无对应目录，原样保留）' + k); }
		spaces[nk] = v;
	}
	const files = {};
	let flHit = 0;
	for (const [k, v] of Object.entries(j.files || {})) {
		const nk = rewrite(k);
		if (nk !== k) { flHit += 1; }
		files[nk] = v;
	}

	log('   spaces ' + spaces0.length + ' 条（改写 ' + spHit + '）· files ' + files0.length + ' 条（改写 ' + flHit + '）');
	// 数量必须守恒（只换键不丢条目）
	if (Object.keys(spaces).length !== spaces0.length || Object.keys(files).length !== files0.length) {
		log('   ✗ 条目数变了！中止（未写盘）');
		process.exit(1);
	}
	if (APPLY) {
		const bak = FEISHU + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
		fs.writeFileSync(bak, raw, 'utf8');
		fs.writeFileSync(FEISHU, JSON.stringify(Object.assign({}, j, { spaces, files }), null, 2), 'utf8');
		log('   ✓ 已写回（备份：' + path.basename(bak) + '）');
	} else {
		log('   · dry-run 未写盘');
	}
	feishuStat = 'spaces ' + spaces0.length + '→' + Object.keys(spaces).length + ' · files ' + files0.length + '→' + Object.keys(files).length;
}

/* ── ⑥ 索引重建 ──────────────────────────────────────────────────────── */
log('\n⑤ 重建索引（绝对路径已失效）');
for (const name of ['.kbkernel.json', '.kb-html-cache']) {
	const p = path.join(VAULT, name);
	if (!has(p)) { continue; }
	if (APPLY) { fs.rmSync(p, { recursive: true, force: true }); }
	log('   ✓ ' + (APPLY ? '' : '将 ') + '删除 ' + name);
}
if (APPLY) {
	try {
		const mod = await import(new URL('../lib/core/kbKernelBuild.js', import.meta.url).href);
		const r = await mod.rebuildKernelCache(VAULT);
		const docs = Array.isArray(r?.docs) ? r.docs.length : 0;
		log('   ✓ 已重建：' + docs + ' 篇');
	} catch (e) {
		log('   ⚠ 重建失败（界面里可手动重建）：' + String((e && e.message) || e).slice(0, 140));
	}
}

/* ── ⑦ 布局标记 + 校验 ───────────────────────────────────────────────── */
if (APPLY) {
	fs.mkdirSync(path.join(VAULT, '.kb'), { recursive: true });
	fs.writeFileSync(path.join(VAULT, '.kb/layout.json'), JSON.stringify({
		version: 3,
		layout: 'topics',
		topics: TARGET_KBS,
		reorganizedAt: new Date().toISOString(),
	}, null, 2), 'utf8');
}

log('\n⑥ 校验');
const now = fs.readdirSync(LIST, { withFileTypes: true })
	.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
	.map((e) => e.name);
log('   一级目录（= 知识库）：' + (now.length ? now.join(' / ') : '(空)'));
const expect = TARGET_KBS.slice().sort().join(',');
const actual = now.slice().sort().join(',');
log('   ' + (actual === expect ? '✓ 与目标一致' : '✗ 与目标不一致（期望 ' + expect + '）'));
let total = 0;
for (const k of now) {
	const n = countFiles(path.join(LIST, k), { mdOnly: true });
	total += n;
	log('     · ' + k.padEnd(14) + n + ' 篇');
}
log('   合计 = ' + total + ' 篇（重组前 md = 76，应保持一致）');
log('   飞书 = ' + feishuStat);

log('\n' + (APPLY ? '✓ 完成（git 里可用 `git status` 复核；如需回滚：git checkout -- . 或从 .archive-' + new Date().toISOString().slice(0, 10) + '/ 取回）' : '· 这是 dry-run，加 --apply 才会真改'));
