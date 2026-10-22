#!/usr/bin/env node
/*
 * 一次性迁移：给已有 .canvas 的 text 节点补 **JSON Canvas 1.0 规范要求的 `text`** 字段。
 *
 * 背景：`kb_mindmap` 长期只写 `content`（LLM prompt 也这么要求），而规范里 text 节点的 `text`
 * 是 **required**（jsoncanvas.org/spec/1.0）⇒ 这些文件在 Obsidian 等遵循规范的工具里是**空节点**。
 * 生成侧已修（0.4.7：writeMindmap 写盘前补 text），但**已存在的旧文件不会自动补** ⇒ 本脚本补它们。
 *
 * 安全设计（动的是用户的库，必须保守）：
 *   · **默认 dry-run**：只统计与打印，不写任何文件；加 `--apply` 才真写。
 *   · `--apply` 时先**备份**到 `<root>/.canvas-text-migration-backup/<runId>/<相对路径>`，
 *     报告里给出备份目录（还原只靠它）。
 *   ⚠ 不动 `content`（合并去重 `_simpleKey` 还要用），只**新增** `text`；
 *     已有非空 `text` 的节点一律跳过（幂等，可重复跑）。
 *
 * 用法：
 *   node dsh-plugins/vssaros-kb/scripts/migrate-canvas-text.mjs                 # dry-run，扫默认库
 *   node dsh-plugins/vssaros-kb/scripts/migrate-canvas-text.mjs --apply         # 真写（带备份）
 *   node dsh-plugins/vssaros-kb/scripts/migrate-canvas-text.mjs "E:\某个库" --apply
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const verbose = argv.includes('--verbose');
const root = argv.find(a => !a.startsWith('--')) || 'E:/VsSarosVault';

/** 跳过这些目录（回收站 / 备份 / 依赖）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.trash', '.canvas-text-migration-backup']);

async function walk(dir, out) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) { continue; }
			await walk(join(dir, e.name), out);
			continue;
		}
		if (e.isFile() && e.name.toLowerCase().endsWith('.canvas')) { out.push(join(dir, e.name)); }
	}
}

/** 给 text 节点补 `text`（与 core/kbMindmap.js 的 withStandardText 同语义）。返回补了几个。 */
function fillText(mm) {
	let filled = 0;
	if (!mm || !Array.isArray(mm.nodes)) { return filled; }
	for (const node of mm.nodes) {
		if (!node || node.type !== 'text') { continue; }
		if (typeof node.text === 'string' && node.text) { continue; }
		if (typeof node.content === 'string') { node.text = node.content; filled++; }
	}
	return filled;
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = join(root, '.canvas-text-migration-backup', runId);

const files = [];
await walk(root, files);

let scanned = 0, changedFiles = 0, filledNodes = 0, alreadyOk = 0, parseErrors = 0, writeErrors = 0;
const changedList = [];

for (const file of files) {
	scanned++;
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (e) {
		console.log(`  ✗ 读不到：${file}（${e?.message ?? e}）`);
		parseErrors++;
		continue;
	}
	let mm;
	try {
		mm = JSON.parse(text);
	} catch (e) {
		console.log(`  ✗ JSON 解析失败（跳过，不改）：${relative(root, file)}（${e?.message ?? e}）`);
		parseErrors++;
		continue;
	}

	const before = (mm.nodes ?? []).filter(n => n?.type === 'text').length;
	const filled = fillText(mm);
	if (filled === 0) {
		if (before > 0) { alreadyOk++; }
		continue;
	}

	changedFiles++;
	filledNodes += filled;
	changedList.push({ file: relative(root, file), filled, before });

	if (verbose) { console.log(`  · ${relative(root, file)}：补 ${filled}/${before} 个 text 节点`); }

	if (apply) {
		try {
			const target = join(backupRoot, relative(root, file));
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, text, 'utf8');
			await writeFile(file, JSON.stringify(mm, null, '\t'), 'utf8');
		} catch (e) {
			writeErrors++;
			console.log(`  ✗ 写失败：${relative(root, file)}（${e?.message ?? e}）`);
		}
	}
}

console.log('');
console.log(`扫描根：${root}`);
console.log(`模式：${apply ? 'APPLY（已写入，带备份）' : 'DRY-RUN（未改任何文件）'}`);
console.log(`.canvas 文件：${scanned} 个`);
console.log(`需要补 text：${changedFiles} 个文件 / ${filledNodes} 个节点`);
console.log(`已经合规（跳过）：${alreadyOk} 个文件`);
if (parseErrors) { console.log(`解析/读取失败：${parseErrors} 个`); }
if (apply && writeErrors) { console.log(`写入失败：${writeErrors} 个`); }
if (apply && changedFiles > 0) { console.log(`备份目录：${backupRoot}`); }
if (!apply && changedFiles > 0) { console.log('\n确认无误后加 --apply 重跑（会先备份再写）。'); }
if (changedFiles > 0 && !verbose) {
	console.log('\n前 10 个待处理文件：');
	for (const c of changedList.slice(0, 10)) { console.log(`  · ${c.file}（${c.filled}/${c.before} 个节点）`); }
}
process.exit(writeErrors > 0 ? 1 : 0);
