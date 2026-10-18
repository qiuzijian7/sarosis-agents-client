// @vssaros/dsh-codebase — indexer：**写侧的前提**自证（契约 / 增量 / 兜底 / 符号级）。
//
// 背景（方案把本模块列为"高/不满足"）：代码图谱真源是 VsSaros 侧构建的产物（`.codebase-memory/`
// 里的 `artifact.json` + `graph.db.zst`），dsh 侧**只读** ✓。要把写侧搬过来，先得把四件"不可回避的
// 前提"钉成**可断言的事实**，而不是等真搬索引器时才撞上：
//
//   ① **契约**：Host 产出的东西，读侧认不认？（5.53 ⇒ `selfCheck` 的读回比对）
//   ② **增量 ≡ 全量**：只重算变了的文件，结果能不能与全量一致？（5.54 ⇒ pass2 / delta 夹具）
//   ③ **漏改可兜**：`(size, mtimeNs)` 判定会漏掉的那次改动，周期性全量重扫能不能收敛？（5.55 ⇒ miss 夹具）
//   ④ **符号级**：能不能在文件之上再抽一层符号（`function` / `class` / …）并挂 `CONTAINS` 边？
//      （本站 ⇒ 只认**顶层**声明、只用**正则**，见下面的边界）
//
// ⚠ **边界（写清楚，免被误读成"写侧已迁完"）**：
//   · 文件级＝全部源文件；符号级**只认顶层声明**（缩进的类成员 / 内嵌函数**不抽** ✗）；
//   · 符号抽取是**正则**（`export function` / `class` / `const` … 那一串 ✓）：装饰器、`declare module`、
//     多行声明、重载、解构声明一律不认（如实不抽，不假装成功 ✗）；
//   · 边的类型只有两种：`IMPORTS`（文件→文件，相对导入）与 `CONTAINS`（文件→符号）✓；真源图谱还有
//     `CALLS` / `USAGE` / `EXTENDS` 等 ✗ —— 那些要**真解析 + 跨文件符号解析**，不是正则能糊的 ✗；
//   · **自证只写临时目录**：本节的自证产物写到 `mkdtemp` 出来的目录里做回读（**绝不动**工作区 ✓）。
//     ⚠ 2026-10-12（决策 3 = **所有权从 IDE 交给 dsh**）之后，"绝不动工作区"这句话**只对自证成立** ✗：
//     真索引的落点由 `config.indexTarget` 决定 —— 缺省仍是影子目录 ✓；`'workspace'` 时才写
//     `<ws>/.codebase-memory/`（那就是**交接**的意思 ✓，见 shadow.js 文件头与 doc §5 P3 ✓）。
//
// 契约（与真源产物逐字对齐，读侧才知道怎么读）：
//   · 图文件 `graph.db.zst` —— 名字是 `.zst`，**内容其实是 gzip**（读侧用的就是 `gunzipSync`：
//     `store.js:12/146`。这个不一致是历史遗留，我们**跟随**它，不擅自"修正" ⇒ 否则读侧读不了 ✗）；
//   · 清单 `artifact.json` —— `{ node_count, edge_count, format: 'gzip-json', saved_at, project }`；
//   · 图 JSON —— `{ nodes, edges, fileHashes, bm25, layout, nextNodeId, nextEdgeId }`，
//     节点 `{ project, id, label, name, qualifiedName, filePath, startLine, endLine, inDegree, outDegree, community }`、
//     边 `{ project, id, sourceId, targetId, type, properties }`。

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, posix, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { GRAPH_FILE, MANIFEST_FILE, SKIP_DIRS, loadGraph, readOverview } from './store.js';
// P2：真解析的边解析要用真源那两条 **label 限制**（USAGE 只连 class|interface|variable；INHERITS 只连 class|interface ✓）
import { INHERIT_TARGET_LABELS, USAGE_TARGET_LABELS } from './parser/extract.js';

/** 扫描时跳过的目录（都是"别人生成/别人的东西"，不是本仓库源码）。 */
// ⚠ `SKIP_DIRS` 已上移到 `store.js`（**单一来源** ✓：读侧文本搜索与写侧扫描必须同一份口径 ✗）⇒ 见那边的注释 ✓。
/**
 * **默认**算源码的后缀（= 正则路径的扫描面 ✓；**导出**是为了让"语言表比扫描面宽"这条差异可被断言 ✓）。
 *
 * ★ P3（2026-10-12）：真解析模式不再被这份白名单框住 —— 扫描面改由 **`EXTENSION_TO_LANGUAGE`**（语言表 ✓）
 * 决定，缺 grammar 的文件**照样进扫描集**、只是不产符号并计进 `skippedUnsupported` ✓。
 * 为什么不做成"只扫有 grammar 的那些"（看着更干净 ✗）：那会让**没有 grammar 的源文件静默消失** ✗✗ ——
 * "少了一整族文件、而没人看得出来"正是本仓最怕的那种错 ✓；现在的做法是"它在，只是明确标着没解析" ✓。
 */
export const REGEX_SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/** 内部默认（正则路径 ✓）。 */
const SOURCE_EXT = REGEX_SOURCE_EXT;
/** 单文件最多读多少字节（图谱是文件级 + 顶层符号，读全文件只为抓 import 行与顶层声明）。 */
const MAX_BYTES_PER_FILE = 200_000;
/** 默认扫描上限（文件数）。真源图谱是几万节点，我们这一步只证前提 ⇒ 有上限、且如实回报被截断。 */
export const DEFAULT_MAX_FILES = 1500;

/**
 * 顶层声明的正则表（**只用正则** —— 见文件头边界；顺序即优先级，一行只认第一条命中的 ✓）。
 *
 * `label` 用的是真源图谱的用词（`function` / `class` / `variable` / `interface` / `type` / `enum` ✓），
 * 这样读侧的 `summary.labels` / `searchNodes({label})` 直接就能用 ✓。
 */
const SYMBOL_PATTERNS = [
	{ label: 'class', re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ label: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
	{ label: 'interface', re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
	{ label: 'enum', re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
	{ label: 'type', re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
	{ label: 'variable', re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
];

/** 路径统一成 `/` 分隔的相对路径（契约里 filePath 一律正斜杠，读侧按它算短路径与匹配）。 */
const toPosix = value => String(value).split(sep).join(posix.sep);

/**
 * 扫出源码文件（**确定性顺序**：按相对路径排序 ⇒ 同输入同输出，探针可比对）。
 * @returns `{ files: [{ relPath, bytes }], truncated, skippedDirs }`
 */
export async function collectSourceFiles(root, { maxFiles = DEFAULT_MAX_FILES, extensions = SOURCE_EXT } = {}) {
	const files = [];
	const wanted = extensions instanceof Set ? extensions : new Set(extensions ?? []);
	let truncated = false;
	const walk = async (dir, prefix) => {
		if (truncated) { return; }
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // 读不了的目录跳过（权限/竞态），不因此让整次扫描失败
		}
		for (const entry of entries) {
			if (truncated) { return; }
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) { continue; }
				await walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
				continue;
			}
			if (!entry.isFile() || !wanted.has(extname(entry.name).toLowerCase())) { continue; }
			if (files.length >= maxFiles) { truncated = true; return; }
			files.push({ relPath: prefix ? `${prefix}/${entry.name}` : entry.name, bytes: 0 });
		}
	};
	await walk(root, '');
	files.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return { files, truncated, skippedDirs: [...SKIP_DIRS] };
}

/** 抓一段源码里的 import / require 目标（正则，够用即止 —— 见文件头边界）。 */
export function extractSpecifiers(text) {
	const out = [];
	const push = value => { if (value && !out.includes(value)) { out.push(value); } };
	const patterns = [
		/\bfrom\s+['"]([^'"]+)['"]/g,          // import x from 'y' / export … from 'y'
		/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // require('y')
		/^\s*import\s+['"]([^'"]+)['"]/gm,      // 副作用导入 import 'y'
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			push(match[1]);
		}
	}
	return out;
}

/**
 * 抓 `import { a, b as c } from './x'` 里的**具名导入**（`a` / `b` —— 别名只取**原名** ✓：我们要找的是
 * 目标文件里**声明**的那个名字 ✓）。`import * as ns` / 默认导入 / 纯副作用导入都没有具名列表 ⇒ 不产出 ✓。
 *
 * ⚠ 正则边界（如实少连，不假装 ✓）：`export { a } from './x'`（再导出）**不认** ✗；跨行导入
 * （`import {\n a\n} from`）**不认** ✗；`import { type A }` 会拿到 `A` ✓（它在目标里通常确实是声明 ✓）。
 *
 * @returns `[{ specifier, names }]`，按出现顺序（确定性 ✓）
 */
export function extractNamedImports(text) {
	const out = [];
	const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
	for (const match of text.matchAll(re)) {
		const names = match[1]
			.split(',')
			.map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
			.filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
		if (names.length) {
			out.push({ specifier: match[2], names: [...new Set(names)] });
		}
	}
	return out;
}

/**
 * 抽**顶层声明**（缩进的一律不算 ✗ —— 类成员 / 内嵌函数会被跳过 ✓）。
 * @returns `[{ name, label, line }]`，按行号升序（确定性 ✓）；同名只留第一个（重载/重复声明如实不展开 ✓）
 */
export function extractSymbols(text) {
	const out = [];
	const seen = new Set();
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].replace(/\r$/, '');
		if (!line || /^\s/.test(line)) { continue; } // 空行 / 缩进行 ⇒ 不是顶层
		for (const { label, re } of SYMBOL_PATTERNS) {
			const match = re.exec(line);
			if (!match) { continue; }
			const name = match[1];
			if (!seen.has(name)) {
				seen.add(name);
				out.push({ name, label, line: index + 1 });
			}
			break; // 一行只认第一条命中的模式
		}
	}
	return out;
}

/**
 * 把 import 说明符解析成扫描集合里的相对路径（只认相对路径；`pkg` / `node:x` 一律算外部依赖）。
 * @returns 相对路径（`/` 分隔）或 `undefined`
 */
export function resolveSpecifier(fromRelPath, specifier, knownPaths) {
	if (!specifier.startsWith('.')) {
		return undefined;
	}
	const base = posix.normalize(posix.join(posix.dirname(fromRelPath), specifier));
	const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(ext => base + ext)];
	for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
		candidates.push(posix.join(base, `index${ext}`));
	}
	return candidates.find(candidate => knownPaths.has(candidate));
}

/**
 * 建图：**文件级 + 顶层符号级**。
 *
 * 节点：每个源文件一个 `label: 'file'` 节点（id 连续 ✓），随后每个文件的符号各一个节点（文件顺序 → 行序 ✓）。
 * 边：先 `IMPORTS`（文件→文件，相对导入 ✓），再 `CONTAINS`（文件→自己的符号 ✓）—— **顺序固定** ⇒ 产物可比对 ✓。
 *
 * `previous` = **上一次本函数的返回值**：判定只看 **(size, mtimeNs)**，命中就**连 `specifiers` 与 `symbols`
 * 一起复用** ✓（符号必须跟着缓存走 ✗ 否则"增量"会悄悄少掉符号层 ✓）。
 *
 * ⚠ 已知代价：**同尺寸 + 同 mtime 粒度内**改内容会被漏掉 ✗ ⇒ 真索引器靠**周期性全量重扫**兜底
 * （`fullRescan` / `shouldRescan` ✓，见 `missCheck` 把这条漏改**造出来**验一遍 ✓）。
 *
 * @returns `{ project, graph, hashes, specifiers, symbols, stats }`；`graph` 的形状与真源产物逐字一致。
 */
export async function buildImportGraph({
	root, maxFiles = DEFAULT_MAX_FILES, project = 'dsh-self-index', now = Date.now(), previous, fullRescan = false,
	// ★ P2（2026-10-12）：**真解析**挂载点。给了 `extract` 就走 tree-sitter（每个文件把源码交给它，
	// 拿回符号 + 调用/使用/继承事实 ✓）；不给就是原来的正则路径 ✓（**缺省零行为改变** ✓）。
	// 为什么用"注入一个函数"而不是在这里 import parser：① 索引器保持**可单测/可离线**（探针能塞假抽取器 ✓）；
	// ② worker/池的生命周期与 indexService 在一起（indexer 不该管线程 ✗）。
	extract,
	// 与 `extract` 同源的解析器标记：**只影响产物里的 stats 与缓存的字段含义** ✓（`'regex'` / `'treesitter'`）。
	parser = extract ? 'treesitter' : 'regex',
	// 扫描面（后缀集合）：**缺省 = 正则路径那份白名单**（零行为改变 ✓）；真解析模式由 indexService 传**语言表** ✓。
	extensions,
} = {}) {
	const started = Date.now();
	const { files, truncated } = await collectSourceFiles(root, { maxFiles, ...(extensions ? { extensions } : {}) });
	const knownPaths = new Set(files.map(file => file.relPath));
	const nodes = [];
	const edges = [];
	const fileHashes = [];
	let imports = 0;
	let external = 0;
	let unresolved = 0;
	// P2：真解析的额外统计（**不改图，只让"为什么边少了"可查** ✓）
	let extractErrors = 0;
	let skippedUnsupported = 0;
	let unmatchedCalls = 0;
	let unmatchedUsages = 0;
	let unmatchedInherits = 0;
	const byPath = new Map();
	for (const file of files) {
		const node = {
			project,
			id: nodes.length + 1,
			label: 'file',
			name: posix.basename(file.relPath),
			qualifiedName: file.relPath,
			filePath: file.relPath,
			startLine: 1,
			endLine: 1,
			inDegree: 0,
			outDegree: 0,
			community: 0,
		};
		nodes.push(node);
		byPath.set(file.relPath, node);
	}
	// `fullRescan: true` ⇒ **忽略缓存、全部重解析**。真索引器周期性这么做，用来兜"复用判定漏掉的那次改动"
	// （(size, mtimeNs) 都相同但内容变了 —— 见上面的已知代价 ✓）。产出与"干净重建"逐字节相同 ✓。
	const previousHashes = fullRescan ? {} : (previous?.hashes ?? {});
	const previousSpecifiers = fullRescan ? {} : (previous?.specifiers ?? {});
	const previousSymbols = fullRescan ? {} : (previous?.symbols ?? {});
	const previousNamed = fullRescan ? {} : (previous?.namedImports ?? {});
	// P2：真解析的三份事实也必须**跟着复用** ✗ —— 少复一份就会让"增量少算"（图上少了边，看起来却正常 ✓）。
	const previousCalls = fullRescan ? {} : (previous?.calls ?? {});
	const previousUsages = fullRescan ? {} : (previous?.usages ?? {});
	const previousInherits = fullRescan ? {} : (previous?.inherits ?? {});
	// 连续增量次数（自上一次全量重扫起算）：真索引器据此周期性强制全量 ✓（`shouldRescan` 用的就是它）
	const runs = previous && !fullRescan ? (previous?.stats?.incrementalRuns ?? 0) + 1 : 0;
	const hashes = {};
	const specifiers = {};
	const symbols = {};
	const namedImports = {};
	// P2：真解析的三份事实（regex 模式下恒为空对象 ⇒ 形状固定、计算路径唯一 ✓）
	const calls = {};
	const usages = {};
	const inherits = {};
	let reused = 0;
	let parsed = 0;
	for (const file of files) {
		const abs = join(root, ...file.relPath.split('/'));
		let size = 0;
		let mtimeNs = 0;
		try {
			const info = await stat(abs);
			size = info.size;
			mtimeNs = Math.round(info.mtimeMs * 1e6);
		} catch {
			continue; // 连 stat 都失败 ⇒ 这个文件不参与（也就不产生任何节点之外的边）
		}
		const before = previousHashes[file.relPath];
		const cached = previousSpecifiers[file.relPath];
		const cachedSymbols = previousSymbols[file.relPath];
		const cachedNamed = previousNamed[file.relPath];
		const cachedCalls = previousCalls[file.relPath];
		const cachedUsages = previousUsages[file.relPath];
		const cachedInherits = previousInherits[file.relPath];
		// P2：真解析模式下，**三份事实也必须在缓存里**才算复用充分 ✓（缺哪一份都不许"半复用"✗）
		const extrasCached = !extract
			|| (Array.isArray(cachedCalls) && Array.isArray(cachedUsages) && Array.isArray(cachedInherits));
		if (before && Array.isArray(cached) && Array.isArray(cachedSymbols) && Array.isArray(cachedNamed) && extrasCached
			&& before.size === size && before.mtimeNs === mtimeNs) {
			// 没变 ⇒ **不读、不解析**，说明符 / 符号 / 具名导入 / 三份真解析事实都沿用上次的；`sha256` 也沿用（**不假算**）
			specifiers[file.relPath] = cached;
			symbols[file.relPath] = cachedSymbols;
			namedImports[file.relPath] = cachedNamed;
			if (extract) {
				calls[file.relPath] = cachedCalls;
				usages[file.relPath] = cachedUsages;
				inherits[file.relPath] = cachedInherits;
			}
			hashes[file.relPath] = { size, mtimeNs, sha256: before.sha256 };
			reused += 1;
			continue;
		}
		let buffer;
		try {
			buffer = await readFile(abs);
		} catch {
			continue; // 读不了就跳过这个文件的出边（如实：不产生不存在的边）
		}
		const text = buffer.subarray(0, MAX_BYTES_PER_FILE).toString('utf8');
		// 说明符 / 具名导入**两模式共用正则**（那是**我们自己的**边，真源没有 ✗ —— 见文件头边界 ✓）
		specifiers[file.relPath] = extractSpecifiers(text);
		namedImports[file.relPath] = extractNamedImports(text);
		if (extract) {
			// ★ P2：真解析（tree-sitter）。三种结果都要**如实**处理 ✓：
			//   · `unsupported`（扩展名/语言不在覆盖范围）⇒ 该文件**不产符号**，计进 `skippedUnsupported` ✓
			//     （**不回落正则** —— 半张图比明确的"没覆盖"更误导 ✗）
			//   · `error`（解析/worker 失败）⇒ 计进 `extractErrors` 并把原因留在 stats 里 ✓（不静默 ✗）
			const got = await extract({ relPath: file.relPath, text, absPath: abs });
			if (got?.unsupported) {
				skippedUnsupported += 1;
				symbols[file.relPath] = [];
				calls[file.relPath] = [];
				usages[file.relPath] = [];
				inherits[file.relPath] = [];
			} else if (got?.error) {
				extractErrors += 1;
				symbols[file.relPath] = [];
				calls[file.relPath] = [];
				usages[file.relPath] = [];
				inherits[file.relPath] = [];
			} else {
				symbols[file.relPath] = (got?.symbols ?? []).map(symbol => ({
					name: symbol.name, label: symbol.label, line: symbol.line, endLine: symbol.endLine,
				}));
				calls[file.relPath] = got?.calls ?? [];
				usages[file.relPath] = got?.usages ?? [];
				inherits[file.relPath] = got?.inherits ?? [];
			}
		} else {
			symbols[file.relPath] = extractSymbols(text);
		}
		hashes[file.relPath] = { size: buffer.length, mtimeNs, sha256: createHash('sha256').update(buffer).digest('hex') };
		parsed += 1;
	}
	// ── 符号节点（在所有**文件**节点之后追加，id 与顺序都确定 ✓）────────────────────────────
	const symbolNodes = new Map(); // `${relPath}::${name}` → node（`CONTAINS` 边按它连 ✓）
	for (const file of files) {
		for (const symbol of symbols[file.relPath] ?? []) {
			const node = {
				project,
				id: nodes.length + 1,
				label: symbol.label,
				name: symbol.name,
				qualifiedName: `${file.relPath}::${symbol.name}`,
				filePath: file.relPath,
				startLine: symbol.line,
				// P2：真解析给得出**真的**结束行 ⇒ 用真的 ✓；正则模式仍等于起始行（如实：它只知道一行 ✗）
				endLine: symbol.endLine ?? symbol.line,
				inDegree: 1, // 恰好一条 `CONTAINS` 边指向它（下面会建 ✓）；出边为 0（符号间的调用/引用还没做 ✗）
				outDegree: 0,
				community: 0,
			};
			nodes.push(node);
			symbolNodes.set(`${file.relPath}::${symbol.name}`, node);
		}
	}
	// ── 边：**先 IMPORTS**（文件→文件），**再 CONTAINS**（文件→符号）—— 顺序固定 ⇒ 产物可比对 ✓ ──
	// 两类边与计数都只从 `specifiers` / `symbols` 推（无论那份是新解析的还是复用的）⇒ 增量与全量走
	// **同一条**计算路径 ⇒ 结果不可能因为"复用"而漂 ✓（这正是 `selfCheck` 要证的事实）。
	let importSymbols = 0;
	let importSymbolsMissing = 0;
	for (const file of files) {
		const list = specifiers[file.relPath];
		if (!list) { continue; }
		const source = byPath.get(file.relPath);
		for (const specifier of list) {
			imports += 1;
			const target = resolveSpecifier(file.relPath, specifier, knownPaths);
			if (!target) {
				if (specifier.startsWith('.')) { unresolved += 1; } else { external += 1; }
				continue;
			}
			const targetNode = byPath.get(target);
			source.outDegree += 1;
			targetNode.inDegree += 1;
			edges.push({
				project,
				id: edges.length + 1,
				sourceId: source.id,
				targetId: targetNode.id,
				type: 'IMPORTS',
				properties: { specifier },
			});
			// ── 再往下一层（README 5.66）：这个 specifier 上的**具名导入**若在目标文件里确实是顶层声明 ⇒
			// 连到**那个符号节点**（`IMPORTS_SYMBOL`）—— 从"文件认识文件"升到"文件认识具体的定义" ✓。
			// ⚠ 目标里没有那个名字（别名 / 再导出 / 默认导出 / `export *`）⇒ 计入 `importSymbolsMissing` ✓
			// 如实少连、**不猜** ✗。
			for (const entry of namedImports[file.relPath] ?? []) {
				if (entry.specifier !== specifier) { continue; }
				for (const name of entry.names) {
					const symbolNode = symbolNodes.get(`${target}::${name}`);
					if (!symbolNode) {
						importSymbolsMissing += 1;
						continue;
					}
					source.outDegree += 1;
					symbolNode.inDegree += 1;
					importSymbols += 1;
					edges.push({
						project,
						id: edges.length + 1,
						sourceId: source.id,
						targetId: symbolNode.id,
						type: 'IMPORTS_SYMBOL',
						properties: { specifier, name },
					});
				}
			}
		}
	}
	let contains = 0;
	for (const file of files) {
		for (const symbol of symbols[file.relPath] ?? []) {
			const fileNode = byPath.get(file.relPath);
			const symbolNode = symbolNodes.get(`${file.relPath}::${symbol.name}`);
			fileNode.outDegree += 1;
			contains += 1;
			edges.push({
				project,
				id: edges.length + 1,
				sourceId: fileNode.id,
				targetId: symbolNode.id,
				type: 'CONTAINS',
				properties: { label: symbol.label, line: symbol.line },
			});
		}
	}
	// ── P2：真解析的**符号间边**（CALLS / USAGE / INHERITS / IMPLEMENTS）────────────────────────────
	// 与真源同法：**先收虚拟边、再按名字解析**（真源 `_matchCallsToDefinitions` / `_matchUsageEdgesToDefinitions` /
	// `_matchInheritsToDefinitions` ✓）。解析规则也照真源：
	//   · 目标候选按**名字**全局索引 ✓；
	//   · **同文件优先**，其次取第一个候选 ✓（真源 `service:4131-4137`）；
	//   · 目标 label 有限制（USAGE: class|interface|variable；INHERITS/IMPLEMENTS: class|interface ✓）；
	//   · **匹配不上就丢边** ✓（真源三处 `continue`；我们额外**如实计数** ⇒ 见文件头有意差异 ②）；
	//   · **按 (source,target,type) 去重** ✓（真源 `service:830` 插入前去重 ⇒ 同一条边只算一次、度数只 +1 ✓）。
	const nameIndex = new Map(); // name → node[]（顺序 = 节点创建顺序 ⇒ 确定性 ✓）
	for (const file of files) {
		for (const symbol of symbols[file.relPath] ?? []) {
			const node = symbolNodes.get(`${file.relPath}::${symbol.name}`);
			if (!node) { continue; }
			const list = nameIndex.get(symbol.name);
			if (list) { list.push(node); } else { nameIndex.set(symbol.name, [node]); }
		}
	}
	const edgeKeys = new Set(edges.map(edge => `${edge.sourceId}|${edge.targetId}|${edge.type}`));
	/** 解析一条虚拟边：同文件优先 → 第一个候选；label 不合或找不到 ⇒ 丢边（返回 undefined ✓）。 */
	const resolveTarget = (ownerNode, name, allowedLabels) => {
		const candidates = nameIndex.get(name);
		if (!candidates || candidates.length === 0) {
			return undefined;
		}
		const allowed = allowedLabels ? candidates.filter(node => allowedLabels.has(node.label)) : candidates;
		if (allowed.length === 0) {
			return undefined;
		}
		return allowed.find(node => node.filePath === ownerNode.filePath) ?? allowed[0];
	};
	const pushResolvedEdge = (sourceNode, targetNode, type, properties) => {
		const key = `${sourceNode.id}|${targetNode.id}|${type}`;
		if (edgeKeys.has(key)) {
			return false; // 去重（真源同款 ✓）
		}
		edgeKeys.add(key);
		sourceNode.outDegree += 1;
		targetNode.inDegree += 1;
		edges.push({ project, id: edges.length + 1, sourceId: sourceNode.id, targetId: targetNode.id, type, properties: properties ?? {} });
		return true;
	};
	let callEdges = 0;
	let usageEdges = 0;
	let inheritEdges = 0;
	if (extract) {
		for (const file of files) {
			const ownerOf = name => symbolNodes.get(`${file.relPath}::${name}`);
			for (const call of calls[file.relPath] ?? []) {
				const ownerNode = ownerOf(call.owner);
				if (!ownerNode) {
					unmatchedCalls += 1;
					continue;
				}
				const targetNode = resolveTarget(ownerNode, call.name, undefined);
				if (!targetNode || pushResolvedEdge(ownerNode, targetNode, 'CALLS', { loopDepth: call.loopDepth ?? 0 }) === false) {
					if (!targetNode) { unmatchedCalls += 1; }
					continue;
				}
				callEdges += 1;
			}
			for (const usage of usages[file.relPath] ?? []) {
				const ownerNode = ownerOf(usage.owner);
				if (!ownerNode) {
					unmatchedUsages += 1;
					continue;
				}
				const targetNode = resolveTarget(ownerNode, usage.name, USAGE_TARGET_LABELS);
				if (!targetNode || pushResolvedEdge(ownerNode, targetNode, 'USAGE', { access: usage.access }) === false) {
					if (!targetNode) { unmatchedUsages += 1; }
					continue;
				}
				usageEdges += 1;
			}
			for (const inherit of inherits[file.relPath] ?? []) {
				const ownerNode = ownerOf(inherit.owner);
				if (!ownerNode) {
					unmatchedInherits += 1;
					continue;
				}
				const targetNode = resolveTarget(ownerNode, inherit.name, INHERIT_TARGET_LABELS);
				if (!targetNode || pushResolvedEdge(ownerNode, targetNode, inherit.type, {}) === false) {
					if (!targetNode) { unmatchedInherits += 1; }
					continue;
				}
				inheritEdges += 1;
			}
		}
	}
	// `fileHashes` 按扫描顺序输出（确定性 ⇒ 产物可比对），字段与真源一致
	for (const file of files) {
		const entry = hashes[file.relPath];
		if (!entry) { continue; }
		fileHashes.push({ project, relPath: file.relPath, sha256: entry.sha256, mtimeNs: entry.mtimeNs, size: entry.size });
	}
	const graph = {
		nodes,
		edges,
		fileHashes,
		bm25: null,
		layout: [],
		nextNodeId: nodes.length + 1,
		nextEdgeId: edges.length + 1,
	};
	return {
		project,
		graph,
		// 供下一次增量复用：每个文件的判定依据（size / mtimeNs / sha256）与**解析结果**
		//（specifiers / symbols / namedImports）。⚠ 这四份**不进产物** —— 产物的字段是读侧契约
		//（见文件头），而它们是"索引器自己的缓存" ✓（少带一份就会让"增量 ≡ 全量"破功 ✗）。
		hashes,
		specifiers,
		symbols,
		namedImports,
		// P2：给下一次增量复用（regex 模式下是空对象 ✓）
		calls,
		usages,
		inherits,
		stats: {
			root,
			parser,
			files: files.length,
			imports,
			external,
			unresolved,
			symbolNodes: nodes.length - files.length,
			containsEdges: contains,
			// `IMPORTS_SYMBOL`：连到目标文件里**真实存在**的那个符号 ✓；`importSymbolsMissing` 是
			// "名字在目标文件里找不到"的如实计数 ✓（别名 / 再导出 / 默认导出都会落这里 ✓）
			importSymbolEdges: importSymbols,
			importSymbolsMissing,
			// P2 真解析：四条边计数 + 三种"没匹配上"的如实计数 + 覆盖不到的如实计数（见文件头 ✓）
			callEdges,
			usageEdges,
			inheritEdges,
			unmatchedCalls,
			unmatchedUsages,
			unmatchedInherits,
			extractErrors,
			skippedUnsupported,
			reused,
			parsed,
			incrementalRuns: runs,
			fullRescan: fullRescan === true,
			truncated,
			ms: Date.now() - started,
			now,
		},
	};
}

/** 产物编码：图 JSON 走 **gzip**（文件名是 `.zst` 但读侧用 `gunzipSync` —— 见文件头契约说明）。 */
export function encodeGraph(graph) {
	return gzipSync(Buffer.from(JSON.stringify(graph)));
}

/** dsh 侧的 `producer` 取值（**两侧契约**：IDE 侧同名常量见 `codebaseIndexDefaults.ts` ✓）。 */
export const ARTIFACT_PRODUCER = 'vssaros-dsh';

/**
 * 清单（`artifact.json`）的字段与真源一致，读侧 `parseManifest` 才认。
 *
 * ★ 2026-10-13（用户裁决「**权限都在 dsh 侧全权处理、逻辑也都转移到 dsh 侧**」）：
 * 多写一个 `producer: 'vssaros-dsh'` —— 这是**所有权声明**：
 *   · IDE 侧见到它 ⇒ **不索引、不落盘**（连扫描都不做），只负责"读 + 发现变化就重载" ✓
 *     （判据在 IDE 侧 `codebaseGraphService._isIndexOwnedByDsh()`；它按键内联读清单 ⇒ 多一个键无碍 ✓）；
 *   · 反过来：dsh 的制品被删掉、或 IDE 后来自己写了一份（不带此键）⇒ 权限**自动回到 IDE** ✓
 *     （缺省行为始终是"谁也没接管时由 IDE 负责" ✓ —— 这是"没装 dsh 的环境不会失去索引"的保证 ✓）。
 *   · 为什么不用"IDE 侧配置项"：那是把决定权留在 IDE ✗，且新增配置项还要用户手动开 ✓。
 */
export function manifestOf(graph, { project, savedAt = Date.now(), producer = ARTIFACT_PRODUCER } = {}) {
	return {
		node_count: graph.nodes.length,
		edge_count: graph.edges.length,
		format: 'gzip-json',
		saved_at: savedAt,
		project,
		producer,
		// ── 与真源 `ArtifactMeta` 的**同形**补齐（2026-10-14 反向兼容查证后加 ✓）────────────────
		// 背景：以前我们只写上面那几个键，而 IDE 侧 `ArtifactMeta` 还声明 `schema_version` /
		// `compression` / `original_size` / `compressed_size` / `created_at`（见 `codebaseGraphPersistence.ts`）。
		// **查证结论**（逐条 grep 过真源）：今天**没有任何** IDE 代码读这五个键 ✓（它读清单是**按键内联**的：
		// 只认 `saved_at` / `node_count` / `edge_count` ✓）⇒ 缺它们**今天无害** ✓。
		// ⇒ 补这三个是**预防性**的（不是修 bug ✗，且这是**有意的**行为变化 ✓）：
		//   · `schema_version` / `compression`：**语义性**键 —— 真源自己把它们当"格式声明"用
		//     （注释原文："压缩格式记录在 artifact.json 中（compression: "gzip"），加载时自动探测" ✓），
		//     将来它真要按字段（而非嗅探）判格式时，我们这份就是**自洽可读**的 ✓；
		//   · `created_at`：与 `saved_at` **同一瞬间**的 ISO 串 ✓（两个键各写各的才是坑 ✗）。
		//
		// ⚠ **故意不写** `original_size` / `compressed_size` ✗：它们要的是"解压前/后的字节数"，
		//   而本函数的入参只有**图对象** ⇒ 要算它就得**为此多序列化一遍整张图**（大图上是 MB 级开销 ✗），
		//   换来两个**当前无人读**的字段 —— 不值 ✓。将来若真有读者要它，正确做法是让**编码处**
		//   （`encodeGraph` 已经 `JSON.stringify(graph)` 一次 ✓）把尺寸透传下来 ✓，而不是在这里重算。
		//
		// ⚠ 我们自己的读侧是**宽容白名单**（`parseManifest` 只取它认的那几个键、忽略其余 ✓）⇒ 加键不会破坏自家读 ✓。
		schema_version: 1,
		compression: 'gzip',
		created_at: new Date(savedAt).toISOString(),
	};
}

/**
 * **自证**（四问）：① 产出 → 写进临时目录 → 用**同一个读侧**读回 → 逐项比对（**契约** ✓）；
 * ② 拿①的结果当 `previous` 再跑一遍（文件一个没变）⇒ 应当**全部复用**且产物**逐字节相同**（**复用不改结果** ✓）；
 * ③ 在临时目录里造夹具：改一个文件 + 加一个文件 ⇒ "增量"与"全量"必须**同结果**（**变了也对** ✓）；
 * ④ 把 `(size, mtimeNs)` 判定**必然漏掉**的那次改动造出来 ⇒ 漏改**可复现** + 一次全量重扫**收敛**（**漏改可兜** ✓）；
 * ⑤ 符号级夹具：顶层声明能被抽出、挂上 `CONTAINS`、并被读侧认作 `function` / `class` / … 节点（**符号级** ✓）。
 *
 * 为什么非要五问：写侧最容易出的错不是"写得慢"，而是"**自己写的东西自己读不了**"（字段名 / 压缩格式 /
 * 目录约定任一处不一致都够）；增量最容易出的错是"**复用了不该复用的东西**"；符号级最容易出的错是
 * "**多抽/少抽**"（缩进的类成员被当成顶层 ✗）—— 这三类只在②③④⑤里才露头 ✓。
 * 全程**只碰临时目录**（`mkdtemp`），工作区里的 `.codebase-memory/` 一行不写 ✓。
 *
 * @returns `{ ok, stats, incremental, delta, miss, symbol, manifest, readBack, bytes, ms, warnings, error? }`
 *          （**不抛** —— 调用方要能直接显示）
 */
export async function selfCheck({ root, maxFiles = DEFAULT_MAX_FILES, project = 'dsh-self-index' } = {}) {
	const started = Date.now();
	if (!root) {
		return { ok: false, error: '需要 root（要扫描的工作区根）', ms: Date.now() - started };
	}
	const warnings = [];
	const built = await buildImportGraph({ root, maxFiles, project });
	// ── ② pass2：拿①当 `previous` 再跑（文件**一个没变**）───────────────────────────────
	// 「全部复用」+「产物逐字节相同」是"增量 ≡ 全量"最硬的形式：复用路径只要悄悄动过任何一处
	// （node id / 顺序 / 计数 / hash / **符号**），字节比对立刻红 ✓。
	const again = await buildImportGraph({ root, maxFiles, project, previous: built });
	const incremental = {
		reused: again.stats.reused,
		parsed: again.stats.parsed,
		equal: encodeGraph(again.graph).equals(encodeGraph(built.graph)),
	};
	const manifest = manifestOf(built.graph, { project });
	const bytes = encodeGraph(built.graph);
	let temp;
	try {
		temp = await mkdtemp(join(tmpdir(), 'vssaros-codebase-selfcheck-'));
		// ── ③④⑤ 夹具（都在临时目录里，与下面的读回互不干扰）──
		const delta = await deltaCheck(join(temp, 'delta-ws'));
		const miss = await missCheck(join(temp, 'miss-ws'));
		const symbol = await symbolCheck(join(temp, 'symbol-ws'));
		const cacheFixture = await cacheCheck(join(temp, 'cache-ws'));
		const dir = join(temp, '.codebase-memory');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
		await writeFile(join(dir, GRAPH_FILE), bytes);
		// ★ 读侧就是页面/工具用的那两个（`store.readOverview` / `store.loadGraph`）
		const overview = await readOverview({ workspaceRoot: temp });
		const loaded = await loadGraph({ workspaceRoot: temp });
		const readBack = {
			overviewError: overview.error,
			manifestError: overview.manifestError,
			manifest: overview.manifest,
			graphError: loaded.error,
			nodeCount: loaded.graph?.nodes?.length ?? 0,
			edgeCount: loaded.graph?.edges?.length ?? 0,
			// 读侧把**符号节点**原样带回来（label 就是 `function` / `class` / …）⇒ 符号级不是自说自话 ✓
			symbolNodes: (loaded.graph?.nodes ?? []).filter(node => node?.label && node.label !== 'file').length,
			nodeCountMatches: (loaded.graph?.nodes?.length ?? -1) === built.graph.nodes.length,
			edgeCountMatches: (loaded.graph?.edges?.length ?? -1) === built.graph.edges.length,
		};
		// ⚠ 读侧 `parseManifest` 把清单**改名成驼峰**（`node_count` → `nodeCount`，见 core/codebase.js:34-42）
		// ⇒ 比对必须按读侧的形状来 ✗ 不能按**我们写下去**的形状（第一版就是这么写错的：永远 undefined ⇒ 永不过）。
		const ok = !readBack.overviewError && !readBack.manifestError && !readBack.graphError
			&& readBack.manifest?.nodeCount === manifest.node_count
			&& readBack.manifest?.edgeCount === manifest.edge_count
			&& readBack.nodeCountMatches && readBack.edgeCountMatches
			&& readBack.symbolNodes === built.stats.symbolNodes
			&& incremental.equal && delta.equal && delta.changed
			// ④：漏改**必须能复现**（搬不动就是假绿 ✗）+ 一次全量重扫**必须收敛** + 策略给得出"该重扫" ✓
			&& miss.missObserved && miss.rescannedEqual && miss.rescannedReused === 0 && miss.policyAdvises
			// ⑤：符号级的抽/挂/认三条都要过（多抽或漏抽都会红 ✓）
			&& symbol.ok
			// ⑥：缓存跨进程 —— 子进程拿**文件里那串 JSON** 跑出的图必须与干净全量**摘要相同** ✓，
			// 且四条"该拒就拒"**一条都不许被默默接受** ✗（任何一条被接受 ⇒ `rejects` 少一个 ⇒ 这里红 ✓）
			&& cacheFixture.childExit === 0 && cacheFixture.childEqual && cacheFixture.parentEqual
			&& cacheFixture.childReused === cacheFixture.files && cacheFixture.rejects === 4;
		return { ok, stats: built.stats, incremental, delta, miss, symbol, cacheFixture, manifest, readBack, bytes: bytes.length, ms: Date.now() - started, warnings };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e), stats: built.stats, manifest, bytes: bytes.length, ms: Date.now() - started, warnings };
	} finally {
		if (temp) {
			await rm(temp, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

/**
 * **增量差分夹具**（只在临时目录里跑）：造 3 个小文件 → 全量建图 → 改一个 + 加一个 →
 * 分别用"增量（拿旧结果当 `previous`）"与"全量"重建 ⇒ 两图必须**逐字节相同** ✓。
 *
 * 这条补的正是 pass2 补不上的那一半：pass2 只证"**没变**时复用不出错"✓；这里证"**变了**时也错不了" ✓
 * —— 复用的风险全在后半句。
 *
 * ⚠ 变更处**刻意同时改尺寸**（beta 多一行 `import` ⇒ 变长）⇒ 判定不依赖 mtime 粒度，不会因"同一毫秒内
 * 改写"退化成"复用了没变的判定"（那会让 `equal` 变成**假绿** ✓ 比红更糟）。
 */
async function deltaCheck(root) {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, 'alpha.ts'), 'export const alpha = 1;\n');
	await writeFile(join(root, 'beta.ts'), "import { alpha } from './alpha';\nexport const beta = alpha;\n");
	const before = await buildImportGraph({ root });
	await writeFile(join(root, 'gamma.ts'), 'export const gamma = 3;\n');
	await writeFile(join(root, 'beta.ts'), "import { alpha } from './alpha';\nimport { gamma } from './gamma';\nexport const beta = alpha + gamma;\n");
	const incremental = await buildImportGraph({ root, previous: before });
	const full = await buildImportGraph({ root });
	const count = (graph, type) => graph.edges.filter(edge => edge.type === type).length;
	return {
		files: full.stats.files,
		reused: incremental.stats.reused,
		parsed: incremental.stats.parsed,
		// 报告 **IMPORTS** 的边数（"变更非空"这条断言只说 import 层，不受符号层影响 ✓），
		// 另附总边数（含 `CONTAINS`）以便一眼看出符号层也在 ✓。
		importsBefore: count(before.graph, 'IMPORTS'),
		importsAfter: count(full.graph, 'IMPORTS'),
		edgesBefore: before.graph.edges.length,
		edgesAfter: full.graph.edges.length,
		changed: count(before.graph, 'IMPORTS') !== count(full.graph, 'IMPORTS'),
		equal: encodeGraph(incremental.graph).equals(encodeGraph(full.graph)),
	};
}

/**
 * **漏改兜底夹具**（只在临时目录里跑）：把"复用判定会漏掉的那次改动"**造出来**，再证兜底能收敛 ✓。
 *
 * 为什么要造：`(size, mtimeNs)` 判定天然会漏掉"**同尺寸 + 同 mtime 粒度内**"的改动 ✗。真实场景靠
 * **周期性全量重扫**兜底 ✓ —— 但"兜底到底有没有用"不能靠嘴说 ✓。这里把它钉成两个事实：
 *   ① 漏改**可复现**：缓存声称"没变" ⇒ 复用旧说明符 ⇒ 结果与真相**不同**（`missObserved` ✓）；
 *   ② 一次全量重扫**收敛**：`fullRescan: true` 的产出与"干净重建"**逐字节相同**（`rescannedEqual` ✓）。
 *
 * ⚠ 缓存是**人为构造**的（把"**新的** stat 值 + **旧的** specifiers/symbols"拼进 `previous`）⇒ 不依赖文件
 * 系统的时间精度 ⇒ 每次运行都必然复现漏改 ✓。**正因如此**，`missObserved === true` 也算进通过条件 ✓ ——
 * 有朝一日夹具不再能制造漏改（比如判定改成了内容哈希），这条会**红**而不是变成假绿 ✓。
 */
async function missCheck(root) {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, 'aaa.ts'), 'export const aaa = 1;\n');
	await writeFile(join(root, 'bbb.ts'), 'export const bbb = 2;\n');
	await writeFile(join(root, 'beta.ts'), "import { aaa } from './aaa';\nexport const beta = aaa;\n");
	const first = await buildImportGraph({ root });
	// 改写 beta：换成**同样长度**的目标（`'./bbb'` 与 `'./aaa'` 都是 7 个字符 ⇒ 尺寸不变 ✓）
	await writeFile(join(root, 'beta.ts'), "import { bbb } from './bbb';\nexport const beta = bbb;\n");
	const info = await stat(join(root, 'beta.ts'));
	const stale = {
		...first,
		hashes: {
			...first.hashes,
			'beta.ts': { size: info.size, mtimeNs: Math.round(info.mtimeMs * 1e6), sha256: first.hashes['beta.ts'].sha256 },
		},
		specifiers: { ...first.specifiers, 'beta.ts': first.specifiers['beta.ts'] },
		symbols: { ...first.symbols, 'beta.ts': first.symbols['beta.ts'] },
	};
	const missed = await buildImportGraph({ root, previous: stale });
	const full = await buildImportGraph({ root });
	const rescanned = await buildImportGraph({ root, previous: missed, fullRescan: true });
	// 只看 `IMPORTS` 边（符号层也有边 ⇒ 不能拿 `edges[0]` 当"那条 import"✗）
	const importTargetOf = graph => {
		const edge = graph.edges.find(candidate => candidate.type === 'IMPORTS');
		return graph.nodes.find(node => node.id === edge?.targetId)?.filePath;
	};
	return {
		missReused: missed.stats.reused,
		missTarget: importTargetOf(missed.graph),
		fullTarget: importTargetOf(full.graph),
		missObserved: importTargetOf(missed.graph) !== importTargetOf(full.graph),
		rescannedReused: rescanned.stats.reused,
		rescannedEqual: encodeGraph(rescanned.graph).equals(encodeGraph(full.graph)),
		runs: missed.stats.incrementalRuns,
		policyAdvises: shouldRescan(missed, { maxIncrementalRuns: 1 }),
	};
}

/**
 * **该不该强制全量重扫**：连续增量次数到阈值就该来一次 ✓ —— 真索引器用它兜 `(size, mtimeNs)` 判定的
 * 漏改 ✗（见 `missCheck` 把这条漏改**造出来**验一遍 ✓）。
 *
 * 只按"次数"这一条来判 ✓ —— 时间维度（"最长 N 小时来一次"）是天然的下一步，这一步**没做** ✗。
 * @returns `true` = **建议**忽略缓存、全量重解析（调用方决定听不听 ✓）
 */
/**
 * 增量缓存的**版本**：缓存形状/语义一改就 +1 ⇒ 旧缓存会被 `parseCache` **大声拒绝** ✓
 * （不是"默默少用一点" ✗ —— 那样增量会少算，而结果看起来正常 ✓）。
 *
 * ⚠ 2026-10-12（P2）：1 → **2** —— 缓存里多了真解析的三份事实（`calls` / `usages` / `inherits` ✓）。
 * 旧缓存（version 1）会被拒绝 ⇒ 第一次升级到 treesitter 时全量重扫一遍（**这是对的** ✓：
 * 少这三份就会让"增量 ≠ 全量"，而那正是缓存最危险的错法 ✗）。
 */
export const CACHE_VERSION = 2;

/**
 * 把一次索引的**可复用状态**序列化成 JSON 安全对象（跨进程 / 跨次运行用 ✓）。
 *
 * 只带"**怎么复用**"所需的东西：每文件的 `size/mtimeNs/sha256` ＋ 解析结果（`specifiers` / `symbols` /
 * `namedImports` ＋ P2 的 `calls` / `usages` / `inherits` ✓）、**不带产物**（图不进缓存 ✓
 * —— 图是可重算的，缓存只是"省一次解析" ✓）。
 */
export function serializeCache(index, { savedAt = Date.now() } = {}) {
	return {
		version: CACHE_VERSION,
		// 写 `root` 进去**就是为了拒绝**：缓存只对它自己那个工作区有效 ✓（拿 A 的缓存去 B，
		// 复用的是 A 的 mtime 判定 ⇒ 边会算错且看不出来 ✗）。
		root: toPosix(index?.stats?.root ?? ''),
		savedAt,
		hashes: index?.hashes ?? {},
		specifiers: index?.specifiers ?? {},
		symbols: index?.symbols ?? {},
		namedImports: index?.namedImports ?? {},
		// P2（真解析模式才有内容；regex 模式下是空对象 ✓ —— 形状固定 ⇒ 增量与全量走同一条计算路径 ✓）
		calls: index?.calls ?? {},
		usages: index?.usages ?? {},
		inherits: index?.inherits ?? {},
		parser: index?.stats?.parser ?? 'regex',
	};
}

/**
 * 读回缓存 —— **能拒就拒，并且说清为什么** ✓。返回 `{ cache }` 或 `{ error }`（**不抛**：调用方要能如实显示 ✓）。
 *
 * 为什么拒得这么啰嗦：缓存**唯一危险的错法是"悄悄用了一点"** ✗（版本/工作区对不上 ⇒ 增量少算或算错，
 * 而结果**看起来正常** ✓）。所以每条拒绝理由都要能**原样写进页面/工具输出** ✓。
 */
export function parseCache(value, { root, now = Date.now() } = {}) {
	let data = value;
	if (typeof value === 'string') {
		try {
			data = JSON.parse(value);
		} catch (e) {
			return { error: `缓存不是合法 JSON：${String(e?.message ?? e)}` };
		}
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return { error: '缓存不是对象' };
	}
	if (data.version !== CACHE_VERSION) {
		return { error: `缓存版本不符：文件里是 ${String(data.version)}，本版要 ${CACHE_VERSION}（请全量重扫）` };
	}
	const wantRoot = toPosix(root ?? '');
	if (wantRoot && toPosix(data.root ?? '') !== wantRoot) {
		return { error: `缓存属于别的工作区：缓存=${toPosix(data.root ?? '') || '(空)'} 当前=${wantRoot}` };
	}
	for (const field of ['hashes', 'specifiers', 'symbols', 'namedImports', 'calls', 'usages', 'inherits']) {
		if (!data[field] || typeof data[field] !== 'object') {
			return { error: `缓存缺 ${field}（形状不对，请全量重扫）` };
		}
	}
	return { cache: { ...data, savedAt: typeof data.savedAt === 'number' ? data.savedAt : now } };
}

/**
 * **跨进程缓存夹具**（只在临时目录里跑）：把缓存**写成文件** → 起一个**新 Node 进程**读它并用它跑增量
 * → 子进程算出的图与父进程的"干净全量"**摘要必须相同** ✓。
 *
 * 为什么非要跨进程：`previous` 在**内存里**传是 5.54 证过的 ✓，可真索引器要跨 **Host 重启** ✓ ——
 * 那时缓存只剩"文件里那串 JSON" ✓。这条证的就是**那串 JSON 够用**（序列化无损 / 字段没丢 / 形状没变 ✓）。
 * 顺带把**该拒就拒**也钉住 ✓：版本不符、别的工作区、垃圾输入，一个都不许被"默默用上" ✗。
 */
async function cacheCheck(root) {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, 'one.ts'), 'export const one = 1;\n');
	await writeFile(join(root, 'two.ts'), "import { one } from './one';\nexport const two = one;\n");
	const full = await buildImportGraph({ root });
	const cache = serializeCache(full);
	// ⚠ 辅助文件写到**扫描范围之外**（`root` 的兄弟目录 ✓）：`child.mjs` 是 `.mjs` ⇒ 会被
	// `collectSourceFiles` 当成源文件 ✗ —— 那样"增量"看到的文件比"全量"多一个，两边的图**真的不同** ✓
	// （第一版就是这么红的：**红得有道理** ✓，但红的是夹具、不是被测物 ✗）。`cache.json` 不是源码、
	// 本来不影响，但和它放一起更省心 ✓。
	const aux = `${root}-aux`;
	await mkdir(aux, { recursive: true });
	const cacheFile = join(aux, 'cache.json');
	await writeFile(cacheFile, JSON.stringify(cache));
	const childFile = join(aux, 'child.mjs');
	await writeFile(childFile, [
		`import { createHash } from 'node:crypto';`,
		`import { readFile } from 'node:fs/promises';`,
		// 子进程按**同一个模块 URL** 导入 ⇒ 证的是这个模块的缓存能被另一个进程用 ✓（不是另一份实现的复印件 ✓）
		`import { buildImportGraph, encodeGraph, parseCache } from ${JSON.stringify(import.meta.url)};`,
		`const [, , wsRoot, cachePath] = process.argv;`,
		`const parsed = parseCache(await readFile(cachePath, 'utf8'), { root: wsRoot });`,
		`if (parsed.error) { console.log(JSON.stringify({ error: parsed.error })); process.exit(0); }`,
		`const next = await buildImportGraph({ root: wsRoot, previous: parsed.cache });`,
		`console.log(JSON.stringify({`,
		`	digest: createHash('sha256').update(encodeGraph(next.graph)).digest('hex'),`,
		`	reused: next.stats.reused, parsed: next.stats.parsed,`,
		`	nodes: next.graph.nodes.length, edges: next.graph.edges.length,`,
		`}));`,
	].join('\n'));
	// 只在自证里起子进程 ⇒ 用**动态 import**，别把 `node:child_process` 带进插件的主路径 ✓
	const { spawnSync } = await import('node:child_process');
	// ⚠ windowsHide 必带（见 vssaros-agents/lib/memory.js 的同类注释）：dsh Host 没有
	// 可继承的控制台，不带就会为这条子进程新分配一个控制台窗口 ⇒ 自证时闪黑框。
	const child = spawnSync(process.execPath, [childFile, root, cacheFile], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
	let out = {};
	try {
		out = JSON.parse(String(child.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}');
	} catch {
		out = {}; // 子进程输出不是 JSON ⇒ 下面按"证据不足"处理（不假装通过 ✓）
	}
	const incr = await buildImportGraph({ root, previous: cache });
	const digestOf = graph => createHash('sha256').update(encodeGraph(graph)).digest('hex');
	const fullDigest = digestOf(full.graph);
	return {
		files: full.stats.files,
		childExit: child.status,
		childReused: out.reused ?? -1,
		childEqual: !!out.digest && out.digest === fullDigest,
		parentEqual: digestOf(incr.graph) === fullDigest,
		reused: incr.stats.reused,
		cacheBytes: Buffer.byteLength(JSON.stringify(cache), 'utf8'),
		// 三条"该拒就拒"（只要有一条被默默接受 ⇒ `rejects` 少一个 ⇒ 探针红 ✓）
		rejects: [
			parseCache({ ...cache, version: CACHE_VERSION + 1 }, { root }).error,
			parseCache({ ...cache, root: '/somewhere/else/entirely' }, { root }).error,
			parseCache('not json at all', { root }).error,
			parseCache(null, { root }).error,
		].filter(Boolean).length,
		rejectReasons: [
			parseCache({ ...cache, version: CACHE_VERSION + 1 }, { root }).error,
			parseCache({ ...cache, root: '/somewhere/else/entirely' }, { root }).error,
		],
	};
}

export function shouldRescan(previous, { maxIncrementalRuns = 10 } = {}) {
	return (previous?.stats?.incrementalRuns ?? 0) >= maxIncrementalRuns;
}

/**
 * **符号级夹具**（只在临时目录里跑）：一个文件里放齐六种顶层声明 + 两个**缩进**声明，
 * 断言"**该抽的都抽到、不该抽的一个没抽**"，并且 `CONTAINS` 边与 `qualifiedName` 都成对 ✓。
 *
 * ⚠ 缩进那两个（类方法 `area` / 内嵌函数 `inner`）是**故意的反例** ✓ —— 少了它们，这条自检
 * 只证"能抽" ✗，证不了"不超抽" ✗，而**多抽**恰恰是正则式抽取最典型的翻车方式 ✓。
 */
async function symbolCheck(root) {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, 'lib.ts'), [
		'export interface Shape {',      // 1  → interface
		'\tarea(): number;',             // 缩进 ⇒ **不该抽**
		'}',
		'',
		'export class Circle implements Shape {', // 5 → class
		'\tarea() { return 0; }',        // 缩进 ⇒ **不该抽**
		'}',
		'',
		'export const PI = 3.14;',       // 9  → variable
		'',
		'export async function load(): Promise<void> {}', // 11 → function
		'',
		'type Hidden = string;',         // 13 → type
		'',
		'enum Color { Red }',            // 15 → enum
		'',
		'function nested() {',           // 17 → function
		'\tfunction inner() {}',         // 缩进 ⇒ **不该抽**
		'}',
	].join('\n') + '\n');
	// 第二个文件：从 `lib.ts` 具名导入（其中 `Nope` 在目标里**不存在** ⇒ 必须计入 missing ✓）
	await writeFile(join(root, 'use.ts'), [
		"import { Circle, PI, Nope } from './lib';",
		'export const total = PI;',
	].join('\n') + '\n');
	const built = await buildImportGraph({ root });
	const symbolNodes = built.graph.nodes.filter(node => node.label !== 'file');
	const got = symbolNodes.map(node => `${node.label}:${node.name}@${node.startLine}`).join(',');
	const expected = 'interface:Shape@1,class:Circle@5,variable:PI@9,function:load@11,type:Hidden@13,enum:Color@15,function:nested@17,variable:total@2';
	const contains = built.graph.edges.filter(edge => edge.type === 'CONTAINS');
	const qualified = symbolNodes.find(node => node.name === 'Circle')?.qualifiedName;
	const containsOk = contains.length === symbolNodes.length
		&& contains.every(edge => {
			const source = built.graph.nodes.find(node => node.id === edge.sourceId);
			const target = built.graph.nodes.find(node => node.id === edge.targetId);
			return source?.label === 'file' && target?.label !== 'file';
		});
	// `IMPORTS_SYMBOL`：`use.ts` 具名导入了 3 个名字，其中 2 个在 `lib.ts` 里真是声明 ⇒ 2 条边 + 1 个 missing ✓
	const pathOf = id => built.graph.nodes.find(node => node.id === id)?.filePath;
	const qualifiedOf = id => built.graph.nodes.find(node => node.id === id)?.qualifiedName;
	const symbolEdgeNames = built.graph.edges
		.filter(edge => edge.type === 'IMPORTS_SYMBOL')
		.map(edge => `${pathOf(edge.sourceId)}->${qualifiedOf(edge.targetId)}`);
	const symbolEdgesOk = symbolEdgeNames.length === 2
		&& symbolEdgeNames.includes('use.ts->lib.ts::Circle')
		&& symbolEdgeNames.includes('use.ts->lib.ts::PI')
		&& built.stats.importSymbolEdges === 2 && built.stats.importSymbolsMissing === 1;
	return {
		got,
		expected,
		count: symbolNodes.length,
		contains: contains.length,
		qualified,
		symbolEdges: symbolEdgeNames.join(','),
		missing: built.stats.importSymbolsMissing,
		ok: got === expected && containsOk && qualified === 'lib.ts::Circle' && symbolEdgesOk,
	};
}

/** 供工具/页面用的紧凑摘要（人读一句 + 结构化一份，后者走 `*_json:` 机器行约定）。 */
export function summarizeSelfCheck(result) {
	const stats = result.stats ?? {};
	return {
		ok: result.ok === true,
		root: toPosix(stats.root ?? ''),
		files: stats.files ?? 0,
		imports: stats.imports ?? 0,
		external: stats.external ?? 0,
		unresolved: stats.unresolved ?? 0,
		truncated: stats.truncated === true,
		nodeCount: result.manifest?.node_count ?? 0,
		edgeCount: result.manifest?.edge_count ?? 0,
		graphBytes: result.bytes ?? 0,
		// 符号级（④）：符号节点数 / `CONTAINS` 边数 / 夹具三条（抽得对、挂得上、读得回 ✓）
		symbolCount: stats.symbolNodes ?? 0,
		containsEdges: stats.containsEdges ?? 0,
		// 符号级导入边（README 5.66）：连到真定义几条 / 名字在目标里找不到几条（如实计数 ✓）
		importSymbolEdges: stats.importSymbolEdges ?? 0,
		importSymbolsMissing: stats.importSymbolsMissing ?? 0,
		symbolFixtureOk: result.symbol?.ok === true,
		// 增量两问的结论（见 `selfCheck` 的②③）：复用数 / "复用不改结果" / 差分夹具的边数与"变了也对"
		reused: result.incremental?.reused ?? 0,
		incrementalEqual: result.incremental?.equal === true,
		deltaFiles: result.delta?.files ?? 0,
		deltaReused: result.delta?.reused ?? 0,
		deltaEdgesBefore: result.delta?.importsBefore ?? 0,
		deltaEdgesAfter: result.delta?.importsAfter ?? 0,
		deltaEqual: result.delta?.equal === true,
		// 漏改兜底（见 `missCheck`）：漏改复现了吗 / 全量重扫收敛了吗
		missReused: result.miss?.missReused ?? 0,
		// ⑥ 缓存跨进程（见 `cacheCheck`）：字节数 / 与干净全量一致 / 子进程复用数 / 该拒就拒的条数
		cacheBytes: result.cacheFixture?.cacheBytes ?? 0,
		cacheCrossProcessEqual: result.cacheFixture?.childEqual === true && result.cacheFixture?.parentEqual === true,
		cacheReuseCount: result.cacheFixture?.childReused ?? 0,
		cacheRejects: result.cacheFixture?.rejects ?? 0,
		// **失败分项**：`ok: false` 光说"没通过"没用 ✓ —— 2026-10-12 为查"是哪一条"白跑了两轮 ✓。
		// 这里从已有字段反推，不额外传参 ✓（"假绿"也单列：夹具没造出变更 / 漏改没复现，比红更值得喊 ✓）。
		failed: [
			result.incremental?.equal === false ? '② 复用改变了结果' : null,
			result.delta?.equal === false ? '③ 增量 ≠ 全量' : null,
			result.delta?.changed === false ? '③ 夹具没造出变更（假绿）' : null,
			result.miss?.missObserved === false ? '④ 漏改没复现（假绿）' : null,
			result.miss?.rescannedEqual === false ? '④ 全量重扫不收敛' : null,
			result.symbol?.ok === false ? '⑤ 符号级抽/挂/认不过' : null,
			result.cacheFixture?.childEqual === false || result.cacheFixture?.parentEqual === false ? '⑥ 缓存跨进程与全量不一致' : null,
			result.cacheFixture?.rejects !== 4 ? `⑥ 有缓存"该拒没拒"（只拒了 ${String(result.cacheFixture?.rejects)}/4）` : null,
			result.readBack?.nodeCountMatches === false || result.readBack?.edgeCountMatches === false ? '① 读回计数不一致' : null,
		].filter(Boolean),
		missObserved: result.miss?.missObserved === true,
		rescannedEqual: result.miss?.rescannedEqual === true,
		readBack: result.readBack
			? {
				ok: result.readBack.nodeCountMatches === true && result.readBack.edgeCountMatches === true,
				nodeCount: result.readBack.nodeCount ?? 0,
				edgeCount: result.readBack.edgeCount ?? 0,
				symbolNodes: result.readBack.symbolNodes ?? 0,
			}
			: undefined,
		...(result.error ? { error: result.error } : {}),
		ms: result.ms ?? 0,
	};
}

/**
 * 把自证摘要压成**扁平**形状 —— 工具输出与 HTTP 回执**共用这一份**（一处定义、两处使用）。
 *
 * 为什么必须共用：第一版工具侧拍了平、HTTP 侧原样回嵌套对象 ⇒ **同一件事两种形状**，探针按工具的形状
 * 读 HTTP 就拿到 `undefined` ✗（真机 p3-11 抓到的）。形状漂移是这类"两面同一数据"最常见的坑 ✓。
 */
export function flatSelfCheck(summary) {
	return {
		ok: summary.ok === true,
		root: summary.root,
		files: summary.files ?? 0,
		imports: summary.imports ?? 0,
		external: summary.external ?? 0,
		unresolved: summary.unresolved ?? 0,
		truncated: summary.truncated === true,
		nodeCount: summary.nodeCount ?? 0,
		edgeCount: summary.edgeCount ?? 0,
		graphBytes: summary.graphBytes ?? 0,
		symbolCount: summary.symbolCount ?? 0,
		containsEdges: summary.containsEdges ?? 0,
		importSymbolEdges: summary.importSymbolEdges ?? 0,
		importSymbolsMissing: summary.importSymbolsMissing ?? 0,
		symbolFixtureOk: summary.symbolFixtureOk === true,
		reused: summary.reused ?? 0,
		incrementalEqual: summary.incrementalEqual === true,
		deltaFiles: summary.deltaFiles ?? 0,
		deltaReused: summary.deltaReused ?? 0,
		deltaEdgesBefore: summary.deltaEdgesBefore ?? 0,
		deltaEdgesAfter: summary.deltaEdgesAfter ?? 0,
		deltaEqual: summary.deltaEqual === true,
		missReused: summary.missReused ?? 0,
		cacheBytes: summary.cacheBytes ?? 0,
		cacheCrossProcessEqual: summary.cacheCrossProcessEqual === true,
		cacheReuseCount: summary.cacheReuseCount ?? 0,
		cacheRejects: summary.cacheRejects ?? 0,
		missObserved: summary.missObserved === true,
		rescannedEqual: summary.rescannedEqual === true,
		readBackNodeCount: summary.readBack?.nodeCount ?? 0,
		readBackEdgeCount: summary.readBack?.edgeCount ?? 0,
		readBackSymbolNodes: summary.readBack?.symbolNodes ?? 0,
		...(summary.error ? { error: summary.error } : {}),
		ms: summary.ms ?? 0,
	};
}

/** 让 `gunzipSync` 不被摇树误伤（解码只用一次：探针按同一读侧口径核对时可能直接调它）。 */
export function decodeGraph(bytes, { maxOutputLength } = {}) {
	// ⚠ `maxOutputLength` 是给**不可信输入**用的（导入的外来产物 ✓）：不设上限时，一个小文件能解出几十 GB ✗✗
	//   （zip bomb ✓）；索引器自己的产物是可信的 ⇒ 不传时行为与从前**逐字相同** ✓。
	const buf = maxOutputLength === undefined ? gunzipSync(bytes) : gunzipSync(bytes, { maxOutputLength });
	return JSON.parse(buf.toString('utf8'));
}
