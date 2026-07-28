/*---------------------------------------------------------------------------------------------
 *  Frontmatter 解析与 sources 源追溯（P0-1，对齐 llm_wiki `src/lib/frontmatter.ts` 设计）。
 *
 *  本项目 KB 笔记 frontmatter 仅需扁平 string|string[]（sources/related/tags/title...），
 *  故不引入 js-yaml，采用零依赖自写解析，但复刻 llm_wiki 经 LLM 产出验证的健壮性策略：
 *    1. 两遍解析：strict（顶锚）→ anywhere fallback（容忍 LLM 在 frontmatter 前塞杂行/代码栅栏）。
 *    2. repairWikilinkLists：修复 `sources: [[a]], [[b]]` 这种非法 YAML。
 *    3. 行级 injectSources：保留其他字段原始格式，仅修改 sources（不破坏 agent 写的 frontmatter）。
 *
 *  这是 P2/P3 多个 frontmatter 解析 bug 的根治方案（流列表残留括号、LLM 损坏格式等）。
 *--------------------------------------------------------------------------------------------*/

export type FrontmatterValue = string | string[];

export interface FrontmatterParseResult {
	frontmatter: Record<string, FrontmatterValue> | null;
	body: string;
	/** 原始 frontmatter 块（含首尾 `---`），编辑 body 时可原样写回。 */
	rawBlock: string;
}

const FM_BLOCK_STRICT_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const FM_BLOCK_ANYWHERE_RE = /\n---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const MAX_PREFIX_LINES_BEFORE_FRONTMATTER = 6;

/** 解析 frontmatter（两遍 + wikilink-list 修复）。 */
export function parseFrontmatter(content: string): FrontmatterParseResult {
	const located = locateFrontmatterBlock(content);
	if (!located) { return { frontmatter: null, body: content, rawBlock: '' }; }
	const { yamlPayload, rawBlock, body } = located;
	const repaired = repairWikilinkLists(yamlPayload);
	const frontmatter = parseFlatYaml(repaired);
	return { frontmatter, body, rawBlock };
}

/**
 * 定位 frontmatter 块。strict（顶锚）优先；失败则扫描 anywhere，但要求开 fence
 * 在前 6 行内，避免把 body 深处的 `---` 水平线误判为 frontmatter。
 * 兼容 LLM 用 ```yaml 代码栅栏包裹 frontmatter 的情况。
 */
export function locateFrontmatterBlock(content: string): { yamlPayload: string; rawBlock: string; body: string } | null {
	const strict = content.match(FM_BLOCK_STRICT_RE);
	if (strict) {
		return { yamlPayload: strict[1], rawBlock: strict[0], body: content.slice(strict[0].length) };
	}
	const fallback = content.match(FM_BLOCK_ANYWHERE_RE);
	if (!fallback || fallback.index === undefined) { return null; }
	const openIdx = fallback.index + 1; // 跳过前导 `\n`
	if (lineNumberAt(content, openIdx) > MAX_PREFIX_LINES_BEFORE_FRONTMATTER) { return null; }
	const rawBlock = content.slice(openIdx, openIdx + fallback[0].length - 1);
	const bodyAfterFm = content.slice(openIdx + rawBlock.length);
	const prefix = content.slice(0, openIdx);
	const prefixIsYamlFence = /^\s*```(?:yaml|yml)?\s*\r?\n$/i.test(prefix);
	if (prefixIsYamlFence) {
		const stripped = bodyAfterFm.replace(/^\s*```\s*(?:\r?\n|$)/, '');
		return { yamlPayload: fallback[1], rawBlock, body: stripped };
	}
	return { yamlPayload: fallback[1], rawBlock, body: bodyAfterFm };
}

function lineNumberAt(s: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < s.length; i++) { if (s.charCodeAt(i) === 10) { line++; } }
	return line;
}

/**
 * 修复 `key: [[a]], [[b]]` 这种非法 YAML（LLM 常见产出），改写为
 * `key: ["[[a]]", "[[b]]"]`。仅处理精确匹配的行，不影响合法嵌套。
 */
export function repairWikilinkLists(payload: string): string {
	return payload.split('\n').map(line => {
		const m = line.match(/^(\s*[A-Za-z_][\w-]*\s*:\s*)(\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+)\s*$/);
		if (!m) { return line; }
		const items = m[2].split(',').map(s => s.trim()).filter(Boolean).map(s => `"${s}"`).join(', ');
		return `${m[1]}[${items}]`;
	}).join('\n');
}

/** 轻量扁平 YAML 解析：key: value / key: [a,b] / key: + 块序列。不支持嵌套对象（本项目不需要）。 */
function parseFlatYaml(payload: string): Record<string, FrontmatterValue> | null {
	const out: Record<string, FrontmatterValue> = {};
	const lines = payload.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
		if (!m) { continue; }
		const key = m[1];
		const val = m[2].trim();
		if (val === '') {
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length && /^[\t ]+-\s+/.test(lines[j])) {
				items.push(stripQuotes(lines[j].replace(/^[\t ]+-\s+/, '').trim()));
				j++;
			}
			out[key] = items;
			i = j - 1;
		} else if (val.startsWith('[')) {
			const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
			out[key] = inner === '' ? [] : inner.split(',').map(s => stripQuotes(s.trim())).filter(s => s !== '');
		} else {
			out[key] = stripQuotes(val);
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

function stripQuotes(s: string): string {
	return s.replace(/^["']|["']$/g, '');
}

/** 从笔记内容提取 sources[]，归一化为库文件 basename（小写，去 `库/` 前缀与 wikilink/引号/括号）。 */
export function extractSources(content: string): string[] {
	const { frontmatter } = parseFrontmatter(content);
	if (!frontmatter) { return []; }
	const v = frontmatter['sources'];
	if (v == null || v === '') { return []; }
	const arr = Array.isArray(v) ? v : [v];
	return arr.map(normalizeSourceRef).filter(Boolean);
}

/** 归一化单个 source 引用为库文件 basename（小写）。 */
export function normalizeSourceRef(s: string): string {
	let t = s.trim().replace(/^["']|["']$/g, '');
	t = t.replace(/^\[+/, '').replace(/\]+$/, '');
	t = t.replace(/^库\//, '');
	return (t.split(/[\\/]/).pop() ?? t).toLowerCase();
}

/** 笔记状态（P0-1 去抽象化门控）：pending=候选(来源不足)，active=正式(已被≥2来源确认)。 */
export type NoteStatus = 'pending' | 'active';
export const STATUS_ACTIVE: NoteStatus = 'active';
export const STATUS_PENDING: NoteStatus = 'pending';

/**
 * 读取笔记 frontmatter 的 `status`。缺失时默认 `active`（向后兼容门控上线前的旧笔记）。
 */
export function getStatus(content: string): NoteStatus {
	const { frontmatter } = parseFrontmatter(content);
	const v = frontmatter?.['status'];
	if (v == null || v === '') { return STATUS_ACTIVE; }
	const s = Array.isArray(v) ? v[0] : v;
	return s === STATUS_PENDING ? STATUS_PENDING : STATUS_ACTIVE;
}

/**
 * 行级设置 frontmatter 的 `status`，返回新内容与是否变更。
 * 复用 injectSources 的「仅改目标字段、保留其他原始格式」策略；无 frontmatter 时直接跳过。
 */
export function setStatus(content: string, status: NoteStatus): { content: string; changed: boolean } {
	const located = locateFrontmatterBlock(content);
	if (!located) { return { content, changed: false }; }
	const { rawBlock, body } = located;
	const cleanBody = body.replace(/^\r?\n/, '');
	const inner = extractInnerLines(rawBlock);
	const idx = inner.findIndex(l => /^status\s*:/.test(l.trim()));
	if (idx !== -1) {
		const cur = inner[idx].replace(/^[\t ]*status\s*:\s*/, '').trim().replace(/^["']|["']$/g, '');
		if (cur === status) { return { content, changed: false }; }
		const lead = /^[\t ]*/.exec(inner[idx])![0];
		inner[idx] = `${lead}status: ${status}`;
		return { content: `---\n${inner.join('\n')}\n---\n${cleanBody}`, changed: true };
	}
	// 缺 status 字段：在 frontmatter 末尾追加
	const newLines = [...inner, `status: ${status}`];
	return { content: `---\n${newLines.join('\n')}\n---\n${cleanBody}`, changed: true };
}

/**
 * 在 frontmatter 中确保 sources 含 refLink（如 `[[库/x.md]]`），返回新内容与是否变更。
 * 行级操作：保留其他字段原始格式，仅修改 sources。
 * 兼容：无 frontmatter / 缺 sources / 块序列 / 流列表 / 单值。
 */
export function injectSources(content: string, refLink: string, refBase: string): { content: string; changed: boolean } {
	const located = locateFrontmatterBlock(content);
	if (!located) {
		const body = content.startsWith('\n') ? content : '\n' + content;
		return { content: `---\nsources:\n  - ${refLink}\n---\n${body}`, changed: true };
	}
	const { rawBlock, body } = located;
	const cleanBody = body.replace(/^\r?\n/, '');
	const inner = extractInnerLines(rawBlock);

	const idx = inner.findIndex(l => /^sources\s*:/.test(l.trim()));
	if (idx === -1) {
		const newLines = ['sources:', `  - ${refLink}`, ...inner];
		return { content: `---\n${newLines.join('\n')}\n---\n${cleanBody}`, changed: true };
	}
	let end = idx + 1;
	while (end < inner.length && /^[\t ]+- /.test(inner[end])) { end++; }
	if (inner.slice(idx, end).some(l => l.includes(refLink) || l.includes(refBase))) {
		return { content, changed: false };
	}
	const flow = /^sources\s*:\s*\[(.*)\]\s*$/.exec(inner[idx].trim());
	if (flow) {
		const innerVal = flow[1].trim();
		// refLink 形如 [[库/x.md]]，在 YAML 流列表 [...] 里 [ 是非法起始，必须加引号
		const newVal = innerVal === '' ? `["${refLink}"]` : `[${innerVal}, "${refLink}"]`;
		const lead = /^[\t ]*/.exec(inner[idx])![0] ?? '';
		inner[idx] = `${lead}sources: ${newVal}`;
		return { content: `---\n${inner.join('\n')}\n---\n${cleanBody}`, changed: true };
	}
	// 单值 sources: x → 转块序列
	const single = /^(\s*)sources\s*:\s*(\S.*)$/.exec(inner[idx]);
	if (single && end === idx + 1) {
		const lead = single[1];
		const oldVal = single[2].replace(/^["']|["']$/g, '');
		inner[idx] = `${lead}sources:`;
		inner.splice(idx + 1, 0, `${lead}  - ${oldVal}`, `${lead}  - ${refLink}`);
		return { content: `---\n${inner.join('\n')}\n---\n${cleanBody}`, changed: true };
	}
	inner.splice(end, 0, `  - ${refLink}`);
	return { content: `---\n${inner.join('\n')}\n---\n${cleanBody}`, changed: true };
}

/** 从 rawBlock（`---\n...\n---`）提取内部行（去首尾 fence 与空行）。 */
function extractInnerLines(rawBlock: string): string[] {
	const lines = rawBlock.split(/\r?\n/);
	if (lines.length > 0 && lines[0].trim() === '---') { lines.shift(); }
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') { lines.pop(); }
	if (lines.length > 0 && lines[lines.length - 1].trim() === '---') { lines.pop(); }
	return lines;
}
