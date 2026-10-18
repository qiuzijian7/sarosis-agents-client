// @vssaros/dsh-codebase — store（主机侧 I/O）：读 `<workspace>/.codebase-memory/`。只读。
//
// **轻/重两条路**（这是本模块性能上的关键设计）：
//   轻：`artifact.json`（几百字节）→ 节点/边计数、project、saved_at，**不解压**；
//   重：`graph.db.zst`（本机 8.4MB → 解压 129MB）→ 全量图，**按需 + 带缓存 + 有上限**。
// 页面默认走轻路径，只有显式检索/深度视图才付解压与内存的代价。
//
// 工作区根：`config.workspaceRoot`（VsSaros 经 --patch 注入；真源方案说"按会话 cwd 定位图谱"）。
// Host 进程的 cwd 不是工作区，所以**不猜**：没配就是"未配置"（工具报错、页面说明），而不是去读别人的图。

import { readFile, readdir, stat } from 'node:fs/promises';
import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { foundation } from './foundationRef.js';
import { parseGitPaths, parseManifest, validateGraph } from './core/codebase.js';
import { indexTargetOf, readShadowInfo, shadowReadableOf } from './shadow.js';

/** 异步解压（libuv 线程池）：`gunzipSync` 会把 Host 主线程连别的请求一起卡住 ✗（见下方 `loadGraph` 注释）。 */
const gunzip = promisify(gunzipCallback);

export const MANIFEST_FILE = 'artifact.json';
export const GRAPH_FILE = 'graph.db.zst';
export const SQLITE_FILE = 'graph.db.sqlite';
/** 解压后超过这个大小就拒绝加载（129MB 已经在可接受边缘；再大就是别的东西了）。 */
export const MAX_DECOMPRESSED_BYTES = 400 * 1024 * 1024;
/**
 * 扫描/搜索时**一律跳过**的目录（2026-10-13 上移到这一层）。
 *
 * 为什么在这一层：读侧的文本搜索（`searchCode`）与写侧的索引扫描（`indexer.js::collectSourceFiles`）
 * 必须用**同一份**排除口径 ✓ —— 否则会出现"索引器没扫 `out/`、搜索却搜进去了"这种**只在边角上错**的差异 ✗✗
 * （而 `indexer.js` 本来就 import 本文件 ✓ ⇒ 依赖方向天然成立，不必成环 ✓）。
 *
 * ⚠ 这次上移还**顺手修掉一个哑炸点** ✗：`SKIP_DIRS` 原本只在 `indexer.js` 里**私有**声明 ✓，
 *   而本文件的 `listDir` 直接引用了它 ✗ ⇒ `listDir` 一旦被调用就 ReferenceError ✓。
 *   它此前**从未被调用**（导出了但没人用 ✓）⇒ 所以一直没暴露 —— 这次搜索要用，才把它顶出来 ✓。
 */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.codebase-memory', 'out', 'dist', 'build', 'dsh-runtime', '.vscode-test']);

/**
 * 工作区根（源码根 = 图谱与源码读写的锚点）。
 *
 * 优先级（★ 2026-10-17 加了第一级）：**运行期上下文** → `config.workspaceRoot`（启动时
 * `--patch` 注入的快照）→ `null`（不猜 ✓）。
 *
 * 为什么加运行期那一级：config 那份只在 Host 启动时注入 ⇒ 从前切工作区必须重启 Host 才能跟上
 * （而重启会把在跑的会话杀掉）。运行期上下文的真源与三条纪律见
 * `@vssaros/dsh-foundation/lib/workspaceContext.js` ✓。
 * ⚠ 有上下文就**以它为准**：上下文里没有根（＝当前工作区没有可用的主根）⇒ 返回 `null`
 *   （工具/页面照旧如实报"未配置"，**不回落到旧工作区的根** —— 那会变成"图来自 A、你以为在 B" ✗）。
 */
export function workspaceRootOf(config) {
	const runtime = workspaceContext();
	if (runtime) {
		return runtime.workspaceRoot ?? null;
	}
	const configured = typeof config?.workspaceRoot === 'string' ? config.workspaceRoot.trim() : '';
	return configured || null;
}

/** 运行期工作区上下文；`undefined` = 没有（foundation 缺席 / 从未推过都算"没有" ⇒ 回落 config ✓）。 */
function workspaceContext() {
	// 为什么要 try：`foundation()` 在服务未绑定时**故意抛错**（fail-fast ✓），而本模块全是工具/页面的
	// 热路径 ⇒ 不能让它把"读一眼工作区根"变成整页报错 ✗（与 config 回落同语义 ✓）。
	try {
		return foundation().workspaceContext?.() ?? undefined;
	} catch {
		return undefined;
	}
}

export function codebaseDirOf(config) {
	const root = workspaceRootOf(config);
	return root ? join(root, '.codebase-memory') : null;
}

/**
 * ★ P1（2026-10-12）：**图谱从哪个目录读** —— 影子产物优先，否则 IDE 产物。
 *
 * 两条目录的语义差别只说一句：**源码根永远只有一个**（`resolveRoot(config)`）✓ ——
 * 影子目录里**只有图谱产物**（`artifact.json` + `graph.db.zst`），**没有源码** ⇒
 * `readSourceSlice` 仍然按工作区根解析相对路径 ✓（这一点搞混就会"图来自 A、源码读的是 B"✗✗）。
 *
 * 采用影子产物的判据只有一条：**清单在、且图在** ✓（`shadowReadableOf`）——
 * "清单说有图、其实图不在"这种最误导的状态因此不可能被读侧采用 ✓（由 shadow.js 的写入顺序保证它不出现 ✓）。
 * 影子目录**存在但不可读**时：回退 IDE 产物，但把 `shadow` 的实情报出来 ✓（不静默 ✗ —— 否则"我明明索引过了"会无解）。
 *
 * ★★ P3-b（2026-10-12）**新鲜度纪律**：影子产物**只有在不比 IDE 产物旧**时才被采用 ✓。
 *
 * 为什么必须补这一条（我自己往回看时发现的缺口 ✗）：P1 只判"影子可读吗"，于是**一次索引之后**，
 * 只要用户后来在 IDE 里又跑过索引（IDE 的图更新 ✓），我们用旧影子**静默盖住**了更新的那张图 ✗✗ ——
 * 症状是"图里的符号/行号跟当前代码对不上，而页面看不出为什么"，正是本仓最贵的那类静默错 ✓。
 * 判据用**产物自称的 `saved_at`**（两边同一口径：IDE 的 artifact.json 与我们的 manifestOf 都写它 ✓），
 * 读不到才退回文件 `mtimeMs` ✓；平手时**用影子**（同一次索引的两种视角，影子更全：多了符号与调用边 ✓）。
 * 被这条挡下来时**不静默**：返回 `staleShadow`（谁更新、差多少）⇒ 页面/工具会显示，状态工具也答得出来 ✓。
 *
 * @returns `{ root, dir, source: 'shadow'|'ide', shadow?, staleShadow?, savedAt?, ageMs? }` | `{ error }`
 */
export async function graphDirOf(config) {
	const root = await resolveRoot(config);
	if (!root) {
		return { error: '未配置 workspaceRoot：Host 进程的 cwd 不是工作区，所以不猜图谱位置（VsSaros 经 --patch 注入 config.workspaceRoot）。' };
	}
	// IDE 那一份：**只读清单**（轻路径 ✓，不解压图谱 ✓）—— 为了比新鲜度也够 ✓
	const ideDir = join(root, '.codebase-memory');
	const readManifestOf = async dir => {
		const info = await statOf(join(dir, MANIFEST_FILE));
		let manifest;
		if (info?.isFile()) {
			try {
				const parsed = parseManifest(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
				manifest = parsed.error ? undefined : parsed.manifest;
			} catch {
				manifest = undefined; // 读不动 ⇒ 当它没有清单（下面的新鲜度退回 mtime ✓）
			}
		}
		return { manifest, exists: !!info?.isFile(), mtimeMs: info?.mtimeMs };
	};
	const withAge = (placed, savedAt) => ({
		...placed,
		...(savedAt !== undefined ? { savedAt, ageMs: Math.max(0, Date.now() - savedAt) } : {}),
	});
	// ★ 交接档（`indexTarget: 'workspace'`）：**没有"影子 vs IDE"这回事** —— 落点就是那一个目录 ✓
	//   （两边写的是同一份产物 ⇒ "谁更新"这种比较毫无意义，谁最后写谁是真的 ✓）。
	//   ⚠ 这一档**不读影子目录**：换向之后留下的旧影子产物**不许**再参与（否则"我明明交接了、读的还是老影子" ✗✗）。
	if (indexTargetOf(config).target === 'workspace') {
		const own = await readManifestOf(ideDir);
		return withAge({ root, dir: ideDir, source: 'workspace', target: 'workspace' }, freshnessOf(own.manifest, own.mtimeMs));
	}
	const info = await readShadowInfo(config, root);
	const ide = await readManifestOf(ideDir);
	const ideSavedAt = freshnessOf(ide.manifest, ide.mtimeMs);
	if (shadowReadableOf(info)) {
		const shadowSavedAt = freshnessOf(info.manifest, info.mtimeMs);
		// ⚠ 只有"IDE 明确更新"才让位（`>`；平手留影子 ✓）—— 不敢用"接近就算旧"，那会在时钟/粒度噪声上乱跳 ✗
		if (ideSavedAt !== undefined && shadowSavedAt !== undefined && ideSavedAt > shadowSavedAt) {
			return {
				root,
				dir: ideDir,
				source: 'ide',
				shadow: { dir: info.dir, placement: info.source, manifest: info.manifest, bytes: info.bytes, mtimeMs: info.mtimeMs },
				staleShadow: { shadowSavedAt, ideSavedAt, ageMs: ideSavedAt - shadowSavedAt },
				savedAt: ideSavedAt,
			};
		}
		return withAge({
			root,
			dir: info.dir,
			source: 'shadow',
			shadow: { dir: info.dir, placement: info.source, manifest: info.manifest, bytes: info.bytes, mtimeMs: info.mtimeMs },
			...(ideSavedAt !== undefined ? { ideSavedAt } : {}),
		}, shadowSavedAt);
	}
	// 影子不可读：能报就报（没配 indexDir 时连影子目录都算不出来 ⇒ 那不算"有问题"，不报 ✓）
	const shadow = info && !info.error ? { dir: info.dir, placement: info.source, present: info.present, ...(info.missing ? { missing: info.missing } : {}), ...(info.manifestError ? { manifestError: info.manifestError } : {}) } : undefined;
	return withAge({ root, dir: ideDir, source: 'ide', ...(shadow ? { shadow } : {}) }, ideSavedAt);
}

/** 产物"多新"：优先它自称的 `saved_at`（两边同口径 ✓），读不到才退回文件 mtime ✓。 */
function freshnessOf(manifest, mtimeMs) {
	const declared = Number(manifest?.savedAt);
	if (Number.isFinite(declared) && declared > 0) {
		return declared;
	}
	return typeof mtimeMs === 'number' && mtimeMs > 0 ? Math.round(mtimeMs) : undefined;
}

async function statOf(path) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

/**
 * 图谱**相关根**（主根之外的其余根）：VsSaros 经**同一份覆盖层**注入 `config.relatedRoots`
 * （主根是 `workspaceRoot`，这里只是其余根；见 README 4.87/4.88）。去重、去空白、**主根不重复列**。
 *
 * ★ 2026-10-17：与 `workspaceRootOf` 同一条纪律（运行期上下文优先 ✓）。
 * ⚠ 这里**必须**用上下文里的那一份（哪怕它是**空数组**）：切到"没有关联根"的工作区时若回落到
 * config 的旧列表，检索会继续在**旧工作区**的根里翻 ✗（那种"图里多了几个不认识的根"最误导 ✓）。
 */
export function relatedRootsOf(config) {
	const runtime = workspaceContext();
	const raw = runtime ? runtime.relatedRoots : (Array.isArray(config?.relatedRoots) ? config.relatedRoots : []);
	const main = workspaceRootOf(config);
	const out = [];
	for (const entry of raw) {
		const root = typeof entry === 'string' ? entry.trim() : '';
		if (root && root !== main && !out.includes(root)) {
			out.push(root);
		}
	}
	return out;
}

async function hasCodebaseDir(root) {
	try {
		return (await stat(join(root, '.codebase-memory'))).isDirectory();
	} catch {
		return false;
	}
}

/**
 * **实际用哪个根**：主根优先 ✓，主根没有 `.codebase-memory/` 时按 `config.relatedRoots` 的顺序找第一个有图的根 ✓；
 * 都没有时**回落到主根** ✓（这样"还没建过图谱"的提示指向主根，与只有单根时的行为完全一致 ✓）。
 *
 * 为什么"实际用哪个根"必须**可观测**：页面与工具都在打印返回里的 `workspaceRoot` ✓ —— 读了哪个根一眼能看出来，
 * 免得又变成"看起来正常、其实读的是别人的图" ✗（那种静默错最贵）。
 */
export async function resolveRoot(config) {
	const main = workspaceRootOf(config);
	if (!main) {
		return null;
	}
	if (await hasCodebaseDir(main)) {
		return main;
	}
	for (const root of relatedRootsOf(config)) {
		if (await hasCodebaseDir(root)) {
			return root;
		}
	}
	return main;
}

/** 轻路径：清单 + 磁盘上的图谱文件信息（不读图谱内容）。 */
export async function readOverview(config) {
	// ★ 用**实际**的根（主根没有图谱时会退到 relatedRoots 里第一个有图的根）✓；`files`/`manifest` 都按它读 ✓，
	// 返回里的 `workspaceRoot` 也就是"实际用的根" ✓ ⇒ 页面与工具**自动**如实显示（它们只打印这个字段 ✓）。
	// ★ P1：**图谱目录**改由 `graphDirOf` 决定（影子优先 ✓）；`workspaceRoot` 仍是**源码根** ✓，两者不是一回事。
	const placed = await graphDirOf(config);
	if (placed.error) {
		return { error: placed.error };
	}
	const root = placed.root;
	const dir = placed.dir;
	const files = {};
	for (const name of [MANIFEST_FILE, GRAPH_FILE, SQLITE_FILE]) {
		try {
			const info = await stat(join(dir, name));
			files[name] = { bytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
		} catch {
			files[name] = undefined;
		}
	}
	let manifest;
	let manifestError;
	if (files[MANIFEST_FILE]) {
		const parsed = parseManifest(await readFile(join(dir, MANIFEST_FILE), { encoding: 'utf8' }));
		if (parsed.error) {
			manifestError = parsed.error;
		} else {
			manifest = parsed.manifest;
		}
	}
	return {
		workspaceRoot: root,
		dir,
		// ★ P1：**这张图从哪来**（页面/工具/探针都要能一眼看出，别让人猜 ✓）
		graphSource: placed.source,
		// ★ 决策 3：**落点是哪一档**（`shadow` / `workspace`）—— "图从哪来"与"写到哪"是两个问题 ✓
		...(placed.target ? { indexTarget: placed.target } : {}),
		// ★ P3-b：**它有多新** + 影子被"更新的 IDE 图"顶掉时的实情 ✓（一律不静默 ✗）
		...(placed.savedAt !== undefined ? { savedAt: placed.savedAt, ageMs: placed.ageMs } : {}),
		...(placed.staleShadow ? { staleShadow: placed.staleShadow } : {}),
		...(placed.ideSavedAt !== undefined ? { ideSavedAt: placed.ideSavedAt } : {}),
		...(placed.shadow ? { shadow: placed.shadow } : {}),
		files,
		manifest,
		...(manifestError ? { manifestError } : {}),
		...(Object.values(files).every(f => f === undefined) ? { missing: dir } : {}),
	};
}

/** 图谱缓存：按 路径+大小+mtime 判定失效（改了图就重读）。 */
let cache; // { path, size, mtimeMs, graph, ms }

/**
 * 重路径：解压 + 解析全量图。
 * @returns `{ graph, ms, bytes, cached, source }` 或 `{ error }`（`source` = 图来自影子/IDE ✓）
 */
export async function loadGraph(config, { timeoutMs = 60_000 } = {}) {
	// 同 readOverview：用**实际**的图谱目录（P1 起：影子产物优先 ✓）；没有工作区根时按同一句话报错 ✓
	const placed = await graphDirOf(config);
	if (placed.error) {
		return { error: '未配置 workspaceRoot（见 readOverview 的说明）' };
	}
	const dir = placed.dir;
	const path = join(dir, GRAPH_FILE);
	let info;
	try {
		info = await stat(path);
	} catch (e) {
		return { error: `读不到图谱文件（${e?.code ?? 'unknown'}）：${path}` };
	}
	if (cache && cache.path === path && cache.size === info.size && cache.mtimeMs === info.mtimeMs) {
		return { graph: cache.graph, ms: cache.ms, bytes: cache.bytes, cached: true, source: placed.source };
	}
	const started = Date.now();
	let text;
	try {
		const compressed = await readFile(path);
		// **异步**解压（2026-10-12，报告 §5-3）：原来这里是 `gunzipSync` ✗ —— 129MB 的图谱在 **Host 主线程**
		// 上同步解压，会把同进程的其它请求（页面、别的工具、桥）**一起卡住** ✗。`await gunzip(…)` 走
		// **libuv 线程池** ✓，主线程继续服务别的请求 ✓（`loadGraph` 本来就是 async、调用方全都 await ✓，
		// 所以这次改动只动了这两行 ✓）。
		const raw = await gunzip(compressed);
		if (raw.length > MAX_DECOMPRESSED_BYTES) {
			return { error: `解压后 ${raw.length} 字节 > 上限 ${MAX_DECOMPRESSED_BYTES}，拒绝加载（改走 sqlite 快照或减小图谱）` };
		}
		if (Date.now() - started > timeoutMs) {
			return { error: `解压耗时超过 ${timeoutMs}ms` };
		}
		text = raw.toString('utf8');
	} catch (e) {
		return { error: `图谱解压失败（不是 gzip？）：${String(e?.message ?? e)}` };
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `图谱 JSON 解析失败：${String(e?.message ?? e)}` };
	}
	const validated = validateGraph(raw);
	if (validated.error) {
		return { error: validated.error };
	}
	const ms = Date.now() - started;
	cache = { path, size: info.size, mtimeMs: info.mtimeMs, graph: validated.graph, ms, bytes: text.length, source: placed.source };
	return { graph: validated.graph, ms, bytes: text.length, cached: false, source: placed.source };
}

/** 源码切片的上限（`codebase_snippet` 用）：一次最多回这么多行 / 读这么大的文件。 */
export const SNIPPET_MAX_LINES = 400;
export const SNIPPET_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * 读一个**图谱节点**对应的源码片段（`codebase_snippet` 的 I/O 半边 ✓）。
 *
 * ⚠ 三条围栏（都是"读错了比读不到更坏"那类问题 ✓）：
 *   ① **按实际用的根解析** ✓ —— 用 `resolveRoot(config)`（主根没有图谱时会退到 relatedRoots ✓），
 *      保证"图里来的相对路径"与"读的树"是**同一个** ✓；否则会读成别的工作区的同名文件 ✗（静默错最贵 ✓）。
 *   ② 相对路径**只许往里** ✓：拒绝绝对路径 / 盘符 / 任何 `..` 段 ✓，拼完再做**前缀复核** ✓（双保险 ✓）。
 *   ③ 大小先 `stat` 再读 ✓（超大文件如实拒绝 ✓，别把 Host 内存吃掉 ✗）。
 * @returns `{ ok: true, root, absPath, text, bytes }` | `{ ok: false, why }`
 */
export async function readSourceSlice(config, node, { contextLines = 3, maxLines = SNIPPET_MAX_LINES } = {}) {
	const root = await resolveRoot(config);
	if (!root) { return { ok: false, why: '没有工作区根（config.workspaceRoot 未配置）⇒ 不知道怎么把图谱里的相对路径落到盘上 ✗' }; }
	const rel = String(node?.filePath ?? '').replace(/\\/g, '/').trim();
	if (!rel) { return { ok: false, why: '这个节点没有 filePath（图谱里是文件级之外的节点？）✗' }; }
	if (/^[a-zA-Z]:\//.test(rel) || rel.startsWith('/') || rel.split('/').some(seg => seg === '..')) {
		return { ok: false, why: `图谱里的路径不安全，拒绝读取：${rel} ✗（只允许工作区内相对路径 ✓）` };
	}
	const rootPosix = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
	const absPath = `${rootPosix}/${rel}`;
	if (!absPath.toLowerCase().startsWith(`${rootPosix.toLowerCase()}/`)) {
		return { ok: false, why: `路径复核没过（拼出来跑到工作区外了）：${absPath} ✗` };
	}
	let size = 0;
	try {
		const info = await stat(absPath);
		if (!info.isFile()) { return { ok: false, why: `不是普通文件：${rel}` }; }
		size = info.size;
	} catch (e) {
		return { ok: false, why: `读不到文件：${rel}（${String(e?.code ?? e?.message ?? e)}）—— 图谱可能是旧的，或该文件已移动 ✓` };
	}
	if (size > SNIPPET_MAX_FILE_BYTES) {
		return { ok: false, why: `文件太大（${size} 字节 > ${SNIPPET_MAX_FILE_BYTES}）⇒ 拒绝整读 ✓；换用 codebase_search / 别的工具按需看 ✓` };
	}
	const text = await readFile(absPath, 'utf8');
	return { ok: true, root, absPath, text, bytes: size };
}

/** git 可执行名（`config.gitExe` 可覆盖 ✓：装在非标准位置时能指路 ✓）。 */
export function gitExeOf(config) {
	return (typeof config?.gitExe === 'string' && config.gitExe.trim()) || 'git';
}

/**
 * 跑 git 拿"自 `since` 起变更的文件"（`codebase_changes` 的 I/O 半边 ✓）。
 *
 * 三条纪律（都是本模块已有做法或已有教训 ✓）：
 *  ① **动态 import `node:child_process`** ✓ —— 本模块的原则是"别把它带进插件主路径"
 *     （见 `indexer.js` 里自证那段的同款注释 ✓）；
 *  ② 参数**逐个进数组、不经 shell** ✓，且 ref 先过 `isSafeGitRef`（调用方做 ✓）—— `-` 开头会被 git
 *     当**选项**解析 ✗（参数注入的经典入口 ✓）；
 *  ③ 失败**分型** ✓：没有 git / 不是仓库 / ref 不存在 —— 三者"下一步"完全不同 ✓，
 *     糊成一句"git 失败"是这三者里最没用的一种 ✓。
 * @returns `{ ok: true, root, tracked, untracked }` | `{ ok: false, kind, why }`
 */
export async function runGitChanges(config, { since = 'HEAD' } = {}) {
	const root = await resolveRoot(config);
	if (!root) { return { ok: false, kind: 'no-root', why: '没有工作区根（`config.workspaceRoot` 未配置）⇒ 不知道在哪个仓库里跑 git ✗' }; }
	const { spawnSync } = await import('node:child_process');
	const exe = gitExeOf(config);
	const run = args => spawnSync(exe, ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
	const probe = run(['rev-parse', '--is-inside-work-tree']);
	if (probe.error?.code === 'ENOENT') {
		return { ok: false, kind: 'no-git', why: `没找到 git 可执行文件（${exe}）⇒ 装上 git，或用 config.gitExe 指个绝对路径 ✓` };
	}
	if (probe.status !== 0 || !String(probe.stdout ?? '').includes('true')) {
		return { ok: false, kind: 'not-a-repo', why: `「${root}」不是 git 仓库（或 git 拒绝访问）⇒ 本工具需要 git ✓：${String(probe.stderr ?? '').trim().slice(0, 160)}` };
	}
	const tracked = run(['diff', '--name-only', '--no-renames', since]);
	if (tracked.status !== 0) {
		return { ok: false, kind: 'bad-ref', why: `\`git diff ${since}\` 失败（ref 不存在 / 克隆太浅 / 拼写错 ✗）：${String(tracked.stderr ?? '').trim().slice(0, 200)}` };
	}
	// 未跟踪的新文件**也算变更** ✓（否则"刚加的文件"永远进不了影响面 ✗）；与 tracked **分列** ⇒ 调用方能分清 ✓
	const others = run(['ls-files', '--others', '--exclude-standard']);
	return {
		ok: true,
		root,
		tracked: parseGitPaths(tracked.stdout),
		untracked: others.status === 0 ? parseGitPaths(others.stdout) : [],
	};
}

/** 图谱目录里还有哪些文件（页面展示用）。 */
/**
 * 文本搜索：**真源 `search_code` 的对应物**（P8，2026-10-13；真源 `search_code` / `search_files` ✓）。
 *
 * ## ⚠ 先纠正一个容易搞错的定位 ✗
 *
 * 真源这两个工具**不是图查询**，是 **ripgrep 驱动的文件系统文本搜索** ✓（`search_code` 的说明里就写着
 * "结构类问题（callers / definitions / dependencies）请用**图**工具" ✓）。所以这里**不碰图谱**：
 * 它**不需要索引**、没有图也能用 ✓ —— 但也因此**答不了**任何结构问题 ✗（那不是它的职责，见 `codebase_search` ✓）。
 *
 * ## 与真源的**硬差别**（写死，别让人以为等价 ✗）
 *
 *   · 真源是 **ripgrep-backed**（流式、巨仓也快 ✓）；dsh 侧是 **Node 扫描**（无外部依赖 ✓，但有上限与代价 ✓）
 *     ⇒ 返回值里如实带 `backend: 'node'` ✓ 与 `scannedFiles` / `truncatedScan` ✓；**没有**实现 rg 后端（未做 ✓）。
 *   · 真源按 `.gitignore` 等忽略规则过滤 ✓；dsh 侧只有**排除目录集**（`.git` / `node_modules` / 构建产物 ✓）
 *     ⇒ **不读 `.gitignore`** ✗（如实说明，免得"以为被忽略了其实被搜了" ✓）。
 *   · 真源可跨工作区 / 可搜依赖源码（有专门的放行路径 ✓）；dsh 侧**只在工作区内** ✓（与读侧围栏同一条纪律 ✓）。
 *
 * ## 两条"不许静默"的纪律
 *
 * ① **多词自动转正则**（`foo bar` → `foo.*bar`，照真源 ✓）是**一个变换** ⇒ 返回值必须带**生效的正则** `pattern` ✓
 *    （否则用户看到的 query 与真正跑的不是一回事 ✗✗）；
 * ② 命中/扫描被上限截断 ⇒ **如实报** `truncated` / `truncatedScan` ✓（"只搜了一部分"与"就这么多"必须能分开 ✓）。
 */
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 30;
/** Node 扫描的预算（**不是性能参数，是诚实的围栏** ✓：超了就报 `truncatedScan`，而不是悄悄少搜 ✓）。 */
export const SEARCH_SCAN_MAX_FILES = 4000;
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 工作区内的相对路径 → 绝对路径（**与 `codebase_snippet` 同一条围栏** ✓：绝对路径 / `..` 一律拒 ✗）。 */
export function resolveInsideWorkspace(root, relPath) {
	const raw = String(relPath ?? '').trim();
	if (!raw) {
		return { abs: root, parts: [] };
	}
	if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
		return { error: `必须是**工作区内的相对路径** ✗（收到绝对路径 \`${raw}\`）` };
	}
	const parts = raw.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
	if (parts.some(part => part === '..')) {
		return { error: '路径里不许有 `..` ✗（不许跑出工作区 ✓）' };
	}
	const abs = parts.length ? join(root, ...parts) : root;
	const norm = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	if (norm(abs) !== norm(root) && !norm(abs).startsWith(`${norm(root)}/`)) {
		return { error: '解析之后跑出了工作区 ✗' };
	}
	return { abs, parts };
}

/** 简化 glob → 正则（只支持 `**` / `*` / `?` ✓；其他魔字符**如实拒** ✗ —— 悄悄当成字面量比拒更坏 ✓）。 */
export function globToRegExp(glob) {
	const text = String(glob ?? '').trim();
	if (!text) {
		return { error: 'filePattern 不能为空 ✗' };
	}
	const bad = /[{}[\]()+^$|\\]/.exec(text);
	if (bad) {
		return { error: `filePattern 只支持 \`*\` / \`**\` / \`?\` ✗（收到 \`${bad[0]}\`）—— 复杂 glob 请用更简单的模式 ✓` };
	}
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '*') {
			if (text[i + 1] === '*') { out += '.*'; i += 1; } else { out += '[^/]*'; }
			continue;
		}
		out += ch === '?' ? '[^/]' : ch.replace(/[.+]/g, m => `\\${m}`);
	}
	return { regex: new RegExp(`^${out}$`, 'i') };
}

/** 多词 → `.*`（照真源 ✓）；生效的模式**要回给调用方** ✓。 */
function effectivePattern(query, useRegex) {
	const raw = String(query ?? '');
	if (useRegex) {
		return { source: raw };
	}
	const escaped = raw.trim().split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	return { source: escaped.join('.*'), converted: escaped.length > 1 };
}

/**
 * 遍历工作区内的一个范围（**唯一一份遍历** ✓ —— `searchCode` 与 `findFiles` 共用 ✓）。
 *
 * 它只管三件**口径**上的事，其余交给回调 ✓：
 *   ① 跳过排除目录（`SKIP_DIRS` + 隐藏目录 ✓）；
 *   ② 到上限就停、并把 `truncatedScan` 置真 ✓（"只扫了一部分"必须能被报出来 ✓）；
 *   ③ 把每个文件交给 `onFile`（`childRel` / 所在目录 / dirent ✓）；回调返回 `true` ⇒ **立刻收工** ✓
 *      （"已经搜够了"要能真停下来 —— 否则 limit 只是"少返回"，扫描照样跑满 ✗）。
 *
 * ⚠ 计数口径：`visited` = **遍历到的文件数**（在回调之前就加 ✓）⇒ 含被 `filePattern` 滤掉的那些 ✓
 *   （`searchCode` 的 `scannedFiles` 就是它 ✓，那里的 notes 也这么写 ✓）。
 * ⚠ 抽公共遍历的动机：两份遍历就是**两套排除口径**，迟早出现"索引器不扫 `out/`、搜索却搜进去"这种
 *   只在边角上错的差异 ✗✗（2026-10-13 抽这一次就是为了关掉这条路 ✓）。
 */
async function walkWorkspace(abs, rel, { onFile, budget = SEARCH_SCAN_MAX_FILES } = {}) {
	const { readdir } = await import('node:fs/promises');
	const state = { visited: 0, truncatedScan: false };
	const walk = async (at, prefix) => {
		if (state.truncatedScan) {
			return;
		}
		let entries;
		try {
			entries = await readdir(at, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (state.truncatedScan) {
				return;
			}
			const childRel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
					continue;
				}
				await walk(join(at, entry.name), childRel);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			if (state.visited >= budget) {
				state.truncatedScan = true;
				return;
			}
			state.visited += 1;
			if (await onFile(childRel, at, entry) === true) {
				return;
			}
		}
	};
	await walk(abs, rel);
	return state;
}

export async function searchCode(config, { query, regex = false, path, filePattern, context = 0, limit = SEARCH_DEFAULT_LIMIT } = {}) {
	// ⚠ 不再直接 `readdir`：遍历已收进 `walkWorkspace` ✓（留着不用的引入只会让人以为这里还自己走目录 ✗）
	const { readFile, stat } = await import('node:fs/promises');
	const started = Date.now();
	const root = String(workspaceRootOf(config) ?? '').trim();
	if (!root) {
		return { error: '未配置 workspaceRoot ⇒ 不猜搜哪里 ✗' };
	}
	const scope = resolveInsideWorkspace(root, path);
	if (scope.error) {
		return { error: `path：${scope.error}` };
	}
	const clamped = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : SEARCH_DEFAULT_LIMIT));
	const ctxLines = Math.max(0, Math.min(5, Number.isFinite(context) ? Math.floor(context) : 0));
	let globMatch;
	let effectiveGlob;
	if (filePattern) {
		// ⚠ 与真源（ripgrep `-g`）对齐：**不含 `/` 的模式**（如 `*.py`）表示"任意路径以它结尾" ✓
		//   —— 若只按"本级目录"匹配（`[^/]*\.py`），`*.py` 会**一个都不中** ✗✗（2026-10-13 冒烟实测踩到 ✓）。
		//   含 `/` 的（如 `src/*.ts`）仍按层级匹配 ✓（`*` 不跨 `/`，`**` 才跨 ✓）。
		effectiveGlob = String(filePattern).includes('/') ? String(filePattern) : `**/${String(filePattern)}`;
		const built = globToRegExp(effectiveGlob);
		if (built.error) {
			return { error: built.error };
		}
		globMatch = built.regex;
	}
	const pattern = effectivePattern(query, regex === true);
	let matcher;
	try {
		matcher = new RegExp(pattern.source, 'i');
	} catch (error) {
		return { error: `query 不是合法正则：${String(error?.message ?? error)} ✗` };
	}
	const files = [];
	let hits = 0;
	let truncated = false;
	let skippedBinary = 0;
	let skippedOversized = 0;
	// ★ 遍历走**唯一一份** `walkWorkspace` ✓（与 `findFiles` 同口径：同一套排除目录、同一个上限 ✓）
	//   ⚠ 副作用（**有意**的 ✓）：`scannedFiles` 现在是"**遍历到**的文件数"（在 `filePattern` 过滤**之前**计数 ✓）——
	//   这比原来那个"候选数"更贴近它的名字 ✓，且与 `findFiles` 的 `scannedFiles` 同义 ✓（notes 里也这么写 ✓）。
	const state = await walkWorkspace(scope.abs, scope.parts.join('/'), {
		onFile: async (childRel, parentAbs, entry) => {
			if (globMatch && !globMatch.test(childRel)) {
				return false;
			}
			let info;
			try {
				info = await stat(join(parentAbs, entry.name));
			} catch {
				return false;
			}
			if (info.size > SEARCH_MAX_FILE_BYTES) {
				skippedOversized += 1;
				return false;
			}
			let text;
			try {
				text = await readFile(join(parentAbs, entry.name), 'utf8');
			} catch {
				return false;
			}
			// 二进制：**不当成错误**，计数后跳过 ✓（把一个 0 命中的判断说清楚，比假装搜过好 ✓）
			if (text.includes('\u0000')) {
				skippedBinary += 1;
				return false;
			}
			const lines = text.split(/\r?\n/);
			const picked = [];
			for (let i = 0; i < lines.length; i++) {
				matcher.lastIndex = 0;
				if (!matcher.test(lines[i])) {
					continue;
				}
				if (hits >= clamped) {
					truncated = true;
					break;
				}
				hits += 1;
				picked.push({
					line: i + 1,
					text: lines[i].slice(0, 400),
					...(ctxLines > 0 ? { before: lines.slice(Math.max(0, i - ctxLines), i).map(line => line.slice(0, 400)), after: lines.slice(i + 1, i + 1 + ctxLines).map(line => line.slice(0, 400)) } : {}),
				});
			}
			if (picked.length) {
				files.push({ relPath: childRel, hits: picked });
			}
			// 命中行够了 ⇒ **立刻收工** ✓（否则 limit 只是"少返回"，扫描照样跑满 ✗）
			return truncated;
		},
	});
	const scannedFiles = state.visited;
	const truncatedScan = state.truncatedScan;
	return {
		ok: true,
		query: String(query ?? ''),
		pattern: pattern.source,
		...(pattern.converted ? { converted: '多词已按真源规则转成 `.*` 连接 ✓（生效模式见 pattern ✓）' } : {}),
		regex: regex === true,
		backend: 'node',
		scope: scope.parts.join('/') || '.',
		// ⚠ 回**生效的** glob（无 `/` 的会被补成 `**/…` ✓）—— 用户看到的必须就是真正跑的 ✓
		...(effectiveGlob ? { filePattern: effectiveGlob, ...(effectiveGlob !== filePattern ? { filePatternNote: `\`${filePattern}\` 不含 \`/\` ⇒ 按"任意路径以它结尾"处理（与真源 ripgrep \`-g\` 同义 ✓），生效模式是 \`${effectiveGlob}\` ✓` } : {}) } : {}),
		context: ctxLines,
		limit: clamped,
		// ⚠ 语义写死：这是**命中行数**（同一行里多处匹配只算一行 ✓）—— 别把"行数"读成"匹配次数"✗
		totalHits: hits,
		hitUnit: 'matched-line',
		fileCount: files.length,
		files,
		truncated,
		truncatedScan,
		scannedFiles,
		...(skippedBinary ? { skippedBinary } : {}),
		...(skippedOversized ? { skippedOversized } : {}),
		skippedDirs: [...SKIP_DIRS],
		ms: Date.now() - started,
		notes: [
			'dsh 侧是 **Node 扫描**（无 ripgrep 依赖 ✓，但有上限 ✓）：真源是 ripgrep-backed ⇒ 差别是**速度**，不是语义 ✓',
			`排除目录：${[...SKIP_DIRS].join(' / ')} ✓；**不读** \`.gitignore\` ✗（真源会读 ⇒ 这是硬差别 ✓）`,
			'只在工作区内搜索 ✓（与读侧围栏同一条纪律 ✓）',
			'`totalHits` 是**命中行数**（同一行多处匹配只算一行 ✓，见 `hitUnit` ✓）',
			'`scannedFiles` 是**遍历到**的文件数（含被 `filePattern` 滤掉的 ✓）—— 与 `findFiles` 同义 ✓；到上限会置 `truncatedScan` ✓',
		],
	};
}

/**
 * 按**名字/路径**找文件（真源 `search_files` 的 `files` 模式 ✓ —— "代替 `find` / `ls`" 那半边 ✓）。
 *
 * ## 与 `searchCode` 的分工（**两件事，别混** ✗）
 *
 *   · 这个：**只读目录项**（不读文件内容 ✓）⇒ 快、且与文件大小无关 ✓；
 *   · `searchCode`：**读内容** ✓（有大小上限与二进制跳过 ✓）。
 *
 * ## 匹配语义（两种，**如实回报是哪一种** ✓）
 *
 *   · 带通配符（星号或问号，见 `globToRegExp` ✓）⇒ 按 **glob** 匹配**相对路径** ✓；模式里没有斜杠时，
 *     按真源（ripgrep `-g`）语义补"任意目录"前缀 ✓（即"任意路径以它结尾" ✓，见 `effectivePattern` ✓）；
 *   · 不带通配符 ⇒ 按**文件名子串**匹配 ✓（`matchedBy: 'substring'` ✓）—— glob 语义下 `router` 会变成
 *     "正好叫 router"，对"找文件"几乎没用 ✗ ⇒ 这里选子串 **并把选择说出来** ✓（不静默换语义 ✓）。
 *
 * ★ 2026-10-13（当天收尾）：目录遍历已收进 `walkWorkspace`（**唯一一份** ✓，`searchCode` 与它同用 ✓）——
 *   原先两份遍历就是**两套排除口径**，迟早出现"索引器不扫 `out/`、搜索却搜进去"这种只在边角上错的差异 ✗✗。
 *   ⚠ 顺带统一了 `scannedFiles` 的口径（= **遍历到**的文件数 ✓，与 `searchCode` 同义 ✓）。
 * ⚠ 结果**确定性排序**（同输入同输出 ✓ —— 探针与页面可比对 ✓）。
 *
 * ⚠ 注释纪律（本仓踩过多次 ✗）：块注释里**不许**出现星号紧跟斜杠的序列（会提前闭合注释 ✓）——
 *   所以上面讲"通配符"与"任意目录前缀"都用**文字**说，而不是把符号原样贴出来 ✓。
 */
export async function findFiles(config, { pattern, path, limit = SEARCH_DEFAULT_LIMIT, offset = 0 } = {}) {
	const { readdir } = await import('node:fs/promises');
	const started = Date.now();
	const root = String(workspaceRootOf(config) ?? '').trim();
	if (!root) {
		return { error: '未配置 workspaceRoot ⇒ 不猜找哪里 ✗' };
	}
	const scope = resolveInsideWorkspace(root, path);
	if (scope.error) {
		return { error: `path：${scope.error}` };
	}
	const raw = String(pattern ?? '').trim();
	if (!raw) {
		return { error: '必须给一个 `pattern` ✗（glob 如 `*.ts`，或文件名的子串如 `router`）' };
	}
	const hasMagic = /[*?]/.test(raw);
	const matchedBy = hasMagic ? 'glob' : 'substring';
	let matcher;
	let effectivePattern;
	if (hasMagic) {
		effectivePattern = raw.includes('/') ? raw : `**/${raw}`;
		const built = globToRegExp(effectivePattern);
		if (built.error) {
			return { error: built.error };
		}
		matcher = built.regex;
	} else {
		const lowered = raw.toLowerCase();
		matcher = { test: value => String(value).toLowerCase().includes(lowered) };
	}
	const clampLimit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : SEARCH_DEFAULT_LIMIT));
	const skip = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
	const found = [];
	// ★ 遍历走**唯一一份** `walkWorkspace` ✓（与 `searchCode` 同口径：同一套排除目录、同一个上限 ✓）
	const state = await walkWorkspace(scope.abs, scope.parts.join('/'), {
		onFile: async (childRel, _parentAbs, entry) => {
			// glob 按**相对路径**配（`**` 前缀才有意义 ✓）；子串按**文件名**配（"找文件"的语义 ✓）
			if (matcher.test(hasMagic ? childRel : entry.name)) {
				found.push(childRel);
			}
			return false;
		},
	});
	let visited = state.visited;
	let truncatedScan = state.truncatedScan;
	found.sort((a, b) => a.localeCompare(b));
	const page = found.slice(skip, skip + clampLimit);
	return {
		ok: true,
		pattern: raw,
		matchedBy,
		...(effectivePattern ? { effectivePattern } : {}),
		backend: 'node',
		scope: scope.parts.join('/') || '.',
		total: found.length,
		returned: page.length,
		offset: skip,
		limit: clampLimit,
		truncated: found.length > skip + clampLimit,
		truncatedScan,
		scannedFiles: visited,
		files: page,
		ms: Date.now() - started,
		notes: [
			'只读**目录项**（不读文件内容 ✓）⇒ 与 `mode: content` 是两件事 ✗',
			`排除目录与索引器 / 搜索**同一份**（${[...SKIP_DIRS].length} 项：${[...SKIP_DIRS].join(' / ')} ✓）`,
			'`truncatedScan` 为真时，"没找到"只代表**扫到的那部分**没有 ✗（不是"整个工作区没有" ✓）',
		],
	};
}

/**
 * ADR（Architecture Decision Record）：**真源 `manage_adr` 的对应物**（P9，2026-10-13 ✓）。
 *
 * ## 落点与所有权（**这里要靠已经定下的那条决策** ✓）
 *
 * 默认落在**工作区内的** `.codebase-memory/adr/` ✓（可用 `config.adrDir` 改 ✓，但**只许工作区内** ✓）。
 *
 * 为什么敢往 `.codebase-memory/` 里放：所有权已经交接给 dsh ✓（产物自称 `producer: 'vssaros-dsh'` ⇒
 * IDE 侧不索引、不落盘 ✓，见 `indexer.js` 的 `ARTIFACT_PRODUCER` 注释 ✓）—— 也正是**必须**放在工作区里的原因：
 * ADR 是**仓库内容** ✓（要跟着 git 走、要能被同事 review ✓），放进我们自己的索引数据目录（影子目录 / `DSH_HOME`）
 * 就变成了"只有这台机器看得见"的私有笔记 ✗✗。
 *
 * ## 文件名即 id（**不许含糊** ✗）
 *
 * `NNN-slug.md`（如 `007-adopt-dsh-index.md` ✓）⇒ `id` 就是这个文件主干 ✓；`list` 会把它们原样报出来 ✓，
 * `get` / `update` / `delete` 收"主干"或"纯数字前缀"（`007` ✓）两种写法 ✓，**别的一律拒** ✗
 * （不许拿一段内容或路径当 id ⇒ 那是路径穿越的入口 ✓）。
 */
export const ADR_SUBDIR = '.codebase-memory/adr';
const ADR_FILE_RE = /^([0-9]{3,})-([a-z0-9][a-z0-9-]*)\.md$/i;

/** ADR 目录（只算路径 + 围栏，**不创建** ✓ —— 创建只在真正写入时发生 ✓）。 */
export function adrDirOf(config) {
	const root = String(workspaceRootOf(config) ?? '').trim();
	if (!root) {
		return { error: '未配置 workspaceRoot ⇒ 不猜 ADR 放哪里 ✗' };
	}
	const configured = typeof config?.adrDir === 'string' && config.adrDir.trim() ? config.adrDir.trim() : ADR_SUBDIR;
	const scope = resolveInsideWorkspace(root, configured);
	if (scope.error) {
		return { error: `adrDir：${scope.error}` };
	}
	return { dir: scope.abs, rel: scope.parts.join('/'), source: configured === ADR_SUBDIR ? '缺省' : 'config.adrDir' };
}

/** 把用户给的 id 收敛成文件主干（主干原样 ✓；纯数字前缀按编号配 ✓；此外一律拒 ✗）。 */
async function resolveAdrFile(config, id) {
	const placed = adrDirOf(config);
	if (placed.error) {
		return { error: placed.error };
	}
	const asked = String(id ?? '').trim();
	if (!asked) {
		return { error: '必须给 `id` ✗（`list` 会把可用的 id 报出来 ✓）' };
	}
	const { readdir } = await import('node:fs/promises');
	let names;
	try {
		names = await readdir(placed.dir);
	} catch {
		names = [];
	}
	const candidates = names.filter(name => ADR_FILE_RE.test(name));
	const wanted = /^[0-9]+$/.test(asked)
		? candidates.filter(name => name.split('-')[0] === asked.padStart(3, '0') || String(Number(name.split('-')[0])) === String(Number(asked)))
		: candidates.filter(name => name === `${asked}.md` || name.replace(/\.md$/i, '') === asked);
	if (!candidates.length) {
		return { error: `还没有任何 ADR（${placed.rel}/ 是空的 ✓）⇒ 先用 \`action: "create"\` 建一条 ✓` };
	}
	if (!wanted.length) {
		return { error: `没有这个 id：\`${asked}\` ✗（现有：${candidates.map(name => name.replace(/\.md$/i, '')).join(' / ')} ✓）` };
	}
	if (wanted.length > 1) {
		return { error: `id \`${asked}\` 匹配到多条：${wanted.join(' / ')} ✗（用完整主干 ✓）` };
	}
	return { placed, name: wanted[0], path: join(placed.dir, wanted[0]), id: wanted[0].replace(/\.md$/i, '') };
}

function adrTitleOf(text, fallback) {
	const heading = /^#\s+(.+)$/m.exec(String(text));
	return heading ? heading[1].trim() : fallback;
}

/** 列出所有 ADR（**只读** ✓）：id / 标题 / 字节 / 修改时间 ✓（标题取自首个一级标题 ✓，没有就退回文件名 ✓）。 */
export async function listAdrs(config) {
	const { readFile, readdir, stat } = await import('node:fs/promises');
	const placed = adrDirOf(config);
	if (placed.error) {
		return { error: placed.error };
	}
	let names;
	try {
		names = (await readdir(placed.dir)).filter(name => ADR_FILE_RE.test(name));
	} catch {
		names = [];
	}
	const items = [];
	for (const name of names.sort()) {
		const path = join(placed.dir, name);
		let text = '';
		let bytes;
		try {
			text = await readFile(path, 'utf8');
			bytes = (await stat(path)).size;
		} catch {
			continue;
		}
		items.push({ id: name.replace(/\.md$/i, ''), title: adrTitleOf(text, name), bytes });
	}
	return {
		ok: true,
		dir: placed.dir,
		relDir: placed.rel,
		dirSource: placed.source,
		count: items.length,
		items,
		notes: [
			'ADR 是**仓库内容** ✓ ⇒ 默认放在工作区内的 `.codebase-memory/adr/`（所有权已交给 dsh ✓），要跟着 git 走 ✓',
			'id 就是文件名主干（`NNN-slug` ✓）；`get` / `update` / `delete` 也收纯数字前缀 ✓',
			'动作 `create` / `update` / `delete` 都是**写** ⇒ 走审批闸 ✓；`list` / `get` 是只读 ⇒ 不问 ✓',
		],
	};
}

/** 读一条 ADR（**只读** ✓）。 */
export async function getAdr(config, { id }) {
	const { readFile } = await import('node:fs/promises');
	const found = await resolveAdrFile(config, id);
	if (found.error) {
		return found;
	}
	let content;
	try {
		content = await readFile(found.path, 'utf8');
	} catch (error) {
		return { error: `读不动 \`${found.id}\`：${String(error?.message ?? error)} ✗` };
	}
	return { ok: true, id: found.id, title: adrTitleOf(content, found.id), path: found.path, relPath: `${found.placed.rel}/${found.name}`, content, bytes: Buffer.byteLength(content, 'utf8') };
}

/** 新建一条 ADR：编号自动取**下一个**（`max + 1` ✓，三位起 ✓）；标题会被写成一级标题 ✓。 */
export async function createAdr(config, { title, content }) {
	const { mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
	const placed = adrDirOf(config);
	if (placed.error) {
		return { error: placed.error };
	}
	const heading = String(title ?? '').trim();
	if (!heading) {
		return { error: '必须给 `title` ✗（它就是一级标题 ✓）' };
	}
	let names = [];
	try {
		names = (await readdir(placed.dir)).filter(name => ADR_FILE_RE.test(name));
	} catch { /* 目录还不存在 ⇒ 编号从 1 起 ✓ */ }
	const nextNumber = names.reduce((max, name) => Math.max(max, Number(name.split('-')[0]) || 0), 0) + 1;
	const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'adr';
	const name = `${String(nextNumber).padStart(3, '0')}-${slug}.md`;
	await mkdir(placed.dir, { recursive: true });
	const body = String(content ?? '').trim();
	const text = `# ${heading}\n${body ? `\n${body}\n` : ''}`;
	await writeFile(join(placed.dir, name), text, 'utf8');
	return { ok: true, action: 'create', id: name.replace(/\.md$/i, ''), title: heading, path: join(placed.dir, name), relPath: `${placed.rel}/${name}`, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 改写一条 ADR（**保留原编号** ✓ —— 编号变了就等于换了一条，引用全断 ✓）。 */
export async function updateAdr(config, { id, title, content }) {
	const { readFile, writeFile } = await import('node:fs/promises');
	const found = await resolveAdrFile(config, id);
	if (found.error) {
		return found;
	}
	const heading = String(title ?? '').trim();
	if (!heading && content === undefined) {
		return { error: '`update` 至少要给 `title` 或 `content` 之一 ✗（不然这次调用什么也没改 ✓）' };
	}
	let old = '';
	try {
		old = await readFile(found.path, 'utf8');
	} catch {
		old = '';
	}
	const body = content === undefined ? old.replace(/^#\s+.+$/m, '').trim() : String(content).trim();
	const finalTitle = heading || adrTitleOf(old, found.id);
	const text = `# ${finalTitle}\n${body ? `\n${body}\n` : ''}`;
	await writeFile(found.path, text, 'utf8');
	return { ok: true, action: 'update', id: found.id, title: finalTitle, path: found.path, relPath: `${found.placed.rel}/${found.name}`, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 删一条 ADR（**破坏性** ✓ ⇒ 走审批闸 ✓；删之前清点、报告如实 ✓）。 */
export async function deleteAdr(config, { id }) {
	const { readFile, rm, stat } = await import('node:fs/promises');
	const found = await resolveAdrFile(config, id);
	if (found.error) {
		return found;
	}
	let bytes;
	let title;
	try {
		const text = await readFile(found.path, 'utf8');
		title = adrTitleOf(text, found.id);
		bytes = (await stat(found.path)).size;
	} catch {
		title = found.id;
		bytes = undefined;
	}
	await rm(found.path, { force: true });
	return { ok: true, action: 'delete', deleted: true, id: found.id, title, path: found.path, relPath: `${found.placed.rel}/${found.name}`, ...(bytes !== undefined ? { bytes } : {}), note: 'ADR 已删（它是仓库内容 ⇒ 记得在 git 里一起提交这次删除 ✓）' };
}

export async function listDir(dir) {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort();
	} catch {
		return [];
	}
}
