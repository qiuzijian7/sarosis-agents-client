// @vssaros/dsh-codebase — indexService：**影子索引的编排**（P1 v0）。
//
// 它把已经存在、已被自证过的三块接起来（不是从零造 ✗）：
//   · `indexer.js` 的 `buildImportGraph`（文件级 `IMPORTS` + 顶层符号 `CONTAINS` + 增量 + 可序列化缓存）；
//   · `core/codebase.js` 的产物契约（`manifestOf` 的字段名、`parseManifest` 的硬校验）；
//   · `shadow.js` 的落点/锁/原子写。
//
// ## P1 的"v0"到底 v 在哪（**写清楚，免被读成"写侧已完成"** ✗）
//
//   · 解析仍是**正则**顶层声明（真 tree-sitter 解析是 P2；P0 只证了"Host 能跑"✓）；
//   · 边只有 `IMPORTS` / `CONTAINS` / `IMPORTS_SYMBOL`（真源的 `CALLS` / `USAGE` / `EXTENDS` 要跨文件符号解析 ✗）；
//   · **不写工作区产物**（`.codebase-memory/` 是 IDE 的所有物 ✓）⇒ 只写影子目录 ✓；
//   · 不注册文件监听、不做后台任务（一次调用 = 一次索引 ✓）；`maxFiles` 有上限并**如实报截断** ✓。
//
// ## 读侧怎么用它（**唯一的接口就是产物本身** ✓）
//
//   `store.js::graphDirOf(config)` 在"影子产物可读"时优先用它 ✓（`artifact.json` + `graph.db.zst` 逐字同形
//   ⇒ 读侧零改动即可消费 ✓）。所以本文件**不导出**任何"给读侧用的对象"——两半只通过盘上的契约耦合 ✓
//   （这正是"将来交接给 IDE 只需改一个目录常量"的前提 ✓）。
//
// ## 增量缓存：**先图后缓存**、且缓存坏了大不了全量重扫 ✓
//
//   缓存（`index-cache.json`）只是"省一次抽取" ✓：`parseCache` 会**大声拒绝**版本/工作区不符的缓存 ✓
//   （见 indexer.js 的注释：它唯一危险的错法是"悄悄用了一点" ✗）。拒绝**不算失败**，但必须**如实报出** ✓。

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';

import { ARTIFACT_PRODUCER, DEFAULT_MAX_FILES, GRAPH_RECIPE_VERSION, REGEX_SOURCE_EXT, buildImportGraph, collectSourceFiles, decodeGraph, encodeGraph, graphFingerprintOf, manifestOf, parseCache, serializeCache, shouldRescan } from './indexer.js';
import { parseManifest } from './core/codebase.js';
// P2：真解析（tree-sitter）—— 复用 P0 的解析器门面（资产链 + worker 池 ✓），不另起一套 ✗
import { createParserPool, describeParser } from './parser/pool.js';
import { EXTENSION_TO_LANGUAGE, languageOfFile } from './parser/extract.js';
import {
	LOCK_STALE_MS, acquireIndexLock, cachePathOf, lockPathOf, readArtifactInfo, readShadowInfo, releaseIndexLock, shadowDirOf, shadowReadableOf, startLockHeartbeat, writeDirOf, writeShadowArtifact,
} from './shadow.js';
import { GRAPH_FILE, MANIFEST_FILE, MAX_DECOMPRESSED_BYTES, graphDirOf, workspaceRootOf } from './store.js';

/**
 * ★★ 甲档交接的**首次安全闸**（2026-10-20，所有权交接当天补的）。
 *
 * 场景：`config.indexTarget='workspace'`（dsh 写 `<ws>/.codebase-memory/`）**且** `indexWatch=true`。
 * 工作区里此刻躺着的是 **IDE 产的图**（20 万节点、无 `producer`）。保鲜 watcher 的第一次运行只有
 * "增量预算"（`maxFiles` 默认 1500）—— 拿它去覆盖那份完整图，再写上 `producer: 'vssaros-dsh'`
 * （⇒ IDE **从此永远让路** ✗），一次无意的文件改动就把图毁成 1/40（与 99 字节事故同族 ✗✗）。
 *
 * 规则：**交接的第一次建图必须显式跑 `codebase_index`**（带足 `maxFiles` + `treesitter`）。
 * 在它成功产出 `producer=ours` 之前，watcher 只记一条日志、不写盘 ✓。
 *
 * @returns 需要拦截时返回**给人看的原因**（含已有节点数，便于判断"到底会不会覆盖掉真东西"✓）；否则 undefined。
 */
export async function handoverNeedsInitialBuild(root) {
	const dir = String(root ?? '').trim();
	if (!dir) { return undefined; }
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(dir, '.codebase-memory', 'artifact.json'), 'utf8'));
	} catch {
		return undefined; // 工作区里没有清单（从没索引过）⇒ watcher 写一份小的也不毁东西 ✓
	}
	if (manifest?.producer === ARTIFACT_PRODUCER) { return undefined; } // 已经是我们产的 ⇒ 正常增量 ✓
	const nodes = Number(manifest?.node_count) || 0;
	return nodes > 0
		? `交接待首次建图：工作区已有 **IDE 产**的图（${nodes} 节点）⇒ watcher 的增量预算会把它覆盖成小图 ✗；先显式跑一次 codebase_index（parser=treesitter，maxFiles 覆盖全仓）✓`
		: undefined; // 空制品（0 节点）⇒ 没有可毁的东西 ✓
}

/**
 * 解析档（`config.parser` / `codebase_index` 的 `parser` 参数 ✓）。
 *
 *   · `auto`（**P7 起的缺省**）：资产可用就真解析 ✓，不可用就**如实降级**到快档（返回 `degraded` ✓）；
 *   · `regex`：显式快档（顶层声明的正则近似，秒级 ✓）；
 *   · `treesitter`：显式真解析（资产不可用 ⇒ **当场拒**，不静默换档 ✗）。
 *
 * ⚠ `auto` **不是一种档**，它是"按能力挑档"的指令 ✓ ⇒ 上报给用户的档位永远是 `regex` / `treesitter` 之一 ✓
 * （落地记录见 `index-meta.json`：`parser` 记**解析出来的那个**，`parserChoice` 记"怎么挑的" ✓）。
 */
export const PARSERS = ['auto', 'regex', 'treesitter'];
/** 单文件真解析的等待预算（**比 P0 的 15s 短**：建图是"每文件一次"，卡住的单个文件不该拖住整轮 ✓）。 */
export const PER_FILE_PARSE_TIMEOUT_MS = 10_000;

/** 默认扫描上限（与自证同一口径 ✓）。 */
export const INDEX_MAX_FILES = DEFAULT_MAX_FILES;
/** 上限的**硬夹紧**（`maxFiles` 是模型给的参数，不能让它传 10^9 把机器拖死 ✗）。 */
export const INDEX_MAX_FILES_CAP = 20_000;
/** 连续增量多少次之后强制全量重扫（兜 `(size, mtimeNs)` 判定的漏改 ✓，与自证同口径）。 */
export const INDEX_MAX_INCREMENTAL_RUNS = 10;

/**
 * "这份图**太旧了**"的判定阈值（2026-10-14 随**甲档·所有权交接**一起加的 ✓）。
 *
 * ⚠ 为什么需要有"判决"而不只是"报个 age" ✗：甲档下 IDE **不再自己索引** ⇒ 图会不会变新，
 *   **只**取决于有没有人跑 `codebase_index`（或开没开 `config.indexWatch` ✓）。所以"多旧"在甲档是
 *   **安全信号**（图旧 = 检索在拿旧事实回答 ✓），在乙档只是信息（IDE 那份仍然新鲜 ✓）。
 *
 * ⚠ 阈值是**我们定的启发式**（7 天）✗ —— 不是从真源来的 ✓。它只用来决定要不要**显眼地提示**，
 *   绝不阻断任何操作 ✓（判断依据永远是返回里的 `ageMs` 与 `staleAfterMs` 两个数 ✓，调用方可以自己定标准 ✓）。
 */
export const GRAPH_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** `codebase_delete_project` 的 `which` 取值（**一个地方定义** ⇒ 工具描述、校验、探针都引它 ✓）。 */
export const DELETE_WHICH_VALUES = ['current', 'shadow', 'workspace', 'both'];

/** 一次索引最多跑多久就给"没跑完"的诚实答案？——用 `maxFiles` 夹紧即可，不做墙钟超时（见文件头：不做后台任务 ✓）。 */
function clampMaxFiles(value) {
	const asked = Number(value);
	if (!Number.isFinite(asked) || asked <= 0) {
		return INDEX_MAX_FILES;
	}
	return Math.min(INDEX_MAX_FILES_CAP, Math.max(50, Math.floor(asked)));
}

const ownerToken = () => `codebase-shadow-${process.pid}-${randomBytes(4).toString('hex')}`;

/**
 * 跑一次影子索引（**全量或增量**）。
 * @returns `{ ok: true, dir, project, stats, manifest, graphBytes, cacheBytes?, cacheRejected?, rescanned, tookOver?, ms }`
 *          | `{ ok: false, kind, why, ... }`（**不抛**：工具与页面都要能直接显示 ✓）
 */
export async function runShadowIndex(config, {
	root, project, maxFiles, incremental = true, fullRescan = false, now = Date.now(), env = process.env,
	// ★ P2：`'regex'`（缺省，与从前逐字一致 ✓）| `'treesitter'`（真解析 ⇒ 符号/行号准确 + CALLS/USAGE/INHERITS/IMPLEMENTS 边 ✓）
	parser,
	// 资产解析的覆盖项（`{ cwd, env }`，直接交给 `resolveWasmDir` ✓）。**只给探针用**：
	// 生产路径上资产链要么命中、要么如实报"试过哪些目录"；但**失败路径**（零候选）在 dev 里跑不出来
	// （cwd 的 node_modules 总会兜住 ✗）⇒ 不给一个覆盖口，`no-parser-assets` 这条就**永远测不到** ✓。
	parserOptions,
} = {}) {
	const workspaceRoot = String(root ?? workspaceRootOf(config) ?? '').trim();
	if (!workspaceRoot) {
		return { ok: false, kind: 'no-workspace', why: '未配置 workspaceRoot（Host 的 cwd 不是工作区 ⇒ 本模块不猜 ✓；VsSaros 经覆盖层注入）' };
	}
	// ★ 落点由 `writeDirOf` 一处决定（同一函数读侧也调 ⇒ 「写一处、读一处」在结构上不可能 ✗）：
	//   `indexTarget` 缺省 = `shadow`（与从前逐字一致 ✓）；`= 'workspace'` 时才写 `<ws>/.codebase-memory/` ✓。
	const placed = writeDirOf(config, workspaceRoot, { env });
	if (placed.error) {
		return { ok: false, kind: placed.error.includes('indexTarget') ? 'bad-target' : 'no-index-dir', why: placed.error };
	}
	// 项目名与真源同口径：工作区目录名（真源 artifact.json 的 `project` 就是它 ✓ —— 口径漂移会让查询反复回退）
	const projectName = String(project ?? basename(workspaceRoot)).trim() || 'workspace';
	const limit = clampMaxFiles(maxFiles);
	const started = Date.now();
	// ★ P2 / P7：解析档选择。**显式参数 > config > auto** ✓。
	//   `auto`（**P7 起的缺省**）：资产可用就用真解析（质量优先 ✓）；资产不可用 ⇒ **如实降级**到快档并在
	//   返回值里说清为什么（`degraded` ✓）。降级可以是好选择，**静默**降级不是 ✗✗（图的档位决定答案质量 ✓）。
	//   ⚠ 缺省从 `regex` 改成 `auto` 是**一次行为变化**（同类工作区产的图更准、也更慢 ✓）⇒ 所以档位必须处处可见：
	//     落盘写进 `index-meta.json`、状态工具与页面按它上报 ✓（见 `readIndexMeta` / `shadowStatus` ✓）。
	const asked = String(parser ?? config?.parser ?? 'auto').trim().toLowerCase();
	if (!PARSERS.includes(asked)) {
		return { ok: false, kind: 'bad-parser', why: `不认识的解析器「${String(parser ?? config?.parser)}」（支持：${PARSERS.join(' / ')}）` };
	}
	let chosen = asked;
	let parserChoice = `显式指定「${asked}」✓`;
	let degraded;
	// ★ O4（2026-10-14，用户拍板 ✓）：规模挑档的"为什么"要**落盘可见** ✓ ⇒ 与"资产不可用"（`degraded` ✓）**分开记** ✗✓
	//   —— "策略选了快档"与"没资产"是两种不同的真相 ✓。
	let scaleCapped;
	if (asked === 'auto') {
		const probeAssets = describeParser(config, { env, ...(parserOptions ?? {}) });
		if (probeAssets.available) {
			// ⚠ 规模用**上次实测**的文件数 ✓（本次的要扫完才知道 ✗）；**第一次跑**仍按资产判断 ✓（"先要真解析就显式说" ✓）。
			const scaleCap = Number.isFinite(Number(config?.autoTreesitterMaxFiles)) && Number(config.autoTreesitterMaxFiles) > 0
				? Math.floor(Number(config.autoTreesitterMaxFiles))
				: INDEX_AUTO_TREESITTER_MAX_FILES;
			const previousMeta = await readIndexMeta(placed.dir).catch(() => undefined);
			const previousFiles = previousMeta?.present === true && typeof previousMeta.files === 'number' ? previousMeta.files : undefined;
			const previousParser = typeof previousMeta?.parser === 'string' ? previousMeta.parser : undefined;
			// ★★ 2026-10-20 真机事故（**这是本轮最重要的一条**）：甲档交接后，watcher 的一次运行**没有传 parser**
			//   ⇒ 走 auto ⇒ 上次实测 13242 文件 > 阈值 3000 ⇒ **悄悄降成 regex 快档** ⇒ 把 treesitter 建的
			//   393,183 节点 / 1,226,947 边**覆盖成 98,925 / 186,460**（类成员方法、CALLS/USAGE 整族消失 ✗✗）。
			//   降档是"规模折衷"，**不是**"没有能力" ⇒ 已有一份高保真图时**不许**用启发式把它换差 ✗。
			//   规则：上次是 `treesitter` 就继续用它（规模阈值不参与降档）；只有上次本来就是 regex 才继续按规模判 ✓。
			if (previousParser === 'treesitter') {
				chosen = 'treesitter';
				parserChoice = `沿用上次的档位「treesitter」（上次实测 ${previousFiles ?? '?'} 个文件；规模阈值 ${scaleCap} **不参与降档** —— 降档会静默丢掉方法/调用边 ✗）`;
			} else if (previousFiles !== undefined && previousFiles > scaleCap) {
				chosen = 'regex';
				parserChoice = `auto ⇒ 快档（上次实测 ${previousFiles} 个文件 > 阈值 ${scaleCap} ✓ ⇒ 真解析会是分钟级 ✗；要真解析就显式 parser:"treesitter"，或调 config.autoTreesitterMaxFiles ✓）`;
				scaleCapped = { files: previousFiles, threshold: scaleCap };
			} else {
				chosen = 'treesitter';
				parserChoice = `auto ⇒ 真解析（本机资产可用：${probeAssets.languages.length} 语言 · 来自 ${probeAssets.source} ✓${previousFiles !== undefined ? ` · 上次规模 ${previousFiles} 文件（≤ 阈值 ${scaleCap} ✓）` : ''}）`;
			}
		} else {
			chosen = 'regex';
			parserChoice = 'auto ⇒ 快档（本机没有可用的 tree-sitter 资产 ⇒ 如实降级 ✓；要真解析先备好随包资产 ✓）';
			degraded = { requested: 'auto', fellBackTo: 'regex', why: probeAssets.why };
		}
	}
	let pool;
	let extract;
	// ★ P3：真解析模式的**扫描面** = 真源语言表（20 个后缀 ✓），而不是正则路径那份 TS/JS 白名单 ✗ ——
	// 缺 grammar 的文件**照样进扫描集**（只是不产符号 + 计进 `skippedUnsupported` ✓）；
	// 这样"语言表里有、但这份资产解析不了"会**看得见**，而不是"文件静默消失" ✗。
	const scanExtensions = chosen === 'treesitter' ? new Set(Object.keys(EXTENSION_TO_LANGUAGE)) : undefined;
	if (chosen === 'treesitter') {
		// 先问资产**在不在**（缺就**当场拒**，而不是扫一遍之后每个文件都失败 ✗ —— "看起来很慢、其实什么都没解析"是最难查的那种 ✓）
		const described = describeParser(config, { env, ...(parserOptions ?? {}) });
		if (!described.available) {
			return { ok: false, kind: 'no-parser-assets', why: `要真解析但没有可用的 tree-sitter 资产：${described.why}` };
		}
		const available = new Set(described.languages);
		pool = createParserPool(config, { options: { env, ...(parserOptions ?? {}) } });
		// 每个文件：扩展名 → 语言（表照真源 ✓）→ 问池子要抽取结果。三种结果都**如实**回给索引器 ✓：
		//   · `unsupported`：扩展名/语言不在覆盖范围（**不回落正则** —— 半张图比明确的"没覆盖"更误导 ✗）
		//   · `error`：解析失败/超时（把原因带上，索引器计数 ✓）
		extract = async ({ relPath, text }) => {
			const language = languageOfFile(relPath);
			if (!language) {
				return { unsupported: true, why: '扩展名不在覆盖表里（见 parser/extract.js 的 EXTENSION_TO_LANGUAGE ✓）' };
			}
			if (!available.has(language)) {
				return { unsupported: true, why: `资产目录里没有 ${language} 的 grammar` };
			}
			const got = await pool.parseSource({ language, text, file: relPath, mode: 'extract', timeoutMs: PER_FILE_PARSE_TIMEOUT_MS });
			if (!got.ok) {
				return { error: `${got.kind}: ${String(got.why).slice(0, 200)}` };
			}
			return {
				symbols: got.extraction?.symbols ?? [],
				calls: got.extraction?.calls ?? [],
				usages: got.extraction?.usages ?? [],
				inherits: got.extraction?.inherits ?? [],
			};
		};
	}

	// ── 增量缓存（读）────────────────────────────────────────────────────────────
	let previous;
	let cacheRejected;
	if (incremental !== false) {
		try {
			const raw = await readFile(cachePathOf(placed.dir), 'utf8');
			const parsed = parseCache(raw, { root: workspaceRoot, now });
			if (parsed.error) {
				cacheRejected = parsed.error; // 如实报出（拒绝是**正常**路径，不是失败 ✓）
			} else {
				previous = parsed.cache;
			}
		} catch (e) {
			if (e?.code !== 'ENOENT') {
				cacheRejected = `读缓存失败：${String(e?.message ?? e)}`;
			}
		}
	}
	// 漏改兜底：连续增量太多次 ⇒ 这一次忽略缓存、全量重解析 ✓（并如实报出"这次是兜底重扫"）
	let rescanned = false;
	if (!fullRescan && previous && shouldRescan(previous, { maxIncrementalRuns: INDEX_MAX_INCREMENTAL_RUNS })) {
		fullRescan = true;
		rescanned = true;
	}

	// ── 锁（拿不到就**不排队**，如实回报"谁在跑" ✓）─────────────────────────────────
	const owner = ownerToken();
	const lock = await acquireIndexLock(placed.dir, { owner, now });
	if (!lock.ok) {
		// 交接之后这条有了新含义：**IDE 侧正在索引同一个目录** ✓（`heldBy.writer` 就是那句话的证据 ✓）
		return { ok: false, kind: 'locked', why: lock.why, heldBy: lock.heldBy, dir: placed.dir, target: placed.target };
	}
	// ★ 心跳（交接的必配件 ✓）：真解析一轮可能到分钟级，而两边共用同一个 5min 阈值 ⇒
	//   没心跳就会被 IDE 判成残骸并接管 ✗（见 shadow.js 的锁那节）。丢锁时如实记下，不假装还在写 ✓。
	let lockLost;
	const heartbeat = startLockHeartbeat(placed.dir, owner, {
		onLost: lost => { lockLost = lost; },
	});
	let released;
	try {
		const built = await buildImportGraph({ root: workspaceRoot, maxFiles: limit, project: projectName, now, previous, fullRescan, extract, parser: chosen, ...(scanExtensions ? { extensions: scanExtensions } : {}) });
		// ★★ 2026-10-21（A 档优化）：**先判"图有没有变"，变了才编码/才写盘** ⇒ 每次空跑省掉 ~4.7s 的 gzip ✓
		//   判据 = **内容指纹**（文件内容 hash 的聚合 + 解析档 + 配方版本 + 节点/边计数 ⇒ 图由它们完全决定 ✓）。
		//   ⚠ 配方版本（`GRAPH_RECIPE_VERSION`）必须随"提取/构图语义"变化而 +1 —— 否则"代码变了但文件没变"
		//     会误判成"没变" ⇒ **图谱停在旧语义上**（比慢更糟 ✗✗）。
		//   ⚠ 只在"上次成功写盘时记下的指纹"与本次相同、且图文件确实存在时才跳过 ⇒ 其它情况一律照旧写 ✓。
		const fingerprint = graphFingerprintOf(built, { parser: chosen });
		const previousMetaRun = await readIndexMeta(placed.dir).catch(() => undefined);
		const graphStat = await stat(join(placed.dir, GRAPH_FILE)).then(info => info).catch(() => undefined);
		const graphFilePresent = !!graphStat;
		let graphBytes;
		let manifest;
		let written;
		let graphUnchanged = false;
		let encodeSkipped = false;
		if (previousMetaRun?.graphFingerprint === fingerprint
			&& previousMetaRun?.graphRecipe === GRAPH_RECIPE_VERSION
			&& graphFilePresent
			// ⚠ 还要**图文件的大小**与上次记的一致 ⇒ 有人动过/截断过它（指纹只覆盖"内容来源"，不覆盖"盘上那份"）
			//   ⇒ 大小对不上就照旧重写（宁可多写一次，也不要留一份坏图 ✗✗）。
			&& (previousMetaRun?.graphBytes === undefined || previousMetaRun.graphBytes === graphStat.size)) {
			graphUnchanged = true;
			encodeSkipped = true;
			manifest = manifestOf(built.graph, { project: projectName, savedAt: now }); // 只为报计数 ✓（便宜）
		} else {
			graphBytes = encodeGraph(built.graph);
			manifest = manifestOf(built.graph, { project: projectName, savedAt: now });
			written = await writeShadowArtifact(placed.dir, { graphBytes, manifest });
			graphUnchanged = written.graphUnchanged === true;
		}
		// ★ P7：把**档位**落盘（旁挂 `index-meta.json` ✓ —— 产物本身一个字节都不动 ✓）。
		//   写失败**不**把整次索引判失败（图已经安全落盘 ✓），但必须报出来 ✗：否则以后对着这份图猜档位 ✓。
		let metaBytes;
		let metaWarning;
		try {
			metaBytes = await writeIndexMeta(placed.dir, {
				version: 1,
				parser: chosen,
				parserChoice,
				...(degraded ? { degraded } : {}),
				// ★ O4（2026-10-14）：规模挑档的"为什么"落盘 ✓（与"资产不可用"分开 ✗）+ 这次的文件数（下次 auto 的判断输入 ✓）
				...(scaleCapped ? { scaleCapped } : {}),
				files: built.stats.files,
				project: projectName,
				savedAt: now,
				maxFiles: limit,
				// ★ P7 的"代价"那半（2026-10-13）：**记实测值**，不编估算公式 ✓ ——
				//   页面/状态里那句"重建大概要多久"必须是"**上一次真花了多少**"（含是哪一档、增量还是全量 ✓），
				//   而不是拿文件数乘一个系数 ✗（那种数字看着专业、其实与真因无关 ✓）。
				ms: Date.now() - started,
				incremental: !fullRescan,
				tookOverLock: lock.tookOver === true,
				// ⚠ `manifestOf` 写的是 **snake_case**（`node_count` ✓，与 IDE 的产物**同形** ✓）——
				//   我第一版读 `nodeCount` ⇒ 落盘记了个 `undefined` ✗（2026-10-13 冒烟抓到 ✓）。
				nodeCount: manifest?.node_count ?? manifest?.nodeCount,
				edgeCount: manifest?.edge_count ?? manifest?.edgeCount,
				// ★ 2026-10-21：把**内容指纹**与**配方版本**记进 meta ⇒ 下一轮能判"图没变 ⇒ 不用重编码" ✓
				//   （指纹相同 ⇒ 图必然相同；配方版本一变 ⇒ 指纹必变 ⇒ 强制重写 ✓）。
				graphFingerprint: fingerprint,
				graphRecipe: GRAPH_RECIPE_VERSION,
				// ★ 2026-10-21（增量图设计的阶段 0）：把"这次**内容有没有变**"记进 meta/history
				//   ⇒ 度量脚本能把"空跑耗时"与"有变更耗时"**分开**统计（混在一起看不出优化落在哪 ✓）。
				graphChanged: graphUnchanged !== true,
				// ★ 2026-10-21："这次连编码都省了"进 meta/history ⇒ 优化在真机上是**看得见的数据** ✓
				//   （`cacheUnchanged` 在 meta 写入**之后**才确定 ⇒ 不能在这里引用它 ✗，它仍在工具返回值里 ✓）
				encodeSkipped: encodeSkipped === true,
				// 图文件大小（用来判"盘上那份有没有被动过" ⇒ 被动过就重写 ✓）
				...(written?.graphBytes !== undefined ? { graphBytes: written.graphBytes } : {}),
			});
		} catch (error) {
			metaWarning = `档位记录没写成（不影响产物，但以后查不到这份图是哪一档建的）：${String(error?.message ?? error)}`;
		}
		// 缓存**后写**（图已经安全落盘了才更新它 ✓）；缓存写失败只是"下次省不了"⇒ 报 warn 不报失败 ✓
		//
		// ★ 2026-10-21（真机观察：多人并发编辑的仓库）：watcher 大约每 30s 跑一次，其中**很多次内容没变**
		//   （nodes/edges 逐字相同 ⇒ 图压根没落盘，`graphUnchanged=true`），却每次都把 **135MB** 的
		//   `index-cache.json` 重写一遍（真机单次 13–34s 的跑）⇒ 纯浪费 I/O 与 CPU ✗。
		//   判据：**图内容没变** ⇒ 这轮的解析结果与上次等价 ⇒ 缓存不必重写 ✓。
		//   代价（可接受、且是安全的）：万一某个文件变了但解析结果恰好相同，它的 hash 会留在旧缓存里
		//   ⇒ 下轮会**多解析一次**那个文件（只是慢一点，不会算错 ✓）。
		let cacheBytes;
		let cacheWarning;
		let cacheUnchanged = false;
		try {
			const cachePath = cachePathOf(placed.dir);
			let cacheExists = false;
			try { await stat(cachePath); cacheExists = true; } catch { cacheExists = false; }
			if (graphUnchanged === true && cacheExists) {
				cacheUnchanged = true;
				cacheBytes = (await stat(cachePath)).size;
			} else {
				const payload = JSON.stringify(serializeCache(built, { savedAt: now }));
				await writeFile(cachePath, payload);
				cacheBytes = Buffer.byteLength(payload, 'utf8');
			}
		} catch (e) {
			cacheWarning = `增量缓存没写成（不影响产物）：${String(e?.message ?? e)}`;
		}
		return {
			ok: true,
			dir: placed.dir,
			target: placed.target,
			indexRoot: placed.indexRoot,
			placement: placed.source,
			key: placed.key,
			project: projectName,
			parser: chosen,
			parserChoice,
			...(degraded ? { degraded } : {}),
			...(scaleCapped ? { scaleCapped } : {}),
			...(metaBytes !== undefined ? { metaBytes } : {}),
			...(metaWarning ? { metaWarning } : {}),
			stats: built.stats,
			manifest,
			graphBytes: written?.graphBytes ?? (await stat(join(placed.dir, GRAPH_FILE)).then(info => info.size).catch(() => undefined)),
			manifestBytes: written?.manifestBytes,
			// ★ O3（2026-10-14）：图内容没变 ⇒ 没落盘 ✓（如实报出来 —— "建了一次索引"与"写出了一份**新的**图"是两件事 ✓）
			...(graphUnchanged ? { graphUnchanged: true } : {}),
			// ★ 2026-10-21（A 档优化）：这次**连编码都没做**（指纹相同 ⇒ 图必然相同 ⇒ 省掉 ~4.7s 的 gzip ✓）
			...(encodeSkipped ? { encodeSkipped: true, graphFingerprint: fingerprint } : {}),
			// ★ 2026-10-21：图没变 ⇒ 缓存也没重写（省掉 135MB 的写盘 ✓；"省了一次写盘"是要被看见的事实 ✓）
			...(cacheUnchanged ? { cacheUnchanged: true } : {}),
			...(cacheBytes !== undefined ? { cacheBytes } : {}),
			...(cacheRejected ? { cacheRejected } : {}),
			...(cacheWarning ? { cacheWarning } : {}),
			rescanned,
			...(lock.tookOver ? { tookOver: lock.tookOver } : {}),
			// 心跳读数（"这把锁有没有在跳"是可展示的事实 ✓；丢锁**必须**能看见 ✗）
			heartbeat: { touches: heartbeat.state.touches, lost: heartbeat.state.lost, ...(heartbeat.state.error ? { error: heartbeat.state.error } : {}) },
			...(lockLost ? { lockLost } : {}),
			ms: Date.now() - started,
		};
	} finally {
		// 解析线程用完就收（`worker_threads` 不会跟着函数返回消失 ✗；Host 里长跑的进程尤其要收 ✓）
		if (pool) {
			await pool.dispose().catch(() => { /* 收线程失败不值得把一次成功的索引说成失败 ✓ */ });
		}
		// 心跳**先停**再放锁（否则可能出现"锁已删、心跳又把它按 token 写回"? 不会 —— 心跳只刷 mtime ✓；
		// 但停心跳本身是纪律：一次索引结束之后不该还有任何定时器在动这个目录 ✓）
		heartbeat.stop();
		released = await releaseIndexLock(placed.dir, owner).catch(e => ({ released: false, why: String(e?.message ?? e) }));
		// 放锁失败**不能静默**（别人会被一把永远不走的锁挡在门外 ✗）——但也不该把成功的一次索引说成失败 ⇒ 单独报 ✓
		if (!released?.released) {
			process.emitWarning?.(`[vssaros-codebase] 索引锁没放掉：${released?.why ?? '未知'}`);
		}
	}
}

/**
 * 锁文件的现状（只读；页面与状态工具共用 ✓）。
 * `stale: true` = 已经超过 `LOCK_STALE_MS` ⇒ **下一次索引会接管它** ✓（这句必须能提前看出来，
 * 否则"为什么我的索引立刻成功了、另一个进程的还在跑"会变成一个查不出来的谜 ✓）。
 */
/**
 * 覆盖率用的扩展名集合 = **正则档能收的** ∪ **真解析档认得的**（`parser/extract.js` 的语言表 ✓）。
 *
 * ⚠ 为什么必须是并集：只按正则档那几个扩展名扫，会把图里真实存在的 `.py` / `.go` 等文件判成
 * "图里有、磁盘上没有" ⇒ 报出一个**假的"图已过期"** ✗✗（这正是最坏的那类错：数字看着有理，方向反了）。
 */
const COVERAGE_EXTENSIONS = new Set(
	[...REGEX_SOURCE_EXT, ...Object.keys(EXTENSION_TO_LANGUAGE)]
		.map(value => { const text = String(value).toLowerCase(); return text.startsWith('.') ? text : `.${text}`; }),
);

/**
 * 覆盖率：**图里的文件集合** vs **现在扫得到的源文件集合**（纯函数 ✓ —— 判据只写这一份，工具与探针共用 ✓）。
 *
 * ## 为什么是"集合差"而不是"每个文件的原因"（**这条边界必须说死** ✗）
 *
 * 真源 `check_index_coverage` 能给出"每个被跳过的文件 + 原因"（未支持 / 超大 / 超长行 / 解析错 / 超时 / 部分解析 ✓）——
 * 因为它的索引器**逐文件保留结果** ✓。dsh 侧没有这份数据：我们的索引器只汇总计数
 * （`stats.skippedUnsupported` / `stats.extractErrors` ✓，产物里也不落逐文件结果 ✗）。
 * ⇒ 这里只能回答"**哪边多出来**"，回答不了"**每个文件为什么**" ✗。要后者得先让索引器把逐文件结果落进产物 ✓（另立一期）。
 *
 * ## 两边的含义（方向**不许弄反** ✗）
 *
 *   · `missingInGraph`（扫得到、图里没有）⇒ **未覆盖**：上次索引之后新增 / 上次解析失败被跳 / 上次达 `maxFiles` 截断 ✓
 *   · `missingOnDisk`（图里有、现在扫不到）⇒ **图已过期**：文件被删或移走，或这次扫描范围不同（排除集 / 上限）✓
 */
export function diffCoverage(graphFiles, scannedFiles, { truncated = false } = {}) {
	// ⚠ 防御性归一：两边都可能是**对象**（`collectSourceFiles` 给的是 `{ relPath, bytes }` ✗，而图的节点给的是
	//   `filePath` ✓）。2026-10-13 实测踩到：只做 `String(value)` ⇒ 整批文件被压成同一个 `[object Object]`
	//   ⇒ "扫到 1 个文件、覆盖率 0%" ✗✗ —— **数字看着有理、其实全错**，正是最坏的一类。
	const norm = value => {
		const raw = value && typeof value === 'object' ? (value.relPath ?? value.filePath ?? value.path ?? '') : (value ?? '');
		return String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
	};
	const graphSet = new Set((graphFiles ?? []).map(norm).filter(Boolean));
	const scanSet = new Set((scannedFiles ?? []).map(norm).filter(Boolean));
	const missingInGraph = [...scanSet].filter(path => !graphSet.has(path)).sort();
	const missingOnDisk = [...graphSet].filter(path => !scanSet.has(path)).sort();
	const coveredCount = [...graphSet].filter(path => scanSet.has(path)).length;
	// 分母取两边的**较大者**：只算图里那份会把"图漏了一半"报成 100% ✗；只算扫描那份反之 ✗
	const denominator = Math.max(graphSet.size, scanSet.size);
	return {
		graphFileCount: graphSet.size,
		scannedFileCount: scanSet.size,
		coveredCount,
		coveragePct: denominator ? Math.round((coveredCount / denominator) * 1000) / 10 : 100,
		missingInGraph,
		missingOnDisk,
		truncated,
		/**
		 * ⚠ 扫描被上限截断时**不能**下"图已过期"的结论：没扫到 ≠ 磁盘上没有 ✗✗
		 *   （2026-10-13 真机冒烟实测：maxFiles=300 时 missingOnDisk 会把图里 6000+ 个文件里的绝大部分
		 *   都列成"扫不到" ⇒ 一个**假的"图已过期"警报** ✗）。⇒ 截断时这里恒为 false，并另给一个可靠性标记 ✓。
		 */
		staleGraph: !truncated && missingOnDisk.length > 0,
		/** `missingOnDisk` 这个列表本身可不可信（截断时不可信 ✓ —— 要它可信就把 maxFiles 提到超过工作区文件数 ✓）。 */
		missingOnDiskReliable: !truncated,
		method: '集合差：图的 `filePath` 集合 vs **现在**用同一套扫描规则（扩展名并集 + 排除目录）扫到的源文件集合 ✓；'
			+ '⚠ **没有**逐文件失败原因（dsh 索引器只留计数 ✗）—— 要"每个文件为什么"得先让索引器把逐文件结果落进产物 ✓。'
			+ (truncated ? '⚠ 本次扫描被上限截断 ⇒ 覆盖率只是**下界**、且 `missingOnDisk` **不可信**（没扫到 ≠ 不存在 ✗）✓。' : ''),
	};
}

/**
 * 覆盖率的"读盘那半步"：现扫一次工作区，再与图作差。
 * `graph` 由调用方给（它已经为了这次调用加载了 ✓）；本函数**不**加载图、不写任何东西 ✓。
 */
export async function coverageOf(config, graph, { maxFiles = DEFAULT_MAX_FILES } = {}) {
	const root = workspaceRootOf(config);
	if (!root) {
		return { error: '未配置 workspaceRoot ⇒ 无法比对覆盖率' };
	}
	const scanned = await collectSourceFiles(root, { maxFiles, extensions: COVERAGE_EXTENSIONS });
	// 扫描器给的是 `{ relPath, bytes }` ⇒ 显式取 `relPath`（不指望下游替我做对 ✓）
	const scannedPaths = scanned.files.map(entry => entry?.relPath).filter(Boolean);
	const graphFiles = [...new Set((graph?.nodes ?? []).map(node => node?.filePath).filter(Boolean))];
	return {
		...diffCoverage(graphFiles, scannedPaths, { truncated: scanned.truncated === true }),
		maxFiles,
		// 扫描器自己的排除集（如实回传 ✓：换一台机器/改过口径都会影响这个数字）
		skippedDirs: scanned.skippedDirs ?? [],
		root,
	};
}

/**
 * 产图的**档位记录**（P7，2026-10-13）—— 我们自己在产物目录里放的**旁挂**小文件（`index-meta.json` ✓）。
 *
 * ## 为什么必须有它（✗✗）
 *
 * 在这之前，"这份图是哪一档建的"只活在**那次调用的返回值**里 —— 关掉会话就**查不到**了 ✗。
 * 而档位决定答案质量（正则档的符号边界与行号是近似的、也没有 `CALLS`/`USAGE` 那四类边 ✓）
 * ⇒ 拿一份正则档的图去回答"谁调用了谁"，出错时**根本无从判断是图的问题还是查询的问题** ✗✗。
 * ⇒ 落盘时记一笔，`codebase_index_status` 与页面都按它上报 ✓。
 *
 * ## 三条纪律
 *
 * ① **不改产物格式**：`artifact.json` / `graph.db.zst` **一个字节都不动** ✓（IDE 侧读得懂的东西不许被我们加料 ✗）
 *    ⇒ 档位写在**旁挂文件**里 ✓；
 * ② **原子写**（`tmp + rename` ✓，与产物同一套纪律 ✓）：半个 meta 比没有 meta 更坏 ✗；
 * ③ **读不到就说读不到**（`present: false` ✓）：IDE 产的图**没有**这份 meta ⇒ 状态里如实说"档位不在我们手上" ✓，
 *    **绝不**猜成"大概是 regex 吧" ✗。
 */
export const INDEX_META_FILE = 'index-meta.json';

/**
 * `auto` 档的**规模上限**（O4，2026-10-14，用户拍板 ✓）：上次实测的文件数**超了它** ⇒ `auto` 走**快档** ✓
 * （UE 级仓库走真解析是分钟级 ✗）。⚠ 阈值是**我们定的启发式**（3,000 ✗ —— 可调：`config.autoTreesitterMaxFiles` ✓）；
 * 显式 `parser:'treesitter'` **永远赢**（"我要真解析"不许被规模顶掉 ✓✗）。
 */
export const INDEX_AUTO_TREESITTER_MAX_FILES = 3000;

/** `index-meta.json` 里"最近几次建图"历史的上限（O2，2026-10-14 ✓）—— 只留**近**的 ⇒ 文件不会随时间长胖 ✓。 */
export const INDEX_META_HISTORY_MAX = 10;

/** 档位记录的落点（放在**产物目录**里 ⇒ 跟着产物一起被删/被导 ✓）。 */
export function indexMetaPathOf(dir) {
	return join(dir, INDEX_META_FILE);
}

/** 读档位记录：**不抛**（没有 / 坏了都回 `present: false` ✓ —— 状态查询不该因为一个旁挂文件失败 ✗）。 */
export async function readIndexMeta(dir) {
	try {
		const parsed = JSON.parse(await readFile(indexMetaPathOf(dir), 'utf8'));
		return parsed && typeof parsed === 'object' ? { present: true, ...parsed } : { present: false };
	} catch {
		return { present: false };
	}
}

/**
 * 写档位记录（**顺带记"最近 N 次"的历史** —— O2，2026-10-14 ✓）。
 *
 * ## 为什么要有历史
 *
 * 只记"上一次"时，页面看不出"这次比上次快 / 慢" ✗ ⇒ "优化有没有用"**没有数** ✗。
 * ⇒ meta 里加 `history: [{ savedAt, ms, parser, incremental, nodeCount, edgeCount }]`（**新→旧** ✓，上限
 * `INDEX_META_HISTORY_MAX` ✓）。每条只留**对"快不快"有判断价值**的字段 ✓（不整份往里塞 ✗）。
 *
 * ## 两条边界（刻意 ✓）
 *
 * ① 旧 meta **读不到/坏了** ⇒ 历史从新开始 ✓（不让一个坏文件把"记历史"变成"记不了" ✗）；
 * ② `history` 只在**我们的**旁挂文件里 ⇒ IDE 不认识它 ✓（无兼容风险 ✓；产物本体 `artifact.json` **一字不动** ✓）。
 */
async function writeIndexMeta(dir, meta) {
	let previous = [];
	try {
		const old = await readIndexMeta(dir);
		if (old.present && Array.isArray(old.history)) {
			previous = old.history;
		}
	} catch { /* 读不到就当没有历史 ✓ */ }
	const entry = {
		...(meta.savedAt !== undefined ? { savedAt: meta.savedAt } : {}),
		...(typeof meta.ms === 'number' ? { ms: meta.ms } : {}),
		...(typeof meta.parser === 'string' ? { parser: meta.parser } : {}),
		...(typeof meta.incremental === 'boolean' ? { incremental: meta.incremental } : {}),
		...(typeof meta.nodeCount === 'number' ? { nodeCount: meta.nodeCount } : {}),
		...(typeof meta.edgeCount === 'number' ? { edgeCount: meta.edgeCount } : {}),
		...(typeof meta.files === 'number' ? { files: meta.files } : {}),
		// ★ 2026-10-21：把"这次**连编码都省了**"记进历史 ⇒ 优化在真机上是**看得见的数据**（不是靠感觉 ✓）
		...(typeof meta.encodeSkipped === 'boolean' ? { encodeSkipped: meta.encodeSkipped } : {}),
		...(typeof meta.cacheUnchanged === 'boolean' ? { cacheUnchanged: meta.cacheUnchanged } : {}),
		// ★ 2026-10-21：这次**内容有没有变**（增量图设计阶段 0：让度量脚本能分开统计空跑/有变更 ✓）
		...(typeof meta.graphChanged === 'boolean' ? { graphChanged: meta.graphChanged } : {}),
	};
	const withHistory = { ...meta, history: [entry, ...previous].slice(0, INDEX_META_HISTORY_MAX) };
	const payload = `${JSON.stringify(withHistory, null, 1)}\n`;
	const tempPath = `${indexMetaPathOf(dir)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	await mkdir(dir, { recursive: true });
	try {
		await writeFile(tempPath, payload, 'utf8');
		await rename(tempPath, indexMetaPathOf(dir));
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => { /* 清临时文件的失败不该盖住真错误 ✓ */ });
		throw error;
	}
	return Buffer.byteLength(payload, 'utf8');
}

/** 删完之后**读侧会怎样**（后果要说清 ✓ —— 免得用户以为"删了就没图了" ✗）。 */
function afterDeleteNote(target) {
	return target === 'shadow'
		? '读侧会**退回读 IDE 的 `.codebase-memory/`**（它也没有 ⇒ 报"还没有图谱" ✓）；要重建就跑 `codebase_index` ✓'
		: '工作区 `.codebase-memory/` 已删（交接后这份目录属于 dsh ✓）；要重建就跑 `codebase_index` ✓。'
			+ '⚠ 删它也**正是"把权限还给 IDE"的动作** ✓—— 权限的凭据是那份清单里的 `producer` ✓，清单没了 ⇒ IDE 下次索引自动接管 ✓';
}

/** 工作区产物目录（**构造出来的** `<ws>/.codebase-memory/` ✓ —— 不是任何用户输入 ⇒ 没有注入面 ✓）。 */
export function workspaceArtifactDirOf(root) {
	return join(root, '.codebase-memory');
}

/**
 * 工作区里那份产物**归谁**（只读、**不抛** ✓）。
 *
 * 甲档的"**双输**"要靠它查出来 ✗：当前档是 `shadow`、而工作区里还留着一份**我们产的**清单 ⇒
 * IDE 见到 `producer` **继续让路** ✗，dsh 又不写那里 ⇒ **两边都不索引** ✗✗
 * （用户以为"改回配置就回退了"，其实没有 ✓）。
 */
export async function workspaceOwnershipOf(root) {
	const dir = workspaceArtifactDirOf(root);
	try {
		const raw = await readFile(join(dir, MANIFEST_FILE), 'utf8');
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { dir, exists: true, readable: false };
		}
		const producer = typeof parsed?.producer === 'string' ? parsed.producer : undefined;
		return {
			dir,
			exists: true,
			readable: true,
			...(producer !== undefined ? { producer } : {}),
			ours: producer === ARTIFACT_PRODUCER,
			...(typeof parsed?.saved_at === 'number' && Number.isFinite(parsed.saved_at) ? { savedAt: parsed.saved_at } : {}),
		};
	} catch {
		return { dir, exists: false };
	}
}

/**
 * 删**一个**落点：红线 + 锁 + 清点 + 删。
 *
 * ⚠ 红线的判据**只写在这一处** ✓ —— `which` 让"删哪个"变成多个，但"什么情况下**不许**删"必须仍然只有一份 ✗。
 */
async function deleteOneSpot({ which, dir, target, root, indexRoot, force }) {
	const norm = value => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	const dirNorm = norm(dir).toLowerCase();
	const rootNorm = norm(root).toLowerCase();
	if (!dirNorm || dirNorm === rootNorm) {
		return { which, dir, target, error: `拒绝：落点与工作区根相同（${dir}）⇒ 这等于删工作区，不是删索引 ✗` };
	}
	if (target === 'shadow' && norm(indexRoot ?? '').toLowerCase() === rootNorm) {
		return { which, dir, target, error: `拒绝：config.indexDir 指向工作区根（${indexRoot}）⇒ 影子目录会落在工作区里、与真实目录无法区分 ✗；换成工作区之外的目录 ✓` };
	}
	// ⚠ 工作区落点**只认**构造出来的 `<ws>/.codebase-memory` 这一条 ✓（`which='workspace'` 是给"回退/清理"用的，
	//   不是给"删任意目录"用的 ✗）。
	if (target === 'workspace' && dirNorm !== norm(workspaceArtifactDirOf(root)).toLowerCase()) {
		return { which, dir, target, error: `拒绝：工作区落点不是 <ws>/.codebase-memory（${dir}）✗` };
	}
	const lock = await lockStateOf(dir);
	if (lock.held === true && lock.stale !== true && !force) {
		return { which, dir, target, error: `有人正在索引（holder=${lock.holder?.token ?? '?'}，空闲 ${Math.round((lock.idleMs ?? 0) / 1000)}s）⇒ 等它结束再删，或用 \`force\` 强删 ✓` };
	}
	const inventory = await inventoryOf(dir);
	if (!inventory.exists) {
		return { which, dir, target, deleted: false, reason: '这里没有产物（没什么可删 ✓）' };
	}
	await rm(dir, { recursive: true, force: true });
	return {
		which,
		dir,
		target,
		deleted: true,
		removedFiles: inventory.files,
		removedBytes: inventory.bytes,
		// 强删时把"当时锁还被人持有"如实说出来 ✓（否则事后没人知道这份产物是被抢删的 ✗）
		...(lock.held === true ? { forcedWhileLocked: lock.holder?.token ?? true } : {}),
	};
}

/** 清点一个目录（文件数 + 字节数 ✓）；不存在 ⇒ `exists: false`（**不抛** —— "没什么可删"是正常结果 ✓）。 */
async function inventoryOf(dir) {
	let files = 0;
	let bytes = 0;
	const walk = async at => {
		let entries;
		try {
			entries = await readdir(at, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = `${at}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(child);
				continue;
			}
			files += 1;
			try {
				bytes += (await stat(child)).size;
			} catch { /* 竞态：清点失败就少算一点，不许因此中断删除 ✓ */ }
		}
	};
	try {
		const info = await stat(dir);
		if (!info.isDirectory()) {
			return { exists: false, files: 0, bytes: 0 };
		}
	} catch {
		return { exists: false, files: 0, bytes: 0 };
	}
	await walk(dir);
	return { exists: true, files, bytes };
}

/**
 * 删除本工作区的**索引产物**（P6 2026-10-13；`which` 随**甲档·所有权交接**于 2026-10-14 加 ✓）。
 *
 * ## 删的是哪一份（落点判据**复用 `writeDirOf` / `shadowDirOf`** ✓ —— 那是"产物在哪"的**唯一**判断）
 *
 *   · `which='current'`（**缺省**，与从前**逐字一致** ✓）⇒ 删**当前配置的落点**；
 *   · `which='workspace'` ⇒ 删 `<ws>/.codebase-memory/`；`which='shadow'` ⇒ 删影子目录；
 *   · `which='both'` ⇒ 两处都删（返回换成 `removed[]` 明细 + 合计 ✓）。
 *
 * ⚠ **为什么必须有 `workspace` / `both`**（甲档的安全出口 ✓）：交接后权限的凭据是**那份清单里的 `producer`** ✓，
 *   **不是配置** ✗ —— 只把 `indexTarget` 改回 `shadow` 的话，工作区那份还在 ⇒ IDE **继续让路**、而 dsh 又不写它
 *   ⇒ **两边都不索引** ✗✗（"双输"）。所以要能**指着工作区那份删** ✓。
 *
 * ## 三条不许越过的线（每条都配了探针断言 ✓；判据**只在 `deleteOneSpot` 一处** ✓）
 *
 * ① **绝不删工作区根**：落点等于工作区根 ⇒ 拒 ✓；影子模式的 `config.indexDir` 指向工作区根 ⇒ 也拒 ✓
 *    （那种配置下"影子目录"与真实目录无法区分，删它等于删工作区 ✗✗）；工作区落点**只认** `<ws>/.codebase-memory` ✓。
 * ② **别人正在索引**（持锁且**未过期**，判据同 `lockStateOf` ✓）⇒ 拒 ✓：把目录从活着的索引器脚下抽走是另一种坏 ✗。
 * ③ **删完如实报**：删之前先清点（文件数 / 字节 ✓）⇒ 报告里的数字来自"真删之前看到了什么" ✓。
 *
 * ⚠ 没产物**不算失败**（`deleted: false` + 说清"没什么可删" ✓）—— 幂等 ✓，重复调用不报错 ✓。
 */
export async function deleteIndexArtifacts(config, { force = false, which = 'current' } = {}) {
	const root = workspaceRootOf(config);
	if (!root) {
		return { error: '未配置 workspaceRoot ⇒ 不猜要删哪一份 ✗' };
	}
	if (!DELETE_WHICH_VALUES.includes(which)) {
		return { error: `which 只能是 ${DELETE_WHICH_VALUES.join(' / ')}（收到 ${JSON.stringify(which)}）✗` };
	}
	const placed = writeDirOf(config, root);
	if (placed.error) {
		return { error: placed.error };
	}
	// 工作区那一份**永远是构造出来的** `<ws>/.codebase-memory` ✓（不必、也不许依赖配置 ✓）
	const workspaceSpot = { which: 'workspace', dir: workspaceArtifactDirOf(root), target: 'workspace' };
	const shadowPlaced = shadowDirOf(config, root);
	const shadowSpot = shadowPlaced.error
		? undefined
		: { which: 'shadow', dir: shadowPlaced.dir, target: 'shadow', indexRoot: shadowPlaced.indexRoot };
	const currentSpot = { which: 'current', dir: placed.dir, target: placed.target, indexRoot: placed.indexRoot };
	if (which === 'shadow' && !shadowSpot) {
		return { error: `算不出影子目录：${shadowPlaced.error} ✗` };
	}
	// ⚠ `which='workspace'` 时若当前落点**不是**工作区，不算失败 ✓（正是回退要干的事 ✓），
	//   但下面返回里的 `note` 会说清"删的不是当前落点" ✗ → ✓。
	const wanted = which === 'current' ? [currentSpot]
		: which === 'both' ? [shadowSpot, workspaceSpot].filter(Boolean)
			: which === 'shadow' ? [shadowSpot]
				: [workspaceSpot];
	const removed = [];
	for (const spot of wanted) {
		removed.push(await deleteOneSpot({ ...spot, root, force }));
	}
	if (which === 'both') {
		const files = removed.reduce((sum, item) => sum + (item.removedFiles ?? 0), 0);
		const bytes = removed.reduce((sum, item) => sum + (item.removedBytes ?? 0), 0);
		return {
			deleted: removed.some(item => item.deleted === true),
			which,
			removed,
			removedFiles: files,
			removedBytes: bytes,
			...(removed.length > 0 && removed.every(item => item.error)
				? { error: removed.map(item => `[${item.which}] ${item.error}`).join('；') }
				: {}),
			refused: removed.filter(item => item.error).map(item => ({ which: item.which, error: item.error })),
			afterDelete: '两处都处理过了；要重建就跑 `codebase_index` ✓',
		};
	}
	const primary = removed[0];
	if (primary.error) {
		return { error: primary.error, which: primary.which };
	}
	// ⚠ 单落点（含缺省 `current`）的返回**与从前逐字一致** ✓（旧探针直接断言这些字段 ✓）+ 一个冗余 `removed` 明细
	return {
		deleted: primary.deleted === true,
		dir: primary.dir,
		target: primary.target,
		source: placed.source,
		...(primary.which === 'current' && placed.key ? { key: placed.key } : {}),
		...(primary.deleted === true
			? { removedFiles: primary.removedFiles, removedBytes: primary.removedBytes }
			: { reason: primary.reason ?? '这里没有产物（没什么可删 ✓）' }),
		...(primary.forcedWhileLocked !== undefined ? { forcedWhileLocked: primary.forcedWhileLocked } : {}),
		...(primary.which === 'current' ? {} : { which: primary.which, note: '⚠ 这次删的**不是**当前配置的落点 ✓（用来清理/回退另一处的产物 ✓）' }),
		afterDelete: afterDeleteNote(primary.target),
		removed,
	};
}

/** 导出/导入的路径围栏（与 `codebase_snippet` **同一条纪律** ✓：只收工作区内的相对路径 ⇒ 不新造一套路径策略 ✗）。 */
function insideWorkspace(root, relPath) {
	const raw = String(relPath ?? '').trim();
	if (!raw) {
		return { error: '必须给一个路径 ✗' };
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

/**
 * 导出：把**读侧现在用的那一份**产物（`artifact.json` + `graph.db.zst`）复制到工作区内的一个目录 ✓
 * （真源：IDE 的 `export_artifact` ✓）。
 *
 * ## 三个刻意的选择
 *
 * ① **导出的是"你正在查的那份"**：落点取自 `graphDirOf(config)` ✓（与 `codebase_search` 等**同一个**判断 ⇒
 *    不会出现"查的是影子、导出的是老图" ✗✗）；返回值里如实带 `from` / `fromSource`（是影子还是 IDE 的 ✓）。
 * ② **不导出 `graph.db.sqlite`**：本插件不用它（读的是 `graph.db.zst` ✓）—— 导一份用不上的东西只会让"这份包到底够不够"变模糊 ✗。
 * ③ **目标只许在工作区内**（相对路径 ✓）：与读侧围栏同一条纪律 ✓，不为了"能写到 U 盘"开一个任意写口子 ✗。
 */
export async function exportIndexArtifacts(config, { toDir }) {
	const root = workspaceRootOf(config);
	if (!root) {
		return { error: '未配置 workspaceRoot ⇒ 不猜导出什么 ✗' };
	}
	const placed = await graphDirOf(config);
	if (placed.error) {
		return { error: placed.error };
	}
	const guard = insideWorkspace(root, toDir);
	if (guard.error) {
		return { error: `toDir：${guard.error}` };
	}
	if (!guard.parts.length) {
		return { error: '导出目标不能是工作区根本身 ✗（会往工作区里撒产物文件 ✓ 换个子目录）' };
	}
	const picked = [];
	for (const name of [MANIFEST_FILE, GRAPH_FILE]) {
		try {
			picked.push({ name, bytes: await readFile(join(placed.dir, name)) });
		} catch {
			return { error: `产物目录里缺 \`${name}\`（${placed.dir}）⇒ 这份图不完整，导出没有意义 ✗` };
		}
	}
	await mkdir(guard.abs, { recursive: true });
	let bytes = 0;
	for (const file of picked) {
		await writeFile(join(guard.abs, file.name), file.bytes);
		bytes += file.bytes.length;
	}
	return {
		exported: true,
		from: placed.dir,
		fromSource: placed.source ?? '(未知)',
		to: guard.abs,
		relDir: guard.parts.join('/'),
		files: picked.map(file => file.name),
		bytes,
		note: '导出的是**你正在查的那份**（`from` ✓）；目标目录在工作区内，要搬走就自己复制出去 ✓',
	};
}

/**
 * 导入：把一份外来的产物装成**本工作区的索引**（真源：IDE 的 `import_artifact` ✓）。
 *
 * ## 为什么"先证明它读得动"是这条路径的核心（✗✗）
 *
 * 装一份**坏图**进来 = 之后每个查询都静默错（或整个插件看起来"坏了"）✗✗ —— 所以顺序是**先验证再落盘**：
 *   ① 清单过 `parseManifest` 的硬校验（不认识的 `format` / 缺字段当场拒 ✓）；
 *   ② 图谱**真解一遍**（不是"文件在就算 ✓"）—— 且**带输出上限** `MAX_DECOMPRESSED_BYTES` ✓：
 *      导入是**不可信输入**，不设上限的话一个小文件能解出几十 GB（zip bomb ✗✗）。
 *   ③ 落盘复用**索引器同一套**原子写（`writeShadowArtifact` ✓，`mkdir + tmp + rename`）⇒ 不另造落盘路径 ✗。
 *
 * ## 会如实说出的两件事
 *
 *   · `replaced`：覆盖之前那份是什么（项目名 / 保存时间 ✓）—— 导入是**破坏性**的 ✓；
 *   · `foreignProject`：外来清单里的项目名与当前工作区**对不上**时置真 ✓（跨机器共享是合法用途 ✓，
 *     但**绝不**让人误以为"这份图就是本工作区索引出来的" ✗ —— 图里的相对路径会指向别处的源码 ✓）。
 */
export async function importIndexArtifacts(config, { fromDir }) {
	const root = workspaceRootOf(config);
	if (!root) {
		return { error: '未配置 workspaceRoot ⇒ 不猜装到哪 ✗' };
	}
	const guard = insideWorkspace(root, fromDir);
	if (guard.error) {
		return { error: `fromDir：${guard.error}` };
	}
	const placed = writeDirOf(config, root);
	if (placed.error) {
		return { error: placed.error };
	}
	let manifestText;
	try {
		manifestText = await readFile(join(guard.abs, MANIFEST_FILE), 'utf8');
	} catch {
		return { error: `找不到 \`${MANIFEST_FILE}\`（${guard.abs}）⇒ 这不像一份产物目录 ✗` };
	}
	let graphBytes;
	try {
		graphBytes = await readFile(join(guard.abs, GRAPH_FILE));
	} catch {
		return { error: `找不到 \`${GRAPH_FILE}\`（${guard.abs}）⇒ 这份包不完整 ✗` };
	}
	const manifestCheck = parseManifest(manifestText);
	if (manifestCheck.error) {
		return { error: `清单不合格：${manifestCheck.error} ✗（拒绝落盘 ✓）` };
	}
	let graph;
	try {
		graph = decodeGraph(graphBytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
	} catch (error) {
		return { error: `图谱解不开：${String(error?.message ?? error)} ✗（拒绝落盘 ✓ —— 装一份坏图进来会让之后每个查询都错 ✗✗）` };
	}
	let incoming;
	try {
		incoming = JSON.parse(manifestText);
	} catch (error) {
		return { error: `清单不是合法 JSON：${String(error?.message ?? error)} ✗` };
	}
	// ⚠ `readArtifactInfo` **不抛**（它把"没产物"也当正常结果 ⇒ 回 `files: {}` ✓）⇒ **不能靠 catch 判断**"原来有没有产物" ✗✗
	//   —— 2026-10-13 冒烟实测：写成 catch 会**谎报**"覆盖了 (未知)"（其实目录是空的 ✓）。
	const before = await readArtifactInfo(placed.dir).catch(() => undefined);
	const hadBefore = Boolean(before && (before.files?.manifest || before.files?.graph));
	// ⚠ 这里必须传**对象**：`writeShadowArtifact` 内部是 `JSON.stringify(manifest, null, 1)` ✓ ⇒ 传文本的话
	//   会写出一份"JSON 字符串字面量"的清单 ✗✗（2026-10-13 探针实测踩到：装坏还报成功 —— 所以下面还要**回读** ✓）。
	await writeShadowArtifact(placed.dir, { graphBytes, manifest: incoming });
	// ★ **装完回读校验**：验证过"输入"不等于"落盘结果"是对的 ✗（上面那条 bug 只有回读才拦得住 ✓）。
	const readback = await readArtifactInfo(placed.dir).catch(() => undefined);
	if (readback?.manifestError) {
		return { error: `装完回读校验失败：${readback.manifestError} ✗（这次**没有**装成一份可用的图，别把它当成功 ✗）` };
	}
	const workspaceName = basename(root);
	const incomingProject = typeof incoming?.project === 'string' ? incoming.project : undefined;
	return {
		imported: true,
		from: guard.abs,
		to: placed.dir,
		target: placed.target,
		bytes: graphBytes.length,
		nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
		edgeCount: Array.isArray(graph?.edges) ? graph.edges.length : 0,
		project: incomingProject ?? '(清单里没写)',
		workspaceName,
		...(incomingProject !== undefined && incomingProject !== workspaceName ? { foreignProject: true } : {}),
		...(hadBefore ? { replaced: { project: before.manifest?.project ?? '(未知)', savedAt: before.manifest?.savedAt ?? undefined } } : { replaced: null }),
		note: '装的是**外来产物** ⇒ 图里的相对路径指向**导出方**的源码布局 ✓；本工作区的索引要用 `codebase_index` 重建 ✓',
	};
}

export async function lockStateOf(dir, { now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
	try {
		const path = lockPathOf(dir);
		const raw = await readFile(path, 'utf8');
		const held = JSON.parse(raw);
		// ⚠ 过期判据用**文件 mtime**（与 `acquireIndexLock` 的接管判据、以及 IDE 侧的 `isIndexLockStale` **同一个** ✓）。
		//   第一版这里用的是 `acquiredAt` ⇒ 有了心跳之后它会**必然误报**："`acquiredAt` 是 8 分钟前、锁其实正在跳"✗✗
		//   （心跳只刷 mtime、不动内容 ✓）。`ageMs` 保留成"这把锁是什么时候拿的"（信息性，不许拿它判过期 ✗）。
		const mtimeMs = Math.round((await stat(path)).mtimeMs);
		const ageMs = typeof held?.acquiredAt === 'number' ? Math.max(0, now - held.acquiredAt) : undefined;
		const idleMs = Math.max(0, now - mtimeMs);
		return {
			held: true,
			holder: held,
			mtimeMs,
			idleMs,
			...(ageMs !== undefined ? { ageMs } : {}),
			stale: idleMs > staleMs,
		};
	} catch {
		return { held: false };
	}
}

/**
 * 影子索引的**状态**（只读 ⇒ 由 `codebase_index_status` 工具、页面诊断与探针共用 ✓）。
 * 它要能回答三个"我需要知道什么"：① 落点在哪、凭什么；② 现在有没有产物、多大、多新；③ 能不能跑（锁/缓存）。
 */
export async function shadowStatus(config, { root, now = Date.now(), env = process.env } = {}) {
	const workspaceRoot = String(root ?? workspaceRootOf(config) ?? '').trim();
	if (!workspaceRoot) {
		return { ok: false, kind: 'no-workspace', why: '未配置 workspaceRoot（见 runShadowIndex）' };
	}
	const placed = writeDirOf(config, workspaceRoot, { env });
	if (placed.error) {
		return { ok: false, kind: placed.error.includes('indexTarget') ? 'bad-target' : 'no-index-dir', why: placed.error };
	}
	// 产物现状：`shadow` 档看影子目录；`workspace` 档看**工作区目录**（就是 `placed.dir` ✓）—— 同一份读法 ✓
	const info = placed.target === 'shadow'
		? await readShadowInfo(config, workspaceRoot, { env })
		: await readArtifactInfo(placed.dir);
	// 交接后**影子里可能还留着上一次的影子产物**（换向不会自动删 ✗）⇒ 报出来，别让它变成谜 ✓
	const orphanShadow = placed.target === 'workspace' ? await readShadowInfo(config, workspaceRoot, { env }).catch(() => undefined) : undefined;
	const lock = await lockStateOf(placed.dir, { now });
	// 缓存现状：**只报"有没有、多大、什么时候写的"**，不解析内容（状态查询不该付解析代价 ✓）
	let cache;
	try {
		const raw = await readFile(cachePathOf(placed.dir), 'utf8');
		const parsed = JSON.parse(raw);
		cache = {
			bytes: Buffer.byteLength(raw, 'utf8'),
			savedAt: typeof parsed?.savedAt === 'number' ? parsed.savedAt : undefined,
			files: parsed?.hashes && typeof parsed.hashes === 'object' ? Object.keys(parsed.hashes).length : undefined,
			version: parsed?.version,
		};
	} catch {
		cache = undefined;
	}
	// ★ P3-b：状态工具必须答得出"**读图现在会走哪一份**"—— 影子的存在 ≠ 它被采用 ✓
	//（"有影子产物"与"读的是影子"是两件事：更新的 IDE 图会把影子挤下去 ✓，见 store.js 的新鲜度纪律）
	const effective = await graphDirOf(config);
	// ★ P7：**这份图是哪一档建的** —— 读**读侧实际会用**的那份的 `index-meta.json` ✓（写落的点与读的点可能
	//   不是同一份：IDE 产的图没有这份 meta ⇒ 如实说"不在我们手上"，**绝不**猜档位 ✗）。
	const graphMeta = await readIndexMeta(effective?.error ? placed.dir : (effective?.dir ?? placed.dir));
	// ★ 甲档·所有权交接（2026-10-14）：**"双输"探测器** —— 当前档是 `shadow`、但工作区里还留着一份**我们产的**产物
	//   ⇒ IDE 见到 `producer` **继续让路** ✗、而 dsh 又不写那里 ⇒ **两边都不索引** ✗✗。
	//   这是"只改配置回不去"那个坑的**唯一可观察点** ✓ ⇒ 页面与状态工具必须把它喊出来（不然用户永远不知道自己踩了 ✓）。
	const workspaceOwn = placed.target === 'shadow' ? await workspaceOwnershipOf(workspaceRoot) : undefined;
	return {
		ok: true,
		workspaceRoot,
		// ★ 决策 3：**写到哪**（`shadow` / `workspace`）是状态工具必答的一格 ✓ ——
		// "我以为在写工作区"和"我以为还在写影子"是完全不同的两件事（而磁盘上都很正常 ✓）。
		target: placed.target,
		dir: placed.dir,
		...(placed.indexRoot ? { indexRoot: placed.indexRoot } : {}),
		placement: placed.source,
		readable: info.present?.manifest === true && info.present?.graph === true,
		graphParser: graphMeta.present ? graphMeta.parser : undefined,
		graphParserWhy: graphMeta.present
			? String(graphMeta.parserChoice ?? '（记录里没写选择理由）')
			: '没有档位记录（这份图不是这一代 dsh 索引器产的 ⇒ 档位不在我们手上 ✗）',
		...(graphMeta.present && graphMeta.degraded ? { graphParserDegraded: graphMeta.degraded } : {}),
		...(graphMeta.present && graphMeta.savedAt !== undefined ? { graphMetaSavedAt: graphMeta.savedAt } : {}),
		// ★ P7 代价：上一次建这份图**实测花了多久**（`ms` ✓），以及它是增量还是全量（`incremental` ✓）——
		//   两件事都会显著改变"再来一次大概要多久" ✓；取不到就**不报**（不猜 ✗）。
		...(graphMeta.present && typeof graphMeta.ms === 'number' ? { graphMetaMs: graphMeta.ms } : {}),
		...(graphMeta.present && typeof graphMeta.incremental === 'boolean' ? { graphMetaIncremental: graphMeta.incremental } : {}),
		// ★ O2（2026-10-14）：把"最近几次建图"透出去 ⇒ 页面能看出**趋势**（"这次比上次快/慢" ✓），不只"上一次" ✗
		...(graphMeta.present && Array.isArray(graphMeta.history) ? { graphMetaHistory: graphMeta.history } : {}),
		...(orphanShadow && orphanShadow.present ? {
			orphanShadow: {
				dir: orphanShadow.dir,
				readable: shadowReadableOf(orphanShadow),
				...(orphanShadow.manifest?.savedAt !== undefined ? { savedAt: orphanShadow.manifest.savedAt } : {}),
				...(orphanShadow.error ? { error: orphanShadow.error } : {}),
			},
		} : {}),
		...(effective.error ? {} : {
			effectiveSource: effective.source,
			effectiveDir: effective.dir,
			...(effective.savedAt !== undefined ? { effectiveSavedAt: effective.savedAt, effectiveAgeMs: effective.ageMs } : {}),
			// ★ 甲档的安全信号（2026-10-14）："这份图有多旧"在**甲档**是"检索会不会拿旧事实回答"的问题 ✓
			//   （乙档只是信息 —— IDE 那份仍然新鲜 ✓）。判定阈值是我们定的启发式 ✓ ⇒ 把它一起返回，
			//   调用方要自己判就有依据 ✓（绝不因为"旧"阻断任何操作 ✗）。
			...(typeof effective.ageMs === 'number' ? { effectiveStale: effective.ageMs > GRAPH_STALE_AFTER_MS, staleAfterMs: GRAPH_STALE_AFTER_MS } : {}),
			...(effective.staleShadow ? { staleShadow: effective.staleShadow } : {}),
		}),
		// ★ 甲档的"双输"（只在 `shadow` 档才可能发生 ✓）：工作区里那份清单**是我们的** ⇒ IDE 会继续让路 ✗
		...(workspaceOwn && workspaceOwn.exists === true && workspaceOwn.ours === true ? {
			orphanWorkspace: {
				dir: workspaceOwn.dir,
				ours: true,
				...(workspaceOwn.savedAt !== undefined ? { savedAt: workspaceOwn.savedAt } : {}),
				risk: '当前档是 shadow（dsh 写自己的索引目录），而工作区里那份清单写着 producer=' + ARTIFACT_PRODUCER
					+ ' ⇒ IDE 会**继续让路**、而 dsh 又不写它 ⇒ **两边都不索引** ✗✗；⚠ 改回配置**不能**解决'
					+ '（权限的凭据是那份**清单** ✓）⇒ 用 `codebase_delete_project` 的 `which="workspace"`（或 `"both"`）删掉它 ✓',
			},
		} : {}),
		...(info.manifest ? { manifest: info.manifest } : {}),
		...(info.manifestError ? { manifestError: info.manifestError } : {}),
		...(info.missing ? { missing: info.missing } : {}),
		...(info.bytes !== undefined ? { graphBytes: info.bytes, graphMtimeMs: info.mtimeMs } : {}),
		present: info.present,
		lock,
		...(cache ? { cache } : {}),
	};
}


