// @vssaros/dsh-kb — store（主机侧 I/O）：vault 扫描、kernel 索引读取、正文读取（带路径围栏）。只读。
//
// 数据根口径与前几个模块一致：`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`；
// vault 根：`config.kbRoot` → `<数据根>/knowledge-base`（与 `knowledgeStorage.ts` 的默认一致）。

// ⚠ `writeFile` 是 2026-10-13 补的：写构建缓存（P1）时才需要 —— 漏掉它的表现是
// `ReferenceError: writeFile is not defined`，而且**只在"真的登记成功"那条路上**才炸 ✓
// （p3-66 抓到的 ✓：登记函数先跑通、到了落盘那一步才抛 ⇒ 若不跑那条路，这个 bug 会一直躺着 ✓）。
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FTINDEX_FILE, KERNEL_FILE, LIBRARY_DIR, MAX_DOC_BYTES, NOTES_DIR, TOPIC_OVERVIEW_FILE, isVaultId, normalizeOverview, parseKernel } from './core/kb.js';
import { MAX_FULLTEXT_TOTAL_CHARS, buildIndex } from './core/kbFulltext.js';
import { BUILD_CACHE_FILE, MAX_LIB_SCAN, classifyPending, isSystemNavFile, parseBuildCache } from './core/kbIngest.js';
// P1 构建缓存写入（只增不删 + 只登记'确实产出'的 ✓）：纯逻辑在 core/kbBuildCache.js ✓
import { mergeBuildCache, planBuildCacheEntries, serializeBuildCache } from './core/kbBuildCache.js';

export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

/** vault 根：`config.kbRoot` → `<数据根>/knowledge-base`。 */
export function kbRootOf(config) {
	const configured = typeof config?.kbRoot === 'string' ? config.kbRoot.trim() : '';
	return configured || join(dataRootOf(config), 'knowledge-base');
}

/**
 * 页面渲染快照（报告 §5-4 的"缓存 vault/kernel 扫描结果，按 mtime 失效"）✓。
 *
 * 为什么需要：kb 页**每次渲染**都会 ① 逐个 vault 读并 `JSON.parse` 那个 `.kbkernel.json`
 *（大库时就是几万个 doc 的索引 ✗）② 递归 walk 整个库数文件 ⇒ 刷新一次全是主线程 I/O ✗。
 *
 * 缓存键 = **根目录 readdir 的形状 + 每个 vault 目录的 mtime + 那个 vault 的 kernel 的 (size, mtimeMs)**
 * ✓ —— 覆盖"加/删库 ✓、加/删文件 ✓、重建索引 ✓"（codebase 的 `loadGraph` 是同一套思路 ✓，这里抄它 ✓）。
 * 扫描**之后再取一次**指纹 ✓：两端不一致就不缓存这次结果 ✓（别把扫描期间的中间态钉住 ✗）。
 *
 * ⚠ 一个如实说明的边界 ✗：手工往 `库/` 里丢文件、又**没重建 kernel** 时，页面上那个"N 个文件"的
 * 计数可能**滞后**（直到 kernel 变或 Host 重启 ✓）；**索引条目数与正文不受影响** ✓（它们只看 kernel ✓）。
 */
let pageCache;

export async function pageSnapshotOf(root, { external = [] } = {}) {
	const key = await pageFingerprint(root, external);
	if (pageCache && pageCache.root === root && pageCache.key === key) {
		return { ...pageCache.value, cached: true };
	}
	const { vaults, missing } = await listVaults(root, { withDocs: true, external });
	const docCounts = new Map();
	for (const vault of vaults) {
		docCounts.set(vault.id, await countFiles(vault.dir));
	}
	// ★ 门控可视化（§15.10）：每库的"还没建成笔记"集合（**相对「库」**的路径、小写归一 ✓）。
	//   复用 P1 那份 `previewBuild`（判据与 `kb_build mode=preview` **同一个** ✓ —— 页面与工具不会各说一套 ✓）。
	//   ⚠ 只统计 `.md`（见 previewBuild 的边界说明 ✓）；读失败就**当空集**（页面少标几个 ≠ 崩 ✓），
	//   但把原因留在 `pendingNote` 里让页面能如实说 ✓。
	const pending = new Map();
	let pendingNote;
	for (const vault of vaults) {
		try {
			const preview = await previewBuild(vault.dir);
			// ⚠ 两边口径要**一致**才标得上 ✗：`previewBuild` 的 pending 路径实测是**绝对路径**
			//   （JSDoc 写的是"相对「库」" ✗ —— p3-70 的 ① 就是被这一条咬红的 ✓，
			//   而"计数"那条照样绿 ✓ ⇒ 只跑计数根本发现不了 ✓）。
			//   统一成「库内后缀」：取最后一个 `/库/` 之后的整段、正斜杠、小写 ✓
			const libKey = value => {
				const flat = String(value).split(String.fromCharCode(92)).join('/');
				const at = flat.lastIndexOf('/' + LIBRARY_DIR + '/');
				return (at < 0 ? flat : flat.slice(at + LIBRARY_DIR.length + 2)).toLowerCase();
			};
			pending.set(vault.id, new Set(preview.pending.map(item => libKey(item.path))));
		} catch (e) {
			pending.set(vault.id, new Set());
			pendingNote = String(e?.message ?? e);
		}
	}
	const value = { vaults, missing, docCounts, pending, ...(pendingNote ? { pendingNote } : {}) };
	if ((await pageFingerprint(root, external)) === key) {
		pageCache = { root, key, value };
	}
	return { ...value, cached: false };
}

/**
 * 指纹：读不动的一律按"变过"处理（保守 ⇒ 宁可多扫一次，也不显示旧数据 ✗）。
 *
 * ⚠ 为什么**还要看 vault 的直接子目录**（第一版只看 vault 自己，当场被 p3-08 抓到 ✗）：往
 * `笔记/` 或 `库/<分类>/` 里丢文件，变的是**子目录**的 mtime、vault 自己的 mtime 不变 ✗ ⇒
 * 那样"加文件立刻重扫"就是假的 ✓。真实布局恰好是两层（`笔记/` 与 `库/<分类>/`）⇒ 下沉一层就够 ✓
 * （**更深**的嵌套、或只改已有文件的**内容**，这两件事都不改文件数 ⇒ 不需要让这份快照失效 ✓；
 * 页面上要看正文时走只读 API / `kb_read`，那是另一条路径 ✓）。
 */
async function pageFingerprint(root, external = []) {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return `unreadable:${root}`;
	}
	// ⚠ 库清单 = 扫到的 ＋ **注入里内容在别处的**（B 方案，2026-10-15 ✓）—— 两类的失效面**必须一致**：
	//   外挂库改了内容，页面缓存也要失效 ✓（否则又是"越用越不准" ✓，与下面那条构建缓存同一个坑 ✓）。
	const list = [
		...entries.filter(e => e.isDirectory() && isVaultId(e.name)).map(e => ({ id: e.name, dir: join(root, e.name) })),
		...external.map(item => ({ id: String(item?.id ?? ''), dir: String(item?.dir ?? '') })).filter(x => x.id && x.dir),
	].sort((a, b) => a.id.localeCompare(b.id));
	const parts = [];
	for (const { id, dir } of list) {
		const dirInfo = await stat(dir).catch(() => undefined);
		const kernel = await stat(join(dir, KERNEL_FILE)).catch(() => undefined);
		// ★ 2026-10-13（§15.10）：构建缓存也进指纹 ✓ —— 页面现在会显示"哪些素材还没建成笔记"，
		//   而**构建/登记**只改这个文件与笔记 mtime ✗ ⇒ 不纳入指纹的话，构建完再打开页面**还是**旧标记
		//   （"越用越不准" ✓，与 §13 那条同一个坑 ✓）。
		const buildCache = await stat(join(dir, BUILD_CACHE_FILE)).catch(() => undefined);
		const subParts = [];
		const subs = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const sub of subs.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
			const subInfo = await stat(join(dir, sub.name)).catch(() => undefined);
			subParts.push(`${sub.name}@${subInfo?.mtimeMs ?? 'x'}`);
		}
		parts.push(`${id}:${dirInfo?.mtimeMs ?? 'x'}:${kernel ? `${kernel.size}/${kernel.mtimeMs}` : 'none'}:${buildCache ? `${buildCache.size}/${buildCache.mtimeMs}` : 'none'}:${subParts.join(',')}`);
	}
	return parts.join('|');
}

/** 扫描 vault 根：只认 `<vaultId>/`（`_archive` / `favorites` / `notes` / 点文件一律跳过）。 */
export async function listVaults(root, { withDocs = true, external = [] } = {}) {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { vaults: [], root, missing: root };
		}
		throw new Error(`资料库根目录读取失败（${root}）：${e?.message ?? e}`);
	}
	const vaults = [];
	for (const entry of entries.filter(e => e.isDirectory() && isVaultId(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
		const dir = join(root, entry.name);
		const kernelPath = join(dir, KERNEL_FILE);
		let parsed = { docs: [], totalDocs: 0, notes: [] };
		let kernelBytes = 0;
		try {
			const info = await stat(kernelPath);
			kernelBytes = info.size;
			parsed = parseKernel(await readFile(kernelPath, { encoding: 'utf8' }));
		} catch {
			// 没有 kernel 索引：空 vault（正常，新库还没 ingest）——不报错、不刷屏
		}
		vaults.push({
			id: entry.name,
			dir,
			kernelBytes,
			totalDocs: parsed.totalDocs,
			notes: parsed.notes,
			// ⚠ 标出来源（2026-10-15，B 方案）：页面据此把"只存在于盘上、IDE 并不认识"的目录
			//   标成「未登记」✓ —— 它们不是库（真源的库内判据不认 ⇒ 打开它们的笔记得不到富显示 ✗）。
			source: 'scan',
			...(withDocs ? { docs: parsed.docs } : {}),
		});
	}
	// ★★ 2026-10-15（B 方案）：注入记录里带 `path` 的库 = **内容在别处**的库根（IDE 的
	//   「配置文件夹为知识库」/ 用户真正的库 `e:\VsSarosVault` ✓）—— 它们**不在**知识库数据根下，
	//   所以扫盘永远扫不到 ✗ ⇒ 以前页面上只列着数据根下那些**遗留 uid 目录**（IDE 并不认识它们 ✓），
	//   而真源那套"库内 .md ⇒ 块编辑器富显示"的判据只认**已登记的库根** ⇒ 点开只能是普通编辑器 ✓、
	//   内容自然也"显示不出来" ✓（用户 2026-10-15 报的就是这个 ✓）。
	//   ⚠ 去重按 id：同 id 一律以**注入记录**为准（它是 IDE 的权威口径，且带 name/icon ✓）。
	//   ⚠ 没有注入（独立启动器 / 老 Host）⇒ `external` 为空 ⇒ 行为与从前逐字相同 ✓（不猜 ✓）。
	for (const item of external) {
		const id = String(item?.id ?? '');
		const dir = String(item?.dir ?? '');
		if (!id || !dir || vaults.some(vault => vault.id === id)) { continue; }
		const kernelPath = join(dir, KERNEL_FILE);
		let parsed = { docs: [], totalDocs: 0, notes: [] };
		let kernelBytes = 0;
		try {
			const info = await stat(kernelPath);
			kernelBytes = info.size;
			parsed = parseKernel(await readFile(kernelPath, { encoding: 'utf8' }));
		} catch {
			// 新挂进来的库还没有索引：与扫盘那条**同一处理**（不报错、不刷屏 ✓）
		}
		vaults.push({
			id,
			dir,
			kernelBytes,
			totalDocs: parsed.totalDocs,
			notes: parsed.notes,
			source: 'injected',
			...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}),
			...(typeof item.icon === 'string' && item.icon ? { icon: item.icon } : {}),
			...(withDocs ? { docs: parsed.docs } : {}),
		});
	}
	return { vaults, root };
}

/**
 * 列一个分区的**真文件树**（2026-10-13，§15.38 复刻第一刀）。
 *
 * ## 为什么必须有它
 * 此前页面渲染的是**索引条目**（`.kbkernel.json` 的 docs）⇒ 只有"被索引的 md" ✗；
 * 而真源的树走 `fileService` **列目录**（`knowledgeBaseView.ts` 的 `loadSectionTree`）⇒
 * **目录、非 md 文件、点文件全在**，没索引的标「未索引」（`isRawLib`，`:2062`）+ 大小。
 * 对照图就是证据：右侧连 `.kb-insights-cache.json` / `.canvas` 都列着 ✓。
 *
 * ## 三处如实标注（不假装与真源同规 ✗）
 * ① **排序**：真源默认是 `KB_SORT_GROUPS` 的「创建时间（从旧到新）」；我们按
 *    「**目录在前、各自按名称**（数字感知）」—— 磁盘上拿得到 mtime、拿不到可靠的「创建时间」，
 *    而乱序的树比名称序更难读 ✓（这条差异写进文档 ✓）。
 * ② **上限**：真源是**懒加载**（展开才读子目录）；我们一次列完 + 深度/节点数上限，
 *    超了**如实**带 `truncated` ✓（不假装列全了 ✗）。
 * ③ 点文件**照样列出** ✓（与对照图一致，也是「未索引」的主要来源 ✓）。
 *
 * @param {string} vaultDir `<vault>` 的绝对路径
 * @param {{section?: string, maxDepth?: number, maxNodes?: number}} [options]
 * @returns `{ section, dir, nodes, files, dirs, truncated, missing? }`；
 *   `nodes` 是**嵌套**数组（`{ name, rel, isDirectory, size?, mtime?, children? }`），
 *   `rel` 相对**该分区**（页面拼 `笔记/...` 时用它 ✓）
 */
export async function listVaultTree(vaultDir, { section = LIBRARY_DIR, maxDepth = 6, maxNodes = 1500 } = {}) {
	const dir = join(vaultDir, section);
	let budget = maxNodes;
	let files = 0;
	let dirs = 0;
	let truncated = false;

	const walk = async (current, rel, depth) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (e) {
			// 目录不存在**不是**错误（新库还没建「笔记」✓）⇒ 如实标 missing 让上层决定怎么显示 ✓
			return { nodes: [], missing: e?.code === 'ENOENT' ? true : undefined };
		}
		const nodes = [];
		let missing;
		for (const entry of entries) {
			if (budget <= 0) { truncated = true; break; }
			const childRel = rel ? rel + '/' + entry.name : entry.name;
			if (entry.isDirectory()) {
				budget--;
				dirs++;
				// 深度到顶：**仍然列出这个目录本身**，但不再往下，并如实标 truncated ✓
				const deeper = depth + 1 < maxDepth
					? await walk(join(current, entry.name), childRel, depth + 1)
					: { nodes: [], truncated: true };
				if (deeper.missing) { missing = true; }
				if (deeper.truncated) { truncated = true; }
				nodes.push({ name: entry.name, rel: childRel, isDirectory: true, children: deeper.nodes });
				continue;
			}
			if (!entry.isFile()) { continue; }   // 符号链接等不列（真源走 fileService，同样有这一档 ✓）
			budget--;
			files++;
			const info = await stat(join(current, entry.name)).catch(() => undefined);
			nodes.push({
				name: entry.name,
				rel: childRel,
				isDirectory: false,
				size: info ? info.size : undefined,
				mtime: info ? info.mtimeMs : undefined,
			});
		}
		nodes.sort(treeCompare);
		return { nodes, missing };
	};

	const result = await walk(dir, '', 0);
	return {
		section,
		dir,
		nodes: result.nodes,
		files,
		dirs,
		truncated,
		...(result.missing ? { missing: true } : {}),
	};
}

/** 目录在前、各自按名称（见上面 `listVaultTree` 的 ⚠ ① 排序说明）。 */
function treeCompare(a, b) {
	if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
	return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
}

/** 目录里的文件数（页面展示用；含子目录）。 */
export async function countFiles(dir, limit = 5000) {
	let count = 0;
	const walk = async current => {
		if (count >= limit) {
			return;
		}
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (count >= limit) {
				return;
			}
			if (entry.isDirectory()) {
				await walk(join(current, entry.name));
			} else if (!entry.name.startsWith('.')) {
				count++;
			}
		}
	};
	await walk(dir);
	return count;
}

/** 一个 vault 最多返回多少条目录摘要（vault 很大时也不该把回执撑爆）。 */
export const MAX_TOPIC_OVERVIEWS = 200;

/**
 * 读一个 vault 的**目录摘要**：`<vault>/库/<分类>/.overview.md`。
 *
 * 口径与 IDE 的 `readTopicOverviews()` 一致：只取 library 区（`库/`）的**直接子目录**——那是
 * 「渐进式下钻」的第一层，不是递归把整棵树倒出来。`库/` 不存在时**不猜别的区**，如实带上
 * `libraryMissing`（由工具给出可读说明；猜错的代价是模型拿到一整套错误的"目录结构"）。
 *
 * 返回 `{overviews: [{dir, summary}], libraryDir, libraryMissing?, scannedDirs}`；
 * `scannedDirs` 是"扫过多少个分类目录"——用来把"没有摘要"说清楚（是没建过，还是压根没有分类目录）。
 */
export async function listTopicOverviews(vaultDir) {
	const libraryDir = join(vaultDir, LIBRARY_DIR);
	let entries;
	try {
		entries = await readdir(libraryDir, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { overviews: [], libraryDir, libraryMissing: true, scannedDirs: 0 };
		}
		throw new Error(`library 区读取失败（${libraryDir}）：${e?.message ?? e}`);
	}
	// 与 IDE 一致：跳过**点目录**（`.archive` 之类不是分类），按名字稳定排序（同输入同输出）
	const dirs = entries
		.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
		.sort((a, b) => a.name.localeCompare(b.name));
	const overviews = [];
	for (const entry of dirs) {
		try {
			const summary = normalizeOverview(await readFile(join(libraryDir, entry.name, TOPIC_OVERVIEW_FILE), { encoding: 'utf8' }));
			if (summary) {
				overviews.push({ dir: entry.name, summary });
			}
		} catch {
			// 这个分类目录没有目录摘要（还没「构建笔记」过）：跳过——"没生成"是正常状态，不是错误
		}
	}
	return { overviews, libraryDir, scannedDirs: dirs.length };
}

/**
 * 读一篇正文。
 * `uri` 可以是 `file://` URL（索引里就是这种），也可以是 vault 内的相对路径（`库/概念/x.md`）。
 * **路径围栏**：解析后的绝对路径必须落在 vault 根内，否则拒绝——`kb_read` 是模型可达的工具，
 * 不能让 `../../` 之类的输入读到库外（`..`、盘符、UNC 都挡在这条检查里）。
 */
export async function readDoc(root, uri, extraRoots = []) {
	const rootAbs = resolve(root);
	let target;
	if (/^file:/i.test(String(uri))) {
		try {
			target = fileURLToPath(String(uri));
		} catch (e) {
			return { error: `uri 不是合法的 file URL：${String(e?.message ?? e)}` };
		}
	} else {
		target = resolve(rootAbs, String(uri));
	}
	const targetAbs = resolve(target);
	// ★ 2026-10-15（B 方案）：围栏从"数据根一根"改成**多根**（数据根 ＋ 注入里那些内容在别处的库根 ✓）——
	//   外挂库（`e:\VsSarosVault` ✓）里的正文**必须读得到**，否则"本页认它"这件事只到列目录为止 ✗。
	//   ⚠ 判据仍是**段边界**（`root + sep`）⇒ 兄弟目录（`…-other`）照旧拒绝 ✓（不放松 ✓）。
	const isInside = (abs, base) => process.platform === 'win32'
		? abs.toLowerCase().startsWith(`${base.toLowerCase()}${sep}`)
		: abs.startsWith(`${base}${sep}`);
	const roots = [rootAbs, ...extraRoots.map(candidate => resolve(candidate))];
	if (!roots.some(base => isInside(targetAbs, base))) {
		return { error: `拒绝读取库外文件：${targetAbs}` };
	}
	let info;
	try {
		info = await stat(targetAbs);
	} catch (e) {
		return { error: `文件读取失败（${e?.code ?? 'unknown'}）：${targetAbs}` };
	}
	if (!info.isFile()) {
		return { error: `不是文件：${targetAbs}` };
	}
	if (info.size > MAX_DOC_BYTES * 4) {
		return { error: `文件过大（${info.size} 字节 > ${MAX_DOC_BYTES * 4}）：${targetAbs}` };
	}
	const text = await readFile(targetAbs, { encoding: 'utf8' });
	const truncated = text.length > MAX_DOC_BYTES;
	return {
		path: targetAbs,
		bytes: info.size,
		truncated,
		content: truncated ? `${text.slice(0, MAX_DOC_BYTES)}\n…（已截断，原文件 ${info.size} 字节）` : text,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 正文检索（`kb_search mode=fulltext`）的数据源与索引缓存
//
// ★ 数据源的选择**不是猜的**，是实测出来的（2026-10-12）：
//   `.kbkernel.json` 在生产库（元数据形态）与 dev 库（FTS 形态）里**都带全文 `text`** ✓
//   ⇒ 正文不必自己去扫盘：直接用索引器已经读过的正文（零额外 I/O、且与 IDE 侧
//   "索引的就是这份文本"天然一致 ✓）。读不到 text（老索引）时退到 `.ftindex.json`
//   （同一份序列化的另一处落盘，实测与 kernel 同样大小 ✓），再没有就**如实说没有**（不假装搜过 ✗）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个 vault 的正文来源（按 kernel → ftindex 顺序试）。 */
export async function loadFulltextDocs(vaultDir) {
	for (const file of [KERNEL_FILE, FTINDEX_FILE]) {
		const path = join(vaultDir, file);
		let info;
		try {
			info = await stat(path);
		} catch {
			continue; // 这份不存在 ⇒ 试下一份
		}
		let parsed;
		try {
			parsed = parseKernel(await readFile(path, { encoding: 'utf8' }), { withText: true });
		} catch (e) {
			return {
				docs: [],
				source: file,
				indexedAt: new Date(info.mtimeMs).toISOString(),
				notes: [`读取失败（${e?.code ?? e?.message ?? e}）`],
				docsWithoutText: 0,
			};
		}
		const withText = parsed.docs.filter(doc => typeof doc.text === 'string' && doc.text.length > 0);
		if (withText.length > 0) {
			return {
				docs: withText,
				source: file,
				indexedAt: new Date(info.mtimeMs).toISOString(),
				notes: parsed.notes,
				docsWithoutText: parsed.docs.length - withText.length,
			};
		}
	}
	return { docs: [], source: 'none', indexedAt: undefined, notes: [], docsWithoutText: 0 };
}

/**
 * 索引指纹：两个候选文件各自的 `size/mtimeMs`。读不动 ⇒ `none`（保守：宁可重扫 ✗ 不显示旧数据）。
 * 与 `pageFingerprint` 同一个思路（那边看的是目录树，这边看的是**索引文件本身** ✓）。
 */
async function indexFingerprint(vaultDir) {
	const parts = [];
	for (const file of [KERNEL_FILE, FTINDEX_FILE]) {
		const info = await stat(join(vaultDir, file)).catch(() => undefined);
		parts.push(info ? `${file}:${info.size}/${Math.round(info.mtimeMs)}` : `${file}:none`);
	}
	return parts.join(',');
}

/**
 * 每库一份索引的缓存（模块级 Map，键 = 根 + 库 id + 索引指纹 ⇒ 不同数据根 / 不同库不串 ✓，
 * 且有条数上限：库多时不无限增长）。
 */
const fulltextCache = new Map();
/** 缓存条数上限（按库计；超了淘汰最久未用的）。 */
const FULLTEXT_CACHE_MAX = 24;

/**
 * 为每个 vault **各建一份**正文索引。
 *
 * ★ 为什么是"每库一份"而不是"跨库合成一份"（这一条是本轮实测后**改过的**决定）：
 *   BM25 的 `N`（文档总数）与 `avgLen` 是**全局量** —— 把多个库的文档合成一个索引，
 *   同一篇文档的分数会随"同时选了哪些别的库"变化 ⇒ 与 IDE 侧（一次只索引**当前打开的那个** vault）
 *   对不上 ✗，而症状是"分数不一样、两边都不报错"（最难查的一种）。
 *   每库一份后：**单库检索（或 vaultId 限定）的分数与 IDE 逐条相同** ✓（黄金表就是这么钉的）。
 *   ⚠ 跨库合并时分数**不可互相比较**（各自的语料不同）⇒ 工具回执里如实说明，不假装它们可比 ✓。
 *
 * @param root vault 根
 * @param vaults `[{ id, dir }]`（已按 vaultId 过滤好的集合）
 * @returns 每库一项 `{ vaultId, index, source, indexedAt, docs, docsWithoutText, notes, cached }`
 */
export async function fulltextIndexes(root, vaults) {
	const out = [];
	for (const vault of vaults) {
		const key = `${root}|${vault.id}|${await indexFingerprint(vault.dir)}`;
		const hit = fulltextCache.get(key);
		if (hit) {
			// 触摸（LRU：删了再插到尾部）
			fulltextCache.delete(key);
			fulltextCache.set(key, hit);
			out.push({ ...hit, cached: true });
			continue;
		}
		const loaded = await loadFulltextDocs(vault.dir);
		let totalChars = 0;
		for (const doc of loaded.docs) {
			totalChars += doc.text.length;
		}
		if (totalChars > MAX_FULLTEXT_TOTAL_CHARS) {
			throw new Error(`库 ${vault.id} 的正文索引过大（已超 ${Math.round(MAX_FULLTEXT_TOTAL_CHARS / 1024 / 1024)}MB）：请缩小该库或改用 mode="index"。`);
		}
		const index = buildIndex(loaded.docs.map(doc => ({ ...doc, vaultId: vault.id })));
		const value = {
			vaultId: vault.id,
			index,
			source: loaded.source,
			indexedAt: loaded.indexedAt,
			docs: loaded.docs.length,
			docsWithoutText: loaded.docsWithoutText,
			notes: loaded.notes,
		};
		fulltextCache.set(key, value);
		while (fulltextCache.size > FULLTEXT_CACHE_MAX) {
			fulltextCache.delete(fulltextCache.keys().next().value);
		}
		out.push({ ...value, cached: false });
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 构建预览（`kb_build mode=preview`，2026-10-12）：**只读** —— 数一数「库」里还有哪些素材没建成笔记。
//
// 口径真源 = IDE 的 `collectPendingSources`（`knowledge/kbVaultFs.ts:97-122` ✓ 逐行读过）；
// 纯逻辑那半在 `core/kbIngest.js`（`classifyPending` ✓），这里只负责**读盘**：
//   · 入口集合：递归 walk `<vault>/库/`，跳过**点开头**的文件与目录 ✓、只收 `*.md` ✓、跳过系统导航文件名 ✓；
//   · 构建缓存：`<vault>/.kb-build-cache.json`（`{ 素材绝对路径: 笔记绝对路径 }` ✓）。
// ⚠ **如实记两处边界**（真源有、我们没有）：
//   ① 真源在数之前会先 `stageDocSourcesToText` 把 **pdf/docx 等非 md 素材**转成文本，
//      再当素材算 ✓ —— dsh 侧没有那条原生转换链 ⇒ 本侧**只统计 `.md`** ✗，非 md 素材不在这里出现 ✓；
//   ② 真源扫描的是"库分区根 + 备注目录"（视图传入的 roots ✓），本侧固定为 `<vault>/库/` ✓。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构建预览。
 * @returns `{ libDir, libMissing?, cacheFile, cacheNote?, scanned, truncated?, pending, counts }`
 *   `pending` 是相对「库」的路径 + 拒因（真源只给路径；拒因是由同一批判据直接导出的，不是猜的 ✓）
 */
export async function previewBuild(vaultDir) {
	const libDir = join(vaultDir, LIBRARY_DIR);
	const cacheFile = join(vaultDir, BUILD_CACHE_FILE);

	// 构建缓存：读不动/坏掉都按"空缓存"处理（照真源），但**带上 note**（缓存坏了会让 pending 全量复活 ✓）
	let cache = {};
	let cacheNote;
	try {
		const parsed = parseBuildCache(await readFile(cacheFile, { encoding: 'utf8' }));
		cache = parsed.cache;
		cacheNote = parsed.note;
	} catch (e) {
		if (e?.code !== 'ENOENT') {
			cacheNote = `构建缓存读取失败（${e?.code ?? e?.message ?? e}）⇒ 已按空缓存处理`;
		}
	}

	const files = [];
	let truncated = false;
	const walk = async current => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;   // 子目录读不动就跳过（与真源的 try/catch 同策略 ✓）
		}
		for (const entry of entries) {
			if (files.length >= MAX_LIB_SCAN) {
				truncated = true;
				return;
			}
			if (entry.name.startsWith('.')) {
				continue;   // 点开头的文件与目录都跳过（照真源 ✓）
			}
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			// ⚠ 大小写**照真源**（`child.name.endsWith('.md')` ✓，即区分大小写 ✗）：同一个 vault 会被
			//   两个引擎同时看，放宽成忽略大小写就会让"`.MD` 算不算素材"两边给出**不同的集合** ✗
			//   —— 那不是"更宽容"，那是新的口径分叉 ✓（宁可两个引擎一起"看着怪"，也不要各答一套 ✓）。
			if (!entry.name.endsWith('.md') || isSystemNavFile(entry.name)) {
				continue;
			}
			const info = await stat(full).catch(() => undefined);
			files.push({ path: full, mtime: info?.mtimeMs });
		}
	};
	await walk(libDir);
	const libMissing = !(await stat(libDir).catch(() => undefined));

	// 笔记 mtime：同一个笔记可能被多个素材指向 ⇒ 缓存一次查询结果 ✓（undefined = 笔记不存在）
	const noteMtimes = new Map();
	const noteMtimeOf = async notePath => {
		const key = String(notePath).toLowerCase();
		if (!noteMtimes.has(key)) {
			const info = await stat(notePath).catch(() => undefined);
			noteMtimes.set(key, info ? info.mtimeMs : undefined);
		}
		return noteMtimes.get(key);
	};
	// `classifyPending` 是**同步纯函数** ⇒ 先把笔记 mtime 查完，再分类 ✓（查完再分类 = 一次遍历 ✓）
	for (const notePath of new Set(Object.values(cache))) {
		await noteMtimeOf(notePath);
	}
	const { pending, counts } = classifyPending({ files, cache, noteMtimeOf: notePath => noteMtimes.get(String(notePath).toLowerCase()) });

	return {
		libDir,
		...(libMissing ? { libMissing: true } : {}),
		cacheFile,
		...(cacheNote ? { cacheNote } : {}),
		scanned: files.length,
		...(truncated ? { truncated: true } : {}),
		pending,
		counts,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 构建缓存**写入**（P1，2026-10-13）：把本批**确实产出**的笔记登记进 <vault>/.kb-build-cache.json。
//
// 为什么必须做：不登记 ⇒ 下一次 preview 把同一批**再算成待构建** ✗（"越用越不准" ✓）。
// 协议（三条，见 core/kbBuildCache.js 文件头）：
//   ① **只增不删** ✓：别人的条目一律保留（我们只登记自己产出的那几对 ✓）；
//   ② 调用方**在那把 vault 锁里**调我 ✓（read-modify-write 窗口最小化 ✓）；
//   ③ **有歧义就不登记** ✓（同名素材 / 一素材被两篇笔记声明 ⇒ 跳过并带回 reason ✓，绝不瞎猜 ✓）。
// ⚠ 残余风险**如实承认** ✗：IDE 侧整理器不加锁 ⇒ 同一瞬间它在写就会**丢一条**（丢的那条下次被重新算成
//   待构建 ✓，而真源的构建语义是**就地 patch** 那篇笔记 ⇒ 不是灾难 ✓）。这条写进回执，不假装解决 ✓。
//
// @param {string} vaultDir
// @param {{ sources: readonly string[], notePaths: readonly string[] }} input
//   sources = 本批素材绝对路径 ✓；notePaths = 收尾时**候选**笔记（不存在的会被自动忽略 ✓）
// @returns {{ registered: number, total: number, changed: boolean, skipped: object[], cacheFile: string }}
// ─────────────────────────────────────────────────────────────────────────────
export async function registerBuildCacheEntries(vaultDir, { sources }) {
	const cacheFile = join(vaultDir, BUILD_CACHE_FILE);
	// ★ 候选笔记 = **扫「笔记」区**（不是调用方给的账本 ✗）——2026-10-13 由 p3-66 的第一次红纠正：
	//   原来用"构建收尾时授权放行账本里的那些笔记"⇒ **用户逐篇批准**（config.batchGrant=false）或
	//   其它写路径产出的笔记会**漏登记** ✗（现象：笔记明明在盘上，下一次 preview 仍把它算成待构建 ✓）。
	//   扫盘没有这个盲区 ✓，也更贴真源"登记**确实落盘**的产出" ✓（读不动的文件就当没有 ✓）。
	const notes = await collectNoteFiles(join(vaultDir, NOTES_DIR));
	const { entries, skipped } = planBuildCacheEntries({ sources, notes });
	if (entries.length === 0) {
		// ⚠ 一条都不登记时**绝不碰文件** ✗：无谓的写会动 mtime，而 mtime 正是待构建判据之一 ✓
		// ⚠ 一条都不登记时也要**把输入规模带回去** ✗：真机回执只说「0 条」时，分不出是"扫不到"还是"匹配不上" ✓
		return { registered: 0, total: 0, changed: false, skipped, cacheFile, notesScanned: notes.length, sourcesScanned: (sources ?? []).length };
	}
	let existing = {};
	try {
		existing = parseBuildCache(await readFile(cacheFile, { encoding: 'utf8' })).cache;
	} catch {
		// 读不动 ⇒ 按空缓存（照真源 ✓）；但**只增不删**的语义因此退化成"整份重写" ✗
		// ⇒ 只在读得动的常态下才可能丢更新 ✓（这条随残余风险一起如实记 ✓）
	}
	const merged = mergeBuildCache(existing, entries);
	await writeFile(cacheFile, serializeBuildCache(merged), { encoding: 'utf8' });
	return { registered: entries.length, total: Object.keys(merged).length, changed: true, skipped, cacheFile, notesScanned: notes.length, sourcesScanned: (sources ?? []).length };
}

/**
 * 递归收集「笔记」区的 `*.md`（含内容 ✓）：跳过点开头的文件/目录、跳过**系统导航文件** ✓。
 * 只给 `registerBuildCacheEntries` 用（登记缓存要的是"盘上真有什么" ✓，不是"谁写的" ✓）。
 */
async function collectNoteFiles(notesDir, out = []) {
	let entries;
	try {
		entries = await readdir(notesDir, { withFileTypes: true });
	} catch {
		return out;   // 笔记区还不存在 ⇒ 没有可登记的 ✓
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) { continue; }
		const full = join(notesDir, entry.name);
		if (entry.isDirectory()) { await collectNoteFiles(full, out); continue; }
		if (!entry.name.endsWith('.md') || isSystemNavFile(entry.name)) { continue; }
		try {
			out.push({ path: full, content: await readFile(full, { encoding: 'utf8' }) });
		} catch { /* 读不动 ⇒ 当没有 ✓ */ }
	}
	return out;
}
