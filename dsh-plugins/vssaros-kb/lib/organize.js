// @vssaros/dsh-kb — `kb_organize` 的**写路径**（唯一会改盘的地方之一 ✓，另一个是 `kb_feishu_sync` 的随包脚本）。
//
// 为什么单开一个文件（而不是塞进 `store.js` ✗）：`store.js` 的不变量是"**只读**" ✓（页面/工具都靠它读 ✓），
// 把写操作混进去会让那条不变量作废 ✗ —— 而这轮的整个主题就是"写操作必须显式、可审计、可还原" ✓。
//
// 三条安全规则（照真源 ✓，全部实测断言在 `p3-08`）：
//   ① **围栏**：只在 `<vault>/笔记/` 之内动 ✓（`core/kbOrganize.js` 的 `resolveOrganizePath` ✓）；
//   ② **不覆盖**：`moves` 的目标已存在 ⇒ 拒该项 ✓（静默覆盖是数据丢失里最坏的一种 ✗）；
//   ③ **没有还原点就不动手**：`moves` 先备份、备份失败就拒该项 ✓（dsh 侧没有聊天页签 undoAll ✗ ⇒
//      备份目录是**唯一**的还原点 ✓）；`deletes` 本身即"移入备份" ✓。
//
// ⚠ 2026-10-14 加的 **`copies`**（§16.20）在 ②③ 上是**例外** ✓，理由在它那段注释里（源文件不动 ⇒
//   无损失可还原 ✓）；但 ①（围栏）**照旧** ✓ —— 复制也不能越出「笔记」区 ✓。
//
// 2026-10-12：本文件同时承载 `kb_write_note` / `kb_mkdir`（写正文）—— 它们**沿用同三条规则** ✓
// （同一份 `resolveOrganizePath`、同一套 vault 外备份、同样"先校验后 I/O"）。理由写在 `writeNote` 上方 ✓。
import { mkdir, readdir, readFile, rename, copyFile, cp, stat, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backupDirFor, incrementalCopyName, resolveOrganizePath, stampOf } from './core/kbOrganize.js';
// 导航文件（`笔记/index.md` / `笔记/overview.md`）：生成逻辑逐字照真源，见 core/kbNavigation.js 文件头 ✓
import { buildNavigationFiles, selectNoteFiles } from './core/kbNavigation.js';
// 去抽象化门控（导航之后跑，真源同序 ✓）：纯逻辑见 core/kbGating.js 文件头 ✓
import { EMPTY_ALIASES, KB_ALIASES_FILE } from './core/kbAliases.js';
import { planGating } from './core/kbGating.js';
import { planEnrichment } from './core/kbEnrich.js';
// 图谱洞察（导航三件之一，与真源 `maintainKbNavigation` 同集合 ✓）：纯逻辑见 core/kbInsights.js ✓
import { buildInsightsFile } from './core/kbInsights.js';

/** 存在吗（不抛 ✓）。 */
async function exists(abs) {
	try { await stat(abs); return true; } catch { return false; }
}

/**
 * 移动：同盘用 `rename` ✓（备份目录是 vault 的兄弟 ⇒ 通常同盘 ✓）；跨盘（EXDEV ✗）退回复制+删源 ✓。
 * `overwrite` 只给 `deletes` 那条路用 ✓（备份目录里的同名残留不该挡住搬运 ✓）。
 */
async function moveFile(from, to, overwrite) {
	try {
		await rename(from, to);
		return;
	} catch (e) {
		if (e?.code !== 'EXDEV') { throw e; }
		await copyFile(from, to);
		await unlink(from);
	}
	void overwrite;
}

/**
 * 执行一次整理。
 * 执行顺序：`creates` → `moves` → **`copies`** → `deletes` ✓（复制排在移动之后：先把位置理好、
 * 再按最终位置复制 ✓；删除放最后 ⇒ 被删的还能作为复制源 ✓ —— 真源的 organize 没有复制动词 ✓，
 * 这个次序是我们的选择，写在参数表里 ✓）。
 * @param {{ vaultRoot: string, moves?: unknown[], creates?: unknown[], copies?: unknown[], deletes?: unknown[], now?: Date }} input
 * @returns `{ moved, copied, created, deletedToBackup, skipped, backupDir, backupUsed }`
 *   路径一律归一成 `/` 分隔的**绝对**路径 ✓（与真源的 fsPath 同口径，但跨平台可读 ✓）。
 */
export async function runOrganize({ vaultRoot, moves = [], creates = [], copies = [], deletes = [], now = new Date() }) {
	const backupDir = backupDirFor(vaultRoot, stampOf(now));
	// ★ 2026-10-12 修的既有缺陷（实测复现，见下面收尾那段的注释）：时间戳精度是**分钟**
	//	（`stampOf` 取 12 位 ✓ 照真源）⇒ 同一分钟内的多次调用**共用**同一个备份目录 ✗。
	//	所以必须先记下"这个目录是不是本来就存在"，收尾时才知道该不该清空它 ✓。
	const backupDirExisted = await exists(backupDir);
	const moved = [];
	const copied = [];
	const created = [];
	const deletedToBackup = [];
	const skipped = [];
	let backupUsed = false;

	// ── 1. 新建目录（先做：后面的 move 才好把文件放进去 ✓，与真源同序 ✓）──────────────────
	for (const item of Array.isArray(creates) ? creates : []) {
		const r = resolveOrganizePath(vaultRoot, item);
		if (r.why) { skipped.push({ item: String(item), why: r.why }); continue; }
		try {
			await mkdir(r.abs, { recursive: true });
			created.push(r.abs);
		} catch (e) {
			skipped.push({ item: r.abs, why: `建目录失败：${String(e?.message ?? e)}` });
		}
	}

	// ── 2. 移动 / 重命名 ───────────────────────────────────────────────────────────────────
	for (const m of Array.isArray(moves) ? moves : []) {
		const label = `${String(m?.from ?? '?')} → ${String(m?.to ?? '?')}`;
		const from = resolveOrganizePath(vaultRoot, m?.from);
		const to = resolveOrganizePath(vaultRoot, m?.to);
		if (from.why || to.why) { skipped.push({ item: label, why: from.why || to.why }); continue; }
		if (from.abs.toLowerCase() === to.abs.toLowerCase()) { skipped.push({ item: label, why: 'from 与 to 相同' }); continue; }
		if (!(await exists(from.abs))) { skipped.push({ item: label, why: 'from 不存在' }); continue; }
		if (await exists(to.abs)) { skipped.push({ item: label, why: 'to 已存在（不覆盖）' }); continue; }
		try {
			// ③ 先备份（dsh 侧唯一的还原点 ✓）：备份失败 ⇒ 这一项不搬 ✓
			await mkdir(dirname(backupDirOf(backupDir, vaultRoot, from.abs)), { recursive: true });
			await copyFile(from.abs, backupDirOf(backupDir, vaultRoot, from.abs));
			backupUsed = true;
			await mkdir(dirname(to.abs), { recursive: true });
			await moveFile(from.abs, to.abs, false);
			moved.push({ from: from.abs, to: to.abs });
		} catch (e) {
			skipped.push({ item: label, why: String(e?.message ?? e) });
		}
	}

	// ── 3. 复制（2026-10-14 §16.20，照真源的 **Ctrl 拖拽** ✓）────────────────────────────────
	// 与 moves 的规则**三处相反/不同**，都照真源：
	//   · **撞名不拒、改自动增量名** ✓（`甲 copy.md` / `甲 copy 2.md` ✓ 真源 :4066-4069 的复制分支 ✓
	//     —— 而 moves 那条是真源 :4077-4081 的"确认替换"，我们拒 ✓）；
	//   · **不备份** ✓：备份的意义是"还原点"（本文件第 ③ 条 ✓），而复制**不动源文件** ⇒ 没有需要还原的损失 ✓；
	//   · **目录也能复制**（递归 ✓ 真源走 `workingCopyFileService.copy` 亦然 ✓）——但**不许复制进自己内部** ✗
	//     （`x/ → x/y/` 会边复制边产生新内容 ⇒ 无底洞 ✓）⇒ 拒该项 ✓。
	// ⚠ 撞名的判定用**读一次目录**的集合 ✓（比真源 99 次 stat 省 ✓，同锁内等价 ✓）；Windows 上文件名
	//   大小写不敏感 ⇒ 集合**按小写**比 ✓（否则 `甲 COPY.md` 会被判成"没占用" ⇒ 覆盖 ✗）。
	for (const c of Array.isArray(copies) ? copies : []) {
		const label = `${String(c?.from ?? '?')} → ${String(c?.to ?? '?')}`;
		const from = resolveOrganizePath(vaultRoot, c?.from);
		const to = resolveOrganizePath(vaultRoot, c?.to);
		if (from.why || to.why) { skipped.push({ item: label, why: from.why || to.why }); continue; }
		if (!(await exists(from.abs))) { skipped.push({ item: label, why: 'from 不存在' }); continue; }
		// `to` 在 `from` 内部 ⇒ 递归无底 ✗（两端都已归一成 `/` 分隔 ⇒ 前缀比就够 ✓）
		if (`${to.abs}/`.toLowerCase().startsWith(`${from.abs}/`.toLowerCase())) {
			skipped.push({ item: label, why: 'to 在 from 内部' });
			continue;
		}
		try {
			const src = await stat(from.abs);
			let target = to.abs;
			if (await exists(target)) {
				// ⚠ 增量名那一段**不许用 `dirname` / `join`** ✗：那两个是**平台分隔符**（Windows 给 `\` ✓），
				//   而 `resolveOrganizePath` 的 `abs` 一律是 `/` 归一形式 ✓ ⇒ 混用会让回执里的落点变成
				//   "g:\a\b/甲 copy.md" 这种**半反斜杠**路径 ✗（2026-10-14 被 p3-87 ⑥-b 咬出来：
				//   页面把它当"相对路径"切名字 ⇒ 提示里印出**一长串绝对路径** ✓）。
				const cut = target.lastIndexOf('/');
				const dir = cut >= 0 ? target.slice(0, cut) : target;
				const listed = await readdir(dir).catch(() => []);
				const taken = new Set(listed.map(entry => String(entry).toLowerCase()));
				const picked = incrementalCopyName(target.slice(cut + 1), name => taken.has(String(name).toLowerCase()));
				target = `${dir}/${picked}`;
			}
			await mkdir(dirname(target), { recursive: true });
			if (src.isDirectory()) { await cp(from.abs, target, { recursive: true }); }
			else { await copyFile(from.abs, target); }
			copied.push({ from: from.abs, to: target });
		} catch (e) {
			skipped.push({ item: label, why: String(e?.message ?? e) });
		}
	}

	// ── 4.「删除」= 移入备份目录（回收站语义 ✓，真源同款 ✓）─────────────────────────────────
	for (const item of Array.isArray(deletes) ? deletes : []) {
		const u = resolveOrganizePath(vaultRoot, item);
		if (u.why) { skipped.push({ item: String(item), why: u.why }); continue; }
		if (!(await exists(u.abs))) { skipped.push({ item: u.abs, why: '不存在' }); continue; }
		const dest = backupDirOf(backupDir, vaultRoot, u.abs);
		try {
			await mkdir(dirname(dest), { recursive: true });
			await moveFile(u.abs, dest, true);
			deletedToBackup.push(u.abs);
			backupUsed = true;
		} catch (e) {
			skipped.push({ item: u.abs, why: String(e?.message ?? e) });
		}
	}

	// 备份目录建了却没放东西 ⇒ 收掉（不留空目录噪音 ✓；只在**确实建过**时才动 ✓）。
	//
	// ★★ 2026-10-12 修：原先只判 `!backupUsed` ⇒ 把"**别人**（同一分钟内的前一次调用）写过东西的备份目录"
	//	也一起删了 ✗✗。实测（两次调用用同一个 `now`）：第一次删除入备份 ⇒ 备份里有 `笔记/旧目录/丙.md`；
	//	紧接着一次**只建目录**（backupUsed=false）的调用 ⇒ 那条备份**整个消失** ✗。
	//	为什么这是最坏的一档：dsh 侧**没有**聊天页签的 undoAll ⇒ 那个备份目录是**唯一的还原点** ✓
	//	（本文件开头第 ③ 条）⇒ 删掉它 = 已执行的删除/移动**不可挽回** ✗。
	//	判据因此从"这次没放东西"改成"**这个目录是我这次建的**" ✓（两个条件都要满足才清）。
	if (!backupUsed && !backupDirExisted) { await rm(backupDir, { recursive: true, force: true }); }
	return { moved, copied, created, deletedToBackup, skipped, backupDir: backupUsed ? backupDir : '', backupUsed };
}

/** 备份目标路径 = 备份目录 + 该文件**相对 vault 根**的路径 ✓（保留 `笔记/01_学习/…` 结构 ⇒ 可原样放回 ✓）。 */
function backupDirOf(backupDir, vaultRoot, abs) {
	const root = String(vaultRoot).replace(/\\/g, '/').replace(/\/+$/, '');
	const rest = String(abs).replace(/\\/g, '/').replace(root, '').replace(/^\/+/, '');
	return `${backupDir}/${rest}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 写正文（`kb_write_note` / `kb_mkdir`，2026-10-12）
//
// ★ 为什么**不**让模型直接用 dsh 原生 `write` / `edit`：那两个工具受沙箱围栏
//   （`workspace-write` = 会话工作区 ＋ 平台 temp），而 vault 与数据根都在围栏**外**
//   ⇒ 模型改笔记只会拿到 `FS_SANDBOX_DENIED` ✗（报告 R.8 的实测结论 ✓）。
//   ⇒ 这里给出本模块**自己的**写路径，并沿用与 `runOrganize` **同一套**安全规则 ✓：
//     ① 围栏 = `<vault>/笔记/` 之内（同一个 `resolveOrganizePath` ✓，不另写一份判断 ✗）；
//     ② **不静默覆盖**：缺省只许新建（目标已存在 ⇒ 拒）；`mode:'replace'` 才覆盖，
//        且覆盖前把旧正文复制进 **vault 之外的备份目录** ✓（dsh 侧没有 undoAll ⇒ 那是唯一还原点 ✓）；
//     ③ 校验**在任何 I/O 之前**（路径 / 类型 / 长度），每条拒绝路径都可单测 ✓。
// ─────────────────────────────────────────────────────────────────────────────

/** 单篇正文的长度上限（防一次写入把上下文/磁盘搞坏 ✓；比 `kb_read` 的上限 200k 略宽）。 */
export const MAX_NOTE_CHARS = 256 * 1024;

/**
 * 写一篇笔记正文。
 * @param {{ vaultRoot: string, relPath: unknown, content: unknown, mode?: unknown, now?: Date }} input
 * @returns `{ ok: true, path, created, bytes, backupDir, backupUsed, mode }` 或 `{ ok: false, error }`
 */
export async function writeNote({ vaultRoot, relPath, content, mode = 'create', now = new Date() }) {
	if (mode !== 'create' && mode !== 'replace') {
		return { ok: false, error: `未知的 mode：${String(mode)}（支持 create / replace）` };
	}
	if (typeof relPath !== 'string' || !relPath.trim()) {
		return { ok: false, error: '缺少 path（vault 内相对路径，形如 笔记/主题/标题.md）' };
	}
	if (typeof content !== 'string') {
		return { ok: false, error: `content 必须是字符串（收到 ${typeof content}）` };
	}
	if (content.length > MAX_NOTE_CHARS) {
		return { ok: false, error: `正文过大（${content.length} 字 > ${MAX_NOTE_CHARS}）⇒ 请拆分或精简。` };
	}
	const target = resolveOrganizePath(vaultRoot, relPath);   // ① 先校验、后 I/O ✓
	if (target.why) {
		return { ok: false, error: target.why };
	}
	const alreadyThere = await exists(target.abs);
	if (alreadyThere && mode === 'create') {
		// 不静默覆盖 ✓：报错里给出"要覆盖该怎么做"，别让模型自己猜路径规则 ✓
		return { ok: false, error: `目标已存在（不覆盖）：${target.abs} —— 要覆盖请显式传 mode='replace'（会先把旧正文移入备份 ✓）。` };
	}
	let backupDir = '';
	if (alreadyThere) {
		backupDir = backupDirFor(vaultRoot, stampOf(now));
		const dest = backupDirOf(backupDir, vaultRoot, target.abs);
		try {
			await mkdir(dirname(dest), { recursive: true });
			await copyFile(target.abs, dest);   // ② 覆盖前先留还原点（写不进去就不覆盖 ✓）
		} catch (e) {
			return { ok: false, error: `备份旧正文失败 ⇒ 未覆盖：${String(e?.message ?? e)}` };
		}
	}
	try {
		await mkdir(dirname(target.abs), { recursive: true });
		await writeFile(target.abs, content, { encoding: 'utf8' });
	} catch (e) {
		return { ok: false, error: `写入失败：${String(e?.message ?? e)}` };
	}
	return {
		ok: true,
		path: target.abs,
		created: !alreadyThere,
		mode,
		bytes: Buffer.byteLength(content, 'utf8'),
		backupDir: backupDir || undefined,
		backupUsed: !!backupDir,
	};
}

/**
 * ★ 页面「新建文件 / 新建文件夹」的**唯一命名规则**（2026-10-14 §16.18）——
 * **逐字照真源** `knowledgeBaseView.ts:2353-2365` 的 `uniqueName` ✓：
 * `未命名.md` ⇒ `未命名 (1).md` ⇒ `未命名 (2).md`…（**空格 ＋ 括号** ✓，别写成 `-2` ✗ —— 那是
 * 思维导图改名那条的规则，两处**本来就不同** ✓）。
 * @returns 可用的**文件名**（不带目录 ✓）
 */
export async function uniqueChildName(dir, base, ext = '') {
	let candidate = base + ext;
	let i = 1;
	// 上限只是防御（真源是 while(true) ✓）：同一目录攒不下 1000 个同名。
	while (i <= 1000) {
		if (!(await exists(join(dir, candidate)))) { return candidate; }
		candidate = `${base} (${i})${ext}`;
		i++;
	}
	return `${base} (${stampOf(new Date())})${ext}`;
}

/**
 * 在 `笔记/` 区内建目录（递归建父目录 ✓）。
 * 为什么不并进 `kb_write_note`：两者拒绝语义不同（目录重名**不是**错误：`mkdir -p` 本来就幂等 ✓），
 * 混成一个工具会让"要不要报错"这件事变得含混 ✓。
 */
export async function makeDir({ vaultRoot, relPath }) {
	if (typeof relPath !== 'string' || !relPath.trim()) {
		return { ok: false, error: '缺少 path（vault 内相对路径，形如 笔记/主题）' };
	}
	const target = resolveOrganizePath(vaultRoot, relPath);
	if (target.why) {
		return { ok: false, error: target.why };
	}
	const alreadyThere = await exists(target.abs);
	try {
		await mkdir(target.abs, { recursive: true });
	} catch (e) {
		return { ok: false, error: `建目录失败：${String(e?.message ?? e)}` };
	}
	return { ok: true, path: target.abs, created: !alreadyThere };
}

/**
 * 扫一遍笔记区，把**每个文件**读成 `{ rel, content }`（递归、可读的都收 ✓）。
 *
 * ⚠ 这里**不做**任何"算不算笔记"的判断 ✗：那条规则在纯模块 `selectNoteFiles` 里（真源 `collectMdFiles` 的判据 ✓）
 *   —— 只有一处，对账探针与写盘这层走的是同一个函数 ✓（第一版把排除写在遍历里 ⇒ 纯模块算出的索引
 *   多出系统导航文件与点目录 ⇒ 与真源**对不上**，正是 p3-46 那条对账抓出来的 ✓✓）。
 * @param {string} notesDir `<vault>/笔记` 的绝对路径
 * @returns {Promise<{ rel: string, content: string }[]>} `rel` 是相对笔记区、`/` 分隔、含 `.md` ✓
 */
async function readNotesTree(notesDir) {
	const out = [];
	const walk = async (dir, prefix) => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;   // 目录不存在/读不动 ⇒ 当空处理（与真源的 `catch { /* ignore */ }` 同语义 ✓）
		}
		for (const entry of entries) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(join(dir, entry.name), rel);
				continue;
			}
			// ⚠ 读不动的文件**照收**（内容当空串 ⇒ type 退化到目录名 ✓）：真源那边 `readNoteFrontmatterType`
			//   内部也是 `catch { return undefined }` ✓ —— 漏收一篇会让索引里少一条，比"类型退化"更糟 ✓。
			const content = await readFile(join(dir, entry.name), 'utf8').catch(() => '');
			out.push({ rel, content });
		}
	};
	await walk(notesDir, '');
	return out;
}

/**
 * 刷新导航两件：`笔记/index.md` 与 `笔记/overview.md`（内容生成见 `core/kbNavigation.js` ✓）。
 *
 * 为什么由**我们**写（而不是留给 IDE）：它们是两侧视图共读的导航文件 ⇒ dsh 构建完不刷，
 * 用户在 IDE 侧看到的就是"旧索引 + 新笔记" ✗（P2 的验收判据正是"两侧同形" ✓）。
 * 真源在**每个**构建/整理动作之后都会刷一次（`kbImportController.ts` 的 `maintainKbNavigation` 调用点 ✓），
 * 我们挂在同一批动作上 ✓。
 *
 * ⚠ 仍是写入 ⇒ 只走**已经过闸**的那些路径（构建任务内部、或某个写工具成功之后 ✓），
 *   不新开任何工具、也不单独弹窗 ✓；`config.maintainNavigation=false` 可整体关掉 ✓。
 * ⚠ `writeIfChanged` 语义（真源 `_writeIfChanged` ✓）：内容没变就**不落盘** ⇒ 不制造无谓的 mtime 变化 ✓
 *   （mtime 是 IDE 侧构建缓存的判据之一 ⇒ 乱刷会让它把笔记误判成"刚改过" ✗）。
 *
 * @param {string} notesDir
 * @returns {Promise<{ written: string[], unchanged: string[], scanned: number }>}
 */
export async function maintainNavigation(notesDir) {
	// 「算不算笔记」由纯模块裁决（与对账探针同一函数 ✓ ⇒ 规则只有一处 ✓）
	const notes = selectNoteFiles(await readNotesTree(notesDir));
	const files = buildNavigationFiles(notes);
	const written = [];
	const unchanged = [];
	// ★ 三件一起维护（真源 `maintainKbNavigation` = index + overview + **insights** ✓）：
	//   少维护 insights 的话，dsh 构建出来的库在 IDE 的「图谱洞察」里是空的 ✗（只能靠回执让人去 IDE 刷 ✗）。
	// ⚠ dsh 侧**不传 chatModel** ⇒ 就是真源"无模型"那一档（纯成员列表 ✓，不是阉割版 ✓，见 core/kbInsights.js 文件头）。
	const insights = buildInsightsFile(notes);
	for (const [name, content] of [['index.md', files.index], ['overview.md', files.overview], ['insights.md', insights.content]]) {
		const target = join(notesDir, name);
		const previous = await readFile(target, 'utf8').catch(() => undefined);
		if (previous === content) {
			unchanged.push(name);
			continue;
		}
		await writeFile(target, content, { encoding: 'utf8' });
		written.push(name);
	}
	return {
		written, unchanged, scanned: notes.length,
		insights: { nodes: insights.nodes, edges: insights.edges, communities: insights.communities, modularity: insights.modularity },
	};
}

/**
 * 跑一遍**去抽象化门控**（真源 `kbVaultFs.applyDeabstractionGating` ✓，纯逻辑在 `core/kbGating.js` ✓）：
 * 派生类笔记（`concept` / `comparison` / `synthesis` / `entity` ✓）按"同义归一后的 **distinct 来源数**"
 * 决定 `status: active`（≥2）还是 `pending`（<2）✓。
 *
 * 为什么 dsh 侧也要做：`status` 缺失时真源读出来是 `active`（那是"向后兼容门控上线前的旧笔记"的缺省 ✓）
 * ⇒ 我们构建出来的库在 IDE 里会**整片显示成正式** ✗（与 IDE 自己构建的库不一样 ✓）。
 *
 * 三条照抄的边界：
 *   · **只碰派生类**笔记（手写笔记、库区素材一律不动 ✓）；
 *   · **只改 `status` 一个字段**（`setStatus` 是行级操作 ⇒ 正文与其它字段原样保留 ✓）；
 *   · `aliases.json` 在 **vault 根**（真源 `loadKbAliases(fileService, dirname(<传入目录>))` ✓，调用方传的是笔记区 ✓）——
 *     读不到 / JSON 非法 ⇒ **空表降级**（真源原话："绝不阻断门控" ✓）。
 *
 * ⚠ 仍然是写入 ⇒ 只挂在**已经过闸**的那些动作之后（与导航同一个挂点 ✓），不新开工具、不单独弹窗 ✓。
 * @param {string} notesDir `<vault>/笔记`
 * @param {string} vaultRoot `<vault>`（`aliases.json` 在这一层 ✓）
 * @returns {Promise<{ active: number, pending: number, written: string[], decisions: object[] }>}
 */
export async function applyGating(notesDir, vaultRoot) {
	const notes = selectNoteFiles(await readNotesTree(notesDir));
	let aliases = EMPTY_ALIASES;
	try {
		const parsed = JSON.parse(await readFile(join(vaultRoot, KB_ALIASES_FILE), 'utf8'));
		if (parsed && typeof parsed === 'object' && parsed.aliases && typeof parsed.aliases === 'object') {
			aliases = { aliases: parsed.aliases };
		}
	} catch {
		// 文件不存在 / JSON 非法 ⇒ 空表降级（与真源同语义：门控不该被一个坏配置文件阻断 ✓）
	}
	const plan = planGating(notes, aliases);
	const written = [];
	for (const item of plan.changed) {
		await writeFile(join(notesDir, item.rel), item.content, { encoding: 'utf8' });
		written.push(item.rel);
	}
	return { active: plan.active, pending: plan.pending, written, decisions: plan.decisions };
}

/**
 * 给**本次新写的笔记**做确定性补链（真源 `_enrichNewNotes` → `enrichWikilinks` ✓，纯逻辑在 `core/kbEnrich.js` ✓）：
 * 把正文里**整词出现**的其它笔记标题包成 `[[标题]]` ⇒ 知识图谱多一条边 ✓。
 *
 * 为什么只补"本次新写的"（真源原话）：*"不动已有笔记，避免大面积改动用户内容"* ✓ ——
 * 全库补链会把用户手写的笔记也改写一遍（他们可能**故意**不链接 ✓），那不是"构建"该做的事 ✗。
 *
 * ⚠ 边界：`targetAbsPaths` 里**不在笔记区之内**的路径会被忽略（围栏外不该被改 ✓）；
 *   候选标题取自**全部笔记的文件名**（含目标自己 ⇒ `enrichContent` 会跳过自身 ✓）。
 * @param {string} notesDir `<vault>/笔记`
 * @param {string[]} targetAbsPaths 本次新写笔记的**绝对**路径（来自写工具的结果 ✓）
 * @returns {Promise<{ enriched: { path: string, titles: string[] }[], candidates: number, written: string[] }>}
 */
export async function enrichNotes(notesDir, targetAbsPaths) {
	const targets = new Set((targetAbsPaths ?? []).filter(Boolean));
	if (targets.size === 0) {
		return { enriched: [], candidates: 0, written: [] };
	}
	const all = await readNotesTree(notesDir);
	const allNotes = selectNoteFiles(all).map(note => ({ rel: note.rel, content: note.content }));
	const relOf = abs => {
		const rel = join(abs).startsWith(join(notesDir)) ? join(abs).slice(join(notesDir).length).replace(/^[\\/]+/, '') : '';
		return rel.replace(/\\/g, '/');
	};
	const wanted = [...targets].map(relOf).filter(Boolean);
	const plan = planEnrichment(allNotes, wanted);
	const written = [];
	for (const item of plan.changed) {
		await writeFile(join(notesDir, item.rel), item.content, { encoding: 'utf8' });
		written.push(item.rel);
	}
	return {
		enriched: plan.added.map(item => ({ path: join(notesDir, item.rel), titles: item.titles })),
		candidates: plan.candidates,
		written,
	};
}

/**
 * 从备份目录**放回原位** —— 撤销「删除＝移入备份」（2026-10-13，§15.47 ✓）。
 *
 * 守卫（每条都**先校验后 I/O** ✓，与 runOrganize 同一套口径）：
 *   ① 目标路径过**同一个围栏** `resolveOrganizePath`（只在「笔记」区内 ✓；`..` 由它判死 ✓，不另写一份 ✗）；
 *   ② 备份目录必须**自洽**：拿它自己的目录名当 stamp 重算 `backupDirFor` ⇒ 必须与传入值完全一致 ✓
 *      （这样"随便指一个目录当还原源 / 指到 vault 外别处"都会被挡住 ✓ —— 靠字符串前缀比是错的 ✗）；
 *   ③ 源必须存在、目标**必须不存在**（不覆盖 ✓ —— 静默覆盖是数据丢失里最坏的一种 ✗）。
 * @returns `{ ok: true, path, rel, backupDir }` 或 `{ ok: false, error }`
 */
export async function restoreFromBackup({ vaultRoot, backupDir, relPath }) {
	const target = resolveOrganizePath(vaultRoot, relPath);
	if (target.why || !target.inside) { return { ok: false, error: `目标不在可写的「笔记」区内：${target.why ?? relPath}` }; }
	// ⚠ 判据是"**父目录**必须是本库的备份根" ✗，不是"目录名等于重算值" ✓ ——
	//   第一版拿叶子名当 stamp 去重算 ⇒ `backupDirFor` 收的是**时间戳**（目录名整体是
	//   backup-kborganize-<stamp> ✓）⇒ 自己把自己判成"不自洽"、撤销永远 400 ✓（正是冒烟 ⑤ 咬出来的 ✓）。
	//   按父目录判的好处：任何一次备份（含更早的 stamp ✓）都放行 ✓，而"随便指一个目录"照旧被挡 ✓。
	const normalize = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '');
	const back = normalize(backupDir);
	const expectedParent = normalize(dirname(backupDirFor(vaultRoot, 'stamp')));
	if (!back || normalize(dirname(back)) !== expectedParent) { return { ok: false, error: '备份目录不自洽（不是本库的备份目录）' }; }
	const source = join(String(backupDir), target.rel);
	if (!(await exists(source))) { return { ok: false, error: `备份里没有这一项：${target.rel}` }; }
	if (await exists(target.abs)) { return { ok: false, error: `原位已有文件 ⇒ 不覆盖：${target.rel}` }; }
	try {
		await mkdir(dirname(target.abs), { recursive: true });
		await moveFile(source, target.abs, false);
		return { ok: true, path: target.abs, rel: target.rel, backupDir: String(backupDir) };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}
