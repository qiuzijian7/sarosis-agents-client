// @vssaros/dsh-codebase — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 契约真源 = **本机真实图谱文件**（`<workspace>/.codebase-memory/`，方案 6.6 与真机逐项对上）：
//
//   artifact.json   ← 轻量清单，**不用解压**就能读：
//     { node_count: 186142, edge_count: 489124, format: 'gzip-json', saved_at: <ms>, project: 'sarosis-agents-client' }
//
//   graph.db.zst    ← **gzip** 压缩的 JSON（magic 1f8b；`.zst` 后缀名不表示 zstd，真源设置项明说 gzip-json）；
//     解压后 ≈ 129MB：{ nodes, edges, fileHashes, bm25: null, layout: [], nextNodeId, nextEdgeId }
//     node = { project, id, label: 'variable'|'function'|'interface'|'class'|'file'|'enum',
//              name, qualifiedName: '<file>::<name>', filePath, startLine, endLine,
//              properties: { cyclomatic, … }, inDegree, outDegree, community }
//     edge = { project, sourceId, targetId, type: 'CONTAINS'|'CALLS'|'USAGE', properties, id }
//     fileHashes = [{ project, relPath, sha256, mtimeNs, size }]
//
// 另有 `graph.db.sqlite` 变体（主进程 VACUUM INTO 出的快照，本机 943MB）——v0 不读它（需要 SQLite 驱动），
// 页面上会如实列出它存在与大小。

/** 清单（artifact.json）——轻量视图，任何操作都不该先解压。 */
export function parseManifest(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `artifact.json 不是合法 JSON：${String(e?.message ?? e)}` };
	}
	if (!raw || typeof raw !== 'object') {
		return { error: `artifact.json 顶层不是对象：${typeof raw}` };
	}
	if (raw.format !== undefined && raw.format !== 'gzip-json') {
		// 不认识的格式要报出来（例如某些版本写 sqlite 快照）
		return { error: `不认识的 artifact.format：${String(raw.format)}（本模块按 gzip-json 解析）` };
	}
	return {
		manifest: {
			nodeCount: finite(raw.node_count),
			edgeCount: finite(raw.edge_count),
			project: typeof raw.project === 'string' ? raw.project : undefined,
			savedAt: finite(raw.saved_at),
			format: typeof raw.format === 'string' ? raw.format : 'gzip-json',
		},
	};
}

function finite(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 图谱顶层形态校验（坏结构带原因，不猜）。 */
export function validateGraph(raw) {
	if (!raw || typeof raw !== 'object') {
		return { error: `图谱顶层不是对象：${typeof raw}` };
	}
	if (!Array.isArray(raw.nodes)) {
		return { error: `图谱缺 nodes 数组（${typeof raw.nodes}）` };
	}
	if (!Array.isArray(raw.edges)) {
		return { error: `图谱缺 edges 数组（${typeof raw.edges}）` };
	}
	return {
		graph: {
			nodes: raw.nodes,
			edges: raw.edges,
			fileHashes: Array.isArray(raw.fileHashes) ? raw.fileHashes : [],
			nextNodeId: finite(raw.nextNodeId),
			nextEdgeId: finite(raw.nextEdgeId),
		},
	};
}

/** 概览（纯计算；调用方决定要不要为它解压）。 */
export function summarizeGraph(graph) {
	const labels = new Map();
	for (const node of graph.nodes) {
		const key = typeof node?.label === 'string' ? node.label : '(未声明 label)';
		labels.set(key, (labels.get(key) ?? 0) + 1);
	}
	const edgeTypes = new Map();
	for (const edge of graph.edges) {
		const key = typeof edge?.type === 'string' ? edge.type : '(未声明 type)';
		edgeTypes.set(key, (edgeTypes.get(key) ?? 0) + 1);
	}
	const files = new Set();
	for (const node of graph.nodes) {
		if (typeof node?.filePath === 'string' && node.filePath) {
			files.add(node.filePath);
		}
	}
	const communities = new Set();
	for (const node of graph.nodes) {
		if (node?.community !== undefined && node.community !== null) {
			communities.add(node.community);
		}
	}
	const top = (map, limit = 12) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit)
		.map(([name, count]) => ({ name, count }));
	return {
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		files: files.size,
		fileHashes: graph.fileHashes.length,
		communities: communities.size,
		labels: top(labels),
		edgeTypes: top(edgeTypes),
	};
}

/**
 * `codebase_architecture` **支持**的方面。
 *
 * 2026-10-13（P6）之前只有前 5 个 ✓ —— 真源另外 7 个（packages / layers / services / routes /
 * crossBoundaries / dependencies / deadCode）当时**没有**（要索引器的进阶 pass ✗），因此列在 `ARCHITECTURE_NOT_PORTED` ✓。
 * 现在这 7 个都按**图内已有的事实**做出来了 ✓（各自的 `*Method` 字段写明口径与近似程度 ✓）——
 * ⚠ 它们是**近似**（路径/命名/度数层面 ✓），**不等价**于真源那套索引器分析 ✗（见 `notPortedHint` ✓）。
 */
export const ARCHITECTURE_ASPECTS = [
	'languages', 'entryPoints', 'hotspots', 'communities', 'tree',
	'packages', 'layers', 'services', 'routes', 'crossBoundaries', 'dependencies', 'deadCode',
];
/**
 * 真源有、我们**仍然没有**的方面 ⇒ 现在为**空** ✓（那 7 个已按图近似实现 ✓）。
 * ⚠ 保留这个常量与输出字段是**有意的**：调用方与守卫都按它判断"有没有缺项" ✓，
 *   一旦将来真源又长出新的分析面，就往这里加 ✓（而不是悄悄不实现 ✗）。
 */
export const ARCHITECTURE_NOT_PORTED = [];
/** 真源那 7 条背后用的**进阶分析**（我们仍然没有 ⇒ 只能给近似 ✓）—— 写进 `notPortedHint` 里指路 ✓。 */
export const ARCHITECTURE_APPROXIMATED = ['packages', 'layers', 'services', 'routes', 'crossBoundaries', 'dependencies', 'deadCode'];

/**
 * 路径 → 包（**路径约定**：取**目录**部分的前两段 ✓）。⚠ 不是真包解析 ✗。
 *
 * ⚠ 2026-10-13：第一版写成"取整条路径的前两段" ✗ ⇒ 两层路径（`src/a.ts`）会被算成包 `src/a.ts`（**文件名当包名** ✗✗）。
 *   正确口径：**先去掉文件名**，再取目录前两段 ⇒ `src/a.ts` ⇒ `src` ✓、`src/vs/editor/x.ts` ⇒ `src/vs` ✓、`weird.zzz` ⇒ `(根)` ✓。
 */
function packageKeyOf(filePath) {
	const parts = String(filePath ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
	if (!parts.length) { return '(无路径)'; }
	const dirs = parts.slice(0, -1);
	if (!dirs.length) { return '(根)'; }
	return dirs.length === 1 ? dirs[0] : `${dirs[0]}/${dirs[1]}`;
}

/** 层的路径段约定（真源拿"层"当架构维度 ✓，我们只能按段名认 ✓）。 */
const LAYER_BY_SEGMENT = new Map([
	['electron-main', 'electron-main'], ['node', 'node'], ['common', 'common'],
	['browser', 'browser'], ['test', 'test'], ['tests', 'test'],
]);

/** 路径 → 层（认不出归 `(其他)` ✓）。 */
function layerOf(filePath) {
	for (const part of String(filePath ?? '').replace(/\\/g, '/').split('/')) {
		const layer = LAYER_BY_SEGMENT.get(part);
		if (layer) { return layer; }
	}
	return '(其他)';
}

/** 扩展名 → 语言名（**只做保守映射** ✓：认不出就如实用扩展名本身，不猜 ✗）。 */
const LANGUAGE_BY_EXT = {
	ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
	js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
	py: 'Python', java: 'Java', kt: 'Kotlin', go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP',
	cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', c: 'C', h: 'C/C++ 头文件',
	swift: 'Swift', m: 'Objective-C', mm: 'Objective-C++', scala: 'Scala', sh: 'Shell', ps1: 'PowerShell',
	sql: 'SQL', lua: 'Lua', dart: 'Dart', vue: 'Vue', html: 'HTML', css: 'CSS', scss: 'CSS', json: 'JSON', yml: 'YAML', yaml: 'YAML',
};

/** 入口点候选的**文件名规则**（纯 ✓；这是**启发式** ✗ —— 调用方必须在输出里如实标注 ✓）。 */
const ENTRY_FILE_RE = /^(index|main|cli|server|app|bootstrap|entry)\.[a-z0-9]+$/i;

/** 取扩展名（小写 ✓；无扩展名 ⇒ 空串 ✓）。 */
function extOf(path) {
	const base = String(path).replace(/\\/g, '/').split('/').pop() ?? '';
	const at = base.lastIndexOf('.');
	return at > 0 ? base.slice(at + 1).toLowerCase() : '';
}

/**
 * 架构速览（`codebase_architecture` 用；纯 ✓）。
 *
 * ⚠ **诚实边界**（这是本函数最要紧的部分 ✓）：
 *   · `languages` —— 图里**没有** language 字段（契约只有 `filePath` ✓）⇒ 只能**按扩展名统计** ✓，
 *     输出里带 `method` 说明这一点 ✓（"按扩展名" ≠ "语言分析" ✗）；
 *   · `entryPoints` —— **纯启发式**（按文件名 ✓），输出里带 `heuristic: true` ✓；
 *   · `hotspots` / `communities` —— **真事实** ✓（前者用节点里已算好的度数 ✓，后者用索引器写入的
 *     `community` 字段 ✓ —— 我们**不重算**社区 ✗，重算就等于换了一套结论 ✓）；
 *   · `tree` —— **按路径分组** ✓（不是依赖分析 ✓）。
 * 真源还有 `packages / layers / services / routes / crossBoundaries / dependencies / deadCode` ✗ ——
 * 那要索引器的进阶分析 ✓，我们没有 ⇒ **不假装**：payload 里用 `notPorted` 列出来并指路（见 ARCHITECTURE_NOT_PORTED ✓）。
 */
export function architectureOf(graph, { scopePath = '', aspects = ARCHITECTURE_ASPECTS, topLimit = 12 } = {}) {
	const scope = String(scopePath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	const all = graph.nodes;
	const nodes = scope
		? all.filter(node => String(node?.filePath ?? '').replace(/\\/g, '/').startsWith(`${scope}/`)
			|| String(node?.filePath ?? '').replace(/\\/g, '/') === scope)
		: all;
	const ids = new Set(nodes.map(node => node.id));
	const edges = scope ? graph.edges.filter(edge => ids.has(edge.sourceId) && ids.has(edge.targetId)) : graph.edges;
	const wanted = new Set((Array.isArray(aspects) && aspects.length ? aspects : ARCHITECTURE_ASPECTS));
	const cap = Math.max(1, Math.min(50, Math.floor(topLimit) || 12));
	const out = {
		nodes: nodes.length,
		edges: edges.length,
		...(scope ? { scopePath: scope, scoped: true } : {}),
		notPorted: ARCHITECTURE_NOT_PORTED,
		// 2026-10-13（P6）：那 7 个不再是"没有"，而是"**按图近似**" ✓ —— 近似口径写在各自的 `*Method` 字段里 ✓
		// ⚠ 本行是**模板串** ⇒ 里面不能再出现反引号 ✗（2026-10-13 实测：写了 `*Method` ⇒ 模板提前闭合 ⇒
		//   运行时报 "Method is not defined"，而 `node --check` 照样通过 ✗ —— 与插件页 CSS 那个坑同源 ✓）
		notPortedHint: `${ARCHITECTURE_APPROXIMATED.join(' / ')} 这 7 项**已按图近似实现** ✓（路径 / 命名 / 度数层面 ⇒ 每条都带一个 *Method 字段写明口径 ✓，**不等价**于真源那套索引器分析 ✗）。`
			+ '仍未建模的：LSP 跨文件类型推断 · 语义相似 / 克隆 · 运行时 trace 摄入 · 3D 布局 ✗（要 LSP / 语义 / 渲染栈 ✓）。'
			+ '想回答相关问题请用：codebase_deps（谁用了谁 ✓）、codebase_trace（调用链 ✓）、codebase_projects（多根 ✓）、codebase_hotspots（热点 ✓）。',
	};

	if (wanted.has('languages')) {
		const counts = new Map();
		for (const node of nodes) {
			const ext = extOf(node?.filePath ?? '');
			const key = ext ? (LANGUAGE_BY_EXT[ext] ?? `.${ext}`) : '(无扩展名)';
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		out.languages = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, cap)
			.map(([name, count]) => ({ name, count }));
		out.languageCount = counts.size;
		// ⚠ 把"这是怎么算出来的"写在数据里 ✓ —— 不然用法的人会以为我们做了语言分析 ✗
		out.languagesMethod = '按 `filePath` 的扩展名统计（图谱里没有 language 字段 ✓）；认不出的扩展名照原样列出 ✓';
	}
	if (wanted.has('entryPoints')) {
		const files = new Set();
		for (const node of nodes) {
			const path = String(node?.filePath ?? '').replace(/\\/g, '/');
			if (path) { files.add(path); }
		}
		out.entryPoints = [...files]
			.filter(path => ENTRY_FILE_RE.test(path.split('/').pop() ?? '') && path.split('/').length <= 4)
			.sort()
			.slice(0, cap);
		// ⚠ 启发式必须**自报家门** ✓
		out.entryPointsHeuristic = true;
		out.entryPointsMethod = '**启发式**：文件名匹配 index/main/cli/server/app/bootstrap/entry 且路径深度 ≤ 4 ✓（不是真正的入口分析 ✗）';
	}
	if (wanted.has('hotspots')) {
		// 复用现成的 `topNodes` ✓（度数在节点里已经算好 ✓ ⇒ 传子图即可 ✓）
		out.hotspots = topNodes({ nodes, edges: [] }, { by: 'inDegree', limit: cap })
			.map(node => ({ qualifiedName: node.qualifiedName ?? node.name, label: node.label, inDegree: node.inDegree, filePath: node.filePath }));
	}
	if (wanted.has('communities')) {
		const sizes = new Map();
		for (const node of nodes) {
			if (node?.community === undefined || node?.community === null) { continue; }
			const key = String(node.community);
			if (!sizes.has(key)) { sizes.set(key, { size: 0, sample: node.qualifiedName ?? node.name }); }
			const entry = sizes.get(key);
			entry.size += 1;
		}
		out.communities = [...sizes.entries()].sort((a, b) => b[1].size - a[1].size || String(a[0]).localeCompare(String(b[0]))).slice(0, cap)
			.map(([id, entry]) => ({ id, size: entry.size, sample: entry.sample }));
		out.communityCount = sizes.size;
		out.communitiesMethod = '直接用索引器写进节点的 `community` 字段 ✓（**不重算**社区 —— 重算就是换一套结论 ✗）';
	}
	if (wanted.has('tree')) {
		const top = new Map();
		for (const node of nodes) {
			const path = String(node?.filePath ?? '').replace(/\\/g, '/');
			if (!path) { continue; }
			const dir = path.includes('/') ? path.split('/')[0] : '(根)';
			if (!top.has(dir)) { top.set(dir, { dir, files: new Set(), nodes: 0 }); }
			const entry = top.get(dir);
			entry.files.add(path);
			entry.nodes += 1;
		}
		out.tree = [...top.values()].sort((a, b) => b.nodes - a.nodes || a.dir.localeCompare(b.dir)).slice(0, cap)
			.map(entry => ({ dir: entry.dir, files: entry.files.size, nodes: entry.nodes }));
		out.treeMethod = '**按路径首段分组** ✓（不是包/模块分析 ✗）';
	}
	// ── P6（2026-10-13）：真源那 7 个 aspect 的**按图近似**实现 ───────────────────────────────
	// 硬纪律：真源那几条来自**索引器的进阶 pass / LSP / 语义分析** ✗；我们手上只有图（filePath / label / 名字 / 度数 / 边 ✓）
	// ⇒ 能做的是"路径与命名约定"层面的推断 ✓ ⇒ **明说是近似**（每条一个 `*Method` ✓），绝不声称与真源等价 ✗。
	const byIdOfNodes = new Map(nodes.map(node => [node.id, node]));
	const nonSelfPath = (from, to) => from !== to;
	if (wanted.has('packages') || wanted.has('crossBoundaries') || wanted.has('dependencies')) {
		const buckets = new Map();
		for (const node of nodes) {
			const key = packageKeyOf(node?.filePath);
			if (!buckets.has(key)) { buckets.set(key, { name: key, nodes: 0, files: new Set() }); }
			const entry = buckets.get(key);
			entry.nodes += 1;
			const path = String(node?.filePath ?? '').replace(/\\/g, '/');
			if (path) { entry.files.add(path); }
		}
		const packages = [...buckets.values()].sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name));
		const pairEdges = new Map();
		let crossing = 0;
		for (const edge of edges) {
			const from = packageKeyOf(byIdOfNodes.get(edge.sourceId)?.filePath);
			const to = packageKeyOf(byIdOfNodes.get(edge.targetId)?.filePath);
			if (!nonSelfPath(from, to)) { continue; }
			crossing += 1;
			const key = `${from}\u0000${to}`;
			pairEdges.set(key, (pairEdges.get(key) ?? 0) + 1);
		}
		const pairs = [...pairEdges.entries()].map(([key, count]) => {
			const [from, to] = key.split('\u0000');
			return { from, to, edges: count };
		}).sort((a, b) => b.edges - a.edges || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
		if (wanted.has('packages')) {
			out.packages = packages.slice(0, cap).map(entry => ({ name: entry.name, nodes: entry.nodes, files: entry.files.size }));
			out.packageCount = packages.length;
			out.packagesMethod = '按 `filePath` **前两段**分组（路径约定 ✗ —— 不是真包解析；真源用索引器 pass ✓）';
		}
		if (wanted.has('crossBoundaries')) {
			out.crossBoundaries = { total: crossing, top: pairs.slice(0, cap) };
			out.crossBoundariesMethod = '两端落在**不同包**的边计数（包 = 路径前两段 ✓，与 `packages` 同一口径 ✓）';
		}
		if (wanted.has('dependencies')) {
			out.dependencies = pairs.slice(0, cap);
			out.dependenciesMethod = '包级依赖矩阵：把边**按包聚合** ✓（不区分边类型 ✗ —— 要类型明细用 `codebase_deps` 或 `edgeTypes` ✓）';
		}
	}
	if (wanted.has('layers')) {
		const buckets = new Map();
		for (const node of nodes) {
			const layer = layerOf(node?.filePath);
			if (!buckets.has(layer)) { buckets.set(layer, { name: layer, nodes: 0, files: new Set() }); }
			const entry = buckets.get(layer);
			entry.nodes += 1;
			const path = String(node?.filePath ?? '').replace(/\\/g, '/');
			if (path) { entry.files.add(path); }
		}
		const flow = new Map();
		for (const edge of edges) {
			const from = layerOf(byIdOfNodes.get(edge.sourceId)?.filePath);
			const to = layerOf(byIdOfNodes.get(edge.targetId)?.filePath);
			if (!nonSelfPath(from, to)) { continue; }
			const key = `${from}\u0000${to}`;
			flow.set(key, (flow.get(key) ?? 0) + 1);
		}
		out.layers = [...buckets.values()].sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name)).slice(0, cap)
			.map(entry => ({ name: entry.name, nodes: entry.nodes, files: entry.files.size }));
		out.layerFlow = [...flow.entries()].map(([key, count]) => {
			const [from, to] = key.split('\u0000');
			return { from, to, edges: count };
		}).sort((a, b) => b.edges - a.edges || a.from.localeCompare(b.from)).slice(0, cap);
		out.layersMethod = '**按路径段约定**分层（electron-main / node / common / browser / test ✓；认不出归 `(其他)` ✗）+ 层间边的方向计数 ✓ —— 不是语言/架构分析 ✗';
	}
	if (wanted.has('services')) {
		const re = /(service|manager|provider|repository|adapter|gateway|controller)s?$/i;
		const found = nodes
			.filter(node => ['class', 'interface', 'function', 'method'].includes(String(node?.label ?? '')))
			.filter(node => re.test(String(node?.name ?? '')) || (/service/i.test(String(node?.name ?? '')) && /^I[A-Z]/.test(String(node?.name ?? ''))))
			.map(node => ({ name: node.name, label: node.label, filePath: node.filePath, inDegree: node.inDegree }));
		out.services = found.sort((a, b) => (b.inDegree ?? 0) - (a.inDegree ?? 0) || String(a.name).localeCompare(String(b.name))).slice(0, cap);
		out.serviceCount = found.length;
		out.servicesMethod = '**按命名约定**（*Service / *Manager / *Provider / *Repository / *Adapter / *Gateway / *Controller，或 `I*Service` 前缀 ✓）⇒ 启发式 ✗（会漏会误收 ✓；真源用索引器 pass ✓）';
	}
	if (wanted.has('routes')) {
		const re = /(route|router|endpoint|handler|controller|command|contribution|middleware)s?$/i;
		const found = nodes
			// ⚠ 只收"能承载路由/入口的东西"（函数 / 方法 / 类 / 接口 ✓）—— 收 `variable` 会把
			//   `staleOwnRoute` 这类**状态变量**也列进来（真图冒烟实测 3561 条里一堆噪声 ✗）
			.filter(node => ['function', 'method', 'class', 'interface'].includes(String(node?.label ?? '')))
			.filter(node => re.test(String(node?.name ?? '')) || /(\/routes?\/|\/commands?\/|\/controllers?\/)/i.test(String(node?.filePath ?? '')))
			.map(node => ({ name: node.name, label: node.label, filePath: node.filePath, startLine: node.startLine }));
		out.routes = found.sort((a, b) => String(a.filePath).localeCompare(String(b.filePath)) || (a.startLine ?? 0) - (b.startLine ?? 0)).slice(0, cap);
		out.routeCount = found.length;
		out.routesMethod = '**按名字/路径约定**（*Route(s) / *Handler / *Command / *Contribution / *Middleware，或路径含 routes / commands / controllers ✓）⇒ 启发式 ✗ —— '
			+ 'VS Code 的"命令与贡献点"也会被收进来，与 HTTP 路由**不是一回事** ✗（真源另有索引器口径 ✓）';
	}
	if (wanted.has('deadCode')) {
		// ⚠⚠ 2026-10-13 真图冒烟抓到的语义 bug：**只看 `inDegree === 0` 永远等于空** ✗ ——
		//   因为索引器会给每个符号写一条 `file --CONTAINS--> symbol` ⇒ 每个符号的入度 ≥ 1 ✓
		//   ⇒ 必须**排除 CONTAINS**（那条边表达的是"它属于这个文件"，不是"有人用它" ✓）。
		//   排除之后，"没有任何**真实引用**（CALLS / USAGE / INHERITS / IMPORTS_SYMBOL …）指到它"才有意义 ✓。
		const referenced = new Set();
		for (const edge of edges) {
			if (String(edge?.type).toUpperCase() === 'CONTAINS') { continue; }
			referenced.add(edge.targetId);
		}
		const dead = nodes
			.filter(node => !referenced.has(node.id))
			// ⚠ **不收 `method`**：方法常通过 `this.x()` / 属性访问调用，而 CALLS 的 callee 只取**最左标识符**
			//   （与真源同口径 ✓）⇒ 方法会大面积假阳性（真图冒烟实测：含 method 时 27338 条，占节点 14% ✗ 太误导）。
			//   宁可少报、把口径说清 ✓ —— 要判某个方法有没有人用，用 `codebase_deps` 看它的入边 ✓。
			.filter(node => ['function', 'class', 'interface'].includes(String(node?.label ?? '')))
			.filter(node => !ENTRY_FILE_RE.test(String(node?.filePath ?? '').replace(/\\/g, '/').split('/').pop() ?? ''))
			.filter(node => !/(^|\/)tests?\//i.test(String(node?.filePath ?? '').replace(/\\/g, '/')) && !/\.(test|spec)\./i.test(String(node?.filePath ?? '')))
			.map(node => ({ name: node.name, label: node.label, filePath: node.filePath, startLine: node.startLine }));
		out.deadCode = dead.sort((a, b) => String(a.filePath).localeCompare(String(b.filePath)) || (a.startLine ?? 0) - (b.startLine ?? 0)).slice(0, cap);
		// ⚠ 只给一个总数会误导（真图实测 2.7 万条 ✗）⇒ 一定要给"它们**聚在哪**"：
		//   按包（路径前两段 ✓）分布 top 8 —— 用户据此能一眼看出"是主仓的公共 API，还是某个角落的脚本" ✓
		{
			const byPackage = new Map();
			for (const entry of dead) {
				const key = packageKeyOf(entry.filePath);
				byPackage.set(key, (byPackage.get(key) ?? 0) + 1);
			}
			out.deadCodeByPackage = [...byPackage.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8)
				.map(([name, count]) => ({ name, count }));
		}
		out.deadCodeCount = dead.length;
		out.deadCodeHeuristic = true;
		out.deadCodeMethod = '**排除 `CONTAINS` 之后、没有任何入边**（不收 `method` ✓、排除入口文件名与 test/ 路径 ✓）⇒ "图内**没有被真实引用**的函数/类/接口" ✗ —— '
			+ '**不等于死代码**（可能被动态引用 / 反射 / 外部消费者 / 导出的公共 API 用到 ✓；图没覆盖的语言也不会出现在这里 ✓）。'
			+ '⚠ **本仓实测：2.7 万条里 2.6 万条都在 `src/vs`** ⇒ 那是"图没覆盖到的调用形态"（TS 里大量调用是 `obj.method()`，而 CALLS 的 callee 只取最左标识符 ✓）'
			+ '⇒ **不要拿它当结论** ✗：请先看 `deadCodeByPackage` 的聚集位置，再用 `codebase_deps` 逐个确认 ✓。要判影响面用 `codebase_deps` / `codebase_changes` ✓。';
	}
	return out;
}

/**
 * 建**邻接索引**（`traceFrom` 与 `impactOf` 共用；纯 ✓）。
 *
 * 做成共用不是为了少写几行，而是因为这两个工具问的是**同一件事**（"沿着调用边还能走到谁" ✓）——
 * 各写一份 BFS 迟早会在"去自环 / 去重边 / 边类型缺失"这些**细节**上分叉 ✗，而分叉出来的差异
 * 恰恰最难发现（两个工具对同一张图给出不同答案 ✓）。
 * @returns `{ out, inn, used, available }`；`used` 为空 ⇒ 调用方应抛"边类型不存在并列可用"（见 `traceFrom` ✓）
 */
export function indexAdjacency(graph, edgeTypes) {
	const available = new Set(graph.edges.map(edge => String(edge?.type)));
	const wanted = (Array.isArray(edgeTypes) ? edgeTypes : []).map(type => String(type)).filter(Boolean);
	const used = wanted.filter(type => available.has(type));
	const out = new Map();
	const inn = new Map();
	if (!used.length) { return { out, inn, used, available }; }
	const usedSet = new Set(used);
	for (const edge of graph.edges) {
		if (!usedSet.has(String(edge?.type))) { continue; }
		// 自环（真图里有 `console → console` ✓）：**visited 其实已经挡得住** ✓ ⇒ 这行是**显式表达意图** ✓
		//（不写它结果一样 ✓；写它是因为以后有人改 visited 逻辑时，自环不该悄悄混进来 ✓ —— 但我**不**声称
		// 它"省了深度预算"✗：那话在带 visited 的 BFS 里不成立 ✓，注释也得说实话 ✓）。
		if (edge?.sourceId === edge?.targetId) { continue; }
		if (!out.has(edge.sourceId)) { out.set(edge.sourceId, new Set()); }
		out.get(edge.sourceId).add(edge.targetId);
		if (!inn.has(edge.targetId)) { inn.set(edge.targetId, new Set()); }
		inn.get(edge.targetId).add(edge.sourceId);
	}
	return { out, inn, used, available };
}

/**
 * **影响面**：一批种子节点（比如"这次改动碰到的符号" ✓）沿 `CALLS` **反向**走 N 跳 ⇒ 谁会受影响 ✓（纯 ✓）。
 *
 * ⚠ 方向语义**必须说死**（真源用 "downstream impact propagation" ✗ —— 那个词读起来像"往下走"，
 * 但对"我改了 X，谁会被波及"这个问题，**正确答案是往上找调用者** ✓）：本函数固定走 `callers` ✓。
 * @returns `{ reached, total, seeds, truncated }`（`reached` 里带 `viaSeed` ⇒ 能说清"是被哪个改动波及的" ✓）
 */
export function impactOf(graph, seedIds, { edgeTypes = ['CALLS'], depth = 5, maxNodes = 300 } = {}) {
	const { inn, used, available } = indexAdjacency(graph, edgeTypes);
	const byId = new Map(graph.nodes.map(node => [node.id, node]));
	const seeds = [...new Set(seedIds)];
	const seedSet = new Set(seeds);
	const maxD = Math.max(1, Math.min(20, Math.floor(depth) || 5));
	const cap = Math.max(1, Math.min(2000, Math.floor(maxNodes) || 300));
	const reached = [];
	const seen = new Set(seeds);
	let truncated = false;
	let frontier = seeds.map(id => ({ id, depth: 0, viaSeed: id }));
	for (let level = 1; level <= maxD && frontier.length; level += 1) {
		const next = [];
		for (const cursor of frontier) {
			for (const caller of inn.get(cursor.id) ?? []) {
				if (seen.has(caller)) { continue; }
				seen.add(caller);
				const hop = { id: caller, depth: level, viaSeed: cursor.viaSeed, root: seedSet.has(caller) };
				reached.push(hop);
				next.push(hop);
				if (reached.length >= cap) { truncated = true; break; }
			}
			if (truncated) { break; }
		}
		if (truncated) { break; }
		frontier = next;
	}
	return {
		used,
		available: [...available],
		total: reached.length,
		truncated,
		reached: reached.map(hop => ({
			id: hop.id,
			depth: hop.depth,
			viaSeed: hop.viaSeed,
			label: byId.get(hop.id)?.label,
			name: byId.get(hop.id)?.name,
			qualifiedName: byId.get(hop.id)?.qualifiedName,
			filePath: byId.get(hop.id)?.filePath,
			startLine: byId.get(hop.id)?.startLine,
		})),
	};
}

/** git ref 的安全校验（纯 ✓）：**只放行保守字符集**，且**不许以 `-` 开头** ✗。 */
export function isSafeGitRef(value) {
	const ref = String(value ?? '').trim();
	if (!ref || ref.length > 120) { return false; }
	if (ref.startsWith('-')) { return false; }   // `-` 开头会被 git 当**选项**解析（参数注入的经典入口 ✗）
	return /^[A-Za-z0-9._/~^@{}+-]+$/.test(ref);
}

/** 解析 `git diff --name-only` / `ls-files --others` 的输出（纯 ✓：CRLF、空行、重复都处理 ✓，统一成 `/`）。 */
export function parseGitPaths(text) {
	const out = [];
	const seen = new Set();
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const path = raw.trim().replace(/\\/g, '/');
		if (!path || seen.has(path)) { continue; }
		seen.add(path);
		out.push(path);
	}
	return out;
}

/** 归一化 `scope`（纯 ✓）：相对路径、去前导 `./` ✓；绝对路径 / `..` ⇒ `undefined`（调用方明说拒绝 ✓）。 */
export function normalizeScope(value) {
	const raw = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
	if (!raw) { return ''; }
	if (raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw) || raw.split('/').some(seg => seg === '..')) { return undefined; }
	return raw;
}

/**
 * 把"变更文件"落到**图里的节点**（纯 ✓，只做**精确** `filePath` 匹配 ✓）。
 * 匹配不上的文件**单独列出来** ✗→✓：那说明"图比工作区旧"或"这个文件没被索引" ✓ ——
 * 悄悄丢掉会让影响面**凭空变小**（看起来"影响很小"，其实是我们没看见 ✗）。
 */
export function mapFilesToNodes(graph, files) {
	const byPath = new Map();
	for (const node of graph.nodes) {
		const path = typeof node?.filePath === 'string' ? node.filePath.replace(/\\/g, '/') : '';
		if (!path) { continue; }
		if (!byPath.has(path)) { byPath.set(path, []); }
		byPath.get(path).push(node);
	}
	const hit = [];
	const missed = [];
	for (const file of files) {
		const nodes = byPath.get(file) ?? [];
		if (!nodes.length) { missed.push(file); continue; }
		hit.push({
			filePath: file,
			nodeCount: nodes.length,
			// `nodeIds` 是给**影响面**用的（`impactOf` 要拿它们当种子 ✓）；`symbols` 只是给人/模型看的摘要 ✓。
			nodeIds: nodes.map(node => node.id),
			symbols: nodes.filter(node => node.label !== 'file').slice(0, 8).map(node => node.qualifiedName ?? node.name),
		});
	}
	return { hit, missed };
}

/**
 * 沿**指定边类型**做双向 BFS（`codebase_trace` 用；纯 ✓）。
 *
 * 真源：IDE `codebaseTools.ts` 的 `trace_path` ✓（它还有 `mode: data_flow / cross_service`、
 * `riskLabels`、`toon` 输出等 ✗）。**我们只做 `calls` 那一半** ✓，理由不是省事，而是**证据**：
 * 2026-10-12 前提取证（本仓真图 189,302 节点 / 489,145 边）里**只有** `CONTAINS` / `CALLS` / `USAGE`
 * 三种边 ✓ ⇒ `DATA_FLOWS` / `HTTP_CALLS` 那些**图里根本没有** ✗ ⇒ 承诺它们就是**编** ✓。
 *
 * 三条**从真实数据里学到的**细节：
 *   ① **去掉自环** ✓（真图里有 `console → console` 这种 ⇒ 白占深度预算 ✓）；
 *   ② **同一对只走一次** ✓（用 Set 去重，否则重复边会把 BFS 撑成扇出 ✗）；
 *   ③ `edgeTypes` 里写了图里**没有**的类型 ⇒ **明确报错并列出可用类型** ✓（不静默降级成"啥也没找到"✗）。
 * @returns `{ start, hops, used, available, truncated, notFound }` | `{ error }` | `{ candidates }`
 */
export function traceFrom(graph, {
	sourceQuery = '', targetQuery = '', edgeTypes = ['CALLS'], direction = 'both', maxDepth = 10, maxNodes = 200,
} = {}) {
	const picked = resolveSymbol(graph, { qualifiedName: sourceQuery });
	if (picked.error) { return { error: picked.error }; }
	if (picked.candidates) { return { candidates: picked.candidates }; }
	const start = picked.node;

	// 邻接索引**与 `impactOf` 共用** ✓（同一张图、同一套"去自环/去重/边类型缺失"细节 ⇒ 不许分叉 ✗）
	const { out, inn, used, available } = indexAdjacency(graph, edgeTypes);
	if (!used.length) {
		const wanted = (Array.isArray(edgeTypes) ? edgeTypes : []).map(type => String(type)).filter(Boolean);
		return { error: `图里没有这些边类型：${wanted.join(', ') || '(空)'} ⇒ 这个图里**实际可用**的是：${[...available].join(', ') || '(一个都没有)'} ✓（别猜边类型 ✗）` };
	}
	const byId = new Map(graph.nodes.map(node => [node.id, node]));
	const describe = (id, depth, dir, via) => ({
		id, depth, direction: dir, via,
		label: byId.get(id)?.label,
		name: byId.get(id)?.name,
		qualifiedName: byId.get(id)?.qualifiedName,
		filePath: byId.get(id)?.filePath,
		startLine: byId.get(id)?.startLine,
	});
	const hops = [describe(start.id, 0, 'start', null)];
	const maxD = Math.max(1, Math.min(30, Math.floor(maxDepth) || 10));
	const cap = Math.max(1, Math.min(2000, Math.floor(maxNodes) || 200));
	const dirs = direction === 'callers' ? ['callers'] : direction === 'callees' ? ['callees'] : ['callees', 'callers'];
	let truncated = false;
	for (const dir of dirs) {
		const adj = dir === 'callees' ? out : inn;
		const seen = new Set([start.id]);   // 每个方向一份 visited ✓（合成一份会把"既被它调、又调它"的节点漏掉 ✗）
		let frontier = [start.id];
		for (let depth = 1; depth <= maxD && frontier.length; depth += 1) {
			const next = [];
			for (const id of frontier) {
				for (const other of adj.get(id) ?? []) {
					if (seen.has(other)) { continue; }
					seen.add(other);
					hops.push(describe(other, depth, dir, id));
					next.push(other);
					if (hops.length >= cap) { truncated = true; break; }
				}
				if (truncated) { break; }
			}
			if (truncated) { break; }
			frontier = next;
		}
		if (truncated) { break; }
	}
	const wantedTarget = String(targetQuery ?? '').trim().toLowerCase();
	// ⚠ 目标匹配**先按 `name`** ✓，只有查询本身**像限定名**（含 `::` 或 `/`）才去比 qualifiedName ✓。
	//   为什么：拿 qualifiedName 做子串会把**路径前缀**也算命中 ✗ —— 实测目标 `c` 命中了 `src/a.js::a`
	//   （"**src**" 里就有一个 `c` ✓），于是返回了**错误的"最短链"** ✓（这种"看起来答了、其实答的是别人"
	//   正是本模块最想避免的一类错 ✓）。
	const targetIsQualified = wantedTarget.includes('::') || wantedTarget.includes('/');
	const hit = wantedTarget
		? hops.find(hop => {
			const name = String(hop.name ?? '').toLowerCase();
			const qualified = String(hop.qualifiedName ?? '').toLowerCase();
			return name.includes(wantedTarget) || (targetIsQualified && qualified.includes(wantedTarget));
		})
		: undefined;
	return {
		start: hops[0],
		hops,
		used,
		available: [...available],
		truncated,
		...(hit ? { target: hit.qualifiedName ?? hit.name, path: pathOf(hops, hit) } : {}),
		...(wantedTarget && !hit ? { targetMissing: true } : {}),
	};
}

/** 沿 `via` 回溯出到某个 hop 的那条链（BFS ⇒ 是最短的 ✓）。 */
export function pathOf(hops, hop) {
	const chain = [];
	let cursor = hop;
	while (cursor) {
		chain.unshift(cursor.qualifiedName ?? cursor.name ?? String(cursor.id));
		cursor = cursor.via === null || cursor.via === undefined
			? null
			: hops.find(candidate => candidate.id === cursor.via && candidate.depth === cursor.depth - 1);
	}
	return chain;
}

/**
 * 图谱的**结构目录**（`codebase_schema` 用；纯 ✓）。
 *
 * ⚠ 与 `summarizeGraph` 的**关键区别**：那个给页面用，`labels`/`edgeTypes` 各**截到 top 12** ✗；
 * 这里给**模型**用 ⇒ 必须① 给出**全量去重后的条数**（`labelsTotal` ✓）、② 截断时**明确标 `truncated`** ✓。
 * 拿截断结果当全量说，正是"看起来齐全、其实漏了"那类错 ✗。
 * @returns `{ nodes, edges, files, communities, labels, edgeTypes, labelsTotal, edgeTypesTotal, truncated }`
 */
export function graphSchemaOf(graph, { limit = 40 } = {}) {
	const labels = new Map();
	for (const node of graph.nodes) {
		const key = typeof node?.label === 'string' ? node.label : '(未声明 label)';
		labels.set(key, (labels.get(key) ?? 0) + 1);
	}
	const edgeTypes = new Map();
	for (const edge of graph.edges) {
		const key = typeof edge?.type === 'string' ? edge.type : '(未声明 type)';
		edgeTypes.set(key, (edgeTypes.get(key) ?? 0) + 1);
	}
	const files = new Set();
	const communities = new Set();
	for (const node of graph.nodes) {
		if (typeof node?.filePath === 'string' && node.filePath) { files.add(node.filePath); }
		if (node?.community !== undefined && node?.community !== null) { communities.add(node.community); }
	}
	const cap = Math.max(1, Math.floor(limit) || 40);
	const listOf = map => [...map.entries()]
		.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
		.slice(0, cap)
		.map(([name, count]) => ({ name, count }));
	return {
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		files: files.size,
		communities: communities.size,
		labels: listOf(labels),
		edgeTypes: listOf(edgeTypes),
		labelsTotal: labels.size,
		edgeTypesTotal: edgeTypes.size,
		truncated: labels.size > cap || edgeTypes.size > cap,
	};
}

/**
 * 图谱里有哪些**项目**（`codebase_projects` 用；纯 ✓）。
 *
 * 为什么需要它：本模块支持 `config.relatedRoots`（一张图可能覆盖**多个**根 ✓，见 README 4.87/4.88），
 * 模型得先知道"这张图里有哪几个项目"才能把检索收敛到对的那个 ✓。
 * 边的归属：优先用边自己的 `project` ✓，否则用**源节点**的项目 ✓，再不行标"(未知)" ✓（不猜 ✗）。
 */
export function projectsOf(graph) {
	const projectOfNode = new Map();
	const stats = new Map();
	const touch = name => {
		const key = typeof name === 'string' && name.trim() ? name.trim() : '(未声明 project)';
		if (!stats.has(key)) { stats.set(key, { project: key, nodes: 0, edges: 0, files: new Set(), labels: new Map() }); }
		return stats.get(key);
	};
	for (const node of graph.nodes) {
		const entry = touch(node?.project);
		entry.nodes += 1;
		if (typeof node?.id !== 'undefined') { projectOfNode.set(node.id, node?.project); }
		if (typeof node?.filePath === 'string' && node.filePath) { entry.files.add(node.filePath); }
		const label = typeof node?.label === 'string' ? node.label : '(未声明 label)';
		entry.labels.set(label, (entry.labels.get(label) ?? 0) + 1);
	}
	for (const edge of graph.edges) {
		const own = typeof edge?.project === 'string' && edge.project.trim() ? edge.project : projectOfNode.get(edge?.sourceId);
		touch(own).edges += 1;
	}
	return [...stats.values()]
		.map(entry => ({
			project: entry.project,
			nodes: entry.nodes,
			edges: entry.edges,
			files: entry.files.size,
			topLabels: [...entry.labels.entries()]
				.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
				.slice(0, 5)
				.map(([name, count]) => ({ name, count })),
		}))
		.sort((a, b) => b.nodes - a.nodes || a.project.localeCompare(b.project));
}

/**
 * 按名字/文件检索节点。
 * 稳定性：同输入同输出（分数 → 入度 → id），保证反复调用不会抖动（护 KV cache 的同一条道理）。
 * @param options.query 名字片段（大小写不敏感）
 * @param options.label 限定节点类型
 * @param options.filePath 限定文件路径片段
 */
export function searchNodes(graph, { query = '', label = '', filePath = '', limit = 20 } = {}) {
	const q = String(query ?? '').trim().toLowerCase();
	const wantedLabel = String(label ?? '').trim().toLowerCase();
	const wantedFile = String(filePath ?? '').trim().toLowerCase();
	const scored = [];
	for (const node of graph.nodes) {
		if (!node || typeof node.name !== 'string') {
			continue;
		}
		if (wantedLabel && String(node.label ?? '').toLowerCase() !== wantedLabel) {
			continue;
		}
		if (wantedFile && !String(node.filePath ?? '').toLowerCase().includes(wantedFile)) {
			continue;
		}
		const name = node.name.toLowerCase();
		const qualified = String(node.qualifiedName ?? '').toLowerCase();
		let score = 0;
		if (q) {
			if (name === q) {
				score += 200;
			} else if (name.startsWith(q)) {
				score += 120;
			} else if (name.includes(q)) {
				score += 60;
			} else if (qualified.includes(q)) {
				score += 30;
			} else {
				continue;
			}
		}
		scored.push({ node, score });
	}
	scored.sort((a, b) => (b.score - a.score)
		|| ((b.node.inDegree ?? 0) - (a.node.inDegree ?? 0))
		|| ((a.node.id ?? 0) - (b.node.id ?? 0)));
	const capped = Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
	return scored.slice(0, capped).map(entry => entry.node);
}

/**
 * 在图上**定位一个符号**（`codebase_snippet` 用；纯函数 ✓，不碰盘 ✓）。
 *
 * 匹配按**从精确到宽松**四级，且**歧义就如实列候选、绝不猜** ✗（猜错会把"另一个符号的源码"当答案给模型 ✓
 * —— 这种错最贵：模型会拿它当事实 ✓）：
 *   ① `qualifiedName` 全等 ✓（真源图谱的形状：文件节点 = 相对路径 ✓、符号节点 = `路径::名字` ✓）；
 *   ② `qualifiedName` **后缀** `::<名字>` 全等 ✓（模型常只给 `Name` 或 `Class::method` ✓）；
 *   ③ `name` 全等 ✓；
 *   ④ `name` 子串（仅当**唯一**命中时才接受 ✓ —— 多个就报候选 ✓）。
 * @returns `{ node }` | `{ candidates }` | `{ error }`
 */
export function resolveSymbol(graph, { qualifiedName = '' } = {}) {
	const wanted = String(qualifiedName ?? '').trim();
	if (!wanted) { return { error: '需要 qualifiedName（例如 `src/foo.ts::bar`，也可以只给 `bar` 或 `Foo::bar`）✗' }; }
	const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const byQualified = nodes.filter(node => node?.qualifiedName === wanted);
	if (byQualified.length === 1) { return { node: byQualified[0] }; }
	const suffix = `::${wanted.split('::').pop()}`;
	const byLeaf = nodes.filter(node => typeof node?.qualifiedName === 'string'
		&& node.qualifiedName.endsWith(suffix)
		&& (wanted.includes('::') ? node.qualifiedName.includes(wanted) : true));
	if (byLeaf.length === 1) { return { node: byLeaf[0] }; }
	const byName = nodes.filter(node => node?.name === wanted);
	if (byName.length === 1) { return { node: byName[0] }; }
	const loose = nodes.filter(node => typeof node?.name === 'string' && node.name.includes(wanted));
	if (loose.length === 1) { return { node: loose[0] }; }
	const pool = (byQualified.length ? byQualified : byLeaf.length ? byLeaf : byName.length ? byName : loose);
	if (!pool.length) { return { error: `图谱里没有匹配「${wanted}」的符号（先用 codebase_search 按名字找 ✓；不要猜它的位置 ✗）` }; }
	return { candidates: pool.slice(0, 10).map(node => node.qualifiedName ?? node.name) };
}

/**
 * 从**整份文件文本**里切出符号所在的那一段（纯函数 ✓，纯按行号 ✓）。
 * `endLine` 缺失 / 等于 `startLine`（我们的自建图就是逐行 ✓）时，只给"这一行 + 前后各 contextLines 行" ✓
 * —— **如实标注** `endLineKnown: false` ✓，别让调用方以为那是整个函数体的边界 ✗。
 * @returns `{ lines: Array<{ n: number, text: string }>, from, to, truncated, endLineKnown }`
 */
export function sliceLines(text, { startLine = 1, endLine = 0, contextLines = 3, maxLines = 400 } = {}) {
	const all = String(text ?? '').split(/\r?\n/);
	const start = Math.max(1, Math.floor(startLine) || 1);
	const context = Math.max(0, Math.min(200, Math.floor(contextLines) || 0));
	const endDeclared = Math.floor(endLine) || 0;
	const endLineKnown = endDeclared > start;
	const end = Math.min(all.length, endLineKnown ? endDeclared : start);
	const from = Math.max(1, start - context);
	const to = Math.min(all.length, end + context);
	const wanted = to - from + 1;
	const limit = Math.max(1, Math.floor(maxLines) || 400);
	const clipped = Math.min(to, from + limit - 1);
	const lines = [];
	for (let n = from; n <= clipped; n += 1) { lines.push({ n, text: all[n - 1] ?? '' }); }
	return { lines, from, to: clipped, truncated: clipped < to || wanted > limit, endLineKnown };
}

/** 入度/出度最高的节点（"从哪开始读"的入口）。 */
export function topNodes(graph, { by = 'inDegree', label = '', limit = 20 } = {}) {
	const wanted = String(label ?? '').trim().toLowerCase();
	const key = by === 'outDegree' ? 'outDegree' : 'inDegree';
	const picked = graph.nodes
		.filter(node => node && (!wanted || String(node.label ?? '').toLowerCase() === wanted))
		.map(node => ({ node, degree: typeof node[key] === 'number' ? node[key] : 0 }))
		.sort((a, b) => b.degree - a.degree || ((a.node.id ?? 0) - (b.node.id ?? 0)));
	const capped = Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
	return picked.slice(0, capped).map(entry => ({ ...entry.node, degree: entry.degree }));
}

/**
 * 一个节点（或一个文件里的全部节点）的依赖：出边（它用了什么）与入边（谁用了它）。
 * 只算**两端都存在**的边；指不到的边计入 `dangling`（不静默丢数据）。
 */
export function dependenciesOf(graph, { nodeId, filePath, limit = 50 } = {}) {
	const byId = new Map();
	for (const node of graph.nodes) {
		byId.set(node.id, node);
	}
	let targets;
	if (nodeId !== undefined) {
		const node = byId.get(nodeId);
		if (!node) {
			return { error: `图里没有 id=${nodeId} 的节点` };
		}
		targets = [node];
	} else if (filePath) {
		targets = graph.nodes.filter(node => node?.filePath === filePath);
		if (!targets.length) {
			return { error: `图里没有 filePath=${filePath} 的节点` };
		}
	} else {
		return { error: '需要 nodeId 或 filePath' };
	}
	const ids = new Set(targets.map(node => node.id));
	const out = [];
	const inEdges = [];
	let dangling = 0;
	for (const edge of graph.edges) {
		if (!edge) {
			continue;
		}
		const from = byId.get(edge.sourceId);
		const to = byId.get(edge.targetId);
		if (!from || !to) {
			if (ids.has(edge.sourceId) || ids.has(edge.targetId)) {
				dangling++;
			}
			continue;
		}
		if (ids.has(edge.sourceId)) {
			out.push({ type: edge.type, node: to });
		}
		if (ids.has(edge.targetId)) {
			inEdges.push({ type: edge.type, node: from });
		}
	}
	const simplify = entries => entries
		.slice(0, limit)
		.map(entry => ({ type: entry.type, name: entry.node.name, label: entry.node.label, filePath: entry.node.filePath, id: entry.node.id }));
	return {
		targets: targets.map(node => ({ id: node.id, name: node.name, label: node.label, filePath: node.filePath, inDegree: node.inDegree, outDegree: node.outDegree })),
		uses: simplify(out),
		usedBy: simplify(inEdges),
		usesTotal: out.length,
		usedByTotal: inEdges.length,
		dangling,
	};
}
