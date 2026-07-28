/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.searchResultParse.ts — 搜索工具结果解析纯函数（独立于 DOM，便于单测）。
 *
 *  负责将搜索工具（search_code / search_files / search_graph 等）返回的原始文本/JSON
 *  解析为统一的「文件名 + 行号」列表，并过滤掉不能作为文件路径渲染的脏数据
 *  （grep 内容行、日志行、表格行、摘要行等），避免点击时报 "file not found"。
 *--------------------------------------------------------------------------------------------*/

export function basenameOf(s: string): string {
	const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
	return parts[parts.length - 1] || s;
}

export function extToTypeOf(fn: string): string {
	const dot = fn.lastIndexOf('.');
	if (dot < 0) { return 'default'; }
	const e = fn.slice(dot + 1).toLowerCase();
	const map: Record<string, string> = {
		js:'js',jsx:'js',mjs:'js',cjs:'js',
		ts:'ts',tsx:'ts',mts:'ts',cts:'ts',
		py:'py',pyi:'py',
		go:'go',rs:'rust',html:'html',htm:'html',
		css:'css',scss:'css',less:'css',
		md:'md',mdx:'md',json:'json',yaml:'yml',yml:'yaml',
	};
	return map[e] || 'default';
}

export function splitGrepPath(raw: string): { path: string; line?: number } {
	if (!raw) { return { path: raw }; }
	const m = /^(.*?\.(?:tsx?|jsx?|mjs|cjs|py[3w]?|rb|php|go|rs|java|kt|swift|scala|cs|cpp|cxx|h|hpp|vue|svelte|astro|prisma|md|mdx|css|scss|less|html?|json|ya?ml|toml|xml|svg|png|jpe?g|gif|webp|bmp|ico|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|env|config|ini|cfg|lock|txt|log|tf|tfvars|proto|sqlx|dart|lua|r|jl|nim|zig))(?:[:#](\d+))?/i.exec(raw);
	if (m && m[2]) {
		return { path: m[1], line: parseInt(m[2], 10) };
	}
	return { path: raw };
}

/** 校验提取出的路径是否像真实文件路径（过滤 grep 内容行 / 日志行 / 表格行等） */
export function isValidFilePath(raw: string, extracted: string): boolean {
	// 提取结果与原始输入几乎一样长 → 说明正则没真正截取到文件名，是整行回退
	if (extracted.length > 0 && raw.length > 0 && extracted.length >= raw.length * 0.8) {
		// 回退路径必须看起来像纯文件名/路径（不含典型内容行特征）
		const suspicious = /[|]|--|\([^)]*ms[^)]*\)|（[^）]*）/;
		if (suspicious.test(extracted)) { return false; }
	}
	// 路径含引号包裹、管道符、中文括号注释等 → 不是文件路径
	if (/['"|].{0,20}['"]/.test(raw) || /\|.{1,40}\|/.test(raw)) { return false; }
	// 路径长度异常（>300 字符）→ 大概率不是文件路径
	if (extracted.length > 300) { return false; }
	return true;
}

// 摘要行：如 "[共 11 个文件]" / "[共 42 条匹配]" / "[共 5 条]" 等
const _SUMMARY_RE = /^\[共\s*\d+[^\]]*\]$/;

// densified 格式匹配行特征：缩进（2+ 空格）+ 数字 + : 或 - + 内容
const _MATCH_LINE_RE = /^\s{2,}(\d+)[:-]\s/;

// 纯文本 "无结果" 行
const _NO_RESULT_RE = /^\(no (matches|matching files|results)\)$/i;

// TOON 格式头行标识（search_graph / trace_path 等图谱工具输出）
const _TOON_HEADER_RE = /^TOON\s+(search_graph|trace_path):\s/;

/**
 * 解析 TOON 格式（pipe 分隔表格）的图谱搜索结果。
 *
 * 格式示例：
 *   TOON search_graph: total=22 returned=10 hasMore=true
 *   #|type|qn|loc|in|out
 *   1|function|GC::ProcessAsync|f:/path/to/file.cpp:123|3|1
 *
 * 从 "loc" 列提取文件路径与行号，"qn" 列作为显示名。
 * 不支持 TOON 格式时返回 null，调用方应回退到其它解析路径。
 */
function tryParseToonText(text: string, key: string): SearchResultItem[] | null {
	if (!text || !_TOON_HEADER_RE.test(text)) { return null; }

	const lines = text.split('\n');
	const out: SearchResultItem[] = [];

	// 跳过 TOON 头行，找到 pipe 分隔的表格头行，确定 loc 列索引
	let locIdx = -1;
	let headerFound = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) { continue; }
		if (_TOON_HEADER_RE.test(line)) { continue; }

		const cols = line.split('|');
		if (cols.length < 4) { continue; }

		if (!headerFound) {
			// 第一行非 TOON 头、有足够列数的 pipe 行 = 表头
			const idx = cols.findIndex((c) => c === 'loc');
			if (idx < 0) { return null; } // 没有 loc 列 → 不是可解析的 TOON
			locIdx = idx;
			headerFound = true;
			continue;
		}

		// 数据行
		if (locIdx >= cols.length) { continue; }
		const loc = cols[locIdx].trim();
		if (!loc || loc === '-') { continue; }

		// "loc" = path:line 格式
		const sp = splitGrepPath(loc);
		const qn = cols.length > 2 ? cols[2].trim() : '';

		out.push({
			name: qn || basenameOf(sp.path),
			path: sp.path || loc,
			lineStart: sp.line,
			type: sp.path ? extToTypeOf(sp.path) : 'default',
		});
	}

	return out.length > 0 ? out : null;
}

// ── TOON → 结构化数据（供 search_graph / trace_path 卡片渲染）──

export interface ToonGraphNode {
	rank: number;
	name: string;
	type: string;
	filePath: string;
	startLine: number;
	score?: number;
	inDegree?: number;
	outDegree?: number;
	summary?: string;
}

export interface ToonSemanticNode {
	rank: number;
	name: string;
	type: string;
	filePath: string;
	startLine: number;
	score?: number;
	relevance?: string;
}

export interface ToonGraphData {
	total: number;
	returned: number;
	hasMore: boolean;
	nodes: ToonGraphNode[];
	scores?: Record<string, number>;
	semanticResults?: ToonSemanticNode[];
}

export interface ToonTraceHop {
	depth: number;
	name: string;
	type: string;
	filePath: string;
	startLine: number;
	edgeType?: string;
	risk?: string;
	score?: number;
}

export interface ToonTraceData {
	found: boolean;
	hops: number;
	depth: number;
	hasCycle: boolean;
	from: string;
	to: string;
	hopList: ToonTraceHop[];
}

/** 从 TOON header 行提取键值对。 */
function _parseToonMeta(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.replace(/^TOON\s+\w+:\s*/, '').split(/\s+/)) {
		const eq = part.indexOf('=');
		if (eq > 0) { out[part.slice(0, eq)] = part.slice(eq + 1); }
	}
	return out;
}

/** 从 TOON 行解析指定列。cols 已按 | 分割。 */
function _col(cols: string[], idx: number): string {
	return idx >= 0 && idx < cols.length ? cols[idx].trim() : '';
}

/** 解析 loc 列 (path:line) → [path, line]。 */
function _parseLoc(loc: string): [string, number] {
	const sp = splitGrepPath(loc);
	return [sp.path || loc, sp.line ?? 0];
}

/**
 * 解析 search_graph TOON → 结构化数据。
 * 支持带 summary 和不带 summary 两种变体；带 semantic_results 附加区块。
 */
export function parseToonGraphData(text: string): ToonGraphData | null {
	if (!text || !_TOON_HEADER_RE.test(text)) { return null; }
	const headerMatch = text.match(_TOON_HEADER_RE);
	if (!headerMatch || headerMatch[1] !== 'search_graph') { return null; }

	const meta = _parseToonMeta(text.split('\n')[0]);
	const total = parseInt(meta['total'] || '0', 10);
	const returned = parseInt(meta['returned'] || '0', 10);
	const hasMore = meta['hasMore'] === 'true';

	const lines = text.split('\n');
	const nodes: ToonGraphNode[] = [];
	let semanticResults: ToonSemanticNode[] | undefined;
	let scores: Record<string, number> | undefined;

	let inSem = false;
	let semHeader: string[] | null = null;
	let nodeIdx = 0;
	let semIdx = 0;

	for (const rawLine of lines.slice(1)) {
		const line = rawLine.trim();
		if (!line) { continue; }

		// Semantic results 区块标记
		if (line.startsWith('semantic_results:') || line.startsWith('TOON semantic_results:')) {
			inSem = true;
			semanticResults = [];
			continue;
		}

		const cols = line.split('|');
		if (cols.length < 3) { continue; }

		if (!inSem) {
			// 主节点表头（跳过，只解析数据行）
			if (cols[0] === '#') { continue; }

			// 数据行
			const rank = parseInt(cols[0], 10);
			if (isNaN(rank)) { continue; }
			const name = _col(cols, 2);
			const type = _col(cols, 1);
			const loc = _col(cols, 3);
			if (!loc || loc === '-') { continue; }
			const [filePath, startLine] = _parseLoc(loc);

			const node: ToonGraphNode = { rank, name, type, filePath, startLine };
			// in/out degree 列
			const inDeg = parseInt(_col(cols, 4), 10);
			const outDeg = parseInt(_col(cols, 5), 10);
			if (!isNaN(inDeg)) { node.inDegree = inDeg; }
			if (!isNaN(outDeg)) { node.outDegree = outDeg; }
			// summary 列（如果有第 7 列且不是数字）
			if (cols.length > 6 && isNaN(Number(cols[6]))) {
				node.summary = cols.slice(6).join('|').trim();
			}
			nodes.push(node);
			nodeIdx++;

			// BM25 排名分数（rank 反向）
			if (!scores) { scores = {}; }
			scores[filePath] = 1.0 - (rank - 1) * 0.05;
		} else {
			// Semantic 区块
			if (cols[0] === '#') { semHeader = cols; continue; }
			if (semHeader === null) { continue; }

			const semLocIdx = semHeader.findIndex(c => c === 'loc');
			const semQnIdx = semHeader.findIndex(c => c === 'qn');
			const semTypeIdx = semHeader.findIndex(c => c === 'type');
			const semScoreIdx = semHeader.findIndex(c => c === 'score');
			const semRelIdx = semHeader.findIndex(c => c === 'relevance');

			const name = semQnIdx >= 0 ? _col(cols, semQnIdx) : _col(cols, 2);
			const type = semTypeIdx >= 0 ? _col(cols, semTypeIdx) : _col(cols, 1);
			const loc = semLocIdx >= 0 ? _col(cols, semLocIdx) : _col(cols, 3);
			if (!loc || loc === '-') { continue; }
			const [filePath, startLine] = _parseLoc(loc);

			const sn: ToonSemanticNode = { rank: semIdx + 1, name, type, filePath, startLine };
			const score = semScoreIdx >= 0 ? parseFloat(_col(cols, semScoreIdx)) : NaN;
			if (!isNaN(score)) { sn.score = score; }
			if (semRelIdx >= 0) { sn.relevance = _col(cols, semRelIdx); }
			semanticResults!.push(sn);
			semIdx++;
		}
	}

	return { total, returned, hasMore, nodes, scores, semanticResults };
}

/**
 * 解析 trace_path TOON → 结构化数据。
 * 格式：TOON trace_path: found=true hops=N depth=D hasCycle=false from=X to=Y
 * 表头：d|type|qn|loc（+可选 edge_type / risk / score 等）
 */
export function parseToonTraceData(text: string): ToonTraceData | null {
	if (!text || !_TOON_HEADER_RE.test(text)) { return null; }
	const headerMatch = text.match(_TOON_HEADER_RE);
	if (!headerMatch || headerMatch[1] !== 'trace_path') { return null; }

	const meta = _parseToonMeta(text.split('\n')[0]);
	const found = meta['found'] === 'true';
	const hops = parseInt(meta['hops'] || '0', 10);
	const depth = parseInt(meta['depth'] || '0', 10);
	const hasCycle = meta['hasCycle'] === 'true';
	const from = meta['from'] || '';
	const to = meta['to'] || '';

	const lines = text.split('\n');
	const hopList: ToonTraceHop[] = [];
	let headerCols: string[] | null = null;

	for (const rawLine of lines.slice(1)) {
		const line = rawLine.trim();
		if (!line) { continue; }
		const cols = line.split('|');
		if (cols.length < 4) { continue; }

		// 表头行
		if (cols[0] === 'd' || cols[0] === '#') {
			headerCols = cols;
			continue;
		}
		if (headerCols === null) { continue; }

		const d = parseInt(cols[0], 10);
		if (isNaN(d)) { continue; }
		const type = _col(cols, headerCols.findIndex(c => c === 'type'));
		const qn = _col(cols, headerCols.findIndex(c => c === 'qn'));
		const loc = _col(cols, headerCols.findIndex(c => c === 'loc'));
		if (!loc || loc === '-') { continue; }
		const [filePath, startLine] = _parseLoc(loc);

		const hop: ToonTraceHop = { depth: d, name: qn, type, filePath, startLine };
		const et = headerCols.findIndex(c => c === 'edge_type');
		if (et >= 0) { hop.edgeType = _col(cols, et); }
		const rk = headerCols.findIndex(c => c === 'risk');
		if (rk >= 0) { hop.risk = _col(cols, rk); }
		const sc = headerCols.findIndex(c => c === 'score');
		if (sc >= 0) { const v = parseFloat(_col(cols, sc)); if (!isNaN(v)) { hop.score = v; } }
		hopList.push(hop);
	}

	return { found, hops, depth, hasCycle, from, to, hopList };
}

export type SearchResultItem = {
	name: string;
	path?: string;
	lineStart?: number | string;
	lineEnd?: number | string;
	type?: string;
};

/**
 * 解析 densified 分组格式（search_files / search_code content 模式输出，≥5 条匹配时的紧凑格式）。
 *
 * 格式：
 *   file1.ext
 *     34: content
 *     7733: content
 *
 *   file2.ext
 *     7691: content
 *
 *   [共 N 个文件]
 *
 * 返回每一条匹配为独立的 SearchResultItem（path 继承其所属文件，lineStart 为匹配行号）。
 * 若格式不可识别则返回 null，调用方应回退到其它解析路径。
 */
function tryParseDensifiedText(text: string): SearchResultItem[] | null {
	const rawLines = text.split('\n');
	const out: SearchResultItem[] = [];
	let currentFile: string | undefined;
	let hasDensified = false;
	// 跟踪哪些文件已有匹配行条目（避免纯文件列表双重计数）
	const filesWithMatches = new Set<string>();

	for (const rawLine of rawLines) {
		const line = rawLine.trim();
		if (!line) { continue; }
		if (_SUMMARY_RE.test(line)) { continue; }
		if (_NO_RESULT_RE.test(line)) { return []; }

		// 缩进匹配行（densified 特有）
		const ml = rawLine.match(_MATCH_LINE_RE);
		if (ml) {
			const lineNo = parseInt(ml[1], 10);
			if (currentFile) {
				filesWithMatches.add(currentFile);
				out.push({
					name: basenameOf(currentFile),
					path: currentFile,
					lineStart: lineNo,
					type: extToTypeOf(currentFile),
				});
				hasDensified = true;
			}
			continue;
		}

		// 非缩进行 → 可能是文件路径或内容行
		const gp = splitGrepPath(line);
		if (gp.line !== undefined && isValidFilePath(line, gp.path)) {
			// 经典的 file:line:content 格式
			currentFile = gp.path;
			filesWithMatches.add(currentFile);
			out.push({
				name: basenameOf(gp.path),
				path: gp.path,
				lineStart: gp.line,
				type: extToTypeOf(gp.path),
			});
			hasDensified = true;
		} else if (gp.line === undefined) {
			// 只有路径没有行号
			const candidate = line;
			if (isValidFilePath(candidate, candidate)) {
				currentFile = candidate;
				hasDensified = true;
				// 暂不 push：等循环结束后，无匹配的文件才会作为独立条目输出
			}
		}
	}

	// 收尾：无匹配行的文件（纯文件列表）作为独立条目
	for (const rawLine of rawLines) {
		const line = rawLine.trim();
		if (!line || _SUMMARY_RE.test(line) || _NO_RESULT_RE.test(line)) { continue; }
		const ml = rawLine.match(_MATCH_LINE_RE);
		if (ml) { continue; }
		const gp = splitGrepPath(line);
		if (gp.line !== undefined) { continue; } // 已有行号的 grep 行已处理
		if (!isValidFilePath(line, line)) { continue; }
		if (!filesWithMatches.has(line)) {
			out.push({
				name: basenameOf(line),
				path: line,
				type: extToTypeOf(line),
			});
		}
	}

	return out.length > 0 || hasDensified ? out : null;
}

export function parseSearchResultItems(
	resultText: string,
	key: string
): SearchResultItem[] | null {
	if (!resultText) { return null; }

	// 优先尝试 TOON 格式（search_graph / trace_path 等图谱工具输出）
	const toon = tryParseToonText(resultText, key);
	if (toon) { return toon; }

	try {
		const parsed = JSON.parse(resultText);

		// 处理工具结果被序列化为 content-block 数组的情况
		// （例如 search_files 后端返回 [{ type:'text', text:'<内容>' }]）
		if (Array.isArray(parsed) && parsed.length > 0 &&
			parsed.every((b: any) => b && typeof b === 'object' && 'type' in b && typeof b.text === 'string')) {
			const text = (parsed as Array<{ text: string }>).map((b) => b.text).join('\n');
			// 优先尝试 densified 格式解析
			const densified = tryParseDensifiedText(text);
			if (densified) { return densified; }
			// 回退：逐行 splitGrepPath（用于纯文件列表 / 非 densified grep 输出）
			const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean).slice(0, 60);
			if (lines.length) {
				const mapped: SearchResultItem[] = [];
				for (const line of lines) {
					if (_SUMMARY_RE.test(line)) { continue; }
					const sp = splitGrepPath(line);
					if (!isValidFilePath(line, sp.path)) { continue; }
					mapped.push({ name: basenameOf(sp.path), path: sp.path, lineStart: sp.line, type: extToTypeOf(sp.path) });
				}
				if (mapped.length) { return mapped; }
			}
			return null;
		}
		// 处理 { content: [{ type:'text', text:'...' }] } 形态
		if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content) && parsed.content.length > 0 &&
			parsed.content.every((b: any) => b && typeof b.text === 'string')) {
			const text = (parsed.content as Array<{ text: string }>).map((b) => b.text).join('\n');
			// 优先尝试 densified 格式解析
			const densified = tryParseDensifiedText(text);
			if (densified) { return densified; }
			// 回退
			const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean).slice(0, 60);
			if (lines.length) {
				const mapped: SearchResultItem[] = [];
				for (const line of lines) {
					if (_SUMMARY_RE.test(line)) { continue; }
					const sp = splitGrepPath(line);
					if (!isValidFilePath(line, sp.path)) { continue; }
					mapped.push({ name: basenameOf(sp.path), path: sp.path, lineStart: sp.line, type: extToTypeOf(sp.path) });
				}
				if (mapped.length) { return mapped; }
			}
			return null;
		}

		// search_graph → nodes[]
		if (key === 'search_graph' && parsed.nodes && Array.isArray(parsed.nodes)) {
			return (parsed.nodes as Array<any>).map((n: any) => ({
				name: n.file ? basenameOf(n.file) : (n.name || n.label || '?'),
				path: n.file || n.uri || n.path,
				lineStart: n.startLine ?? n.line,
				type: extToTypeOf(n.file || n.name || ''),
			}));
		}

		// search_code → results[] (grep style)
		if ((key === 'search_code' || key === 'grep') && parsed.results && Array.isArray(parsed.results)) {
			return (parsed.results as Array<any>).map((r: any) => {
				const sp = splitGrepPath(r.file || r.path || r.uri || '');
				const line = r.line ?? r.start_line ?? r.startLine ?? sp.line;
				return {
					name: sp.path ? basenameOf(sp.path) : '?',
					path: sp.path || undefined,
					lineStart: line,
					lineEnd: r.end_line ?? r.endLine,
					type: extToTypeOf(sp.path || ''),
				};
			});
		}

		// 通用数组
		let arr: any[] = Array.isArray(parsed) ? parsed
			: Array.isArray(parsed?.items) ? parsed.items
				: Array.isArray(parsed?.children) ? parsed.children
					: Array.isArray(parsed?.list) ? parsed.list
						: Array.isArray(parsed?.uris) ? parsed.uris : null;
		if (!arr) { return null; }

		const mapped: SearchResultItem[] = [];
		for (const it of arr) {
			if (typeof it === 'string') {
				const trimmed = it.trim();
				if (_SUMMARY_RE.test(trimmed)) { continue; }
				const sp = splitGrepPath(trimmed);
				// 过滤非文件路径行（grep 内容行 / 日志行 / 表格行等）
				if (!isValidFilePath(trimmed, sp.path)) { continue; }
				mapped.push({ name: basenameOf(sp.path), path: sp.path, lineStart: sp.line, type: extToTypeOf(sp.path) });
				continue;
			}
			if (!it || typeof it !== 'object') { continue; }
			const sp = splitGrepPath((it.path || it.uri || it.fsPath || it.file || it.filePath || it.filename || '') as string);
			const resolvedName = it.name || it.label || it.title || it.displayName || basenameOf(sp.path);
			mapped.push({
				name: resolvedName || '?',
				path: sp.path || undefined,
				lineStart: (it.line ?? it.start_line ?? it.startLine ?? it.offset) ?? sp.line,
				lineEnd: it.end_line ?? it.endLine,
				type: extToTypeOf(sp.path || it.name || ''),
			});
		}
		// 后处理：name 为 "?" 但有 path 时，用 path 的 basename 替代
		for (const m of mapped) {
			if ((m.name === '?' || !m.name) && m.path) {
				m.name = basenameOf(m.path);
			}
		}
		return mapped.length > 0 ? mapped : null;
	} catch {
		// JSON.parse 失败 → 尝试 densified 纯文本格式
		const densified = tryParseDensifiedText(resultText);
		if (densified) { return densified; }
		return null;
	}
}
